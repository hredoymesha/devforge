// Export → Selected part: everything that can be read about one part of the page, as separate
// files (HTML, CSS, JavaScript, data) plus a README written from the facts of that part. When the
// whole page is selected the same entry point produces a page export instead.

const ELPKG_MAX_SCRIPT = 6 * 1024 * 1024;

// Readable indentation for HTML, CSS and JavaScript. Falls back to the original text if the
// formatter cannot handle it, so formatting never loses code.
function elpkgPretty(kind, text) {
  try {
    if (typeof beautifier === 'undefined' || !text || text.length > 600000) return text;
    return beautifier[kind](text, { indent_size: 2, preserve_newlines: true, max_preserve_newlines: 2, wrap_line_length: 0 });
  } catch (_) {
    return text;
  }
}

// A PNG of the part as it is drawn now, using the visible-tab capture. Returns null when the
// browser refuses (no access, part outside the viewport) so the export can go on without it.
async function elpkgPreview(handle) {
  try {
    const box = await call('rectOf', handle);
    await call('clearHighlight');
    await sleep(250);
    const img = await loadImg(await capture());
    const sx = img.width / box.vw;
    const cx = Math.max(0, box.x * sx),
      cy = Math.max(0, box.y * sx),
      cw = Math.min(img.width - cx, box.w * sx),
      ch = Math.min(img.height - cy, box.h * sx);
    if (cw < 1 || ch < 1) return null;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    canvas.getContext('2d').drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch (_) {
    return null; // a preview is a bonus; the code files do not depend on it
  }
}

// The page takes a moment to follow a window resize. Wait until it is about the wanted width, or
// give up after three seconds and report the width that was measured.
async function elpkgSettleWidth(want) {
  let inner = 0;
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    inner = await exec(() => innerWidth);
    if (Math.abs(inner - want) <= 2) break;
  }
  return inner;
}

// The same part at three window widths. Chrome resizes only a normal window, so other states are
// skipped with a note. The window is put back in a finally block, even when a shot fails.
async function elpkgWidthShots(handle, add, notes) {
  const t = await activeTab();
  const before = await chrome.windows.get(t.windowId);
  if (before.state !== 'normal') {
    notes.push({ path: '(preview-responsive/)', note: 'Not written: the browser window is ' + before.state + '. Restore it to a normal window and try again.' });
    return null;
  }
  const frame = before.width - (await exec(() => innerWidth));
  const shots = [];
  let restored = false;
  try {
    for (const w of DFResponsive.WIDTHS) {
      await chrome.windows.update(t.windowId, { state: 'normal', width: w + frame, height: before.height });
      const measured = await elpkgSettleWidth(w);
      const png = await elpkgPreview(handle);
      const file = png ? 'preview-responsive/' + w + 'px.png' : null;
      if (png) add(file, png, 'The part at a window width of ' + w + 'px.');
      shots.push({ width: w, measured, picture: file });
    }
  } catch (e) {
    notes.push({ path: '(preview-responsive/)', note: 'Stopped early: ' + e.message });
  } finally {
    try {
      await chrome.windows.update(t.windowId, { state: 'normal', left: before.left, top: before.top, width: before.width, height: before.height });
      restored = true;
    } catch (e) {
      notes.push({ path: '(window)', note: 'The window size could not be put back: ' + e.message });
    }
  }
  return { window: { width: before.width, height: before.height, restored }, shots };
}

// Names used for downloaded assets: stable, readable, never colliding.
function elpkgAssetName(url, i, type) {
  let base = 'file';
  let ext = '';
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const m = /^(.*?)(?:\.([a-z0-9]{2,5}))?$/i.exec(decodeURIComponent(p));
    base = slug(m[1]) || 'file';
    ext = m[2] ? m[2].toLowerCase() : '';
  } catch (_) {
    /* keep the defaults */
  }
  if (!ext) ext = (String(type || '').split('/')[1] || 'bin').split(';')[0].replace('svg+xml', 'svg');
  return 'assets/' + String(i + 1).padStart(2, '0') + '-' + base + '.' + ext;
}

