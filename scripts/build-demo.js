// Builds dist/cert-radar-demo.html: one self-contained page (no API, sample data
// inline) for hosts that only serve a single static file.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const r = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const appUrl = process.env.APP_URL || 'https://perezamadorluisenrique-gif.github.io/cert-radar/';
const lib = r('lib.js').replace(/^export /gm, '');
const app = r('app.js').replace(/^import .*$/m, '').replace(/^const DAY = .*$/m, '');
const sample = r('sample.json');
const html = r('index.html');
const head = html.slice(html.indexOf('<title>'), html.indexOf('<link rel="stylesheet" href="styles.css"'));
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
const out = `${head}<style>
${r('styles.css')}
</style>
${body}<script>
window.CERT_RADAR_EMBED = { appUrl: ${JSON.stringify(appUrl)}, sample: ${sample} };
(() => {
${lib}
${app}
})();
</script>
`;
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/cert-radar-demo.html', import.meta.url), out);
console.log(`dist/cert-radar-demo.html ${(out.length / 1024).toFixed(0)} KB`);
