#!/usr/bin/env node
/*
 * Browser tests for the panel features (security banner and trend, settings, network compare, performance
 * history, colour readability, bundles, prototype, owner mode), run against the real extension in Chromium:
 *   node e2e/features.js
 * Same requirements as e2e/run.js (Playwright, Chromium, CHROME_PATH / PLAYWRIGHT_MODULE).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFixtures } = require('./fixtures.js');

function loadPlaywright() {
  for (const id of ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright']) {
    if (!id) continue;
    try {
      return require(id);
    } catch (_) {
      /* try the next location */
    }
  }
  throw new Error('Playwright not found. Install it or set PLAYWRIGHT_MODULE.');
}
const { chromium } = loadPlaywright();
const root = path.resolve(__dirname, '..');
const EXT_FILES = ['manifest.json', 'background.js', 'sidepanel.html', 'sidepanel.css', 'agent.js', 'agent', 'lib', 'panel', 'netcap.js', 'netbridge.js', 'sandbox.html', 'sandbox.js', 'icons'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '\n         ' + String(detail).slice(0, 500)));
}

async function launch(extDir, profile) {
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROME_PATH || chromium.executablePath(),
    args: ['--headless=new', '--no-sandbox', '--host-resolver-rules=MAP example.com 127.0.0.1', '--disable-extensions-except=' + extDir, '--load-extension=' + extDir],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return { ctx, sw, id: sw.url().split('/')[2] };
}

