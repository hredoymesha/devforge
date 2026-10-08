// Network tab: live capture of fetch/XHR/WebSocket/SSE/beacon (MAIN-world netcap.js), timing-only
// rows from the Resource Timing API, waterfall, request detail, replay, copy-as, HAR export and
// interception rules (block / mock / delay / headers / redirect).
const net = {
  filter: 'all',
  errorsOnly: false,
  query: '',
  redact: true,
  live: true,
  sort: { key: 'start', dir: 1 },
  rows: new Map(), // live capture id -> summary row
  timing: new Map(), // live capture id -> matched Resource Timing record
  perfOnly: [], // Resource Timing records with no captured counterpart
  rev: 0,
  startedAt: 0,
  captureOn: false,
  clearedAt: 0, // perf timestamp; timing-only rows older than this are hidden after "Clear"
  selId: null,
  detailTab: 'overview',
  rules: [],
  hits: {},
  pushedRules: null,
};
const NET_FILTERS = [
  ['all', 'All'],
  ['api', 'Fetch/XHR'],
  ['js', 'JS'],
  ['css', 'CSS'],
  ['img', 'Img'],
  ['font', 'Font'],
  ['media', 'Media'],
  ['doc', 'Doc'],
  ['ws', 'WS/SSE'],
  ['other', 'Other'],
];
const RULE_ACTIONS = {
  block: 'Block (network error)',
  mock: 'Mock response',
  delay: 'Add latency',
  headers: 'Set request headers',
  redirect: 'Redirect to URL',
};
const PERSIST_ID = 'df-netcap';

/* ---------- data ---------- */
const extCategory = (u) => {
  const p = (() => {
    try {
      return new URL(u).pathname;
    } catch (_) {
      return u;
    }
  })();
  if (/\.m?js$/i.test(p)) return 'js';
  if (/\.css$/i.test(p)) return 'css';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(p)) return 'img';
  if (/\.(woff2?|ttf|otf|eot)$/i.test(p)) return 'font';
  if (/\.(mp4|webm|mp3|ogg|wav|m4a|m3u8|mov)$/i.test(p)) return 'media';
  if (/\.(html?|php|aspx?)$/i.test(p)) return 'doc';
  return null;
};
function categoryOf(r) {
  if (r.kind === 'fetch' || r.kind === 'xhr' || r.kind === 'beacon') return 'api';
  if (r.kind === 'websocket' || r.kind === 'sse') return 'ws';
  const it = r.initiatorType;
  if (it === 'fetch' || it === 'xmlhttprequest' || it === 'beacon') return 'api';
  if (it === 'script') return 'js';
  if (it === 'img' || it === 'image' || it === 'imageset') return 'img';
  if (it === 'iframe' || it === 'frame' || it === 'navigation') return 'doc';
  if (it === 'video' || it === 'audio' || it === 'track') return 'media';
  const byExt = extCategory(r.url);
  if (byExt) return byExt;
  if (it === 'link' || it === 'css') return 'css';
  return 'other';
}

// Resource Timing records, read in the isolated world (it shares the page's performance timeline).
function readResourceTimings() {
  return performance.getEntriesByType('resource').map((r) => ({
    url: r.name,
    initiatorType: r.initiatorType,
    startTime: r.startTime,
    duration: r.duration,
    fetchStart: r.fetchStart,
    redirectStart: r.redirectStart,
    redirectEnd: r.redirectEnd,
    domainLookupStart: r.domainLookupStart,
    domainLookupEnd: r.domainLookupEnd,
    connectStart: r.connectStart,
    connectEnd: r.connectEnd,
    secureConnectionStart: r.secureConnectionStart,
    requestStart: r.requestStart,
    responseStart: r.responseStart,
    responseEnd: r.responseEnd,
    transferSize: r.transferSize,
    encodedBodySize: r.encodedBodySize,
    decodedBodySize: r.decodedBodySize,
    nextHopProtocol: r.nextHopProtocol,
    responseStatus: r.responseStatus || null,
    renderBlockingStatus: r.renderBlockingStatus || null,
    deliveryType: r.deliveryType || '',
    serverTiming: (r.serverTiming || []).map((s) => ({
      name: s.name,
      dur: s.duration,
      desc: s.description,
    })),
  }));
}

async function pollNet() {
  const res = await exec(
    (rev) => (window.__dfNet && window.__dfNet.changes ? window.__dfNet.changes(rev) : null),
    [net.rev],
    'MAIN'
  );
  if (!res) {
    net.captureOn = false;
    net.rows.clear();
    net.rev = 0;
  } else {
    // A different startedAt means the page reloaded (persistent capture) and the log restarted.
    if (res.startedAt !== net.startedAt || res.rev < net.rev) {
      net.rows.clear();
      net.timing.clear();
      net.startedAt = res.startedAt;
    }
    net.captureOn = true;
    for (const e of res.entries) net.rows.set(e.id, e);
    const alive = new Set(res.ids);
    for (const id of net.rows.keys()) if (!alive.has(id)) net.rows.delete(id);
    net.rev = res.rev;
    if (net.pushedRules !== net.startedAt || res.rules !== activeRules().length) await pushRules();
    net.hits = (await exec(() => window.__dfNet.ruleHits(), [], 'MAIN').catch(() => null)) || {};
  }
  matchTimings(await exec(readResourceTimings, []));
}

// Pairs captured requests with their Resource Timing record (same URL, nearest start time).
function matchTimings(timings) {
  const byUrl = new Map();
  for (const t of timings) {
    if (!byUrl.has(t.url)) byUrl.set(t.url, []);
    byUrl.get(t.url).push(t);
  }
  const used = new Set();
  for (const r of net.rows.values()) {
    if (r.kind === 'websocket' || r.kind === 'sse' || r.start == null) continue;
    const cands = byUrl.get(r.redirectedTo || r.url);
    if (!cands) continue;
    let best = null;
    for (const c of cands)
      if (!used.has(c) && Math.abs(c.startTime - r.start) < 250)
        if (!best || Math.abs(c.startTime - r.start) < Math.abs(best.startTime - r.start)) best = c;
    if (best) {
      used.add(best);
      net.timing.set(r.id, best);
    }
  }
  net.perfOnly = timings.filter((t) => !used.has(t) && t.startTime >= net.clearedAt);
}

