// Construit un installeur Windows (Setup.exe) avec NSIS, SANS electron-builder.
// Fonctionne hors-ligne tant que NSIS est présent (fourni via le cache
// electron-builder, ou un NSIS installé sur le système / défini par NSIS_DIR).
//
//   node scripts/build-installer.mjs
//
// Étapes : (1) s'assure que le portable existe (sinon le construit),
//          (2) localise makensis.exe, (3) compile build/installer.nsi.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const portableDir = path.join(root, 'dist', 'Snipe MC-portable');
const outFile = path.join(root, 'dist', `Snipe MC Setup ${version}.exe`);
const nsi = path.join(root, 'build', 'installer.nsi');

// 1. Reconstruit TOUJOURS le portable pour empaqueter le code courant (sinon
//    l'installeur réutilise un vieux portable → app périmée).
{
  console.log('(Re)construction du portable...');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-portable.mjs')], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(path.join(portableDir, 'Snipe MC.exe'))) process.exit(r.status || 1);
}

// 2. Localiser makensis.exe (priorité : NSIS_DIR, PATH, cache electron-builder, Program Files)
function findMakensis() {
  if (process.env.NSIS_DIR) {
    const p = path.join(process.env.NSIS_DIR, 'makensis.exe');
    if (fs.existsSync(p)) return p;
  }
  try {
    const which = execSync('where makensis', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    if (which && fs.existsSync(which)) return which;
  } catch { /* pas dans le PATH */ }

  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache'),
    path.join('C:', 'Program Files (x86)', 'NSIS'),
    path.join('C:', 'Program Files', 'NSIS'),
  ];
  for (const base of roots) {
    const hit = walkFind(base, 'makensis.exe');
    if (hit) return hit;
  }
  return null;
}

function walkFind(dir, name, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  // Préfère un makensis.exe à la racine d'un dossier NSIS (NSISDIR bien résolu).
  const direct = entries.find((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
  if (direct && fs.existsSync(path.join(dir, 'Include'))) return path.join(dir, direct.name);
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = walkFind(path.join(dir, e.name), name, depth - 1);
      if (found) return found;
    }
  }
  if (direct) return path.join(dir, direct.name);
  return null;
}

const makensis = findMakensis();
if (!makensis) {
  console.error('makensis.exe introuvable. Installe NSIS (https://nsis.sourceforge.io) ' +
    'ou définis NSIS_DIR, ou lance d\'abord `npm run dist` une fois pour peupler le cache.');
  process.exit(1);
}
console.log('makensis :', makensis);

// 3. Compiler. spawn en tableau d'args -> pas de re-découpage des espaces par le shell.
fs.rmSync(outFile, { force: true });
const iconPath = path.join(root, 'build', 'icon.ico');
const args = [
  `/DAPP_VERSION=${version}`,
  `/DSRC_DIR=${portableDir}`,
  `/DOUT_FILE=${outFile}`,
];
if (fs.existsSync(iconPath)) args.push(`/DAPP_ICON=${iconPath}`);
args.push(nsi);
const res = spawnSync(makensis, args, { stdio: 'inherit' });
if (res.status !== 0) { console.error('Échec de la compilation NSIS.'); process.exit(res.status || 1); }

const size = (fs.statSync(outFile).size / 1e6).toFixed(1);
console.log(`\nInstalleur prêt : ${outFile} (${size} Mo)`);
