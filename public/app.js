import {
  analyze, cleanDomain, currentStep, diffSnapshots, guidance, renewalsPerYear, SCHEDULE, snapshot, toCSV, toICS, toReport,
} from './lib.js';
import { certSpotter, crtsh, explain, fetchJSON } from './sources.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const DEMO_DOMAIN = 'stateuniversity.example';
const DEMO_NOW = new Date('2026-10-03T12:00:00Z');
// Set by the single-file demo build, which ships the sample inline and has no API.
const EMBED = globalThis.CERT_RADAR_EMBED || null;

const state = {
  domain: null, result: null, entries: [], filter: 'manual', query: '', live: {}, liveFrom: null,
  owners: {}, apiAvailable: null, expanded: new Set(), sourceNote: '', prevSnap: null, scanId: 0,
};

// ---------- small helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tick = () => new Promise((r) => setTimeout(r, 30));
const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtShort = (d) => d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

// ---------- countdown ----------
function renderCountdown() {
  const now = new Date();
  const next = SCHEDULE.find((s) => new Date(s.from + 'T00:00:00Z') > now);
  const cur = currentStep(now);
  const el = $('countdown');
  if (!next) { el.textContent = `The 47-day cap is in force.`; return; }
  const days = Math.ceil((new Date(next.from + 'T00:00:00Z') - now) / DAY);
  el.innerHTML = `Today's cap: <b>${cur.maxDays} days</b>. The <b>${next.maxDays}-day</b> cap starts in <b>${days.toLocaleString()} days</b>.`;
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
  const set = (cls) => (i, text) => { items[i].className = cls; if (text) items[i].textContent = text; };
  return { doing: set('doing'), done: set('done'), fail: set('fail'), skip: set('skip') };
}
function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- data loading ----------
// 1. a fresh daily snapshot from the watchlist monitor (includes live TLS checks)
// 2. the Node API when running `npm run dev`
// 3. Cert Spotter (fast, current certs), then crt.sh history in the background
async function loadSnapshot(domain) {
  try {
    const snap = await fetchJSON(`monitor/${encodeURIComponent(domain)}.json`, 8000);
    if (!snap || !Array.isArray(snap.entries) || !snap.entries.length) return null;
    if (Date.now() - Date.parse(snap.scannedAt) > 3 * DAY) return null;
    return snap;
  } catch {
    return null;
  }
}

async function tryApi(domain) {
  try {
    const body = await fetchJSON(`api/ct?domain=${encodeURIComponent(domain)}`, 90000);
    state.apiAvailable = true;
    return body;
  } catch (e) {
    if (e.status && e.status !== 404 && e.status !== 405 && e.code !== 'bad_response') {
      state.apiAvailable = true;
      throw e;
    }
    state.apiAvailable = false;
    return null;
  }
}

