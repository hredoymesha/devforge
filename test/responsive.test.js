const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/responsive.js');

const css = `
.promo { padding: 16px; }
@media (max-width: 600px) {
  .promo { padding: 8px; }
  .promo-title { font-size: 18px; }
}
@media screen and (min-width: 40em) and (max-width: 1024px) {
  .promo { display: grid; }
}
@media print { .promo { color: black; } }
@media (prefers-color-scheme: dark) { .promo { background: #111; } }
`;

test('finds every media block with its query, rules and selectors', () => {
  const list = R.mediaRules(css);
  assert.equal(list.length, 4);
  assert.equal(list[0].query, '(max-width: 600px)');
  assert.equal(list[0].rules, 2);
  assert.deepEqual(list[0].selectors, ['.promo', '.promo-title']);
  assert.equal(list[1].query, 'screen and (min-width: 40em) and (max-width: 1024px)');
  assert.equal(list[2].query, 'print');
  assert.equal(list[3].rules, 1);
});

test('breakpoints are in pixels, em counts as 16px, and duplicates are dropped', () => {
  const list = R.mediaRules(css);
  assert.deepEqual(list[0].breakpoints, [{ feature: 'max-width', px: 600 }]);
  assert.deepEqual(list[1].breakpoints, [
    { feature: 'min-width', px: 640 },
    { feature: 'max-width', px: 1024 },
  ]);
  assert.deepEqual(R.breakpoints('(max-width:600px) and (max-width:600px)'), [{ feature: 'max-width', px: 600 }]);
});

test('a width is judged against min-width and max-width, inclusive', () => {
  assert.equal(R.activeAt('(max-width: 600px)', 600), true);
  assert.equal(R.activeAt('(max-width: 600px)', 601), false);
  assert.equal(R.activeAt('(min-width: 40em)', 640), true);
  assert.equal(R.activeAt('(min-width: 40em)', 639), false);
  assert.equal(R.activeAt('screen and (min-width: 40em) and (max-width: 1024px)', 768), true);
  assert.equal(R.activeAt('screen and (min-width: 40em) and (max-width: 1024px)', 1280), false);
});

test('print and unknown features are never reported as true or false', () => {
  assert.equal(R.activeAt('print', 360), false);
  assert.equal(R.activeAt('(prefers-color-scheme: dark)', 360), 'unknown');
  assert.equal(R.activeAt('(width >= 600px)', 360), 'unknown');
  assert.equal(R.activeAt('not print', 360), 'unknown');
});

test('a comma list is true if any part is true, and unknown when the rest are unknown', () => {
  assert.equal(R.activeAt('(max-width: 400px), (min-width: 1200px)', 1280), true);
  assert.equal(R.activeAt('(max-width: 400px), (prefers-reduced-motion: reduce)', 1280), 'unknown');
  assert.equal(R.activeAt('(max-width: 400px), (min-width: 1200px)', 800), false);
  assert.equal(R.activeAt('', 360), true);
});

test('bad or unclosed CSS does not throw and does not hang', () => {
  assert.deepEqual(R.mediaRules(null), []);
  assert.deepEqual(R.mediaRules('@media'), []);
  const open = R.mediaRules('@media (max-width: 500px) { .a { color: red; }');
  assert.equal(open.length, 1);
  assert.equal(open[0].rules, 1);
  assert.doesNotThrow(() => R.mediaRules('@media (max-width: 500px) { } } }'));
});

test('the three preview widths are the ones the Export tab uses', () => {
  assert.deepEqual(R.WIDTHS, [360, 768, 1280]);
});
