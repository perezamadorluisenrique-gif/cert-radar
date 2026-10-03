# 47-Day Cert Radar

Enter a domain and see every public TLS certificate issued for it, which ones are still renewed by hand, and how much renewal work the new validity caps will add.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fperezamadorluisenrique-gif%2Fcert-radar&project-name=cert-radar)

## Why

In April 2025 the CA/Browser Forum passed Ballot SC-081v3. Maximum certificate validity drops on a fixed schedule:

| From | Max validity | Renewals a year per cert (renewing ~1 week early) |
| --- | --- | --- |
| before Mar 15, 2026 | 398 days | ~1 |
| Mar 15, 2026 | 200 days | ~2 |
| Mar 15, 2027 | 100 days | ~4 |
| Mar 15, 2029 | 47 days | ~9 |

A process that used to happen once a year happens about nine times a year. Automated (ACME) certificates don't care. The ones that break are the forgotten, hand-renewed certs: a staging subdomain, a vendor landing page, an appliance someone installed a cert on three years ago. Cert Radar finds those.

## What it does

1. **Discover.** Queries public Certificate Transparency logs ([crt.sh](https://crt.sh), with [Cert Spotter](https://sslmate.com/certspotter/) as a fallback) for the domain and all subdomains. Precertificate and final-certificate duplicates are merged, and renewals of the same set of names are grouped into one *lineage*.
2. **Classify.** Each lineage is scored as *probably manual*, *unclear* or *automated*:
   - issued by Let's Encrypt, ZeroSSL, Google Trust Services, Amazon, Cloudflare, Buypass or Azure → leans automated;
   - issued by a commercial CA (DigiCert, Sectigo, GoDaddy, GlobalSign, InCommon, …) with no ACME history → leans manual;
   - validity close to the old 398-day maximum, renewals roughly yearly, or irregular renewal dates → leans manual;
   - short (≤100 day) certs → leans automated.
   Every row shows the reasons on hover.
3. **Forecast.** Projects manual renewals per year under the 200, 100 and 47-day caps. Unclear lineages count as half, so the headline number is an estimate rather than a worst case.
4. **Flag.** Hand-renewed certs expiring in the next 30 days, and recently expired lineages that nobody replaced.
5. **Verify live.** "Check live hosts" runs a TLS handshake against each host on port 443 (serverless function) and shows the certificate actually served, its expiry, whether it chains to a trusted root, and whether it differs from the newest one in CT.
6. **Assign and remind.** An owner field per certificate ("who renews this?", saved in the browser), CSV export, and an `.ics` calendar file with a reminder 14 days before each non-automated expiry.

A built-in demo (`stateuniversity.example`, fictional, under the reserved `.example` TLD) works offline, so a live demo never depends on crt.sh being fast.

## Run locally

```bash
npm test        # unit tests (Node 18+)
npm run dev     # http://localhost:3000, serves public/ and the api/ handlers
```

No dependencies. Open `http://localhost:3000/?d=demo` for the demo, or `?d=example.com` to scan a domain directly.

## Deploy

- **Vercel (recommended).** Click the button above, or `vercel deploy`. `public/` is served as static files and `api/ct.js` and `api/tls.js` become serverless functions. Live TLS checks need this.
- **Any static host (GitHub Pages, Netlify, S3).** Publish the `public/` folder. With no `api/`, the page queries crt.sh straight from the browser and the live-check button explains that it needs the API.
- **Single file.** `node scripts/build-demo.js` writes `dist/cert-radar-demo.html`, a self-contained demo page with the sample inlined.

## Layout

```
public/      index.html, app.js (UI), lib.js (analysis, shared with tests), styles.css, sample.json
api/ct.js    GET /api/ct?domain=…   CT lookup with fallbacks, cached for an hour
api/tls.js   GET /api/tls?host=a,b   TLS handshake for up to 10 hosts; refuses private IPs
scripts/     make-sample.js (demo data), build-demo.js (single-file build)
test/        node:test unit tests
```

## Caveats

- Classification is heuristic. A DigiCert cert can be automated (DigiCert supports ACME), and a Let's Encrypt cert can be renewed by someone running certbot by hand. The reasons are shown so a human can judge.
- CT shows what was *issued*, not what is *deployed*. The live check closes that gap for hosts reachable on 443.
- crt.sh is a free community service and can be slow or time out for very large domains. The API falls back to the unexpired-only query and then to Cert Spotter.
- The outage statistic often quoted for this problem (86% of organizations had a certificate outage in the past year) is from vendor research by Keyfactor; treat it as directional.

## Roadmap

- Slack and email expiry alerts with scheduled re-scans
- Shared team inventory with owners stored server-side
- ACME migration guides per CA and per platform (IIS, F5, Kubernetes, appliances)

## License

MIT
