// Processus principal Electron. Fait le pont entre l'UI et le moteur de snipe.
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, session, Menu, Tray, Notification } from 'electron';
import { request } from 'undici';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Charge .env depuis plusieurs emplacements probables : à côté de l'exe (app
// packagée), dans le userData, ou à la racine du projet (dev). Le premier trouvé
// gagne. Permet de fournir MS_CLIENT_ID sans le compiler dans le binaire.
function loadEnv() {
  const candidates = [
    path.join(path.dirname(app.getPath('exe')), '.env'),
    path.join(app.getPath('userData'), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { dotenv.config({ path: p }); return p; }
  }
  return null;
}
loadEnv();

import { bus, sleep } from '../src/util.js';
import * as watchlist from './watchlist.js';
import { loginInteractive, cachedProfile, getValidToken } from '../src/auth.js';
import { isNameFree, nameStatus, validName } from '../src/mojang.js';
import { changeName, nameChangeInfo } from '../src/nameapi.js';
import { snipe, requestStop } from '../src/sniper.js';
import { bestOffset } from '../src/ntp.js';
import { bulkCheck } from '../src/bulk.js';
import { generateNames, spaceSize, nameVariants } from '../src/generate.js';
import { rankNames } from '../src/score.js';
import { makeProxyPool, testProxies } from '../src/proxy.js';
import { setManualToken, clearManualToken, manualStatus, getActiveToken, tryGetActiveToken } from './session.js';
import { listAccounts, saveCurrentAsAccount, activateAccount, removeAccount, allTokens } from './accounts.js';
import * as history from './history.js';
import { getWebhookPublic, setWebhook, sendWebhook, BLURPLE } from './webhook.js';
import { getPrefs, setPrefs } from './prefs.js';
import { initUpdater, checkForUpdates, applyUpdate } from './updater.js';

let win;
let bulkStop = false;
let tray = null;
app.isQuitting = false;
const monitor = { on: false, timer: null, ticking: false, notified: new Set(), autoclaim: false };

const ICON = path.join(__dirname, '..', 'build', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    title: 'Minecraft Sniper',
    backgroundColor: '#05070a',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined,
    // Barre de titre thématisée : caption masquée + contrôles natifs recolorés.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0e0a', symbolColor: '#39ff14', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,            // renderer en bac à sable
      webviewTag: false,        // pas de <webview>
      spellcheck: false,
      devTools: !app.isPackaged, // DevTools désactivés en version packagée
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Ouvre en grande fenêtre maximisée (l'app paraissait minuscule au démarrage).
  win.once('ready-to-show', () => { win.maximize(); win.show(); });

  // Sécurité : aucune navigation hors de l'app, aucune fenêtre enfant ;
  // les liens externes s'ouvrent dans le navigateur système.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  bus.on('log', (e) => { if (win && !win.isDestroyed()) win.webContents.send('log', e); });

  // Fermer la fenêtre = réduire dans le tray si la surveillance tourne
  // (sinon l'app se ferme normalement). Le menu du tray permet de quitter.
  win.on('close', (e) => {
    if (!app.isQuitting && monitor.on) { e.preventDefault(); win.hide(); }
  });

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForUpdates({ silent: true }), 3000);
  });
}

