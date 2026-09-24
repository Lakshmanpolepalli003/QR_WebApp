/* Generates icons/*.png for the PWA manifest — dependency-free (Node zlib).
   Run: node tools/gen-icons.js */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- minimal PNG encoder (RGBA, 8-bit) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // stride = width*4 + filter byte
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- drawing ---------- */
function roundedRectSDF(px, py, x, y, w, h, r) {
  // returns true if point is inside the rounded rect
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  // inside the inner (non-corner) area → distance to clamped point is 0
  if ((px < x + r || px > x + w - r) && (py < y + r || py > y + h - r)) {
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

const SQUARES = [
  { x: 6, y: 6, w: 8, h: 8, r: 2 },
  { x: 18, y: 6, w: 8, h: 8, r: 2 },
  { x: 6, y: 18, w: 8, h: 8, r: 2 },
  { x: 18.5, y: 18.5, w: 3.5, h: 3.5, r: 1 },
  { x: 23, y: 23.5, w: 2.5, h: 2.5, r: 0.8 }
];

const BG = [0x25, 0x63, 0xeb]; // #2563EB
const FG = [0xff, 0xff, 0xff]; // #FFFFFF

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Renders the brand mark at size×size. mode: 'rounded' (rounded tile) or 'full' (square, for maskable). */
function render(size, mode, scale = 1) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // supersampling factor per axis
  const inv = 1 / (SS * SS);
  const cornerR = mode === 'rounded' ? (size / 32) * 8 : 0;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;
          // background tile (inset 0 for full-bleed maskable, rounded for normal)
          const inBg = mode === 'full' ? true : roundedRectSDF(fx, fy, 0, 0, size, size, cornerR);
          if (!inBg) continue;
          let inFg = false;
          for (const sq of SQUARES) {
            const x = (sq.x / 32) * size * scale + size * (1 - scale) / 2;
            const y = (sq.y / 32) * size * scale + size * (1 - scale) / 2;
            const w = (sq.w / 32) * size * scale;
            const h = (sq.h / 32) * size * scale;
            const r = (sq.r / 32) * size * scale;
            if (roundedRectSDF(fx, fy, x, y, w, h, r)) { inFg = true; break; }
          }
          cover += inv;
        }
      }
      const i = (py * size + px) * 4;
      rgba[i] = FG[0];
      rgba[i + 1] = FG[1];
      rgba[i + 2] = FG[2];
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return rgba;
}

/** Composites the rounded mark over a flat background color (for maskable/apple icons). */
function renderOnBackground(size, bgHex, scale) {
  const mark = render(size, 'rounded', scale);
  const bg = hexToRgb(bgHex);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = mark[i * 4 + 3] / 255;
    out[i * 4] = Math.round(FG[0] * a + bg[0] * (1 - a));
    out[i * 4 + 1] = Math.round(FG[1] * a + bg[1] * (1 - a));
    out[i * 4 + 2] = Math.round(FG[2] * a + bg[2] * (1 - a));
    out[i * 4 + 3] = 255;
  }
  return out;
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const jobs = [
  { file: 'icon-192.png', size: 192, buf: render(192, 'rounded') },
  { file: 'icon-512.png', size: 512, buf: render(512, 'rounded') },
  { file: 'apple-touch-icon.png', size: 180, buf: renderOnBackground(180, '#2563EB', 1) },
  { file: 'maskable-512.png', size: 512, buf: renderOnBackground(512, '#2563EB', 0.72) }
];

for (const j of jobs) {
  const png = encodePng(j.size, j.size, j.buf);
  fs.writeFileSync(path.join(outDir, j.file), png);
  console.log('wrote', j.file, png.length, 'bytes');
}
console.log('done');
