// Gère le token « actif » : soit un bearer collé à la main, soit celui du login
// Microsoft. Les actions (change username, snipe, statut compte) l'utilisent.
import { getValidToken } from '../src/auth.js';
import { profileFromToken } from '../src/nameapi.js';

let manualToken = null;
let manualProfile = null;

// Définit et valide un token collé à la main. Renvoie le profil.
export async function setManualToken(token) {
  const clean = String(token || '').replace(/^Bearer\s+/i, '').trim();
  if (!clean) throw new Error('Token vide.');
  const profile = await profileFromToken(clean); // valide + récupère le pseudo
  manualToken = clean;
  manualProfile = profile;
  return profile;
}

export function clearManualToken() {
  manualToken = null;
  manualProfile = null;
}

export function manualStatus() {
  return manualToken ? { active: true, profile: manualProfile } : { active: false };
}

// Renvoie { accessToken, profile, source }. Priorité au token manuel.
export async function getActiveToken() {
  if (manualToken) return { accessToken: manualToken, profile: manualProfile, source: 'token' };
  const mc = await getValidToken(); // lève si non connecté
  return { accessToken: mc.accessToken, profile: mc.profile, source: 'microsoft' };
}

// Comme getActiveToken mais renvoie null au lieu de lever si rien n'est dispo.
export async function tryGetActiveToken() {
  try { return await getActiveToken(); } catch { return null; }
}
