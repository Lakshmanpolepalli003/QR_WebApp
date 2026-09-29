/* Camera permission flow test — drives the real app in headless Chrome and
   verifies each camera state (supported / secure / denied / dismissed /
   in-use / unavailable / overconstrained / stop-during-start) with mocked
   getUserMedia. Plain Node, no framework:  node test/camera.test.js
   Env overrides: CHROME (chrome.exe path), BASE (app URL). */
'use strict';

const assert = require('assert');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://localhost:8123/index.html';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return fn().then(() => { passed++; console.log('  \u2713 ' + name); })
    .catch((e) => { failed++; failures.push({ name, error: e }); console.error('  \u2717 ' + name + '\n      ' + (e && e.message ? e.message.split('\n')[0] : e)); });
}

// Watchdog: never let a hung Chrome keep the suite alive.
setTimeout(() => {
  console.error('\nTIMEOUT after 180s — Chrome likely failed to launch or attach in this environment.');
  console.error(passed + ' passed, ' + (failed + 1) + ' failed (timeout)');
  process.exit(1);
}, 180000).unref();

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream=0', '--disable-features=Translate']
    });
  } catch (e) {
    console.error('Could not launch Chrome (' + e.message + ').');
    console.error('Set CHROME=/path/to/chrome and retry. Skipping camera browser tests.');
    process.exit(0);
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  page.on('console', (m) => { if (m.type() === 'error') console.error('  [console.error]', m.text().split('\n')[0]); });
  process.on('unhandledRejection', (e) => console.error('  [unhandledRejection]', String(e).split('\n')[0]));
  page.on('pageerror', (e) => console.error('  [pageerror]', String(e).split('\n')[0]));
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#genFields') && document.querySelector('#genFields').children.length > 0, { timeout: 10000 });

  // Open the Scan view for every scenario.
  await page.evaluate(() => document.querySelector('.top-tab[data-view="scan"]').click());

  const ui = () => page.evaluate(() => ({
    error: document.querySelector('#cameraError').hidden ? null : document.querySelector('#cameraError').textContent,
    helpSteps: [...document.querySelectorAll('#cameraBlockedHelp li')].map((li) => li.textContent),
    blockedActionsVisible: !document.querySelector('#cameraBlockedActions').hidden,
    cameraActive: document.querySelector('#cameraBox').classList.contains('active'),
    startText: document.querySelector('#startCamBtn').textContent,
    diag: { starting: state.cameraStarting, gen: state.camGeneration, stream: !!state.cameraStream }
  }));

  // Install a controllable fake getUserMedia. `script` is a factory:
  // ({ record }) => Promise<stream-like>  — runs inside the page each call.
  async function mockCamera(pageSetup) {
    await page.evaluate(pageSetup);
  }
  const resetMock = () => page.evaluate(() => {
    delete navigator.mediaDevices; // restored below to the real handle
    if (window.__realMD) Object.defineProperty(navigator, 'mediaDevices', { value: window.__realMD, configurable: true });
    if (window.__realPerms) Object.defineProperty(navigator, 'permissions', { value: window.__realPerms, configurable: true });
    resetCameraUi();
    stopCamera();
  });
  await page.evaluate(() => { window.__realMD = navigator.mediaDevices; window.__realPerms = navigator.permissions; });

  const FAKE_STREAM = `(track) => ({
    getTracks: () => [track],
    getVideoTracks: () => [track]
  })`;

  console.log('\ncamera permission flow');

  await test('secure-context gate shows the HTTPS message and never calls gUM', async () => {
    let called = false;
    await mockCamera(() => {
      Object.defineProperty(window, 'isSecureContext', { get: () => false, configurable: true });
      window.__gumCalls = 0;
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => { window.__gumCalls++; return Promise.resolve(); } }, configurable: true });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 300));
    const state = await ui();
    await page.evaluate(() => { Object.defineProperty(window, 'isSecureContext', { get: () => true, configurable: true }); resetCameraUi(); });
    assert.match(state.error, /HTTPS/);
    const calls = await page.evaluate(() => window.__gumCalls);
    assert.strictEqual(calls, 0, 'getUserMedia must not be called on insecure origin');
    void called;
  });

  await test('unsupported browser shows compatibility message', async () => {
    await mockCamera(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 200));
    const state = await ui();
    await resetMock();
    assert.match(state.error, /doesn.t support camera scanning/);
  });

  await test('confirmed denied → blocked help + Try Again + Scan from Image', async () => {
    await mockCamera(() => {
      Object.defineProperty(navigator, 'permissions', {
        value: { query: () => Promise.resolve({ state: 'denied', addEventListener() {} }) }, configurable: true
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 600));
    const state = await ui();
    await resetMock();
    assert.match(state.error, /Camera permission is blocked\./);
    assert.ok(state.helpSteps.length >= 3, 'browser-specific steps shown');
    assert.ok(state.blockedActionsVisible, 'Try Again / Scan from Image row visible');
    assert.match(state.startText, /Try Again|Start Camera/);
  });

  await test('dismissed prompt → asks to retry, does NOT claim denial', async () => {
    await mockCamera(() => {
      Object.defineProperty(navigator, 'permissions', {
        value: { query: () => Promise.resolve({ state: 'prompt', addEventListener() {} }) }, configurable: true
      });
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 600));
    const state = await ui();
    await resetMock();
    assert.match(state.error, /dismissed/i);
    assert.ok(!/denied/i.test(state.error), 'must not say denied when state is prompt');
    assert.strictEqual(state.helpSteps.length, 0, 'no blocked-instructions panel');
  });

  await test('Permissions API unsupported + NotAllowedError → falls back to dismissed copy, not denial', async () => {
    await mockCamera(() => {
      Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })) }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 400));
    const state = await ui();
    await resetMock();
    assert.match(state.error, /dismissed/i);
    assert.ok(!/blocked/i.test(state.error));
  });

  await test('camera in use → meaningful message', async () => {
    await mockCamera(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotReadableError' })) }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 800));
    const state = await ui();
    await resetMock();
    assert.match(state.error, /already in use/);
  });

  await test('no camera → unavailable message', async () => {
    await mockCamera(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotFoundError' })) }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 900));
    const state = await ui();
    await resetMock();
    assert.match(state.error, /No usable camera/);
  });

  await test('overconstrained → retries with simpler constraints and starts', async () => {
    await mockCamera(() => {
      // Real MediaStream objects: video.srcObject rejects non-MediaStream values.
      const mk = () => new MediaStream();
      let n = 0;
      window.__constraints = [];
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: (c) => { window.__constraints.push(JSON.stringify(c)); n++; return n === 1 ? Promise.reject(Object.assign(new Error('no'), { name: 'OverconstrainedError' })) : Promise.resolve(mk()); } },
        configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 700));
    const state = await ui();
    const constraints = await page.evaluate(() => window.__constraints);
    await resetMock();
    assert.ok(constraints.length >= 2, 'second stage attempted');
    assert.strictEqual(state.cameraActive, true, 'camera UI active after retry — diag: ' + JSON.stringify(state));
  });

  await test('rear camera preferred via facingMode ideal environment', async () => {
    await mockCamera(() => {
      window.__last = null;
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: (c) => { window.__last = c; return Promise.resolve(new MediaStream()); } }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 400));
    const last = await page.evaluate(() => window.__last);
    await resetMock();
    assert.strictEqual(last.video.facingMode.ideal, 'environment');
    assert.strictEqual(last.audio, false);
  });

  await test('stop during pending gUM discards the late stream (no leak)', async () => {
    await mockCamera(() => {
      window.__late = null;
      const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {}, readyState: 'live', kind: 'video' };
      window.__track = track;
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => new Promise((res) => { window.__late = () => res({ getTracks: () => [track], getVideoTracks: () => [track] }); }) },
        configurable: true
      });
    });
    // Fire WITHOUT awaiting inside the page: startCamera stays pending until
    // gUM resolves, so awaiting it here would deadlock the test.
    await page.evaluate(() => { startCamera(); });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => stopCamera());            // user bails
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => window.__late());         // gUM resolves late
    await new Promise((r) => setTimeout(r, 400));
    const out = await page.evaluate(() => ({
      trackStopped: window.__track.stopped,
      active: document.querySelector('#cameraBox').classList.contains('active'),
      stream: !!state.cameraStream
    }));
    await resetMock();
    assert.strictEqual(out.trackStopped, true, 'late stream tracks stopped');
    assert.strictEqual(out.stream, false, 'no leaked stream in state');
    assert.strictEqual(out.active, false);
  });

  await test('camera active → Camera active note + Stop enabled; stop resets UI', async () => {
    await mockCamera(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: { getUserMedia: () => Promise.resolve(new MediaStream()) }, configurable: true
      });
    });
    await page.evaluate(() => startCamera());
    await new Promise((r) => setTimeout(r, 500));
    let s = await ui();
    const noteVisible = await page.evaluate(() => !document.querySelector('#cameraActiveNote').hidden);
    const stopEnabled = await page.evaluate(() => !document.querySelector('#stopCamBtn').disabled);
    await page.evaluate(() => stopCamera());
    await new Promise((r) => setTimeout(r, 200));
    s = await ui();
    await resetMock();
    assert.strictEqual(noteVisible, true);
    assert.strictEqual(stopEnabled, true);
    assert.strictEqual(s.cameraActive, false, 'UI resets after stop');
  });

  await browser.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    failures.forEach((f) => console.error('FAILED: ' + f.name + ' — ' + f.error.message));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
