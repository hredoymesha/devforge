const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
const run = (out) => execFileSync(process.execPath, ['scripts/package.js', '--out', out], { cwd: root, encoding: 'utf8' });
const hasUnzip = spawnSync('unzip', ['-v']).status === 0;

function names(zip) {
  return execFileSync('unzip', ['-Z1', zip]).toString().split('\n').filter(Boolean);
}

test('npm run package makes both ZIPs and checksum files named after the manifest version', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-pkg-'));
  try {
    run(out);
    const files = fs.readdirSync(out).sort();
    assert.deepEqual(files, [`DevForge-${version}-extension.zip`, `DevForge-${version}-extension.zip.sha256`, `DevForge-${version}-source.zip`, `DevForge-${version}-source.zip.sha256`]);
    for (const z of files.filter((f) => f.endsWith('.zip'))) {
      const want = fs.readFileSync(path.join(out, z + '.sha256'), 'utf8');
      const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, z))).digest('hex');
      assert.equal(want, sum + '  ' + z + '\n');
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('two runs give byte-identical files and the same checksums', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-pkg-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-pkg-'));
  try {
    run(a);
    run(b);
    for (const f of fs.readdirSync(a)) assert.ok(fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))), f);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('the extension ZIP holds the extension files at its root and nothing else', { skip: !hasUnzip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-pkg-'));
  try {
    run(out);
    const zip = path.join(out, `DevForge-${version}-extension.zip`);
    execFileSync('unzip', ['-tq', zip]);
    const list = names(zip);
    assert.ok(list.includes('manifest.json') && list.includes('sidepanel.html') && list.includes('agent.js') && list.includes('lib/zip.js') && list.includes('panel/boot.js') && list.includes('icons/icon128.png'));
    const bad = list.filter((n) => /^(test|e2e|docs|scripts|node_modules|\.github)\//.test(n) || /^(README|CHANGELOG|CONTRIBUTING|SECURITY|package|eslint|LICENSE)/.test(n) || /\.(md|zip|log)$/.test(n));
    assert.deepEqual(bad, []);
    // every file the manifest and the panel page refer to is in the ZIP
    const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
    for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(list.includes(src), src);
    assert.ok(list.every((n, i) => i === 0 || list[i - 1] <= n), 'sorted');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the source ZIP leaves out installs, builds, archives and secrets', { skip: !hasUnzip }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-pkg-'));
  try {
    run(out);
    const list = names(path.join(out, `DevForge-${version}-source.zip`));
    assert.ok(list.includes('devforge/manifest.json') && list.includes('devforge/test/package.test.js') && list.includes('devforge/scripts/package.js'));
    assert.deepEqual(list.filter((n) => /node_modules|release-out|\.zip$|\.pem$|\/\.env/.test(n)), []);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
