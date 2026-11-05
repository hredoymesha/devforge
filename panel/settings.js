const CAPS = [
  [
    'A',
    'DOM tree, attributes, computed styles, box model, selectors/XPath, readable CSS rules',
    'Fully implemented',
  ],
  [
    'A',
    'HTML/CSS/data/ZIP export, screenshots (visible/element), accessibility & performance audits, passive security checks and report, local workspace',
    'Fully implemented',
  ],
  [
    'B',
    'Cross-origin stylesheets and assets',
    'Needs per-site permission you grant; CORS-blocked otherwise',
  ],
  [
    'B',
    'Blocking, mocking, delaying and redirecting requests',
    'fetch/XHR/beacon made by page scripts, while capture is on (Network → Interception rules)',
  ],
  [
    'B',
    'Network bodies/headers',
    'fetch/XHR/WebSocket only after you enable capture; earlier & browser-initiated requests are timing-only',
  ],
  ['B', 'iframes / Shadow DOM', 'Same-origin iframes and open shadow roots only'],
  [
    'C',
    'Real :hover/:focus forcing, console capture, full source maps, blocking browser-initiated loads (img/CSS/script)',
    'Requires the debugger permission, which DevForge deliberately does not request; emulation or paste-in provided',
  ],
  ['C', 'Reading AI replies automatically', 'No API or scraping; you paste the reply'],
  [
    'D',
    'Server-side PHP/SQL, private APIs/credentials, original unminified source without source maps, addEventListener enumeration, closed shadow roots, cross-origin iframe content',
    'Not possible; reported as unavailable, never fabricated',
  ],
];

// A number box bound to a setting, clamped on change.
function numberSetting(id, key, min, max, fallback, label) {
  const s = DF.state.settings;
  const input = h('input', {
    type: 'number',
    id,
    min,
    max,
    'aria-label': label,
    value: s[key] != null ? s[key] : fallback,
    on: {
      change: (e) => {
        const n = Math.min(max, Math.max(min, Math.round(+e.target.value) || fallback));
        e.target.value = n;
        s[key] = n;
        saveSettings();
      },
    },
  });
  return input;
}

function siteAccessSection(s) {
  const listBox = h('div');
  const drawList = () => {
    clear(listBox);
    if (s.allowAllSites !== false) return;
    const list = s.siteAllowlist || [];
    listBox.append(
      h('div', { class: 'sev-info' }, list.length ? 'DevForge may run only on these sites:' : 'No sites are allowed yet, so DevForge will refuse every page.'),
      table(
        ['Site', ''],
        list.map((o) => [mono(o), h('button', { 'aria-label': 'Remove ' + o, on: { click: () => { s.siteAllowlist = list.filter((x) => x !== o); saveSettings(); drawList(); } } }, 'Remove')])
      ),
      (() => {
        const input = h('input', { type: 'text', placeholder: 'https://example.com', 'aria-label': 'Site to allow', class: 'grow' });
        const add = (raw) => {
          let origin;
          try {
            origin = new URL(raw).origin;
            if (!/^https?:|^file:/.test(origin) && !/^https?:|^file:/.test(raw)) throw new Error();
          } catch (_) {
            return toast('That is not a web address, for example https://example.com');
          }
          s.siteAllowlist = [...new Set([...(s.siteAllowlist || []), origin])];
          saveSettings();
          drawList();
        };
        return h(
          'div',
          { class: 'row' },
          input,
          h('button', { on: { click: () => add(input.value.trim()) } }, 'Allow site'),
          h('button', { on: { click: async () => { const t = await activeTab(); add(t.url); } } }, 'Allow the current site')
        );
      })()
    );
  };
  const box = section(
    'Site access',
    h(
      'label',
      { class: 'sec-ack', for: 'set-allsites' },
      h('input', {
        type: 'checkbox',
        id: 'set-allsites',
        checked: s.allowAllSites !== false,
        on: { change: (e) => { s.allowAllSites = e.target.checked; saveSettings(); drawList(); } },
      }),
      ' Allow DevForge on all sites'
    ),
    h('div', { class: 'sev-info' }, 'On by default. Switch it off to make DevForge work only on the sites you list. This is a DevForge setting; Chrome also has its own control for it.'),
    listBox,
    h('div', { id: 'perm-state', class: 'sev-info' }, 'checking…'),
    h(
      'div',
      { class: 'row' },
      h('button', { on: { click: () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }) } }, 'Open Chrome site-access settings')
    ),
    h('div', { class: 'sev-info' }, 'Screenshots need either a click on the toolbar icon for that tab or all-sites access (a Chrome rule). File URLs also need "Allow access to file URLs" in Chrome.')
  );
  drawList();
  return box;
}

