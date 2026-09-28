/* Generates every QR Studio icon + favicon.ico — dependency-free (Node zlib).
   Run: node tools/gen-icons.js

   Design: dark professional rounded tile (#111111), white QR finder squares
   and brand-blue accent dots (#3B82F6 — the site's dark-mode --primary),
   mirroring the in-app brand mark geometry (32-unit grid). */
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
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- palette ---------- */
const BG = [0x11, 0x11, 0x11];      // #111111 dark professional tile
const WHITE = [0xff, 0xff, 0xff];  // finder squares
const ACCENT = [0x3b, 0x82, 0xf6]; // #3B82F6 accent dots (site dark-mode --primary)

/* ---------- glyph geometry (32-unit grid, matches in-app brand mark) ---------- */
const FINDERS = [
  { x: 6, y: 6, w: 8, h: 8, r: 2 },
  { x: 18, y: 6, w: 8, h: 8, r: 2 },
  { x: 6, y: 18, w: 8, h: 8, r: 2 }
];
const DOTS = [
  { x: 18.5, y: 18.5, w: 3.5, h: 3.5, r: 1 },
  { x: 23, y: 23.5, w: 2.5, h: 2.5, r: 0.8 }
];

function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  if ((px < x + r || px > x + w - r) && (py < y + r || py > y + h - r)) {
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

/**
 * Renders one icon frame at size×size.
 *  - mode 'tile':   rounded dark tile with transparency outside (tab/shortcut icons)
 *  - mode 'opaque': full-bleed dark square (maskable / apple-touch)
 * glyphScale: 1 = glyph spans 20/32 of the canvas (identical to the in-app mark).
 * Maskable uses a reduced scale so the artwork stays inside the safe zone.
 */
function renderIcon(size, mode, glyphScale = 1) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = size <= 64 ? 8 : size <= 256 ? 4 : 3; // supersampling per axis
  const inv = 1 / (SS * SS);
  const cornerR = mode === 'opaque' ? 0 : (size / 32) * 8;
  const g = (v) => (v / 32) * size * glyphScale + (size * (1 - glyphScale)) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0, glyph = 0, accent = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;
          const inTile = mode === 'opaque' ? true : inRoundedRect(fx, fy, 0, 0, size, size, cornerR);
          if (!inTile) continue;
          tile += inv;
          let hit = false;
          for (const q of FINDERS) {
            if (inRoundedRect(fx, fy, g(q.x), g(q.y), g(q.w), g(q.h), g(q.r))) { glyph += inv; hit = true; break; }
          }
          if (hit) continue;
          for (const q of DOTS) {
            if (inRoundedRect(fx, fy, g(q.x), g(q.y), g(q.w), g(q.h), g(q.r))) { accent += inv; hit = true; break; }
          }
        }
      }
      const i = (py * size + px) * 4;
      const aT = tile, aG = glyph, aA = accent;
      const base = aT - aG - aA; // exposed tile area
      rgba[i]     = Math.round(BG[0] * base + WHITE[0] * aG + ACCENT[0] * aA);
      rgba[i + 1] = Math.round(BG[1] * base + WHITE[1] * aG + ACCENT[1] * aA);
      rgba[i + 2] = Math.round(BG[2] * base + WHITE[2] * aG + ACCENT[2] * aA);
      rgba[i + 3] = Math.round(aT * 255);
    }
  }
  return rgba;
}

/* ---------- multi-resolution .ico writer (PNG-compressed entries) ---------- */
function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const e = dir.subarray(i * 16, i * 16 + 16);
    e[0] = img.size >= 256 ? 0 : img.size; // 0 means 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0;                              // palette
    e[3] = 0;                              // reserved
    e.writeUInt16LE(1, 4);                 // planes
    e.writeUInt16LE(32, 6);                // bpp
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

/* ---------- generate everything ---------- */
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const SIZES = [16, 32, 48, 72, 96, 128, 144, 192, 256, 384, 512];
const written = [];

for (const s of SIZES) {
  const name = s <= 48 ? `favicon-${s}.png` : `icon-${s}.png`;
  const png = encodePng(s, s, renderIcon(s, 'tile'));
  fs.writeFileSync(path.join(outDir, name), png);
  written.push({ file: `icons/${name}`, size: s, png });
}

// Maskable: full-bleed square, artwork inside the safe zone (scale 0.85 →
// glyph corner radius 0.376 < 0.4·canvas safe circle).
fs.writeFileSync(path.join(outDir, 'maskable-512.png'),
  encodePng(512, 512, renderIcon(512, 'opaque', 0.85)));
written.push({ file: 'icons/maskable-512.png', size: 512 });

// Apple touch: opaque (iOS flattens transparency), standard 180px.
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'),
  encodePng(180, 180, renderIcon(180, 'opaque', 1)));
written.push({ file: 'icons/apple-touch-icon.png', size: 180 });

// favicon.ico: 16 + 32 + 48 in one file.
const ico = makeIco(
  [16, 32, 48].map((s) => ({ size: s, png: encodePng(s, s, renderIcon(s, 'tile')) }))
);
fs.writeFileSync(path.join(__dirname, '..', 'favicon.ico'), ico);
written.push({ file: 'favicon.ico', size: '16+32+48' });

for (const w of written) console.log('wrote', w.file, `(${w.size})`);
console.log('done');