// One normalised row shape for both captured and timing-only entries.
function allRows() {
  const out = [];
  for (const r of net.rows.values()) {
    const t = net.timing.get(r.id);
    out.push({
      ...r,
      cat: categoryOf(r),
      startT: t ? t.startTime : r.start,
      ms: r.ms != null ? r.ms : t ? Math.round(t.duration) : null,
      transfer: t ? t.transferSize : null,
      size: t && t.decodedBodySize ? t.decodedBodySize : r.size || r.resBodySize || 0,
      protocol: t ? t.nextHopProtocol : null,
      timingRec: t || null,
    });
  }
  net.perfOnly.forEach((t, i) =>
    out.push({
      id: 'p' + i,
      perf: true,
      kind: 'perf',
      initiatorType: t.initiatorType,
      method: 'GET',
      url: t.url,
      status: t.responseStatus,
      cat: categoryOf({ url: t.url, initiatorType: t.initiatorType }),
      startT: t.startTime,
      ms: Math.round(t.duration),
      transfer: t.transferSize,
      size: t.decodedBodySize,
      protocol: t.nextHopProtocol,
      timingRec: t,
    })
  );
  return out;
}

/* DevTools-style filter: words must all match the URL; `-word` excludes; `status:4xx`,
   `method:post`, `domain:cdn`, `larger-than:100k`, `is:mocked|blocked|error|cached`. */
