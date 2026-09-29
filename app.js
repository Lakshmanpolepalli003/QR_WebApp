/* ============================================================
   QR Studio — app.js
   Generate & scan QR codes entirely in the browser.
   ============================================================ */
'use strict';

/* ============================================================
   0. Small utilities
   ============================================================ */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const icon = (id, className) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className || 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
};

const escXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }
};

/* ============================================================
   1. Library loading (local files first, CDN fallbacks) + engine readiness
   ============================================================ */
const LOCAL_LIBS = {
  qrcode: ['vendor/qrcode.min.js'],
  jsqr: ['vendor/jsQR.min.js'],
  zxing: ['vendor/zxing.min.js'],
  jsbarcode: ['vendor/JsBarcode.all.min.js']
};

const CDN = {
  qrcode: [
    'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js',
    'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js'
  ],
  jsqr: [
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
    'https://unpkg.com/jsqr@1.4.0/dist/jsQR.min.js'
  ],
  zxing: [
    'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
    'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js'
  ],
  jsbarcode: [
    'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js',
    'https://unpkg.com/jsbarcode@3.11.6/dist/JsBarcode.all.min.js'
  ]
};

function loadScript(urls) {
  return new Promise((resolve, reject) => {
    const attempt = (i) => {
      if (i >= urls.length) { reject(new Error('Failed to load: ' + urls[0])); return; }
      const s = document.createElement('script');
      s.src = urls[i];
      s.async = true;
      s.onload = () => resolve(urls[i]);
      s.onerror = () => { s.remove(); attempt(i + 1); };
      document.head.appendChild(s);
    };
    attempt(0);
  });
}

let engineReady = null;
function initEngine() {
  engineReady = Promise.all([
    loadScript(LOCAL_LIBS.qrcode.concat(CDN.qrcode)),
    loadScript(LOCAL_LIBS.jsqr.concat(CDN.jsqr))
  ])
    .then(([qrSrc, jsqrSrc]) => {
      // Force UTF-8 byte encoding for the generator (handles all characters).
      if (window.qrcode) {
        window.qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));
      }
      if (!window.qrcode || !window.jsQR) throw new Error('QR engine incomplete');
      state.libsLocal = String(qrSrc).indexOf('http') !== 0 && String(jsqrSrc).indexOf('http') !== 0;
    })
    .catch((err) => {
      $('#libNoticeText').textContent =
        'Couldn\u2019t load the QR engine. If you\u2019re offline, serve this folder over http://localhost so the bundled copy in vendor/ loads; otherwise check your connection and reload.';
      $('#libNotice').hidden = false;
      throw err;
    });

  // Barcode engine (ZXing) — best effort: if it fails, QR scanning keeps
  // working and barcode mode explains that it is unavailable.
  state.zxingReady = loadScript(LOCAL_LIBS.zxing.concat(CDN.zxing))
    .then(() => { state.zxingLoaded = true; return true; })
    .catch(() => { state.zxingLoaded = false; return false; });

  return engineReady;
}

async function ensureEngine() {
  try { await engineReady; return true; }
  catch (e) { return false; }
}

/* ============================================================
   2. State, constants, persistence
   ============================================================ */
const KEYS = {
  theme: 'qr-studio-theme',
  view: 'qr-studio-view',
  type: 'qr-studio-type',
  custom: 'qr-studio-custom',
  history: 'qr-studio-history',
  scanMode: 'qr-studio-scan-mode',
  genMode: 'qr-studio-gen-mode',
  bcCustom: 'qr-studio-bc-custom',
  bcValue: 'qr-studio-bc-value'
};

const SIZES = [256, 384, 512, 768, 1024];
const HISTORY_MAX = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DEFAULT_CUSTOM = Object.freeze({
  fg: '#2563EB',
  bg: '#FFFFFF',
  pattern: 'square',      // square | rounded | dots
  cornerStyle: 'square',  // square | rounded | dot
  size: 512,
  frame: 'none',          // none | scanme | custom
  frameText: ''
});

const state = {
  view: 'generate',
  currentType: 'url',
  custom: { ...DEFAULT_CUSTOM },
  hasQR: false,
  payload: null,
  svgString: null,
  svgW: 0,
  svgH: 0,
  formStore: {},
  history: [],
  uploadUrl: null,
  cameraStream: null,
  cameraTimer: null,
  cameraStarting: false,     // gUM in-flight guard (prevents double streams)
  camGeneration: 0,          // bumped by every stop; invalidates in-flight starts
  camFacing: 'environment',  // preferred facing for the next start
  cameras: [],               // enumerated videoinput devices (post-grant)
  camPermState: null,        // last known Permissions API state ('granted' | 'prompt' | 'denied')
  _camDebug: null,
  _camFacingNoteShown: false,
  clearArmedTimer: null,
  libsLocal: false,
  scanMode: 'qr',
  historyFilter: 'all',
  zxingReady: null,
  zxingLoaded: false,
  genMode: 'qr'
};

/* ============================================================
   3. Toasts
   ============================================================ */
const TOAST_ICON = { success: 'i-check', error: 'i-alert', info: 'i-info' };

function toast(message, kind) {
  const stack = $('#toastStack');
  const t = el('div', 'toast ' + (kind || 'success'));
  t.appendChild(icon(TOAST_ICON[kind] || 'i-check'));
  t.appendChild(el('span', null, message));
  stack.appendChild(t);
  while (stack.children.length > 4) stack.firstChild.remove();
  setTimeout(() => {
    t.classList.add('leaving');
    t.addEventListener('animationend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 400); // safety net
  }, 2600);
}

/* ============================================================
   4. Clipboard
   ============================================================ */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

async function copyWithToast(text, label) {
  const ok = await copyText(text);
  toast(ok ? (label || 'Copied to clipboard') : 'Copy failed. Please copy manually.', ok ? 'success' : 'error');
}

/* ============================================================
   5. Theme
   ============================================================ */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('#themeToggle').setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  try { localStorage.setItem(KEYS.theme, t); } catch (e) { /* ignore */ }
}

function initTheme() {
  const saved = (() => { try { return localStorage.getItem(KEYS.theme); } catch (e) { return null; } })();
  let theme = saved === 'light' || saved === 'dark'
    ? saved
    : (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);
  $('#themeToggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
}

/* ============================================================
   6. Navigation / views / drawer
   ============================================================ */
function setView(view) {
  state.view = view;
  const isGen = view === 'generate';
  $('#view-generate').hidden = !isGen;
  $('#view-scan').hidden = isGen;

  $$('.top-tab').forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $$('.nav-item').forEach((b) => {
    const match = b.dataset.view === view || (b.dataset.type && isGen && b.dataset.type === state.currentType);
    b.classList.toggle('active', !!match);
  });

  document.title = isGen
    ? 'QR Studio — ' + TYPES[state.currentType].heading
    : 'QR Studio — Scan QR Code';

  if (!isGen) stopCamera();
  closeDrawer();
  store.set(KEYS.view, view);
}

function openDrawer() {
  $('#sidebar').classList.add('open');
  $('#overlay').hidden = false;
  $('#hamburger').setAttribute('aria-expanded', 'true');
  document.body.classList.add('drawer-open');
  $('#drawerClose').focus();
}

function closeDrawer() {
  $('#sidebar').classList.remove('open');
  $('#overlay').hidden = true;
  $('#hamburger').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
}

function initNav() {
  $('#hamburger').addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', () => { closeDrawer(); $('#hamburger').focus(); });
  $('#overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#sidebar').classList.contains('open')) {
      closeDrawer(); $('#hamburger').focus();
    }
  });

  $$('.top-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('.nav-item[data-type]').forEach((b) =>
    b.addEventListener('click', () => { selectType(b.dataset.type); setView('generate'); })
  );

  $('#upgradeBtn').addEventListener('click', () => toast('Pro features are coming soon.', 'info'));
  $('#profileBtn').addEventListener('click', () => toast('Accounts are coming soon — QR Studio is free to use.', 'info'));

  // If the viewport grows past the drawer breakpoint while the drawer is open,
  // close it so the overlay never gets stuck on desktop.
  const drawerMq = window.matchMedia('(max-width: 768px)');
  const onDrawerMq = (e) => { if (!e.matches) closeDrawer(); };
  if (drawerMq.addEventListener) drawerMq.addEventListener('change', onDrawerMq);
  else if (drawerMq.addListener) drawerMq.addListener(onDrawerMq);
}

/* ============================================================
   7. QR type definitions (fields + payload builders)
   ============================================================ */
const normalizeUrl = (input) => {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (e) { /* invalid */ }
  return null;
};

const validPhone = (raw) => {
  const s = String(raw || '').trim();
  if (!/^[\d\s()+\-.]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  return '+' + digits;
};

const escWifi = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
const escVcard = (s) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, ' ');

