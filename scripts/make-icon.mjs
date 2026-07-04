// Génère le logo de l'app (viseur de sniper vert sur fond sombre) en PUR Node :
//   build/icon.png (256x256)  +  build/icon.ico
// Aucune dépendance : rendu haute-résolution + downscale (anti-aliasing),
// encodage PNG maison, empaquetage ICO (PNG intégré).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });

const N = 256;         // taille finale
const SS = 4;          // supersampling
const H = N * SS;      // rendu hi-res

// Couleurs
const BG_C = [14, 26, 16];     // centre du fond
const BG_E = [5, 9, 6];        // bord du fond (vignette)
const LENS = [8, 18, 11];      // verre de la lunette
const LENS_HI = [24, 58, 30];  // reflet du verre
const GREEN = [57, 255, 20];
const GBRIGHT = [180, 255, 150];
const GDIM = [22, 110, 12];
const OUT = [3, 7, 4];         // liseré sombre pour détacher l'anneau
const RIM = [30, 60, 34];      // liseré externe

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Couleur (hard-edge) au point hi-res ; alpha 0 = transparent.
function colorAt(x, y) {
  const cx = H / 2, cy = H / 2, s = H / N;

  // Fond arrondi (transparent dehors)
  const sd = sdRoundRect(x, y, cx, cy, H / 2 - 4 * s, H / 2 - 4 * s, 48 * s);
  if (sd > 0) return [0, 0, 0, 0];

  const d = dist(x, y, cx, cy);
  const ringR = 90 * s, ringHalf = 7.5 * s;
  const lensR = ringR - ringHalf;
  const armHalf = 3.4 * s, gap = 16 * s, dotR = 6.5 * s;

  // 1) Fond : dégradé radial (vignette)
  let col = mix(BG_C, BG_E, clamp(d / (H * 0.62), 0, 1));

  // 2) Verre de la lunette (cercle intérieur) + reflet doux
  if (d <= lensR) {
    const hl = clamp(1 - dist(x, y, cx - lensR * 0.34, cy - lensR * 0.34) / (lensR * 1.15), 0, 1);
    col = mix(LENS, LENS_HI, Math.pow(hl, 1.6) * 0.85);
  }

  // 3) Mil-dots le long des bras
  const dotHalf = 2.5 * s;
  for (const m of [34 * s, 55 * s, 76 * s]) {
    if (Math.abs(x - cx) <= dotHalf && Math.abs(Math.abs(y - cy) - m) <= dotHalf) col = GREEN;
    if (Math.abs(y - cy) <= dotHalf && Math.abs(Math.abs(x - cx) - m) <= dotHalf) col = GREEN;
  }

  // 4) Réticule fin (gap central), jusqu'à l'anneau
  const reach = ringR + ringHalf;
  if ((Math.abs(x - cx) <= armHalf && Math.abs(y - cy) > gap && d <= reach) ||
      (Math.abs(y - cy) <= armHalf && Math.abs(x - cx) > gap && d <= reach)) {
    col = GREEN;
  }

  // 5) Anneau de visée avec liseré sombre (relief) + léger sheen vertical
  const dr = Math.abs(d - ringR);
  if (dr <= ringHalf) {
    const sheen = clamp(0.9 + 0.28 * ((cy - y) / ringR), 0.72, 1.18);
    col = [clamp(GREEN[0] * sheen, 0, 255), clamp(GREEN[1] * sheen, 0, 255), clamp(GREEN[2] * sheen, 0, 255)];
  } else if (dr <= ringHalf + 2 * s) {
    col = OUT;
  }

  // 6) Point central + halo
  if (d <= dotR) col = GBRIGHT;
  else if (d <= dotR + 3 * s) col = mix(GREEN, GBRIGHT, 0.5);

  // 7) Liseré externe fin (contour de l'icône)
  if (sd > -3.5 * s) col = mix(col, RIM, 0.7);

  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255];
}

// Rendu hi-res puis downscale moyenné -> AA
function render() {
  const out = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = colorAt(x * SS + sx + 0.5, y * SS + sy + 0.5);
          const af = pa / 255;
          r += pr * af; g += pg * af; b += pb * af; a += pa;
        }
      }
      const n = SS * SS;
      const af = a / (255 * n);
      const idx = (y * N + x) * 4;
      out[idx] = af ? Math.round(r / (af * n)) : 0;
      out[idx + 1] = af ? Math.round(g / (af * n)) : 0;
      out[idx + 2] = af ? Math.round(b / (af * n)) : 0;
      out[idx + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --- Encodage PNG (RGBA 8 bits) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function pngToIco(png) {
  const dir = Buffer.alloc(6); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
  const e = Buffer.alloc(16); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8); e.writeUInt32LE(22, 12);
  return Buffer.concat([dir, e, png]);
}

const rgba = render();
const png = encodePNG(N, N, rgba);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToIco(png));
console.log(`Icône générée : build/icon.png (${(png.length / 1024).toFixed(1)} Ko) + build/icon.ico`);
