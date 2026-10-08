/*
 * Performance profiling: Core Web Vitals, Long Animation Frames (with script attribution where the
 * browser supports it), navigation timing breakdown and an on-demand frame-rate profiler.
 *
 * Observers are registered with `buffered: true`, so metrics from before injection (LCP, layout
 * shifts, slow interactions, long tasks) are still reported. The thresholds are the published
 * web.dev ones; INP here is the worst interaction seen, which matches the field definition for
 * pages with fewer than 50 interactions.
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.vitals) return;
  const { handleOf, label, clip, onDestroy } = DF.kit;

  const THRESHOLDS = {
    lcp: [2500, 4000],
    cls: [0.1, 0.25],
    inp: [200, 500],
    fcp: [1800, 3000],
    ttfb: [800, 1800],
  };
  const rate = (metric, v) =>
    v == null
      ? null
      : v <= THRESHOLDS[metric][0]
        ? 'good'
        : v <= THRESHOLDS[metric][1]
          ? 'ni'
          : 'poor';

  const v = {
    lcp: null,
    cls: { value: 0, session: 0, sessionStart: 0, sessionLast: 0, sources: [] },
    interactions: new Map(), // interactionId -> worst entry
    longTasks: [],
    loafs: [],
    observers: [],
    supported: {},
  };

  function observe(type, cb, extra) {
    try {
      const po = new PerformanceObserver((list) => list.getEntries().forEach(cb));
      po.observe({ type, buffered: true, ...(extra || {}) });
      v.observers.push(po);
      v.supported[type] = true;
    } catch (_) {
      v.supported[type] = false; // older Chrome or an unsupported entry type
    }
  }

  const nodeInfo = (node) => {
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.isConnected) return { label: label(node), h: null };
    return { label: label(el), h: handleOf(el) };
  };

  observe('largest-contentful-paint', (e) => {
    v.lcp = {
      value: Math.round(e.startTime),
      size: e.size,
      url: e.url ? clip(e.url, 300) : null,
      el: nodeInfo(e.element),
      renderTime: Math.round(e.renderTime || 0),
      loadTime: Math.round(e.loadTime || 0),
    };
  });

  // CLS uses session windows: shifts less than 1s apart, a window capped at 5s; the worst window wins.
  observe('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    const c = v.cls;
    if (c.session && e.startTime - c.sessionLast < 1000 && e.startTime - c.sessionStart < 5000)
      c.session += e.value;
    else {
      c.session = e.value;
      c.sessionStart = e.startTime;
    }
    c.sessionLast = e.startTime;
    c.value = Math.max(c.value, c.session);
    for (const s of e.sources || []) {
      if (c.sources.length >= 40) c.sources.shift();
      c.sources.push({
        t: Math.round(e.startTime),
        value: Math.round(e.value * 10000) / 10000,
        el: nodeInfo(s.node),
        from: s.previousRect
          ? [s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map(
              Math.round
            )
          : null,
        to: s.currentRect
          ? [s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map(
              Math.round
            )
          : null,
      });
    }
  });

  observe(
    'event',
    (e) => {
      if (!e.interactionId) return;
      const prev = v.interactions.get(e.interactionId);
      if (prev && prev.duration >= e.duration) return;
      v.interactions.set(e.interactionId, {
        type: e.name,
        duration: Math.round(e.duration),
        start: Math.round(e.startTime),
        inputDelay: Math.round(e.processingStart - e.startTime),
        processing: Math.round(e.processingEnd - e.processingStart),
        presentation: Math.round(e.startTime + e.duration - e.processingEnd),
        el: nodeInfo(e.target),
      });
    },
    { durationThreshold: 16 }
  );

  observe('longtask', (e) => {
    if (v.longTasks.length >= 300) v.longTasks.shift();
    v.longTasks.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
  });

  // Long Animation Frames (Chrome 123+) carry script attribution, which long tasks do not.
  observe('long-animation-frame', (e) => {
    if (v.loafs.length >= 200) v.loafs.shift();
    v.loafs.push({
      start: Math.round(e.startTime),
      ms: Math.round(e.duration),
      blocking: Math.round(e.blockingDuration || 0),
      renderStart: Math.round(e.renderStart || 0),
      styleLayout: Math.round(
        e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0
      ),
      scripts: (e.scripts || []).slice(0, 8).map((s) => ({
        ms: Math.round(s.duration),
        invoker: clip(s.invoker || '', 120),
        invokerType: s.invokerType || '',
        source: clip(s.sourceURL || '', 200),
        fn: s.sourceFunctionName || '',
        char: s.sourceCharPosition,
        forcedLayout: Math.round(s.forcedStyleAndLayoutDuration || 0),
      })),
    });
  });

  function navBreakdown() {
    const n = performance.getEntriesByType('navigation')[0];
    if (!n) return null;
    const d = (a, b) => (a > 0 && b > 0 && b >= a ? Math.round(b - a) : 0);
    return {
      type: n.type,
      protocol: n.nextHopProtocol || null,
      redirect: d(n.redirectStart, n.redirectEnd),
      dns: d(n.domainLookupStart, n.domainLookupEnd),
      connect: d(n.connectStart, n.connectEnd),
      tls: n.secureConnectionStart > 0 ? d(n.secureConnectionStart, n.connectEnd) : 0,
      request: d(n.requestStart, n.responseStart),
      response: d(n.responseStart, n.responseEnd),
      domInteractive: Math.round(n.domInteractive),
      domContentLoaded: Math.round(n.domContentLoadedEventEnd),
      load: Math.round(n.loadEventEnd),
      ttfb: Math.round(n.responseStart),
      transferSize: n.transferSize,
      encodedBodySize: n.encodedBodySize,
      decodedBodySize: n.decodedBodySize,
      serverTiming: (n.serverTiming || []).map((s) => ({
        name: s.name,
        dur: s.duration,
        desc: s.description,
      })),
    };
  }

  function vitals() {
    const nav = navBreakdown();
    const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
    const fcp = fcpEntry ? Math.round(fcpEntry.startTime) : null;
    const inter = [...v.interactions.values()].sort((a, b) => b.duration - a.duration);
    const inp = inter[0] || null;
    const tbt = v.longTasks.reduce((sum, t) => sum + Math.max(0, t.ms - 50), 0);
    // Aggregate LoAF script time by source so the heaviest scripts float to the top.
    const bySource = new Map();
    for (const f of v.loafs)
      for (const s of f.scripts) {
        const key = (s.source || '(inline / unknown)') + (s.fn ? ' :: ' + s.fn : '');
        const agg = bySource.get(key) || {
          key,
          ms: 0,
          count: 0,
          forcedLayout: 0,
          invoker: s.invoker,
        };
        agg.ms += s.ms;
        agg.count++;
        agg.forcedLayout += s.forcedLayout;
        bySource.set(key, agg);
      }
    const mem = performance.memory
      ? {
          used: performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
          limit: performance.memory.jsHeapSizeLimit,
        }
      : null;
    return {
      url: location.href,
      sinceLoad: Math.round(performance.now()),
      lcp: v.lcp ? { ...v.lcp, rating: rate('lcp', v.lcp.value) } : null,
      cls: {
        value: Math.round(v.cls.value * 1000) / 1000,
        rating: rate('cls', v.cls.value),
        // Sub-0.0001 shifts round to 0.0000 and only add noise to the table.
        sources: v.cls.sources
          .filter((s) => s.value >= 0.0001)
          .sort((a, b) => b.value - a.value)
          .slice(0, 12),
      },
      inp: inp ? { ...inp, value: inp.duration, rating: rate('inp', inp.duration) } : null,
      interactions: inter.length,
      worstInteractions: inter.slice(0, 10),
      fcp: fcp == null ? null : { value: fcp, rating: rate('fcp', fcp) },
      ttfb: nav ? { value: nav.ttfb, rating: rate('ttfb', nav.ttfb) } : null,
      nav,
      longTasks: {
        count: v.longTasks.length,
        tbt,
        worst: v.longTasks
          .slice()
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 10),
      },
      loaf: {
        count: v.loafs.length,
        blocking: v.loafs.reduce((s, f) => s + f.blocking, 0),
        worst: v.loafs
          .slice()
          .sort((a, b) => b.ms - a.ms)
          .slice(0, 8),
        scripts: [...bySource.values()].sort((a, b) => b.ms - a.ms).slice(0, 12),
      },
      memory: mem,
      supported: v.supported,
      thresholds: THRESHOLDS,
    };
  }

  // Frame profiler: samples requestAnimationFrame deltas for `ms` milliseconds.
  let profiling = null;
  function profileFrames(ms) {
    if (profiling) throw new Error('A frame profile is already running.');
    const duration = Math.min(Math.max(+ms || 3000, 500), 15000);
    const loafsBefore = v.loafs.length;
    return new Promise((resolve) => {
      const deltas = [];
      let last = performance.now();
      let done = false;
      const end = last + duration;
      const step = (now) => {
        deltas.push(now - last);
        last = now;
        if (now < end) profiling = requestAnimationFrame(step);
        else finish();
      };
      // rAF is paused in background tabs; this timer guarantees the promise still settles.
      const safety = setTimeout(finish, duration + 2000);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(safety);
        cancelAnimationFrame(profiling);
        profiling = null;
        const sorted = deltas.slice().sort((a, b) => a - b);
        const pct = (p) =>
          sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
        const total = deltas.reduce((a, b) => a + b, 0) || 1;
        const budget = 1000 / 60;
        // Downsample to at most 240 points so the panel's sparkline stays light.
        const stepN = Math.max(1, Math.ceil(deltas.length / 240));
        const series = [];
        for (let i = 0; i < deltas.length; i += stepN)
          series.push(Math.round(Math.max(...deltas.slice(i, i + stepN)) * 10) / 10);
        resolve({
          duration: Math.round(total),
          frames: deltas.length,
          fps: Math.round((deltas.length / total) * 1000 * 10) / 10,
          p50: Math.round(pct(0.5) * 10) / 10,
          p95: Math.round(pct(0.95) * 10) / 10,
          p99: Math.round(pct(0.99) * 10) / 10,
          worst: Math.round((sorted[sorted.length - 1] || 0) * 10) / 10,
          janky: deltas.filter((d) => d > budget * 1.5).length,
          severe: deltas.filter((d) => d > 50).length,
          series,
          loafsDuring: v.loafs.length - loafsBefore,
          hidden: document.hidden,
        });
      }
      profiling = requestAnimationFrame(step);
    });
  }

  onDestroy(() => {
    v.observers.forEach((o) => o.disconnect());
    if (profiling) cancelAnimationFrame(profiling);
  });
  DF.extend({ vitals, profileFrames });
})();
