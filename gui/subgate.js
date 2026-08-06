// Gate d'abonnement (Stripe 3 €/mois) — process main.
//
// OFF par défaut : sans SUB_GATE=1 (+ SUPABASE_URL/ANON_KEY), l'app est inchangée
// (resolveEntry → index.html, gardes gateLocked() no-op).
//
// Durcissements post-audit :
//  - Config BAKÉE au build (gate-config.js) en packagé → pas désactivable via .env (C2).
//  - Décision d'accès SERVEUR-AUTORITAIRE si le backend est joignable ; sinon grâce
//    hors-ligne BORNÉE, jugée sur une HEURE DE CONFIANCE (NTP) comparée aux champs
//    SIGNÉS (iat/grace_until) + plafond OFFLINE_MAX — plus de bypass "gel d'horloge"
//    ni de faux-verrouillage d'un abonné dont l'horloge locale retarde (H1/H2).
//  - resolveEntry ne fait AUCUN fast-path cache→index (le check a lieu dans gate.html).
//  - Jeton lié à l'uid de session (B1) ; erreurs réseau gérées (M5) ; refresh dédupliqué
//    (B6) ; deviceId paresseux (B3) ; URL validée https (B4).
//
// Réalisme : binaire public → un reverser contourne. Ça protège l'utilisateur lambda
// (extract asar / éditer un .env ne suffit plus), pas un cracker.
import { app, shell } from 'electron';
import { request } from 'undici';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveEncrypted, loadEncrypted } from '../src/securebox.js';
import { bestOffset } from '../src/ntp.js';
import { GATE } from './gate-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Clé PUBLIQUE Ed25519 d'entitlement (SPKI DER base64) — figée. Pendant public de
// ENT_PRIVATE_KEY_PKCS8_B64 (secret de l'edge function).
const ENT_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAO1Ug2gm39aRC+pPrXQqK3bDx5Loo6xCBLMmjpPiOE/8=';

const OFFLINE_MAX = 7 * 24 * 3600; // plafond DUR de fonctionnement hors-ligne (s)

const RENDERER = (f) => path.join(__dirname, 'renderer', f);
const INDEX = () => RENDERER('index.html');
const GATE_HTML = () => RENDERER('gate.html');
const SESSION_FILE = () => path.join(app.getPath('userData'), 'subgate.session');
const CACHE_FILE = () => path.join(app.getPath('userData'), 'subgate.cache');

let verified = false; // source de vérité du guard IPC (état main)

// Config : en packagé, SEULE gate-config.js compte (non éditable via .env). En dev,
// le .env peut surcharger (pratique pour tester).
function cfg(k) {
  const baked = (GATE[k] || '').trim();
  if (app.isPackaged) return baked;
  return (process.env[k] || '').trim() || baked;
}

export function isEnabled() {
  return cfg('SUB_GATE') === '1' && !!cfg('SUPABASE_URL') && !!cfg('SUPABASE_ANON_KEY');
}
export function isVerified() { return verified; }

const SB = () => cfg('SUPABASE_URL').replace(/\/+$/, '');
const ANON = () => cfg('SUPABASE_ANON_KEY');

// Validation https (B4) : refuse http:// (creds en clair) et URL malformée.
function backendOk() {
  try { const u = new URL(SB()); return u.protocol === 'https:' && !!ANON(); }
  catch { return false; }
}

// deviceId paresseux + mémoïsé (B3 : pas d'os.userInfo() au top-level, zéro effet si OFF).
let _deviceId = null;
function deviceId() {
  if (!_deviceId) {
    try { _deviceId = crypto.createHash('sha256').update(os.hostname() + '|' + os.userInfo().username).digest('hex'); }
    catch { _deviceId = 'unknown'; }
  }
  return _deviceId;
}

let ENT_PUB = null;
function entPub() {
  if (!ENT_PUB) ENT_PUB = crypto.createPublicKey({ key: Buffer.from(ENT_PUBLIC_KEY_SPKI_B64, 'base64'), format: 'der', type: 'spki' });
  return ENT_PUB;
}
// Ordre de clés IDENTIQUE au serveur (edge function). Octet pour octet.
const canonical = (p) =>
  JSON.stringify({ uid: p.uid, device: p.device, active: p.active, status: p.status, grace_until: p.grace_until, iat: p.iat });

