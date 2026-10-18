// Housekeeping: what DevForge keeps in this browser, how much, and clean-up of temporary data.
// Nothing here talks to the network. "Temporary" means data that is safe to lose: session state,
// the in-page capture log, old automatically saved scan reports and performance history.
const DFKeep = (() => {
  const PERF_KEY = 'perfHistory';
  const DAY = 86400000;
  // Opaque storage keys for per-site data (performance history, acknowledgements): a salted hash of
  // the address, so the sites someone has worked on are not readable in plain text at rest.
  // This is obfuscation of names, not encryption; Owner mode is the protection for content.
  let salt = '';
  async function initSalt() {
    const got = (await chrome.storage.local.get('installSalt')).installSalt;
    if (typeof got === 'string' && got.length >= 16) {
      salt = got;
      return;
    }
    salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ installSalt: salt });
  }
  const keyFor = (s) => 'k' + DFHash.sha256(salt + '|' + s).slice(0, 24);
  const size = (v) => {
    try {
      return new TextEncoder().encode(JSON.stringify(v)).length;
    } catch (_) {
      return 0;
    }
  };

  async function usage() {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null).catch(() => ({}));
    const raw = await DFStore.rawItems().catch(() => []);
    const byKind = {};
    let auto = 0;
    for (const r of raw) {
      const k = r.sealed ? 'sealed' : r.kind || 'other';
      byKind[k] = byKind[k] || { count: 0, bytes: 0 };
      byKind[k].count++;
      byKind[k].bytes += size(r);
      if (r.auto === true) auto++;
    }
    const perf = local[PERF_KEY] || {};
    return {
      localBytes: size(local),
      sessionBytes: size(session),
      sessionKeys: Object.keys(session).length,
      items: byKind,
      itemCount: raw.length,
      itemBytes: Object.values(byKind).reduce((s, x) => s + x.bytes, 0),
      autoSavedScans: auto,
      perfPages: Object.keys(perf).length,
      perfPoints: Object.values(perf).reduce((s, a) => s + a.length, 0),
      acknowledgements: Object.values(local.secFindingAcks || {}).reduce((s, m) => s + Object.keys(m).length, 0),
    };
  }

  // Session state (scan confirmations, parked commands, capture keys) and the capture log of the open tab.
  async function cleanTemporary() {
    // Only keys that are safe to lose. The capture channel keys (netCaptureKeys) stay: removing
    // them would cut off a capture that is still running in the open tab.
    const drop = ['pendingCommand', 'secAcknowledged', 'secOwnerGranted'];
    const before = await chrome.storage.session.get(drop).catch(() => ({}));
    await chrome.storage.session.remove(drop).catch(() => {});
    let capture = false;
    try {
      if (typeof netCall === 'function' && (await netCall('ping')) === 'pong') {
        await netCall('clear');
        if (typeof net !== 'undefined') {
          net.rows.clear();
          net.rev = 0;
        }
        capture = true;
      }
    } catch (_) {
      /* no capture on this page, or no access to it: nothing to clear there */
    }
    return { sessionKeys: Object.keys(before).length, captureCleared: capture };
  }

  async function deleteAutoSaved() {
    let n = 0;
    for (const r of await DFStore.rawItems()) {
      if (r.auto === true && !r.sealed) {
        await DFStore.deleteItem(r.id);
        n++;
      }
    }
    return n;
  }

  async function clearPerfHistory(olderThanDays) {
    const all = (await chrome.storage.local.get(PERF_KEY))[PERF_KEY] || {};
    if (olderThanDays == null) {
      await chrome.storage.local.remove(PERF_KEY);
      return Object.values(all).reduce((s, a) => s + a.length, 0);
    }
    const cut = Date.now() - olderThanDays * DAY;
    let n = 0;
    for (const [k, a] of Object.entries(all)) {
      const keep = a.filter((p) => p.t >= cut);
      n += a.length - keep.length;
      if (keep.length) all[k] = keep;
      else delete all[k];
    }
    await chrome.storage.local.set({ [PERF_KEY]: all });
    return n;
  }

  async function clearAcknowledgements() {
    await chrome.storage.local.remove('secFindingAcks');
  }

  // Run once at start-up according to Settings → Temporary data. 'close' cleans whatever the last
  // session left behind; 'daily' does the same at most once a day and also trims old history.
  async function autoRun(settings) {
    const mode = settings.tempCleanup;
    if (mode !== 'close' && mode !== 'daily') return null;
    const { keepLastCleanup: last } = await chrome.storage.local.get('keepLastCleanup');
    if (mode === 'daily' && last && Date.now() - last < DAY) return null;
    const r = await cleanTemporary();
    if (mode === 'daily') await clearPerfHistory(90);
    await chrome.storage.local.set({ keepLastCleanup: Date.now() });
    return r;
  }

  return { initSalt, keyFor, usage, cleanTemporary, deleteAutoSaved, clearPerfHistory, clearAcknowledgements, autoRun, PERF_KEY };
})();
