// Minimal ZIP writer. build() stores files; buildAsync() also deflates them where the browser can.
// Entry names are made safe for extraction tools: no leading slash, no drive letters, no ".." segments, forward slashes only, and a repeated
// name gets a numeric suffix instead of silently producing two entries with the same path.
const DFZip = (() => {
  const T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const enc = new TextEncoder();
  // Control characters go first: some extractors stop reading a name at a NUL, so "a/..<NUL>b"
  // would be read as "a/..". Bidirectional overrides go too: "photo<RLO>gpj.exe" is drawn as
  // "photoexe.jpg". Windows ignores trailing dots and spaces, so ".. " would act as "..". Those are
  // cut from every segment before empty, "." and ".." segments are dropped. A colon becomes "_":
  // "c:x" would mean the current folder of drive C, and "a.txt:x" an alternate data stream on NTFS.
  const BAD_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g; // eslint-disable-line no-control-regex
  function cleanName(p) {
    const parts = String(p)
      .replace(BAD_CHARS, '')
      .replace(/\\/g, '/')
      .replace(/^[a-zA-Z]:/, '')
      .split('/')
      .map((s) => s.replace(/[. ]+$/, '').replace(/:/g, '_'))
      .filter((s) => s && s !== '.' && s !== '..');
    return parts.join('/') || 'file';
  }
  function uniqueNames(files) {
    const seen = new Set();
    return files.map((f) => {
      let name = cleanName(f.path);
      if (seen.has(name.toLowerCase())) {
        const m = /^(.*?)(\.[^./]*)?$/.exec(name);
        let n = 2;
        while (seen.has((m[1] + ' (' + n + ')' + (m[2] || '')).toLowerCase())) n++;
        name = m[1] + ' (' + n + ')' + (m[2] || '');
      }
      seen.add(name.toLowerCase());
      return name;
    });
  }
  // Files that are already compressed gain nothing from deflate and cost time.
  const ALREADY_PACKED = /\.(png|jpe?g|gif|webp|avif|heic|woff2?|zip|gz|tgz|br|bz2|xz|7z|rar|mp[34]|m4[av]|webm|ogg|opus|mov|pdf|jar|apk)$/i;

  // Deflate needs CompressionStream('deflate-raw'). Where it is missing the files are stored.
  function canDeflate() {
    try {
      if (typeof CompressionStream !== 'function' || typeof Response !== 'function' || typeof Blob !== 'function') return false;
      new CompressionStream('deflate-raw');
      return true;
    } catch (_) {
      return false;
    }
  }
  async function deflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // entries: [{ name: Uint8Array, data: Uint8Array (as stored in the file), crc, size, method }]
  function assemble(entries, date) {
    const chunks = [],
      central = [];
    let offset = 0;
    const now = date || new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const e of entries) {
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, e.method, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, e.crc, true);
      lh.setUint32(18, e.data.length, true);
      lh.setUint32(22, e.size, true);
      lh.setUint16(26, e.name.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), e.name, e.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, e.method, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, e.crc, true);
      ch.setUint32(20, e.data.length, true);
      ch.setUint32(24, e.size, true);
      ch.setUint16(28, e.name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), e.name);
      offset += 30 + e.name.length + e.data.length;
    }
    let csize = 0;
    central.forEach((c) => (csize += c.length));
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: 'application/zip',
    });
  }
  function prepare(files) {
    // files: [{path, data: string|Uint8Array}]
    if (files.length > 65534) throw new Error('Too many files for one ZIP (' + files.length + ').');
    const names = uniqueNames(files);
    return files.map((f, i) => {
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      return { name: enc.encode(names[i]), path: names[i], data, crc: crc32(data), size: data.length, method: 0 };
    });
  }
  // Stored, not compressed. Synchronous.
  function build(files, opts = {}) {
    return assemble(prepare(files), opts.date);
  }
  // Deflates every file that is worth it (not an already-compressed type, and smaller once packed).
  // Falls back to storing where CompressionStream is not available. Names, CRCs and sizes are the same
  // either way. opts.deflate = false stores everything. opts.date fixes the timestamp (for repeatable builds).
  async function buildAsync(files, opts = {}) {
    const entries = prepare(files);
    if (opts.deflate !== false && canDeflate()) {
      for (const e of entries) {
        if (e.size < 64 || ALREADY_PACKED.test(e.path)) continue;
        const packed = await deflate(e.data);
        if (packed.length < e.size) {
          e.data = packed;
          e.method = 8;
        }
      }
    }
    return assemble(entries, opts.date);
  }
  return { build, buildAsync, canDeflate, crc32 };
})();
if (typeof module !== 'undefined') module.exports = DFZip;
