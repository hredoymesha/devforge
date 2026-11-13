// Reads a source map (version 3) and works out how many bytes of a generated script each original
// file accounts for. The sizes come from the mapping, so they are estimates at the granularity the
// map gives. Indexed maps (with "sections") are not analysed.
const DFSourceMap = (() => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const LOOKUP = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) LOOKUP[B64.charCodeAt(i)] = i;
  const MAX_SEGMENTS = 5e6;
  const MAX_MAPPINGS = 60e6;

  function utf8Len(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  // One segment is 1, 4 or 5 base64 VLQ numbers. Returns the numbers in order.
  function decodeSegment(seg) {
    const out = [];
    let value = 0;
    let shift = 0;
    for (let i = 0; i < seg.length; i++) {
      const code = seg.charCodeAt(i);
      const d = code < 128 ? LOOKUP[code] : -1;
      if (d < 0) throw new Error('The source map has a character that is not base64.');
      if (shift > 30) throw new Error('The source map has a number that is too large.');
      value += (d & 31) << shift;
      if (d & 32) {
        shift += 5;
      } else {
        const negative = value & 1;
        value = value >>> 1;
        out.push(negative ? -value : value);
        value = 0;
        shift = 0;
      }
    }
    if (shift !== 0) throw new Error('The source map ends in the middle of a number.');
    return out;
  }

  // Returns one array per generated line. A segment is { col, src, line, column }; src is -1 when the
  // segment only says where a column is.
  function parseMappings(mappings) {
    if (String(mappings).length > MAX_MAPPINGS) throw new Error('The source map is too large to analyse.');
    const lines = [];
    let src = 0;
    let line = 0;
    let column = 0;
    let count = 0;
    for (const text of String(mappings).split(';')) {
      const segs = [];
      let col = 0;
      if (text) {
        for (const raw of text.split(',')) {
          if (!raw) continue;
          if (++count > MAX_SEGMENTS) throw new Error('The source map has too many segments to analyse.');
          const f = decodeSegment(raw);
          col += f[0];
          if (f.length >= 4) {
            src += f[1];
            line += f[2];
            column += f[3];
            segs.push({ col, src: src, line, column });
          } else {
            segs.push({ col, src: -1, line: -1, column: -1 });
          }
        }
      }
      lines.push(segs);
    }
    return lines;
  }

  // Splits the bytes of a generated script between the original files of its map.
  // Returns { total, unmapped, perSource: [bytes per source index] }.
  function attribute(map, code) {
    const lines = parseMappings(map.mappings);
    const perSource = new Array((map.sources || []).length).fill(0);
    const text = String(code);
    const rows = text.split('\n');
    let unmapped = 0;
    rows.forEach((row, i) => {
      const segs = lines[i] || [];
      let at = 0;
      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k];
        const start = Math.min(Math.max(seg.col, at), row.length);
        if (start > at) unmapped += utf8Len(row.slice(at, start));
        const end = k + 1 < segs.length ? Math.min(segs[k + 1].col, row.length) : row.length;
        const bytes = utf8Len(row.slice(start, Math.max(start, end)));
        if (seg.src >= 0 && seg.src < perSource.length) perSource[seg.src] += bytes;
        else unmapped += bytes;
        at = Math.max(start, end);
      }
      if (at < row.length) unmapped += utf8Len(row.slice(at));
      if (i < rows.length - 1) unmapped += 1;
    });
    return { total: utf8Len(text), unmapped, perSource };
  }

  // Parses map JSON. Throws a clear message for the cases it does not handle.
  function parseMap(text) {
    let j;
    try {
      j = JSON.parse(String(text).replace(/^\)\]\}'\n?/, ''));
    } catch (_) {
      throw new Error('This is not valid source map JSON.');
    }
    if (j && j.sections) throw new Error('Indexed source maps (with sections) are not analysed.');
    if (!j || typeof j.mappings !== 'string') throw new Error('The source map has no mappings.');
    const sources = Array.isArray(j.sources) ? j.sources.map((s) => String(s)) : [];
    const root = typeof j.sourceRoot === 'string' && j.sourceRoot ? j.sourceRoot.replace(/\/?$/, '/') : '';
    const hasContent = sources.map((_, i) => typeof (j.sourcesContent || [])[i] === 'string');
    return { mappings: j.mappings, sources: sources.map((s) => root + s), hasContent };
  }

  // The package a module belongs to, and the folder that holds that copy of it.
  // "node_modules/a/node_modules/b/x.js" is package b, in the copy under a.
  function packageOf(path) {
    const p = String(path).replace(/\\/g, '/');
    const re = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;
    let m;
    let last = null;
    while ((m = re.exec(p))) last = { name: m[1], folder: p.slice(0, m.index + m[0].length) };
    return last;
  }

  // Packages that appear in more than one copy in the analysed bundles. A copy is the folder that
  // holds it, so two copies of one package under different parents are duplicates.
  function duplicates(modules) {
    const byName = new Map();
    for (const m of modules) {
      const pkg = packageOf(m.path);
      if (!pkg) continue;
      if (!byName.has(pkg.name)) byName.set(pkg.name, new Map());
      const copies = byName.get(pkg.name);
      copies.set(pkg.folder, (copies.get(pkg.folder) || 0) + m.bytes);
    }
    const out = [];
    for (const [name, copies] of byName) {
      if (copies.size < 2) continue;
      const list = [...copies].map(([folder, bytes]) => ({ folder, bytes })).sort((a, b) => b.bytes - a.bytes);
      out.push({ name, copies: list.length, bytes: list.reduce((n, c) => n + c.bytes, 0), folders: list.slice(0, 10) });
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  }

  // Joins the results of several bundle files into one list of modules, largest first.
  function modulesOf(results) {
    const byPath = new Map();
    for (const r of results) {
      r.modules.forEach((m) => {
        const key = m.path;
        const prev = byPath.get(key) || { path: key, bytes: 0, hasContent: false, files: 0 };
        prev.bytes += m.bytes;
        prev.hasContent = prev.hasContent || m.hasContent;
        prev.files += 1;
        byPath.set(key, prev);
      });
    }
    return [...byPath.values()].sort((a, b) => b.bytes - a.bytes);
  }

  // Analyses one script with its parsed map. Returns the modules and the unmapped bytes.
  function analyse(scriptName, code, map) {
    const att = attribute(map, code);
    const modules = map.sources
      .map((path, i) => ({ path, bytes: att.perSource[i], hasContent: map.hasContent[i] }))
      .filter((m) => m.bytes > 0);
    return { script: scriptName, total: att.total, unmapped: att.unmapped, modules, sourcesWithContent: map.hasContent.filter(Boolean).length, sourceCount: map.sources.length };
  }

  return { utf8Len, decodeSegment, parseMappings, attribute, parseMap, packageOf, duplicates, modulesOf, analyse };
})();
if (typeof module !== 'undefined') module.exports = DFSourceMap;
