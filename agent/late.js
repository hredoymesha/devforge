/*
 * Resources that load after the page's first render. Watching starts on request and records what
 * comes after it: a MutationObserver for script, stylesheet, image and media nodes added to the
 * page, and a PerformanceObserver for resource timing, which keeps entries even after the
 * browser's own timing buffer is full. What loaded before watching started is only what the
 * browser still keeps in that buffer.
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.lateStart) return;
  const { dom } = DF.kit;
  // lib/latefetch.js is injected before this file.
  const LATE = window.DFLate;

  const CAP = 300;
  const SEL = 'script[src],link[rel~="stylesheet"][href],img[src],source[src],video[src],audio[src]';
  let started = false;
  let since = null;
  let timingObserver = null;
  const added = [];
  const timed = [];

  const absolute = (u) => {
    if (typeof u !== 'string' || !u) return null;
    try {
      return new URL(u, document.baseURI).href;
    } catch (_) {
      return null;
    }
  };
  const kindOf = (el) => {
    const t = String(dom.tagName(el)).toLowerCase();
    if (t === 'script') return 'script';
    if (t === 'link') return 'stylesheet';
    if (t === 'img') return 'image';
    return 'media';
  };
  function noteAdded(el) {
    if (added.length >= CAP) return;
    const isLink = String(dom.tagName(el)).toLowerCase() === 'link';
    const url = absolute(dom.getAttribute(el, isLink ? 'href' : 'src'));
    if (!url || added.some((x) => x.url === url)) return;
    added.push({ url, kind: kindOf(el), at: Math.round(performance.now()) });
  }
  function visit(node) {
    if (!(node instanceof Element)) return;
    if (dom.matches(node, SEL)) noteAdded(node);
    Array.from(dom.querySelectorAll(node, SEL)).forEach(noteAdded);
  }

  function lateStart() {
    if (started) return { started: true, since, timingObserver: !!timingObserver };
    started = true;
    since = Math.round(performance.now());
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) visit(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
    try {
      timingObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (timed.length < CAP) {
            timed.push({ name: e.name, initiatorType: e.initiatorType, startTime: e.startTime, responseStatus: e.responseStatus, transferSize: e.transferSize });
          }
        }
      });
      timingObserver.observe({ type: 'resource', buffered: false });
    } catch (_) {
      timingObserver = null;
    }
    return { started: true, since, timingObserver: !!timingObserver };
  }

  // What was seen so far: the timing entries after the first render, and the nodes added to the page.
  function lateList() {
    const nav = performance.getEntriesByType('navigation')[0];
    const domContentLoaded = nav ? nav.domContentLoadedEventStart : 0;
    const buffered = performance.getEntriesByType('resource');
    return {
      watching: started,
      since,
      domContentLoaded: Math.round(domContentLoaded),
      timingBufferFull: buffered.length >= 250,
      timing: LATE.lateEntries([...buffered, ...timed], domContentLoaded),
      observed: added.map((x) => ({ ...x })),
    };
  }

  DF.extend({ lateStart, lateList });
})();
