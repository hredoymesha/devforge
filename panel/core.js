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
    settings: { theme: 'system', shortcuts: {}, lastTab: 'inspect' },
  },
  views: {},
};

// Files that make up the page agent. Injected together, in this order, the first time a tab is used.
const AGENT_FILES = [
  'agent.js',
  'agent/mutations.js',
  'agent/vitals.js',
  'agent/tokens.js',
  'agent/storage.js',
];
// Bump whenever the agent API changes so pages holding an older copy get a fresh one.
const AGENT_VERSION = 4;

/* Errors from UI handlers end up here instead of as unhandled rejections in the console. */
function showError(err) {
  const msg = (err && err.message) || String(err);
  status(msg, 'err');
  toast(msg, 4000);
}
// Wraps a handler so both sync throws and rejected promises are reported to the user.
function guard(fn) {
  return function guarded(ev) {
    try {
      const r = fn.call(this, ev);
      if (r && typeof r.then === 'function') r.catch(showError);
      return r;
    } catch (err) {
      showError(err);
    }
  };
}

// safe DOM builder: text is always textContent
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'on')
        for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, guard(fn));
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'hidden') el.hidden = !!v;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtBytes = (n) => {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(n >= 10240 ? 0 : 1) + ' KB';
  return n + ' B';
};
const fmtMs = (n) =>
  n == null || isNaN(n) ? '–' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : Math.round(n) + ' ms';
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

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
  $('#status-text').textContent = msg || '';
  s.className = kind || '';
  s.hidden = !msg;
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
  if (DF.state.tabId !== t.id) agentReady.delete(DF.state.tabId);
  DF.state.tabId = t.id;
  DF.state.url = t.url || '';
  const label = t.title || t.url || 'tab ' + t.id;
  const target = $('#target');
  target.textContent = label.slice(0, 80);
  target.title = (t.url || '') + '\nThe tab DevForge is working on';
  return t;
}
const NO_ACCESS_MSG =
  'DevForge has no access to this tab right now. Click the DevForge toolbar icon while this tab is active (temporary, this tab only), or enable access for all sites in Settings.';
const RESTRICTED =
  /^(chrome|edge|about|brave|opera|vivaldi|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;
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
    if (/^file:/i.test(t.url || '') && /Cannot access|permission/i.test(e.message))
      throw new Error(
        'Local files need "Allow access to file URLs" switched on for DevForge in chrome://extensions.'
      );
    if (/Cannot access|activeTab|all_urls|permission|host/i.test(e.message))
      throw new Error(NO_ACCESS_MSG + ' (' + e.message + ')');
    if (/No tab with id|Frame with ID 0 was removed|The tab was closed/i.test(e.message))
      throw new Error('The tab closed or navigated away while DevForge was working. Try again.');
    throw e;
  }
}

/*
 * Runs window.__DF[name](...args) in the page. Self-contained because executeScript serializes it.
 * Reports {missing:true} when there is no agent, or one from an older build / dead extension
 * context, so the caller can (re)inject without paying for a separate "is it there?" round trip.
 */
async function invokeAgent(name, args, version) {
  const df = window.__DF;
  const alive = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (!df || df.version !== version || !alive) {
    if (df && typeof df.destroy === 'function') {
      try {
        df.destroy();
      } catch (_) {
        /* best effort: an old agent may already be half torn down */
      }
    }
    delete window.__DF;
    return { missing: true };
  }
  if (typeof df[name] !== 'function') return { ok: false, e: 'Unknown page call: ' + name };
  try {
    const v = await df[name](...args);
    return { ok: true, v: v === undefined ? null : v };
  } catch (e) {
    return { ok: false, e: e && e.message ? e.message : String(e) };
  }
}
const agentReady = new Set(); // tab ids where the agent is known to be injected
async function injectAgent() {
  await exec(null, [], 'ISOLATED', AGENT_FILES);
  agentReady.add(DF.state.tabId);
}
async function call(name, ...args) {
  let r = await exec(invokeAgent, [name, args, AGENT_VERSION]);
  if (r && r.missing) {
    await injectAgent();
    r = await exec(invokeAgent, [name, args, AGENT_VERSION]);
    if (r && r.missing)
      throw new Error('Could not start the page agent (the page may block script injection).');
  }
  if (!r) throw new Error('No response from the page (it may have navigated). Try again.');
  if (!r.ok) throw new Error(r.e);
  return r.v;
}
const ensureAgent = () => call('ping');

