/*
 * Storage inspector: Web Storage, script-visible cookies, IndexedDB / Cache Storage names,
 * service worker registrations and the storage quota estimate. Runs in the isolated world, which
 * shares localStorage, sessionStorage and document.cookie with the page.
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.storageDump) return;
  const { clip } = DF.kit;

  const VALUE_MAX = 20000;
  const area = (name) => {
    if (name === 'local') return window.localStorage;
    if (name === 'session') return window.sessionStorage;
    throw new Error('Unknown storage area: ' + name);
  };

  function webStorage(name) {
    let s;
    try {
      s = area(name);
    } catch (e) {
      // Sandboxed or opaque-origin documents throw on access.
      return { error: e.message, items: [] };
    }
    const items = [];
    for (let i = 0; i < s.length && i < 2000; i++) {
      const key = s.key(i);
      const value = s.getItem(key) || '';
      items.push({
        key,
        value: value.length > VALUE_MAX ? value.slice(0, VALUE_MAX) : value,
        size: (key.length + value.length) * 2, // UTF-16 code units, which is what quotas count
        truncated: value.length > VALUE_MAX,
      });
    }
    return { items, count: s.length };
  }

  function cookies() {
    const raw = document.cookie;
    if (!raw) return [];
    return raw.split(/;\s*/).map((pair) => {
      const i = pair.indexOf('=');
      const name = i < 0 ? '' : pair.slice(0, i);
      const value = i < 0 ? pair : pair.slice(i + 1);
      return { key: name, value: clip(value, VALUE_MAX), size: pair.length };
    });
  }

  async function storageDump() {
    const out = {
      origin: location.origin,
      local: webStorage('local'),
      session: webStorage('session'),
      cookies: cookies(),
      cookieNote:
        'Only cookies visible to page scripts are listed; HttpOnly cookies are hidden from JavaScript by design.',
      indexedDB: null,
      caches: null,
      serviceWorkers: null,
      quota: null,
    };
    try {
      out.indexedDB = indexedDB.databases ? await indexedDB.databases() : null;
    } catch (e) {
      out.indexedDB = { error: e.message };
    }
    try {
      out.caches = window.caches ? await caches.keys() : null;
    } catch (e) {
      out.caches = { error: e.message };
    }
    try {
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      out.serviceWorkers = regs.map((r) => {
        const w = r.active || r.waiting || r.installing;
        return {
          scope: r.scope,
          state: w ? w.state : 'none',
          script: w ? w.scriptURL : null,
          updateViaCache: r.updateViaCache,
        };
      });
    } catch (e) {
      out.serviceWorkers = { error: e.message };
    }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        out.quota = { usage: est.usage, quota: est.quota, details: est.usageDetails || null };
        if (navigator.storage.persisted) out.quota.persisted = await navigator.storage.persisted();
      }
    } catch (e) {
      out.quota = { error: e.message };
    }
    return out;
  }

  function storageSet(name, key, value) {
    if (name === 'cookie') {
      if (!/^[^\s;,=]+$/.test(key))
        throw new Error('Cookie names cannot contain spaces, ; , or =.');
      // Path=/ so the cookie is visible on every page of the site, which is what people expect.
      document.cookie = `${key}=${value}; path=/; SameSite=Lax`;
      if (!cookies().some((c) => c.key === key))
        throw new Error('The browser refused the cookie (it may be HttpOnly or blocked).');
      return { ok: true };
    }
    try {
      area(name).setItem(key, value);
    } catch (e) {
      throw new Error(/quota/i.test(e.name + e.message) ? 'Storage quota exceeded.' : e.message);
    }
    return { ok: true };
  }

  function storageRemove(name, key) {
    if (name === 'cookie') {
      // A cookie is only removed with the same path/domain it was set with, which scripts cannot
      // read back, so try the usual combinations.
      const past = 'Thu, 01 Jan 1970 00:00:00 GMT';
      const paths = ['/', location.pathname, location.pathname.replace(/\/[^/]*$/, '') || '/'];
      const host = location.hostname;
      const domains = ['', host, '.' + host, '.' + host.split('.').slice(-2).join('.')];
      for (const p of new Set(paths))
        for (const d of new Set(domains))
          document.cookie = `${key}=; expires=${past}; path=${p}` + (d ? `; domain=${d}` : '');
      return { ok: !cookies().some((c) => c.key === key) };
    }
    area(name).removeItem(key);
    return { ok: true };
  }

  function storageClear(name) {
    if (name === 'cookie') {
      const keys = cookies().map((c) => c.key);
      keys.forEach((k) => storageRemove('cookie', k));
      return { removed: keys.length - cookies().length };
    }
    const s = area(name);
    const n = s.length;
    s.clear();
    return { removed: n };
  }

  // IndexedDB and Cache Storage. A name from the panel is checked against what the browser lists
  // first, so a call never creates a database or cache by accident.
  // lib/storageview.js is injected before this file, so it is read from the window here.
  const SV = window.DFStorageView;
  const LIMITS = SV.LIMITS;
  const reqDone = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('The browser refused the request.'));
    });
  const txDone = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('The change did not complete.'));
      tx.onabort = () => reject(tx.error || new Error('The change was cancelled by the browser.'));
    });
  async function checkDb(name) {
    const list = indexedDB.databases ? await indexedDB.databases() : [];
    if (!list.some((d) => d.name === name)) throw new Error('No IndexedDB database named "' + name + '" exists on this page.');
  }
  function openDb(name) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('The database could not be opened.'));
      r.onblocked = () => reject(new Error('The database is open in another tab. Close that tab and try again.'));
    });
  }

  async function idbStores(name) {
    await checkDb(name);
    const db = await openDb(name);
    try {
      const stores = [];
      for (const store of [...db.objectStoreNames]) {
        const os = db.transaction(store, 'readonly').objectStore(store);
        const count = await reqDone(os.count());
        stores.push({ name: store, count, keyPath: os.keyPath == null ? null : JSON.stringify(os.keyPath), autoIncrement: !!os.autoIncrement });
      }
      return { version: db.version, stores };
    } finally {
      db.close();
    }
  }

  // One page of records, or with full set, every record up to the export limits. Values are plain
  // text: dates and binary data are marked, not written out.
  async function idbRecords(name, store, offset, limit, full) {
    await checkDb(name);
    const db = await openDb(name);
    try {
      const os = db.transaction(store, 'readonly').objectStore(store);
      const cap = full ? LIMITS.exportRecords : LIMITS.recordsPerPage;
      const want = Math.min(Math.max(0, limit || cap), cap);
      const rows = [];
      let skipped = 0;
      let bytes = 0;
      let more = false;
      let capped = false;
      await new Promise((resolve, reject) => {
        const req = os.openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          if (skipped < (offset || 0)) {
            skipped++;
            return c.continue();
          }
          if (rows.length >= want) {
            more = true;
            return resolve();
          }
          const enc = SV.encodeKey(c.key);
          const v = SV.valueText(c.value);
          if (full) {
            bytes += v.chars;
            if (bytes > LIMITS.exportBytes) {
              capped = true;
              return resolve();
            }
            rows.push({ key: enc, keyText: SV.keyText(enc), value: v.text });
          } else {
            rows.push({ key: enc, keyText: SV.keyText(enc), value: v.text, truncated: v.truncated, chars: v.chars });
          }
          c.continue();
        };
      });
      return { rows, more, capped, offset: offset || 0 };
    } finally {
      db.close();
    }
  }

  // Edits one record. Only stores whose key is kept outside the value can be edited, because the
  // panel's key is the one that must be written back.
  async function idbPut(name, store, encKey, json) {
    await checkDb(name);
    const value = SV.revive(json);
    const key = SV.decodeKey(encKey);
    const db = await openDb(name);
    try {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      if (os.keyPath != null) throw new Error('This store keeps the key inside the value, so it cannot be edited here.');
      os.put(value, key);
      await txDone(tx);
      return { ok: true };
    } finally {
      db.close();
    }
  }

  async function idbDelete(name, store, encKey) {
    await checkDb(name);
    const key = SV.decodeKey(encKey);
    const db = await openDb(name);
    try {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      if (os.keyPath != null) throw new Error('This store keeps the key inside the value, so a record cannot be deleted here.');
      os.delete(key);
      await txDone(tx);
      return { ok: true };
    } finally {
      db.close();
    }
  }

  async function cacheNames() {
    return window.caches ? await caches.keys() : [];
  }
  async function cacheList(name) {
    if (!(await cacheNames()).includes(name)) throw new Error('No cache named "' + name + '" exists on this page.');
    const cache = await caches.open(name);
    const requests = await cache.keys();
    const entries = [];
    for (const req of requests.slice(0, LIMITS.cacheEntries)) {
      const res = await cache.match(req);
      const len = res ? Number(res.headers.get('content-length')) : NaN;
      entries.push({
        url: req.url,
        status: res ? res.status : null,
        type: res ? res.type : null,
        contentType: res ? res.headers.get('content-type') || '' : '',
        size: Number.isFinite(len) ? len : null,
      });
    }
    return { entries, total: requests.length, truncated: requests.length > LIMITS.cacheEntries };
  }

  // The body of one entry as base64. An opaque response (a cross-origin request made without
  // cors) has no readable body, and that is reported rather than guessed.
  async function cacheRead(name, url) {
    const cache = await caches.open(name);
    const res = await cache.match(url);
    if (!res) throw new Error('That entry is no longer in the cache.');
    if (res.type === 'opaque') return { url, skipped: 'opaque response: the browser does not let scripts read its body' };
    const blob = await res.blob();
    if (blob.size > LIMITS.cacheBodyBytes) return { url, skipped: 'larger than ' + LIMITS.cacheBodyBytes / 1e6 + ' MB', size: blob.size };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return { url, status: res.status, contentType: res.headers.get('content-type') || '', size: bytes.length, base64: btoa(bin) };
  }

  async function cacheDeleteEntry(name, url) {
    const cache = await caches.open(name);
    return { ok: await cache.delete(url) };
  }
  async function cacheDelete(name) {
    if (!(await cacheNames()).includes(name)) throw new Error('No cache named "' + name + '" exists on this page.');
    return { ok: await caches.delete(name) };
  }

  async function swUnregister(scope) {
    const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration(scope) : null;
    if (!reg || reg.scope !== scope) throw new Error('No service worker is registered for ' + scope + '.');
    return { ok: await reg.unregister() };
  }

  DF.extend({ storageDump, storageSet, storageRemove, storageClear, idbStores, idbRecords, idbPut, idbDelete, cacheList, cacheRead, cacheDeleteEntry, cacheDelete, swUnregister });
})();
