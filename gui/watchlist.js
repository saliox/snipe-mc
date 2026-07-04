// Liste de surveillance persistante (userData/watchlist.json) : pseudos convoités
// que le moniteur de fond vérifie régulièrement.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(app.getPath('userData'), 'watchlist.json');
let list = null;

function ensure() {
  if (list) return;
  try { list = JSON.parse(fs.readFileSync(FILE(), 'utf8')); if (!Array.isArray(list)) list = []; }
  catch { list = []; }
}
function save() { try { fs.writeFileSync(FILE(), JSON.stringify(list)); } catch { /* ignore */ } }

export function getWatch() { ensure(); return list.slice(); }
export function addWatch(names) {
  ensure();
  const seen = new Set(list.map((x) => x.toLowerCase()));
  for (const n of names) {
    const v = String(n).trim();
    if (v && /^[A-Za-z0-9_]{3,16}$/.test(v) && !seen.has(v.toLowerCase())) { list.push(v); seen.add(v.toLowerCase()); }
  }
  save();
  return list.slice();
}
export function removeWatch(name) {
  ensure();
  list = list.filter((x) => x.toLowerCase() !== String(name).toLowerCase());
  save();
  return list.slice();
}
export function clearWatch() { ensure(); list = []; save(); return []; }
