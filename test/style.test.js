const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../scripts/style-check.js');

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-style-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('the repository passes its own style check', () => {
  assert.deepEqual(S.run(), []);
});

test('each banned word and phrase is found in a document and in a code comment', () => {
  const words = ['comprehensive', 'robustly', 'seamless', 'leverages', 'utilizes', 'delve', 'cutting-edge', 'powerful', 'in order to', 'It is important to note', 'ensures that', 'a variety of'];
  const dir = repo({ 'README.md': words.map((w) => 'This is ' + w + ' text.').join('\n'), 'lib/a.js': words.map((w) => '// ' + w).join('\n') });
  try {
    const p = S.run(dir);
    assert.equal(p.filter((x) => x.startsWith('README.md:')).length, words.length);
    assert.equal(p.filter((x) => x.startsWith('lib/a.js:')).length, words.length);
  } finally {
    clean(dir);
  }
});

test('ordinary words that only look similar are not flagged', () => {
  const dir = repo({ 'README.md': 'Utilities, a robot, delivery, the order of items, ensure it works, variety show, power.' });
  try {
    assert.deepEqual(S.run(dir), []);
  } finally {
    clean(dir);
  }
});

test('an allow-list entry with a reason lets one word through in one file, and a stale entry is reported', () => {
  const dir = repo({ 'README.md': 'A powerful idea.', 'docs/x.md': 'A powerful idea.', 'scripts/style-allow.json': JSON.stringify([{ file: 'README.md', term: 'powerful', reason: 'quotes the product name' }]) });
  try {
    const p = S.run(dir);
    assert.equal(p.length, 1);
    assert.match(p[0], /^docs\/x\.md:1/);
    fs.writeFileSync(path.join(dir, 'docs/x.md'), 'Fine.');
    fs.writeFileSync(path.join(dir, 'README.md'), 'Fine.');
    assert.match(S.run(dir)[0], /not used any more/);
  } finally {
    clean(dir);
  }
});

test('an allow-list entry without a reason is refused', () => {
  const dir = repo({ 'scripts/style-allow.json': JSON.stringify([{ file: 'README.md', term: 'powerful' }]) });
  try {
    assert.throws(() => S.run(dir), /needs file, term and reason/);
  } finally {
    clean(dir);
  }
});

test('Guide sentences above the average limit are flagged', () => {
  const long = 'This sentence goes on and on without any real need to stop so that readers lose track of what it was saying at the start of it all, and then it keeps going.';
  const guide = `const DFGuide = { readingStats: () => ({ average: ${long.split(' ').length} }) }; module.exports = DFGuide;`;
  const dir = repo({ 'lib/guide.js': guide });
  try {
    assert.match(S.run(dir)[0], /lib\/guide\.js: sentences average/);
  } finally {
    clean(dir);
  }
});

test('vendored files are not scanned', () => {
  const dir = repo({ 'lib/acorn.js': '// a powerful parser', 'lib/beautifier.min.js': '/* comprehensive */' });
  try {
    assert.deepEqual(S.run(dir), []);
  } finally {
    clean(dir);
  }
});
