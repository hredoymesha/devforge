// Static checks that need no dependencies: JS syntax, manifest sanity and script/file references.
// Run with `npm run check`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const problems = [];

// Git's file list when this is a checkout; a directory walk otherwise (for example in a restored
// backup, which has no .git).
function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
    if (out.length) return out;
  } catch (_) {
    /* not a git checkout */
  }
  const skip = new Set(['node_modules', '.git', 'release-out']);
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) found.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(root);
  return found;
}
const tracked = listFiles();

for (const file of tracked.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { cwd: root, stdio: 'pipe' });
  } catch (e) {
    problems.push(`syntax error in ${file}: ${String(e.stderr).split('\n')[0]}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.description.length > 132) {
  problems.push(`manifest description is ${manifest.description.length} characters (limit 132)`);
}
// All-sites access is a required host permission on purpose (Settings → Site access
// can still limit DevForge to chosen sites). What must stay out is the debugger permission: it shows
// Chrome's \"is debugging this browser\" bar and nothing in DevForge needs it.
if ((manifest.permissions || []).includes('debugger') || (manifest.optional_permissions || []).includes('debugger')) {
  problems.push('manifest requests the debugger permission, which DevForge deliberately does not use');
}
if (manifest.optional_host_permissions && manifest.host_permissions) {
  problems.push('manifest lists host access as both required and optional');
}

// Every script the side panel loads, and every file the panel injects, must exist.
const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
  if (!fs.existsSync(path.join(root, src))) problems.push(`sidepanel.html loads missing ${src}`);
}
const core = fs.readFileSync(path.join(root, 'panel/core.js'), 'utf8');
const agentList = core.match(/const AGENT_FILES = \[([\s\S]*?)\];/);
for (const [, src] of (agentList ? agentList[1] : '').matchAll(/'([^']+)'/g)) {
  if (!fs.existsSync(path.join(root, src))) problems.push(`AGENT_FILES lists missing ${src}`);
}

// A file that is never loaded is dead weight or a forgotten registration.
const loaded = new Set([...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]));
for (const file of tracked.filter((f) => /^(lib|panel)\/[^/]+\.js$/.test(f))) {
  if (!loaded.has(file)) problems.push(`${file} is not loaded by sidepanel.html`);
}
const injected = new Set([...(agentList ? agentList[1] : '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
for (const file of tracked.filter((f) => /^agent\/[^/]+\.js$/.test(f))) {
  if (!injected.has(file)) problems.push(`${file} is not in AGENT_FILES`);
}

// The capture log must never be reachable from the page again: no global named __dfNet (the
// extension-side key holder __dfNetKey lives in the isolated world and is a different name).
for (const file of tracked.filter((f) => /^(netcap|netbridge|agent)\.js$|^(panel|lib|agent)\/.*\.js$/.test(f))) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (/__dfNet(?!Key)/.test(text)) problems.push(`${file} mentions __dfNet: the capture log must stay private to netcap.js`);
}

// The agent version is declared in two places and must match.
const agentVersion = (text) => (text.match(/AGENT_VERSION = (\d+)/) || [])[1];
const agentSrc = fs.readFileSync(path.join(root, 'agent.js'), 'utf8');
if (agentVersion(core) !== agentVersion(agentSrc)) {
  problems.push(
    `AGENT_VERSION differs: panel/core.js=${agentVersion(core)} agent.js=${agentVersion(agentSrc)}`
  );
}

// Wording: filler words in the docs, interface strings and comments (scripts/style-check.js).
problems.push(...require('./style-check.js').run(root));

// One version everywhere: the manifest, both npm files and the newest changelog heading.
const versionOf = (file, pick) => {
  try {
    return pick(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (_) {
    return undefined;
  }
};
const versions = {
  'manifest.json': manifest.version,
  'package.json': versionOf('package.json', (t) => JSON.parse(t).version),
  'package-lock.json': versionOf('package-lock.json', (t) => JSON.parse(t).version),
  'package-lock.json (root package)': versionOf('package-lock.json', (t) => JSON.parse(t).packages[''].version),
  'newest CHANGELOG.md heading': versionOf('CHANGELOG.md', (t) => (t.match(/^## (\d+\.\d+\.\d+)\s*$/m) || [])[1]),
};
if (new Set(Object.values(versions)).size !== 1) problems.push('versions differ: ' + Object.entries(versions).map(([k, v]) => k + '=' + v).join(', '));

// Vendored third-party files must stay byte-for-byte what was published. Each hash below was
// compared with the file inside the upstream npm package (acorn 8.18.0 dist/acorn.js; js-beautify
// 1.15.3 and 1.15.4 ship the same js/lib/beautifier.min.js). To update one, replace the file with the
// new release, check it against the package, then change the hash and the version in the README.
const VENDORED = {
  'lib/acorn.js': 'fc3ed7b81e58464715d0291402892f22c3d86ea75302645a330390f85d8015c9',
  'lib/beautifier.min.js': 'b65a96529bb399195df6209af009398ded3ecc1fe09d097f6a9f0056540adf54',
};
const sha256 = (file) => require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const [file, want] of Object.entries(VENDORED)) {
  if (!fs.existsSync(path.join(root, file))) problems.push(`${file} is missing`);
  else if (sha256(file) !== want) problems.push(`${file} does not match its recorded SHA-256. Vendored files are not edited; see scripts/check.js`);
}

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`ok: ${tracked.filter((f) => f.endsWith('.js')).length} JS files, manifest and references`);
