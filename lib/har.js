// Network helpers shared by the Network tab: copy-as snippets, HAR export, timing phases,
// Server-Timing and GraphQL parsing. Pure functions, unit-testable under Node.
const DFHar = (() => {
  // Headers a client recomputes itself; copying them into a snippet only causes errors.
  const HOP =
    /^(host|content-length|connection|keep-alive|accept-encoding|transfer-encoding|:.*)$/i;

  const bashQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const hasBody = (e) => e.reqBody != null && e.reqBody !== '' && !/^\[.*\]$/.test(e.reqBody);

  function toCurl(e) {
    // One flag (with its value) per line, the way DevTools formats it.
    const parts = ['curl ' + bashQuote(e.url)];
    if (e.method && e.method !== 'GET' && !(e.method === 'POST' && hasBody(e)))
      parts.push('-X ' + e.method);
    for (const [k, v] of Object.entries(e.reqHeaders || {}))
      if (!HOP.test(k)) parts.push('-H ' + bashQuote(k + ': ' + v));
    if (hasBody(e)) parts.push('--data-raw ' + bashQuote(e.reqBody));
    parts.push('--compressed');
    return parts.join(' \\\n  ');
  }

  function toFetch(e) {
    const init = { method: e.method || 'GET' };
    const headers = {};
    for (const [k, v] of Object.entries(e.reqHeaders || {})) if (!HOP.test(k)) headers[k] = v;
    if (Object.keys(headers).length) init.headers = headers;
    if (hasBody(e)) init.body = e.reqBody;
    init.credentials = 'include';
    return `await fetch(${JSON.stringify(e.url)}, ${JSON.stringify(init, null, 2)});`;
  }

  function toPowerShell(e) {
    const lines = [];
    const headers = Object.entries(e.reqHeaders || {}).filter(
      ([k]) => !HOP.test(k) && !/^(content-type|user-agent)$/i.test(k)
    );
    if (headers.length) {
      lines.push('$headers = @{');
      headers.forEach(([k, v]) => lines.push(`  ${psQuote(k)} = ${psQuote(v)}`));
      lines.push('}');
    }
    let cmd = `Invoke-WebRequest -Uri ${psQuote(e.url)} -Method ${e.method || 'GET'}`;
    if (headers.length) cmd += ' -Headers $headers';
    const ct = (e.reqHeaders || {})['content-type'];
    if (ct) cmd += ` -ContentType ${psQuote(ct)}`;
    const ua = (e.reqHeaders || {})['user-agent'];
    if (ua) cmd += ` -UserAgent ${psQuote(ua)}`;
    if (hasBody(e)) cmd += ` -Body ${psQuote(e.reqBody)}`;
    lines.push(cmd);
    return lines.join('\n');
  }

  /*
   * Phases from a PerformanceResourceTiming-like object (milliseconds). Zero values mean the phase
   * did not happen (connection reuse, cache hit) or the server withheld Timing-Allow-Origin.
   */
  function timingPhases(t) {
    if (!t) return null;
    const d = (a, b) => (a > 0 && b > 0 && b >= a ? b - a : 0);
    const restricted = !t.requestStart && !t.responseStart && t.duration > 0;
    return {
      restricted,
      queued: d(t.startTime, t.domainLookupStart || t.fetchStart),
      redirect: d(t.redirectStart, t.redirectEnd),
      dns: d(t.domainLookupStart, t.domainLookupEnd),
      connect: d(
        t.connectStart,
        t.secureConnectionStart > 0 ? t.secureConnectionStart : t.connectEnd
      ),
      tls: t.secureConnectionStart > 0 ? d(t.secureConnectionStart, t.connectEnd) : 0,
      wait: d(t.requestStart, t.responseStart),
      download: d(t.responseStart, t.responseEnd),
      total: t.duration || 0,
    };
  }

  // Parses a Server-Timing header: `db;dur=53.2;desc="Query", cache;desc=hit`.
  function parseServerTiming(header) {
    if (!header) return [];
    return String(header)
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((part) => {
        const [name, ...params] = part.trim().split(';');
        const out = { name: name.trim() };
        for (const p of params) {
          const i = p.indexOf('=');
          const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
          const v =
            i < 0
              ? ''
              : p
                  .slice(i + 1)
                  .trim()
                  .replace(/^"|"$/g, '');
          if (k === 'dur') out.dur = parseFloat(v);
          else if (k === 'desc') out.desc = v;
        }
        return out;
      })
      .filter((x) => x.name);
  }

  // Recognises GraphQL POST bodies (single or batched) and GET ?query= requests.
  function graphqlInfo(e) {
    const pick = (o) => {
      if (!o || typeof o.query !== 'string') return null;
      const m = /^\s*(query|mutation|subscription)\b\s*([A-Za-z_]\w*)?/.exec(o.query);
      return {
        operationName: o.operationName || (m && m[2]) || '(anonymous)',
        type: m ? m[1] : 'query',
        variables: o.variables || null,
      };
    };
    try {
      if (hasBody(e) && /^\s*[[{]/.test(e.reqBody)) {
        const j = JSON.parse(e.reqBody);
        const ops = (Array.isArray(j) ? j : [j]).map(pick).filter(Boolean);
        if (ops.length) return ops;
      }
      const u = new URL(e.url);
      const q = u.searchParams.get('query');
      if (q) return [pick({ query: q, operationName: u.searchParams.get('operationName') })];
    } catch (_) {
      /* not JSON, or not a URL: just not GraphQL */
    }
    return null;
  }

  const headerList = (o) =>
    Object.entries(o || {}).map(([name, value]) => ({ name, value: String(value) }));
  function queryList(url) {
    try {
      return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
    } catch (_) {
      return [];
    }
  }

  // HAR 1.2. `timing` maps an entry id to its Resource Timing record when one was matched.
  function toHar(entries, meta) {
    meta = meta || {};
    const started = new Date(meta.startedAt || Date.now()).toISOString();
    return {
      log: {
        version: '1.2',
        creator: { name: 'DevForge', version: meta.version || '' },
        pages: [
          {
            startedDateTime: started,
            id: 'page_1',
            title: meta.title || meta.pageUrl || '',
            pageTimings: {},
          },
        ],
        entries: entries.map((e) => {
          const t = (meta.timing && meta.timing[e.id]) || null;
          const ph = timingPhases(t);
          const ct = (e.resHeaders && e.resHeaders['content-type']) || '';
          const reqCt = (e.reqHeaders && e.reqHeaders['content-type']) || '';
          const proto = (t && t.nextHopProtocol) || e.protocol || '';
          const httpVersion = proto === 'h2' ? 'HTTP/2' : proto === 'h3' ? 'HTTP/3' : 'HTTP/1.1';
          const entry = {
            pageref: 'page_1',
            startedDateTime: new Date(e.t || Date.now()).toISOString(),
            time: e.ms || (t && t.duration) || 0,
            request: {
              method: e.method === 'GET?' ? 'GET' : e.method || 'GET',
              url: e.url,
              httpVersion,
              cookies: [],
              headers: headerList(e.reqHeaders),
              queryString: queryList(e.url),
              headersSize: -1,
              bodySize: e.reqBody ? e.reqBody.length : 0,
            },
            response: {
              status: e.status || 0,
              statusText: e.statusText || '',
              httpVersion,
              cookies: [],
              headers: headerList(e.resHeaders),
              content: {
                size: (t && t.decodedBodySize) || e.size || (e.resBody ? e.resBody.length : 0),
                mimeType: ct || 'x-unknown',
                ...(typeof e.resBody === 'string' && !/^\[.*\]$/.test(e.resBody)
                  ? { text: e.resBody }
                  : {}),
              },
              redirectURL: e.redirectedTo || '',
              headersSize: -1,
              bodySize: (t && t.transferSize) || -1,
            },
            cache: {},
            timings: {
              blocked: ph ? ph.queued : -1,
              dns: ph && ph.dns ? ph.dns : -1,
              connect: ph && ph.connect ? ph.connect + ph.tls : -1,
              ssl: ph && ph.tls ? ph.tls : -1,
              send: 0,
              wait: ph ? ph.wait : e.ms || 0,
              receive: ph ? ph.download : 0,
            },
            _devforge: {
              kind: e.kind,
              mocked: !!e.mocked,
              blocked: !!e.blocked,
              rules: e.rules || [],
            },
          };
          if (hasBody(e))
            entry.request.postData = { mimeType: reqCt || 'text/plain', text: e.reqBody };
          return entry;
        }),
      },
    };
  }

  return { toCurl, toFetch, toPowerShell, timingPhases, parseServerTiming, graphqlInfo, toHar };
})();
if (typeof module !== 'undefined') module.exports = DFHar;
