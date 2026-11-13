// Resources that a page loads after its first render, and what the export does with them. Pure: the
// page agent collects the raw entries (resource timing and added nodes), and this file decides
// which ones are late, what kind each one is and what its file is called.
const DFLate = (() => {
  const KINDS = {
    script: 'script',
    link: 'stylesheet',
    css: 'stylesheet',
    img: 'image',
    image: 'image',
    source: 'media',
    video: 'media',
    audio: 'media',
    fetch: 'data',
    xmlhttprequest: 'data',
    beacon: 'data',
    other: 'other',
  };
  const MAX = 300;

  // The kind of one resource. The initiator type is the browser's own record of who asked for it.
  function kindOf(initiatorType, url) {
    if (KINDS[initiatorType]) return KINDS[initiatorType];
    if (/\.m?js(\?|#|$)/i.test(url)) return 'script';
    if (/\.css(\?|#|$)/i.test(url)) return 'stylesheet';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|#|$)/i.test(url)) return 'image';
    return 'other';
  }

  // Only web addresses can be fetched. Blob, data and extension addresses are listed, not saved.
  function fetchable(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  // Entries that began after the page's first render (DOMContentLoaded), oldest first, with no
  // address twice. entries: [{ name, initiatorType, startTime, responseStatus?, transferSize? }].
  function lateEntries(entries, domContentLoadedAt) {
    const cut = Number.isFinite(domContentLoadedAt) ? domContentLoadedAt : 0;
    const seen = new Set();
    const out = [];
    const valid = (entries || []).filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.startTime) && e.startTime > cut);
    for (const e of valid.sort((a, b) => a.startTime - b.startTime)) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({
        url: e.name,
        kind: kindOf(e.initiatorType, e.name),
        startTime: Math.round(e.startTime),
        status: Number.isFinite(e.responseStatus) && e.responseStatus > 0 ? e.responseStatus : null,
      });
      if (out.length >= MAX) break;
    }
    return out;
  }

  // Merges what the observers saw (nodes added to the page) with what the timing recorded. A node
  // the timing already has keeps the timing's kind and start.
  function merge(timed, observed) {
    const byUrl = new Map(timed.map((x) => [x.url, x]));
    for (const o of observed || []) {
      if (!o || !o.url || byUrl.has(o.url)) continue;
      byUrl.set(o.url, { url: o.url, kind: o.kind || kindOf('', o.url), startTime: o.at == null ? null : Math.round(o.at), status: null, via: 'added to the page' });
      if (byUrl.size >= MAX) break;
    }
    return [...byUrl.values()];
  }

  // A file name in the export: its position, then the address' last path piece, made safe.
  function fileName(url, index, kind) {
    let base = 'resource';
    try {
      const u = new URL(url);
      base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    } catch (_) {
      /* keep the default */
    }
    const safe = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'resource';
    const dir = kind === 'stylesheet' ? 'css' : kind === 'script' ? 'js' : kind === 'image' ? 'images' : 'other';
    return 'loaded-later/' + dir + '/' + String(index + 1).padStart(3, '0') + '-' + safe;
  }

  return { kindOf, fetchable, lateEntries, merge, fileName, MAX };
})();
// The page agent runs in the isolated world, where a top-level const is not a window property.
if (typeof window !== 'undefined') window.DFLate = DFLate;
if (typeof module !== 'undefined') module.exports = DFLate;