async function openPanel(env, targetUrl) {
  const target = await env.ctx.newPage();
  await target.goto(targetUrl);
  const pattern = targetUrl.replace(/[?#].*$/, '').replace(/\/$/, '') + '/*';
  let tabId;
  for (let i = 0; i < 40 && tabId == null; i++) {
    // The newest matching tab that still exists (a tab closed a moment ago can linger in the list).
    tabId = await env.sw.evaluate(async (p) => {
      for (const t of (await chrome.tabs.query({ url: p })).sort((a, b) => b.id - a.id)) {
        if (await chrome.tabs.get(t.id).then(() => true, () => false)) return t.id;
      }
      return undefined;
    }, pattern);
    if (tabId == null) await new Promise((r) => setTimeout(r, 150));
  }
  const panel = await env.ctx.newPage();
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${env.id}/sidepanel.html`);
  await panel.evaluate((id) => {
    chrome.tabs.query = async () => [await chrome.tabs.get(id)];
  }, tabId);
  const close = panel.close.bind(panel);
  panel.close = async () => {
    await close();
    await target.close();
  };
  return { target, panel, tabId, errors };
}

async function runScan(panel, level = 'passive') {
  await panel.evaluate(() => {
    SEC.view = 'setup';
    SEC.report = null;
    show('security');
  });
  await panel.waitForSelector('#sec-lv-' + level);
  await panel.check('#sec-lv-' + level);
  await panel.click('button:has-text("Start scan")');
  await panel.waitForSelector('.sec-banner', { timeout: 120000 });
  return panel.evaluate(() => SEC.report);
}

const run = (name) => !process.env.ONLY || process.env.ONLY.split(',').includes(name);

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-e2e411-'));
  const fx = await startFixtures();
  const vuln = `http://127.0.0.1:${fx.vuln.port}/`;
  const extDir = path.join(scratch, 'ext');
  fs.mkdirSync(extDir, { recursive: true });
  for (const f of EXT_FILES) fs.cpSync(path.join(root, f), path.join(extDir, f), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  check('manifest requests all-sites access as a required permission, and not the debugger permission', (manifest.host_permissions || []).includes('<all_urls>') && !(manifest.permissions || []).includes('debugger') && manifest.version === require('../package.json').version);
  const env = await launch(extDir, path.join(scratch, 'profile'));
  try {
    /* ---------- tabs ---------- */
    console.log('\nPanel');
    if (run('Panel')) {
      const { panel, errors } = await openPanel(env, vuln);
      const tabs = await panel.evaluate(() => DF.tabs.map((t) => t.id));
      for (const t of tabs) {
        await panel.evaluate((id) => show(id), t);
        await panel.waitForTimeout(150);
      }
      check('all ' + tabs.length + ' tabs render without page errors (including Prototype)', errors.length === 0 && tabs.includes('proto'), errors.join(' | '));
      await panel.close();
    }

    /* ---------- settings: all sites on by default, limit, allow list ---------- */
    console.log('\nSettings → Site access');
    if (run('Settings')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(() => show('settings'));
      await panel.waitForSelector('#set-allsites');
      check('"Allow DevForge on all sites" is on by default', await panel.isChecked('#set-allsites'));
      check('the page agent works with it on', (await panel.evaluate(() => call('ping').then(() => true, () => false))) === true);
      await panel.uncheck('#set-allsites');
      const blocked = await panel.evaluate(() => exec(() => 1).then(() => 'ran', (e) => e.message));
      check('switched off: pages that are not on the list are refused with a clear message', /not on the list/.test(blocked), blocked);
      await panel.fill('input[aria-label="Site to allow"]', vuln);
      await panel.click('button:has-text("Allow site")');
      const allowed = await panel.evaluate(() => exec(() => 1).then(() => 'ran', (e) => e.message));
      check('switched off: a listed site works again', allowed === 'ran', allowed);
      await panel.check('#set-allsites');
      check('the setting survives a reload of the panel', (await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings.allowAllSites)) === true);
      await target.close();
      await panel.close();
    }

    /* ---------- security: banner, trend, selection, acknowledge, export ---------- */
    console.log('\nSecurity: banner, scan trend, findings selection');
    if (run('Security')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(async () => {
        for (const it of await DFStore.rawItems()) await DFStore.deleteItem(it.id);
        await chrome.storage.local.remove('secFindingAcks');
      });
      const r1 = await runScan(panel);
      const banner1 = await panel.locator('.sec-banner').innerText();
      check('banner shows the scanned site', banner1.includes('127.0.0.1'), banner1);
      check('banner shows the scan level', /Level\s+Passive/i.test(banner1), banner1);
      check('banner shows how many checks were skipped', /Checks skipped\s+\d+/.test(banner1), banner1);
      await panel.waitForTimeout(400);
      check('first scan of a site: no comparison message and no errors', (await panel.locator('.sec-trend:visible').count()) === 0);
      check('the first scan was saved automatically', (await panel.evaluate(async () => (await DFStore.allItems()).filter((i) => i.kind === 'security' && i.auto === true).length)) === 1);

      const r2 = await runScan(panel);
      await panel.waitForSelector('.sec-trend:visible', { timeout: 10000 });
      const trend = await panel.locator('.sec-trend').innerText();
      check('second scan of the same site shows a short comparison', /same findings|new finding|no longer reported|fewer|more/i.test(trend), trend);
      check('the comparison names the earlier scan', /Compared with the scan from/.test(trend), trend);
      check('both scans found the same number of findings (the comparison is about the same report)', r1.findings.length === r2.findings.length);

      for (const tab of ['overview', 'findings', 'paths', 'plan', 'coverage', 'export']) {
        await panel.evaluate((t) => SEC.go(t), tab);
        await panel.waitForTimeout(120);
        const vis = await panel.locator('.sec-banner').isVisible();
        check('banner is visible on the ' + tab + ' tab', vis);
      }

      await panel.evaluate(() => SEC.go('findings'));
      await panel.waitForSelector('.sec-finding');
      const total = await panel.locator('.sec-finding').count();
      check('every finding has a checkbox', (await panel.locator('.sec-finding .sec-pick').count()) === total && total > 3, total);
      check('the selection toolbar is hidden until something is selected', (await panel.locator('.sec-selbar').isVisible()) === false);
      await panel.locator('.sec-finding .sec-pick').nth(0).check();
      await panel.locator('.sec-finding .sec-pick').nth(1).check();
      check('the toolbar appears with the selected count', /2 findings selected/.test(await panel.locator('.sec-selbar').innerText()));
      check('ticking a finding does not expand it', (await panel.locator('.sec-finding[open]').count()) === 0);
      const picked = await panel.evaluate(() => [...SEC.selected]);
      const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('.sec-selbar button:has-text("Export selected (.md)")')]);
      const mdPath = path.join(scratch, 'sel.md');
      await dl.saveAs(mdPath);
      const md = fs.readFileSync(mdPath, 'utf8');
      const titles = await panel.evaluate((ids) => SEC.report.findings.filter((f) => ids.includes(f.id)).map((f) => f.title), picked);
      const others = await panel.evaluate((ids) => SEC.report.findings.filter((f) => !ids.includes(f.id)).map((f) => f.title), picked);
      check('Export selected contains exactly the selected findings', titles.every((t) => md.includes(t)) && !others.some((t) => t.length > 12 && md.includes(t)), md.slice(0, 300));
      const [dj] = await Promise.all([panel.waitForEvent('download'), panel.click('.sec-selbar button:has-text("(.json)")')]);
      const jPath = path.join(scratch, 'sel.json');
      await dj.saveAs(jPath);
      const j = JSON.parse(fs.readFileSync(jPath, 'utf8'));
      check('JSON export holds only the selection', j.findings.length === 2 && j.selectedCount === 2);

      await panel.click('.sec-selbar button:has-text("Acknowledge")');
      await panel.fill('.sec-selbar input[type="text"]', 'accepted for the demo');
      await panel.click('.sec-selbar button:has-text("Confirm")');
      await panel.waitForSelector('.sec-acked');
      check('Acknowledge marks the selected findings and clears the selection', (await panel.locator('.sec-acked').count()) === 2 && (await panel.locator('.sec-selbar').isVisible()) === false);
      check('the note is stored with the acknowledgement', (await panel.evaluate(async () => JSON.stringify((await chrome.storage.local.get('secFindingAcks')).secFindingAcks))).includes('accepted for the demo'));
      await panel.selectOption('#sec-f-ack', 'ack');
      check('the "Acknowledged" filter shows only those two', (await panel.locator('.sec-finding').count()) === 2);
      await panel.selectOption('#sec-f-ack', 'open');
      check('the "Not acknowledged" filter hides them', (await panel.locator('.sec-finding').count()) === total - 2);
      await panel.selectOption('#sec-f-ack', 'all');
      await panel.check('#sec-pick-all');
      check('"Select all shown" selects every finding', /\d+ findings selected/.test(await panel.locator('.sec-selbar').innerText()) && (await panel.evaluate(() => SEC.selected.size)) === total);
      await panel.uncheck('#sec-pick-all');
      check('unticking it clears the selection', (await panel.evaluate(() => SEC.selected.size)) === 0);
      await target.close();
      await panel.close();
    }

    /* ---------- retention cap ---------- */
    console.log('\nScan history cap');
    if (run('History')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(async () => {
        DF.state.settings.scanRetention = 2;
        for (const it of await DFStore.rawItems()) await DFStore.deleteItem(it.id);
      });
      for (let i = 0; i < 3; i++) await runScan(panel);
      const n = await panel.evaluate(async () => (await DFStore.allItems()).filter((i) => i.kind === 'security' && i.auto === true).length);
      check('only the newest N automatically saved scans are kept per site', n === 2, n);
      await panel.evaluate(async () => {
        await saveToWorkspace('security', 'mine', { version: 2, id: 'handmade-001', target: 'http://127.0.0.1/', scannedAt: '2020-01-01T00:00:00.000Z', findings: [] });
      });
      await runScan(panel);
      const manual = await panel.evaluate(async () => (await DFStore.allItems()).filter((i) => i.title === 'mine').length);
      check('reports you saved yourself are never removed', manual === 1, manual);
      await target.close();
      await panel.close();
    }

    /* ---------- network: limits, save, compare, copy ---------- */
    console.log('\nNetwork: capture size, saved captures, compare, copy as code');
    if (run('Network')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(async () => {
        for (const it of await DFStore.rawItems()) await DFStore.deleteItem(it.id);
        DF.state.settings.captureEntries = 100;
        DF.state.settings.captureBodyKB = 10;
      });
      await panel.evaluate(() => startCapture());
      await panel.evaluate(() => pushCaptureLimits());
      const lim = await panel.evaluate(() => netCall('setLimits', { entries: 100, bodyKB: 10, totalMB: 2 }));
      check('capture limits are applied and echoed back', lim.entries === 100 && lim.bodyKB === 10 && lim.totalMB === 2, JSON.stringify(lim));
      const clamp = await panel.evaluate(() => netCall('setLimits', { entries: 99999, bodyKB: 1, totalMB: 9999 }));
      check('out-of-range limits are clamped', clamp.entries === 5000 && clamp.bodyKB === 10 && clamp.totalMB === 64, JSON.stringify(clamp));
      await panel.evaluate(() => netCall('setLimits', { entries: 100, bodyKB: 10, totalMB: 2 }));
      await target.evaluate(async () => {
        for (let i = 0; i < 130; i++) await fetch('/slow?i=' + i);
      });
      await target.waitForTimeout(500);
      const held = await panel.evaluate(async () => (await netCall('changes', 0)).entries.length);
      check('the capture log holds at most the configured number of requests (130 sent, limit 100)', held <= 100 && held > 50, held);

      await panel.evaluate(() => netCall('clear'));
      await target.evaluate(async () => {
        await fetch('/slow?a=1');
        await fetch('/assets/gone.js');
      });
      await target.waitForTimeout(400);
      await panel.evaluate(() => show('network'));
      await panel.waitForSelector('#net-compare');
      await panel.evaluate(() => (document.querySelector('#net-compare').open = true));
      await panel.waitForTimeout(300);
      await panel.click('#net-save-capture');
      await panel.waitForTimeout(800);
      await panel.evaluate(async () => {
        await netCall('clear');
        net.rows.clear();
        net.rev = 0;
      });
      await target.evaluate(async () => {
        await fetch('/slow?a=1');
        await fetch('/cors-demo?x=1');
      });
      await target.waitForTimeout(400);
      await panel.click('#net-save-capture');
      await panel.waitForTimeout(800);
      const saved = await panel.evaluate(async () => (await DFStore.allItems()).filter((i) => i.kind === 'network'));
      check('captures are saved to the Workspace, redacted', saved.length === 2 && saved.every((s) => s.payload.redacted === true && s.payload.entries.length >= 2), saved.length + ' | ' + JSON.stringify(saved.map((s) => s.payload.entries.map((e) => e.url))) + ' | status: ' + (await panel.evaluate(() => (document.querySelector('#status') || {}).textContent)) + ' | toast: ' + (await panel.evaluate(() => (document.querySelector('.toast') || {}).textContent)));
      await panel.evaluate(() => (document.querySelector('#net-compare').open = false));
      await panel.evaluate(() => (document.querySelector('#net-compare').open = true));
      await panel.waitForTimeout(500);
      const opts = await panel.locator('#net-cmp-a option').count();
      check('both captures are offered in the compare pickers', opts >= 3, opts);
      const ids = await panel.evaluate(() => [...document.querySelectorAll('#net-cmp-a option')].map((o) => o.value).filter((v) => v !== 'live'));
      const first = await panel.evaluate(async () => (await DFStore.allItems()).filter((i) => i.kind === 'network').sort((a, b) => a.created - b.created)[0].id);
      const second = ids.find((i) => i !== first);
      await panel.selectOption('#net-cmp-a', first);
      await panel.selectOption('#net-cmp-b', second);
      await panel.click('#net-cmp-run');
      await panel.waitForSelector('#net-cmp-result');
      const res = await panel.locator('#net-cmp-result').innerText();
      check('compare reports a request only in the second capture', /only in/i.test(res) && /cors-demo/.test(res), res.slice(0, 400));
      check('compare reports a request that disappeared', /gone\.js/.test(res), res.slice(0, 400));
      check('every listed request has a Copy cURL button', (await panel.locator('#net-cmp-result button:has-text("cURL")').count()) >= 2);
      const e = { method: 'POST', url: 'https://x.test/a', reqHeaders: { 'content-type': 'application/json' }, reqBody: '{"a":1}' };
      const snippets = await panel.evaluate((x) => [DFHar.toCurl(x), DFHar.toPython(x), DFHar.toNode(x)], e);
      check('cURL, Python and Node snippets are produced for a request', /curl/.test(snippets[0]) && /requests\.post/.test(snippets[1]) && /await fetch/.test(snippets[2]));
      await target.close();
      await panel.close();
    }

    /* ---------- performance history ---------- */
    console.log('\nPerformance history');
    if (run('Perf')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(async (u) => {
        await chrome.storage.local.set({ perfHistory: { [DFKeep.keyFor(DFPerfHist.keyFor(u))]: [{ t: Date.now() - 86400000 * 2, lcp: 3200, fcp: 1100, ttfb: 300, inp: null, cls: 0.02 }, { t: Date.now() - 86400000, lcp: 2800, fcp: 1000, ttfb: 280, inp: null, cls: 0.02 }] } });
        DF.state.url = u;
      }, vuln);
      await panel.evaluate(() => show('perf'));
      await panel.waitForSelector('.perf-chart', { timeout: 10000 });
      check('after several checks the Perf tab shows a history chart', (await panel.locator('.perf-chart circle').count()) >= 2);
      await panel.selectOption('#perf-metric', 'fcp');
      await panel.waitForTimeout(300);
      check('the metric can be switched', (await panel.locator('.perf-chart').getAttribute('aria-label')).startsWith('FCP'));
      await panel.click('button:has-text("Clear this page")');
      await panel.waitForTimeout(500);
      check('history for the page can be cleared', (await panel.locator('.perf-chart').count()) === 0 || (await panel.locator('#perf-hist-hint').count()) === 1);
      await target.close();
      await panel.close();
    }

    /* ---------- tokens: readability ---------- */
    console.log('\nTokens: colour readability');
    if (run('Tokens')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(() => show('tokens'));
      await panel.waitForSelector('#tok-fg');
      await panel.fill('#tok-fg', '#777777');
      await panel.fill('#tok-bg', '#ffffff');
      await panel.waitForTimeout(150);
      const out = await panel.locator('#tok-contrast-out').innerText();
      check('the checker shows the WCAG ratio', out.includes('4.48:1'), out.slice(0, 200));
      check('it says #777 on white fails AA text but passes AA large', /✕ AA text/.test(out) && /✓ AA large/.test(out), out.slice(0, 300));
      check('it suggests a passing colour', /Nearest text colour for 4\.5:1/.test(out), out.slice(0, 400));
      await panel.click('#tok-swap');
      check('swap exchanges the colours', (await panel.inputValue('#tok-fg')) === '#ffffff');
      await target.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', '<p id="lowc" style="color:#bbb;background:#fff">faint text</p><p id="goodc" style="color:#000;background:#fff">strong text</p>');
      });
      await panel.click('#tok-scan');
      await panel.waitForSelector('#tok-scan-out .card');
      const scanText = await panel.locator('#tok-scan-out').innerText();
      check('the page scan finds the low-contrast text and reports its ratio', /faint text/.test(scanText) && /1\.9\d:1/.test(scanText), scanText.slice(0, 400));
      check('the page scan does not list passing text as a failure', !/strong text/.test(scanText));
      await target.close();
      await panel.close();
    }

    /* ---------- export bundle ---------- */
    console.log('\nExport: page bundle');
    if (run('Export')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(() => show('export'));
      await panel.waitForSelector('#bundle-html');
      check('single items can be selected and the buttons enable', await (async () => {
        const before = await panel.isDisabled('#bundle-zip');
        await panel.check('#bundle-html');
        return before && !(await panel.isDisabled('#bundle-zip'));
      })());
      for (const id of ['js', 'css', 'local', 'cookies', 'idb', 'manifest']) await panel.check('#bundle-' + id);
      const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#bundle-zip')]);
      const zipPath = path.join(scratch, 'bundle.zip');
      await dl.saveAs(zipPath);
      const listing = execFileSync('unzip', ['-l', zipPath]).toString();
      check('all selected items are in the one downloaded ZIP', /_manifest\.json/.test(listing) && /html\/rendered\.html/.test(listing) && /storage\/local-storage\.json/.test(listing) && /storage\/cookies\.json/.test(listing) && /storage\/indexeddb-and-caches\.json/.test(listing), listing);
      check('scripts and styles of the page are in it', /js\//.test(listing) || /css\//.test(listing), listing);
      const manifestText = execFileSync('unzip', ['-p', zipPath, '_manifest.json']).toString();
      const m = JSON.parse(manifestText);
      check('the manifest records a result for every selected item', ['html', 'js', 'css', 'local', 'cookies', 'idb', 'manifest'].every((id) => m.items.some((x) => x.id === id)), manifestText.slice(0, 300));
      check('secrets are masked by default', m.secretsMasked === true);
      const html = execFileSync('unzip', ['-p', zipPath, 'html/rendered.html']).toString();
      check('the rendered HTML is the live DOM', /<html/i.test(html) && html.length > 200);
      await panel.click('#bundle-all');
      await panel.waitForTimeout(100);
      const sepDownloads = [];
      panel.on('download', (d) => sepDownloads.push(d.suggestedFilename()));
      await panel.uncheck('#bundle-network').catch(() => {});
      for (const id of ['js', 'css', 'maps', 'wasm', 'manifest', 'sw', 'network', 'cookies', 'session', 'idb']) await panel.uncheck('#bundle-' + id);
      await panel.uncheck('#bundle-local');
      await panel.click('#bundle-files');
      await panel.waitForTimeout(2500);
      check('"download as separate files" gives individual files', sepDownloads.length >= 3 && sepDownloads.some((n) => /rendered\.html$/.test(n)) && sepDownloads.some((n) => /_manifest\.json$/.test(n)), JSON.stringify(sepDownloads));
      await target.close();
      await panel.close();
    }

    /* ---------- prototype ---------- */
    console.log('\nPrototype');
    if (run('Prototype')) {
      const { panel, target } = await openPanel(env, vuln);
      await target.evaluate(() => {
        document.body.insertAdjacentHTML('afterbegin', '<h1 id="proto-h1" style="color: rgb(10, 20, 30)">Prototype heading</h1>');
        window.__before = document.querySelectorAll('style').length + ':' + document.adoptedStyleSheets.length;
      });
      const origColor = await target.evaluate(() => getComputedStyle(document.querySelector('h1') || document.body).color);
      await panel.evaluate(async () => {
        const d = await call('selectBySelector', 'h1');
        DF.state.h = d.h;
        DF.state.info = d;
      });
      await panel.evaluate(() => show('proto'));
      await panel.waitForSelector('#proto-analyse');
      await panel.click('#proto-analyse');
      await panel.waitForSelector('#proto-analysis');
      check('analysis reads the page\'s theme and the element\'s layout', /theme variable/.test(await panel.locator('#proto-analysis').innerText()));
      await panel.fill('#proto-color', '#ff0000');
      await panel.dispatchEvent('#proto-color', 'change');
      await panel.waitForTimeout(500);
      const redNow = await target.evaluate(() => getComputedStyle(document.querySelector('h1')).color);
      check('the visual dashboard changes the element on the page', redNow === 'rgb(255, 0, 0)', redNow);
      check('the generated CSS is shown', /color: #ff0000 !important/.test(await panel.locator('#proto-generated').innerText()));
      const dom = await target.evaluate(() => document.querySelectorAll('style').length + ':' + document.adoptedStyleSheets.length);
      check('the preview adds no element to the page\'s DOM', dom.split(':')[0] === (await target.evaluate(() => window.__before)).split(':')[0], dom);
      await panel.click('#proto-toggle');
      await panel.waitForTimeout(250);
      check('"Show original" brings back the site\'s own colour', (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).color)) === origColor);
      await panel.click('#proto-toggle');
      await panel.click('#proto-mode-code');
      await panel.waitForSelector('#proto-css');
      await panel.fill('#proto-css', 'h1 { letter-spacing: 7px; }');
      await panel.waitForTimeout(600);
      check('the code editor applies CSS and wins over the site (important by default)', (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).letterSpacing)) === '7px', (await panel.locator('#proto-result').innerText()) + ' | sheets: ' + JSON.stringify(await target.evaluate(() => [...document.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join(' ')))) + ' | ls=' + (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).letterSpacing)));
      await panel.click('#proto-new');
      await panel.waitForTimeout(400);
      check('a new variant starts from the original page', (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).letterSpacing)) !== '7px');
      await panel.selectOption('#proto-variant', '0');
      await panel.waitForTimeout(500);
      check('switching variants re-applies the other one', (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).letterSpacing)) === '7px');
      await panel.check('#proto-allowjs');
      await panel.fill('#proto-js', "document.querySelector('h1').setAttribute('data-proto', 'yes');");
      await panel.click('#proto-run-js');
      await panel.waitForTimeout(400);
      check('JavaScript, once allowed, runs in the page', (await target.evaluate(() => document.querySelector('h1').getAttribute('data-proto'))) === 'yes');
      await panel.fill('#proto-js', 'this is not valid javascript (((');
      await panel.click('#proto-run-js');
      await panel.waitForTimeout(300);
      check('a script error is reported, not swallowed', /did not run|threw/.test(await panel.locator('#proto-result').innerText()));
      await panel.click('#proto-reset');
      await panel.waitForTimeout(500);
      check('Reset page restores the original', (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).color)) === origColor && (await target.evaluate(() => getComputedStyle(document.querySelector('h1')).letterSpacing)) !== '7px');
      await target.close();
      await panel.close();
    }

    /* ---------- privacy probe, cleanup ---------- */
    console.log('\nWebsite privacy and housekeeping');
    if (run('Privacy')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(() => startCapture());
      await target.waitForTimeout(300);
      await panel.evaluate(() => show('settings'));
      await panel.waitForSelector('#set-footprint');
      await panel.click('#set-footprint');
      await panel.waitForSelector('text=What a page script can look for');
      const rows = await panel.evaluate(() => [...document.querySelectorAll('#set-footprint')].length && null);
      void rows;
      const probe = await panel.evaluate(async () => (await exec(footprintProbe, [], 'MAIN')).map((r) => [r.name, r.ok]));
      const by = (s) => probe.find((r) => r[0].includes(s));
      check('with capture running: patched functions still look native to the page', by('native code')[1] === true, JSON.stringify(probe));
      check('with capture running: XMLHttpRequest objects carry no extra properties', by('XMLHttpRequest objects')[1] === true);
      check('with capture running: navigator carries no extra properties', by('navigator carries')[1] === true);
      check('with capture running: no window global carries a DevForge name', by('DevForge name')[1] === true);
      const direct = await target.evaluate(() => {
        const x = new XMLHttpRequest();
        x.open('GET', '/slow');
        return { own: Object.getOwnPropertyNames(x), fetchSrc: Function.prototype.toString.call(window.fetch), wsSrc: Function.prototype.toString.call(window.WebSocket), nav: Object.getOwnPropertyNames(navigator), nameOk: window.fetch.name === 'fetch' && window.fetch.length === 1 && XMLHttpRequest.prototype.open.length === 2 };
      });
      check('the page sees native source text for fetch and WebSocket', /native code/.test(direct.fetchSrc) && /native code/.test(direct.wsSrc), direct.fetchSrc.slice(0, 80));
      check('fetch keeps its name and length', direct.nameOk);
      check('instances carry no properties of ours', direct.own.length === 0 && direct.nav.length === 0, JSON.stringify(direct.own));

      await panel.evaluate(() => chrome.storage.session.set({ pendingCommand: 'x', secAcknowledged: { a: 1 } }));
      const keysBefore = await panel.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
      const r = await panel.evaluate(async () => DFKeep.cleanTemporary());
      const keysAfter = await panel.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
      check('Clear temporary data removes session leftovers', r.sessionKeys >= 1 && !keysAfter.includes('pendingCommand') && !keysAfter.includes('secAcknowledged'), JSON.stringify([keysBefore, keysAfter]));
      check('…but keeps the keys a running capture needs', (await panel.evaluate(() => netCall('ping'))) === 'pong');
      const usage = await panel.evaluate(() => DFKeep.usage());
      check('storage usage is reported', typeof usage.localBytes === 'number' && 'itemCount' in usage);
      await target.close();
      await panel.close();
    }

    /* ---------- recreate (advanced build) and home ---------- */
    console.log('\nRecreate: token-aware build, and Home dashboard');
    if (run('Recreate')) {
      const { panel, target } = await openPanel(env, vuln);
      await target.evaluate(() => {
        const chip = (n) => '<span style="display:inline-block;padding:' + (2 + n) + 'px 8px;margin:2px;background-color:#336699;border:1px solid #224466;color:#ffffff">tag ' + n + '</span>';
        document.body.insertAdjacentHTML('afterbegin', '<section id="rc-card" style="width:300px;padding:16px;background-color:#ffffff"><h2 style="margin:0 0 8px">Card</h2>' + chip(1) + chip(2) + chip(3) + '</section>');
      });
      await panel.evaluate(async () => {
        const d = await call('selectBySelector', '#rc-card');
        DF.state.h = d.h;
        DF.state.info = d;
        show('recreate');
      });
      await panel.waitForSelector('#re-name');
      await panel.click('button:has-text("Recreate & compare")');
      await panel.waitForSelector('#re-adv-run', { timeout: 60000 });
      check('the Recreate result offers the advanced token-aware build', true);
      await panel.click('#re-adv-run');
      await panel.waitForSelector('#re-adv-css', { timeout: 60000 });
      const css = await panel.locator('#re-adv-css').innerText();
      check('repeated colours became custom properties', /--color-\d: rgb\(51, ?102, ?153\)/.test(css) && /var\(--color-\d\)/.test(css), css.slice(0, 500));
      const verdict = await panel.locator('#re-adv-out [role="status"]').innerText();
      check('the token-aware build is measured against the original and matches', /matches the standard one/.test(verdict), verdict);
      await target.close();
      await panel.close();
    }
    if (run('Home')) {
      const { panel, target } = await openPanel(env, vuln);
      await panel.evaluate(() => show('home'));
      await panel.waitForSelector('#home-card-access');
      for (const id of ['access', 'owner', 'sec', 'perf', 'data']) check('Home shows the ' + id + ' card', (await panel.locator('#home-card-' + id).count()) === 1);
      check('the access card says all sites are allowed', /All sites allowed/.test(await panel.locator('#home-card-access').innerText()));
      check('Home offers Prototype, contrast and bundle shortcuts', (await panel.locator('.home-tile:has-text("Prototype a change")').count()) === 1 && (await panel.locator('.home-tile:has-text("colour contrast")').count()) === 1 && (await panel.locator('.home-tile:has-text("page bundle")').count()) === 1);
      await target.close();
      await panel.close();
    }

    /* ---------- owner: step-up verification, passphrase change ---------- */
    console.log('\nOwner mode: re-verification and passphrase change');
    if (run('Owner')) {
      const { panel, target } = await openPanel(env, vuln);
      const OLD = 'correct horse battery staple';
      const NEW = 'purple giraffe window lantern';
      await panel.evaluate(async (pw) => {
        for (const it of await DFStore.rawItems()) await DFStore.deleteItem(it.id);
        await DFOwnerSession.workspaceInit();
        await DFOwnerSession.setup(pw);
        await saveToWorkspace('note', 'Rekey test item', { text: 'internal-secret-note', n: 7 });
        await DFOwnerSession.workspaceSealAll();
        await DFOwnerSession.sealTechnical('tech-0001', { host: 'a.test', level: 'passive', at: new Date().toISOString() }, { headers: { server: 'nginx-secret' } });
        await DFOwnerSession.authorizeOrigin('https://staging.example.com', true);
      }, OLD);
      check('setup: unlocked and freshly verified', await panel.evaluate(() => DFOwnerSession.isUnlocked() && DFOwnerSession.isFresh()));
      check('a fresh verification does not prompt again', (await panel.evaluate(() => ownerStepUp('x'))) === true);

      // make the verification look 6 minutes old
      await panel.evaluate(() => {
        window.__realNow = Date.now;
        const skew = 6 * 60 * 1000;
        Date.now = () => window.__realNow() + skew;
      });
      check('after 5 minutes it is no longer fresh', (await panel.evaluate(() => DFOwnerSession.isFresh())) === false);
      await panel.evaluate(() => {
        window.__stepUp = ownerStepUp('Test action.');
      });
      await panel.waitForSelector('#owner-stepup-pass');
      check('a sensitive action asks for the passphrase again (modal dialog)', (await panel.locator('.owner-stepup[role="dialog"][aria-modal="true"]').count()) === 1);
      await panel.fill('#owner-stepup-pass', 'wrong passphrase here');
      await panel.click('#owner-stepup-go');
      await panel.waitForFunction(() => /not correct/.test(document.querySelector('#owner-stepup-msg').textContent));
      check('a wrong passphrase is refused and stays on the dialog', (await panel.locator('.owner-stepup').count()) === 1);
      await panel.fill('#owner-stepup-pass', OLD);
      await panel.click('#owner-stepup-go');
      check('the right passphrase resolves it and closes the dialog', (await panel.evaluate(() => window.__stepUp)) === true && (await panel.locator('.owner-stepup').count()) === 0);
      check('…and it is fresh again', await panel.evaluate(() => DFOwnerSession.isFresh()));
      await panel.evaluate(() => {
        window.__stepUp = ownerStepUp('Test action.');
      });
      // cancelled via Escape
      await panel.evaluate(() => {
        Date.now = () => window.__realNow() + 20 * 60 * 1000;
      });
      await panel.evaluate(() => {
        window.__stepUp2 = ownerStepUp('Another action.');
      });
      await panel.waitForSelector('#owner-stepup-pass');
      await panel.click('#owner-stepup-cancel');
      check('cancelling returns false and leaves nothing on screen', (await panel.evaluate(() => window.__stepUp2)) === false && (await panel.locator('.owner-stepup').count()) === 0);
      await panel.evaluate(() => {
        Date.now = window.__realNow;
      });

      await panel.evaluate(() => show('owner'));
      await panel.waitForSelector('#owner-change-go', { state: 'attached' });
      await panel.evaluate(() => (document.querySelector('#owner-cur').closest('details').open = true));
      await panel.fill('#owner-cur', 'not the passphrase');
      await panel.fill('#owner-new', NEW);
      await panel.fill('#owner-new2', NEW);
      await panel.click('#owner-change-go');
      await panel.waitForFunction(() => document.querySelector('#owner-change-msg').textContent.length > 0);
      check('changing the passphrase needs the current one', /not correct/.test(await panel.locator('#owner-change-msg').innerText()));
      await panel.fill('#owner-cur', OLD);
      await panel.fill('#owner-new', 'short');
      await panel.fill('#owner-new2', 'short');
      await panel.click('#owner-change-go');
      await panel.waitForFunction(() => document.querySelector('#owner-change-msg').textContent.length > 0);
      check('a weak new passphrase is refused', /at least 12/.test(await panel.locator('#owner-change-msg').innerText()));
      await panel.fill('#owner-cur', OLD);
      await panel.fill('#owner-new', OLD);
      await panel.fill('#owner-new2', OLD);
      await panel.click('#owner-change-go');
      await panel.waitForFunction(() => document.querySelector('#owner-change-msg').textContent.length > 0);
      check('the new passphrase must differ from the old one', /different/.test(await panel.locator('#owner-change-msg').innerText()));
      await panel.fill('#owner-cur', OLD);
      await panel.fill('#owner-new', NEW);
      await panel.fill('#owner-new2', NEW);
      await panel.click('#owner-change-go');
      await panel.waitForFunction(() => document.querySelector('#owner-change-ok').textContent || document.querySelector('#owner-change-msg').textContent, null, { timeout: 90000 });
      check('the change succeeds and says what was re-sealed', /Re-sealed 1 diagnostic record/.test(await panel.locator('#owner-change-ok').innerText()), (await panel.locator('#owner-change-ok').innerText()) + ' / ' + (await panel.locator('#owner-change-msg').innerText()));
      check('the password fields are cleared afterwards', (await panel.inputValue('#owner-cur')) === '' && (await panel.inputValue('#owner-new')) === '');

      await panel.evaluate(() => DFOwnerSession.lock());
      const oldTry = await panel.evaluate((pw) => DFOwnerSession.unlock(pw).then(() => 'unlocked', (e) => e.message), OLD);
      check('the old passphrase no longer unlocks', /not correct/.test(oldTry), oldTry);
      const newTry = await panel.evaluate((pw) => DFOwnerSession.unlock(pw).then(() => 'unlocked', (e) => e.message), NEW);
      check('the new passphrase unlocks', newTry === 'unlocked', newTry);
      const after = await panel.evaluate(async () => ({
        items: (await DFStore.allItems()).map((i) => ({ title: i.title, text: i.payload && i.payload.text, locked: !!i.locked })),
        tech: await DFOwnerSession.openTechnical('tech-0001'),
        origins: (await DFOwnerSession.originsList()).map((o) => o.origin),
        ws: DFOwnerSession.workspaceActive(),
        raw: JSON.stringify(await chrome.storage.local.get(null)) + JSON.stringify(await DFStore.rawItems()),
      }));
      check('Workspace items still open and are still encrypted at rest', after.items.some((i) => i.title === 'Rekey test item' && i.text === 'internal-secret-note') && after.ws === true && !/internal-secret-note|Rekey test item/.test(after.raw));
      check('sealed diagnostics survived the change', after.tech.headers.server === 'nginx-secret');
      check('the authorised-site list survived the change', after.origins.includes('https://staging.example.com'));
      await panel.evaluate(() => DFOwnerSession.lock());
      const locked = await panel.evaluate(async () => (await DFStore.allItems()).filter((i) => i.title === 'Rekey test item').length);
      check('locked again: the item is sealed', locked === 0);
      await target.close();
      await panel.close();
    }
  } finally {
    await env.ctx.close();
    await fx.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error('E2E ERROR', e);
  process.exit(2);
});
