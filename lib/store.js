// Workspace storage in IndexedDB. Stays in the browser.
const DFStore = (() => {
  const Seal = typeof DFWsSeal !== 'undefined' ? DFWsSeal : require('./wsseal.js');
  const Stored = typeof DFStored !== 'undefined' ? DFStored : require('./stored.js');
  const DB = 'devforge',
    VER = 1;
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('projects', { keyPath: 'id' });
        const it = d.createObjectStore('items', { keyPath: 'id' });
        it.createIndex('project', 'project');
        it.createIndex('kind', 'kind');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => {
        dbp = null;
        rej(r.error);
      };
    });
    return dbp;
  }
  // Optional encryption of items at rest (lib/wsseal.js, enabled from the Owner tab). The codec is
  // { active(): boolean, seal(item), reveal(rec), canOpen(): boolean }. While it is active, saving
  // without an unlocked key throws instead of writing plaintext.
  let codec = null;
  const reveal = async (rec) => {
    if (!rec || !rec.sealed) return rec;
    if (!codec || !codec.canOpen()) return Seal.lockedView(rec);
    try {
      return await codec.reveal(rec);
    } catch (_) {
      // Wrong key or altered record: show it as unreadable rather than failing the whole list.
      return { ...Seal.lockedView(rec), title: 'Sealed item (could not be opened)', damaged: true };
    }
  };
  const revealAll = (recs) => Promise.all(recs.map(reveal));
  // Records that are not usable (no id, wrong type, far too large) are left out of every list and a
  // note goes to the handler the panel sets, so one damaged record cannot stop the Workspace opening.
  let onIssues = () => {};
  const checked = (list, check, what) => {
    const r = Stored.records(list, check, what);
    if (r.ignored.length) onIssues(r.ignored);
    return r.value;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const req = (store, mode, fn) =>
    open().then(
      (d) =>
        new Promise((res, rej) => {
          const r = fn(d.transaction(store, mode).objectStore(store));
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        })
    );
  return {
    uid,
    createProject: async (name) => {
      const p = { id: uid(), name: name || 'Untitled project', created: Date.now() };
      await req('projects', 'readwrite', (s) => s.put(p));
      return p;
    },
    listProjects: async () => checked(await req('projects', 'readonly', (s) => s.getAll()), Stored.project, 'projects'),
    setIssueHandler: (fn) => {
      onIssues = typeof fn === 'function' ? fn : () => {};
    },
    deleteProject: async (id) => {
      const items = await req('items', 'readonly', (s) => s.index('project').getAllKeys(id));
      for (const k of items) await req('items', 'readwrite', (s) => s.delete(k));
      await req('projects', 'readwrite', (s) => s.delete(id));
    },
    setCodec: (c) => {
      codec = c;
    },
    saveItem: async (item) => {
      const it = { id: item.id || uid(), created: Date.now(), ...item };
      const rec = codec && codec.active() ? await codec.seal(it) : it;
      await req('items', 'readwrite', (s) => s.put(rec));
      return it;
    },
    listItems: async (project) => revealAll(checked(await req('items', 'readonly', (s) => s.index('project').getAll(project)), Stored.item, 'items')),
    allItems: async () => revealAll(checked(await req('items', 'readonly', (s) => s.getAll()), Stored.item, 'items')),
    deleteItem: (id) => req('items', 'readwrite', (s) => s.delete(id)),
    getItem: async (id) => {
      const rec = await req('items', 'readonly', (s) => s.get(id));
      if (rec === undefined) return rec;
      const r = Stored.item(rec);
      if (!r.ok) {
        onIssues(['Workspace: a saved item was left out (' + r.why + ').']);
        return undefined;
      }
      return reveal(r.item);
    },
    // Raw records exactly as stored (for migration and counts). Never revealed.
    rawItems: () => req('items', 'readonly', (s) => s.getAll()),
    putRaw: (rec) => req('items', 'readwrite', (s) => s.put(rec)),
  };
})();
if (typeof module !== 'undefined') module.exports = DFStore;
