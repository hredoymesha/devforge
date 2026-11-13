const test = require('node:test');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const acorn = require('../lib/acorn.js');
const G = require('../lib/gen.js');

const tree = {
  tag: 'section',
  attrs: { 'aria-label': 'Card' },
  cls: 'card a"b',
  children: [
    { tag: 'h2', attrs: {}, cls: '', children: [{ text: 'Hello `x` ${y} <b>' }] },
    { tag: 'img', attrs: { src: 'a.png', alt: '' }, cls: '', children: [] },
    { tag: 'label', attrs: { for: 'x', tabindex: '0' }, cls: '', children: [{ text: 'Name' }] },
  ],
};
const css = '.card{color:red}\n.card::after{content:"</style>"}';
const meta = { tool: '4.4.0', source: 'section.card', page: 'https://example.test/' };

const files = (target, m = meta) => G.componentFiles({ tree, css }, target, 'card-demo', m).files;
const file = (list, path) => {
  const f = list.find((x) => x.path === path);
  assert.ok(f, 'missing ' + path);
  return f.data;
};

// A tag count check. It cannot replace a JSX parser, but it catches a missing or extra closing tag.
function tagsBalance(markup) {
  const voids = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'wbr']);
  const stack = [];
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , selfClose] = m;
    if (voids.has(name) || selfClose) continue;
    if (close) {
      assert.equal(stack.pop(), name, 'closing tag </' + name + '> does not match');
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], 'unclosed tags');
}

test('element names are valid custom element names', () => {
  const el = G.elementName;
  assert.equal(el('Card Demo!'), 'card-demo');
  assert.equal(el(''), 'component-part');
  assert.equal(el('3d'), 'x-3d');
  assert.equal(el('font-face'), 'df-font-face');
  assert.match(el('Ünïcode card'), /^[a-z][a-z0-9-]*-[a-z0-9-]*$/);
});

test('the web component parses, defines one element and uses no HTML-string sink', () => {
  const js = file(files('webcomponent'), 'card-demo.js');
  assert.doesNotThrow(() => acorn.parse(js, { ecmaVersion: 2022, sourceType: 'script' }));
  assert.match(js, /customElements\.define\('card-demo', CardDemo\);/);
  assert.match(js, /attachShadow\(\{ mode: 'open' \}\)/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|DOMParser|srcdoc|createContextualFragment/);
});

test('the web component tree and CSS evaluate back to the recreated markup and styles', () => {
  const js = file(files('webcomponent'), 'card-demo.js');
  const ast = acorn.parse(js, { ecmaVersion: 2022, sourceType: 'script' });
  const decl = ast.body.find((n) => n.type === 'VariableDeclaration' && n.declarations[0].id.name === 'tree');
  const init = decl.declarations[0].init;
  const [root] = [vm.runInNewContext('(' + js.slice(init.start, init.end) + ')')];
  assert.equal(root[0], 'section');
  assert.equal(root[1]['aria-label'], 'Card');
  assert.equal(root[2], 'card a"b');
  assert.equal(root[3][0][0], 'h2');
  assert.equal(root[3][0][3][0], 'Hello `x` ${y} <b>');
  assert.equal(root[3][1][0], 'img');
  const cssLine = /style\.textContent = (".*");/.exec(js);
  assert.ok(cssLine, 'css line');
  assert.equal(JSON.parse(cssLine[1]), css);
});

test('SVG elements are created in the SVG namespace', () => {
  const svgTree = { tag: 'svg', ns: 'svg', attrs: { viewBox: '0 0 1 1' }, cls: '', children: [{ tag: 'circle', ns: 'svg', attrs: { r: '1' }, cls: '', children: [] }] };
  const js = G.componentFiles({ tree: svgTree, css: '' }, 'webcomponent', 'icon-badge', null).files[0].data;
  assert.match(js, /const tree = \["svg", \{"viewBox":"0 0 1 1"\}, null, \[\n\s+\["circle", \{"r":"1"\}, null, \[\], "svg"\]\n\], "svg"\];/);
  assert.match(js, /createElementNS\(SVG, tag\)/);
});

test('React JSX is balanced and keeps empty attributes and quotes', () => {
  const jsx = file(files('react-project'), 'src/CardDemo.jsx');
  tagsBalance(jsx.replace(/\{"[^"]*"\}/g, 'text'));
  assert.match(jsx, /<img src="a\.png" alt="" \/>/);
  assert.match(jsx, /className="card a&quot;b"/);
  assert.match(jsx, /htmlFor="x"/);
  assert.doesNotMatch(jsx, /\salt\s*\/>/, 'a bare alt means true in JSX');
});

test('boolean attributes become flags, other empty attributes stay empty strings', () => {
  const t = { tag: 'div', attrs: { hidden: '', title: '' }, cls: '', children: [] };
  const jsx = G.componentFiles({ tree: t, css: '' }, 'react', 'flags', null).files.find((f) => f.path === 'Flags.jsx').data;
  assert.match(jsx, /<div hidden title="" \/>|<div title="" hidden \/>|<div hidden title=""/);
});

test('the React project has package.json, entry point, vite config and a README', () => {
  const list = files('react-project');
  assert.deepEqual(
    list.map((f) => f.path).sort(),
    ['README.md', 'index.html', 'package.json', 'src/CardDemo.css', 'src/CardDemo.jsx', 'src/main.jsx', 'vite.config.js'].sort()
  );
  const pkg = JSON.parse(file(list, 'package.json'));
  assert.equal(pkg.name, 'card-demo');
  assert.equal(pkg.dependencies.react, '^18.3.1');
  assert.equal(pkg.scripts.build, 'vite build');
  assert.match(file(list, 'src/main.jsx'), /import CardDemo from '\.\/CardDemo\.jsx';/);
  assert.match(file(list, 'index.html'), /src="\/src\/main\.jsx"/);
});

test('every generated file says where it came from, and the README says it is generated', () => {
  for (const target of ['webcomponent', 'react-project', 'react', 'vue']) {
    const list = files(target);
    const readme = file(list, 'README.md');
    assert.match(readme, /Generated by DevForge 4\.4\.0 from `section\.card` on https:\/\/example\.test\//, target);
    assert.match(readme, /Event handlers, scripts and state were not copied/, target);
  }
  assert.match(file(files('vue'), 'CardDemo.vue'), /Generated by DevForge 4\.4\.0 from section\.card/);
});

test('without metadata the code has no provenance banner, as the Recreate tab expects', () => {
  const list = files('webcomponent', null);
  assert.doesNotMatch(file(list, 'card-demo.js'), /Generated by DevForge/);
  assert.match(file(list, 'README.md'), /^# CardDemo\n\nGenerated code\./);
});

test('a newline in the page address cannot break a comment into code', () => {
  const list = files('react', { tool: '4.4.0', source: 'a', page: 'https://x.test/\nalert(1)' });
  const jsx = file(list, 'CardDemo.jsx');
  const lines = jsx.split('\n');
  assert.match(lines[0], /^\/\/ Generated by DevForge/);
  assert.match(lines[0], /on https:\/\/x\.test\/ alert\(1\)\.$/);
  assert.doesNotMatch(jsx, /^alert\(1\)/m);
});

test('the Vue and React output for Recreate is unchanged when no metadata is passed', () => {
  const react = G.generate({ tree, css }, 'react', 'card-demo').files;
  assert.equal(react[0].path, 'CardDemo.jsx');
  assert.doesNotMatch(react[0].data, /Generated by/);
});

test('unknown targets still fail', () => {
  assert.throws(() => G.componentFiles({ tree, css }, 'angular', 'x', null), /Unknown target/);
});
