// Gestionnaire multi-comptes. Enregistre plusieurs tokens (chiffrés au repos via
// DPAPI/safeStorage quand dispo), permet de basculer entre eux, et fournit la
// liste des tokens pour un snipe multi-comptes.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setManualToken, getManualToken, manualStatus } from './session.js';

const FILE = () => path.join(app.getPath('userData'), 'accounts.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return { active: null, accounts: [] }; }
}
function persist(d) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(d, null, 2));
}

function enc(token) {
  if (safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(token).toString('base64') };
  return { plain: token }; // repli si pas de coffre OS
}
function dec(a) {
  if (a.enc) return safeStorage.decryptString(Buffer.from(a.enc, 'base64'));
  return a.plain;
}

// Liste allégée (sans tokens) pour l'UI.
export function listAccounts() {
  const d = load();
  return {
    active: d.active,
    accounts: d.accounts.map((a) => ({ id: a.id, label: a.label, name: a.profile?.name, active: a.id === d.active })),
  };
}

// Enregistre le token ACTIF (collé via tokenSet) comme compte nommé.
export async function saveCurrentAsAccount(label) {
  const st = manualStatus();
  const token = getManualToken();
  if (!st.active || !token) throw new Error("Colle un token valide d'abord (champ TOKEN), puis enregistre-le.");
  const d = load();
  // Évite les doublons par pseudo.
  const existing = d.accounts.find((a) => a.profile?.id === st.profile.id);
  const rec = {
    id: existing?.id || crypto.randomUUID(),
    label: (label || '').trim() || st.profile.name,
    profile: st.profile,
    ...enc(token),
    addedAt: Date.now(),
  };
  if (existing) Object.assign(existing, rec);
  else d.accounts.push(rec);
  d.active = rec.id;
  persist(d);
  return listAccounts();
}

export async function activateAccount(id) {
  const d = load();
  const a = d.accounts.find((x) => x.id === id);
  if (!a) throw new Error('Compte introuvable.');
  await setManualToken(dec(a)); // revalide le token (réseau) et le rend actif
  d.active = id;
  persist(d);
  return listAccounts();
}

export function removeAccount(id) {
  const d = load();
  d.accounts = d.accounts.filter((x) => x.id !== id);
  if (d.active === id) d.active = null;
  persist(d);
  return listAccounts();
}

// Tous les tokens déchiffrés (pour le snipe multi-comptes).
export function allTokens() {
  const d = load();
  return d.accounts.map((a) => ({ label: a.label, name: a.profile?.name, token: dec(a) }));
}
