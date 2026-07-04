// Vérification en masse de disponibilité, avec anti-rate-limit ADAPTATIF (AIMD)
// et estimation du temps restant (ETA).
//
// Principe : plusieurs requêtes en vol, cadencées par un intervalle dynamique.
// - succès répétés  -> on accélère (intervalle × 0.85, additive/gentle)
// - 429 (rate limit) -> on ralentit fort (intervalle × 2) + pause globale qui
//   respecte l'en-tête Retry-After, et le pseudo est remis en file (retry).
// Résultat : rapide quand l'API suit, prudent dès qu'elle proteste, sans jamais
// perdre un pseudo. Les résultats arrivent dans le désordre : chaque callback
// porte un compteur `done` pour une barre de progression fiable.
import { isNameFree, validName, nameStatus } from './mojang.js';

const START_INTERVAL = 70;   // ms entre deux départs de requête au démarrage
const MIN_INTERVAL = 25;     // plancher (≈ 40 req/s)
const MAX_INTERVAL = 3000;   // plafond quand ça throttle
const MAX_INFLIGHT = 12;     // requêtes simultanées max
const SPEEDUP_AFTER = 15;    // succès consécutifs avant d'accélérer
const MAX_ATTEMPTS = 4;      // tentatives par pseudo avant abandon

// names: string[]
// opts.minIntervalMs : plancher d'intervalle (sécurité, défaut MIN_INTERVAL)
// opts.token         : statut compte pour les libres (AVAILABLE/NOT_ALLOWED)
// opts.onResult(r)   : { done, total, name, state, detail } ; state ∈ free|taken|invalid|error
// opts.onStats(s)    : { done, total, rate, etaMs, inFlight, intervalMs, throttled, throttleEvents }
// opts.shouldStop()  : true pour interrompre
export async function bulkCheck(names, opts = {}) {
  const {
    minIntervalMs = MIN_INTERVAL, token = null, proxyPool = null,
    onResult = () => {}, onStats = () => {}, shouldStop = () => false,
  } = opts;
  const floor = Math.max(MIN_INTERVAL, minIntervalMs | 0);

  // File dédoublonnée (insensible à la casse) + rapport immédiat des invalides.
  const queue = [];
  const seen = new Set();
  let invalid = 0;
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!validName(name)) { invalid++; continue; }
    queue.push({ name, attempts: 0 });
  }
  const retryQ = [];
  const total = queue.length;
  const freeList = [];
  let checked = 0, free = 0, taken = 0, errors = 0;

  // Contrôleur adaptatif
  let interval = Math.max(START_INTERVAL, floor);
  let inFlight = 0;
  let pauseUntil = 0;
  let successStreak = 0;
  let throttleEvents = 0;

  const start = Date.now();
  let ewmaRate = 0;
  function stats() {
    const elapsed = (Date.now() - start) / 1000;
    const avg = elapsed > 0 ? checked / elapsed : 0;
    ewmaRate = ewmaRate ? ewmaRate * 0.7 + avg * 0.3 : avg;
    const remaining = total - checked;
    const etaMs = ewmaRate > 0.01 ? (remaining / ewmaRate) * 1000 : null;
    onStats({
      done: checked, total, rate: ewmaRate, etaMs,
      inFlight, intervalMs: Math.round(interval),
      throttled: Date.now() < pauseUntil, throttleEvents,
    });
  }

  function onThrottle(retryAfter) {
    throttleEvents++;
    interval = Math.min(interval * 2, MAX_INTERVAL);
    successStreak = 0;
    const backoff = retryAfter ? retryAfter * 1000 : Math.min(interval * 4, 8000);
    pauseUntil = Math.max(pauseUntil, Date.now() + backoff);
  }
  function onSuccess() {
    if (++successStreak >= SPEEDUP_AFTER && interval > floor) {
      interval = Math.max(floor, interval * 0.85);
      successStreak = 0;
    }
  }

  async function handleOne(item) {
    inFlight++;
    try {
      let res;
      try {
        res = await isNameFree(item.name, proxyPool ? proxyPool.next() : null);
      } catch (e) {
        if (item.attempts++ < MAX_ATTEMPTS) retryQ.push(item);
        else { errors++; checked++; onResult({ done: checked, total, name: item.name, state: 'error', detail: e.message }); }
        return;
      }

      if (res.rateLimited) {
        onThrottle(res.retryAfter);
        if (item.attempts++ < MAX_ATTEMPTS) retryQ.push(item);
        else { errors++; checked++; onResult({ done: checked, total, name: item.name, state: 'error', detail: 'rate-limité (abandon)' }); }
        return;
      }

      onSuccess();
      if (res.free === true) {
        free++; freeList.push(item.name); checked++;
        let detail = 'LIBRE';
        if (token) {
          try {
            const st = await nameStatus(item.name, token);
            detail = st === 'AVAILABLE' ? 'LIBRE (réclamable)' : st === 'NOT_ALLOWED' ? 'LIBRE mais BLOQUÉ' : `LIBRE (${st})`;
          } catch { /* garde LIBRE */ }
        }
        onResult({ done: checked, total, name: item.name, state: 'free', detail });
      } else if (res.free === false) {
        taken++; checked++;
        onResult({ done: checked, total, name: item.name, state: 'taken', detail: `pris par ${res.name}` });
      } else {
        errors++; checked++;
        onResult({ done: checked, total, name: item.name, state: 'error', detail: `HTTP ${res.statusCode || '?'}` });
      }
    } finally {
      inFlight--;
    }
  }

  const nextItem = () => retryQ.shift() || queue.shift();

  // Boucle de cadence : un timer pour l'ETA, une pompe qui envoie les requêtes.
  await new Promise((resolve) => {
    const statsTimer = setInterval(stats, 300);
    const done = () => { clearInterval(statsTimer); stats(); resolve(); };

    function pump() {
      if (shouldStop()) {
        if (inFlight === 0) return done();
        return setTimeout(pump, 50);
      }
      const now = Date.now();
      if (now < pauseUntil) return setTimeout(pump, pauseUntil - now);

      if (inFlight < MAX_INFLIGHT) {
        const item = nextItem();
        if (item) {
          handleOne(item).then(() => { stats(); });
          return setTimeout(pump, interval); // cadence les DÉPARTS
        }
      }
      // Rien à envoyer maintenant : fini ? sinon on repasse bientôt.
      if (!queue.length && !retryQ.length && inFlight === 0) return done();
      setTimeout(pump, Math.min(interval, 80));
    }
    if (total === 0) return done();
    pump();
  });

  return { checked, free, taken, invalid, errors, freeList, throttleEvents, elapsedMs: Date.now() - start };
}

// Estimation grossière AVANT le scan (raffinée en direct ensuite).
export function estimateScanMs(count, minIntervalMs = MIN_INTERVAL) {
  const iv = Math.max(MIN_INTERVAL, minIntervalMs | 0);
  // Débit sain ≈ 1 départ / intervalle de démarrage, un peu de marge réseau.
  const perName = Math.max(iv, START_INTERVAL) * 0.8;
  return Math.round(count * perName);
}
