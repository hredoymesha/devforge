/* Helpers for exports and fetches that touch untrusted page data.
 * Loaded as a plain script in the panel and with require() in the unit tests. */
const DFSafe = (() => {
  /* Spreadsheet-safe CSV: cells that start (after whitespace/control chars) with = + - @ would be evaluated as formulas by Excel/Sheets/LibreOffice.
     They are prefixed with a single quote so they open as text. Plain numbers such as -5 or +3.2 are left alone. */
  // eslint-disable-next-line no-control-regex
  const FORMULA_LEAD = /^[\s\u0000-\u001f\u007f\u00a0\ufeff]*[=+\-@|]/;
  const PLAIN_NUMBER = /^\s*[+-]?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/;
  const csvNeutralize = (v) => (FORMULA_LEAD.test(v) && !PLAIN_NUMBER.test(v) ? "'" + v : v);
  const csvEsc = (v) => {
    v = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    v = csvNeutralize(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };

  // redaction for captured network data (default ON)
  const SENSITIVE_KEY =
    /(pass(word|wd)?|pwd|token|secret|auth|api[_-]?key|apikey|access[_-]?key|session|sess(id)?|cookie|csrf|xsrf|signature|sig|otp|pin|ssn|card|cvv|credential|bearer|jwt)/i;
  function redactUrl(u) {
    try {
      const x = new URL(u);
      let hit = false;
      for (const k of [...x.searchParams.keys()])
        if (SENSITIVE_KEY.test(k)) {
          x.searchParams.set(k, '[redacted]');
          hit = true;
        }
      if (x.username || x.password) {
        x.username = '';
        x.password = '';
        hit = true;
      }
      return hit ? decodeURI(x.href).replace(/%5Bredacted%5D/gi, '[redacted]') : u;
    } catch (_) {
      return u;
    }
  }
  function redactValue(v, depth = 0) {
    if (depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v))
        o[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(x, depth + 1);
      return o;
    }
    return v;
  }
  function redactBody(b) {
    if (b == null || typeof b !== 'string') return b;
    const t = b.trim();
    if (t[0] === '{' || t[0] === '[') {
      try {
        return JSON.stringify(redactValue(JSON.parse(t)), null, 1);
      } catch (_) {
        /* truncated JSON: fall through */
      }
    }
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(t))
      return t
        .split('&')
        .map((p) => {
          const i = p.indexOf('=');
          return SENSITIVE_KEY.test(p.slice(0, i)) ? p.slice(0, i) + '=[redacted]' : p;
        })
        .join('&');
    return b.replace(
      /("(?:[^"\\]*(?:pass(?:word)?|token|secret|auth|api[_-]?key|session|cookie|csrf|credential|jwt)[^"\\]*)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
    );
  }
  function redactEntry(e) {
    return {
      ...e,
      url: redactUrl(e.url),
      reqHeaders: redactHeaders(e.reqHeaders),
      resHeaders: redactHeaders(e.resHeaders),
      reqBody: redactBody(e.reqBody),
      resBody: redactBody(e.resBody),
      initiator: e.initiator,
    };
  }
  const redactHeaders = (o) =>
    Object.fromEntries(
      Object.entries(o || {}).map(([k, v]) => [
        k,
        /^(authorization|cookie|set-cookie|x-api-key|x-auth|x-csrf|x-xsrf|proxy-authorization)/i.test(
          k
        ) || SENSITIVE_KEY.test(k)
          ? '[redacted]'
          : v,
      ])
    );

  // private-network guard for page-derived fetches (SSRF-style protection)
  function isPrivateHost(host) {
    host = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    )
      return true;
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const [a, b] = [+m[1], +m[2]];
      return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
      );
    }
    if (host.includes(':'))
      return (
        host === '::1' ||
        host === '::' ||
        /^f[cd]/.test(host) ||
        /^fe[89ab]/.test(host) ||
        host.startsWith('::ffff:')
      );
    return false;
  }
  /* true when fetching `url` from a page at `pageUrl` would reach a private/loopback host the page itself isn't on */
  function blocksPrivate(url, pageUrl) {
    try {
      const t = new URL(url),
        p = new URL(pageUrl);
      if (!isPrivateHost(t.hostname)) return false;
      return t.hostname !== p.hostname;
    } catch (_) {
      return true;
    }
  }

  return {
    csvNeutralize,
    csvEsc,
    redactUrl,
    redactValue,
    redactBody,
    redactEntry,
    redactHeaders,
    isPrivateHost,
    blocksPrivate,
  };
})();
if (typeof module !== 'undefined') module.exports = DFSafe;

if (typeof window !== 'undefined') {
  Object.assign(window, DFSafe);
}