// --- Tray + moniteur de fond de la watchlist ---
function createTray() {
  try {
    tray = new Tray(fs.existsSync(ICON) ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
    tray.setToolTip('Minecraft Sniper');
    tray.on('click', showWindow);
    updateTray();
  } catch { /* tray indispo */ }
}
function showWindow() { if (win) { win.show(); win.focus(); } }
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir Snipe MC', click: showWindow },
    { label: monitor.on ? '● Surveillance active' : '○ Surveillance arrêtée', enabled: false },
    { label: monitor.on ? 'Arrêter la surveillance' : 'Démarrer la surveillance', click: () => (monitor.on ? stopMonitor() : startMonitor()) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function notifyFree(name) {
  try { new Notification({ title: '🎯 Pseudo libre !', body: `${name} est disponible`, icon: fs.existsSync(ICON) ? ICON : undefined }).show(); } catch {}
}
function startMonitor() {
  if (monitor.on) return;
  monitor.on = true;
  monitor.notified.clear();
  // .catch aux points d'appel : monitorTick est async et lancé par setInterval,
  // sans quoi un rejet deviendrait une "unhandled rejection" (crash potentiel).
  monitor.timer = setInterval(() => { monitorTick().catch((e) => console.error('[monitor] tick:', e)); }, 90000);
  monitorTick().catch((e) => console.error('[monitor] tick:', e));
  updateTray();
  if (win && !win.isDestroyed()) win.webContents.send('monitor-status', { on: true });
}
function stopMonitor() {
  monitor.on = false;
  clearInterval(monitor.timer); monitor.timer = null;
  updateTray();
  if (win && !win.isDestroyed()) win.webContents.send('monitor-status', { on: false });
}
async function monitorTick() {
  if (monitor.ticking) return;
  monitor.ticking = true;
  try {
    for (const name of watchlist.getWatch()) {
      if (!monitor.on) break;
      if (monitor.notified.has(name.toLowerCase())) continue;
      let res; try { res = await isNameFree(name); } catch { res = null; }
      if (res && res.free === true) {
        monitor.notified.add(name.toLowerCase());
        notifyFree(name);
        void sendWebhook({ title: '🎯 Pseudo libre !', description: `**${name}** est disponible — réclame vite (cooldown 30 j).` });
        bus.emit('log', { level: 'free', msg: `★ WATCHLIST : ${name} est LIBRE !`, t: Date.now() });
        if (win && !win.isDestroyed()) win.webContents.send('watch-free', { name });
        if (monitor.autoclaim) {
          // Garde individuelle : un échec de claim (réseau/401/…) ne doit pas
          // avorter tout le tick ni sauter le reste de la watchlist.
          try {
            const active = await tryGetActiveToken();
            if (active) {
              const cr = await changeName(name, active.accessToken);
              bus.emit('log', { level: cr.ok ? 'ok' : 'err', msg: cr.ok ? `Auto-claim : ${name} obtenu ! (cooldown 30 j → auto-claim coupé, veille conservée)` : `Auto-claim ${name} : ${cr.reason}`, t: Date.now() });
              if (cr.ok) {
                // Réclamé : on le retire de la watchlist et on coupe l'auto-claim
                // (cooldown 30 j → toute autre tentative échouerait). La veille
                // continue pour NOTIFIER sur les autres pseudos.
                try { watchlist.removeWatch(name); } catch { /* ignore */ }
                void sendWebhook({ title: '🎯 Pseudo auto-réclamé !', description: `**${name}** t'appartient maintenant.`, color: BLURPLE });
                monitor.autoclaim = false;
                if (win && !win.isDestroyed()) {
                  win.webContents.send('watch-free', { name, claimed: true });
                  win.webContents.send('monitor-status', { on: monitor.on, autoclaim: false });
                }
                break; // pas d'autre claim ce tick (cooldown)
              }
            }
          } catch (e) {
            bus.emit('log', { level: 'err', msg: `Auto-claim ${name} : ${e.message}`, t: Date.now() });
          }
        }
      }
      await sleep(1200); // espacé (respect rate limit)
    }
  } finally { monitor.ticking = false; }
}

app.whenReady().then(() => {
  // Tokens dans userData (persistant, hors dossier d'install) et chiffrés.
  process.env.SNIPE_DATA_DIR = app.getPath('userData');

  // Durcissement session : refuse TOUTES les permissions (caméra, micro, géo,
  // notifications, etc.) — l'app n'en a besoin d'aucune.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  Menu.setApplicationMenu(null); // pas de menu applicatif

  createWindow();
  createTray();
  initUpdater(() => win);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Défense en profondeur : applique les gardes à TOUT webContents créé, et
// interdit l'attachement de <webview>.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !monitor.on) app.quit(); });
app.on('before-quit', () => { try { history.flushSync(); } catch { /* ignore */ } });

// --- Meta / MAJ ---
ipcMain.handle('config-status', () => ({
  hasClientId: !!process.env.MS_CLIENT_ID,
}));
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('update-check', () => checkForUpdates({ silent: false }));
ipcMain.handle('update-apply', () => applyUpdate());

// --- Compte / token ---
// Profil actif = token manuel si présent, sinon login Microsoft en cache.
ipcMain.handle('whoami', async () => {
  const m = manualStatus();
  if (m.active) return { ok: true, profile: m.profile, source: 'token' };
  const active = await tryGetActiveToken();
  if (active) return { ok: true, profile: active.profile, source: active.source };
  return { ok: true, profile: cachedProfile(), source: cachedProfile() ? 'microsoft' : null };
});

ipcMain.handle('token-set', async (_e, token) => {
  try {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('Token invalide.');
    const profile = await setManualToken(token);
    return { ok: true, profile };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('token-clear', () => { clearManualToken(); return { ok: true }; });

// --- Multi-comptes ---
ipcMain.handle('accounts-list', () => { try { return { ok: true, ...listAccounts() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('account-save', async (_e, label) => { try { return { ok: true, ...(await saveCurrentAsAccount(label)) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('account-activate', async (_e, id) => { try { return { ok: true, ...(await activateAccount(id)) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('account-remove', (_e, id) => { try { return { ok: true, ...removeAccount(id) }; } catch (e) { return { ok: false, error: e.message }; } });

ipcMain.handle('login', async () => {
  try {
    const mc = await loginInteractive((prompt) => {
      win.webContents.send('device-code', prompt);
      shell.openExternal(prompt.verificationUri).catch(() => {});
    });
    return { ok: true, profile: mc.profile };
  } catch (e) { return { ok: false, error: e.message }; }
});

// --- Change username ---
ipcMain.handle('change-username', async (_e, name) => {
  try {
    if (!validName(name)) return { ok: false, error: 'Pseudo invalide (3-16 car., [A-Za-z0-9_]).' };
    const active = await tryGetActiveToken();
    if (!active) return { ok: false, error: 'Aucun token : colle un bearer token ou connecte-toi (MS).' };
    const res = await changeName(name, active.accessToken);
    if (res.ok) { bus?.emit?.('log', { level: 'ok', msg: `Pseudo changé en ${res.name} !`, t: Date.now() }); }
    return { ok: res.ok, status: res.status, reason: res.reason, name: res.name };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Cooldown de renommage (30 j) du compte actif.
ipcMain.handle('namechange-info', async () => {
  try {
    const active = await tryGetActiveToken();
    if (!active) return { ok: false, error: 'Aucun token actif.' };
    return { ok: true, ...(await nameChangeInfo(active.accessToken)) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Classe des pseudos par score de désirabilité.
ipcMain.handle('rank-names', (_e, names) => {
  try { return { ok: true, ranked: rankNames(Array.isArray(names) ? names : []) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// --- NTP / check unitaire ---
ipcMain.handle('ntp', async () => {
  try { return { ok: true, ...(await bestOffset()) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('check', async (_e, name) => {
  try {
    const out = { ok: true, name, valid: validName(name) };
    out.seen = history.lookup(name); // « déjà vu » = état PRÉCÉDENT (avant ce check)
    out.public = await isNameFree(name);
    if (out.public.free === true) history.record(name, 'free');
    else if (out.public.free === false) history.record(name, 'taken');
    const active = await tryGetActiveToken();
    if (active) {
      try { out.account = await nameStatus(name, active.accessToken); }
      catch (err) { out.accountError = err.message; }
    }
    return out;
  } catch (e) { return { ok: false, error: e.message }; }
});

// --- Historique persistant ---
ipcMain.handle('history-stats', () => { try { return { ok: true, ...history.stats() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('history-lookup', (_e, name) => { try { return { ok: true, entry: history.lookup(name) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('history-search', (_e, q) => { try { return { ok: true, names: history.searchFree(q) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('history-free-all', () => { try { return { ok: true, names: history.allFree() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('history-clear', () => { try { history.clear(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// --- Checkpoint de session (reprise) : fichier userData, persistant et fiable
//     (contrairement au localStorage file:// d'Electron). ---
const CHECKPOINT_FILE = () => path.join(app.getPath('userData'), 'checkpoint.json');
ipcMain.handle('checkpoint-save', async (_e, data) => {
  try {
    // Écriture ASYNC (ne bloque pas le main sur de gros scans) + temp unique
    // (pas de collision entre deux sauvegardes) + rename atomique.
    const tmp = `${CHECKPOINT_FILE()}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data));
    await fs.promises.rename(tmp, CHECKPOINT_FILE());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Variante « brute » : le renderer a déjà sérialisé (JSON string). On écrit tel
// quel → pas de 2e JSON.stringify ici ni de clone d'un gros graphe d'objets en IPC.
ipcMain.handle('checkpoint-save-raw', async (_e, str) => {
  try {
    if (typeof str !== 'string') return { ok: false, error: 'payload non-string' };
    const tmp = `${CHECKPOINT_FILE()}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, str);
    await fs.promises.rename(tmp, CHECKPOINT_FILE());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('checkpoint-load', () => {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(CHECKPOINT_FILE(), 'utf8')) }; }
  catch { return { ok: true, data: null }; }
});
ipcMain.handle('checkpoint-clear', () => { try { fs.rmSync(CHECKPOINT_FILE(), { force: true }); } catch { /* ignore */ } return { ok: true }; });

// --- Watchlist + moniteur de fond ---
ipcMain.handle('watch-get', () => { try { return { ok: true, names: watchlist.getWatch() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('watch-add', (_e, names) => { try { const arr = Array.isArray(names) ? names : [names]; return { ok: true, names: watchlist.addWatch(arr) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('watch-remove', (_e, name) => { try { return { ok: true, names: watchlist.removeWatch(name) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('watch-clear', () => { try { return { ok: true, names: watchlist.clearWatch() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('monitor-start', () => { startMonitor(); return { ok: true, on: monitor.on }; });
ipcMain.handle('monitor-stop', () => { stopMonitor(); return { ok: true, on: monitor.on }; });
ipcMain.handle('monitor-status', () => ({ ok: true, on: monitor.on, autoclaim: monitor.autoclaim }));
ipcMain.handle('monitor-autoclaim', (_e, v) => { monitor.autoclaim = !!v; return { ok: true, autoclaim: monitor.autoclaim }; });

// --- Alertes Discord (webhook) ---
ipcMain.handle('webhook-get', () => { try { return { ok: true, ...getWebhookPublic() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('webhook-set', (_e, p) => { try { return { ok: true, ...setWebhook(p?.url, p?.enabled) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('webhook-test', async (_e, url) => {
  try { return await sendWebhook({ title: '✅ Test Snipe MC', description: 'Les alertes Discord fonctionnent — tu seras prévenu quand un pseudo surveillé se libère.' }, url); }
  catch (e) { return { ok: false, error: e.message }; }
});

// --- Export / import config (sans les tokens : liés machine + sensibles) ---
ipcMain.handle('config-export', async (_e, payload) => {
  try {
    const r = await dialog.showSaveDialog(win, { title: 'Exporter la config', defaultPath: 'snipe-mc-config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const cfg = {
      version: 1,
      watchlist: watchlist.getWatch(),
      proxies: Array.isArray(payload?.proxies) ? payload.proxies : [],
      gen: payload?.gen || {},
      accountsLabels: listAccounts().accounts.map((a) => ({ label: a.label, name: a.name })), // infos seulement, pas de token
    };
    fs.writeFileSync(r.filePath, JSON.stringify(cfg, null, 2));
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('config-import', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { title: 'Importer une config', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const cfg = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (Array.isArray(cfg.watchlist)) watchlist.addWatch(cfg.watchlist);
    return { ok: true, data: { proxies: cfg.proxies || [], gen: cfg.gen || {}, watchlist: watchlist.getWatch() } };
  } catch (e) { return { ok: false, error: e.message }; }
});

// --- Générateur ---
ipcMain.handle('generate', (_e, opts) => {
  try {
    const names = generateNames(opts);
    return { ok: true, names, space: spaceSize(opts.length, opts.charset) };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Variantes proches d'un pseudo (alternatives quand la cible est prise).
ipcMain.handle('variants', (_e, base) => {
  try { return { ok: true, names: nameVariants(String(base || '')) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Préférences d'UI persistées (réglages mémorisés entre les lancements).
ipcMain.handle('prefs-get', () => { try { return { ok: true, prefs: getPrefs() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('prefs-set', (_e, obj) => { try { return { ok: true, prefs: setPrefs(obj) }; } catch (e) { return { ok: false, error: e.message }; } });

// --- Fichier .txt (liste de pseudos) ---
ipcMain.handle('pick-txt', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choisir une liste de pseudos',
    filters: [{ name: 'Texte', extensions: ['txt'] }, { name: 'Tous', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const content = fs.readFileSync(r.filePaths[0], 'utf8');
    const names = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return { ok: true, path: r.filePaths[0], names };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('save-txt', async (_e, { suggested, content }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Enregistrer la liste',
    defaultPath: suggested || 'pseudos.txt',
    filters: [{ name: 'Texte', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(r.filePath, content, 'utf8'); return { ok: true, path: r.filePath }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// --- Check en masse ---
ipcMain.handle('bulk-check', async (_e, { names, delayMs, useToken, proxies }) => {
  bulkStop = false;
  const proxyPool = (proxies && proxies.length) ? makeProxyPool(proxies) : null;
  try {
    let token = null;
    if (useToken) { const a = await tryGetActiveToken(); token = a?.accessToken || null; }
    const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
    const summary = await bulkCheck(names, {
      minIntervalMs: Number(delayMs) || 0,
      token, proxyPool,
      onResult: (r) => { history.record(r.name, r.state); send('bulk-result', r); },
      onStats: (s) => send('bulk-stats', s),
      shouldStop: () => bulkStop,
    });
    history.flushNow();
    if (proxyPool) summary.proxies = proxyPool.size;
    return { ok: true, summary };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (proxyPool) await proxyPool.close(); }
});
ipcMain.handle('bulk-stop', () => { bulkStop = true; return { ok: true }; });

// Récupère une liste publique de proxies HTTP gratuits (plusieurs sources en repli).
ipcMain.handle('fetch-proxies', async () => {
  const sources = [
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  ];
  for (const url of sources) {
    try {
      const { statusCode, body } = await request(url, {
        headers: { 'user-agent': 'snipe-mc' }, maxRedirections: 3, headersTimeout: 6000, bodyTimeout: 10000,
      });
      if (statusCode !== 200) { await body.dump(); continue; }
      const text = await body.text();
      const proxies = text.split(/\r?\n/)
        .map((s) => s.trim().replace(/^https?:\/\//i, ''))
        .filter((s) => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s));
      if (proxies.length) return { ok: true, proxies: proxies.slice(0, 400), source: url };
    } catch { /* source suivante */ }
  }
  return { ok: false, error: 'Aucune source de proxies joignable.' };
});

// Pré-teste des proxies et ne garde que les vivants (stream de progression).
ipcMain.handle('test-proxies', async (_e, lines) => {
  try {
    const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };
    const r = await testProxies(lines || [], { onProgress: (p) => send('proxy-test-progress', p) });
    return { ok: true, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});

// --- Snipe ---
ipcMain.handle('snipe', async (_e, opts) => {
  try {
    if (!validName(opts.name)) return { ok: false, error: 'Pseudo invalide (3-16 car., [A-Za-z0-9_]).' };
    const common = {
      name: opts.name,
      dropAt: opts.dropAt || undefined,
      monitor: !!opts.monitor,
      burst: opts.burst,
      spacingMs: opts.spacingMs,
      leadMs: opts.leadMs,
      connections: opts.connections,
      skipNtp: !!opts.skipNtp,
    };

    // Multi-comptes : tire depuis tous les comptes enregistrés en parallèle.
    if (opts.allAccounts) {
      const accts = allTokens();
      if (!accts.length) return { ok: false, error: 'Aucun compte enregistré (enregistre des comptes d\'abord).' };
      bus?.emit?.('log', { level: 'step', msg: `Snipe multi-comptes : ${accts.length} comptes`, t: Date.now() });
      const runs = accts.map((a) =>
        snipe({ ...common, token: a.token })
          .then((r) => ({ label: a.label || a.name, success: !!r.success }))
          .catch((e) => ({ label: a.label || a.name, success: false, error: e.message })));
      const results = await Promise.all(runs);
      const winner = results.find((x) => x.success) || null;
      return { ok: true, multi: true, count: accts.length, winner: winner ? winner.label : null, results };
    }

    const active = await tryGetActiveToken();
    if (!active) return { ok: false, error: 'Aucun token : colle un bearer token ou connecte-toi (MS).' };
    if (active.source === 'microsoft' && !active.profile) {
      return { ok: false, error: "Ce compte n'a pas de profil Java." };
    }
    // Token-provider seulement pour la source Microsoft (rafraîchissable). Un bearer
    // collé à la main n'est pas rafraîchissable : un 401 sera alors signalé, pas bouclé.
    const getToken = active.source === 'microsoft'
      ? async () => (await getValidToken()).accessToken
      : undefined;

    // Multi-cibles : snipe plusieurs pseudos EN PARALLÈLE avec le compte actif ;
    // le 1er obtenu gagne (on ne peut de toute façon en réclamer qu'un — cooldown).
    const targets = Array.isArray(opts.names) ? [...new Set(opts.names.filter(validName))] : [];
    if (targets.length > 1) {
      bus?.emit?.('log', { level: 'step', msg: `Snipe multi-cibles : ${targets.length} pseudos (le 1er libre gagne)`, t: Date.now() });
      const runs = targets.map((nm) =>
        snipe({ ...common, name: nm, token: active.accessToken, getToken })
          .then((r) => ({ name: nm, success: !!r.success }))
          .catch((e) => ({ name: nm, success: false, error: e.message })));
      const results = await Promise.all(runs);
      const winner = results.find((x) => x.success) || null;
      return { ok: true, multiTarget: true, count: targets.length, winner: winner ? winner.name : null, results };
    }

    const result = await snipe({ ...common, token: active.accessToken, getToken });
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stop', () => { requestStop(); return { ok: true }; });
