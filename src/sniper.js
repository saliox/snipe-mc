// Moteur de snipe : envoie une rafale de requêtes de changement de nom
// calibrée autour de l'instant du drop, sur des connexions pré-chauffées.
import { Pool } from 'undici';
import { log, c, sleep, sleepUntil, fmtDuration } from './util.js';
import { bestOffset } from './ntp.js';

const HOST = 'https://api.minecraftservices.com';

// Arrêt coopératif (utilisé par l'UI pour stopper le mode surveillance).
let stopFlag = false;
export function requestStop() { stopFlag = true; }

// Pré-établit `n` connexions TLS pour éliminer le handshake du chemin critique.
async function warmup(pool, token, n) {
  const warm = async () => {
    try {
      // GET léger et authentifié : ouvre la connexion sans effet de bord.
      const { body } = await pool.request({
        path: '/minecraft/profile',
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      await body.dump();
    } catch { /* peu importe, le but est d'ouvrir le socket */ }
  };
  await Promise.all(Array.from({ length: n }, warm));
}

// Un essai de changement de nom. Renvoie { ok, status, retryAfter }.
async function attempt(pool, name, token) {
  const { statusCode, headers, body } = await pool.request({
    path: `/minecraft/profile/name/${encodeURIComponent(name)}`,
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
  });
  const retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : null;
  await body.dump();
  return { ok: statusCode === 200, status: statusCode, retryAfter };
}

/**
 * @param {object} opts
 * @param {string} opts.name          pseudo cible
 * @param {string} opts.token         token d'accès Minecraft
 * @param {number} [opts.dropAt]      epoch ms du drop (mode planifié)
 * @param {boolean} [opts.monitor]    mode surveillance (poll jusqu'à libre)
 * @param {number} [opts.connections] connexions pré-chauffées (def 3)
 * @param {number} [opts.burst]       nb de requêtes dans la rafale (def 6)
 * @param {number} [opts.spacingMs]   espacement entre requêtes (def 30ms)
 * @param {number} [opts.leadMs]      avance de la 1re requête sur T0 (def 40ms)
 * @param {boolean} [opts.skipNtp]    ne pas synchroniser l'horloge
 */
export async function snipe(opts) {
  const {
    name, token, dropAt, monitor = false,
    connections = 3, burst = 6, spacingMs = 30, leadMs = 40, skipNtp = false,
  } = opts;

  stopFlag = false;
  const pool = new Pool(HOST, { connections, pipelining: 1 });
  let offset = 0;

  try {
    if (!skipNtp) {
      log.step('Synchronisation NTP');
      try {
        const o = await bestOffset();
        offset = o.offset;
        log.ok(`Offset horloge : ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms ` +
          `(via ${o.server}, rtt ${o.rtt.toFixed(0)} ms)`);
        if (Math.abs(offset) > 250) log.warn('Ton horloge Windows dérive beaucoup — l\'offset NTP corrige ça.');
      } catch (e) {
        log.warn(`NTP indisponible (${e.message}) — on utilise l'horloge locale telle quelle.`);
      }
    }
    // "Maintenant" corrigé = Date.now() + offset. Pour viser un temps réel T,
    // on attend l'instant local L tel que L + offset = T, soit L = T - offset.
    const toLocal = (realMs) => realMs - offset;

    if (monitor) return await monitorLoop(pool, name, token, { burst, spacingMs });

    if (!dropAt) throw new Error('Mode planifié : --at requis (ou utilise --monitor).');

    const now = Date.now() + offset;
    log.step(`Snipe planifié de ${c.yellow}${name}${c.reset}`);
    log.info(`Drop dans ${c.cyan}${fmtDuration(dropAt - now)}${c.reset} (${new Date(dropAt).toISOString()})`);

    // Pré-chauffage ~10s avant le drop pour avoir des sockets frais.
    const warmAtLocal = toLocal(dropAt - 10_000);
    if (warmAtLocal > Date.now()) {
      await sleepUntil(warmAtLocal);
    }
    log.info('Pré-chauffage des connexions...');
    await warmup(pool, token, connections);
    log.ok('Connexions prêtes.');

    // Rafale : première requête `leadMs` avant T0, puis toutes les `spacingMs`.
    const firstLocal = toLocal(dropAt - leadMs);
    log.info(`Rafale de ${burst} requêtes espacées de ${spacingMs} ms, ` +
      `1re à T0-${leadMs} ms. En attente...`);
    await sleepUntil(firstLocal, 20);

    const result = await fireBurst(pool, name, token, { burst, spacingMs });
    reportResult(result, name);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}

async function fireBurst(pool, name, token, { burst, spacingMs }) {
  const inflight = [];
  let winner = null;
  for (let i = 0; i < burst; i++) {
    const t = Date.now();
    inflight.push(
      attempt(pool, name, token).then((r) => {
        const dt = (Date.now() - t);
        log.info(`  req#${i + 1} → ${statusColor(r.status)} (${dt} ms)` +
          (r.retryAfter ? ` retry-after ${r.retryAfter}s` : ''));
        if (r.ok && !winner) winner = { ...r, index: i + 1 };
        return r;
      }).catch((e) => { log.warn(`  req#${i + 1} erreur: ${e.message}`); return { ok: false }; })
    );
    if (i < burst - 1) await sleep(spacingMs);
  }
  const all = await Promise.all(inflight);
  return { success: !!winner, winner, attempts: all };
}

// Mode surveillance : poll la dispo et déclenche une rafale dès que le nom
// passe libre. Utile quand on ne connaît pas la seconde exacte du drop.
async function monitorLoop(pool, name, token, { burst, spacingMs }) {
  log.step(`Surveillance de ${c.yellow}${name}${c.reset} (Ctrl+C pour arrêter)`);
  await warmup(pool, token, 2);
  let polls = 0;
  while (!stopFlag) {
    polls++;
    const { body, statusCode } = await pool.request({
      // On sonde via l'endpoint public de Mojang par un fetch séparé serait plus
      // propre, mais rester sur le pool chaud réduit la latence de bascule.
      path: `/minecraft/profile/name/${encodeURIComponent(name)}/available`,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    let status = null;
    if (statusCode === 200) status = (await body.json()).status;
    else await body.dump();

    if (status === 'AVAILABLE') {
      log.ok(`${name} est DISPONIBLE — rafale !`);
      const result = await fireBurst(pool, name, token, { burst, spacingMs });
      reportResult(result, name);
      return result;
    }
    if (polls % 20 === 0) log.info(`...toujours ${status || statusCode} (${polls} sondages)`);
    await sleep(1000); // 1 req/s : sûr vis-à-vis du rate limit
  }
  log.warn('Surveillance arrêtée.');
  return { success: false, stopped: true, attempts: [] };
}

function statusColor(s) {
  if (s === 200) return `${c.green}200 OK${c.reset}`;
  if (s === 429) return `${c.red}429 rate-limit${c.reset}`;
  if (s === 403 || s === 400) return `${c.yellow}${s} indispo/refus${c.reset}`;
  return `${c.gray}${s}${c.reset}`;
}

function reportResult(result, name) {
  console.log('');
  if (result.success) {
    log.ok(`${c.green}🎯 SNIPE RÉUSSI${c.reset} — ${name} obtenu (req#${result.winner.index}) !`);
  } else {
    const got429 = result.attempts.some((a) => a.status === 429);
    log.err(`Échec du snipe de ${name}.` +
      (got429 ? ' Rate-limité (429) : réduis burst/augmente spacing, ou nom pris par plus rapide.' : ''));
  }
}
