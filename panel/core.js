// Panel core: DOM helpers (page data is only ever set as text), page RPC, shared state, file helpers.
const DF = {
  tabs: [],
  commands: [],
  state: {
    tabId: null,
    url: '',
    h: null,
    info: null,
    project: null,
    settings: { theme: 'dark', shortcuts: {} },
  },
  views: {},
};

// safe DOM builder: text is always textContent
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}
const $ = (s, r = document) => r.querySelector(s);
const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};
const tagEl = (p) => h('span', { class: 'tag ' + (p || '') }, p || '');
const mono = (t) => h('code', null, t);

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function status(msg, kind) {
  const s = $('#status');
  s.textContent = msg || '';
  s.className = kind || '';
}
const busy = async (label, fn) => {
  status(label + '…');
  try {
    const r = await fn();
    status('');
    return r;
  } catch (e) {
    status(e.message || String(e), 'err');
    throw e;
  }
};

// page RPC. All calls run in the extension's isolated world in the active tab.
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab.');
  DF.state.tabId = t.id;
  DF.state.url = t.url || '';
  $('#target').textContent = (t.title || t.url || 'tab ' + t.id).slice(0, 80);
  return t;
}
const NO_ACCESS_MSG =
  'DevForge has no access to this tab right now. Click the DevForge toolbar icon while this tab is active (temporary, this tab only), or enable access for all sites in Settings.';
const RESTRICTED =
  /^(chrome|edge|about|brave|devtools|view-source|chrome-extension|moz-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;
async function exec(func, args = [], world = 'ISOLATED', files) {
  const t = await activeTab();
  if (t.url && RESTRICTED.test(t.url))
    throw new Error(
      'Browsers do not allow extensions to run on this kind of page (' +
        t.url.split(':')[0] +
        ':). Open a regular web page.'
    );
  try {
    const r = await chrome.scripting.executeScript(
      files
        ? { target: { tabId: t.id }, files, world }
        : { target: { tabId: t.id }, func, args, world }
    );
    return r && r[0] ? r[0].result : undefined;
  } catch (e) {
    if (/Cannot access|activeTab|all_urls|permission|host/i.test(e.message))
      throw new Error(NO_ACCESS_MSG + ' (' + e.message + ')');
    throw e;
  }
}
async function ensureAgent() {
  const ok = await exec(() => !!(window.__DF && window.__DF.version)).catch((e) => {
    throw e;
  });
  if (!ok) await exec(null, [], 'ISOLATED', ['agent.js']);
  const ok2 = await exec(() => !!(window.__DF && window.__DF.version));
  if (!ok2)
    throw new Error('Could not start the page agent (the page may block script injection).');
}
/* call(name, ...args): runs window.__DF[name](...args) in page; errors come back as thrown Errors with the real message */
async function call(name, ...args) {
  await ensureAgent();
  const r = await exec(
    async (n, a) => {
      try {
        const v = await window.__DF[n](...a);
        return { ok: true, v: v === undefined ? null : v };
      } catch (e) {
        return { ok: false, e: e && e.message ? e.message : String(e) };
      }
    },
    [name, args]
  );
  if (!r) throw new Error('No response from the page (it may have navigated). Try again.');
  if (!r.ok) throw new Error(r.e);
  return r.v;
}

// files
function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(
    'Saved ' +
      name +
      ' (' +
      Math.round((blob.size / 1024) * 10) / 10 +
      ' KB) to your downloads folder'
  );
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
    return true;
  } catch (e) {
    toast('Clipboard blocked: ' + e.message);
    return false;
  }
}
function toCSV(rows) {
  if (!rows.length) return '';
  if (Array.isArray(rows[0])) return rows.map((r) => r.map(csvEsc).join(',')).join('\n');
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvEsc(r[c])).join(','))].join('\n');
}
function toMD(rows) {
  if (!rows.length) return '';
  const cols = Array.isArray(rows[0])
    ? rows[0].map((_, i) => 'col' + (i + 1))
    : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) =>
    String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v)
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  const body = rows.map(
    (r) => '| ' + (Array.isArray(r) ? r : cols.map((c) => r[c])).map(cell).join(' | ') + ' |'
  );
  return [
    '| ' + cols.join(' | ') + ' |',
    '| ' + cols.map(() => '---').join(' | ') + ' |',
    ...body,
  ].join('\n');
}
const slug = (s) =>
  (s || 'export')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'export';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// host permission for asset fetching / blocked stylesheets (optional, on demand)
