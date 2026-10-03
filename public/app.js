import { analyze, cleanDomain, renewalsPerYear, toCSV, toICS } from './lib.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const DEMO_DOMAIN = 'stateuniversity.example';
// Set by the single-file demo build, which ships the sample inline and has no API.
const EMBED = globalThis.CERT_RADAR_EMBED || null;

const state = { domain: null, result: null, filter: 'manual', query: '', live: {}, owners: {}, apiAvailable: null };

// ---------- storage (owners are a per-browser convenience) ----------
function loadOwners(domain) {
  try { return JSON.parse(localStorage.getItem('owners:' + domain) || '{}'); } catch { return {}; }
}
function saveOwners() {
  try { localStorage.setItem('owners:' + state.domain, JSON.stringify(state.owners)); } catch {}
}

// ---------- progress UI ----------
function progress(steps) {
  const ol = $('progress');
  ol.hidden = false;
  ol.innerHTML = '';
  const items = steps.map((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    ol.appendChild(li);
    return li;
  });
  return {
    doing: (i, text) => { items[i].className = 'doing'; if (text) items[i].textContent = text; },
    done: (i, text) => { items[i].className = 'done'; if (text) items[i].textContent = text; },
    fail: (i, text) => { items[i].className = 'fail'; if (text) items[i].textContent = text; },
  };
}
function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- data sources ----------
async function fetchJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) { const e = new Error('not json'); e.status = r.status; throw e; }
    const body = await r.json();
    if (!r.ok) { const e = new Error(body.error || `HTTP ${r.status}`); e.status = r.status; e.body = body; throw e; }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function lookupCT(domain) {
  // Preferred: our serverless function (caches, falls back across CT sources).
  try {
    const body = await fetchJSON(`api/ct?domain=${encodeURIComponent(domain)}`, 60000);
    state.apiAvailable = true;
    return body;
  } catch (e) {
    if (e.body) throw e; // the API exists and reported a real failure
  }
  // Static hosting (e.g. GitHub Pages): ask crt.sh directly from the browser.
  state.apiAvailable = false;
  const q = encodeURIComponent('%.' + domain);
  try {
    return { source: 'crt.sh', entries: await fetchJSON(`https://crt.sh/?q=${q}&output=json&deduplicate=Y`, 45000) };
  } catch {
    return {
      source: 'crt.sh (unexpired only)',
      entries: await fetchJSON(`https://crt.sh/?q=${q}&output=json&exclude=expired&deduplicate=Y`, 30000),
    };
  }
}

