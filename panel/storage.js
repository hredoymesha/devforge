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
                ['Database', 'Version'],
                dbs.map((d) => [mono(d.name), d.version]),
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
                c.map((n) => h('span', { class: 'tag' }, n))
              )
            : h('div', { class: 'sev-info' }, 'No caches.')
        )
      ),
      section(
        'Service workers',
        errOr(dump.serviceWorkers, (s) =>
          s.length
            ? table(
                ['Scope', 'State', 'Script'],
                s.map((w) => [mono(w.scope), w.state, mono(w.script || '–')]),
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
    extra
  );
  await load().catch((e) => clear(out).append(h('div', { class: 'card sev-error' }, e.message)));
});
