const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

// A copy of the repository without the dev tools, so a test can break one file and run the real
// scripts/check.js against it.
function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-check-'));
  fs.cpSync(root, dir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.git|release-out)([\\/]|$)/.test(src),
  });
  return dir;
}
const runCheck = (dir) => spawnSync(process.execPath, ['scripts/check.js'], { cwd: dir, encoding: 'utf8' });

test('editing a vendored file makes the static check fail', () => {
  const dir = copyRepo();
  try {
    fs.appendFileSync(path.join(dir, 'lib', 'acorn.js'), '\n// local edit\n');
    const r = runCheck(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lib\/acorn\.js does not match its recorded SHA-256/);
    assert.doesNotMatch(r.stderr, /beautifier/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted vendored file is reported, not skipped', () => {
  const dir = copyRepo();
  try {
    fs.rmSync(path.join(dir, 'lib', 'beautifier.min.js'));
    const r = runCheck(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lib\/beautifier\.min\.js is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a version that differs between the manifest, package files and changelog makes the check fail', () => {
  for (const [file, from, to] of [['package.json', /"version": "[^"]+"/, '"version": "9.9.9"'], ['CHANGELOG.md', /^## \d+\.\d+\.\d+/m, '## 9.9.9']]) {
    const dir = copyRepo();
    try {
      const p = path.join(dir, file);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to));
      const r = runCheck(dir);
      assert.equal(r.status, 1, file);
      assert.match(r.stderr, /versions differ/, file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
