const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tool = path.join(root, 'tools', 'livecheck');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const reasons = JSON.parse(fs.readFileSync(path.join(tool, 'permission-reasons.json'), 'utf8'));

test('the live check has one reason for each permission and host pattern in the manifest, and no others', () => {
  assert.deepEqual(Object.keys(reasons.permissions).sort(), [...manifest.permissions, ...(manifest.optional_permissions || [])].sort());
  assert.deepEqual(Object.keys(reasons.host_permissions).sort(), [...manifest.host_permissions].sort());
  for (const text of [...Object.values(reasons.permissions), ...Object.values(reasons.host_permissions), reasons.single_purpose]) {
    assert.ok(text.length > 20 && !/needed for functionality/i.test(text), text);
  }
});

test('the package check of the live check passes on the extension ZIP npm run package makes', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-lc-'));
  try {
    execFileSync(process.execPath, ['scripts/package.js', '--out', out], { cwd: root });
    const zip = path.join(out, `DevForge-${manifest.version}-extension.zip`);
    // --audit-only needs no browser, so this runs where Playwright is not installed.
    const r = spawnSync(process.execPath, [path.join(tool, 'livecheck.js'), '--zip', zip, '--audit-only', '--out', path.join(out, 'report')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, / 0 failed/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
