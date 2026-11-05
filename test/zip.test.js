const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const DFZip = require('../lib/zip.js');

async function entries(blob) {
  const buf = Buffer.from(await blob.arrayBuffer());
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(at + 28);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, crc, size, data: buf.slice(start, start + size) });
    at += 46 + nameLen;
  }
  return out;
}

test('stores every file with a correct CRC and size, in order', async () => {
  const blob = DFZip.build([
    { path: 'a.txt', data: 'hello' },
    { path: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) },
  ]);
  const list = await entries(blob);
  assert.deepEqual(list.map((e) => e.name), ['a.txt', 'dir/b.bin']);
  for (const e of list) assert.equal(DFZip.crc32(e.data), e.crc);
  assert.equal(list[0].data.toString(), 'hello');
});

test('entry names cannot escape the extraction folder', async () => {
  const list = await entries(
    DFZip.build([
      { path: '../../etc/passwd', data: 'x' },
      { path: '/abs/file.txt', data: 'x' },
      { path: 'C:\\win\\file.txt', data: 'x' },
      { path: 'a/./b/../c.txt', data: 'x' },
    ])
  );
  assert.deepEqual(list.map((e) => e.name), ['etc/passwd', 'abs/file.txt', 'win/file.txt', 'a/b/c.txt']);
});

test('a repeated name gets a numeric suffix instead of a second entry with the same path', async () => {
  const list = await entries(DFZip.build([{ path: 'x/a.css', data: '1' }, { path: 'x/a.css', data: '2' }, { path: 'X/A.CSS', data: '3' }]));
  assert.deepEqual(list.map((e) => e.name), ['x/a.css', 'x/a (2).css', 'X/A (3).CSS']);
  assert.equal(new Set(list.map((e) => e.name.toLowerCase())).size, 3);
});

test('non-ASCII names are stored as UTF-8 and the archive passes the system unzip test when available', async () => {
  const blob = DFZip.build([{ path: 'পরীক্ষা/ফাইল.txt', data: 'ok' }, { path: 'normal.txt', data: 'ok' }]);
  const list = await entries(blob);
  assert.equal(list[0].name, 'পরীক্ষা/ফাইল.txt');
  const have = spawnSync('unzip', ['-v'], { stdio: 'ignore' }).status === 0;
  if (!have) return;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dfzip-')), 't.zip');
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  assert.match(execFileSync('unzip', ['-tq', file]).toString(), /No errors detected/);
});

test('refuses a file count that does not fit the classic ZIP header', () => {
  const many = Array.from({ length: 65535 }, (_, i) => ({ path: 'f' + i, data: '' }));
  assert.throws(() => DFZip.build(many), /Too many files/);
});

/* ---------- deflate (buildAsync) ---------- */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

