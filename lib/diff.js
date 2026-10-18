/*
 * Comparison helpers. Pure functions, no extension APIs, testable in Node.
 *
 *   compareReports(previous, current)  → scan trend ("2 new findings since the last scan")
 *   compareCaptures(a, b)              → what changed between two saved network captures
 *
 * Findings are matched by their id plus the address they concern; both are stable across scans
 * (for example "csp-missing" or "exposed-<probe id>"). Requests are matched by method + address (+ the nth repeat of that pair).
 */
const DFDiff = (() => {
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const SEV_RANK = { info: 0, low: 1, medium: 2, high: 3 };

  /* ---------- scan trend ---------- */

  function compareReports(prev, cur) {
    if (!prev || !cur || !Array.isArray(prev.findings) || !Array.isArray(cur.findings)) return null;
    // The same check can fire on several addresses (a missing header on two pages), so the
    // address is part of a finding's identity.
    const key = (f) => f.id + '|' + (f.resource || '');
    const before = new Map(prev.findings.map((f) => [key(f), f]));
    const after = new Map(cur.findings.map((f) => [key(f), f]));
    const added = cur.findings.filter((f) => !before.has(key(f)));
    const resolved = prev.findings.filter((f) => !after.has(key(f)));
    const worse = [];
    const better = [];
    for (const f of cur.findings) {
      const old = before.get(key(f));
      if (!old) continue;
      const d = (SEV_RANK[f.severity] || 0) - (SEV_RANK[old.severity] || 0);
      if (d > 0) worse.push({ id: f.id, title: f.title, from: old.severity, to: f.severity });
      else if (d < 0) better.push({ id: f.id, title: f.title, from: old.severity, to: f.severity });
    }
    const net = cur.findings.length - prev.findings.length;
    const parts = [];
    if (added.length) parts.push(plural(added.length, 'new finding') + ' since the last scan');
    if (resolved.length) parts.push(plural(resolved.length, 'finding') + ' no longer reported');
    let message;
    if (!added.length && !resolved.length) message = 'Same findings as the last scan.';
    else {
      message = parts.join(', ') + '.';
      if (net !== 0) message += ' Net: ' + Math.abs(net) + (net < 0 ? ' fewer ' : ' more ') + (Math.abs(net) === 1 ? 'finding' : 'findings') + ' than last time.';
    }
    const levelDiffers = prev.level !== cur.level;
    return {
      message,
      net,
      added: added.map((f) => ({ id: f.id, title: f.title, severity: f.severity })),
      resolved: resolved.map((f) => ({ id: f.id, title: f.title, severity: f.severity })),
      worse,
      better,
      unchanged: cur.findings.length - added.length,
      previousAt: prev.scannedAt || null,
      previousLevel: prev.level || null,
      levelDiffers,
      // A different scan level runs different checks, so a gap may reflect that and not a real change.
      caveat: levelDiffers ? 'The last scan used another level, so some differences may come from checks that only one of them ran.' : '',
    };
  }

  // The newest saved security report for the same origin, from a list of workspace items.
  // Items that are sealed (Owner mode locked) or damaged have no readable payload and are skipped.
  function latestPrevious(items, report) {
    let origin;
    try {
      origin = new URL(report.target).origin;
    } catch (_) {
      return null;
    }
    const cands = (items || [])
      .filter((it) => it && it.kind === 'security' && it.payload && it.payload.version === 2 && !it.locked && Array.isArray(it.payload.findings))
      .filter((it) => it.payload.id !== report.id)
      .filter((it) => {
        try {
          return new URL(it.payload.target).origin === origin;
        } catch (_) {
          return false;
        }
      })
      .filter((it) => !report.scannedAt || String(it.payload.scannedAt || '') < String(report.scannedAt))
      .sort((a, b) => String(b.payload.scannedAt || '').localeCompare(String(a.payload.scannedAt || '')));
    return cands.length ? cands[0].payload : null;
  }

  /* ---------- network captures ---------- */

  const baseUrl = (u, ignoreQuery) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname + (ignoreQuery ? '' : x.search);
    } catch (_) {
      return String(u || '');
    }
  };

  function keyed(entries, ignoreQuery) {
    const seen = new Map();
    const out = new Map();
    for (const e of entries || []) {
      const base = (e.method || 'GET') + ' ' + baseUrl(e.url, ignoreQuery);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.set(n === 1 ? base : base + ' #' + n, e);
    }
    return out;
  }

  const hdrDiff = (a, b) => {
    const x = a || {};
    const y = b || {};
    const out = { added: {}, removed: {}, changed: {} };
    for (const k of Object.keys(y)) {
      if (!(k in x)) out.added[k] = y[k];
      else if (String(x[k]) !== String(y[k])) out.changed[k] = [x[k], y[k]];
    }
    for (const k of Object.keys(x)) if (!(k in y)) out.removed[k] = x[k];
    const n = Object.keys(out.added).length + Object.keys(out.removed).length + Object.keys(out.changed).length;
    return n ? out : null;
  };

  // Header values that change on every request and would drown real differences.
  const NOISY = new Set(['date', 'age', 'etag', 'x-request-id', 'x-amzn-trace-id', 'cf-ray', 'set-cookie', 'server-timing', 'x-served-by', 'x-cache', 'content-length']);
  const quiet = (h) => {
    if (!h) return h;
    const o = {};
    for (const [k, v] of Object.entries(h)) if (!NOISY.has(k.toLowerCase())) o[k.toLowerCase()] = v;
    return o;
  };

  function compareCaptures(a, b, opts = {}) {
    const ignoreQuery = !!opts.ignoreQuery;
    const slowFactor = opts.slowFactor || 1.5;
    const A = keyed(a, ignoreQuery);
    const B = keyed(b, ignoreQuery);
    const added = [];
    const removed = [];
    const changed = [];
    let same = 0;
    for (const [k, y] of B) {
      const x = A.get(k);
      if (!x) {
        added.push({ key: k, entry: y });
        continue;
      }
      const ch = {};
      if (x.status !== y.status) ch.status = [x.status, y.status];
      const sx = x.size != null ? x.size : x.resBodySize;
      const sy = y.size != null ? y.size : y.resBodySize;
      if (sx != null && sy != null && sx !== sy) ch.size = [sx, sy];
      if (x.ms != null && y.ms != null && x.ms > 0 && (y.ms >= x.ms * slowFactor + 50 || y.ms * slowFactor + 50 <= x.ms)) ch.ms = [x.ms, y.ms];
      const rh = hdrDiff(quiet(x.reqHeaders), quiet(y.reqHeaders));
      if (rh) ch.requestHeaders = rh;
      const sh = hdrDiff(quiet(x.resHeaders), quiet(y.resHeaders));
      if (sh) ch.responseHeaders = sh;
      if (typeof x.resBody === 'string' && typeof y.resBody === 'string' && x.resBody !== y.resBody && x.resBody[0] !== '[' && y.resBody[0] !== '[') ch.body = [x.resBody.length, y.resBody.length];
      if (Object.keys(ch).length) changed.push({ key: k, before: x, after: y, changes: ch });
      else same++;
    }
    for (const [k, x] of A) if (!B.has(k)) removed.push({ key: k, entry: x });
    return {
      added,
      removed,
      changed,
      same,
      totals: { a: A.size, b: B.size },
      message:
        !added.length && !removed.length && !changed.length
          ? 'The two captures match.'
          : [added.length ? plural(added.length, 'request') + ' only in the second' : '', removed.length ? plural(removed.length, 'request') + ' only in the first' : '', changed.length ? plural(changed.length, 'request') + ' changed' : ''].filter(Boolean).join(', ') + '.',
    };
  }


  // A readable summary of a compareCaptures() result, for pasting into a ticket or a chat.
  function capturesToMarkdown(d, labels = {}) {
    const a = labels.a || 'First capture';
    const b = labels.b || 'Second capture';
    const L = ['# Network capture comparison', '', '- A: ' + a + ' (' + d.totals.a + ' requests)', '- B: ' + b + ' (' + d.totals.b + ' requests)', '- Result: ' + d.message, ''];
    const ch = (arr) => (Array.isArray(arr) ? arr[0] + ' → ' + arr[1] : '');
    if (d.changed.length) {
      L.push('## Changed', '');
      for (const x of d.changed) {
        L.push('### ' + x.key);
        for (const [k, v] of Object.entries(x.changes)) {
          if (k === 'requestHeaders' || k === 'responseHeaders') {
            for (const [n, val] of Object.entries(v.added)) L.push('- ' + k + ' added `' + n + '`: ' + String(val).slice(0, 120));
            for (const [n, val] of Object.entries(v.removed)) L.push('- ' + k + ' removed `' + n + '`: ' + String(val).slice(0, 120));
            for (const [n, val] of Object.entries(v.changed)) L.push('- ' + k + ' `' + n + '`: ' + String(val[0]).slice(0, 80) + ' → ' + String(val[1]).slice(0, 80));
          } else L.push('- ' + k + ': ' + ch(v));
        }
        L.push('');
      }
    }
    if (d.added.length) L.push('## Only in B', '', ...d.added.map((x) => '- ' + x.key + (x.entry.status != null ? ' (' + x.entry.status + ')' : '')), '');
    if (d.removed.length) L.push('## Only in A', '', ...d.removed.map((x) => '- ' + x.key + (x.entry.status != null ? ' (' + x.entry.status + ')' : '')), '');
    return L.join('\n');
  }

  // The fields worth keeping when a capture is saved to the Workspace: no bodies larger than a
  // preview, and credential-bearing headers are masked by the caller before this is used.
  function slimEntry(e, bodyChars = 4000) {
    const keep = ['id', 'kind', 'method', 'url', 'status', 'statusText', 'ms', 'size', 'type', 'error', 'blocked', 'mocked', 'start', 'reqHeaders', 'resHeaders', 'reqBody'];
    const o = {};
    for (const k of keep) if (e[k] !== undefined) o[k] = e[k];
    if (typeof e.resBody === 'string') o.resBody = e.resBody.length > bodyChars ? e.resBody.slice(0, bodyChars) + '…[truncated]' : e.resBody;
    return o;
  }

  return { compareReports, latestPrevious, compareCaptures, capturesToMarkdown, slimEntry, plural };
})();
if (typeof module !== 'undefined') module.exports = DFDiff;