// Downloads the images, fonts and media the part uses. Every outcome is reported, none is hidden.
async function elpkgFetchAssets(list, files) {
  const report = [];
  const map = {};
  const FETCH = new Set(['image', 'background-image', 'media', 'font']);
  for (const x of list)
    if (x.url && !FETCH.has(x.type) && x.type !== 'svg-inline') report.push({ url: x.url, status: 'listed, not downloaded (' + x.type + (x.via ? ': ' + x.via : '') + ')' });
  const targets = list.filter((x) => x.url && FETCH.has(x.type) && /^(https?:|data:)/.test(x.url)).slice(0, 80);
  const perm = await ensureOrigins(targets.filter((a) => /^https?:/.test(a.url)).map((a) => a.url));
  let n = 0;
  for (const a of targets) {
    if (a.url.startsWith('data:')) {
      report.push({ url: a.url.slice(0, 40) + '…', status: 'inline data URI, kept in place' });
      continue;
    }
    try {
      if (blocksPrivate(a.url, DF.state.url)) {
        report.push({ url: a.url, status: 'skipped: private or loopback address the page is not on' });
        continue;
      }
      const { bytes, type } = await fetchBytes(a.url, 8 * 1024 * 1024);
      const name = elpkgAssetName(a.url, n++, type);
      files.push({ path: name, data: bytes });
      map[a.url] = name;
      report.push({ url: a.url, status: 'saved as ' + name });
    } catch (e) {
      report.push({
        url: a.url,
        status: 'failed: ' + e.message + (perm.denied.length ? ' (site access was not granted, so other origins may block the download)' : ''),
      });
    }
  }
  return { report, map };
}

// Searches the page's external scripts for code that refers to the part.
async function elpkgScriptFragments(facts, handlers, onStep, opts = {}) {
  const spec = DFElementDoc.searchSpec(facts, handlers);
  const none = !spec.ids.size && !spec.classes.size && !spec.dataAttrs.size && !spec.names.size;
  if (none) return { sections: [], scriptFiles: [] };
  const res = await call('siteResources').then((r) => (Array.isArray(r) ? r : r.resources || []));
  const urls = [...new Set(res.filter((r) => r.kind === 'js').map((r) => r.url))].slice(0, 40);
  const sections = [];
  const scriptFiles = [];
  for (const url of urls) {
    onStep && onStep('Searching ' + url.split('/').pop());
    let label = url;
    try {
      label = new URL(url).pathname.split('/').pop() || url;
    } catch (_) {
      /* keep the address */
    }
    try {
      if (blocksPrivate(url, DF.state.url)) throw new Error('private or loopback address the page is not on');
      const { bytes } = await fetchBytes(url, ELPKG_MAX_SCRIPT);
      const found = DFElementDoc.fragments(new TextDecoder('utf-8').decode(bytes), spec);
      if (opts.format !== false) found.fragments.forEach((f) => (f.text = elpkgPretty('js', f.text)));
      if (found.error) {
        scriptFiles.push({ label, url, count: 0, error: found.error });
      } else if (found.fragments.length) {
        scriptFiles.push({ label, url, count: found.fragments.length });
        sections.push(DFElementDoc.fragmentsToText(url, found.fragments));
      }
    } catch (e) {
      scriptFiles.push({ label, url, count: 0, error: e.message });
    }
  }
  return { sections, scriptFiles: scriptFiles.filter((s) => s.error || s.count) };
}

