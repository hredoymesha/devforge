/*
 * Network capture, injected into the page's MAIN world on request.
 * It only sees fetch / XHR / WebSocket calls made after injection; earlier requests are
 * available as Performance entries (timing only, no headers or bodies).
 */
(() => {
  if (window.__dfNet) return;
  const LIMIT = 600,
    BODY_MAX = 200 * 1024;
  const log = [];
  let seq = 0;
  const push = (e) => {
    if (log.length >= LIMIT) log.shift();
    log.push(e);
  };
  const hdrObj = (h) => {
    const o = {};
    try {
      if (h && h.forEach) h.forEach((v, k) => (o[k] = v));
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
          o.push(k + '=' + (typeof v === 'string' ? v : '[File ' + v.name + ']'))
        );
        return o.join('&');
      }
      if (b instanceof Blob) return '[Blob ' + b.size + ' bytes]';
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b))
        return '[binary ' + b.byteLength + ' bytes]';
      return String(b).slice(0, 2000);
    } catch (_) {
      return '[unreadable]';
    }
  };
  const initiator = () => {
    try {
      return (new Error().stack || '')
        .split('\n')
        .slice(3, 7)
        .map((s) => s.trim())
        .join(' | ');
    } catch (_) {
      return '';
    }
  };
  const textual = (ct) => /json|text|xml|javascript|html|x-www-form|graphql/i.test(ct || '');

  /*
   Body capture is bounded: at most BODY_MAX bytes are read per response (then the stream is
   cancelled), a few bodies are read at a time with a capped backlog, and the total stored
   text has a budget with oldest-first eviction.
*/
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
    stored += text.length;
    if (stored > TOTAL_MAX) {
      for (const r of log) {
        if (stored <= TOTAL_MAX * 0.75) break;
        if (r.resBody && r !== rec) {
          stored -= r.resBody.length;
          r.resBody = '[evicted: capture memory budget reached]';
        }
      }
    }
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
    account(rec, new TextDecoder('utf-8').decode(buf));
    rec.resTruncated = over;
  }
  const of = window.fetch;
  window.fetch = function (input, init) {
    const id = ++seq,
      t0 = performance.now();
    const rec = {
      id,
      kind: 'fetch',
      t: Date.now(),
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
    try {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      rec.url = new URL(isReq ? input.url : String(input), document.baseURI).href;
      rec.method = ((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
      rec.reqHeaders = hdrObj((init && init.headers) || (isReq && input.headers));
      rec.reqBody = bodyStr(init && init.body);
    } catch (_) {}
    push(rec);
    return of.apply(this, arguments).then(
      (res) => {
        rec.status = res.status;
        rec.statusText = res.statusText;
        rec.resHeaders = hdrObj(res.headers);
        rec.type = res.type;
        rec.ms = Math.round(performance.now() - t0);
        const ct = res.headers.get('content-type');
        const len = +res.headers.get('content-length') || 0;
        if (res.type === 'opaque')
          rec.resBody = '[opaque response: cross-origin without CORS, body unreadable]';
        else if (!textual(ct)) rec.resBody = null;
        else if (len > SKIP_ABOVE)
          rec.resBody =
            '[body not captured: ' +
            len +
            ' bytes exceeds the ' +
            SKIP_ABOVE +
            ' byte capture limit]';
        else if (backlog >= MAX_BACKLOG) rec.resBody = '[body not captured: capture backlog full]';
        else {
          let clone;
          try {
            clone = res.clone();
          } catch (_) {
            clone = null;
          }
          if (clone) {
            backlog++;
            jobs.push(() => readLimited(clone, rec));
            pump();
          }
        }
        return res;
      },
      (err) => {
        rec.error = String((err && err.message) || err);
        rec.ms = Math.round(performance.now() - t0);
        throw err;
      }
    );
  };

  const XO = XMLHttpRequest.prototype.open,
    XS = XMLHttpRequest.prototype.send,
    XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__df = {
      id: ++seq,
      kind: 'xhr',
      t: Date.now(),
      method: String(m).toUpperCase(),
      url: (() => {
        try {
          return new URL(String(u), document.baseURI).href;
        } catch (_) {
          return String(u);
        }
      })(),
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
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__df) this.__df.reqHeaders[String(k).toLowerCase()] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const r = this.__df;
    if (r) {
      r.reqBody = bodyStr(body);
      const t0 = performance.now();
      push(r);
      this.addEventListener('loadend', () => {
        r.status = this.status;
        r.statusText = this.statusText;
        r.ms = Math.round(performance.now() - t0);
        const raw = this.getAllResponseHeaders();
        raw
          .trim()
          .split(/\r?\n/)
          .forEach((l) => {
            const i = l.indexOf(':');
            if (i > 0) r.resHeaders[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
          });
        try {
          const len = +this.getResponseHeader('content-length') || 0;
          if (len > SKIP_ABOVE)
            r.resBody =
              '[body not captured: ' +
              len +
              ' bytes exceeds the ' +
              SKIP_ABOVE +
              ' byte capture limit]';
          else if (this.responseType === '' || this.responseType === 'text') {
            const t = this.responseText;
            account(r, t.length > BODY_MAX ? t.slice(0, BODY_MAX) : t);
            r.resTruncated = t.length > BODY_MAX;
          } else if (this.responseType === 'json') {
            const t = JSON.stringify(this.response);
            account(r, t.slice(0, BODY_MAX));
            r.resTruncated = t.length > BODY_MAX;
          } else r.resBody = '[' + this.responseType + ' response]';
        } catch (_) {}
        if (this.status === 0) r.error = 'Request failed or was blocked (status 0)';
      });
    }
    return XS.apply(this, arguments);
  };

  const OW = window.WebSocket;
  if (OW) {
    window.WebSocket = function (url, protocols) {
      const ws = protocols !== undefined ? new OW(url, protocols) : new OW(url);
      const rec = {
        id: ++seq,
        kind: 'websocket',
        t: Date.now(),
        method: 'WS',
        url: String(url),
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
      });
      ws.addEventListener('message', (e) => {
        rec.received++;
        if (rec.frames.length < 30)
          rec.frames.push({
            dir: 'in',
            data: typeof e.data === 'string' ? e.data.slice(0, 500) : '[binary]',
          });
      });
      ws.addEventListener('error', () => {
        rec.error = 'WebSocket error';
      });
      ws.addEventListener('close', (e) => {
        rec.closed = { code: e.code, reason: e.reason };
      });
      const os = ws.send;
      ws.send = function (d) {
        rec.sent++;
        if (rec.frames.length < 30)
          rec.frames.push({
            dir: 'out',
            data: typeof d === 'string' ? d.slice(0, 500) : '[binary]',
          });
        return os.apply(this, arguments);
      };
      return ws;
    };
    window.WebSocket.prototype = OW.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => (window.WebSocket[k] = OW[k]));
  }
  window.__dfNet = {
    log,
    clear: () => {
      log.length = 0;
      stored = 0;
    },
    startedAt: Date.now(),
    note: 'Page scripts share this realm and can alter or spoof this log; treat it as observational, not tamper-proof.',
  };
})();
