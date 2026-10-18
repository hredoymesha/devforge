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
  /* Keys are split into words (camelCase, snake_case, kebab-case) and matched by word, so "author",
     "design" and "shipping" are kept while "authToken", "client_secret" and "X-Api-Key" are not.
     STRONG stems are rare enough inside other words to match anywhere in a word ("accesstoken");
     WEAK ones only match a whole word, or the listed longer forms. */
  const STRONG_STEMS = [
    'password', 'passwd', 'passcode', 'token', 'secret', 'apikey', 'credential', 'session',
    'cookie', 'csrf', 'xsrf', 'signature', 'bearer', 'jwt', 'privatekey', 'sessid',
  ];
  const WEAK_WORDS = new Set([
    'pass', 'pwd', 'auth', 'authorization', 'authorisation', 'authentication', 'sig', 'otp', 'pin',
    'ssn', 'card', 'cvv', 'cvc', 'key', 'sid',
  ]);
  // "key" alone is too common ("keyboard", "sort key"); it only counts next to api/access/private/secret.
  const KEY_PREFIXES = new Set(['api', 'access', 'private', 'secret', 'auth', 'secure']);
  function isSensitiveKey(key) {
    const words = String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return words.some((w, i) => {
      if (STRONG_STEMS.some((stem) => w.includes(stem))) return true;
      if (w === 'key') return i > 0 && KEY_PREFIXES.has(words[i - 1]);
      return WEAK_WORDS.has(w);
    });
  }
  function redactUrl(u) {
    try {
      const x = new URL(u);
      let hit = false;
      for (const k of [...x.searchParams.keys()])
        if (isSensitiveKey(k)) {
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
        o[k] = isSensitiveKey(k) ? '[redacted]' : redactValue(x, depth + 1);
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
          return isSensitiveKey(p.slice(0, i)) ? p.slice(0, i) + '=[redacted]' : p;
        })
        .join('&');
    // Truncated JSON cannot be parsed, so blank the string value after any sensitive-looking key.
    return b.replace(/("([^"\\]*)"\s*:\s*)"[^"]*"/g, (m, lead, key) =>
      isSensitiveKey(key) ? lead + '"[redacted]"' : m
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
        ) || isSensitiveKey(k)
          ? '[redacted]'
          : v,
      ])
    );

  /*
   * Private-network guard for page-derived fetches (SSRF-style protection).
   *
   * Hosts are classified by PARSING them, not by pattern-matching text: the URL parser has already
   * turned 0x7f.1, 2130706433 and 017700000001 into dotted decimal, so what arrives here is a
   * canonical dotted-quad, a bracketed IPv6 literal, or a name. Limits that no extension can remove:
   * a public-looking name that resolves to a private address (DNS rebinding) is not recognised,
   * because extensions cannot see DNS answers; lib/netguard.js adds a network-layer rule for the same
   * address families so redirects cannot slip past, with the same DNS limit.
   */
  function parseIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    return o.every((n) => n <= 255) ? o : null;
  }
  // Returns eight 16-bit groups, or null when it is not a valid IPv6 literal.
  function parseIPv6(host) {
    let h = host.toLowerCase();
    if (!/^[0-9a-f:.]+$/.test(h) || !h.includes(':')) return null;
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (dotted) {
      const v4 = parseIPv4(dotted[1]);
      if (!v4) return null;
      h = h.slice(0, dotted.index) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
    }
    const halves = h.split('::');
    if (halves.length > 2) return null;
    const side = (t) => (t === '' ? [] : t.split(':'));
    const head = side(halves[0]);
    const tail = halves.length === 2 ? side(halves[1]) : [];
    const fill = 8 - head.length - tail.length;
    if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
    const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  }
  // Non-routable or special-use IPv4 space: loopback, private, link-local, CGNAT, documentation,
  // benchmarking, multicast, reserved, broadcast and "this network".
  function v4IsPrivate([a, b, c]) {
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  function isPrivateHost(host) {
    // A trailing dot is the same name ('localhost.' reaches the loopback host).
    host = (host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa'))
      return true;
    const v4 = parseIPv4(host);
    if (v4) return v4IsPrivate(v4);
    if (host.includes(':')) {
      const g = parseIPv6(host);
      if (!g) return true; // something that looks like IPv6 but does not parse: refuse
      const embedded = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
      if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4IsPrivate(embedded(g[6], g[7])); // ::ffff:a.b.c.d
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0) return true; // deprecated IPv4-compatible ::a.b.c.d
      if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4IsPrivate(embedded(g[6], g[7])); // NAT64
      if (g[0] === 0x2002) return v4IsPrivate(embedded(g[1], g[2])); // 6to4
      if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
      if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
      if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
      if ((g[0] & 0xff00) === 0xff00) return true; // multicast
      if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
      return false;
    }
    return false;
  }
  // HTTP-speaking local services that are dangerous to read from a hostile page. Browsers already
  // refuse many raw-protocol ports (ERR_UNSAFE_PORT); these are the ones that answer plain HTTP.
  const SENSITIVE_LOCAL_PORTS = new Set(['2375', '2376', '2379', '2380', '4243', '5984', '6443', '8200', '8500', '9200', '9300', '10250', '15672', '28017']);
  /*
   * True when fetching `url` from a page at `pageUrl` would reach a private/loopback host the page
   * itself isn't on. The page's own host is allowed on its own port and on ordinary dev ports, but not
   * on the well-known ports of local admin services (container engine, key-value and search stores,
   * cluster APIs): a port number alone does not make a destination unsafe, so this is a short,
   * documented list and not a blanket rule.
   */
  function blocksPrivate(url, pageUrl) {
    try {
      const t = new URL(url),
        p = new URL(pageUrl);
      if (!isPrivateHost(t.hostname)) return false;
      if (t.hostname.toLowerCase().replace(/\.$/, '') !== p.hostname.toLowerCase().replace(/\.$/, '')) return true;
      const port = t.port || (t.protocol === 'https:' ? '443' : '80');
      const pagePort = p.port || (p.protocol === 'https:' ? '443' : '80');
      return port !== pagePort && SENSITIVE_LOCAL_PORTS.has(port);
    } catch (_) {
      return true;
    }
  }

  /*
   * Messages the panel accepts over chrome.runtime. Only the extension's own contexts can reach
   * onMessage (there is no externally_connectable), but a content script lives next to untrusted
   * page data, so what it may say is still limited and every field is checked:
   *   df:selected        from a content script in the tab the panel is working on; handle "h<number>"
   *   df:pick-cancelled  from a content script in that tab
   *   df:command         from the service worker only (it has no tab); a fixed list of commands
   * Returns a normalised message, or null when the message must be ignored.
   */
  const PANEL_COMMANDS = ['pick', 'inspect-context'];
  function checkPanelMessage(m, sender, ownId, activeTabId) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
    if (!sender || sender.id !== ownId) return null;
    const fromTab = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    if (m.type === 'df:selected') {
      if (fromTab === null || fromTab !== activeTabId) return null;
      return typeof m.handle === 'string' && /^h\d{1,9}$/.test(m.handle) ? { type: m.type, handle: m.handle } : null;
    }
    if (m.type === 'df:pick-cancelled') return fromTab !== null && fromTab === activeTabId ? { type: m.type } : null;
    if (m.type === 'df:command') return fromTab === null && PANEL_COMMANDS.includes(m.command) ? { type: m.type, command: m.command } : null;
    return null;
  }

  /* Workflow steps come from pasted JSON, so they are checked before they are stored or run. */
  const STEP_ACTIONS = ['click', 'type', 'extract', 'waitFor', 'wait', 'navigate'];
  function webUrl(raw, base) {
    try {
      const u = new URL(String(raw), base);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch (_) {
      return null;
    }
  }
  function workflowProblems(steps) {
    const problems = [];
    if (!Array.isArray(steps)) return ['A workflow must be a list of steps.'];
    if (steps.length > 500) problems.push('A workflow can have at most 500 steps.');
    steps.slice(0, 500).forEach((s, i) => {
      const n = 'Step ' + (i + 1);
      if (!s || typeof s !== 'object') return problems.push(n + ' is not an object.');
      if (!STEP_ACTIONS.includes(s.action))
        return problems.push(n + ' has an unknown action: ' + String(s.action).slice(0, 30));
      if (s.action === 'navigate' && !webUrl(s.url, 'https://placeholder.invalid/'))
        problems.push(n + ': Navigate only accepts http and https addresses.');
    });
    return problems;
  }

  return {
    checkPanelMessage,
    webUrl,
    workflowProblems,
    isSensitiveKey,
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