function parseQuery(q) {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const neg = tok[0] === '-' && tok.length > 1;
      const body = neg ? tok.slice(1) : tok;
      const m = /^([a-z-]+):(.+)$/i.exec(body);
      return { neg, key: m ? m[1].toLowerCase() : null, val: (m ? m[2] : body).toLowerCase() };
    });
}
function sizeArg(v) {
  const m = /^(\d+(?:\.\d+)?)(k|m)?b?$/i.exec(v);
  if (!m) return Infinity;
  return +m[1] * (m[2] === 'k' ? 1024 : m[2] === 'm' ? 1048576 : 1);
}
function rowMatches(r, terms) {
  if (net.filter !== 'all' && r.cat !== net.filter) return false;
  if (net.errorsOnly && !(r.error || r.status >= 400 || r.blocked)) return false;
  for (const t of terms) {
    let hit;
    switch (t.key) {
      case 'status': {
        const s = String(r.status || 0);
        hit = /x/.test(t.val)
          ? new RegExp('^' + t.val.replace(/x/g, '\\d') + '$').test(s)
          : s === t.val;
        break;
      }
      case 'method':
        hit = (r.method || '').toLowerCase() === t.val;
        break;
      case 'domain':
        try {
          hit = new URL(r.url).host.toLowerCase().includes(t.val);
        } catch (_) {
          hit = false;
        }
        break;
      case 'larger-than':
        hit = (r.size || r.transfer || 0) > sizeArg(t.val);
        break;
      case 'is':
        hit =
          t.val === 'mocked'
            ? !!r.mocked
            : t.val === 'blocked'
              ? !!r.blocked
              : t.val === 'error'
                ? !!(r.error || r.status >= 400)
                : t.val === 'cached'
                  ? !!(
                      r.timingRec &&
                      r.timingRec.transferSize === 0 &&
                      r.timingRec.decodedBodySize > 0
                    )
                  : t.val === 'ruled'
                    ? !!(r.rules && r.rules.length)
                    : false;
        break;
      default:
        hit = (r.method + ' ' + r.url + ' ' + (r.status || '')).toLowerCase().includes(t.val);
    }
    if (hit === t.neg) return false;
  }
  return true;
}
function sortRows(rows) {
  const { key, dir } = net.sort;
  const val = (r) =>
    key === 'ms'
      ? r.ms || 0
      : key === 'size'
        ? r.size || 0
        : key === 'status'
          ? r.status || 0
          : key === 'name'
            ? r.url
            : r.startT || 0;
  return rows.sort((a, b) => {
    const x = val(a),
      y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/* ---------- rules ---------- */
const activeRules = () => net.rules.filter((r) => r.enabled !== false);
async function loadRules() {
  const { netRules } = await chrome.storage.local.get('netRules');
  net.rules = Array.isArray(netRules) ? netRules : [];
}
async function saveRules() {
  await chrome.storage.local.set({ netRules: net.rules });
  if (net.captureOn) await pushRules();
}
async function pushRules() {
  const rules = activeRules();
  await exec((list) => window.__dfNet && window.__dfNet.setRules(list), [rules], 'MAIN');
  net.pushedRules = net.startedAt;
}
function validateRule(r) {
  if (r.regex)
    try {
      new RegExp(r.match);
    } catch (e) {
      throw new Error('Invalid regular expression: ' + e.message);
    }
  if (r.action === 'mock') {
    const s = +r.status;
    if (!(s >= 200 && s <= 599)) throw new Error('Mock status must be between 200 and 599.');
  }
  if (r.action === 'delay' && !(+r.delay >= 0 && +r.delay <= 60000))
    throw new Error('Latency must be 0–60000 ms.');
  if (r.action === 'redirect' && !r.redirect) throw new Error('Enter the URL to redirect to.');
  if (!r.match && r.action !== 'delay' && r.action !== 'headers')
    throw new Error('Enter a URL pattern, otherwise the rule would hit every request.');
}
const ruleSummary = (r) =>
  r.action === 'mock'
    ? `mock ${r.status} ${r.contentType || ''}`
    : r.action === 'delay'
      ? `+${r.delay} ms`
      : r.action === 'headers'
        ? 'set ' + Object.keys(r.headers || {}).join(', ')
        : r.action === 'redirect'
          ? '→ ' + r.redirect
          : 'block';

/* ---------- capture control ---------- */
async function startCapture() {
  await exec(null, [], 'MAIN', ['netcap.js']);
  // The default Resource Timing buffer holds 250 entries; busy pages overflow it quickly.
  await exec(() => performance.setResourceTimingBufferSize(3000), []);
  net.rev = 0;
  await pollNet();
  await pushRules();
}
async function persistentOrigins() {
  const regs = await chrome.scripting.getRegisteredContentScripts({ ids: [PERSIST_ID] });
  return regs[0] ? regs[0].matches : [];
}
async function setPersistent(on) {
  const origin = new URL(DF.state.url).origin;
  const pattern = origin + '/*';
  const perm = await ensureOrigins([DF.state.url]);
  if (on && perm.denied.length)
    throw new Error('Capturing from page start needs permanent access to ' + origin + '.');
  const current = await persistentOrigins();
  const next = on ? [...new Set([...current, pattern])] : current.filter((m) => m !== pattern);
  if (current.length) await chrome.scripting.unregisterContentScripts({ ids: [PERSIST_ID] });
  if (next.length)
    await chrome.scripting.registerContentScripts([
      {
        id: PERSIST_ID,
        matches: next,
        js: ['netcap.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
  return next;
}

/* ---------- detail ---------- */
async function fullEntry(id) {
  const e = await exec((i) => (window.__dfNet ? window.__dfNet.get(i) : null), [id], 'MAIN');
  if (!e) throw new Error('This request is no longer in the capture log.');
  return e;
}
const view = (e) => (net.redact ? redactEntry(e) : e);
function prettyBody(b) {
  if (b == null) return '';
  const t = String(b).trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch (_) {
      /* truncated or not JSON */
    }
  }
  return String(b);
}
function headerTable(obj) {
  const ents = Object.entries(obj || {});
  return ents.length
    ? table(
        ['Header', 'Value'],
        ents.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [mono(k), mono(String(v))]),
        { class: 'compact' }
      )
    : h('div', { class: 'sev-info' }, 'none');
}
function phaseBars(t) {
  const ph = DFHar.timingPhases(t);
  if (!ph)
    return h('div', { class: 'sev-info' }, 'No Resource Timing record matched this request.');
  const rows = [
    ['Queued / stalled', ph.queued, 'q'],
    ['Redirect', ph.redirect, 'r'],
    ['DNS lookup', ph.dns, 'dns'],
    ['TCP connect', ph.connect, 'tcp'],
    ['TLS handshake', ph.tls, 'tls'],
    ['Waiting (TTFB)', ph.wait, 'wait'],
    ['Content download', ph.download, 'dl'],
  ];
  const total = Math.max(1, ph.total);
  let offset = 0;
  const grid = h(
    'div',
    { class: 'phases' },
    rows.map(([label, ms, cls]) => {
      const left = (offset / total) * 100;
      offset += ms;
      return h(
        'div',
        { class: 'phase' },
        h('span', null, label),
        h(
          'span',
          { class: 'phase-track' },
          ms
            ? h('i', {
                class: 'ph-' + cls,
                style: { left: left + '%', width: Math.max(0.5, (ms / total) * 100) + '%' },
              })
            : ''
        ),
        h('span', { class: 'mono' }, ms ? fmtMs(ms) : '–')
      );
    })
  );
  const cached = t.transferSize === 0 && t.decodedBodySize > 0;
  return h(
    'div',
    null,
    grid,
    ph.restricted
      ? h(
          'div',
          { class: 'sev-warn' },
          'Detailed phases are hidden: this cross-origin server does not send Timing-Allow-Origin.'
        )
      : '',
    kv({
      total: fmtMs(ph.total),
      protocol: t.nextHopProtocol || '–',
      transferred: cached ? 'served from cache' : fmtBytes(t.transferSize),
      'encoded / decoded':
        fmtBytes(t.encodedBodySize) +
        ' / ' +
        fmtBytes(t.decodedBodySize) +
        (t.encodedBodySize && t.decodedBodySize > t.encodedBodySize
          ? ` (${Math.round((1 - t.encodedBodySize / t.decodedBodySize) * 100)}% compressed)`
          : ''),
      'render blocking': t.renderBlockingStatus || '–',
      delivery: t.deliveryType || (cached ? 'cache' : 'network'),
    })
  );
}
function serverTimingBlock(list) {
  if (!list || !list.length) return '';
  const max = Math.max(...list.map((s) => s.dur || 0), 1);
  return section(
    'Server-Timing',
    h(
      'div',
      { class: 'phases' },
      list.map((s) =>
        h(
          'div',
          { class: 'phase' },
          h('span', null, s.desc ? `${s.name} (${s.desc})` : s.name),
          h(
            'span',
            { class: 'phase-track' },
            s.dur
              ? h('i', { class: 'ph-wait', style: { left: 0, width: (s.dur / max) * 100 + '%' } })
              : ''
          ),
          h('span', { class: 'mono' }, s.dur != null ? fmtMs(s.dur) : '–')
        )
      )
    )
  );
}

function renderDetail(box, row) {
  clear(box);
  if (!row) return;
  const head = h(
    'div',
    { class: 'detail-head' },
    h('b', null, row.method || 'GET'),
    h(
      'span',
      { class: 'mono grow ellipsis', title: row.url },
      net.redact ? redactUrl(row.url) : row.url
    ),
    h(
      'button',
      {
        class: 'icon ghost',
        'aria-label': 'Close request details',
        on: {
          click: () => {
            net.selId = null;
            clear(box);
            box.dispatchEvent(new CustomEvent('df-closed', { bubbles: true }));
          },
        },
      },
      '✕'
    )
  );
  box.append(head);
  if (row.perf) {
    box.append(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'sev-info' },
          'Timing-only entry from the Performance API: the browser exposes no headers or body for it. ' +
            (row.cat === 'api'
              ? 'It happened before capture was enabled; enable capture (or capture from page start) to see details.'
              : 'Loads started by the browser itself (scripts, styles, images) never pass through page JavaScript.')
        ),
        kv({ initiator: row.initiatorType, status: row.status || 'not exposed' })
      ),
      section('Timing', phaseBars(row.timingRec)),
      serverTimingBlock(row.timingRec.serverTiming)
    );
    return;
  }
  const body = h('div', null, loading('Loading request'));
  box.append(body);
  fullEntry(row.id)
    .then((raw) => {
      const e = view(raw);
      const gql = DFHar.graphqlInfo(raw);
      const st = DFHar.parseServerTiming((raw.resHeaders || {})['server-timing']);
      clear(body).append(
        miniTabs(
          [
            [
              'overview',
              'Overview',
              (c) =>
                c.append(
                  kv({
                    status:
                      e.status == null
                        ? e.error
                          ? 'failed'
                          : 'pending'
                        : e.status + ' ' + (e.statusText || ''),
                    type: e.kind + (e.redirected ? ' (redirected)' : ''),
                    duration: fmtMs(e.ms),
                    size: fmtBytes(row.size),
                    protocol: row.protocol || '–',
                    error: e.error,
                    rules:
                      e.rules && e.rules.length ? e.rules.map((x) => x.action).join(', ') : null,
                    mocked: e.mocked ? 'yes: no request reached the server' : null,
                    'redirected to': e.redirectedTo,
                  }),
                  gql
                    ? section(
                        'GraphQL',
                        table(
                          ['Operation', 'Type', 'Variables'],
                          gql.map((o) => [
                            mono(o.operationName),
                            o.type,
                            mono(
                              o.variables
                                ? JSON.stringify(
                                    net.redact ? redactValue(o.variables) : o.variables
                                  ).slice(0, 200)
                                : '–'
                            ),
                          ])
                        )
                      )
                    : '',
                  e.initiator
                    ? section(
                        'Initiator (call stack)',
                        codeBlock(e.initiator.split(' | ').join('\n'))
                      )
                    : '',
                  h(
                    'div',
                    { class: 'row' },
                    h(
                      'button',
                      { on: { click: () => openRuleForm(ruleFromEntry(raw)) } },
                      '＋ Rule from this request'
                    )
                  )
                ),
            ],
            [
              'headers',
              'Headers',
              (c) =>
                c.append(
                  section('Request headers', headerTable(e.reqHeaders)),
                  section('Response headers', headerTable(e.resHeaders)),
                  serverTimingBlock(st)
                ),
            ],
            [
              'payload',
              'Payload',
              (c) => {
                let q = null;
                try {
                  q = [...new URL(e.url).searchParams];
                } catch (_) {}
                c.append(
                  q && q.length
                    ? section(
                        'Query string',
                        table(
                          ['Name', 'Value'],
                          q.map(([k, v]) => [mono(k), mono(v)]),
                          { class: 'compact' }
                        )
                      )
                    : '',
                  e.reqBody
                    ? section(
                        'Request body (' + fmtBytes(e.reqBody.length) + ')',
                        codeBlock(prettyBody(e.reqBody).slice(0, 50000))
                      )
                    : h('div', { class: 'sev-info' }, 'No request body.')
                );
              },
            ],
            [
              'response',
              e.kind === 'websocket' || e.kind === 'sse' ? 'Messages' : 'Response',
              (c) => {
                if (e.frames) {
                  c.append(
                    h(
                      'div',
                      { class: 'sev-info' },
                      `${e.sent || 0} sent · ${e.received || 0} received` +
                        (e.closed
                          ? ` · closed ${e.closed.code}${e.closed.reason ? ' ' + e.closed.reason : ''}`
                          : '')
                    ),
                    e.frames.length
                      ? table(
                          ['', 'Time', 'Size', 'Data'],
                          e.frames
                            .slice()
                            .reverse()
                            .map((f) => [
                              h(
                                'span',
                                { class: f.dir === 'in' ? 'sev-ok' : 'acc' },
                                f.dir === 'in' ? '↓' : '↑'
                              ),
                              fmtMs(f.t),
                              f.size != null ? fmtBytes(f.size) : '',
                              mono(f.data),
                            ]),
                          { class: 'compact' }
                        )
                      : h('div', { class: 'sev-info' }, 'No messages yet.')
                  );
                  return;
                }
                if (e.resBody == null) {
                  c.append(
                    h(
                      'div',
                      { class: 'sev-info' },
                      e.status == null && !e.error
                        ? 'Waiting for the response…'
                        : 'Body not captured (binary or non-text content type).'
                    )
                  );
                  return;
                }
                const text = prettyBody(e.resBody);
                c.append(
                  h(
                    'div',
                    { class: 'row' },
                    h(
                      'span',
                      { class: 'sev-info grow' },
                      fmtBytes(raw.resBody.length) +
                        (e.resTruncated ? ' (truncated at 200 KB)' : '')
                    ),
                    h('button', { on: { click: () => copy(text) } }, 'Copy'),
                    h(
                      'button',
                      {
                        on: {
                          click: () =>
                            download(
                              'response-' + e.id + '-' + stamp() + '.txt',
                              text,
                              'text/plain'
                            ),
                        },
                      },
                      'Download'
                    )
                  ),
                  codeBlock(text.slice(0, 60000))
                );
              },
            ],
            ['timing', 'Timing', (c) => c.append(phaseBars(row.timingRec))],
            ['replay', 'Edit & replay', (c) => replayForm(c, e)],
            ['copy', 'Copy as', (c) => copyAsPane(c, e, row)],
          ],
          net.detailTab
        )
      );
      body
        .querySelectorAll('.seg [role=tab]')
        .forEach((b) => b.addEventListener('click', () => (net.detailTab = b.dataset.id)));
    })
    .catch((err) => clear(body).append(h('div', { class: 'sev-error' }, err.message)));
}

function copyAsPane(c, e, row) {
  const out = h('div');
  const showSnippet = (label, text) => {
    clear(out).append(
      h(
        'div',
        { class: 'row' },
        h('b', { class: 'grow' }, label),
        h('button', { on: { click: () => copy(text) } }, 'Copy')
      ),
      codeBlock(text)
    );
  };
  c.append(
    net.redact
      ? h(
          'div',
          { class: 'sev-warn' },
          'Redaction is on, so secrets appear as [redacted]. Turn it off to copy working credentials.'
        )
      : h(
          'div',
          { class: 'sev-warn' },
          'Redaction is off: snippets include real tokens and cookies. Do not paste them anywhere public.'
        ),
    h(
      'div',
      { class: 'row' },
      h('button', { on: { click: () => showSnippet('cURL (bash)', DFHar.toCurl(e)) } }, 'cURL'),
      h('button', { on: { click: () => showSnippet('fetch()', DFHar.toFetch(e)) } }, 'fetch'),
      h(
        'button',
        { on: { click: () => showSnippet('PowerShell', DFHar.toPowerShell(e)) } },
        'PowerShell'
      ),
      h(
        'button',
        {
          on: {
            click: () =>
              showSnippet(
                'HAR entry',
                JSON.stringify(
                  DFHar.toHar([e], { timing: { [e.id]: row.timingRec }, pageUrl: DF.state.url }).log
                    .entries[0],
                  null,
                  2
                )
              ),
          },
        },
        'HAR entry'
      )
    ),
    out
  );
  showSnippet('cURL (bash)', DFHar.toCurl(e));
}

function replayForm(c, e) {
  const method = h(
    'select',
    { 'aria-label': 'Method' },
    ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) =>
      h('option', { value: m, selected: m === e.method }, m)
    )
  );
  const url = h('input', { class: 'grow', value: e.url, 'aria-label': 'URL' });
  const headers = h('textarea', { rows: 5, 'aria-label': 'Headers (JSON)', spellcheck: 'false' });
  const strip =
    /^(host|content-length|cookie|connection|accept-encoding|origin|referer|user-agent|sec-.*)$/i;
  headers.value = JSON.stringify(
    Object.fromEntries(Object.entries(e.reqHeaders || {}).filter(([k]) => !strip.test(k))),
    null,
    2
  );
  const body = h('textarea', { rows: 5, 'aria-label': 'Body', spellcheck: 'false' });
  body.value = e.reqBody && !/^\[.*\]$/.test(e.reqBody) ? prettyBody(e.reqBody) : '';
  const result = h('div');
  const send = async () => {
    let hdrs;
    try {
      hdrs = headers.value.trim() ? JSON.parse(headers.value) : {};
    } catch (err) {
      throw new Error('Headers must be a JSON object: ' + err.message);
    }
    const m = method.value;
    if (
      !/^(GET|HEAD|OPTIONS)$/.test(m) &&
      !confirm(`Send this ${m} request again? It may change data on the server.`)
    )
      return;
    clear(result).append(loading('Sending'));
    const r = await exec(
      async (spec) => {
        const t0 = performance.now();
        try {
          const res = await fetch(spec.url, {
            method: spec.method,
            headers: spec.headers,
            body: /^(GET|HEAD)$/.test(spec.method) ? undefined : spec.body,
            credentials: 'include',
          });
          const text = spec.method === 'HEAD' ? '' : await res.text();
          return {
            ok: true,
            status: res.status,
            statusText: res.statusText,
            ms: Math.round(performance.now() - t0),
            headers: Object.fromEntries(res.headers),
            body: text.slice(0, 100000),
            size: text.length,
          };
        } catch (err) {
          return {
            ok: false,
            error: String(err && err.message),
            ms: Math.round(performance.now() - t0),
          };
        }
      },
      [{ url: url.value.trim(), method: m, headers: hdrs, body: body.value }],
      'MAIN'
    );
    clear(result);
    if (!r.ok) {
      result.append(
        h('div', { class: 'sev-error' }, `Failed after ${fmtMs(r.ms)}: ${r.error}`),
        h(
          'div',
          { class: 'sev-info' },
          "Cross-origin requests are subject to the page's CORS rules, exactly like page code."
        )
      );
      return;
    }
    result.append(
      h(
        'div',
        { class: r.status >= 400 ? 'sev-error' : 'sev-ok' },
        `${r.status} ${r.statusText} · ${fmtMs(r.ms)} · ${fmtBytes(r.size)}`
      ),
      h(
        'details',
        null,
        h('summary', null, 'Response headers'),
        headerTable(net.redact ? redactHeaders(r.headers) : r.headers)
      ),
      codeBlock(prettyBody(net.redact ? redactBody(r.body) : r.body).slice(0, 60000))
    );
  };
  c.append(
    h(
      'div',
      { class: 'sev-info' },
      'Re-sends from the page with its cookies, so the server sees it as the page itself. ' +
        (net.redact
          ? 'Redacted values are prefilled as [redacted]; turn redaction off to reuse real tokens.'
          : '')
    ),
    h('div', { class: 'row' }, method, url),
    h('label', { class: 'lbl' }, 'Headers (JSON)'),
    headers,
    h('label', { class: 'lbl' }, 'Body'),
    body,
    h('div', { class: 'row' }, h('button', { class: 'primary', on: { click: send } }, 'Send')),
    result
  );
}

