const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/elementdoc.js');

const facts = (over = {}) => ({
  tag: 'section',
  id: 'promo',
  classes: ['promo'],
  selector: 'section#promo',
  elementCount: 7,
  tagCount: { section: 1, h2: 1, p: 1, img: 1, svg: 1, form: 1, input: 1, button: 1 },
  headings: [{ level: 2, text: 'Autumn blend' }],
  text: 'Autumn blend Roasted this week. Buy now',
  box: { width: 520, height: 210 },
  ancestors: [{ tag: 'main', id: '', classes: [] }, { tag: 'body', id: '', classes: [] }, { tag: 'html', id: '', classes: [] }],
  keys: { ids: ['promo'], classes: ['promo', 'promo-title', 'buy', 'open', 'row'], dataAttrs: ['data-track', 'data-sku'], customTags: [] },
  outline: [
    { depth: 0, tag: 'section', id: 'promo', classes: ['promo'], role: '', text: '' },
    { depth: 1, tag: 'h2', id: '', classes: ['promo-title'], role: '', text: 'Autumn blend' },
  ],
  links: [{ text: 'Menu', href: 'https://example.test/menu' }],
  images: [{ src: 'https://example.test/bean.png', alt: 'Coffee bean', width: 48, height: 48 }],
  forms: [{ action: 'https://example.test/subscribe', method: 'post', fields: [{ tag: 'input', type: 'email', name: 'email', required: true, label: 'Email' }] }],
  svgs: [{ label: 'Arrow', markup: '<svg></svg>' }],
  jsonLd: [],
  microdata: [],
  pageTitle: 'Harbor Coffee',
  pageUrl: 'https://example.test/demo/',
  lang: 'en',
  ...over,
});

test('handlerNames: the plain functions an inline handler calls, nothing else', () => {
  assert.deepEqual([...D.handlerNames([{ code: "buy('autumn')" }])], ['buy']);
  assert.deepEqual([...D.handlerNames([{ code: "return confirm('Sure?') && removeItem(this, 3)" }])], ['removeItem']);
  assert.deepEqual([...D.handlerNames([{ code: 'this.classList.toggle("x"); event.stopPropagation()' }])], [], 'method calls are not function names');
  assert.deepEqual([...D.handlerNames([{ code: 'if (' }])], [], 'broken code gives no names and no error');
  assert.deepEqual([...D.handlerNames(undefined)], []);
});

test('searchSpec: ids, specific classes and data attributes; generic class words are left out', () => {
  const s = D.searchSpec(facts(), [{ code: "buy('a')" }]);
  assert.ok(s.ids.has('promo'));
  assert.ok(s.classes.has('promo-title') && s.classes.has('buy'));
  assert.ok(!s.classes.has('open') && !s.classes.has('row'), 'generic words match too much unrelated code');
  assert.ok(s.dataAttrs.has('data-sku'));
  assert.ok(s.names.has('buy'));
});

const SRC = `
function trackPageview(){ return fetch('/analytics', { method: 'POST' }); }
function unrelatedHelper(a, b){ return a + b; }
const promo = document.querySelector('#promo');
promo.dataset.ready = '1';
function highlightBuy(){ document.querySelectorAll('.buy').forEach(function (b) { b.style.outline = '1px solid'; }); }
function buy(sku){ window.__bought = sku; }
document.getElementById('other').textContent = 'x';
el.setAttribute('data-sku', '1');
`;

test('fragments: only statements that refer to the part, as whole short functions', () => {
  const spec = D.searchSpec(facts(), [{ code: "buy('a')" }]);
  const r = D.fragments(SRC, spec);
  assert.equal(r.error, undefined);
  const texts = r.fragments.map((f) => f.text);
  assert.ok(texts.some((t) => t.startsWith("const promo = document.querySelector('#promo')")), 'selector string');
  assert.ok(texts.some((t) => t.startsWith('function highlightBuy')), 'a whole function that uses a class selector');
  assert.ok(texts.some((t) => t.startsWith('function buy(sku)')), 'the function the handler calls');
  assert.ok(texts.some((t) => t.includes("setAttribute('data-sku'")), 'a data attribute');
  assert.ok(!texts.some((t) => /unrelatedHelper|trackPageview|getElementById\('other'\)/.test(t)), 'unrelated code is left out');
  const buy = r.fragments.find((f) => f.text.startsWith('function buy'));
  assert.deepEqual(buy.matched, ['buy()']);
  assert.equal(buy.kind, 'function');
  assert.ok(buy.line >= 6);
});

test('fragments: a long function is cut down to the statement that refers to the part', () => {
  const filler = Array.from({ length: 200 }, (_, i) => `  var v${i} = ${i} * 2;`).join('\n');
  const src = `function bigInit(){\n${filler}\n  document.querySelector('#promo').hidden = false;\n${filler}\n}`;
  const r = D.fragments(src, D.searchSpec(facts(), []), { maxFragment: 400 });
  assert.equal(r.fragments.length, 1);
  assert.match(r.fragments[0].text, /^document\.querySelector\('#promo'\)\.hidden = false;/);
  assert.ok(r.fragments[0].text.length < 400);
});

