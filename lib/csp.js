// A Content-Security-Policy-Report-Only suggestion and Subresource Integrity tags, built from what a
// page was seen to load. Both are generated and inferred: they describe this page at this moment, not
// every page of the site or every state of this one. Pure: the agent collects the facts, the panel
// fetches the files and hashes them, and this module only turns that into text.
const DFCsp = (() => {
  const PROVENANCE = 'generated: inferred from what this page loaded when the button was pressed';
  const DIRECTIVES = [
    ['script', 'script-src', 'Scripts the page loaded'],
    ['style', 'style-src', 'Stylesheets the page loaded'],
    ['img', 'img-src', 'Images the page loaded'],
    ['font', 'font-src', 'Fonts the page loaded'],
    ['connect', 'connect-src', 'Addresses the page fetched or sent data to'],
    ['media', 'media-src', 'Audio and video the page loaded'],
    ['frame', 'frame-src', 'Frames the page embedded'],
  ];
  const ORIGIN = /^(https?|wss?):\/\/[A-Za-z0-9.[\]:-]+$/;
  const HASH = /^[A-Za-z0-9+/]{43}=$/; // base64 of a 32-byte SHA-256 digest

  const originOf = (u, base) => {
    try {
      const x = new URL(u, base);
      return /^https?:$/.test(x.protocol) || /^wss?:$/.test(x.protocol) ? x.origin : null;
    } catch (_) {
      return null;
    }
  };

  // facts (from agent secCspFacts): { origin, loaded: { script: [origin|'data:'|'blob:'], ... },
  //   inline: { scripts: [sha256 base64], styles: [...], handlers: n, styleAttributes: n }, forms: [origin] }
  function build(facts) {
    const self = String(facts.origin || '');
    const notes = [];
    const rows = [];
    const sourcesFor = (kind) => {
      const out = ["'self'"];
      const seen = new Set();
      for (const s of (facts.loaded && facts.loaded[kind]) || []) {
        if (s === 'data:' || s === 'blob:') {
          if (!seen.has(s)) out.push(s);
          seen.add(s);
        } else if (ORIGIN.test(s) && s !== self && !seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
      return out;
    };
    rows.push({ name: 'default-src', values: ["'self'"], why: 'Everything not named below may come from this site only.' });
    for (const [kind, name, why] of DIRECTIVES) {
      const values = sourcesFor(kind);
      const seen = (facts.loaded && facts.loaded[kind]) || [];
      if (kind !== 'script' && kind !== 'style' && !seen.length) continue; // nothing seen: default-src covers it
      if (kind === 'script' || kind === 'style') {
        const hashes = ((facts.inline && facts.inline[kind === 'script' ? 'scripts' : 'styles']) || []).filter((h) => HASH.test(h));
        for (const h of [...new Set(hashes)]) values.push("'sha256-" + h + "'");
      }
      rows.push({ name, values, why: why + (kind === 'script' || kind === 'style' ? ', plus a hash for each inline block' : '') + '.' });
    }
    rows.push({ name: 'object-src', values: ["'none'"], why: 'Plug-ins are not needed by modern pages.' });
    rows.push({ name: 'base-uri', values: ["'self'"], why: 'Stops an injected <base> tag from redirecting relative addresses.' });
    const forms = [...new Set((facts.forms || []).filter((o) => ORIGIN.test(o) && o !== self))];
    rows.push({ name: 'form-action', values: ["'self'", ...forms], why: 'Forms may submit to this site' + (forms.length ? ' and the addresses they use now' : '') + ' only.' });
    const handlers = (facts.inline && facts.inline.handlers) || 0;
    const styleAttrs = (facts.inline && facts.inline.styleAttributes) || 0;
    if (styleAttrs) {
      rows.push({ name: 'style-src-attr', values: ["'unsafe-inline'"], why: styleAttrs + ' element' + (styleAttrs === 1 ? ' has' : 's have') + ' a style attribute. Hashes cannot cover those without \'unsafe-hashes\', so this allows them.' });
    }
    if (handlers) notes.push(handlers + ' inline event handler attribute' + (handlers === 1 ? '' : 's') + ' (onclick and similar) will be reported as violations. Move them into scripts with addEventListener, or the policy cannot be enforced without \'unsafe-inline\'.');
    if (/^https:/.test(self) && rows.some((r) => r.values.some((v) => /^http:/.test(v)))) notes.push('The page loads something over http: from an https: page (mixed content). Fix that before enforcing.');
    notes.push('A Report-Only policy blocks nothing. Add a report-to or report-uri endpoint to collect the violations, run it for a while on every kind of page, and only then enforce it.');
    notes.push('WebSocket and EventSource connections do not appear in the page timing used here. Add their wss: or https: origins to connect-src yourself.');
    notes.push('Only what loaded on this page, in this state, is included. Resources that load later, after a click or on other pages, are not.');
    const policy = rows.map((r) => r.name + ' ' + r.values.join(' ')).join('; ');
    return { header: 'Content-Security-Policy-Report-Only: ' + policy, policy, rows, notes, provenance: PROVENANCE };
  }

  /* ---------- Subresource Integrity ---------- */

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const integrityValue = (digestBytes, algo = 'sha384') => algo + '-' + toBase64(digestBytes);

  // "sha384-AAA sha512-BBB" against one computed value of the same algorithm.
  function compare(existing, computed) {
    const tokens = String(existing || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return 'none';
    const algo = computed.split('-')[0];
    const same = tokens.filter((t) => t.split('-')[0] === algo);
    if (!same.length) return 'other-algorithm';
    return same.some((t) => t.split('?')[0] === computed) ? 'matches' : 'differs';
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const SCRIPT_ATTRS = ['type', 'async', 'defer', 'nomodule'];
  const LINK_ATTRS = ['media'];

  // entry: { tag: 'script' | 'link', url, attrs: { type, async, ... } }; integrity: "sha384-..." from integrityValue().
  function tag(entry, integrity) {
    const a = entry.attrs || {};
    const extra = (list) =>
      list
        .filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== false)
        .map((k) => (a[k] === true || a[k] === '' ? ' ' + k : ' ' + k + '="' + esc(a[k]) + '"'))
        .join('');
    if (entry.tag === 'link') return '<link rel="stylesheet" href="' + esc(entry.url) + '" integrity="' + esc(integrity) + '" crossorigin="anonymous"' + extra(LINK_ATTRS) + '>';
    return '<script src="' + esc(entry.url) + '" integrity="' + esc(integrity) + '" crossorigin="anonymous"' + extra(SCRIPT_ATTRS) + '></script>';
  }

  return { PROVENANCE, build, originOf, toBase64, integrityValue, compare, tag, esc };
})();
if (typeof module !== 'undefined') module.exports = DFCsp;