/* ---------- rule editor ---------- */
function ruleFromEntry(e) {
  let match = e.url;
  try {
    const u = new URL(e.url);
    match = u.host + u.pathname;
  } catch (_) {}
  return {
    match,
    regex: false,
    method: e.method || '*',
    kinds: 'any',
    action: 'mock',
    status: e.status && e.status >= 200 ? e.status : 200,
    contentType: (e.resHeaders || {})['content-type'] || 'application/json',
    body:
      typeof e.resBody === 'string' && !/^\[.*\]$/.test(e.resBody) ? prettyBody(e.resBody) : '{}',
  };
}
let openRuleForm = () => {};
function rulesSection(onChange) {
  const wrap = h('div');
  const list = h('div');
  const formBox = h('div');
  const drawList = () => {
    clear(list);
    if (!net.rules.length) {
      list.append(
        h(
          'div',
          { class: 'sev-info' },
          'No rules yet. Rules can block requests, return mock responses, add latency, set headers or redirect, for fetch/XHR made by page scripts.'
        )
      );
      return;
    }
    list.append(
      table(
        ['On', 'Match', 'Action', 'Hits', ''],
        net.rules.map((r, i) => [
          h('input', {
            type: 'checkbox',
            checked: r.enabled !== false,
            'aria-label': 'Enable rule',
            on: {
              change: async (ev) => {
                r.enabled = ev.target.checked;
                await saveRules();
                onChange();
              },
            },
          }),
          h(
            'div',
            null,
            mono(
              (r.method && r.method !== '*' ? r.method + ' ' : '') +
                (r.regex ? '/' + r.match + '/' : r.match || '(any URL)')
            )
          ),
          ruleSummary(r),
          String(net.hits[r.id] || 0),
          h(
            'span',
            { class: 'nowrap' },
            h(
              'button',
              {
                class: 'icon ghost',
                'aria-label': 'Edit rule',
                title: 'Edit',
                on: { click: () => openRuleForm(r, i) },
              },
              '✎'
            ),
            h(
              'button',
              {
                class: 'icon ghost',
                'aria-label': 'Delete rule',
                title: 'Delete',
                on: {
                  click: async () => {
                    net.rules.splice(i, 1);
                    await saveRules();
                    drawList();
                    onChange();
                  },
                },
              },
              '✕'
            )
          ),
        ]),
        { class: 'compact' }
      )
    );
  };
  openRuleForm = (preset, index) => {
    const r = {
      match: '',
      regex: false,
      method: '*',
      kinds: 'any',
      action: 'block',
      status: 200,
      contentType: 'application/json',
      body: '{}',
      delay: 1000,
      ...(preset || {}),
    };
    const f = {
      match: h('input', {
        class: 'grow',
        value: r.match,
        placeholder: 'URL contains… (e.g. /api/users)',
        'aria-label': 'URL pattern',
      }),
      regex: h('input', { type: 'checkbox', checked: r.regex }),
      method: h(
        'select',
        { 'aria-label': 'Method' },
        ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) =>
          h('option', { value: m, selected: m === (r.method || '*') }, m === '*' ? 'any method' : m)
        )
      ),
      kinds: h(
        'select',
        { 'aria-label': 'Applies to' },
        [
          ['any', 'fetch + XHR + beacon'],
          ['fetch', 'fetch only'],
          ['xhr', 'XHR only'],
          ['beacon', 'sendBeacon only'],
        ].map(([v, l]) => h('option', { value: v, selected: v === r.kinds }, l))
      ),
      action: h(
        'select',
        { 'aria-label': 'Action' },
        Object.entries(RULE_ACTIONS).map(([v, l]) =>
          h('option', { value: v, selected: v === r.action }, l)
        )
      ),
      status: h('input', {
        type: 'number',
        min: 200,
        max: 599,
        value: r.status,
        'aria-label': 'Status',
        style: { width: '80px' },
      }),
      contentType: h('input', {
        class: 'grow',
        value: r.contentType,
        'aria-label': 'Content-Type',
      }),
      body: h('textarea', { rows: 6, 'aria-label': 'Response body', spellcheck: 'false' }),
      resHeaders: h('textarea', {
        rows: 2,
        'aria-label': 'Extra response headers (JSON)',
        placeholder: '{"cache-control": "no-store"}',
        spellcheck: 'false',
      }),
      delay: h('input', {
        type: 'number',
        min: 0,
        max: 60000,
        value: r.delay,
        'aria-label': 'Latency in ms',
        style: { width: '100px' },
      }),
      reqHeaders: h('textarea', {
        rows: 3,
        'aria-label': 'Request headers to set (JSON)',
        placeholder: '{"x-feature-flag": "on"}',
        spellcheck: 'false',
      }),
      redirect: h('input', {
        class: 'grow',
        value: r.redirect || '',
        placeholder: 'https://staging.example.com/api/users',
        'aria-label': 'Redirect URL',
      }),
    };
    f.body.value = r.body || '';
    if (r.action === 'mock' && r.headers) f.resHeaders.value = JSON.stringify(r.headers);
    if (r.action === 'headers' && r.headers)
      f.reqHeaders.value = JSON.stringify(r.headers, null, 2);
    const groups = {
      mock: h(
        'div',
        null,
        h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Status'), f.status, f.contentType),
        h('label', { class: 'lbl' }, 'Body'),
        f.body,
        h('label', { class: 'lbl' }, 'Extra response headers (JSON, optional)'),
        f.resHeaders
      ),
      delay: h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Latency (ms)'), f.delay),
      headers: h(
        'div',
        null,
        h('label', { class: 'lbl' }, 'Request headers to set (JSON object)'),
        f.reqHeaders
      ),
      redirect: h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Send to'), f.redirect),
      block: h(
        'div',
        { class: 'sev-info' },
        'Matching requests fail immediately, like a network error (fetch rejects, XHR fires "error").'
      ),
    };
    const actionBox = h('div');
    const syncAction = () => clear(actionBox).append(groups[f.action.value]);
    f.action.addEventListener('change', syncAction);
    syncAction();
    const parseJson = (ta, what) => {
      if (!ta.value.trim()) return undefined;
      try {
        const v = JSON.parse(ta.value);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object');
        return v;
      } catch (e) {
        throw new Error(what + ' must be a JSON object: ' + e.message);
      }
    };
    const save = async () => {
      const action = f.action.value;
      const rule = {
        id: (preset && preset.id) || 'r' + Date.now().toString(36),
        enabled: preset && preset.enabled === false ? false : true,
        match: f.match.value.trim(),
        regex: f.regex.checked,
        method: f.method.value,
        kinds: f.kinds.value,
        action,
      };
      if (action === 'mock') {
        Object.assign(rule, {
          status: +f.status.value,
          contentType: f.contentType.value.trim(),
          body: f.body.value,
        });
        const extra = parseJson(f.resHeaders, 'Response headers');
        if (extra) rule.headers = extra;
      } else if (action === 'delay') rule.delay = +f.delay.value;
      else if (action === 'headers')
        rule.headers = parseJson(f.reqHeaders, 'Request headers') || {};
      else if (action === 'redirect') rule.redirect = f.redirect.value.trim();
      validateRule(rule);
      if (index != null && net.rules[index]) net.rules[index] = rule;
      else net.rules.push(rule);
      await saveRules();
      clear(formBox);
      drawList();
      onChange();
      toast(
        net.captureOn
          ? 'Rule saved and active on this page'
          : 'Rule saved. It takes effect once capture is on.'
      );
    };
    clear(formBox).append(
      h(
        'div',
        { class: 'card' },
        h('b', null, index != null ? 'Edit rule' : 'New rule'),
        h('div', { class: 'row' }, f.match, h('label', null, f.regex, ' regex')),
        h('div', { class: 'row' }, f.method, f.kinds, f.action),
        actionBox,
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', on: { click: save } }, 'Save rule'),
          h('button', { on: { click: () => clear(formBox) } }, 'Cancel')
        )
      )
    );
    const holder = wrap.closest('details');
    if (holder) holder.open = true;
    formBox.scrollIntoView({ block: 'nearest' });
  };
  drawList();
  wrap.append(
    list,
    h('div', { class: 'row' }, h('button', { on: { click: () => openRuleForm() } }, '＋ Add rule')),
    formBox,
    h(
      'div',
      { class: 'sev-info' },
      'Rules apply to requests made by page scripts while capture is on. Loads the browser starts itself (img, script, CSS, navigation) cannot be intercepted without the debugger permission.'
    )
  );
  wrap.redraw = drawList;
  return wrap;
}

