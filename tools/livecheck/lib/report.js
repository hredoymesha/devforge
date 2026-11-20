// Turns the results into one HTML page and one JSON file.
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function collect(data) {
  const items = []; // { level, area, text, detail }
  for (const c of data.audit) items.push({ level: c.level, area: c.group, text: c.text, detail: c.detail });
  const live = data.live;
  if (live && live.fatal) items.push({ level: 'fail', area: 'Live run', text: 'The browser run did not finish', detail: live.fatal });
  if (live && !live.fatal) {
    for (const f of live.flows) items.push({ level: f.ok ? 'pass' : 'fail', area: 'Flow', text: f.name, detail: f.detail });
    for (const w of live.walk) for (const p of w.problems) {
      const hard = /empty|error|undefined|NaN|object Object/.test(p);
      items.push({ level: hard ? 'fail' : 'warn', area: 'Panel', text: `${w.tab} (${w.theme}, ${w.width}px): ${p}`, detail: w.shot });
    }
    items.push({ level: live.walk.every((w) => !w.problems.length) ? 'pass' : 'info', area: 'Panel', text: `${live.walk.length} panel views opened (every panel, 2 themes, 2 widths)`, detail: '' });
    items.push({ level: live.network.external.length ? 'fail' : 'pass', area: 'Privacy', text: 'The extension made no request to an outside address', detail: [...new Set(live.network.external)].slice(0, 5).join(', ') });
    items.push({ level: live.errors.violations.length ? 'fail' : 'pass', area: 'Security', text: 'No Content Security Policy or Trusted Types violation in the panel', detail: live.errors.violations.slice(0, 3).join(' | ') });
    items.push({ level: live.errors.page.length ? 'fail' : 'pass', area: 'Errors', text: 'No uncaught error in any page or worker', detail: live.errors.page.slice(0, 3).join(' | ') });
    items.push({ level: live.errors.console.length ? 'fail' : 'pass', area: 'Errors', text: 'No console error in the panel', detail: [...new Set(live.errors.console)].slice(0, 3).join(' | ') });
  }
  return items;
}

function write(outDir, data) {
  const items = collect(data);
  const count = (l) => items.filter((i) => i.level === l).length;
  const summary = { fail: count('fail'), warn: count('warn'), pass: count('pass'), info: count('info') };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ summary, ...data }, null, 2));

  const row = (i) => `<tr class="${i.level}"><td><span class="tag">${i.level}</span></td><td>${esc(i.area)}</td><td>${esc(i.text)}${i.detail ? `<div class="d">${esc(i.detail)}</div>` : ''}</td></tr>`;
  const attention = items.filter((i) => i.level === 'fail' || i.level === 'warn');
  const live = data.live && !data.live.fatal ? data.live : null;
  const m = data.manifest || {};
  const verdict = summary.fail ? 'Not ready: fix the red items first.' : summary.warn ? 'No failures. Read the yellow items before you upload.' : 'No failures and nothing to read.';
  const gallery = live ? live.walk.filter((w) => w.theme === 'dark' && w.width === 1280).map((w) => `<figure><a href="${esc(w.shot)}"><img loading="lazy" src="${esc(w.shot)}" alt="${esc(w.tab)} panel, dark, wide"></a><figcaption>${esc(w.tab)}</figcaption></figure>`).join('') : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live check: ${esc(data.zip)}</title><style>
:root{--bg:#fff;--fg:#1c2330;--mut:#5b6677;--line:#d7dde8;--card:#f5f7fb;--fail:#b3261e;--warn:#8a5a00;--pass:#1b6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#0f141c;--fg:#e6ebf3;--mut:#9aa6b8;--line:#2a3445;--card:#161d29;--fail:#ff8a80;--warn:#f0b955;--pass:#6fd39a}}
body{font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px}main{max-width:980px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.sub{color:var(--mut);margin:0 0 16px}
.v{padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);font-weight:600}
.v.bad{border-color:var(--fail)}.v.mid{border-color:var(--warn)}.v.ok{border-color:var(--pass)}
.nums{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.nums div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:6px 8px;vertical-align:top}.d{color:var(--mut);font-size:13px;word-break:break-word}
.tag{font-size:12px;font-weight:700;text-transform:uppercase}tr.fail .tag{color:var(--fail)}tr.warn .tag{color:var(--warn)}tr.pass .tag{color:var(--pass)}tr.info .tag{color:var(--mut)}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}figure{margin:0}img{width:100%;border:1px solid var(--line);border-radius:6px}figcaption{font-size:13px;color:var(--mut)}
</style></head><body><main>
<h1>Live check: ${esc(data.zip)}</h1>
<p class="sub">${esc(m.name || '')} ${esc(m.version || '')}${m.version_name ? ' (' + esc(m.version_name) + ')' : ''} &middot; ${esc(data.started)}${live && live.browser ? ' &middot; browser ' + esc(live.browser) : ''}</p>
<div class="v ${summary.fail ? 'bad' : summary.warn ? 'mid' : 'ok'}">${esc(verdict)}</div>
<div class="nums"><div><b>${summary.fail}</b> failed</div><div><b>${summary.warn}</b> to read</div><div><b>${summary.pass}</b> passed</div></div>
<h2>Needs your attention</h2>${attention.length ? `<table>${attention.map(row).join('')}</table>` : '<p>Nothing.</p>'}
<h2>What a person does</h2>${live ? `<table>${items.filter((i) => i.area === 'Flow').map(row).join('')}</table>` : '<p>The live part did not run.</p>'}
<h2>Package and permissions</h2><table>${items.filter((i) => ['Package', 'Manifest', 'Icons', 'Permissions', 'Security', 'Privacy'].includes(i.area) && i.level !== 'fail' && i.level !== 'warn').map(row).join('')}</table>
${live ? `<h2>The extension and the network</h2><p class="sub">${live.network.fromExtension.length} request(s) came from the extension; ${live.network.external.length} went outside the test site.</p>` : ''}
${live ? `<h2>Every panel (dark, wide)</h2><div class="g">${gallery}</div><p class="sub">More views are in the shots folder: light theme and a 360 px width.</p>` : ''}
<p class="sub">This check runs the packaged ZIP in a test build of Chromium. It does not replace trying the extension by hand in Chrome (see checklist.html).</p>
</main></body></html>`;
  fs.writeFileSync(path.join(outDir, 'report.html'), html);
  fs.copyFileSync(path.join(__dirname, '..', 'checklist.html'), path.join(outDir, 'checklist.html'));
  return summary;
}

module.exports = { write };
