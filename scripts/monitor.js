#!/usr/bin/env node
// Daily watchlist monitor, run by GitHub Actions before each Pages deploy.
//
// For every domain in watchlist.txt it looks up certificates (Cert Spotter and
// crt.sh), runs live TLS handshakes, and writes public/monitor/<domain>.json
// plus public/monitor/index.json for the site. Domains marked "alert" get a
// GitHub issue while something needs attention; the issue closes itself once
// the problem is gone.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { analyze, cleanDomain } from '../public/lib.js';
import { lookup } from '../api/ct.js';
import { liveCheck } from './live.js';

const DAY = 86400000;
const OUT = process.env.MONITOR_OUT ? new URL(`file://${process.env.MONITOR_OUT.replace(/\/?$/, '/')}`) : new URL('../public/monitor/', import.meta.url);
const ALERT_DAYS = 14;
const MAX_ENTRIES = 40000;

function readWatchlist() {
  let text = '';
  try { text = readFileSync(process.env.WATCHLIST || new URL('../watchlist.txt', import.meta.url), 'utf8'); } catch { return []; }
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [d, ...rest] = l.split(/\s+/);
      return { domain: cleanDomain(d), alert: rest.includes('alert') };
    })
    .filter((w) => w.domain);
}

// Problems worth waking someone up for.
function problems(r, live) {
  const out = [];
  for (const l of r.active) {
    if (l.daysLeft <= ALERT_DAYS) {
      out.push({ host: l.primary, issue: `certificate expires in ${l.daysLeft} days (${l.latest.notAfter.toISOString().slice(0, 10)}), renewal looks ${l.automation}` });
    }
    if (l.flags.some((f) => f.kind === 'distrust')) out.push({ host: l.primary, issue: 'Entrust certificate issued after Nov 11, 2024 is distrusted by Chrome' });
  }
  for (const [host, v] of Object.entries(live || {})) {
    if (!v.ok) continue;
    const days = Math.floor((Date.parse(v.validTo) - Date.now()) / DAY);
    if (!v.trusted) out.push({ host, issue: `serves an untrusted certificate (${v.authError || 'unknown error'})` });
    else if (days <= ALERT_DAYS) out.push({ host, issue: `serves a certificate that expires in ${days} days` });
  }
  const seen = new Set();
  return out.filter((p) => !seen.has(p.host + p.issue) && seen.add(p.host + p.issue));
}

async function gh(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function syncIssue(domain, list, siteUrl) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!process.env.GITHUB_TOKEN || !repo) return 'skipped (no GITHUB_TOKEN)';
  const title = `Cert Radar: certificates need attention on ${domain}`;
  const open = await gh(`/repos/${repo}/issues?state=open&per_page=100`);
  const existing = open.find((i) => i.title === title && !i.pull_request);
  if (!list.length) {
    if (existing) {
      await gh(`/repos/${repo}/issues/${existing.number}/comments`, { method: 'POST', body: JSON.stringify({ body: 'All clear on the latest daily scan. Closing.' }) });
      await gh(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
      return `closed #${existing.number}`;
    }
    return 'nothing to report';
  }
  const body = [
    `The daily Cert Radar scan found ${list.length} problem${list.length > 1 ? 's' : ''} on **${domain}**:`,
    '',
    '| Host | Problem |',
    '| --- | --- |',
    ...list.map((p) => `| \`${p.host}\` | ${p.issue} |`),
    '',
    siteUrl ? `Full report: ${siteUrl}?d=${encodeURIComponent(domain)}` : '',
    '',
    '_This issue updates every day and closes itself when the problems are gone._',
  ].join('\n');
  if (existing) {
    if (existing.body !== body) await gh(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    return `updated #${existing.number}`;
  }
  const created = await gh(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) });
  return `opened #${created.number}`;
}

const slim = (e) => ({
  id: e.id, issuer_name: e.issuer_name, name_value: e.name_value, not_before: e.not_before,
  not_after: e.not_after, serial_number: e.serial_number, ...(e.source ? { source: e.source } : {}),
});

// Cert Spotter's free tier allows a handful of lookups per few minutes. When a domain hits
// the limit, wait it out once (up to 8 minutes) instead of losing that day's scan.
async function lookupWithRetry(domain) {
  try {
    return await lookup(domain, { token: process.env.CERTSPOTTER_TOKEN });
  } catch (e) {
    const m = /rate limit reached(?:, try again in (\d+) min)?/.exec(e.message);
    if (!m) throw e;
    const wait = Math.min(Number(m[1] || 2), 8);
    console.log(`${domain}: rate limited, retrying in ${wait} min`);
    await new Promise((r) => setTimeout(r, wait * 60000));
    return lookup(domain, { token: process.env.CERTSPOTTER_TOKEN });
  }
}

const watch = readWatchlist();
mkdirSync(OUT, { recursive: true });
const siteUrl = process.env.SITE_URL || '';
const index = { generatedAt: new Date().toISOString(), domains: [] };
let failures = 0;

for (const w of watch) {
  const t0 = Date.now();
  try {
    const data = await lookupWithRetry(w.domain);
    const entries = data.entries.slice(0, MAX_ENTRIES);
    const r = analyze(entries);
    const live = await liveCheck(r, { max: 40 });
    writeFileSync(new URL(`${w.domain}.json`, OUT), JSON.stringify({
      domain: w.domain, scannedAt: new Date().toISOString(), scope: data.scope, source: data.source,
      sourceErrors: data.errors, entries: entries.map(slim), live,
    }));
    const soonest = [...r.active].sort((a, b) => a.daysLeft - b.daysLeft)[0];
    const list = problems(r, live);
    const liveProblems = Object.values(live).filter((v) => v.ok && (!v.trusted || Date.parse(v.validTo) - Date.now() < ALERT_DAYS * DAY)).length;
    let alert = 'off';
    if (w.alert) {
      try { alert = await syncIssue(w.domain, list, siteUrl); } catch (e) { alert = `failed: ${e.message}`; }
    }
    index.domains.push({
      domain: w.domain,
      grade: r.readiness.grade,
      score: r.readiness.score,
      live: r.active.length,
      manual: r.manual.length,
      unclear: r.unclear.length,
      manualRenewals2029: r.forecast[r.forecast.length - 1].manualRenewals,
      nextExpiry: soonest ? { host: soonest.primary, daysLeft: soonest.daysLeft } : null,
      liveChecked: Object.keys(live).length,
      liveProblems,
      problems: list.length,
      scope: data.scope,
    });
    console.log(`${w.domain}: ${data.source}, ${entries.length} entries, grade ${r.readiness.grade}, ${Object.keys(live).length} hosts checked, ${list.length} problem(s), alert ${alert} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    if (data.errors.length) console.log(`  source warnings: ${data.errors.join('; ')}`);
  } catch (e) {
    failures++;
    index.domains.push({ domain: w.domain, error: `Lookup failed on ${new Date().toISOString().slice(0, 10)}: ${e.message}` });
    console.log(`${w.domain}: FAILED ${e.message}`);
  }
}

writeFileSync(new URL('index.json', OUT), JSON.stringify(index, null, 2));
console.log(`Wrote ${index.domains.length} domain(s) to public/monitor (${failures} failed).`);