// ---------- scan ----------
async function scan(domain, { demo = false, scroll = true } = {}) {
  showError('');
  $('go').disabled = true;
  $('results').hidden = true;
  state.domain = domain;
  state.owners = loadOwners(domain);
  state.live = {};
  const p = progress([
    demo ? 'Loading demo CT history' : `Searching Certificate Transparency logs for *.${domain}`,
    'Grouping renewals and classifying each certificate',
    'Projecting renewals under the 200, 100 and 47-day caps',
  ]);
  try {
    p.doing(0);
    const t0 = performance.now();
    const data = demo ? { source: 'sample data', entries: EMBED ? EMBED.sample : await (await fetch('sample.json')).json() } : await lookupCT(domain);
    if (!data.entries.length) {
      p.fail(0, `No certificates found for ${domain}`);
      showError('No public certificates were logged for this domain. Check the spelling, or try the parent domain.');
      return;
    }
    p.done(0, `Found ${data.entries.length.toLocaleString()} CT log entries via ${data.source} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    p.doing(1);
    await tick();
    const now = demo ? new Date('2026-10-03T12:00:00Z') : new Date();
    const result = analyze(data.entries, now);
    result.now = now;
    result.source = data.source;
    result.demo = demo;
    state.result = result;
    p.done(1, `${result.totalCerts.toLocaleString()} unique certificates in ${result.lineages.length} lineages`);
    p.doing(2);
    await tick();
    render();
    p.done(2);
    if (!EMBED) {
      const u = new URL(location.href);
      u.searchParams.set('d', demo ? 'demo' : domain);
      history.replaceState(null, '', u);
    }
    $('results').hidden = false;
    if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    p.fail(0, 'Certificate Transparency lookup failed');
    showError(
      (e.name === 'AbortError' ? 'crt.sh took too long to answer. ' : (e.message || 'Lookup failed') + '. ') +
        'crt.sh is a free public service and is often slow for large domains; try again in a minute, or try a subdomain.',
    );
  } finally {
    $('go').disabled = false;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 30));

// ---------- render ----------
function fmtDate(d) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function render() {
  const r = state.result;
  const y2029 = r.forecast[r.forecast.length - 1];
  const before = r.forecast[0];
  $('hl-domain').textContent = (r.demo ? 'Demo · ' : '') + state.domain;
  $('hl-num').textContent = y2029.manualRenewals;
  const mult = before.manualRenewals ? (y2029.manualRenewals / before.manualRenewals).toFixed(1) : null;
  $('hl-text').innerHTML =
    `<b>${r.manual.length}</b> of ${r.active.length} live certificate lineages look hand-renewed` +
    (r.unclear.length ? ` and <b>${r.unclear.length}</b> are unclear` : '') +
    `. Under the old 398-day rule that was about <b>${before.manualRenewals}</b> renewals a year` +
    (mult ? `; by March 2029 it is <b>${mult}×</b> the work.` : '.') +
    (r.manual.length ? ' Move them to ACME before 2027, or give each one an owner.' : ' Nice: everything here looks automated.');

  const soon = r.expiringSoon.length;
  const tiles = [
    ['Certificates logged', r.totalCerts.toLocaleString()],
    ['Live lineages', r.active.length],
    ['Hostnames covered', r.hosts.length],
    ['Probably manual', r.manual.length, r.manual.length > 0],
    ['Need attention', r.forgotten.length, r.forgotten.length > 0],
    ['Expire in 30 days', soon, soon > 0],
  ];
  $('tiles').innerHTML = tiles
    .map(([k, v, warn]) => `<div class="tile${warn ? ' warn' : ''}"><div class="v">${v}</div><div class="k">${k}</div></div>`)
    .join('');

  renderForecast();
  renderTimeline();
  renderAttention();
  renderTable();
}

function renderForecast() {
  const f = state.result.forecast;
  const W = 520, H = 230, padL = 10, padB = 46, top = 24;
  const max = Math.max(1, ...f.map((x) => x.manualRenewals));
  const bw = (W - padL * 2) / f.length;
  const bars = f
    .map((x, i) => {
      const h = Math.round(((H - padB - top) * x.manualRenewals) / max);
      const bx = padL + i * bw + bw * 0.18;
      const w = bw * 0.64;
      const y = H - padB - h;
      const color = i === f.length - 1 ? 'var(--manual)' : i === 0 ? 'var(--expired)' : 'var(--unclear)';
      return `<rect x="${bx}" y="${y}" width="${w}" height="${Math.max(h, 2)}" rx="4" fill="${color}"/>
        <text class="val" x="${bx + w / 2}" y="${y - 7}" text-anchor="middle">${x.manualRenewals}</text>
        <text x="${bx + w / 2}" y="${H - padB + 18}" text-anchor="middle">${x.label}</text>
        <text x="${bx + w / 2}" y="${H - padB + 34}" text-anchor="middle">${x.maxDays === 398 ? 'old 398-day max' : x.maxDays + '-day max'}</text>`;
    })
    .join('');
  $('forecast').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Manual renewals per year under each validity cap">
    <line class="axis" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>${bars}</svg>`;
}

function renderTimeline() {
  const r = state.result;
  const now = r.now.getTime();
  const W = 520, H = 230, padL = 12, padR = 12, laneTop = 30;
  const span = 365 * DAY;
  const x = (t) => padL + ((t - now) / span) * (W - padL - padR);
  const months = [];
  for (let i = 0; i <= 12; i += 3) {
    const d = new Date(r.now);
    d.setUTCMonth(d.getUTCMonth() + i, 1);
    if (d.getTime() >= now) months.push(d);
  }
  const lanes = { manual: 60, unclear: 110, automated: 160 };
  const dots = r.active
    .filter((l) => l.latest.notAfter.getTime() - now <= span)
    .map((l) => {
      const cx = x(l.latest.notAfter.getTime());
      const jitter = ((l.key.length * 7) % 21) - 10;
      const color = l.automation === 'manual' ? 'var(--manual)' : l.automation === 'unclear' ? 'var(--unclear)' : 'var(--auto)';
      return `<circle cx="${cx.toFixed(1)}" cy="${lanes[l.automation] + jitter}" r="${l.automation === 'automated' ? 4 : 6}" fill="${color}" fill-opacity="0.85"><title>${esc(l.primary)} · ${fmtDate(l.latest.notAfter)}</title></circle>`;
    })
    .join('');
  const cuts = [Date.parse('2027-03-15')]
    .filter((t) => t > now && t < now + span)
    .map((t) => `<line class="today" x1="${x(t)}" x2="${x(t)}" y1="${laneTop}" y2="${H - 30}"/><text x="${x(t) + 4}" y="${laneTop + 8}">100-day cap</text>`)
    .join('');
  const labels = Object.entries(lanes)
    .map(([k, y]) => `<text x="${padL}" y="${y - 16}">${k === 'manual' ? 'Probably manual' : k === 'unclear' ? 'Unclear' : 'Automated'}</text>`)
    .join('');
  const ticks = months
    .map((d) => `<text x="${x(d.getTime())}" y="${H - 10}" text-anchor="middle">${d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}</text>`)
    .join('');
  $('timeline').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Expiry dates over the next 12 months">
    <line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - 30}" y2="${H - 30}"/>${labels}${cuts}${dots}${ticks}</svg>`;
}

function renderAttention() {
  const r = state.result;
  const items = [...r.forgotten].sort((a, b) => a.daysLeft - b.daysLeft);
  $('attention').innerHTML = items.length
    ? items
        .map((l) => {
          const when = l.expired
            ? `expired ${-l.daysLeft} days ago, no replacement logged`
            : `expires in ${l.daysLeft} days (${fmtDate(l.latest.notAfter)})`;
          return `<li class="${l.expired ? 'expired' : ''}"><span><b>${esc(l.primary)}</b> · ${esc(l.issuer.name)}</span><span class="why">${when}</span></li>`;
        })
        .join('')
    : '<li class="empty">Nothing urgent. No hand-renewed certificate expires in the next 30 days.</li>';
}

function filtered() {
  const r = state.result;
  const q = state.query.trim().toLowerCase();
  let list =
    state.filter === 'all' ? r.lineages
      : state.filter === 'expired' ? r.lineages.filter((l) => l.expired)
        : r.active.filter((l) => l.automation === state.filter);
  if (q) list = list.filter((l) => l.names.some((n) => n.includes(q)) || l.issuer.name.toLowerCase().includes(q));
  return [...list].sort((a, b) => (a.expired === b.expired ? a.daysLeft - b.daysLeft : a.expired ? 1 : -1));
}

function renderTable() {
  const r = state.result;
  const counts = {
    manual: r.manual.length, unclear: r.unclear.length, automated: r.automated.length,
    expired: r.lineages.length - r.active.length, all: r.lineages.length,
  };
  for (const b of $('seg').querySelectorAll('button')) {
    const label = b.textContent.replace(/\s*\d+$/, '');
    b.innerHTML = `${label}<span class="c">${counts[b.dataset.f]}</span>`;
    b.classList.toggle('on', b.dataset.f === state.filter);
  }
  $('inv-sub').textContent = `${r.lineages.length} lineages from ${r.source}. Hover a renewal badge to see why it was classified that way.`;

  const tpl = $('row-tpl');
  const body = $('rows');
  body.innerHTML = '';
  const list = filtered();
  const per2029 = renewalsPerYear(47, true);
  for (const l of list.slice(0, 400)) {
    const tr = tpl.content.firstElementChild.cloneNode(true);
    tr.querySelector('.primary').textContent = l.primary;
    const others = l.names.filter((n) => n !== l.primary);
    tr.querySelector('.more').textContent = others.length ? `+ ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}` : '';
    tr.querySelector('.ca').textContent = l.issuer.name;
    const badge = tr.querySelector('.badge');
    const kind = l.expired ? 'expired' : l.automation;
    badge.className = 'badge ' + kind;
    badge.textContent = l.expired ? 'expired' : l.automation === 'manual' ? 'probably manual' : l.automation;
    badge.title = l.reasons.join('\n') + `\n${l.certs.length} certificate${l.certs.length > 1 ? 's' : ''} in this lineage`;
    tr.querySelector('.date').textContent = fmtDate(l.latest.notAfter);
    const left = tr.querySelector('.left');
    left.textContent = l.expired ? `${-l.daysLeft}d ago` : `in ${l.daysLeft}d`;
    left.classList.toggle('soon', !l.expired && l.daysLeft <= 30);
    tr.querySelector('.num').textContent = l.expired ? '' : l.automation === 'automated' ? 'auto' : per2029.toFixed(1);
    renderLive(tr.querySelector('.livecell'), l);
    const owner = tr.querySelector('.owner');
    owner.value = state.owners[l.key] || '';
    owner.addEventListener('change', () => {
      if (owner.value.trim()) state.owners[l.key] = owner.value.trim();
      else delete state.owners[l.key];
      saveOwners();
    });
    tr.dataset.key = l.key;
    body.appendChild(tr);
  }
  if (!list.length) body.innerHTML = '<tr><td colspan="7" class="note">Nothing in this view.</td></tr>';
}

function renderLive(cell, l) {
  const host = liveHost(l);
  const res = host && state.live[host];
  if (!host) { cell.textContent = 'wildcard'; return; }
  if (!res) { cell.textContent = '–'; return; }
  if (res === 'pending') { cell.textContent = 'checking…'; return; }
  if (!res.ok) { cell.innerHTML = `<span class="bad" title="${esc(res.error)}">no TLS</span>`; return; }
  const to = new Date(res.validTo);
  const days = Math.floor((to - Date.now()) / DAY);
  const matches = Math.abs(to - l.latest.notAfter) < 2 * DAY;
  cell.innerHTML = `<span class="${res.trusted && days > 14 ? 'okk' : 'bad'}" title="${esc(`${res.issuer}\nserved cert expires ${res.validTo.slice(0, 10)}${res.authError ? '\n' + res.authError : ''}`)}">${days}d${res.trusted ? '' : ' untrusted'}</span>${matches ? '' : ' <span title="The host serves a different certificate than the newest one in CT">≠CT</span>'}`;
}

function liveHost(l) {
  const plain = l.names.filter((n) => !n.startsWith('*.'));
  return plain.length ? (plain.includes(l.primary) ? l.primary : plain[0]) : null;
}

async function checkLive() {
  const btn = $('live');
  const note = $('live-note');
  const r = state.result;
  if (r.demo) {
    note.hidden = false;
    note.textContent = 'Live checks need a real domain. The demo university is fictional.';
    return;
  }
  // Prioritise the risky ones: manual and unclear first, then the rest.
  const order = [...r.manual, ...r.unclear, ...r.automated];
  const hosts = [...new Set(order.map(liveHost).filter(Boolean))].slice(0, 60);
  btn.disabled = true;
  note.hidden = false;
  note.textContent = `Handshaking ${hosts.length} hosts on port 443…`;
  for (const h of hosts) state.live[h] = 'pending';
  renderTable();
  let failedApi = false;
  for (let i = 0; i < hosts.length && !failedApi; i += 10) {
    const batch = hosts.slice(i, i + 10);
    try {
      const out = await fetchJSON(`api/tls?host=${batch.join(',')}`, 30000);
      for (const res of out.results) state.live[res.host] = res;
    } catch {
      failedApi = true;
      for (const h of hosts) if (state.live[h] === 'pending') delete state.live[h];
    }
    renderTable();
  }
  btn.disabled = false;
  if (failedApi) {
    note.textContent = 'Live TLS checks need the serverless API, which this static copy does not have. Deploy to Vercel (see README) to enable them.';
  } else {
    const vals = hosts.map((h) => state.live[h]).filter((x) => x && x.ok);
    const mismatched = r.active.filter((l) => {
      const v = state.live[liveHost(l)];
      return v && v.ok && Math.abs(new Date(v.validTo) - l.latest.notAfter) >= 2 * DAY;
    }).length;
    note.textContent = `${vals.length} of ${hosts.length} hosts answered TLS on 443. ${mismatched} serve a different certificate than the newest one in CT (≠CT), which usually means a stale cert, a CDN, or a load balancer with its own cert.`;
  }
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- wire up ----------
$('scan').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = cleanDomain($('domain').value);
  if (!d) return showError('That does not look like a domain. Try something like example.com.');
  $('domain').value = d;
  if (EMBED && d !== DEMO_DOMAIN) {
    return showError(`This preview only runs the demo university. Scan ${d} in the full app: ${EMBED.appUrl}`);
  }
  scan(d, { demo: d === DEMO_DOMAIN });
});
$('demo').addEventListener('click', () => {
  $('domain').value = DEMO_DOMAIN;
  scan(DEMO_DOMAIN, { demo: true });
});
$('seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.filter = b.dataset.f;
  renderTable();
});
$('search').addEventListener('input', (e) => { state.query = e.target.value; renderTable(); });
$('live').addEventListener('click', checkLive);
$('csv').addEventListener('click', () => download(`cert-radar-${state.domain}.csv`, toCSV(state.result.lineages, state.owners), 'text/csv'));
$('ics').addEventListener('click', () =>
  download(`cert-radar-${state.domain}.ics`, toICS(state.result.active.filter((l) => l.automation !== 'automated'), state.owners, state.result.now), 'text/calendar'),
);

if (EMBED) {
  for (const id of ['live', 'csv', 'ics']) $(id).hidden = true;
  $('domain').value = DEMO_DOMAIN;
  scan(DEMO_DOMAIN, { demo: true, scroll: false });
}
const initial = EMBED ? null : new URL(location.href).searchParams.get('d');
if (initial === 'demo') $('demo').click();
else if (initial && cleanDomain(initial)) { $('domain').value = cleanDomain(initial); scan(cleanDomain(initial)); }
