// Service worker. Deliberately small: opens the panel and hands keyboard / context-menu commands
// over to it. All real work happens in the panel and the injected page agent.

const MENU_INSPECT = 'devforge-inspect';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('DevForge: setPanelBehavior failed', e));
  // removeAll first so an update never trips over a duplicate id.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_INSPECT,
      title: 'Inspect with DevForge',
      contexts: ['all'],
    });
  });
});

/*
 * The panel may not be running yet when a command arrives (it is opened by the very same gesture),
 * so a plain runtime message would usually be lost. The command is parked in session storage, where
 * the panel picks it up on boot, and also broadcast for a panel that is already open.
 */
function handOver(command) {
  const pending = { command, at: Date.now() };
  chrome.storage.session.set({ pendingCommand: pending }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'df:command', command }).catch(() => {
    /* no panel listening yet: it will read pendingCommand when it starts */
  });
}

// sidePanel.open() must be called synchronously inside the user gesture. Awaiting anything first
// (even tabs.query) drops the gesture and Chrome rejects the call.
function openPanel(tab) {
  if (!tab || tab.id == null) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.warn('DevForge: open failed', e));
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'pick-element') return;
  openPanel(tab);
  handOver('pick');
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_INSPECT) return;
  openPanel(tab);
  handOver('inspect-context');
});