const TYPES = {
  url: {
    label: 'URL', icon: 'i-link', file: 'url',
    heading: 'URL QR Code',
    desc: 'Enter a URL and create your QR code.',
    fields: [
      { name: 'url', label: 'Enter URL', type: 'url', placeholder: 'https://www.example.com', required: true, span: 2, autocomplete: 'url' }
    ],
    build(v, err) {
      const u = normalizeUrl(v.url);
      if (!String(v.url || '').trim()) err.url = 'Please enter a URL.';
      else if (!u) err.url = 'Please enter a valid URL.';
      return u;
    }
  },
  text: {
    label: 'Text', icon: 'i-type', file: 'text',
    heading: 'Text QR Code',
    desc: 'Type any text — single line or multi-line — and create your QR code.',
    fields: [
      { name: 'text', label: 'Enter text', type: 'textarea', placeholder: 'Type anything — a note, a code, a message…', required: true, span: 2, rows: 5, maxlength: 900 }
    ],
    build(v, err) {
      const t = String(v.text || '');
      if (!t.trim()) err.text = 'Please enter some text.';
      return t;
    }
  },
  wifi: {
    label: 'Wi-Fi', icon: 'i-wifi', file: 'wifi',
    heading: 'Wi-Fi QR Code',
    desc: 'Let people join your Wi-Fi network with a quick scan.',
    fields: [
      { name: 'ssid', label: 'Network name (SSID)', type: 'text', placeholder: 'My Home Wi-Fi', required: true, span: 2, autocomplete: 'off' },
      { name: 'password', label: 'Password', type: 'text', placeholder: 'Network password', span: 1, autocomplete: 'off' },
      { name: 'security', label: 'Security type', type: 'select', span: 1, options: [
        { value: 'WPA', label: 'WPA / WPA2 / WPA3' },
        { value: 'WEP', label: 'WEP' },
        { value: 'nopass', label: 'None (open network)' }
      ] }
    ],
    build(v, err) {
      const ssid = String(v.ssid || '').trim();
      if (!ssid) err.ssid = 'Please enter a network name (SSID).';
      const sec = v.security || 'WPA';
      const parts = ['T:' + sec, 'S:' + escWifi(ssid)];
      if (sec !== 'nopass' && String(v.password || '')) parts.push('P:' + escWifi(v.password));
      return 'WIFI:' + parts.join(';') + ';;';
    }
  },
  email: {
    label: 'Email', icon: 'i-mail', file: 'email',
    heading: 'Email QR Code',
    desc: 'Open a pre-filled email with one scan.',
    fields: [
      { name: 'email', label: 'Email address', type: 'email', placeholder: 'name@example.com', required: true, span: 2, autocomplete: 'email' },
      { name: 'subject', label: 'Subject', type: 'text', placeholder: 'Email subject (optional)', span: 2 },
      { name: 'message', label: 'Message', type: 'textarea', placeholder: 'Email body (optional)', span: 2, rows: 3 }
    ],
    build(v, err) {
      const em = String(v.email || '').trim();
      if (!em) err.email = 'Please enter an email address.';
      else if (!EMAIL_RE.test(em)) err.email = 'Please enter a valid email address.';
      const params = [];
      if (String(v.subject || '').trim()) params.push('subject=' + encodeURIComponent(v.subject.trim()));
      if (String(v.message || '').trim()) params.push('body=' + encodeURIComponent(v.message.trim()));
      return 'mailto:' + em + (params.length ? '?' + params.join('&') : '');
    }
  },
  phone: {
    label: 'Phone', icon: 'i-phone', file: 'phone',
    heading: 'Phone QR Code',
    desc: 'Start a phone call with a quick scan.',
    fields: [
      { name: 'phone', label: 'Phone number', type: 'tel', placeholder: '+1 555 123 4567', required: true, span: 2, autocomplete: 'tel' }
    ],
    build(v, err) {
      const p = validPhone(v.phone);
      if (!p) err.phone = 'Please enter a valid phone number.';
      return p ? 'tel:' + p : null;
    }
  },
  sms: {
    label: 'SMS', icon: 'i-message', file: 'sms',
    heading: 'SMS QR Code',
    desc: 'Open the messaging app with a pre-filled SMS.',
    fields: [
      { name: 'phone', label: 'Phone number', type: 'tel', placeholder: '+1 555 123 4567', required: true, span: 2, autocomplete: 'tel' },
      { name: 'message', label: 'Message', type: 'textarea', placeholder: 'Pre-filled message (optional)', span: 2, rows: 3 }
    ],
    build(v, err) {
      const p = validPhone(v.phone);
      if (!p) err.phone = 'Please enter a valid phone number.';
      const msg = String(v.message || '').trim();
      return p ? ('SMSTO:' + p + ':' + msg) : null;
    }
  },
  location: {
    label: 'Location', icon: 'i-pin', file: 'location',
    heading: 'Location QR Code',
    desc: 'Share a place by latitude and longitude.',
    fields: [
      { name: 'lat', label: 'Latitude', type: 'text', inputmode: 'decimal', placeholder: 'e.g. 40.7128', required: true, span: 1 },
      { name: 'lng', label: 'Longitude', type: 'text', inputmode: 'decimal', placeholder: 'e.g. -74.0060', required: true, span: 1 }
    ],
    build(v, err) {
      const lat = Number(String(v.lat || '').trim());
      const lng = Number(String(v.lng || '').trim());
      if (!String(v.lat || '').trim()) err.lat = 'Please enter a latitude.';
      else if (!Number.isFinite(lat) || lat < -90 || lat > 90) err.lat = 'Latitude must be between -90 and 90.';
      if (!String(v.lng || '').trim()) err.lng = 'Please enter a longitude.';
      else if (!Number.isFinite(lng) || lng < -180 || lng > 180) err.lng = 'Longitude must be between -180 and 180.';
      if (err.lat || err.lng) return null;
      return 'geo:' + lat + ',' + lng;
    }
  },
  vcard: {
    label: 'vCard', icon: 'i-user', file: 'vcard',
    heading: 'vCard QR Code',
    desc: 'Share contact details that save straight to a phone.',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', placeholder: 'Jane', required: true, span: 1, autocomplete: 'given-name' },
      { name: 'lastName', label: 'Last name', type: 'text', placeholder: 'Doe', span: 1, autocomplete: 'family-name' },
      { name: 'org', label: 'Organization', type: 'text', placeholder: 'Company or team (optional)', span: 2, autocomplete: 'organization' },
      { name: 'phone', label: 'Phone', type: 'tel', placeholder: '+1 555 123 4567', span: 1, autocomplete: 'tel' },
      { name: 'email', label: 'Email', type: 'email', placeholder: 'jane@example.com', span: 1, autocomplete: 'email' },
      { name: 'website', label: 'Website', type: 'url', placeholder: 'https://example.com', span: 2, autocomplete: 'url' }
    ],
    build(v, err) {
      const f = String(v.firstName || '').trim();
      const l = String(v.lastName || '').trim();
      const org = String(v.org || '').trim();
      const phone = String(v.phone || '').trim();
      const email = String(v.email || '').trim();
      const website = String(v.website || '').trim();
      if (!f && !l) err.firstName = 'Enter at least a first or last name.';
      if (phone && !validPhone(phone)) err.phone = 'Please enter a valid phone number.';
      if (email && !EMAIL_RE.test(email)) err.email = 'Please enter a valid email address.';
      if (website && !normalizeUrl(website)) err.website = 'Please enter a valid URL.';
      if (Object.keys(err).length) return null;
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + escVcard(l) + ';' + escVcard(f) + ';;;', 'FN:' + escVcard((f + ' ' + l).trim())];
      if (org) lines.push('ORG:' + escVcard(org));
      if (phone) lines.push('TEL;TYPE=CELL:' + phone);
      if (email) lines.push('EMAIL:' + email);
      if (website) lines.push('URL:' + normalizeUrl(website));
      lines.push('END:VCARD');
      return lines.join('\r\n');
    }
  },
  image: {
    label: 'Image URL', icon: 'i-image', file: 'image',
    heading: 'Image URL QR Code',
    desc: 'Link to an image online — the QR stores the URL, not the image itself.',
    fields: [
      { name: 'url', label: 'Image URL', type: 'url', placeholder: 'https://example.com/photo.jpg', required: true, span: 2, autocomplete: 'url' }
    ],
    build(v, err) {
      const u = normalizeUrl(v.url);
      if (!String(v.url || '').trim()) err.url = 'Please enter an image URL.';
      else if (!u) err.url = 'Please enter a valid image URL.';
      return u;
    }
  },
  file: {
    label: 'File URL', icon: 'i-file', file: 'file',
    heading: 'File URL QR Code',
    desc: 'Link to a PDF, résumé, portfolio or any public file.',
    fields: [
      { name: 'url', label: 'File URL', type: 'url', placeholder: 'https://example.com/document.pdf', required: true, span: 2, autocomplete: 'url' }
    ],
    build(v, err) {
      const u = normalizeUrl(v.url);
      if (!String(v.url || '').trim()) err.url = 'Please enter a file URL.';
      else if (!u) err.url = 'Please enter a valid file URL.';
      return u;
    }
  }
};

/* ============================================================
   8. Generate view — form rendering & handling
   ============================================================ */
function fieldHtml(f, type) {
  const id = 'f-' + f.name;
  const req = f.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
  let control = '';
  if (f.type === 'textarea') {
    control = '<textarea id="' + id + '" name="' + f.name + '" rows="' + (f.rows || 3) + '"' +
      (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '') +
      ' placeholder="' + escXml(f.placeholder || '') + '" aria-required="' + (f.required ? 'true' : 'false') + '"></textarea>';
  } else if (f.type === 'select') {
    control = '<span class="select-wrap"><select id="' + id + '" name="' + f.name + '">' +
      f.options.map((o) => '<option value="' + o.value + '">' + escXml(o.label) + '</option>').join('') +
      '</select></span>';
  } else {
    control = '<input id="' + id + '" name="' + f.name + '" type="' + (f.type || 'text') + '"' +
      (f.inputmode ? ' inputmode="' + f.inputmode + '"' : '') +
      (f.autocomplete ? ' autocomplete="' + f.autocomplete + '"' : ' autocomplete="off"') +
      ' placeholder="' + escXml(f.placeholder || '') + '" aria-required="' + (f.required ? 'true' : 'false') + '">';
  }
  return '<div class="field' + (f.span === 2 ? ' span-2' : '') + '" data-field="' + f.name + '">' +
    '<label for="' + id + '">' + escXml(f.label) + req + '</label>' +
    control +
    '<p class="field-error" id="' + id + '-err" hidden></p>' +
    '</div>';
}

function renderForm(type) {
  const def = TYPES[type];
  $('#genFields').innerHTML = def.fields.map((f) => fieldHtml(f, type)).join('');
  $$('#genFields input, #genFields textarea, #genFields select').forEach((input) => {
    input.addEventListener('input', () => clearFieldError(input.name));
  });
}

function collectForm(type) {
  const values = {};
  $$('#genFields [name]').forEach((input) => { values[input.name] = input.value; });
  return values;
}

function restoreForm(type) {
  const saved = state.formStore[type];
  if (!saved) return;
  Object.entries(saved).forEach(([name, value]) => {
    const input = $('#genFields [name="' + name + '"]');
    if (input) input.value = value;
  });
}

function saveForm(type) {
  state.formStore[type] = collectForm(type);
}

function clearFieldError(name) {
  const field = $('#genFields [data-field="' + name + '"]');
  if (!field) return;
  const errEl = $('.field-error', field);
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  const input = $('[name="' + name + '"]', field);
  if (input) input.removeAttribute('aria-invalid');
}

function showFieldErrors(errors) {
  $$('#genFields .field-error').forEach((e) => { e.hidden = true; e.textContent = ''; });
  $$('#genFields [aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  Object.entries(errors).forEach(([name, msg]) => {
    const field = $('#genFields [data-field="' + name + '"]');
    if (!field) return;
    const errEl = $('.field-error', field);
    if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
    const input = $('[name="' + name + '"]', field);
    if (input) input.setAttribute('aria-invalid', 'true');
  });
}

function selectType(type) {
  if (!TYPES[type]) return;
  saveForm(state.currentType);
  state.currentType = type;
  state.hasQR = false;
  state.payload = null;
  state.svgString = null;

  const def = TYPES[type];
  $('#genHeading').textContent = def.heading;
  $('#genDesc').textContent = def.desc;
  renderForm(type);
  restoreForm(type);
  $$('.nav-item[data-type]').forEach((b) => b.classList.toggle('active', b.dataset.type === type));

  updatePreviewVisibility();
  setDownloadsEnabled(false);
  document.title = 'QR Studio — ' + def.heading;
  store.set(KEYS.type, type);
}

async function onGenerate(e) {
  e.preventDefault();
  if (!(await ensureEngine())) {
    toast('QR engine failed to load. Check your connection and reload the page.', 'error');
    return;
  }
  const type = state.currentType;
  const values = collectForm(type);
  const errors = {};
  let payload = null;
  try {
    payload = TYPES[type].build(values, errors);
  } catch (err) {
    toast('Could not build the QR payload. Please check your input.', 'error');
    return;
  }
  saveForm(type);
  showFieldErrors(errors);
  if (Object.keys(errors).length || payload === null || payload === undefined) {
    toast('Please fix the highlighted fields.', 'error');
    const firstBad = $('#genFields [aria-invalid="true"]');
    if (firstBad) firstBad.focus();
    return;
  }

  try {
    state.hasQR = true;
    renderQr(payload);
  } catch (err) {
    state.hasQR = false;
    updatePreviewVisibility();
    if (err && err.message === 'QR_TOO_LONG') {
      toast('This content is too long to fit in a QR code. Try shortening it.', 'error');
    } else {
      toast('Could not generate the QR code. Please try again.', 'error');
    }
    return;
  }

  setDownloadsEnabled(true);
  toast('QR code generated', 'success');
  if (window.matchMedia('(max-width: 1080px)').matches) {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    $('#previewCard').scrollIntoView({ behavior, block: 'start' });
  }
}

function onClear() {
  $$('#genFields input, #genFields textarea').forEach((i) => {
    if (i.tagName === 'SELECT') return;
    i.value = '';
  });
  const select = $('#genFields select');
  if (select) select.value = select.options[0].value;
  showFieldErrors({});
  saveForm(state.currentType);
  const first = $('#genFields input, #genFields textarea');
  if (first) first.focus();
}

/* ============================================================
   9. QR rendering (matrix → styled SVG)
   ============================================================ */
function roundedRectPath(x, y, w, h, r) {
  if (r <= 0) return 'M' + x + ',' + y + 'h' + w + 'v' + h + 'h' + (-w) + 'Z';
  r = Math.min(r, w / 2, h / 2);
  return 'M' + (x + r) + ',' + y +
    'h' + (w - 2 * r) +
    'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
    'v' + (h - 2 * r) +
    'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r +
    'h' + (-(w - 2 * r)) +
    'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + (-r) +
    'v' + (-(h - 2 * r)) +
    'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) +
    'Z';
}

function modulePath(x, y, s, tl, tr, br, bl) {
  let d = 'M' + (x + tl) + ',' + y;
  d += 'H' + (x + s - tr);
  d += tr ? 'A' + tr + ' ' + tr + ' 0 0 1 ' + (x + s) + ',' + (y + tr) : 'L' + (x + s) + ',' + y;
  d += 'V' + (y + s - br);
  d += br ? 'A' + br + ' ' + br + ' 0 0 1 ' + (x + s - br) + ',' + (y + s) : 'L' + (x + s - br) + ',' + (y + s);
  d += 'H' + (x + bl);
  d += bl ? 'A' + bl + ' ' + bl + ' 0 0 1 ' + x + ',' + (y + s - bl) : 'L' + x + ',' + (y + s - bl);
  d += 'V' + (y + tl);
  d += tl ? 'A' + tl + ' ' + tl + ' 0 0 1 ' + (x + tl) + ',' + y : 'L' + (x + tl) + ',' + y;
  return d + 'Z';
}

const safeHex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback);

