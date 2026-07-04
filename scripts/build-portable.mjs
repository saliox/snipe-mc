// Assemble une version portable de l'app SANS electron-builder (100% hors-ligne).
// Utile quand electron-builder est bloqué (téléchargement winCodeSign / privilège
// de symlink manquant). Produit dist/Snipe MC-portable/ avec "Snipe MC.exe".
//
//   node scripts/build-portable.mjs
//
// Pour l'installeur .exe classique (NSIS) sur une machine avec Mode développeur
// ou droits admin : npm run dist
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(root, 'dist', 'Snipe MC-portable');
const RUNTIME_DEPS = ['undici', 'dotenv']; // deps de prod (zéro dep transitive)

// Localise rcedit (fourni dans le cache winCodeSign d'electron-builder) et
// remplace l'icône de l'exe. Silencieux si introuvable (pas bloquant).
function applyExeIcon(exe, ico) {
  if (!fs.existsSync(ico)) return;
  const base = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign');
  let rcedit = null;
  const stack = fs.existsSync(base) ? [base] : [];
  while (stack.length && !rcedit) {
    const dir = stack.pop();
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && /rcedit-x64\.exe$/i.test(e.name)) { rcedit = p; break; }
      if (e.isDirectory()) stack.push(p);
    }
  }
  if (!rcedit) { console.log('  (rcedit introuvable — icône de fenêtre OK, icône du .exe inchangée)'); return; }
  const r = spawnSync(rcedit, [exe, '--set-icon', ico], { stdio: 'ignore' });
  console.log(r.status === 0 ? '  icône du .exe appliquée (rcedit)' : '  (rcedit a échoué — non bloquant)');
}

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  console.error('Binaire Electron introuvable. Lance d\'abord: npm install');
  process.exit(1);
}

// N'efface QUE le dossier portable, pas tout dist/ (sinon on perd les installeurs).
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 0. Génère l'icône si absente.
if (!fs.existsSync(path.join(root, 'build', 'icon.png'))) {
  spawnSync(process.execPath, [path.join(root, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
}

// 1. Runtime Electron
fs.cpSync(electronDist, out, { recursive: true });
const exePath = path.join(out, 'Snipe MC.exe');
fs.renameSync(path.join(out, 'electron.exe'), exePath);
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });

// 1b. Applique l'icône au .exe (rcedit du cache electron-builder, si dispo).
applyExeIcon(exePath, path.join(root, 'build', 'icon.ico'));

// 2. App (+ dossier build/ pour l'icône lue au runtime)
const appDir = path.join(out, 'resources', 'app');
fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
for (const item of ['gui', 'src', 'package.json', 'build']) {
  fs.cpSync(path.join(root, item), path.join(appDir, item), { recursive: true });
}
for (const dep of RUNTIME_DEPS) {
  fs.cpSync(path.join(root, 'node_modules', dep), path.join(appDir, 'node_modules', dep), { recursive: true });
}

// 3. Modèle .env à côté de l'exe (l'app le cherche là en priorité)
fs.copyFileSync(path.join(root, '.env.example'), path.join(out, '.env.example'));

console.log(`Portable prêt : ${out}`);
console.log('Lance "Snipe MC.exe". Place un fichier .env (voir .env.example) à côté.');
