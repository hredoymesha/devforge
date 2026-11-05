// Helpers for the site download: safe paths, URL rewriting, source-map extraction.
// Pure functions, except rewriteHtml which needs DOMParser.
const DFSite = (() => {
  // Bidirectional overrides are replaced too: "photo<RLO>gpj.exe" would be drawn as "photoexe.jpg".
  // eslint-disable-next-line no-control-regex
  const RESERVED = /[<>:"|?*\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
  const WIN_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36).padStart(6, '0').slice(0, 6);
  };
  const dec = (s) => {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  };
  function safeSeg(raw) {
    let s = dec(raw)
      .replace(/\//g, '_')
      .replace(RESERVED, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    if (!s || /^\.+$/.test(s)) s = '_';
    if (WIN_NAMES.test(s)) s = '_' + s;
    if (s.length > 100) {
      const i = s.lastIndexOf('.');
      const ext = i > 0 && s.length - i <= 10 ? s.slice(i) : '';
      s = s.slice(0, 80) + '~' + hash(s) + ext;
    }
    return s;
  }
  // Turns an untrusted path (e.g. from a source map) into a relative path with no '..',
  // no leading slash and no drive letter.
  function sanitizePath(p) {
    p = String(p == null ? '' : p)
      .replace(/^[a-z][a-z0-9+.-]*:\/*/i, '')
      .replace(/\\/g, '/')
      .replace(/\?.*$/, '');
    const segs = [];
    for (const part of p.split('/')) {
      if (!part || part === '.' || part === '..') continue;
      segs.push(safeSeg(part));
    }
    return segs.join('/') || '_unnamed';
  }
  function conflicts(path, used) {
    const lp = path.toLowerCase();
    if (used.has(lp)) return true;
    for (const k of used.keys()) {
      if (k.startsWith(lp + '/') || lp.startsWith(k + '/')) return true;
    }
    return false;
  }
  // Unique, safe path inside the ZIP for a URL. `used` maps lowercase path -> url.
  function urlToPath(url, used, prefix = 'site') {
    const u = new URL(url);
    const host = safeSeg(u.host.replace(/:/g, '_'));
    let segs = u.pathname.split('/').filter((x) => x !== '');
    let file = u.pathname.endsWith('/') || segs.length === 0 ? 'index.html' : segs.pop();
    segs = segs.filter((x) => x !== '.' && x !== '..').map(safeSeg);
    file = safeSeg(file);
    if (u.search) {
      const i = file.lastIndexOf('.');
      const tag = '~' + hash(u.search);
      file = i > 0 ? file.slice(0, i) + tag + file.slice(i) : file + tag;
    }
    let base = [prefix, host, ...segs].filter(Boolean).join('/');
    let path = base + '/' + file,
      n = 1;
    while (conflicts(path, used) && used.get(path.toLowerCase()) !== url) {
      n++;
      const i = file.lastIndexOf('.');
      path = base + '/' + (i > 0 ? file.slice(0, i) + '~' + n + file.slice(i) : file + '~' + n);
      if (n > 50) {
        path = base + '/' + hash(url) + '_' + file;
        break;
      }
    }
    used.set(path.toLowerCase(), url);
    return path;
  }
  function relPath(from, to) {
    const f = from.split('/');
    f.pop();
    const t = to.split('/');
    let i = 0;
    while (i < f.length && i < t.length - 1 && f[i] === t[i]) i++;
    return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/') || t[t.length - 1];
  }
  const norm = (u) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return x.href;
    } catch (_) {
      return null;
    }
  };
  function mapped(raw, base, fromPath, map) {
    if (!raw || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(raw)) return null;
    let abs;
    try {
      abs = new URL(raw, base);
    } catch (_) {
      return null;
    }
    const frag = abs.hash;
    const key = norm(abs.href);
    const to = key && map.get(key);
    return to
      ? relPath(fromPath, to)
          .split('/')
          .map((s) => (s === '..' ? s : encodeURIComponent(s)))
          .join('/') + frag
      : null;
  }
  // Every url(...) token in a CSS text, found in one pass. The regular expressions this replaces
  // backtracked badly on text with many unclosed "url(": 8 KB of "url(" and spaces ran for over eight
  // seconds, so a hostile stylesheet could freeze the panel. Each token here reads at most about
  // 2,200 characters, so the cost stays linear in the size of the text.
  const CSS_SPACE = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  function cssUrlTokens(text, max = 20000) {
    const src = String(text);
    const out = [];
    const re = /url\(/gi;
    let m;
    while (out.length < max && (m = re.exec(src))) {
      let j = m.index + 4;
      for (let k = 0; k < 64 && j < src.length && CSS_SPACE(src.charCodeAt(j)); k++) j++;
      const quote = src[j] === '"' || src[j] === "'" ? src[j] : '';
      if (quote) j++;
      const from = j;
      const limit = Math.min(src.length, j + 2048);
      while (j < limit && (quote ? src[j] !== quote && src[j] !== '\n' : src[j] !== ')' && src[j] !== '"' && src[j] !== "'")) j++;
      if (quote ? src[j] !== quote : false) continue;
      const value = src.slice(from, j);
      if (quote) j++;
      for (let k = 0; k < 64 && j < src.length && CSS_SPACE(src.charCodeAt(j)); k++) j++;
      if (src[j] !== ')' || !value.trim()) continue;
      out.push({ start: m.index, end: j + 1, value: value.trim() });
      re.lastIndex = j + 1;
    }
    return out;
  }
  // @import "file.css" and @import url("file.css"). Bounded for the same reason.
  const IMPORT = /@import\s{1,64}(url\(\s{0,64})?(['"])([^'"]{1,2048})\2/gi;
  function rewriteCss(text, base, fromPath, map) {
    text = text.replace(IMPORT, (m, u, q, v) => {
      const r = mapped(v, base, fromPath, map);
      return r ? m.replace(v, r) : m;
    });
    let out = '';
    let at = 0;
    for (const tok of cssUrlTokens(text)) {
      const r = mapped(tok.value, base, fromPath, map);
      if (!r) continue;
      out += text.slice(at, tok.start) + 'url("' + r + '")';
      at = tok.end;
    }
    return out + text.slice(at);
  }
  function discoverCssUrls(text, base) {
    const out = new Set();
    for (const m of text.matchAll(IMPORT)) out.add(m[3]);
    for (const tok of cssUrlTokens(text)) out.add(tok.value);
    const res = [];
    for (const v of out) {
      if (!v || /^(data:|blob:|#)/i.test(v)) continue;
      try {
        const a = new URL(v, base);
        if (/^https?:$/.test(a.protocol)) {
          a.hash = '';
          res.push(a.href);
        }
      } catch (_) {
        /* an unparseable address is not listed */
      }
    }
    return res;
  }
  function sourceMapUrlOf(jsOrCssText) {
    const tail = jsOrCssText.slice(-2000);
    const m = tail.match(/[#@]\s*sourceMappingURL=([^\s*]+)/g);
    if (!m) return null;
    return m[m.length - 1].replace(/^[#@]\s*sourceMappingURL=/, '');
  }
  // Returns [{path, content}] for sources that embed their content, with cleaned-up unique paths.
  function mapSources(mapText, mapUrl, limits = {}) {
    const maxFiles = limits.maxFiles || 3000,
      maxBytes = limits.maxBytes || 60e6;
    let j;
    try {
      j = JSON.parse(mapText.replace(/^\)\]\}'/, ''));
    } catch (e) {
      return { files: [], error: 'invalid source map JSON' };
    }
    const maps = j.sections ? j.sections.map((s) => s.map).filter(Boolean) : [j];
    const files = [];
    const seen = new Set();
    let bytes = 0,
      skippedNoContent = 0;
    for (const m of maps) {
      const root = m.sourceRoot || '';
      (m.sources || []).forEach((src, i) => {
        const content = m.sourcesContent && m.sourcesContent[i];
        if (typeof content !== 'string') {
          skippedNoContent++;
          return;
        }
        if (files.length >= maxFiles || bytes + content.length > maxBytes) return;
        let p = sanitizePath((root ? root.replace(/\/?$/, '/') : '') + src);
        let q = p,
          n = 1;
        while (seen.has(q.toLowerCase())) {
          n++;
          const i2 = p.lastIndexOf('.');
          q = i2 > 0 ? p.slice(0, i2) + '~' + n + p.slice(i2) : p + '~' + n;
        }
        seen.add(q.toLowerCase());
        bytes += content.length;
        files.push({ path: q, content });
      });
    }
    return {
      files,
      skippedNoContent,
      total: maps.reduce((a, m) => a + (m.sources || []).length, 0),
    };
  }
  function rewriteHtml(html, base, fromPath, map, opts = {}) {
    const trusted = typeof DFTrusted !== 'undefined' ? DFTrusted.html(html) : html;
    const doc = new DOMParser().parseFromString(trusted, 'text/html');
    const A = ['src', 'href', 'poster', 'data', 'data-src'];
    doc.querySelectorAll('base').forEach((b) => b.remove());
    let rewritten = 0;
    doc.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase();
      for (const a of A) {
        const v = el.getAttribute(a);
        if (!v) continue;
        if (tag === 'a' && a === 'href') continue; // navigation links stay pointing at the live site
        const r = mapped(v, base, fromPath, map);
        if (r) {
          // <script src> is a Trusted Types sink even in this inert document.
          el.setAttribute(a, tag === 'script' && a === 'src' && typeof DFTrusted !== 'undefined' ? DFTrusted.scriptUrl(r) : r);
          rewritten++;
          if (el.hasAttribute('integrity')) el.removeAttribute('integrity');
          if (el.hasAttribute('crossorigin')) el.removeAttribute('crossorigin');
        }
      }
      for (const a of ['srcset', 'data-srcset']) {
        const v = el.getAttribute(a);
        if (v)
          el.setAttribute(
            a,
            v
              .split(',')
              .map((p) => {
                const [u, ...rest] = p.trim().split(/\s+/);
                const r = mapped(u, base, fromPath, map);
                if (r) rewritten++;
                return [r || u, ...rest].join(' ');
              })
              .join(', ')
          );
      }
      const st = el.getAttribute('style');
      if (st && st.includes('url(')) el.setAttribute('style', rewriteCss(st, base, fromPath, map));
      // Only a style element that holds nothing but text. A <style> inside <math> is parsed as
      // markup, and assigning textContent would flatten the elements inside it.
      if (tag === 'style' && [...el.childNodes].every((n) => n.nodeType === 3)) el.textContent = rewriteCss(el.textContent, base, fromPath, map);
    });
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, rewritten };
  }
  const EXT_KIND = {
    js: 'js',
    mjs: 'js',
    cjs: 'js',
    css: 'css',
    html: 'html',
    htm: 'html',
    xhtml: 'html',
    json: 'json',
    webmanifest: 'json',
    map: 'map',
    wasm: 'wasm',
    xml: 'data',
    txt: 'data',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    avif: 'image',
    svg: 'image',
    ico: 'image',
    bmp: 'image',
    woff: 'font',
    woff2: 'font',
    ttf: 'font',
    otf: 'font',
    eot: 'font',
    mp4: 'media',
    webm: 'media',
    mp3: 'media',
    ogg: 'media',
    wav: 'media',
    m4a: 'media',
    m3u8: 'media',
    mov: 'media',
  };
  function kindFromUrl(u) {
    try {
      const m = new URL(u).pathname.match(/\.([a-z0-9]{1,6})$/i);
      return (m && EXT_KIND[m[1].toLowerCase()]) || null;
    } catch (_) {
      return null;
    }
  }
  function baseDomain(host) {
    const p = host.split('.');
    if (p.length <= 2 || /^\d+(\.\d+){3}$/.test(host)) return host;
    const sl = p[p.length - 2];
    return (
      p[p.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(sl)
        ? p.slice(-3)
        : p.slice(-2)
    ).join('.');
  }
  function isThirdParty(url, pageHost) {
    try {
      const h = new URL(url).hostname;
      return !(h === pageHost || baseDomain(h) === baseDomain(pageHost));
    } catch (_) {
      return true;
    }
  }
  return {
    kindFromUrl,
    baseDomain,
    isThirdParty,
    hash,
    safeSeg,
    sanitizePath,
    urlToPath,
    relPath,
    rewriteCss,
    rewriteHtml,
    discoverCssUrls,
    cssUrlTokens,
    sourceMapUrlOf,
    mapSources,
    norm,
  };
})();
if (typeof module !== 'undefined') module.exports = DFSite;