function buildQrSvg(payload) {
  const c = state.custom;
  const fg = safeHex(c.fg, '#2563EB');
  const bg = safeHex(c.bg, '#FFFFFF');
  const ecc = c.logo ? 'H' : 'Q'; // high error correction when a logo is embedded

  let qr;
  try {
    qr = window.qrcode(0, ecc);
    qr.addData(payload, 'Byte');
    qr.make();
  } catch (e) {
    const err = new Error('QR_TOO_LONG');
    throw err;
  }

  const n = qr.getModuleCount();
  const C = 16;          // SVG units per module
  const QUIET = 4;       // quiet zone in modules (spec standard)
  const useCustomFinder = c.cornerStyle !== 'square';

  // Frame layout
  const rawFrameText = c.frame === 'scanme' ? 'SCAN ME' : c.frame === 'custom' ? (c.frameText || '').trim().slice(0, 24) : '';
  const frameText = rawFrameText.toUpperCase() || (c.frame === 'custom' && rawFrameText === '' ? 'SCAN ME' : '');
  const framed = c.frame !== 'none' && c.frame !== undefined;
  const showFrame = framed;
  const label = showFrame ? (frameText || 'SCAN ME') : '';

  const qrS = n * C;
  const q = QUIET * C;
  const bw = showFrame ? Math.round(1.1 * C) : 0;
  const pad = showFrame ? Math.round(3 * C) : 0;
  const labelH = showFrame ? Math.round(7 * C) : 0;
  const W = qrS + 2 * q + 2 * bw + 2 * pad;
  const H = W + labelH;
  const ox = pad + bw + q;

  const isFinder = (r, col) =>
    (r < 7 && col < 7) || (r < 7 && col >= n - 7) || (r >= n - 7 && col < 7);

  // Detect alignment patterns (5×5: dark border ring, light ring, dark center).
  // These are functional patterns — like finders they must keep their exact
  // geometry, so they are always drawn square regardless of the dot pattern.
  const alignmentCells = new Set();
  for (let ar = 0; ar + 4 < n; ar++) {
    for (let ac = 0; ac + 4 < n; ac++) {
      if (!qr.isDark(ar + 2, ac + 2)) continue; // center dark
      let ok = true;
      for (let i = 0; i < 5 && ok; i++) {
        if (!qr.isDark(ar, ac + i) || !qr.isDark(ar + 4, ac + i) ||
            !qr.isDark(ar + i, ac) || !qr.isDark(ar + i, ac + 4)) ok = false;
      }
      if (ok) {
        for (let dr = 1; dr <= 3 && ok; dr++) {
          for (let dc = 1; dc <= 3; dc++) {
            if (!(dr === 2 && dc === 2) && qr.isDark(ar + dr, ac + dc)) { ok = false; break; }
          }
        }
      }
      if (ok) {
        for (let dr = 0; dr < 5; dr++) {
          for (let dc = 0; dc < 5; dc++) alignmentCells.add((ar + dr) + ',' + (ac + dc));
        }
      }
    }
  }
  const darkAt = (r, col) => {
    if (r < 0 || col < 0 || r >= n || col >= n) return false;
    if (useCustomFinder && isFinder(r, col)) return false;
    return qr.isDark(r, col);
  };

  /* --- data modules --- */
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (!qr.isDark(r, col)) continue;
      const inFinder = isFinder(r, col);
      if (useCustomFinder && inFinder) continue;
      // Finder patterns and alignment patterns must always stay geometrically
      // intact — dots/rounding must not destroy their scan-critical structure.
      const forceSquare = inFinder || (c.pattern === 'dots' && alignmentCells.has(r + ',' + col));
      const x = ox + col * C;
      const y = ox + r * C;
      if (c.pattern === 'square' || forceSquare) {
        d += 'M' + x + ',' + y + 'h' + C + 'v' + C + 'h' + (-C) + 'Z';
      } else if (c.pattern === 'rounded') {
        const up = darkAt(r - 1, col), dn = darkAt(r + 1, col), lf = darkAt(r, col - 1), rt = darkAt(r, col + 1);
        const R = C / 2;
        const tl = (!up && !lf) ? R : 0;
        const tr = (!up && !rt) ? R : 0;
        const br = (!dn && !rt) ? R : 0;
        const bl = (!dn && !lf) ? R : 0;
        d += modulePath(x, y, C, tl, tr, br, bl);
      } else { // dots — full-size circles (touching) so connectivity is preserved for scanners
        const rad = C / 2;
        const cx = x + C / 2, cy = y + C / 2;
        d += 'M' + (cx - rad) + ',' + cy +
          'a' + rad + ',' + rad + ' 0 1 0 ' + (2 * rad) + ',0' +
          'a' + rad + ',' + rad + ' 0 1 0 ' + (-2 * rad) + ',0Z';
      }
    }
  }

  /* --- finder patterns --- */
  let finder = '';
  if (useCustomFinder) {
    const origins = [[0, 0], [0, n - 7], [n - 7, 0]];
    for (const [fr, fc] of origins) {
      const x = ox + fc * C;
      const y = ox + fr * C;
      if (c.cornerStyle === 'rounded') {
        finder +=
          '<path d="' + roundedRectPath(x, y, 7 * C, 7 * C, 2.4 * C) + roundedRectPath(x + C, y + C, 5 * C, 5 * C, 1.4 * C) + '" fill-rule="evenodd" fill="' + fg + '"/>' +
          '<path d="' + roundedRectPath(x + 2 * C, y + 2 * C, 3 * C, 3 * C, 0.4 * C) + '" fill="' + fg + '"/>';
      } else { // dot
        const cx = x + 3.5 * C, cy = y + 3.5 * C;
        finder +=
          '<circle cx="' + cx + '" cy="' + cy + '" r="' + 3.5 * C + '" fill="' + fg + '"/>' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="' + 2.5 * C + '" fill="' + bg + '"/>' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="' + 1.5 * C + '" fill="' + fg + '"/>';
      }
    }
  }

  /* --- logo --- */
  let logo = '';
  if (c.logo) {
    const lw = qrS * 0.22;
    const bgPad = 0.9 * C;
    const lb = lw + 2 * bgPad;
    const lx = ox + (qrS - lb) / 2;
    logo =
      '<rect x="' + lx + '" y="' + lx + '" width="' + lb + '" height="' + lb + '" rx="' + (lb * 0.22) + '" fill="' + bg + '"/>' +
      '<clipPath id="qs-logo-clip"><rect x="' + (lx + bgPad) + '" y="' + (lx + bgPad) + '" width="' + lw + '" height="' + lw + '" rx="' + (lw * 0.14) + '"/></clipPath>' +
      '<image href="' + escXml(c.logo) + '" x="' + (lx + bgPad) + '" y="' + (lx + bgPad) + '" width="' + lw + '" height="' + lw + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#qs-logo-clip)"/>';
  }

  /* --- frame chrome --- */
  let chrome = '';
  if (showFrame) {
    chrome =
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + (4 * C) + '" fill="' + bg + '"/>' +
      '<rect x="' + (pad + bw / 2) + '" y="' + (pad + bw / 2) + '" width="' + (W - 2 * pad - bw) + '" height="' + (H - 2 * pad - bw - labelH) + '" rx="' + (2.6 * C) + '" fill="none" stroke="' + fg + '" stroke-width="' + bw + '"/>';
  } else {
    chrome = '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + bg + '"/>';
  }

  /* --- frame label --- */
  let labelSvg = '';
  if (showFrame && label) {
    const labelY = ox + qrS + q + bw + labelH / 2;
    const fs = Math.min(3.6 * C, (W * 0.72) / Math.max(label.length, 1) / 0.62);
    labelSvg = '<text x="' + (W / 2) + '" y="' + (labelY + fs * 0.35) + '" text-anchor="middle" ' +
      'font-family="Arial, Helvetica, sans-serif" font-weight="700" letter-spacing="' + (fs * 0.12).toFixed(1) + '" ' +
      'font-size="' + fs.toFixed(1) + '" fill="' + fg + '">' + escXml(label) + '</text>';
  }

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" shape-rendering="geometricPrecision">' +
    chrome +
    '<path d="' + d + '" fill="' + fg + '"/>' +
    finder +
    logo +
    labelSvg +
    '</svg>';

  return { svg, w: W, h: H };
}

function renderQr(payload) {
  const { svg, w, h } = buildQrSvg(payload);
  state.svgString = svg;
  state.svgW = w;
  state.svgH = h;
  state.payload = payload;

  const output = $('#qrOutput');
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const svgEl = doc.documentElement;
  output.replaceChildren(document.importNode(svgEl, true));
  updatePreviewVisibility();

  const caption = $('#qrCaption');
  caption.textContent = truncate(payload.replace(/\s+/g, ' ').trim(), 80);
  caption.title = payload;
  caption.hidden = false;
}

function updatePreviewVisibility() {
  $('#qrPlaceholder').hidden = state.hasQR;
  $('#qrOutput').hidden = !state.hasQR || !state.svgString;
}

function setDownloadsEnabled(enabled) {
  $('#downloadPngBtn').disabled = !enabled;
  $('#downloadSvgBtn').disabled = !enabled;
}

/* ============================================================
   10. Customize controls
   ============================================================ */
let renderTimer = null;
function scheduleRerender() {
  if (!state.hasQR || !state.payload) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    try { renderQr(state.payload); } catch (e) { /* payload unchanged; keep last good render */ }
  }, 90);
}

function saveCustom() {
  const { logo, ...persistable } = state.custom;
  store.set(KEYS.custom, persistable);
}

function updateContrastWarning() {
  const lum = (hex) => {
    const v = [1, 3, 5].map((i) => {
      let x = parseInt(hex.slice(i, i + 2), 16) / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const l1 = lum(safeHex(state.custom.fg, '#2563EB'));
  const l2 = lum(safeHex(state.custom.bg, '#FFFFFF'));
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const warn = $('#contrastWarn');
  if (ratio < 3) {
    warn.textContent = 'Low contrast between the foreground and background colors may make this QR code hard to scan.';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

function syncLogoUi() {
  const has = !!state.custom.logo;
  $('#logoPreviewWrap').hidden = !has;
  $('#logoWarn').hidden = !has;
  if (has) $('#logoPreviewImg').src = state.custom.logo;
}

function setCustom(part) {
  Object.assign(state.custom, part);
  saveCustom();
  updateContrastWarning();
  scheduleRerender();
}

function bindColorPair(colorInput, hexInput, key) {
  colorInput.addEventListener('input', () => {
    hexInput.value = colorInput.value.toUpperCase();
    setCustom({ [key]: colorInput.value.toUpperCase() });
  });
  hexInput.addEventListener('input', () => {
    const v = hexInput.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      colorInput.value = v;
      setCustom({ [key]: v.toUpperCase() });
    }
  });
  hexInput.addEventListener('change', () => {
    hexInput.value = safeHex(hexInput.value.trim(), state.custom[key]).toUpperCase();
  });
}

function bindSeg(containerId, attr, key) {
  const seg = $('#' + containerId);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-' + attr + ']');
    if (!btn) return;
    $$('.seg-btn', seg).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    setCustom({ [key]: btn.dataset[attr] });
  });
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const btn = e.target.closest('[data-' + attr + ']');
    if (btn) { e.preventDefault(); btn.click(); }
  });
}

function reflectCustomUI() {
  const c = state.custom;
  $('#fgColor').value = safeHex(c.fg, '#2563EB');
  $('#fgHex').value = safeHex(c.fg, '#2563EB').toUpperCase();
  $('#bgColor').value = safeHex(c.bg, '#FFFFFF');
  $('#bgHex').value = safeHex(c.bg, '#FFFFFF').toUpperCase();
  $$('#patternSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pattern === c.pattern)));
  $$('#cornerSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.corner === c.cornerStyle)));
  $$('#frameSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.frame === c.frame)));
  const sizeIdx = Math.max(0, SIZES.indexOf(c.size));
  $('#sizeRange').value = String(sizeIdx);
  $('#sizeOut').textContent = SIZES[sizeIdx] + ' px';
  $('#frameTextWrap').hidden = c.frame !== 'custom';
  $('#frameTextInput').value = c.frameText;
  syncLogoUi();
  updateContrastWarning();
}

function onReset() {
  state.custom = { ...DEFAULT_CUSTOM };
  saveCustom();
  reflectCustomUI();
  scheduleRerender();
  toast('QR settings reset to defaults', 'success');
}

function initCustomize() {
  bindColorPair($('#fgColor'), $('#fgHex'), 'fg');
  bindColorPair($('#bgColor'), $('#bgHex'), 'bg');
  bindSeg('patternSeg', 'pattern', 'pattern');
  bindSeg('cornerSeg', 'corner', 'cornerStyle');
  bindSeg('frameSeg', 'frame', 'frame');
  // Show the custom-text input only for the Custom frame option
  $('#frameSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-frame]');
    if (btn) $('#frameTextWrap').hidden = btn.dataset.frame !== 'custom';
  });

  $('#sizeRange').addEventListener('input', (e) => {
    const size = SIZES[Number(e.target.value)];
    $('#sizeOut').textContent = size + ' px';
    setCustom({ size });
  });

  $('#frameTextInput').addEventListener('input', (e) => setCustom({ frameText: e.target.value }));

  $('#logoBtn').addEventListener('click', () => $('#logoInput').click());
  $('#logoInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      toast('Unsupported logo format. Use PNG, JPG or WEBP.', 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast('Logo is too large. Maximum size is 2 MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.custom.logo = String(reader.result);
      saveCustom();
      syncLogoUi();
      scheduleRerender();
      toast('Logo added', 'success');
    };
    reader.onerror = () => toast('Could not read that file. Please try another.', 'error');
    reader.readAsDataURL(file);
  });
  $('#logoRemoveBtn').addEventListener('click', () => {
    state.custom.logo = null;
    $('#logoPreviewImg').removeAttribute('src');
    saveCustom();
    syncLogoUi();
    scheduleRerender();
    toast('Logo removed', 'success');
  });

  $('#resetBtn').addEventListener('click', onReset);
}

