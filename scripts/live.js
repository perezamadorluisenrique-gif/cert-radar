// Live TLS checks for the hosts in an analysis, a few at a time.
import { handshake } from '../api/tls.js';

export function liveHost(l) {
  const plain = l.names.filter((n) => !n.startsWith('*.'));
  return plain.length ? (plain.includes(l.primary) ? l.primary : plain[0]) : null;
}

export async function liveCheck(r, { max = 40, concurrency = 8 } = {}) {
  const order = [...r.manual, ...r.unclear, ...r.automated];
  const hosts = [...new Set(order.map(liveHost).filter(Boolean))].slice(0, max);
  const out = {};
  let i = 0;
  async function worker() {
    while (i < hosts.length) {
      const h = hosts[i++];
      out[h] = await handshake(h);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return out;
}
