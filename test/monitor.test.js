import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Runs the watchlist monitor end to end with fetch stubbed: CT sources answer
// from the sample data and the GitHub API records the issue it would open.
test('monitor writes snapshots and opens an alert issue', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cert-radar-'));
  const sample = readFileSync(new URL('../public/sample.json', import.meta.url), 'utf8').replaceAll('stateuniversity.example', 'acme.invalid');
  writeFileSync(path.join(dir, 'watchlist.txt'), '# test\nacme.invalid alert\n');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(`${init.method || 'GET'} ${u}`);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://crt.sh/')) return new Response(sample, { headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://api.certspotter.com/')) return json({ code: 'rate_limited', message: 'slow down' }, 429);
    if (u.includes('/issues?state=open')) return json([]);
    if (u.endsWith('/issues') && init.method === 'POST') return json({ number: 7 }, 201);
    return json({ message: 'unexpected' }, 500);
  };
  process.env.MONITOR_OUT = dir;
  process.env.WATCHLIST = path.join(dir, 'watchlist.txt');
  process.env.GITHUB_TOKEN = 'test';
  process.env.GITHUB_REPOSITORY = 'someone/cert-radar';
  try {
    await import('../scripts/monitor.js');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.MONITOR_OUT; delete process.env.WATCHLIST; delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_REPOSITORY;
  }
  const index = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.domains.length, 1);
  assert.match(index.domains[0].grade, /^[A-F]$/);
  const snap = JSON.parse(readFileSync(path.join(dir, 'acme.invalid.json'), 'utf8'));
  assert.ok(snap.entries.length > 1000);
  assert.equal(snap.source, 'crt.sh');
  assert.ok(calls.some((c) => c.startsWith('POST https://api.github.com/repos/someone/cert-radar/issues')), 'issue opened');
});
