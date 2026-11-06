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
