// Préférences d'UI persistées entre les lancements (userData/prefs.json).
// Non sensible (réglages du générateur, tuning du snipe, filtre pépites…) → JSON
// en clair, contrairement aux tokens/webhook qui sont chiffrés.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const FILE = () => path.join(app.getPath('userData'), 'prefs.json');
let cache = null;

function load() {
  if (cache) return cache;
  try { const o = JSON.parse(fs.readFileSync(FILE(), 'utf8')); cache = (o && typeof o === 'object') ? o : {}; }
  catch { cache = {}; }
  return cache;
}

export function getPrefs() { return load(); }

export function setPrefs(obj) {
  if (!obj || typeof obj !== 'object') return load();
  cache = { ...load(), ...obj };
  try { fs.writeFileSync(FILE(), JSON.stringify(cache)); } catch { /* ignore */ }
  return cache;
}
