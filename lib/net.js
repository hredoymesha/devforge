/* Bounded, guarded fetch for page-derived URLs. Loaded as a plain script in the panel and with
 * require() in tests, where `fetchImpl` is replaced by a stub. */
const DFNet = (() => {
  const Safe = typeof DFSafe !== 'undefined' ? DFSafe : require('./safe.js');

  /*
   * Downloads at most `maxBytes` of `url` without sending cookies.
   * `pageUrl` is the page the URL came from. The request is refused before it is sent when it
   * targets a private or loopback host that page is not itself on (judged by host name; DNS names
   * that resolve to private addresses cannot be recognised from an extension).
   *
   * Redirects fail safe. A browser cannot show an extension where a redirect leads until it has
   * already followed it, and the redirected request has been sent by then. So by default redirects
   * are NOT followed (`redirect: 'manual'`): the redirect is reported and nothing is sent to its
   * target. With `followRedirects: true` (an explicit setting) they are followed and the final
   * address is checked, so a public URL that redirects into the local network never has its body read
   * or stored. That check alone would come too late (the request was already sent), so following is
   * paired with `guard`, a declarativeNetRequest rule that blocks private destinations at the network
   * layer for every hop. The residual risk is a public-looking name that resolves to a private
   * address, which neither check can see from an extension.
   */
  async function fetchBounded(url, opts = {}) {
    const {
      maxBytes = 25 * 1024 * 1024,
      timeoutMs = 20000,
      pageUrl,
      followRedirects = false,
      guard = null,
      fetchImpl = (...a) => fetch(...a),
    } = opts;
    // Fail closed: without a page address there is no way to tell "the page's own host" from
    // another one, so nothing is fetched (an empty value used to switch the guard off).
    if (typeof pageUrl !== 'string' || !pageUrl) throw new Error('blocked: the address of the page is unknown');
    if (Safe.blocksPrivate(url, pageUrl))
      throw new Error('blocked: private or loopback address that the page is not itself on');
    // The network-layer guard (lib/netguard.js) blocks private destinations for every hop of a
    // redirect chain before the request is sent. Following redirects is only allowed with it: if it
    // cannot be installed, the request fails closed instead of falling back to the weaker
    // after-the-fact check below.
    if (guard) {
      try {
        await guard(pageUrl);
      } catch (e) {
        if (followRedirects) throw new Error('blocked: redirects cannot be followed safely (' + e.message + ')');
      }
    } else if (followRedirects) {
      throw new Error('blocked: redirects cannot be followed without the network guard');
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, {
        credentials: 'omit',
        // 'force-cache' served whatever was cached, however old, so an export could silently contain
        // an earlier version of an asset. 'no-cache' revalidates (a cheap 304 when nothing changed).
        cache: 'no-cache',
        signal: ac.signal,
        redirect: followRedirects ? 'follow' : 'manual',
      });
      if (r.type === 'opaqueredirect') {
        const err = new Error('redirect not followed (turn on "Follow redirects" in Settings to allow it)');
        err.redirect = true;
        throw err;
      }
      const finalUrl = r.url || url;
      if (!/^https?:/i.test(finalUrl)) {
        if (r.body) r.body.cancel().catch(() => {});
        throw new Error('blocked: redirected to a non-web address');
      }
      if (Safe.blocksPrivate(finalUrl, pageUrl)) {
        if (r.body) r.body.cancel().catch(() => {});
        throw new Error('blocked: redirected to a private or loopback address');
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const len = +r.headers.get('content-length') || 0;
      if (len > maxBytes) throw new Error('too large (' + len + ' bytes)');
      const reader = r.body.getReader();
      const chunks = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > maxBytes) {
          try {
            await reader.cancel();
          } catch (_) {
            /* the stream is being abandoned anyway */
          }
          throw new Error('too large (> ' + maxBytes + ' bytes)');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(n);
      let off = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, off);
        off += chunk.length;
      }
      return { bytes, type: r.headers.get('content-type') || '', status: r.status, finalUrl };
    } catch (e) {
      throw new Error(
        e.name === 'AbortError' ? 'timed out after ' + timeoutMs / 1000 + 's' : e.message
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchBounded };
})();
if (typeof module !== 'undefined') module.exports = DFNet;
