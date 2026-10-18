/*
 * Performance history: a small record of Core Web Vitals per page, so the Perf tab can show how
 * they change between checks. Pure functions; the panel keeps the result in chrome.storage.local.
 */
const DFPerfHist = (() => {
  const METRICS = {
    lcp: { label: 'LCP', unit: 'ms', good: 2500, poor: 4000 },
    fcp: { label: 'FCP', unit: 'ms', good: 1800, poor: 3000 },
    ttfb: { label: 'TTFB', unit: 'ms', good: 800, poor: 1800 },
    inp: { label: 'INP', unit: 'ms', good: 200, poor: 500 },
    cls: { label: 'CLS', unit: '', good: 0.1, poor: 0.25 },
  };
  // One history per page: the address without query or fragment.
  function keyFor(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (_) {
      return String(url || '').slice(0, 200);
    }
  }
  const num = (m) => (m && typeof m.value === 'number' && isFinite(m.value) ? Math.round(m.value * 1000) / 1000 : null);
  // From the object returned by the agent's vitals().
  function pointFrom(vitals, now = Date.now()) {
    const p = { t: now, lcp: num(vitals.lcp), fcp: num(vitals.fcp), ttfb: num(vitals.ttfb), inp: num(vitals.inp), cls: num(vitals.cls) };
    if (vitals.nav && typeof vitals.nav.load === 'number') p.load = Math.round(vitals.nav.load);
    return p;
  }
  const hasData = (p) => Object.keys(METRICS).some((k) => p[k] != null);
  const same = (a, b) => Object.keys(METRICS).every((k) => a[k] === b[k]) && a.load === b.load;
  // Returns a new store. A reading identical to the last one, or taken within 3 s of it, is not added.
  function add(store, key, point, limit = 30) {
    if (!hasData(point)) return store || {};
    const all = { ...(store || {}) };
    const list = (all[key] || []).slice();
    const last = list[list.length - 1];
    if (last && (same(last, point) || point.t - last.t < 3000)) return all;
    list.push(point);
    all[key] = list.slice(-Math.max(2, Math.min(200, limit)));
    return all;
  }
  const series = (points, metric) => (points || []).filter((p) => p[metric] != null).map((p) => ({ t: p.t, v: p[metric] }));
  function summary(points, metric) {
    const s = series(points, metric);
    if (!s.length) return null;
    const vals = s.map((x) => x.v).sort((a, b) => a - b);
    const latest = s[s.length - 1].v;
    const prev = s.length > 1 ? s[s.length - 2].v : null;
    const m = METRICS[metric];
    return {
      n: s.length,
      latest,
      prev,
      delta: prev == null ? null : Math.round((latest - prev) * 1000) / 1000,
      best: vals[0],
      worst: vals[vals.length - 1],
      median: vals[Math.floor((vals.length - 1) / 2)],
      rating: m ? (latest <= m.good ? 'good' : latest <= m.poor ? 'ni' : 'poor') : null,
    };
  }
  return { METRICS, keyFor, pointFrom, add, series, summary };
})();
if (typeof module !== 'undefined') module.exports = DFPerfHist;
