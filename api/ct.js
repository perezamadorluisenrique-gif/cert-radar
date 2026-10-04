// GET /api/ct?domain=example.com
// Server-side CT lookup for `npm run dev` and Node hosts: asks Cert Spotter and
// crt.sh at the same time and merges what comes back.
import { cleanDomain } from '../public/lib.js';
import { certSpotter, crtsh, explain } from '../public/sources.js';

export async function lookup(domain, { token } = {}) {
  const [cs, hist] = await Promise.allSettled([
    certSpotter(domain, { maxPages: 10, token }),
    crtsh(domain, { history: true, timeout: 80000 }),
  ]);
  const entries = [];
  const used = [];
  const errors = [];
  if (cs.status === 'fulfilled') { entries.push(...cs.value.entries); used.push('Cert Spotter'); } else errors.push(explain('Cert Spotter', cs.reason));
  if (hist.status === 'fulfilled') { entries.push(...hist.value.entries); used.push('crt.sh'); } else errors.push(explain('crt.sh', hist.reason));
  if (!used.length) {
    const err = new Error(errors.join('; '));
    err.details = errors;
    throw err;
  }
  return {
    source: used.join(' and '),
    scope: hist.status === 'fulfilled' ? 'history' : 'current',
    truncated: cs.status === 'fulfilled' && cs.value.truncated,
    errors,
    entries,
  };
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const domain = cleanDomain(url.searchParams.get('domain'));
  res.setHeader('content-type', 'application/json');
  if (!domain) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Enter a domain like example.com' }));
  }
  try {
    const out = await lookup(domain, { token: process.env.CERTSPOTTER_TOKEN });
    res.setHeader('cache-control', 's-maxage=3600, stale-while-revalidate=86400');
    res.end(JSON.stringify({ domain, ...out }));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: e.message, details: e.details || [] }));
  }
}
