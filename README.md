# 47-Day Cert Radar

Enter a domain and see every public TLS certificate issued for it, which ones are still renewed by hand, how often they lapsed in the past, and how much renewal work the new validity caps will add.

**Live app:** https://perezamadorluisenrique-gif.github.io/cert-radar/ · [demo university](https://perezamadorluisenrique-gif.github.io/cert-radar/?d=demo)

## Why

In April 2025 the CA/Browser Forum passed Ballot SC-081v3, with Apple, Google, Mozilla and Microsoft voting in favour. Certificate lifetimes and the reuse of domain validation shrink on a fixed schedule:

| From | Max certificate lifetime | Domain validation reuse | Renewals a year per cert |
| --- | --- | --- | --- |
| before Mar 15, 2026 | 398 days | 398 days | about 1 |
| Mar 15, 2026 | 200 days | 200 days | about 2 |
| Mar 15, 2027 | 100 days | 100 days | about 4 |
| Mar 15, 2029 | 47 days | 10 days | about 9 |

A task that used to happen once a year happens about nine times a year, and from 2029 each renewal also needs a fresh DNS or HTTP validation. Automated (ACME) certificates don't care. The ones that break are the forgotten, hand-renewed certs: a staging subdomain, a vendor landing page, the VPN appliance someone installed a cert on three years ago. Cert Radar finds those before they fail.

Enterprise certificate lifecycle tools (Keyfactor, Venafi/CyberArk, DigiCert Trust Lifecycle) solve this for large companies. Expiry monitors such as UptimeRobot only alert on hosts you already know about. Cert Radar does discovery, manual-renewal detection and a forecast for free, with no sign-up, which is what small teams, universities and agencies need.

## What it does

- **Discover.** Asks [Cert Spotter](https://sslmate.com/certspotter/) for every certificate valid today for the domain and its subdomains, then [crt.sh](https://crt.sh) for the full Certificate Transparency history when it is available. Duplicates across logs and sources are merged, and renewals of the same set of names become one *lineage*.
- **Classify** each lineage as *probably manual*, *unclear* or *automated*, with the reasons shown:
  - the issuer: ACME and cloud CAs (Let's Encrypt, Google Trust Services, ZeroSSL, Amazon, Cloudflare, Azure, cPanel AutoSSL…) versus commercial CAs, and whether that CA sells ACME;
  - lifetime close to the maximum, renewing roughly once a year, irregular renewal dates;
  - **renewal lead time**: ACME clients renew about a third of the way before expiry, people renew days before (or after) it;
  - a steady renewal rhythm, which looks like a scheduled job.
- **Find past lapses**: times a certificate expired before its replacement was issued. If the host was serving traffic, that was an outage.
- **Grade 47-day readiness** from A to F, with the deductions listed.
- **Forecast** manual renewals a year under each cap, and the month-by-month load in the first 47-day year.
- **Explain each certificate**: renewal history chart, why it got its label, and what to do. Advice depends on the CA (ACME with EAB keys for DigiCert, Sectigo, GlobalSign and others), wildcards (DNS-01), and what the host is for (mail, VPN, SSO, appliances, non-production).
- **Flag** hand-renewed certs expiring within 30 days, recently expired names nobody replaced, and Entrust certificates that Chrome no longer trusts.
- **Remember** what changed since your last scan of a domain, and who owns each certificate (stored in your browser).
- **Export** CSV, JSON, calendar reminders (`.ics`, 14 days before each non-automated expiry) or a printed report.

## Watch your own domains for free

The repository includes a daily monitor that runs on GitHub Actions, so you get scheduled scans, live TLS checks and alerts with no server:

1. Fork this repository and turn on GitHub Pages (Settings → Pages → Source: **GitHub Actions**).
2. Edit [`watchlist.txt`](watchlist.txt): one domain per line, with `alert` after the ones you want alerts for.
3. Every day at 06:17 UTC the Pages workflow scans each domain, handshakes up to 40 hosts on port 443, and publishes the results. They appear as cards on your site and load instantly, with live results, when you open a watched domain.
4. For `alert` domains, it opens an issue when a certificate is within 14 days of expiry, a host serves an untrusted or expiring certificate, or a distrusted Entrust certificate is found. The issue updates daily and closes itself once the problem is gone. GitHub emails you about new issues.

Optional: add a `CERTSPOTTER_TOKEN` repository secret (free SSLMate account) for higher Cert Spotter limits. GitHub pauses scheduled workflows after 60 days without commits; any commit, or re-enabling the workflow, restarts them.

## Command line and CI

```bash
node scripts/scan.js example.com                  # readable report
node scripts/scan.js example.com --live           # plus TLS handshakes on port 443
node scripts/scan.js example.com --json > r.json  # full machine-readable report
node scripts/scan.js example.com --csv            # inventory
node scripts/scan.js example.com --fail-under C   # exit 1 when readiness is below C
```

No dependencies, Node 18 or newer.

## Run locally

```bash
npm test          # unit tests, including the monitor with stubbed network calls
npm run dev       # http://localhost:3000 with the API, so "Check live hosts" works
```

Browser tests (mocked CT sources) need Playwright: `npm i --no-save playwright && BASE=http://localhost:3000 npm run test:browser`.

## How it is hosted

- **GitHub Pages.** `.github/workflows/pages.yml` runs the tests, scans the watchlist and publishes `public/` on every push and once a day. In the browser the page talks to Cert Spotter and crt.sh directly, since both allow cross-origin requests. Browsers can't open raw TLS connections, so live checks come from the daily scan.
- **After each deploy**, `.github/workflows/e2e.yml` runs the browser tests against the live site and scans a real domain end to end, with screenshots saved as a workflow artifact.
- **Any Node host** can also serve `api/ct.js` and `api/tls.js` (plain `(req, res)` handlers; `npm run dev` does this). With the API present, lookups are merged server-side and "Check live hosts" handshakes on demand.
- **Single file.** `node scripts/build-demo.js` writes `dist/cert-radar-demo.html`, a self-contained demo with the sample inlined.

## Layout

```
public/            the site: index.html, app.js (UI), lib.js (analysis), sources.js (CT lookups), styles.css, sample.json
api/ct.js          GET /api/ct?domain=…  Cert Spotter + crt.sh merged
api/tls.js         GET /api/tls?host=a,b  TLS handshakes; refuses private addresses
scripts/scan.js    CLI
scripts/monitor.js daily watchlist scan and issue alerts
scripts/           make-sample.js (demo data), build-demo.js (single-file build), live.js
test/              node:test unit tests, browser.mjs (Playwright, mocked), live-smoke.mjs (real scan)
watchlist.txt      domains the daily monitor scans
```

## Caveats

- Classification is a heuristic. A commercial CA's ACME service looks the same in CT as a manual order, and a Let's Encrypt certificate can be renewed by someone running certbot by hand. The reasons are shown so a person can judge.
- CT shows what was *issued*, not what is *deployed*. Live checks close part of that gap. Private and internal certificates never appear in CT.
- Cert Spotter and crt.sh are free services with rate limits and outages. Without crt.sh history, renewal habits and past lapses can't be measured, and the page says so. Cert Spotter refuses a few very large domains on its free tier.
- The outage statistic often quoted for this problem (86% of organizations had a certificate outage in the past year) is from vendor research by Keyfactor. Treat it as directional.

## License

MIT
