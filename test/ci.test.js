const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
// Strip comments so the checks look at what the workflow does, not at what it says it does not do.
const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('CI is read-only: contents:read is the only permission and nothing can write', () => {
  assert.match(code, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(code, /:\s*write\b/, 'no permission may be granted write');
  assert.doesNotMatch(code, /permissions:\s*write-all/);
});

test('CI never commits, pushes, publishes, deploys, uploads or uses secrets', () => {
  for (const bad of [/git\s+(push|commit|tag)/, /gh\s+(pr|release|api|repo)/, /npm\s+publish/, /upload-artifact|upload-pages|deploy-pages/, /secrets\./, /GITHUB_TOKEN/, /softprops\/action-gh-release|actions\/create-release/])
    assert.doesNotMatch(code, bad, String(bad));
});

test('every checkout drops the repository token from the workspace', () => {
  const checkouts = code.split('\n').filter((l) => /uses:\s*actions\/checkout@/.test(l)).length;
  const drops = (code.match(/persist-credentials:\s*false/g) || []).length;
  assert.ok(checkouts >= 1);
  assert.equal(drops, checkouts);
});

test('CI triggers on pull requests and does not use pull_request_target', () => {
  assert.match(code, /^on:\n(?:.*\n)*?\s+pull_request:/m);
  assert.doesNotMatch(code, /pull_request_target/);
});

test('every action is pinned to a full commit SHA with a version comment', () => {
  const uses = wf.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(uses.length >= 4);
  for (const l of uses) {
    assert.match(l, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/, 'not pinned: ' + l.trim());
  }
});

test('a tag or branch reference instead of a SHA would be caught', () => {
  const re = /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+\s*$/;
  assert.ok(!re.test('      - uses: actions/checkout@v4'));
  assert.ok(!re.test('      - uses: actions/checkout@main # v4.4.0'));
  assert.ok(re.test('      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0'));
});
