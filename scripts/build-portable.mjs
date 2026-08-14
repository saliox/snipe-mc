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
import * as asar from '@electron/asar';

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

// 2. App (+ dossier build/ pour l'icône lue au runtime) — empaquetée en .asar, PAS
//    livrée en fichiers .js bruts (durcissement post-audit : avant ce correctif,
//    TOUT le code de l'app — y compris le moteur de snipe : src/auth.js,
//    src/sniper.js, src/mojang.js, src/nameapi.js, src/ntp.js, src/securebox.js —
//    finissait en clair, lisible/copiable, dans resources/app/, et
//    build/installer.nsi l'installait tel quel via `File /r`). On assemble d'abord
//    dans un dossier de STAGING temporaire (hors resources/, jamais livré tel quel),
//    puis on l'empaquette en resources/app.asar : Electron lit un .asar nativement
//    (aucun changement ailleurs dans le code), donc plus aucun .js source ne se
//    retrouve posé nu sur le disque de l'utilisateur.
//    ⚠️ Un .asar n'est PAS un coffre-fort : `npx asar extract` le déballe en une
//    commande. Le VRAI rempart contre le bypass moteur est le gate CÔTÉ ENGINE
//    (src/entitlement.js, appelé par snipe()/changeName()/getValidToken()/
//    loginInteractive()) — ceci n'est qu'une couche de durcissement supplémentaire
//    (ne plus exposer le code source en clair par défaut), pas une preuve
//    d'inviolabilité.
const stageDir = path.join(out, '.stage-app');
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, 'node_modules'), { recursive: true });
// SÉCURITÉ (gate d'abonnement) : ne PAS livrer le CLI src/index.js dans l'app packagée.
// C'est un moteur de snipe complet qui, en CLI, appelle loginInteractive()/getValidToken()/
// snipe() SANS jeton d'entitlement (ces derniers sont désormais gatés eux-mêmes, cf
// src/entitlement.js — audit "moteur nu") : l'exposer ne romprait donc plus le gate,
// mais autant ne pas fournir gratuitement un point d'entrée CLI dans le produit packagé.
const EXCLUDE = new Set([path.resolve(root, 'src', 'index.js')]);
for (const item of ['gui', 'src', 'package.json', 'build']) {
  fs.cpSync(path.join(root, item), path.join(stageDir, item), {
    recursive: true,
    filter: (s) => !EXCLUDE.has(path.resolve(s)),
  });
}
for (const dep of RUNTIME_DEPS) {
  fs.cpSync(path.join(root, 'node_modules', dep), path.join(stageDir, 'node_modules', dep), { recursive: true });
}
const appAsar = path.join(out, 'resources', 'app.asar');
fs.rmSync(appAsar, { force: true });
await asar.createPackage(stageDir, appAsar);
fs.rmSync(stageDir, { recursive: true, force: true }); // aucun .js brut ne reste sur disque

// 3. Modèle .env à côté de l'exe (l'app le cherche là en priorité)
fs.copyFileSync(path.join(root, '.env.example'), path.join(out, '.env.example'));

console.log(`Portable prêt : ${out}`);
console.log('Lance "Snipe MC.exe". Place un fichier .env (voir .env.example) à côté.');
