// Looks for credential-like values in files that are about to leave the panel (ZIPs, single files,
// AI prompts) and, if the user asks, masks them or leaves those files out. Pure: it takes and
// returns data and touches no browser API. A finding names the type, the file and the line. It never
// holds the value, so a finding list can be shown, copied or put in a report.
const DFExportGuard = (() => {
  const Probe = typeof DFSecProbe !== 'undefined' ? DFSecProbe : require('./secprobe.js');

  const WINDOW = 1000000;
  const OVERLAP = 4096; // longer than any single credential, so a value on a window edge is not missed
  const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
  const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|zip|gz|br|mp[34]|webm|ogg|wav|pdf|wasm)$/i;
  const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  const maskFor = (type) => '[REDACTED:' + type + ']';

  // The text of a file, or null for a file that is not text. String data counts as text.
  function textOf(file) {
    if (typeof file.data === 'string') return file.data;
    if (!(file.data instanceof Uint8Array) || BINARY.test(file.path || '')) return null;
    const head = file.data.subarray(0, 8192);
    if (head.includes(0)) return null;
    return dec.decode(file.data);
  }

  // Spans of one text, found window by window so a very large file is checked in full.
  function spansOf(text) {
    const found = [];
    const seen = new Set();
    for (let at = 0; ; at += WINDOW - OVERLAP) {
      for (const s of Probe.scanSecretSpans(text.slice(at, at + WINDOW))) {
        const start = at + s.start;
        if (seen.has(start)) continue;
        seen.add(start);
        found.push({ ...s, start, end: at + s.end });
      }
      if (at + WINDOW >= text.length) break;
    }
    // The key rule matches only the opening line. The key itself follows, so cover it up to the end line.
    for (const s of found) {
      if (s.type !== 'private-key-block') continue;
      PEM_END.lastIndex = s.end;
      const m = PEM_END.exec(text);
      s.end = m && m.index - s.end < 20000 ? m.index + m[0].length : Math.min(text.length, s.end + 4096);
    }
    found.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of found) {
      const last = merged[merged.length - 1];
      if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
      else merged.push(s);
    }
    return merged;
  }

  function lineOf(text, offset, cache) {
    if (!cache.starts) {
      cache.starts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) cache.starts.push(i + 1);
    }
    let lo = 0;
    let hi = cache.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cache.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - cache.starts[lo] + 1 };
  }

  const finding = (s, file, pos) => ({ type: s.type, label: s.label, severity: s.severity, file, line: pos.line, column: pos.column });

  // [{ path, data }] -> { findings, scanned, skipped }. Findings carry no value.
  function scan(files) {
    const findings = [];
    let scanned = 0;
    let skipped = 0;
    for (const f of files) {
      const text = textOf(f);
      if (text == null) {
        skipped++;
        continue;
      }
      scanned++;
      const spans = spansOf(text);
      const cache = {};
      for (const s of spans) findings.push(finding(s, f.path, lineOf(text, s.start, cache)));
    }
    return { findings, scanned, skipped };
  }

  function maskText(text) {
    let out = '';
    let last = 0;
    const spans = spansOf(text);
    for (const s of spans) {
      out += text.slice(last, s.start) + maskFor(s.type);
      last = s.end;
    }
    return { text: out + text.slice(last), count: spans.length };
  }

  const countBy = (findings, key) => {
    const o = {};
    for (const f of findings) o[f[key]] = (o[f[key]] || 0) + 1;
    return o;
  };

  // Markdown report for the ZIP. Type, file and line only.
  function reportMarkdown(result, mode) {
    const f = result.findings;
    const how = { mask: 'The values were replaced with [REDACTED:type].', keep: 'The files were left as they are. Treat this ZIP as sensitive.', omit: 'The files listed below were left out of the ZIP.' }[mode] || '';
    const rows = f.slice(0, 500).map((x) => '| ' + x.label + ' | ' + x.file + ' | ' + x.line + ' |');
    return [
      '# Secrets check',
      '',
      f.length + ' credential-like value(s) found in ' + new Set(f.map((x) => x.file)).size + ' file(s). ' + how,
      'These are matches on shape. Some may be public keys or examples, and some real secrets may not match any shape.',
      'The values are not written here.',
      '',
      '| Kind | File | Line |',
      '| --- | --- | --- |',
      ...rows,
      f.length > rows.length ? '\n…and ' + (f.length - rows.length) + ' more.' : '',
      '',
    ].join('\n');
  }

  const REPORT_PATH = '_devforge-secrets.md';

  // Applies the user's choice. mode: 'mask' | 'keep' | 'omit'. Adds the report file when anything was found.
  function apply(files, mode) {
    const result = scan(files);
    if (!result.findings.length) return { files, ...result, mode, masked: 0, omitted: [] };
    const bad = new Set(result.findings.map((x) => x.file));
    let out = files;
    let masked = 0;
    const omitted = [];
    if (mode === 'omit') {
      for (const f of files) if (bad.has(f.path)) omitted.push(f.path);
      out = files.filter((f) => !bad.has(f.path));
    } else if (mode === 'mask') {
      out = files.map((f) => {
        if (!bad.has(f.path)) return f;
        const m = maskText(textOf(f));
        masked += m.count;
        return { ...f, data: typeof f.data === 'string' ? m.text : enc.encode(m.text) };
      });
    }
    return { files: [...out, { path: REPORT_PATH, data: reportMarkdown(result, mode) }], ...result, mode, masked, omitted };
  }

  // The same for one piece of text, such as an AI prompt or a single exported file.
  function checkText(text, name = 'text') {
    return scan([{ path: name, data: String(text) }]);
  }

  // A short line for the dialog: "Stripe live secret key · js/app.js · line 12".
  const describe = (x) => x.label + ' · ' + x.file + ' · line ' + x.line;

  return { scan, apply, maskText, checkText, reportMarkdown, describe, countBy, textOf, REPORT_PATH };
})();
if (typeof module !== 'undefined') module.exports = DFExportGuard;
