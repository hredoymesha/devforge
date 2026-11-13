const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/exportdiff.js');

const enc = (s) => new TextEncoder().encode(s);
const find = (r, path) => r.files.find((f) => f.path === path);

test('the top folder with the export name is removed before comparing', () => {
  const list = [{ path: 'part-a-2026/css/x.css', data: 'a{}' }, { path: 'part-a-2026/README.md', data: 'x' }];
  assert.deepEqual(D.stripRoot(list).map((f) => f.path), ['css/x.css', 'README.md']);
  const mixed = [{ path: 'one/a.css', data: '' }, { path: 'two/b.css', data: '' }];
  assert.deepEqual(D.stripRoot(mixed).map((f) => f.path), ['one/a.css', 'two/b.css']);
});

test('HTML ignores whitespace, comments and DevForge ids, but not text or elements', () => {
  const a = '<div id="df-1" data-df-root><!-- note --><p>Hello   world</p></div>';
  const b = '<div>\n  <p>Hello world</p>\n</div>';
  assert.equal(D.normaliseHtml(a), D.normaliseHtml(b));
  assert.notEqual(D.normaliseHtml(a), D.normaliseHtml('<div><p>Hello there</p></div>'));
  assert.equal(D.normaliseHtml('<p id="__df_x">a</p>'), '<p>a</p>');
  assert.equal(D.normaliseHtml('<p id="keep">a</p>'), '<p id="keep">a</p>');
});

test('CSS rules are matched by selector, and blocks are kept whole', () => {
  const r = D.cssRules('/* c */ .a{color:red} @media (max-width:600px){ .a{padding:4px} .b{x:1} }');
  assert.deepEqual(r.map((x) => x.selector), ['.a', '@media (max-width:600px)']);
  assert.equal(r[0].body, 'color:red');
  assert.equal(r[1].body, '.a{padding:4px} .b{x:1}');
});

test('compare reports added, removed, changed and same files, and skips files with the export time', async () => {
  const A = [
    { path: 'x/html/a.html', data: '<p>Old</p>' },
    { path: 'x/css/s.css', data: '.a{color:red;padding:8px}.gone{color:blue}' },
    { path: 'x/data/meta.json', data: JSON.stringify({ created: '2026-01-01', page: 'p' }) },
    { path: 'x/README.md', data: 'first' },
    { path: 'x/assets/i.png', data: enc('aaa') },
    { path: 'x/js/only-a.js', data: 'var a=1' },
    { path: 'x/same.txt', data: 'same' },
  ];
  const B = [
    { path: 'y/html/a.html', data: '<p>New</p><span>x</span>' },
    { path: 'y/css/s.css', data: '.a{color:red;padding:16px}.new{margin:0}' },
    { path: 'y/data/meta.json', data: JSON.stringify({ created: '2027-01-01', page: 'p' }) },
    { path: 'y/README.md', data: 'second' },
    { path: 'y/assets/i.png', data: enc('bbb') },
    { path: 'y/js/only-b.js', data: 'var b=2' },
    { path: 'y/same.txt', data: 'same' },
  ];
  const r = await D.compare(A, B);
  assert.deepEqual(r.summary, { same: 2, added: 1, removed: 1, changed: 3, ignored: 1 });
  assert.deepEqual(r.ignored, ['README.md']);
  assert.equal(find(r, 'js/only-a.js').status, 'removed');
  assert.equal(find(r, 'js/only-b.js').status, 'added');
  assert.equal(find(r, 'assets/i.png').detail.note, 'different bytes');
  const css = find(r, 'css/s.css').detail;
  assert.deepEqual(css.added.map((x) => x.selector), ['.new']);
  assert.deepEqual(css.removed.map((x) => x.selector), ['.gone']);
  assert.equal(css.changed[0].after, 'color:red;padding:16px');
  const html = find(r, 'html/a.html').detail;
  assert.deepEqual(html.tags.added, { span: 1 });
  assert.deepEqual(html.text.removed.map((x) => x.text), ['Old']);
});

test('JSON that differs only in time fields is the same', async () => {
  const a = JSON.stringify({ b: 1, a: { created: 'x', v: 2 } });
  const b = JSON.stringify({ a: { v: 2, generatedAt: 'y' }, b: 1 });
  const r = await D.compare([{ path: 'm.json', data: a }], [{ path: 'm.json', data: b }]);
  assert.equal(r.summary.same, 1);
});

test('JSON fields that changed are named', async () => {
  const r = await D.compare([{ path: 'm.json', data: '{"a":1}' }], [{ path: 'm.json', data: '{"a":1,"b":2}' }]);
  assert.deepEqual(find(r, 'm.json').detail.keysAdded, ['b']);
});

test('invalid JSON is compared as text and says so', async () => {
  const r = await D.compare([{ path: 'm.json', data: '{x' }], [{ path: 'm.json', data: '{y' }]);
  assert.match(find(r, 'm.json').detail.note, /not valid JSON/);
});

test('a text file over the size limit is compared by bytes', async () => {
  const big = 'a'.repeat(2 * 1024 * 1024 + 1);
  const r = await D.compare([{ path: 'big.js', data: big }], [{ path: 'big.js', data: big + 'b' }]);
  assert.match(find(r, 'big.js').detail.note, /too large/);
});

test('more files than the limit is refused with a clear message', async () => {
  const many = Array.from({ length: 5001 }, (_, i) => ({ path: 'f' + i + '.txt', data: 'x' }));
  await assert.rejects(D.compare(many, []), /more than 5000 files/);
});

test('the Markdown escapes backticks in names and says what is not compared', async () => {
  const r = await D.compare([{ path: 'a`b.txt', data: '1' }], [], { nameA: 'one`two', nameB: 'three' });
  const md = D.toMarkdown(r);
  assert.match(md, /Compared `one'two` with `three`/);
  assert.match(md, /- `a'b\.txt` \(text\)/);
  assert.doesNotMatch(md, /``/);
});

test('an export with no difference says so', async () => {
  const r = await D.compare([{ path: 'a.txt', data: 'same' }], [{ path: 'a.txt', data: 'same' }]);
  assert.match(D.toMarkdown(r), /No differences in the compared files/);
});
