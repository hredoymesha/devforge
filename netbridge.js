/*
 * Registered together with netcap.js for "capture from page start", but in the extension's isolated
 * world. Its only job is to receive the capture channel's secret from netcap.js and keep it where
 * page scripts cannot see it (an isolated-world global), so the panel can read it later.
 *
 * Both scripts run at document_start, before any script of the page, so nothing on the page can
 * be listening for the two events below. Each side registers its listener before it announces
 * itself, so the handshake completes whichever script loads first (in practice Chrome starts the
 * MAIN-world script first). The listeners are removed as soon as the secret arrives, or when the
 * document has finished loading.
 * Residual risk: until the document has loaded, a page script could send this script a *fake* key,
 * which can only make capture unreachable; it never reveals the real one.
 */
(() => {
  if (typeof globalThis.__dfNetKey !== 'undefined') return;
  globalThis.__dfNetKey = null;
  const finish = () => {
    document.removeEventListener('devforge:net-key', onKey, true);
    document.removeEventListener('devforge:netcap-ready', announce, true);
    document.removeEventListener('DOMContentLoaded', finish, true);
  };
  const onKey = (e) => {
    try {
      const k = JSON.parse(e.detail);
      if (k && typeof k.n === 'string' && typeof k.s === 'string') globalThis.__dfNetKey = k;
    } catch (_) {
      /* a malformed value is ignored: the panel then reports that capture cannot be reached */
    }
    finish();
  };
  const announce = () => document.dispatchEvent(new CustomEvent('devforge:bridge-ready'));
  document.addEventListener('devforge:net-key', onKey, true);
  document.addEventListener('devforge:netcap-ready', announce, true);
  document.addEventListener('DOMContentLoaded', finish, true);
  announce();
})();