/* ============================================================
   11. Downloads (PNG + SVG)
   ============================================================ */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function rasterizeSvg(svgString, outW, outH) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    const finalize = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, outW, outH);
        cleanup();
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
    img.onload = () => {
      // img.decode() guarantees the SVG is fully rasterized before drawing.
      if (img.decode) {
        img.decode().then(finalize, finalize);
      } else {
        finalize();
      }
    };
    img.onerror = () => { cleanup(); reject(new Error('SVG rasterize failed')); };
    img.src = url;
  });
}

async function onDownloadPng() {
  if (!state.svgString) return;
  try {
    const scale = state.svgH / state.svgW;
    const outH = Math.round(state.custom.size * scale);
    const blob = await rasterizeSvg(state.svgString, state.custom.size, outH);
    downloadBlob(blob, 'qr-studio-' + TYPES[state.currentType].file + '.png');
    toast('PNG downloaded', 'success');
  } catch (e) {
    toast('Download failed. Please try again.', 'error');
  }
}

function onDownloadSvg() {
  if (!state.svgString) return;
  try {
    const scale = state.svgH / state.svgW;
    const size = state.custom.size;
    const outH = Math.round(size * scale);
    const withSize = state.svgString.replace(
      /(width="\d+" height="\d+")/,
      'width="' + size + '" height="' + outH + '"'
    );
    downloadBlob(new Blob([withSize], { type: 'image/svg+xml;charset=utf-8' }),
      'qr-studio-' + TYPES[state.currentType].file + '.svg');
    toast('SVG downloaded', 'success');
  } catch (e) {
    toast('Download failed. Please try again.', 'error');
  }
}

function initDownloads() {
  $('#downloadPngBtn').addEventListener('click', onDownloadPng);
  $('#downloadSvgBtn').addEventListener('click', onDownloadSvg);
}

/* ============================================================
   11b. Scan mode (QR / Barcode) + barcode decode engine
   ============================================================ */
const SCAN_MODE_TEXT = {
  qr: {
    heading: 'Scan QR Code',
    sub: 'Upload an image or use your camera to scan.',
    uploadTitle: 'Upload QR Image',
    cameraTitle: 'Camera Scanner',
    cameraSub: 'Point your camera at a QR code to scan it live.',
    cameraIdleHint: 'Press \u201CStart Camera\u201D and point it at a QR code',
    dropzoneSub: 'PNG, JPG, JPEG or WEBP',
    decodeBtn: 'Decode'
  },
  barcode: {
    heading: 'Barcode Scanner',
    sub: 'Scan a barcode using your camera or upload a barcode image.',
    uploadTitle: 'Upload Barcode Image',
    cameraTitle: 'Barcode Scanner',
    cameraSub: 'Point your camera at a barcode to scan it live.',
    cameraIdleHint: 'Press \u201CStart Camera\u201D and point it at a barcode',
    dropzoneSub: 'EAN, UPC, Code 128/39, ITF, Data Matrix & more',
    decodeBtn: 'Decode Barcode'
  }
};

// 1D + 2D formats the vendored ZXing build genuinely decodes. Formats are kept
// only if the library actually exposes them — no fake support. Computed lazily
// so Node-based tests (no window) still load this module.
function barcodeFormatEnums() {
  if (!state._barcodeFormats) {
    const names = [
      'QR_CODE', // must stay in POSSIBLE_FORMATS or QR decoding regresses
      'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E',
      'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR',
      'DATA_MATRIX', 'PDF_417', 'AZTEC'
    ].filter((f) => Boolean(window.ZXing && window.ZXing.BarcodeFormat && window.ZXing.BarcodeFormat[f] !== undefined));
    state._barcodeFormats = names;
  }
  return state._barcodeFormats;
}

const BARCODE_LABELS = {
  EAN_13: 'EAN-13', EAN_8: 'EAN-8', UPC_A: 'UPC-A', UPC_E: 'UPC-E',
  CODE_128: 'Code 128', CODE_39: 'Code 39', CODE_93: 'Code 93',
  ITF: 'ITF', CODABAR: 'Codabar',
  DATA_MATRIX: 'Data Matrix', PDF_417: 'PDF417', AZTEC: 'Aztec',
  QR_CODE: 'QR Code'
};

function barcodeFormatName(fmt) {
  if (fmt === undefined || fmt === null) return null;
  if (typeof fmt === 'string') return BARCODE_LABELS[fmt] || fmt;
  const name = window.ZXing && window.ZXing.BarcodeFormat ? window.ZXing.BarcodeFormat[fmt] : null;
  return name ? (BARCODE_LABELS[name] || name) : null;
}

function zxingReader() {
  const ZX = window.ZXing;
  if (!ZX || !ZX.MultiFormatReader) return null;
  if (!state._zxReader) {
    const reader = new ZX.MultiFormatReader();
    const hints = new Map();
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, barcodeFormatEnums().map((f) => ZX.BarcodeFormat[f]));
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    state._zxReader = reader;
  }
  return state._zxReader;
}

// Decode a raw RGBA frame (ImageData.data) with ZXing.
// Returns { text, formatName } or null when nothing is found.
function zxingDecodeImageData(frameData, w, h) {
  const ZX = window.ZXing;
  const reader = zxingReader();
  if (!ZX || !reader) return null;
  const len = w * h;
  const gray = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    const j = i * 4;
    // Standard RGB luma weights (as used by ZXing's own RGB converters).
    gray[i] = (frameData[j] * 306 + frameData[j + 1] * 601 + frameData[j + 2] * 117) >> 10;
  }
  const binarizers = [ZX.HybridBinarizer, ZX.GlobalHistogramBinarizer];
  for (const B of binarizers) {
    try {
      const source = new ZX.RGBLuminanceSource(gray, w, h);
      const bitmap = new ZX.BinaryBitmap(new B(source));
      const res = reader.decodeWithState(bitmap);
      const text = res && res.getText ? res.getText() : '';
      if (text) return { text: String(text), formatName: barcodeFormatName(res.getBarcodeFormat()) };
    } catch (e) { /* nothing found with this binarizer — try the next */ }
    try { reader.reset(); } catch (e) { /* ignore */ }
  }
  return null;
}

function setScanMode(mode) {
  if (mode !== 'qr' && mode !== 'barcode') return;
  const changed = state.scanMode !== mode;
  state.scanMode = mode;
  try { localStorage.setItem(KEYS.scanMode, mode); } catch (e) { /* ignore */ }

  $$('#scanModeSeg .seg-btn').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.scanMode === mode))
  );

  const t = SCAN_MODE_TEXT[mode];
  $('#scanHeading').textContent = t.heading;
  $('#scanSub').textContent = t.sub;
  $('#uploadTitle').textContent = t.uploadTitle;
  $('#cameraTitle').textContent = t.cameraTitle;
  $('#cameraSub').textContent = t.cameraSub;
  $('#cameraIdleHint').textContent = t.cameraIdleHint;
  $('#decodeBtn').textContent = t.decodeBtn;
  const dzSub = $('#dropzoneSub');
  if (dzSub) dzSub.textContent = t.dropzoneSub;
  document.title = 'QR Studio — ' + t.heading;

  $('#cameraBox').dataset.mode = mode;

  if (changed) {
    if (state.uploadUrl || state.uploadFile) clearUploadImage(); // reset pending upload
    if (state.cameraStream) stopCamera();                        // never keep a stream across modes
    hideResult();
  }
  renderHistory(); // re-render so empty-state copy matches the active mode
}

function initScanMode() {
  $$('#scanModeSeg .seg-btn').forEach((b) =>
    b.addEventListener('click', () => setScanMode(b.dataset.scanMode))
  );
  $$('#historyFilter .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      state.historyFilter = b.dataset.historyFilter;
      renderHistory();
    })
  );
  let saved = 'qr';
  try { saved = localStorage.getItem(KEYS.scanMode) || 'qr'; } catch (e) { /* ignore */ }
  setScanMode(saved === 'barcode' ? 'barcode' : 'qr');
}

/* ============================================================
   12. Scan view — upload & decode
   ============================================================ */
function showUploadError(msg) {
  const e = $('#uploadError');
  e.textContent = msg;
  e.hidden = !msg;
}

function setUploadImage(file) {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    showUploadError('Unsupported file type. Please use PNG, JPG, JPEG or WEBP.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    showUploadError('Image is too large. Maximum size is 8 MB.');
    return;
  }
  showUploadError('');
  if (state.uploadUrl) URL.revokeObjectURL(state.uploadUrl);
  state.uploadUrl = URL.createObjectURL(file);
  state.uploadFile = file;

  const img = new Image();
  img.onload = () => {
    const preview = $('#uploadPreviewImg');
    preview.src = state.uploadUrl;
    $('#uploadPreviewWrap').hidden = false;
    $('#dropzone').hidden = true;
    $('#decodeBtn').disabled = false;
  };
  img.onerror = () => {
    showUploadError('Could not read this image. It may be corrupted — try a different file.');
  };
  img.src = state.uploadUrl;
}

function clearUploadImage() {
  if (state.uploadUrl) URL.revokeObjectURL(state.uploadUrl);
  state.uploadUrl = null;
  state.uploadFile = null;
  $('#uploadPreviewImg').removeAttribute('src');
  $('#uploadPreviewWrap').hidden = true;
  $('#dropzone').hidden = false;
  $('#decodeBtn').disabled = true;
  showUploadError('');
}

async function decodeImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(Object.assign(new Error('read failed'), { userMessage: 'Could not read this image file.' }));
    reader.readAsDataURL(file);
  });

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(Object.assign(new Error('decode failed'), { userMessage: 'Could not read this image. It may be corrupted — try a different file.' }));
    i.src = dataUrl;
  });

  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  if (state.scanMode === 'barcode') {
    return zxingDecodeImageData(data.data, w, h);
  }
  const code = window.jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

async function onDecode() {
  if (!state.uploadFile) return;
  if (!(await ensureEngine())) {
    showUploadError('QR engine failed to load. Check your connection and reload the page.');
    return;
  }
  if (state.scanMode === 'barcode' && !state.zxingLoaded) {
    showUploadError('Barcode engine failed to load. Check your connection and reload the page.');
    return;
  }
  const btn = $('#decodeBtn');
  btn.disabled = true;
  hideResult(); // never leave a stale previous result under a new decode
  const original = btn.textContent;
  btn.textContent = 'Decoding…';
  try {
    const result = await decodeImageFile(state.uploadFile);
    if (result) {
      handleScanSuccess(result);
    } else if (state.scanMode === 'barcode') {
      showUploadError('No barcode was detected in this image.');
    } else {
      showUploadError('No QR code was detected in this image.');
    }
  } catch (err) {
    showUploadError(err.userMessage || 'Could not read this image. Try a different file.');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function initUpload() {
  const dz = $('#dropzone');
  const input = $('#scanFileInput');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('dragover'); })
  );
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) setUploadImage(file);
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) setUploadImage(file);
    e.target.value = '';
  });

  $('#changeImageBtn').addEventListener('click', () => input.click());
  $('#decodeBtn').addEventListener('click', onDecode);
}

/* ============================================================
   13. Camera scanner — permissions, lifecycle, UI states

   Camera permission flow (only ever triggered by an explicit user
   gesture on "Start Camera" / "Try Again" / "Switch Camera"):

     1. mediaDevices / getUserMedia feature detection → unsupported state
     2. window.isSecureContext check → HTTPS-required state
     3. navigator.permissions.query({ name: 'camera' }) where supported
        (feature-detected — several mobile browsers don't implement it)
     4. getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
        with a constraint cascade for devices that reject the first try
     5. Typed DOMException mapping → separate, non-scary UI states

   The previous implementation mapped *any* NotAllowedError to "Camera
   access was denied … browser settings", which also fired when Chrome's
   transient user-activation check rejected the request (e.g. the page
   was reloaded/cached by the service worker and the tap no longer
   counted as a fresh gesture) — the permission was NOT actually
   persisted, so Android Settings correctly showed nothing. The states
   are now kept apart: only a browser-confirmed denied/block state shows
   the "blocked" help; a dismissed prompt or a stale-gesture retry just
   asks the user to tap Start Camera again.
   ============================================================ */

