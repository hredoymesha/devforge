#!/usr/bin/env node
// Builds the release files: DevForge-<version>-extension.zip (only what Chrome loads) and
// DevForge-<version>-source.zip (the repository), each with a .sha256 file.
//   npm run package [-- --out <dir>]
// Files are stored, not compressed, in sorted order with one fixed timestamp, so two runs on the same
// files give the same bytes and the same checksum, on any machine. Nothing is uploaded or published.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DFZip = require('../lib/zip.js');

const root = path.resolve(__dirname, '..');
const EXTENSION = ['manifest.json', 'background.js', 'sidepanel.html', 'sidepanel.css', 'agent.js', 'netcap.js', 'netbridge.js', 'sandbox.html', 'sandbox.js', 'agent', 'lib', 'panel', 'icons'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'release-out', 'dist', 'build', 'coverage']);
const SKIP_FILE = /\.(zip|crx|pem|log|bak)$|^\.env|^\.DS_Store$|^Thumbs\.db$/i;
const STAMP = new Date(2026, 0, 1, 0, 0, 0); // local fields, so the DOS time is the same everywhere

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, out);
    } else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(r);
  }
  return out;
}

function version() {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('manifest.json has no usable version: ' + v);
  return v;
}

function extensionFiles() {
  const out = [];
  for (const item of EXTENSION) {
    const full = path.join(root, item);
    if (!fs.existsSync(full)) throw new Error('missing from the extension: ' + item);
    if (fs.statSync(full).isDirectory()) walk(item, item, out);
    else out.push(item);
  }
  return out.sort();
}

async function writeZip(outDir, name, entries) {
  const files = entries.map((e) => ({ path: e.zipPath, data: new Uint8Array(fs.readFileSync(path.join(root, e.file))) }));
  const blob = await DFZip.buildAsync(files, { deflate: false, date: STAMP });
  const buf = Buffer.from(await blob.arrayBuffer());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), buf);
  const sum = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(outDir, name + '.sha256'), sum + '  ' + name + '\n');
  return { name, sha256: sum, bytes: buf.length, files: files.length };
}

async function main(argv = process.argv.slice(2)) {
  const outDir = path.resolve(root, argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'release-out');
  const desc = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).description;
  if (desc.length > 132) throw new Error('manifest description is ' + desc.length + ' characters (limit 132)');
  const v = version();
  const ext = extensionFiles().map((f) => ({ file: f, zipPath: f }));
  const src = walk('.', '', []).sort().map((f) => ({ file: f, zipPath: 'devforge/' + f }));
  const results = [await writeZip(outDir, `DevForge-${v}-extension.zip`, ext), await writeZip(outDir, `DevForge-${v}-source.zip`, src)];
  for (const r of results) console.log(r.name + '  ' + r.files + ' files  ' + r.bytes + ' bytes  sha256 ' + r.sha256);
  return results;
}

if (require.main === module) {
  main().catch((e) => {
    console.error('✗ ' + e.message);
    process.exit(1);
  });
}
module.exports = { main, extensionFiles, EXTENSION };
