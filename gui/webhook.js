// Alertes Discord via webhook. L'URL est un secret (quiconque l'a peut poster
// dans le salon) → stockée chiffrée au repos (machine-bound, comme les tokens).
// Le renderer ne reçoit jamais l'URL brute, seulement un état (configuré/actif).
import { app } from 'electron';
import path from 'node:path';
import { request } from 'undici';
import { saveEncrypted, loadEncrypted } from '../src/securebox.js';

const FILE = () => path.join(app.getPath('userData'), 'webhook.enc');
const GREEN = 5763719;   // 0x57F287
const BLURPLE = 5793266; // 0x5865F2

// Webhooks Discord officiels (discord.com / discordapp.com, + ptb/canary, avec ou sans /vN/).
const RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;
export function isValidWebhook(url) { return typeof url === 'string' && RE.test(url.trim()); }

// Config interne (avec URL) — usage main uniquement.
function load() { return loadEncrypted(FILE()) || {}; }

// Vue publique (sans l'URL) pour le renderer.
export function getWebhookPublic() {
  const c = load();
  const url = c.url || '';
  // On ne renvoie AUCUN fragment d'URL au renderer (cf. en-tête du module) : juste
  // un état. `configured` suffit à l'UI pour afficher « configuré ».
  return { configured: !!url, enabled: !!c.enabled, hint: url ? 'configuré' : '' };
}

// Enregistre. Une URL vide conserve l'URL existante (permet de (dé)cocher le
// toggle sans re-saisir le secret). Lève si l'URL fournie est invalide.
export function setWebhook(url, enabled) {
  const cur = load();
  let u = String(url || '').trim();
  if (!u) u = cur.url || '';
  if (u && !isValidWebhook(u)) throw new Error('URL de webhook Discord invalide.');
  saveEncrypted(FILE(), { url: u, enabled: !!enabled && !!u });
  return getWebhookPublic();
}

// Envoie un embed. `override` = URL explicite (test avant enregistrement) qui
// court-circuite la vérif « activé ». Ne lève jamais : renvoie { ok, status?, error? }.
export async function sendWebhook({ title, description, color = GREEN }, override) {
  const cfg = load();
  const url = (override && String(override).trim()) || cfg.url;
  if (!url) return { ok: false, error: 'aucun webhook configuré' };
  if (!override && !cfg.enabled) return { ok: false, error: 'alertes désactivées' };
  if (!isValidWebhook(url)) return { ok: false, error: 'URL invalide' };
  try {
    const { statusCode, body } = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Snipe MC', embeds: [{ title, description, color }] }),
      headersTimeout: 8000, bodyTimeout: 8000,
    });
    await body.dump();
    return { ok: statusCode >= 200 && statusCode < 300, status: statusCode };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Test manuel : utilise l'URL fournie (test AVANT enregistrement) ou, à défaut,
// l'URL déjà enregistrée. Court-circuite toujours la vérif « activé » — un test
// explicite doit fonctionner même si les alertes sont décochées, et même quand le
// champ de saisie est vide après un enregistrement.
export async function testWebhook(overrideUrl) {
  const url = (overrideUrl && String(overrideUrl).trim()) || load().url || '';
  if (!url) return { ok: false, error: 'aucun webhook configuré' };
  // On passe une URL non vide comme `override` → sendWebhook ignore le flag « activé ».
  return sendWebhook({ title: '✅ Test Snipe MC', description: 'Les alertes Discord fonctionnent — tu seras prévenu quand un pseudo surveillé se libère.' }, url);
}

export { GREEN, BLURPLE };
