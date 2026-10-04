// Core analysis for 47-Day Cert Radar. Pure functions, shared by the browser,
// the CLI, the GitHub Actions monitor and the Node tests. Input is the crt.sh
// JSON shape:
//   { id, issuer_name, common_name, name_value, not_before, not_after, serial_number, entry_timestamp }

const DAY = 86400000;

// CA/Browser Forum Ballot SC-081v3. Maximum certificate validity and the
// maximum age of reused domain validation (DCV) on each date.
export const SCHEDULE = [
  { label: 'Before Mar 2026', from: '2015-01-01', maxDays: 398, dcvDays: 398 },
  { label: 'Mar 15, 2026', from: '2026-03-15', maxDays: 200, dcvDays: 200 },
  { label: 'Mar 15, 2027', from: '2027-03-15', maxDays: 100, dcvDays: 100 },
  { label: 'Mar 15, 2029', from: '2029-03-15', maxDays: 47, dcvDays: 10 },
];

export function currentStep(now = new Date()) {
  let step = SCHEDULE[0];
  for (const s of SCHEDULE) if (now >= new Date(s.from + 'T00:00:00Z')) step = s;
  return step;
}

// Issuer catalogue. kind:
//   automated  - issued through ACME or a cloud/CDN that renews on its own
//   hosting    - issued by a hosting panel's auto-SSL (cPanel, Plesk partners, ...)
//   commercial - a paid CA; `acme` says whether that CA sells an ACME service
const ISSUERS = [
  [/let'?s ?encrypt/i, "Let's Encrypt", 'automated'],
  [/zerossl/i, 'ZeroSSL', 'automated'],
  [/google trust services|O=Google Trust|\bGTS CA\b/i, 'Google Trust Services', 'automated'],
  [/O=Amazon\b|Amazon RSA|Amazon ECDSA|Amazon RSA 2048/i, 'Amazon (ACM)', 'automated'],
  [/cloudflare/i, 'Cloudflare', 'automated'],
  [/microsoft azure/i, 'Microsoft Azure', 'automated'],
  [/buypass/i, 'Buypass', 'automated'],
  [/certainly/i, 'Certainly (Fastly)', 'automated'],
  [/cpanel/i, 'cPanel AutoSSL', 'hosting'],
  [/encryption everywhere/i, 'DigiCert Encryption Everywhere', 'hosting'],
  [/thawte/i, 'Thawte (DigiCert)', 'commercial', true],
  [/geotrust/i, 'GeoTrust (DigiCert)', 'commercial', true],
  [/rapidssl/i, 'RapidSSL (DigiCert)', 'commercial', true],
  [/digicert/i, 'DigiCert', 'commercial', true],
  [/internet2|incommon/i, 'InCommon (Sectigo)', 'commercial', true],
  [/geant|terena/i, 'GÉANT TCS', 'commercial', true],
  [/sectigo|comodo|usertrust/i, 'Sectigo', 'commercial', true],
  [/globalsign/i, 'GlobalSign', 'commercial', true],
  [/entrust/i, 'Entrust', 'commercial', true],
  [/ssl\.com/i, 'SSL.com', 'commercial', true],
  [/harica/i, 'HARICA', 'commercial', true],
  [/actalis/i, 'Actalis', 'commercial', true],
  [/godaddy|starfield/i, 'GoDaddy', 'commercial', false],
  [/certum/i, 'Certum', 'commercial', false],
];

export function issuerInfo(issuerName = '') {
  for (const [re, name, kind, acme] of ISSUERS) {
    if (re.test(issuerName)) return { name, kind, acme: kind === 'commercial' ? Boolean(acme) : true };
  }
  const o = /O=("?)([^,"]+)\1/.exec(issuerName);
  const cn = /CN=("?)([^,"]+)\1/.exec(issuerName);
  return { name: (o && o[2]) || (cn && cn[2]) || 'Unknown CA', kind: 'commercial', acme: false };
}

const parseDate = (s) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');

export function normalizeHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.$/, '');
}