// files
function download(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('Saved ' + name + ' (' + fmtBytes(blob.size) + ') to your downloads folder');
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
    return true;
  } catch (e) {
    // The side panel loses clipboard access when it is not focused; fall back to execCommand.
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? 'Copied to clipboard' : 'Clipboard blocked: ' + e.message);
    return ok;
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
  // request() must be the first await: the click's user gesture does not survive earlier awaits.
  // For origins that are already granted it resolves true without showing a prompt.
  try {
    if (await chrome.permissions.request({ origins })) return { granted: origins, denied: [] };
  } catch (_) {
    /* no user gesture (e.g. called from a timer): fall through and report what we have */
  }
  const granted = [];
  for (const o of origins) if (await chrome.permissions.contains({ origins: [o] })) granted.push(o);
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
// Tabs can register a cleanup (stop polling, drop listeners) that runs when the user leaves them.
let viewCleanup = [];
function onLeave(fn) {
  viewCleanup.push(fn);
}
function show(id) {
  const t = DF.tabs.find((x) => x.id === id);
  if (!t) return;
  for (const fn of viewCleanup.splice(0)) {
    try {
      fn();
    } catch (_) {
      /* a failed cleanup must not block switching tabs */
    }
  }
  DF.state.tab = id;
  if (DF.state.settings.lastTab !== id) {
    DF.state.settings.lastTab = id;
    saveSettings();
  }
  for (const b of $('#tabs').children) {
    const on = b.dataset.id === id;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
    if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const v = clear($('#view'));
  v.setAttribute('aria-labelledby', 'tab-' + id);
  v.scrollTop = 0;
  try {
    const r = t.render(v);
    if (r && r.catch)
      r.catch((e) => {
        if (DF.state.tab === id) v.append(errBox(e));
      });
  } catch (e) {
    v.append(errBox(e));
  }
}
function errBox(e) {
  return h(
    'div',
    { class: 'card sev-error', role: 'alert' },
    h('b', null, 'This panel hit a problem: '),
    e.message || String(e),
    h('div', { class: 'row' }, h('button', { on: { click: () => show(DF.state.tab) } }, 'Retry'))
  );
}
let saveT;
function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => chrome.storage.local.set({ settings: DF.state.settings }), 150);
}

/* generic UI parts */
function section(title, ...kids) {
  return h('section', { class: 'sec' }, h('h2', null, title), ...kids);
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
          ? '–'
          : v.nodeType
            ? v
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
  return h(
    'table',
    { class: opts.class || null },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        cols.map((c) => h('th', { scope: 'col' }, c))
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
}
function codeBlock(text, lang) {
  return h('pre', { 'data-lang': lang || '', tabindex: 0 }, text);
}
function loading(label) {
  return h(
    'div',
    { class: 'empty', role: 'status' },
    h('span', { class: 'spin' }),
    ' ',
    label || 'Working…'
  );
}
// Friendly empty state: a title, a sentence of guidance and an optional call to action.
function emptyState(title, hint, action) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-title' }, title),
    hint ? h('div', null, hint) : '',
    action ? h('div', { class: 'row center' }, action) : ''
  );
}
function colorSwatch(c) {
  return h('span', null, h('i', { class: 'swatch', style: { background: c } }), c);
}
// Small segmented tab strip for detail panes. defs: [[id, label, renderFn(container)], ...]
function miniTabs(defs, initial) {
  const bar = h('div', { class: 'seg', role: 'tablist' });
  const body = h('div', { class: 'seg-body' });
  const open = (id) => {
    for (const b of bar.children) b.setAttribute('aria-selected', b.dataset.id === id);
    const d = defs.find((x) => x[0] === id) || defs[0];
    clear(body);
    const r = d[2](body);
    if (r && r.catch) r.catch((e) => body.append(h('div', { class: 'sev-error' }, e.message)));
  };
  defs.forEach(([id, label]) =>
    bar.append(h('button', { role: 'tab', 'data-id': id, on: { click: () => open(id) } }, label))
  );
  open(initial || defs[0][0]);
  return h('div', { class: 'seg-wrap' }, bar, body);
}
function needsSelection() {
  return emptyState(
    'No element selected',
    'Pick something on the page, or search the DOM on the Inspect tab.',
    h('button', { class: 'primary', on: { click: startPick } }, '⌖ Pick an element')
  );
}
async function startPick() {
  await call('startPick');
  status('Click an element on the page. Esc cancels.');
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
