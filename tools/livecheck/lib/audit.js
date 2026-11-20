// Static checks on the extension ZIP, the same file that would be uploaded to the store.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readZip } = require('./zipread');

const VENDORED = new Set(['lib/acorn.js', 'lib/beautifier.min.js']);
const DEV_FOLDERS = ['tools/', 'test/', 'e2e/', 'scripts/', 'node_modules/', '.github/', 'release-out/'];
const NEEDS_PERMISSION = {
  scripting: 'scripting',
  storage: 'storage',
  sidePanel: 'sidePanel',
  contextMenus: 'contextMenus',
  declarativeNetRequest: 'declarativeNetRequest',
  cookies: 'cookies',
  downloads: 'downloads',
  debugger: 'debugger',
  webNavigation: 'webNavigation',
  webRequest: 'webRequest',
  history: 'history',
  bookmarks: 'bookmarks',
  tabCapture: 'tabCapture',
  management: 'management',
  notifications: 'notifications',
  alarms: 'alarms',
  identity: 'identity',
};
// Hosts the code may mention. Anything else is listed for a human to look at.
const KNOWN_HOSTS = [
  'claude.ai', 'chatgpt.com', 'gemini.google.com', 'copilot.microsoft.com', 'github.com',
  'www.w3.org', 'w3.org', 'schemastore.org', 'json-schema.org', 'developer.mozilla.org', 'localhost',
  'example.com', 'example.org', 'example.test', 'www.example.com', 'tools.ietf.org', 'datatracker.ietf.org',
  'www.rfc-editor.org', 'html.spec.whatwg.org', 'spec.whatwg.org', 'owasp.org', 'cheatsheetseries.owasp.org',
  'www.googletagmanager.com', 'cdn.polyfill.io', 'polyfill.io', 'schema.org', 'registry.npmjs.org', 'npmjs.com',
  'web.dev', 'developer.chrome.com', 'www.npmjs.com', 'raw.githubusercontent.com', 'swagger.io', 'spec.openapis.org',
  'docs.sarif.org', 'placeholder.invalid', 'sarif.info', 'vitejs.dev', 'reactjs.org', 'react.dev', 'vuejs.org', 'nvd.nist.gov',
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.slice(0, 8).equals(sig)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}


// True when the pattern matches outside a comment and outside a quoted string on its line.
function realCalls(text, re) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(re)) {
      const before = line.slice(0, m.index + (m[1] ? m[1].length : 0));
      let inside = false;
      let quote = '';
      for (let i = 0; i < before.length; i++) {
        const c = before[i];
        if (inside) {
          if (c === '\\') i++;
          else if (c === quote) inside = false;
        } else if (c === "'" || c === '"' || c === '`') {
          inside = true;
          quote = c;
        }
      }
      if (!inside) return true;
    }
  }
  return false;
}