// Convert Cert Spotter's issuance objects to the crt.sh shape.
export function fromCertSpotter(items) {
  return (items || []).map((i) => ({
    id: i.id,
    issuer_name: (i.issuer && (i.issuer.name || i.issuer.friendly_name)) || '',
    name_value: (i.dns_names || []).join('\n'),
    not_before: i.not_before,
    not_after: i.not_after,
    serial_number: i.cert_sha256 || i.tbs_sha256 || i.id,
    source: 'certspotter',
  }));
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
    const notBefore = parseDate(e.not_before);
    const notAfter = parseDate(e.not_after);
    if (isNaN(notBefore) || isNaN(notAfter)) continue;
    // Same names and same validity window = same certificate, whichever log or
    // source reported it (precertificates and final certs, crt.sh and Cert Spotter).
    const key = [...new Set(names)].sort().join(' ') + '|' + notBefore.getTime() + '|' + notAfter.getTime();
    const prev = bySerial.get(key);
    if (prev) {
      // Prefer the crt.sh record: it links to a viewable certificate page and a full issuer DN.
      if (!prev.crtsh && e.source !== 'certspotter' && typeof e.id === 'number') {
        prev.crtsh = e.id;
        prev.issuerName = issuer || prev.issuerName;
        prev.issuer = issuerInfo(prev.issuerName);
      }
      continue;
    }
    bySerial.set(key, {
      id: e.id,
      crtsh: e.source !== 'certspotter' && typeof e.id === 'number' ? e.id : null,
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

// What a hostname is probably for. Certificates on these are the ones most
// often installed by hand, and each has its own automation story.
const ROLES = [
  [/^(mail|smtp|imap|pop3?|webmail|owa|autodiscover|exchange|mx\d*|email)$/, 'Mail server',
    'Mail servers often get their certs by hand. win-acme automates Exchange; certbot or acme.sh with a deploy hook covers Postfix and Dovecot.'],
  [/^(vpn|remote|gateway|gw|fw|firewall|sslvpn|anyconnect|globalprotect|fortigate|citrix|netscaler|rdweb|rdgateway)$/, 'VPN or remote access',
    'Appliances are the hardest certs to automate. Check whether your vendor firmware supports ACME (several now do); if not, script the upload through the vendor API.'],
  [/^(sso|idp|adfs|login|auth|okta|shibboleth|cas|saml|identity|sts|fs)$/, 'Single sign-on',
    'If this cert lapses, nobody can log in to anything. Automate it first and give it two owners. Remember that SAML partners may pin the signing cert, which is separate from this TLS cert.'],
  [/^(erp|payroll|hr|sap|oracle|peoplesoft|banner|workday|finance|crm)$/, 'Business system',
    'Often hosted or managed by a vendor. Find out who renews it and put that in the contract or runbook.'],
  [/^(staging|stage|stg|test|dev|uat|qa|sandbox|preprod|demo|beta|old|legacy)(-|\d|$)/, 'Non-production',
    'Easy to forget and often internet-facing. Automate it, or retire it and let the cert lapse on purpose.'],
  [/^(print|printer|door|door-controller|camera|nvr|ipmi|idrac|ilo|bmc|ups|pdu|scada|hvac|badge|lab-gateway)$/, 'Device or appliance',
    'Embedded devices rarely speak ACME. Put them behind a reverse proxy that does, or schedule the manual swap with a named owner.'],
  [/^(api|apis|ws|graphql|grpc)$/, 'API endpoint',
    'Check whether any client pins this certificate or its intermediate before you shorten lifetimes.'],
];

export function roleHint(host) {
  const first = String(host || '').replace(/^\*\./, '').split('.')[0];
  for (const [re, role, tip] of ROLES) if (re.test(first)) return { role, tip };
  return null;
}

// Chrome stopped trusting Entrust TLS certs whose earliest SCT is after this date.
const ENTRUST_DISTRUST = new Date('2024-11-12T00:00:00Z');

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
    const latest = list.reduce((a, b) => (b.notAfter > a.notAfter ? b : a));
    const recent = list.filter((c) => now - c.notBefore < 3 * 365 * DAY);
    const sample = recent.length ? recent : [latest];

    // Renewal chain: one cert per issue day (same-day reissues collapse).
    const chain = [];
    for (const c of list) {
      const last = chain[chain.length - 1];
      if (last && Math.abs(c.notBefore - last.notBefore) < 3 * DAY) {
        if (c.notAfter > last.notAfter) chain[chain.length - 1] = c;
      } else chain.push(c);
    }
    const intervals = [];
    const leads = [];
    const gaps = [];
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1];
      const cur = chain[i];
      intervals.push((cur.notBefore - prev.notBefore) / DAY);
      const lead = (prev.notAfter - cur.notBefore) / DAY; // days left on the old cert at renewal
      leads.push(lead);
      // A gap between one cert expiring and the next being issued. Long gaps
      // usually mean the name was idle, so only short ones count as lapses.
      if (lead < -0.5 && lead > -90 && now - cur.notBefore < 3 * 365 * DAY) {
        gaps.push({ from: prev.notAfter, to: cur.notBefore, days: Math.round(-lead) });
      }
    }
    const recentIntervals = intervals.slice(-6);
    const medianValidity = median(sample.map((c) => c.validityDays));
    const medianInterval = median(recentIntervals);
    const medianLead = median(leads.slice(-6));
    const mean = recentIntervals.reduce((a, b) => a + b, 0) / (recentIntervals.length || 1);
    const spread = recentIntervals.length
      ? Math.sqrt(recentIntervals.reduce((a, b) => a + (b - mean) ** 2, 0) / recentIntervals.length)
      : 0;
    const irregular = recentIntervals.length >= 3 && Math.max(...recentIntervals) - Math.min(...recentIntervals) > 45;
    const regular = recentIntervals.length >= 3 && mean > 0 && spread / mean < 0.08;

    const reasons = [];
    let score = 0; // >0 leans manual, <0 leans automated
    const iss = latest.issuer;
    if (iss.kind === 'automated') {
      score -= 3;
      reasons.push(`${iss.name} issues through ACME or managed auto-renewal`);
    } else if (iss.kind === 'hosting') {
      score -= 3;
      reasons.push(`${iss.name} is renewed by the hosting provider`);
    } else if (iss.acme && medianValidity && medianValidity <= 100) {
      score -= 2;
      reasons.push(`short certs from ${iss.name} usually mean its ACME service is in use`);
    } else {
      score += 2;
      reasons.push(
        iss.acme
          ? `${iss.name} sells ACME, but nothing in this history suggests it is used`
          : `${iss.name} is a commercial CA with no public ACME service`,
      );
    }
    if (medianValidity >= 300) {
      score += 2;
      reasons.push(`certs run about ${Math.round(medianValidity)} days, close to the old 398-day maximum`);
    } else if (medianValidity >= 150) {
      score += 1;
      reasons.push(`certs run about ${Math.round(medianValidity)} days`);
    } else if (medianValidity <= 100) {
      score -= 1;
      reasons.push(`short ${Math.round(medianValidity)}-day certs suggest automation`);
    }
    if (irregular) {
      score += 1;
      reasons.push('renewal dates are irregular');
    } else if (regular) {
      score -= 1;
      reasons.push(`renews on a steady ${Math.round(mean)}-day rhythm, like a scheduled job`);
    }
    if (medianInterval && medianInterval > 250) {
      score += 1;
      reasons.push(`renewed about once every ${Math.round(medianInterval)} days`);
    }
    const lastMinute = leads.length >= 1 && medianLead !== null && medianLead < 7;
    if (lastMinute) {
      score += 1;
      reasons.push(
        medianLead < 0
          ? 'usually renewed after the old cert had already expired'
          : `usually renewed only ${Math.max(0, Math.round(medianLead))} days before expiry`,
      );
    } else if (medianLead !== null && medianLead >= 20 && medianValidity <= 100) {
      score -= 1;
      reasons.push(`renewed about ${Math.round(medianLead)} days early, the way ACME clients do`);
    }
    if (gaps.length) {
      score += 1;
      reasons.push(`${gaps.length} past gap${gaps.length > 1 ? 's' : ''} between expiry and renewal`);
    }
    const everAutomated = list.some((c) => c.issuer.kind !== 'commercial');
    if (iss.kind === 'commercial' && everAutomated && score > 0) {
      score += 1;
      reasons.push('switched away from an automated CA');
    }

    const automation = score >= 2 ? 'manual' : score <= -2 ? 'automated' : 'unclear';
    const daysLeft = Math.floor((latest.notAfter - now) / DAY);
    const expired = daysLeft < 0;
    // An expired lineage is either retired or forgotten. Retired ones are
    // noise, so only recent expiries are worth flagging.
    const stale = expired && daysLeft > -120;
    const primary = pickPrimary(latest.names);
    const flags = [];
    if (iss.name === 'Entrust' && latest.notBefore >= ENTRUST_DISTRUST && !expired) {
      flags.push({ kind: 'distrust', text: 'Chrome no longer trusts Entrust certificates issued after November 11, 2024' });
    }
    if (latest.names.some((n) => n.startsWith('*.'))) flags.push({ kind: 'wildcard', text: 'Wildcard: one renewal, many servers to update' });

    lineages.push({
      key,
      names: latest.names,
      primary,
      role: roleHint(primary),
      certs: list,
      chain,
      latest,
      issuer: iss,
      automation,
      score,
      reasons,
      medianValidity,
      medianInterval,
      medianLead,
      gaps,
      lastMinute,
      flags,
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
  return [...pool].sort((a, b) => a.split('.').length - b.split('.').length || a.length - b.length || a.localeCompare(b))[0];
}

// Practical next steps for one certificate, most important first.
export function guidance(l) {
  const out = [];
  if (l.expired) {
    out.push(l.stale
      ? 'Check whether anything still answers on this name. If it does, it is serving an expired or different certificate; if not, remove the DNS record so it cannot be taken over.'
      : 'Expired long ago. If the name is retired, remove its DNS record.');
    return out;
  }
  if (l.flags.some((f) => f.kind === 'distrust')) {
    out.push('Replace this certificate now: Chrome shows an error for Entrust certificates issued after November 11, 2024. Sectigo took over Entrust public TLS customers.');
  }
  if (l.automation === 'automated') {
    out.push('Looks automated. Make sure renewal failures alert a person, since a silent ACME failure is the new way certs expire.');
    return out;
  }
  if (l.issuer.acme) {
    out.push(`${l.issuer.name} offers ACME, usually with External Account Binding (EAB) keys from your account portal. You can keep your contract and point certbot, acme.sh, win-acme or cert-manager at it.`);
  } else {
    out.push(`${l.issuer.name} has no public ACME service. Moving this name to an ACME CA (Let's Encrypt, Google Trust Services, or a paid CA with ACME) removes the manual step.`);
  }
  if (l.names.some((n) => n.startsWith('*.'))) {
    out.push('Wildcards need DNS-01 validation, so automation needs API access to your DNS provider. Splitting the wildcard into per-host certs also limits the blast radius of a leaked key.');
  }
  if (l.role) out.push(l.role.tip);
  if (l.gaps.length) {
    const g = l.gaps[l.gaps.length - 1];
    out.push(`This name went ${g.days} day${g.days > 1 ? 's' : ''} without a valid certificate in ${g.from.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}. If the host was serving traffic then, that was an outage.`);
  }
  if (l.lastMinute) out.push('Renewals happen at the last minute. Under a 47-day cap there is no slack left for that habit.');
  out.push('In 2029, domain validation can only be reused for 10 days, so each manual renewal will also need a fresh DNS or HTTP validation.');
  return out;
}

// Spread each manual cert's 2029-30 renewals over the year to show the
// monthly load and the busiest month.
export function workload2029(manual, unclear = []) {
  const start = Date.parse('2029-03-15T00:00:00Z');
  const end = start + 365 * DAY;
  const every = 47 - 7;
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + i, 1);
    return { label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), year: d.getUTCFullYear(), month: d.getUTCMonth(), count: 0 };
  });
  const add = (l, weight) => {
    // Phase each lineage by its current expiry day so renewals don't all collide.
    const phase = Math.floor(l.latest.notAfter.getTime() / DAY) % every;
    for (let t = start + phase * DAY; t < end; t += every * DAY) {
      const d = new Date(t);
      const m = months.find((x) => x.year === d.getUTCFullYear() && x.month === d.getUTCMonth());
      if (m) m.count += weight;
    }
  };
  for (const l of manual) add(l, 1);
  for (const l of unclear) add(l, 0.5);
  for (const m of months) m.count = Math.round(m.count);
  const peak = months.reduce((a, b) => (b.count > a.count ? b : a), months[0]);
  return { months, peak };
}

