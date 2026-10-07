// Service worker. Deliberately small: it only opens the panel and forwards one shortcut.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('sidePanel behavior', e));
});
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'pick-element') {
    // sidePanel.open() needs a user gesture, which the keyboard command provides.
    try {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t) await chrome.sidePanel.open({ tabId: t.id });
    } catch (e) {
      console.warn(e);
    }
    setTimeout(
      () => chrome.runtime.sendMessage({ type: 'df:command', command: 'pick' }).catch(() => {}),
      400
    );
  }
});
