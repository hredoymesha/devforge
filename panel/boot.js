// Startup: tab bar (with overflow menu), theme, command palette, shortcuts and tab/page events.
const THEMES = ['system', 'dark', 'light'];
const systemDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = DF.state.settings.theme;
  const effective = t === 'system' ? (systemDark.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = effective;
  const b = $('#btn-theme');
  b.textContent = t === 'system' ? '◐' : t === 'dark' ? '☾' : '☀';
  b.title = 'Theme: ' + t + ' (click to change)';
}
function setTheme(t) {
  DF.state.settings.theme = THEMES.includes(t) ? t : 'system';
  applyTheme();
  saveSettings();
}
systemDark.addEventListener('change', applyTheme);

const ORDER = [
  'inspect',
  'css',
  'network',
  'perf',
  'mutations',
  'storage',
  'tokens',
  'export',
  'site',
  'recreate',
  'audit',
  'data',
  'ai',
  'play',
  'auto',
  'work',
  'settings',
];
DF.tabs.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

/* ---------- tab bar ---------- */
const tabsEl = $('#tabs'),
  moreBtn = $('#tabs-more'),
  moreMenu = $('#tabs-menu');
DF.tabs.forEach((t) =>
  tabsEl.append(
    h(
      'button',
      {
        role: 'tab',
        id: 'tab-' + t.id,
        'data-id': t.id,
        'aria-selected': 'false',
        'aria-controls': 'view',
        tabindex: -1,
        on: { click: () => show(t.id) },
      },
      t.label
    )
  )
);
// Widths are measured once while every tab is visible; labels never change afterwards.
let tabWidths = null;
function layoutTabs() {
  const buttons = [...tabsEl.children];
  if (!tabWidths) {
    buttons.forEach((b) => (b.hidden = false));
    tabWidths = new Map(buttons.map((b) => [b, b.offsetWidth]));
    if (![...tabWidths.values()].some(Boolean)) {
      tabWidths = null; // panel not laid out yet
      return;
    }
  }
  const avail = tabsEl.parentElement.clientWidth - 36; // room for the » button
  const total = [...tabWidths.values()].reduce((a, b) => a + b, 0);
  const overflow = [];
  if (total > avail + 36) {
    const active = buttons.find((b) => b.dataset.id === DF.state.tab) || buttons[0];
    let used = tabWidths.get(active);
    let full = false;
    for (const b of buttons) {
      if (b === active) continue;
      if (!full && used + tabWidths.get(b) <= avail) used += tabWidths.get(b);
      else {
        full = true;
        overflow.push(b);
      }
    }
  }
  buttons.forEach((b) => (b.hidden = overflow.includes(b)));
  moreBtn.hidden = !overflow.length;
  clear(moreMenu).append(
    ...overflow.map((b) =>
      h(
        'li',
        { role: 'none' },
        h(
          'button',
          {
            role: 'menuitem',
            on: {
              click: () => {
                closeMenu();
                show(b.dataset.id);
              },
            },
          },
          b.textContent
        )
      )
    )
  );
}
function closeMenu() {
  moreMenu.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
}
moreBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = moreMenu.hidden;
  moreMenu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    const first = moreMenu.querySelector('button');
    if (first) first.focus();
  }
});
moreMenu.addEventListener('keydown', (e) => {
  const items = [...moreMenu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
  else if (e.key === 'Escape') {
    closeMenu();
    moreBtn.focus();
  } else return;
  e.preventDefault();
});
document.addEventListener('click', (e) => {
  if (!moreMenu.hidden && !moreMenu.contains(e.target)) closeMenu();
});
new ResizeObserver(() => layoutTabs()).observe(tabsEl.parentElement);
// show() changes the active tab, which may have to be swapped into the visible part of the bar.
const baseShow = show;
show = function (id) {
  baseShow(id);
  layoutTabs();
};
tabsEl.addEventListener('keydown', (e) => {
  const bs = [...tabsEl.children].filter((b) => !b.hidden);
  const i = bs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  let n = null;
  if (e.key === 'ArrowRight') n = bs[(i + 1) % bs.length];
  else if (e.key === 'ArrowLeft') n = bs[(i - 1 + bs.length) % bs.length];
  else if (e.key === 'Home') n = bs[0];
  else if (e.key === 'End') n = bs[bs.length - 1];
  if (!n) return;
  e.preventDefault();
  n.click();
  const again = [...tabsEl.children].find((b) => b.dataset.id === n.dataset.id);
  if (again && !again.hidden) again.focus();
});

/* ---------- commands ---------- */
const pickNow = async () => {
  show('inspect');
  await startPick();
};
// Context-menu entry: select the right-clicked element if the agent saw it, else start picking.
async function inspectContextTarget() {
  const d = await call('takeContextTarget');
  if (!d) {
    await pickNow();
    status('Click the element you want to inspect. Esc cancels.');
    return;
  }
  DF.state.h = d.h;
  DF.state.info = d;
  show('inspect');
  status('Selected ' + d.selectors[0].selector, 'ok');
}
DF.tabs.forEach((t) => registerCommand('open-' + t.id, 'Open ' + t.label, () => show(t.id)));
registerCommand('pick', 'Inspect element (pick on page)', pickNow, 'Ctrl+Shift+U');
registerCommand('export-component', 'Export component', () => show('export'));
registerCommand('recreate', 'Recreate component', () => show('recreate'));
registerCommand('open-code', 'Open code (Playground)', () => show('play'));
registerCommand('capture-network', 'Start network capture', async () => {
  show('network');
  await startCapture();
  toast('Network capture on');
});
registerCommand('profile-frames', 'Profile frame rate (5 s)', () => {
  DF.state.perfAutoProfile = true;
  show('perf');
});
registerCommand('track-mutations', 'Track DOM mutations', () => {
  DF.state.mutAutoStart = true;
  show('mutations');
});
registerCommand('xray', 'Toggle layout X-ray', async () => {
  const on = !DF.state.xray;
  const r = await call('xray', on);
  DF.state.xray = r.on;
  toast(r.on ? 'Layout X-ray on' : 'Layout X-ray off');
});
registerCommand('create-ai', 'Create AI task', () => show('ai'));
registerCommand('run-workflow', 'Run workflow', () => show('auto'));
registerCommand('screenshot', 'Take screenshot (visible area)', async () => {
  show('export');
  await sleep(50);
  await shot('visible');
});
registerCommand('search', 'Search workspace', () => show('work'));
registerCommand('theme', 'Cycle theme (system / dark / light)', () =>
  setTheme(THEMES[(THEMES.indexOf(DF.state.settings.theme) + 1) % THEMES.length])
);
registerCommand('undo', 'Undo last page change', async () => {
  await call('undo');
  toast('Undone');
});
registerCommand('redo', 'Redo page change', async () => {
  await call('redo');
  toast('Redone');
});
registerCommand('reset', 'Reset all page changes', async () => {
  await call('resetAll');
  toast('All page changes reverted');
});
registerCommand('report', 'Export developer report', async () => {
  download(
    'devforge-report-' + stamp() + '.md',
    await busy('Running audits', developerReport),
    'text/markdown'
  );
});

/* ---------- palette ---------- */
const pal = $('#palette'),
  palIn = $('#pal-input'),
  palList = $('#pal-list');
let palSel = 0,
  palItems = [],
  palReturn = null;
function renderPal() {
  const q = palIn.value.toLowerCase().split(/\s+/).filter(Boolean);
  palItems = DF.commands.filter((c) => q.every((w) => c.title.toLowerCase().includes(w)));
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  clear(palList).append(
    ...palItems.map((c, i) =>
      h(
        'li',
        {
          id: 'pal-' + i,
          class: i === palSel ? 'on' : '',
          role: 'option',
          'aria-selected': String(i === palSel),
          on: { click: () => runPal(c) },
        },
        h('span', null, c.title),
        h('kbd', null, DF.state.settings.shortcuts[c.id] || c.hint || '')
      )
    ),
    palItems.length ? '' : h('li', { class: 'none' }, 'No matching command')
  );
  palIn.setAttribute('aria-activedescendant', palItems.length ? 'pal-' + palSel : '');
  const on = palList.querySelector('li.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function openPal() {
  palReturn = document.activeElement;
  pal.hidden = false;
  palIn.value = '';
  palSel = 0;
  renderPal();
  palIn.focus();
}
function closePal() {
  pal.hidden = true;
  if (palReturn && palReturn.focus) palReturn.focus();
}
function runPal(c) {
  closePal();
  guard(c.run)();
}
palIn.addEventListener('input', () => {
  palSel = 0;
  renderPal();
});
palIn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    palSel = Math.min(palItems.length - 1, palSel + 1);
    renderPal();
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    palSel = Math.max(0, palSel - 1);
    renderPal();
    e.preventDefault();
  } else if (e.key === 'Enter' && palItems[palSel]) runPal(palItems[palSel]);
  else if (e.key === 'Escape') closePal();
  else if (e.key === 'Tab') e.preventDefault(); // keep focus inside the dialog
});
pal.addEventListener('click', (e) => {
  if (e.target === pal) closePal();
});
$('#btn-palette').addEventListener('click', openPal);
$('#btn-pick').addEventListener('click', guard(pickNow));
$('#btn-theme').addEventListener('click', () =>
  setTheme(THEMES[(THEMES.indexOf(DF.state.settings.theme) + 1) % THEMES.length])
);
$('#status-close').addEventListener('click', () => status(''));

