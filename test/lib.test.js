import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, cleanDomain, issuerInfo, normalizeEntries, renewalsPerYear, toCSV, toICS } from '../public/lib.js';
import tlsHandler from '../api/tls.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const sample = JSON.parse(readFileSync(new URL('../public/sample.json', import.meta.url)));

test('cleanDomain accepts urls and rejects junk', () => {
  assert.equal(cleanDomain('https://WWW.Example.com/path?q=1'), 'www.example.com');
  assert.equal(cleanDomain('*.example.org'), 'example.org');
  assert.equal(cleanDomain('example.com:8443'), 'example.com');
  assert.equal(cleanDomain('not a domain'), null);
  assert.equal(cleanDomain('localhost'), null);
});

test('issuer classification', () => {
  assert.equal(issuerInfo("C=US, O=Let's Encrypt, CN=R11").kind, 'automated');
  assert.equal(issuerInfo('C=US, O=Google Trust Services, CN=WR1').kind, 'automated');
  assert.equal(issuerInfo('C=US, O=DigiCert Inc, CN=DigiCert Global G2').name, 'DigiCert');
  assert.equal(issuerInfo('C=XX, O=Acme Widgets CA, CN=Widget CA').name, 'Acme Widgets CA');
});

test('precertificate duplicates collapse by serial', () => {
  const e = { issuer_name: 'O=DigiCert Inc', name_value: 'a.example.com', not_before: '2026-01-01T00:00:00', not_after: '2026-07-01T00:00:00', serial_number: 'ab' };
  assert.equal(normalizeEntries([{ id: 1, ...e }, { id: 2, ...e }]).length, 1);
});

test('renewal math matches the schedule', () => {
  assert.ok(Math.abs(renewalsPerYear(47) - 365 / 40) < 1e-9);
  assert.ok(renewalsPerYear(100) > 3.5 && renewalsPerYear(100) < 4);
  assert.ok(renewalsPerYear(398) < 1);
});

test('sample analysis finds the hand-renewed and forgotten certs', () => {
  const a = analyze(sample, NOW);
  const manual = new Set(a.manual.map((l) => l.primary));
  for (const h of ['mail', 'vpn', 'canvas', 'payroll', 'door-controller.facilities']) assert.ok(manual.has(`${h}.stateuniversity.example`), h);
  const auto = new Set(a.automated.map((l) => l.primary));
  for (const h of ['news', 'api', 'apply']) assert.ok(auto.has(`${h}.stateuniversity.example`), h);
  const forgotten = new Set(a.forgotten.map((l) => l.primary));
  assert.ok(forgotten.has('staging.apply.stateuniversity.example'));
  assert.ok(forgotten.has('old-portal.stateuniversity.example'));
  assert.ok(!forgotten.has('news.stateuniversity.example'));
  const f = a.forecast.map((x) => x.manualRenewals);
  assert.ok(f[0] < f[1] && f[1] < f[2] && f[2] < f[3], 'renewals grow at each step');
});

test('exports', () => {
  const a = analyze(sample, NOW);
  const ics = toICS(a.manual, { [a.manual[0].key]: 'Pat' }, NOW);
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, a.manual.length);
  assert.match(ics, /owner: Pat/);
  const csv = toCSV(a.lineages);
  assert.equal(csv.split('\n').length, a.lineages.length + 1);
});

function call(handler, url) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { resolve({ status: this.statusCode, body: JSON.parse(b) }); } };
    handler({ url }, res);
  });
}

test('tls endpoint validates input and refuses private addresses', async () => {
  assert.equal((await call(tlsHandler, '/api/tls?host=')).status, 400);
  const r = await call(tlsHandler, '/api/tls?host=localhost.localdomain.test,127.0.0.1.nip.io');
  for (const x of r.body.results) assert.equal(x.ok, false);
});
