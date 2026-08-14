// Processus principal Electron. Fait le pont entre l'UI et le moteur de snipe.
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, session, Menu, Tray, Notification, clipboard } from 'electron';
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
import * as subgate from './subgate.js';
import { initUpdater, checkForUpdates, applyUpdate } from './updater.js';

let win;
let bulkStop = false;
let bulkBusy = false; // un bulk-check est en cours (anti-concurrence)
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
  // Gate d'abonnement OFF par défaut : resolveEntry() renvoie index.html tant que
  // SUB_GATE != 1 (comportement identique). Sinon → gate.html (ou index.html si grâce).
  win.loadFile(subgate.resolveEntry());

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
    // Gardé : le clic tray ne doit pas contourner l'abonnement (M1). `enabled` ici est
    // un indice UI bon marché (lecture synchrone du dernier état connu, peut être
    // périmé de quelques minutes) — l'application RÉELLE du gate a lieu de façon
    // async dans le click handler via gateLocked() (recheck si périmé, cf TOCTOU).
    { label: monitor.on ? 'Arrêter la surveillance' : 'Démarrer la surveillance', enabled: monitor.on || !subgate.isEnabled() || subgate.isVerified(), click: async () => { if (!monitor.on && await gateLocked()) return; monitor.on ? stopMonitor() : startMonitor(); } },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function notifyFree(name) {
  try { new Notification({ title: '🎯 Pseudo libre !', body: `${name} est disponible`, icon: fs.existsSync(ICON) ? ICON : undefined }).show(); } catch {}
}
async function startMonitor() {
  if (monitor.on) return;
  if (await gateLocked()) return; // abonnement requis (M1)
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
  if (await gateLocked()) { monitor.on = false; return; } // abonnement requis (M1)
  monitor.ticking = true;
  try {
    for (const name of watchlist.getWatch()) {
      if (!monitor.on) break;
      let res; try { res = await isNameFree(name); } catch { res = null; }
      const key = name.toLowerCase();
      // Repris depuis la dernière notif → on réarme pour re-notifier au prochain
      // drop (sinon un pseudo notifié une fois n'alerte plus jamais).
      if (res && res.free === false) monitor.notified.delete(key);
      // Notifie UNE fois par passage à « libre » (pas de spam tant qu'il le reste).
      if (res && res.free === true && !monitor.notified.has(key)) {
        monitor.notified.add(key);
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
              const cr = await changeName(name, active.accessToken, subgate.getEntitlementToken());
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

// --- Ré-vérification PÉRIODIQUE du gate en tâche de fond (fix TOCTOU) ---
// gateLocked() ne recheck le backend QUE quand une action gatée est déclenchée
// (paresseux). Sans ce timer, un abonné qui résilie/rembourse juste après avoir été
// vérifié, puis ne déclenche plus jamais d'action gatée pendant un moment (ex.
// surveillance tournant seule en tray, fenêtre juste ouverte sans clic), garderait un
// accès valide jusqu'à... rien : l'app peut tourner indéfiniment. Ce timer proactif
// détecte donc la révocation même sans interaction utilisateur.
const SUBGATE_POLL_MS = 7 * 60 * 1000; // 7 min (fourchette 5-10 min visée par l'audit)
let subgateTimer = null;
function startSubgatePolling() {
  if (subgateTimer || !subgate.isEnabled()) return; // no-op si le gate est OFF
  subgateTimer = setInterval(async () => {
    try {
      const wasOk = subgate.isVerified();
      const ok = await subgate.ensureFreshAccess();
      if (wasOk && !ok) onSubgateAccessLost();
    } catch (e) { console.error('[subgate] poll:', e); }
  }, SUBGATE_POLL_MS);
}
// Accès perdu détecté hors d'un appel IPC gaté : coupe la surveillance en cours et
// renvoie la fenêtre sur le gate (resolveEntry() → gate.html tant que non re-vérifié),
// pour que l'UI reflète immédiatement la perte d'accès au lieu de rester sur
// index.html avec des actions qui échoueraient silencieusement une à une.
function onSubgateAccessLost() {
  bus?.emit?.('log', { level: 'err', msg: 'Abonnement expiré ou résilié — accès reverrouillé.', t: Date.now() });
  if (monitor.on) stopMonitor();
  if (win && !win.isDestroyed()) { try { win.loadFile(subgate.resolveEntry()); } catch { /* ignore */ } }
  updateTray();
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
  startSubgatePolling();
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

// --- Subgate (abonnement) : inertes si SUB_GATE != 1 ---
ipcMain.handle('subgate:state', () => subgate.ipcState());
ipcMain.handle('subgate:access', () => subgate.ipcAccess());
ipcMain.handle('subgate:login', (_e, { email, password }) => subgate.ipcLogin(email, password));
ipcMain.handle('subgate:signup', (_e, { email, password }) => subgate.ipcSignup(email, password));
ipcMain.handle('subgate:refresh', () => subgate.ipcRefresh());
ipcMain.handle('subgate:openCheckout', () => subgate.ipcOpenCheckout());
ipcMain.handle('subgate:logout', () => subgate.ipcLogout());
ipcMain.handle('subgate:enter', async () => {
  if (await gateLocked()) return { ok: false };
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return { ok: true };
});
// Garde des IPC moteur : quand le gate est actif et l'accès non vérifié/périmé, on
// refuse (coupe le contournement « charger index.html à la main »). No-op si flag OFF.
// ensureFreshAccess() re-vérifie auprès du backend si le cache `verified` est périmé
// (fraîcheur ou grace_until dépassés) AVANT de trancher — c'est le fix TOCTOU : une
// résiliation Stripe survenue après la vérification initiale finit par être détectée
// ici, pas seulement au prochain redémarrage de l'app.
async function gateLocked() { return subgate.isEnabled() && !(await subgate.ensureFreshAccess()); }

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
    }, subgate.getEntitlementToken());
    return { ok: true, profile: mc.profile };
  } catch (e) { return { ok: false, error: e.message }; }
});

