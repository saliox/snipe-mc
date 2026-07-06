// Auto-update côté Electron (processus principal). S'appuie sur src/updatecore.js
// pour la logique réseau, et pilote l'UI + le lancement de l'installeur.
//
// AUTONOME : se met à jour depuis les Releases GitHub du dépôt public
// DEFAULT_REPO, sans aucune config, aucun serveur, aucune adresse IP.
// Seul override .env : UPDATE_REPO=owner/name (autre dépôt GitHub — jamais une IP).
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isNewer, fetchLatestGithub, downloadTo, fetchJson, verifyReleaseSignature } from '../src/updatecore.js';

const DEFAULT_REPO = 'saliox/snipe-mc';

let getWin = () => null;
let source = { repo: DEFAULT_REPO };
let lastInfo = null;
let busy = false;

export function initUpdater(winGetter) {
  getWin = winGetter;
  const repo = (process.env.UPDATE_REPO && process.env.UPDATE_REPO.trim()) || DEFAULT_REPO;
  source = { repo };
  console.log(`[update] source: github:${source.repo}`);
}

function send(channel, data) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// Vérifie la présence d'une mise à jour. silent=false -> on notifie aussi
// "à jour"/"désactivé"/"erreur" (bouton manuel) ; silent=true -> on ne
// remonte que si une MAJ est disponible (vérif de démarrage).
export async function checkForUpdates({ silent = true } = {}) {
  try {
    const info = await fetchLatestGithub(source.repo);
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

// Télécharge la MAJ puis l'installe. Essaie d'abord la MAJ DIFFÉRENTIELLE
// (app.zip ~1 Mo, si le runtime Electron est inchangé), sinon l'installeur complet.
export async function applyUpdate() {
  if (busy) return { ok: false, error: 'Mise à jour déjà en cours' };
  if (!lastInfo) return { ok: false, error: 'Aucune mise à jour prête' };
  busy = true;
  try {
    if (await tryAppOnlyUpdate()) return { ok: true };

    // Repli : installeur complet. Nom de fichier temporaire imprévisible : un nom fixe
    // permettrait à un autre process local (même utilisateur) de pré-créer/substituer
    // le fichier avant le téléchargement.
    const dest = path.join(os.tmpdir(), `${crypto.randomUUID()}-${sanitize(lastInfo.file)}`);
    send('update-status', { state: 'downloading' });
    await downloadTo(lastInfo, dest, (p) => send('update-progress', p));
    send('update-status', { state: 'installing' });
    quitAndInstall(dest);
    return { ok: true };
  } catch (e) {
    busy = false;
    send('update-status', { state: 'error', error: e.message });
    return { ok: false, error: e.message };
  }
}

// MAJ différentielle : ne remplace que resources/app (code), ~1 Mo au lieu de 81 Mo.
// Conditions : assets app.zip + app-update.json présents et MÊME version majeure
// d'Electron (pas de changement de runtime). Renvoie true si appliquée.
async function tryAppOnlyUpdate() {
  try {
    const assets = lastInfo.assets || [];
    const metaAsset = assets.find((a) => a.name === 'app-update.json');
    const zipAsset = assets.find((a) => a.name === 'app.zip');
    if (!metaAsset || !zipAsset) return false;

    const meta = await fetchJson(metaAsset.url);
    const curMajor = String(process.versions.electron || '').split('.')[0];
    const newMajor = String(meta.electron || '').split('.')[0];
    if (!curMajor || curMajor !== newMajor) {
      console.log(`[update] runtime Electron différent (${curMajor}->${newMajor}) : installeur complet`);
      return false;
    }

    // Même exigence de signature que l'installeur complet (voir fetchLatestGithub) :
    // app-update.json seul, même servi par GitHub, ne prouve rien sans signature.
    if (!meta.sha256 || !meta.size) return false;
    const payload = { version: meta.version, electron: meta.electron, sha256: meta.sha256, size: meta.size };
    if (!verifyReleaseSignature(payload, meta.signature)) {
      console.log('[update] app-update.json non signé/signature invalide : repli installeur complet');
      return false;
    }

    const dest = path.join(os.tmpdir(), `snipemc-app-${crypto.randomUUID()}.zip`);
    send('update-status', { state: 'downloading' });
    await downloadTo({ url: zipAsset.url, size: meta.size, sha256: meta.sha256 }, dest, (p) => send('update-progress', p));
    send('update-status', { state: 'installing' });
    applyAppZip(dest, meta.version || lastInfo.version);
    return true;
  } catch (e) {
    console.log('[update] MAJ différentielle impossible, repli installeur :', e.message);
    return false;
  }
}

// Remplace resources/app par le contenu de app.zip (racine = dossier app/) via un
// script PowerShell détaché, puis relance l'app.
function applyAppZip(zipPath, version) {
  // Échappe les apostrophes pour les chaînes PowerShell (ex. C:\Users\O'Brien).
  const q = (s) => String(s).replace(/'/g, "''");
  const exe = process.execPath;
  const resourcesDir = process.resourcesPath; // <install>\resources
  const appPid = process.pid;
  // Nom de script imprévisible (voir dest plus haut, même raison).
  const ps = path.join(os.tmpdir(), `snipemc-appupdate-${crypto.randomUUID()}.ps1`);
  const script =
    "$ErrorActionPreference='SilentlyContinue'\r\n" +
    // Attendre la SORTIE RÉELLE du process (pas un sleep fixe) : sinon l'extraction
    // tourne pendant que l'app tient encore ses fichiers (electron + node_modules) et
    // échoue en silence -> MAJ non appliquée. + marge pour la libération des handles.
    `$appPid = ${appPid}\r\n` +
    '$deadline = (Get-Date).AddSeconds(30)\r\n' +
    'while ((Get-Process -Id $appPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }\r\n' +
    'Start-Sleep -Milliseconds 800\r\n' +
    // Anti zip-slip : System.IO.Compression.ZipFile (.NET Framework, utilisé par
    // Expand-Archive sous Windows PowerShell 5.1) ne rejette PAS les entrées portant
    // un chemin "..\" ou absolu comme le fait .NET Core -> on les rejette nous-mêmes
    // AVANT extraction (une release signée reste fiable, mais on se protège aussi
    // d'un bug d'outillage lors de la génération de l'archive).
    "Add-Type -AssemblyName System.IO.Compression.FileSystem\r\n" +
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${q(zipPath)}')\r\n` +
    '$bad = $false\r\n' +
    'foreach ($e in $zip.Entries) { if ($e.FullName -match "(^|[\\\\/])\\.\\.([\\\\/]|$)" -or [System.IO.Path]::IsPathRooted($e.FullName)) { $bad = $true; break } }\r\n' +
    '$zip.Dispose()\r\n' +
    'if ($bad) { exit 1 }\r\n' +
    // Retry : si un handle traîne encore, on retente quelques fois plutôt que d'échouer.
    '$done = $false\r\n' +
    `for ($i = 0; $i -lt 6 -and -not $done; $i++) { try { Expand-Archive -Path '${q(zipPath)}' -DestinationPath '${q(resourcesDir)}' -Force -ErrorAction Stop; $done = $true } catch { Start-Sleep -Milliseconds 700 } }\r\n` +
    'if (-not $done) { exit 2 }\r\n' +
    // Aligne la version affichée dans « Applications installées ».
    `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SnipeMC' -Name DisplayVersion -Value '${q(version || '')}'\r\n` +
    `Start-Process -FilePath '${q(exe)}'\r\n`;
  fs.writeFileSync(ps, script);
  launchDetached(`powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps}"`);
  setTimeout(() => app.quit(), 400);
}

// Lance une commande DÉTACHÉE qui SURVIT à la fermeture de l'app. Sur Windows,
// un enfant spawné directement hérite du « job object » d'Electron (kill-on-close)
// et est tué quand l'app quitte -> le script de MAJ ne s'exécutait jamais. `cmd start`
// crée un process qui rompt le job et survit.
function launchDetached(commandLine) {
  const child = spawn('cmd.exe', ['/c', `start "" /min ${commandLine}`], {
    detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  });
  child.unref();
}

// Lance l'installeur en silencieux via un script détaché qui attend la fin de
// l'install puis relance l'app (l'installeur ferme l'app en cours au démarrage).
function quitAndInstall(installerPath) {
  const exe = process.execPath;
  const script = path.join(os.tmpdir(), `snipemc-update-${crypto.randomUUID()}.cmd`);
  // ping = petite temporisation pour laisser l'app se fermer proprement.
  const body =
    '@echo off\r\n' +
    'ping 127.0.0.1 -n 2 >nul\r\n' +
    `"${installerPath}" /S\r\n` +
    `start "" "${exe}"\r\n`;
  fs.writeFileSync(script, body);
  launchDetached(`"${script}"`);
  setTimeout(() => app.quit(), 400);
}

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9 ._-]/g, '_');
}
