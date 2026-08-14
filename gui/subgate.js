// Gate d'abonnement (Stripe 3 €/mois) — process main.
//
// OFF par défaut : sans SUB_GATE=1 (+ SUPABASE_URL/ANON_KEY), l'app est inchangée
// (resolveEntry → index.html, gardes gateLocked() no-op).
//
// Durcissements post-audit :
//  - Config BAKÉE au build (src/gate-config.js) en packagé → pas désactivable via .env (C2).
//  - Décision d'accès SERVEUR-AUTORITAIRE si le backend est joignable ; sinon grâce
//    hors-ligne BORNÉE, jugée sur une HEURE DE CONFIANCE (NTP) comparée aux champs
//    SIGNÉS (iat/grace_until) + plafond OFFLINE_MAX — plus de bypass "gel d'horloge"
//    ni de faux-verrouillage d'un abonné dont l'horloge locale retarde (H1/H2).
//  - resolveEntry ne fait AUCUN fast-path cache→index (le check a lieu dans gate.html).
//  - Jeton lié à l'uid de session (B1) ; erreurs réseau gérées (M5) ; refresh dédupliqué
//    (B6) ; deviceId paresseux (B3) ; URL validée https (B4).
//  - Vérification Ed25519 extraite dans src/entitlement.js (PARTAGÉE avec le moteur :
//    src/sniper.js / src/auth.js / src/nameapi.js se gatent maintenant eux-mêmes via
//    ce module, plus seulement via les IPC ci-dessous — cf audit "moteur nu").
//  - Ré-vérification PÉRIODIQUE (ensureFreshAccess + poll en tâche de fond dans
//    gui/main.js) : `verified` n'est plus un booléen vérifié une fois et gardé pour
//    toute la session — une résiliation Stripe est détectée en quelques minutes, pas
//    seulement au prochain redémarrage (cf audit TOCTOU).
//
// Réalisme : binaire public → un reverser contourne. Ça protège l'utilisateur lambda
// (extract asar / éditer un .env ne suffit plus), pas un cracker.
import { app, shell } from 'electron';
import { request } from 'undici';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { saveEncrypted, loadEncrypted } from '../src/securebox.js';
import { bestOffset } from '../src/ntp.js';
import { GATE } from '../src/gate-config.js';
import { verifyEntitlementToken, deviceId } from '../src/entitlement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OFFLINE_MAX = 7 * 24 * 3600; // plafond DUR de fonctionnement hors-ligne (s)

// Fraîcheur de la vérification EN LIGNE (TOCTOU) : `verified` est mis en cache pour
// éviter un aller-retour réseau à chaque action gatée, mais ce cache doit expirer —
// sinon un abonnement résilié juste après vérification reste valide pour toute la
// durée de vie du process (l'app peut tourner indéfiniment en tray). 20 min (dans la
// fourchette 15-30 min visée) : assez court pour une détection rapide, assez long
// pour ne pas spammer le backend à chaque clic. Indépendant de grace_until (72h) :
// grace_until borne la grâce HORS-LIGNE, pas la fréquence de recheck EN LIGNE — le
// réutiliser tel quel laisserait un abonnement résilié actif jusqu'à 72h.
const VERIFY_FRESHNESS_MS = 20 * 60 * 1000;

const RENDERER = (f) => path.join(__dirname, 'renderer', f);
const INDEX = () => RENDERER('index.html');
const GATE_HTML = () => RENDERER('gate.html');
const SESSION_FILE = () => path.join(app.getPath('userData'), 'subgate.session');
const CACHE_FILE = () => path.join(app.getPath('userData'), 'subgate.cache');

let verified = false; // source de vérité du guard IPC (état main)
let lastVerifiedAt = 0; // Date.now() du dernier verified=true (fraîcheur, cf TOCTOU)
let lastGraceUntil = 0; // grace_until (s, signé) du dernier jeton honoré
let lastToken = null; // dernier jeton signé { payload, sig } honoré — exposé au moteur
                       // (src/sniper.js, src/nameapi.js, src/auth.js) via getEntitlementToken()

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

