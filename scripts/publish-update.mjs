// Prépare une mise à jour à héberger : construit l'installeur si besoin, calcule
// son SHA-256, et écrit release/latest.json + une copie de l'installeur.
//
//   node scripts/publish-update.mjs ["notes de version"]
//
// Ensuite, héberge le dossier release/ avec :  npm run serve:updates
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const notes = process.argv.slice(2).join(' ');

const installerName = `Snipe MC Setup ${version}.exe`;
const installerPath = path.join(root, 'dist', installerName);
const releaseDir = path.join(root, 'release');

// 1. S'assurer que l'installeur de cette version existe.
if (!fs.existsSync(installerPath)) {
  console.log(`Installeur ${version} absent, construction...`);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-installer.mjs')], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(installerPath)) {
    console.error('Échec de la construction de l\'installeur.');
    process.exit(1);
  }
}

// 2. SHA-256 + taille.
const buf = fs.readFileSync(installerPath);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const size = buf.length;

// 3. Dossier release/ : installeur + latest.json.
fs.mkdirSync(releaseDir, { recursive: true });
fs.copyFileSync(installerPath, path.join(releaseDir, installerName));

const latest = {
  version,
  file: installerName,
  sha256,
  size,
  notes,
  pubDate: new Date().toISOString(),
};
fs.writeFileSync(path.join(releaseDir, 'latest.json'), JSON.stringify(latest, null, 2));

console.log('Mise à jour publiée dans release/ :');
console.log(`  version : ${version}`);
console.log(`  fichier : ${installerName} (${(size / 1e6).toFixed(1)} Mo)`);
console.log(`  sha256  : ${sha256}`);
console.log('\nProchaine étape (sur le PC hébergeur) :  npm run serve:updates');