// 47-day readiness: a letter grade with the reasons behind it.
export function readiness({ active, manual, unclear, forgotten, lineages }) {
  if (!active.length) return { grade: '–', score: null, notes: ['No live certificates to grade.'] };
  const notes = [];
  let score = 100;
  const share = (manual.length + 0.5 * unclear.length) / active.length;
  const sharePenalty = Math.round(55 * share);
  score -= sharePenalty;
  if (sharePenalty) notes.push(`${Math.round(share * 100)}% of live certificates look hand-renewed (−${sharePenalty})`);
  const f = Math.min(20, 5 * forgotten.length);
  score -= f;
  if (f) notes.push(`${forgotten.length} need${forgotten.length === 1 ? 's' : ''} attention now (−${f})`);
  const gapLineages = lineages.filter((l) => l.gaps.length).length;
  const g = Math.min(15, 5 * gapLineages);
  score -= g;
  if (g) notes.push(`${gapLineages} lapsed between expiry and renewal in the last 3 years (−${g})`);
  const lm = active.filter((l) => l.lastMinute).length;
  const m = Math.min(10, 2 * lm);
  score -= m;
  if (m) notes.push(`${lm} usually renew${lm === 1 ? 's' : ''} at the last minute (−${m})`);
  const distrusted = active.filter((l) => l.flags.some((x) => x.kind === 'distrust')).length;
  if (distrusted) {
    score -= 10;
    notes.push(`${distrusted} distrusted Entrust certificate${distrusted > 1 ? 's' : ''} (−10)`);
  }
  score = Math.max(0, score);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 65 ? 'C' : score >= 50 ? 'D' : 'F';
  if (!notes.length) notes.push('Everything here looks automated and renewed on time.');
  return { grade, score, notes };
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
    const per = (l) => renewalsPerYear(today && l.medianValidity ? Math.min(l.medianValidity, 398) : step.maxDays, true);
    const total = manual.reduce((s, l) => s + per(l), 0) + unclear.reduce((s, l) => s + 0.5 * per(l), 0);
    return { ...step, perCert, manualRenewals: Math.round(total) };
  });

  const expiringSoon = active.filter((l) => l.daysLeft <= 30);
  // A recently expired lineage only counts as forgotten when no live cert still
  // covers its names (renewals sometimes add or drop a SAN and start a new
  // lineage). Exact names only: a wildcard on file doesn't mean the host serves it.
  const covered = (name) => hosts.has(name);
  const forgotten = lineages.filter(
    (l) =>
      (l.stale && !l.names.some(covered)) ||
      (!l.expired && l.automation !== 'automated' && l.daysLeft <= 30) ||
      (!l.expired && l.flags.some((f) => f.kind === 'distrust')),
  );

  const issuers = {};
  for (const l of active) issuers[l.issuer.name] = (issuers[l.issuer.name] || 0) + 1;

  const out = {
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
    gaps: lineages.reduce((s, l) => s + l.gaps.length, 0),
    workload: workload2029(manual, unclear),
  };
  out.readiness = readiness(out);
  return out;
}