/* ---------- export ---------- */
async function exportNet(fmt) {
  const rows = allRows().filter((r) => rowMatches(r, parseQuery(net.query)));
  if (!rows.length) throw new Error('Nothing to export with the current filter.');
  status('Collecting request bodies…');
  const full = [];
  for (const r of rows) {
    if (r.perf) {
      full.push({
        id: r.id,
        kind: 'perf',
        method: 'GET',
        url: r.url,
        status: r.status,
        ms: r.ms,
        initiatorType: r.initiatorType,
      });
      continue;
    }
    try {
      full.push(view(await fullEntry(r.id)));
    } catch (_) {
      full.push(view(r));
    }
  }
  status('');
  const timing = Object.fromEntries(
    rows.filter((r) => r.timingRec).map((r) => [r.id, r.timingRec])
  );
  if (fmt === 'har') {
    const har = DFHar.toHar(full, {
      pageUrl: DF.state.url,
      title: $('#target').textContent,
      version: chrome.runtime.getManifest().version,
      timing,
      startedAt: net.startedAt || Date.now(),
    });
    download('network-' + stamp() + '.har', JSON.stringify(har, null, 2), 'application/json');
  } else if (fmt === 'csv') {
    download(
      'network-' + stamp() + '.csv',
      toCSV(
        rows.map((r) => ({
          kind: r.kind,
          method: r.method,
          status: r.status,
          url: net.redact ? redactUrl(r.url) : r.url,
          ms: r.ms,
          size: r.size,
          protocol: r.protocol,
          mocked: !!r.mocked,
          blocked: !!r.blocked,
        }))
      ),
      'text/csv'
    );
  } else {
    download(
      'network-' + stamp() + '.json',
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          page: DF.state.url,
          redacted: net.redact,
          provenance: 'observed after capture was enabled; kind "perf" entries are timing-only',
          entries: full,
        },
        null,
        2
      ),
      'application/json'
    );
  }
}

