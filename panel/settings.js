const CAPS = [
  [
    'A',
    'DOM tree, attributes, computed styles, box model, selectors/XPath, readable CSS rules',
    'Fully implemented',
  ],
  [
    'A',
    'HTML/CSS/data/ZIP export, screenshots (visible/element), accessibility & performance & security audits, local workspace',
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
registerTab('settings', 'Settings', async (v) => {
  setTimeout(async () => {
    const el = document.getElementById('perm-state');
    if (!el) return;
    try {
      const all = await chrome.permissions.contains({ origins: ['<all_urls>'] });
      el.textContent = all ? 'All-sites access: ENABLED' : 'All-sites access: off (default)';
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
          [
            'activeTab',
            'Temporary access to the tab you invoke DevForge on. Nothing else is touched.',
          ],
          ['scripting', 'Injects the inspector only when you use it. Never auto-injected.'],
          ['sidePanel', 'Shows the workbench.'],
          ['storage', 'Saves preferences and your network interception rules, locally.'],
          ['contextMenus', 'Adds "Inspect with DevForge" to the right-click menu.'],
          ['clipboardWrite', 'Copying code or prompts at your request.'],
          [
            'optional site access',
            'Asked per site, only when you export assets or read cross-origin stylesheets. You can revoke it in the extension details page.',
          ],
        ]
      )
    ),
    section(
      'Site access',
      h('div', { id: 'perm-state', class: 'sev-info' }, 'checking…'),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: async () => {
                try {
                  const ok = await chrome.permissions.request({ origins: ['<all_urls>'] });
                  toast(ok ? 'Access on all sites enabled' : 'Not granted');
                  show('settings');
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          'Allow on all sites (persistent)'
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                try {
                  await chrome.permissions.remove({ origins: ['<all_urls>'] });
                  toast('Revoked');
                  show('settings');
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          'Revoke'
        )
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Optional. Without it DevForge only works on a tab after you click its toolbar icon, and screenshots/asset downloads ask per site. Screenshots specifically require either that click or all-sites access (a Chrome rule).'
      )
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
