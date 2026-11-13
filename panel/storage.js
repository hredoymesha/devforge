// Storage tab: localStorage, sessionStorage and script-visible cookies (view, edit, add, delete),
// plus IndexedDB / Cache Storage names, service workers and quota usage (agent/storage.js).
const storS = { area: 'local', q: '' };
const AREAS = [
  ['local', 'Local storage'],
  ['session', 'Session storage'],
  ['cookie', 'Cookies'],
];

function prettyValue(v) {
  const t = (v || '').trim();
  if (t[0] === '{' || t[0] === '[') {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch (_) {
      /* not JSON */
    }
  }
  return v;
}

registerTab('storage', 'Storage', async (v) => {
  const out = h('div', null, loading('Reading storage'));
  const extra = h('div');
  let dump = null;

  const editor = (item) => {
    const key = h('input', {
      class: 'grow',
      value: item ? item.key : '',
      placeholder: 'key',
      'aria-label': 'Key',
      readonly: !!item,
    });
    const val = h('textarea', { rows: 6, 'aria-label': 'Value', spellcheck: 'false' });
    val.value = item ? prettyValue(item.value) : '';
    const box = h(
      'div',
      { class: 'card' },
      h('b', null, item ? 'Edit ' + item.key : 'New entry'),
      h('div', { class: 'row' }, key),
      val,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: async () => {
                if (!key.value.trim()) throw new Error('Enter a key.');
                // Pretty-printed JSON is saved compact again, matching how apps usually store it.
                let value = val.value;
                if (item && value !== item.value) {
                  try {
                    if (prettyValue(item.value) !== item.value)
                      value = JSON.stringify(JSON.parse(value));
                  } catch (_) {
                    /* user turned it into non-JSON; store as typed */
                  }
                }
                await call('storageSet', storS.area, key.value.trim(), value);
                toast('Saved');
                await load();
              },
            },
          },
          'Save'
        ),
        h('button', { on: { click: () => box.remove() } }, 'Cancel')
      )
    );
    return box;
  };

  const draw = () => {
    clear(out);
    if (!dump) return;
    const data = storS.area === 'cookie' ? { items: dump.cookies } : dump[storS.area];
    if (data.error) {
      out.append(h('div', { class: 'card sev-error' }, data.error));
      return;
    }
    const q = storS.q.toLowerCase();
    const items = data.items.filter((i) => !q || (i.key + ' ' + i.value).toLowerCase().includes(q));
    const total = data.items.reduce((s, i) => s + (i.size || 0), 0);
    const formBox = h('div');
    out.append(
      h(
        'div',
        { class: 'row' },
        h(
          'span',
          { class: 'sev-info grow' },
          `${data.items.length} entr${data.items.length === 1 ? 'y' : 'ies'} · ${fmtBytes(total)}` +
            (storS.area === 'cookie' ? ' · HttpOnly cookies are not visible to scripts' : '')
        ),
        h('button', { on: { click: () => clear(formBox).append(editor(null)) } }, '＋ Add'),
        h(
          'button',
          {
            class: 'danger',
            disabled: !data.items.length,
            on: {
              click: async () => {
                if (
                  !confirm(
                    `Delete all ${data.items.length} entries from ${storS.area === 'cookie' ? 'cookies' : storS.area + 'Storage'} on ${dump.origin}?`
                  )
                )
                  return;
                const r = await call('storageClear', storS.area);
                toast(`Removed ${r.removed}`);
                await load();
              },
            },
          },
          'Clear all'
        )
      ),
      formBox,
      items.length
        ? table(
            ['Key', 'Value', 'Size', ''],
            items.map((i) => [
              mono(i.key),
              h(
                'details',
                { class: 'val' },
                h('summary', { class: 'mono ellipsis' }, i.value.slice(0, 120) || '(empty)'),
                codeBlock(prettyValue(i.value) + (i.truncated ? '\n… (truncated)' : ''))
              ),
              fmtBytes(i.size),
              h(
                'span',
                { class: 'nowrap' },
                h(
                  'button',
                  {
                    class: 'icon ghost',
                    title: 'Copy value',
                    'aria-label': 'Copy value of ' + i.key,
                    on: { click: () => copy(i.value) },
                  },
                  '⧉'
                ),
                h(
                  'button',
                  {
                    class: 'icon ghost',
                    title: 'Edit',
                    'aria-label': 'Edit ' + i.key,
                    disabled: i.truncated,
                    on: { click: () => clear(formBox).append(editor(i)) },
                  },
                  '✎'
                ),
                h(
                  'button',
                  {
                    class: 'icon ghost',
                    title: 'Delete',
                    'aria-label': 'Delete ' + i.key,
                    on: {
                      click: async () => {
                        const r = await call('storageRemove', storS.area, i.key);
                        if (r.ok === false)
                          toast(
                            'The cookie could not be removed (set with a path or domain scripts cannot target).'
                          );
                        await load();
                      },
                    },
                  },
                  '✕'
                )
              ),
            ]),
            { class: 'compact' }
          )
        : emptyState(
            q ? 'Nothing matches' : 'Empty',
            q ? 'Try another search.' : 'No entries stored for this origin.'
          )
    );
  };

  // The box under the sections that shows one database, one cache, or the result of an action.
  const deepBox = h('div', { id: 'storage-deep' });
  const showDeep = (title, ...kids) => {
    deepBox.replaceChildren(
      section(
        title,
        h('div', { class: 'row' }, h('button', { on: { click: () => deepBox.replaceChildren() } }, 'Close')),
        ...kids
      )
    );
    deepBox.scrollIntoView?.({ block: 'nearest' });
  };
  const limitsNote = `Shows up to ${DFStorageView.LIMITS.recordsPerPage} records at a time. Export takes up to ${DFStorageView.LIMITS.exportRecords.toLocaleString('en-US')} records or ${fmtBytes(DFStorageView.LIMITS.exportBytes)}.`;

  const openIdb = async (name) => {
    showDeep(
      'Database ' + name,
      h('div', { class: 'sev-info' }, 'Loading…')
    );
    try {
      const info = await call('idbStores', name);
      showDeep(
        'Database ' + name,
        h('div', { class: 'sev-info' }, 'Version ' + info.version + '. Pick a store to see its records. ' + limitsNote),
        info.stores.length
          ? table(
              ['Store', 'Records', 'Key', ''],
              info.stores.map((st) => [
                mono(st.name),
                String(st.count),
                st.keyPath ? 'in the value: ' + st.keyPath : st.autoIncrement ? 'generated' : 'outside the value',
                h('button', { class: 'tiny', on: { click: () => openStore(name, st) } }, 'Browse'),
              ]),
              { class: 'compact' }
            )
          : h('div', { class: 'sev-info' }, 'No object stores in this database.')
      );
    } catch (e) {
      showDeep('Database ' + name, h('div', { class: 'sev-error' }, e.message));
    }
  };

  const openStore = async (db, st, offset = 0) => {
    const page = DFStorageView.LIMITS.recordsPerPage;
    const body = h('div', { class: 'sev-info' }, 'Loading records…');
    showDeep('Store ' + st.name + ' in ' + db, body);
    try {
      const res = await call('idbRecords', db, st.name, offset, page, false);
      const canEdit = st.keyPath == null;
      const rows = res.rows.map((r, i) => {
        const idx = offset + i;
        const actions = [];
        if (canEdit) actions.push(h('button', { class: 'tiny', on: { click: () => editRecord(db, st, r, idx, offset) } }, 'Edit'));
        else actions.push(h('span', { class: 'sev-info' }, 'key in value'));
        if (canEdit) actions.push(h('button', { class: 'tiny', on: { click: () => deleteRecord(db, st, r, offset) } }, 'Delete'));
        return [mono(r.keyText.slice(0, 120)), h('span', { class: 'mono' }, r.value.slice(0, 300) + (r.value.length > 300 || r.truncated ? '…' : '')), h('div', { class: 'row' }, ...actions)];
      });
      body.replaceWith(
        h('div', { class: 'sev-info' }, 'Records ' + (rows.length ? offset + 1 : 0) + '–' + (offset + rows.length) + '. ' + limitsNote + (canEdit ? '' : ' This store keeps keys inside the value, so records cannot be edited or deleted here.')),
        rows.length ? table(['Key', 'Value', ''], rows, { class: 'compact' }) : h('div', { class: 'sev-info' }, 'No records on this page.'),
        h(
          'div',
          { class: 'row' },
          h('button', { disabled: offset === 0, on: { click: () => openStore(db, st, Math.max(0, offset - page)) } }, 'Previous page'),
          h('button', { disabled: !res.more, on: { click: () => openStore(db, st, offset + page) } }, 'Next page'),
          h('button', { on: { click: () => exportStore(db, st) } }, 'Export this store (JSON)'),
          h('button', { on: { click: () => openIdb(db) } }, 'Back to stores')
        )
      );
    } catch (e) {
      body.replaceWith(h('div', { class: 'sev-error' }, e.message));
    }
  };

  const editRecord = async (db, st, row, idx, offset) => {
    const full = await call('idbRecords', db, st.name, idx, 1, true);
    const text = full.rows[0] ? full.rows[0].value : row.value;
    const area = h('textarea', { class: 'code-box', 'aria-label': 'Record value', rows: 12 }, text);
    area.value = text;
    const warn = h('div', { class: 'sev-info' }, 'Values are saved as JSON. Dates written as {"$date": "…"} come back as dates. Other marked values (binary data, blobs, maps) are saved as they are written here.');
    const err = h('div', { class: 'sev-error' });
    showDeep(
      'Edit record in ' + st.name,
      h('div', { class: 'sev-info' }, 'Key: ' + row.keyText),
      warn,
      area,
      err,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: async () => {
                try {
                  await call('idbPut', db, st.name, row.key, area.value);
                  toast('Record saved');
                  openStore(db, st, offset);
                } catch (e) {
                  err.textContent = e.message;
                }
              },
            },
          },
          'Save record'
        ),
        h('button', { on: { click: () => openStore(db, st, offset) } }, 'Cancel')
      )
    );
  };

  const deleteRecord = async (db, st, row, offset) => {
    if (!confirm('Delete the record with key ' + row.keyText + ' from ' + st.name + ' in ' + db + '? This cannot be undone.')) return;
    try {
      await call('idbDelete', db, st.name, row.key);
      toast('Record deleted');
      openStore(db, st, offset);
    } catch (e) {
      toast(e.message);
    }
  };

  const exportStore = async (db, st) => {
    try {
      const res = await busy('Reading the store', () => call('idbRecords', db, st.name, 0, DFStorageView.LIMITS.exportRecords, true));
      const doc = {
        origin: dump.origin,
        database: db,
        store: st.name,
        exportedAt: new Date().toISOString(),
        records: res.rows.map((r) => ({ key: r.keyText, value: JSON.parse(r.value) })),
        complete: !res.more && !res.capped,
      };
      const note = res.capped ? ' The export stopped at ' + fmtBytes(DFStorageView.LIMITS.exportBytes) + ', so it is partial.' : res.more ? ' The export stopped at ' + DFStorageView.LIMITS.exportRecords + ' records, so it is partial.' : '';
      await saveGuarded('idb-' + slug(db) + '-' + slug(st.name) + '-' + stamp() + '.json', JSON.stringify(doc, null, 2) + '\n', 'application/json');
      status('Exported ' + res.rows.length + ' record(s).' + note, res.more || res.capped ? '' : 'ok');
    } catch (e) {
      toast(e.message);
    }
  };

  const openCache = async (name) => {
    const body = h('div', { class: 'sev-info' }, 'Loading entries…');
    showDeep('Cache ' + name, body);
    try {
      const res = await call('cacheList', name);
      const rows = res.entries.map((e) => [
        mono(e.url.slice(0, 160)),
        e.status == null ? '–' : String(e.status),
        e.contentType ? e.contentType.split(';')[0] : '–',
        e.size == null ? 'unknown' : fmtBytes(e.size),
        h('button', { class: 'tiny', on: { click: () => deleteCacheEntry(name, e.url) } }, 'Delete'),
      ]);
      body.replaceWith(
        h('div', { class: 'sev-info' }, res.total + ' entr' + (res.total === 1 ? 'y' : 'ies') + '. ' + (res.truncated ? 'Only the first ' + DFStorageView.LIMITS.cacheEntries + ' are listed. ' : '') + 'Export saves up to ' + DFStorageView.LIMITS.cacheEntries + ' entries and ' + fmtBytes(DFStorageView.LIMITS.cacheTotalBytes) + ' of bodies, each body up to ' + fmtBytes(DFStorageView.LIMITS.cacheBodyBytes) + '. Opaque responses have no readable body.'),
        rows.length ? table(['Address', 'Status', 'Type', 'Size', ''], rows, { class: 'compact' }) : h('div', { class: 'sev-info' }, 'The cache is empty.'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', on: { click: () => exportCache(name, res) } }, 'Export cache (ZIP)'),
          h('button', { on: { click: () => deleteCache(name) } }, 'Delete this cache')
        )
      );
    } catch (e) {
      body.replaceWith(h('div', { class: 'sev-error' }, e.message));
    }
  };

  const deleteCacheEntry = async (name, url) => {
    if (!confirm('Delete this entry from the cache ' + name + '?\n\n' + url + '\n\nThis cannot be undone.')) return;
    try {
      const r = await call('cacheDeleteEntry', name, url);
      toast(r.ok ? 'Entry deleted' : 'The entry was not in the cache');
      openCache(name);
    } catch (e) {
      toast(e.message);
    }
  };

  const deleteCache = async (name) => {
    if (!confirm('Delete the whole cache ' + name + ' with all its entries? This cannot be undone.')) return;
    try {
      await call('cacheDelete', name);
      toast('Cache deleted');
      deepBox.replaceChildren();
      await load();
    } catch (e) {
      toast(e.message);
    }
  };

  const exportCache = async (name, listing) => {
    const L = DFStorageView.LIMITS;
    const manifest = { origin: dump.origin, cache: name, exportedAt: new Date().toISOString(), entries: [] };
    const files = [];
    let total = 0;
    let stopped = null;
    await busy('Reading the cache', async (step) => {
      for (let i = 0; i < listing.entries.length; i++) {
        const e = listing.entries[i];
        step && step('Reading ' + (i + 1) + ' of ' + listing.entries.length);
        const r = await call('cacheRead', name, e.url);
        if (r.skipped) {
          manifest.entries.push({ url: e.url, status: e.status, skipped: r.skipped });
          continue;
        }
        if (total + r.size > L.cacheTotalBytes) {
          stopped = 'The export stopped at ' + fmtBytes(L.cacheTotalBytes) + '.';
          break;
        }
        total += r.size;
        const path = DFStorageView.cacheFileName(e.url, i);
        files.push({ path, data: Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) });
        manifest.entries.push({ url: e.url, status: r.status, contentType: r.contentType, size: r.size, file: path });
      }
    });
    if (stopped) manifest.stopped = stopped;
    files.unshift({ path: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' });
    const safe = await guardFiles(files);
    if (!safe) return;
    const root = 'cache-' + slug(name) + '-' + stamp();
    download(root + '.zip', await DFZip.buildAsync(safe.map((f) => ({ path: root + '/' + f.path, data: f.data }))), 'application/zip');
    status('Cache exported: ' + files.length - 1 + ' file(s), ' + fmtBytes(total) + '.' + (stopped ? ' ' + stopped : ''), stopped ? '' : 'ok');
  };

  const unregisterSw = async (scope) => {
    if (!confirm('Unregister the service worker for ' + scope + '? The site stops running it for this origin until it registers it again. This cannot be undone here.')) return;
    try {
      const r = await call('swUnregister', scope);
      toast(r.ok ? 'Service worker unregistered' : 'The browser did not unregister it');
      await load();
    } catch (e) {
      toast(e.message);
    }
  };

  const drawExtra = () => {
    clear(extra);
    if (!dump) return;
    const errOr = (x, fn) =>
      x == null
        ? h('div', { class: 'sev-info' }, 'Not available here.')
        : x.error
          ? h('div', { class: 'sev-error' }, x.error)
          : fn(x);
    if (dump.quota && !dump.quota.error) {
      const pct = dump.quota.quota ? (dump.quota.usage / dump.quota.quota) * 100 : 0;
      extra.append(
        section(
          'Quota',
          h(
            'div',
            { class: 'bar' },
            h('i', { style: { width: Math.max(0.5, Math.min(100, pct)) + '%' } })
          ),
          h(
            'div',
            { class: 'sev-info' },
            `${fmtBytes(dump.quota.usage)} used of ${fmtBytes(dump.quota.quota)} available` +
              (dump.quota.persisted ? ' · persistent storage granted' : '')
          ),
          dump.quota.details
            ? kv(
                Object.fromEntries(
                  Object.entries(dump.quota.details).map(([k, n]) => [k, fmtBytes(n)])
                )
              )
            : ''
        )
      );
    }
    extra.append(
      section(
        'IndexedDB',
        errOr(dump.indexedDB, (dbs) =>
          dbs.length
            ? table(
                ['Database', 'Version', ''],
                dbs.map((d) => [mono(d.name), d.version, h('button', { class: 'tiny', on: { click: () => openIdb(d.name) } }, 'Browse')]),
                { class: 'compact' }
              )
            : h('div', { class: 'sev-info' }, 'No databases.')
        )
      ),
      section(
        'Cache Storage',
        errOr(dump.caches, (c) =>
          c.length
            ? h(
                'div',
                { class: 'row' },
                c.map((n) => h('button', { class: 'tag', on: { click: () => openCache(n) } }, n))
              )
            : h('div', { class: 'sev-info' }, 'No caches.')
        )
      ),
      section(
        'Service workers',
        errOr(dump.serviceWorkers, (s) =>
          s.length
            ? table(
                ['Scope', 'State', 'Script', ''],
                s.map((w) => [mono(w.scope), w.state, mono(w.script || '–'), h('button', { class: 'tiny', on: { click: () => unregisterSw(w.scope) } }, 'Unregister')]),
                { class: 'compact' }
              )
            : h('div', { class: 'sev-info' }, 'None registered for this origin.')
        )
      )
    );
  };

  const load = async () => {
    dump = await call('storageDump');
    draw();
    drawExtra();
  };

  const search = h('input', {
    class: 'grow',
    type: 'search',
    value: storS.q,
    placeholder: 'Search keys and values…',
    'aria-label': 'Search storage',
  });
  search.addEventListener(
    'input',
    debounce(() => {
      storS.q = search.value;
      draw();
    }, 120)
  );
  v.append(
    h(
      'div',
      { class: 'toolbar' },
      h(
        'div',
        { class: 'seg', role: 'tablist', 'aria-label': 'Storage area' },
        AREAS.map(([id, label]) =>
          h(
            'button',
            {
              role: 'tab',
              'aria-selected': String(id === storS.area),
              on: {
                click: (e) => {
                  storS.area = id;
                  for (const b of e.currentTarget.parentNode.children)
                    b.setAttribute('aria-selected', String(b === e.currentTarget));
                  draw();
                },
              },
            },
            label
          )
        )
      ),
      h('button', { on: { click: load } }, 'Refresh'),
      h(
        'button',
        {
          on: {
            click: () => {
              if (!dump) return;
              download(
                'storage-' + slug(dump.origin) + '-' + stamp() + '.json',
                JSON.stringify(dump, null, 2),
                'application/json'
              );
            },
          },
        },
        'Export'
      )
    ),
    h('div', { class: 'row' }, search),
    out,
    extra,
    deepBox
  );
  await load().catch((e) => clear(out).append(h('div', { class: 'card sev-error' }, e.message)));
});
