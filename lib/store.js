// Workspace storage in IndexedDB. Stays in the browser.
const DFStore = (() => {
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
    listProjects: () => req('projects', 'readonly', (s) => s.getAll()),
    deleteProject: async (id) => {
      const items = await req('items', 'readonly', (s) => s.index('project').getAllKeys(id));
      for (const k of items) await req('items', 'readwrite', (s) => s.delete(k));
      await req('projects', 'readwrite', (s) => s.delete(id));
    },
    saveItem: async (item) => {
      const it = { id: item.id || uid(), created: Date.now(), ...item };
      await req('items', 'readwrite', (s) => s.put(it));
      return it;
    },
    listItems: (project) => req('items', 'readonly', (s) => s.index('project').getAll(project)),
    allItems: () => req('items', 'readonly', (s) => s.getAll()),
    deleteItem: (id) => req('items', 'readwrite', (s) => s.delete(id)),
    getItem: (id) => req('items', 'readonly', (s) => s.get(id)),
  };
})();
if (typeof module !== 'undefined') module.exports = DFStore;