function verifyToken(tok) {
  try {
    if (!tok || !tok.payload || !tok.sig) return null;
    if (!crypto.verify(null, Buffer.from(canonical(tok.payload)), entPub(), Buffer.from(tok.sig, 'base64'))) return null; // forge → rejet
    if (tok.payload.device !== deviceId()) return null; // anti-copie du cache sur une autre machine
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

async function trustedNowSec() { // heure de confiance (NTP) ; null si injoignable
  try { const { offset } = await bestOffset(); return Math.floor((Date.now() + offset) / 1000); }
  catch { return null; }
}

// --- Décision d'entrée SYNCHRONE : gate.html si le gate est actif (le check réel a
// lieu dans gate.html via ipcAccess). Aucun fast-path cache→index (fermeture du bypass). ---
export function resolveEntry() {
  return isEnabled() ? GATE_HTML() : INDEX();
}

// --- Auth Supabase (REST) — toutes les requêtes réseau protégées (M5) ---
async function post(url, bodyObj, headers) {
  try {
    const { statusCode, body } = await request(url, {
      method: 'POST', headers: { apikey: ANON(), 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(bodyObj), headersTimeout: 8000, bodyTimeout: 8000,
    });
    const j = await body.json().catch(() => ({}));
    return { statusCode, j };
  } catch (e) { return { statusCode: 0, j: {}, netError: e.message }; }
}

async function passwordLogin(email, password) {
  if (!backendOk()) return { ok: false, error: 'Backend non configuré.' };
  const { statusCode, j, netError } = await post(`${SB()}/auth/v1/token?grant_type=password`, { email, password });
  if (netError) return { ok: false, offline: true, error: 'Réseau indisponible.' };
  if (statusCode !== 200) return { ok: false, error: j.error_description || j.msg || 'Identifiants invalides' };
  writeSession({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000,
    userId: j.user?.id, email: j.user?.email,
  });
  return { ok: true };
}
async function signup(email, password) {
  if (!backendOk()) return { ok: false, error: 'Backend non configuré.' };
  const { statusCode, j, netError } = await post(`${SB()}/auth/v1/signup`, { email, password });
  if (netError) return { ok: false, offline: true, error: 'Réseau indisponible.' };
  if (statusCode >= 400) return { ok: false, error: j.error_description || j.msg || 'Inscription refusée' };
  return { ok: true, needConfirm: !j.access_token };
}

// Refresh dédupliqué (B6) : une seule requête en vol partagée.
let refreshInFlight = null;
async function ensureAccessToken() {
  const s = readSession();
  if (!s) return null;
  if (Date.now() < s.expires_at - 60_000) return s;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { statusCode, j, netError } = await post(`${SB()}/auth/v1/token?grant_type=refresh_token`, { refresh_token: s.refresh_token });
      if (netError) return { offline: true };
      if (statusCode !== 200) return null;
      const ns = { ...s, access_token: j.access_token, refresh_token: j.refresh_token,
                   expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000 };
      writeSession(ns);
      return ns;
    })().finally(() => { refreshInFlight = null; });
  }
  const r = await refreshInFlight;
  return (r && r.offline) ? { offline: true } : r;
}

// --- Entitlement : appel backend + vérif signature + cache (jamais de décision sur
// un champ non signé ; online_ok = dernier check EN LIGNE réussi, en heure de confiance) ---
async function fetchEntitlement() {
  const s = await ensureAccessToken();
  if (!s) return { ok: false, needLogin: true };
  if (s.offline) return { ok: false, offline: true };
  let statusCode, body;
  try {
    ({ statusCode, body } = await request(`${SB()}/functions/v1/subscription-status`, {
      method: 'POST',
      headers: { apikey: ANON(), authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device: deviceId() }), headersTimeout: 8000, bodyTimeout: 8000,
    }));
  } catch { return { ok: false, offline: true }; }
  if (statusCode === 401) return { ok: false, needLogin: true };
  if (statusCode >= 500 || statusCode === 0) return { ok: false, offline: true };

  const tok = await body.json().catch(() => null);
  const p = verifyToken(tok);
  if (!p) return { ok: false, error: 'Jeton serveur invalide.' };
  if (p.uid !== s.userId) return { ok: false, error: 'Jeton pour un autre compte.' };

  const now = (await trustedNowSec()) ?? Math.floor(Date.now() / 1000);
  writeCache({ ...tok, online_ok: now }); // heure de CONFIANCE du dernier online OK
  const entitled = p.active && now < p.grace_until;
  verified = entitled; // serveur autoritaire : peut rétrograder
  return { ok: true, entitled, status: p.status, email: s.email };
}

// Décision d'accès (appelée par gate.html) : serveur d'abord, sinon grâce bornée.
async function checkAccess() {
  const sess = readSession();
  if (!sess) return { entitled: false, needLogin: true };
  const online = await fetchEntitlement();
  if (online.ok) return { entitled: online.entitled, status: online.status, email: sess.email };
  if (online.needLogin) return { entitled: false, needLogin: true };
  // Hors-ligne : n'honorer la grâce que si le jeton signé est encore valide, lié à ce
  // compte, sous grace_until, ET qu'un check EN LIGNE a réussi il y a < OFFLINE_MAX.
  const cached = readCache(); const p = cached && verifyToken(cached);
  if (!p || p.uid !== sess.userId) return { entitled: false, offline: true };
  const now = (await trustedNowSec()) ?? Math.floor(Date.now() / 1000);
  const entitled = p.active && now < p.grace_until && (now - (cached.online_ok || 0)) < OFFLINE_MAX;
  if (entitled) { verified = true; return { entitled: true, offline: true, email: sess.email }; }
  return { entitled: false, offline: true };
}

// --- API IPC (consommée par gate.html) ---
export async function ipcState() {
  const s = readSession();
  return { enabled: isEnabled(), hasSession: !!s, email: s?.email || null, paymentLink: !!cfg('STRIPE_PAYMENT_LINK'), priceLabel: cfg('SUB_PRICE_LABEL') || '3 €/mois' };
}
export async function ipcAccess() { return checkAccess(); }
export async function ipcLogin(email, password) {
  const r = await passwordLogin(email, password);
  if (!r.ok) return r;
  return checkAccess();
}
export async function ipcSignup(email, password) { return signup(email, password); }
export async function ipcRefresh() {
  const r = await checkAccess();
  if (r.offline && !r.entitled) return { ...r, error: 'Backend injoignable, réessaie.' };
  return r;
}
export async function ipcOpenCheckout() {
  const s = readSession();
  const base = cfg('STRIPE_PAYMENT_LINK');
  if (!base || !s?.userId) return { ok: false, error: 'Indisponible (connecte-toi d\'abord).' };
  const url = `${base}?client_reference_id=${encodeURIComponent(s.userId)}&prefilled_email=${encodeURIComponent(s.email || '')}`;
  await shell.openExternal(url).catch(() => {});
  return { ok: true };
}
export function ipcLogout() { logout(); return { ok: true }; }
