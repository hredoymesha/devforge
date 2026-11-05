// Perf tab: Core Web Vitals with element attribution, navigation timing, Long Animation Frames
// (which scripts block the main thread) and a frame-rate profiler. Data comes from agent/vitals.js.
const RATING_LABEL = { good: 'Good', ni: 'Needs work', poor: 'Poor' };

function selectAndShow(hnd) {
  return async () => {
    if (!hnd) return toast('That element is no longer in the page.');
    const d = await call('select', hnd);
    DF.state.h = d.h;
    DF.state.info = d;
    await call('highlight', hnd);
    toast('Selected ' + d.selectors[0].selector);
  };
}
const elLink = (el) =>
  el
    ? h(
        'button',
        {
          class: 'link mono',
          title: 'Select and highlight on the page',
          on: { click: selectAndShow(el.h) },
        },
        el.label
      )
    : h('span', { class: 'sev-info' }, '–');

function vitalCard(name, metric, fmt, hint) {
  const val = metric ? fmt(metric.value) : '–';
  return h(
    'div',
    { class: 'stat ' + (metric && metric.rating ? 'r-' + metric.rating : '') },
    h('div', { class: 'stat-name' }, name),
    h('div', { class: 'stat-val' }, val),
    h('div', { class: 'stat-sub' }, metric && metric.rating ? RATING_LABEL[metric.rating] : hint)
  );
}

// Inline SVG sparkline. `budget` (optional) draws a dashed reference line, e.g. the 60 fps budget.
function sparkline(series, budget) {
  const W = 300,
    H = 60;
  const max = Math.max(budget ? budget * 3 : 1, ...series);
  const x = (i) => (i / Math.max(1, series.length - 1)) * W;
  const y = (v) => H - (Math.min(v, max) / max) * (H - 4) - 2;
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Frame times over the profile');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('class', 'spark-line');
  if (budget) {
    const b = document.createElementNS(ns, 'line');
    b.setAttribute('x1', 0);
    b.setAttribute('x2', W);
    b.setAttribute('y1', y(budget));
    b.setAttribute('y2', y(budget));
    b.setAttribute('class', 'spark-budget');
    svg.append(b);
  }
  svg.append(line);
  return svg;
}

function navBar(nav) {
  const parts = [
    ['Redirect', nav.redirect, 'r'],
    ['DNS', nav.dns, 'dns'],
    ['Connect', nav.connect - nav.tls, 'tcp'],
    ['TLS', nav.tls, 'tls'],
    ['Server (TTFB)', nav.request, 'wait'],
    ['Download', nav.response, 'dl'],
  ].filter(([, ms]) => ms > 0);
  const total = parts.reduce((s, p) => s + p[1], 0) || 1;
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'stack-bar', role: 'img', 'aria-label': 'Navigation request phases' },
      parts.map(([label, ms, cls]) =>
        h('i', {
          class: 'ph-' + cls,
          style: { width: (ms / total) * 100 + '%' },
          title: `${label}: ${fmtMs(ms)}`,
        })
      )
    ),
    h(
      'div',
      { class: 'legend' },
      parts.map(([label, ms, cls]) =>
        h('span', null, h('i', { class: 'ph-' + cls }), `${label} ${fmtMs(ms)}`)
      )
    )
  );
}


/* ---------- history: how the same page measured on earlier checks ---------- */
const perfKey = (url) => DFKeep.keyFor(DFPerfHist.keyFor(url));
async function perfRecord(url, d) {
  const key = perfKey(url);
  const store = await DFKeep.readPerf();
  let next = DFPerfHist.add(store, key, DFPerfHist.pointFrom(d), DF.state.settings.perfHistoryLimit);
  const pages = Object.keys(next);
  if (pages.length > 100) {
    // Keep the 100 most recently measured pages.
    const last = (k) => next[k][next[k].length - 1].t;
    next = Object.fromEntries(pages.sort((a, b) => last(b) - last(a)).slice(0, 100).map((k) => [k, next[k]]));
  }
  if (JSON.stringify(next[key]) !== JSON.stringify(store[key]) || pages.length > 100) await chrome.storage.local.set({ [DFKeep.PERF_KEY]: next });
  return next[key] || [];
}

