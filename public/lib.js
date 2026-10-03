// Core analysis for 47-Day Cert Radar. Pure functions, shared by the browser
// and the Node tests. Input is the crt.sh JSON shape:
//   { id, issuer_name, common_name, name_value, not_before, not_after, serial_number, entry_timestamp }

const DAY = 86400000;

// CA/Browser Forum Ballot SC-081v3 maximum validity schedule.
export const SCHEDULE = [
  { label: 'Before Mar 2026', from: '2015-01-01', maxDays: 398 },
  { label: 'Mar 15, 2026', from: '2026-03-15', maxDays: 200 },
  { label: 'Mar 15, 2027', from: '2027-03-15', maxDays: 100 },
  { label: 'Mar 15, 2029', from: '2029-03-15', maxDays: 47 },
];

// Issuers that are issued through ACME or a cloud-managed auto-renewal flow.
const AUTOMATED_ISSUERS = [
  [/let'?s ?encrypt/i, "Let's Encrypt"],
  [/zerossl/i, 'ZeroSSL'],
  [/google trust services|\bGTS\b|O=Google Trust/i, 'Google Trust Services'],
  [/O=Amazon\b|Amazon RSA|Amazon ECDSA/i, 'Amazon (ACM)'],
  [/cloudflare/i, 'Cloudflare'],
  [/buypass/i, 'Buypass'],
  [/microsoft azure/i, 'Microsoft Azure'],
];

const COMMERCIAL_ISSUERS = [
  [/digicert/i, 'DigiCert'],
  [/sectigo|comodo|usertrust/i, 'Sectigo'],
  [/godaddy|starfield/i, 'GoDaddy'],
  [/globalsign/i, 'GlobalSign'],
  [/entrust/i, 'Entrust'],
  [/thawte/i, 'Thawte'],
  [/geotrust/i, 'GeoTrust'],
  [/rapidssl/i, 'RapidSSL'],
  [/ssl\.com/i, 'SSL.com'],
  [/certum/i, 'Certum'],
  [/harica/i, 'HARICA'],
  [/internet2|incommon/i, 'InCommon'],
  [/geant|terena/i, 'GÉANT/TERENA'],
  [/actalis/i, 'Actalis'],
];

export function issuerInfo(issuerName = '') {
  for (const [re, name] of AUTOMATED_ISSUERS) if (re.test(issuerName)) return { name, kind: 'automated' };
  for (const [re, name] of COMMERCIAL_ISSUERS) if (re.test(issuerName)) return { name, kind: 'commercial' };
  const o = /O=("?)([^,"]+)\1/.exec(issuerName);
  const cn = /CN=("?)([^,"]+)\1/.exec(issuerName);
  return { name: (o && o[2]) || (cn && cn[2]) || 'Unknown CA', kind: 'commercial' };
}

const parseDate = (s) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');

export function normalizeHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