// Dev-only diagnostics. Silent unless ?debugcam=1 (or #debugcam) is set,
// and silent when "production" appears in the host (e.g. deployed builds).
function camDebug() {
  try {
    if (!state._camDebug) {
      const flagged = /(?:^|[?&#])debugcam(?:=1|=true)?(?:$|[&])/.test(location.search + '#' + location.hash);
      state._camDebug = flagged && !/production/i.test(location.hostname);
    }
    if (state._camDebug) console.log.apply(console, arguments);
  } catch (e) { /* never break scanning over logging */ }
}

const CAMERA_COPY = {
  unsupported: 'This browser doesn\u2019t support camera scanning. Please use a current version of Chrome, Edge, Firefox or Safari (on iPhone, Safari or Chrome).',
  insecure: 'Camera scanning requires a secure connection (HTTPS). Please open QR Studio using HTTPS.',
  denied: 'Camera permission is blocked. Allow camera access in your browser\u2019s site permissions, then try again.',
  dismissed: 'The camera prompt was dismissed. Tap \u201CStart Camera\u201D again and choose \u201CAllow\u201D to scan.',
  inUse: 'Your camera is already in use by another app or tab. Close it and try again.',
  unavailable: 'No usable camera was found on this device.',
  overconstrained: 'This device\u2019s camera doesn\u2019t support the requested settings. Trying simpler settings…',
  security: 'Camera access is blocked by your browser\u2019s security policy or an embedded-frame setting.',
  aborted: 'Camera startup was interrupted. Please try again.',
  generic: 'Could not start the camera. Please try again.'
};

// Browser-specific help, shown ONLY when permission is confirmed denied.
// Never claims the site appears under the phone OS Settings — websites
// don't, except when installed as a PWA on some Android devices.
function cameraBlockedHelpHtml() {
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const firefox = /Firefox|FxiOS/i.test(ua);
  let lines;
  if (iOS) {
    lines = firefox
      ? ['Tap the permission icon near the address bar.', 'Open Site settings and allow Camera.', 'Reload the page.']
      : ['Open the aA menu (or lock icon) in the address bar.', 'Tap Website Settings and set Camera to Allow.', 'Reload the page.'];
  } else if (firefox) {
    lines = ['Tap the shield/lock icon near the address bar.', 'Open site permissions and clear the Camera block.', 'Reload the page.'];
  } else {
    // Android Chrome / Edge / Samsung Internet and desktop Chromium browsers.
    lines = [
      'Tap the lock or site settings icon near the address bar.',
      'Tap Permissions (in Edge: Camera under Site permissions).',
      'Allow Camera, then reload the page.'
    ];
  }
  const ol = el('ol', 'cam-help-steps');
  lines.forEach((l) => ol.appendChild(el('li', null, l)));
  const wrap = el('div', 'cam-help');
  wrap.appendChild(el('p', 'cam-help-title', 'How to allow the camera:'));
  wrap.appendChild(ol);
  return wrap;
}

function queryCameraPermission() {
  // Feature-detected: returns 'granted' | 'prompt' | 'denied' | null (unsupported).
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      return navigator.permissions.query({ name: 'camera' })
        .then((st) => { camDebug('[cam] permissions.query →', st && st.state); return st ? st.state : null; })
        .catch(() => null);
    }
  } catch (e) { /* some engines throw on the 'camera' name */ }
  return Promise.resolve(null);
}

function isCamSupported() {
  return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
}

function isCamSecure() {
  return !!window.isSecureContext;
}

// Pre-flight checks shown BEFORE the permission prompt. Returns a message
// string when camera cannot start, or null when we may proceed.
function cameraPreflight() {
  if (!isCamSupported()) return CAMERA_COPY.unsupported;
  if (!isCamSecure()) return CAMERA_COPY.insecure;
  return null;
}

// Run getUserMedia with a forgiving constraint cascade. facingMode uses
// { ideal } so it never hard-fails on desktops or single-camera devices.
// The constraint ladder lives in tryCamera — see below.
function gmdConstraints(stage) {
  if (stage === 0) {
    return {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };
  }
  if (stage === 1) {
    return { video: { facingMode: { ideal: 'environment' } }, audio: false };
  }
  // stage 2 — plain camera request, works everywhere.
  return { video: true, audio: false };
}

async function requestCameraStream(preferred) {
  // preferred: 'environment' | 'user' | null (any). Returns a MediaStream.
  const stages = [
    gmdConstraints(0),
    gmdConstraints(1),
    gmdConstraints(2)
  ];
  let lastErr = null;
  for (let i = 0; i < stages.length; i++) {
    let c = stages[i];
    if (preferred === 'user' && c.video && c.video.facingMode) {
      c = Object.assign({}, c, { video: Object.assign({}, c.video, { facingMode: { ideal: 'user' } }) });
    }
    if (preferred === null && c.video && c.video.facingMode) {
      c = Object.assign({}, c, { video: Object.assign({}, c.video, { facingMode: undefined }) });
    }
    try {
      camDebug('[cam] gUM try', i, c);
      const stream = await navigator.mediaDevices.getUserMedia(c);
      camDebug('[cam] gUM ok on stage', i);
      return stream;
    } catch (err) {
      lastErr = err;
      camDebug('[cam] gUM stage', i, 'failed:', err && err.name, err && err.message);
      // Only constraint problems are worth retrying with simpler constraints.
      // Permission/security failures must surface immediately.
      const name = err && err.name;
      const retryable = name === 'OverconstrainedError' ||
        name === 'NotFoundError' ||          // some Android builds report 'no camera' for unknown constraints
        name === 'NotReadableError' ||       // transient: another tab is still releasing the camera
        name === 'AbortError';               // device was busy switching cameras
      if (!retryable || i === stages.length - 1) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr || new DOMException('Camera unavailable', 'NotFoundError');
}

async function listCameras() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'videoinput');
  } catch (e) {
    return [];
  }
}

function describeCameraError(err) {
  // Returns { key, message } — key selects the UI state.
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      // Distinguish a genuinely persisted block from a dismissed prompt is
      // not possible from the DOMException alone; the caller consults the
      // Permissions API (where available) before showing 'denied'.
      return { key: 'denied-ish', message: CAMERA_COPY.dismissed };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { key: 'unavailable', message: CAMERA_COPY.unavailable };
    case 'NotReadableError':
    case 'TrackStartError':
      return { key: 'inUse', message: CAMERA_COPY.inUse };
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { key: 'overconstrained', message: CAMERA_COPY.overconstrained };
    case 'SecurityError':
      return { key: 'security', message: CAMERA_COPY.security };
    case 'AbortError':
      return { key: 'aborted', message: CAMERA_COPY.aborted };
    default:
      return { key: 'generic', message: CAMERA_COPY.generic };
  }
}

/* ---------- scanner UI states ---------- */

// Neutral, non-scary help panel for a confirmed block.
function showCameraBlocked() {
  showCameraError(CAMERA_COPY.denied);
  const box = $('#cameraError');
  box.classList.add('has-help');
  const help = cameraBlockedHelpHtml();
  help.id = 'cameraBlockedHelp';
  box.appendChild(help);
  const actions = $('#cameraBlockedActions');
  if (actions) actions.hidden = false;
  const start = $('#startCamBtn');
  if (start) start.textContent = 'Try Again';
}

function resetCameraUi() {
  showCameraError('');
  const actions = $('#cameraBlockedActions');
  if (actions) actions.hidden = true;
  const start = $('#startCamBtn');
  if (start) start.textContent = 'Start Camera';
}

function showCameraError(msg) {
  const e = $('#cameraError');
  e.classList.remove('has-help');
  const help = $('#cameraBlockedHelp');
  if (help) help.remove();
  e.textContent = msg;
  e.hidden = !msg;
}

function setCameraUi(active) {
  $('#cameraBox').classList.toggle('active', active);
  $('#cameraIdle').hidden = active;
  $('#scanFrame').hidden = !active;
  $('#startCamBtn').disabled = active;
  $('#stopCamBtn').disabled = !active;
  const status = $('#cameraActiveNote');
  if (status) status.hidden = !active;
  const statusEl = $('#scanStatus');
  if (statusEl) {
    statusEl.hidden = !active;
    statusEl.classList.remove('found');
    if (active) {
      statusEl.classList.add('scanning');
      $('.scan-status-text', statusEl).textContent =
        'Scanning for ' + (state.scanMode === 'barcode' ? 'barcodes…' : 'QR codes…');
    } else {
      statusEl.classList.remove('scanning');
    }
  }
}

// Stop any previous stream/tracker BEFORE opening a new one — prevents
// duplicate active streams and camera-in-use errors when restarting fast.
function releaseCameraStream() {
  if (state.cameraTimer) { clearInterval(state.cameraTimer); state.cameraTimer = null; }
  if (state.cameraStream) {
    try {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      camDebug('[cam] previous stream released');
    } catch (e) { /* already stopped */ }
    state.cameraStream = null;
  }
  const video = $('#cameraVideo');
  if (video) video.srcObject = null;
}

function stopCamera(opts) {
  state.camGeneration++;            // invalidate any in-flight getUserMedia start
  releaseCameraStream();
  setCameraUi(false);
  resetCameraUi();
  camDebug('[cam] scanner cleanup');
  void opts;
}

async function startCamera(preferredFacing) {
  if (state.cameraStarting) return; // guard against double-taps creating two streams
  state.cameraStarting = true;
  // Generation token: any stopCamera() while getUserMedia is pending
  // invalidates this start, so its stream is discarded instead of leaking
  // (a leaked stream keeps the camera locked → "camera in use" later).
  const gen = ++state.camGeneration;
  const invalidated = () => gen !== state.camGeneration;
  const startBtn = $('#startCamBtn');
  try {
    resetCameraUi();

    // --- 1. Pre-flight: support & secure context (never touch the camera) ---
    const preflight = cameraPreflight();
    if (preflight) {
      showCameraError(preflight);
      return;
    }

    // --- 2. Barcode engine readiness (barcode mode only) ---
    if (state.scanMode === 'barcode') {
      const ok = await state.zxingReady;
      if (!state.zxingLoaded) {
        showCameraError('Barcode engine failed to load. Check your connection and reload the page.');
        return;
      }
      void ok;
    }

    // QR mode: the QR engine is bundled locally; no need to block on it here.

    // --- 3. Permission state (informational; getUserMedia is the source of truth) ---
    const permState = await queryCameraPermission();
    state.camPermState = permState;
    if (invalidated()) return;

    setCameraUi(true); // spinner/idle note while the prompt may be showing

    // --- 4. Acquire the stream (must be inside the click-gesture task) ---
    const stream = await requestCameraStream(preferredFacing === 'user' ? 'user' : 'environment');
    if (invalidated()) {
      // Stop was pressed (or the view changed) while the prompt was open.
      stream.getTracks().forEach((t) => t.stop());
      camDebug('[cam] start invalidated → stream discarded');
      return;
    }

    releaseCameraStream();       // safety: never two live streams
    state.cameraStream = stream;
    stream.getVideoTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        // User revoked camera from the browser UI mid-scan (Chrome fires this).
        if (state.cameraStream === stream) stopCamera();
      });
    });

    const video = $('#cameraVideo');
    video.srcObject = stream;
    // Do NOT await play(): on some devices it stays pending indefinitely
    // (paused stream, iOS low-power mode, fake/headless devices) and would
    // block startup. The scan loop below polls video.readyState instead.
    try { video.play().catch(() => { /* muted autoplay */ }); } catch (e) { /* ignore */ }

    if (state.camFacing === 'user' && !state._camFacingNoteShown) {
      toast('Using front camera', 'info');
    }

    // Device enumeration is only meaningful after permission was granted.
    const cams = await listCameras();
    state.cameras = cams;
    camDebug('[cam] devices:', cams.map((d) => d.label || d.deviceId).join(' | ') || '(labels hidden until granted)');
    const switchBtn = $('#switchCamBtn');
    if (switchBtn) switchBtn.hidden = cams.length < 2;

    startBtn.textContent = 'Stop Camera';
    startBtn.disabled = true;
    $('#stopCamBtn').disabled = false;

    camDebug('[cam] scanner initialized (' + state.scanMode + ' mode)');
    beginScanLoop(video);
  } catch (err) {
    releaseCameraStream();
    if (!invalidated()) {
      setCameraUi(false);
      await handleCameraStartError(err);
    }
  } finally {
    // Always clear the in-flight guard — even when a stop invalidated this
    // start — otherwise the next "Start Camera" tap would be swallowed.
    state.cameraStarting = false;
  }
}

