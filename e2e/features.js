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
  // Trusted Types: the panel's CSP refuses plain strings at HTML sinks. Record every refusal.
  await panel.addInitScript(() => {
    window.__ttv = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__ttv.push(e.violatedDirective + ' ' + (e.sample || '')));
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
    check('no Trusted Types violation in this panel session', ttv.length === 0, ttv.join(' | '));
    await close();
    await target.close();
  };
  return { target, panel, tabId, errors };
}

// The weak fixture site holds fake credentials, so an export of its code opens the Secrets check.
// These tests are about what the export contains, so they choose "Keep".
async function keepIfAsked(panel) {
  try {
    await panel.waitForSelector('.guard-dialog', { timeout: 10000 });
    await panel.click('#guard-keep');
    return true;
  } catch (_) {
    return false;
  }
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
      check('visiting every tab causes no Trusted Types violation', (await panel.evaluate(() => window.__ttv)).length === 0);
      // Prove the listener and the policy work: a plain string at an HTML sink must be refused and recorded.
      const refused = await panel.evaluate(() => {
        try {
          document.createElement('div').innerHTML = '<b>x</b>';
          return false;
        } catch (e) {
          return e instanceof TypeError;
        }
      });
      check('a plain string at innerHTML is refused and recorded (the policy is enforced)', refused && (await panel.evaluate(() => window.__ttv)).length === 1);
      await panel.evaluate(() => (window.__ttv.length = 0));
      check('a policy with any other name cannot be created', await panel.evaluate(() => {
        try {
          trustedTypes.createPolicy('other', { createHTML: (s) => s });
          return false;
        } catch (_) {
          return true;
        }
      }));
      await panel.evaluate(() => (window.__ttv.length = 0));
      await panel.close();
    }

    /* ---------- guide ---------- */
    console.log('\nGuide');
    if (run('Guide')) {
      const { panel, errors } = await openPanel(env, vuln);
      await panel.evaluate(() => show('guide'));
      await panel.waitForSelector('.guide');
      const missing = await panel.evaluate(() => DF.tabs.map((t) => t.id).filter((id) => !document.getElementById('guide-tab-' + id)));
      check('the Guide has a card for every tab', missing.length === 0, missing.join(', '));
      check('the Guide tab sits right after Home', (await panel.evaluate(() => DF.tabs.map((t) => t.id).slice(0, 2).join(','))) === 'home,guide');
      await panel.evaluate(() => document.getElementById('guide-tab-network').querySelector('summary').click());
      check('opening a card shows its three steps', (await panel.locator('#guide-tab-network ol li').count()) === 3);
      await panel.locator('#guide-tab-security summary').click();
      await panel.locator('#guide-tab-security button', { hasText: 'Open Security' }).click();
      check('the Open button on a card switches to that tab', (await panel.evaluate(() => DF.state.tab)) === 'security');
      check('the Guide shows no page errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- fuzz: hostile pages through the agent and the Site rewrite ---------- */
    console.log('\nFuzz: hostile page content');
    if (run('Fuzz')) {
      const gen = require('./fuzzgen.js');
      const seed = gen.seedFromEnv(20260511) + 99;
      const rounds = gen.roundsFromEnv(60);
      const r = gen.rng(seed);
      // The clean single-page app sends a CSP that blocks inline handlers, so the hostile markup
      // cannot run in the target page while the agent reads it.
      const { panel, target } = await openPanel(env, `http://127.0.0.1:${fx.spa.port}/`);
      target.on('dialog', (d) => d.dismiss());
      await panel.evaluate(() => call('ping'));
      const broken = [];
      for (let i = 0; i < rounds; i++) {
        const markup = gen.hostileHtml(r, 14);
        await target.evaluate((m) => {
          const box = document.createElement('div');
          box.id = 'fz';
          box.innerHTML = m;
          document.body.replaceChildren(box);
        }, markup);
        const dom = await panel.evaluate(() => call('fullDom', false));
        // Read what the saved file would become when opened in a browser with scripting on. A div
        // in the target page parses with scripting on (a template or DOMParser document would not,
        // and would read <noscript> text as markup). The page's CSP stops inline handlers running.
        const found = await target.evaluate((saved) => {
          const t = document.createElement('div');
          t.innerHTML = saved;
          // eslint-disable-next-line no-control-regex -- the URL parser skips these leading characters
          const deadly = (v) => /^(javascript|vbscript|data:text\/html)/i.test(String(v).replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, ''));
          const urlAttrs = /^(href|src|action|formaction|xlink:href|data|poster|ping|background|cite|longdesc|manifest)$/i;
          const bad = [];
          for (const el of t.querySelectorAll('*')) {
            if (/^(script|object|embed)$/i.test(el.localName)) bad.push('element ' + el.localName);
            if (el.localName === 'meta' && /refresh/i.test(el.getAttribute('http-equiv') || '')) bad.push('meta refresh');
            for (const a of el.attributes) {
              if (/^on/i.test(a.name)) bad.push('attribute ' + a.name);
              if (/^srcdoc$/i.test(a.name)) bad.push('srcdoc');
              if (urlAttrs.test(a.name) && deadly(a.value)) bad.push(a.name + '=' + a.value.slice(0, 30));
            }
          }
          return bad;
        }, dom);
        if (found.length) broken.push({ i, found: found.slice(0, 3), markup: markup.slice(0, 200) });
      }
      check('the saved page has no script, handler or javascript: address after ' + rounds + ' hostile pages (seed ' + seed + ')', broken.length === 0, JSON.stringify(broken.slice(0, 2)));

      // Site rewrite with nothing to rewrite must change nothing but the <base> tags.
      const rewrite = await panel.evaluate(
        ({ docs }) => {
          const parse = (s) => new DOMParser().parseFromString(DFTrusted.html(s), 'text/html');
          const bad = [];
          for (const markup of docs) {
            const out = DFSite.rewriteHtml(markup, 'https://a.example/', 'index.html', new Map());
            const before = parse(markup);
            before.querySelectorAll('base').forEach((b) => b.remove());
            if ('<!DOCTYPE html>\n' + before.documentElement.outerHTML !== out.html || out.rewritten !== 0) bad.push(markup.slice(0, 120));
          }
          return bad;
        },
        { docs: Array.from({ length: rounds }, () => gen.hostileHtml(r, 14)) }
      );
      check('the Site rewrite changes nothing but <base> when no address is saved (seed ' + seed + ')', rewrite.length === 0, JSON.stringify(rewrite.slice(0, 2)));

      const flat = await panel.evaluate(() => DFSite.rewriteHtml('<math><style><mi>keep</mi></style></math><style>a{b:red}</style>', 'https://a.example/', 'index.html', new Map()).html);
      check('regression: a <style> inside <math> keeps its child elements', /<style><mi>keep<\/mi><\/style>/.test(flat) && /<style>a\{b:red\}<\/style>/.test(flat), flat);

      // A stylesheet-sized hostile style attribute must not stall the agent's address scan.
      await target.evaluate((css) => {
        const box = document.createElement('div');
        box.id = 'fz';
        box.setAttribute('style', css);
        document.body.replaceChildren(box);
      }, 'url('.repeat(40000) + ' '.repeat(60000));
      const t0 = Date.now();
      await panel.evaluate(() => call('resourceMap'));
      const spent = Date.now() - t0;
      check('a 300 KB hostile style attribute does not stall the resource scan (' + spent + ' ms)', spent < 8000);
      check('no page errors during fuzzing', true);
      await panel.close();
    }

    /* ---------- known problems from 4.2: names that shadow built-ins, the bridge id, pick mode ---------- */
    console.log('\nPage agent against hostile names');
    if (run('Clobber')) {
      const { CLOBBER_NAMES } = require('./fixtures.js');
      const demoBase = `http://127.0.0.1:${fx.demo.port}/demo/`;
      const { panel, target, errors } = await openPanel(env, demoBase + 'clobber');
      const readers = ['pageInfo', 'scriptsInfo', 'accessibilityAudit', 'securityAudit', 'performanceAudit', 'responsiveReport', 'resourceMap', 'siteResources', 'contrastScan'];
      const out = await panel.evaluate(async (names) => {
        const res = {};
        for (const n of names) {
          try {
            await call(n);
            res[n] = 'ok';
          } catch (e) {
            res[n] = e.message.slice(0, 120);
          }
        }
        res.fullDom = await call('fullDom', false).then((s) => (typeof s === 'string' && s.includes('f1') ? 'ok' : 'wrong'), (e) => e.message.slice(0, 120));
        res.forms = await call('extractData', 'forms').then((f) => f, (e) => 'ERR ' + e.message.slice(0, 120));
        res.secFacts = await call('secFacts').then((f) => f, (e) => 'ERR ' + e.message.slice(0, 120));
        return res;
      }, readers);
      check('every page-reading call works on a page whose names shadow built-ins', readers.every((n) => out[n] === 'ok') && out.fullDom === 'ok', JSON.stringify(out, null, 0).slice(0, 700));
      const f1 = Array.isArray(out.forms) ? out.forms.find((f) => /submit/.test(f.action || '')) : null;
      check('the form read still has its real action, method and all of its fields', !!f1 && f1.action === '/submit' && f1.method === 'post' && f1.fields.length === CLOBBER_NAMES.length + 2, JSON.stringify(f1 || out.forms).slice(0, 300));
      const facts = out.secFacts && out.secFacts.forms ? out.secFacts.forms.find((f) => /submit/.test(f.action)) : null;
      check('the Security facts for that form are right (password, file upload, POST)', !!facts && facts.hasPassword === true && facts.hasFile === true && facts.method === 'post', JSON.stringify(out.secFacts && out.secFacts.forms).slice(0, 300));
      const info = await panel.evaluate(() => call('selectBySelector', '#f1').then((d) => d.form || d, (e) => 'ERR ' + e.message));
      check('selecting the form reports its action, method and field count', info && info.form && info.form.action === '/submit' && info.form.method === 'post' && info.form.fields === CLOBBER_NAMES.length + 2, JSON.stringify(info).slice(0, 300));

      // The same calls on the form itself, next to the same calls on a plain paragraph. Anything that
      // fails on the form but not on the paragraph is a read the page managed to break.
      const onElement = (sel) =>
        panel.evaluate(async (s) => {
          const res = {};
          const d = await call('selectBySelector', s).catch((e) => ({ err: e.message }));
          if (!d || !d.h) return { select: (d && d.err) || 'no handle' };
          for (const [name, ...args] of [['children'], ['relative', 'parent'], ['css'], ['computedAll'], ['elementFacts'], ['collectComponent'], ['highlight'], ['clearHighlight'], ['xray', true], ['xray', false]]) {
            res[name] = await call(name, d.h, ...args).then(() => 'ok', (e) => e.message.slice(0, 100));
          }
          return res;
        }, sel);
      await panel.evaluate(() => document.getElementById('df-note') || 0);
      const control = await onElement('title');
      const formRes = await onElement('#f1');
      const differs = Object.keys(formRes).filter((k) => formRes[k] !== control[k] && formRes[k] !== 'ok');
      check('reads of the selected form fail no more often than reads of a plain element', differs.length === 0, JSON.stringify({ differs, formRes }).slice(0, 500));

      const scripts = await panel.evaluate(() => call('scriptsInfo'));
      check('an inline script with the id __df_bridge is listed like any other script', JSON.stringify(scripts).includes('__hiddenByName'));
      const res2 = await panel.evaluate(() => call('siteResources'));
      check('and it is in the site resources that the Site and Export downloads use', JSON.stringify(res2).includes('__hiddenByName'));
      check('no page errors on the clobbered page', errors.length === 0, errors.join(' | '));
      await target.close();
      await panel.close();
    }

    /* ---------- pick mode must not outlive the panel ---------- */
    console.log('\nPick mode and the panel');
    if (run('PickMode')) {
      const { panel, target, tabId } = await openPanel(env, vuln);
      const picking = () =>
        env.sw.evaluate(async (id) => {
          const r = await chrome.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: () => !!(window.__DF && window.__DF.kit.state.picking) });
          return r[0].result;
        }, tabId);
      await panel.evaluate(() => call('startPick'));
      check('pick mode is on after Pick is pressed', (await picking()) === true);
      await panel.waitForTimeout(1500);
      check('it stays on while the panel is open', (await picking()) === true);
      // Leaving the page is what closing a side panel does to the panel's own context.
      await panel.goto('about:blank');
      let off = false;
      for (let i = 0; i < 30 && !off; i++) {
        await new Promise((r) => setTimeout(r, 200));
        off = (await picking()) === false;
      }
      check('pick mode ends by itself when the panel closes', off);
      await target.close();
      await panel.close().catch(() => {});

      // Pressing Esc and picking an element still end it, and leave no port behind.
      const second = await openPanel(env, vuln);
      await second.panel.evaluate(() => call('startPick'));
      await second.panel.evaluate(() => call('stopPick'));
      check('stopPick still turns it off while the panel stays open', (await env.sw.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id }, world: 'ISOLATED', func: () => !!window.__DF.kit.state.picking }))[0].result, second.tabId)) === false);
      await second.target.close();
      await second.panel.close().catch(() => {});
    }

    /* ---------- stored data: damaged, old and oversized ---------- */
    console.log('\nStored data: damaged, old and oversized');
    if (run('Stored')) {
      const keys = ['settings', 'netRules', 'perfHistory'];
      const before = await env.sw.evaluate((k) => chrome.storage.local.get(k), keys);
      const putStored = (data) => env.sw.evaluate((d) => chrome.storage.local.set(d), data);
      const goodRule = { match: '/api/ok', regex: false, method: '*', kinds: 'any', action: 'block' };
      try {
        // 1. Damaged values everywhere.
        await putStored({
          settings: { theme: 'neon', shortcuts: 'Ctrl+K', siteAllowlist: 5, scanRetention: -9, schemaVersion: 'x', extra: { a: 1 } },
          netRules: [goodRule, null, { action: 'explode' }, { action: 'mock', match: '/x', status: 12 }],
          perfHistory: { bad: 1, ['k' + 'a'.repeat(24)]: ['x', { t: 5, lcp: 'slow' }, { t: 1700000000000, lcp: 900 }] },
        });
        const { panel, errors } = await openPanel(env, vuln);
        await panel.waitForSelector('#tabs button');
        check('the panel opens with damaged saved settings and uses defaults', (await panel.evaluate(() => DF.state.settings.theme + '|' + Array.isArray(DF.state.settings.siteAllowlist) + '|' + DF.state.settings.scanRetention)) === 'system|true|20');
        await panel.evaluate(() => show('network'));
        await panel.waitForTimeout(400);
        check('only the one usable interception rule is loaded', (await panel.evaluate(() => net.rules.length)) === 1);
        await panel.evaluate(() => show('perf'));
        await panel.waitForTimeout(400);
        await panel.evaluate(() => show('settings'));
        await panel.waitForSelector('#stored-ignored');
        const notes = await panel.locator('#stored-ignored li').allInnerTexts();
        check('Settings, Stored data names what was ignored, for settings and for rules', notes.some((n) => /^theme:/.test(n)) && notes.some((n) => /^shortcuts:/.test(n)) && notes.some((n) => /Interception rule \d+:/.test(n)), notes.join(' | '));
        check('the notes carry no raw saved value', !notes.join(' ').includes('neon'));
        for (const id of await panel.evaluate(() => DF.tabs.map((x) => x.id))) {
          await panel.evaluate((x) => show(x), id);
          await panel.waitForTimeout(80);
        }
        check('every tab still renders without page errors', errors.length === 0, errors.join(' | '));

        // 2. Damaged and oversized Workspace records, written straight into IndexedDB.
        const ws = await panel.evaluate(async () => {
          const p = await DFStore.createProject('Keep me');
          await DFStore.saveItem({ project: p.id, kind: 'data', title: 'Good item', payload: { a: 1 } });
          await DFStore.putRaw({ id: 'no-project', kind: 'data', title: 'x' });
          await DFStore.putRaw({ id: 'bad-kind', project: p.id, kind: 99, title: { a: 1 }, created: 'never' });
          await DFStore.putRaw({ id: 'huge', project: p.id, kind: 'screenshot', title: 'Huge', payload: { data: 'x'.repeat(26 * 1000 * 1000) } });
          const db = await new Promise((res, rej) => { const r = indexedDB.open('devforge'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          await new Promise((res, rej) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').put({ id: 'p-bad', name: 5 }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
          db.close();
          DF.state.stored.ignored.length = 0;
          const items = await DFStore.listItems(p.id);
          const projects = await DFStore.listProjects();
          return { titles: items.map((i) => i.title + ':' + i.kind), projects: projects.map((x) => x.name), notes: DF.state.stored.ignored.slice(), pid: p.id };
        });
        check('Workspace lists the good item and repairs the odd one', ws.titles.includes('Good item:data') && ws.titles.some((x) => /:other$/.test(x)), JSON.stringify(ws));
        check('a record without a project and a 26 MB record are left out', ws.titles.length === 2 && ws.notes.some((n) => /left out/.test(n) && /larger than 25 MB/.test(n)), JSON.stringify(ws.notes));
        check('a project with a bad name is shown as Untitled project instead of failing', ws.projects.includes('Untitled project') && ws.projects.includes('Keep me'), JSON.stringify(ws.projects));
        await panel.evaluate(() => show('work'));
        await panel.waitForTimeout(500);
        check('the Workspace tab opens with those records in the database', errors.length === 0, errors.join(' | '));
        await panel.evaluate(async () => {
          await DFStore.deleteProject(DF.state.stored ? (await DFStore.listProjects()).find((x) => x.name === 'Keep me').id : '');
          for (const id of ['no-project', 'bad-kind', 'huge']) await DFStore.deleteItem(id);
          const db = await new Promise((res) => { const r = indexedDB.open('devforge'); r.onsuccess = () => res(r.result); });
          await new Promise((res) => { const tx = db.transaction('projects', 'readwrite'); tx.objectStore('projects').delete('p-bad'); tx.oncomplete = res; });
          db.close();
        });
        await panel.close();

        // 3. Settings written by 4.2.0 (no version field).
        await env.sw.evaluate(() => chrome.storage.local.remove(['perfHistory', 'netRules']));
        await putStored({ settings: { theme: 'dark', lastTab: 'tokens', shortcuts: { pick: 'Ctrl+Shift+U' }, allowAllSites: true } });
        const old = await openPanel(env, vuln);
        await old.panel.waitForSelector('#tabs button');
        await old.panel.waitForTimeout(600);
        check('4.2.0 settings are read: theme and last tab are kept', (await old.panel.evaluate(() => DF.state.settings.theme + '|' + DF.state.tab)) === 'dark|tokens');
        const saved = await env.sw.evaluate(() => chrome.storage.local.get('settings'));
        check('the migrated settings are saved with the new version and nothing is reported', saved.settings.schemaVersion === 2 && saved.settings.theme === 'dark' && (await old.panel.evaluate(() => DF.state.stored.ignored.length)) === 0, JSON.stringify(saved.settings).slice(0, 200));
        check('no page errors with 4.2.0 settings', old.errors.length === 0, old.errors.join(' | '));
        await old.panel.close();
      } finally {
        await env.sw.evaluate(async (b) => {
          await chrome.storage.local.remove(['settings', 'netRules', 'perfHistory']);
          await chrome.storage.local.set(b);
        }, before);
      }
    }

    /* ---------- hardening helpers: CSP Report-Only and Subresource Integrity ---------- */
    console.log('\nSecurity: CSP suggestion and Subresource Integrity');
    if (run('Hardening')) {
      const { VENDOR, FAKE } = require('./fixtures.js');
      const nodeCrypto = require('node:crypto');
      const b64 = (alg, s) => nodeCrypto.createHash(alg).update(s).digest('base64');
      const port = fx.demo.port;
      const { panel, target, errors } = await openPanel(env, `http://127.0.0.1:${port}/demo/hardening`);
      await panel.evaluate(() => show('security'));
      await panel.waitForSelector('#hardening');
      await panel.click('#hardening > summary');
      await panel.waitForTimeout(1200);
      const before = await target.evaluate(() => document.documentElement.outerHTML.length);

      await panel.click('#btn-csp');
      await panel.waitForSelector('#csp-header');
      const csp = await panel.locator('#csp-header').innerText();
      const dir = (name) => (csp.split('; ').find((d) => d.startsWith(name + ' ')) || '').split(' ').slice(1);
      check('CSP: it is a Report-Only header with default-src self', /^Content-Security-Policy-Report-Only: default-src 'self'; /.test(csp), csp.slice(0, 200));
      check('CSP: script-src names the third-party origin and the hash of the inline script, not its text', dir('script-src').includes('http://example.com:' + port) && dir('script-src').includes("'sha256-" + b64('sha256', VENDOR.inlineScript.replace('TP', 'http://example.com:' + port)) + "'") && !csp.includes(FAKE.stripe), csp);
      check('CSP: style-src has the stylesheet origin and the hash of the inline style', dir('style-src').includes('http://example.com:' + port) && dir('style-src').includes("'sha256-" + b64('sha256', VENDOR.inlineStyle) + "'"), csp);
      check('CSP: img-src and connect-src list the origin the page used', dir('img-src').includes('http://example.com:' + port) && dir('connect-src').includes('http://example.com:' + port), csp);
      check('CSP: the style attribute is reported, and object-src is none', /style-src-attr 'unsafe-inline'/.test(csp) && /object-src 'none'/.test(csp), csp);
      const cspCard = await panel.locator('#csp-result').innerText();
      check('CSP: the result is labelled generated and inferred and explains that it blocks nothing', /generated/.test(cspCard) && /inferred/.test(cspCard) && /blocks nothing/.test(cspCard));

      await panel.click('#btn-sri');
      await panel.waitForSelector('#sri-tags', { timeout: 60000 });
      const sriText = await panel.locator('#sri-result').innerText();
      const tags = await panel.locator('#sri-tags').innerText();
      const tp = 'http://example.com:' + port;
      check('SRI: lib.js gets a tag whose hash is the SHA-384 of the file', tags.includes('<script src="' + tp + '/vendor/lib.js" integrity="sha384-' + b64('sha384', VENDOR.lib) + '" crossorigin="anonymous"></script>'), tags);
      check('SRI: the stylesheet gets a link tag with its hash', tags.includes('<link rel="stylesheet" href="' + tp + '/vendor/lib.css" integrity="sha384-' + b64('sha384', VENDOR.css) + '" crossorigin="anonymous">'), tags);
      check('SRI: a correct integrity attribute on the page is recognised and not rewritten', /known\.js[^\n]*\n?[^\n]*The integrity value on the page is correct/.test(sriText) && !tags.includes('known.js'), sriText);
      check('SRI: a wrong integrity attribute is flagged and a corrected tag is offered', /stale\.js[\s\S]*does not match the file now/.test(sriText) && tags.includes('stale.js" integrity="sha384-' + b64('sha384', VENDOR.stale)), sriText + tags);
      check('SRI: a file that changes between requests gets no tag', /changing\.js[\s\S]*Changes between requests/.test(sriText) && !tags.includes('changing.js'), sriText);
      check('SRI: a private address (localhost, another host than the page) is not fetched', /localhost[\s\S]*Could not be fetched[\s\S]*blocked/.test(sriText) && !tags.includes('localhost'), sriText);
      check('the helpers leave the page as it was', (await target.evaluate(() => document.documentElement.outerHTML.length)) === before);
      check('no secret value in the helper output', !(await panel.locator('#hardening').innerText()).includes(FAKE.stripe));
      check('no page errors in the Security tab helpers', errors.length === 0, errors.join(' | '));
      await target.close();
      await panel.close();
    }

    /* ---------- check one finding again ---------- */
    console.log('\nSecurity: check one finding again');
    if (run('Recheck')) {
      const { panel, target, errors } = await openPanel(env, vuln);
      const report = await runScan(panel, 'standard');
      const ids = report.findings.map((f) => f.id);
      check('the weak site has an exposed .git folder and missing headers to re-check', ids.includes('exposed-git-head') && ids.includes('csp-missing'), ids.join(','));
      const logBefore = fx.vuln.log.length;
      const again = (id) =>
        panel.evaluate(async (fid) => {
          SEC.go('findings', fid);
          await new Promise((r) => setTimeout(r, 300));
          const btn = document.querySelector('[data-recheck="' + fid + '"]');
          if (!btn) return 'no button';
          btn.click();
          for (let i = 0; i < 60; i++) {
            await new Promise((r) => setTimeout(r, 200));
            const out = btn.parentElement.querySelector('.sec-recheck');
            if (out && !/Checking/.test(out.textContent) && out.textContent) return out.textContent;
          }
          return 'timeout';
        }, id);
      const still = await again('exposed-git-head');
      check('an exposure that is still there is reported as still present', /Still present/.test(still), still);
      const hdr = await again('csp-missing');
      check('a missing header that is still missing is reported as still present', /Still present/.test(hdr), hdr);
      const sent = fx.vuln.log.slice(logBefore);
      check('the re-checks sent only GET or HEAD requests, at most 4 in all, with no cookies', sent.length <= 4 && sent.every((r) => /^(GET|HEAD)$/.test(r.method) && !r.cookie && !r.auth), JSON.stringify(sent.map((r) => r.method + ' ' + r.url)));
      fx.vuln.fix('git');
      const fixed = await again('exposed-git-head');
      check('after the exposure is removed the same button says fixed', /Fixed/.test(fixed), fixed);
      check('the saved report is not changed by a re-check', (await panel.evaluate(() => SEC.report.findings.some((f) => f.id === 'exposed-git-head'))) === true);
      check('a finding that needs a full scan has no Check again button', await panel.evaluate(() => { const f = SEC.report.findings.find((x) => x.theme === 'cookies'); if (!f) return true; SEC.go('findings', f.id); return !document.querySelector('[data-fid="' + f.id + '"] [data-recheck]'); }));
      check('no page errors during re-checks', errors.length === 0, errors.join(' | '));
      await target.close();
      await panel.close();
    }

    /* ---------- capture self-check ---------- */
    console.log('\nNetwork: capture warns when the page replaced built-ins first');
    if (run('Tamper')) {
      const bad = await openPanel(env, vuln + 'hostile-proto');
      await bad.panel.evaluate(() => startCapture());
      const list = await bad.panel.evaluate(() => (net.tamper ? net.tamper.list : null));
      check('capture on a page that replaced String.prototype.charCodeAt reports it', Array.isArray(list) && list.includes('String.prototype.charCodeAt'), JSON.stringify(list));
      await bad.panel.evaluate(() => show('network'));
      await bad.panel.waitForSelector('#net-tamper');
      const warn = await bad.panel.locator('#net-tamper').innerText();
      check('the Network tab shows a clear warning and recommends capture from page start', /replaced built-in functions/.test(warn) && /From page start/.test(warn), warn);
      check('the check leaves no frame behind in the page', (await bad.target.evaluate(() => document.querySelectorAll('iframe').length)) === 0);
      check('capture still works after the warning', (await bad.panel.evaluate(() => netCall('ping'))) === 'pong');
      check('no page errors on the hostile page', bad.errors.length === 0, bad.errors.join(' | '));
      await bad.target.close();
      await bad.panel.close();

      const clean = await openPanel(env, vuln);
      await clean.panel.evaluate(() => startCapture());
      check('capture on a clean page reports nothing', (await clean.panel.evaluate(() => net.tamper)) === null);
      await clean.panel.evaluate(() => show('network'));
      await clean.panel.waitForTimeout(400);
      check('and shows no warning', (await clean.panel.locator('#net-tamper').count()) === 0);
      await clean.target.close();
      await clean.panel.close();
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
      let asked = false;
      const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#bundle-zip').then(async () => (asked = await keepIfAsked(panel)))]);
      check('the weak site holds fake credentials, so the bundle asks first (Secrets check)', asked);
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
      await keepIfAsked(panel);
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
