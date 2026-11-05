// Style check: flags wording that makes text read as filler, in the docs, the interface strings and the
// code comments, and checks that the Guide stays easy to read. Part of `npm run check`.
// A flagged word that is right where it stands goes in scripts/style-allow.json with a reason.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const BANNED = [
  /\bcomprehensive(ly)?\b/i,
  /\brobust(ly|ness)?\b/i,
  /\bseamless(ly)?\b/i,
  /\bleverag(e|es|ed|ing)\b/i,
  /\butili[sz](e|es|ed|ing)\b/i,
  /\bdelv(e|es|ed|ing)\b/i,
  /\bcutting[- ]edge\b/i,
  /\bpowerful\b/i,
  /\bin order to\b/i,
  /\bit is important to note\b/i,
  /\bensures? that\b/i,
  /\ba variety of\b/i,
];

const TEXT_FILES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'PRIVACY.md', 'SECURITY.md'];
const TEXT_DIRS = ['docs'];
const CODE_DIRS = ['lib', 'panel', 'agent'];
const CODE_FILES = ['agent.js', 'background.js', 'netcap.js', 'netbridge.js', 'sandbox.js', 'sandbox.html', 'sidepanel.html', 'scripts/check.js', 'scripts/package.js'];
const VENDORED = /^lib\/(acorn|beautifier)/;
const MAX_AVERAGE_WORDS = 18;

function listFiles(rootDir) {
  const out = [];
  for (const f of TEXT_FILES) if (fs.existsSync(path.join(rootDir, f))) out.push(f);
  for (const d of TEXT_DIRS) {
    const dir = path.join(rootDir, d);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) out.push(d + '/' + f);
  }
  for (const d of CODE_DIRS) {
    const dir = path.join(rootDir, d);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.js') && !VENDORED.test(d + '/' + f)) out.push(d + '/' + f);
  }
  for (const f of CODE_FILES) if (fs.existsSync(path.join(rootDir, f))) out.push(f);
  return out;
}

function loadAllow(rootDir) {
  const p = path.join(rootDir, 'scripts', 'style-allow.json');
  if (!fs.existsSync(p)) return [];
  const list = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const e of list) if (!e.file || !e.term || !e.reason) throw new Error('scripts/style-allow.json: every entry needs file, term and reason');
  return list;
}

// Returns a list of problem texts. rootDir defaults to the repository.
function run(rootDir = root) {
  const problems = [];
  const allow = loadAllow(rootDir);
  const used = new Set();
  for (const file of listFiles(rootDir)) {
    const lines = fs.readFileSync(path.join(rootDir, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const re of BANNED) {
        const m = re.exec(line);
        if (!m) continue;
        const hit = allow.findIndex((a) => a.file === file && m[0].toLowerCase() === a.term.toLowerCase());
        if (hit >= 0) used.add(hit);
        else problems.push(`${file}:${i + 1}: "${m[0]}" reads as filler. Say what it does, or add it to scripts/style-allow.json with a reason.`);
      }
    });
  }
  allow.forEach((a, i) => {
    if (!used.has(i)) problems.push(`scripts/style-allow.json: "${a.term}" in ${a.file} is not used any more. Remove the entry.`);
  });
  // The Guide is written for beginners: short sentences.
  const guidePath = path.join(rootDir, 'lib', 'guide.js');
  if (fs.existsSync(guidePath)) {
    delete require.cache[require.resolve(guidePath)];
    const s = require(guidePath).readingStats();
    if (s.average > MAX_AVERAGE_WORDS) problems.push(`lib/guide.js: sentences average ${s.average.toFixed(1)} words (limit ${MAX_AVERAGE_WORDS}).`);
  }
  return problems;
}

if (require.main === module) {
  const problems = run();
  if (problems.length) {
    console.error(problems.map((p) => '✗ ' + p).join('\n'));
    process.exit(1);
  }
  console.log('ok: style check');
}
module.exports = { run, BANNED, MAX_AVERAGE_WORDS };
