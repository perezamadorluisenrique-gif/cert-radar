// Scans a real domain on the live site with real CT sources.
//   BASE=https://<user>.github.io/cert-radar node test/live-smoke.mjs sslmate.com [shot-dir]
// Fails if the page breaks or hangs. An upstream CT outage shown to the user as
// a clear error is reported as a warning, not a failure.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const domain = process.argv[2] || 'sslmate.com';
const shots = process.argv[3];

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
await p.goto(`${BASE}/?d=${encodeURIComponent(domain)}`);
const outcome = await p
  .waitForFunction(() => {
    const done = !document.getElementById('results').hidden && !/Loading full history/.test(document.getElementById('source-note').textContent);
    const failed = !document.getElementById('error').hidden;
    return done ? 'results' : failed ? 'error' : false;
  }, null, { timeout: 150000, polling: 500 })
  .then((h) => h.jsonValue())
  .catch(() => 'timeout');
const secs = ((Date.now() - t0) / 1000).toFixed(1);
const progress = (await p.locator('#progress li').allTextContents()).join('\n  ');
console.log(`outcome: ${outcome} after ${secs}s\nprogress:\n  ${progress}`);
if (outcome === 'results') {
  console.log('grade:', await p.textContent('#grade'));
  console.log('headline:', await p.textContent('#hl-text'));
  console.log('source:', await p.textContent('#source-note'));
  console.log('tiles:', (await p.locator('#tiles .tile').allTextContents()).join(' | '));
} else if (outcome === 'error') {
  console.log(`::warning::scan of ${domain} showed an error: ${await p.textContent('#error')}`);
}
if (shots) await p.screenshot({ path: `${shots}/live-${domain}.png`, fullPage: true });
await browser.close();
if (errors.length) console.log('page errors:', errors);
process.exit(outcome === 'timeout' || errors.length ? 1 : 0);
