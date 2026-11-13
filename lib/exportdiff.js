// Compares two exports (part ZIPs, page bundles or site ZIPs) file by file. HTML is compared
// without whitespace, comments and DevForge's own ids; CSS by rule; JSON without the fields that
// hold a time; everything else by its SHA-256. The result is plain data, with a Markdown and a JSON
// form.
const DFExportDiff = (() => {
  const hash = typeof DFHash !== 'undefined' ? DFHash : require('./hash.js');
  const IGNORED = [/(^|\/)README\.md$/i, /(^|\/)_devforge\/report\.json$/, /(^|\/)_manifest\.json$/, /(^|\/)RECREATION-REPORT\.md$/];
  const VOLATILE_KEYS = new Set(['created', 'generated', 'generatedAt', 'exportedAt', 'timestamp', 'time', 'date']);
  const TEXT_LIMIT = 2 * 1024 * 1024;
  const MAX_FILES = 5000;
  const LIST_LIMIT = 20;

  const kindOf = (path) => {
    if (/\.(html?|htm)$/i.test(path)) return 'html';
    if (/\.css$/i.test(path)) return 'css';
    if (/\.json$/i.test(path)) return 'json';
    if (/\.(js|mjs|cjs|svg|xml|txt|md)$/i.test(path)) return 'text';
    return 'binary';
  };

  // A ZIP made by DevForge has one top folder, with the export's name and time. It is removed so
  // two exports of the same part compare by their content.
  function stripRoot(files) {
    const first = files.map((f) => f.path.split('/')[0]);
    const root = first[0];
    if (files.length && files.every((f, i) => f.path.includes('/') && first[i] === root)) {
      return files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
    }
    return files;
  }

  const text = (data) => (typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data));
  const bytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

  // Whitespace, comments, and the ids DevForge writes into exported pages.
  function normaliseHtml(src) {
    return src
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\sdata-df-root(?=[\s>])/g, '')
      .replace(/\sid="(?:__df_|df-)[^"]*"/g, '')
      .replace(/\s+/g, ' ')
      .replace(/>\s+</g, '><')
      .trim();
  }

  function htmlParts(src) {
    const tags = new Map();
    for (const m of src.matchAll(/<([a-zA-Z][\w-]*)/g)) tags.set(m[1].toLowerCase(), (tags.get(m[1].toLowerCase()) || 0) + 1);
    const words = new Map();
    for (const m of src.matchAll(/>([^<]+)/g)) {
      const t = m[1].trim();
      if (t) words.set(t, (words.get(t) || 0) + 1);
    }
    return { tags, words };
  }

  function countDiff(a, b) {
    const added = {};
    const removed = {};
    for (const [k, n] of b) if ((a.get(k) || 0) < n) added[k] = n - (a.get(k) || 0);
    for (const [k, n] of a) if ((b.get(k) || 0) < n) removed[k] = n - (b.get(k) || 0);
    return { added, removed };
  }

  function listDiff(a, b) {
    const add = [];
    const rem = [];
    for (const [k, n] of b) {
      const d = n - (a.get(k) || 0);
      if (d > 0) add.push({ text: k.slice(0, 120), count: d });
    }
    for (const [k, n] of a) {
      const d = n - (b.get(k) || 0);
      if (d > 0) rem.push({ text: k.slice(0, 120), count: d });
    }
    return { added: add.slice(0, LIST_LIMIT), removed: rem.slice(0, LIST_LIMIT), more: Math.max(0, add.length - LIST_LIMIT) + Math.max(0, rem.length - LIST_LIMIT) };
  }

  function compareHtml(a, b) {
    const na = normaliseHtml(a);
    const nb = normaliseHtml(b);
    if (na === nb) return { same: true };
    const pa = htmlParts(na);
    const pb = htmlParts(nb);
    return { same: false, tags: countDiff(pa.tags, pb.tags), text: listDiff(pa.words, pb.words) };
  }

  // Top-level rules as { selector, body }. Each @media or other at-rule block is one item, and its
  // inner text is its body.
  function cssRules(src) {
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const rules = [];
    let depth = 0;
    let start = 0;
    let open = -1;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === '{') {
        if (depth === 0) open = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && open >= 0) {
          rules.push({ selector: clean.slice(start, open).replace(/\s+/g, ' ').trim(), body: clean.slice(open + 1, i).replace(/\s+/g, ' ').trim() });
          start = i + 1;
          open = -1;
        }
      } else if (c === ';' && depth === 0) {
        start = i + 1;
      }
    }
    return rules.filter((r) => r.selector);
  }

  function compareCss(a, b) {
    const ra = cssRules(a);
    const rb = cssRules(b);
    const bySel = (list) => {
      const m = new Map();
      for (const r of list) m.set(r.selector, [...(m.get(r.selector) || []), r.body]);
      return m;
    };
    const ma = bySel(ra);
    const mb = bySel(rb);
    const added = [];
    const removed = [];
    const changed = [];
    for (const [sel, bodies] of mb) {
      if (!ma.has(sel)) added.push({ selector: sel.slice(0, 160) });
      else if (bodies.join('\n') !== ma.get(sel).join('\n')) changed.push({ selector: sel.slice(0, 160), before: ma.get(sel).join(' | ').slice(0, 300), after: bodies.join(' | ').slice(0, 300) });
    }
    for (const sel of ma.keys()) if (!mb.has(sel)) removed.push({ selector: sel.slice(0, 160) });
    if (!added.length && !removed.length && !changed.length) return { same: true };
    return { same: false, added: added.slice(0, LIST_LIMIT), removed: removed.slice(0, LIST_LIMIT), changed: changed.slice(0, LIST_LIMIT), counts: { added: added.length, removed: removed.length, changed: changed.length } };
  }

  function scrub(v) {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) if (!VOLATILE_KEYS.has(k)) out[k] = scrub(v[k]);
      return out;
    }
    return v;
  }

  function compareJson(a, b) {
    let ja;
    let jb;
    try {
      ja = JSON.stringify(scrub(JSON.parse(a)));
      jb = JSON.stringify(scrub(JSON.parse(b)));
    } catch (_) {
      return { same: false, note: 'One side is not valid JSON, compared as text.', ...compareText(a, b) };
    }
    if (ja === jb) return { same: true };
    const ka = new Set(Object.keys(JSON.parse(ja)));
    const kb = new Set(Object.keys(JSON.parse(jb)));
    return { same: false, keysAdded: [...kb].filter((k) => !ka.has(k)).slice(0, LIST_LIMIT), keysRemoved: [...ka].filter((k) => !kb.has(k)).slice(0, LIST_LIMIT) };
  }

  function compareText(a, b) {
    return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim() ? { same: true } : { same: false };
  }

  async function digest(data) {
    return hash.sha256(bytes(data));
  }

  // files: [{ path, data }] where data is text or bytes. Returns the comparison.
  async function compare(filesA, filesB, opts = {}) {
    const A = stripRoot(filesA);
    const B = stripRoot(filesB);
    if (A.length > MAX_FILES || B.length > MAX_FILES) throw new Error('An export has more than ' + MAX_FILES + ' files. Compare smaller exports.');
    const ma = new Map(A.map((f) => [f.path, f.data]));
    const mb = new Map(B.map((f) => [f.path, f.data]));
    const paths = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    const out = { a: opts.nameA || 'first export', b: opts.nameB || 'second export', summary: { same: 0, added: 0, removed: 0, changed: 0, ignored: 0 }, ignored: [], files: [] };
    for (const path of paths) {
      if (IGNORED.some((re) => re.test(path))) {
        out.summary.ignored++;
        out.ignored.push(path);
        continue;
      }
      const inA = ma.has(path);
      const inB = mb.has(path);
      if (!inA || !inB) {
        const status = inA ? 'removed' : 'added';
        out.summary[status]++;
        out.files.push({ path, kind: kindOf(path), status, size: bytes(inA ? ma.get(path) : mb.get(path)).length });
        continue;
      }
      const kind = kindOf(path);
      const da = ma.get(path);
      const db = mb.get(path);
      const entry = { path, kind, status: 'same' };
      if (kind === 'binary' || bytes(da).length > TEXT_LIMIT || bytes(db).length > TEXT_LIMIT) {
        const ha = await digest(da);
        const hb = await digest(db);
        if (ha !== hb) {
          entry.status = 'changed';
          entry.detail = { sizeBefore: bytes(da).length, sizeAfter: bytes(db).length, note: kind === 'binary' ? 'different bytes' : 'too large to compare text, compared by bytes' };
        }
      } else {
        const ta = text(da);
        const tb = text(db);
        const r = kind === 'html' ? compareHtml(ta, tb) : kind === 'css' ? compareCss(ta, tb) : kind === 'json' ? compareJson(ta, tb) : compareText(ta, tb);
        if (!r.same) {
          entry.status = 'changed';
          entry.detail = Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'same'));
        }
      }
      out.summary[entry.status === 'same' ? 'same' : 'changed']++;
      if (entry.status !== 'same') out.files.push(entry);
    }
    return out;
  }

  const ticks = (o) => Object.entries(o).map(([k, n]) => k + ' ×' + n).join(', ');

  function toMarkdown(r) {
    const L = [];
    const tick = (s) => String(s).replace(/`/g, "'");
    L.push('# Export comparison', '');
    L.push('Compared `' + tick(r.a) + '` with `' + tick(r.b) + '`.', '');
    L.push('| Result | Files |', '| --- | --- |');
    for (const k of ['same', 'changed', 'added', 'removed', 'ignored']) L.push('| ' + k + ' | ' + r.summary[k] + ' |');
    L.push('');
    for (const status of ['added', 'removed', 'changed']) {
      const list = r.files.filter((f) => f.status === status);
      if (!list.length) continue;
      L.push('## ' + status[0].toUpperCase() + status.slice(1) + ' files', '');
      for (const f of list) {
        L.push('- `' + tick(f.path) + '` (' + f.kind + ')');
        const d = f.detail || {};
        if (d.tags) {
          const add = ticks(d.tags.added);
          const rem = ticks(d.tags.removed);
          if (add) L.push('  - Elements added: ' + add);
          if (rem) L.push('  - Elements removed: ' + rem);
        }
        if (d.text) {
          for (const t of d.text.added) L.push('  - Text added: "' + tick(t.text) + '"' + (t.count > 1 ? ' ×' + t.count : ''));
          for (const t of d.text.removed) L.push('  - Text removed: "' + tick(t.text) + '"' + (t.count > 1 ? ' ×' + t.count : ''));
          if (d.text.more) L.push('  - And ' + d.text.more + ' more text changes.');
        }
        if (d.added) for (const x of d.added) L.push('  - Rule added: `' + tick(x.selector) + '`');
        if (d.removed) for (const x of d.removed) L.push('  - Rule removed: `' + tick(x.selector) + '`');
        if (d.changed) for (const x of d.changed) L.push('  - Rule changed: `' + tick(x.selector) + '` from `' + tick(x.before) + '` to `' + tick(x.after) + '`');
        if (d.keysAdded && d.keysAdded.length) L.push('  - Fields added: ' + d.keysAdded.map((k) => '`' + tick(k) + '`').join(', '));
        if (d.keysRemoved && d.keysRemoved.length) L.push('  - Fields removed: ' + d.keysRemoved.map((k) => '`' + tick(k) + '`').join(', '));
        if (d.note) L.push('  - ' + d.note);
        if (d.sizeBefore != null) L.push('  - Size: ' + d.sizeBefore + ' → ' + d.sizeAfter + ' bytes');
        if (f.size != null) L.push('  - Size: ' + f.size + ' bytes');
      }
      L.push('');
    }
    if (!r.files.length) L.push('No differences in the compared files.', '');
    if (r.ignored.length) L.push('Not compared (they hold the export time): ' + r.ignored.map((p) => '`' + tick(p) + '`').join(', ') + '.', '');
    L.push('HTML is compared without whitespace, comments and DevForge ids. CSS is compared rule by rule. JSON is compared without time fields. Other files are compared by their SHA-256.', '');
    return L.join('\n');
  }

  return { compare, toMarkdown, normaliseHtml, cssRules, stripRoot, kindOf };
})();
if (typeof module !== 'undefined') module.exports = DFExportDiff;