// Decide between a real "denied" block and a dismissed/stale-gesture prompt.
async function handleCameraStartError(err) {
  const desc = describeCameraError(err);
  camDebug('[cam] getUserMedia failed:', err && err.name, err && err.message);
  if (desc.key !== 'denied-ish') {
    showCameraError(desc.message);
    return;
  }
  // NotAllowedError — ask the browser (where supported) who is to blame.
  const state2 = await queryCameraPermission();
  state.camPermState = state2;
  if (state2 === 'denied') {
    showCameraBlocked();       // confirmed block → instructions + Try Again
  } else if (state2 === 'granted') {
    // Odd but seen in the wild: permission says granted yet gUM refused —
    // often a stale user-activation after a service-worker page restore.
    // A fresh tap fixes it; do NOT claim the user denied anything.
    showCameraError(CAMERA_COPY.dismissed);
  } else {
    // 'prompt' (or Permissions API unsupported): most likely the prompt was
    // dismissed, or the gesture had gone stale. Never say "denied".
    showCameraError(CAMERA_COPY.dismissed);
  }
}

function beginScanLoop(video) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  state.cameraTimer = setInterval(() => {
    if (!state.cameraStream || video.readyState < 2) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, 640 / vw);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    if (state.scanMode === 'barcode') {
      const hit = zxingDecodeImageData(frame.data, w, h);
      if (hit && hit.text) {
        stopCamera();
        if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* ignore */ } }
        handleScanSuccess(hit);
      }
      return;
    }
    const code = window.jsQR(frame.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      stopCamera();
      if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* ignore */ } }
      handleScanSuccess(code.data);
    }
  }, 180);
}

async function onSwitchCamera() {
  camDebug('[cam] switch camera requested');
  await startCamera(state.camFacing === 'user' ? 'environment' : 'user');
}

function initCamera() {
  $('#startCamBtn').addEventListener('click', () => startCamera());
  $('#stopCamBtn').addEventListener('click', () => stopCamera());
  const switchBtn = $('#switchCamBtn');
  if (switchBtn) switchBtn.addEventListener('click', onSwitchCamera);
  const blockedRetry = $('#startCamBtn2');
  if (blockedRetry) blockedRetry.addEventListener('click', () => { resetCameraUi(); startCamera(); });
  const blockedImage = $('#imageFromBlockBtn');
  if (blockedImage) blockedImage.addEventListener('click', () => { stopCamera(); resetCameraUi(); $('#scanFileInput').click(); });

  // Lifecycle: stop tracks when leaving the page or hiding the tab.
  // On return the camera is simply started fresh with "Start Camera"
  // (permission is already granted, so no prompt appears).
  window.addEventListener('pagehide', () => releaseCameraStream());
  window.addEventListener('beforeunload', () => releaseCameraStream());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.cameraStream) {
      camDebug('[cam] tab hidden → stopping camera');
      releaseCameraStream();
      setCameraUi(false);
    }
    // NOTE: no action when becoming visible — starting a stream here would
    // race the permission prompt and can leak the previous one.
  });
}

/* ============================================================
   14. Scan results — classification, rendering, actions
   ============================================================ */
function hideResult() {
  $('#resultCard').hidden = true;
  const badge = $('#resultBadge');
  badge.hidden = true;
  $('#resultBody').replaceChildren();
  state.lastResult = null;
}

function classifyBarcode(hit) {
  const raw = String(hit.text || '').trim();
  if (!raw) return null;
  // Only a genuinely valid http/https value counts as a URL (never a bare
  // product number, never a javascript: link). URL barcodes keep their
  // barcode metadata so the format badge/details still render.
  const http = safeHttpUrl(raw);
  const base = http
    ? { type: 'URL', label: 'URL', icon: 'i-link', openUrl: http }
    : { type: 'Barcode', label: 'Barcode', icon: 'i-barcode' };
  return Object.assign(base, { raw, isBarcode: true, barcodeFormat: hit.formatName || null });
}

const safeHttpUrl = (u) => {
  try {
    const url = new URL(u);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch (e) { return null; }
};

const WIFI_SECURITY = { WPA: 'WPA / WPA2 / WPA3', WEP: 'WEP', nopass: 'Open network' };
const wifiUnescape = (s) => String(s).replace(/\\([;,:\\"])/g, '$1');

function parseWifiPayload(s) {
  const out = {};
  s.replace(/^WIFI:/i, '').split(/(?<!\\);/).forEach((part) => {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).toUpperCase()] = wifiUnescape(part.slice(i + 1));
  });
  return out;
}

function parseVcard(s) {
  const details = [];
  const get = (re) => { const m = s.match(re); return m ? m[1].trim() : ''; };
  let name = get(/^(?:FN|fn)[^:]*:(.+)$/m);
  if (!name) {
    const n = get(/^N[^:]*:([^;\r\n]+);([^;\r\n]+)/m);
    if (n) name = (n.split(';').reverse().join(' ')).trim();
  }
  const lines = s.split(/\r?\n/);
  let tel = '', email = '', url = '', org = '';
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).toUpperCase();
    const val = line.slice(idx + 1).trim();
    if (!val) continue;
    if (key.startsWith('TEL') && !tel) tel = val;
    else if (key.startsWith('EMAIL') && !email) email = val;
    else if (key.startsWith('URL') && !url) url = val;
    else if (key.startsWith('ORG') && !org) org = val.replace(/\\,/g, ',').replace(/\\;/g, ';');
  }
  if (name) details.push(['Name', name]);
  if (org) details.push(['Organization', org]);
  if (tel) details.push(['Phone', tel]);
  if (email) details.push(['Email', email]);
  if (url) details.push(['Website', url]);
  return details;
}

function parseMecard(s) {
  const details = [];
  s.replace(/^MECARD:/i, '').split(/(?<!\\);/).forEach((part) => {
    const i = part.indexOf(':');
    if (i < 1) return;
    const key = part.slice(0, i).toUpperCase();
    let val = wifiUnescape(part.slice(i + 1));
    if (!val) return;
    if (key === 'N') {
      const bits = val.split(',');
      val = bits.length > 1 ? (bits[1] + ' ' + bits[0]).trim() : val;
      details.unshift(['Name', val]);
    } else if (key === 'TEL') details.push(['Phone', val]);
    else if (key === 'EMAIL') details.push(['Email', val]);
    else if (key === 'URL') details.push(['Website', val]);
  });
  return details;
}

function classify(raw) {
  const s = String(raw || '').trim();
  if (!s) return { type: 'Text', label: 'Text', icon: 'i-type', raw: '' };

  if (/^BEGIN:VCARD/i.test(s)) {
    return { type: 'vCard', label: 'vCard', icon: 'i-user', raw: s, details: parseVcard(s) };
  }
  if (/^WIFI:/i.test(s)) {
    const w = parseWifiPayload(s);
    const details = [];
    if (w.S) details.push(['Network (SSID)', w.S]);
    if (w.T) details.push(['Security', WIFI_SECURITY[w.T] || w.T]);
    if (w.P) details.push(['Password', w.P]);
    if (String(w.H || '').toLowerCase() === 'true') details.push(['Hidden', 'Yes']);
    return { type: 'Wi-Fi', label: 'Wi-Fi', icon: 'i-wifi', raw: s, details };
  }
  if (/^geo:/i.test(s)) {
    const m = s.slice(4).match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      const details = [['Latitude', m[1]], ['Longitude', m[2]]];
      const mapsUrl = (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)
        ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(m[1] + ',' + m[2])
        : null;
      return { type: 'Location', label: 'Location', icon: 'i-pin', raw: s, details, mapsUrl };
    }
  }
  if (/^tel:/i.test(s)) {
    return { type: 'Phone', label: 'Phone', icon: 'i-phone', raw: s, number: s.slice(4) };
  }
  if (/^mailto:/i.test(s)) {
    const details = [];
    try {
      const u = new URL(s);
      const to = decodeURIComponent(u.pathname || '');
      if (to) details.push(['To', to]);
      const subj = u.searchParams.get('subject');
      const body = u.searchParams.get('body');
      if (subj) details.push(['Subject', subj]);
      if (body) details.push(['Message', body]);
    } catch (e) { /* keep raw */ }
    return { type: 'Email', label: 'Email', icon: 'i-mail', raw: s, details };
  }
  if (/^(SMSTO|MMSTO|sms):/i.test(s)) {
    const body = s.replace(/^(SMSTO|MMSTO|sms):/i, '');
    const sep = body.indexOf(':');
    const number = sep >= 0 ? body.slice(0, sep) : body;
    const message = sep >= 0 ? body.slice(sep + 1) : '';
    const details = [['Number', number]];
    if (message) details.push(['Message', message]);
    return { type: 'SMS', label: 'SMS', icon: 'i-message', raw: s, number, details };
  }
  if (/^MECARD:/i.test(s)) {
    return { type: 'vCard', label: 'Contact', icon: 'i-user', raw: s, details: parseMecard(s) };
  }

  const http = safeHttpUrl(s);
  if (http) return { type: 'URL', label: 'URL', icon: 'i-link', raw: s, openUrl: http };

  if (!/\s/.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(s)) {
    return { type: 'URL', label: 'URL', icon: 'i-link', raw: s, openUrl: safeHttpUrl('https://' + s) };
  }

  return { type: 'Text', label: 'Text', icon: 'i-type', raw: s };
}

function navigateToHref(href) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildResultActions(res, actionsEl) {
  const addBtn = (label, iconId, primary, handler) => {
    const b = el('button', 'btn ' + (primary ? 'btn-primary' : 'btn-ghost'));
    b.type = 'button';
    b.appendChild(icon(iconId));
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', handler);
    actionsEl.appendChild(b);
  };

  if (res.type === 'URL' && res.openUrl) {
    addBtn('Open Link', 'i-external', true, () => {
      const win = window.open(res.openUrl, '_blank', 'noopener,noreferrer');
      if (!win) toast('Your browser blocked the pop-up. Allow pop-ups to open links.', 'info');
    });
  } else if (res.type === 'Phone') {
    addBtn('Call', 'i-phone', true, () => navigateToHref(res.raw));
  } else if (res.type === 'Email') {
    addBtn('Open Email', 'i-mail', true, () => navigateToHref(res.raw));
  } else if (res.type === 'SMS') {
    addBtn('Open Messages', 'i-message', true, () => navigateToHref('sms:' + (res.number || '')));
  } else if (res.type === 'Location' && res.mapsUrl) {
    addBtn('Open Maps', 'i-pin', true, () => {
      const win = window.open(res.mapsUrl, '_blank', 'noopener,noreferrer');
      if (!win) toast('Your browser blocked the pop-up. Allow pop-ups to open links.', 'info');
    });
  }

  addBtn('Copy', 'i-copy', false, () => copyWithToast(res.raw));
}

function renderResult(res) {
  const badge = $('#resultBadge');
  badge.replaceChildren(icon(res.icon), document.createTextNode(res.label));
  badge.hidden = false;

  const body = $('#resultBody');
  body.replaceChildren();

  const contentSection = el('div', 'result-section');
  contentSection.appendChild(el('p', 'result-label', res.isBarcode ? 'Barcode Number / Value' : 'Content'));
  contentSection.appendChild(el('p', 'result-content', res.raw));
  body.appendChild(contentSection);

  if (res.isBarcode && res.barcodeFormat) {
    const detailsSection = el('div', 'result-section');
    detailsSection.appendChild(el('p', 'result-label', 'Details'));
    const dl = el('dl', 'result-details');
    const row = el('div');
    row.appendChild(el('dt', null, 'Format'));
    row.appendChild(el('dd', null, res.barcodeFormat));
    dl.appendChild(row);
    detailsSection.appendChild(dl);
    body.appendChild(detailsSection);
  } else if (res.details && res.details.length) {
    const detailsSection = el('div', 'result-section');
    detailsSection.appendChild(el('p', 'result-label', 'Details'));
    const dl = el('dl', 'result-details');
    res.details.forEach(([k, v]) => {
      const row = el('div');
      row.appendChild(el('dt', null, k));
      row.appendChild(el('dd', null, v));
      dl.appendChild(row);
    });
    detailsSection.appendChild(dl);
    body.appendChild(detailsSection);
  }

  const actions = el('div', 'result-actions');
  buildResultActions(res, actions);
  body.appendChild(actions);

  $('#resultCard').hidden = false;
}

