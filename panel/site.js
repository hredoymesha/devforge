// Site tab: scan the page, then download its code and assets (HTML snapshot, CSS, JS,
// source maps, images, fonts) as one ZIP.
const siteS = { scan: null, cancel: false, running: false, tech: [] };
const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const fmtBytes = (n) =>
  n > 1048576
    ? (n / 1048576).toFixed(1) + ' MB'
    : n > 1024
      ? Math.round(n / 1024) + ' KB'
      : n + ' B';
const TECH_URL = [
  [/jquery/i, 'jQuery'],
  [/react(\.|-dom|\/)/i, 'React'],
  [/vue(\.|\/)/i, 'Vue'],
  [/angular/i, 'Angular'],
  [/bootstrap/i, 'Bootstrap'],
  [/tailwind/i, 'Tailwind CSS'],
  [/\/_next\//, 'Next.js'],
  [/\/_nuxt\//, 'Nuxt'],
  [/gatsby/i, 'Gatsby'],
  [/wp-content|wp-includes/, 'WordPress'],
  [/cdn\.shopify|shopify/i, 'Shopify'],
  [/googletagmanager|google-analytics|gtag/i, 'Google Analytics/Tag Manager'],
  [/fonts\.googleapis|fonts\.gstatic/, 'Google Fonts'],
  [/cloudflare/i, 'Cloudflare'],
  [/webpack/i, 'webpack bundle'],
  [/\bsvelte/i, 'Svelte'],
  [/htmx/i, 'htmx'],
  [/alpine/i, 'Alpine.js'],
  [/stripe\.com|js\.stripe/i, 'Stripe'],
  [/lodash/i, 'lodash'],
  [/d3(\.v\d|\.min|\/)/i, 'D3'],
  [/three(\.min|\.module|\/)/i, 'three.js'],
  [/gsap|greensock/i, 'GSAP'],
];
async function detectTech(scan) {
  const found = new Map();
  const add = (n, ev) => {
    if (!found.has(n)) found.set(n, []);
    found.get(n).push(ev);
  };
  scan.resources.forEach((r) =>
    TECH_URL.forEach(([re, n]) => {
      if (re.test(r.url)) add(n, 'resource URL');
    })
  );
  if (scan.metaGenerator) add('Generator: ' + scan.metaGenerator, 'meta generator tag');
  try {
    const g = await exec(
      () => {
        const o = {};
        const t = (k, f) => {
          try {
            if (f()) o[k] = 1;
          } catch (_) {}
        };
        t('React', () => window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__);
        t('Vue', () => window.Vue || window.__VUE__);
        t('jQuery', () => window.jQuery);
        t('Angular', () => window.ng || window.getAllAngularRootElements);
        t('Next.js', () => window.__NEXT_DATA__);
        t('Nuxt', () => window.__NUXT__);
        t('Shopify', () => window.Shopify);
        t('Alpine.js', () => window.Alpine);
        t('htmx', () => window.htmx);
        t('Backbone', () => window.Backbone);
        t('D3', () => window.d3);
        t('three.js', () => window.THREE);
        t('GSAP', () => window.gsap);
        t('Google Analytics/Tag Manager', () => window.dataLayer || window.ga);
        return o;
      },
      [],
      'MAIN'
    );
    Object.keys(g || {}).forEach((k) => add(k, 'page global (MAIN world)'));
  } catch (_) {
    /* restricted: URL evidence only */
  }
  return [...found.entries()].map(([name, ev]) => ({
    name,
    evidence: [...new Set(ev)].join(', '),
  }));
}
async function scanSite() {
  const scan = await call('siteResources');
  let captured = [];
  try {
    captured =
      (await exec(
        () =>
          window.__dfNet
            ? window.__dfNet.log
                .filter(
                  (x) =>
                    (x.kind === 'fetch' || x.kind === 'xhr') &&
                    typeof x.resBody === 'string' &&
                    x.status >= 200 &&
                    x.status < 300
                )
                .map((x) => ({
                  method: x.method,
                  url: x.url,
                  status: x.status,
                  body: x.resBody.slice(0, 200000),
                  reqBody: x.reqBody,
                }))
            : [],
        [],
        'MAIN'
      )) || [];
  } catch (_) {}
  scan.captured = captured;
  scan.host = new URL(scan.page).hostname;
  scan.resources.forEach((r) => {
    r.third = DFSite.isThirdParty(r.url, scan.host);
  });
  siteS.scan = scan;
  siteS.tech = await detectTech(scan);
  return scan;
}

async function runSiteDownload(opts, ui) {
  const scan = siteS.scan,
    pageUrl = scan.page,
    pageOrigin = new URL(pageUrl).origin,
    pageHost = new URL(pageUrl).hostname;
  const LIM = { files: 1500, total: 150 * 1048576, file: 25 * 1048576, inPage: 8 * 1048576 };
  const used = new Map(),
    okMap = new Map(),
    seen = new Set(),
    queue = [],
    files = [],
    report = [],
    fetched = new Map();
  const counts = { saved: 0, failed: 0, skipped: 0, mapFiles: 0 };
  let total = 0,
    inflight = 0,
    idx = 0,
    capHit = false;
  const allow = (k) =>
    ['html', 'css', 'js', 'json', 'map', 'wasm', 'data'].includes(k)
      ? true
      : k === 'image'
        ? opts.images
        : k === 'font'
          ? opts.fonts
          : k === 'media'
            ? opts.media
            : k === 'api'
              ? false
              : opts.other;
  const skip = (url, kind, why) => {
    counts.skipped++;
    if (report.length < 3000) report.push({ url, kind, status: 'skipped', reason: why });
  };
  const enqueue = (url, kind, via) => {
    let n;
    try {
      n = DFSite.norm(url);
    } catch (_) {
      return;
    }
    if (!n || !/^https?:/i.test(n) || seen.has(n)) return;
    seen.add(n);
    kind = kind && kind !== 'other' ? kind : DFSite.kindFromUrl(n) || 'other';
    if (!allow(kind))
      return skip(
        n,
        kind,
        kind === 'api'
          ? 'API/XHR URL: not re-requested (see captured responses)'
          : 'excluded by options (' + kind + ')'
      );
    if (!opts.thirdParty && DFSite.isThirdParty(n, pageHost))
      return skip(n, kind, 'third-party excluded by options');
    if (queue.length >= LIM.files) {
      capHit = true;
      return skip(n, kind, 'file-count cap (' + LIM.files + ')');
    }
    const path = DFSite.urlToPath(n, used);
    queue.push({ url: n, kind, path, via });
  };
  scan.resources.forEach((r) => enqueue(r.url, r.kind, (r.via || [])[0]));
  if (opts.originalHtml) enqueue(pageUrl, 'html', 'page');
  ui.update({ total: queue.length, done: 0, bytes: 0, current: 'starting…' });

  async function fetchOne(it) {
    const sameOrigin = new URL(it.url).origin === pageOrigin;
    if (!sameOrigin && blocksPrivate(it.url, pageUrl))
      throw new Error('blocked: private/loopback address the page itself is not on');
    if (sameOrigin) {
      try {
        const r = await call('fetchInPage', it.url, LIM.inPage);
        if (!r.ok) {
          const e = new Error('HTTP ' + r.status);
          e.http = true;
          throw e;
        }
        return { bytes: b64ToBytes(r.b64), type: r.type };
      } catch (e) {
        if (e.http) throw e; /* too large / transient: retry via the extension with host access */
      }
    }
    return await fetchBytes(it.url, LIM.file);
  }
  const dec = new TextDecoder('utf-8'),
    enc = new TextEncoder();
  async function handle(it) {
    ui.update({ current: it.url });
    let r;
    try {
      r = await fetchOne(it);
    } catch (e) {
      counts.failed++;
      report.push({
        url: it.url,
        kind: it.kind,
        status: 'failed',
        reason:
          e.message +
          (!/HTTP|blocked|too large|timed out/.test(e.message)
            ? ' (no site permission for this origin, or blocked by the network)'
            : ''),
      });
      return;
    }
    if (total + r.bytes.length > LIM.total) {
      capHit = true;
      return skip(it.url, it.kind, 'total size cap (' + fmtBytes(LIM.total) + ')');
    }
    total += r.bytes.length;
    counts.saved++;
    okMap.set(it.url, it.path);
    files.push({ path: it.path, data: r.bytes });
    report.push({
      url: it.url,
      path: it.path,
      kind: it.kind,
      status: 'saved',
      bytes: r.bytes.length,
      via: it.via,
    });
    if (it.kind === 'css' || it.kind === 'js' || it.kind === 'html' || it.kind === 'map') {
      const text = r.bytes.length < 12e6 ? dec.decode(r.bytes) : '';
      if (it.kind === 'css') {
        fetched.set(it.url, { text, path: it.path, kind: 'css' });
        DFSite.discoverCssUrls(text, it.url).forEach((u) => enqueue(u, null, 'css:' + it.path));
      }
      if (it.kind === 'html') fetched.set(it.url, { text, path: it.path, kind: 'html' });
      if ((it.kind === 'css' || it.kind === 'js') && opts.sourceMaps) {
        const ref = DFSite.sourceMapUrlOf(text);
        if (ref) {
          if (/^data:application\/json/i.test(ref)) {
            try {
              const j = decodeURIComponent(ref.split(',').slice(1).join(','));
              extractMap(j.startsWith('{') ? j : atob(j), it.path + '.inline-map');
            } catch (_) {}
          } else {
            try {
              enqueue(new URL(ref, it.url).href, 'map', 'sourceMappingURL of ' + it.path);
            } catch (_) {}
          }
        }
      }
      if (it.kind === 'map' && opts.sourceMaps) extractMap(text, it.path);
    }
  }
  function extractMap(text, mapPath) {
    const res = DFSite.mapSources(text, mapPath);
    const dir = '_sourcemaps/' + DFSite.sanitizePath(mapPath.replace(/^site\//, ''));
    res.files.forEach((f) => {
      files.push({ path: dir + '/' + f.path, data: enc.encode(f.content) });
      counts.mapFiles++;
      total += f.content.length;
    });
    report.push({
      url: mapPath,
      kind: 'sourcemap',
      status: res.error ? 'failed' : 'extracted',
      reason:
        res.error ||
        res.files.length +
          ' original source file(s) with embedded content; ' +
          res.skippedNoContent +
          ' listed without content',
      path: dir,
    });
  }

  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      if (siteS.cancel) return;
      const it = queue[idx];
      if (!it) {
        if (inflight === 0) return;
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      idx++;
      inflight++;
      try {
        await handle(it);
      } catch (e) {
        counts.failed++;
        report.push({
          url: it.url,
          kind: it.kind,
          status: 'failed',
          reason: 'internal: ' + e.message,
        });
      } finally {
        inflight--;
        ui.update({ done: counts.saved + counts.failed, total: queue.length, bytes: total });
      }
    }
  });
  await Promise.all(workers);
  const cancelled = siteS.cancel;

  // rewrite phase: only URLs that were actually saved are rewritten
  let rewrittenCss = 0;
  for (const [url, f] of fetched) {
    if (f.kind === 'css' && f.text) {
      const out = DFSite.rewriteCss(f.text, url, f.path, okMap);
      if (out !== f.text) rewrittenCss++;
      const e = files.find((x) => x.path === f.path);
      if (e) e.data = enc.encode(out);
    } else if (f.kind === 'html' && f.text && url !== DFSite.norm(pageUrl)) {
      const out = DFSite.rewriteHtml(f.text, url, f.path, okMap).html;
      const e = files.find((x) => x.path === f.path);
      if (e) e.data = enc.encode(out);
    }
  }
  const extra = [];
  let snapshot = null;
  try {
    const dom = await call('fullDom', !!opts.keepScripts);
    const rw = DFSite.rewriteHtml(dom, scan.base, 'index.html', okMap);
    snapshot = rw.rewritten;
    extra.push({ path: 'index.html', data: enc.encode(rw.html) });
  } catch (e) {
    report.push({ url: pageUrl, kind: 'snapshot', status: 'failed', reason: e.message });
  }
  if (opts.originalHtml) {
    const o = fetched.get(DFSite.norm(pageUrl));
    if (o) {
      const i = files.findIndex((x) => x.path === o.path);
      if (i >= 0) {
        extra.push({ path: '_original/page.html', data: files[i].data });
        files.splice(i, 1);
      }
    }
  }
  scan.inlineScripts.forEach((s, i) =>
    extra.push({
      path:
        'inline/script-' + String(i + 1).padStart(3, '0') + (s.type === 'module' ? '.mjs' : '.js'),
      data: enc.encode((s.truncated ? '/* truncated at 2 MB */\n' : '') + s.code),
    })
  );
  scan.inlineStyles.forEach((s, i) =>
    extra.push({
      path: 'inline/style-' + String(i + 1).padStart(3, '0') + '.css',
      data: enc.encode(s.css),
    })
  );
  if (opts.api && scan.captured.length)
    scan.captured.forEach((c, i) => {
      const body = redactBody(c.body);
      const nm = DFSite.sanitizePath(new URL(c.url).host + new URL(c.url).pathname)
        .replace(/\//g, '_')
        .slice(0, 60);
      extra.push({
        path:
          '_captured-api/' + String(i + 1).padStart(3, '0') + '-' + c.method + '-' + nm + '.txt',
        data: enc.encode(
          'URL: ' +
            redactUrl(c.url) +
            '\nMETHOD: ' +
            c.method +
            '\nSTATUS: ' +
            c.status +
            '\n(secrets redacted; body truncated at 200 KB)\n\n' +
            body
        ),
      });
    });
  const summary = {
    generatedAt: new Date().toISOString(),
    page: pageUrl,
    cancelled,
    counts,
    totalBytes: total,
    capsHit: capHit,
    snapshotLinksRewritten: snapshot,
    cssFilesRewritten: rewrittenCss,
    technologiesInferred: siteS.tech,
    options: opts,
  };
  extra.push({
    path: '_devforge/report.json',
    data: enc.encode(JSON.stringify({ summary, resources: report }, null, 2)),
  });
  extra.push({
    path: 'README.txt',
    data: enc.encode(
      `DevForge site export\nSource: ${pageUrl}\nCreated: ${summary.generatedAt}${cancelled ? '\nSTATUS: CANCELLED (partial)' : ''}\n\nWHAT IS HERE\n  index.html            Snapshot of the page as currently rendered (observed DOM). Links to downloaded files are rewritten to local paths; navigation links still point to the live site.${opts.keepScripts ? "\n                        Scripts are KEPT, so opening it runs the site's own JavaScript; it may contact the original servers." : '\n                        Scripts were removed from the snapshot.'}\n  site/<host>/...       Every downloaded resource, mirrored by URL (query strings become ~hash suffixes).\n  _original/page.html   The HTML exactly as the server returned it (before JavaScript ran).\n  inline/               Inline <script> and <style> blocks.\n  _sourcemaps/          Original source files recovered from source maps, ONLY where a map was published with embedded sources.\n  _captured-api/        API responses seen while Network capture was on (secrets redacted). Nothing was re-requested.\n  _devforge/report.json Every resource: saved / failed / skipped, with reasons.\n\nWHAT CANNOT BE HERE\n  Server-side code (PHP, SQL, etc.), private APIs, credentials, content that was never requested by this page, and original sources when no source map is published.\n  Resources loaded later by user actions or lazy loading are only included if already requested/discoverable.\n\nUse only on sites you are allowed to copy. The snapshot may contain personal data you can see in your session.\n`
    ),
  });
  return { files: [...extra, ...files], summary, report };
}

registerTab('site', 'Site', async (v) => {
  const out = h('div'),
    prog = h('div');
  const O = {
    images: true,
    fonts: true,
    media: false,
    other: false,
    thirdParty: true,
    sourceMaps: true,
    keepScripts: true,
    originalHtml: true,
    api: true,
  };
  const optRow = h(
    'div',
    { class: 'row' },
    [
      ['images', 'images'],
      ['fonts', 'fonts'],
      ['media', 'audio/video (large)'],
      ['other', 'unknown types'],
      ['thirdParty', 'third-party hosts'],
      ['sourceMaps', 'extract source maps'],
      ['keepScripts', 'keep scripts in snapshot'],
      ['originalHtml', 'original HTML'],
      ['api', 'captured API responses'],
    ].map(([k, l]) =>
      h(
        'label',
        null,
        h('input', {
          type: 'checkbox',
          checked: O[k],
          on: { change: (e) => (O[k] = e.target.checked) },
        }),
        ' ' + l
      )
    )
  );
  const draw = () => {
    clear(out);
    const s = siteS.scan;
    if (!s) return;
    const byKind = {};
    s.resources.forEach((r) => {
      const k = (byKind[r.kind] = byKind[r.kind] || { n: 0, third: 0 });
      k.n++;
      if (r.third) k.third++;
    });
    out.append(
      h(
        'div',
        { class: 'sev-info' },
        `${s.resources.length} resource URL(s) discovered (DOM + readable CSS + Performance entries), ${s.inlineScripts.length} inline script(s), ${s.inlineStyles.length} inline style block(s). Observed, not exhaustive: lazy-loaded files not yet requested are not listed.`
      ),
      table(
        ['Kind', 'URLs', 'Third-party'],
        Object.entries(byKind)
          .sort((a, b) => b[1].n - a[1].n)
          .map(([k, x]) => [k, x.n, x.third])
      ),
      s.unreadableSheets.length
        ? h(
            'div',
            { class: 'sev-warn' },
            s.unreadableSheets.length +
              ' cross-origin stylesheet(s) have unreadable rules; they are still downloaded as files, which also reveals their @imports and fonts.'
          )
        : '',
      siteS.tech.length
        ? h(
            'div',
            null,
            h('h2', null, 'Technologies ', tagEl('inferred')),
            table(
              ['Name', 'Evidence'],
              siteS.tech.map((t) => [t.name, t.evidence])
            )
          )
        : '',
      s.captured.length
        ? h(
            'div',
            { class: 'sev-info' },
            s.captured.length +
              ' API response(s) from Network capture can be included (nothing is re-requested).'
          )
        : h(
            'div',
            { class: 'sev-info' },
            'Tip: enable Network capture first, reload/interact, to include the API responses your page received.'
          )
    );
  };
  v.append(
    h(
      'div',
      { class: 'card sev-warn' },
      h('b', null, 'What this does: '),
      'finds every file this page uses and downloads it from where it came from. It cannot see server-side code. Where a site publishes source maps, original unminified sources are recovered. Use only on sites you are allowed to copy; the snapshot contains whatever you can see in your session.'
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          on: {
            click: async () => {
              clear(out).append(loading('Scanning page'));
              try {
                await scanSite();
                draw();
              } catch (e) {
                clear(out).append(h('div', { class: 'card sev-error' }, e.message));
              }
            },
          },
        },
        'Scan this page'
      ),
      h('span', { class: 'sev-info' }, 'Step 1')
    ),
    section(
      'Options',
      optRow,
      h(
        'div',
        { class: 'sev-info' },
        'Limits: 1500 files, 25 MB per file, 150 MB total. Cross-origin files need site permission (asked once, for the hosts involved). Private/loopback addresses the page is not itself on are never fetched.'
      )
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          id: 'site-go',
          on: {
            click: async (e) => {
              if (siteS.running) return;
              try {
                if (!siteS.scan) {
                  clear(out).append(loading('Scanning page'));
                  await scanSite();
                  draw();
                }
                const hosts = siteS.scan.resources
                  .filter((r) => O.thirdParty || !r.third)
                  .map((r) => r.url);
                const perm = await ensureOrigins(
                  hosts.filter((u) => new URL(u).origin !== new URL(siteS.scan.page).origin)
                );
                siteS.running = true;
                siteS.cancel = false;
                e.target.disabled = true;
                $('#site-cancel').disabled = false;
                const bar = h('div', { class: 'bar' }, h('i', { style: { width: '0%' } })),
                  line = h('div', { class: 'mono sev-info' }, ''),
                  stat = h('div', null, '');
                clear(prog).append(stat, bar, line);
                let last = 0;
                const ui = {
                  st: { done: 0, total: 0, bytes: 0, current: '' },
                  update(p) {
                    Object.assign(this.st, p);
                    const n = Date.now();
                    if (n - last < 120) return;
                    last = n;
                    stat.textContent = `${this.st.done} / ${this.st.total} files · ${fmtBytes(this.st.bytes)}`;
                    bar.firstChild.style.width =
                      (this.st.total ? Math.min(100, (this.st.done / this.st.total) * 100) : 0) +
                      '%';
                    line.textContent = this.st.current.slice(0, 120);
                  },
                };
                const res = await runSiteDownload(O, ui);
                const zip = DFZip.build(res.files);
                download(
                  'site-' + slug(siteS.scan.host) + '-' + stamp() + '.zip',
                  zip,
                  'application/zip'
                );
                const c = res.summary.counts,
                  fails = res.report.filter((r) => r.status === 'failed'),
                  skips = res.report.filter((r) => r.status === 'skipped');
                clear(prog).append(
                  h(
                    'div',
                    { class: c.failed ? 'sev-warn' : 'sev-ok' },
                    `${res.summary.cancelled ? 'CANCELLED (partial). ' : ''}Saved ${c.saved} file(s) (${fmtBytes(res.summary.totalBytes)}), ${c.mapFiles} original source file(s) from source maps, ${c.failed} failed, ${c.skipped} skipped. ZIP: ${res.files.length} entries.`
                  ),
                  perm.denied.length
                    ? h(
                        'div',
                        { class: 'sev-warn' },
                        'Site permission not granted for: ' +
                          perm.denied.join(', ') +
                          ' - those hosts will show as failed.'
                      )
                    : '',
                  res.summary.capsHit
                    ? h(
                        'div',
                        { class: 'sev-warn' },
                        'A size/count cap was reached; see report.json.'
                      )
                    : '',
                  fails.length
                    ? h(
                        'details',
                        { open: true },
                        h('summary', null, fails.length + ' failed'),
                        table(
                          ['URL', 'Reason'],
                          fails.slice(0, 100).map((f) => [mono(f.url.slice(0, 100)), f.reason])
                        )
                      )
                    : '',
                  skips.length
                    ? h(
                        'details',
                        null,
                        h('summary', null, skips.length + ' skipped'),
                        table(
                          ['URL', 'Reason'],
                          skips.slice(0, 100).map((f) => [mono(f.url.slice(0, 100)), f.reason])
                        )
                      )
                    : ''
                );
              } catch (err) {
                clear(prog).append(h('div', { class: 'card sev-error' }, err.message));
                status(err.message, 'err');
              } finally {
                siteS.running = false;
                e.target.disabled = false;
                const cb = $('#site-cancel');
                if (cb) cb.disabled = true;
              }
            },
          },
        },
        '⬇ Download all site code (ZIP)'
      ),
      h(
        'button',
        {
          id: 'site-cancel',
          disabled: true,
          class: 'danger',
          on: {
            click: () => {
              siteS.cancel = true;
              toast('Cancelling after in-flight files finish…');
            },
          },
        },
        'Cancel'
      ),
      h('span', { class: 'sev-info' }, 'Step 2')
    ),
    prog,
    out
  );
  if (siteS.scan) draw();
});