test('fragments: nested matches are merged and the list is bounded', () => {
  const src = "function init(){ var a = $('#promo'); var b = $('.promo-title'); }";
  const r = D.fragments(src, D.searchSpec(facts(), []));
  assert.equal(r.fragments.length, 1, 'both selectors sit in one short function');
  assert.deepEqual(r.fragments[0].matched.sort(), ['#promo', '.promo-title']);
  const many = Array.from({ length: 100 }, () => "$('#promo').x();").join('\n');
  assert.equal(D.fragments(many, D.searchSpec(facts(), []), { maxFragments: 10 }).fragments.length, 10);
});

test('fragments: ids match whole selectors only, and comments or identifiers are not matches', () => {
  const spec = D.searchSpec(facts(), []);
  assert.equal(D.fragments("var x = '#promotion';", spec).fragments.length, 0, '#promotion is another id');
  assert.equal(D.fragments("// #promo is mentioned here\nvar promo = 1;", spec).fragments.length, 0, 'comments and plain names do not count');
  assert.equal(D.fragments("document.getElementById('promo');", spec).fragments.length, 1);
  assert.equal(D.fragments("el.classList.add('promo-title extra');", spec).fragments.length, 1, 'class lists');
});

test('fragments: code that does not parse is reported, never thrown', () => {
  const r = D.fragments('function (', D.searchSpec(facts(), []));
  assert.match(r.error, /Could not parse/);
  assert.deepEqual(r.fragments, []);
  assert.equal(D.fragments("import x from './x.js'; document.querySelector('#promo');", D.searchSpec(facts(), [])).fragments.length, 1, 'ES modules are read too');
});