function handleScanSuccess(content) {
  // QR paths pass a string; barcode paths pass { text, formatName }.
  const res = (content && typeof content === 'object' && content.text !== undefined)
    ? (classifyBarcode(content) || classify(String(content.text)))
    : classify(content);
  state.lastResult = res;
  renderResult(res);
  addHistory({
    type: res.label,
    icon: res.icon,
    content: res.raw,
    kind: res.isBarcode ? 'barcode' : 'qr',
    format: res.isBarcode ? (res.barcodeFormat || 'Barcode') : res.label,
    ts: Date.now()
  });
  toast(res.isBarcode ? 'Barcode detected' : 'QR code detected', 'success');
  const status = $('#scanStatus');
  if (status && !status.hidden) {
    status.classList.remove('scanning');
    status.classList.add('found');
    $('.scan-status-text', status).textContent =
      (res.isBarcode ? 'Barcode' : 'QR code') + ' detected';
  }
  if (window.matchMedia('(max-width: 900px)').matches) {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    $('#resultCard').scrollIntoView({ behavior, block: 'start' });
  }
}

/* ============================================================
   15. Scan history
   ============================================================ */
function loadHistory() {
  const saved = store.get(KEYS.history, []);
  state.history = Array.isArray(saved) ? saved.slice(0, HISTORY_MAX) : [];
}

function saveHistory() {
  store.set(KEYS.history, state.history);
}

function formatHistoryTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderHistory() {
  const list = $('#historyList');
  list.replaceChildren();

  const filter = state.historyFilter || 'all';
  const hasBarcode = state.history.some((h) => h.kind === 'barcode');
  const filterSeg = $('#historyFilter');
  if (filterSeg) filterSeg.hidden = !hasBarcode;
  $$('#historyFilter .seg-btn').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.historyFilter === filter))
  );

  const visible = state.history.filter((h) => {
    if (filter === 'qr') return h.kind !== 'barcode';
    if (filter === 'barcode') return h.kind === 'barcode';
    return true;
  });

  const empty = $('#historyEmpty');
  if (!state.history.length) {
    empty.textContent = state.scanMode === 'barcode'
      ? 'No scans yet. Scanned barcodes will appear here.'
      : 'No scans yet. Scanned QR codes will appear here.';
    empty.hidden = false;
  } else if (!visible.length) {
    empty.textContent = filter === 'barcode'
      ? 'No barcode scans yet.'
      : 'No QR scans yet.';
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
  $('#clearHistoryBtn').hidden = state.history.length === 0;
  disarmClear();

  visible.forEach((h) => {
    const li = el('li');

    const iconWrap = el('span', 'history-icon');
    iconWrap.appendChild(icon(h.icon || 'i-qr'));
    li.appendChild(iconWrap);

    const body = el('div', 'history-body');
    body.appendChild(el('p', 'history-content', truncate(String(h.content || '').replace(/\s+/g, ' ').trim(), 90)));
    const meta = el('p', 'history-meta');
    const kindTag = el('span', 'history-type-tag' + (h.kind === 'barcode' ? ' barcode' : ''),
      h.kind === 'barcode' ? 'Barcode' : 'QR');
    meta.appendChild(kindTag);
    meta.appendChild(el('span', 'history-type', h.format || h.type || 'Text'));
    meta.appendChild(el('span', null, formatHistoryTime(h.ts)));
    body.appendChild(meta);
    li.appendChild(body);

    const actions = el('div', 'history-actions');

    const copyBtn = el('button', 'icon-btn');
    copyBtn.type = 'button';
    copyBtn.setAttribute('aria-label', 'Copy scan result');
    copyBtn.appendChild(icon('i-copy'));
    copyBtn.addEventListener('click', () => copyWithToast(String(h.content || '')));
    actions.appendChild(copyBtn);

    const delBtn = el('button', 'icon-btn');
    delBtn.type = 'button';
    delBtn.setAttribute('aria-label', 'Delete scan from history');
    delBtn.appendChild(icon('i-trash'));
    delBtn.addEventListener('click', () => {
      state.history = state.history.filter((x) => x.id !== h.id);
      saveHistory();
      renderHistory();
      toast('Scan removed', 'info');
    });
    actions.appendChild(delBtn);

    li.appendChild(actions);
    list.appendChild(li);
  });
}

function addHistory(entry) {
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  state.history.unshift({
    id,
    type: entry.type,
    icon: entry.icon,
    content: entry.content,
    kind: entry.kind || 'qr',
    format: entry.format || entry.type || 'Text',
    ts: entry.ts
  });
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  saveHistory();
  renderHistory();
}

function disarmClear() {
  if (state.clearArmedTimer) { clearTimeout(state.clearArmedTimer); state.clearArmedTimer = null; }
  const btn = $('#clearHistoryBtn');
  btn.textContent = 'Clear history';
  btn.classList.remove('armed');
}

function initHistory() {
  $('#clearHistoryBtn').addEventListener('click', () => {
    const btn = $('#clearHistoryBtn');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Tap again to clear';
      state.clearArmedTimer = setTimeout(disarmClear, 3000);
      return;
    }
    state.history = [];
    saveHistory();
    renderHistory();
    toast('Scan history cleared', 'info');
  });
  loadHistory();
  renderHistory();
}

/* ============================================================
   16. Init
   ============================================================ */
