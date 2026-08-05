// Gate d'abonnement (Stripe 3 €/mois) — process main.
//
// DÉSACTIVÉ PAR DÉFAUT : sans SUB_GATE=1 (+ SUPABASE_URL/ANON_KEY) dans le .env,
// isEnabled() = false, resolveEntry() renvoie index.html, tous les IPC sont inertes
// et les gardes sont des no-op → l'app se comporte EXACTEMENT comme avant.
//
// Sécurité : l'état d'abonnement honoré hors-ligne est un JETON SIGNÉ Ed25519 par le
// serveur (edge function). Chiffrer le cache ne suffirait pas (la clé securebox est
// recalculable par l'utilisateur → forge triviale d'un `active`) : c'est la SIGNATURE
// qui empêche la forge. Binding machine (device) anti-partage + horloge NTP anti-rollback.
// Réalisme : binaire public (auto-update) → un reverser contourne ; ça protège
// l'utilisateur lambda (licensing poli), pas un cracker.
import { app, shell } from 'electron';
import { request } from 'undici';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveEncrypted, loadEncrypted } from '../src/securebox.js';
import { bestOffset } from '../src/ntp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Clé PUBLIQUE Ed25519 d'entitlement (SPKI DER base64) — figée à la compilation.
// Pendant public de ENT_PRIVATE_KEY_PKCS8_B64 (secret de l'edge function). La privée
// ne quitte JAMAIS le serveur (comme la clé de signature des MAJ reste locale).
const ENT_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAO1Ug2gm39aRC+pPrXQqK3bDx5Loo6xCBLMmjpPiOE/8=';

const FRESH_S = 6 * 3600;   // en deçà : déverrouille sans réseau (fast path)
const CLOCK_SKEW = 5 * 60;  // tolérance anti-rollback

const RENDERER = (f) => path.join(__dirname, 'renderer', f); // == main.js
const INDEX = () => RENDERER('index.html');
const GATE = () => RENDERER('gate.html');
const SESSION_FILE = () => path.join(app.getPath('userData'), 'subgate.session');
const CACHE_FILE = () => path.join(app.getPath('userData'), 'subgate.cache');

let verified = false; // source de vérité du guard IPC (état main)

export function isEnabled() {
  return process.env.SUB_GATE === '1'
    && !!(process.env.SUPABASE_URL || '').trim()
    && !!(process.env.SUPABASE_ANON_KEY || '').trim();
}
export function isVerified() { return verified; }

const SB = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const ANON = () => (process.env.SUPABASE_ANON_KEY || '').trim();
const deviceId = crypto.createHash('sha256')
  .update(os.hostname() + '|' + os.userInfo().username).digest('hex');

let ENT_PUB = null;
function entPub() {
  if (!ENT_PUB) ENT_PUB = crypto.createPublicKey({ key: Buffer.from(ENT_PUBLIC_KEY_SPKI_B64, 'base64'), format: 'der', type: 'spki' });
  return ENT_PUB;
}
// Ordre de clés IDENTIQUE au serveur (edge function). Doit correspondre octet pour octet.
const canonical = (p) =>
  JSON.stringify({ uid: p.uid, device: p.device, active: p.active, status: p.status, grace_until: p.grace_until, iat: p.iat });

function verifyToken(tok) {
  try {
    if (!tok || !tok.payload || !tok.sig) return null;
    if (!crypto.verify(null, Buffer.from(canonical(tok.payload)), entPub(), Buffer.from(tok.sig, 'base64'))) return null; // forge → rejet
    if (tok.payload.device !== deviceId) return null; // anti-partage machine
    return tok.payload;
  } catch { return null; }
}

