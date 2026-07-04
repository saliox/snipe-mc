// Historique persistant des pseudos vus (entre sessions), dans userData/history.json.
// Répond à « ai-je déjà checké X ? » et garde la trace des libres trouvés.
// Stockage JSON simple (pas de dépendance native) ; écriture débouncée.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(app.getPath('userData'), 'history.json');
const MAX_ENTRIES = 200000;     // garde-fou : au-delà, on élague (libres + récents)
let map = null;                 // name_lower -> { name, state, ts }
let dirty = false, flushTimer = null, writing = false;

function ensure() {
  if (map) return;
  try { map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE(), 'utf8')))); }
  catch { map = new Map(); }
}
// Élague en gardant les libres d'abord, puis les plus récents. Laisse ~10 % de
// marge pour ne pas ré-élaguer à chaque écriture.
function trim() {
  if (map.size <= MAX_ENTRIES) return;
  const keep = Math.floor(MAX_ENTRIES * 0.9);
  const entries = [...map.entries()].sort((a, b) => {
    const fa = a[1].state === 'free' ? 1 : 0, fb = b[1].state === 'free' ? 1 : 0;
    return fb - fa || b[1].ts - a[1].ts;
  });
  map = new Map(entries.slice(0, keep));
}
function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, 15000);
}
// Écriture NON bloquante (temp + rename atomique). Une seule à la fois.
export function flushNow() {
  if (!dirty || !map || writing) return;
  trim();
  const json = JSON.stringify(Object.fromEntries(map));
  const tmp = FILE() + '.async.tmp';
  dirty = false; writing = true;
  fs.writeFile(tmp, json, (err) => {
    if (!err) { try { fs.renameSync(tmp, FILE()); } catch { /* ignore */ } }
    writing = false;
    if (dirty) flushNow(); // des changements pendant l'écriture
  });
}
// Écriture SYNCHRONE (fermeture de l'app : garantit la persistance).
// Temp DISTINCT de flushNow pour éviter toute collision de fichier.
export function flushSync() {
  if (!map) return;
  trim();
  try { const tmp = FILE() + '.sync.tmp'; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map))); fs.renameSync(tmp, FILE()); dirty = false; }
  catch { /* ignore */ }
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
export function clear() { ensure(); map.clear(); dirty = true; flushSync(); }