async function scan(domain, { demo = false, scroll = true } = {}) {
  const id = ++state.scanId;
  showError('');
  $('go').disabled = true;
  $('results').hidden = true;
  state.domain = domain;
  state.owners = load('owners:' + domain, {});
  state.prevSnap = demo ? null : load('scan:' + domain, null);
  state.live = {};
  state.liveFrom = null;
  state.expanded = new Set();
  state.filter = 'manual';
  const p = progress([
    demo ? 'Loading the demo university' : `Looking up certificates for ${domain} and its subdomains`,
    'Grouping renewals and classifying each certificate',
    demo ? 'Projecting renewals under the 200, 100 and 47-day caps' : 'Fetching full history from crt.sh',
  ]);
  try {
    p.doing(0);
    const t0 = performance.now();
    let data = null;
    let wantHistory = false;
    if (demo) {
      data = { source: 'sample data', scope: 'history', entries: EMBED ? EMBED.sample : await (await fetch('sample.json')).json() };
    } else {
      const snap = EMBED ? null : await loadSnapshot(domain);
      if (snap) {
        data = { source: `the daily scan on ${fmtDate(new Date(snap.scannedAt))}`, scope: snap.scope || 'history', entries: snap.entries };
        state.live = snap.live || {};
        state.liveFrom = snap.scannedAt;
      } else {
        data = EMBED ? null : await tryApi(domain);
        if (!data) {
          try {
            data = await certSpotter(domain);
            wantHistory = true;
          } catch (e) {
            const why = explain('Cert Spotter', e);
            p.doing(0, `${why}. Trying crt.sh instead (this can take a minute)`);
            try {
              data = await crtsh(domain, { history: true, timeout: 70000 });
            } catch (e2) {
              throw new Error(`${why}, and ${explain('crt.sh', e2).replace(/^crt\.sh/, 'crt.sh')}.`);
            }
          }
        }
      }
    }
    if (id !== state.scanId) return;
    if (!data.entries.length) {
      p.fail(0, `No certificates found for ${domain}`);
      showError('No publicly trusted certificates are logged for this domain. Check the spelling, or try the parent domain.');
      return;
    }
    p.done(0, `Found ${plural(data.entries.length, 'log entry', 'log entries')} via ${data.source} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    p.doing(1);
    await tick();
    state.entries = data.entries;
    state.sourceNote = sourceNote(data, wantHistory ? 'loading' : null);
    analyzeAndRender(demo);
    p.done(1, `${plural(state.result.totalCerts, 'unique certificate')} in ${plural(state.result.lineages.length, 'lineage')}`);
    if (!EMBED) {
      const u = new URL(location.href);
      u.searchParams.set('d', demo ? 'demo' : domain);
      history.replaceState(null, '', u);
    }
    $('results').hidden = false;
    if (scroll) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('go').disabled = false;

    if (wantHistory) {
      p.doing(2, 'Fetching full history from crt.sh to spot renewal habits and past lapses');
      try {
        const hist = await crtsh(domain, { history: true, timeout: 75000 });
        if (id !== state.scanId) return;
        state.entries = [...data.entries, ...hist.entries];
        state.sourceNote = sourceNote(data, 'ok');
        analyzeAndRender(false);
        p.done(2, `Added ${plural(hist.entries.length, 'historical entry', 'historical entries')} from crt.sh`);
      } catch (e) {
        if (id !== state.scanId) return;
        state.sourceNote = sourceNote(data, explain('crt.sh', e));
        $('source-note').textContent = state.sourceNote;
        p.skip(2, `No history: ${explain('crt.sh', e)}. Results use current certificates only.`);
      }
    } else {
      p.done(2);
    }
    if (!demo) store('scan:' + domain, snapshot(state.result, new Date()));
  } catch (e) {
    console.error(e);
    if (id !== state.scanId) return;
    p.fail(0, 'Certificate lookup failed');
    showError(`${e.message} Both services are free and sometimes overloaded. Try again in a few minutes, or try the demo.`);
  } finally {
    if (id === state.scanId) $('go').disabled = false;
  }
}

function sourceNote(data, history) {
  const parts = [`Certificates from ${data.source}.`];
  if (data.truncated) parts.push('Very large domain: only the first pages of results were loaded.');
  if (history === 'loading') parts.push('Loading full history from crt.sh…');
  else if (history === 'ok') parts.push('Full history from crt.sh included.');
  else if (history) parts.push(`History unavailable (${history}), so renewal habits and past lapses are based on current certificates only.`);
  return parts.join(' ');
}

function analyzeAndRender(demo) {
  const now = demo ? DEMO_NOW : new Date();
  const result = analyze(state.entries, now);
  result.now = now;
  result.demo = demo;
  state.result = result;
  render();
}

// ---------- render ----------
function render() {
  const r = state.result;
  const y2029 = r.forecast[r.forecast.length - 1];
  const before = r.forecast[0];
  $('hl-domain').textContent = (r.demo ? 'Demo · ' : '') + state.domain;
  $('hl-num').textContent = y2029.manualRenewals;
  const g = r.readiness;
  const gradeEl = $('grade');
  gradeEl.textContent = g.grade;
  gradeEl.className = 'grade g-' + (g.grade === '–' ? 'na' : g.grade);
  gradeEl.title = g.score === null ? '' : `Score ${g.score} of 100`;
  $('grade-notes').innerHTML = g.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  const mult = before.manualRenewals ? (y2029.manualRenewals / before.manualRenewals).toFixed(1) : null;
  $('hl-text').innerHTML =
    `<b>${r.manual.length}</b> of ${r.active.length} live certificates look hand-renewed` +
    (r.unclear.length ? ` and <b>${r.unclear.length}</b> are unclear` : '') +
    (r.manual.length || r.unclear.length
      ? `. Under the old 398-day rule that was about <b>${before.manualRenewals}</b> renewals a year` +
        (mult ? `; by March 2029 it is <b>${mult}×</b> the work.` : '.')
      : '. Everything here looks automated.');

  const changes = $('changes');
  const diff = state.prevSnap ? diffSnapshots(state.prevSnap, snapshot(r)) : null;
  if (diff && (diff.added.length || diff.renewed.length || diff.gone.length || diff.prevGrade !== g.grade)) {
    const bits = [];
    if (diff.added.length) bits.push(plural(diff.added.length, 'new certificate'));
    if (diff.renewed.length) bits.push(`${diff.renewed.length} renewed`);
    if (diff.gone.length) bits.push(`${diff.gone.length} no longer live`);
    if (diff.prevGrade !== g.grade) bits.push(`grade was ${diff.prevGrade}`);
    changes.textContent = `Since your last scan on ${fmtDate(new Date(diff.since))}: ${bits.join(', ')}.`;
    changes.hidden = false;
  } else {
    changes.hidden = true;
  }
  $('source-note').textContent = state.sourceNote;

  const tiles = [
    ['Certificates logged', r.totalCerts.toLocaleString()],
    ['Live certificates', r.active.length],
    ['Hostnames covered', r.hosts.length],
    ['Probably manual', r.manual.length, r.manual.length > 0],
    ['Need attention', r.forgotten.length, r.forgotten.length > 0],
    ['Past lapses', r.gaps, r.gaps > 0, 'Times a certificate expired before its replacement was issued, in the last 3 years'],
  ];
  $('tiles').innerHTML = tiles
    .map(([k, v, warn, title]) => `<div class="tile${warn ? ' warn' : ''}"${title ? ` title="${esc(title)}"` : ''}><div class="v">${v}</div><div class="k">${k}</div></div>`)
    .join('');

  renderForecast();
  renderWorkload();
  renderTimeline();
  renderIssuers();
  renderAttention();
  renderLiveControls();
  renderTable();
}

function barChart(el, bars, { label, highlight, ariaLabel, sub }) {
  const W = 520, H = 230, padB = sub ? 46 : 30, top = 24, padL = 6;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const bw = (W - padL * 2) / bars.length;
  const g = bars
    .map((b, i) => {
      const h = Math.round(((H - padB - top) * b.value) / max);
      const w = bw * (bars.length > 6 ? 0.7 : 0.64);
      const bx = padL + i * bw + (bw - w) / 2;
      const y = H - padB - h;
      return `<rect x="${bx}" y="${y}" width="${w}" height="${Math.max(h, 2)}" rx="3" fill="${b.color}"/>
        ${b.value || bars.length <= 6 ? `<text class="val" x="${bx + w / 2}" y="${y - 6}" text-anchor="middle">${b.value}</text>` : ''}
        <text x="${bx + w / 2}" y="${H - padB + 17}" text-anchor="middle">${esc(b.label)}</text>
        ${sub ? `<text x="${bx + w / 2}" y="${H - padB + 33}" text-anchor="middle">${esc(b.sub || '')}</text>` : ''}`;
    })
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
    <line class="axis" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>${g}</svg>`;
}

function renderForecast() {
  const f = state.result.forecast;
  barChart($('forecast'), f.map((x, i) => ({
    label: x.label,
    sub: x.maxDays === 398 ? 'old 398-day max' : `${x.maxDays}-day max`,
    value: x.manualRenewals,
    color: i === f.length - 1 ? 'var(--manual)' : i === 0 ? 'var(--expired)' : 'var(--unclear)',
  })), { sub: true, ariaLabel: 'Manual renewals per year under each validity cap' });
}

function renderWorkload() {
  const w = state.result.workload;
  const total = w.months.reduce((s, m) => s + m.count, 0);
  $('workload-sub').textContent = total
    ? `Manual renewals per month from March 2029. Busiest: ${w.peak.label} ${w.peak.year} with ${w.peak.count}.`
    : 'No hand-renewed certificates, so no manual renewals to schedule.';
  barChart($('workload'), w.months.map((m) => ({
    label: m.label,
    value: m.count,
    color: m === w.peak && total ? 'var(--manual)' : 'var(--unclear)',
  })), { ariaLabel: 'Manual renewals per month in the first year of the 47-day cap' });
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
  const lanes = { manual: 64, unclear: 114, automated: 164 };
  const dots = r.active
    .filter((l) => l.latest.notAfter.getTime() - now <= span)
    .map((l) => {
      const cx = x(l.latest.notAfter.getTime());
      let h = 0;
      for (const ch of l.key) h = (h * 31 + ch.charCodeAt(0)) | 0;
      const jitter = (Math.abs(h) % 21) - 10;
      const color = l.automation === 'manual' ? 'var(--manual)' : l.automation === 'unclear' ? 'var(--unclear)' : 'var(--auto)';
      return `<circle cx="${cx.toFixed(1)}" cy="${lanes[l.automation] + jitter}" r="${l.automation === 'automated' ? 4 : 6}" fill="${color}" fill-opacity="0.85"><title>${esc(l.primary)} · ${fmtDate(l.latest.notAfter)}</title></circle>`;
    })
    .join('');
  const cuts = SCHEDULE.slice(1)
    .map((s) => ({ t: Date.parse(s.from + 'T00:00:00Z'), s }))
    .filter(({ t }) => t > now && t < now + span)
    .map(({ t, s }) => `<line class="today" x1="${x(t)}" x2="${x(t)}" y1="${laneTop}" y2="${H - 30}"/><text x="${x(t) + 4}" y="${laneTop + 8}">${s.maxDays}-day cap</text>`)
    .join('');
  const labels = Object.entries(lanes)
    .map(([k, y]) => `<text x="${padL}" y="${y - 18}">${k === 'manual' ? 'Probably manual' : k === 'unclear' ? 'Unclear' : 'Automated'}</text>`)
    .join('');
  const ticks = months
    .map((d) => `<text x="${Math.min(W - 24, Math.max(18, x(d.getTime())))}" y="${H - 10}" text-anchor="middle">${d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}</text>`)
    .join('');
  $('timeline').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Expiry dates over the next 12 months">
    <line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - 30}" y2="${H - 30}"/>${labels}${cuts}${dots}${ticks}</svg>`;
}

function renderIssuers() {
  const r = state.result;
  const rows = {};
  for (const l of r.active) {
    const k = l.issuer.name;
    rows[k] = rows[k] || { name: k, kind: l.issuer.kind, count: 0, manual: 0 };
    rows[k].count++;
    if (l.automation === 'manual') rows[k].manual++;
  }
  const list = Object.values(rows).sort((a, b) => b.count - a.count).slice(0, 7);
  const W = 520, rowH = 28, padTop = 6, labelW = 190;
  const H = Math.max(60, padTop * 2 + list.length * rowH);
  const max = Math.max(1, ...list.map((x) => x.count));
  const bars = list
    .map((x, i) => {
      const y = padTop + i * rowH;
      const w = Math.max(3, ((W - labelW - 50) * x.count) / max);
      const auto = x.kind !== 'commercial';
      return `<text x="0" y="${y + 17}">${esc(x.name.length > 26 ? x.name.slice(0, 25) + '…' : x.name)}</text>
        <rect x="${labelW}" y="${y + 5}" width="${w}" height="16" rx="3" fill="${auto ? 'var(--auto)' : 'var(--surface)'}" stroke="${auto ? 'var(--auto)' : 'var(--manual)'}" stroke-width="1.5"/>
        <text class="val" x="${labelW + w + 6}" y="${y + 17}">${x.count}${x.manual ? ` <tspan class="muted">(${x.manual} manual)</tspan>` : ''}</text>`;
    })
    .join('');
  $('issuers').innerHTML = list.length
    ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Live certificates by issuing CA">${bars}</svg>`
    : '<p class="note">No live certificates.</p>';
}

function renderAttention() {
  const r = state.result;
  const items = [...r.forgotten].sort((a, b) => a.daysLeft - b.daysLeft);
  $('attention').innerHTML = items.length
    ? items
        .map((l) => {
          const distrust = l.flags.find((f) => f.kind === 'distrust');
          const when = l.expired
            ? `expired ${-l.daysLeft} days ago, no replacement logged`
            : distrust
              ? distrust.text
              : `expires in ${plural(l.daysLeft, 'day')} (${fmtDate(l.latest.notAfter)})`;
          return `<li class="${l.expired ? 'expired' : ''}"><button type="button" class="link jump" data-key="${esc(l.key)}">${esc(l.primary)}</button><span class="ca-name">${esc(l.issuer.name)}</span><span class="why">${esc(when)}</span></li>`;
        })
        .join('')
    : '<li class="empty">Nothing urgent. No hand-renewed certificate expires in the next 30 days.</li>';
}

function renderLiveControls() {
  const btn = $('live');
  const note = $('live-note');
  if (EMBED) { btn.hidden = true; return; }
  btn.hidden = !state.apiAvailable;
  if (state.liveFrom) {
    const vals = Object.values(state.live);
    const ok = vals.filter((v) => v && v.ok).length;
    note.hidden = false;
    note.textContent = `Live TLS checks from the daily scan on ${fmtDate(new Date(state.liveFrom))}: ${ok} of ${vals.length} hosts answered on port 443.`;
  } else if (!state.apiAvailable) {
    note.hidden = true;
  }
}

function filtered() {
  const r = state.result;
  const q = state.query.trim().toLowerCase();
  let list =
    state.filter === 'all' ? r.lineages
      : state.filter === 'expired' ? r.lineages.filter((l) => l.expired)
        : r.active.filter((l) => l.automation === state.filter);
  if (q) {
    list = list.filter((l) =>
      l.names.some((n) => n.includes(q)) || l.issuer.name.toLowerCase().includes(q) || (l.role && l.role.role.toLowerCase().includes(q)));
  }
  return [...list].sort((a, b) => (a.expired === b.expired ? a.daysLeft - b.daysLeft : a.expired ? 1 : -1));
}

function renderTable() {
  const r = state.result;
  const counts = {
    manual: r.manual.length, unclear: r.unclear.length, automated: r.automated.length,
    expired: r.lineages.length - r.active.length, all: r.lineages.length,
  };
  for (const b of $('seg').querySelectorAll('button')) {
    const label = b.dataset.label || (b.dataset.label = b.textContent);
    b.innerHTML = `${esc(label)}<span class="c">${counts[b.dataset.f]}</span>`;
    b.classList.toggle('on', b.dataset.f === state.filter);
    b.setAttribute('aria-selected', String(b.dataset.f === state.filter));
  }
  $('inv-sub').textContent = `${plural(r.lineages.length, 'certificate lineage')}. Select one to see its history, the reasons for its label and how to automate it.`;

  const tpl = $('row-tpl');
  const body = $('rows');
  body.innerHTML = '';
  const list = filtered();
  const per2029 = renewalsPerYear(47, true);
  for (const l of list.slice(0, 500)) {
    const tr = tpl.content.firstElementChild.cloneNode(true);
    tr.querySelector('.primary').textContent = l.primary;
    const others = l.names.filter((n) => n !== l.primary);
    tr.querySelector('.more').textContent = others.length ? `+ ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}` : '';
    const tags = [];
    if (l.role) tags.push(`<span class="tag">${esc(l.role.role)}</span>`);
    if (l.gaps.length) tags.push(`<span class="tag warn">${plural(l.gaps.length, 'past lapse')}</span>`);
    if (l.flags.some((f) => f.kind === 'distrust')) tags.push('<span class="tag warn">distrusted</span>');
    tr.querySelector('.tags').innerHTML = tags.join('');
    tr.querySelector('.ca').textContent = l.issuer.name;
    const badge = tr.querySelector('.badge');
    const kind = l.expired ? 'expired' : l.automation;
    badge.className = 'badge ' + kind;
    badge.textContent = l.expired ? 'expired' : l.automation === 'manual' ? 'probably manual' : l.automation;
    badge.title = l.reasons.join('\n');
    tr.querySelector('.date').textContent = fmtDate(l.latest.notAfter);
    const left = tr.querySelector('.left');
    left.textContent = l.expired ? `${-l.daysLeft}d ago` : `in ${l.daysLeft}d`;
    left.classList.toggle('soon', !l.expired && l.daysLeft <= 30);
    tr.querySelector('td.num').textContent = l.expired ? '' : l.automation === 'automated' ? 'auto' : per2029.toFixed(1);
    renderLive(tr.querySelector('.livecell'), l);
    const owner = tr.querySelector('.owner');
    owner.value = state.owners[l.key] || '';
    owner.addEventListener('change', () => {
      if (owner.value.trim()) state.owners[l.key] = owner.value.trim();
      else delete state.owners[l.key];
      store('owners:' + state.domain, state.owners);
    });
    const btn = tr.querySelector('.expand');
    const open = state.expanded.has(l.key);
    btn.setAttribute('aria-expanded', String(open));
    tr.classList.toggle('open', open);
    btn.addEventListener('click', () => {
      if (state.expanded.has(l.key)) state.expanded.delete(l.key);
      else state.expanded.add(l.key);
      renderTable();
    });
    tr.dataset.key = l.key;
    body.appendChild(tr);
    if (open) body.appendChild(detailRow(l));
  }
  if (!list.length) body.innerHTML = '<tr><td colspan="7" class="note">Nothing in this view.</td></tr>';
}

function detailRow(l) {
  const tr = document.createElement('tr');
  tr.className = 'detail';
  const td = document.createElement('td');
  td.colSpan = 7;
  const facts = [];
  if (l.medianValidity) facts.push(`Typical lifetime <b>${Math.round(l.medianValidity)} days</b>`);
  if (l.medianLead !== null && l.medianLead !== undefined) {
    facts.push(l.medianLead < 0
      ? `Renewed <b>after</b> expiry`
      : `Renewed about <b>${Math.round(l.medianLead)} days</b> before expiry`);
  }
  facts.push(`<b>${plural(l.certs.length, 'certificate')}</b> since ${fmtShort(l.certs[0].notBefore)}`);
  if (l.gaps.length) facts.push(`<b class="bad">${plural(l.gaps.length, 'lapse')}</b>`);
  const live = state.live[liveHost(l)];
  const recent = [...l.chain].reverse().slice(0, 6);
  const certRows = recent
    .map((c) => {
      const link = c.crtsh && !state.result.demo ? ` · <a href="https://crt.sh/?id=${c.crtsh}" target="_blank" rel="noopener">view on crt.sh</a>` : '';
      return `<li>${fmtDate(c.notBefore)} → ${fmtDate(c.notAfter)} <span class="muted">(${c.validityDays} days, ${esc(c.issuer.name)})</span>${link}</li>`;
    })
    .join('');
  td.innerHTML = `
    <div class="detail-grid">
      <div class="detail-main">
        <p class="facts">${facts.join(' · ')}</p>
        <div class="gantt">${gantt(l)}</div>
        <h4>Why it is labelled ${l.expired ? 'expired' : l.automation === 'manual' ? 'probably manual' : l.automation}</h4>
        <ul class="reasons">${l.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h4>What to do</h4>
        <ul class="guidance">${guidance(l).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="detail-side">
        <h4>Names on the certificate</h4>
        <p class="names">${l.names.map((n) => `<code>${esc(n)}</code>`).join(' ')}</p>
        <h4>Recent certificates</h4>
        <ul class="certs">${certRows}</ul>
        ${live && live.ok ? `<h4>Served right now</h4><p class="names">${esc(live.issuer || '')}<br>expires ${esc((live.validTo || '').slice(0, 10))}${live.trusted ? '' : ` · <span class="bad">${esc(live.authError || 'untrusted')}</span>`}</p>` : ''}
      </div>
    </div>`;
  tr.appendChild(td);
  return tr;
}

// Renewal history as bars on a time axis, with lapses in red.
function gantt(l) {
  const chain = l.chain.slice(-10);
  const now = state.result.now.getTime();
  const t0 = chain[0].notBefore.getTime();
  const t1 = Math.max(now, chain[chain.length - 1].notAfter.getTime());
  const W = 640, rowH = 13, padTop = 18, padL = 4, padR = 4;
  const H = padTop + chain.length * rowH + 22;
  const x = (t) => padL + ((t - t0) / (t1 - t0 || 1)) * (W - padL - padR);
  const bars = chain
    .map((c, i) => {
      const y = padTop + i * rowH;
      const color = c.issuer.kind === 'commercial' ? 'var(--unclear)' : 'var(--auto)';
      return `<rect x="${x(c.notBefore.getTime()).toFixed(1)}" y="${y}" width="${Math.max(2, x(c.notAfter.getTime()) - x(c.notBefore.getTime())).toFixed(1)}" height="${rowH - 4}" rx="2" fill="${color}"><title>${fmtDate(c.notBefore)} → ${fmtDate(c.notAfter)} (${esc(c.issuer.name)})</title></rect>`;
    })
    .join('');
  const gaps = l.gaps
    .filter((g) => g.to.getTime() >= t0)
    .map((g) => `<rect x="${x(g.from.getTime()).toFixed(1)}" y="${padTop - 4}" width="${Math.max(3, x(g.to.getTime()) - x(g.from.getTime())).toFixed(1)}" height="${chain.length * rowH + 4}" fill="var(--manual)" fill-opacity="0.35"><title>${g.days}-day lapse</title></rect>`)
    .join('');
  const years = [];
  for (let y = new Date(t0).getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= t1; y++) years.push(y);
  const yearTicks = years
    .map((y) => `<line class="axis" x1="${x(Date.UTC(y, 0, 1))}" x2="${x(Date.UTC(y, 0, 1))}" y1="${padTop - 6}" y2="${H - 18}"/><text x="${x(Date.UTC(y, 0, 1))}" y="${H - 5}" text-anchor="middle">${y}</text>`)
    .join('');
  const nowLine = `<line class="today" x1="${x(now)}" x2="${x(now)}" y1="${padTop - 8}" y2="${H - 18}"/><text x="${Math.min(W - 20, x(now))}" y="10" text-anchor="middle">today</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Renewal history for ${esc(l.primary)}">${yearTicks}${gaps}${bars}${nowLine}</svg>`;
}

function renderLive(cell, l) {
  const host = liveHost(l);
  const res = host && state.live[host];
  if (!host) { cell.textContent = 'wildcard'; return; }
  if (!res) { cell.textContent = '–'; return; }
  if (res === 'pending') { cell.textContent = 'checking…'; return; }
  if (!res.ok) { cell.innerHTML = `<span class="bad" title="${esc(res.error)}">no TLS</span>`; return; }
  const to = new Date(res.validTo);
  const ref = state.liveFrom ? Date.parse(state.liveFrom) : Date.now();
  const days = Math.floor((to - ref) / DAY);
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
  const order = [...r.manual, ...r.unclear, ...r.automated];
  const hosts = [...new Set(order.map(liveHost).filter(Boolean))].slice(0, 60);
  btn.disabled = true;
  note.hidden = false;
  note.textContent = `Connecting to ${plural(hosts.length, 'host')} on port 443…`;
  for (const h of hosts) state.live[h] = 'pending';
  renderTable();
  for (let i = 0; i < hosts.length; i += 10) {
    const batch = hosts.slice(i, i + 10);
    try {
      const out = await fetchJSON(`api/tls?host=${batch.join(',')}`, 30000);
      for (const res of out.results) state.live[res.host] = res;
    } catch {
      for (const h of batch) state.live[h] = { host: h, ok: false, error: 'check failed' };
    }
    renderTable();
  }
  btn.disabled = false;
  const vals = hosts.map((h) => state.live[h]).filter((x) => x && x.ok);
  const mismatched = r.active.filter((l) => {
    const v = state.live[liveHost(l)];
    return v && v.ok && Math.abs(new Date(v.validTo) - l.latest.notAfter) >= 2 * DAY;
  }).length;
  note.textContent = `${vals.length} of ${hosts.length} hosts answered on port 443. ${mismatched} serve a different certificate than the newest one in CT (≠CT), which usually means a stale cert, a CDN, or a load balancer with its own cert.`;
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- watchlist board ----------
async function loadBoard() {
  let index;
  try {
    index = await fetchJSON('monitor/index.json', 8000);
  } catch {
    return;
  }
  if (!index || !Array.isArray(index.domains) || !index.domains.length) return;
  $('board-sub').textContent = `Scanned by GitHub Actions on ${fmtDate(new Date(index.generatedAt))}, with live TLS checks. Fork the repo to watch your own domains.`;
  $('board-cards').innerHTML = index.domains
    .map((d) => {
      if (d.error) {
        return `<div class="bcard"><div class="bhead"><span class="bdomain">${esc(d.domain)}</span><span class="grade small g-na">–</span></div><p class="note">${esc(d.error)}</p></div>`;
      }
      const next = d.nextExpiry ? `next expiry ${esc(d.nextExpiry.host)} in ${d.nextExpiry.daysLeft}d` : '';
      return `<button type="button" class="bcard" data-domain="${esc(d.domain)}">
        <span class="bhead"><span class="bdomain">${esc(d.domain)}</span><span class="grade small g-${esc(d.grade === '–' ? 'na' : d.grade)}">${esc(d.grade)}</span></span>
        <span class="bstats"><b>${d.manual}</b> of ${d.live} look manual · <b>${d.manualRenewals2029}</b>/yr by 2029</span>
        <span class="bstats">${next}${d.liveProblems ? ` · <span class="bad">${plural(d.liveProblems, 'live problem')}</span>` : ''}${d.scope === 'current' ? ' · current certificates only' : ''}</span>
      </button>`;
    })
    .join('');
  $('board').hidden = false;
}

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
$('attention').addEventListener('click', (e) => {
  const b = e.target.closest('.jump');
  if (!b) return;
  const l = state.result.lineages.find((x) => x.key === b.dataset.key);
  if (!l) return;
  state.filter = l.expired ? 'expired' : l.automation;
  state.query = '';
  $('search').value = '';
  state.expanded.add(l.key);
  renderTable();
  const row = [...document.querySelectorAll('#rows tr.row')].find((tr) => tr.dataset.key === l.key);
  if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.querySelector('.expand').focus({ preventScroll: true }); }
});
$('board-cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-domain]');
  if (!b) return;
  $('domain').value = b.dataset.domain;
  scan(b.dataset.domain);
});
$('live').addEventListener('click', checkLive);
$('csv').addEventListener('click', () => download(`cert-radar-${state.domain}.csv`, toCSV(state.result.lineages, state.owners), 'text/csv'));
$('ics').addEventListener('click', () =>
  download(`cert-radar-${state.domain}.ics`, toICS(state.result.active.filter((l) => l.automation !== 'automated'), state.owners, state.result.now), 'text/calendar'),
);
$('json').addEventListener('click', () =>
  download(`cert-radar-${state.domain}.json`, JSON.stringify(toReport(state.domain, state.result, { source: state.sourceNote }), null, 2), 'application/json'),
);
$('print').addEventListener('click', () => {
  // Open the manual ones so the printed report carries their history and guidance.
  for (const l of state.result.manual) state.expanded.add(l.key);
  renderTable();
  setTimeout(() => window.print(), 50);
});
$('share').addEventListener('click', async () => {
  const btn = $('share');
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = 'Link copied';
  } catch {
    btn.textContent = 'Copy the address bar';
  }
  setTimeout(() => { btn.textContent = 'Copy link'; }, 2000);
});

renderCountdown();
if (EMBED) {
  for (const id of ['live', 'csv', 'ics', 'json', 'print', 'share']) $(id).hidden = true;
  $('domain').value = DEMO_DOMAIN;
  scan(DEMO_DOMAIN, { demo: true, scroll: false });
} else {
  loadBoard();
  const initial = new URL(location.href).searchParams.get('d');
  if (initial === 'demo') $('demo').click();
  else if (initial && cleanDomain(initial)) { $('domain').value = cleanDomain(initial); scan(cleanDomain(initial)); }
}
