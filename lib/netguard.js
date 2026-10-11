/*
 * Network-layer guard for requests the extension makes on its own (exports, downloads, stylesheet
 * fetches). It complements the host-name check in lib/safe.js (`blocksPrivate`) with a
 * declarativeNetRequest rule, which Chrome evaluates for EVERY request in a redirect chain. That is
 * what lets DevForge stop a public URL from bouncing the browser to a loopback or private address:
 * the second request is blocked before it is sent, which `fetch()` alone cannot do (it only reveals a
 * redirect target after following it).
 *
 * What it guarantees: requests whose initiator is this extension are blocked when the URL names a
 * loopback / private / link-local / unique-local address or an internal-looking host name, unless
 * the host is the one the user's current page is itself on.
 * What it cannot do: it sees URLs, not DNS answers. A public-looking name that resolves to a
 * private address (DNS rebinding) is not recognised. See docs/SECURITY-REVIEW.md.
 *
 * The patterns use RE2 syntax (what Chrome accepts); they are also plain JavaScript regular
 * expressions so the unit tests can run the same text against an adversarial URL matrix.
 */
const DFNetGuard = (() => {
  const BLOCK_RULE_IDS = [9001, 9002, 9003, 9004, 9005, 9006, 9007];
  const BLOCK_RULE_ID = BLOCK_RULE_IDS[0];
  const ALLOW_RULE_ID = 9010;

  // scheme, optional user-info, then the host. Chrome gives the rule the canonical URL, in which
  // numeric forms (0x7f.1, 2130706433, 017700000001) are already dotted decimal.
  // ASCII classes, not negated ones: a negated class compiles to many UTF-8 byte ranges and pushed
  // the patterns over Chrome's 2 KB limit. Canonical URLs only contain ASCII here (IDNs are punycode).
  const HEAD = "^https?://([-a-zA-Z0-9._~%:!$&'()*+,;=]*@)?";
  const TAIL = '\\.?(:[0-9]+)?([/?#]|$)';

  // One rule per family: Chrome compiles each regexFilter with a 2 KB memory limit (RE2), and a
  // single combined pattern exceeded it in a real browser.
  // After the first octets only digits and dots may follow, so '127.example.com' or '10.evil.com'
  // (public names that merely start like an address) are not matched.
  const D = '\\.[0-9.]+';
  const BODIES = [
    '(127|10|0|192\\.168|169\\.254)' + D,
    '(192\\.0\\.[02]|198\\.(1[89]|51\\.100)|203\\.0\\.113)' + D,
    '(2[2-5][0-9]|172\\.(1[6-9]|2[0-9]|3[01])|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))' + D,
    '(localhost|[-a-zA-Z0-9._~%]*\\.(localhost|local|internal|home\\.arpa))',
    '\\[::[0-9a-fA-F:.]*\\]',
    '\\[(64:ff9b::|2002:|2001:[dD][bB]8:)[0-9a-fA-F:.]*\\]',
    '\\[([fF][cdCD]|[fF][eE][89a-fA-F]|[fF][fF])[0-9a-fA-F:]*\\]',
  ];
  const FILTERS = BODIES.map((body) => HEAD + body + TAIL);
  const PRIVATE_URL = FILTERS.join('|'); // for tests only: the union of the rules

  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const TYPES = ['xmlhttprequest', 'other', 'image', 'stylesheet', 'script', 'font', 'media'];

  // The rules that block private destinations for this extension's own requests.
  const blockRules = (extensionId) =>
    FILTERS.map((regexFilter, i) => ({
      id: BLOCK_RULE_IDS[i],
      priority: 1,
      action: { type: 'block' },
      condition: { regexFilter, isUrlFilterCaseSensitive: false, initiatorDomains: [extensionId], resourceTypes: TYPES },
    }));

  // Lets the host of the user's current page through (a page on localhost may fetch its own assets).
  function allowRule(pageUrl, extensionId) {
    const u = new URL(pageUrl);
    return {
      id: ALLOW_RULE_ID,
      priority: 2,
      action: { type: 'allow' },
      condition: {
        regexFilter: HEAD + escapeRe(u.hostname.toLowerCase()) + TAIL,
        isUrlFilterCaseSensitive: false,
        initiatorDomains: [extensionId],
        resourceTypes: TYPES,
      },
    };
  }

  // For tests: would the block rule match this URL (after the canonicalisation Chrome applies)?
  function wouldBlock(url) {
    try {
      const href = new URL(url).href;
      return FILTERS.some((f) => new RegExp(f, 'i').test(href));
    } catch (_) {
      return false;
    }
  }

  /*
   * Installs the block rule and sets the allow rule for the page's host. Session rules are used so
   * nothing persists after the browser closes. Throws when the API is unavailable, so callers can
   * fail closed instead of sending an unguarded request.
   */
  async function install(chromeApi, extensionId, pageUrl) {
    const dnr = chromeApi && chromeApi.declarativeNetRequest;
    if (!dnr || !dnr.updateSessionRules) throw new Error('the network guard is unavailable in this browser');
    const add = blockRules(extensionId);
    if (pageUrl) {
      try {
        add.push(allowRule(pageUrl, extensionId));
      } catch (_) {
        /* an unparseable page address simply gets no exception */
      }
    }
    await dnr.updateSessionRules({ removeRuleIds: [...BLOCK_RULE_IDS, ALLOW_RULE_ID], addRules: add });
    return add.length;
  }

  return { BLOCK_RULE_IDS, BLOCK_RULE_ID, ALLOW_RULE_ID, PRIVATE_URL, FILTERS, blockRules, allowRule, wouldBlock, install };
})();
if (typeof module !== 'undefined') module.exports = DFNetGuard;
