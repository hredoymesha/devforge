#!/usr/bin/env node
/*
 * Browser tests for the Export tab (selected part, whole page, site ZIP) against the demo site:
 *   node e2e/exports.js
 * Same requirements as e2e/run.js (Playwright, Chromium, CHROME_PATH / PLAYWRIGHT_MODULE).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFixtures, FAKE } = require('./fixtures.js');
const { splitReports } = require('./violations.js');

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
    viewport: null,
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
  // Trusted Types: the panel's CSP refuses plain strings at HTML sinks. Record every refusal.
  await panel.addInitScript(() => {
    window.__ttv = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__ttv.push(e.violatedDirective + ' ' + (e.sample || '') + ' [' + (e.sourceFile || 'no source') + ':' + e.lineNumber + ':' + e.columnNumber + ' blocked=' + e.blockedURI + ']')
    );
  });
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${env.id}/sidepanel.html`);
  await panel.evaluate((id) => {
    chrome.tabs.query = async () => [await chrome.tabs.get(id)];
  }, tabId);
  const close = panel.close.bind(panel);
  panel.close = async () => {
    const ttv = await panel.evaluate(() => window.__ttv || []).catch(() => []);
    // Every session here exports pages, and exporting parses their markup in the panel.
    const failing = splitReports(ttv).other;
    check('no Trusted Types violation in this panel session', failing.length === 0, failing.length + ' refusal(s), first 5: ' + failing.slice(0, 5).join(' | '));
    await close();
    await target.close();
  };
  return { target, panel, tabId, errors };
}


async function selectPart(panel, selector) {
  // The agent also tells the panel about a selection by message. Wait for that message to land
  // so it cannot overwrite the state set here after the test has moved on.
  const pick = () =>
    panel.evaluate(async (sel) => {
      const d = await call('selectBySelector', sel);
      DF.state.h = d.h;
      DF.state.info = d;
    }, selector);
  await pick();
  await panel.waitForTimeout(600);
  await pick();
}

async function saveDownload(panel, click, dir, name) {
  const [dl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), click()]);
  const file = path.join(dir, name || dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}
const zipList = (f) => execFileSync('unzip', ['-Z1', f]).toString().split('\n').filter(Boolean);
const zipRead = (f, p) => execFileSync('unzip', ['-p', f, p], { maxBuffer: 64 * 1024 * 1024 }).toString();

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-exports-'));
  const fx = await startFixtures();
  const demo = `http://127.0.0.1:${fx.demo.port}/demo/`;
  const extDir = path.join(scratch, 'ext');
  fs.mkdirSync(extDir, { recursive: true });
  for (const f of EXT_FILES) fs.cpSync(path.join(root, f), path.join(extDir, f), { recursive: true });
  const mf = path.join(extDir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = ['<all_urls>'];
  fs.writeFileSync(mf, JSON.stringify(m));
  const env = await launch(extDir, path.join(scratch, 'profile'));
  try {
    console.log('\nExport: one part');
    const { panel, target, errors } = await openPanel(env, demo);
    await selectPart(panel, '#promo');
    await panel.evaluate(() => show('export'));
    await panel.waitForSelector('#el-zip');
    const zip = await saveDownload(panel, () => panel.click('#el-zip'), scratch);
    const names = zipList(zip);
    const has = (re) => names.some((n) => re.test(n));
    check('the ZIP holds HTML (outer, inner, standalone), CSS, JavaScript, data and a README', has(/\/README\.md$/) && has(/html\/outer\.html$/) && has(/html\/inner\.html$/) && has(/html\/standalone\.html$/) && has(/css\/styles\.css$/) && has(/css\/computed\.css$/) && has(/js\/handlers\.js$/) && has(/js\/inline-scripts\.js$/) && has(/js\/external-fragments\.js$/) && has(/data\/meta\.json$/), names.join(', '));
    const root0 = names.find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    const outer = zipRead(zip, root0 + 'html/outer.html');
    check('outer HTML is only the picked part, not the whole page', /id="promo"/.test(outer) && /Autumn blend/.test(outer) && !/About/.test(outer) && !/<nav/.test(outer), outer.slice(0, 300));
    const inner = zipRead(zip, root0 + 'html/inner.html');
    check('inner HTML leaves out the element itself', /promo-title/.test(inner) && !/id="promo"/.test(inner));
    const css = zipRead(zip, root0 + 'css/styles.css');
    check('CSS has the part\'s rules with their media query, animation and variables, and none of the rest', /\.promo/.test(css) && /@media/.test(css) && /@keyframes pulse/.test(css) && /--brand/.test(css) && !/\.top\b/.test(css), css.slice(0, 400));
    console.log('\nExport: generated Web Component');
    await panel.selectOption('#el-gen-target', 'webcomponent');
    const gen = await saveDownload(panel, () => panel.click('#el-gen'), scratch, 'component.zip');
    const genNames = zipList(gen);
    const genRoot = genNames.find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    const wcSource = zipRead(gen, genRoot + 'section-promo.js');
    check('the component ZIP holds one element file and a README that says where the code came from', /customElements\.define\('section-promo', SectionPromo\)/.test(wcSource) && /Generated by DevForge/.test(zipRead(gen, genRoot + 'README.md')), genNames.join(', '));
    const wcPage = await env.ctx.newPage();
    const wcErrors = [];
    wcPage.on('pageerror', (e) => wcErrors.push(e.message));
    await wcPage.setContent('<!doctype html><body></body>');
    await wcPage.addScriptTag({ content: wcSource });
    const shown = await wcPage.evaluate(() => {
      const el = document.querySelector('section-promo') || (document.body.append(document.createElement('section-promo')), document.querySelector('section-promo'));
      return { root: !!el.shadowRoot, text: el.shadowRoot ? el.shadowRoot.textContent.replace(/\s+/g, ' ').trim() : '' };
    });
    await wcPage.close();
    check('the Web Component draws the part in its shadow root and runs without errors', shown.root && /Autumn blend/.test(shown.text) && wcErrors.length === 0, JSON.stringify({ shown, wcErrors }));
    console.log('\nExport: three widths and media rules');
    const winSize = () => panel.evaluate(async () => {
      const w = await chrome.windows.getCurrent();
      return { width: w.width, height: w.height, state: w.state };
    });
    const sizeBefore = await winSize();
    // The side panel sits beside the active page in Chrome. In this test the panel is a tab, so the
    // demo page has to be the visible tab, or Chrome does not re-lay it out after a resize.
    await target.bringToFront();
    await panel.check('#opt-widths');
    const wz = await saveDownload(panel, () => panel.click('#el-zip'), scratch, 'widths.zip');
    await panel.uncheck('#opt-widths');
    const sizeAfter = await winSize();
    const wnames = zipList(wz);
    const wroot = wnames.find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    const shots = wnames.filter((n) => /preview-responsive\/\d+px\.png$/.test(n));
    check('three width previews are in the ZIP', shots.length === 3, wnames.join(', '));
    const media = JSON.parse(zipRead(wz, wroot + 'data/media-rules.json'));
    const mq = media.rules.find((r) => /max-width:\s*600px/.test(r.query));
    check('media rules list the 600px rule with its breakpoint', !!mq && mq.breakpoints[0].px === 600, JSON.stringify(media.rules));
    check('the rule is active at the narrow width and not at the wide one', media.widths && media.widths.length === 3 && media.widths[0].rulesActive.some((r) => r.query === mq.query && r.active === true) && media.widths[2].rulesActive.some((r) => r.query === mq.query && r.active === false), JSON.stringify(media.widths));
    check('the window is back to the size it had', media.window && media.window.restored === true && sizeAfter.width === sizeBefore.width && sizeAfter.height === sizeBefore.height && sizeAfter.state === sizeBefore.state, JSON.stringify({ sizeBefore, sizeAfter, window: media.window }));
    console.log('\nExport: compare two exports');
    await panel.evaluate(() => show('export'));
    await panel.setInputFiles('#cmp-a', zip);
    await panel.setInputFiles('#cmp-b', zip);
    await panel.click('#cmp-run');
    await panel.waitForSelector('#cmp-md');
    const same = await panel.textContent('#cmp-md');
    check('a ZIP compared with itself has no differences', /No differences in the compared files/.test(same) && /\| same \| \d+ \|/.test(same), same.slice(0, 300));
    await panel.setInputFiles('#cmp-a', zip);
    await panel.setInputFiles('#cmp-b', gen);
    await panel.click('#cmp-run');
    await panel.waitForFunction(() => /Compared/.test((document.querySelector('#cmp-md') || {}).textContent || ''));
    const diff = await panel.textContent('#cmp-md');
    check('two different exports list the files that were added and removed', /## Added files/.test(diff) && /## Removed files/.test(diff) && /section-promo\.js/.test(diff) && /assets\/01-hero\.png/.test(diff), diff.slice(0, 400));
    check('the comparison does not show the export time files', !/README\.md` \(text\)|- `README\.md`/.test(diff) && /Not compared \(they hold the export time\)/.test(diff), diff.slice(-300));
    console.log('\nBundle analysis');
    const DFZipNode = require('../lib/zip.js');
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const vlq = (n) => {
      let v = n < 0 ? (-n << 1) | 1 : n << 1;
      let out = '';
      do {
        let d = v & 31;
        v >>>= 5;
        if (v > 0) d |= 32;
        out += B64[d];
      } while (v > 0);
      return out;
    };
    // Line 0: "AAAA;BBBBBBBBB" maps 5 bytes to lodash and 9 bytes to a second lodash copy.
    // Line 1: 8 bytes of app code. Line 2 is the sourceMappingURL comment.
    // Columns restart on each line; sources, lines and columns are relative to the previous segment.
    const mappings = vlq(0) + vlq(0) + vlq(0) + vlq(0) + ',' + vlq(5) + vlq(1) + vlq(0) + vlq(0) + ';' + vlq(0) + vlq(1) + vlq(0) + vlq(0);
    const bundleCode = 'AAAA;BBBBBBBBB\nCCCCCCCC\n//# sourceMappingURL=app.bundle.js.map';
    const sources = ['node_modules/lodash/a.js', 'node_modules/x/node_modules/lodash/b.js', 'src/app.js'];
    const withText = { version: 3, sources, sourcesContent: ['a', 'b', 'c'], names: [], mappings };
    const noText = { version: 3, sources, names: [], mappings };
    const makeSite = async (map, file) => {
      const blob = DFZipNode.build([
        { path: 'site/app.bundle.js', data: bundleCode },
        { path: 'site/app.bundle.js.map', data: JSON.stringify(map) },
      ]);
      fs.writeFileSync(path.join(scratch, file), Buffer.from(await blob.arrayBuffer()));
      return path.join(scratch, file);
    };
    const siteWith = await makeSite(withText, 'site-with-text.zip');
    const siteNo = await makeSite(noText, 'site-no-text.zip');
    await panel.evaluate(() => show('site'));
    await panel.setInputFiles('#site-bundle-zip', siteWith);
    await panel.click('#site-bundle-run');
    await panel.waitForSelector('#site-bundle-out .card');
    const bundleText = await panel.textContent('#site-bundle-out');
    check('bundle analysis lists each original file with its bytes', /node_modules\/lodash\/a\.js/.test(bundleText) && /src\/app\.js/.test(bundleText) && /\b5\b/.test(bundleText) && /\b9\b/.test(bundleText), bundleText.slice(0, 400));
    check('bundle analysis reports a package in two folders as a duplicate', /Package in more than one folder/.test(bundleText) && /lodash/.test(bundleText) && /No package appears/.test(bundleText) === false, bundleText.slice(-400));
    await panel.setInputFiles('#site-bundle-zip', siteNo);
    await panel.click('#site-bundle-run');
    await panel.waitForFunction(() => /None of these source maps/.test((document.querySelector('#site-bundle-out') || {}).textContent || ''));
    const noTextOut = await panel.textContent('#site-bundle-out');
    check('a map without embedded source text is said so, and the file names still come from the map', /None of these source maps includes the original source text/.test(noTextOut) && /node_modules\/lodash\/a\.js/.test(noTextOut), noTextOut.slice(0, 300));
    await panel.evaluate(() => show('export'));
    console.log('\nExport: encrypted ZIP and the offline decrypt page');
    const PASS = 'correct horse battery';
    await panel.evaluate(() => show('export'));
    await panel.check('#opt-encrypt');
    await panel.fill('#enc-pass', 'too short');
    await panel.fill('#enc-pass2', 'too short');
    await panel.click('#el-zip');
    await new Promise((r) => setTimeout(r, 400));
    check('a passphrase shorter than 12 characters is refused before anything is written', (await panel.evaluate(() => document.querySelector('#enc-pass').value)) === 'too short');
    await panel.fill('#enc-pass', PASS);
    await panel.fill('#enc-pass2', PASS + '!');
    await panel.click('#el-zip');
    await new Promise((r) => setTimeout(r, 400));
    check('two passphrases that do not match are refused', (await panel.evaluate(() => document.querySelector('#enc-pass').value)) === PASS);
    await panel.fill('#enc-pass2', PASS);
    const [edl] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), panel.click('#el-zip')]);
    const encFile = path.join(scratch, 'part-export.zip.devforge-enc');
    await edl.saveAs(encFile);
    const encText = fs.readFileSync(encFile, 'utf8');
    check('the encrypted ZIP is a sealed file that does not show the page or its file names', edl.suggestedFilename().endsWith('.zip.devforge-enc') && !encText.includes('README.md') && !encText.includes('Autumn blend'), edl.suggestedFilename());
    await panel.check('#opt-encrypt');
    await panel.uncheck('#opt-encrypt');
    const DFEnc = require('../lib/encexport.js');
    const DFZipE = require('../lib/zip.js');
    const plainZip = await DFZipE.read(await DFEnc.decrypt(encText, PASS));
    check('the sealed file opens with the passphrase, and the ZIP inside has the export files', plainZip.files.some((f) => /\/README\.md$/.test(f.path)) && plainZip.files.some((f) => /html\/outer\.html$/.test(f.path)), plainZip.files.map((f) => f.path).join(', ').slice(0, 200));

    const tool = await env.ctx.newPage();
    const toolRequests = [];
    tool.on('request', (r) => toolRequests.push(r.url()));
    await tool.goto('file://' + path.join(root, 'tools', 'decrypt.html'));
    await tool.setInputFiles('#file', encFile);
    await tool.fill('#pass', 'a wrong passphrase');
    await tool.click('button[type=submit]');
    await tool.waitForSelector('#error:not([hidden])', { timeout: 60000 });
    const wrongMsg = await tool.textContent('#error');
    check('the decrypt page refuses a wrong passphrase with one clear message and no file', wrongMsg === DFEnc.WRONG && (await tool.locator('#result a').count()) === 0, wrongMsg);
    await tool.fill('#pass', PASS);
    await tool.click('button[type=submit]');
    await tool.waitForSelector('#result a', { timeout: 60000 });
    const [tdl] = await Promise.all([tool.waitForEvent('download'), tool.click('#result a')]);
    const decFile = path.join(scratch, 'decrypted.zip');
    await tdl.saveAs(decFile);
    check('the decrypt page saves the original ZIP under its original name', tdl.suggestedFilename() === 'part-export.zip', tdl.suggestedFilename());
    const decBytes = fs.readFileSync(decFile);
    const origBytes = Buffer.from(await DFEnc.decrypt(encText, PASS));
    check('the decrypted bytes are the same as the sealed plaintext', decBytes.equals(origBytes));
    check('the decrypt page made no request to the network', toolRequests.every((u) => /^(file|blob|data):/.test(u)), toolRequests.filter((u) => !/^(file|blob|data):/.test(u)).join(' | '));
    await tool.close();

    console.log('\nExport: resources that load after the page');
    const late = await openPanel(env, `http://127.0.0.1:${fx.demo.port}/late-demo/`);
    await late.panel.evaluate(() => show('export'));
    await late.panel.click('#el-late-start');
    await late.target.waitForFunction(() => window.lateRan === true, null, { timeout: 20000 });
    await late.target.click('#css');
    await late.target.click('#data');
    await new Promise((r) => setTimeout(r, 800));
    await late.target.bringToFront();
    await selectPart(late.panel, '#title');
    await late.panel.evaluate(() => show('export'));
    await late.panel.check('#opt-late');
    const [ldl] = await Promise.all([late.panel.waitForEvent('download', { timeout: 60000 }), late.panel.click('#el-zip')]);
    const lateFile = path.join(scratch, 'late-export.zip');
    await ldl.saveAs(lateFile);
    const lateNames = zipList(lateFile);
    const lateRoot = lateNames.find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    check('the script and the stylesheet that loaded after the first render are in the export', lateNames.some((n) => n.includes('loaded-later/js/') && /late\.js$/.test(n)) && lateNames.some((n) => n.includes('loaded-later/css/') && /late\.css$/.test(n)), lateNames.filter((n) => n.includes('loaded-later')).join(', '));
    const lateList = JSON.parse(zipRead(lateFile, lateRoot + 'data/loaded-later.json'));
    check('the list says watching was on, and that the data request is listed but not sent again', lateList.watching === true && lateList.items.some((x) => /data\.json$/.test(x.url) && /^listed, not saved: an API/.test(x.status)), JSON.stringify(lateList.items).slice(0, 300));
    check('every late resource has a status, saved or the reason it was not', lateList.items.length > 0 && lateList.items.every((x) => typeof x.status === 'string' && x.status.length > 0));
    await late.target.close();
    await late.panel.close();
    console.log('\nExport: late resources in the Site ZIP');
    const lateSite = await openPanel(env, `http://127.0.0.1:${fx.demo.port}/late-demo/`);
    await lateSite.panel.evaluate(() => show('site'));
    await lateSite.panel.evaluate(() => call('lateStart'));
    await lateSite.target.waitForFunction(() => window.lateRan === true, null, { timeout: 20000 });
    await lateSite.target.click('#css');
    await lateSite.target.click('#data');
    await new Promise((r) => setTimeout(r, 800));
    await lateSite.panel.click('button:has-text("Scan this page")');
    await lateSite.panel.waitForSelector('#site-go', { timeout: 60000 });
    await lateSite.panel.check('label:has-text("resources that load after the page") input');
    const lsZip = await saveDownload(lateSite.panel, () => lateSite.panel.click('#site-go'), scratch, 'late-site.zip');
    const lsNames = zipList(lsZip);
    check('the Site ZIP holds the late script and stylesheet', lsNames.some((n) => /late-demo\/late\.js$/.test(n)) && lsNames.some((n) => /late-demo\/late\.css$/.test(n)), lsNames.slice(0, 12).join(', '));
    const lsReport = zipRead(lsZip, lsNames.find((n) => /_devforge\/report\.json$/.test(n)));
    const lsItems = JSON.parse(lsReport).resources || [];
    check('the Site report lists the data request from the page, as an API call that is not sent again', lsItems.some((x) => /data\.json$/.test(x.url) && x.kind === 'api' && x.status === 'skipped'), JSON.stringify(lsItems.filter((x) => /data\.json/.test(x.url))));
    await lateSite.target.close();
    await lateSite.panel.close();

    const handlers = zipRead(zip, root0 + 'js/handlers.js');
    check('inline handler attributes are saved', /onclick/.test(handlers) && /buy\(/.test(handlers));
    const inlineJs = zipRead(zip, root0 + 'js/inline-scripts.js');
    check('inline scripts: the function the handler calls and the click listener on the part', /function buy/.test(inlineJs) && /promo-title/.test(inlineJs));
    const ext = zipRead(zip, root0 + 'js/external-fragments.js');
    check('script files: only code that refers to the part is included', /highlightBuy|#promo/.test(ext) && !/formatPrice/.test(ext) && !/unrelatedHelper/.test(ext), ext.slice(0, 500));
    check('inline SVG is saved as its own file', has(/html\/svg\/01\.svg$/));
    check('JSON-LD of the page is not mixed into a part that does not contain it', !has(/data\/json-ld\.json$/));
    check('images are downloaded', has(/assets\/\d+-bean\.png$/), names.join(', '));
    const readme = zipRead(zip, root0 + 'README.md');
    check('README describes this part in plain words and lists the files', /#promo/.test(readme) && /Autumn blend/.test(readme) && /subscribe/.test(readme) && /html\/outer\.html/.test(readme) && /not here/i.test(readme), readme.slice(0, 600));

    const css1 = await saveDownload(panel, () => panel.click('#el-css'), scratch, 'single.css');
    check('CSS button gives the same stylesheet as the ZIP', /\.promo/.test(fs.readFileSync(css1, 'utf8')));
    const js1 = await saveDownload(panel, () => panel.click('#el-js'), scratch, 'single.js');
    check('JavaScript button combines handlers, inline scripts and script-file fragments', /function buy/.test(fs.readFileSync(js1, 'utf8')) && /highlightBuy/.test(fs.readFileSync(js1, 'utf8')));
    const doc1 = await saveDownload(panel, () => panel.click('#el-doc'), scratch, 'single.md');
    check('Documentation button gives the README', /^# /.test(fs.readFileSync(doc1, 'utf8')));
    const std = zipRead(zip, root0 + 'html/standalone.html');
    check('standalone page has no scripts or inline handlers', !/<script/i.test(std) && !/onclick=/i.test(std));

    console.log('\nExport: shadow DOM, srcset, posters, pseudo-elements, inherited styles');
    const rich = `http://127.0.0.1:${fx.demo.port}/demo/rich`;
    const rp = await openPanel(env, rich);
    await selectPart(rp.panel, '#rich');
    await rp.panel.evaluate(() => show('export'));
    await rp.panel.waitForSelector('#el-zip');
    const rzip = await saveDownload(rp.panel, () => rp.panel.click('#el-zip'), scratch, 'rich.zip');
    const rn = zipList(rzip);
    const rroot = rn.find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    const rh = (re) => rn.some((n) => re.test(n));
    const shadowHtml = rh(/html\/with-shadow-dom\.html$/) ? zipRead(rzip, rroot + 'html/with-shadow-dom.html') : '';
    check('open shadow root content is written out as declarative shadow DOM', /shadowrootmode="open"/.test(shadowHtml) && /class="inner"/.test(shadowHtml) && /class="go"/.test(shadowHtml) && /Hello/.test(shadowHtml), shadowHtml.slice(0, 400));
    const shadowCss = rh(/css\/shadow-dom\.css$/) ? zipRead(rzip, rroot + 'css/shadow-dom.css') : '';
    check('styles inside the shadow root are saved separately', /\.inner/.test(shadowCss) && /shadow-bg\.png/.test(shadowCss), shadowCss.slice(0, 300));
    const std2 = zipRead(rzip, rroot + 'html/standalone.html');
    check('standalone page keeps the shadow content and still has no scripts', /shadowrootmode/.test(std2) && !/<script/i.test(std2));
    const rassets = JSON.parse(zipRead(rzip, rroot + 'data/assets.json'));
    const urls = rassets.assets.map((a) => a.url).join('\n');
    for (const [label, re] of [['every srcset candidate', /bean-2x\.png/], ['the video poster', /poster\.png/], ['an inline-style background', /badge\.png/], ['a CSS mask image', /mask\.png/], ['generated ::before content', /icon-before\.png/], ['an image inside the shadow root', /shadow-bg\.png/], ['the video source', /clip\.mp4/]])
      check('assets include ' + label, re.test(urls), urls);
    check('images are downloaded into assets/ and the unreachable video is reported, not hidden', rh(/assets\/\d+-bean-2x\.png$/) && rh(/assets\/\d+-poster\.png$/) && rassets.downloads.some((d) => /clip\.mp4/.test(d.url) && /failed|HTTP/.test(d.status)), JSON.stringify(rassets.downloads).slice(0, 500));
    const pseudo = JSON.parse(zipRead(rzip, rroot + 'data/pseudo-elements.json'));
    check('generated ::before content is listed', pseudo.some((x) => x.pseudo === '::before' && /icon-before/.test(x.content)), JSON.stringify(pseudo));
    const fwa = JSON.parse(zipRead(rzip, rroot + 'data/framework-attributes.json'));
    check('framework attributes are reported and kept in the HTML', fwa['data-v-7ba5bd90'] === 1 && /data-v-7ba5bd90/.test(zipRead(rzip, rroot + 'html/outer.html')), JSON.stringify(fwa));
    const ctxHtml = zipRead(rzip, rroot + 'html/in-context.html');
    check('in-context HTML wraps the part in its ancestors', /<main>/.test(ctxHtml) && /<body/.test(ctxHtml) && /<\/main>/.test(ctxHtml) && /id="rich"/.test(ctxHtml), ctxHtml.slice(0, 300));
    const outerRich = zipRead(rzip, rroot + 'html/outer.html');
    check('formatted code is indented over several lines', outerRich.split('\n').length > 8 && /\n {2,}</.test(outerRich));
    check('selectors, accessibility info, matched rules and a preview picture are included', rh(/data\/selectors\.txt$/) && rh(/data\/accessibility\.json$/) && rh(/css\/matched-rules\.json$/) && rh(/preview\.png$/), rn.join(', '));
    check('selectors file has a CSS selector, an XPath and a JS path', /#rich/.test(zipRead(rzip, rroot + 'data/selectors.txt')) && /XPath:/.test(zipRead(rzip, rroot + 'data/selectors.txt')) && /JS path: document\.querySelector/.test(zipRead(rzip, rroot + 'data/selectors.txt')));
    const rrd = zipRead(rzip, rroot + 'README.md');
    check('README mentions shadow roots, generated content and framework attributes', /shadow root/.test(rrd) && /generated content/.test(rrd) && /framework attributes/.test(rrd), rrd.slice(0, 700));

    await selectPart(rp.panel, '.note');
    await rp.panel.evaluate(() => show('export'));
    await rp.panel.waitForSelector('#el-zip');
    const nzip = await saveDownload(rp.panel, () => rp.panel.click('#el-zip'), scratch, 'note.zip');
    const nroot = zipList(nzip).find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    const inh = JSON.parse(zipRead(nzip, nroot + 'css/inherited.json'));
    check('inherited styles name the ancestor that sets them', inh.some((x) => /rich/.test(x.from) && /Georgia/.test(x.set['font-family'] || '')), JSON.stringify(inh).slice(0, 400));
    check('CSS of a small part leaves out the rules of the other parts', !/unrelated-sheet-rule/.test(zipRead(nzip, nroot + 'css/styles.css')));
    check('no page errors on the rich page', rp.errors.length === 0, rp.errors.join(' | '));
    await rp.panel.close();

    console.log('\nExport: whole page');
    await selectPart(panel, 'body');
    await panel.evaluate(() => show('export'));
    await panel.waitForSelector('#el-zip');
    const pageZip = await saveDownload(panel, () => panel.click('#el-zip'), scratch, 'page.zip');
    const pn = zipList(pageZip);
    const ph = (re) => pn.some((n) => re.test(n));
    check('selecting the whole page exports the page: HTML, scripts, styles, maps, manifest, service worker', ph(/html\/rendered\.html$/) && ph(/js\/.*app\.js$/) && ph(/js\/.*lazy\.js$/) && ph(/css\/.*site\.css$/) && ph(/sourcemaps\//) && ph(/app\/.*manifest/) && ph(/app\/.*sw/), pn.join(', '));
    const pr = zipRead(pageZip, pn.find((n) => /README\.md$/.test(n)));
    check('the page README says it covers the whole page', /whole page/i.test(pr) && /Harbor Coffee/.test(pr));

    console.log('\nExport: download all site files as a ZIP');
    await panel.evaluate(() => show('site'));
    await panel.waitForSelector('#site-go');
    const siteZip = await saveDownload(panel, () => panel.click('#site-go'), scratch, 'site.zip');
    const sn = zipList(siteZip);
    const sh = (re) => sn.some((n) => re.test(n));
    check('site ZIP has the rendered page, the original HTML, scripts, styles, fonts/images and a report', sh(/^index\.html$/) && sh(/^_original\/page\.html$/) && sh(/app\.js$/) && sh(/lazy\.js$/) && sh(/site\.css$/) && sh(/bean\.png$/) && sh(/^_devforge\/report\.json$/), sn.join(', '));
    check('site ZIP has every inline script and style as a file', sh(/^inline\/script-001\.js$/) && sh(/^inline\/style-001\.css$/));
    check('site ZIP recovers original sources from source maps', sh(/^_sourcemaps\//), sn.filter((n) => /map/i.test(n)).join(', '));
    check('site ZIP has the web app manifest and the service worker script', sh(/manifest/) && sh(/sw\.js$/), sn.filter((n) => /manifest|sw/.test(n)).join(', '));
    check('site ZIP has page data, structured data, README.md and an overview', sh(/^data\/page\.json$/) && sh(/^data\/json-ld\.json$/) && sh(/^README\.md$/) && sh(/^docs\/OVERVIEW\.md$/), sn.join(', '));
    const verbose = execFileSync('unzip', ['-v', siteZip]).toString();
    check('the Site ZIP deflates text files and stores images and fonts as they are', /Defl:N\s.*\.js\b/.test(verbose) && /Stored\s.*\.png\b/.test(verbose) && /Stored\s.*\.woff2\b/.test(verbose), verbose.slice(0, 600));
    check('the compressed Site ZIP passes the system integrity test', (() => { try { execFileSync('unzip', ['-tq', siteZip]); return true; } catch (_) { return false; } })());
    const siteReadme = zipRead(siteZip, 'README.md');
    check('site README names the real counts and layout', /Harbor Coffee/.test(siteReadme) && /Saved: \d+ files/.test(siteReadme) && /docs\/OVERVIEW\.md/.test(siteReadme), siteReadme.slice(0, 500));
    const idx = zipRead(siteZip, 'index.html');
    check('index.html in the ZIP points at the local copy of the stylesheet', /href="[^"]*site\.css/.test(idx) && !/href="http:\/\/127\.0\.0\.1:\d+\/demo\/site\.css"/.test(idx), (idx.match(/<link[^>]*>/g) || []).join(' '));

    console.log('\nSite ZIP when the page agent returns nothing for the page');
    await panel.evaluate(async () => {
      await ensureAgent();
      await exec(() => {
        const real = window.__DF.elementFacts;
        window.__DF.elementFacts = (h) => (h === '@page' ? undefined : real(h));
      });
    });
    const bareZip = await saveDownload(panel, () => panel.click('#site-go'), scratch, 'site-no-facts.zip');
    const bn = zipList(bareZip);
    const bareReport = JSON.parse(zipRead(bareZip, '_devforge/report.json'));
    const pageData = bareReport.resources.filter((r) => r.kind === 'page-data');
    check('the report says why the page data is missing', pageData.length === 1 && pageData[0].status === 'failed' && /^The page agent returned nothing for this page/.test(pageData[0].reason), JSON.stringify(pageData));
    check('the page data and overview files are left out, the rest of the ZIP is still made', !bn.includes('data/page.json') && !bn.includes('docs/OVERVIEW.md') && bn.includes('index.html') && bn.includes('README.md') && bn.some((n) => /app\.js$/.test(n)), bn.join(', '));
    const bareReadme = zipRead(bareZip, 'README.md');
    check('the README falls back to the host name and lists the reason', /^# 127\.0\.0\.1/.test(bareReadme) && /The page agent returned nothing for this page/.test(bareReadme), bareReadme.slice(0, 300));

    check('no page errors in the panel', errors.length === 0, errors.join(' | '));
    await target.close();
    await panel.close();

    /* ---------- secrets check before an export ---------- */
    console.log('\nExport: secrets check');
    const leaky = `http://127.0.0.1:${fx.demo.port}/demo/leaky`;
    const everything = (zip) => execFileSync('unzip', ['-p', zip], { maxBuffer: 64 * 1024 * 1024 }).toString();
    const lk = await openPanel(env, leaky);
    await selectPart(lk.panel, '#cfg');
    await lk.panel.evaluate(() => show('export'));
    await lk.panel.waitForSelector('#el-zip');
    await lk.panel.click('#el-zip');
    await lk.panel.waitForSelector('.guard-dialog');
    const dialogText = await lk.panel.locator('.guard-dialog').innerText();
    check('a secret in the part stops the export and asks first', /Secrets check/.test(dialogText) && /Stripe live secret key/.test(dialogText));
    check('the dialog names the kind, the file and the line, and never the value', /line \d+/.test(dialogText) && !dialogText.includes(FAKE.stripe));
    await lk.panel.click('#guard-cancel');
    const stray = await lk.panel.waitForEvent('download', { timeout: 1500 }).then(() => true, () => false);
    check('Cancel saves nothing', !stray);

    const maskedZip = await saveDownload(lk.panel, async () => {
      await lk.panel.click('#el-zip');
      await lk.panel.waitForSelector('.guard-dialog');
      await lk.panel.click('#guard-mask');
    }, scratch, 'leaky-mask.zip');
    const maskedAll = everything(maskedZip);
    check('Mask: the key is gone from every file in the ZIP and a marker is there', !maskedAll.includes(FAKE.stripe) && /\[REDACTED:stripe-secret\]/.test(maskedAll));
    const mroot = zipList(maskedZip).find((n) => /README\.md$/.test(n)).replace(/README\.md$/, '');
    const mrep = zipRead(maskedZip, mroot + '_devforge-secrets.md');
    check('Mask: the ZIP carries a report with the kind and line, and no value', /Stripe live secret key/.test(mrep) && /\| \d+ \|/.test(mrep) && !mrep.includes(FAKE.stripe));
    check('Mask: the ZIP is still a valid archive', (() => { try { execFileSync('unzip', ['-tq', maskedZip]); return true; } catch (_) { return false; } })());

    const keptZip = await saveDownload(lk.panel, async () => {
      await lk.panel.click('#el-zip');
      await lk.panel.waitForSelector('.guard-dialog');
      await lk.panel.click('#guard-keep');
    }, scratch, 'leaky-keep.zip');
    check('Keep: the file is unchanged and the report is added', everything(keptZip).includes(FAKE.stripe) && zipList(keptZip).some((n) => /_devforge-secrets\.md$/.test(n)));

    const omitZip = await saveDownload(lk.panel, async () => {
      await lk.panel.click('#el-zip');
      await lk.panel.waitForSelector('.guard-dialog');
      await lk.panel.click('#guard-omit');
    }, scratch, 'leaky-omit.zip');
    check('Leave out: no file with the key is in the ZIP, and the report says which', !everything(omitZip).includes(FAKE.stripe) && zipList(omitZip).some((n) => /_devforge-secrets\.md$/.test(n)));

    const one = await lk.panel.evaluate(async (k) => {
      const p = guardText('Why does this fail?\nconst key = "' + k + '";', 'prompt');
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector('#guard-mask').click();
      return p;
    }, FAKE.stripe);
    check('an AI prompt is checked too, and Mask removes the key from the text', one && !one.includes(FAKE.stripe) && one.includes('[REDACTED:stripe-secret]'));
    const dropped = await lk.panel.evaluate(async (k) => {
      const p = guardText('const key = "' + k + '";', 'prompt');
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector('#guard-cancel').click();
      return p;
    }, FAKE.stripe);
    check('Cancel on a prompt returns nothing to copy', dropped === null);

    await lk.panel.evaluate(() => show('site'));
    await lk.panel.waitForSelector('#site-go');
    const leakySite = await saveDownload(lk.panel, async () => {
      await lk.panel.click('#site-go');
      await lk.panel.waitForSelector('.guard-dialog', { timeout: 60000 });
      await lk.panel.click('#guard-mask');
    }, scratch, 'leaky-site.zip');
    const siteAll = everything(leakySite);
    check('the Site ZIP is checked too: both keys are masked, the report is in the ZIP', !siteAll.includes(FAKE.stripe) && !siteAll.includes(FAKE.aws) && zipList(leakySite).some((n) => /_devforge-secrets\.md$/.test(n)));
    check('no page errors during the secrets check', lk.errors.length === 0, lk.errors.join(' | '));
    await lk.panel.close();
  } finally {
    await env.ctx.close();
    await fx.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' of ' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
