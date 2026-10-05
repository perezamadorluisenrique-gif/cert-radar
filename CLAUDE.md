# 47-Day Cert Radar

Static web app: enter a domain, see every public TLS certificate from CT logs and when each breaks
under the CA/B Forum caps (200 days from 2026-03-15, 100 days from 2027-03-15, 47 days from 2029-03-15).
Live: https://perezamadorluisenrique-gif.github.io/cert-radar/ (demo `?d=demo`).
Part of Hidden Problems Lab; project policy lives in `/mnt/project-files/autopilot/charter.md`.

## Commands
| Job | Command |
|---|---|
| Unit tests | `npm test` (node:test, `test/*.test.js`) |
| Single test file | `node --test test/lib.test.js` |
| Browser tests (as CI runs them) | `npm i --no-save playwright@1.56.1; python3 -m http.server 3000 -d public & BASE=http://localhost:3000 node test/browser.mjs shots` |
| CLI scan | `node scripts/scan.js example.com [--json|--csv|--fail-under C]` (needs network: CI only) |
| Watchlist monitor | `node scripts/monitor.js` (runs in the daily deploy) |
| Dev server with API | `npm run dev` (serves `api/` too) |

## Architecture
- `public/` ships to GitHub Pages: `lib.js` (grading, forecast), `sources.js` (Cert Spotter first, crt.sh for history), `app.js` UI.
- `.github/workflows/pages.yml`: push to main and daily 06:17 UTC; runs tests, scans `watchlist.txt` (opens issues for `alert` domains), deploys.
- `e2e.yml` runs Playwright against the live site after each deploy; `ci.yml` runs the gates on pull requests.
- `api/` and `server.js` are for Node hosts only (not GitHub Pages); `vercel.json` is legacy (Vercel isn't available).

## Rules
- Dates come from public CT logs: say so; never claim a site is safe.
- Work on a branch and open a PR; gates must be green before merge. Never skip a test.

## Traps
- Run browser tests against a **static** copy of `public/`. Against `npm run dev` the three "static hosting" tests fail because `/api/ct` exists there.
- The sandbox can't reach crt.sh, Cert Spotter or github.io; use Actions runs (e2e "CT source health" step) as the probe.
- crt.sh often returns 502/timeouts (Oct 2026); Cert Spotter is rate limited (monitor waits once).
- GraphQL is blocked: use `gh api repos/...`. Git branch deletes through the proxy fail.
- GitHub disables cron after 60 days with no commits; the daily watchlist scan depends on it.
