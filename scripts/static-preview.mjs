// Serveur statique jetable pour prévisualiser l'UI (gui/renderer) dans un navigateur.
// Uniquement pour le dev/design — l'app réelle tourne sous Electron.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'gui', 'renderer');
const port = Number(process.env.PORT) || 4599;
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  let name = decodeURIComponent((req.url || '/').split('?')[0]);
  if (name === '/') name = '/index.html';
  const file = path.join(dir, name.replace(/^\/+/, ''));
  // path.relative + vérif de séparateur : un simple startsWith(dir) laisserait passer
  // un dossier frère dont le nom commence par "renderer" (ex. ../renderer-evil/x).
  const rel = path.relative(dir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
// 127.0.0.1 explicite : serveur de dev uniquement, pas d'exposition LAN par défaut.
}).listen(port, '127.0.0.1', () => console.log(`preview statique sur http://localhost:${port}`));