function perfChart(points, metric) {
  const m = DFPerfHist.METRICS[metric];
  const s = DFPerfHist.series(points, metric);
  const W = 320,
    H = 120,
    L = 38,
    R = 8,
    T = 8,
    B = 18;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'perf-chart', role: 'img', 'aria-label': m.label + ' over ' + s.length + ' checks' });
  const max = Math.max(...s.map((x) => x.v), m.good) * 1.15 || 1;
  const x = (i) => L + (s.length === 1 ? (W - L - R) / 2 : (i / (s.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const fmt = (v) => (metric === 'cls' ? v.toFixed(3) : fmtMs(v));
  for (const [val, cls] of [[m.good, 'perf-good'], [m.poor, 'perf-poor']])
    if (val < max) {
      svg.append(el('line', { x1: L, x2: W - R, y1: y(val), y2: y(val), class: 'perf-thr ' + cls }));
      svg.append(el('text', { x: L - 3, y: y(val) + 3, class: 'perf-axis', 'text-anchor': 'end' }, fmt(val)));
    }
  svg.append(el('line', { x1: L, x2: L, y1: T, y2: H - B, class: 'perf-base' }), el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'perf-base' }));
  svg.append(el('text', { x: L - 3, y: H - B + 3, class: 'perf-axis', 'text-anchor': 'end' }, '0'));
  svg.append(el('polyline', { points: s.map((p, i) => x(i).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' '), class: 'perf-line' }));
  s.forEach((p, i) => {
    const c = el('circle', { cx: x(i), cy: y(p.v), r: 3.5, class: 'perf-dot' });
    c.append(el('title', {}, new Date(p.t).toLocaleString() + ': ' + m.label + ' ' + fmt(p.v)));
    svg.append(c);
  });
  svg.append(el('text', { x: L, y: H - 3, class: 'perf-axis' }, new Date(s[0].t).toLocaleDateString()), el('text', { x: W - R, y: H - 3, class: 'perf-axis', 'text-anchor': 'end' }, new Date(s[s.length - 1].t).toLocaleDateString()));
  return svg;
}

function perfHistorySection(url, points, redraw) {
  const metric = DF.state.perfMetric || 'lcp';
  const box = h('div');
  const fmt = (k, v) => (v == null ? '–' : k === 'cls' ? v.toFixed(3) : fmtMs(v));
  const sum = DFPerfHist.summary(points, metric);
  const pick = h(
    'select',
    { id: 'perf-metric', 'aria-label': 'Metric to chart', on: { change: (e) => { DF.state.perfMetric = e.target.value; redraw(); } } },
    Object.entries(DFPerfHist.METRICS).map(([k, m]) => h('option', { value: k, selected: k === metric }, m.label))
  );
  box.append(h('div', { class: 'row' }, h('label', null, 'Metric ', pick), h('button', { on: { click: async () => { const store = await DFKeep.readPerf(); delete store[perfKey(url)]; await chrome.storage.local.set({ [DFKeep.PERF_KEY]: store }); toast('History for this page cleared'); redraw(); } } }, 'Clear this page\'s history')));
  if (points.length < 2 || !sum || sum.n < 2) {
    box.append(h('div', { class: 'sev-info', id: 'perf-hist-hint' }, points.length ? 'One reading saved so far. Run “Refresh vitals” again, after interacting with the page or reloading it, to see how it changes.' : 'No readings saved yet for this page.'));
  } else {
    const better = sum.delta < 0;
    box.append(
      perfChart(points, metric),
      h('div', { class: 'sev-info', role: 'status' }, DFPerfHist.METRICS[metric].label + ' is ' + fmt(metric, sum.latest) + (sum.delta === 0 ? ', unchanged since the previous check.' : ', ' + fmt(metric, Math.abs(sum.delta)) + (better ? ' better' : ' worse') + ' than the previous check.') + ' Best ' + fmt(metric, sum.best) + ', worst ' + fmt(metric, sum.worst) + ', median ' + fmt(metric, sum.median) + ' over ' + sum.n + ' checks. Dashed lines mark the “good” and “poor” limits.')
    );
  }
  box.append(
    h('details', null, h('summary', null, 'Recent readings (' + points.length + ')'), table(['When', 'LCP', 'FCP', 'TTFB', 'INP', 'CLS', 'Load'], points.slice(-10).reverse().map((p) => [new Date(p.t).toLocaleString(), fmt('lcp', p.lcp), fmt('fcp', p.fcp), fmt('ttfb', p.ttfb), fmt('inp', p.inp), fmt('cls', p.cls), p.load != null ? fmtMs(p.load) : '–']), { class: 'compact' }))
  );
  return section('History for this page', box);
}

