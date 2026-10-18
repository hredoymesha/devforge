/*
 * Export helpers for one selected part of a page (or the whole page): finding the JavaScript that
 * refers to it, summarising its CSS, and writing the README that goes into the export. Pure
 * functions, testable in Node. Nothing here reads the page or the network.
 *
 * JavaScript is matched by names, not by running anything: a script statement is related to the part
 * when it contains one of the part's ids, classes or data attributes in a selector or string, or when
 * it defines a function that one of the part's inline handlers calls. That is an inference and the
 * README says so.
 */
const DFElementDoc = (() => {
  const acornLib = typeof acorn !== 'undefined' ? acorn : typeof require === 'function' ? require('./acorn.js') : null;

  // Class names too common to say anything about a script that mentions them.
  const GENERIC = new Set(
    'active open show hide hidden item items list row col btn button text title image img link icon nav main header footer content wrapper container inner outer box card body top left right small large medium primary secondary disabled selected current visible name label input form field group section page block'.split(' ')
  );
  const CALL_IGNORE = new Set('alert confirm prompt eval Function setTimeout setInterval requestAnimationFrame fetch parseInt parseFloat String Number Boolean Array Object Date RegExp Math JSON Promise Symbol'.split(' '));
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // eslint-disable-next-line no-control-regex
  const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
  const slug = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

  /* ---------- JavaScript that refers to the part ---------- */

  function parseJs(src) {
    if (!acornLib) throw new Error('The JavaScript parser is not loaded.');
    let last;
    for (const sourceType of ['script', 'module']) {
      try {
        return acornLib.parse(src, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true });
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  const children = (node) => {
    const out = [];
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) c && typeof c.type === 'string' && out.push(c);
      else if (v && typeof v.type === 'string') out.push(v);
    }
    return out;
  };

  // Names of the plain functions an inline handler calls: onclick="buy('a')" → buy.
  function handlerNames(handlers) {
    const names = new Set();
    for (const hd of handlers || []) {
      const code = String(hd.code || '');
      try {
        const ast = parseJs('(function(){' + code + '\n})');
        const stack = [ast];
        while (stack.length) {
          const n = stack.pop();
          if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && !CALL_IGNORE.has(n.callee.name)) names.add(n.callee.name);
          stack.push(...children(n));
        }
      } catch (_) {
        for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (!CALL_IGNORE.has(m[1]) && !/^(if|for|while|switch|return|function|catch)$/.test(m[1])) names.add(m[1]);
      }
    }
    return names;
  }

  // What to look for in scripts, from the facts about the part.
  function searchSpec(facts, handlers) {
    const keys = (facts && facts.keys) || {};
    const ids = new Set([...(keys.ids || []), facts && facts.id].filter(Boolean));
    const classes = new Set([...(keys.classes || [])].filter((c) => c.length >= 3 && !GENERIC.has(c.toLowerCase()) && !/^\d/.test(c) && !/^[a-z]{1,2}-\d/.test(c)));
    return { ids, classes, dataAttrs: new Set(keys.dataAttrs || []), names: handlerNames(handlers) };
  }

  function matchString(v, spec) {
    const hits = [];
    if (typeof v !== 'string' || v.length > 600) return hits;
    const tokens = v.split(/\s+/).filter(Boolean);
    for (const id of spec.ids) if ((tokens.length === 1 && v === id) || new RegExp('#' + esc(id) + '(?![\\w-])').test(v)) hits.push('#' + id);
    for (const c of spec.classes) if (tokens.includes(c) || new RegExp('\\.' + esc(c) + '(?![\\w-])').test(v)) hits.push('.' + c);
    for (const a of spec.dataAttrs) if (v === a || v.includes('[' + a)) hits.push('[' + a + ']');
    return hits;
  }

  /*
   * Statements of `source` that refer to the part. For each match the largest enclosing statement
   * that fits in `maxFragment` characters is returned (a whole function when it is short enough),
   * nested duplicates are dropped, and the result is in source order.
   */
  function fragments(source, spec, opts = {}) {
    const max = opts.maxFragment || 3000;
    const limit = opts.maxFragments || 40;
    let ast;
    try {
      ast = parseJs(source);
    } catch (e) {
      return { error: 'Could not parse as JavaScript: ' + e.message, fragments: [] };
    }
    const found = [];
    const chain = [];
    const isStatement = (n) => /(Statement|Declaration)$/.test(n.type) && n.type !== 'ExportNamedDeclaration' && n.type !== 'ExportDefaultDeclaration';
    const record = (matched, kind) => {
      const cands = chain.filter(isStatement);
      if (!cands.length) return;
      const fit = cands.find((n) => n.end - n.start <= max);
      const node = fit || cands[cands.length - 1];
      found.push({ start: node.start, end: Math.min(node.end, node.start + max), cut: !fit, matched, kind });
    };
    const visit = (node) => {
      chain.push(node);
      if (node.type === 'Literal' && typeof node.value === 'string') {
        const m = matchString(node.value, spec);
        if (m.length) record(m, 'selector');
      } else if (node.type === 'TemplateElement') {
        const m = matchString(node.value.cooked || node.value.raw, spec);
        if (m.length) record(m, 'selector');
      } else if (node.type === 'FunctionDeclaration' && node.id && spec.names.has(node.id.name) && chain.length <= 3) {
        record([node.id.name + '()'], 'function');
      } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && spec.names.has(node.id.name) && node.init && /Function/.test(node.init.type) && chain.length <= 4) {
        record([node.id.name + '()'], 'function');
      }
      for (const c of children(node)) visit(c);
      chain.pop();
    };
    visit(ast);
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const f of found) {
      const last = kept[kept.length - 1];
      if (last && f.start >= last.start && f.end <= last.end) {
        for (const m of f.matched) if (!last.matched.includes(m)) last.matched.push(m);
        continue;
      }
      kept.push({ ...f, matched: [...f.matched] });
    }
    const out = kept.slice(0, limit).map((f) => {
      const before = source.slice(0, f.start);
      const line = before.split('\n').length;
      return { line, offset: f.start, text: source.slice(f.start, f.end) + (f.cut ? '\n/* …cut at ' + max + ' characters */' : ''), matched: f.matched, kind: f.kind };
    });
    return { fragments: out, total: kept.length };
  }

  // One text file from the fragments of one script.
  function fragmentsToText(label, list) {
    return list
      .map((f, i) => '/* ' + label + ' · fragment ' + (i + 1) + ' of ' + list.length + ' · line ' + f.line + ' · refers to ' + f.matched.slice(0, 4).join(', ') + ' */\n' + f.text)
      .join('\n\n');
  }

  function handlersToText(handlers) {
    if (!handlers || !handlers.length) return '';
    return (
      '/* Inline event handler attributes found on this part. They are written as attributes in the\n   HTML; they are listed here so the code is easy to read. */\n\n' +
      handlers.map((h) => '// ' + (h.selector || 'element') + ' · ' + h.attr + '\n' + clean(h.code)).join('\n\n') +
      '\n'
    );
  }

  /* ---------- CSS summary ---------- */

  function analyzeCss(css) {
    const text = String(css || '');
    const media = [...new Set([...text.matchAll(/@(media|container|supports)\s+([^{]+)\{/g)].map((m) => '@' + m[1] + ' ' + m[2].trim()))];
    const keyframes = [...new Set([...text.matchAll(/@keyframes\s+([^\s{]+)/g)].map((m) => m[1]))];
    const fonts = [...new Set([...text.matchAll(/@font-face\s*\{[^}]*font-family:\s*["']?([^;"'}]+)/g)].map((m) => m[1].trim()))];
    const sources = [...new Set([...text.matchAll(/\/\* source: ([^*]+?) \*\//g)].map((m) => m[1]))];
    const vars = {};
    const root = /:root\s*\{([^}]*)\}/.exec(text);
    if (root) for (const m of root[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
    // Style rules only: @font-face and @keyframes blocks, and what is inside them, are not counted.
    const bare = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*:root\s*\{[^}]*\}/, '');
    const stack = [];
    let rules = 0;
    let start = 0;
    for (let i = 0; i < bare.length; i++) {
      const ch = bare[i];
      if (ch === '{') {
        const head = bare.slice(start, i).trim();
        const group = /^@(media|supports|container|layer)\b/.test(head);
        const other = /^@(-webkit-)?(keyframes|font-face|page|property|counter-style)\b/.test(head);
        if (!group && !other && !stack.includes('other')) rules++;
        stack.push(group ? 'group' : other ? 'other' : 'rule');
        start = i + 1;
      } else if (ch === '}') {
        stack.pop();
        start = i + 1;
      } else if (ch === ';') start = i + 1;
    }
    return { media, keyframes, fonts, sources, vars, rules };
  }

  /* ---------- README ---------- */

  const NOUNS = [
    ['h1', 'heading'], ['h2', 'heading'], ['h3', 'heading'], ['h4', 'heading'], ['h5', 'heading'], ['h6', 'heading'],
    ['p', 'paragraph'], ['img', 'image'], ['svg', 'inline SVG', 'inline SVGs'], ['picture', 'picture'], ['video', 'video'], ['audio', 'audio player'],
    ['form', 'form'], ['input', 'input'], ['select', 'select menu', 'select menus'], ['textarea', 'text area'], ['button', 'button'],
    ['a', 'link'], ['ul', 'list'], ['ol', 'numbered list'], ['table', 'table'], ['canvas', 'canvas', 'canvases'], ['iframe', 'frame'],
  ];
  function partsSentence(tagCount) {
    const counts = new Map();
    for (const [tag, one, many] of NOUNS) {
      const n = tagCount[tag] || 0;
      if (!n) continue;
      const e = counts.get(one) || { n: 0, one, many: many || one + 's' };
      e.n += n;
      counts.set(one, e);
    }
    const parts = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 6).map((e) => (e.n === 1 ? 'one ' + e.one : e.n + ' ' + e.many));
    if (!parts.length) return '';
    return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  const cell = (s) => clean(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const code = (s) => '`' + clean(s).replace(/`/g, "'").replace(/\s+/g, ' ').trim() + '`';
  // Inside a table a pipe must be escaped, also inside a code span.
  const cellCode = (s) => code(s).replace(/\|/g, '\\|');
  const label = (facts) => facts.selector || facts.tag;

  function titleOf(facts) {
    const h = (facts.headings || [])[0];
    if (h && h.text) return h.text;
    if (facts.id) return facts.tag + '#' + facts.id;
    if (facts.classes && facts.classes[0]) return facts.tag + '.' + facts.classes[0];
    return 'The ' + facts.tag + ' element';
  }

  function outlineText(outline, maxLines = 60) {
    const lines = (outline || []).slice(0, maxLines).map((n) => '  '.repeat(n.depth) + '<' + n.tag + (n.id ? ' #' + n.id : '') + (n.classes && n.classes.length ? ' .' + n.classes.join('.') : '') + (n.role ? ' role=' + n.role : '') + '>' + (n.text ? '  ' + JSON.stringify(n.text) : ''));
    if ((outline || []).length > maxLines) lines.push('… ' + (outline.length - maxLines) + ' more elements');
    return lines.join('\n');
  }

  /*
   * ctx: { facts, css (the exported CSS text), handlers, relatedInline: [{index, matchedOn}],
   *        scriptFiles: [{label, url, count, error}], assets: [{url, status}], blockedSheets: [],
   *        files: [{path, note}], created, tool, pageUrl }
   */
  function partReadme(ctx) {
    const f = ctx.facts;
    const css = analyzeCss(ctx.css);
    const L = [];
    L.push('# ' + clean(titleOf(f)), '');
    const dims = f.box && f.box.width ? f.box.width + ' × ' + f.box.height + ' px' : '';
    const parts = partsSentence(f.tagCount || {});
    L.push(
      'This is the ' + code('<' + f.tag + '>') + ' element ' + code(label(f)) + ' from ' + (f.pageTitle ? '"' + clean(f.pageTitle) + '" (' + clean(ctx.pageUrl || f.pageUrl) + ')' : clean(ctx.pageUrl || f.pageUrl)) + '. ' +
        (dims ? 'It measured ' + dims + ' when it was exported. ' : '') +
        'It contains ' + plural(f.elementCount, 'element') + (parts ? ': ' + parts : '') + '.' + (f.truncated ? ' Only the first 3000 elements were read.' : '')
    );
    if (f.ancestors && f.ancestors.length) {
      L.push('', 'It sits inside ' + code([...f.ancestors].reverse().map((a) => a.tag + (a.id ? '#' + a.id : a.classes && a.classes[0] ? '.' + a.classes[0] : '')).join(' > ')) + '.');
    }
    L.push('', '## Files', '', '| File | What it is |', '| --- | --- |');
    for (const x of ctx.files || []) L.push('| ' + cellCode(x.path) + ' | ' + cell(x.note) + ' |');

    L.push('', '## Structure', '', '```text', outlineText(f.outline), '```');
    if (ctx.shadow) L.push('', 'This part contains open shadow roots. Their content is written out in ' + code('html/with-shadow-dom.html') + ' and their styles in ' + code('css/shadow-dom.css') + '; a page stylesheet cannot style inside them.');
    if ((ctx.pseudo || []).length) L.push('', plural(ctx.pseudo.length, 'generated content item') + ' (' + code('::before') + ' or ' + code('::after') + ') is not in the HTML; see ' + code('data/pseudo-elements.json') + '.');
    const fw = Object.entries(ctx.frameworkAttrs || {});
    if (fw.length) L.push('', 'The markup carries framework attributes (' + fw.slice(0, 5).map(([k, n]) => code(k) + ' ×' + n).join(', ') + '). Scoped styles can depend on them, so they were kept. The HTML is the page as rendered now, not the template or source code it was built from.');

    const content = [];
    const heads = (f.headings || []).slice(0, 8);
    if (heads.length) content.push('- Headings: ' + heads.map((h) => 'h' + h.level + ' ' + JSON.stringify(h.text)).join(', ') + '.');
    if (f.text) content.push('- Text starts with: ' + JSON.stringify(clean(f.text).replace(/\s+/g, ' ').slice(0, 200)) + (f.text.length > 200 ? ' …' : ''));
    if ((f.links || []).length) content.push('- ' + plural(f.links.length, 'link') + (f.links.length > 6 ? ', the first six: ' : ': ') + f.links.slice(0, 6).map((l) => (l.text ? JSON.stringify(l.text) + ' → ' : '') + code(l.href)).join('; ') + '.');
    if ((f.images || []).length) content.push('- ' + plural(f.images.length, 'image') + (f.images.some((i) => i.alt == null || i.alt === '') ? ' (' + f.images.filter((i) => i.alt == null || i.alt === '').length + ' without alternative text)' : ', all with alternative text') + '.');
    for (const fm of f.forms || []) content.push('- A form that ' + (fm.method || 'get').toUpperCase() + 's to ' + code(fm.action || '(this page)') + ' with ' + (fm.fields.length ? fm.fields.map((x) => (x.label || x.name) + ' (' + (x.type || x.tag) + (x.required ? ', required' : '') + ')').join(', ') : 'no named fields') + '.');
    if ((f.svgs || []).length) content.push('- ' + plural(f.svgs.length, 'inline SVG') + ', saved as separate files in ' + code('html/svg/') + '.');
    if ((f.jsonLd || []).length) content.push('- ' + plural(f.jsonLd.length, 'JSON-LD block') + ' (structured data for search engines), saved in ' + code('data/json-ld.json') + '.');
    if ((f.microdata || []).length) content.push('- Microdata types: ' + f.microdata.map(code).join(', ') + '.');
    if (content.length) L.push('', '## Content', '', ...content);

    L.push('', '## Styling', '');
    const style = [];
    style.push(css.rules ? css.rules + ' CSS rule' + (css.rules === 1 ? '' : 's') + ' apply to this part' + (css.sources.length ? ', from ' + css.sources.map((s) => code(s)).join(', ') : '') + '.' : 'No author CSS rules were found for this part.');
    if (css.media.length) style.push('Conditional rules: ' + css.media.map(code).join(', ') + '.');
    if (css.keyframes.length) style.push('Animations defined: ' + css.keyframes.map(code).join(', ') + '.');
    if (css.fonts.length) style.push('Web fonts used: ' + css.fonts.map(code).join(', ') + '.');
    const vn = Object.keys(css.vars);
    if (vn.length) style.push('It reads ' + plural(vn.length, 'custom property', 'custom properties') + ' (' + vn.map(code).join(', ') + '). Their current values are at the top of ' + code('css/styles.css') + '.');
    style.push('The browser also resolves every property of the outer element to a value; the ones that differ from the browser default are in ' + code('css/computed.css') + '.');
    if ((ctx.blockedSheets || []).length) style.push(plural(ctx.blockedSheets.length, 'stylesheet') + ' could not be read (usually another origin without CORS), so rules from ' + ctx.blockedSheets.map(code).join(', ') + ' are missing.');
    L.push(style.join(' '));

    L.push('', '## Behaviour', '');
    const beh = [];
    const hs = ctx.handlers || [];
    if (hs.length) beh.push('- ' + plural(hs.length, 'inline event handler') + ': ' + hs.slice(0, 6).map((h) => code(h.attr + '="' + clean(h.code).slice(0, 60) + '"')).join(', ') + '. See ' + code('js/handlers.js') + '.');
    if ((ctx.relatedInline || []).length) beh.push('- ' + plural(ctx.relatedInline.length, 'inline script') + ' refer to this part by id, class or data attribute. See ' + code('js/inline-scripts.js') + '.');
    for (const s of ctx.scriptFiles || []) beh.push(s.error ? '- ' + code(s.label) + ' could not be searched: ' + cell(s.error) : '- ' + plural(s.count, 'fragment') + ' of ' + code(s.label) + ' refer to this part. See ' + code('js/external-fragments.js') + '.');
    beh.push('- Which script code belongs to a part is worked out by matching names (ids, classes, data attributes and the functions its handlers call). Treat it as a starting point and check it before reusing it. Listeners added with ' + code('addEventListener') + ' cannot be listed by a browser extension; they show up here only when the script that adds them is found.');
    L.push(...beh);

    if ((ctx.assets || []).length) {
      L.push('', '## Assets', '', '| Asset | Result |', '| --- | --- |');
      for (const a of ctx.assets.slice(0, 40)) L.push('| ' + cellCode(a.url) + ' | ' + cell(a.status) + ' |');
      if (ctx.assets.length > 40) L.push('| … | ' + (ctx.assets.length - 40) + ' more in ' + code('data/assets.json') + ' |');
    }

    L.push(
      '',
      '## Using these files',
      '',
      '1. Open ' + code('html/standalone.html') + ' in a browser to see the part with its styles. No scripts run there.',
      '2. ' + code('html/outer.html') + ' is the markup including the element itself; ' + code('html/inner.html') + ' is only what is inside it.',
      '3. ' + code('css/styles.css') + ' holds the rules, copied together with the conditions and animations they need. Image and font addresses are absolute, or point into ' + code('assets/') + ' when the file was downloaded.',
      '4. The JavaScript files are for reading and adapting; they are not a working bundle.'
    );
    if ((ctx.notWritten || []).length) L.push('', '## Not written', '', ...ctx.notWritten.map((x) => '- ' + cell(x)));
    L.push(
      '',
      '## What is not here',
      '',
      '- Server-side code and data. A browser never receives them.',
      '- Closed shadow roots and content of cross-origin frames.',
      '- Rules from stylesheets the browser did not let the extension read.',
      '',
      '---',
      '',
      'Exported by ' + (ctx.tool || 'DevForge') + ' on ' + (ctx.created || new Date().toISOString()) + ' from ' + clean(ctx.pageUrl || f.pageUrl) + '. Use it only for pages you may copy.'
    );
    return L.join('\n') + '\n';
  }

  /*
   * README for an export of the whole page. ctx: { facts, manifest: {items:[{item,status,files}]},
   * files: [{path, note}], created, tool, pageUrl }
   */
  function pageReadme(ctx) {
    const f = ctx.facts;
    const L = [];
    L.push('# ' + clean(f.pageTitle || 'Web page'), '');
    L.push('Source: ' + clean(ctx.pageUrl || f.pageUrl) + (f.lang ? ' (language: ' + f.lang + ')' : ''), '');
    L.push('You selected the whole page, so this export covers the page and not one part of it: the rendered HTML, every script, every stylesheet, and where they can be read, source maps, the web app manifest and service worker scripts.');
    L.push('', 'At the time of export the page had ' + plural(f.elementCount, 'element') + ((partsSentence(f.tagCount || {}) && ': ' + partsSentence(f.tagCount || {})) || '') + '.');
    const heads = (f.headings || []).slice(0, 10);
    if (heads.length) L.push('', '## Headings', '', ...heads.map((h) => '- h' + h.level + ' ' + clean(h.text)));
    L.push('', '## Files', '', '| File | What it is |', '| --- | --- |');
    for (const x of ctx.files || []) L.push('| ' + cellCode(x.path) + ' | ' + cell(x.note) + ' |');
    const items = (ctx.manifest && ctx.manifest.items) || [];
    if (items.length) {
      L.push('', '## What was collected', '', '| Item | Result | Files |', '| --- | --- | --- |');
      for (const i of items) L.push('| ' + cell(i.item) + ' | ' + cell(i.status) + ' | ' + i.files + ' |');
      const problems = items.flatMap((i) => (i.problems || []).map((p) => '- ' + cell(i.item) + ': ' + cell(p)));
      if (problems.length) L.push('', '## Problems', '', ...problems);
    }
    L.push(
      '',
      '## What is not here',
      '',
      '- Server-side code and data.',
      '- Content of cross-origin frames, closed shadow roots and HttpOnly cookies.',
      '- Pages other than this one. Use the Site tab to download the files the page loads together with a rewritten copy of this page.',
      '',
      '---',
      '',
      'Exported by ' + (ctx.tool || 'DevForge') + ' on ' + (ctx.created || new Date().toISOString()) + '. Use it only for pages you may copy.'
    );
    return L.join('\n') + '\n';
  }

  return { slug, searchSpec, handlerNames, fragments, fragmentsToText, handlersToText, analyzeCss, partsSentence, outlineText, titleOf, partReadme, pageReadme };
})();
if (typeof module !== 'undefined') module.exports = DFElementDoc;