// Like entries(), but also reads the method and the compressed size, and inflates what is deflated.
async function details(blob) {
  const buf = Buffer.from(await blob.arrayBuffer());
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(start, start + csize);
    out.push({ name, method, crc, csize, size, localCrc: buf.readUInt32LE(local + 14), localCsize: buf.readUInt32LE(local + 18), localSize: buf.readUInt32LE(local + 22), localMethod: buf.readUInt16LE(local + 8), data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    at += 46 + nameLen;
  }
  return { buf, list: out };
}
const canDeflate = DFZip.canDeflate();
const maybe = canDeflate ? test : test.skip;

const TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(400);
const sample = () => [
  { path: 'index.html', data: '<!doctype html>' + TEXT },
  { path: 'app/main.js', data: new TextEncoder().encode('const a = 1;\n'.repeat(500)) },
  { path: 'img/logo.png', data: new TextEncoder().encode(TEXT) },
  { path: 'fonts/a.woff2', data: new TextEncoder().encode(TEXT) },
  { path: 'photo.JPG', data: new TextEncoder().encode(TEXT) },
  { path: 'inner.zip', data: new TextEncoder().encode(TEXT) },
  { path: 'tiny.txt', data: 'hi' },
  { path: 'random.txt', data: new Uint8Array(crypto.randomBytes(4000)) },
  { path: 'empty.txt', data: '' },
];

maybe('buildAsync deflates text, and the file reads back byte for byte (Node zlib)', async () => {
  const { list } = await details(await DFZip.buildAsync(sample()));
  const html = list.find((e) => e.name === 'index.html');
  assert.equal(html.method, 8);
  assert.ok(html.csize < html.size / 10, 'compressed ' + html.csize + ' of ' + html.size);
  assert.equal(html.data.toString(), '<!doctype html>' + TEXT);
  assert.equal(list.find((e) => e.name === 'app/main.js').method, 8);
});

maybe('central directory and local header agree: CRC of the original, both sizes, method', async () => {
  const { list } = await details(await DFZip.buildAsync(sample()));
  for (const e of list) {
    assert.equal(DFZip.crc32(e.data), e.crc, e.name + ' crc');
    assert.equal(e.data.length, e.size, e.name + ' size');
    assert.equal(e.method === 8 ? e.csize <= e.size : e.csize === e.size, true, e.name);
    assert.deepEqual([e.localCrc, e.localCsize, e.localSize, e.localMethod], [e.crc, e.csize, e.size, e.method], e.name + ' local header');
  }
});

maybe('already-compressed types, tiny files, empty files and random data are stored', async () => {
  const { list } = await details(await DFZip.buildAsync(sample()));
  const method = (n) => list.find((e) => e.name === n).method;
  for (const n of ['img/logo.png', 'fonts/a.woff2', 'photo.JPG', 'inner.zip', 'tiny.txt', 'random.txt', 'empty.txt']) assert.equal(method(n), 0, n);
});

maybe('the system unzip accepts a deflated archive and extracts the same bytes', async () => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch (_) {
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-zip-'));
  try {
    const f = path.join(dir, 'a.zip');
    fs.writeFileSync(f, Buffer.from(await (await DFZip.buildAsync(sample())).arrayBuffer()));
    execFileSync('unzip', ['-tq', f]);
    assert.equal(execFileSync('unzip', ['-p', f, 'index.html']).toString(), '<!doctype html>' + TEXT);
    assert.equal(execFileSync('unzip', ['-p', f, 'app/main.js']).toString(), 'const a = 1;\n'.repeat(500));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

maybe('names are the same, safe and unique whether or not files are deflated', async () => {
  const files = [{ path: '../../etc/passwd', data: 'x'.repeat(200) }, { path: 'C:\\win\\a.txt', data: 'x'.repeat(200) }, { path: 'a/./b/../c.txt', data: 'x'.repeat(200) }, { path: 'A.TXT', data: 'x'.repeat(200) }, { path: 'a.txt', data: 'y'.repeat(200) }];
  const stored = (await details(DFZip.build(files))).list.map((e) => e.name);
  const packed = (await details(await DFZip.buildAsync(files))).list.map((e) => e.name);
  assert.deepEqual(packed, stored);
  assert.equal(new Set(packed.map((n) => n.toLowerCase())).size, packed.length);
  assert.ok(packed.every((n) => !n.includes('..') && !n.startsWith('/')));
});

test('opts.deflate = false stores everything, with the same result as build()', async () => {
  const { list } = await details(await DFZip.buildAsync(sample(), { deflate: false }));
  assert.ok(list.every((e) => e.method === 0));
  const plain = await details(DFZip.build(sample().filter((f) => f.path !== 'random.txt')));
  assert.deepEqual(plain.list.map((e) => e.name), list.filter((e) => e.name !== 'random.txt').map((e) => e.name));
});

test('where CompressionStream is missing the archive is stored and still valid', async () => {
  const saved = globalThis.CompressionStream;
  try {
    delete globalThis.CompressionStream;
    assert.equal(DFZip.canDeflate(), false);
    const { list } = await details(await DFZip.buildAsync(sample()));
    assert.ok(list.every((e) => e.method === 0));
    for (const e of list) assert.equal(DFZip.crc32(e.data), e.crc);
  } finally {
    globalThis.CompressionStream = saved;
  }
});

test('a CompressionStream that cannot be built counts as unavailable', async () => {
  if (!canDeflate) return;
  const saved = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = class {
      constructor(f) {
        if (f !== 'deflate-raw') throw new TypeError('x');
        throw new Error('stream broke');
      }
    };
    // canDeflate() builds one too, so it reports false and the archive is stored instead.
    assert.equal(DFZip.canDeflate(), false);
    const { list } = await details(await DFZip.buildAsync(sample()));
    assert.ok(list.every((e) => e.method === 0));
  } finally {
    globalThis.CompressionStream = saved;
  }
});