function readCache() { try { return loadEncrypted(CACHE_FILE()); } catch { return null; } }
function writeCache(o) { try { saveEncrypted(CACHE_FILE(), o); } catch { /* non bloquant */ } }
function readSession() { try { return loadEncrypted(SESSION_FILE()); } catch { return null; } }
function writeSession(o) { try { saveEncrypted(SESSION_FILE(), o); } catch { /* non bloquant */ } }
export function logout() {
  verified = false;
  try { fs.rmSync(SESSION_FILE(), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(CACHE_FILE(), { force: true }); } catch { /* ignore */ }
}

async function trustedNowSec() { // horloge de confiance (NTP) ; null si injoignable
  try { const { offset } = await bestOffset(); return Math.floor((Date.now() + offset) / 1000); }
  catch { return null; }
}

// --- Décision d'entrée SYNCHRONE (appelée dans createWindow) ---
export function resolveEntry() {
  if (!isEnabled()) return INDEX();
  const cached = readCache();
  const p = cached && verifyToken(cached);
  if (p) {
    const now = Math.floor(Date.now() / 1000);
    const rolledBack = cached.seen && now < cached.seen - CLOCK_SKEW; // horloge reculée sous le dernier point de confiance
    if (!rolledBack && p.active && now < p.grace_until) {
      verified = true;
      if (now > (cached.seen || 0) + FRESH_S) revalidateInBackground(); // rafraîchit sans expulser ce run
      return INDEX();
    }
  }
  return GATE();
}

// --- Auth Supabase (REST) ---
async function passwordLogin(email, password) {
  const { statusCode, body } = await request(`${SB()}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON(), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }), headersTimeout: 8000, bodyTimeout: 8000,
  });
  const j = await body.json().catch(() => ({}));
  if (statusCode !== 200) return { ok: false, error: j.error_description || j.msg || 'Identifiants invalides' };
  writeSession({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000,
    userId: j.user?.id, email: j.user?.email,
  });
  return { ok: true };
}
async function signup(email, password) {
  const { statusCode, body } = await request(`${SB()}/auth/v1/signup`, {
    method: 'POST', headers: { apikey: ANON(), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }), headersTimeout: 8000, bodyTimeout: 8000,
  });
  const j = await body.json().catch(() => ({}));
  if (statusCode >= 400) return { ok: false, error: j.error_description || j.msg || 'Inscription refusée' };
  return { ok: true, needConfirm: !j.access_token }; // true si confirmation email activée dans Supabase
}
async function ensureAccessToken() {
  let s = readSession();
  if (!s) return null;
  if (Date.now() < s.expires_at - 60_000) return s;
  const { statusCode, body } = await request(`${SB()}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: ANON(), 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }), headersTimeout: 8000, bodyTimeout: 8000,
  });
  const j = await body.json().catch(() => ({}));
  if (statusCode !== 200) return null;
  s = { ...s, access_token: j.access_token, refresh_token: j.refresh_token,
        expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000 };
  writeSession(s);
  return s;
}

// --- Entitlement : appel backend + vérif signature + cache ---
async function fetchEntitlement() {
  const s = await ensureAccessToken();
  if (!s) return { ok: false, needLogin: true };
  let statusCode, body;
  try {
    ({ statusCode, body } = await request(`${SB()}/functions/v1/subscription-status`, {
      method: 'POST',
      headers: { apikey: ANON(), authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device: deviceId }), headersTimeout: 8000, bodyTimeout: 8000,
    }));
  } catch { return { ok: false, offline: true }; }
  if (statusCode === 401) return { ok: false, needLogin: true };
  if (statusCode >= 500) return { ok: false, offline: true };

  const tok = await body.json().catch(() => null);
  const p = verifyToken(tok);
  if (!p) return { ok: false, error: 'Jeton serveur invalide.' };

  const nowNtp = await trustedNowSec();
  const now = nowNtp ?? Math.floor(Date.now() / 1000);
  const prev = readCache();
  if (prev?.seen && now < prev.seen - CLOCK_SKEW) return { ok: false, error: 'Horloge reculée.' }; // refuse d'étendre
  writeCache({ ...tok, seen: now });
  const entitled = p.active && now < p.grace_until;
  verified = entitled || verified; // ne rétrograde pas un fast-path déjà déverrouillé ce run
  return { ok: true, entitled, status: p.status, email: s.email };
}
function revalidateInBackground() { fetchEntitlement().catch(() => {}); }

// --- API IPC (consommée par gate.html) ---
export async function ipcState() {
  const s = readSession(); const c = readCache(); const p = c && verifyToken(c);
  const now = Math.floor(Date.now() / 1000);
  return {
    enabled: isEnabled(), hasSession: !!s, email: s?.email || null,
    cachedEntitled: !!(p && p.active && now < p.grace_until),
    paymentLink: !!(process.env.STRIPE_PAYMENT_LINK || '').trim(),
  };
}
export async function ipcLogin(email, password) {
  const r = await passwordLogin(email, password);
  if (!r.ok) return r;
  return fetchEntitlement();
}
export async function ipcSignup(email, password) { return signup(email, password); }
export async function ipcRefresh() {
  const r = await fetchEntitlement();
  if (r.offline) return { ok: false, offline: true, error: 'Backend injoignable, réessaie.' };
  return r;
}
export async function ipcOpenCheckout() {
  const s = readSession();
  const base = (process.env.STRIPE_PAYMENT_LINK || '').trim();
  if (!base || !s?.userId) return { ok: false, error: 'Indisponible (abonne-toi après connexion).' };
  const url = `${base}?client_reference_id=${encodeURIComponent(s.userId)}&prefilled_email=${encodeURIComponent(s.email || '')}`;
  await shell.openExternal(url).catch(() => {});
  return { ok: true };
}
export function ipcLogout() { logout(); return { ok: true }; }