// deviceId + vérification Ed25519 : voir src/entitlement.js (partagé avec le moteur,
// B3 : deviceId reste paresseux/mémoïsé là-bas, zéro effet si le gate est OFF).
const verifyToken = (tok) => verifyEntitlementToken(tok, deviceId());

function readCache() { try { return loadEncrypted(CACHE_FILE()); } catch { return null; } }
function writeCache(o) { try { saveEncrypted(CACHE_FILE(), o); } catch { /* non bloquant */ } }
function readSession() { try { return loadEncrypted(SESSION_FILE()); } catch { return null; } }
function writeSession(o) { try { saveEncrypted(SESSION_FILE(), o); } catch { /* non bloquant */ } }
export function logout() {
  verified = false;
  lastVerifiedAt = 0;
  lastGraceUntil = 0;
  lastToken = null;
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
  if (entitled) { lastVerifiedAt = Date.now(); lastGraceUntil = p.grace_until; lastToken = tok; }
  else { lastToken = null; } // pas d'entitlement -> rien à exposer au moteur
  return { ok: true, entitled, status: p.status, email: s.email };
}

// Décision d'accès (appelée par gate.html, ET par ensureFreshAccess() pour le
// recheck périodique / TOCTOU) : serveur d'abord, sinon grâce bornée. Chaque branche
// met explicitement à jour `verified` (y compris à false) : un recheck qui échoue
// doit RÉVOQUER l'accès mis en cache, pas seulement s'abstenir de le renouveler
// (sinon un abonnement résilié resterait indéfiniment "verified" entre deux succès).
async function checkAccess() {
  const sess = readSession();
  if (!sess) return { entitled: false, needLogin: true };
  const online = await fetchEntitlement();
  if (online.ok) return { entitled: online.entitled, status: online.status, email: sess.email };
  if (online.needLogin) { verified = false; lastToken = null; return { entitled: false, needLogin: true }; }
  // Hors-ligne : n'honorer la grâce que si le jeton signé est encore valide, lié à ce
  // compte, sous grace_until, ET qu'un check EN LIGNE a réussi il y a < OFFLINE_MAX.
  const cached = readCache(); const p = cached && verifyToken(cached);
  if (!p || p.uid !== sess.userId) { verified = false; lastToken = null; return { entitled: false, offline: true }; }
  const now = (await trustedNowSec()) ?? Math.floor(Date.now() / 1000);
  const entitled = p.active && now < p.grace_until && (now - (cached.online_ok || 0)) < OFFLINE_MAX;
  if (entitled) {
    verified = true; lastVerifiedAt = Date.now(); lastGraceUntil = p.grace_until; lastToken = cached;
    return { entitled: true, offline: true, email: sess.email };
  }
  verified = false; lastToken = null;
  return { entitled: false, offline: true };
}

// Jeton signé { payload, sig } le plus récemment honoré (ONLINE ou grâce hors-ligne
// valide) — c'est CE jeton que le moteur (src/entitlement.js#requireEntitlement)
// vérifie à nouveau côté engine quand gui/main.js le lui transmet, afin qu'un import
// direct des modules moteur (hors gui/main.js) reste refusé sans jeton valide.
export function getEntitlementToken() { return lastToken; }

// Recheck paresseux, appelé par gateLocked() (gui/main.js) avant toute action gatée.
// Renvoie true = accès accordé. Ne fait un aller-retour réseau QUE si le cache
// `verified` est absent/périmé (fraîcheur VERIFY_FRESHNESS_MS OU grace_until signé
// dépassé) — sinon retourne le cache tel quel, sans latence supplémentaire.
export async function ensureFreshAccess() {
  if (!isEnabled()) return true; // gate OFF pour ce build : comportement historique inchangé
  if (!verified) return false; // jamais vérifié / déjà révoqué -> pas de recheck implicite
  const nowSec = Math.floor(Date.now() / 1000);
  const staleByTime = (Date.now() - lastVerifiedAt) > VERIFY_FRESHNESS_MS;
  const staleByGrace = lastGraceUntil > 0 && nowSec >= lastGraceUntil;
  if (!staleByTime && !staleByGrace) return true; // encore frais
  const r = await checkAccess(); // met à jour verified/lastVerifiedAt/lastToken en interne
  return !!r.entitled;
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
