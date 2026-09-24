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
  jsqr: ['vendor/jsQR.min.js']
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
  history: 'qr-studio-history'
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
  clearArmedTimer: null,
  libsLocal: false
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

  const maxDim = 1400;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const code = window.jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}

async function onDecode() {
  if (!state.uploadFile) return;
  if (!(await ensureEngine())) {
    showUploadError('QR engine failed to load. Check your connection and reload the page.');
    return;
  }
  const btn = $('#decodeBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Decoding…';
  try {
    const result = await decodeImageFile(state.uploadFile);
    if (result) {
      handleScanSuccess(result);
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
   13. Camera scanner
   ============================================================ */
function showCameraError(msg) {
  const e = $('#cameraError');
  e.textContent = msg;
  e.hidden = !msg;
}

function setCameraUi(active) {
  $('#cameraBox').classList.toggle('active', active);
  $('#cameraIdle').hidden = active;
  $('#scanFrame').hidden = !active;
  $('#startCamBtn').disabled = active;
  $('#stopCamBtn').disabled = !active;
}

async function startCamera() {
  showCameraError('');
  if (!(await ensureEngine())) {
    showCameraError('QR engine failed to load. Check your connection and reload the page.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraError('Camera scanning is not supported in this browser.');
    return;
  }
  if (!window.isSecureContext) {
    showCameraError('Camera access requires a secure connection. Open QR Studio over HTTPS or localhost.');
    return;
  }
  setCameraUi(true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    state.cameraStream = stream;
    const video = $('#cameraVideo');
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay is muted; ignore */ }

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
      const code = window.jsQR(frame.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        stopCamera();
        if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* ignore */ } }
        handleScanSuccess(code.data);
      }
    }, 180);
  } catch (err) {
    setCameraUi(false);
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      showCameraError('Camera access was denied. Allow camera permission in your browser settings and try again.');
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      showCameraError('No camera was found on this device.');
    } else if (name === 'NotReadableError' || name === 'TrackStartError') {
      showCameraError('Your camera is already in use by another app. Close it and try again.');
    } else {
      showCameraError('Could not start the camera. Please try again.');
    }
  }
}

function stopCamera() {
  if (state.cameraTimer) { clearInterval(state.cameraTimer); state.cameraTimer = null; }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  const video = $('#cameraVideo');
  if (video) video.srcObject = null;
  setCameraUi(false);
}

function initCamera() {
  $('#startCamBtn').addEventListener('click', startCamera);
  $('#stopCamBtn').addEventListener('click', stopCamera);
}

/* ============================================================
   14. Scan results — classification, rendering, actions
   ============================================================ */
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
  contentSection.appendChild(el('p', 'result-label', 'Content'));
  contentSection.appendChild(el('p', 'result-content', res.raw));
  body.appendChild(contentSection);

  if (res.details && res.details.length) {
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
  const res = classify(content);
  state.lastResult = res;
  renderResult(res);
  addHistory({ type: res.label, icon: res.icon, content: res.raw, ts: Date.now() });
  toast('QR code detected', 'success');
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
  $('#historyEmpty').hidden = state.history.length > 0;
  $('#clearHistoryBtn').hidden = state.history.length === 0;
  disarmClear();

  state.history.forEach((h) => {
    const li = el('li');

    const iconWrap = el('span', 'history-icon');
    iconWrap.appendChild(icon(h.icon || 'i-qr'));
    li.appendChild(iconWrap);

    const body = el('div', 'history-body');
    body.appendChild(el('p', 'history-content', truncate(String(h.content || '').replace(/\s+/g, ' ').trim(), 90)));
    const meta = el('p', 'history-meta');
    meta.appendChild(el('span', 'history-type', h.type || 'Text'));
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
  state.history.unshift({ id, type: entry.type, icon: entry.icon, content: entry.content, ts: entry.ts });
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

  $('#genForm').addEventListener('submit', onGenerate);
  $('#clearBtn').addEventListener('click', onClear);

  const savedType = store.get(KEYS.type, 'url');
  selectType(TYPES[savedType] ? savedType : 'url');
  const savedView = store.get(KEYS.view, 'generate');
  setView(savedView === 'scan' ? 'scan' : 'generate');

  initEngine();

  window.addEventListener('pagehide', stopCamera);
  window.addEventListener('beforeunload', () => {
    if (state.uploadUrl) URL.revokeObjectURL(state.uploadUrl);
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
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
    store
  };
}
