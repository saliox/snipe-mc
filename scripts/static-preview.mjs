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
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, () => console.log(`preview statique sur http://localhost:${port}`));
