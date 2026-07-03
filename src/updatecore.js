// Cœur de l'auto-update, sans dépendance à Electron (donc testable en Node pur).
// Le flux de mise à jour est un simple dossier HTTP hébergé sur un autre PC :
//   <feed>/latest.json          -> { version, file, sha256, size, notes }
//   <feed>/Snipe MC Setup X.Y.Z.exe
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';

// Compare deux versions "x.y.z". Renvoie true si `a` est strictement plus récente que `b`.
export function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

// Récupère et valide latest.json depuis le flux.
export async function fetchLatest(feedBase) {
  const url = new URL('latest.json', ensureSlash(feedBase)).toString();
  const { statusCode, body } = await request(url, {
    method: 'GET',
    headersTimeout: 5000,
    bodyTimeout: 8000,
  });
  if (statusCode !== 200) { await body.dump(); throw new Error(`latest.json HTTP ${statusCode}`); }
  const info = await body.json();
  if (!info || !info.version || !info.file) throw new Error('latest.json invalide (version/file manquants)');
  return info;
}

// Télécharge l'installeur dans `dest`, vérifie le SHA-256, renvoie `dest`.
// onProgress({ received, total, pct }) est appelé pendant le téléchargement.
export async function downloadTo(feedBase, info, dest, onProgress) {
  const url = new URL(encodeURIComponent(info.file), ensureSlash(feedBase)).toString();
  const { statusCode, headers, body } = await request(url, { maxRedirections: 2 });
  if (statusCode !== 200) { await body.dump(); throw new Error(`téléchargement HTTP ${statusCode}`); }

  const total = Number(info.size) || Number(headers['content-length']) || 0;
  let received = 0;
  const hash = crypto.createHash('sha256');
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hash.update(chunk);
      if (onProgress) onProgress({ received, total, pct: total ? Math.round((received / total) * 100) : 0 });
      cb(null, chunk);
    },
  });

  await pipeline(body, meter, fs.createWriteStream(dest));

  const digest = hash.digest('hex').toLowerCase();
  if (info.sha256 && digest !== String(info.sha256).toLowerCase()) {
    fs.rmSync(dest, { force: true });
    throw new Error('Somme de contrôle SHA-256 invalide — fichier corrompu ou altéré.');
  }
  return dest;
}

function ensureSlash(base) {
  return base.endsWith('/') ? base : base + '/';
}
