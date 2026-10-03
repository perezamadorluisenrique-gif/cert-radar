// GET /api/tls?host=www.example.com
// Opens a TLS handshake to host:443 and reports the certificate actually served.
import tls from 'node:tls';
import net from 'node:net';
import dns from 'node:dns/promises';

const HOST_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    v.startsWith('::ffff:') && isPrivate(v.slice(7));
}

export function handshake(host, timeoutMs = 6000) {
  return new Promise(async (resolve) => {
    let address;
    try {
      ({ address } = await dns.lookup(host));
    } catch {
      return resolve({ host, ok: false, error: 'DNS: host does not resolve' });
    }
    // Only public addresses: this endpoint must not become a way to probe internal networks.
    if (isPrivate(address)) return resolve({ host, ok: false, error: 'Resolves to a private address' });
    const started = Date.now();
    const socket = tls.connect({ host: address, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs });
    const done = (r) => { socket.destroy(); resolve(r); };
    socket.once('secureConnect', () => {
      const c = socket.getPeerCertificate();
      if (!c || !c.valid_to) return done({ host, ok: false, error: 'No certificate presented' });
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      done({
        host,
        ok: true,
        ip: address,
        ms: Date.now() - started,
        subject: c.subject && c.subject.CN,
        issuer: [c.issuer && c.issuer.O, c.issuer && c.issuer.CN].filter(Boolean).join(' / '),
        validFrom: new Date(c.valid_from).toISOString(),
        validTo: new Date(c.valid_to).toISOString(),
        serial: c.serialNumber,
        altNames: (c.subjectaltname || '').split(', ').map((s) => s.replace(/^DNS:/, '')).filter(Boolean),
        trusted: !authError,
        authError,
      });
    });
    socket.once('timeout', () => done({ host, ok: false, error: 'Timed out (nothing listening on 443?)' }));
    socket.once('error', (e) => done({ host, ok: false, error: e.code || e.message }));
  });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const hosts = String(url.searchParams.get('host') || '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .filter((h) => HOST_RE.test(h))
    .slice(0, 10);
  res.setHeader('content-type', 'application/json');
  if (!hosts.length) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Pass ?host=www.example.com (up to 10, comma separated)' }));
  }
  const results = await Promise.all(hosts.map((h) => handshake(h)));
  res.setHeader('cache-control', 's-maxage=600');
  res.end(JSON.stringify({ results }));
}