function init() {
  initTheme();
  initNav();

  // Restore customization (logo is never persisted)
  const savedCustom = store.get(KEYS.custom, {});
  const merged = { ...DEFAULT_CUSTOM, ...(savedCustom && typeof savedCustom === 'object' ? savedCustom : {}) };
  if (!['square', 'rounded', 'dots'].includes(merged.pattern)) merged.pattern = 'square';
  if (!['square', 'rounded', 'dot'].includes(merged.cornerStyle)) merged.cornerStyle = 'square';
  if (!['none', 'scanme', 'custom'].includes(merged.frame)) merged.frame = 'none';
  if (!SIZES.includes(merged.size)) merged.size = 512;
  if (typeof merged.frameText !== 'string') merged.frameText = '';
  merged.logo = null;
  state.custom = merged;

  renderForm(state.currentType);
  reflectCustomUI();
  initCustomize();
  initDownloads();
  initUpload();
  initCamera();
  initHistory();
  initScanMode();
  initGenMode();
  initBarcodeGen();

  $('#genForm').addEventListener('submit', onGenerate);
  $('#clearBtn').addEventListener('click', onClear);

  const savedType = store.get(KEYS.type, 'url');
  selectType(TYPES[savedType] ? savedType : 'url');
  const savedView = store.get(KEYS.view, 'generate');
  setView(savedView === 'scan' ? 'scan' : 'generate');

  initEngine();

  // pagehide/beforeunload camera cleanup is registered in initCamera().
  window.addEventListener('beforeunload', () => {
    if (state.uploadUrl) URL.revokeObjectURL(state.uploadUrl);
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

/* ============================================================
   12. Barcode generator (Generate view → Barcode mode)
   Real, machine-readable rendering via JsBarcode (local first,
   CDN fallback). Live preview, per-format validation, PNG/SVG export.
   ============================================================ */
const GEN_BC_TEXT = {
  heading: 'Barcode Generator',
  desc: 'Enter a value and create a real, scannable barcode.'
};

const BC_FORMATS = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'UPCE', 'ITF14', 'ITF', 'codabar'];

const bcFormatLabel = (f) => ({
  CODE128: 'CODE128', CODE39: 'CODE39', EAN13: 'EAN-13', EAN8: 'EAN-8',
  UPC: 'UPC-A', UPCE: 'UPC-E', ITF14: 'ITF-14', ITF: 'ITF', codabar: 'Codabar'
}[f] || f);

const BC_FORMAT_HINTS = {
  CODE128: 'Letters, digits and common ASCII symbols are supported.',
  CODE39: 'Uppercase A–Z, digits and the symbols - . $ / + % space.',
  EAN13: 'Exactly 12 digits (check digit added automatically) or 13 digits with a valid check digit.',
  EAN8: 'Exactly 7 digits (check digit added automatically) or 8 digits with a valid check digit.',
  UPC: 'Exactly 11 digits (check digit added automatically) or 12 digits with a valid check digit.',
  UPCE: '6–7 digits (check digit added automatically) or 8 digits with a valid UPC-E check digit.',
  ITF14: 'Exactly 13 digits (check digit added automatically) or 14 digits with a valid check digit.',
  ITF: 'An even number of digits (2–32).',
  codabar: 'Digits and - $ : / . + between start/stop letters A–D, e.g. A123456B.'
};

/* JsBarcode option state — synced to the UI inputs on load/reset. */
const bcOptions = {
  format: 'CODE128',
  width: 2,
  height: 80,
  fontSize: 18,
  margin: 10,
  linecolor: '#111111',
  background: '#FFFFFF',
  displayValue: true
};
const BC_DEFAULTS = Object.freeze(JSON.parse(JSON.stringify(bcOptions)));

let barcodeReady = null;   // cached loadScript promise (mirrors engineReady/zxingReady)
let barcodeSvg = null;     // last generated SVG string
let bcGenerated = false;   // has the user pressed Generate with a valid value?

function ensureBarcodeLib() {
  if (!barcodeReady) {
    barcodeReady = loadScript(LOCAL_LIBS.jsbarcode.concat(CDN.jsbarcode))
      .then(() => {
        if (typeof window.JsBarcode !== 'function') throw new Error('JsBarcode failed to load');
        return window.JsBarcode;
      })
      .catch((err) => { barcodeReady = null; throw err; });
  }
  return barcodeReady;
}

/* Mod-10 check digit (GS1 3/1 weighting) shared by EAN/UPC/ITF-14. */
function gs1CheckDigit(digits) {
  const d = String(digits);
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += Number(d[d.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

/* UPC-E body (number-system digit + 6 compressed digits) → 11-digit UPC-A body.
   Expansion table per GS1 (mirrors ZXing's UPCEReader, verified empirically). */
function upceToUpcaBody(v7) {
  const ns = v7[0];
  const d = v7.slice(1);           // the 6 compressed digits
  const last = d[5];
  let mid;
  if (last === '0' || last === '1' || last === '2') mid = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
  else if (last === '3') mid = d.slice(0, 3) + '10000' + d.slice(3, 5);
  else if (last === '4') mid = d.slice(0, 4) + '00000' + d.slice(4, 5);
  else mid = d.slice(0, 5) + '0000' + last;
  return ns + mid;                 // 11 digits
}

/* Per-format validators. Return null when valid, else a friendly message.
   Rules mirror the vendored JsBarcode encoders: short input gets the check
   digit added automatically, full-length input must carry a valid one. */
function bcValidate(format, raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return 'Please enter a barcode value.';
  const digits = /^[0-9]+$/;
  switch (format) {
    case 'CODE128':
      if (!/^[ -~]+$/.test(v)) return 'CODE128 supports only ASCII characters (no accents or emoji).';
      return null;
    case 'CODE39':
      if (!/^[0-9A-Z\-. $/+%]+$/.test(v)) return 'CODE39 supports only A–Z, digits, spaces and - . $ / + %.';
      return null;
    case 'EAN13':
      if (!digits.test(v) || (v.length !== 12 && v.length !== 13)) return 'EAN-13 requires a valid 12/13-digit value.';
      if (v.length === 13 && gs1CheckDigit(v.slice(0, 12)) !== v[12]) return 'Invalid EAN-13 check digit.';
      return null;
    case 'EAN8':
      if (!digits.test(v) || (v.length !== 7 && v.length !== 8)) return 'EAN-8 requires a valid 7/8-digit value.';
      if (v.length === 8 && gs1CheckDigit(v.slice(0, 7)) !== v[7]) return 'Invalid EAN-8 check digit.';
      return null;
    case 'UPC':
      if (!digits.test(v) || (v.length !== 11 && v.length !== 12)) return 'UPC-A requires a valid 11/12-digit value.';
      if (v.length === 12 && gs1CheckDigit(v.slice(0, 11)) !== v[11]) return 'Invalid UPC-A check digit.';
      return null;
    case 'UPCE': {
      if (!digits.test(v) || (v.length !== 6 && v.length !== 7 && v.length !== 8)) return 'UPC-E requires a valid 6–8-digit value.';
      if (v.length >= 7 && v[0] !== '0' && v[0] !== '1') return 'UPC-E number system must be 0 or 1.';
      if (v.length === 6 || v.length === 7) return null;   // check digit added automatically
      const expected = gs1CheckDigit(upceToUpcaBody(v.slice(0, 7)));
      if (v[7] !== expected) return 'Invalid UPC-E check digit.';
      return null;
    }
    case 'ITF14':
      if (!digits.test(v) || (v.length !== 13 && v.length !== 14)) return 'ITF-14 requires a valid 13/14-digit value.';
      if (v.length === 14 && gs1CheckDigit(v.slice(0, 13)) !== v[13]) return 'Invalid ITF-14 check digit.';
      return null;
    case 'ITF':
      if (!digits.test(v)) return 'ITF supports digits only.';
      if (v.length % 2 !== 0) return 'ITF requires an even number of digits.';
      if (v.length < 2 || v.length > 32) return 'ITF requires 2–32 digits (even length).';
      return null;
    case 'codabar':
      if (!/^[A-D][0-9\-$:.+/]+[A-D]$/.test(v)) return 'Codabar needs digits and - $ : / . + between start/stop letters A–D (e.g. A123456B).';
      return null;
  }
  return 'Unsupported barcode format.';
}

function showBcError(msg) {
  const errEl = $('#bcValue-err');
  if (msg) { errEl.textContent = msg; errEl.hidden = false; }
  else errEl.hidden = true;
}

function hideBcPreview() {
  $('#bcOutput').hidden = true;
  $('#bcPlaceholder').hidden = false;
  $('#bcCaption').hidden = true;
}

function setBcDownloads(enabled) {
  $('#bcDownloadPngBtn').disabled = !enabled;
  $('#bcDownloadSvgBtn').disabled = !enabled;
  $('#bcCopyBtn').disabled = !enabled;
}

/* Live preview on any input/format/option change (the committed state only
   changes when Generate is pressed, mirroring the QR flow). */
function bcSettingsChanged() {
  const v = $('#bcValue').value.trim();
  const fmt = $('#bcFormat').value;
  const msg = bcValidate(fmt, v);
  showBcError(msg);
  updateBcContrastWarning();
  if (msg) { hideBcPreview(); return; }
  ensureBarcodeLib()
    .then(() => { renderBcSvg(v, fmt); })
    .catch(() => { /* toasts on load failure surface via Generate */ });
}

/* Render a real JsBarcode SVG into the preview. Returns true on success. */
function renderBcSvg(value, format) {
  const out = $('#bcOutput');
  out.textContent = '';                       // clean up the previous render
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  out.appendChild(svg);
  let ok = false;
  window.JsBarcode(svg, value, {
    format,
    width: bcOptions.width,
    height: bcOptions.height,
    displayValue: bcOptions.displayValue,
    fontSize: bcOptions.fontSize,
    margin: bcOptions.margin,
    lineColor: bcOptions.linecolor,
    background: bcOptions.background,
    valid(v) { ok = v; }
  });
  if (!ok) {                                   // belt & braces — validators catch this first
    showBcError('Please enter a valid barcode value.');
    hideBcPreview();
    return false;
  }
  $('#bcPlaceholder').hidden = true;
  out.hidden = false;
  const cap = $('#bcCaption');
  cap.textContent = value;                     // untrusted value via textContent only
  cap.hidden = false;
  barcodeSvg = svg.outerHTML;
  return true;
}

async function onBcGenerate(e) {
  e.preventDefault();
  const input = $('#bcValue');
  const v = input.value.trim();
  const fmt = $('#bcFormat').value;
  const msg = bcValidate(fmt, v);
  if (msg) {
    showBcError(msg);
    toast('Please enter a valid barcode value.', 'error');
    input.focus();
    return;
  }
  try {
    await ensureBarcodeLib();
  } catch (err) {
    toast('Barcode engine failed to load. Check your connection and reload the page.', 'error');
    return;
  }
  if (!renderBcSvg(v, fmt)) {
    toast('Please enter a valid barcode value.', 'error');
    return;
  }
  bcGenerated = true;
  setBcDownloads(true);
  store.set(KEYS.bcValue, { format: fmt, value: input.value });
  toast('Barcode generated', 'success');
}

function onBcClear() {
  $('#bcValue').value = '';
  showBcError(null);
  bcGenerated = false;
  barcodeSvg = null;
  setBcDownloads(false);
  hideBcPreview();
  $('#bcValue').focus();
}

function onBcReset() {
  Object.assign(bcOptions, JSON.parse(JSON.stringify(BC_DEFAULTS)));
  $('#bcFormat').value = bcOptions.format;
  $('#bcValueHint').textContent = BC_FORMAT_HINTS[bcOptions.format] || '';
  reflectBcOptions();
  onBcClear();
  try { localStorage.removeItem(KEYS.bcValue); localStorage.removeItem(KEYS.bcCustom); } catch (err) { /* ignore */ }
}

function persistBc() {
  store.set(KEYS.bcCustom, bcOptions);
}

function reflectBcOptions() {
  $('#bcWidth').value = String(bcOptions.width);
  $('#bcWidthOut').textContent = String(bcOptions.width);
  $('#bcHeight').value = String(bcOptions.height);
  $('#bcHeightOut').textContent = bcOptions.height + ' px';
  $('#bcFontSize').value = String(bcOptions.fontSize);
  $('#bcFontSizeOut').textContent = bcOptions.fontSize + ' px';
  $('#bcMargin').value = String(bcOptions.margin);
  $('#bcMarginOut').textContent = bcOptions.margin + ' px';
  $('#bcLineColor').value = safeHex(bcOptions.linecolor, '#111111');
  $('#bcLineHex').value = safeHex(bcOptions.linecolor, '#111111').toUpperCase();
  $('#bcBgColor').value = safeHex(bcOptions.background, '#FFFFFF');
  $('#bcBgHex').value = safeHex(bcOptions.background, '#FFFFFF').toUpperCase();
  $('#bcShowValue').checked = bcOptions.displayValue;
  updateBcContrastWarning();
}

function updateBcContrastWarning() {
  const lum = (hex) => {
    const v = [1, 3, 5].map((i) => {
      let x = parseInt(hex.slice(i, i + 2), 16) / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const l1 = lum(safeHex(bcOptions.linecolor, '#111111'));
  const l2 = lum(safeHex(bcOptions.background, '#FFFFFF'));
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const warn = $('#bcContrastWarn');
  if (ratio < 3) {
    warn.textContent = 'Low contrast may make this barcode difficult to scan.';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}

function bcFileBase() {
  return 'qr-studio-barcode-' + bcOptions.format.toLowerCase() + '-' + Date.now();
}

async function onBcDownloadPng() {
  if (!bcGenerated || !barcodeSvg) return;
  try {
    // Rasterize the vector SVG at 3× its natural size — geometric scaling,
    // so bars stay perfectly sharp (no screenshot / no blur).
    const wM = barcodeSvg.match(/width="(\d+(?:\.\d+)?)"/);
    const hM = barcodeSvg.match(/height="(\d+(?:\.\d+)?)"/);
    const natW = wM ? parseFloat(wM[1]) : 260;
    const natH = hM ? parseFloat(hM[1]) : 100;
    const scale = 3;
    const blob = await rasterizeSvg(barcodeSvg, Math.round(natW * scale), Math.round(natH * scale));
    downloadBlob(blob, bcFileBase() + '.png');
    toast('PNG downloaded', 'success');
  } catch (err) {
    toast('Download failed. Please try again.', 'error');
  }
}

function onBcDownloadSvg() {
  if (!bcGenerated || !barcodeSvg) return;
  try {
    downloadBlob(new Blob([barcodeSvg], { type: 'image/svg+xml;charset=utf-8' }), bcFileBase() + '.svg');
    toast('SVG downloaded', 'success');
  } catch (err) {
    toast('Download failed. Please try again.', 'error');
  }
}

/* Generate-view mode switch (QR Code / Barcode). */
function setGenMode(mode) {
  if (mode !== 'qr' && mode !== 'barcode') mode = 'qr';
  state.genMode = mode;
  const isBc = mode === 'barcode';
  $('#genBarcode').hidden = !isBc;
  $('#genQr').hidden = isBc;
  $$('#genModeSeg .seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.genMode === mode)));
  const def = isBc ? GEN_BC_TEXT : TYPES[state.currentType];
  $('#genHeading').textContent = def.heading;
  $('#genDesc').textContent = def.desc;
  document.title = 'QR Studio — ' + def.heading;
  store.set(KEYS.genMode, mode);
}

function initGenMode() {
  $$('#genModeSeg .seg-btn').forEach((b) => {
    b.addEventListener('click', () => setGenMode(b.dataset.genMode));
  });
}

function initBarcodeGen() {
  // Restore persisted customization (validated + clamped)
  const saved = store.get(KEYS.bcCustom, null);
  if (saved && typeof saved === 'object') {
    if (BC_FORMATS.includes(saved.format)) bcOptions.format = saved.format;
    const num = (v, min, max, fb) => (typeof v === 'number' && v >= min && v <= max ? v : fb);
    bcOptions.width = num(saved.width, 1, 5, bcOptions.width);
    bcOptions.height = num(saved.height, 30, 160, bcOptions.height);
    bcOptions.fontSize = num(saved.fontSize, 10, 32, bcOptions.fontSize);
    bcOptions.margin = num(saved.margin, 0, 40, bcOptions.margin);
    bcOptions.linecolor = safeHex(saved.linecolor, bcOptions.linecolor);
    bcOptions.background = safeHex(saved.background, bcOptions.background);
    if (typeof saved.displayValue === 'boolean') bcOptions.displayValue = saved.displayValue;
  }
  const savedVal = store.get(KEYS.bcValue, null);
  if (savedVal && typeof savedVal === 'object') {
    if (BC_FORMATS.includes(savedVal.format)) $('#bcFormat').value = savedVal.format;
    bcOptions.format = $('#bcFormat').value;
    if (typeof savedVal.value === 'string') $('#bcValue').value = savedVal.value;
  }
  $('#bcValueHint').textContent = BC_FORMAT_HINTS[bcOptions.format] || '';
  reflectBcOptions();

  $('#bcGenForm').addEventListener('submit', onBcGenerate);
  $('#bcClearBtn').addEventListener('click', onBcClear);
  $('#bcResetBtn').addEventListener('click', onBcReset);
  $('#bcDownloadPngBtn').addEventListener('click', onBcDownloadPng);
  $('#bcDownloadSvgBtn').addEventListener('click', onBcDownloadSvg);
  $('#bcCopyBtn').addEventListener('click', () => {
    if (barcodeSvg) copyWithToast(barcodeSvg, 'SVG code copied');
  });

  $('#bcFormat').addEventListener('change', () => {
    bcOptions.format = $('#bcFormat').value;
    $('#bcValueHint').textContent = BC_FORMAT_HINTS[bcOptions.format] || '';
    persistBc();
    bcSettingsChanged();
  });
  $('#bcValue').addEventListener('input', bcSettingsChanged);

  [['bcWidth', 'width'], ['bcHeight', 'height'], ['bcFontSize', 'fontSize'], ['bcMargin', 'margin']].forEach(([id, key]) => {
    $('#' + id).addEventListener('input', (e) => {
      bcOptions[key] = Number(e.target.value);
      const out = $('#' + id + 'Out');
      out.textContent = key === 'width' ? String(bcOptions[key]) : bcOptions[key] + ' px';
      persistBc();
      bcSettingsChanged();
    });
  });

  const bindBcColor = (colorId, hexId, key) => {
    const colorInput = $('#' + colorId);
    const hexInput = $('#' + hexId);
    colorInput.addEventListener('input', () => {
      bcOptions[key] = colorInput.value;
      hexInput.value = colorInput.value.toUpperCase();
      persistBc();
      bcSettingsChanged();
    });
    hexInput.addEventListener('input', () => {
      const v = safeHex(hexInput.value.trim(), '');
      if (v) {
        bcOptions[key] = v;
        colorInput.value = v;
        persistBc();
        bcSettingsChanged();
      }
    });
    hexInput.addEventListener('change', () => {
      hexInput.value = safeHex(hexInput.value.trim(), bcOptions[key]).toUpperCase();
    });
  };
  bindBcColor('bcLineColor', 'bcLineHex', 'linecolor');
  bindBcColor('bcBgColor', 'bcBgHex', 'background');

  $('#bcShowValue').addEventListener('change', (e) => {
    bcOptions.displayValue = e.target.checked;
    persistBc();
    bcSettingsChanged();
  });
}

/* Node export for tests — the browser ignores typeof-module code paths. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TYPES,
    classify,
    normalizeUrl,
    validPhone,
    escWifi,
    escVcard,
    escXml,
    truncate,
    store,
    classifyBarcode,
    barcodeFormatName,
    BARCODE_LABELS,
    bcValidate,
    gs1CheckDigit,
    upceToUpcaBody,
    bcFormatLabel,
    BC_FORMATS,
    zxingDecodeImageData,
    decodeImageFile
  };
}
