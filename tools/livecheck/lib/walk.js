// Opens the unpacked ZIP in a real Chromium, visits every panel and records what went wrong.
// The extension is loaded exactly as shipped: the manifest is not changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZip } = require('./zipread');

function loadPlaywright() {
  const tries = ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright'];
  for (const id of tries) {
    if (!id) continue;
    try {
      return require(id);
    } catch (_) {
      /* try the next one */
    }
  }
  throw new Error('Playwright is not installed. Run "npm install" in this folder first.');
}

function unpack(files, dest) {
  for (const f of files) {
    const target = path.join(dest, ...f.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ files, site, outDir, headed, slow, chromePath, extraUrls, log }) {
  const { chromium } = loadPlaywright();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-live-'));
  const extDir = path.join(work, 'ext');
  unpack(files, extDir);
  const shots = path.join(outDir, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const downloads = path.join(work, 'downloads');
  fs.mkdirSync(downloads);

  const result = { walk: [], flows: [], serviceWorker: {}, network: { fromExtension: [], external: [] }, errors: { page: [], console: [], violations: [] }, browser: '' };
  const executablePath = chromePath || process.env.CHROME_PATH || chromium.executablePath();
  const args = ['--no-sandbox', '--disable-extensions-except=' + extDir, '--load-extension=' + extDir];
  if (!headed) args.unshift('--headless=new');
  const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), { headless: false, executablePath, args, acceptDownloads: true, slowMo: slow || 0, viewport: null });
  result.browser = ctx.browser() ? ctx.browser().version() : '';

  const siteOrigin = new URL(site.url).origin;
  ctx.on('request', (req) => {
    const frame = (() => {
      try {
        return req.frame();
      } catch (_) {
        return null;
      }
    })();
    const fromExt = !!req.serviceWorker() || (frame && frame.url().startsWith('chrome-extension://'));
    if (!fromExt) return;
    const u = req.url();
    if (/^(chrome-extension:|data:|blob:|about:)/.test(u)) return;
    result.network.fromExtension.push(u);
    if (!u.startsWith(siteOrigin)) result.network.external.push(u);
  });
  ctx.on('weberror', (e) => result.errors.page.push(String(e.error && e.error.message ? e.error.message : e.error)));

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = sw.url().split('/')[2];
    result.serviceWorker = await sw.evaluate(async () => {
      const out = { version: chrome.runtime.getManifest().version, commands: [], panelBehavior: null };
      out.commands = (await chrome.commands.getAll()).map((c) => c.name + (c.shortcut ? ' (' + c.shortcut + ')' : ''));
      try {
        out.panelBehavior = await chrome.sidePanel.getPanelBehavior();
      } catch (e) {
        out.panelBehavior = 'error: ' + e.message;
      }
      return out;
    });

    const target = await ctx.newPage();
    await target.goto(site.url);
    const tabId = await sw.evaluate(async (p) => (await chrome.tabs.query({ url: p })).sort((a, b) => b.id - a.id)[0].id, site.url + '*');

    const panel = await ctx.newPage();
    // Each violation is sent out as it happens, so a reload of the panel cannot lose it.
    await panel.exposeFunction('__dfViolation', (m) => result.errors.violations.push(String(m).slice(0, 300)));
    await panel.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        if (window.__dfViolation) window.__dfViolation(e.violatedDirective + ' ' + (e.sample || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber);
      });
    });
    panel.on('pageerror', (e) => result.errors.page.push(e.message));
    panel.on('console', (m) => {
      if (m.type() === 'error') result.errors.console.push(m.text().slice(0, 300));
    });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    // The panel is opened as a normal tab here, so tell it which tab to work on.
    await panel.evaluate((tid) => {
      chrome.tabs.query = async () => [await chrome.tabs.get(tid)];
    }, tabId);
    await panel.waitForFunction(() => typeof ORDER !== 'undefined' && typeof show === 'function', null, { timeout: 15000 });
    const tabs = await panel.evaluate(() => [...ORDER]);
    log(`  ${tabs.length} panels found`);

    // ---- every panel, two themes, two widths ----
    for (const theme of ['dark', 'light']) {
      await panel.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      for (const width of [1280, 360]) {
        await panel.setViewportSize({ width, height: 800 });
        for (const tab of tabs) {
          const before = result.errors.console.length + result.errors.page.length;
          await panel.evaluate((t) => show(t), tab);
          await sleep(350);
          await panel.keyboard.press('Escape');
          const file = `${tab}-${theme}-${width}.jpg`;
          await panel.screenshot({ path: path.join(shots, file), type: 'jpeg', quality: 70 });
          const facts = await panel.evaluate(() => {
            const text = document.body.innerText || '';
            const named = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || (el.labels && el.labels.length) || (el.textContent || '').trim() || el.getAttribute('placeholder') || el.querySelector('title, img[alt]'));
            // Parts inside a closed <details> are not shown, so they are not counted.
            const shown = (e) => (typeof e.checkVisibility === 'function' ? e.checkVisibility() : e.offsetParent !== null);
            const controls = [...document.querySelectorAll('button, input:not([type=hidden]), select, textarea')].filter(shown);
            return {
              chars: text.trim().length,
              overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
              // Text boxes keep their words in .value, which innerText does not include.
              badText: ((text + ' ' + [...document.querySelectorAll('textarea, input:not([type=password]):not([type=hidden])')].filter((e) => e.checkVisibility ? e.checkVisibility() : e.offsetParent !== null).map((e) => e.value || '').join(' ')).match(/\bundefined\b|\bNaN\b|\[object Object\]/g) || []).slice(0, 3),
              unnamed: controls.filter((e) => !named(e)).length,
              controls: controls.length,
            };
          });
          const problems = [];
          if (facts.chars < 20) problems.push('the panel is almost empty');
          if (facts.overflowX) problems.push('it scrolls sideways');
          if (facts.badText.length) problems.push('it shows "' + facts.badText.join('", "') + '"');
          if (facts.unnamed) problems.push(facts.unnamed + ' control(s) with no name');
          const newErrors = result.errors.console.length + result.errors.page.length - before;
          if (newErrors) problems.push(newErrors + ' error(s) in the console');
          result.walk.push({ tab, theme, width, shot: 'shots/' + file, problems });
        }
      }
    }
    await panel.setViewportSize({ width: 1280, height: 800 });
    await panel.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    // ---- things a person does ----
    const flow = async (name, fn) => {
      const t0 = Date.now();
      try {
        const detail = await fn();
        result.flows.push({ name, ok: true, detail: detail || '', ms: Date.now() - t0 });
      } catch (e) {
        result.flows.push({ name, ok: false, detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 });
      }
    };
    const download = async (click, name) => {
      const [d] = await Promise.all([panel.waitForEvent('download', { timeout: 60000 }), click()]);
      const file = path.join(downloads, name);
      await d.saveAs(file);
      return readZip(fs.readFileSync(file));
    };

    await flow('Pick an element by selector (#hero)', async () => {
      await panel.evaluate(() => show('inspect'));
      // The same two steps the Inspect panel takes when a person types a selector.
      await panel.evaluate(async () => setSelection(await call('selectBySelector', '#hero')));
      const ok = await panel.evaluate(() => !!DF.state.h && !!DF.state.info && DF.state.info.selectors && DF.state.info.selectors.length > 0);
      if (!ok) throw new Error('nothing was selected');
      await panel.waitForFunction(() => /hero/.test(document.body.innerText), null, { timeout: 8000 });
      return 'selected and shown';
    });
    await flow('Network tab sees a request from the page', async () => {
      await panel.evaluate(() => show('network'));
      await sleep(600);
      await target.evaluate(() => fetch('/api/items?live=1').then((r) => r.text()));
      await panel.waitForFunction(() => /api\/items/.test(document.body.innerText), null, { timeout: 10000 });
      return '/api/items listed';
    });
    await flow('Storage tab lists the page keys', async () => {
      await panel.evaluate(() => show('storage'));
      await panel.waitForFunction(() => /cart/.test(document.body.innerText), null, { timeout: 8000 });
      return 'localStorage key "cart" listed';
    });
    await flow('Perf tab shows web vitals', async () => {
      await panel.evaluate(() => show('perf'));
      await panel.waitForFunction(() => /LCP|CLS|TTFB/.test(document.body.innerText), null, { timeout: 10000 });
      return 'metrics shown';
    });
    await flow('Export makes a valid ZIP of the selected part', async () => {
      await panel.evaluate(() => show('export'));
      await panel.waitForSelector('#el-zip', { timeout: 8000 });
      const zip = await download(() => panel.click('#el-zip'), 'part.zip');
      if (zip.length < 3) throw new Error('only ' + zip.length + ' file(s) in the ZIP');
      return zip.length + ' files, every CRC matches';
    });
    await flow('Site download makes a valid ZIP', async () => {
      await panel.evaluate(() => show('site'));
      await panel.waitForSelector('#site-go', { timeout: 8000 });
      const zip = await download(() => panel.click('#site-go'), 'site.zip');
      if (!zip.some((f) => /index\.html$|original\.html$|rendered/.test(f.name))) throw new Error('no page HTML in the ZIP');
      return zip.length + ' files, every CRC matches';
    });
    await flow('Security passive scan finishes', async () => {
      await panel.evaluate(() => {
        SEC.view = 'setup';
        SEC.report = null;
        show('security');
      });
      await panel.waitForSelector('#sec-lv-passive', { timeout: 8000 });
      await panel.check('#sec-lv-passive');
      await panel.click('button:has-text("Start scan")');
      await panel.waitForSelector('.sec-banner', { timeout: 120000 });
      const n = await panel.evaluate(() => (SEC.report && SEC.report.findings ? SEC.report.findings.length : -1));
      return n >= 0 ? n + ' findings in the report' : 'report shown';
    });
    await flow('Playground opened from an AI reply shows empty boxes, not the word "undefined"', async () => {
      await panel.evaluate(() => {
        DF.state.pg = { html: '<b>x</b>' };
        DF.state.pgPaused = true;
        show('play');
      });
      await sleep(500);
      const values = await panel.evaluate(() => [...document.querySelectorAll('textarea')].map((t) => t.value));
      const bad = values.filter((v) => /^(undefined|null|NaN)$/.test(v.trim()));
      if (bad.length) throw new Error(bad.length + ' box(es) show "' + bad[0].trim() + '"');
      return 'boxes are empty or filled';
    });
    await flow('The command palette opens with Ctrl+K and closes with Esc', async () => {
      await panel.evaluate(() => show('home'));
      await panel.keyboard.press('Control+k');
      await panel.waitForSelector('[role=dialog], .palette, #palette', { timeout: 5000 });
      await panel.keyboard.press('Escape');
      return 'opened and closed';
    });
    await flow('The chosen theme is remembered after a reload', async () => {
      await panel.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      const saved = await panel.evaluate(() => (typeof setTheme === 'function' ? (setTheme('light'), true) : false));
      if (!saved) return 'skipped: no setTheme helper in this build';
      await panel.reload();
      await panel.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, { timeout: 8000 });
      return 'light theme kept';
    });
    await flow('The service worker reports the packaged version', async () => {
      const mv = JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString('utf8')).version;
      if (result.serviceWorker.version !== mv) throw new Error(`worker says ${result.serviceWorker.version}, manifest says ${mv}`);
      if (!result.serviceWorker.commands.some((c) => /pick-element/.test(c))) throw new Error('shortcut "pick-element" is not registered');
      if (result.serviceWorker.panelBehavior && result.serviceWorker.panelBehavior.openPanelOnActionClick !== true) throw new Error('the toolbar icon does not open the side panel');
      return `version ${mv}; shortcuts: ${result.serviceWorker.commands.join(', ')}`;
    });

    // Pages the user named: only the panels' first screens and the passive reads run here.
    for (const u of extraUrls || []) {
      await flow('Opens ' + u, async () => {
        const p = await ctx.newPage();
        await p.goto(u, { timeout: 45000, waitUntil: 'domcontentloaded' });
        await sleep(1500);
        await p.screenshot({ path: path.join(shots, 'site-' + new URL(u).hostname + '.jpg'), type: 'jpeg', quality: 60 });
        await p.close();
        return 'loaded with DevForge installed';
      });
    }

    await panel.close();
    await target.close();
  } finally {
    await ctx.close().catch(() => {});
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (_) {
      /* Windows may still hold a file for a moment; the system cleans the temp folder later */
    }
  }
  return result;
}

module.exports = { run };