// Collapse precertificate + final certificate duplicates and parse fields.
export function normalizeEntries(entries) {
  const bySerial = new Map();
  for (const e of entries || []) {
    const names = String(e.name_value || e.common_name || '')
      .split(/\n|,/)
      .map(normalizeHost)
      .filter((n) => n && n.includes('.') && !n.includes(' ') && !n.includes('@'));
    if (!names.length) continue;
    const issuer = e.issuer_name || '';
    const key = (e.serial_number || e.id) + '|' + issuer;
    const prev = bySerial.get(key);
    if (prev) {
      for (const n of names) if (!prev.names.includes(n)) prev.names.push(n);
      continue;
    }
    const notBefore = parseDate(e.not_before);
    const notAfter = parseDate(e.not_after);
    if (isNaN(notBefore) || isNaN(notAfter)) continue;
    bySerial.set(key, {
      id: e.id,
      serial: e.serial_number || String(e.id),
      issuerName: issuer,
      issuer: issuerInfo(issuer),
      names: [...new Set(names)].sort(),
      notBefore,
      notAfter,
      validityDays: Math.round((notAfter - notBefore) / DAY),
    });
  }
  return [...bySerial.values()].sort((a, b) => a.notBefore - b.notBefore);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Renewals a year a single certificate needs under a maximum validity, assuming
// the usual practice of renewing with roughly a third of the lifetime left
// (what ACME clients do) for automated certs, and about a week of safety margin
// for manual ones.
export function renewalsPerYear(maxDays, manual = true) {
  const effective = manual ? Math.max(maxDays - 7, maxDays * 0.8) : maxDays * (2 / 3);
  return 365 / effective;
}

// A "lineage" is one logical certificate: the same set of names, renewed over time.
export function buildLineages(certs, now = new Date()) {
  const groups = new Map();
  for (const c of certs) {
    const key = c.names.join(' ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const lineages = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.notBefore - b.notBefore);
    const latest = list[list.length - 1];
    const recent = list.filter((c) => now - c.notBefore < 3 * 365 * DAY);
    const sample = recent.length ? recent : [latest];
    const intervals = [];
    for (let i = 1; i < list.length; i++) {
      const d = (list[i].notBefore - list[i - 1].notBefore) / DAY;
      if (d > 3) intervals.push(d); // ignore same-day reissues
    }
    const medianValidity = median(sample.map((c) => c.validityDays));
    const medianInterval = median(intervals.slice(-6));
    const irregular =
      intervals.length >= 3 &&
      Math.max(...intervals.slice(-6)) - Math.min(...intervals.slice(-6)) > 45;

    const reasons = [];
    let score = 0; // >0 leans manual, <0 leans automated
    if (latest.issuer.kind === 'automated') {
      score -= 3;
      reasons.push(`${latest.issuer.name} issues via ACME or managed auto-renewal`);
    } else {
      score += 2;
      reasons.push(`${latest.issuer.name} is a commercial CA with no ACME history here`);
    }
    if (medianValidity >= 300) {
      score += 2;
      reasons.push(`certs run ~${Math.round(medianValidity)} days, near the old 398-day maximum`);
    } else if (medianValidity >= 150) {
      score += 1;
      reasons.push(`certs run ~${Math.round(medianValidity)} days`);
    } else if (medianValidity <= 100) {
      score -= 1;
      reasons.push(`short ${Math.round(medianValidity)}-day certs suggest automation`);
    }
    if (irregular) {
      score += 1;
      reasons.push('renewal dates are irregular');
    }
    if (medianInterval && medianInterval > 250) {
      score += 1;
      reasons.push(`renewed about every ${Math.round(medianInterval)} days`);
    }
    const everAutomated = list.some((c) => c.issuer.kind === 'automated');
    if (latest.issuer.kind !== 'automated' && everAutomated) {
      score += 1;
      reasons.push('switched away from an automated CA');
    }

    const automation = score >= 2 ? 'manual' : score <= -2 ? 'automated' : 'unclear';
    const daysLeft = Math.floor((latest.notAfter - now) / DAY);
    const expired = daysLeft < 0;
    // An expired lineage that hasn't been renewed in the last 30 days is either
    // retired or forgotten. Retired ones are noise, so only flag recent ones.
    const stale = expired && daysLeft > -120;

    lineages.push({
      key,
      names: latest.names,
      primary: pickPrimary(latest.names),
      certs: list,
      latest,
      issuer: latest.issuer,
      automation,
      reasons,
      medianValidity,
      medianInterval,
      daysLeft,
      expired,
      stale,
    });
  }
  return lineages;
}

function pickPrimary(names) {
  const plain = names.filter((n) => !n.startsWith('*.'));
  const pool = plain.length ? plain : names;
  return [...pool].sort((a, b) => a.split('.').length - b.split('.').length || a.length - b.length)[0];
}

export function analyze(entries, now = new Date()) {
  const certs = normalizeEntries(entries);
  const lineages = buildLineages(certs, now);
  const active = lineages.filter((l) => !l.expired);
  const manual = active.filter((l) => l.automation === 'manual');
  const unclear = active.filter((l) => l.automation === 'unclear');
  const automated = active.filter((l) => l.automation === 'automated');

  const hosts = new Set();
  for (const l of active) for (const n of l.names) hosts.add(n);

  // Forecast: manual work under each step of the schedule. "Unclear" lineages
  // count as half, so the headline number is a defensible estimate, not a max.
  const forecast = SCHEDULE.map((step) => {
    const perCert = renewalsPerYear(step.maxDays, true);
    const today = step.maxDays === 398;
    const manualRenewals = manual.reduce((sum, l) => {
      // Before the cut-overs, use what the team actually does today.
      const observed = today && l.medianValidity ? Math.min(l.medianValidity, 398) : step.maxDays;
      return sum + renewalsPerYear(observed, true);
    }, 0);
    const unclearRenewals = unclear.reduce((sum, l) => {
      const observed = today && l.medianValidity ? Math.min(l.medianValidity, 398) : step.maxDays;
      return sum + 0.5 * renewalsPerYear(observed, true);
    }, 0);
    return {
      ...step,
      perCert,
      manualRenewals: Math.round(manualRenewals + unclearRenewals),
    };
  });

  const expiringSoon = active.filter((l) => l.daysLeft <= 30);
  // A recently expired lineage only counts as forgotten when no live cert still
  // covers its names (renewals sometimes add or drop a SAN and start a new lineage).
  // Exact names only: a wildcard on file doesn't mean the host is serving it.
  const covered = (name) => hosts.has(name);
  const forgotten = lineages.filter(
    (l) =>
      (l.stale && !l.names.some(covered)) ||
      (!l.expired && l.automation !== 'automated' && l.daysLeft <= 30),
  );

  const issuers = {};
  for (const l of active) issuers[l.issuer.name] = (issuers[l.issuer.name] || 0) + 1;

  return {
    totalCerts: certs.length,
    lineages,
    active,
    manual,
    unclear,
    automated,
    hosts: [...hosts].sort(),
    forecast,
    expiringSoon,
    forgotten,
    issuers,
  };
}

// Minimal iCalendar export: one all-day reminder 14 days before each expiry.
export function toICS(lineages, owners = {}, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const esc = (s) => String(s).replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//47-Day Cert Radar//EN', 'CALSCALE:GREGORIAN'];
  for (const l of lineages) {
    if (l.expired) continue;
    const remind = new Date(l.latest.notAfter.getTime() - 14 * DAY);
    const day = remind < now ? now : remind;
    const next = new Date(day.getTime() + DAY);
    const owner = owners[l.key] ? ` (owner: ${owners[l.key]})` : '';
    lines.push(
      'BEGIN:VEVENT',
      `UID:${l.latest.serial}-${ymd(day)}@cert-radar`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(day)}`,
      `DTEND;VALUE=DATE:${ymd(next)}`,
      `SUMMARY:${esc(`Renew TLS cert: ${l.primary}${owner}`)}`,
      `DESCRIPTION:${esc(
        `Expires ${l.latest.notAfter.toISOString().slice(0, 10)}. Issuer: ${l.issuer.name}. Names: ${l.names.join(', ')}. Renewal looks ${l.automation}.`,
      )}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function toCSV(lineages, owners = {}) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['primary_name', 'all_names', 'issuer', 'renewal', 'expires', 'days_left', 'typical_validity_days', 'owner']];
  for (const l of lineages) {
    rows.push([
      l.primary,
      l.names.join(' '),
      l.issuer.name,
      l.automation,
      l.latest.notAfter.toISOString().slice(0, 10),
      l.daysLeft,
      Math.round(l.medianValidity || 0),
      owners[l.key] || '',
    ]);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

export function cleanDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(d)) return null;
  return d;
}
