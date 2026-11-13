// Helpers for the Storage tab. They turn IndexedDB keys and values into text that can be sent as
// JSON and back, name the files of a cache export, and hold the limits the tab shows. The page
// agent loads this file too, so it has no DevForge dependency.
const DFStorageView = (() => {
  const LIMITS = {
    recordsPerPage: 200,
    exportRecords: 10000,
    exportBytes: 20e6,
    cacheEntries: 500,
    cacheBodyBytes: 8e6,
    cacheTotalBytes: 50e6,
    valueChars: 20000,
  };
  const MAX_DEPTH = 20;
  const MAX_ITEMS = 2000;

  // IndexedDB keys are strings, numbers, dates and arrays of those. Each is written as a tagged pair
  // so that a number and a string with the same text stay different.
  function encodeKey(k) {
    if (typeof k === 'string') return { t: 's', v: k };
    if (typeof k === 'number' && Number.isFinite(k)) return { t: 'n', v: k };
    if (Object.prototype.toString.call(k) === '[object Date]' && !Number.isNaN(k.getTime())) return { t: 'd', v: k.toISOString() };
    if (Array.isArray(k)) return { t: 'a', v: k.map(encodeKey) };
    return { t: 'x', v: String(k) };
  }

  // The reverse. A key that cannot be found again (binary, or an unknown tag) is refused, so the
  // panel never deletes the wrong record.
  function decodeKey(e) {
    if (e && typeof e === 'object') {
      if (e.t === 's' && typeof e.v === 'string') return e.v;
      if (e.t === 'n' && typeof e.v === 'number' && Number.isFinite(e.v)) return e.v;
      if (e.t === 'd' && typeof e.v === 'string' && !Number.isNaN(Date.parse(e.v))) return new Date(e.v);
      if (e.t === 'a' && Array.isArray(e.v)) return e.v.map(decodeKey);
    }
    throw new Error('This key cannot be used to find the record. Only text, number, date and lists of those are supported.');
  }

  function keyText(e) {
    if (e.t === 's') return JSON.stringify(e.v);
    if (e.t === 'a') return '[' + e.v.map(keyText).join(', ') + ']';
    return String(e.v);
  }

  // A value as plain data. Dates, binary data, blobs and the other types JSON cannot hold are
  // written as marked objects, so the reader can see what was there without the bytes.
  function portable(v, depth = 0, seen = new WeakSet()) {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $number: String(v) };
    if (v === undefined) return { $undefined: true };
    if (typeof v === 'bigint') return { $bigint: String(v) };
    if (typeof v === 'function' || typeof v === 'symbol') return { $unsupported: typeof v };
    if (depth > MAX_DEPTH) return { $truncated: true };
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Date]') return { $date: Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString() };
    if (tag === '[object RegExp]') return { $regexp: String(v) };
    if (tag === '[object ArrayBuffer]') return { $bytes: v.byteLength };
    if (ArrayBuffer.isView(v)) return { $bytes: v.byteLength, $type: tag.slice(8, -1) };
    if (tag === '[object Blob]' || tag === '[object File]') return { $blob: v.size, $mime: v.type || '' };
    if (seen.has(v)) return { $circular: true };
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, MAX_ITEMS).map((x) => portable(x, depth + 1, seen));
    if (tag === '[object Map]') return { $map: [...v].slice(0, MAX_ITEMS).map(([k, x]) => [portable(k, depth + 1, seen), portable(x, depth + 1, seen)]) };
    if (tag === '[object Set]') return { $set: [...v].slice(0, MAX_ITEMS).map((x) => portable(x, depth + 1, seen)) };
    const out = {};
    for (const k of Object.keys(v).slice(0, MAX_ITEMS)) out[k] = portable(v[k], depth + 1, seen);
    return out;
  }

  // The value text for the table, cut to the limit.
  function valueText(v) {
    const json = JSON.stringify(portable(v));
    const text = json === undefined ? 'undefined' : json;
    return text.length > LIMITS.valueChars ? { text: text.slice(0, LIMITS.valueChars), truncated: true, chars: text.length } : { text, truncated: false, chars: text.length };
  }

  // Text typed in the editor back to a value. Dates written as {"$date": …} come back as dates;
  // other marked objects stay as they are, so the panel can warn that they were not restored.
  function revive(json) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (_) {
      throw new Error('The value is not valid JSON. Check the commas, quotes and brackets.');
    }
    const walk = (x) => {
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === 'object') {
        if (typeof x.$date === 'string' && Object.keys(x).length === 1 && !Number.isNaN(Date.parse(x.$date))) return new Date(x.$date);
        const o = {};
        for (const k of Object.keys(x)) o[k] = walk(x[k]);
        return o;
      }
      return x;
    };
    return walk(parsed);
  }

  // A file name for one cache entry. It comes from the address, never from the page's own names,
  // and cannot leave its folder. The index in front keeps two entries from sharing a name.
  function cacheFileName(url, index) {
    let host = '';
    let rest = String(url);
    try {
      const u = new URL(rest);
      host = u.host;
      rest = u.pathname;
    } catch (_) {
      /* keep the text as it is */
    }
    const clean = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
    const segs = rest.split('/').filter((p) => p && p !== '.' && p !== '..').map(clean).filter(Boolean);
    if (!segs.length || rest.endsWith('/')) segs.push('index');
    const name = [clean(host) || 'local', ...segs].join('/').slice(0, 200);
    return 'cache/' + String(index + 1).padStart(4, '0') + '-' + name;
  }

  return { LIMITS, encodeKey, decodeKey, keyText, portable, valueText, revive, cacheFileName };
})();
// The page agent runs in the isolated world, where a top-level const is not a window property.
if (typeof window !== 'undefined') window.DFStorageView = DFStorageView;
if (typeof module !== 'undefined') module.exports = DFStorageView;
