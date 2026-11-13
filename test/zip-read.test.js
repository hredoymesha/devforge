const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const Z = require('../lib/zip.js');

const enc = (s) => new TextEncoder().encode(s);

// A ZIP written by hand, so a test can put in a name the writer would clean up.
function handZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc(e.name);
    const packed = e.method === 8 ? new Uint8Array(zlib.deflateRawSync(e.data)) : e.data;
    const crc = e.crc != null ? e.crc : Z.crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, e.method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, packed);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, e.method, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, packed.length, true);
    dir.setUint32(24, e.usize != null ? e.usize : e.data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + packed.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

test('a ZIP from the writer reads back with the same names and bytes, stored and deflated', async () => {
  const big = enc('<p>hello</p>'.repeat(40));
  const zip = await Z.buildAsync([
    { path: 'a/page.html', data: big },
    { path: 'b.txt', data: enc('tiny') },
  ]);
  const r = await Z.read(zip);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a/page.html', 'b.txt']);
  assert.equal(new TextDecoder().decode(r.files.find((f) => f.path === 'a/page.html').data), new TextDecoder().decode(big));
  const stored = await Z.read(Z.build([{ path: 's.txt', data: enc('plain') }]));
  assert.equal(new TextDecoder().decode(stored.files[0].data), 'plain');
});

test('a deflated entry from another tool is read', async () => {
  const data = enc('hello from another tool '.repeat(20));
  const r = await Z.read(handZip([{ name: 'x/y.txt', data, method: 8 }]));
  assert.equal(new TextDecoder().decode(r.files[0].data), new TextDecoder().decode(data));
});

test('an entry whose bytes do not match its CRC is refused', async () => {
  const zip = handZip([{ name: 'a.txt', data: enc('abc'), method: 0, crc: 0x12345678 }]);
  await assert.rejects(Z.read(zip), /failed its check/);
});

test('a name with .. or an absolute path is skipped and listed', async () => {
  const zip = handZip([
    { name: '../../evil.txt', data: enc('x'), method: 0 },
    { name: '/etc/passwd', data: enc('y'), method: 0 },
    { name: 'C:/win.ini', data: enc('z'), method: 0 },
    { name: 'ok/fine.txt', data: enc('ok'), method: 0 },
  ]);
  const r = await Z.read(zip);
  assert.deepEqual(r.files.map((f) => f.path), ['ok/fine.txt']);
  assert.deepEqual(r.skipped.map((s) => s.name), ['../../evil.txt', '/etc/passwd', 'C:/win.ini']);
});

test('a deflated entry that expands beyond its declared size is stopped', async () => {
  const data = enc('a'.repeat(100000));
  const zip = handZip([{ name: 'bomb.txt', data, method: 8, usize: 10 }]);
  await assert.rejects(Z.read(zip), /larger than its declared size|failed its check/);
});

test('input that is not a ZIP is refused', async () => {
  await assert.rejects(Z.read(enc('hello, this is not a zip file at all')), /not a ZIP/);
});

test('a ZIP whose total size is over the limit is refused before reading the entries', async () => {
  const zip = handZip([{ name: 'a.txt', data: enc('abcdef'), method: 0 }]);
  await assert.rejects(Z.read(zip, { maxBytes: 3 }), /larger than 0 MB/);
});
