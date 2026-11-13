// Which sites DevForge may work on, and the local list of sites it has worked on. Pure: no browser
// API, so both modes and the list can be tested in Node.
const DFSiteAccess = (() => {
  const LOG_MAX = 200;

  // Settings → Site access. "All sites" is the default. With it off, only the origins in the list
  // are allowed. A page address that does not parse is never allowed.
  function allowed(settings, url) {
    if (!settings || settings.allowAllSites !== false) return true;
    try {
      return (settings.siteAllowlist || []).includes(new URL(url).origin);
    } catch (_) {
      return false;
    }
  }

  // The origin of a page address, or null for anything that is not a web page. Paths and queries
  // are dropped: the list holds where DevForge worked, not what it looked at.
  function originOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch (_) {
      return null;
    }
  }

  // Adds one visit to the list, most recent first. A site seen again moves to the top and counts up.
  function record(log, origin, nowIso, max = LOG_MAX) {
    const list = Array.isArray(log) ? log.slice() : [];
    const at = list.findIndex((e) => e.origin === origin);
    const count = at >= 0 ? list[at].count + 1 : 1;
    if (at >= 0) list.splice(at, 1);
    list.unshift({ origin, last: nowIso, count });
    return list.slice(0, max);
  }

  return { allowed, originOf, record, LOG_MAX };
})();
if (typeof module !== 'undefined') module.exports = DFSiteAccess;
