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
  const skip = new Set(['node_modules', '.git', '.claude', 'backups']);
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
if (/<all_urls>|\*:\/\/\*\//.test(JSON.stringify(manifest.host_permissions || []))) {
  problems.push('manifest declares required host permissions; keep them optional');
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

if (problems.length) {
  console.error(problems.map((p) => '✗ ' + p).join('\n'));
  process.exit(1);
}
console.log(`ok: ${tracked.filter((f) => f.endsWith('.js')).length} JS files, manifest and references`);