test('fragmentsToText and handlersToText: readable headers and no loss of code', () => {
  const t = D.fragmentsToText('app.js', [{ line: 3, matched: ['#promo'], text: 'x();' }, { line: 9, matched: ['.buy', '#promo'], text: 'y();' }]);
  assert.match(t, /\/\* app\.js · fragment 1 of 2 · line 3 · refers to #promo \*\/\nx\(\);/);
  assert.match(t, /fragment 2 of 2 · line 9 · refers to \.buy, #promo/);
  assert.equal(D.handlersToText([]), '');
  const h = D.handlersToText([{ selector: 'button.buy', attr: 'onclick', code: "buy('a')\u0000" }]);
  assert.match(h, /\/\/ button\.buy · onclick\nbuy\('a'\)\n/);
  assert.ok(!h.includes('\u0000'));
});

test('analyzeCss: counts, conditions, animations, fonts, sources and variables', () => {
  const css = `:root {\n  --brand: #7a3e12;\n  --radius: 10px;\n}\n\n/* source: https://x.test/site.css */\n@font-face { font-family: Brand; src: url("a.woff2"); }\n.promo { color: red; }\n.promo .buy:hover { color: blue; }\n@keyframes pulse {\n  0% { opacity: 0.9; }\n  100% { opacity: 1; }\n}\n/* source: <style> #1 */\n@media (max-width: 600px) {\n  .promo { padding: 8px; }\n}\n`;
  const a = D.analyzeCss(css);
  assert.deepEqual(a.vars, { '--brand': '#7a3e12', '--radius': '10px' });
  assert.deepEqual(a.media, ['@media (max-width: 600px)']);
  assert.deepEqual(a.keyframes, ['pulse']);
  assert.deepEqual(a.fonts, ['Brand']);
  assert.deepEqual(a.sources, ['https://x.test/site.css', '<style> #1']);
  assert.equal(a.rules, 3, 'two plain rules and the one inside @media; the variables block, @font-face and @keyframes are not counted');
  assert.deepEqual(D.analyzeCss('').media, []);
});

test('partsSentence: plain words, biggest groups first, at most six', () => {
  assert.equal(D.partsSentence({ h2: 1, p: 1, img: 1 }), 'one heading, one paragraph and one image');
  assert.equal(D.partsSentence({ p: 4, a: 9 }), '9 links and 4 paragraphs');
  assert.equal(D.partsSentence({}), '');
  assert.equal(D.partsSentence({ svg: 2 }), '2 inline SVGs');
});

const ctxFor = (over = {}) => ({
  facts: facts(),
  css: ':root {\n  --brand: #7a3e12;\n}\n/* source: https://example.test/site.css */\n.promo { color: red; }\n@media (max-width: 600px) {\n  .promo { padding: 8px; }\n}\n',
  handlers: [{ selector: 'button.buy', attr: 'onclick', code: "buy('autumn')" }],
  relatedInline: [{ index: 1, matchedOn: ['promo'] }],
  scriptFiles: [{ label: 'app.js', url: 'https://example.test/app.js', count: 2 }],
  assets: [{ url: 'https://example.test/bean.png', status: 'saved as assets/01-bean.png' }],
  blockedSheets: [],
  files: [{ path: 'html/outer.html', note: 'The part, including the element itself' }],
  created: '2026-10-16T10:00:00.000Z',
  tool: 'DevForge 4.2.0',
  pageUrl: 'https://example.test/demo/',
  ...over,
});

test('partReadme: says what the part is, where it sits, what styles and scripts it has', () => {
  const md = D.partReadme(ctxFor());
  assert.match(md, /^# Autumn blend\n/);
  assert.match(md, /This is the `<section>` element `section#promo` from "Harbor Coffee" \(https:\/\/example\.test\/demo\/\)\. It measured 520 × 210 px/);
  assert.match(md, /contains 7 elements: one heading, one paragraph/);
  assert.match(md, /sits inside `html > body > main`/);
  for (const h of ['## Files', '## Structure', '## Content', '## Styling', '## Behaviour', '## Assets', '## Using these files', '## What is not here']) assert.ok(md.includes(h), h);
  assert.match(md, /2 CSS rules apply to this part, from `https:\/\/example\.test\/site\.css`/);
  assert.match(md, /Conditional rules: `@media \(max-width: 600px\)`/);
  assert.match(md, /1 custom property \(`--brand`\)/);
  assert.match(md, /1 inline event handler: `onclick="buy\('autumn'\)"`/);
  assert.match(md, /2 fragments of `app\.js` refer to this part/);
  assert.match(md, /A form that POSTs to `https:\/\/example\.test\/subscribe` with Email \(email, required\)/);
  assert.match(md, /Exported by DevForge 4\.2\.0 on 2026-10-16/);
});

test('partReadme: never prints undefined, NaN or object text, and copes with sparse facts', () => {
  const sparse = D.partReadme({ facts: { tag: 'div', classes: [], elementCount: 1, tagCount: {}, outline: [], pageUrl: 'https://example.test/' }, css: '', files: [], tool: 'DevForge', created: '2026-01-01T00:00:00.000Z' });
  for (const bad of ['undefined', 'NaN', '[object', 'null']) assert.ok(!sparse.includes(bad), bad + ' in:\n' + sparse);
  assert.match(sparse, /^# The div element/);
  assert.match(sparse, /No author CSS rules were found/);
  assert.match(sparse, /contains 1 element\./);
  const full = D.partReadme(ctxFor());
  for (const bad of ['undefined', 'NaN', '[object']) assert.ok(!full.includes(bad), bad);
});

test('partReadme: text from the page cannot break out of a table cell or a code span', () => {
  const md = D.partReadme(ctxFor({ files: [{ path: 'a|b`c.html', note: 'line one\nline two | pipe' }], assets: [{ url: 'https://x.test/a|b', status: 'x | y\nz' }] }));
  const rows = md.split('\n').filter((l) => l.startsWith('| `a'));
  assert.equal(rows.length, 1);
  assert.ok(!/\n\| `a\|b/.test(md), 'the pipe in the path is escaped');
  assert.ok(md.includes('line one line two \\| pipe'));
});

test('pageReadme: explains that the whole page was selected and lists what was collected and what failed', () => {
  const md = D.pageReadme({
    facts: facts({ tag: 'html', elementCount: 340, tagCount: { p: 20, a: 40 } }),
    manifest: { items: [{ item: 'Client-side JavaScript (.js)', status: 'partial', files: 3, problems: ['js https://x.test/a.js: HTTP 404'] }] },
    files: [{ path: 'html/rendered.html', note: 'The page as it is now' }],
    created: '2026-10-16T10:00:00.000Z',
    tool: 'DevForge 4.2.0',
    pageUrl: 'https://example.test/demo/',
  });
  assert.match(md, /^# Harbor Coffee\n/);
  assert.match(md, /You selected the whole page/);
  assert.match(md, /340 elements: 40 links and 20 paragraphs/);
  assert.match(md, /\| Client-side JavaScript \(\.js\) \| partial \| 3 \|/);
  assert.match(md, /- Client-side JavaScript \(\.js\): js https:\/\/x\.test\/a\.js: HTTP 404/);
  assert.ok(!md.includes('undefined'));
});

test('slug: safe, short file name parts', () => {
  assert.equal(D.slug('Autumn Blend!'), 'autumn-blend');
  assert.equal(D.slug('../../etc/passwd'), 'etc-passwd');
  assert.equal(D.slug(''), '');
  assert.ok(D.slug('x'.repeat(200)).length <= 48);
});

test('partReadme: explains shadow roots, generated content, framework attributes and files that were not written', () => {
  const md = D.partReadme({
    ...ctxFor(),
    shadow: true,
    pseudo: [{ element: '.note', pseudo: '::before', content: 'url("x.png")' }],
    frameworkAttrs: { 'data-v-7ba5bd90': 2 },
    notWritten: ['preview.png: the browser did not allow a capture'],
  });
  assert.match(md, /open shadow roots/);
  assert.match(md, /html\/with-shadow-dom\.html/);
  assert.match(md, /1 generated content item/);
  assert.match(md, /data-v-7ba5bd90/);
  assert.match(md, /## Not written/);
  assert.match(md, /preview\.png/);
  const plain = D.partReadme(ctxFor());
  assert.doesNotMatch(plain, /open shadow roots|## Not written|framework attributes/);
});
