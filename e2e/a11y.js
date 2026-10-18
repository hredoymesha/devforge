/*
 * Accessibility sweep: runs axe-core over every panel (dark and light theme, 1280 px and 360 px) in
 * the real extension, in Chromium. Needs Playwright like the e2e suite (see README). Run: npm run a11y
 * It checks each panel's initial state against WCAG 2.x A/AA rules that axe can decide automatically;
 * it does not replace keyboard and screen-reader testing (docs/ACCESSIBILITY.md has the manual checklist).
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { chromium } = (() => {
  for (const id of ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright']) {
    if (!id) continue;
    try {
      return require(id);
    } catch (_) {
      /* try the next place */
    }
  }
  throw new Error('Playwright not found. Install it or set PLAYWRIGHT_MODULE.');
})();
const root = path.resolve(__dirname, '..');
const axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
(async () => {
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>T</title><h1>Test page</h1><p id=p>hello</p><a href="/x">link</a><button>b</button>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'axe-'));
  for (const f of ['manifest.json','background.js','sidepanel.html','sidepanel.css','agent.js','agent','lib','panel','netcap.js','netbridge.js','sandbox.html','sandbox.js','icons']) fs.cpSync(path.join(root,f), path.join(dest,f), {recursive:true});
  const m = JSON.parse(fs.readFileSync(path.join(dest,'manifest.json'))); m.host_permissions = ['<all_urls>']; fs.writeFileSync(path.join(dest,'manifest.json'), JSON.stringify(m));
  const ctx = await chromium.launchPersistentContext(path.join(dest,'p'), { headless:false, executablePath: process.env.CHROME_PATH || chromium.executablePath(), args:['--headless=new','--no-sandbox','--disable-extensions-except='+dest,'--load-extension='+dest]});
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const target = await ctx.newPage(); await target.goto(url);
  const tabId = await sw.evaluate(async (p) => (await chrome.tabs.query({ url: p }))[0].id, url + '*');
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.evaluate((tid) => { chrome.tabs.query = async () => [await chrome.tabs.get(tid)]; }, tabId);
  await panel.evaluate(axeSrc); // the source is evaluated by the driver, not by page code
  const ids = await panel.evaluate(() => [...ORDER]);
  const rows = [];
  for (const theme of ['dark', 'light']) {
    await panel.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
    for (const w of [1280, 360]) {
      await panel.setViewportSize({ width: w, height: 800 });
      for (const t of ids) {
        await panel.evaluate((x) => show(x), t); await panel.waitForTimeout(400);
        await panel.keyboard.press('Escape');
        const res = await panel.evaluate(async () => { const r = await window.axe.run(document, { resultTypes: ['violations'] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ') + ' :: ' + (n.any[0] || n.all[0] || n.none[0] || {}).message) })); });
        for (const v of res) rows.push({ theme, w, tab: t, ...v });
      }
    }
  }
  const bad = rows.filter((r) => r.impact === 'serious' || r.impact === 'critical' || process.argv.includes('--strict'));
  for (const r of rows) console.log(`${r.impact || '?'}\t${r.id}\t${r.tab}/${r.theme}/${r.w}px\t${r.n} node(s)\t${r.sample[0] || ''}`);
  console.log(`${rows.length} violation(s) across ${ids.length} panels x 2 themes x 2 widths`);
  process.exitCode = bad.length ? 1 : 0;
  await ctx.close(); srv.close(); fs.rmSync(dest, { recursive: true, force: true });
})().catch((e) => { console.error('ERR', e); process.exit(1); });