/* ---------- global in-panel shortcuts ---------- */
const comboOf = (e) =>
  [
    e.ctrlKey || e.metaKey ? 'Ctrl' : '',
    e.altKey ? 'Alt' : '',
    e.shiftKey ? 'Shift' : '',
    e.key.length === 1 ? e.key.toUpperCase() : e.key,
  ]
    .filter(Boolean)
    .join('+');
document.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input[readonly]')) return;
  const combo = comboOf(e);
  if (combo === 'Ctrl+K') {
    e.preventDefault();
    return pal.hidden ? openPal() : closePal();
  }
  // Single keys must not fire while the user is typing.
  if (!/^(Ctrl|Alt)\+/.test(combo) && e.target.closest && e.target.closest('input,textarea,select'))
    return;
  for (const c of DF.commands) {
    const sc = DF.state.settings.shortcuts[c.id];
    if (sc && sc === combo) {
      e.preventDefault();
      return runPal(c);
    }
  }
});

/* ---------- messages from the page agent / background ---------- */
function runCommand(command) {
  chrome.storage.session.remove('pendingCommand').catch(() => {});
  if (command === 'pick') guard(pickNow)();
  else if (command === 'inspect-context') guard(inspectContextTarget)();
}
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m.type === 'df:selected') {
    if (sender.tab && sender.tab.id !== DF.state.tabId) return;
    call('select', m.handle)
      .then((d) => {
        DF.state.h = d.h;
        DF.state.info = d;
        status('Selected ' + d.selectors[0].selector, 'ok');
        show('inspect');
      })
      .catch((e) => status(e.message, 'err'));
  } else if (m.type === 'df:pick-cancelled') status('Picking cancelled');
  else if (m.type === 'df:command') runCommand(m.command);
});

