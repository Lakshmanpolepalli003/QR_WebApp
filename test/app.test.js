'use strict';

const assert = require('assert');
const path = require('path');

const app = require(path.join(__dirname, '..', 'app.js'));

/* ---------- helpers ---------- */
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

const build = (type, values) => {
  const err = {};
  return app.TYPES[type].build(values, err);
};

/* ---------- normalizeUrl ---------- */
console.log('\nnormalizeUrl');

test('adds https:// to bare domains', () => {
  assert.strictEqual(app.normalizeUrl('example.com'), 'https://example.com/');
});

test('keeps existing http(s) URLs intact', () => {
  assert.strictEqual(app.normalizeUrl('http://example.com/a?b=1'), 'http://example.com/a?b=1');
  assert.strictEqual(app.normalizeUrl('https://example.com/'), 'https://example.com/');
});

test('rejects non-http schemes and garbage', () => {
  assert.strictEqual(app.normalizeUrl('javascript:alert(1)'), null);
  assert.strictEqual(app.normalizeUrl('ftp://example.com'), null);
  assert.strictEqual(app.normalizeUrl('not a url'), null);
  assert.strictEqual(app.normalizeUrl(''), null);
  assert.strictEqual(app.normalizeUrl(null), null);
});

/* ---------- validPhone ---------- */
console.log('\nvalidPhone');

test('normalizes digits to E.164-ish', () => {
  assert.strictEqual(app.validPhone('+1 555 123 4567'), '+15551234567');
  assert.strictEqual(app.validPhone('(555) 123-4567'), '+5551234567');
});

test('rejects too-short, too-long and non-numeric input', () => {
  assert.strictEqual(app.validPhone('12345'), null);
  assert.strictEqual(app.validPhone('1'.repeat(16)), null);
  assert.strictEqual(app.validPhone('hello'), null);
  assert.strictEqual(app.validPhone(''), null);
});

/* ---------- payload builders ---------- */
console.log('\nbuildWifi');

test('builds WIFI payload with escaped special characters', () => {
  assert.strictEqual(
    build('wifi', { ssid: 'Home;Net', password: 'p@ss:word', security: 'WPA' }),
    'WIFI:T:WPA;S:Home\\;Net;P:p@ss\\:word;;'
  );
});

test('omits password for open networks', () => {
  assert.strictEqual(
    build('wifi', { ssid: 'Cafe', password: 'ignored', security: 'nopass' }),
    'WIFI:T:nopass;S:Cafe;;'
  );
});

test('requires an SSID', () => {
  const err = {};
  const out = app.TYPES.wifi.build({ ssid: '  ', security: 'WPA' }, err);
  assert.ok(err.ssid, 'expected ssid error');
  assert.strictEqual(out, 'WIFI:T:WPA;S:;;');
});

console.log('\nbuildEmail');

test('builds mailto with subject and body', () => {
  assert.strictEqual(
    build('email', { email: 'a@b.co', subject: 'Hi', message: 'Line one' }),
    'mailto:a@b.co?subject=Hi&body=Line%20one'
  );
});

test('rejects invalid addresses', () => {
  const err = {};
  const out = app.TYPES.email.build({ email: 'nope' }, err);
  assert.ok(err.email);
  assert.strictEqual(out, 'mailto:nope');
});

console.log('\nbuildPhone / buildSms / buildLocation');

test('phone payload', () => {
  assert.strictEqual(build('phone', { phone: '+1 (555) 123-4567' }), 'tel:+15551234567');
});

test('sms payload with message', () => {
  assert.strictEqual(build('sms', { phone: '5551234567', message: 'Yo' }), 'SMSTO:+5551234567:Yo');
});

test('location payload and range validation', () => {
  assert.strictEqual(build('location', { lat: '40.7128', lng: '-74.0060' }), 'geo:40.7128,-74.006');
  const err = {};
  const out = app.TYPES.location.build({ lat: '95', lng: '0' }, err);
  assert.ok(err.lat);
  assert.strictEqual(out, null);
});

console.log('\nbuildVcard');

test('vCard contains FN and version, escapes separators', () => {
  const out = build('vcard', { firstName: 'Jane', lastName: 'Doe;Jr', org: 'A,B', phone: '+1 555 123 4567', email: 'j@d.co', website: 'example.com' });
  assert.ok(out.startsWith('BEGIN:VCARD\r\nVERSION:3.0'));
  assert.ok(out.includes('FN:Jane Doe\\;Jr'));
  assert.ok(out.includes('ORG:A\\,B'));
  assert.ok(out.includes('TEL;TYPE=CELL:+1 555 123 4567')); // kept as typed, only validated
  assert.ok(out.includes('URL:https://example.com/'));
  assert.ok(out.endsWith('END:VCARD'));
});

test('vCard requires at least a name', () => {
  const err = {};
  const out = app.TYPES.vcard.build({ firstName: '', lastName: '' }, err);
  assert.ok(err.firstName);
  assert.strictEqual(out, null);
});

/* ---------- classify (scan results) ---------- */
console.log('\nclassify');

test('classifies URLs and adds an openUrl', () => {
  const r = app.classify('https://example.com/x');
  assert.strictEqual(r.type, 'URL');
  assert.strictEqual(r.openUrl, 'https://example.com/x');
});

test('never opens javascript: links', () => {
  const r = app.classify('javascript:alert(1)');
  assert.notStrictEqual(r.type, 'URL');
  assert.ok(!r.openUrl);
});

test('bare domains get https', () => {
  const r = app.classify('example.com');
  assert.strictEqual(r.type, 'URL');
  assert.strictEqual(r.openUrl, 'https://example.com/');
});

test('classifies Wi-Fi payloads', () => {
  const r = app.classify('WIFI:T:WPA;S:Net;P:pw;;');
  assert.strictEqual(r.type, 'Wi-Fi');
  assert.ok(r.details.some(([k, v]) => k === 'Network (SSID)' && v === 'Net'));
});

test('classifies phone, email, sms, geo and vCard', () => {
  assert.strictEqual(app.classify('tel:+15551234567').type, 'Phone');
  assert.strictEqual(app.classify('mailto:a@b.co').type, 'Email');
  assert.strictEqual(app.classify('SMSTO:+15551234567:hi').type, 'SMS');
  assert.strictEqual(app.classify('geo:40.7,-74.0').type, 'Location');
  assert.strictEqual(app.classify('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A B\r\nEND:VCARD').type, 'vCard');
});

test('falls back to Text', () => {
  assert.strictEqual(app.classify('just some words').type, 'Text');
  assert.strictEqual(app.classify('').type, 'Text');
});

/* ---------- esc helpers ---------- */
console.log('\nescaping helpers');

test('escWifi escapes \\ ; , : " only', () => {
  assert.strictEqual(app.escWifi('a\\b;c,d:e"f'), 'a\\\\b\\;c\\,d\\:e\\"f');
});

test('escVcard escapes backslash, comma, semicolon and newlines', () => {
  assert.strictEqual(app.escVcard('a,b\nc'), 'a\\,b c');
});

test('escXml escapes XML entities', () => {
  assert.strictEqual(app.escXml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
});

test('truncate adds ellipsis', () => {
  assert.strictEqual(app.truncate('abcdef', 5), 'abcd\u2026');
  assert.strictEqual(app.truncate('abc', 5), 'abc');
});

/* ---------- summary ---------- */
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  process.exit(1);
}
