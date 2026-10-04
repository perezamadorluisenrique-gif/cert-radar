// Certificate Transparency sources. Runs in the browser and in Node 18+ (CLI,
// GitHub Actions monitor), using the global fetch.
//
// Cert Spotter answers fast, allows cross-origin calls and returns certificates
// that are still valid. crt.sh has the full history but is often overloaded,
// so the app treats it as an optional second pass.
import { fromCertSpotter } from './lib.js';

export class SourceError extends Error {
  constructor(message, { status, retryAfter, code } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

export async function fetchJSON(url, ms, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    let r;
    try {
      r = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      throw new SourceError(e.name === 'AbortError' ? 'timed out' : 'could not connect', { code: e.name === 'AbortError' ? 'timeout' : 'network' });
    }
    const type = r.headers.get('content-type') || '';
    const text = await r.text();
    let body = null;
    if (type.includes('json') || /^\s*[[{]/.test(text)) {
      try { body = text.trim() ? JSON.parse(text) : []; } catch { /* fall through */ }
    }
    if (!r.ok || body === null) {
      const msg = (body && (body.message || body.error)) || `HTTP ${r.status}`;
      throw new SourceError(msg, {
        status: r.status,
        retryAfter: Number(r.headers.get('retry-after')) || null,
        code: (body && body.code) || (r.status === 429 ? 'rate_limited' : r.status >= 500 ? 'unavailable' : 'bad_response'),
      });
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

// Unexpired certificates for a domain and its subdomains, following pagination.
export async function certSpotter(domain, { maxPages = 4, timeout = 20000, token } = {}) {
  const base = `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names&expand=issuer`;
  const init = token ? { headers: { authorization: `Bearer ${token}` } } : {};
  const all = [];
  let after = null;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const items = await fetchJSON(after ? `${base}&after=${encodeURIComponent(after)}` : base, timeout, init);
    if (!Array.isArray(items) || !items.length) break;
    all.push(...items);
    after = items[items.length - 1].id;
    if (page === maxPages - 1) truncated = true;
  }
  return { source: 'Cert Spotter', scope: 'current', truncated, entries: fromCertSpotter(all) };
}

// Full history (or unexpired only) from crt.sh.
export async function crtsh(domain, { history = true, timeout = 60000 } = {}) {
  const q = encodeURIComponent('%.' + domain);
  const url = `https://crt.sh/?q=${q}&output=json&deduplicate=Y${history ? '' : '&exclude=expired'}`;
  const entries = await fetchJSON(url, timeout);
  if (!Array.isArray(entries)) throw new SourceError('unexpected response', { code: 'bad_response' });
  return { source: 'crt.sh', scope: history ? 'history' : 'current', truncated: false, entries };
}

// Plain-language reason for a failed lookup.
export function explain(source, e) {
  if (e.code === 'not_allowed_by_plan') return `${source} won't search this domain without a paid plan`;
  if (e.code === 'rate_limited') return `${source} rate limit reached${e.retryAfter ? `, try again in ${Math.ceil(e.retryAfter / 60)} min` : ''}`;
  if (e.code === 'timeout') return `${source} took too long to answer`;
  if (e.code === 'unavailable') return `${source} is overloaded right now (HTTP ${e.status})`;
  if (e.code === 'network') return `${source} could not be reached`;
  return `${source} failed: ${e.message}`;
}
