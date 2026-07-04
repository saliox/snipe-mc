// Pool de proxies HTTP en rotation (round-robin) pour répartir les requêtes du
// check en masse sur plusieurs IP et éviter le rate-limit de Mojang.
import { ProxyAgent } from 'undici';

// Accepte les formats :  http://user:pass@host:port  |  host:port  |  host:port:user:pass
function normalize(raw) {
  let s = String(raw).trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const p = s.split(':');
  if (p.length === 2) return `http://${p[0]}:${p[1]}`;
  if (p.length === 4) return `http://${p[2]}:${p[3]}@${p[0]}:${p[1]}`;
  return `http://${s}`;
}

export function makeProxyPool(lines = []) {
  const agents = [];
  for (const raw of lines) {
    const url = normalize(raw);
    if (!url) continue;
    try { agents.push(new ProxyAgent(url)); } catch { /* proxy invalide ignoré */ }
  }
  let i = 0;
  return {
    size: agents.length,
    next() { return agents.length ? agents[i++ % agents.length] : null; },
    async close() { for (const a of agents) { try { await a.close(); } catch {} } },
  };
}
