// Local dev server: serves public/ and the same handlers Vercel runs from api/.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ct from './api/ct.js';
import tlsCheck from './api/tls.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT) || 3000;

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/ct') return ct(req, res);
    if (pathname === '/api/tls') return tlsCheck(req, res);
    const file = path.join(root, path.normalize(pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(port, () => console.log(`Cert Radar on http://localhost:${port}`));
