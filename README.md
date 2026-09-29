# QR Studio

**Generate. Scan. Connect.**

A fast, private QR code generator and scanner that runs entirely in your browser — no accounts, no servers, no AI APIs. Nothing you type or scan ever leaves your device.

## Run it

It's a fully static site. Serve the folder (recommended, so the camera works on localhost):

```bash
node tools/serve.js 8080
# then open http://localhost:8080
```

Any static server works too (e.g. `python3 -m http.server 8080`). Opening `index.html` directly via `file://` also works for generating QR codes; the camera scanner needs `http://localhost` or HTTPS.

## Camera permissions on mobile

The camera only starts after you tap **Start Camera** — nothing is requested on page load. If scanning fails:

- **HTTPS required.** Phones can only grant camera access on `https://` URLs (or `localhost`). Test on a phone by opening the deployed HTTPS URL, or use a quick tunnel: `npx localtunnel --port 8080`.
- **"The prompt was dismissed…"** means the browser prompt was closed or the tap had gone stale (common after a service-worker page restore). Tap **Start Camera** again and choose **Allow**.
- **"Camera permission is blocked"** appears only when the browser itself reports a persisted block. Fix it in the *browser's* site settings (tap the lock/site icon near the address bar → Permissions → Camera → Allow), then reload. Websites do not appear in the phone's main Settings camera list.
- **"Camera is already in use"** usually means another tab or app holds the camera — close it, then retry.

Add `?debugcam=1` to the URL to see verbose camera diagnostics in the console (secure-context status, permission state, getUserMedia attempts, device enumeration).

The QR engine (`qrcode-generator`) and the decoder (`jsQR`) are bundled in `vendor/`, so the app works **fully offline** with no CDN calls. If `vendor/` is missing, the app transparently falls back to CDN copies — so a bare checkout of just the HTML/CSS/JS still works when online.

## Install (PWA)

QR Studio is an installable Progressive Web App: served over HTTPS (or localhost), it can be installed to your home screen/desktop and keeps working offline thanks to a service worker that caches the app shell.

## Tests

No test framework needed — plain Node:

```bash
node test/app.test.js
```

Covers URL/phone normalization, Wi-Fi/email/vCard/SMS/location payload builders, scan-result classification, and escaping helpers.

## Features

**Generate** — 10 QR types with real, scannable payloads:

URL · Text · Wi-Fi · Email · Phone · SMS · Location (`geo:`) · vCard · Image URL · File URL

**Customize** — foreground/background colors (with a scan-contrast warning), square/rounded/dots module patterns, square/rounded/dot finder (corner) styles, export sizes (256–1024 px), a centered logo upload (PNG/JPG/WEBP, high error correction is applied automatically), and a minimal frame (None / Scan Me / Custom text).

**Download** — the actual rendered QR as PNG or SVG, preserving content, colors, pattern, corner style, size, logo, and frame.

**Scan** — decode QR codes from an uploaded image (drag & drop or browse) or live via the camera, with typed results and contextual actions (Open Link / Call / Open Email / Open Messages / Open Maps / Copy). Decoded data is always treated as untrusted: it is only ever inserted with `textContent`, and only `http(s)` links are ever opened.

**History** — the last 30 scans are kept in `localStorage` with copy/delete per item and a two-tap clear.

**More** — light/dark theme (remembers your choice, falls back to the system preference), mobile drawer navigation, keyboard-accessible controls, and inline validation with no browser alerts.

## Tech

HTML5 + CSS3 + vanilla JavaScript — no build step, no dependencies. `qrcode-generator` (vendored in `vendor/`) provides the QR matrix (UTF-8 byte mode); rendering, styling, SVG/PNG export, and decoding via `jsQR` are all done locally in the browser. `tools/serve.js` is a zero-dependency dev server and `tools/gen-icons.js` regenerates the PWA icons.
