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
const BG = [11, 15, 11];       // fond quasi noir verdâtre
const BORDER = [25, 45, 25];   // liseré
const GREEN = [57, 255, 20];   // vert terminal
const DIMGREEN = [26, 120, 12];

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const inBar = (px, py, cx, cy, hw, hh) => Math.abs(px - cx) <= hw && Math.abs(py - cy) <= hh;

// Couleur (hard-edge) au point hi-res ; alpha 0 = transparent.
function colorAt(x, y) {
  const cx = H / 2, cy = H / 2;
  const s = H / N; // échelle px logique -> hi-res

  // Fond arrondi
  if (sdRoundRect(x, y, cx, cy, H / 2 - 4 * s, H / 2 - 4 * s, 46 * s) > 0) return [0, 0, 0, 0];

  const d = dist(x, y, cx, cy);
  const ring = 96 * s, ringW = 7 * s;

  // Anneau de visée (avec léger halo)
  if (Math.abs(d - ring) <= ringW) return [...GREEN, 255];
  if (Math.abs(d - ring) <= ringW + 3 * s) return [...DIMGREEN, 255];

  // Bras du réticule (gap central)
  const armW = 6 * s, gap = 26 * s, reach = 118 * s;
  if (inBar(x, y, cx, cy, armW, reach) && (Math.abs(y - cy) > gap)) return [...GREEN, 255];
  if (inBar(x, y, cx, cy, reach, armW) && (Math.abs(x - cx) > gap)) return [...GREEN, 255];

  // Point central
  if (d <= 9 * s) return [...GREEN, 255];

  // Liseré interne
  if (sdRoundRect(x, y, cx, cy, H / 2 - 4 * s, H / 2 - 4 * s, 46 * s) > -3 * s) return [...BORDER, 255];

  return [...BG, 255];
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