function housekeepingSection(s) {
  const out = h('div', { class: 'sev-info' }, 'Reading…');
  const fmt = (n) => fmtBytes(n);
  const draw = async () => {
    try {
      const u = await DFKeep.usage();
      clear(out).append(
        kv({
          'Settings, history, rules': fmt(u.localBytes),
          'Session state (temporary)': fmt(u.sessionBytes) + ' in ' + u.sessionKeys + ' key(s)',
          'Workspace items': u.itemCount + ' (' + fmt(u.itemBytes) + ')',
          'Automatically saved scans': String(u.autoSavedScans),
          'Performance history': u.perfPoints + ' measurement(s) on ' + u.perfPages + ' page(s)',
          'Acknowledged findings': String(u.acknowledgements),
        })
      );
    } catch (e) {
      clear(out).append('Could not read storage: ' + e.message);
    }
  };
  const act = (label, fn, danger) =>
    h('button', { class: danger ? 'danger' : '', on: { click: async () => { toast(await fn()); draw(); } } }, label);
  const sel = h(
    'select',
    { id: 'set-cleanup', 'aria-label': 'Automatic clean-up of temporary data', on: { change: (e) => { s.tempCleanup = e.target.value; saveSettings(); } } },
    [['close', 'Each time the panel opens'], ['daily', 'Once a day (also trims history older than 90 days)'], ['off', 'Never (only when I press a button)']].map(([v, t]) => h('option', { value: v, selected: (s.tempCleanup || 'close') === v }, t))
  );
  draw();
  return section(
    'Temporary data and clean-up',
    h('div', { class: 'sev-info' }, 'What DevForge keeps in this browser. Nothing is sent anywhere.'),
    out,
    h('div', { class: 'row' }, h('label', null, 'Clean up temporary data automatically: ', sel)),
    h(
      'div',
      { class: 'row' },
      act('Clear temporary data now', async () => { const r = await DFKeep.cleanTemporary(); return 'Cleared ' + r.sessionKeys + ' session item(s)' + (r.captureCleared ? ' and the capture log' : ''); }),
      act('Clear performance history', async () => 'Removed ' + (await DFKeep.clearPerfHistory()) + ' measurement(s)'),
      act('Delete automatically saved scans', async () => { if (!confirm('Delete every automatically saved scan report? Reports you saved yourself stay.')) return 'Cancelled'; return 'Deleted ' + (await DFKeep.deleteAutoSaved()) + ' report(s)'; }, true),
      act('Forget acknowledged findings', async () => { if (!confirm('Forget every acknowledgement you recorded in the Security tab?')) return 'Cancelled'; await DFKeep.clearAcknowledgements(); return 'Acknowledgements cleared'; }, true)
    ),
    h('div', { class: 'sev-info' }, 'Temporary data means the session state, the in-page capture log and old automatic history. Your Workspace items, Owner vault and settings are never touched by the automatic clean-up.')
  );
}


// Runs in the page's own world, the way any page script could, and reports what it can see of DevForge.
function footprintProbe() {
  const rows = [];
  const add = (name, ok, detail) => rows.push({ name, ok, detail: detail || '' });
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  document.documentElement.appendChild(frame);
  const clean = new Set(Object.getOwnPropertyNames(frame.contentWindow));
  frame.remove();
  const extra = Object.getOwnPropertyNames(window).filter((k) => !clean.has(k));
  const nameLike = extra.filter((k) => /devforge|__df|^df[A-Z_]/i.test(k));
  add('No window global carries a DevForge name', nameLike.length === 0, nameLike.join(', '));
  const hidden = extra.filter((k) => /^_[0-9a-f]{20}$/.test(k));
  add('Capture channel (only while capture is on): one unlabelled entry point', true, hidden.length ? hidden.length + ' hidden entry point(s), not enumerable, unusable without a 256-bit key' : 'capture is not running on this page');
  const marked = [...document.querySelectorAll('[id^="__df_"],[data-devforge],[class*="devforge"]')];
  add('No visible DevForge elements in the page', marked.length === 0, marked.length ? marked.length + ' element(s), normally only while picking or highlighting' : '');
  const native = (fn) => {
    try {
      return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
    } catch (_) {
      return false;
    }
  };
  const fns = { fetch: window.fetch, 'XMLHttpRequest.open': XMLHttpRequest.prototype.open, 'XMLHttpRequest.send': XMLHttpRequest.prototype.send, WebSocket: window.WebSocket, 'sendBeacon': Navigator.prototype.sendBeacon };
  const notNative = Object.entries(fns).filter(([, f]) => typeof f === 'function' && !native(f)).map(([k]) => k);
  add('Patched browser functions still report as native code', notNative.length === 0, notNative.join(', '));
  const xhr = new XMLHttpRequest();
  xhr.open('GET', location.href);
  xhr.abort();
  add('XMLHttpRequest objects carry no extra properties', Object.getOwnPropertyNames(xhr).length === 0, Object.getOwnPropertyNames(xhr).join(', '));
  add('navigator carries no extra properties', Object.getOwnPropertyNames(navigator).length === 0, Object.getOwnPropertyNames(navigator).join(', '));
  const syms = Object.getOwnPropertySymbols(XMLHttpRequest.prototype).length;
  add('Symbols on XMLHttpRequest.prototype', syms === 0, syms ? syms + ' (the capture marker, unlabelled; it stops a second install from wrapping twice)' : 'none');
  return rows;
}

