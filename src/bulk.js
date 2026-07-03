// Vérification en masse de disponibilité, pseudo par pseudo.
// Conçu pour de longues listes : délai réglable + recul automatique sur 429.
import { isNameFree, validName, nameStatus } from './mojang.js';
import { sleep } from './util.js';

// names: string[]
// opts.delayMs      : pause entre deux requêtes (défaut 200)
// opts.token        : si fourni, ajoute le statut compte (AVAILABLE/NOT_ALLOWED)
// opts.onResult(r)  : callback par pseudo { index, total, name, state, detail }
//                     state ∈ 'free' | 'taken' | 'invalid' | 'error'
// opts.shouldStop() : renvoie true pour interrompre
// Renvoie un récap { checked, free, taken, invalid, errors, freeList }.
export async function bulkCheck(names, opts = {}) {
  const { delayMs = 200, token = null, onResult = () => {}, shouldStop = () => false } = opts;
  const total = names.length;
  const freeList = [];
  let checked = 0, free = 0, taken = 0, invalid = 0, errors = 0;

  for (let i = 0; i < total; i++) {
    if (shouldStop()) break;
    const name = String(names[i]).trim();
    if (!name) continue;

    if (!validName(name)) {
      invalid++;
      onResult({ index: i, total, name, state: 'invalid', detail: 'format 3-16 [A-Za-z0-9_]' });
      continue;
    }

    let res;
    try {
      res = await isNameFree(name);
    } catch (e) {
      errors++;
      onResult({ index: i, total, name, state: 'error', detail: e.message });
      await sleep(delayMs);
      continue;
    }

    // Recul sur rate limit : on ré-essaie une fois après une pause plus longue.
    if (res.rateLimited) {
      await sleep(Math.max(1500, delayMs * 4));
      if (shouldStop()) break;
      try { res = await isNameFree(name); } catch { /* ignore */ }
    }

    if (res && res.free === true) {
      free++; freeList.push(name);
      let detail = 'LIBRE';
      if (token) {
        try {
          const st = await nameStatus(name, token);
          detail = st === 'AVAILABLE' ? 'LIBRE (réclamable)' : st === 'NOT_ALLOWED' ? 'LIBRE mais BLOQUÉ' : `LIBRE (${st})`;
        } catch { /* garde LIBRE */ }
      }
      onResult({ index: i, total, name, state: 'free', detail });
    } else if (res && res.free === false) {
      taken++;
      onResult({ index: i, total, name, state: 'taken', detail: `pris par ${res.name}` });
    } else {
      errors++;
      onResult({ index: i, total, name, state: 'error', detail: res?.rateLimited ? 'rate-limité' : `HTTP ${res?.statusCode || '?'}` });
    }

    checked++;
    if (i < total - 1) await sleep(delayMs);
  }

  return { checked, free, taken, invalid, errors, freeList };
}
