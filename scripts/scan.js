#!/usr/bin/env node
// Command-line scanner. No dependencies, Node 18+.
//
//   node scripts/scan.js example.com                 human-readable report
//   node scripts/scan.js example.com --live          also handshake each host on 443
//   node scripts/scan.js example.com --json > r.json machine-readable report
//   node scripts/scan.js example.com --csv           inventory as CSV
//   node scripts/scan.js example.com --fail-under C  exit 1 when readiness is below C (for CI)
//
// Set CERTSPOTTER_TOKEN for a higher Cert Spotter rate limit.
import { analyze, cleanDomain, toCSV, toReport } from '../public/lib.js';
import { lookup } from '../api/ct.js';
import { liveCheck } from './live.js';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const domain = cleanDomain(args.find((a) => !a.startsWith('-') && a !== opt('--fail-under')));
if (!domain || flag('--help') || flag('-h')) {
  console.error('Usage: node scripts/scan.js <domain> [--live] [--json | --csv] [--fail-under A|B|C|D]');
  process.exit(domain ? 0 : 2);
}
const failUnder = (opt('--fail-under') || '').toUpperCase();
const quiet = flag('--json') || flag('--csv');
const log = (...a) => { if (!quiet) console.log(...a); };

let data;
try {
  if (!quiet) process.stderr.write(`Looking up certificates for ${domain}…\n`);
  data = await lookup(domain, { token: process.env.CERTSPOTTER_TOKEN });
} catch (e) {
  console.error(`Lookup failed: ${e.message}`);
  process.exit(2);
}
const r = analyze(data.entries);
const live = flag('--live') ? await liveCheck(r, { max: 60 }) : null;

if (flag('--json')) {
  console.log(JSON.stringify(toReport(domain, r, { source: data.source, sourceErrors: data.errors, live }), null, 2));
} else if (flag('--csv')) {
  console.log(toCSV(r.lineages));
} else {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const g = r.readiness;
  const y29 = r.forecast[r.forecast.length - 1].manualRenewals;
  log(`\n47-Day Cert Radar · ${domain}`);
  log(`Sources: ${data.source}${data.errors.length ? ` (${data.errors.join('; ')})` : ''}`);
  log(`\nReadiness: ${g.grade}${g.score !== null ? ` (${g.score}/100)` : ''}`);
  for (const n of g.notes) log(`  - ${n}`);
  log(`\nLive certificates: ${r.active.length}  (probably manual ${r.manual.length}, unclear ${r.unclear.length}, automated ${r.automated.length})`);
  log(`Manual renewals a year: ${r.forecast.map((f) => `${f.maxDays}d cap ${f.manualRenewals}`).join(' → ')}`);
  log(`By March 2029: ${y29} a year, busiest month ${r.workload.peak.label} ${r.workload.peak.year} (${r.workload.peak.count})`);
  if (r.forgotten.length) {
    log('\nNeeds attention:');
    for (const l of [...r.forgotten].sort((a, b) => a.daysLeft - b.daysLeft)) {
      log(`  ${pad(l.primary, 44)} ${pad(l.issuer.name, 22)} ${l.expired ? `expired ${-l.daysLeft}d ago` : `expires in ${l.daysLeft}d`}`);
    }
  }
  if (r.manual.length) {
    log('\nProbably manual:');
    for (const l of [...r.manual].sort((a, b) => a.daysLeft - b.daysLeft)) {
      log(`  ${pad(l.primary, 44)} ${pad(l.issuer.name, 22)} in ${pad(l.daysLeft + 'd', 6)} ${l.reasons[0]}`);
    }
  }
  if (live) {
    log('\nLive TLS checks (port 443):');
    for (const [host, v] of Object.entries(live)) {
      log(`  ${pad(host, 44)} ${v.ok ? `${v.trusted ? 'trusted' : 'UNTRUSTED'}, expires ${v.validTo.slice(0, 10)} (${v.issuer})` : v.error}`);
    }
  }
  log('');
}

const order = ['A', 'B', 'C', 'D', 'F'];
if (failUnder && order.includes(failUnder) && order.indexOf(r.readiness.grade) > order.indexOf(failUnder)) {
  console.error(`Readiness ${r.readiness.grade} is below ${failUnder}.`);
  process.exit(1);
}
