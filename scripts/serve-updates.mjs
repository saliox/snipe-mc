// Mini-serveur HTTP (zéro dépendance) pour héberger les mises à jour depuis un
// autre PC. Sert le dossier release/ sur le réseau local.
//
//   npm run serve:updates              (port 8770 par défaut)
//   UPDATE_PORT=9000 npm run serve:updates
//
// Sur chaque PC client, mets l'URL affichée dans .env :  UPDATE_URL=http://<ip>:<port>/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.join(root, 'release');
const port = Number(process.env.UPDATE_PORT) || 8770;

if (!fs.existsSync(path.join(releaseDir, 'latest.json'))) {
  console.error('release/latest.json introuvable. Lance d\'abord :  node scripts/publish-update.mjs');
  process.exit(1);
}

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  // Sécurité : on reste confiné à release/ (pas de traversée de chemin).
  const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
  const target = path.join(releaseDir, name || 'latest.json');
  if (!target.startsWith(releaseDir)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(target).pipe(res);
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url} -> ${name} (${st.size} o)`);
  });
});

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(port, '0.0.0.0', () => {
  console.log(`Serveur de mises à jour sur le port ${port}. Ctrl+C pour arrêter.`);
  const addrs = lanAddresses();
  if (addrs.length) {
    console.log('\nRenseigne UPDATE_URL sur les PC clients avec l\'une de ces adresses :');
    for (const a of addrs) console.log(`  UPDATE_URL=http://${a}:${port}/`);
  } else {
    console.log('Aucune IP LAN détectée ; utilise l\'IP de cette machine.');
  }
  console.log('\n(Le pare-feu Windows peut demander d\'autoriser Node.js sur le réseau privé.)');
});
