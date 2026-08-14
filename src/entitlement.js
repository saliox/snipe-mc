// Vérification d'entitlement PARTAGÉE (Ed25519 + config du gate).
//
// AUDIT (bypass moteur nu) : avant ce module, la SEULE vérification d'abonnement
// vivait dans gui/subgate.js + les gardes gateLocked() de gui/main.js — c'est-à-dire
// uniquement dans la couche IPC Electron. Un script important directement
// src/sniper.js / src/auth.js / src/nameapi.js (présents en clair, non asar, dans
// l'app packagée) appelait donc le moteur de snipe SANS jamais passer par le gate.
//
// Ce module déplace la vérification cryptographique dans le moteur lui-même
// (requireEntitlement, appelée en tête de snipe()/getValidToken()/loginInteractive()/
// changeName()) : même un appel direct, hors Electron, hors gui/main.js, est refusé
// sans un jeton d'entitlement signé et valide. gui/subgate.js réutilise CE module
// pour sa propre vérification (au lieu de dupliquer la crypto Ed25519).
//
// Pur Node (aucune dépendance Electron) : utilisable par le moteur CLI comme le GUI.
//
// Réalisme (inchangé de gui/subgate.js) : un binaire public reste contournable par un
// reverser qui réimplémente l'appel HTTP Mojang à la main — ceci hausse la barre
// contre la copie triviale de NOS fonctions, ce n'est pas un DRM inviolable.
import os from 'node:os';
import crypto from 'node:crypto';
import { GATE } from './gate-config.js';

// Clé PUBLIQUE Ed25519 d'entitlement (SPKI DER base64) — figée. Pendant public de
// ENT_PRIVATE_KEY_PKCS8_B64 (secret de l'edge function subscription-status).
export const ENT_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAO1Ug2gm39aRC+pPrXQqK3bDx5Loo6xCBLMmjpPiOE/8=';

let ENT_PUB = null;
function entPub() {
  if (!ENT_PUB) ENT_PUB = crypto.createPublicKey({ key: Buffer.from(ENT_PUBLIC_KEY_SPKI_B64, 'base64'), format: 'der', type: 'spki' });
  return ENT_PUB;
}

// Ordre de clés IDENTIQUE au serveur (edge function) et à gui/subgate.js. Octet pour octet.
export const canonicalEntitlement = (p) =>
  JSON.stringify({ uid: p.uid, device: p.device, active: p.active, status: p.status, grace_until: p.grace_until, iat: p.iat });

// deviceId : MÊME formule que gui/subgate.js pour que les jetons signés vus côté GUI
// restent valides côté moteur (même machine -> même device fingerprint).
let _deviceId = null;
export function deviceId() {
  if (!_deviceId) {
    try { _deviceId = crypto.createHash('sha256').update(os.hostname() + '|' + os.userInfo().username).digest('hex'); }
    catch { _deviceId = 'unknown'; }
  }
  return _deviceId;
}

// Vérifie la signature Ed25519 + l'appareil. Renvoie le payload si valide, sinon null.
// N'évalue PAS active/grace_until ici (cf isPayloadEntitled) : la vérif crypto reste
// séparée de la décision métier, comme côté serveur.
export function verifyEntitlementToken(tok, device = deviceId()) {
  try {
    if (!tok || !tok.payload || !tok.sig) return null;
    if (!crypto.verify(null, Buffer.from(canonicalEntitlement(tok.payload)), entPub(), Buffer.from(tok.sig, 'base64'))) return null; // forge → rejet
    if (tok.payload.device !== device) return null; // anti-copie du jeton sur une autre machine
    return tok.payload;
  } catch { return null; }
}

// Un jeton dont la signature est valide mais dont grace_until est dépassé (ou
// active=false) n'entitle plus. nowSec = horloge locale : suffisant pour ce
// backstop moteur ; la nuance NTP / grâce hors-ligne bornée reste gérée en amont
// par gui/subgate.js (checkAccess), qui produit le jeton passé ici.
export function isPayloadEntitled(payload, nowSec = Math.floor(Date.now() / 1000)) {
  return !!payload && !!payload.active && nowSec < payload.grace_until;
}

// Le gate est-il actif pour CE build ? Réplique gui/subgate.js#isEnabled() sans
// dépendre d'Electron (utilisable en CLI / script). On retient la valeur la plus
// restrictive entre la config bakée (packagé) et le .env (dev) pour ne jamais
// désactiver un gate qui serait actif dans l'un des deux.
export function isGateEnabled() {
  const pick = (k) => (process.env[k] || '').trim() || (GATE[k] || '').trim();
  return pick('SUB_GATE') === '1' && !!pick('SUPABASE_URL') && !!pick('SUPABASE_ANON_KEY');
}

// Garde d'entitlement pour les points d'entrée du MOTEUR (snipe(), changeName(),
// getValidToken(), loginInteractive()...). `entitlement` = jeton signé { payload, sig }
// — le même que gui/subgate.js vérifie et expose via getEntitlementToken(). gui/main.js
// le fournit depuis sa session déjà vérifiée ; un script qui importe le moteur
// directement, lui, n'en a pas -> refusé.
//
// No-op si le gate est désactivé pour ce build (comportement historique inchangé,
// gate OFF par défaut).
export function requireEntitlement(entitlement) {
  if (!isGateEnabled()) return;
  const payload = verifyEntitlementToken(entitlement);
  if (!payload || !isPayloadEntitled(payload)) {
    const err = new Error(
      "Abonnement requis : jeton d'entitlement absent, invalide ou expiré. " +
      "Lance l'application (elle gère la vérification et le fournit automatiquement)."
    );
    err.code = 'SUBSCRIPTION_REQUIRED';
    throw err;
  }
}