// Saves the resources listed by the page agent since watching started (see agent/late.js).
async function elpkgLateFiles(add, notes, css) {
  const got = await call('lateList');
  const items = DFLate.merge(got.timing || [], got.observed || []);
  const report = [];
  let saved = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'data') {
      report.push({ url: it.url, kind: it.kind, status: 'listed, not saved: an API or XHR call is not sent again, because sending it again can change data on the server' });
      continue;
    }
    if (!DFLate.fetchable(it.url)) {
      report.push({ url: it.url, kind: it.kind, status: 'not saved: the browser does not let DevForge read this address' });
      continue;
    }
    if (saved >= 60) {
      report.push({ url: it.url, kind: it.kind, status: 'not saved: more than 60 resources' });
      continue;
    }
    if (blocksPrivate(it.url, DF.state.url)) {
      report.push({ url: it.url, kind: it.kind, status: 'skipped: private or loopback address the page is not on' });
      continue;
    }
    try {
      const { bytes, type } = await fetchBytes(it.url, 8 * 1024 * 1024);
      const path = DFLate.fileName(it.url, i, it.kind);
      const ext = /\.[A-Za-z0-9]{1,6}$/.test(path) ? '' : '.' + ((String(type || '').split('/')[1] || 'bin').split(';')[0].replace('svg+xml', 'svg'));
      add(path + ext, bytes, null);
      saved++;
      report.push({ url: it.url, kind: it.kind, status: 'saved as ' + path + ext, startTime: it.startTime, via: it.via || 'timing' });
    } catch (e) {
      report.push({ url: it.url, kind: it.kind, status: 'failed: ' + e.message });
    }
  }
  const note = got.watching
    ? 'Resources are listed from the moment watching began, and from the browser timing that was still kept before that.'
    : 'Watching was not started on this page, so only what the browser still kept in its timing buffer is listed.';
  add(
    'data/loaded-later.json',
    JSON.stringify({ watching: !!got.watching, since: got.since, domContentLoaded: got.domContentLoaded, timingBufferFull: !!got.timingBufferFull, note, items: report }, null, 2) + '\n',
    'Resources the page loaded after its first render, what was saved, and what was not and why.'
  );
  if (!items.length) notes.push({ path: 'loaded-later/', note: 'No resources loaded after the first render were seen. ' + note });
  else notes.push({ path: 'loaded-later/', note: saved + ' of ' + items.length + ' resource(s) that loaded later were saved. ' + note });
  return report;
}

