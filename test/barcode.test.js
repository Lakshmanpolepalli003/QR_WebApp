'use strict';

const assert = require('assert');
const path = require('path');

/* Barcode scanning unit tests. The decode-engine cases rasterize real barcode
 * encodings (bwip-js canonical run widths + a spec-accurate Code 93 builder)
 * and push them through the app's actual zxingDecodeImageData pipeline.
 * The full PNG end-to-end matrix lives in test/decode-png-fixtures.js. */

global.window = global;
window.ZXing = require(path.join(__dirname, '..', 'vendor', 'zxing.min.js'));
const app = require(path.join(__dirname, '..', 'app.js'));
const bwip = require(path.join(__dirname, 'fixtures', 'bwip-js.js'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.error('  \u2717 ' + name);
    console.error('      ' + (e && e.message ? e.message.split('\n')[0] : e));
  }
}

/* ---------- helpers ---------- */

// Rasterize a 1D sbs run list ([bar,space,...] in modules) or a 2D pixs grid
// into grayscale, then to RGBA, mirroring the canvas upload path.
function rasterize(enc, mod = 4, quiet = 48) {
  let w, h, gray;
  if (enc.pixs) {
    const gw = enc.pixx, gh = enc.pixy;
    w = gw * mod + quiet * 2;
    h = gh * mod + quiet * 2;
    gray = new Uint8ClampedArray(w * h).fill(255);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (!enc.pixs[y * gw + x]) continue;
        for (let dy = 0; dy < mod; dy++) {
          const row = (quiet + y * mod + dy) * w + quiet;
          for (let dx = 0; dx < mod; dx++) gray[row + x * mod + dx] = 0;
        }
      }
    }
  } else {
    w = enc.sbs.reduce((a, b) => a + b, 0) * mod + quiet * 2;
    h = 120;
    gray = new Uint8ClampedArray(w * h).fill(255);
    let x = quiet;
    for (let i = 0; i < enc.sbs.length; i++) {
      if (i % 2 === 0) {
        for (let b = 0; b < enc.sbs[i] * mod; b++) {
          for (let y = 0; y < h; y++) gray[y * w + x + b] = 0;
        }
      }
      x += enc.sbs[i] * mod;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = gray[i];
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return { rgba, w, h };
}

function expectDecodes(bcid, text, opts, expectedText, expectedFormat) {
  const enc = bwip.raw(Object.assign({ bcid, text, padding: 16, includetext: false }, opts))[0];
  const { rgba, w, h } = rasterize(enc);
  const hit = app.zxingDecodeImageData(rgba, w, h);
  assert.ok(hit, bcid + ' should decode');
  assert.strictEqual(hit.text, expectedText);
  assert.strictEqual(hit.formatName, expectedFormat);
}

/* ---------- classifyBarcode ---------- */
console.log('\nclassifyBarcode');

test('tags results as Barcode with the barcode icon', () => {
  const c = app.classifyBarcode({ text: '4006381333931', formatName: 'EAN-13' });
  assert.strictEqual(c.type, 'Barcode');
  assert.strictEqual(c.label, 'Barcode');
  assert.strictEqual(c.icon, 'i-barcode');
  assert.strictEqual(c.isBarcode, true);
  assert.strictEqual(c.raw, '4006381333931');
  assert.strictEqual(c.barcodeFormat, 'EAN-13');
});

test('keeps the detected format name untouched', () => {
  const c = app.classifyBarcode({ text: 'ABC', formatName: 'Code 128' });
  assert.strictEqual(c.barcodeFormat, 'Code 128');
});

test('returns null for empty decoded text', () => {
  assert.strictEqual(app.classifyBarcode({ text: '' }), null);
  assert.strictEqual(app.classifyBarcode({ text: '   ' }), null);
});

test('treats a genuine http/https barcode as a URL with safe openUrl', () => {
  const c = app.classifyBarcode({ text: 'https://example.com/bar', formatName: 'Data Matrix' });
  assert.strictEqual(c.type, 'URL');
  assert.strictEqual(c.openUrl, 'https://example.com/bar');
  assert.strictEqual(c.isBarcode, true, 'URL barcodes keep barcode metadata');
  assert.strictEqual(c.barcodeFormat, 'Data Matrix');
});

test('never treats product numbers or javascript: values as URLs', () => {
  assert.strictEqual(app.classifyBarcode({ text: '8901234567890' }).type, 'Barcode');
  assert.strictEqual(app.classifyBarcode({ text: 'javascript:alert(1)' }).openUrl, undefined);
  assert.strictEqual(app.classifyBarcode({ text: 'javascript:alert(1)' }).type, 'Barcode');
});

/* ---------- barcodeFormatName / BARCODE_LABELS ---------- */
console.log('\nbarcodeFormatName');

test('maps string enum names to friendly labels', () => {
  assert.strictEqual(app.barcodeFormatName('EAN_13'), 'EAN-13');
  assert.strictEqual(app.barcodeFormatName('CODE_128'), 'Code 128');
  assert.strictEqual(app.barcodeFormatName('UPC_A'), 'UPC-A');
  assert.strictEqual(app.barcodeFormatName('QR_CODE'), 'QR Code');
});

test('passes unknown names through and nulls empty input', () => {
  assert.strictEqual(app.barcodeFormatName('SOMETHING_ELSE'), 'SOMETHING_ELSE');
  assert.strictEqual(app.barcodeFormatName(null), null);
  assert.strictEqual(app.barcodeFormatName(undefined), null);
});

test('label table covers every required format', () => {
  for (const f of ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39',
    'CODE_93', 'ITF', 'CODABAR', 'DATA_MATRIX', 'PDF_417', 'AZTEC', 'QR_CODE']) {
    assert.ok(app.BARCODE_LABELS[f], 'missing label for ' + f);
  }
});

/* ---------- zxingDecodeImageData (real decode pipeline) ---------- */
console.log('\nzxingDecodeImageData');

test('decodes a real EAN-13 encoding', () => {
  expectDecodes('ean13', '4006381333931', {}, '4006381333931', 'EAN-13');
});

test('decodes a real Code 128 encoding', () => {
  expectDecodes('code128', 'Code-128-test-9317', {}, 'Code-128-test-9317', 'Code 128');
});

test('decodes a real Code 39 encoding', () => {
  expectDecodes('code39', 'CODE 39 TEST', {}, 'CODE 39 TEST', 'Code 39');
});

test('decodes a real ITF-14 encoding', () => {
  expectDecodes('itf14', '12345678901231', {}, '12345678901231', 'ITF');
});

test('decodes a real Data Matrix encoding', () => {
  expectDecodes('datamatrix', 'DM fixture 424242', {}, 'DM fixture 424242', 'Data Matrix');
});

test('decodes a real QR code through the unified path', () => {
  expectDecodes('qrcode', 'https://example.com/qr', {}, 'https://example.com/qr', 'QR Code');
});

test('returns null for an image with no code', () => {
  const w = 300, h = 120;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  assert.strictEqual(app.zxingDecodeImageData(rgba, w, h), null);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  process.exit(1);
}