// --- Change username ---
ipcMain.handle('change-username', async (_e, name) => {
  if (await gateLocked()) return { ok: false, error: 'LOCKED' };
  try {
    if (!validName(name)) return { ok: false, error: 'Pseudo invalide (3-16 car., [A-Za-z0-9_]).' };
    const active = await tryGetActiveToken();
    if (!active) return { ok: false, error: 'Aucun token : colle un bearer token ou connecte-toi (MS).' };
    const res = await changeName(name, active.accessToken, subgate.getEntitlementToken());
    if (res.ok) { bus?.emit?.('log', { level: 'ok', msg: `Pseudo changé en ${res.name} !`, t: Date.now() }); }
    return { ok: res.ok, status: res.status, reason: res.reason, name: res.name };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Cooldown de renommage (30 j) du compte actif.
ipcMain.handle('namechange-info', async () => {
  if (await gateLocked()) return { ok: false, error: 'LOCKED' };
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

// Mesure la latence réseau vers l'hôte de changement de nom (api.minecraftservices.com).
// Connexion réchauffée (on ignore la 1re requête = handshake TLS) pour refléter la
// latence réelle d'un snipe (le moteur pré-chauffe les sockets). Sert à régler `lead`
// (avance de tir ≈ latence aller ≈ RTT/2). Pas besoin de token (le statut importe peu).
ipcMain.handle('measure-latency', async () => {
  try {
    const url = 'https://api.minecraftservices.com/minecraft/profile';
    const rtts = [];
    for (let i = 0; i < 6; i++) {
      const t = Date.now();
      try {
        const { body } = await request(url, { method: 'GET', headersTimeout: 5000, bodyTimeout: 5000 });
        await body.dump();
        if (i > 0) rtts.push(Date.now() - t); // i=0 = handshake, ignoré
      } catch { /* mesure ratée, on continue */ }
      await sleep(150);
    }
    if (!rtts.length) return { ok: false, error: 'aucune mesure aboutie' };
    rtts.sort((a, b) => a - b);
    const median = rtts[Math.floor(rtts.length / 2)];
    return { ok: true, min: rtts[0], median, samples: rtts };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('check', async (_e, name) => {
  if (await gateLocked()) return { ok: false, error: 'LOCKED' };
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
ipcMain.handle('history-free-all', async () => { if (await gateLocked()) return { ok: false, error: 'LOCKED' }; try { return { ok: true, names: history.allFree() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('history-clear', () => { try { history.clear(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// --- Checkpoint de session (reprise) : fichier userData, persistant et fiable
//     (contrairement au localStorage file:// d'Electron). ---
const CHECKPOINT_FILE = () => path.join(app.getPath('userData'), 'checkpoint.json');
// Suffixe tmp unique : Date.now() seul peut collisionner entre deux sauvegardes dans
// la même ms (A4) ; on ajoute une séquence monotone et on nettoie le tmp en cas d'échec.
let ckptSeq = 0;
async function writeCheckpointAtomic(content) {
  const tmp = `${CHECKPOINT_FILE()}.${Date.now()}.${++ckptSeq}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content);
    await fs.promises.rename(tmp, CHECKPOINT_FILE());
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
ipcMain.handle('checkpoint-save', async (_e, data) => {
  try { await writeCheckpointAtomic(JSON.stringify(data)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// Variante « brute » : le renderer a déjà sérialisé (JSON string).
ipcMain.handle('checkpoint-save-raw', async (_e, str) => {
  try {
    if (typeof str !== 'string') return { ok: false, error: 'payload non-string' };
    await writeCheckpointAtomic(str);
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
ipcMain.handle('monitor-start', async () => { if (await gateLocked()) return { ok: false, error: 'LOCKED' }; await startMonitor(); return { ok: true, on: monitor.on }; });
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
// Alerte pépite (envoyée depuis le renderer pendant un scan). No-op si webhook off.
ipcMain.handle('webhook-gem', async (_e, p) => {
  try { return await sendWebhook({ title: '💎 Pépite libre !', description: `**${p?.name}** (tier ${p?.tier || '?'}) vient de se libérer — réclame vite (cooldown 30 j).`, color: BLURPLE }); }
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

// Copie dans le presse-papiers (module Electron : fiable, sans permission navigateur).
ipcMain.handle('clipboard-write', (_e, text) => { try { clipboard.writeText(String(text ?? '')); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

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
  if (await gateLocked()) return { ok: false, error: 'LOCKED' };
  // Anti-concurrence : deux scans simultanés partageraient bulkStop + émettraient
  // des résultats entrelacés (progression/historique corrompus).
  if (bulkBusy) return { ok: false, error: 'Un scan est déjà en cours.' };
  bulkBusy = true;
  bulkStop = false;
  const proxyPool = (proxies && proxies.length) ? makeProxyPool(proxies) : null;
  try {
    // Sécurité IP : si des proxies ont été fournis mais qu'AUCUN n'est valide, le pool
    // est vide et le scanner basculerait en DIRECT (next()->null) → fuite d'IP. On refuse.
    if (proxyPool && proxyPool.size === 0) {
      return { ok: false, error: 'Aucun proxy valide dans ta liste — scan annulé pour ne pas exposer ton IP en direct (format attendu : host:port).' };
    }
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
  finally { bulkBusy = false; if (proxyPool) await proxyPool.close(); }
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
  if (await gateLocked()) return { ok: false, error: 'LOCKED' };
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
      // Jeton d'entitlement de la session gate courante : requis par snipe() côté
      // moteur si un gate est actif pour ce build (audit : moteur nu, cf src/entitlement.js).
      entitlement: subgate.getEntitlementToken(),
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
      ? async () => (await getValidToken(subgate.getEntitlementToken())).accessToken
      : undefined;

    // Multi-cibles : snipe plusieurs pseudos EN PARALLÈLE avec le compte actif ;
    // le 1er obtenu gagne (on ne peut de toute façon en réclamer qu'un — cooldown).
    const targets = Array.isArray(opts.names) ? [...new Set(opts.names.filter(validName))] : [];
    if (targets.length > 1) {
      bus?.emit?.('log', { level: 'step', msg: `Snipe multi-cibles : ${targets.length} pseudos (le 1er libre gagne)`, t: Date.now() });
      const runs = targets.map((nm) =>
        snipe({ ...common, name: nm, token: active.accessToken, getToken })
          // 1er gagnant → requestStop() coupe le stopFlag GLOBAL : en mode surveillance,
          // les runs frères sortent de leur boucle (sinon Promise.all ne résout jamais
          // et leurs Pools undici restent ouverts à poller indéfiniment).
          .then((r) => { if (r.success) requestStop(); return { name: nm, success: !!r.success }; })
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
