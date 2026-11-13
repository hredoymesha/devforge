// What the panel reads back from chrome.storage and IndexedDB is checked here before anything uses it.
// A value that is missing, the wrong type, out of range or too large is replaced by the default (or
// the record is left out) and a short note says what was ignored, so a damaged profile, an old
// version or another extension's write cannot stop the panel from opening. Pure: no browser API.
//
// Settings carry a schema version. Version 1 is what 4.2.0 wrote (no version field); version 2 adds the
// field. Each migration turns version n into n + 1; add one when a setting changes shape.
const DFStored = (() => {
  const SETTINGS_VERSION = 2;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const text = (v, max) => typeof v === 'string' && v.length <= max;
  const int = (v, lo, hi) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
  const short = (v) => String(v).replace(/[^\w .:/-]/g, '?').slice(0, 40);

  const MIGRATIONS = {
    // 1 -> 2: same shape. The version is recorded so a later migration knows where it starts.
    1: (s) => s,
  };

  /* ---------- settings ---------- */

  // One entry per setting: returns the cleaned value, or undefined when the stored one is not usable.
  const SETTING_RULES = {
    theme: (v) => (['system', 'dark', 'light'].includes(v) ? v : undefined),
    lastTab: (v) => (text(v, 30) && /^[a-z][a-z0-9-]*$/.test(v) ? v : undefined),
    seenWelcome: (v) => (typeof v === 'boolean' ? v : undefined),
    onboarded: (v) => (typeof v === 'boolean' ? v : undefined),
    followRedirects: (v) => (typeof v === 'boolean' ? v : undefined),
    allowAllSites: (v) => (typeof v === 'boolean' ? v : undefined),
    autoSaveScans: (v) => (typeof v === 'boolean' ? v : undefined),
    tempCleanup: (v) => (['off', 'close', 'daily'].includes(v) ? v : undefined),
    scanRetention: (v) => int(v, 0, 500),
    perfHistoryLimit: (v) => int(v, 2, 200),
    captureBodyKB: (v) => int(v, 1, 5000),
    captureTotalMB: (v) => int(v, 1, 256),
    captureEntries: (v) => int(v, 10, 20000),
    shortcuts: (v) => {
      if (!isObj(v)) return undefined;
      const out = {};
      for (const [k, combo] of Object.entries(v).slice(0, 300)) {
        if (/^[A-Za-z0-9-]{1,60}$/.test(k) && k !== '__proto__' && text(combo, 40)) out[k] = combo;
      }
      return out;
    },
    siteAllowlist: (v) => {
      if (!Array.isArray(v)) return undefined;
      const out = [];
      for (const o of v.slice(0, 500)) {
        if (typeof o !== 'string' || o.length > 300) continue;
        try {
          const u = new URL(o);
          if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o) out.push(o);
        } catch (_) {
          /* not an address */
        }
      }
      return [...new Set(out)];
    },
  };

  // raw: what chrome.storage returned (anything). defaults: the panel's default settings.
  // Returns { value, ignored: [text], from, migrated }.
  function settings(raw, defaults) {
    const ignored = [];
    const value = { ...defaults };
    let from = 1;
    if (raw == null) return { value: { ...value, schemaVersion: SETTINGS_VERSION }, ignored, from: SETTINGS_VERSION, migrated: false };
    if (!isObj(raw)) {
      ignored.push('The saved settings were not readable, so the defaults are used.');
      return { value: { ...value, schemaVersion: SETTINGS_VERSION }, ignored, from, migrated: false };
    }
    if (hasOwn(raw, 'schemaVersion')) {
      from = int(raw.schemaVersion, 1, 1000);
      if (from === undefined) {
        ignored.push('schemaVersion: not a version number; treated as version 1.');
        from = 1;
      }
    }
    if (from > SETTINGS_VERSION) ignored.push('The settings were saved by a newer DevForge (version ' + from + '). Settings this version does not know are left out.');
    let cur = { ...raw };
    for (let v = from; v < SETTINGS_VERSION; v++) cur = MIGRATIONS[v](cur);
    const unknown = [];
    for (const key of Object.keys(cur)) {
      if (key === 'schemaVersion') continue;
      const rule = hasOwn(SETTING_RULES, key) ? SETTING_RULES[key] : null;
      if (!rule) {
        unknown.push(short(key));
        continue;
      }
      const clean = rule(cur[key]);
      if (clean === undefined) ignored.push(key + ': the saved value is not valid; the default is used.');
      else value[key] = clean;
    }
    if (unknown.length) ignored.push(unknown.length + ' unknown setting' + (unknown.length === 1 ? '' : 's') + ' left out (' + unknown.slice(0, 5).join(', ') + (unknown.length > 5 ? ', …' : '') + ').');
    value.schemaVersion = SETTINGS_VERSION;
    return { value, ignored, from, migrated: from < SETTINGS_VERSION };
  }

  /* ---------- sites DevForge worked on ---------- */

  // Only web origins with a date and a count are kept. Paths, queries and anything else are dropped.
  function siteLog(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const e of raw.slice(0, 1000)) {
      if (!isObj(e) || typeof e.origin !== 'string' || e.origin.length > 300) continue;
      let origin;
      try {
        origin = new URL(e.origin).origin;
      } catch (_) {
        continue;
      }
      if (origin !== e.origin || seen.has(origin) || !/^https?:/.test(origin)) continue;
      const when = typeof e.last === 'string' && !Number.isNaN(Date.parse(e.last)) ? e.last : null;
      const count = int(e.count, 1, 1000000);
      if (!when || count === undefined) continue;
      seen.add(origin);
      out.push({ origin, last: when, count });
      if (out.length >= 200) break;
    }
    return out;
  }

  /* ---------- interception rules ---------- */

  const RULE_ACTIONS = ['block', 'mock', 'delay', 'headers', 'redirect'];
  const MAX_RULES = 200;
  const MAX_RULE_BYTES = 2 * 1024 * 1024; // all rule bodies together

  function headerMap(h) {
    if (!isObj(h)) return null;
    const out = {};
    for (const [k, v] of Object.entries(h).slice(0, 50)) {
      if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(k) && k !== '__proto__' && text(v, 4000)) out[k] = v;
    }
    return out;
  }

  // raw: whatever was stored under netRules. Returns { value: [rule], ignored: [text] }.
  function rules(raw) {
    const ignored = [];
    if (raw == null) return { value: [], ignored };
    if (!Array.isArray(raw)) return { value: [], ignored: ['The saved interception rules were not a list, so they were ignored.'] };
    const list = raw.slice(0, MAX_RULES);
    if (raw.length > MAX_RULES) ignored.push('Only the first ' + MAX_RULES + ' of ' + raw.length + ' saved interception rules are used.');
    const value = [];
    let bytes = 0;
    list.forEach((r, i) => {
      const n = 'Interception rule ' + (i + 1) + ': ';
      if (!isObj(r)) return ignored.push(n + 'not a rule; left out.');
      if (!RULE_ACTIONS.includes(r.action)) return ignored.push(n + 'unknown action; left out.');
      if (!text(r.match === undefined ? '' : r.match, 2000)) return ignored.push(n + 'the URL pattern is not text or is too long; left out.');
      const out = { match: r.match === undefined ? '' : r.match, regex: r.regex === true, method: '*', kinds: 'any', action: r.action };
      if (out.regex) {
        try {
          new RegExp(out.match);
        } catch (_) {
          return ignored.push(n + 'the pattern is not a valid regular expression; left out.');
        }
      }
      if (r.method !== undefined) out.method = text(r.method, 10) && /^(\*|[A-Za-z]{2,10})$/.test(r.method) ? r.method : '*';
      if (r.kinds !== undefined) out.kinds = text(r.kinds, 20) && /^[a-z,]+$/.test(r.kinds) ? r.kinds : 'any';
      if (r.enabled === false) out.enabled = false;
      if (r.action === 'mock') {
        const s = int(+r.status, 200, 599);
        if (s === undefined) return ignored.push(n + 'the mock status is not between 200 and 599; left out.');
        out.status = s;
        out.contentType = text(r.contentType, 200) ? r.contentType : 'application/json';
        out.body = text(r.body, 1000000) ? r.body : '';
        const hm = r.headers === undefined ? null : headerMap(r.headers);
        if (hm) out.headers = hm;
      } else if (r.action === 'delay') {
        const d = int(+r.delay, 0, 60000);
        if (d === undefined) return ignored.push(n + 'the delay is not between 0 and 60000 ms; left out.');
        out.delay = d;
      } else if (r.action === 'headers') {
        const hm = headerMap(r.headers);
        if (!hm || !Object.keys(hm).length) return ignored.push(n + 'no usable headers; left out.');
        out.headers = hm;
      } else if (r.action === 'redirect') {
        if (!text(r.redirect, 2000) || !r.redirect) return ignored.push(n + 'no redirect address; left out.');
        out.redirect = r.redirect;
      }
      bytes += (out.body || '').length + (out.match || '').length;
      if (bytes > MAX_RULE_BYTES) return ignored.push(n + 'the rules together are too large; this one and the rest are left out.');
      value.push(out);
    });
    return { value, ignored };
  }

  /* ---------- performance history ---------- */

  const PERF_METRICS = { lcp: 600000, fcp: 600000, ttfb: 600000, inp: 600000, cls: 1000, load: 3600000 };
  const PERF_KEY = /^k[0-9a-f]{24}$/;

  // raw: the stored map { siteKey: [point] }. Returns { value, ignored: [text] }.
  function perfHistory(raw) {
    const ignored = [];
    if (raw == null) return { value: {}, ignored };
    if (!isObj(raw)) return { value: {}, ignored: ['The saved performance history was not readable, so it was ignored.'] };
    const value = {};
    let badKeys = 0;
    let badPoints = 0;
    for (const [key, list] of Object.entries(raw).slice(0, 2000)) {
      if (!PERF_KEY.test(key) || !Array.isArray(list)) {
        badKeys++;
        continue;
      }
      const points = [];
      for (const p of list.slice(-200)) {
        if (!isObj(p) || typeof p.t !== 'number' || !isFinite(p.t) || p.t <= 0) {
          badPoints++;
          continue;
        }
        const q = { t: p.t };
        let data = false;
        for (const [m, max] of Object.entries(PERF_METRICS)) {
          const v = p[m];
          if (typeof v === 'number' && isFinite(v) && v >= 0 && v <= max) {
            q[m] = v;
            data = true;
          } else if (m !== 'load') q[m] = null;
        }
        if (data) points.push(q);
        else badPoints++;
      }
      if (points.length) value[key] = points;
    }
    if (badKeys) ignored.push('Performance history: ' + badKeys + ' saved entr' + (badKeys === 1 ? 'y' : 'ies') + ' for unknown pages left out.');
    if (badPoints) ignored.push('Performance history: ' + badPoints + ' saved reading' + (badPoints === 1 ? '' : 's') + ' were not valid and left out.');
    return { value, ignored };
  }

  /* ---------- Workspace records (IndexedDB) ---------- */

  const MAX_ITEM_CHARS = 25 * 1000 * 1000; // about the size of a very large saved report

  // Counts characters in strings of a value, stopping once `limit` is passed. No JSON.stringify, so a
  // huge record is not copied just to measure it. An object that refers to itself is counted once.
  function weight(v, limit) {
    let n = 0;
    const stack = [v];
    let steps = 0;
    const seen = new Set();
    while (stack.length && n <= limit && steps++ < 2000000) {
      const x = stack.pop();
      if (typeof x === 'string') n += x.length;
      else if (x && typeof x === 'object') {
        if (x instanceof Uint8Array || x instanceof ArrayBuffer) n += x.byteLength || x.length || 0;
        else if (!seen.has(x)) {
          seen.add(x);
          for (const k of Object.keys(x)) stack.push(x[k]);
        }
      } else n += 8;
    }
    return n;
  }

  // One saved item, or a note about why it is left out. Sealed items keep their stored shape.
  function item(rec) {
    if (!isObj(rec)) return { ok: false, why: 'not a record' };
    if (!text(rec.id, 200) || !rec.id) return { ok: false, why: 'it has no usable id' };
    if (!text(rec.project, 200)) return { ok: false, why: 'it does not belong to a project' };
    if (weight(rec, MAX_ITEM_CHARS) > MAX_ITEM_CHARS) return { ok: false, why: 'it is larger than ' + Math.round(MAX_ITEM_CHARS / 1e6) + ' MB' };
    const out = { ...rec };
    if (!text(out.kind, 40) || !out.kind) out.kind = 'other';
    if (!text(out.title, 500)) out.title = typeof out.title === 'string' ? out.title.slice(0, 500) : 'Untitled';
    if (typeof out.created !== 'number' || !isFinite(out.created)) out.created = 0;
    return { ok: true, item: out };
  }

  function project(rec) {
    if (!isObj(rec) || !text(rec.id, 200) || !rec.id) return { ok: false, why: 'it has no usable id' };
    const out = { ...rec };
    if (!text(out.name, 200) || !out.name) out.name = typeof out.name === 'string' && out.name ? out.name.slice(0, 200) : 'Untitled project';
    if (typeof out.created !== 'number' || !isFinite(out.created)) out.created = 0;
    return { ok: true, item: out };
  }

  // Filters a list with item() or project(). Returns { value, ignored: [text] }.
  function records(list, check, what) {
    const ignored = [];
    if (!Array.isArray(list)) return { value: [], ignored: ['The saved ' + what + ' were not a list, so they were ignored.'] };
    const value = [];
    let skipped = 0;
    const reasons = new Set();
    for (const rec of list) {
      const r = check(rec);
      if (r.ok) value.push(r.item);
      else {
        skipped++;
        reasons.add(r.why);
      }
    }
    if (skipped) ignored.push('Workspace: ' + skipped + ' saved ' + what + ' left out (' + [...reasons].slice(0, 3).join('; ') + ').');
    return { value, ignored };
  }

  return { SETTINGS_VERSION, settings, rules, perfHistory, item, project, records, weight, MAX_RULES, siteLog };
})();
if (typeof module !== 'undefined') module.exports = DFStored;
