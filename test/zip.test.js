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