registerTab('settings', 'Settings', async (v) => {
  setTimeout(async () => {
    const el = document.getElementById('perm-state');
    if (!el) return;
    try {
      const all = await chrome.permissions.contains({ origins: ['<all_urls>'] });
      el.textContent = all
        ? 'Chrome currently lets DevForge reach all sites.'
        : 'Chrome currently limits DevForge to the sites you chose in chrome://extensions (Site access). DevForge will ask for access per site when needed.';
    } catch (e) {
      el.textContent = e.message;
    }
  }, 0);
  const s = DF.state.settings;
  v.append(
    section(
      'Appearance',
      h(
        'div',
        { class: 'row' },
        h(
          'select',
          { 'aria-label': 'Theme', on: { change: (e) => setTheme(e.target.value) } },
          THEMES.map((t) =>
            h('option', { value: t, selected: s.theme === t }, t === 'system' ? 'match system' : t)
          )
        )
      )
    ),
    section(
      'Stored data',
      h('div', { class: 'sev-info' }, 'DevForge checks what it saved in this browser (settings, interception rules, performance history, Workspace) before it uses it. Anything that is not valid is ignored and listed here.'),
      DF.state.stored.ignored.length
        ? h('ul', { id: 'stored-ignored' }, ...DF.state.stored.ignored.map((t) => h('li', null, t)))
        : h('div', { id: 'stored-ok', class: 'sev-ok' }, 'Nothing was ignored.')
    ),
    section(
      'In-panel shortcuts',
      h(
        'div',
        { class: 'sev-info' },
        'Click a box and press a key combination. Browser-level shortcuts (open panel, pick) are changed at chrome://extensions/shortcuts.'
      ),
      table(
        ['Action', 'Shortcut'],
        DF.commands.map((c) => [
          c.title,
          h('input', {
            value: s.shortcuts[c.id] || '',
            placeholder: c.hint ? c.hint + ' (browser)' : 'press keys…',
            readonly: true,
            'aria-label': 'Shortcut for ' + c.title,
            on: {
              keydown: (e) => {
                // Tab must keep moving focus, or keyboard users get stuck in this table.
                if (e.key === 'Tab') return;
                e.preventDefault();
                if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
                const combo = [
                  e.ctrlKey || e.metaKey ? 'Ctrl' : '',
                  e.altKey ? 'Alt' : '',
                  e.shiftKey ? 'Shift' : '',
                  e.key.length === 1 ? e.key.toUpperCase() : e.key,
                ]
                  .filter(Boolean)
                  .join('+');
                if (e.key === 'Escape' || e.key === 'Backspace') {
                  delete s.shortcuts[c.id];
                  e.target.value = '';
                } else {
                  s.shortcuts[c.id] = combo;
                  e.target.value = combo;
                }
                saveSettings();
              },
            },
          }),
        ])
      )
    ),
    section(
      'Permissions - why each exists',
      table(
        ['Permission', 'Why'],
        [
          ['activeTab', 'Temporary access to the tab you invoke DevForge on.'],
          ['all sites (host access)', 'Required so DevForge works on any page without a prompt per site. Settings → Site access below can still limit it to sites you choose.'],
          ['scripting', 'Injects the inspector into a page only when you use it.'],
          ['sidePanel', 'Shows the workbench.'],
          ['storage', 'Saves preferences, interception rules, scan acknowledgements and performance history, locally.'],
          ['contextMenus', 'Adds "Inspect with DevForge" to the right-click menu.'],
          ['clipboardWrite', 'Copying code or prompts at your request.'],
          ['declarativeNetRequest', 'Blocks redirect hops to private addresses when "follow redirects" is on.'],
          ['cookies (optional)', 'Only if you allow exact cookie-flag checks in the Security tab.'],
          ['debugger (not requested)', 'Deliberately absent: it would show Chrome\'s debugging bar and nothing here needs it.'],
        ]
      )
    ),
    siteAccessSection(s),
    section(
      'Scan history',
      h(
        'label',
        { class: 'sec-ack', for: 'set-autosave' },
        h('input', {
          type: 'checkbox',
          id: 'set-autosave',
          checked: s.autoSaveScans !== false,
          on: { change: (e) => { s.autoSaveScans = e.target.checked; saveSettings(); } },
        }),
        ' Save each finished security scan to the Workspace automatically'
      ),
      h('div', { class: 'row' }, h('label', null, 'Keep the newest ', numberSetting('set-retention', 'scanRetention', 1, 200, 20, 'Automatically saved scans to keep per site'), ' per site')),
      h('div', { class: 'sev-info' }, 'This is what makes the "compared with the last scan" message appear. Reports you save yourself are never removed. Reports contain no cookie values, tokens or credentials.')
    ),
    section(
      'Network capture size',
      h('div', { class: 'row' },
        h('label', null, 'Requests kept ', numberSetting('set-cap-entries', 'captureEntries', 100, 5000, 1000, 'Requests kept in the capture log')),
        h('label', null, 'Largest body kept (KB) ', numberSetting('set-cap-body', 'captureBodyKB', 10, 2048, 200, 'Largest response body kept, in kilobytes')),
        h('label', null, 'Total bodies (MB) ', numberSetting('set-cap-total', 'captureTotalMB', 2, 64, 16, 'Memory budget for all captured bodies, in megabytes'))
      ),
      h('div', { class: 'sev-info' }, 'Applied when capture starts or the page reloads. Older bodies are evicted first when the total is reached; the request rows themselves are kept. Larger values use more of the page\'s memory.')
    ),
    housekeepingSection(s),
    section(
      'Saving files',
      h(
        'label',
        { class: 'sec-ack', for: 'set-redirects' },
        h('input', {
          type: 'checkbox',
          id: 'set-redirects',
          checked: s.followRedirects === true,
          on: {
            change: (e) => {
              s.followRedirects = e.target.checked;
              saveSettings();
            },
          },
        }),
        ' Follow redirects when saving files (exports, stylesheets, site snapshot)'
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Off by default: redirected files are listed as "not followed" and nothing is requested from their targets. With it on, DevForge installs a browser-level rule that blocks any hop of a redirect chain that leads to a private, loopback or link-local address (unless your page is itself on that host), so the request is never sent. It cannot tell when a public-looking name resolves to a private address (DNS rebinding); redirects are refused if the rule cannot be installed.'
      )
    ),
    section(
      'What websites can see of DevForge',
      h('div', { class: 'sev-info' }, 'DevForge keeps its work out of the pages it inspects: the page agent runs in an isolated world that page scripts cannot read, results stay in this panel, and nothing is written to the site\'s storage. The network capture is the one part that must run inside the page, so it hides its state and its wrappers behave like the originals. A determined page can still notice some effects (timing, extra work on its requests); this is reduction, not invisibility.'),
      (() => {
        const out = h('div');
        return h(
          'div',
          null,
          h('div', { class: 'row' }, h('button', { id: 'set-footprint', on: { click: async () => {
            clear(out).append(loading('Probing the page the way a page script would'));
            const rows = await exec(footprintProbe, [], 'MAIN');
            clear(out).append(table(['What a page script can look for', 'Result', 'Detail'], rows.map((r) => [r.name, h('span', { class: r.ok ? 'sev-ok' : 'sev-warn' }, r.ok ? 'OK' : 'Visible'), h('span', { class: 'sev-info' }, r.detail)]), { class: 'compact' }));
          } } }, 'Check this page for DevForge traces')),
          out
        );
      })()
    ),
    section(
      'Privacy',
      h(
        'div',
        null,
        "Everything runs locally. DevForge makes no network requests of its own except those you trigger: asset downloads for an export (from the page's own sites), and opening an AI website with a prompt you chose to send. No analytics, no accounts, no API keys, no servers."
      )
    ),
    section(
      'Capability matrix (what is and is not possible)',
      h(
        'div',
        { class: 'sev-info' },
        'A = fully possible · B = possible with restrictions · C = only in some contexts · D = impossible in a browser extension'
      ),
      table(
        ['Class', 'Capability', 'Reality'],
        CAPS.map((c) => [c[0], c[1], c[2]])
      )
    ),
    section(
      'Provenance labels',
      h(
        'div',
        { class: 'row' },
        ['observed', 'extracted', 'inferred', 'generated', 'reconstructed', 'unavailable'].map(
          tagEl
        )
      ),
      h(
        'div',
        { class: 'sev-info' },
        'observed = read directly · extracted = copied from DOM/CSS · inferred = heuristic · generated = produced by DevForge/AI · reconstructed = rebuilt from partial info · unavailable = the browser does not expose it.'
      )
    )
  );
});
