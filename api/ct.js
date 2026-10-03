// GET /api/ct?domain=example.com
// Fetches every logged certificate for a domain and its subdomains from the
// public Certificate Transparency search at crt.sh. Falls back to the
// unexpired-only query (much faster on big domains) and then to Cert Spotter.
import { cleanDomain } from '../public/lib.js';

const UA = '47-day-cert-radar (+https://github.com/perezamadorluisenrique-gif/cert-radar)';

async function getJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return text.trim() ? JSON.parse(text) : [];
  } finally {
    clearTimeout(t);
  }
}

function fromCertSpotter(items) {
  return items.map((i) => ({
    id: i.id,
    issuer_name: (i.issuer && (i.issuer.name || i.issuer.friendly_name)) || '',
    name_value: (i.dns_names || []).join('\n'),
    not_before: i.not_before,
    not_after: i.not_after,
    serial_number: i.cert_sha256 || i.id,
  }));
}

export async function lookup(domain) {
  const q = encodeURIComponent('%.' + domain);
  const errors = [];
  try {
    return { source: 'crt.sh', entries: await getJSON(`https://crt.sh/?q=${q}&output=json&deduplicate=Y`, 25000) };
  } catch (e) {
    errors.push('crt.sh full history: ' + e.message);
  }
  try {
    return {
      source: 'crt.sh (unexpired only)',
      entries: await getJSON(`https://crt.sh/?q=${q}&output=json&exclude=expired&deduplicate=Y`, 20000),
    };
  } catch (e) {
    errors.push('crt.sh unexpired: ' + e.message);
  }
  try {
    const items = await getJSON(
      `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names&expand=issuer`,
      15000,
    );
    return { source: 'Cert Spotter (unexpired only)', entries: fromCertSpotter(items) };
  } catch (e) {
    errors.push('certspotter: ' + e.message);
  }
  const err = new Error('All Certificate Transparency sources failed or timed out');
  err.details = errors;
  throw err;
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
    const out = await lookup(domain);
    res.setHeader('cache-control', 's-maxage=3600, stale-while-revalidate=86400');
    res.end(JSON.stringify({ domain, ...out }));
  } catch (e) {
    res.statusCode = 504;
    res.end(JSON.stringify({ error: e.message, details: e.details || [] }));
  }
}
