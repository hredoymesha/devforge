/*
 * Owner / Security Admin mode: the cryptographic and policy core. Pure functions over WebCrypto,
 * testable in Node. It stores nothing and touches no extension API; panel/owner.js does that.
 *
 * What this is, honestly: a passphrase that the person using this browser profile chooses. It
 * proves that the person at the keyboard knows the passphrase and protects privileged data at rest
 * (it is encrypted with a key derived from the passphrase). It does NOT prove identity to any
 * website or server, and it cannot stop someone who can modify the extension's files or run code in
 * the extension's own pages while it is unlocked. See docs/OWNER-MODE.md for the full trust boundary.
 *
 *   passphrase --PBKDF2-SHA256 (600k iterations, random salt)--> 64 bytes
 *       first 32: verifier (stored, so a wrong passphrase can be rejected)
 *       last 32:  AES-GCM key (never stored; kept as a non-extractable CryptoKey while unlocked)
 */
const DFOwner = (() => {
  const nodeCrypto = typeof require === 'function' ? (() => { try { return require('node:crypto'); } catch (_) { return null; } })() : null;
  const webcrypto = globalThis.crypto || (nodeCrypto && nodeCrypto.webcrypto);
  const subtle = webcrypto.subtle;

  const KDF = { name: 'PBKDF2-SHA256', iterations: 600000, saltBytes: 16 };
  const MIN_PASSPHRASE = 12;
  const AAD = new TextEncoder().encode('devforge-owner-v1');
  const VAULT_VERSION = 1;

  class OwnerAuthError extends Error {
    constructor(message) {
      super(message);
      this.name = 'OwnerAuthError';
    }
  }
  class OwnerLockedError extends Error {
    constructor() {
      super('Owner mode is locked. Unlock it to use this.');
      this.name = 'OwnerLockedError';
    }
  }

  const b64 = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));

  /* ---------- passphrase policy ---------- */

  // Not a strength meter: it rejects the cases that are plainly too weak and says why.
  function checkPassphrase(pass) {
    const p = String(pass == null ? '' : pass);
    if (p.length < MIN_PASSPHRASE) return { ok: false, reason: 'Use at least ' + MIN_PASSPHRASE + ' characters. A few unrelated words work well.' };
    if (new Set(p).size < 5) return { ok: false, reason: 'That passphrase repeats too few different characters.' };
    if (/^(password|passphrase|qwerty|123456|letmein|devforge)/i.test(p) && p.length < 16) return { ok: false, reason: 'That is too easy to guess.' };
    return { ok: true, reason: '' };
  }

  /* ---------- key derivation ---------- */

  async function derive(pass, salt, iterations) {
    const material = await subtle.importKey('raw', new TextEncoder().encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 512));
    return { verifier: bits.slice(0, 32), keyBytes: bits.slice(32) };
  }
  const importKey = (bytes) => subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

  // Compares in time that does not depend on where the first difference is.
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  /* ---------- vault ---------- */

  // Returns the record to store and the unlocked key. The passphrase and the key are not in it.
  async function createVault(pass) {
    const check = checkPassphrase(pass);
    if (!check.ok) throw new OwnerAuthError(check.reason);
    const salt = random(KDF.saltBytes);
    const { verifier, keyBytes } = await derive(pass, salt, KDF.iterations);
    return {
      vault: { v: VAULT_VERSION, kdf: KDF.name, iterations: KDF.iterations, salt: b64(salt), verifier: b64(verifier), created: new Date().toISOString() },
      key: await importKey(keyBytes),
    };
  }

  async function unlock(pass, vault) {
    if (!vault || vault.v !== VAULT_VERSION || vault.kdf !== KDF.name) throw new OwnerAuthError('This owner record is not in a format this version understands.');
    // A stored value must not be able to weaken the derivation.
    if (!Number.isInteger(vault.iterations) || vault.iterations < KDF.iterations) throw new OwnerAuthError('This owner record uses a weaker setting than allowed.');
    const { verifier, keyBytes } = await derive(pass, unb64(vault.salt), vault.iterations);
    if (!sameBytes(verifier, unb64(vault.verifier))) throw new OwnerAuthError('That passphrase is not correct.');
    return importKey(keyBytes);
  }

  /* ---------- sealing data ---------- */

  // `context` is authenticated but not stored: opening fails unless the same text is supplied, so a
  // sealed record cannot be moved to another record id or have its plaintext labels changed.
  const aadFor = (context) => (context ? new TextEncoder().encode('devforge-owner-v1|' + context) : AAD);

  async function seal(key, value, context = '') {
    if (!key) throw new OwnerLockedError();
    const iv = random(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(context) }, key, new TextEncoder().encode(JSON.stringify(value))));
    return { v: 1, iv: b64(iv), ct: b64(ct) };
  }

  async function open(key, blob, context = '') {
    if (!key) throw new OwnerLockedError();
    if (!blob || blob.v !== 1 || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') throw new OwnerAuthError('This sealed record is not in a known format.');
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv), additionalData: aadFor(context) }, key, unb64(blob.ct));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (_) {
      // Wrong key and modified data look the same on purpose.
      throw new OwnerAuthError('This record could not be opened: it was sealed with a different passphrase or has been altered.');
    }
  }

  /* ---------- guessing limits ---------- */

  const LOCKOUT = { freeAttempts: 4, baseMs: 30000, maxMs: 15 * 60 * 1000 };
  const freshAttempts = () => ({ failures: 0, lockedUntil: 0 });

  const waitMs = (state, now = Date.now()) => Math.max(0, (state && state.lockedUntil) - now);

  // After four free mistakes each further one doubles the wait, up to 15 minutes.
  function registerFailure(state, now = Date.now()) {
    const failures = ((state && state.failures) || 0) + 1;
    const over = failures - LOCKOUT.freeAttempts;
    const wait = over > 0 ? Math.min(LOCKOUT.baseMs * 2 ** (over - 1), LOCKOUT.maxMs) : 0;
    return { failures, lockedUntil: wait ? now + wait : 0 };
  }

  /* ---------- redacting detailed technical data for export ---------- */

  const RISKY_HEADER_VALUE = /^(set-cookie|cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;

  /*
   * Detailed technical evidence is exported only through explicit choices. Defaults keep
   * everything out; each option adds one kind of detail. Header values that could carry credentials
   * are never included whatever the options say.
   */
  const EXPORT_DEFAULTS = { hostnames: false, paths: false, headerValues: false, requestLog: false, cookieNames: false };

  function redactTechnical(tech, options = {}) {
    const o = { ...EXPORT_DEFAULTS, ...options };
    const host = (s) => (o.hostnames ? s : String(s).replace(/^(https?:\/\/)?[^/\s]+/i, (m, scheme) => (scheme || '') + '[host]'));
    const path = (p) => (o.paths ? p : '[path]');
    const out = JSON.parse(JSON.stringify(tech || {}));
    if (out.target) out.target = host(out.target).split(/[?#]/)[0];
    if (out.responseHeaders) {
      out.responseHeaders = Object.fromEntries(
        Object.entries(out.responseHeaders)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, RISKY_HEADER_VALUE.test(k) || !o.headerValues ? '[value omitted]' : String(v).slice(0, 400)])
      );
    }
    if (out.requests) out.requests = o.requestLog ? out.requests.map((r) => ({ ...r, path: path(r.path) })) : { omitted: out.requests.length };
    if (out.probes) out.probes = out.probes.map((p) => ({ ...p, path: path(p.path) }));
    if (out.scripts) out.scripts = out.scripts.map((s) => ({ ...s, path: path(s.path) }));
    if (out.cookies) out.cookies = o.cookieNames ? out.cookies : { count: out.cookies.length };
    // Addresses keep host and path together, so each is cut down by both choices.
    const address = (u) => {
      const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(String(u));
      return m ? host(m[1]) + (o.paths ? m[2] || '/' : '/[path]') : path(u);
    };
    if (out.scriptAddresses) out.scriptAddresses = out.scriptAddresses.map(address);
    if (out.traffic && out.traffic.samples) out.traffic.samples = o.requestLog ? out.traffic.samples.map((s) => ({ ...s, url: address(s.url) })) : { omitted: out.traffic.samples.length };
    out.redaction = { applied: true, options: o, note: 'Cookie, storage and token values, secret values and response bodies are never part of technical data.' };
    return out;
  }

  return {
    KDF,
    MIN_PASSPHRASE,
    LOCKOUT,
    EXPORT_DEFAULTS,
    OwnerAuthError,
    OwnerLockedError,
    checkPassphrase,
    createVault,
    unlock,
    seal,
    open,
    freshAttempts,
    waitMs,
    registerFailure,
    redactTechnical,
  };
})();
if (typeof module !== 'undefined') module.exports = DFOwner;
