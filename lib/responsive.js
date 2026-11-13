// Media rules in a part's stylesheet, and whether each one applies at a given width.
// Only width features, print and screen are judged. Anything else is reported as "unknown",
// never as true or false.
const DFResponsive = (() => {
  const WIDTHS = [360, 768, 1280];
  const EM = 16;
  const FEATURE = /\((min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|em)\s*\)/gi;

  // Walks a block body and returns the preludes of the rules directly inside it.
  function topLevel(body) {
    const sels = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '{') {
        if (depth === 0) sels.push(body.slice(start, i).replace(/\s+/g, ' ').trim());
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) start = i + 1;
      }
    }
    return sels.filter(Boolean);
  }

  // Each @media block in the text, with its query, the breakpoints it names and its rules.
  function mediaRules(css) {
    const text = String(css || '');
    const out = [];
    const re = /@media\b/gi;
    let m;
    while ((m = re.exec(text))) {
      const open = text.indexOf('{', m.index);
      if (open < 0) break;
      const query = text.slice(m.index + '@media'.length, open).replace(/\s+/g, ' ').trim();
      let depth = 0;
      let end = -1;
      for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) {
          end = i;
          break;
        }
      }
      const body = text.slice(open + 1, end < 0 ? text.length : end);
      const sels = topLevel(body);
      out.push({ query, breakpoints: breakpoints(query), rules: sels.length, selectors: sels.slice(0, 5).map((s) => s.slice(0, 120)) });
      if (end < 0) break;
      re.lastIndex = end + 1;
    }
    return out;
  }

  function breakpoints(query) {
    const list = [];
    for (const f of String(query).matchAll(FEATURE)) {
      const px = f[3].toLowerCase() === 'em' ? +f[2] * EM : +f[2];
      list.push({ feature: f[1].toLowerCase() + '-width', px });
    }
    return [...new Map(list.map((b) => [b.feature + b.px, b])).values()].sort((a, b) => a.px - b.px);
  }

  // Is one comma-separated alternative true at this width?
  function alternative(part, width) {
    const p = part.trim().toLowerCase();
    if (!p) return false;
    if (/\bnot\b|\bonly\b|\bprefers-|\borientation|\bhover|\bpointer|\bcolor-scheme/.test(p)) return 'unknown';
    if (/\bprint\b/.test(p) && !/\bscreen\b|\ball\b/.test(p)) return false;
    if (/\bprint\b/.test(p)) return 'unknown';
    const features = [...p.matchAll(FEATURE)];
    const other = p.replace(FEATURE, '').replace(/\band\b|\ball\b|\bscreen\b|[\s()]/g, '');
    if (other) return 'unknown';
    let result = true;
    for (const f of features) {
      const px = f[3] === 'em' ? +f[2] * EM : +f[2];
      if (f[1] === 'min' && !(width >= px)) result = false;
      if (f[1] === 'max' && !(width <= px)) result = false;
    }
    return result;
  }

  // true, false or 'unknown' for a whole query: the query is true if any alternative is true.
  function activeAt(query, width) {
    if (!String(query || '').trim()) return true;
    const parts = String(query).split(',');
    let unknown = false;
    for (const part of parts) {
      const r = alternative(part, width);
      if (r === true) return true;
      if (r === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : false;
  }

  return { WIDTHS, mediaRules, breakpoints, activeAt };
})();
if (typeof module !== 'undefined') module.exports = DFResponsive;