function audit(zipPath, reasonsPath) {
  const checks = [];
  // level: fail stops a release, warn needs a human look, info is for the record.
  const add = (group, level, ok, text, detail = '') => checks.push({ group, level: ok ? 'pass' : level, text, detail: String(detail) });

  const buf = fs.readFileSync(zipPath);
  add('Package', 'info', true, 'ZIP size', `${(buf.length / 1048576).toFixed(2)} MB, SHA-256 ${sha256(buf)}`);

  const shaFile = zipPath + '.sha256';
  if (fs.existsSync(shaFile)) {
    const want = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
    add('Package', 'fail', want === sha256(buf), 'ZIP matches its .sha256 file', want === sha256(buf) ? '' : `file says ${want}`);
  } else {
    add('Package', 'warn', false, 'No .sha256 file next to the ZIP');
  }

  let files;
  try {
    files = readZip(buf);
    add('Package', 'fail', true, 'Every entry opens and its CRC matches', `${files.length} files`);
  } catch (e) {
    add('Package', 'fail', false, 'ZIP can be read', e.message);
    return { checks, files: [] };
  }
  const byName = new Map(files.map((f) => [f.name, f]));
  const names = files.map((f) => f.name);

  const unsafe = names.filter((n) => n.startsWith('/') || n.includes('..') || n.includes('\\') || /^[a-zA-Z]:/.test(n));
  add('Package', 'fail', unsafe.length === 0, 'No unsafe entry names', unsafe.join(', '));
  add('Package', 'fail', new Set(names).size === names.length, 'No duplicate entry names');
  const dev = names.filter((n) => DEV_FOLDERS.some((d) => n.startsWith(d)));
  add('Package', 'fail', dev.length === 0, 'No development folders in the package', dev.slice(0, 5).join(', '));
  const junk = names.filter((n) => /(^|\/)(\.[^/]+|.*\.(map|log|bak|orig|tmp|env|pem|key)|Thumbs\.db)$/i.test(n));
  add('Package', 'fail', junk.length === 0, 'No hidden files, source maps, logs, backups or keys', junk.slice(0, 5).join(', '));
  add('Package', 'info', true, 'Largest files', files.slice().sort((a, b) => b.data.length - a.data.length).slice(0, 4).map((f) => `${f.name} ${(f.data.length / 1024).toFixed(0)} KB`).join(', '));

  const mf = byName.get('manifest.json');
  if (!mf) {
    add('Manifest', 'fail', false, 'manifest.json is at the top of the package');
    return { checks, files };
  }
  add('Manifest', 'fail', true, 'manifest.json is at the top of the package');
  let m;
  try {
    m = JSON.parse(mf.data.toString('utf8'));
  } catch (e) {
    add('Manifest', 'fail', false, 'manifest.json is valid JSON', e.message);
    return { checks, files };
  }
  add('Manifest', 'fail', m.manifest_version === 3, 'Manifest version 3', 'found ' + m.manifest_version);
  add('Manifest', 'fail', /^\d{1,5}(\.\d{1,5}){0,3}$/.test(m.version || ''), 'Version is 1 to 4 whole numbers', m.version);
  add('Manifest', 'info', true, 'Version name', m.version_name || '(none)');
  add('Manifest', 'fail', !!m.name && m.name.length <= 75, 'Name is present and at most 75 characters', `${(m.name || '').length} characters`);
  add('Manifest', 'fail', !!m.description && m.description.length <= 132, 'Description is present and at most 132 characters', `${(m.description || '').length} characters`);
  add('Manifest', 'warn', !!m.minimum_chrome_version, 'A minimum Chrome version is set', m.minimum_chrome_version || '');
  add('Manifest', 'fail', !m.update_url, 'No update_url (the store handles updates)');

  const icons = Object.assign({}, m.icons, m.action && m.action.default_icon);
  const sizes = new Set();
  for (const [size, file] of Object.entries(icons)) {
    const f = byName.get(file);
    const dim = f && pngSize(f.data);
    const ok = !!dim && dim.w === Number(size) && dim.h === Number(size);
    add('Icons', 'fail', ok, `Icon ${size} px: ${file}`, f ? (dim ? `file is ${dim.w}x${dim.h}` : 'not a PNG') : 'file is missing');
    if (ok) sizes.add(Number(size));
  }
  add('Icons', 'fail', sizes.has(128), 'A 128 px icon exists (the store needs it)');
  add('Icons', 'warn', !!m.icons && !!m.icons['128'], 'The top-level "icons" key lists the 128 px icon');

  // Every file the manifest points at must be in the package.
  const refs = [];
  if (m.background && m.background.service_worker) refs.push(['background', m.background.service_worker]);
  if (m.side_panel && m.side_panel.default_path) refs.push(['side panel', m.side_panel.default_path]);
  for (const p of (m.sandbox && m.sandbox.pages) || []) refs.push(['sandbox page', p]);
  for (const cs of m.content_scripts || []) for (const j of cs.js || []) refs.push(['content script', j]);
  for (const war of m.web_accessible_resources || []) for (const r of war.resources || []) if (!r.includes('*')) refs.push(['web accessible', r]);
  const missing = refs.filter(([, p]) => !byName.has(p));
  add('Manifest', 'fail', missing.length === 0, `Every file the manifest names is in the package (${refs.length} checked)`, missing.map((x) => x.join(': ')).join(', '));

  // Files that the HTML pages load.
  const htmlMissing = [];
  for (const f of files.filter((x) => x.name.endsWith('.html'))) {
    const dir = path.posix.dirname(f.name);
    for (const mm of f.data.toString('utf8').matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      const ref = mm[1];
      if (/^(https?:|data:|chrome-extension:|\/\/|mailto:|javascript:)/i.test(ref)) continue;
      const full = path.posix.normalize(ref.startsWith('/') ? ref.slice(1) : path.posix.join(dir === '.' ? '' : dir, ref));
      if (!byName.has(full)) htmlMissing.push(`${f.name} -> ${ref}`);
    }
  }
  add('Manifest', 'fail', htmlMissing.length === 0, 'Every script, style and image an HTML page loads is in the package', htmlMissing.join(', '));

  // Permissions against reasons, and against what the code really calls.
  const reasons = JSON.parse(fs.readFileSync(reasonsPath, 'utf8'));
  const declared = new Set([...(m.permissions || []), ...(m.optional_permissions || [])]);
  add('Permissions', 'info', true, 'Permissions in the manifest', [...(m.permissions || [])].join(', ') || '(none)');
  add('Permissions', 'info', true, 'Optional permissions', (m.optional_permissions || []).join(', ') || '(none)');
  add('Permissions', 'info', true, 'Host permissions', (m.host_permissions || []).join(', ') || '(none)');
  for (const p of declared) add('Permissions', 'fail', !!(reasons.permissions || {})[p], `Reason written for "${p}"`, (reasons.permissions || {})[p] || 'add one to permission-reasons.json');
  for (const p of Object.keys(reasons.permissions || {})) if (!declared.has(p)) add('Permissions', 'warn', false, `Reason exists for "${p}" but the manifest does not declare it`);
  for (const h of m.host_permissions || []) {
    add('Permissions', 'fail', !!(reasons.host_permissions || {})[h], `Reason written for host access "${h}"`);
    if (/<all_urls>|^\*:\/\/\*\/\*$|^https?:\/\/\*\/\*$/.test(h)) add('Permissions', 'warn', false, `"${h}" can send the submission to a slower in-depth review`, 'Plan for a longer wait and keep the written reason specific.');
  }
  add('Permissions', 'fail', !declared.has('debugger'), '"debugger" is not requested (needs its own review and a clear reason)');

  const code = files.filter((f) => /\.(js|html)$/.test(f.name) && !VENDORED.has(f.name));
  const joined = code.map((f) => f.data.toString('utf8')).join('\n');
  const used = new Set([...joined.matchAll(/\bchrome\.([a-zA-Z]+)\b/g)].map((x) => x[1]));
  // Some code reaches an API through a variable, so look for the bare API name too.
  for (const api of Object.keys(NEEDS_PERMISSION)) if (new RegExp('\\.' + api + '\\b').test(joined)) used.add(api);
  const usedNoPerm = [...used].filter((u) => NEEDS_PERMISSION[u] && !declared.has(NEEDS_PERMISSION[u]));
  add('Permissions', 'fail', usedNoPerm.length === 0, 'No API is used without its permission', usedNoPerm.join(', '));
  const unusedPerm = [...declared].filter((p) => NEEDS_PERMISSION[p] && !used.has(p));
  add('Permissions', 'fail', unusedPerm.length === 0, 'No declared permission is unused in the code', unusedPerm.join(', '));
  if (declared.has('clipboardWrite')) add('Permissions', 'fail', /clipboard\.writeText|execCommand\(['"]copy/.test(joined), '"clipboardWrite" is used (copy code found)');
  if (declared.has('activeTab') && (m.host_permissions || []).some((h) => /<all_urls>/.test(h))) add('Permissions', 'info', true, '"activeTab" with all-sites access', 'It still matters when the user sets site access to "on click". Keep the reason specific.');

  // Content security policy and remote code.
  const csp = (m.content_security_policy || {}).extension_pages || '';
  add('Security', 'fail', /script-src[^;]*'self'/.test(csp) && !/script-src[^;]*'unsafe-(eval|inline)'/.test(csp) && !/script-src[^;]*https?:/.test(csp), 'Extension pages allow only their own scripts', csp);
  add('Security', 'info', /require-trusted-types-for/.test(csp), 'Trusted Types are enforced', '');
  const remote = [];
  for (const f of files.filter((x) => x.name.endsWith('.html'))) for (const mm of f.data.toString('utf8').matchAll(/<(script|link|iframe)\b[^>]*(?:src|href)="(https?:)?\/\/[^"]+"/gi)) remote.push(`${f.name}: ${mm[0].slice(0, 80)}`);
  for (const f of code.filter((x) => x.name.endsWith('.js'))) {
    const t = f.data.toString('utf8');
    if (/importScripts\(\s*['"`]https?:/.test(t) || /import\(\s*['"`]https?:/.test(t)) remote.push(`${f.name}: imports remote code`);
  }
  add('Security', 'fail', remote.length === 0, 'No remote script, style or frame is loaded', remote.slice(0, 4).join(' | '));
  const evalHits = code.filter((f) => f.name.endsWith('.js') && realCalls(f.data.toString('utf8'), /(^|[^.\w$])eval\s*\(|new\s+Function\s*\(/g)).map((f) => f.name);
  add('Security', 'warn', evalHits.length === 0, 'No eval() or new Function() calls in extension code (text inside quotes does not count)', evalHits.join(', ') + (evalHits.length ? ' (allowed only inside the sandbox page; check each)' : ''));

  // Web addresses written into the code.
  const hosts = new Map();
  for (const f of code) for (const mm of f.data.toString('utf8').matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,}|localhost)(?::\d+)?/gi)) {
    const h = mm[1].toLowerCase();
    if (!hosts.has(h)) hosts.set(h, new Set());
    hosts.get(h).add(f.name);
  }
  const unknown = [...hosts].filter(([h]) => !KNOWN_HOSTS.some((k) => h === k || h.endsWith('.' + k)));
  add('Privacy', 'warn', unknown.length === 0, 'Every web address in the code is on the known list', unknown.slice(0, 8).map(([h, set]) => `${h} (${[...set][0]})`).join(', '));
  add('Privacy', 'info', true, 'Hosts named in the code', [...hosts.keys()].sort().join(', '));
  return { checks, files, manifest: m };
}

module.exports = { audit, sha256 };