/* ---------- tab/page changes invalidate selection ---------- */
function resetSelection(why) {
  DF.state.h = null;
  DF.state.info = null;
  DF.state.xray = false;
  treeSel = null;
  if (why) status(why);
}
async function restoreSelection() {
  // Only asks an agent that is already running; never injects into tabs we haven't used.
  try {
    const hnd = await exec(() =>
      window.__DF && window.__DF.selectedHandle ? window.__DF.selectedHandle() : null
    );
    if (hnd) {
      const d = await call('select', hnd);
      DF.state.h = d.h;
      DF.state.info = d;
    }
  } catch (_) {
    /* restricted page or no access: nothing to restore */
  }
}
const SELECTION_TABS = ['inspect', 'css', 'export', 'recreate'];
chrome.tabs.onActivated.addListener(async () => {
  resetSelection();
  try {
    await activeTab();
    await restoreSelection();
  } catch (_) {}
  if (SELECTION_TABS.includes(DF.state.tab) || DF.tabs.find((t) => t.id === DF.state.tab).perTab)
    show(DF.state.tab);
});
chrome.tabs.onUpdated.addListener((id, ch) => {
  if (id !== DF.state.tabId) return;
  if (ch.status === 'loading') {
    agentReady.delete(id);
    resetSelection(
      'Page navigated: selection cleared. Live edits and capture were reset by the reload.'
    );
  }
  if (ch.title) $('#target').textContent = ch.title.slice(0, 80);
  if (ch.status === 'complete' && DF.state.tab === 'inspect') show('inspect');
});

(async () => {
  try {
    const r = await chrome.storage.local.get('settings');
    if (r.settings) Object.assign(DF.state.settings, r.settings);
  } catch (_) {}
  applyTheme();
  try {
    await activeTab();
  } catch (e) {
    status(e.message, 'err');
  }
  const start = DF.tabs.some((t) => t.id === DF.state.settings.lastTab)
    ? DF.state.settings.lastTab
    : 'inspect';
  show(start);
  // A shortcut or context-menu click may have opened the panel just now.
  try {
    const { pendingCommand: p } = await chrome.storage.session.get('pendingCommand');
    if (p && Date.now() - p.at < 10000) runCommand(p.command);
  } catch (_) {}
})();
