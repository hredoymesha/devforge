/*
 * DOM mutation timeline. Injected after agent.js and registered through __DF.extend().
 *
 * Compared to a bare MutationObserver dump this keeps old/new values, resolves each record to a
 * handle the panel can select, aggregates "hot" targets and a per-second rate, and can flash
 * mutated elements on the page (similar to DevTools paint flashing, but for DOM writes).
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.mutStart) return;
  const { handleOf, target, clip, isOwn, label, onDestroy } = DF.kit;

  const MAX_LOG = 2000;
  const RATE_WINDOW = 60; // seconds of per-second history kept for the sparkline

  const m = {
    mo: null,
    seq: 0,
    log: [],
    startedAt: 0,
    counts: { attributes: 0, childList: 0, characterData: 0 },
    hot: new Map(), // handle -> {label, count, last}
    rate: [], // [{s, n}]
    dropped: 0,
    opts: null,
    flash: null,
  };

  const describeNode = (n) => {
    if (n.nodeType === 3) return '"' + clip(n.textContent.trim(), 40) + '"';
    if (n.nodeType === 8) return '<!--' + clip(n.textContent, 30) + '-->';
    return label(n);
  };

  function bumpRate() {
    const s = Math.floor((performance.now() - m.startedAt) / 1000);
    const last = m.rate[m.rate.length - 1];
    if (last && last.s === s) last.n++;
    else {
      m.rate.push({ s, n: 1 });
      if (m.rate.length > RATE_WINDOW) m.rate.shift();
    }
  }

  // Flash overlay: a pool of absolutely positioned boxes in a closed shadow root.
  function flashEl(el) {
    if (!m.flash || !el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    const f = m.flash;
    if (f.budget-- <= 0) return; // at most a few dozen flashes per frame
    const b = f.pool[f.next++ % f.pool.length];
    b.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:1px solid rgba(255,170,0,.95);background:rgba(255,170,0,.22);pointer-events:none;box-sizing:border-box;opacity:1;transition:none`;
    // Force a style flush so the transition back to transparent actually animates.
    void b.offsetWidth;
    b.style.transition = 'opacity .6s ease-out';
    b.style.opacity = '0';
  }
  function ensureFlashLayer() {
    if (m.flash) return;
    const host = document.createElement('div');
    host.id = '__df_flash_host';
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    const root = host.attachShadow({ mode: 'closed' });
    const pool = Array.from({ length: 48 }, () => root.appendChild(document.createElement('div')));
    document.documentElement.appendChild(host);
    const f = { host, pool, next: 0, budget: 40, raf: 0 };
    const tick = () => {
      f.budget = 40;
      f.raf = requestAnimationFrame(tick);
    };
    f.raf = requestAnimationFrame(tick);
    m.flash = f;
  }
  function dropFlashLayer() {
    if (!m.flash) return;
    cancelAnimationFrame(m.flash.raf);
    m.flash.host.remove();
    m.flash = null;
  }

  function onRecords(list) {
    const t = Math.round(performance.now() - m.startedAt);
    for (const rec of list) {
      if (isOwn(rec.target)) continue;
      const el = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      if (!el) continue;
      const h = handleOf(el);
      const entry = { seq: ++m.seq, t, type: rec.type, h, target: label(el) };
      if (rec.type === 'attributes') {
        entry.attr = rec.attributeName;
        entry.old = rec.oldValue == null ? null : clip(rec.oldValue, 200);
        const cur = el.getAttribute(rec.attributeName);
        entry.now = cur == null ? null : clip(cur, 200);
        // Frameworks often re-set an attribute to the same value; flag it, it is wasted work.
        entry.noop = entry.old === entry.now;
      } else if (rec.type === 'characterData') {
        entry.old = clip(rec.oldValue, 120);
        entry.now = clip(rec.target.textContent, 120);
        entry.noop = entry.old === entry.now;
      } else {
        const added = [...rec.addedNodes].filter((n) => !isOwn(n));
        const removed = [...rec.removedNodes].filter((n) => !isOwn(n));
        if (!added.length && !removed.length) continue;
        entry.added = added.slice(0, 6).map(describeNode);
        entry.removed = removed.slice(0, 6).map(describeNode);
        entry.addedCount = added.length;
        entry.removedCount = removed.length;
      }
      m.counts[rec.type]++;
      const hot = m.hot.get(h) || { h, label: entry.target, count: 0, last: 0 };
      hot.count++;
      hot.last = t;
      m.hot.set(h, hot);
      bumpRate();
      if (m.log.length >= MAX_LOG) {
        m.log.shift();
        m.dropped++;
      }
      m.log.push(entry);
      if (m.flash) flashEl(el);
    }
  }

  function mutStart(opts) {
    opts = opts || {};
    mutStop();
    const root = opts.scopeH ? target(opts.scopeH) : document.documentElement;
    m.seq = 0;
    m.log = [];
    m.counts = { attributes: 0, childList: 0, characterData: 0 };
    m.hot = new Map();
    m.rate = [];
    m.dropped = 0;
    m.startedAt = performance.now();
    m.opts = {
      scope: opts.scopeH ? label(root) : 'document',
      attributes: opts.attributes !== false,
      childList: opts.childList !== false,
      characterData: opts.characterData !== false,
      flash: !!opts.flash,
    };
    m.mo = new MutationObserver(onRecords);
    m.mo.observe(root, {
      subtree: true,
      childList: m.opts.childList,
      attributes: m.opts.attributes,
      attributeOldValue: m.opts.attributes,
      characterData: m.opts.characterData,
      characterDataOldValue: m.opts.characterData,
    });
    if (m.opts.flash) ensureFlashLayer();
    return mutRead(0);
  }

  function mutStop() {
    if (m.mo) {
      // Deliver whatever is still queued so the last burst is not lost.
      onRecords(m.mo.takeRecords());
      m.mo.disconnect();
      m.mo = null;
    }
    dropFlashLayer();
    return { tracking: false };
  }

  function mutFlash(on) {
    if (on) ensureFlashLayer();
    else dropFlashLayer();
    if (m.opts) m.opts.flash = !!on;
    return { flash: !!m.flash };
  }

  // Returns entries newer than `since` plus aggregate stats, so the panel can poll cheaply.
  function mutRead(since) {
    if (m.mo) onRecords(m.mo.takeRecords());
    const fresh = m.log.filter((e) => e.seq > (since || 0));
    const hot = [...m.hot.values()]
      .filter((x) => DF.kit.byHandle(x.h))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
    const nowS = Math.floor((performance.now() - m.startedAt) / 1000);
    const rate = [];
    for (let s = Math.max(0, nowS - RATE_WINDOW + 1); s <= nowS; s++) {
      const hit = m.rate.find((r) => r.s === s);
      rate.push(hit ? hit.n : 0);
    }
    return {
      tracking: !!m.mo,
      opts: m.opts,
      seq: m.seq,
      entries: fresh.slice(-500),
      truncated: fresh.length > 500,
      dropped: m.dropped,
      counts: m.counts,
      total: m.counts.attributes + m.counts.childList + m.counts.characterData,
      elapsed: m.startedAt ? Math.round(performance.now() - m.startedAt) : 0,
      hot,
      rate: m.mo ? rate : [],
    };
  }

  function mutExport() {
    return { opts: m.opts, counts: m.counts, entries: m.log, dropped: m.dropped };
  }

  onDestroy(mutStop);
  DF.extend({ mutStart, mutStop, mutRead, mutFlash, mutExport });
})();
