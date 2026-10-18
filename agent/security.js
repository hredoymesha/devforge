/*
 * Page-side data collection for the Security tab.
 *
 * Reading: secFacts() reports what the page already exposes. Values from the page (cookie values,
 * storage values, URL parameter values) are never returned, only names and kinds.
 *
 * Requests: every request a scan makes goes through secRequest(), which enforces the scope no
 * matter what the panel asks for:
 *   - same origin as the page only (cross-origin and credential-bearing addresses are refused)
 *   - GET or HEAD only, no request body, no cookies, no custom headers
 *   - a request budget (hard ceiling below) and a minimum pause between requests
 *   - redirects are not followed, except for the page's own address (which is re-checked)
 *   - at most MAX_BYTES of a response are read, then the stream is cancelled
 *   - a scan can be cancelled at any time
 * Interpreting the data happens in lib/secscan.js and lib/secprobe.js.
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.secFacts) return;
  const { clip, safe } = DF.kit;

  const NAME_MAX = 100;
  const LIST_MAX = 200;
  const HARD_MAX_REQUESTS = 200; // keep in step with HARD_MAX_REQUESTS in lib/secscan.js
  const HARD_MIN_DELAY_MS = 100; // pause between requests whenever a scan sends more than 3
  const MAX_BYTES = 1536 * 1024;
  const TIMEOUT_MS = 10000;
  const INLINE_MAX = 150 * 1024;
  const INLINE_TOTAL = 400 * 1024;
  const HTML_MAX = 200 * 1024;

  // Query strings and fragments often carry tokens, so reported addresses never include them.
  const plainUrl = (raw) => {
    const u = safe(() => new URL(raw, document.baseURI));
    return u ? u.origin + u.pathname : clip(raw, 120);
  };
  const originOf = (raw) => safe(() => new URL(raw, document.baseURI).origin);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- reading the page ---------- */

  const SINKS = ['innerHTML', 'document.write', 'eval(', 'outerHTML', 'insertAdjacentHTML'];
  const CSRF_FIELD = /(csrf|xsrf|authenticity|_token|nonce|verification_?token|requestverification)/i;
  const COMMENT_WORDS = /\b(password|passwd|secret|api[ _-]?key|token|credential|admin|debug|internal)\b/gi;

  async function readCookies() {
    if (window.cookieStore && cookieStore.getAll) {
      try {
        const list = await cookieStore.getAll();
        return list.slice(0, LIST_MAX).map((c) => ({
          name: clip(c.name, NAME_MAX),
          secure: !!c.secure,
          sameSite: c.sameSite || null,
        }));
      } catch (_) {
        /* fall through to document.cookie */
      }
    }
    // document.cookie has no flags, so Secure is reported as unknown rather than guessed.
    return document.cookie
      .split(';')
      .map((p) => p.split('=')[0].trim())
      .filter(Boolean)
      .slice(0, LIST_MAX)
      .map((name) => ({ name: clip(name, NAME_MAX), secure: null, sameSite: null }));
  }

  const storageKeys = (area) => safe(() => Object.keys(area).slice(0, LIST_MAX).map((k) => clip(k, NAME_MAX)), []);

  // What kind of value a URL parameter holds, without revealing it.
  const valueKind = (v) => (!v ? 'empty' : /^(https?:)?\/\//i.test(v) ? 'url' : /^\d{1,12}$/.test(v) ? 'number' : 'text');

  function collectLinks() {
    const seen = new Set();
    const out = [];
    const add = (raw, sameOriginRaw) => {
      const u = safe(() => new URL(raw, document.baseURI));
      if (!u || !/^https?:$/.test(u.protocol)) return;
      const params = [...u.searchParams].slice(0, 12).map(([n, v]) => ({ n: clip(n, 40), k: valueKind(v) }));
      const key = u.origin + u.pathname + '?' + params.map((p) => p.n).join(',');
      if (seen.has(key) || out.length >= 400) return;
      seen.add(key);
      out.push({
        path: sameOriginRaw ? u.pathname : u.origin + u.pathname,
        sameOrigin: u.origin === location.origin,
        params,
        idPath: /\/\d{2,12}(\/|$)/.test(u.pathname),
      });
    };
    document.querySelectorAll('a[href]').forEach((a) => add(a.getAttribute('href'), true));
    document.querySelectorAll('form[action]').forEach((f) => add(f.getAttribute('action'), true));
    return out;
  }

  /*
   * Parameters of the current address whose value shows up again in the page, and where. Looked up
   * in the live DOM, where values are already decoded, so a value containing quotes is still found.
   * Only contexts that matter are reported: inside a script, in an event-handler or URL attribute
   * (active), or in any other attribute. A value that merely appears as visible text is normal.
   */
  function findReflections() {
    const out = [];
    const params = [...new URL(location.href).searchParams].filter(([, v]) => v.length >= 4 && !/^\d+$/.test(v)).slice(0, 10);
    if (!params.length) return out;
    const scripts = [...document.querySelectorAll('script:not([src])')].map((s) => s.textContent || '');
    const all = [...document.querySelectorAll('*')].slice(0, 5000);
    for (const [name, value] of params) {
      let context = null;
      if (scripts.some((t) => t.includes(value))) context = 'script';
      else {
        outer: for (const el of all) {
          for (const a of el.attributes) {
            if (!a.value.includes(value)) continue;
            context = /^(on|href$|src$|srcdoc$|formaction$|action$)/i.test(a.name) ? 'attribute-active' : 'attribute';
            break outer;
          }
        }
      }
      if (context) out.push({ name: clip(name, 40), context });
    }
    return out;
  }

  function suspiciousComments() {
    const found = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    for (let i = 0; i < 500 && walker.nextNode(); i++) {
      for (const m of (walker.currentNode.nodeValue || '').matchAll(COMMENT_WORDS)) found.push(m[1].toLowerCase());
    }
    return [...new Set(found)];
  }

  async function secFacts() {
    const https = location.protocol === 'https:';
    const html = document.documentElement.outerHTML.slice(0, HTML_MAX);

    const forms = [...document.forms].slice(0, LIST_MAX).map((f) => {
      const action = f.getAttribute('action');
      const target = safe(() => new URL(action || '', document.baseURI));
      const fieldNames = [...f.elements].map((e) => (e.name || '') + ' ' + (e.id || ''));
      const method = (f.getAttribute('method') || 'get').toLowerCase();
      const textInputs = f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button])').length;
      return {
        action: target ? target.origin + target.pathname : '',
        method,
        hasPassword: !!f.querySelector('input[type=password]'),
        insecureAction: !!target && target.protocol === 'http:' && https,
        crossOrigin: !!target && target.origin !== location.origin,
        hasCsrfToken: fieldNames.some((n) => CSRF_FIELD.test(n)) || !!document.querySelector('meta[name*="csrf" i], meta[name*="xsrf" i]'),
        hasFile: !!f.querySelector('input[type=file]'),
        isSearch: f.getAttribute('role') === 'search' || !!f.querySelector('input[type=search]') || (method === 'get' && textInputs === 1),
      };
    });

    const scriptEls = [...document.querySelectorAll('script[src]')].slice(0, LIST_MAX);
    const scripts = scriptEls.map((s) => {
      const origin = originOf(s.src);
      return {
        src: plainUrl(s.src),
        host: safe(() => new URL(s.src).host, ''),
        thirdParty: !!origin && origin !== location.origin,
        integrity: !!s.integrity,
      };
    });
    // Full addresses of same-origin scripts, used only to fetch them again. They are not reported.
    const scriptFetch = scriptEls
      .filter((s) => originOf(s.src) === location.origin)
      .map((s) => s.src)
      .slice(0, 60);

    const iframes = [...document.querySelectorAll('iframe[src]')].slice(0, LIST_MAX).map((f) => ({
      src: plainUrl(f.src),
      thirdParty: originOf(f.src) !== location.origin,
      sandbox: f.hasAttribute('sandbox'),
    }));

    const mixed = https
      ? performance
          .getEntriesByType('resource')
          .filter((r) => r.name.startsWith('http://'))
          .slice(0, LIST_MAX)
          .map((r) => ({ type: r.initiatorType || 'other', url: plainUrl(r.name) }))
      : [];

    let inlineHandlers = 0;
    let javascriptUrls = 0;
    for (const el of document.querySelectorAll('*')) {
      if (DF.kit.isOwn(el)) continue;
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) inlineHandlers++;
        else if (/^(href|src|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) javascriptUrls++;
      }
    }

    const sinks = new Set();
    const inlineScripts = [];
    let total = 0;
    document.querySelectorAll('script:not([src])').forEach((s, i) => {
      const code = s.textContent || '';
      for (const k of SINKS) if (code.includes(k)) sinks.add(k);
      if (code.length && total < INLINE_TOTAL) {
        const text = code.slice(0, INLINE_MAX);
        total += text.length;
        inlineScripts.push({ label: 'inline script #' + (i + 1), text });
      }
    });

    const generator = document.querySelector('meta[name="generator" i]');
    return {
      protocol: location.protocol,
      origin: location.origin,
      pagePath: location.pathname,
      forms,
      scripts,
      scriptFetch,
      iframes,
      mixed,
      inlineHandlers,
      javascriptUrls,
      sinks: [...sinks],
      inlineScripts,
      html,
      links: collectLinks(),
      reflected: findReflections(),
      suspiciousComments: suspiciousComments(),
      generator: generator ? clip(generator.content, 80) : '',
      cspMeta: !!document.querySelector('meta[http-equiv="Content-Security-Policy" i]'),
      cookies: await readCookies(),
      localKeys: storageKeys(window.localStorage),
      sessionKeys: storageKeys(window.sessionStorage),
    };
  }

  /* ---------- the request gate ---------- */

  const PROBE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,198}$/;
  const HEADER_NAMES = [
    'content-security-policy',
    'content-security-policy-report-only',
    'strict-transport-security',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'cache-control',
    'server',
    'x-powered-by',
    'x-aspnet-version',
    'content-type',
  ];

  let scan = null;

  function secBegin(budget) {
    if (scan && !scan.done && scan.current) scan.current.abort();
    const max = Math.min(Math.max(parseInt(budget && budget.maxRequests, 10) || 3, 1), HARD_MAX_REQUESTS);
    let delay = Math.max(parseInt(budget && budget.delayMs, 10) || 0, 0);
    if (max > 3 && delay < HARD_MIN_DELAY_MS) delay = HARD_MIN_DELAY_MS;
    scan = {
      id: Math.random().toString(36).slice(2),
      max,
      delay,
      used: 0,
      last: 0,
      log: [],
      cancelled: false,
      done: false,
      current: null, // controller of the request in flight, so cancelling stops it at once
    };
    return { id: scan.id, max, delay };
  }

  const secStatus = () => (scan ? { used: scan.used, max: scan.max, cancelled: scan.cancelled, done: scan.done } : null);

  function secCancel() {
    if (scan) {
      scan.cancelled = true;
      if (scan.current) scan.current.abort();
    }
    return secStatus();
  }

  function secEnd() {
    if (!scan) return { log: [] };
    scan.done = true;
    return { log: scan.log, used: scan.used, cancelled: scan.cancelled };
  }

  // Resolves what a request may target. Throws with a reason when it is out of scope.
  function scopedUrl(spec) {
    let u;
    if (spec.path != null) {
      if (!spec.allowQuery && !PROBE_PATH.test(spec.path)) throw new Error('not a plain path');
      if (spec.path.includes('..')) throw new Error('dot segments are not allowed');
      u = new URL(spec.path, location.origin);
    } else {
      u = new URL(spec.url, location.href);
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https');
    if (u.origin !== location.origin) throw new Error('outside the scanned origin');
    if (u.username || u.password) throw new Error('addresses with credentials are refused');
    return u;
  }

  async function readLimited(res, limit) {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return { text: '', bytes: 0 };
    const chunks = [];
    let n = 0;
    try {
      while (n < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
      }
    } finally {
      try {
        await reader.cancel();
      } catch (_) {
        /* the rest of the body is not needed */
      }
    }
    const buf = new Uint8Array(Math.min(n, limit));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, buf.length - off);
      if (take <= 0) break;
      buf.set(c.subarray(0, take), off);
      off += take;
    }
    return { text: new TextDecoder('utf-8').decode(buf), bytes: n };
  }

  /*
   * spec: { id, path | url, method: 'GET' | 'HEAD', maxBytes, purpose, allowQuery, cache,
   *         follow (page address only), headers: [names to return] }
   * Returns { ok, status, type, text?, bytes?, headers?, redirected? } or { ok: false, blocked, error }.
   */
  async function secRequest(spec) {
    if (!scan || scan.id !== spec.id) return { ok: false, blocked: 'no active scan' };
    if (scan.cancelled) return { ok: false, blocked: 'cancelled' };
    if (scan.used >= scan.max) return { ok: false, blocked: 'request limit reached' };
    const method = String(spec.method || 'GET').toUpperCase();
    const entry = { method, path: '', purpose: clip(spec.purpose || '', 60) };
    let u;
    try {
      if (method !== 'GET' && method !== 'HEAD') throw new Error('only GET and HEAD are allowed');
      u = scopedUrl(spec);
      entry.path = u.pathname + (spec.allowQuery && u.search ? '?…' : '');
    } catch (e) {
      entry.note = 'refused: ' + e.message;
      scan.log.push({ ...entry, path: clip(String(spec.path || spec.url || ''), 80).split('?')[0] });
      return { ok: false, blocked: e.message };
    }
    const wait = scan.delay - (Date.now() - scan.last);
    if (wait > 0) await sleep(wait);
    if (scan.cancelled) return { ok: false, blocked: 'cancelled' };
    scan.used++;
    scan.last = Date.now();

    const ctl = new AbortController();
    scan.current = ctl;
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(u.href, {
        method,
        credentials: 'omit',
        cache: spec.cache || 'no-store',
        redirect: spec.follow ? 'follow' : 'manual',
        signal: ctl.signal,
      });
      if (res.type === 'opaqueredirect') {
        entry.status = 'redirect (not followed)';
        scan.log.push(entry);
        return { ok: true, status: 0, redirected: true, type: '' };
      }
      if (new URL(res.url).origin !== location.origin) {
        entry.note = 'redirected off the origin: response discarded';
        scan.log.push(entry);
        if (res.body) res.body.cancel().catch(() => {});
        return { ok: false, blocked: 'redirected to another origin' };
      }
      entry.status = res.status;
      scan.log.push(entry);
      const out = {
        ok: true,
        status: res.status,
        type: res.headers.get('content-type') || '',
        redirected: false,
        wwwAuthenticate: res.headers.get('www-authenticate') || '',
      };
      if (spec.headers && spec.headers.length) {
        out.headers = {};
        for (const name of spec.headers) out.headers[name] = res.headers.get(name);
      }
      if (method === 'GET' && spec.maxBytes > 0) {
        const r = await readLimited(res, Math.min(spec.maxBytes, MAX_BYTES));
        out.text = r.text;
        out.bytes = r.bytes;
      } else if (res.body) {
        res.body.cancel().catch(() => {});
      }
      return out;
    } catch (e) {
      entry.note = e.name === 'AbortError' ? (scan.cancelled ? 'cancelled' : 'timed out') : e.message;
      scan.log.push(entry);
      return { ok: false, error: entry.note };
    } finally {
      clearTimeout(timer);
      if (scan && scan.current === ctl) scan.current = null;
    }
  }

  DF.extend({ secFacts, secBegin, secRequest, secStatus, secCancel, secEnd, secHeaderNames: () => HEADER_NAMES });
})();
