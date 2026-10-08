/*
 * Network capture and interception, injected into the page's MAIN world on request (or registered
 * to run at document_start when "capture from page start" is on).
 *
 * It sees fetch / XHR / WebSocket / EventSource / sendBeacon calls made by page scripts after it
 * runs. Requests the browser makes itself (images, stylesheets, navigations) never pass through
 * here; the panel shows those from the Performance API as timing-only rows.
 *
 * Interception rules are evaluated per request, in order:
 *   delay    adds latency (delays from several rules add up)
 *   headers  sets request headers
 *   block    fails the request like a network error           (terminal)
 *   mock     answers with a canned response, nothing is sent   (terminal)
 *   redirect sends the request to another URL                  (terminal)
 */
(() => {
  if (window.__dfNet) return;
  const LIMIT = 1000,
    BODY_MAX = 200 * 1024,
    FRAME_MAX = 200;
  const log = [];
  const byId = new Map();
  let seq = 0,
    rev = 0;
  const now = () => Math.round(performance.now());
  const push = (e) => {
    if (log.length >= LIMIT) byId.delete(log.shift().id);
    log.push(e);
    byId.set(e.id, e);
    touch(e);
  };
  // Every change bumps a revision so the panel can poll for "what changed since rev N".
  const touch = (e) => {
    e.rev = ++rev;
  };
  const hdrObj = (h) => {
    const o = {};
    try {
      if (h && h.forEach) h.forEach((v, k) => (o[String(k).toLowerCase()] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[String(k).toLowerCase()] = v));
      else if (h) Object.keys(h).forEach((k) => (o[k.toLowerCase()] = h[k]));
    } catch (_) {}
    return o;
  };
  const bodyStr = (b) => {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return b.slice(0, BODY_MAX);
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof FormData) {
        const o = [];
        b.forEach((v, k) =>
          o.push(
            k + '=' + (typeof v === 'string' ? v : '[File ' + v.name + ', ' + v.size + ' bytes]')
          )
        );
        return o.join('&');
      }
      if (b instanceof Blob) return '[Blob ' + b.size + ' bytes, ' + (b.type || 'no type') + ']';
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b))
        return '[binary ' + b.byteLength + ' bytes]';
      if (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) return '[stream]';
      return String(b).slice(0, 2000);
    } catch (_) {
      return '[unreadable]';
    }
  };
  const initiator = () => {
    try {
      // Frames 0-2 are Error, initiator() and the wrapper itself.
      return (new Error().stack || '')
        .split('\n')
        .slice(3, 8)
        .map((s) => s.trim())
        .join(' | ');
    } catch (_) {
      return '';
    }
  };
  const textual = (ct) => /json|text|xml|javascript|html|x-www-form|graphql|csv/i.test(ct || '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- interception rules ---------- */
  let rules = [];
  const hits = {};
  function compile(r) {
    let test = () => false;
    try {
      if (r.regex) {
        const re = new RegExp(r.match, 'i');
        test = (u) => re.test(u);
      } else if (r.match) {
        const needle = String(r.match).toLowerCase();
        test = (u) => u.toLowerCase().includes(needle);
      } else test = () => true;
    } catch (_) {
      test = () => false; // an invalid regex disables the rule rather than throwing in page code
    }
    return { ...r, test };
  }
  function setRules(list) {
    rules = (Array.isArray(list) ? list : []).filter((r) => r && r.enabled !== false).map(compile);
    return { active: rules.length };
  }
  function plan(kind, method, url) {
    const p = { delay: 0, headers: null, terminal: null, matched: [] };
    for (const r of rules) {
      if (r.kinds && r.kinds !== 'any' && r.kinds !== kind) continue;
      if (r.method && r.method !== '*' && r.method.toUpperCase() !== method) continue;
      if (!r.test(url)) continue;
      hits[r.id] = (hits[r.id] || 0) + 1;
      p.matched.push({ id: r.id, action: r.action });
      if (r.action === 'delay') p.delay += Math.min(Math.max(+r.delay || 0, 0), 60000);
      else if (r.action === 'headers') p.headers = { ...(p.headers || {}), ...(r.headers || {}) };
      else if (!p.terminal) p.terminal = r;
    }
    return p;
  }
  const NULL_BODY = new Set([101, 204, 205, 304]);
  function mockParts(rule) {
    const status = Math.min(Math.max(parseInt(rule.status, 10) || 200, 200), 599);
    const headers = {
      'content-type': rule.contentType || 'application/json',
      ...(rule.headers || {}),
    };
    headers['x-devforge-mock'] = String(rule.id || '1');
    return { status, headers, body: NULL_BODY.has(status) ? null : String(rule.body ?? '') };
  }
  const resolve = (u, base) => {
    try {
      return new URL(u, base).href;
    } catch (_) {
      return base;
    }
  };

  /* ---------- bounded body reading ---------- */
  const MAX_ACTIVE = 3,
    MAX_BACKLOG = 12,
    SKIP_ABOVE = 2 * 1024 * 1024,
    TOTAL_MAX = 16 * 1024 * 1024;
  let active = 0,
    backlog = 0,
    stored = 0;
  const jobs = [];
  const account = (rec, text) => {
    rec.resBody = text;
    rec.size = rec.size || text.length;
    stored += text.length;
    if (stored > TOTAL_MAX) {
      for (const r of log) {
        if (stored <= TOTAL_MAX * 0.75) break;
        if (r.resBody && r !== rec && r.resBody[0] !== '[') {
          stored -= r.resBody.length;
          r.resBody = '[evicted: capture memory budget reached]';
          touch(r);
        }
      }
    }
    touch(rec);
  };
  const pump = () => {
    while (active < MAX_ACTIVE && jobs.length) {
      const j = jobs.shift();
      backlog--;
      active++;
      j()
        .catch(() => {})
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  async function readLimited(clone, rec) {
    const reader = clone.body && clone.body.getReader ? clone.body.getReader() : null;
    if (!reader) {
      account(rec, '');
      return;
    }
    const chunks = [];
    let n = 0,
      over = false;
    try {
      while (n <= BODY_MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
      }
      if (n > BODY_MAX) over = true;
    } finally {
      try {
        await reader.cancel();
      } catch (_) {}
    }
    const buf = new Uint8Array(Math.min(n, BODY_MAX));
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, buf.length - off);
      if (take <= 0) break;
      buf.set(c.subarray(0, take), off);
      off += take;
    }
    rec.resTruncated = over;
    account(rec, new TextDecoder('utf-8').decode(buf));
  }
  function captureResponse(rec, res) {
    const ct = res.headers.get('content-type');
    const len = +res.headers.get('content-length') || 0;
    if (len) rec.size = len;
    if (res.type === 'opaque' || res.type === 'opaqueredirect')
      rec.resBody = '[opaque response: cross-origin without CORS, body unreadable]';
    else if (!textual(ct)) rec.resBody = null;
    else if (len > SKIP_ABOVE)
      rec.resBody =
        '[body not captured: ' + len + ' bytes exceeds the ' + SKIP_ABOVE + ' byte limit]';
    else if (backlog >= MAX_BACKLOG) rec.resBody = '[body not captured: capture backlog full]';
    else {
      let clone = null;
      try {
        clone = res.clone();
      } catch (_) {}
      if (clone) {
        backlog++;
        jobs.push(() => readLimited(clone, rec));
        pump();
      }
    }
  }

  /* ---------- fetch ---------- */
  const of = window.fetch;
  window.fetch = function (input, init) {
    const id = ++seq,
      t0 = performance.now();
    const rec = {
      id,
      kind: 'fetch',
      t: Date.now(),
      start: now(),
      method: 'GET',
      url: '',
      reqHeaders: {},
      reqBody: null,
      status: null,
      resHeaders: {},
      resBody: null,
      ms: null,
      error: null,
      initiator: initiator(),
    };
    let isReq = false;
    try {
      isReq = typeof Request !== 'undefined' && input instanceof Request;
      rec.url = new URL(isReq ? input.url : String(input), document.baseURI).href;
      rec.method = ((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
      rec.reqHeaders = { ...hdrObj(isReq && input.headers), ...hdrObj(init && init.headers) };
      rec.reqBody = bodyStr(init && init.body);
      if (rec.reqBody == null && isReq && input.method !== 'GET' && input.method !== 'HEAD')
        rec.reqBody = '[body inside Request object: not readable without consuming it]';
    } catch (_) {}
    push(rec);
    const p = plan('fetch', rec.method, rec.url);
    if (p.matched.length) rec.rules = p.matched;
    const self = this;
    const finish = (res) => {
      rec.status = res.status;
      rec.statusText = res.statusText;
      rec.resHeaders = hdrObj(res.headers);
      rec.type = res.type;
      rec.redirected = res.redirected || undefined;
      rec.ms = Math.round(performance.now() - t0);
      touch(rec);
      captureResponse(rec, res);
      return res;
    };
    const fail = (err) => {
      rec.error = String((err && err.message) || err);
      rec.aborted = !!(err && err.name === 'AbortError') || undefined;
      rec.ms = Math.round(performance.now() - t0);
      touch(rec);
      throw err;
    };
    if (!p.matched.length) return of.apply(self, arguments).then(finish, fail);

    const args = arguments;
    return (async () => {
      if (p.delay) await sleep(p.delay);
      const term = p.terminal;
      if (term && term.action === 'block') {
        rec.blocked = true;
        return fail(new TypeError('Failed to fetch (blocked by a DevForge rule)'));
      }
      if (term && term.action === 'mock') {
        const m = mockParts(term);
        rec.mocked = true;
        const res = new Response(m.body, { status: m.status, headers: m.headers });
        rec.status = m.status;
        rec.resHeaders = m.headers;
        rec.resBody = m.body;
        rec.size = m.body ? m.body.length : 0;
        rec.ms = Math.round(performance.now() - t0);
        touch(rec);
        return res;
      }
      let callArgs = args;
      if (p.headers || (term && term.action === 'redirect')) {
        const base = new Request(input, init);
        const url = term && term.action === 'redirect' ? resolve(term.redirect, rec.url) : base.url;
        const next = new Request(url, base);
        for (const [k, v] of Object.entries(p.headers || {})) {
          try {
            next.headers.set(k, v);
            rec.reqHeaders[k.toLowerCase()] = v;
          } catch (_) {
            /* forbidden header names (Cookie, Host, ...) are silently refused by the browser */
          }
        }
        if (url !== rec.url) rec.redirectedTo = url;
        callArgs = [next];
        touch(rec);
      }
      return of.apply(self, callArgs).then(finish, fail);
    })();
  };

  /* ---------- XMLHttpRequest ---------- */
  const XP = XMLHttpRequest.prototype;
  const XO = XP.open,
    XS = XP.send,
    XH = XP.setRequestHeader;
  const FAKED = [
    'readyState',
    'status',
    'statusText',
    'responseText',
    'response',
    'responseURL',
    'getAllResponseHeaders',
    'getResponseHeader',
  ];
  XP.open = function (m, u, async) {
    // A reused XHR that was mocked last time still carries the fake own properties; drop them so
    // the native getters show through again.
    if (this.__dfFaked) {
      FAKED.forEach((k) => delete this[k]);
      this.__dfFaked = false;
    }
    let url;
    try {
      url = new URL(String(u), document.baseURI).href;
    } catch (_) {
      url = String(u);
    }
    this.__df = {
      id: ++seq,
      kind: 'xhr',
      t: Date.now(),
      start: null,
      method: String(m).toUpperCase(),
      url,
      async: async !== false,
      reqHeaders: {},
      reqBody: null,
      status: null,
      resHeaders: {},
      resBody: null,
      ms: null,
      error: null,
      initiator: initiator(),
    };
    return XO.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__df) this.__df.reqHeaders[String(k).toLowerCase()] = v;
    return XH.apply(this, arguments);
  };
  // Answers an XHR without touching the network: own-property getters shadow the native ones.
  function fakeXhr(xhr, r, { status, headers, body, error }) {
    const def = (k, val) => Object.defineProperty(xhr, k, { configurable: true, get: () => val });
    const text = body == null ? '' : body;
    const rt = xhr.responseType;
    let response = text;
    if (rt === 'json') {
      try {
        response = JSON.parse(text);
      } catch (_) {
        response = null;
      }
    } else if (rt && rt !== 'text') response = null;
    def('readyState', 4);
    def('status', error ? 0 : status);
    def('statusText', error ? '' : 'OK (DevForge mock)');
    def('responseText', text);
    def('response', response);
    def('responseURL', r.url);
    const hdrs = headers || {};
    xhr.getAllResponseHeaders = () =>
      Object.entries(hdrs)
        .map(([k, v]) => k + ': ' + v)
        .join('\r\n');
    xhr.getResponseHeader = (k) => hdrs[String(k).toLowerCase()] ?? null;
    xhr.__dfFaked = true;
    r.status = error ? 0 : status;
    r.resHeaders = hdrs;
    r.resBody = error ? null : text;
    r.size = text.length;
    r.ms = Math.round(performance.now() - r._t0);
    if (error) {
      r.error = 'Blocked by a DevForge rule';
      r.blocked = true;
    }
    touch(r);
    const fire = (type) =>
      xhr.dispatchEvent(
        type === 'readystatechange'
          ? new Event(type)
          : new ProgressEvent(type, {
              lengthComputable: true,
              loaded: text.length,
              total: text.length,
            })
      );
    setTimeout(() => {
      fire('readystatechange');
      fire(error ? 'error' : 'load');
      fire('loadend');
    }, 0);
  }
  XP.send = function (body) {
    const r = this.__df;
    if (!r) return XS.apply(this, arguments);
    r.reqBody = bodyStr(body);
    r.start = now();
    r._t0 = performance.now();
    push(r);
    const p = plan('xhr', r.method, r.url);
    if (p.matched.length) r.rules = p.matched;
    const xhr = this;
    const real = () => {
      const term = p.terminal;
      if (term && term.action === 'block') return fakeXhr(xhr, r, { error: true });
      if (term && term.action === 'mock') {
        r.mocked = true;
        const m = mockParts(term);
        return fakeXhr(xhr, r, { status: m.status, headers: m.headers, body: m.body });
      }
      if (term && term.action === 'redirect') {
        // Re-opening drops request headers, so replay the ones recorded so far.
        const url = resolve(term.redirect, r.url);
        const saved = { ...r.reqHeaders };
        XO.call(xhr, r.method, url, r.async);
        for (const [k, v] of Object.entries(saved)) XH.call(xhr, k, v);
        r.redirectedTo = url;
      }
      for (const [k, v] of Object.entries(p.headers || {})) {
        try {
          XH.call(xhr, k, v);
          r.reqHeaders[k.toLowerCase()] = v;
        } catch (_) {}
      }
      // One listener per XHR object, reporting into whichever request is current. Adding one per
      // send() would make a reused XHR write later responses into earlier records.
      xhr.__dfActive = r;
      if (!xhr.__dfHooked) {
        xhr.__dfHooked = true;
        xhr.addEventListener('loadend', () => xhrDone(xhr));
      }
      return XS.call(xhr, body);
    };
    // Synchronous XHR cannot be delayed without blocking the page, so the delay is skipped there.
    if (p.delay && r.async) {
      setTimeout(real, p.delay);
      return undefined;
    }
    return real();
  };
  function xhrDone(xhr) {
    const r = xhr.__dfActive;
    if (!r || xhr.__dfFaked) return;
    xhr.__dfActive = null;
    r.status = xhr.status;
    r.statusText = xhr.statusText;
    r.ms = Math.round(performance.now() - r._t0);
    (xhr.getAllResponseHeaders() || '')
      .trim()
      .split(/\r?\n/)
      .forEach((l) => {
        const i = l.indexOf(':');
        if (i > 0) r.resHeaders[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      });
    try {
      const len = +xhr.getResponseHeader('content-length') || 0;
      if (len) r.size = len;
      if (len > SKIP_ABOVE)
        r.resBody =
          '[body not captured: ' + len + ' bytes exceeds the ' + SKIP_ABOVE + ' byte limit]';
      else if (xhr.responseType === '' || xhr.responseType === 'text') {
        const t = xhr.responseText;
        r.resTruncated = t.length > BODY_MAX;
        account(r, t.length > BODY_MAX ? t.slice(0, BODY_MAX) : t);
      } else if (xhr.responseType === 'json') {
        const t = JSON.stringify(xhr.response);
        r.resTruncated = t.length > BODY_MAX;
        account(r, t.slice(0, BODY_MAX));
      } else r.resBody = '[' + xhr.responseType + ' response]';
    } catch (_) {
      /* responseText throws for some responseTypes; the headers above are still useful */
    }
    if (xhr.status === 0 && !r.error)
      r.error = 'Request failed, was aborted or was blocked (status 0)';
    touch(r);
  }

  /* ---------- WebSocket ---------- */
  const OW = window.WebSocket;
  if (OW) {
    const frame = (rec, dir, d) => {
      if (dir === 'in') rec.received++;
      else rec.sent++;
      const size = typeof d === 'string' ? d.length : (d && (d.byteLength ?? d.size)) || 0;
      rec.bytes = (rec.bytes || 0) + size;
      if (rec.frames.length >= FRAME_MAX) rec.frames.shift();
      rec.frames.push({
        dir,
        t: now() - rec.start,
        size,
        data: typeof d === 'string' ? d.slice(0, 2000) : '[binary ' + size + ' bytes]',
      });
      touch(rec);
    };
    window.WebSocket = function (url, protocols) {
      const ws = protocols !== undefined ? new OW(url, protocols) : new OW(url);
      const rec = {
        id: ++seq,
        kind: 'websocket',
        t: Date.now(),
        start: now(),
        method: 'WS',
        url: String(ws.url || url),
        status: null,
        sent: 0,
        received: 0,
        frames: [],
        error: null,
        initiator: initiator(),
      };
      push(rec);
      ws.addEventListener('open', () => {
        rec.status = 101;
        rec.protocol = ws.protocol || undefined;
        rec.ms = now() - rec.start;
        touch(rec);
      });
      ws.addEventListener('message', (e) => frame(rec, 'in', e.data));
      ws.addEventListener('error', () => {
        rec.error = 'WebSocket error';
        touch(rec);
      });
      ws.addEventListener('close', (e) => {
        rec.closed = { code: e.code, reason: e.reason, clean: e.wasClean };
        touch(rec);
      });
      const os = ws.send;
      ws.send = function (d) {
        frame(rec, 'out', d);
        return os.apply(this, arguments);
      };
      return ws;
    };
    window.WebSocket.prototype = OW.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => (window.WebSocket[k] = OW[k]));
  }

  /* ---------- EventSource ---------- */
  const OE = window.EventSource;
  if (OE) {
    window.EventSource = function (url, cfg) {
      const es = new OE(url, cfg);
      const rec = {
        id: ++seq,
        kind: 'sse',
        t: Date.now(),
        start: now(),
        method: 'GET',
        url: es.url,
        status: null,
        received: 0,
        frames: [],
        error: null,
        initiator: initiator(),
      };
      push(rec);
      es.addEventListener('open', () => {
        rec.status = 200;
        touch(rec);
      });
      es.addEventListener('message', (e) => {
        rec.received++;
        if (rec.frames.length >= FRAME_MAX) rec.frames.shift();
        rec.frames.push({ dir: 'in', t: now() - rec.start, data: String(e.data).slice(0, 2000) });
        touch(rec);
      });
      es.addEventListener('error', () => {
        rec.error = es.readyState === 2 ? 'EventSource closed' : 'EventSource error (reconnecting)';
        touch(rec);
      });
      return es;
    };
    window.EventSource.prototype = OE.prototype;
    ['CONNECTING', 'OPEN', 'CLOSED'].forEach((k) => (window.EventSource[k] = OE[k]));
  }

  /* ---------- sendBeacon ---------- */
  if (navigator.sendBeacon) {
    const ob = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      const rec = {
        id: ++seq,
        kind: 'beacon',
        t: Date.now(),
        start: now(),
        method: 'POST',
        url: resolve(String(url), document.baseURI),
        reqBody: bodyStr(data),
        status: null,
        error: null,
        initiator: initiator(),
      };
      push(rec);
      const p = plan('beacon', 'POST', rec.url);
      if (p.matched.length) rec.rules = p.matched;
      if (p.terminal && p.terminal.action === 'block') {
        rec.blocked = true;
        rec.error = 'Blocked by a DevForge rule';
        touch(rec);
        return false;
      }
      const queued = ob.apply(this, arguments);
      rec.queued = queued;
      if (!queued) rec.error = 'Browser refused to queue the beacon';
      touch(rec);
      return queued;
    };
  }

  /* ---------- panel API ---------- */
  // Rows without bodies, for cheap polling. Bodies are fetched per request with get().
  const summary = (e) => {
    const { resBody, reqBody, frames, _t0, ...rest } = e;
    return {
      ...rest,
      reqBodySize: reqBody ? reqBody.length : 0,
      resBodySize: resBody ? resBody.length : 0,
      frameCount: frames ? frames.length : undefined,
    };
  };
  const startedAt = Date.now();
  window.__dfNet = {
    version: 2,
    log,
    startedAt,
    changes(sinceRev) {
      const out = [];
      for (const e of log) if (e.rev > (sinceRev || 0)) out.push(summary(e));
      return { rev, startedAt, ids: log.map((e) => e.id), entries: out, rules: rules.length };
    },
    get(id) {
      const e = byId.get(id);
      if (!e) return null;
      const { _t0, ...rest } = e;
      return JSON.parse(JSON.stringify(rest));
    },
    clear() {
      log.length = 0;
      byId.clear();
      stored = 0;
      rev++;
    },
    setRules,
    ruleHits: () => ({ ...hits }),
    note: 'Page scripts share this realm and can alter or spoof this log; treat it as observational, not tamper-proof.',
  };
})();
