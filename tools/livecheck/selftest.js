// Proves the audit catches what it should. It builds broken copies of a good ZIP and expects a failure each time.
// Usage: node selftest.js <good-extension.zip>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZip } = require('./lib/zipread');
const { writeZip } = require('./lib/zipwrite');
const { audit } = require('./lib/audit');

const good = process.argv[2];
if (!good) {
  console.log('Usage: node selftest.js <good-extension.zip>');
  process.exit(2);
}
const base = readZip(fs.readFileSync(good));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-self-'));
const reasons = path.join(__dirname, 'permission-reasons.json');
const mod = (fn) => fn(base.map((f) => ({ name: f.name, data: Buffer.from(f.data) })));
const manifestOf = (files) => JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString());
const withManifest = (files, fn) => {
  const m = manifestOf(files);
  fn(m);
  files.find((f) => f.name === 'manifest.json').data = Buffer.from(JSON.stringify(m));
  return files;
};

const cases = [
  ['the good ZIP passes', (f) => f, null],
  ['a source map is found', (f) => [...f, { name: 'lib/x.js.map', data: '{}' }], /hidden files, source maps/],
  ['a test folder is found', (f) => [...f, { name: 'test/a.test.js', data: 'x' }], /development folders/],
  ['a new permission with no reason is found', (f) => withManifest(f, (m) => m.permissions.push('history')), /Reason written for "history"/],
  ['the debugger permission is found', (f) => withManifest(f, (m) => m.permissions.push('debugger')), /"debugger" is not requested/],
  ['a missing icon file is found', (f) => f.filter((x) => x.name !== 'icons/icon128.png'), /Icon 128/],
  ['a manifest that points at a missing file is found', (f) => f.filter((x) => x.name !== 'background.js'), /Every file the manifest names/],
  ['an unsafe CSP is found', (f) => withManifest(f, (m) => { m.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'; object-src 'self'"; }), /only their own scripts/],
  ['a remote script in a page is found', (f) => [...f, { name: 'x.html', data: '<script src="https://evil.example/a.js"></script>' }], /No remote script/],
  ['a real eval() call is found', (f) => [...f, { name: 'lib/evil.js', data: 'const r = eval(input);' }], /eval\(\) or new Function\(\)/],
  ['an API used without its permission is found', (f) => [...f, { name: 'lib/evil2.js', data: 'chrome.history.search({text:""});' }], /without its permission/],
  ['a long description is found', (f) => withManifest(f, (m) => { m.description = 'x'.repeat(140); }), /Description/],
  ['a manifest version 2 is found', (f) => withManifest(f, (m) => { m.manifest_version = 2; }), /Manifest version 3/],
];


// ---- live part: break the panel on purpose and expect the browser run to notice ----
async function liveCases() {
  const site = require('./lib/site');
  const walk = require('./lib/walk');
  const report = require('./lib/report');
  const files = mod((f) => {
    const boot = f.find((x) => x.name === 'panel/boot.js');
    boot.data = Buffer.concat([boot.data, Buffer.from([
      '\nfetch("https://devforge-selftest.invalid/ping").catch(function () {});',
      'console.error("selftest console error");',
      'setTimeout(function () { throw new Error("selftest uncaught error"); }, 1200);',
      'setTimeout(function () { try { document.body.innerHTML = "<b>x</b>"; } catch (e) { /* refused */ } }, 1500);',
      // The 4.4.2 Playground bug: a box filled with the word "undefined".
      'setTimeout(function () { var t = DF.tabs.find(function (x) { return x.id === "play"; }); var r = t.render; t.render = function (v) { var p = r(v); setTimeout(function () { var ta = v.querySelector("textarea"); if (ta) ta.value = "undefined"; }, 100); return p; }; }, 0);',
    ].join('\n'))]);
    return f;
  });
  const s = await site.start();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-live-'));
  let live;
  try {
    live = await walk.run({ files, site: s, outDir: out, headed: false, slow: 0, chromePath: undefined, extraUrls: [], log: () => {} });
  } finally {
    s.close();
  }
  const { summary } = { summary: report.write(out, { zip: 'selftest.zip', manifest: {}, audit: [], live, started: '' }) };
  const text = fs.readFileSync(path.join(out, 'report.json'), 'utf8');
  const checks = [
    ['an outside request from the extension is found', live.network.external.some((u) => /devforge-selftest\.invalid/.test(u))],
    ['a console error is found', live.errors.console.some((m) => /selftest console error/.test(m))],
    ['an uncaught error is found', live.errors.page.some((m) => /selftest uncaught error/.test(m))],
    ['a Trusted Types violation is found', live.errors.violations.length > 0],
    ['a text box that shows "undefined" is found', live.flows.some((f) => /Playground/.test(f.name) && !f.ok)],
    ['the run is marked as failed', summary.fail >= 3],
  ];
  fs.rmSync(out, { recursive: true, force: true });
  return { checks, text };
}

let bad = 0;
for (const [name, build, expect] of cases) {
  const zip = path.join(dir, 'case.zip');
  fs.writeFileSync(zip, writeZip(mod(build)));
  const r = audit(zip, reasons).checks.filter((c) => c.level === 'fail' || c.level === 'warn');
  const hit = expect ? r.some((c) => expect.test(c.text)) : r.every((c) => c.level !== 'fail');
  console.log((hit ? '  ok   ' : '  FAIL ') + name);
  if (!hit) bad++;
}
fs.rmSync(dir, { recursive: true, force: true });
(async () => {
  if (process.argv.includes('--live')) {
    console.log('Live cases (about one minute)');
    const r = await liveCases();
    for (const [name, ok] of r.checks) {
      console.log((ok ? '  ok   ' : '  FAIL ') + name);
      if (!ok) bad++;
    }
  }
  console.log(bad ? `${bad} case(s) were not caught` : 'All cases behave as expected.');
process.exit(bad ? 1 : 0);
})();
