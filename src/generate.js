// Génération de pseudos candidats (pour ensuite les checker en masse).

const SETS = {
  alpha: 'abcdefghijklmnopqrstuvwxyz',
  alphanum: 'abcdefghijklmnopqrstuvwxyz0123456789',
  full: 'abcdefghijklmnopqrstuvwxyz0123456789_', // _ autorisé par Mojang
};

// Génère jusqu'à `count` pseudos uniques de longueur `length`.
// charset: 'alpha' | 'alphanum' | 'full'. exhaustive: si true et que l'espace
// est petit, renvoie TOUTES les combinaisons (ex. toutes les 3 lettres a-z = 17576).
export function generateNames({ length = 3, charset = 'alpha', count = 50, exhaustive = false } = {}) {
  length = Math.max(3, Math.min(16, length | 0));
  const chars = SETS[charset] || SETS.alpha;
  const space = Math.pow(chars.length, length);

  if (exhaustive && space <= 60000) return enumerate(chars, length);

  const target = Math.min(count, space);
  const out = new Set();
  // Garde-fou anti-boucle infinie si l'espace est petit.
  let guard = target * 50 + 1000;
  while (out.size < target && guard-- > 0) {
    let s = '';
    for (let i = 0; i < length; i++) s += chars[(Math.random() * chars.length) | 0];
    out.add(s);
  }
  return [...out];
}

// Énumère toutes les combinaisons (petits espaces seulement).
function enumerate(chars, length) {
  let acc = [''];
  for (let i = 0; i < length; i++) {
    const next = [];
    for (const p of acc) for (const c of chars) next.push(p + c);
    acc = next;
  }
  return acc;
}

// Taille de l'espace de recherche, pour info dans l'UI.
export function spaceSize(length, charset = 'alpha') {
  const chars = SETS[charset] || SETS.alpha;
  return Math.pow(chars.length, Math.max(3, Math.min(16, length | 0)));
}