// Recent captured requests (full records) for other tabs, e.g. the AI prompt builder.
async function netRecent(n) {
  const ids = [...net.rows.keys()].slice(-n);
  const out = [];
  for (const id of ids) {
    try {
      out.push(await fullEntry(id));
    } catch (_) {
      /* evicted between poll and read */
    }
  }
  return out;
}

/* ---------- tab ---------- */
registerTab('network', 'Network', async (v) => {
  await loadRules();
  const listBox = h('div', { class: 'net-list' });
  const detail = h('div', { class: 'net-detail' });
  const summary = h('div', { class: 'net-summary sev-info' });
  const capBtn = h('button', { class: 'primary' });
  const persistBox = h('input', { type: 'checkbox' });
  const liveBox = h('input', { type: 'checkbox', checked: net.live });
  const query = h('input', {
    class: 'grow',
    type: 'search',
    value: net.query,
    placeholder:
      'Filter: text, -exclude, status:4xx, method:post, domain:, larger-than:50k, is:mocked',
    'aria-label': 'Filter requests',
  });
  const rulesBox = rulesSection(() => drawList());
  const rulesHead = h('summary', null);
  const updateRulesHead = () =>
    (rulesHead.textContent = `Interception rules (${activeRules().length} active of ${net.rules.length})`);
  updateRulesHead();

  const drawCapture = () => {
    capBtn.textContent = net.captureOn ? '● Capturing' : 'Start capture';
    capBtn.className = net.captureOn ? 'rec' : 'primary';
    capBtn.title = net.captureOn
      ? 'Capture is active until the page reloads'
      : 'Record fetch, XHR, WebSocket, SSE and beacons from now on';
  };

  function drawList() {
    updateRulesHead();
    rulesBox.redraw();
    const terms = parseQuery(net.query);
    const all = allRows();
    const rows = sortRows(all.filter((r) => rowMatches(r, terms)));
    // Summary bar
    const transfer = all.reduce((s, r) => s + (r.transfer || 0), 0);
    const errors = all.filter((r) => r.error || r.status >= 400).length;
    const protos = {};
    all.forEach((r) => r.protocol && (protos[r.protocol] = (protos[r.protocol] || 0) + 1));
    const cached = all.filter(
      (r) => r.timingRec && r.timingRec.transferSize === 0 && r.timingRec.decodedBodySize > 0
    ).length;
    summary.textContent =
      `${rows.length} of ${all.length} requests · ${fmtBytes(transfer)} transferred · ${errors} errors · ${cached} from cache` +
      (Object.keys(protos).length
        ? ' · ' +
          Object.entries(protos)
            .map(([k, n]) => `${k} ${n}`)
            .join(', ')
        : '');

    clear(listBox);
    if (!rows.length) {
      listBox.append(
        emptyState(
          all.length
            ? 'No requests match'
            : net.captureOn
              ? 'Waiting for requests'
              : 'No requests yet',
          all.length
            ? 'Clear the filter or pick another type.'
            : net.captureOn
              ? 'Interact with the page; new requests appear here live.'
              : 'Start capture to record fetch/XHR with headers and bodies. Earlier loads show up as timing-only rows.'
        )
      );
      return;
    }
    const shown = rows.slice(-500);
    const minT = Math.min(...shown.map((r) => r.startT || 0));
    const maxT = Math.max(...shown.map((r) => (r.startT || 0) + (r.ms || 0)), minT + 1);
    const span = maxT - minT;
    const sortHead = (key, label) =>
      h(
        'th',
        {
          scope: 'col',
          class: 'sortable',
          'aria-sort':
            net.sort.key === key ? (net.sort.dir > 0 ? 'ascending' : 'descending') : 'none',
          tabindex: 0,
          on: {
            click: () => {
              net.sort = {
                key,
                dir:
                  net.sort.key === key ? -net.sort.dir : key === 'start' || key === 'name' ? 1 : -1,
              };
              drawList();
            },
            keydown: (e) => e.key === 'Enter' && e.currentTarget.click(),
          },
        },
        label,
        net.sort.key === key ? (net.sort.dir > 0 ? ' ▲' : ' ▼') : ''
      );
    const tbody = h('tbody');
    for (const r of shown) {
      let host = '',
        path = r.url;
      try {
        const u = new URL(net.redact ? redactUrl(r.url) : r.url);
        host = u.host;
        path = (u.pathname + u.search).slice(0, 140) || '/';
      } catch (_) {}
      const bad = r.error || r.status >= 400 || r.blocked;
      const tr = h(
        'tr',
        {
          class: (r.id === net.selId ? 'sel ' : '') + (bad ? 'bad ' : '') + (r.perf ? 'perf' : ''),
          tabindex: 0,
          'data-id': r.id,
          on: {
            click: () => {
              net.selId = r.id;
              for (const x of tbody.children) x.classList.toggle('sel', x === tr);
              renderDetail(detail, r);
              detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            },
            keydown: (e) => {
              if (e.key === 'Enter') tr.click();
              if (e.key === 'ArrowDown' && tr.nextElementSibling) tr.nextElementSibling.focus();
              if (e.key === 'ArrowUp' && tr.previousElementSibling)
                tr.previousElementSibling.focus();
            },
          },
        },
        h(
          'td',
          null,
          h(
            'span',
            {
              class:
                'st ' +
                (bad ? 'st-bad' : r.status >= 300 ? 'st-redir' : r.status ? 'st-ok' : 'st-none'),
            },
            r.blocked
              ? 'blocked'
              : r.status == null
                ? r.error
                  ? 'ERR'
                  : r.perf
                    ? '–'
                    : '…'
                : r.status
          )
        ),
        h('td', { class: 'mono' }, r.kind === 'perf' ? '' : r.method),
        h(
          'td',
          { class: 'name', title: r.url },
          h('div', { class: 'mono ellipsis' }, path),
          h(
            'div',
            { class: 'host ellipsis' },
            r.mocked
              ? h('span', { class: 'tag generated', title: 'Answered by a mock rule' }, 'mock')
              : '',
            r.rules && r.rules.length && !r.mocked && !r.blocked
              ? h('span', { class: 'tag reconstructed', title: 'Modified by a rule' }, 'rule')
              : '',
            ' ' + host + (r.perf ? ' · timing only' : '')
          )
        ),
        h('td', { class: 'num' }, r.cat),
        h(
          'td',
          { class: 'num' },
          r.size ? fmtBytes(r.size) : r.transfer === 0 && r.timingRec ? 'cache' : '–'
        ),
        h('td', { class: 'num' }, r.ms == null ? '…' : fmtMs(r.ms)),
        h(
          'td',
          { class: 'wf-cell', 'aria-hidden': 'true' },
          h(
            'div',
            { class: 'wf' },
            h('i', {
              class: 'wf-' + r.cat,
              style: {
                left: (((r.startT || minT) - minT) / span) * 100 + '%',
                width: Math.max(0.6, ((r.ms || 0) / span) * 100) + '%',
              },
            })
          )
        )
      );
      tbody.append(tr);
    }
    listBox.append(
      h(
        'div',
        { class: 'table-scroll' },
        h(
          'table',
          { class: 'net-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              sortHead('status', 'Status'),
              h('th', { scope: 'col' }, 'Method'),
              sortHead('name', 'Name'),
              h('th', { scope: 'col' }, 'Type'),
              sortHead('size', 'Size'),
              sortHead('ms', 'Time'),
              sortHead('start', 'Waterfall')
            )
          ),
          tbody
        )
      ),
      rows.length > shown.length
        ? h('div', { class: 'sev-info' }, `Showing the last ${shown.length} of ${rows.length}.`)
        : ''
    );
  }

  const refresh = async () => {
    await pollNet();
    drawCapture();
    drawList();
    // Keep an open detail pane in sync with its row (status/timing arrive after the request starts).
    if (net.selId && !detail.firstChild) net.selId = null;
  };

  capBtn.addEventListener(
    'click',
    guard(async () => {
      if (net.captureOn) return toast('Capture is already on. It stops when the page reloads.');
      await startCapture();
      drawCapture();
      drawList();
      toast('Capture on: new requests include headers and bodies.');
    })
  );
  persistBox.addEventListener(
    'change',
    guard(async () => {
      try {
        const list = await setPersistent(persistBox.checked);
        toast(
          persistBox.checked
            ? 'Capture will start with every page load on this site. Reload to record from the first request.'
            : 'Capture from page start turned off for this site.'
        );
        persistBox.title = list.join('\n');
      } catch (e) {
        persistBox.checked = !persistBox.checked;
        throw e;
      }
    })
  );
  liveBox.addEventListener('change', () => (net.live = liveBox.checked));
  query.addEventListener(
    'input',
    debounce(() => {
      net.query = query.value;
      drawList();
    }, 120)
  );
  detail.addEventListener('df-closed', () => {
    for (const x of listBox.querySelectorAll('tr.sel')) x.classList.remove('sel');
  });

  v.append(
    h(
      'div',
      { class: 'toolbar' },
      capBtn,
      h('label', { title: 'Poll for new requests every second' }, liveBox, ' Live'),
      h('button', { on: { click: refresh } }, 'Refresh'),
      h(
        'button',
        {
          on: {
            click: async () => {
              await exec(() => window.__dfNet && window.__dfNet.clear(), [], 'MAIN');
              net.clearedAt = await exec(() => performance.now(), []);
              net.rows.clear();
              net.timing.clear();
              net.selId = null;
              clear(detail);
              await refresh();
            },
          },
        },
        'Clear'
      ),
      h(
        'label',
        { title: 'Hide tokens, cookies, passwords and API keys in the view, snippets and exports' },
        h('input', {
          type: 'checkbox',
          checked: net.redact,
          on: {
            change: (e) => {
              net.redact = e.target.checked;
              drawList();
              const row = allRows().find((r) => r.id === net.selId);
              renderDetail(detail, row);
            },
          },
        }),
        ' Redact secrets'
      ),
      h(
        'label',
        {
          title:
            'Inject the recorder at document_start on this site so even the first requests are captured (needs site access)',
        },
        persistBox,
        ' From page start'
      )
    ),
    h(
      'div',
      { class: 'row filters', role: 'group', 'aria-label': 'Request type' },
      NET_FILTERS.map(([f, label]) =>
        h(
          'button',
          {
            class: 'chip' + (f === net.filter ? ' on' : ''),
            'aria-pressed': String(f === net.filter),
            on: {
              click: (e) => {
                net.filter = f;
                for (const b of e.currentTarget.parentNode.children) {
                  if (!b.dataset.toggle) {
                    b.classList.toggle('on', b === e.currentTarget);
                    b.setAttribute('aria-pressed', String(b === e.currentTarget));
                  }
                }
                drawList();
              },
            },
          },
          label
        )
      ),
      h(
        'button',
        {
          class: 'chip warnchip' + (net.errorsOnly ? ' on' : ''),
          'data-toggle': '1',
          'aria-pressed': String(net.errorsOnly),
          on: {
            click: (e) => {
              net.errorsOnly = !net.errorsOnly;
              e.currentTarget.classList.toggle('on', net.errorsOnly);
              e.currentTarget.setAttribute('aria-pressed', String(net.errorsOnly));
              drawList();
            },
          },
        },
        'Errors'
      )
    ),
    h('div', { class: 'row' }, query),
    summary,
    listBox,
    detail,
    h('details', { class: 'card' }, rulesHead, rulesBox),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'sev-info' }, 'Export:'),
      h('button', { on: { click: () => exportNet('har') } }, 'HAR'),
      h('button', { on: { click: () => exportNet('json') } }, 'JSON'),
      h('button', { on: { click: () => exportNet('csv') } }, 'CSV')
    ),
    h(
      'details',
      null,
      h('summary', null, 'What can and cannot be captured'),
      h(
        'div',
        { class: 'sev-info' },
        'fetch / XHR / WebSocket / EventSource / sendBeacon are recorded once capture is on (a reload resets it unless "From page start" is enabled). ' +
          'Requests the browser makes itself (images, CSS, scripts, navigation) appear as timing-only rows from the Performance API. ' +
          'Service-worker responses and cross-origin opaque responses have no readable body. Nothing leaves your browser.'
      )
    )
  );
  drawCapture();
  try {
    persistBox.checked = (await persistentOrigins()).includes(new URL(DF.state.url).origin + '/*');
  } catch (_) {
    persistBox.disabled = true;
  }
  await refresh().catch((e) => {
    clear(listBox).append(h('div', { class: 'card sev-error' }, e.message));
  });
  // Live polling while this tab is open and the panel is visible. The list is only rebuilt when
  // something changed, and never while the user is keyboard-navigating it.
  let lastSig = '';
  const timer = setInterval(() => {
    if (!net.live || document.hidden || DF.state.tab !== 'network') return;
    pollNet()
      .then(() => {
        drawCapture();
        const sig = [
          net.rev,
          net.rows.size,
          net.timing.size,
          net.perfOnly.length,
          net.captureOn,
        ].join();
        if (sig === lastSig) return;
        lastSig = sig;
        if (!document.activeElement || !listBox.contains(document.activeElement)) drawList();
      })
      .catch(() => {
        /* page navigating or restricted: the next tick or Refresh will report it */
      });
  }, 1000);
  onLeave(() => clearInterval(timer));
});
