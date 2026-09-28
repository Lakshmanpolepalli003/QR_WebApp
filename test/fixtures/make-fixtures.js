'use strict';
/* Generates real barcode PNGs into test/fixtures/png/ using bwip-js (a real
 * barcode encoder). These are the exact images used by the browser tests, so
 * every decode proven in Node is reproduced against the running site.
 * Run: node test/fixtures/make-fixtures.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const bwip = require('./bwip-js.js');

const OUT = path.join(__dirname, 'png');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---------- minimal PNG writer (8-bit grayscale) ---------- */
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
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function writeGrayPng(file, w, h, gray) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray[y * w + x];
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(OUT, file), png);
}

/* ---------- Code 93 builder ----------
 * bwip's code93 raw() omits the two mandatory check characters (C and K),
 * which is why every real Code 93 reader rejects it. Build the symbol from
 * the canonical 9-module pattern table (the same values ZXing's reader uses)
 * plus the spec checksums: C (weights 1..20 from the right), K (weights
 * 1..15, computed over message+C). */
const C93_ENC = [
  276, 328, 324, 322, 296, 292, 290, 336, 274, 266, // 0-9
  424, 420, 418, 404, 402, 394, 360, 356, 354, 308, // A-J
  282, 344, 332, 326, 300, 278, 436, 434, 428, 422, // K-T
  406, 410, 364, 358, 310, 314, 302, 468, 466, 458, // U-.
  366, 374, 430, 294, 474, 470, 306, // / + % SPACE... (IDs 40-46)
  350, // '*' start/stop (101011110)
];
const C93_ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
function c93Widths(v) {
  const bits = v.toString(2).padStart(9, '0');
  const runs = [];
  let cur = bits[0], n = 1;
  for (let i = 1; i < 9; i++) {
    if (bits[i] === cur) n++;
    else { runs.push(n); cur = bits[i]; n = 1; }
  }
  runs.push(n);
  return runs; // 6 runs, starts with a bar
}
function code93Sbs(text) {
  const ids = [...text].map((ch) => {
    const i = C93_ALPHA.indexOf(ch);
    if (i < 0) throw new Error('code93: unsupported char ' + JSON.stringify(ch));
    return i;
  });
  const c = ids.reduce((a, id, idx) => a + id * ((ids.length - 1 - idx) % 20 + 1), 0) % 47;
  const withC = [...ids, c];
  const k = withC.reduce((a, id, idx) => a + id * ((withC.length - 1 - idx) % 15 + 1), 0) % 47;
  const star = c93Widths(C93_ENC[47]);
  const runs = [...star];
  for (const id of [...ids, c, k]) runs.push(...c93Widths(C93_ENC[id]));
  runs.push(...star, 1); // stop + termination bar
  return runs;
}

/* ---------- fixtures: one real encoding per format ---------- */
// bwip bcid -> (value, file, extra options)
const FIXTURES = [
  ['ean13',            '4006381333931',                     'ean13.png'],
  ['ean8',             '96385074',                          'ean8.png'],
  ['upca',             '036000291452',                      'upca.png'],
  ['code128',          'Code-128-test-9317',                'code128.png'],
  ['code39',           'CODE 39 TEST',                      'code39.png'],
  ['code93spec',       'CODE 93 TEST',                      'code93.png'], // built to spec (bwip omits check chars)
  ['itf14',            '12345678901231',                    'itf.png'],
  ['rationalizedCodabar', 'A401567890124B',                 'codabar.png'],
  ['datamatrix',       'DM fixture 424242',                 'datamatrix.png'],
  ['pdf417',           'PDF417 fixture 12345',              'pdf417.png'],
  ['azteccode',       'Aztec fixture 777',                 'aztec.png'],
  // QR regression: a REAL QR code through the existing QR upload path
  ['qrcode',           'https://example.com/qr-regression', 'qrcode.png'],
  // URL barcode: proves Open Link appears for barcodes that ARE urls
  ['datamatrix',       'https://example.com/bar',           'datamatrix-url.png'],
  // Negative control: blank 300x120 white image, no code at all
  null,
];

for (const f of FIXTURES) {
  if (!f) { // blank control
    const w = 300, h = 120;
    writeGrayPng('blank.png', w, h, new Uint8Array(w * h).fill(255));
    console.log('blank.png  (control, no code)');
    continue;
  }
  const [bcid, text, file] = f;
  let sbsOverride = null;
  if (bcid === 'code93spec') { sbsOverride = code93Sbs(text); }
  const enc = sbsOverride
    ? { sbs: sbsOverride }
    : bwip.raw({ bcid, text, scale: 4, padding: 16, includetext: false })[0];
  const MOD = 4;      // px per symbol module (like a real screenshot)
  const QUIET = 48;   // px quiet zone (12 modules) on every side
  let w, h, gray;
  if (enc.pixs) {
    // 2D encoders return the module grid (pixx x pixy). Upscale nearest-neighbor
    // so each module is MOD px — how a real photo of a symbol looks.
    const gw = enc.pixx, gh = enc.pixy;
    w = gw * MOD + QUIET * 2;
    h = gh * MOD + QUIET * 2;
    gray = new Uint8Array(w * h).fill(255);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (!enc.pixs[y * gw + x]) continue;
        for (let dy = 0; dy < MOD; dy++) {
          const row = (QUIET + y * MOD + dy) * w + QUIET;
          for (let dx = 0; dx < MOD; dx++) gray[row + x * MOD + dx] = 0;
        }
      }
    }
  } else if (enc.sbs) {
    // 1D encoders return canonical run widths sbs=[bar,space,...] starting
    // with a bar, in modules. Rasterize at MOD px per module + quiet zone.
    w = enc.sbs.reduce((a, b) => a + b, 0) * MOD + QUIET * 2;
    h = 120;
    gray = new Uint8Array(w * h).fill(255);
    let x = QUIET;
    for (let i = 0; i < enc.sbs.length; i++) {
      if (i % 2 === 0) { // even index = bar
        for (let b = 0; b < enc.sbs[i] * MOD; b++)
          for (let y = 0; y < h; y++) gray[y * w + x + b] = 0;
      }
      x += enc.sbs[i] * MOD;
    }
  } else {
    throw new Error(bcid + ': no pixs and no sbs in raw() output');
  }
  writeGrayPng(file, w, h, gray);
  console.log(file.padEnd(20), w + 'x' + h, JSON.stringify(text));
}
console.log('\nFixtures written to ' + OUT);
