/* Responsive audit: loads the app at each viewport size, in both views,
   and reports horizontal overflow / elements crossing viewport edges. */
'use strict';
const puppeteer = require('puppeteer-core');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:8123/index.html';

const SIZES = [
  [320, 640], [360, 700], [375, 720], [390, 800], [414, 820], [430, 850], [480, 860],
  [540, 700], [600, 800], [640, 360], [667, 375], [700, 720], [768, 900],
  [820, 1100], [844, 390], [896, 414], [912, 900], [1024, 768], [1100, 800],
  [1280, 800], [1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1200]
];

function label(n) {
  if (n.id) return '#' + n.id;
  if (typeof n.className === 'string' && n.className) return '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
  return n.tagName;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate']
  });
  const page = await browser.newPage();
  const issues = [];

  for (const [w, h] of SIZES) {
    await page.setViewport({ width: w, height: h });
    await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 250));

    for (const view of ['gen', 'scan']) {
      if (view === 'scan') {
        await page.evaluate(() => document.querySelector('.top-tab[data-view="scan"]').click());
        await new Promise(r => setTimeout(r, 120));
      }
      const probs = await page.evaluate(() => {
        const label = (n) => {
          if (n.id) return '#' + n.id;
          if (typeof n.className === 'string' && n.className) return '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
          return n.tagName;
        };
        const out = [];
        const de = document.documentElement;
        const vw = de.clientWidth;
        if (de.scrollWidth > vw + 1) out.push('DOC-H-OVERFLOW ' + de.scrollWidth + '>' + vw);
        document.querySelectorAll('body *').forEach((n) => {
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return;
          if (n.closest('[hidden]')) return;
          if (n.closest('#sidebar') && !document.getElementById('sidebar').classList.contains('open')) return; // closed drawer is intentionally off-canvas
          const fixed = cs.position === 'fixed';
          if (!n.offsetParent && !fixed) return;
          const r = n.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          const overR = r.right - (de.clientWidth + window.scrollX);
          const overL = -r.left;
          if (overR > 1.5 && r.width > 8) out.push('R+' + Math.round(overR) + ':' + label(n));
          if (overL > 1.5 && r.width > 8) out.push('L+' + Math.round(overL) + ':' + label(n));
        });
        // clipped-content check: containers whose contents exceed their box
        ['.topbar', '.topbar-left', '.topbar-right', '.top-tabs', '.form-actions'].forEach((sel) => {
          const n = document.querySelector(sel);
          if (n && n.scrollWidth > n.clientWidth + 2) out.push('CLIPPED ' + sel + ' ' + n.scrollWidth + '>' + n.clientWidth);
        });
        return Array.from(new Set(out)).slice(0, 8);
      });
      if (probs.length) issues.push(w + 'x' + h + ' [' + view + '] ' + probs.join(' | '));
    }
    process.stdout.write(w + 'x' + h + ' ');
  }
  console.log('\n');
  if (issues.length) {
    console.log('=== ISSUES ===');
    issues.forEach(i => console.log(i));
  } else {
    console.log('NO OVERFLOW ISSUES FOUND');
  }
  await browser.close();
})().catch(e => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
