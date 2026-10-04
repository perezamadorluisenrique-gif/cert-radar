// Browser tests with mocked CT sources. Runs against any copy of the site:
//   BASE=http://localhost:3000 node test/browser.mjs [screenshot-dir]
// Needs Playwright (`npm i -D playwright` or a global install; set PW to its path).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const SHOTS = process.argv[2];
const results = [];

const browser = await chromium.launch();
const errors = [];
async function page(opts = {}) {
  const p = await browser.newPage(opts);
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
}
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n')[0]]);
  }
}

const sampleText = await (await fetch(`${BASE}/sample.json`)).text();
const sample = JSON.parse(sampleText.replaceAll('stateuniversity.example', 'acme.com'));
const live = sample.filter((e) => Date.parse(e.not_after + 'Z') > Date.now());
const csItems = live.map((e, i) => ({
  id: String(1000 + i), cert_sha256: e.serial_number + 'cs', dns_names: e.name_value.split('\n'),
  not_before: e.not_before + 'Z', not_after: e.not_after + 'Z', issuer: { friendly_name: 'x', name: e.issuer_name },
}));
const cors = { 'access-control-allow-origin': '*' };
const certSpotterOK = (r) => {
  const after = new URL(r.request().url()).searchParams.get('after');
  return r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(after ? [] : csItems) });
};
const noSnapshot = (r) => r.fulfill({ status: 404, contentType: 'text/html', body: 'not found' });

await check('demo renders grade, forecast and details', async () => {
  const p = await page({ viewport: { width: 1280, height: 900 } });
  await p.goto(`${BASE}/?d=demo`);
  await p.waitForSelector('#results:not([hidden])');
  assert.match(await p.textContent('#grade'), /^[A-F]$/);
  assert.ok(Number(await p.textContent('#hl-num')) > 100);
  assert.match(await p.textContent('#countdown'), /cap/);
  await p.click('#rows tr.row .expand');
  await p.waitForSelector('tr.detail .gantt svg');
  assert.match(await p.textContent('tr.detail .facts'), /Typical lifetime/);
  await p.click('#attention .jump >> nth=0');
  await p.waitForSelector('tr.detail');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 1280);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/demo-desktop.png`, fullPage: true });
});

await check('static hosting: Cert Spotter first, crt.sh down', async () => {
  const p = await page();
  await p.route('**/monitor/**', noSnapshot);
  await p.route('https://api.certspotter.com/**', certSpotterOK);
  await p.route('https://crt.sh/**', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<html>502</html>' }));
  await p.goto(`${BASE}/?d=acme.com`);
  await p.waitForSelector('#results:not([hidden])');
  await p.waitForFunction(() => /History unavailable|Full history/.test(document.getElementById('source-note').textContent));
  assert.match(await p.textContent('#source-note'), /Cert Spotter.*History unavailable/s);
  assert.match(await p.textContent('#grade'), /^[A-F]$/);
});

await check('static hosting: crt.sh history merges in', async () => {
  const p = await page({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await p.route('**/monitor/**', noSnapshot);
  await p.route('https://api.certspotter.com/**', certSpotterOK);
  await p.route('https://crt.sh/**', (r) => r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(sample) }));
  await p.goto(`${BASE}/?d=acme.com`);
  await p.waitForFunction(() => /Full history/.test(document.getElementById('source-note').textContent));
  const tiles = await p.locator('#tiles .tile .v').allTextContents();
  assert.ok(Number(tiles[0].replace(/,/g, '')) > 500, 'history adds certificates: ' + tiles[0]);
  assert.ok(Number(tiles[5]) > 0, 'past lapses found');
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/real-mobile-dark.png` });
  await p.reload();
  await p.waitForFunction(() => /Full history/.test(document.getElementById('source-note').textContent));
  assert.ok(await p.isHidden('#changes'), 'no changes reported for an identical rescan');
});

await check('both sources down shows a clear error', async () => {
  const p = await page();
  await p.route('**/monitor/**', noSnapshot);
  await p.route('https://api.certspotter.com/**', (r) => r.fulfill({ status: 429, headers: { ...cors, 'retry-after': '600' }, contentType: 'application/json', body: '{"code":"rate_limited","message":"rate limited"}' }));
  await p.route('https://crt.sh/**', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: 'x' }));
  await p.goto(`${BASE}/?d=acme.com`);
  await p.waitForSelector('#error:not([hidden])');
  assert.match(await p.textContent('#error'), /rate limit.*crt\.sh/s);
});

await check('watchlist snapshot loads with live results', async () => {
  const p = await page();
  const snap = { domain: 'acme.com', scannedAt: new Date().toISOString(), scope: 'history', entries: sample, live: { 'mail.acme.com': { host: 'mail.acme.com', ok: true, issuer: 'InCommon', validTo: new Date(Date.now() + 5 * 864e5).toISOString(), trusted: true } } };
  const index = { generatedAt: new Date().toISOString(), domains: [{ domain: 'acme.com', grade: 'D', manual: 18, live: 62, manualRenewals2029: 164, nextExpiry: { host: 'wifi.acme.com', daysLeft: 3 }, liveProblems: 1 }] };
  await p.route('**/monitor/index.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(index) }));
  await p.route('**/monitor/acme.com.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(snap) }));
  await p.route('https://api.certspotter.com/**', () => { throw new Error('should not call Cert Spotter'); });
  await p.goto(`${BASE}/`);
  await p.waitForSelector('#board:not([hidden])');
  await p.click('.bcard[data-domain="acme.com"]');
  await p.waitForSelector('#results:not([hidden])');
  assert.match(await p.textContent('#source-note'), /daily scan/);
  assert.match(await p.textContent('#live-note'), /Live TLS checks from the daily scan/);
});

await browser.close();
for (const r of results) console.log(r.join('  '));
if (errors.length) console.log('page errors:', errors);
const failed = results.filter((r) => r[0] !== 'ok').length + errors.length;
console.log(failed ? `${failed} problem(s)` : 'all browser tests passed');
process.exit(failed ? 1 : 0);
