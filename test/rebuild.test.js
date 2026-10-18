const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/rebuild.js');

const css = `.a { color: #112233; background-color: #ffffff; font-family: "Inter", sans-serif; padding: 16px; }
.b { color: #112233; background-color: #ffffff; font-family: "Inter", sans-serif; padding: 16px; }
.c { color: #112233; background-color: rgb(1, 2, 3); font-size: 24px; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;

test('repeated colours and fonts become custom properties; single-use colours stay literal', () => {
  const { css: out, stats } = R.rebuild(css);
  assert.match(out, /:root \{[\s\S]*--color-1: #112233;/);
  assert.match(out, /--font-1: "Inter", sans-serif;/);
  assert.match(out, /color: var\(--color-1\)/);
  assert.match(out, /rgb\(1, 2, 3\)/); // used once
  assert.equal(stats.fontTokens, 1);
});
test('identical rules are merged into one grouped rule', () => {
  const { css: out, stats } = R.rebuild(css);
  assert.match(out, /\.a,\n\.b \{/);
  assert.equal(stats.merged, 1);
  assert.equal(stats.rulesBefore, 3);
  assert.equal(stats.rulesAfter, 2);
});
test('@keyframes pass through untouched', () => {
  assert.match(R.rebuild(css).css, /@keyframes spin \{ from \{ transform: rotate\(0deg\); \} to \{ transform: rotate\(360deg\); \} \}/);
});
test('rem option converts px sizes and leaves 0 alone', () => {
  const { css: out } = R.rebuild('.x { font-size: 24px; padding: 0px 8px; width: 100px; }', { rem: true });
  assert.match(out, /font-size: 1\.5rem/);
  assert.match(out, /padding: 0 0\.5rem/);
  assert.match(out, /width: 100px/); // not a spacing property
});
test('url() values and semicolons inside strings do not break the parser', () => {
  const { css: out } = R.rebuild('.x { background: url("data:image/svg+xml;utf8,<svg/>"); content: "a;b"; }');
  assert.match(out, /url\("data:image\/svg\+xml;utf8,<svg\/>"\)/);
  assert.match(out, /content: "a;b"/);
});
test('the rebuilt CSS is never longer than twice the input and has no empty rules', () => {
  const { css: out } = R.rebuild(css);
  assert.ok(out.length < css.length * 2);
  assert.doesNotMatch(out, /\{\s*\}/);
});
