// Auto-update côté Electron (processus principal). S'appuie sur src/updatecore.js
// pour la logique réseau, et pilote l'UI + le lancement de l'installeur.
//
// Flux hébergé sur un autre PC, adresse dans UPDATE_URL (.env), ex :
//   UPDATE_URL=http://192.168.1.50:8770/
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isNewer, fetchLatest, downloadTo } from '../src/updatecore.js';

let getWin = () => null;
let feedBase = null;
let lastInfo = null;
let busy = false;

export function initUpdater(winGetter) {
  getWin = winGetter;
  feedBase = process.env.UPDATE_URL ? process.env.UPDATE_URL.trim() : null;
}

function send(channel, data) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// Vérifie la présence d'une mise à jour. silent=false -> on notifie aussi
// "à jour"/"désactivé"/"erreur" (bouton manuel) ; silent=true -> on ne
// remonte que si une MAJ est disponible (vérif de démarrage).
export async function checkForUpdates({ silent = true } = {}) {
  if (!feedBase) {
    console.log('[update] désactivé (UPDATE_URL non défini)');
    if (!silent) send('update-status', { state: 'disabled' });
    return { available: false, disabled: true };
  }
  try {
    const info = await fetchLatest(feedBase);
    const current = app.getVersion();
    const available = isNewer(info.version, current);
    lastInfo = info;
    console.log(`[update] actuel=${current} distant=${info.version} dispo=${available}`);
    if (available) send('update-status', { state: 'available', current, version: info.version, notes: info.notes || '' });
    else if (!silent) send('update-status', { state: 'uptodate', current });
    return { available, current, version: info.version };
  } catch (e) {
    console.log('[update] échec de la vérification:', e.message);
    if (!silent) send('update-status', { state: 'error', error: e.message });
    return { available: false, error: e.message };
  }
}

// Télécharge la MAJ connue puis lance l'installeur et redémarre l'app.
export async function applyUpdate() {
  if (busy) return { ok: false, error: 'Mise à jour déjà en cours' };
  if (!feedBase || !lastInfo) return { ok: false, error: 'Aucune mise à jour prête' };
  busy = true;
  try {
    const dest = path.join(os.tmpdir(), sanitize(lastInfo.file));
    send('update-status', { state: 'downloading' });
    await downloadTo(feedBase, lastInfo, dest, (p) => send('update-progress', p));
    send('update-status', { state: 'installing' });
    quitAndInstall(dest);
    return { ok: true };
  } catch (e) {
    busy = false;
    send('update-status', { state: 'error', error: e.message });
    return { ok: false, error: e.message };
  }
}

// Lance l'installeur en silencieux via un script détaché qui attend la fin de
// l'install puis relance l'app (l'installeur ferme l'app en cours au démarrage).
function quitAndInstall(installerPath) {
  const exe = process.execPath;
  const script = path.join(os.tmpdir(), 'snipemc-update.cmd');
  // ping = petite temporisation pour laisser l'app se fermer proprement.
  const body =
    '@echo off\r\n' +
    'ping 127.0.0.1 -n 2 >nul\r\n' +
    `"${installerPath}" /S\r\n` +
    `start "" "${exe}"\r\n`;
  fs.writeFileSync(script, body);
  const child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => app.quit(), 400);
}

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9 ._-]/g, '_');
}
