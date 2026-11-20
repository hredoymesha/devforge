#!/usr/bin/env node
// Checks a DevForge extension ZIP before it goes to the Chrome Web Store.
//   node livecheck.js --zip DevForge-4.5.0-extension.zip [--headed] [--slow 150] [--url https://example.com]
const fs = require('fs');
const path = require('path');
const { audit } = require('./lib/audit');
const { readZip } = require('./lib/zipread');
const site = require('./lib/site');
const report = require('./lib/report');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes('--' + name);

if (flag('help') || !opt('zip')) {
  console.log('Usage: node livecheck.js --zip <extension.zip> [--out folder] [--headed] [--slow ms] [--url https://...] [--audit-only]');
  process.exit(opt('zip') ? 0 : 2);
}

(async () => {
  const zipPath = path.resolve(opt('zip'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(opt('out') || path.join('livecheck-report', stamp));
  fs.mkdirSync(outDir, { recursive: true });
  const log = (s) => console.log(s);

  log('1/3 Checking the package');
  const a = audit(zipPath, path.join(__dirname, 'permission-reasons.json'));
  const files = readZip(fs.readFileSync(zipPath));
  const data = { zip: path.basename(zipPath), manifest: a.manifest || {}, audit: a.checks, live: null, started: new Date().toISOString() };
  for (const c of a.checks.filter((x) => x.level === 'fail')) log('  FAIL ' + c.text + (c.detail ? ' - ' + c.detail : ''));
  log(`  ${a.checks.filter((x) => x.level === 'pass').length} passed, ${a.checks.filter((x) => x.level === 'warn').length} to look at, ${a.checks.filter((x) => x.level === 'fail').length} failed`);

  if (!flag('audit-only') && !a.checks.some((c) => c.level === 'fail' && c.group === 'Package' && /read/.test(c.text))) {
    log('2/3 Opening the extension in a real browser');
    const s = await site.start();
    try {
      data.live = await require('./lib/walk').run({
        files, site: s, outDir, headed: flag('headed'), slow: Number(opt('slow') || 0), chromePath: opt('chrome'),
        extraUrls: args.filter((x, i) => args[i - 1] === '--url'), log,
      });
    } catch (e) {
      data.live = { fatal: String(e.message || e) };
      log('  The live run stopped: ' + data.live.fatal);
    } finally {
      s.close();
    }
  }

  log('3/3 Writing the report');
  const summary = report.write(outDir, data);
  log(`  ${path.join(outDir, 'report.html')}`);
  log(`  ${summary.fail} failed, ${summary.warn} to look at, ${summary.pass} passed`);
  process.exitCode = summary.fail ? 1 : 0;
})().catch((e) => {
  console.error('Stopped: ' + (e.stack || e));
  process.exit(2);
});
