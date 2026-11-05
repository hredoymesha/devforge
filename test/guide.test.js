const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../lib/guide.js');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// The tab ids the panel really registers, read from the source so a new tab cannot be forgotten.
const tabIds = fs
  .readdirSync(path.join(root, 'panel'))
  .flatMap((f) => [...read('panel/' + f).matchAll(/^registerTab\('([a-z]+)'/gm)].map((m) => m[1]));

test('every registered tab has exactly one guide card', () => {
  assert.ok(tabIds.length >= 20, 'found the registered tabs');
  for (const id of tabIds) assert.equal(G.CARDS.filter((c) => c.id === id).length, 1, 'card for ' + id);
  for (const c of G.CARDS) assert.ok(tabIds.includes(c.id), c.id + ' is not a tab');
});

test('each card has a meaning, three steps and a limit', () => {
  for (const c of G.CARDS) {
    assert.ok(c.name && c.does && c.cannot, c.id);
    assert.equal(c.steps.length, 3, c.id + ' steps');
  }
});

test('the tab order and the overflow groups know the Guide tab', () => {
  const boot = read('panel/boot.js');
  assert.match(boot, /'home',\s*'guide'/);
  assert.match(boot, /\['Start', \['home', 'guide'\]\]/);
});

test('sentences are short: average under 15 words, none over 25', () => {
  const s = G.readingStats();
  assert.ok(s.sentences > 100);
  assert.ok(s.average < 15, 'average is ' + s.average.toFixed(1));
  assert.ok(s.longest <= 25, 'longest is ' + s.longest);
});

test('no very long words', () => {
  for (const t of G.allText()) for (const w of t.split(/[^A-Za-z]+/)) {
    if (w.length > 14) assert.fail('long word: ' + w);
  }
});

test('every technical term used in the text is in the glossary', () => {
  const defined = new Set(G.GLOSSARY.map((g) => g.term.toLowerCase()));
  const text = G.allText().join(' ');
  const used = (t) => new RegExp('\\b' + t.replace(/ /g, '\\s+') + 's?\\b', 'i').test(text);
  const missing = G.JARGON.filter((t) => used(t) && !defined.has(t.toLowerCase()));
  // fetch / XHR is one glossary line for two terms
  assert.deepEqual(missing.filter((t) => !(t === 'XHR' && defined.has('fetch / xhr'))), []);
});

test('glossary terms are unique and each has a one-line meaning', () => {
  const seen = new Set();
  for (const g of G.GLOSSARY) {
    assert.ok(!seen.has(g.term), 'duplicate ' + g.term);
    seen.add(g.term);
    assert.ok(g.meaning.length > 8 && g.meaning.length < 120, g.term);
    assert.ok(G.sentences(g.meaning).length === 1, g.term + ' should be one sentence');
  }
});

test('every [Label] in the text still exists in the panel code', () => {
  const code = [read('sidepanel.html'), ...fs.readdirSync(path.join(root, 'panel')).map((f) => read('panel/' + f))].join('\n');
  const gone = G.labels().filter((l) => !code.includes(l));
  assert.deepEqual(gone, []);
});

test('parts() splits running text around labels', () => {
  assert.deepEqual(G.parts('Click [Go] now.'), [{ text: 'Click ' }, { label: 'Go' }, { text: ' now.' }]);
  assert.deepEqual(G.parts('Plain.'), [{ text: 'Plain.' }]);
  assert.deepEqual(G.parts('[A][B]'), [{ label: 'A' }, { label: 'B' }]);
});

test('reading stats count sentences and words', () => {
  const s = G.readingStats(['One two three. Four five.']);
  assert.equal(s.sentences, 2);
  assert.equal(s.words, 5);
  assert.equal(s.longest, 3);
  assert.deepEqual(G.readingStats([]).sentences, 0);
});
