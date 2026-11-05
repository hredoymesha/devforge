// Trusted Types for extension pages. The manifest's content security policy makes the browser
// reject any string given to an HTML or script-URL sink unless it comes from a named policy.
// The manifest allows exactly the two names below. Three places use them:
//   html:      the Recreate preview (an iframe with sandbox="", so no scripts) and Site's HTML
//              rewrite, which parses into a document that is never attached to a page.
//   scriptUrl: Site's rewrite points <script src> at the saved local copy. The browser applies the
//              rule to that inert document too, so a plain string is refused there.
// New code should build DOM with h() instead.
const DFTrusted = (() => {
  const HTML = 'devforge-html';
  const URL_POLICY = 'devforge-url';
  const policies = {};

  // createPolicy throws if the name is taken or the page's policy does not list it. Both mean the
  // string would be refused later anyway, so fall back to the plain string and let the browser say so.
  function policy(tt, name, rules) {
    if (policies[name] === undefined) {
      try {
        policies[name] = tt.createPolicy(name, rules);
      } catch (_) {
        policies[name] = null;
      }
    }
    return policies[name];
  }
  const available = (tt) => tt && typeof tt.createPolicy === 'function';
  const defaultTT = () => (typeof trustedTypes !== 'undefined' ? trustedTypes : undefined);

  function html(s, tt = defaultTT()) {
    if (!available(tt)) return String(s);
    const p = policy(tt, HTML, { createHTML: (x) => String(x) });
    return p ? p.createHTML(String(s)) : String(s);
  }

  // Only a relative path to a saved file. A scheme, a protocol-relative address or whitespace is
  // refused, so this policy can never point a script at another site.
  const isLocalPath = (x) => typeof x === 'string' && x.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(x) && !x.startsWith('//') && !x.startsWith('\\') && !/[\s\0]/.test(x);
  function scriptUrl(s, tt = defaultTT()) {
    if (!available(tt)) return String(s);
    const p = policy(tt, URL_POLICY, {
      createScriptURL: (x) => {
        if (!isLocalPath(x)) throw new TypeError('Only a relative path to a saved file is allowed here');
        return x;
      },
    });
    return p ? p.createScriptURL(String(s)) : String(s);
  }

  const reset = () => Object.keys(policies).forEach((k) => delete policies[k]);
  return { NAMES: [HTML, URL_POLICY], html, scriptUrl, isLocalPath, reset };
})();
if (typeof module !== 'undefined') module.exports = DFTrusted;
