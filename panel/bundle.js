// Export → Page bundle: pick any mix of what DevTools shows for a page (rendered HTML, scripts,
// stylesheets, source maps, WebAssembly, manifest, service workers, network payloads and HAR,
// cookies and storage, element details, saved Workspace items) and download it as one ZIP or as
// separate files. Whatever cannot be read is listed in _manifest.json with the reason; nothing is
// skipped silently.

const BUNDLE_MAX_TOTAL = 150 * 1024 * 1024;
const BUNDLE_EXT_TYPE = { html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json', har: 'application/json', map: 'application/json', wasm: 'application/wasm', md: 'text/markdown', txt: 'text/plain', png: 'image/png', webmanifest: 'application/manifest+json', xml: 'application/xml', zip: 'application/zip' };
const bundleType = (name) => BUNDLE_EXT_TYPE[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const bundleText = (b) => (typeof b === 'string' ? b : new TextDecoder('utf-8').decode(b));

function bundleFileName(url, i, fallbackExt) {
  let base = 'file';
  let ext = fallbackExt;
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || 'index';
    const m = /^(.*?)(?:\.([a-z0-9]{1,6}))?$/i.exec(decodeURIComponent(p));
    base = slug(m[1]) || 'file';
    if (m[2]) ext = m[2].toLowerCase();
  } catch (_) {
    /* keep the defaults */
  }
  return String(i + 1).padStart(2, '0') + '-' + base + '.' + ext;
}

// Source map address from the last lines of a script or stylesheet; null if there is none.
function bundleSourceMapRef(text) {
  const tail = text.slice(-600);
  const m = /[#@]\s*sourceMappingURL=([^\s'"*]+)/.exec(tail);
  return m ? m[1] : null;
}

const BUNDLE_GROUPS = [
  ['Page', [
    ['html', 'Rendered outer HTML (the DOM as it is now)', 'Everything the browser built, including content added by scripts.'],
    ['js', 'Client-side JavaScript (.js)', 'Inline scripts and every script file the page loads.'],
    ['css', 'Web stylesheets (CSS)', 'Inline <style> blocks and every stylesheet file.'],
    ['maps', 'Source maps (.map)', 'Found through the sourceMappingURL comment of the scripts and styles above.'],
    ['wasm', 'WebAssembly modules (.wasm)', 'Binary modules the page loads, up to 8 MB each.'],
    ['manifest', 'Web app manifest', ''],
    ['sw', 'Service worker scripts', 'The scripts of registered service workers.'],
  ]],
  ['Network', [
    ['network', 'Network payloads and HTTP archive (HAR)', 'Needs Network capture to be on. Responses as JSON / XML / text files plus one .har.'],
  ]],
  ['Application', [
    ['cookies', 'Cookies (those scripts can read)', 'HttpOnly cookies are hidden from scripts by design.'],
    ['local', 'localStorage', ''],
    ['session', 'sessionStorage', ''],
    ['idb', 'IndexedDB and Cache Storage overview', 'Database and store names with record counts, not the records.'],
  ]],
  ['Selected element', [
    ['el-component', 'Element code and documentation', 'HTML, CSS, JavaScript fragments, data and a README for the selected element.'],
    ['el-rules', 'Resolved style rules', 'Which rules apply, and which win.'],
    ['el-computed', 'Computed styles', 'Every computed property.'],
    ['el-box', 'Layout box model and details', 'Size, margin, padding, border, position, selectors.'],
  ]],
];

async function bundleTexts(ctx, kind) {
  // Fetch (once) every file of a kind that the page loads. Failures are recorded, not thrown.
  if (ctx.cache[kind]) return ctx.cache[kind];
  const res = await ctx.resources();
  const known = new Set(res.map((r) => r.url));
  // Files loaded by scripts (dynamic import(), fetch of a stylesheet) are not in the DOM; the
  // browser's own list of loaded resources has them.
  const loaded = await ctx.loaded();
  const extra = loaded.filter((e) => !known.has(e.url) && (kind === 'js' ? e.type === 'script' || /\.(m?js)(\?|#|$)/i.test(e.url) : /\.css(\?|#|$)/i.test(e.url))).map((e) => ({ url: e.url, kind }));
  const list = [...res.filter((r) => r.kind === kind), ...extra].slice(0, 80);
  const out = [];
  for (const r of list) {
    try {
      if (blocksPrivate(r.url, ctx.pageUrl)) throw new Error('private or loopback address the page is not on');
      const { bytes, type } = await fetchBytes(r.url, 12 * 1024 * 1024);
      out.push({ url: r.url, bytes, type });
    } catch (e) {
      ctx.problems.push(kind + ' ' + r.url + ': ' + e.message);
    }
  }
  ctx.cache[kind] = out;
  return out;
}

const BUNDLE_RUN = {
  async html() {
    return [{ path: 'html/rendered.html', data: await call('fullDom') }];
  },
  async js(ctx) {
    const files = [];
    const inline = await exec(() => [...document.scripts].filter((s) => !s.src && s.textContent.trim() && !(s.id || '').startsWith('__df_')).map((s) => ({ type: s.type || 'text/javascript', text: s.textContent })), []);
    (inline || []).forEach((s, i) => files.push({ path: 'js/inline-' + String(i + 1).padStart(2, '0') + '.js', data: s.text }));
    (await bundleTexts(ctx, 'js')).forEach((f, i) => files.push({ path: 'js/' + bundleFileName(f.url, i, 'js'), data: f.bytes, source: f.url }));
    return files;
  },
  async css(ctx) {
    const files = [];
    const inline = await exec(() => [...document.querySelectorAll('style')].filter((s) => !(s.id || '').startsWith('__df_') && s.textContent.trim()).map((s) => s.textContent), []);
    (inline || []).forEach((t, i) => files.push({ path: 'css/inline-' + String(i + 1).padStart(2, '0') + '.css', data: t }));
    (await bundleTexts(ctx, 'css')).forEach((f, i) => files.push({ path: 'css/' + bundleFileName(f.url, i, 'css'), data: f.bytes, source: f.url }));
    return files;
  },
  async maps(ctx) {
    const files = [];
    let n = 0;
    for (const kind of ['js', 'css']) {
      for (const f of await bundleTexts(ctx, kind)) {
        const ref = bundleSourceMapRef(bundleText(f.bytes));
        if (!ref) continue;
        try {
          if (/^data:/i.test(ref)) {
            const comma = ref.indexOf(',');
            const body = ref.slice(comma + 1);
            const text = /;base64/i.test(ref.slice(0, comma)) ? atob(body) : decodeURIComponent(body);
            files.push({ path: 'sourcemaps/' + bundleFileName(f.url, n++, 'map').replace(/\.(js|css)$/, '') + '.inline.map', data: text, source: 'inline in ' + f.url });
            continue;
          }
          const u = new URL(ref, f.url).href;
          if (blocksPrivate(u, ctx.pageUrl)) throw new Error('private or loopback address');
          const { bytes } = await fetchBytes(u, 25 * 1024 * 1024);
          files.push({ path: 'sourcemaps/' + bundleFileName(u, n++, 'map'), data: bytes, source: u });
        } catch (e) {
          ctx.problems.push('source map for ' + f.url + ': ' + e.message);
        }
      }
    }
    return files;
  },
  async wasm(ctx) {
    const urls = [...new Set([...(await ctx.resources()).map((r) => r.url), ...(await ctx.loaded()).map((e) => e.url)])];
    const res = urls.filter((u) => /\.wasm(\?|#|$)/i.test(u)).map((url) => ({ url }));
    const files = [];
    for (const [i, r] of res.slice(0, 20).entries()) {
      try {
        const { bytes } = await fetchBytes(r.url, 8 * 1024 * 1024);
        files.push({ path: 'wasm/' + bundleFileName(r.url, i, 'wasm'), data: bytes, source: r.url });
      } catch (e) {
        ctx.problems.push('wasm ' + r.url + ': ' + e.message);
      }
    }
    return files;
  },
  async manifest(ctx) {
    const href = await exec(() => (document.querySelector('link[rel~="manifest"]') || {}).href || null, []);
    if (!href) return [];
    const { bytes } = await fetchBytes(href, 2 * 1024 * 1024);
    ctx.note('manifest', href);
    return [{ path: 'app/manifest.webmanifest', data: bytes, source: href }];
  },
  async sw(ctx) {
    const urls = await exec(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active || r.waiting || r.installing || {}).scriptURL).filter(Boolean), []);
    const files = [];
    for (const [i, u] of [...new Set(urls || [])].entries()) {
      try {
        const { bytes } = await fetchBytes(u, 8 * 1024 * 1024);
        files.push({ path: 'app/' + bundleFileName(u, i, 'js'), data: bytes, source: u });
      } catch (e) {
        ctx.problems.push('service worker ' + u + ': ' + e.message);
      }
    }
    return files;
  },
  async network(ctx) {
    if (!net.rows.size) throw new Error('skipped: no capture. Turn on Network capture, use the page, then export.');
    const rows = [...net.rows.values()].filter((r) => ['fetch', 'xhr', 'websocket', 'sse', 'beacon'].includes(r.kind));
    const full = [];
    for (const r of rows.slice(0, 400)) {
      try {
        full.push(ctx.mask ? redactEntry(await fullEntry(r.id)) : await fullEntry(r.id));
      } catch (_) {
        full.push(ctx.mask ? redactEntry(r) : r);
      }
    }
    const timing = Object.fromEntries(rows.filter((r) => r.timingRec).map((r) => [r.id, r.timingRec]));
    const files = [{ path: 'network/session.har', data: JSON.stringify(DFHar.toHar(full, { pageUrl: ctx.pageUrl, title: $('#target').textContent, version: chrome.runtime.getManifest().version, timing, startedAt: net.startedAt || Date.now() }), null, 2) }];
    full.forEach((e, i) => {
      if (typeof e.resBody !== 'string' || !e.resBody) return;
      const ct = String((e.resHeaders || {})['content-type'] || '');
      const ext = /json/i.test(ct) || /^\s*[[{]/.test(e.resBody) ? 'json' : /xml/i.test(ct) ? 'xml' : /html/i.test(ct) ? 'html' : 'txt';
      files.push({ path: 'network/responses/' + bundleFileName(e.url, i, ext).replace(/\.[a-z0-9]+$/, '') + '.' + ext, data: e.resBody, source: (e.method || 'GET') + ' ' + e.url });
    });
    return files;
  },
  async cookies(ctx) {
    return [{ path: 'storage/cookies.json', data: JSON.stringify(ctx.maskItems((await ctx.storage()).cookies), null, 2) }];
  },
  async local(ctx) {
    return [{ path: 'storage/local-storage.json', data: JSON.stringify(ctx.maskItems((await ctx.storage()).local.items), null, 2) }];
  },
  async session(ctx) {
    return [{ path: 'storage/session-storage.json', data: JSON.stringify(ctx.maskItems((await ctx.storage()).session.items), null, 2) }];
  },
  async idb(ctx) {
    const s = await ctx.storage();
    return [{ path: 'storage/indexeddb-and-caches.json', data: JSON.stringify({ origin: s.origin, indexedDB: s.indexedDB, caches: s.caches, serviceWorkers: s.serviceWorkers, quota: s.quota, note: 'Web SQL was removed from Chrome and cannot be exported.' }, null, 2) }];
  },
  async 'el-component'() {
    if (!DF.state.h) throw new Error('skipped: no element is selected');
    const r = await buildElementPackage(DF.state.h, { assets: false, scripts: false, forcePart: true });
    return r.files.map((f) => ({ path: 'element/' + f.path, data: f.data }));
  },
  async 'el-rules'() {
    return [{ path: 'element/resolved-rules.json', data: JSON.stringify(await call('css', DF.state.h), null, 2) }];
  },
  async 'el-computed'() {
    return [{ path: 'element/computed-styles.json', data: JSON.stringify(await call('computedAll', DF.state.h), null, 2) }];
  },
  async 'el-box'() {
    return [{ path: 'element/box-model-and-details.json', data: JSON.stringify(await call('describe', DF.state.h), null, 2) }];
  },
};

async function buildBundle(ids, wsIds, opts, onStep) {
  const ctx = {
    pageUrl: DF.state.url,
    mask: opts.mask !== false,
    cache: {},
    problems: [],
    notes: {},
    note: (k, v) => (ctx.notes[k] = v),
    resources: (() => {
      let p;
      return () => (p = p || call('siteResources').then((r) => (Array.isArray(r) ? r : r.resources || [])));
    })(),
    loaded: (() => {
      let p;
      return () => (p = p || exec(() => performance.getEntriesByType('resource').filter((e) => /^https?:/.test(e.name)).map((e) => ({ url: e.name.split('#')[0], type: e.initiatorType })), []).then((r) => r || []).catch(() => []));
    })(),
    storage: (() => {
      let p;
      return () => (p = p || call('storageDump'));
    })(),
    maskItems: (items) => (items || []).map((x) => (ctx.mask && isSensitiveKey(x.key) ? { ...x, value: '[redacted]' } : x)),
  };
  const labels = Object.fromEntries(BUNDLE_GROUPS.flatMap(([, list]) => list.map((x) => [x[0], x[1]])));
  const files = [];
  const report = [];
  let total = 0;
  for (const id of ids) {
    onStep && onStep('Collecting: ' + labels[id]);
    const before = ctx.problems.length;
    try {
      const got = await BUNDLE_RUN[id](ctx);
      let kept = 0;
      for (const f of got) {
        const size = typeof f.data === 'string' ? f.data.length : f.data.length || f.data.byteLength || 0;
        if (total + size > BUNDLE_MAX_TOTAL) {
          ctx.problems.push('size limit reached, not included: ' + f.path);
          continue;
        }
        total += size;
        files.push(f);
        kept++;
      }
      const notes = ctx.problems.slice(before);
      report.push({ id, item: labels[id], status: !got.length ? 'nothing found' : notes.length ? 'partial' : 'ok', files: kept, problems: notes });
    } catch (e) {
      report.push({ id, item: labels[id], status: /^skipped/.test(e.message) ? 'skipped' : 'failed', files: 0, problems: [e.message] });
    }
  }
  if (wsIds.length) {
    onStep && onStep('Collecting saved Workspace items');
    const all = await DFStore.allItems();
    let n = 0;
    for (const it of all.filter((x) => wsIds.includes(x.id))) {
      if (it.locked) {
        report.push({ id: 'ws:' + it.id, item: 'Workspace: ' + it.title, status: 'skipped', files: 0, problems: ['sealed: unlock Owner mode to export it'] });
        continue;
      }
      const base = 'workspace/' + String(++n).padStart(2, '0') + '-' + it.kind + '-' + (slug(it.title) || 'item');
      if (it.payload && it.payload.dataUrl && /^data:image\/png;base64,/.test(it.payload.dataUrl)) {
        const bin = atob(it.payload.dataUrl.split(',')[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        files.push({ path: base + '.png', data: bytes });
      } else files.push({ path: base + '.json', data: JSON.stringify(it, null, 2) });
      if (it.payload && it.payload.html != null) files.push({ path: base + '.html', data: it.payload.html });
      if (it.payload && it.payload.css != null) files.push({ path: base + '.css', data: it.payload.css });
      report.push({ id: 'ws:' + it.id, item: 'Workspace: ' + it.title, status: 'ok', files: 1, problems: [] });
    }
  }
  const manifest = { tool: 'DevForge ' + chrome.runtime.getManifest().version, page: opts.mask === false ? ctx.pageUrl : redactUrl(ctx.pageUrl), created: new Date().toISOString(), secretsMasked: ctx.mask, items: report, files: files.map((f) => ({ path: f.path, source: f.source || undefined, bytes: typeof f.data === 'string' ? f.data.length : f.data.length })) };
  files.unshift({ path: '_manifest.json', data: JSON.stringify(manifest, null, 2) }, { path: 'README.md', data: bundleReadme(manifest) });
  return { files, report, manifest };
}

function bundleReadme(m) {
  return '# DevForge page bundle\n\n- Page: ' + m.page + '\n- Created: ' + m.created + '\n- Secrets masked in storage and network data: ' + (m.secretsMasked ? 'yes' : 'NO (do not share this bundle)') + '\n\n## What was collected\n\n| Item | Result | Files |\n|---|---|---|\n' + m.items.map((i) => '| ' + i.item + ' | ' + i.status + ' | ' + i.files + ' |').join('\n') + '\n\n' + (m.items.some((i) => i.problems.length) ? '## Problems\n\n' + m.items.flatMap((i) => i.problems.map((p) => '- ' + i.item + ': ' + p)).join('\n') + '\n\n' : '') + 'Files that are not listed could not be read by a browser extension (server-side code, HttpOnly cookies, closed shadow roots, cross-origin frames). See _manifest.json for exact paths and sources.\n';
}

function bundleSection() {
  const picked = new Set();
  const wsPicked = new Set();
  const mask = h('input', { type: 'checkbox', id: 'bundle-mask', checked: true });
  const wsBox = h('div', { class: 'sev-info' }, 'Loading saved items…');
  const summary = h('div', { class: 'sev-info', role: 'status', 'aria-live': 'polite', id: 'bundle-count' });
  const boxes = [];
  const refresh = () => {
    const n = picked.size + wsPicked.size;
    summary.textContent = n ? n + ' item(s) selected' : 'Nothing selected yet';
    for (const b of buttons) b.disabled = !n;
  };
  const groupEl = ([title, list]) => {
    const disabled = (id) => id.startsWith('el-') && !DF.state.h;
    return h(
      'details',
      { class: 'card', open: title !== 'Selected element' },
      h('summary', null, title),
      list.map(([id, label, hint]) => {
        const cb = h('input', { type: 'checkbox', id: 'bundle-' + id, disabled: disabled(id), on: { change: (e) => { e.target.checked ? picked.add(id) : picked.delete(id); refresh(); } } });
        boxes.push(cb);
        return h('label', { class: 'sec-ack', for: 'bundle-' + id }, cb, h('span', null, ' ' + label, hint ? h('span', { class: 'sev-info' }, ' · ' + hint + (disabled(id) ? ' (select an element first)' : '')) : ''));
      })
    );
  };
  const run = async (mode) => {
    const ids = BUNDLE_GROUPS.flatMap(([, l]) => l.map((x) => x[0])).filter((id) => picked.has(id));
    const { files, report } = await busy('Building bundle', () => buildBundle(ids, [...wsPicked], { mask: mask.checked }, (m) => status(m + '…')));
    const host = (() => {
      try {
        return slug(new URL(DF.state.url).host);
      } catch (_) {
        return 'page';
      }
    })();
    const safe = await guardFiles(files.map((f) => ({ path: f.path, data: f.data })));
    if (!safe) return;
    if (mode === 'zip') {
      download('devforge-bundle-' + host + '-' + stamp() + '.zip', await DFZip.buildAsync(safe), 'application/zip');
    } else {
      // Separate files: the same names without folders, one download each.
      for (const [i, f] of safe.entries()) {
        const name = f.path.replace(/\//g, '__');
        download(name, f.data instanceof Uint8Array ? new Blob([f.data], { type: bundleType(name) }) : f.data, bundleType(name));
        if (i < safe.length - 1) await sleep(250);
      }
    }
    const bad = report.filter((r) => r.status === 'failed' || r.status === 'skipped' || r.status === 'partial');
    status(files.length - 2 + ' file(s) exported' + (bad.length ? '; ' + bad.length + ' item(s) incomplete: see _manifest.json (' + bad.map((b) => b.item + ': ' + b.status).join(', ') + ')' : '.'), bad.length ? '' : 'ok');
  };
  const buttons = [
    h('button', { class: 'primary', id: 'bundle-zip', disabled: true, on: { click: () => run('zip') } }, icon('download', 14), ' Download selected as one ZIP'),
    h('button', { id: 'bundle-files', disabled: true, title: 'Chrome may ask to allow multiple downloads', on: { click: () => run('files') } }, icon('download', 14), ' Download as separate files'),
  ];
  DFStore.allItems()
    .then((items) => {
      const list = items.filter((i) => !i.locked).sort((a, b) => b.created - a.created).slice(0, 60);
      clear(wsBox).append(
        ...(list.length
          ? list.map((it) => h('label', { class: 'sec-ack' }, h('input', { type: 'checkbox', class: 'bundle-ws', value: it.id, on: { change: (e) => { e.target.checked ? wsPicked.add(it.id) : wsPicked.delete(it.id); refresh(); } } }), ' ' + it.kind + ': ' + it.title))
          : ['No saved items yet (screenshots, reports, captures and snippets you save appear here).'])
      );
    })
    .catch(() => clear(wsBox).append('Saved items could not be read.'));
  const el = section(
    'Page bundle (pick what to export)',
    h('div', { class: 'sev-info' }, 'Choose one item or many. Download them together in one ZIP, or as separate files. A manifest lists what was collected and what could not be.'),
    h('div', { class: 'row' }, h('button', { id: 'bundle-all', on: { click: () => { for (const b of boxes) if (!b.disabled && !b.checked) { b.checked = true; b.dispatchEvent(new Event('change')); } } } }, 'Select all page items'), h('button', { on: { click: () => { for (const b of [...boxes, ...el.querySelectorAll('.bundle-ws')]) if (b.checked) { b.checked = false; b.dispatchEvent(new Event('change')); } } } }, 'Clear')),
    BUNDLE_GROUPS.map(groupEl),
    h('details', { class: 'card' }, h('summary', null, 'Saved in the Workspace (reports, screenshots, captures, snippets)'), wsBox),
    h('label', { class: 'sec-ack', for: 'bundle-mask' }, mask, ' Mask tokens, passwords and other secrets in storage and network data (recommended)'),
    summary,
    h('div', { class: 'row' }, buttons)
  );
  refresh();
  return el;
}
