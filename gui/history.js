// Historique persistant des pseudos vus (entre sessions), dans userData/history.json.
// Répond à « ai-je déjà checké X ? » et garde la trace des libres trouvés.
// Stockage JSON simple (pas de dépendance native) ; écriture débouncée.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(app.getPath('userData'), 'history.json');
let map = null;                 // name_lower -> { name, state, ts }
let dirty = false, flushTimer = null;

function ensure() {
  if (map) return;
  try { map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE(), 'utf8')))); }
  catch { map = new Map(); }
}
function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, 15000);
}
export function flushNow() {
  if (!dirty || !map) return;
  dirty = false;
  try { fs.writeFileSync(FILE(), JSON.stringify(Object.fromEntries(map))); } catch { /* ignore */ }
}

// Priorité d'information : free/taken écrasent error/invalid (une vraie réponse
// vaut mieux qu'un échec réseau précédent) ; sinon on met juste à jour le temps.
const RANK = { free: 3, taken: 3, invalid: 2, error: 1 };
export function record(name, state) {
  ensure();
  const key = String(name).toLowerCase();
  const prev = map.get(key);
  if (prev && (RANK[state] || 0) < (RANK[prev.state] || 0)) { prev.ts = Date.now(); }
  else map.set(key, { name, state, ts: Date.now() });
  scheduleFlush();
}
export function lookup(name) { ensure(); return map.get(String(name).toLowerCase()) || null; }
export function stats() {
  ensure();
  let free = 0, taken = 0;
  for (const v of map.values()) { if (v.state === 'free') free++; else if (v.state === 'taken') taken++; }
  return { total: map.size, free, taken };
}
export function searchFree(substr, limit = 300) {
  ensure();
  const q = String(substr || '').toLowerCase();
  const out = [];
  for (const v of map.values()) {
    if (v.state === 'free' && (!q || v.name.toLowerCase().includes(q))) out.push(v.name);
    if (out.length >= limit) break;
  }
  return out;
}
export function allFree() {
  ensure();
  const out = [];
  for (const v of map.values()) if (v.state === 'free') out.push(v.name);
  return out;
}
export function clear() { ensure(); map.clear(); dirty = true; flushNow(); }
