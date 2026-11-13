const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/sourcemap.js');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function enc(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let s = '';
  do {
    let d = v & 31;
    v >>>= 5;
    if (v > 0) d |= 32;
    s += B64[d];
  } while (v > 0);
  return s;
}
// lines: one array per generated line of [col, src, line, column]. Columns are relative per line,
// the rest is relative across the whole map, as the format requires.
function encodeMappings(lines) {
  let pSrc = 0;
  let pLine = 0;
  let pCol = 0;
  return lines
    .map((segs) => {
      let pc = 0;
      return segs
        .map(([col, src, line, column]) => {
          const s = enc(col - pc) + enc(src - pSrc) + enc(line - pLine) + enc(column - pCol);
          pc = col;
          pSrc = src;
          pLine = line;
          pCol = column;
          return s;
        })
        .join(',');
    })
    .join(';');
}

test('VLQ numbers decode, including negatives and multi-digit values', () => {
  assert.deepEqual(S.decodeSegment('A'), [0]);
  assert.deepEqual(S.decodeSegment('D'), [-1]);
  assert.deepEqual(S.decodeSegment('gB'), [16]);
  assert.deepEqual(S.decodeSegment('AACA'), [0, 0, 1, 0]);
  assert.deepEqual(S.decodeSegment(enc(1234) + enc(-99999)), [1234, -99999]);
  assert.throws(() => S.decodeSegment('g'), /middle of a number/);
  assert.throws(() => S.decodeSegment('!'), /not base64/);
});

test('mappings are relative, so segments decode to absolute positions', () => {
  const m = S.parseMappings(encodeMappings([[[0, 0, 0, 0], [4, 1, 2, 3]], [], [[1, 0, 5, 6]]]));
  assert.equal(m.length, 3);
  assert.deepEqual(m[0].map((s) => [s.col, s.src, s.line, s.column]), [[0, 0, 0, 0], [4, 1, 2, 3]]);
  assert.deepEqual(m[1], []);
  assert.deepEqual(m[2].map((s) => [s.col, s.src, s.line, s.column]), [[1, 0, 5, 6]]);
});

test('bytes are split between the original files, and the total adds up', () => {
  // Line 0 "aaa;bbbb" maps aaa; to a.js and bbbb to b.js. Line 1 "ccc" maps to a.js.
  const map = { mappings: encodeMappings([[[0, 0, 0, 0], [4, 1, 0, 0]], [[0, 0, 1, 0]]]), sources: ['a.js', 'b.js'] };
  const r = S.attribute(map, 'aaa;bbbb\nccc');
  assert.equal(r.total, 12);
  assert.deepEqual(r.perSource, [7, 4]);
  assert.equal(r.unmapped, 1);
  assert.equal(r.perSource[0] + r.perSource[1] + r.unmapped, r.total);
});

test('multi-byte characters count as UTF-8 bytes', () => {
  assert.equal(S.utf8Len('a'), 1);
  assert.equal(S.utf8Len('é'), 2);
  assert.equal(S.utf8Len('€'), 3);
  assert.equal(S.utf8Len('😀'), 4);
});

test('a map with a sections list is refused with a clear message', () => {
  assert.throws(() => S.parseMap('{"version":3,"sections":[]}'), /Indexed source maps/);
});

test('invalid JSON and a map without mappings are refused; the ")]}\'" guard is removed', () => {
  assert.throws(() => S.parseMap('{x'), /not valid source map JSON/);
  assert.throws(() => S.parseMap('{"sources":[]}'), /no mappings/);
  const ok = S.parseMap(")]}'\n" + JSON.stringify({ mappings: '', sources: ['a.js'], sourceRoot: 'webpack:///' }));
  assert.deepEqual(ok.sources, ['webpack:///a.js']);
});

test('sources without embedded text are reported as such', () => {
  const m = S.parseMap(JSON.stringify({ mappings: '', sources: ['a.js', 'b.js'], sourcesContent: ['x', null] }));
  assert.deepEqual(m.hasContent, [true, false]);
  const r = S.analyse('app.js', 'x', { mappings: '', sources: ['a.js', 'b.js'], hasContent: m.hasContent });
  assert.equal(r.sourcesWithContent, 1);
  assert.equal(r.sourceCount, 2);
});

test('the package of a module is found through the last node_modules folder', () => {
  assert.deepEqual(S.packageOf('webpack:///./node_modules/react/index.js'), { name: 'react', folder: 'webpack:///./node_modules/react' });
  assert.deepEqual(S.packageOf('node_modules/a/node_modules/@x/b/c.js'), { name: '@x/b', folder: 'node_modules/a/node_modules/@x/b' });
  assert.equal(S.packageOf('src/app.js'), null);
});

test('a package in two folders is a duplicate, and one copy is not', () => {
  const mods = [
    { path: 'node_modules/lodash/a.js', bytes: 100 },
    { path: 'node_modules/x/node_modules/lodash/b.js', bytes: 40 },
    { path: 'node_modules/react/r.js', bytes: 300 },
    { path: 'node_modules/react/s.js', bytes: 10 },
  ];
  const d = S.duplicates(mods);
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'lodash');
  assert.equal(d[0].copies, 2);
  assert.equal(d[0].bytes, 140);
});

test('modules from several bundles are joined by path, largest first', () => {
  const joined = S.modulesOf([
    { modules: [{ path: 'a.js', bytes: 5, hasContent: true }, { path: 'b.js', bytes: 9, hasContent: false }] },
    { modules: [{ path: 'a.js', bytes: 7, hasContent: true }] },
  ]);
  assert.deepEqual(joined.map((m) => [m.path, m.bytes, m.files]), [['a.js', 12, 2], ['b.js', 9, 1]]);
});