async function buildElementPackage(handle, opts = {}, onStep = () => {}) {
  onStep('Reading the part');
  const facts = await call('elementFacts', handle);
  if (facts.isWholePage && !opts.forcePart) return buildPagePackage(facts, opts, onStep);

  const c = await call('collectComponent', handle, { stripHandlers: false, alsoSafe: true });
  const files = [];
  const notes = [];
  const add = (path, data, note) => {
    files.push({ path, data });
    if (note) notes.push({ path, note });
  };

  let assetResult = { report: [], map: {} };
  if (opts.assets !== false) {
    onStep('Downloading images and fonts');
    assetResult = await elpkgFetchAssets(c.assets || [], files);
    if (assetResult.report.length) notes.push({ path: 'assets/', note: 'Images, fonts and media this part uses (' + Object.keys(assetResult.map).length + ' saved).' });
  }
  const localise = (text) => {
    let out = text;
    for (const [u, local] of Object.entries(assetResult.map)) out = out.split(u).join(local);
    return out;
  };

  // HTML
  const fmt = opts.format !== false;
  const pretty = (kind, text) => (fmt ? elpkgPretty(kind, text) : text);
  add('html/outer.html', pretty('html', localise(c.html)) + '\n', 'The element with everything inside it, as the page showed it (scripts removed).');
  add('html/inner.html', pretty('html', localise(c.innerHtml || '')) + '\n', 'Only what is inside the element.');
  if (c.htmlShadow) add('html/with-shadow-dom.html', pretty('html', localise(c.htmlShadow)) + '\n', 'The same element with the content of its open shadow roots written out as <template shadowrootmode="open">, which a browser renders again when it parses the file.');
  const ctx = c.context || { chain: [] };
  const indent = (n) => '  '.repeat(n);
  const ctxLines = ctx.chain.map((x, i) => indent(i) + '<' + x.tag + (x.attrs ? ' ' + x.attrs : '') + '>');
  const depth = ctx.chain.length;
  const body = pretty('html', localise(c.html)).split('\n').map((l) => indent(depth) + l);
  add(
    'html/in-context.html',
    '<!-- Opening tags of the ancestors (attributes limited to id, class, role, lang, dir and data-*), then the part. ' +
      (ctx.previous ? 'Previous sibling: ' + ctx.previous + '. ' : '') + (ctx.next ? 'Next sibling: ' + ctx.next + '. ' : '') + (ctx.siblings ? ctx.siblings + ' element(s) share this parent. ' : '') + '-->\n' +
      ctxLines.join('\n') + (ctxLines.length ? '\n' : '') + body.join('\n') + '\n' + ctx.chain.map((x, i) => indent(depth - 1 - i) + '</' + x.tag + '>').join('\n') + '\n',
    'Where the part sits: the opening tags of its ancestors around it. For understanding the layout, not for pasting.'
  );
  const title = DFElementDoc.titleOf(facts);
  const safeHtml = localise(c.htmlShadowSafe || c.htmlSafe || c.html);
  add(
    'html/standalone.html',
    '<!DOCTYPE html>\n<html lang="' + (facts.lang || 'en') + '">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' +
      title.replace(/</g, '&lt;') + '</title>\n<link rel="stylesheet" href="../css/styles.css">\n</head>\n<body style="margin:0">\n' + pretty('html', safeHtml) + '\n</body>\n</html>\n',
    'Opens in a browser with the styles applied (including open shadow roots). Event handlers and scripts are removed, so it is for looking at.'
  );
  (facts.svgs || []).forEach((s, i) => add('html/svg/' + String(i + 1).padStart(2, '0') + '.svg', s + '\n'));
  if ((facts.svgs || []).length) notes.push({ path: 'html/svg/', note: 'Each inline SVG as its own file.' });

  // CSS
  const bodyNote = '/* The page body was: background ' + c.htmlStyleRoot.bodyBg + ', font ' + c.htmlStyleRoot.bodyFont + ', color ' + c.htmlStyleRoot.bodyColor + ' */\n';
  add('css/styles.css', bodyNote + pretty('css', localise(c.css)), 'The style rules that apply to the part, with the media queries, animations and fonts they need.');
  const comp = Object.entries(c.computedRoot || {}).map(([k, v]) => '  ' + k + ': ' + v + ';');
  add('css/computed.css', '/* Values the browser resolved for the outer element that differ from the default for <' + facts.tag + '> */\n' + (facts.selector || facts.tag) + ' {\n' + comp.join('\n') + '\n}\n', 'The final value of every property of the outer element that differs from the browser default.');

  if (c.shadowCss) add('css/shadow-dom.css', pretty('css', localise(c.shadowCss)) + '\n', 'Styles that live inside open shadow roots in this part. Page stylesheets cannot reach them.');
  add('css/inherited.json', JSON.stringify(c.inherited || [], null, 2) + '\n', 'Where the part\'s inherited text properties (font, colour, line height…) are set, nearest ancestor first.');
  try {
    add('css/matched-rules.json', JSON.stringify(await call('css', handle), null, 2) + '\n', 'Every rule that matches the outer element, with its stylesheet, specificity and which declaration wins.');
  } catch (e) {
    notes.push({ path: '(css/matched-rules.json)', note: 'Not written: ' + e.message });
  }

  // JavaScript
  if ((c.handlers || []).length) add('js/handlers.js', DFElementDoc.handlersToText(c.handlers), 'Inline event handler attributes (onclick and so on) found in the markup.');
  // Inline scripts are searched here rather than trusting the agent's looser id match, so a script
  // that only calls a handler's function, or finds the part by class, is found as well.
  const inlineScripts = (await exec(() => [...document.scripts].filter((s) => !s.src && s.textContent.trim() && !(s.id || '').startsWith('__df_') && !/json|ld/i.test(s.type || '')).map((s) => s.textContent.slice(0, 400000)), [])) || [];
  const spec = DFElementDoc.searchSpec(facts, c.handlers);
  const inlineParts = [];
  const relatedInline = [];
  inlineScripts.forEach((code, i) => {
    const found = DFElementDoc.fragments(code, spec);
    if (found.fragments && found.fragments.length) {
      if (opts.format !== false) found.fragments.forEach((f) => (f.text = elpkgPretty('js', f.text)));
      inlineParts.push(DFElementDoc.fragmentsToText('inline script ' + (i + 1), found.fragments));
      relatedInline.push({ index: i, matchedOn: [...new Set(found.fragments.flatMap((f) => f.matched))] });
    }
  });
  if (inlineParts.length) add('js/inline-scripts.js', inlineParts.join('\n\n') + '\n', 'Code from inline scripts that refers to the part by id, class, data attribute or handler function.');
  let scriptFiles = [];
  if (opts.scripts !== false) {
    onStep('Searching the page scripts');
    const r = await elpkgScriptFragments(facts, c.handlers, onStep, opts);
    scriptFiles = r.scriptFiles;
    if (r.sections.length) add('js/external-fragments.js', r.sections.join('\n\n') + '\n', 'Pieces of the page\'s script files that refer to the part.');
  }

  // Data
  if ((facts.jsonLd || []).length) add('data/json-ld.json', JSON.stringify(facts.jsonLd, null, 2) + '\n', 'Structured data (JSON-LD) inside the part.');
  add('data/structure.json', JSON.stringify({ outline: facts.outline, headings: facts.headings, forms: facts.forms, links: facts.links, images: facts.images, attributes: facts.attributes, tagCount: facts.tagCount }, null, 2) + '\n', 'The element tree and the forms, links and images in it.');
  if ((c.pseudo || []).length) add('data/pseudo-elements.json', JSON.stringify(c.pseudo, null, 2) + '\n', 'Generated content (::before and ::after) that does not appear in the HTML.');
  try {
    const d = await call('describe', handle);
    const sel = (d.selectors || []).map((s) => s.kind + '\t' + s.selector + '\t' + s.label);
    const css1 = (d.selectors || []).find((s) => s.kind !== 'xpath' && s.kind !== 'xpath-text');
    const xp = (d.selectors || []).find((s) => s.kind === 'xpath');
    add('data/selectors.txt', ['# Ways to find this part again (kind, selector, how stable the selector is)', ...sel, '', css1 ? "JS path: document.querySelector('" + css1.selector.replace(/'/g, "\\'") + "')" : '', xp ? 'XPath: ' + xp.selector : ''].join('\n') + '\n', 'CSS selectors, XPath and a JS path that find the part, ranked by how stable they are.');
    add('data/accessibility.json', JSON.stringify({ accessibility: d.accessibility, form: d.form }, null, 2) + '\n', 'Role, accessible name and related accessibility facts of the outer element.');
  } catch (e) {
    notes.push({ path: '(data/selectors.txt)', note: 'Not written: ' + e.message });
  }
  if (Object.keys(c.frameworkAttrs || {}).length) add('data/framework-attributes.json', JSON.stringify(c.frameworkAttrs, null, 2) + '\n', 'Attributes added by a framework (scoped-style ids and similar). Scoped CSS selectors depend on them, so they are kept in the HTML.');
  if (facts.text) add('data/text.txt', facts.text + '\n', 'The visible text of the part.');
  add('data/assets.json', JSON.stringify({ assets: c.assets, downloads: assetResult.report }, null, 2) + '\n', 'Every image, font and media address, and what happened when each was downloaded.');
  add('data/meta.json', JSON.stringify({ page: facts.pageUrl, selector: facts.selector, framework: c.framework, cssVariables: c.cssVariables, externalScripts: c.externalScripts, blockedStylesheets: c.blockedSheets, provenance: c.provenance, confidence: c.confidence, box: facts.box }, null, 2) + '\n', 'Where the part came from and how reliable each file is.');

  if (opts.preview !== false) {
    onStep('Capturing a preview image');
    const png = await elpkgPreview(handle);
    if (png) add('preview.png', png, 'A picture of the part as drawn in the browser when it was exported.');
    else notes.push({ path: '(preview.png)', note: 'Not written: the browser did not allow a capture of this part (outside the visible area, or no screenshot permission).' });
  }

  // Resources the page loaded after its first render, when the user watched for them. Each one that
  // is a web address is fetched with the same private-address rule and size limit as the other
  // downloads; anything else is listed with the reason it was not saved.
  if (opts.late) {
    onStep('Saving resources that loaded later');
    await elpkgLateFiles(add, notes, c.css);
  }
  // Media rules that the part's own stylesheet uses. A width that is not in the list is judged by
  // the rule's breakpoints alone; "unknown" means the rule uses a feature DevForge does not judge.
  const media = DFResponsive.mediaRules(c.css);
  let widths = null;
  if (opts.responsive) {
    onStep('Capturing three window widths');
    widths = await elpkgWidthShots(handle, add, notes);
  }
  const mediaOut = {
    rules: media.map((m) => ({ query: m.query, breakpoints: m.breakpoints, rules: m.rules, selectors: m.selectors })),
    widths: widths ? widths.shots.map((s) => ({ ...s, rulesActive: media.map((m) => ({ query: m.query, active: DFResponsive.activeAt(m.query, s.measured) })) })) : null,
    window: widths ? widths.window : null,
    note: 'Breakpoints are read from the stylesheet text. A rule that uses a feature other than min-width and max-width is marked unknown.',
  };
  if (media.length || widths) add('data/media-rules.json', JSON.stringify(mediaOut, null, 2) + '\n', 'Media queries that apply to the part, their breakpoints, and which of them are active at each width of the preview.');

  const notWritten = notes.filter((n) => n.path.startsWith('(')).map((n) => n.path.replace(/^\(|\)$/g, '') + ': ' + n.note);
  const readmeNotes = [{ path: 'README.md', note: 'This file.' }, ...notes.filter((n) => !n.path.startsWith('(') && (!n.path.startsWith('assets/') || n.path === 'assets/'))];
  files.unshift({
    path: 'README.md',
    data: DFElementDoc.partReadme({
      facts,
      css: c.css,
      handlers: c.handlers,
      relatedInline,
      scriptFiles,
      assets: assetResult.report,
      blockedSheets: c.blockedSheets,
      files: readmeNotes,
      notWritten,
      pseudo: c.pseudo,
      frameworkAttrs: c.frameworkAttrs,
      shadow: !!c.htmlShadow,
      created: new Date().toISOString(),
      tool: 'DevForge ' + chrome.runtime.getManifest().version,
      pageUrl: facts.pageUrl,
    }),
  });
  return { files, facts, c, name: slug(facts.selector || facts.tag) || 'part' };
}

// The whole page was selected: collect the page itself (HTML, scripts, styles, maps, manifest,
// service workers) with the bundle machinery and describe it in a README.
async function buildPagePackage(facts, opts, onStep) {
  const ids = ['html', 'js', 'css', 'maps', 'manifest', 'sw'];
  if (opts.wasm) ids.push('wasm');
  const { files, manifest } = await buildBundle(ids, [], { mask: true }, onStep);
  const kept = files.filter((f) => f.path !== 'README.md');
  const listing = [];
  for (const [dir, note] of [['html/', 'The page as it is now, including content added by scripts.'], ['js/', 'Inline scripts and every script file the page loads.'], ['css/', 'Inline styles and every stylesheet file.'], ['sourcemaps/', 'Source maps referenced by the scripts and styles.'], ['app/', 'Web app manifest and service worker scripts.']]) {
    if (kept.some((f) => f.path.startsWith(dir))) listing.push({ path: dir, note });
  }
  listing.unshift({ path: '_manifest.json', note: 'Every file with its source address, and every item that could not be read.' });
  kept.unshift({
    path: 'README.md',
    data: DFElementDoc.pageReadme({ facts, manifest, files: listing, created: manifest.created, tool: manifest.tool, pageUrl: facts.pageUrl }),
  });
  return { files: kept, facts, page: true, name: slug(facts.pageTitle || 'page') || 'page' };
}
