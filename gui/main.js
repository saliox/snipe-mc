// Processus principal Electron. Fait le pont entre l'UI et le moteur de snipe.
import { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, session, Menu } from 'electron';
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

import { bus } from '../src/util.js';
import { loginInteractive, cachedProfile } from '../src/auth.js';
import { isNameFree, nameStatus, validName } from '../src/mojang.js';
import { changeName, nameChangeInfo } from '../src/nameapi.js';
import { snipe, requestStop } from '../src/sniper.js';
import { bestOffset } from '../src/ntp.js';
import { bulkCheck } from '../src/bulk.js';
import { generateNames, spaceSize } from '../src/generate.js';
import { rankNames } from '../src/score.js';
import { makeProxyPool, testProxies } from '../src/proxy.js';
import { setManualToken, clearManualToken, manualStatus, getActiveToken, tryGetActiveToken } from './session.js';
import { listAccounts, saveCurrentAsAccount, activateAccount, removeAccount, allTokens } from './accounts.js';
import * as history from './history.js';
import { initUpdater, checkForUpdates, applyUpdate } from './updater.js';

let win;
let bulkStop = false;

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

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForUpdates({ silent: true }), 3000);
  });
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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { history.flushSync(); } catch { /* ignore */ } });

// --- Meta / MAJ ---
ipcMain.handle('config-status', () => ({
  hasClientId: !!process.env.MS_CLIENT_ID,
  updateConfigured: !!process.env.UPDATE_URL,
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

// --- Générateur ---
ipcMain.handle('generate', (_e, opts) => {
  try {
    const names = generateNames(opts);
    return { ok: true, names, space: spaceSize(opts.length, opts.charset) };
  } catch (e) { return { ok: false, error: e.message }; }
});

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
    const result = await snipe({ ...common, token: active.accessToken });
    return { ok: true, result };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stop', () => { requestStop(); return { ok: true }; });