async function ensureOrigins(urls) {
  const origins = [
    ...new Set(
      urls
        .map((u) => {
          try {
            const x = new URL(u);
            return /^https?:$/.test(x.protocol) ? x.origin + '/*' : null;
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean)
    ),
  ];
  if (!origins.length) return { granted: [], denied: [] };
  const have = [];
  for (const o of origins) if (await chrome.permissions.contains({ origins: [o] })) have.push(o);
  const need = origins.filter((o) => !have.includes(o));
  let granted = have;
  if (need.length) {
    try {
      if (await chrome.permissions.request({ origins: need })) granted = origins;
    } catch (e) {
      /* needs user gesture */
    }
  }
  return { granted, denied: origins.filter((o) => !granted.includes(o)) };
}
async function fetchBytes(url, maxBytes = 25 * 1024 * 1024, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const len = +r.headers.get('content-length') || 0;
    if (len > maxBytes) throw new Error('too large (' + len + ' bytes)');
    const reader = r.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) {
        try {
          await reader.cancel();
        } catch (_) {}
        throw new Error('too large (> ' + maxBytes + ' bytes)');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(n);
    let off = 0;
    for (const ch of chunks) {
      bytes.set(ch, off);
      off += ch.length;
    }
    return { bytes, type: r.headers.get('content-type') || '', status: r.status, finalUrl: r.url };
  } catch (e) {
    throw new Error(
      e.name === 'AbortError' ? 'timed out after ' + timeoutMs / 1000 + 's' : e.message
    );
  } finally {
    clearTimeout(timer);
  }
}

// tab/command registry
function registerTab(id, label, render, opts = {}) {
  DF.tabs.push({ id, label, render, ...opts });
}
function registerCommand(id, title, run, hint = '') {
  DF.commands.push({ id, title, run, hint });
}
function show(id) {
  const t = DF.tabs.find((x) => x.id === id);
  if (!t) return;
  DF.state.tab = id;
  for (const b of $('#tabs').children) b.setAttribute('aria-selected', b.dataset.id === id);
  const v = clear($('#view'));
  try {
    const r = t.render(v);
    if (r && r.catch)
      r.catch((e) => {
        v.append(errBox(e));
      });
  } catch (e) {
    v.append(errBox(e));
  }
}
function errBox(e) {
  return h(
    'div',
    { class: 'card sev-error' },
    'This panel failed: ',
    e.message || String(e),
    h('div', { class: 'row' }, h('button', { on: { click: () => show(DF.state.tab) } }, 'Retry'))
  );
}

/* generic UI parts */
function section(title, ...kids) {
  return h('div', null, h('h2', null, title), ...kids);
}
function kv(obj) {
  const g = h('div', { class: 'kv' });
  for (const [k, v] of Object.entries(obj)) {
    g.append(
      h('div', null, k),
      h(
        'div',
        { class: 'mono' },
        v == null
          ? '-'
          : typeof v === 'object'
            ? v.provenance
              ? [String(v.value), ' ', tagEl(v.provenance)]
              : JSON.stringify(v)
            : String(v)
      )
    );
  }
  return g;
}
function table(cols, rows, opts = {}) {
  const t = h(
    'table',
    null,
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        cols.map((c) => h('th', null, c))
      )
    ),
    h(
      'tbody',
      null,
      rows.map((r) =>
        h(
          'tr',
          opts.rowProps ? opts.rowProps(r) : null,
          r.map((c) => h('td', null, c))
        )
      )
    )
  );
  return t;
}
function codeBlock(text, lang) {
  return h('pre', { 'data-lang': lang || '' }, text);
}
function loading(label) {
  return h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' ', label || 'Working…');
}
function colorSwatch(c) {
  return h('span', null, h('i', { class: 'swatch', style: { background: c } }), c);
}
function needsSelection() {
  return h(
    'div',
    { class: 'empty' },
    'No element selected.',
    h(
      'div',
      { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'primary', on: { click: startPick } }, '⌖ Pick an element')
    ),
    h('div', null, 'or search the DOM on the Inspect tab.')
  );
}
async function startPick() {
  try {
    await call('startPick');
    status('Click an element on the page. Esc cancels.');
  } catch (e) {
    status(e.message, 'err');
  }
}

// Save to workspace
async function saveToWorkspace(kind, title, payload, extra) {
  if (!DF.state.project) {
    const ps = await DFStore.listProjects();
    DF.state.project = ps[0] ? ps[0].id : (await DFStore.createProject('My first project')).id;
  }
  const it = await DFStore.saveItem({
    project: DF.state.project,
    kind,
    title,
    url: DF.state.url,
    payload,
    ...(extra || {}),
  });
  toast('Saved to workspace: ' + title);
  return it;
}