registerTab('perf', 'Perf', async (v) => {
  const out = h('div', null, loading('Reading performance data'));
  const prof = h('div');
  const dur = h(
    'select',
    { 'aria-label': 'Profile length' },
    [3, 5, 10].map((s) => h('option', { value: s * 1000, selected: s === 5 }, s + ' s'))
  );
  const runProfile = async () => {
    clear(prof).append(loading('Profiling: scroll or interact with the page now'));
    const r = await call('profileFrames', +dur.value);
    const budget = 1000 / 60;
    clear(prof).append(
      r.hidden
        ? h(
            'div',
            { class: 'sev-warn' },
            'The page was in the background, so the browser throttled frames. Keep it visible while profiling.'
          )
        : '',
      h(
        'div',
        { class: 'stats' },
        vitalCard(
          'FPS',
          { value: r.fps, rating: r.fps >= 55 ? 'good' : r.fps >= 40 ? 'ni' : 'poor' },
          (x) => String(x)
        ),
        vitalCard(
          'p95 frame',
          { value: r.p95, rating: r.p95 <= 20 ? 'good' : r.p95 <= 50 ? 'ni' : 'poor' },
          fmtMs
        ),
        vitalCard(
          'Janky frames',
          { value: r.janky, rating: r.janky === 0 ? 'good' : r.janky < 10 ? 'ni' : 'poor' },
          (x) => String(x)
        ),
        vitalCard(
          'Worst frame',
          { value: r.worst, rating: r.worst <= 50 ? 'good' : r.worst <= 100 ? 'ni' : 'poor' },
          fmtMs
        )
      ),
      sparkline(r.series, budget),
      h(
        'div',
        { class: 'sev-info' },
        `${r.frames} frames in ${fmtMs(r.duration)} · median ${fmtMs(r.p50)} · p99 ${fmtMs(r.p99)} · ${r.severe} over 50 ms · ${r.loafsDuring} long animation frame(s). Dashed line = 16.7 ms budget.`
      )
    );
  };
  const hist = h('div');
  const drawHistory = async (d) => {
    try {
      const url = DF.state.url;
      const pts = d ? await perfRecord(url, d) : (await DFKeep.readPerf())[perfKey(url)] || [];
      clear(hist).append(perfHistorySection(url, pts, () => drawHistory(null)));
    } catch (e) {
      clear(hist).append(h('div', { class: 'sev-info' }, 'History is unavailable: ' + e.message));
    }
  };
  const render = async () => {
    const d = await call('vitals');
    drawHistory(d);
    clear(out);
    out.append(
      h(
        'div',
        { class: 'stats' },
        vitalCard('LCP', d.lcp, fmtMs, 'not reported yet'),
        vitalCard('CLS', d.cls, (x) => x.toFixed(3), 'no shifts'),
        vitalCard('INP', d.inp, fmtMs, 'interact with the page'),
        vitalCard('FCP', d.fcp, fmtMs, '–'),
        vitalCard('TTFB', d.ttfb, fmtMs, '–')
      ),
      h(
        'div',
        { class: 'sev-info' },
        `Measured in this tab since load (${fmtMs(d.sinceLoad)} ago). Lab values from your machine, not field data. INP is the slowest of ${d.interactions} interaction(s).`
      )
    );
    if (d.lcp)
      out.append(
        section(
          'Largest Contentful Paint',
          kv({
            element: elLink(d.lcp.el),
            time: fmtMs(d.lcp.value),
            resource: d.lcp.url || 'text / inline',
            size: d.lcp.size + ' px²',
          })
        )
      );
    if (d.cls.sources.length)
      out.append(
        section(
          'Layout shifts (largest first)',
          table(
            ['When', 'Score', 'Element', 'Moved'],
            d.cls.sources.map((s) => [
              fmtMs(s.t),
              s.value.toFixed(4),
              elLink(s.el),
              s.from && s.to ? mono(`y ${s.from[1]}→${s.to[1]}, h ${s.from[3]}→${s.to[3]}`) : '–',
            ]),
            { class: 'compact' }
          )
        )
      );
    if (d.worstInteractions.length)
      out.append(
        section(
          'Slowest interactions',
          table(
            ['Event', 'Total', 'Input delay', 'Processing', 'Presentation', 'Target'],
            d.worstInteractions.map((i) => [
              i.type,
              h(
                'b',
                { class: i.duration > 500 ? 'sev-error' : i.duration > 200 ? 'sev-warn' : '' },
                fmtMs(i.duration)
              ),
              fmtMs(i.inputDelay),
              fmtMs(i.processing),
              fmtMs(i.presentation),
              elLink(i.el),
            ]),
            { class: 'compact' }
          ),
          h(
            'div',
            { class: 'sev-info' },
            'High input delay = main thread was busy; high processing = slow event handlers; high presentation = expensive rendering after the handler.'
          )
        )
      );
    if (d.nav)
      out.append(
        section(
          'Navigation',
          navBar(d.nav),
          kv({
            protocol: d.nav.protocol,
            type: d.nav.type,
            'DOM interactive': fmtMs(d.nav.domInteractive),
            DOMContentLoaded: fmtMs(d.nav.domContentLoaded),
            load: fmtMs(d.nav.load),
            'document size':
              fmtBytes(d.nav.transferSize) +
              ' transferred, ' +
              fmtBytes(d.nav.decodedBodySize) +
              ' decoded',
            'server timing': d.nav.serverTiming.length
              ? d.nav.serverTiming.map((s) => `${s.name} ${s.dur ? fmtMs(s.dur) : ''}`).join(', ')
              : null,
          })
        )
      );
    out.append(
      section(
        'Main-thread blocking',
        kv({
          'long tasks': d.longTasks.count + ' (' + fmtMs(d.longTasks.tbt) + ' blocking over 50 ms)',
          'long animation frames': d.supported['long-animation-frame']
            ? d.loaf.count + ' (' + fmtMs(d.loaf.blocking) + ' blocking)'
            : 'not supported in this browser',
        }),
        d.loaf.scripts.length
          ? table(
              ['Script', 'Time', 'Calls', 'Forced layout', 'Invoker'],
              d.loaf.scripts.map((s) => [
                mono(s.key),
                fmtMs(s.ms),
                s.count,
                s.forcedLayout ? fmtMs(s.forcedLayout) : '–',
                mono(s.invoker),
              ]),
              { class: 'compact' }
            )
          : h('div', { class: 'sev-info' }, 'No script-attributed long frames recorded.'),
        h(
          'div',
          { class: 'sev-info' },
          'Long Animation Frames attribute blocking time to the script and function that caused it. "Forced layout" means the script read layout after writing styles (layout thrashing).'
        )
      )
    );
    if (d.memory)
      out.append(
        section(
          'JS heap',
          h(
            'div',
            { class: 'bar', title: 'used / limit' },
            h('i', {
              style: { width: Math.min(100, (d.memory.used / d.memory.limit) * 100) + '%' },
            })
          ),
          h(
            'div',
            { class: 'sev-info' },
            `${fmtBytes(d.memory.used)} used of ${fmtBytes(d.memory.total)} allocated (limit ${fmtBytes(d.memory.limit)}). Values are bucketed by Chrome for privacy.`
          )
        )
      );
  };
  v.append(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'primary', on: { click: () => render() } }, 'Refresh vitals'),
      h(
        'button',
        {
          on: {
            click: async () => {
              const d = await call('vitals');
              download(
                'vitals-' + stamp() + '.json',
                JSON.stringify(d, null, 2),
                'application/json'
              );
            },
          },
        },
        'Export JSON'
      )
    ),
    out,
    hist,
    section(
      'Frame-rate profiler',
      h('div', { class: 'row' }, dur, h('button', { on: { click: runProfile } }, '▶ Profile')),
      h(
        'div',
        { class: 'sev-info' },
        'Samples requestAnimationFrame while you scroll or animate the page, to find jank.'
      ),
      prof
    )
  );
  await render().catch((e) => clear(out).append(h('div', { class: 'card sev-error' }, e.message)));
  if (DF.state.perfAutoProfile) {
    DF.state.perfAutoProfile = false;
    await runProfile();
  }
});
