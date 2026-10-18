const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/proto.js');

test('generateCss writes !important declarations per selector', () => {
  const { css, skipped } = P.generateCss({ '.btn': { color: '#fff', 'font-size': '18px' }, h1: { margin: '0' } });
  assert.match(css, /\.btn \{\n {2}color: #fff !important;\n {2}font-size: 18px !important;\n\}/);
  assert.match(css, /h1 \{\n {2}margin: 0 !important;/);
  assert.equal(skipped.length, 0);
});
test('empty values are left out and empty rules produce nothing', () => {
  assert.equal(P.generateCss({ p: { color: '' } }).css, '');
});
test('values or selectors that could break out of a declaration are refused', () => {
  const r = P.generateCss({ p: { color: 'red; } body { display:none' }, 'a{}': { color: 'red' }, '.ok': { 'x y': '1', color: 'red/*' } });
  assert.equal(r.css, '');
  assert.equal(r.skipped.length, 4);
});
test('custom properties are allowed', () => {
  assert.match(P.generateCss({ ':root': { '--brand': '#123456' } }).css, /--brand: #123456 !important/);
});
test('consoleSnippet and userscript embed the CSS as a safe string literal', () => {
  const css = 'a::before{content:"</style>"}';
  assert.ok(P.consoleSnippet(css).includes(JSON.stringify(css)));
  const u = P.userscript({ name: 'x\ny', match: '*://a.test/*', css, js: 'console.log(1);' });
  assert.match(u, /@name x y/);
  assert.ok(u.includes(JSON.stringify(css)));
  assert.match(u, /console\.log\(1\);/);
});
test('unitValue only formats real numbers', () => {
  assert.equal(P.unitValue('12', 'px'), '12px');
  assert.equal(P.unitValue('', 'px'), '');
  assert.equal(P.unitValue('abc', 'px'), '');
});
