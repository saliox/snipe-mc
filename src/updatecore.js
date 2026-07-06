// Cœur de l'auto-update, sans dépendance à Electron (donc testable en Node pur).
//
// Source unique : GitHub Releases (autonome). Le dépôt public sert de flux,
// aucune config, aucun serveur, aucune adresse IP requise.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';

const UA = 'snipe-mc-updater';

// Clé publique Ed25519 figée à la compilation : ancre de confiance INDÉPENDANTE du
// compte/dépôt GitHub. Avant, l'intégrité d'une MAJ reposait uniquement sur un
// sha256 servi par la MÊME release GitHub que le binaire (digest ou latest.json) :
// un compte/PAT saliox compromis pouvait donc publier un binaire ET son "empreinte
// attendue" en même temps, contournant toute vérification. Avec cette signature,
// la clé privée correspondante (jamais committée, jamais sur GitHub) doit AUSSI
// être compromise pour forger une MAJ valide.
const UPDATE_PUBLIC_KEY_B64 = 'MCowBQYDK2VwAyEAjU+MOn6iCpIVAYFnejCKpqspzzxxPaqo1NeLunuRLEw=';

// Vérifie la signature Ed25519 de `payload` (objet {version,file,sha256,size} ou
// {version,electron,sha256,size}, sérialisé en JSON avec l'ORDRE DE CLÉS EXACT
// utilisé à la signature par scripts/publish-update.mjs).
export function verifyReleaseSignature(payload, signatureB64) {
  if (!signatureB64 || typeof signatureB64 !== 'string') return false;
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.from(UPDATE_PUBLIC_KEY_B64, 'base64'), format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.from(JSON.stringify(payload)), pub, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// Compare deux versions "x.y.z". Renvoie true si `a` est strictement plus récente que `b`.
export function isNewer(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

// --- Source GitHub Releases ---
// repo = "owner/name". Renvoie { version, url, file, size, sha256, notes, assets }.
export async function fetchLatestGithub(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const { statusCode, body } = await request(url, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
    maxRedirections: 3, headersTimeout: 6000, bodyTimeout: 10000,
  });
  if (statusCode !== 200) { await body.dump(); throw new Error(`GitHub API HTTP ${statusCode}`); }
  const rel = await body.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const assets = (rel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  const asset = assets.find((a) => /\.exe$/i.test(a.name)) || assets[0];
  if (!version || !asset) throw new Error('Release GitHub sans installeur .exe');

  // Le sha256 seul ne suffit plus comme preuve d'intégrité : GitHub le fournit lui-même
  // (champ `digest`), donc un compte/PAT compromis pourrait publier binaire ET empreinte
  // ensemble. On exige latest.json avec une SIGNATURE Ed25519 (clé indépendante de
  // GitHub, voir UPDATE_PUBLIC_KEY_B64) — sans ça, la MAJ est refusée.
  const metaAsset = assets.find((a) => a.name === 'latest.json');
  if (!metaAsset) throw new Error('Mise à jour refusée : latest.json (signature) absent de la release.');
  const meta = await fetchJson(metaAsset.url);
  if (!meta || meta.file !== asset.name || !meta.sha256 || !meta.size) {
    throw new Error('Mise à jour refusée : latest.json incomplet ou incohérent avec l\'asset.');
  }
  const payload = { version: meta.version, file: meta.file, sha256: meta.sha256, size: meta.size };
  if (!verifyReleaseSignature(payload, meta.signature)) {
    throw new Error('Mise à jour refusée : signature de la release invalide ou absente.');
  }

  return { version, url: asset.url, file: asset.name, size: asset.size, sha256: meta.sha256, notes: rel.body || '', assets };
}

// Télécharge et parse un petit asset JSON (métadonnées de MAJ différentielle).
export async function fetchJson(url) {
  const { statusCode, body } = await request(url, { headers: { 'user-agent': UA }, maxRedirections: 3, headersTimeout: 5000, bodyTimeout: 8000 });
  if (statusCode !== 200) { await body.dump(); throw new Error(`JSON HTTP ${statusCode}`); }
  return body.json();
}

// Télécharge info.url dans `dest`, vérifie le SHA-256 si connu, renvoie `dest`.
// onProgress({ received, total, pct }) est appelé pendant le téléchargement.
export async function downloadTo(info, dest, onProgress) {
  // Vérification d'intégrité OBLIGATOIRE : sans sha256 attendu, on refuse d'installer
  // (un flux altéré pourrait omettre le hash pour contourner le contrôle -> RCE).
  if (!info || !info.sha256 || !String(info.sha256).trim()) {
    fs.rmSync(dest, { force: true });
    throw new Error('Mise à jour refusée : aucun SHA-256 fourni — vérification d\'intégrité impossible.');
  }
  const { statusCode, headers, body } = await request(info.url, {
    maxRedirections: 5,
    headers: { 'user-agent': UA },
  });
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
  if (digest !== String(info.sha256).toLowerCase()) {
    fs.rmSync(dest, { force: true });
    throw new Error('Somme de contrôle SHA-256 invalide — fichier corrompu ou altéré.');
  }
  return dest;
}

