// Encrypted exports. A ZIP is sealed with a key from a passphrase: PBKDF2-SHA256 with a random salt,
// then AES-GCM with a random IV. The header (format, KDF settings, IV, time) is authenticated, so an
// edit to any of it fails to open the file. Opening gives the whole plaintext or an error, never part
// of it. Pure WebCrypto; tools/decrypt.html uses the same code offline.
const DFEncExport = (() => {
  const FORMAT = 'devforge-encrypted-export';
  const VERSION = 1;
  const ITERATIONS = 600000;
  const ITER_MIN = 100000;
  const ITER_MAX = 2000000;
  const MIN_PASSPHRASE = 12;
  const MAX_FILE_CHARS = 400 * 1024 * 1024;
  const WRONG = 'The passphrase is wrong, or the file was changed. Nothing was decrypted.';
  const nodeCrypto = typeof require === 'function' ? (() => { try { return require('node:crypto'); } catch (_) { return null; } })() : null;
  const webcrypto = globalThis.crypto || (nodeCrypto && nodeCrypto.webcrypto);
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();

  const toB64 = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(bin);
  };
  const fromB64 = (text) => {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('This file is damaged: a value is not base64.');
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  };

  // The header as the authenticated data. The field order is fixed, so both sides build the same bytes.
  const aadOf = (h) => enc.encode(JSON.stringify([FORMAT, VERSION, h.kdf.name, h.kdf.hash, h.kdf.iterations, h.kdf.salt, h.cipher.name, h.cipher.iv, h.created]));

  async function keyFor(passphrase, salt, iterations) {
    const material = await subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // bytes: the ZIP as a Uint8Array. Returns the file text (JSON).
  async function encrypt(bytes, passphrase) {
    if (String(passphrase).length < MIN_PASSPHRASE) throw new Error('Use a passphrase of at least ' + MIN_PASSPHRASE + ' characters.');
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const header = {
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
      cipher: { name: 'AES-GCM', iv: toB64(iv) },
      created: new Date().toISOString(),
    };
    const key = await keyFor(passphrase, salt, ITERATIONS);
    const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(header), tagLength: 128 }, key, bytes));
    return (
      JSON.stringify(
        {
          format: FORMAT,
          version: VERSION,
          kdf: header.kdf,
          cipher: header.cipher,
          created: header.created,
          data: toB64(data),
          note: 'Open this file with tools/decrypt.html in the DevForge source folder, or with any tool that supports PBKDF2-SHA256 and AES-GCM.',
        },
        null,
        2
      ) + '\n'
    );
  }

  // text: the file's text. Returns the plaintext bytes, or throws one message.
  async function decrypt(text, passphrase) {
    if (String(text).length > MAX_FILE_CHARS) throw new Error('This file is too large to open here.');
    let h;
    try {
      h = JSON.parse(String(text));
    } catch (_) {
      throw new Error('This is not a DevForge encrypted export.');
    }
    if (!h || h.format !== FORMAT) throw new Error('This is not a DevForge encrypted export.');
    if (h.version !== VERSION) throw new Error('This file uses version ' + h.version + ' of the format. This tool reads version ' + VERSION + '.');
    if (!h.kdf || h.kdf.name !== 'PBKDF2' || h.kdf.hash !== 'SHA-256') throw new Error('This file uses a key method this tool does not support.');
    if (!h.cipher || h.cipher.name !== 'AES-GCM') throw new Error('This file uses a cipher this tool does not support.');
    if (!Number.isInteger(h.kdf.iterations) || h.kdf.iterations < ITER_MIN || h.kdf.iterations > ITER_MAX) throw new Error('This file asks for an unusual number of key rounds. It was not opened.');
    if (typeof h.created !== 'string' || typeof h.data !== 'string') throw new Error('This file is damaged: parts are missing.');
    const salt = fromB64(h.kdf.salt);
    const iv = fromB64(h.cipher.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error('This file is damaged: the salt or IV has the wrong length.');
    const data = fromB64(h.data);
    const key = await keyFor(passphrase, salt, h.kdf.iterations);
    try {
      return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadOf(h), tagLength: 128 }, key, data));
    } catch (_) {
      throw new Error(WRONG);
    }
  }

  // The file name for the decrypted copy: the encrypted name without its last extension.
  const plainName = (name) => String(name || 'export').replace(/\.devforge-enc$/i, '') || 'export';

  return { encrypt, decrypt, plainName, FORMAT, VERSION, MIN_PASSPHRASE, ITERATIONS, WRONG };
})();
if (typeof module !== 'undefined') module.exports = DFEncExport;
