function readme(c, meta) {
  return `# ${meta.title}\n\nExported by DevForge ${new Date().toISOString()} from ${meta.url}\n\n## What is in this export\n| Part | Provenance | Notes |\n|---|---|---|\n| index.html | ${c.provenance.html} | element subtree, scripts removed |\n| styles.css | ${c.provenance.css} | ${c.blockedSheets.length ? c.blockedSheets.length + ' stylesheet(s) were unreadable: ' + c.blockedSheets.join(', ') : 'all stylesheets readable'} |\n| script.js | ${c.provenance.scripts} | ${c.relatedScripts.length} inline script(s) mention this component |\n| assets/ | extracted | see assets.json for fetched / failed files |\n| (backend) | unavailable | server-side code and data are never exposed to a page |\n\n## Detected\n- Framework hints (inferred): ${c.framework.join(', ') || 'none'}\n- CSS variables: ${Object.keys(c.cssVariables).length}\n- Inline handler attributes: ${c.handlers.length}\n- External scripts on the page (not bundled): ${c.externalScripts.length}\n\n## Known gaps\n- Event listeners added via addEventListener cannot be listed by extensions.\n- Behaviour driven by external scripts is not included. Open \`script.js\` and the external list to decide what you need.\n`;
}
async function buildComponentZip(handle, opts) {
  const c = await call('collectComponent', handle, { stripHandlers: opts.stripHandlers !== false });
  const files = [];
  const assetMap = {},
    report = [];
  if (opts.assets) {
    const targets = c.assets.filter((x) => x.url && /^https?:|^data:/.test(x.url)).slice(0, 60);
    const perm = await ensureOrigins(
      targets.filter((a) => /^https?:/.test(a.url)).map((a) => a.url)
    );
    let i = 0;
    for (const a of targets) {
      try {
        if (a.url.startsWith('data:')) {
          report.push({ url: a.url.slice(0, 40) + '…', status: 'inline data URI (kept in place)' });
          continue;
        }
        if (blocksPrivate(a.url, DF.state.url)) {
          report.push({
            url: a.url,
            status: 'skipped: private/loopback address that the page is not itself on',
          });
          continue;
        }
        const { bytes, type } = await fetchBytes(a.url);
        if (bytes.length > 8 * 1024 * 1024) {
          report.push({ url: a.url, status: 'skipped: >8MB' });
          continue;
        }
        const extMatch = new URL(a.url).pathname.match(/\.(\w{2,5})$/);
        const ext = extMatch
          ? extMatch[1]
          : (type.split('/')[1] || 'bin').split(';')[0].replace('svg+xml', 'svg');
        const name = `assets/${a.type === 'font' ? 'fonts/' : ''}${(++i + '').padStart(2, '0')}-${
          slug(
            new URL(a.url).pathname
              .split('/')
              .pop()
              .replace(/\.\w+$/, '')
          ) || 'file'
        }.${ext}`;
        files.push({ path: name, data: bytes });
        assetMap[a.url] = name;
        report.push({ url: a.url, status: 'saved as ' + name });
      } catch (e) {
        report.push({
          url: a.url,
          status:
            'FAILED: ' +
            e.message +
            (perm.denied.length
              ? ' (site permission not granted; CORS blocks cross-origin fetches without it)'
              : ''),
        });
      }
    }
  }
  let html = c.html,
    css = c.css;
  for (const [u, local] of Object.entries(assetMap)) {
    html = html.split(u).join(local);
    css = css.split(u).join(local);
  }
  const doc = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${c.title.replace(/</g, '&lt;')} - component</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body style="margin:0">\n${html}\n${c.relatedScripts.length ? '<script src="script.js"></script>\n' : ''}</body>\n</html>\n`;
  files.unshift(
    { path: 'index.html', data: doc },
    {
      path: 'styles.css',
      data:
        `/* Page body context: background ${c.htmlStyleRoot.bodyBg}, font ${c.htmlStyleRoot.bodyFont}, color ${c.htmlStyleRoot.bodyColor} */\n` +
        css,
    }
  );
  if (c.relatedScripts.length)
    files.push({
      path: 'script.js',
      data: c.relatedScripts
        .map(
          (s) =>
            `/* inline script #${s.index}; matched on: ${s.matchedOn.join(', ')} (INFERRED relation) */\n${s.code}`
        )
        .join('\n\n'),
    });
  files.push(
    {
      path: 'assets.json',
      data: JSON.stringify({ assets: c.assets, fetchReport: report }, null, 2),
    },
    {
      path: 'data/meta.json',
      data: JSON.stringify(
        {
          url: c.base,
          framework: c.framework,
          cssVariables: c.cssVariables,
          externalScripts: c.externalScripts,
          handlers: c.handlers,
          confidence: c.confidence,
          provenance: c.provenance,
        },
        null,
        2
      ),
    }
  );
  files.push({ path: 'README.md', data: readme(c, { title: c.title, url: c.base }) });
  return { files, c, report };
}
async function developerReport() {
  const [pi, a11y, perf, sec, scripts, rm] = await Promise.all([
    call('pageInfo'),
    call('accessibilityAudit', null),
    call('performanceAudit'),
    call('securityAudit'),
    call('scriptsInfo'),
    call('resourceMap'),
  ]);
  const L = [];
  L.push(
    `# DevForge developer report\n\n- URL: ${pi.url}\n- Title: ${pi.title}\n- Generated: ${new Date().toISOString()}\n- DOM elements: ${pi.domCount}; shadow hosts: ${pi.shadowHosts}; iframes: ${pi.iframes.length} (${pi.iframes.filter((f) => !f.accessible).length} inaccessible)\n\n> Provenance legend: **observed** = read directly; **extracted** = copied from DOM/CSS; **inferred** = heuristic; **unavailable** = the browser does not expose it.\n`
  );
  L.push(
    `## Accessibility (observed + inferred)\n${a11y.summary.error} errors, ${a11y.summary.warn} warnings across ${a11y.checked} elements.\n\n` +
      a11y.issues
        .slice(0, 60)
        .map(
          (i) =>
            `- **${i.severity}** \`${i.rule}\` ${i.message}${i.selector ? ' - `' + i.selector + '`' : ''}`
        )
        .join('\n') +
      '\n\nLimits: ' +
      a11y.limits.join(' ')
  );
  L.push(
    `## Performance (observed)\n- DOM nodes ${perf.domCount}, depth ${perf.maxDepth}, resources ${perf.resourceCount}\n- Timing: ${JSON.stringify(perf.timing)}\n${perf.tips.map((t) => '- ' + t).join('\n')}\n\n${perf.note}`
  );
  L.push(
    `## Security (patterns only, not confirmed vulnerabilities)\n` +
      sec.issues
        .map(
          (i) => `- **${i.severity}** \`${i.rule}\` ${i.message}${i.detail ? ' - ' + i.detail : ''}`
        )
        .join('\n')
  );
  L.push(
    `## Scripts (observed)\n` +
      scripts.scripts
        .map(
          (s) =>
            `- ${s.kind} ${s.src || '(inline, ' + s.size + ' chars)'}${s.minified.value === true ? ' [looks minified - inferred]' : ''}`
        )
        .join('\n') +
      `\n\nAvailability: ${JSON.stringify(scripts.availability)}`
  );
  L.push(
    `## Resource map summary (observed)\n${rm.nodes.length} nodes, ${rm.edges.length} edges. External hosts: ${[...new Set(rm.nodes.filter((n) => n.external).map((n) => new URL(n.id).host))].join(', ') || 'none'}`
  );
  return L.join('\n\n');
}
registerTab('export', 'Export', async (v) => {
  const sel = DF.state.h;
  const optAssets = h('input', { type: 'checkbox', id: 'opt-assets', checked: true }),
    optSave = h('input', { type: 'checkbox', id: 'opt-save' });
  v.append(
    section(
      'Selected component',
      sel
        ? h('div', { class: 'sev-info mono' }, DF.state.info.selectors[0].selector)
        : needsSelection(),
      h(
        'div',
        { class: 'row' },
        h('label', null, optAssets, ' fetch assets (images/fonts; asks for site permission)'),
        h('label', null, optSave, ' also save to workspace')
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            disabled: !sel,
            on: {
              click: async () => {
                try {
                  const { files, c } = await busy('Building component ZIP', () =>
                    buildComponentZip(sel, { assets: optAssets.checked })
                  );
                  const zip = DFZip.build(
                    files.map((f) => ({ path: 'component/' + f.path, data: f.data }))
                  );
                  download(
                    'component-' +
                      slug(DF.state.info.selectors[0].selector) +
                      '-' +
                      stamp() +
                      '.zip',
                    zip,
                    'application/zip'
                  );
                  if (optSave.checked)
                    await saveToWorkspace('component', DF.state.info.selectors[0].selector, {
                      html: c.html,
                      css: c.css,
                    });
                  status(
                    `ZIP: ${files.length} files, ${c.blockedSheets.length} unreadable stylesheet(s). See README.md in the ZIP.`,
                    'ok'
                  );
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          'Component ZIP (HTML+CSS+JS+assets)'
        ),
        h(
          'button',
          {
            disabled: !sel,
            on: {
              click: async () => {
                const c = await call('collectComponent', sel);
                download('element.html', c.html, 'text/html');
              },
            },
          },
          'HTML'
        ),
        h(
          'button',
          {
            disabled: !sel,
            on: {
              click: async () => {
                const c = await call('collectComponent', sel);
                download('element.css', c.css, 'text/css');
              },
            },
          },
          'CSS'
        ),
        h(
          'button',
          {
            disabled: !sel,
            on: {
              click: async () => {
                const c = await call('collectComponent', sel);
                download(
                  'element-meta.json',
                  JSON.stringify(
                    {
                      url: c.base,
                      framework: c.framework,
                      cssVariables: c.cssVariables,
                      handlers: c.handlers,
                      assets: c.assets,
                      confidence: c.confidence,
                      provenance: c.provenance,
                    },
                    null,
                    2
                  ),
                  'application/json'
                );
              },
            },
          },
          'Metadata JSON'
        )
      )
    ),
    section(
      'Whole page',
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: async () =>
                download('page-' + stamp() + '.html', await call('fullDom'), 'text/html'),
            },
          },
          'Complete DOM (HTML)'
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                const r = await call('resourceMap');
                download(
                  'resources-' + stamp() + '.json',
                  JSON.stringify(r, null, 2),
                  'application/json'
                );
              },
            },
          },
          'Resource list (JSON)'
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                const r = await call('extractData', 'metadata');
                download('metadata.json', JSON.stringify(r, null, 2), 'application/json');
              },
            },
          },
          'Metadata'
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                const s = await call('scriptsInfo');
                download('scripts.json', JSON.stringify(s, null, 2), 'application/json');
              },
            },
          },
          'Scripts list'
        ),
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: async () => {
                try {
                  const md = await busy('Running all audits', developerReport);
                  download('devforge-report-' + stamp() + '.md', md, 'text/markdown');
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          'Developer report (MD)'
        )
      )
    ),
    section(
      'Project export',
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: async () => {
                const ps = await DFStore.listProjects();
                const p = ps.find((x) => x.id === DF.state.project) || ps[0];
                if (!p) return toast('No project yet - create one in Workspace.');
                const items = await DFStore.listItems(p.id);
                const files = [
                  {
                    path: 'project.json',
                    data: JSON.stringify({ project: p, count: items.length }, null, 2),
                  },
                ];
                items.forEach((it, i) => {
                  const base = `items/${(i + 1 + '').padStart(3, '0')}-${it.kind}-${slug(it.title)}`;
                  if (it.payload && it.payload.html != null)
                    files.push({ path: base + '/index.html', data: it.payload.html });
                  if (it.payload && it.payload.css != null)
                    files.push({ path: base + '/styles.css', data: it.payload.css });
                  files.push({ path: base + '/item.json', data: JSON.stringify(it, null, 2) });
                });
                download(
                  'project-' + slug(p.name) + '-' + stamp() + '.zip',
                  DFZip.build(files),
                  'application/zip'
                );
              },
            },
          },
          'Current workspace project (ZIP)'
        )
      )
    ),
    section(
      'Screenshots',
      h(
        'div',
        { class: 'row' },
        h('button', { on: { click: () => shot('visible') } }, 'Visible area'),
        h('button', { disabled: !sel, on: { click: () => shot('element') } }, 'Selected element'),
        h('button', { on: { click: () => shot('full') } }, 'Full page (stitched)')
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Full page stitches scrolled captures; fixed/sticky headers can repeat and very long pages are capped at 20 screens. Uses the activeTab permission only.'
      ),
      h('div', { id: 'shot-out' })
    ),
    section(
      'Before / after pixel diff',
      h(
        'div',
        { class: 'row' },
        h('button', { on: { click: () => snapshot('before') } }, '1. Snapshot "before"'),
        h('button', { on: { click: () => snapshot('after') } }, '2. Snapshot "after"'),
        h('button', { on: { click: pixelDiff } }, '3. Compare')
      ),
      h('div', { id: 'diff-out' })
    )
  );
});
async function capture() {
  const t = await activeTab();
  try {
    return await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
  } catch (e) {
    if (/all_urls|activeTab|permission/i.test(e.message))
      throw new Error(
        'Screenshots need permission for this tab. ' +
          NO_ACCESS_MSG.replace('DevForge has no access to this tab right now. ', '')
      );
    throw e;
  }
}
const loadImg = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('image decode failed'));
    i.src = src;
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(mode) {
  try {
    await ensureAgent();
    const out = clear($('#shot-out'));
    let canvas;
    if (mode === 'visible') {
      const img = await loadImg(await capture());
      canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
    } else if (mode === 'element') {
      const info = await call('select', DF.state.h);
      const box = await exec(
        (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
            dpr: devicePixelRatio,
            vh: innerHeight,
            vw: innerWidth,
          };
        },
        [info.selectors.find((s) => s.kind !== 'xpath' && s.kind !== 'xpath-text').selector]
      );
      if (!box) throw new Error('Element not found for capture.');
      await call('clearHighlight');
      await sleep(250);
      const img = await loadImg(await capture());
      const sx = img.width / box.vw;
      const cx = Math.max(0, box.x * sx),
        cy = Math.max(0, box.y * sx),
        cw = Math.min(img.width - cx, box.w * sx),
        ch = Math.min(img.height - cy, box.h * sx);
      if (cw < 1 || ch < 1) throw new Error('Element is empty or outside the viewport.');
      canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
      if (box.h > box.vh)
        out.append(
          h(
            'div',
            { class: 'sev-warn' },
            'Element is taller than the viewport; only the visible part was captured.'
          )
        );
    } else {
      const m = await exec(() => ({
        sh: document.documentElement.scrollHeight,
        vh: innerHeight,
        vw: innerWidth,
        dpr: devicePixelRatio,
        sy: scrollY,
      }));
      const n = Math.min(20, Math.ceil(m.sh / m.vh));
      const parts = [];
      for (let i = 0; i < n; i++) {
        const y = Math.min(i * m.vh, Math.max(0, m.sh - m.vh));
        await exec((yy) => window.scrollTo(0, yy), [y]);
        await sleep(350);
        const img = await loadImg(await capture());
        parts.push({ img, y });
      }
      await exec((yy) => window.scrollTo(0, yy), [m.sy]);
      const s = parts[0].img.width / m.vw;
      canvas = document.createElement('canvas');
      canvas.width = parts[0].img.width;
      canvas.height = Math.min(m.sh, n * m.vh) * s;
      const ctx = canvas.getContext('2d');
      parts.forEach((p) => ctx.drawImage(p.img, 0, p.y * s));
      if (n * m.vh < m.sh)
        out.append(
          h('div', { class: 'sev-warn' }, 'Page is longer than 20 screens; the bottom was cut off.')
        );
    }
    const url = canvas.toDataURL('image/png');
    out.append(
      h('img', { src: url, style: { maxWidth: '100%', border: '1px solid var(--bd)' } }),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: () =>
                canvas.toBlob((b) => download('screenshot-' + mode + '-' + stamp() + '.png', b)),
            },
          },
          'Download PNG'
        ),
        h(
          'button',
          {
            on: {
              click: () => saveToWorkspace('screenshot', mode + ' screenshot', { dataUrl: url }),
            },
          },
          'Save to workspace'
        )
      )
    );
  } catch (e) {
    status(e.message, 'err');
    toast(e.message);
  }
}
const snaps = {};
async function snapshot(which) {
  try {
    const img = await loadImg(await capture());
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    snaps[which] = c;
    toast(which + ' snapshot taken (' + img.width + '×' + img.height + ')');
  } catch (e) {
    toast(e.message);
  }
}
function pixelDiff() {
  const out = clear($('#diff-out'));
  if (!snaps.before || !snaps.after)
    return out.append(
      h(
        'div',
        { class: 'sev-warn' },
        'Take both snapshots first (keep the page at the same scroll position and size).'
      )
    );
  const a = snaps.before,
    b = snaps.after;
  if (a.width !== b.width || a.height !== b.height)
    return out.append(
      h(
        'div',
        { class: 'sev-error' },
        `Snapshot sizes differ (${a.width}×${a.height} vs ${b.width}×${b.height}); resize the window back and retake.`
      )
    );
  const da = a.getContext('2d').getImageData(0, 0, a.width, a.height),
    db = b.getContext('2d').getImageData(0, 0, b.width, b.height);
  const c = document.createElement('canvas');
  c.width = a.width;
  c.height = a.height;
  const cx = c.getContext('2d');
  const od = cx.createImageData(a.width, a.height);
  let diff = 0;
  const total = a.width * a.height;
  for (let i = 0; i < da.data.length; i += 4) {
    const d =
      Math.abs(da.data[i] - db.data[i]) +
      Math.abs(da.data[i + 1] - db.data[i + 1]) +
      Math.abs(da.data[i + 2] - db.data[i + 2]);
    if (d > 24) {
      diff++;
      od.data[i] = 255;
      od.data[i + 1] = 40;
      od.data[i + 2] = 80;
      od.data[i + 3] = 255;
    } else {
      od.data[i] = da.data[i];
      od.data[i + 1] = da.data[i + 1];
      od.data[i + 2] = da.data[i + 2];
      od.data[i + 3] = 70;
    }
  }
  cx.putImageData(od, 0, 0);
  out.append(
    h(
      'div',
      null,
      `${((diff / total) * 100).toFixed(2)}% of pixels differ (${diff.toLocaleString()} of ${total.toLocaleString()}; threshold 24/765 per pixel)`
    ),
    h('img', { src: c.toDataURL(), style: { maxWidth: '100%', border: '1px solid var(--bd)' } })
  );
}
