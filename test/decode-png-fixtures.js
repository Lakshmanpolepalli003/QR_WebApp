'use strict';
/* Node-side end-to-end decode check: reads each PNG fixture (8-bit grayscale,
 * filter 0 — the format make-fixtures.js writes), converts to RGBA exactly the
 * way canvas getImageData would, and decodes with the app's real
 * zxingDecodeImageData. Mirrors the browser upload path 1:1.
 *
 * Run: node test/decode-png-fixtures.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

global.window = global;
window.ZXing = require('../vendor/zxing.min.js');
const app = require('../app.js');

const DIR = path.join(__dirname, 'fixtures', 'png');

/* --- minimal PNG reader for the fixtures this suite generates:
 *     8-bit grayscale, color type 0, filter 0 per row, single IDAT --- */
function readGrayPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 0) throw new Error('expected 8-bit grayscale');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w + 1)] !== 0) throw new Error('unexpected row filter');
    for (let x = 0; x < w; x++) gray[y * w + x] = raw[y * (w + 1) + 1 + x];
  }
  return { gray, w, h };
}

function toRGBA(gray, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = gray[i];
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/* fixture file -> expected decoded text ('' = expect NO decode) */
const CASES = [
  ['ean13.png',            '4006381333931'],
  ['ean8.png',             '96385074'],
  ['upca.png',             '036000291452'],
  ['code128.png',          'Code-128-test-9317'],
  ['code39.png',           'CODE 39 TEST'],
  ['code93.png',           'CODE 93 TEST'],
  ['itf.png',              '12345678901231'],
  ['codabar.png',          'A401567890124B'],
  ['datamatrix.png',       'DM fixture 424242'],
  ['pdf417.png',           'PDF417 fixture 12345'],
  ['aztec.png',            'Aztec fixture 777'],
  ['qrcode.png',           'https://example.com/qr-regression'],
  ['datamatrix-url.png',   'https://example.com/bar'],
  ['blank.png',            null], // must NOT decode to anything
];

let pass = 0, fail = 0;
for (const [file, expected] of CASES) {
  let got = null, err = null, fmt = null;
  const t0 = Date.now();
  try {
    const { gray, w, h } = readGrayPng(path.join(DIR, file));
    const hit = app.zxingDecodeImageData(toRGBA(gray, w, h), w, h);
    if (hit) { got = hit.text; fmt = hit.formatName; }
  } catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  const ok = err === null && (expected === null ? got === null : got === expected);
  if (ok) pass++; else fail++;
  console.log(
    (ok ? 'PASS' : 'FAIL'),
    file.padEnd(20),
    err ? ('ERROR: ' + err) : ('got=' + JSON.stringify(got) + ' fmt=' + fmt + ' (' + ms + 'ms)'),
    ok ? '' : ('expected=' + JSON.stringify(expected))
  );
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
