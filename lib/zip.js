// Minimal ZIP writer (stored, no compression). Entry names are made safe for extraction tools:
// no leading slash, no drive letters, no ".." segments, forward slashes only, and a repeated
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
  function cleanName(p) {
    const parts = String(p)
      .replace(/\\/g, '/')
      .replace(/^[a-zA-Z]:/, '')
      .split('/')
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
  function build(files) {
    // files: [{path, data: string|Uint8Array}]
    const chunks = [],
      central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const names = uniqueNames(files);
    if (files.length > 65534) throw new Error('Too many files for one ZIP (' + files.length + ').');
    for (const [fi, f] of files.entries()) {
      const name = enc.encode(names[fi]);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    let csize = 0;
    central.forEach((c) => (csize += c.length));
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: 'application/zip',
    });
  }
  return { build, crc32 };
})();
if (typeof module !== 'undefined') module.exports = DFZip;
