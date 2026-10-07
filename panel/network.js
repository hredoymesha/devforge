const net = { filter: 'all', items: [], sel: null, redact: true };
const NET_FILTERS = [
  'all',
  'api',
  'xhr',
  'fetch',
  'js',
  'css',
  'img',
  'font',
  'media',
  'doc',
  'ws',
  'errors',
];
const extType = (u) =>
  /\.m?js(\?|$)/i.test(u)
    ? 'js'
    : /\.css(\?|$)/i.test(u)
      ? 'css'
      : /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(u)
        ? 'img'
        : /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(u)
          ? 'font'
          : /\.(mp4|webm|mp3|ogg|m3u8)(\?|$)/i.test(u)
            ? 'media'
            : 'doc';
function netMatches(it, f) {
  if (f === 'all') return true;
  if (f === 'errors') return !!it.error || it.status >= 400 || it.status === 0;
  if (f === 'xhr') return it.kind === 'xhr';
  if (f === 'fetch') return it.kind === 'fetch';
  if (f === 'ws') return it.kind === 'websocket';
  if (f === 'api')
    return (
      (it.kind === 'fetch' || it.kind === 'xhr') &&
      /json|graphql|api/i.test((it.resHeaders && it.resHeaders['content-type']) || it.url)
    );
  return it.kind === 'perf' ? it.type === f : extType(it.url) === f;
}
async function loadNet() {
  const live = await exec(
    () => (window.__dfNet ? window.__dfNet.log.map((x) => JSON.parse(JSON.stringify(x))) : null),
    [],
    'MAIN'
  );
  const perf = await call('resourceMap');
  const entries = await exec(
    () =>
      performance.getEntriesByType('resource').map((r) => ({
        url: r.name,
        initiator: r.initiatorType,
        ms: Math.round(r.duration),
        size: r.transferSize,
        status: r.responseStatus || null,
        start: Math.round(r.startTime),
      })),
    []
  );
  const seen = new Set((live || []).map((x) => x.url));
  const earlier = entries
    .filter((e) => !seen.has(e.url))
    .map((e, i) => ({
      id: 'p' + i,
      kind: 'perf',
      url: e.url,
      method: 'GET?',
      status: e.status,
      ms: e.ms,
      size: e.size,
      initiatorType: e.initiator,
      type: extType(e.url) === 'doc' && e.initiator === 'fetch' ? 'doc' : extType(e.url),
      note: 'timing only (observed via Performance API): no headers/body',
    }));
  net.captureOn = !!live;
  net.items = [...(live || []), ...earlier];
  return perf;
}
registerTab('network', 'Network', async (v) => {
  const list = h('div'),
    detail = h('div');
  const draw = () => {
    clear(list);
    const rows = net.items.filter((i) => netMatches(i, net.filter));
    list.append(
      rows.length
        ? table(
            ['', 'Method', 'Status', 'URL', 'ms'],
            rows
              .slice(-300)
              .map((i) => [
                i.kind === 'perf' ? 'p' : i.kind[0],
                i.method,
                h(
                  'span',
                  { class: i.error || i.status >= 400 ? 'sev-error' : '' },
                  i.status == null ? (i.error ? 'ERR' : '…') : i.status
                ),
                mono(
                  (net.redact ? redactUrl(i.url) : i.url)
                    .replace(/^https?:\/\/[^/]+/, '')
                    .slice(0, 90) || i.url
                ),
                i.ms == null ? '' : i.ms,
              ]),
            { rowProps: (r) => ({ tabindex: 0, style: { cursor: 'pointer' } }) }
          )
        : h(
            'div',
            { class: 'empty' },
            net.captureOn
              ? 'No requests match. Interact with the page, then Refresh.'
              : 'No data. Enable capture and interact with the page.'
          )
    );
    [...list.querySelectorAll('tbody tr')].forEach((tr, idx) =>
      tr.addEventListener('click', () => showNet(rows.slice(-300)[idx]))
    );
  };
  const showNet = (it) => {
    net.sel = it;
    clear(detail);
    const V = net.redact ? redactEntry(it) : it;
    let q = null;
    try {
      q = Object.fromEntries(new URL(V.url).searchParams);
      if (net.redact) q = redactValue(q);
    } catch (_) {}
    let body = V.resBody;
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch (_) {}
    detail.append(
      section(
        'Request detail',
        kv({
          url: V.url,
          method: it.method,
          status: it.status == null ? 'pending/unknown' : it.status + ' ' + (it.statusText || ''),
          type: it.kind,
          'time (ms)': it.ms,
          initiator: it.initiator ? { value: it.initiator, provenance: 'observed' } : '-',
          error: it.error,
        }),
        q && Object.keys(q).length
          ? h('div', null, h('b', null, 'Query params'), codeBlock(JSON.stringify(q, null, 2)))
          : '',
        V.reqHeaders
          ? h(
              'details',
              { open: true },
              h('summary', null, 'Request headers'),
              codeBlock(JSON.stringify(V.reqHeaders, null, 2))
            )
          : '',
        V.reqBody
          ? h(
              'details',
              { open: true },
              h('summary', null, 'Request payload'),
              codeBlock(V.reqBody)
            )
          : '',
        V.resHeaders
          ? h(
              'details',
              null,
              h('summary', null, 'Response headers'),
              codeBlock(JSON.stringify(V.resHeaders, null, 2))
            )
          : '',
        body != null
          ? h(
              'details',
              { open: true },
              h(
                'summary',
                null,
                'Response body' + (it.resTruncated ? ' (truncated at 200 KB)' : '')
              ),
              codeBlock(String(pretty).slice(0, 30000))
            )
          : it.kind === 'perf'
            ? h('div', { class: 'sev-warn' }, it.note)
            : '',
        it.kind === 'websocket'
          ? h(
              'div',
              null,
              `sent ${it.sent}, received ${it.received}`,
              codeBlock(JSON.stringify(it.frames, null, 2))
            )
          : ''
      )
    );
  };
  const on = h(
    'button',
    {
      class: 'primary',
      on: {
        click: async () => {
          try {
            await ensureAgent();
            await exec(null, [], 'MAIN', ['netcap.js']);
            toast('Capture enabled. Only requests made from now on include headers and bodies.');
            await refresh();
          } catch (e) {
            toast(e.message);
          }
        },
      },
    },
    'Enable capture'
  );
  const refresh = async () => {
    try {
      await loadNet();
      draw();
      info.textContent = net.captureOn
        ? `Capture on · ${net.items.filter((i) => i.kind !== 'perf').length} live, ${net.items.filter((i) => i.kind === 'perf').length} timing-only`
        : 'Capture off · showing timing-only entries from the Performance API';
    } catch (e) {
      clear(list).append(h('div', { class: 'sev-error' }, e.message));
    }
  };
  const info = h('span', { class: 'sev-info' });
  v.append(
    h(
      'div',
      { class: 'row' },
      on,
      h('button', { on: { click: refresh } }, 'Refresh'),
      h(
        'button',
        {
          on: {
            click: async () => {
              await exec(() => window.__dfNet && window.__dfNet.clear(), [], 'MAIN');
              await refresh();
            },
          },
        },
        'Clear'
      ),
      h(
        'label',
        null,
        h('input', {
          type: 'checkbox',
          checked: net.redact,
          on: { change: (e) => (net.redact = e.target.checked) },
        }),
        ' redact secrets (headers, URL params, JSON/form fields) in view & export'
      )
    ),
    info,
    h(
      'div',
      { class: 'row filters' },
      NET_FILTERS.map((f) =>
        h(
          'button',
          {
            class: f === net.filter ? 'on' : '',
            on: {
              click: (e) => {
                net.filter = f;
                [...e.target.parentNode.children].forEach((b) =>
                  b.classList.toggle('on', b === e.target)
                );
                draw();
              },
            },
          },
          f
        )
      )
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          on: {
            click: () => {
              const rows = net.items
                .filter((i) => netMatches(i, net.filter))
                .map((i) => (net.redact ? redactEntry(i) : i));
              download(
                'network-' + stamp() + '.json',
                JSON.stringify(
                  {
                    exportedAt: new Date().toISOString(),
                    page: DF.state.url,
                    redacted: net.redact,
                    provenance:
                      'observed after capture was enabled; entries with kind "perf" are timing-only',
                    entries: rows,
                  },
                  null,
                  2
                ),
                'application/json'
              );
            },
          },
        },
        'Export JSON'
      ),
      h(
        'button',
        {
          on: {
            click: () =>
              download(
                'network-' + stamp() + '.csv',
                toCSV(
                  net.items
                    .filter((i) => netMatches(i, net.filter))
                    .map((i) => ({
                      kind: i.kind,
                      method: i.method,
                      status: i.status,
                      url: net.redact ? redactUrl(i.url) : i.url,
                      ms: i.ms,
                    }))
                )
              ),
          },
        },
        'Export CSV'
      )
    ),
    h(
      'div',
      { class: 'sev-info' },
      'Limits: fetch / XHR / WebSocket are observed only after "Enable capture" (page reload clears it). Requests by the browser itself (images, CSS, scripts, navigation) appear as timing only. Service-worker and cross-origin opaque responses have no readable body. Nothing leaves your browser.'
    ),
    list,
    detail
  );
  refresh();
});
