// Generates public/sample.json: a realistic, fictional CT history for demos
// that must not depend on crt.sh being fast. The domain is under the reserved
// .example TLD so it can never be confused with a real organization.
import { writeFileSync } from 'node:fs';

const DOMAIN = 'stateuniversity.example';
const NOW = new Date('2026-10-03T00:00:00Z');
const DAY = 86400000;
let seed = 47;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const LE = ['C=US, O=Let\'s Encrypt, CN=R10', 'C=US, O=Let\'s Encrypt, CN=R11', 'C=US, O=Let\'s Encrypt, CN=E5'];
const GTS = ['C=US, O=Google Trust Services, CN=WR1'];
const AMZ = ['C=US, O=Amazon, CN=Amazon RSA 2048 M02'];
const DIGI = 'C=US, O=DigiCert Inc, CN=DigiCert Global G2 TLS RSA SHA256 2020 CA1';
const SECT = 'C=GB, O=Sectigo Limited, CN=Sectigo RSA Domain Validation Secure Server CA';
const INC = 'C=US, O=Internet2, CN=InCommon RSA Server CA 2';
const GODADDY = 'C=US, ST=Arizona, L=Scottsdale, O="GoDaddy.com, Inc.", CN=Go Daddy Secure Certificate Authority - G2';

const entries = [];
let id = 9000000000;
function cert(names, issuer, notBefore, days) {
  const nb = new Date(notBefore);
  const na = new Date(nb.getTime() + days * DAY - 1000);
  const serial = Math.floor(rnd() * 2 ** 48).toString(16).padStart(12, '0') + Math.floor(rnd() * 2 ** 48).toString(16);
  const base = {
    issuer_name: issuer,
    common_name: names[0],
    name_value: names.join('\n'),
    not_before: nb.toISOString().slice(0, 19),
    not_after: na.toISOString().slice(0, 19),
    serial_number: serial,
  };
  // CT logs usually carry both the precertificate and the final certificate.
  entries.push({ id: id++, entry_timestamp: base.not_before, ...base });
  if (rnd() < 0.7) entries.push({ id: id++, entry_timestamp: base.not_before, ...base });
}

function automated(names, issuers, start, jitter = 3) {
  for (let t = new Date(start).getTime(); t < NOW.getTime(); t += (60 + Math.round(rnd() * jitter)) * DAY) {
    cert(names, pick(issuers), t, 90);
  }
}
function manual(names, issuer, start, { days = 397, gapMin = 330, gapMax = 395, endBefore = NOW } = {}) {
  let t = new Date(start).getTime();
  while (t < endBefore.getTime()) {
    // After Mar 15 2026 commercial CAs could only issue 200 days.
    const d = t >= Date.parse('2026-03-15') ? 199 : days;
    cert(names, issuer, t, d);
    const gap = t >= Date.parse('2026-03-15') ? d - 10 - Math.round(rnd() * 10) : gapMin + Math.round(rnd() * (gapMax - gapMin));
    t += gap * DAY;
  }
}
const n = (s) => (s ? `${s}.${DOMAIN}` : DOMAIN);

// Automated estate: web front doors, CDN, cloud apps.
automated([n(''), n('www')], LE, '2023-06-01');
automated([n('news')], LE, '2023-07-12');
automated([n('events')], LE, '2023-08-03');
automated([n('library'), n('catalog.library')], LE, '2023-05-20');
automated([n('apply')], GTS, '2024-01-15');
automated([n('giving')], GTS, '2024-02-10');
automated([n('api')], AMZ, '2023-09-01', 0);
automated([n('static')], AMZ, '2023-09-01', 0);
for (const s of ['cs', 'math', 'physics', 'chem', 'bio', 'history', 'english', 'music', 'art', 'law', 'nursing', 'business',
  'engineering', 'education', 'athletics', 'alumni', 'housing', 'dining', 'parking', 'careers', 'research', 'grad', 'admissions',
  'financialaid', 'registrar', 'hr', 'it', 'security', 'police', 'health', 'counseling', 'map', 'calendar', 'jobs', 'store', 'museum']) {
  automated([n(s)], LE, `2023-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`);
}
// The wildcard ITS still buys every year.
manual([`*.${DOMAIN}`, DOMAIN], DIGI, '2022-11-02', { gapMin: 355, gapMax: 365 });

// Hand-renewed long-lived certs: the 2029 problem.
manual([n('mail')], INC, '2022-09-14');
// Renewed late once: the VPN went 3 days without a valid cert in January 2024.
cert([n('vpn')], INC, '2022-12-01', 397);
cert([n('vpn')], INC, '2024-01-05', 397);
cert([n('vpn')], INC, '2025-02-03', 397);
cert([n('vpn')], INC, '2026-03-01', 199);
cert([n('vpn')], INC, '2026-09-14', 199);
manual([n('sso'), n('idp')], INC, '2023-02-20');
manual([n('canvas')], DIGI, '2022-08-08');
manual([n('payroll')], DIGI, '2023-01-11');
manual([n('portal')], INC, '2022-10-30');
manual([n('webmail')], INC, '2023-03-03');
cert([n('print')], SECT, '2023-07-07', 397);
cert([n('print')], SECT, '2024-08-14', 397); // 6-day lapse
cert([n('print')], SECT, '2025-09-10', 397);
manual([n('wifi'), n('radius')], SECT, '2023-04-04');
manual([n('erp'), n('erp-test')], DIGI, '2022-06-15');
manual([n('lab-gateway.engineering')], GODADDY, '2023-05-05', { gapMin: 300, gapMax: 420 });
manual([n('door-controller.facilities')], GODADDY, '2022-12-12', { gapMin: 300, gapMax: 430 });
manual([n('hpc')], INC, '2023-06-06');
manual([n('irb')], SECT, '2023-07-07');

// Forgotten: expired recently and nobody renewed.
cert([n('staging.apply')], SECT, '2025-03-01', 365);
cert([n('staging.apply')], SECT, '2026-02-20', 199);
cert([n('old-portal')], INC, '2025-09-10', 365);
// Manual cert about to expire.
cert([n('conference')], GODADDY, '2025-10-20', 365);
cert([n('alumni-mag')], SECT, '2026-04-08', 199);
// A vendor-hosted landing page that moved from Let's Encrypt to a paid cert.
for (let i = 0; i < 6; i++) cert([n('summer')], LE[0], Date.parse('2023-03-01') + i * 60 * DAY, 90);
manual([n('summer')], GODADDY, '2024-04-15');

writeFileSync(new URL('../public/sample.json', import.meta.url), JSON.stringify(entries));
console.log(`${entries.length} CT entries for ${DOMAIN}`);
