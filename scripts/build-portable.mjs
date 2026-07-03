// Assemble une version portable de l'app SANS electron-builder (100% hors-ligne).
// Utile quand electron-builder est bloqué (téléchargement winCodeSign / privilège
// de symlink manquant). Produit dist/Snipe MC-portable/ avec "Snipe MC.exe".
//
//   node scripts/build-portable.mjs
//
// Pour l'installeur .exe classique (NSIS) sur une machine avec Mode développeur
// ou droits admin : npm run dist
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(root, 'dist', 'Snipe MC-portable');
const RUNTIME_DEPS = ['undici', 'dotenv']; // deps de prod (zéro dep transitive)

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  console.error('Binaire Electron introuvable. Lance d\'abord: npm install');
  process.exit(1);
}

// N'efface QUE le dossier portable, pas tout dist/ (sinon on perd les installeurs).
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// 1. Runtime Electron
fs.cpSync(electronDist, out, { recursive: true });
fs.renameSync(path.join(out, 'electron.exe'), path.join(out, 'Snipe MC.exe'));
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });

// 2. App
const appDir = path.join(out, 'resources', 'app');
fs.mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
for (const item of ['gui', 'src', 'package.json']) {
  fs.cpSync(path.join(root, item), path.join(appDir, item), { recursive: true });
}
for (const dep of RUNTIME_DEPS) {
  fs.cpSync(path.join(root, 'node_modules', dep), path.join(appDir, 'node_modules', dep), { recursive: true });
}

// 3. Modèle .env à côté de l'exe (l'app le cherche là en priorité)
fs.copyFileSync(path.join(root, '.env.example'), path.join(out, '.env.example'));

console.log(`Portable prêt : ${out}`);
console.log('Lance "Snipe MC.exe". Place un fichier .env (voir .env.example) à côté.');
