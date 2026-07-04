// Processus principal Electron. Fait le pont entre l'UI et le moteur de snipe.
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
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
import { makeProxyPool } from '../src/proxy.js';
import { setManualToken, clearManualToken, manualStatus, getActiveToken, tryGetActiveToken } from './session.js';
import { listAccounts, saveCurrentAsAccount, activateAccount, removeAccount, allTokens } from './accounts.js';
import { initUpdater, checkForUpdates, applyUpdate } from './updater.js';

let win;
let bulkStop = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 780,
    minHeight: 580,
    title: 'Minecraft Sniper',
    backgroundColor: '#05070a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  bus.on('log', (e) => { if (win && !win.isDestroyed()) win.webContents.send('log', e); });

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForUpdates({ silent: true }), 3000);
  });
}

app.whenReady().then(() => {
  createWindow();
  initUpdater(() => win);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

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

// --- NTP / check unitaire ---
ipcMain.handle('ntp', async () => {
  try { return { ok: true, ...(await bestOffset()) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('check', async (_e, name) => {
  try {
    const out = { ok: true, name, valid: validName(name) };
    out.public = await isNameFree(name);
    const active = await tryGetActiveToken();
    if (active) {
      try { out.account = await nameStatus(name, active.accessToken); }
      catch (err) { out.accountError = err.message; }
    }
    return out;
  } catch (e) { return { ok: false, error: e.message }; }
});

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
      onResult: (r) => send('bulk-result', r),
      onStats: (s) => send('bulk-stats', s),
      shouldStop: () => bulkStop,
    });
    if (proxyPool) summary.proxies = proxyPool.size;
    return { ok: true, summary };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (proxyPool) await proxyPool.close(); }
});
ipcMain.handle('bulk-stop', () => { bulkStop = true; return { ok: true }; });

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
