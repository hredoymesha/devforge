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