// Small, storable summary of a scan, used to show what changed next time.
export function snapshot(result, at = new Date()) {
  const lineages = {};
  // Live certificates only, so a scan with history and one without compare cleanly.
  for (const l of result.active) lineages[l.key] = l.latest.notAfter.toISOString().slice(0, 10);
  return { at: at.toISOString(), grade: result.readiness.grade, lineages };
}

export function diffSnapshots(prev, next) {
  if (!prev) return null;
  const added = [];
  const renewed = [];
  const gone = [];
  for (const [k, exp] of Object.entries(next.lineages)) {
    if (!(k in prev.lineages)) added.push(k);
    else if (exp > prev.lineages[k]) renewed.push(k);
  }
  for (const k of Object.keys(prev.lineages)) if (!(k in next.lineages)) gone.push(k);
  return { since: prev.at, prevGrade: prev.grade, added, renewed, gone };
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
  const rows = [['primary_name', 'all_names', 'issuer', 'renewal', 'expires', 'days_left', 'typical_validity_days', 'past_gaps', 'role', 'owner']];
  for (const l of lineages) {
    rows.push([
      l.primary,
      l.names.join(' '),
      l.issuer.name,
      l.automation,
      l.latest.notAfter.toISOString().slice(0, 10),
      l.daysLeft,
      Math.round(l.medianValidity || 0),
      l.gaps.length,
      l.role ? l.role.role : '',
      owners[l.key] || '',
    ]);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

// Machine-readable report (CLI --json, the JSON export, the monitor).
export function toReport(domain, r, extra = {}) {
  return {
    domain,
    generatedAt: new Date().toISOString(),
    ...extra,
    readiness: r.readiness,
    counts: {
      certificates: r.totalCerts,
      liveLineages: r.active.length,
      manual: r.manual.length,
      unclear: r.unclear.length,
      automated: r.automated.length,
      needAttention: r.forgotten.length,
      pastGaps: r.gaps,
    },
    forecast: r.forecast.map((f) => ({ from: f.from, maxDays: f.maxDays, manualRenewalsPerYear: f.manualRenewals })),
    busiestMonth2029: r.workload.peak,
    certificates: r.lineages.map((l) => ({
      primary: l.primary,
      names: l.names,
      issuer: l.issuer.name,
      renewal: l.automation,
      reasons: l.reasons,
      expires: l.latest.notAfter.toISOString(),
      daysLeft: l.daysLeft,
      typicalValidityDays: l.medianValidity && Math.round(l.medianValidity),
      pastGaps: l.gaps.map((g) => ({ from: g.from.toISOString(), to: g.to.toISOString(), days: g.days })),
      role: l.role && l.role.role,
      flags: l.flags.map((f) => f.text),
    })),
  };
}

export function cleanDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(d)) return null;
  return d;
}
