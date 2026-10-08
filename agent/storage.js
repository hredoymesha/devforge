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

  DF.extend({ storageDump, storageSet, storageRemove, storageClear });
})();
