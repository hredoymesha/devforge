// Startup: tab bar, theme, command palette, shortcuts and tab/page events.
function setTheme(t) {
  DF.state.settings.theme = t;
  document.documentElement.dataset.theme = t;
  chrome.storage.local.set({ settings: DF.state.settings });
}
const ORDER = [
  'inspect',
  'css',
  'export',
  'site',
  'recreate',
  'network',
  'audit',
  'data',
  'ai',
  'play',
  'auto',
  'work',
  'settings',
];
DF.tabs.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
const tabsEl = $('#tabs');
tabsEl.setAttribute('role', 'tablist');
DF.tabs.forEach((t) =>
  tabsEl.append(
    h(
      'button',
      { role: 'tab', 'data-id': t.id, 'aria-selected': 'false', on: { click: () => show(t.id) } },
      t.label
    )
  )
);
tabsEl.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const bs = [...tabsEl.children];
  const i = bs.findIndex((b) => b.getAttribute('aria-selected') === 'true');
  const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
  n.focus();
  n.click();
});

/* commands */
const pickNow = async () => {
  show('inspect');
  await startPick();
};
DF.tabs.forEach((t) => registerCommand('open-' + t.id, 'Open ' + t.label, () => show(t.id)));
registerCommand('pick', 'Inspect element (pick on page)', pickNow, 'Ctrl+Shift+U');
registerCommand('export-component', 'Export component', () => show('export'));
registerCommand('recreate', 'Recreate component', () => show('recreate'));
registerCommand('open-code', 'Open code (Playground)', () => show('play'));
registerCommand('open-css', 'Open CSS', () => show('css'));
registerCommand('open-network', 'Open network', () => show('network'));
registerCommand('create-ai', 'Create AI task', () => show('ai'));
registerCommand('run-workflow', 'Run workflow', () => show('auto'));
registerCommand('screenshot', 'Take screenshot (visible area)', async () => {
  show('export');
  setTimeout(() => shot('visible'), 100);
});
registerCommand('search', 'Search workspace', () => show('work'));
registerCommand('open-project', 'Open project', () => show('work'));
registerCommand('open-settings', 'Open settings', () => show('settings'));
registerCommand('theme', 'Toggle theme', () =>
  setTheme(DF.state.settings.theme === 'dark' ? 'light' : 'dark')
);
registerCommand('undo', 'Undo last page change', async () => {
  try {
    await call('undo');
    toast('Undone');
  } catch (e) {
    toast(e.message);
  }
});
registerCommand('redo', 'Redo page change', async () => {
  try {
    await call('redo');
    toast('Redone');
  } catch (e) {
    toast(e.message);
  }
});
registerCommand('reset', 'Reset all page changes', async () => {
  try {
    await call('resetAll');
    toast('Reset');
  } catch (e) {
    toast(e.message);
  }
});
registerCommand('report', 'Export developer report', async () => {
  try {
    download(
      'devforge-report-' + stamp() + '.md',
      await busy('Running audits', developerReport),
      'text/markdown'
    );
  } catch (e) {
    toast(e.message);
  }
});

/* palette */
const pal = $('#palette'),
  palIn = $('#pal-input'),
  palList = $('#pal-list');
let palSel = 0,
  palItems = [];
function renderPal() {
  const q = palIn.value.toLowerCase().split(/\s+/).filter(Boolean);
  palItems = DF.commands.filter((c) => q.every((w) => c.title.toLowerCase().includes(w)));
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  clear(palList).append(
    ...palItems.map((c, i) =>
      h(
        'li',
        { class: i === palSel ? 'on' : '', role: 'option', on: { click: () => runPal(c) } },
        h('span', null, c.title),
        h('span', { class: 'sev-info' }, DF.state.settings.shortcuts[c.id] || c.hint || '')
      )
    )
  );
}
function openPal() {
  pal.hidden = false;
  palIn.value = '';
  palSel = 0;
  renderPal();
  palIn.focus();
}
function closePal() {
  pal.hidden = true;
}
function runPal(c) {
  closePal();
  try {
    const r = c.run();
    if (r && r.catch) r.catch((e) => toast(e.message));
  } catch (e) {
    toast(e.message);
  }
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
});
pal.addEventListener('click', (e) => {
  if (e.target === pal) closePal();
});
$('#btn-palette').addEventListener('click', openPal);
$('#btn-pick').addEventListener('click', pickNow);
$('#btn-theme').addEventListener('click', () =>
  setTheme(DF.state.settings.theme === 'dark' ? 'light' : 'dark')
);

/* global in-panel shortcuts */
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
  for (const c of DF.commands) {
    const sc = DF.state.settings.shortcuts[c.id];
    if (sc && sc === combo) {
      e.preventDefault();
      return runPal(c);
    }
  }
});

/* messages from the page agent / background */
chrome.runtime.onMessage.addListener(async (m, sender) => {
  if (m.type === 'df:selected') {
    if (sender.tab && sender.tab.id !== DF.state.tabId) return;
    try {
      const d = await call('select', m.handle);
      DF.state.h = d.h;
      DF.state.info = d;
      status('Selected ' + d.selectors[0].selector, 'ok');
      show('inspect');
    } catch (e) {
      status(e.message, 'err');
    }
  } else if (m.type === 'df:pick-cancelled') status('Picking cancelled');
  else if (m.type === 'df:command' && m.command === 'pick') pickNow();
});

/* tab/page changes invalidate selection */
function resetSelection(why) {
  DF.state.h = null;
  DF.state.info = null;
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
chrome.tabs.onActivated.addListener(async () => {
  resetSelection();
  try {
    await activeTab();
    await restoreSelection();
  } catch (_) {}
  if (['inspect', 'css', 'export', 'recreate'].includes(DF.state.tab)) show(DF.state.tab);
});
chrome.tabs.onUpdated.addListener((id, ch) => {
  if (id === DF.state.tabId && ch.status === 'loading') {
    resetSelection(
      'Page navigated - selection cleared. Overrides and capture were reset by the reload.'
    );
  }
  if (id === DF.state.tabId && ch.status === 'complete' && DF.state.tab === 'inspect')
    show('inspect');
});

(async () => {
  try {
    const r = await chrome.storage.local.get('settings');
    if (r.settings) Object.assign(DF.state.settings, r.settings);
  } catch (_) {}
  document.documentElement.dataset.theme = DF.state.settings.theme;
  try {
    await activeTab();
  } catch (e) {
    status(e.message, 'err');
  }
  show('inspect');
})();
