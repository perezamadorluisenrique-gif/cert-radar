// Renders public/og.png (the social preview) from the demo. Needs Playwright.
//   BASE=http://localhost:3000 node scripts/make-og.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, bypassCSP: true });
await p.goto(`${BASE}/?d=demo`);
await p.waitForSelector('#results:not([hidden])');
await p.addStyleTag({ content: `
  .top, .hint, .progress, .about, .foot, .board, .source-note, .grid2, #attention-card, .card:last-of-type, .scan, .lede, .countdown, .tile:nth-child(n+4) { display: none !important; }
  .hero { padding: 48px 0 26px; } h1 { font-size: 52px; } .tiles { grid-template-columns: repeat(3, 1fr); }
  .headline { margin-bottom: 14px; } .grade-notes { display: none; } main { padding-top: 6px; }` });
await p.evaluate(() => window.scrollTo(0, 0));
await p.screenshot({ path: new URL('../public/og.png', import.meta.url).pathname, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await b.close();
console.log('wrote public/og.png');
