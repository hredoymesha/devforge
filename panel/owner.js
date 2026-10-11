// Owner / Security Admin mode: local, passphrase-gated access to detailed technical diagnostics.
// Read docs/OWNER-MODE.md for the trust boundary. In short: this protects privileged data from
// pages and from other people using this browser profile; it does not prove identity to anyone
// else, and it never changes what a scan may do (limits and target authorisation are unchanged).
//
// The guard is DFOwnerSession, not the tab: the unlocked key exists only inside that closure and
// every privileged read or write goes through a method that throws when the mode is locked.

const OWNER_VAULT_KEY = 'ownerVault'; // { vault, attempts } in chrome.storage.local
const OWNER_SEALED_KEY = 'ownerSealed'; // { index: <sealed list>, items: { id: <sealed technical> } }
const OWNER_IDLE_CHOICES = [5, 10, 30, 60]; // minutes; the default is the middle-short one
const OWNER_IDLE_DEFAULT = 10;
const OWNER_PREFS_KEY = 'ownerPrefs'; // { idleMinutes } in chrome.storage.local (not secret)
const OWNER_ORIGINS_KEY = 'ownerOrigins'; // sealed list of origins the owner has attested for
const OWNER_MAX_ORIGINS = 50;
const OWNER_MAX_SEALED = 20;
const OWNER_WORKSPACE_KEY = 'ownerWorkspace'; // { enabled: true, since } in chrome.storage.local

// Scan approvals that came from an authorised site (not from the person ticking the box) last only
// while Owner mode is open: locking removes them again.
const OWNER_GRANTS_KEY = 'secOwnerGranted';
async function ownerDropGrants() {
  const grants = (await chrome.storage.session.get(OWNER_GRANTS_KEY))[OWNER_GRANTS_KEY];
  if (!grants || !Object.keys(grants).length) return;
  const acks = (await chrome.storage.session.get(SEC_ACK_KEY))[SEC_ACK_KEY];
  const map = acks && !Array.isArray(acks) ? acks : {};
  for (const origin of Object.keys(grants)) if (map[origin] === 'confirm') delete map[origin];
  await chrome.storage.session.set({ [SEC_ACK_KEY]: map });
  await chrome.storage.session.remove(OWNER_GRANTS_KEY);
}

const DFOwnerSession = (() => {
  let key = null; // non-extractable CryptoKey, present only while unlocked
  let timer = null;
  let events = []; // diagnostic events, kept in memory and only while unlocked
  let wsActive = false; // cached copy of the stored Workspace-encryption switch
  let idleMs = OWNER_IDLE_DEFAULT * 60 * 1000;
  const listeners = new Set();

  const notify = () => listeners.forEach((f) => f());
  const arm = () => {
    clearTimeout(timer);
    if (key) timer = setTimeout(lock, idleMs);
  };
  function lock() {
    key = null;
    events = [];
    clearTimeout(timer);
    ownerDropGrants().catch((e) => console.warn('DevForge: could not clear Owner-granted scan approvals', e.message));
    notify();
  }
  // Every privileged operation starts here.
  function need() {
    if (!key) throw new DFOwner.OwnerLockedError();
    arm();
    return key;
  }
  const readStore = async () => (await chrome.storage.local.get(OWNER_VAULT_KEY))[OWNER_VAULT_KEY] || null;
  const readSealed = async () => (await chrome.storage.local.get(OWNER_SEALED_KEY))[OWNER_SEALED_KEY] || { index: null, items: {} };

  async function readIndex() {
    const s = await readSealed();
    return s.index ? await DFOwner.open(need(), s.index) : [];
  }

  return {
    isUnlocked: () => key !== null,
    onChange: (f) => (listeners.add(f), () => listeners.delete(f)),
    lock,
    touch: arm,

    exists: async () => !!(await readStore()),
    async waitMs() {
      const st = await readStore();
      return st ? DFOwner.waitMs(st.attempts) : 0;
    },

    async setup(pass) {
      if (await readStore()) throw new DFOwner.OwnerAuthError('Owner mode is already set up on this profile.');
      const made = await DFOwner.createVault(pass);
      await chrome.storage.local.set({ [OWNER_VAULT_KEY]: { vault: made.vault, attempts: DFOwner.freshAttempts() } });
      key = made.key;
      arm();
      notify();
    },

    async unlock(pass) {
      const st = await readStore();
      if (!st) throw new DFOwner.OwnerAuthError('Owner mode has not been set up.');
      const wait = DFOwner.waitMs(st.attempts);
      if (wait > 0) throw new DFOwner.OwnerAuthError('Too many wrong attempts. Try again in ' + Math.ceil(wait / 1000) + ' seconds.');
      try {
        key = await DFOwner.unlock(pass, st.vault);
      } catch (e) {
        if (e instanceof DFOwner.OwnerAuthError && /not correct/.test(e.message)) {
          st.attempts = DFOwner.registerFailure(st.attempts);
          await chrome.storage.local.set({ [OWNER_VAULT_KEY]: st });
          const w = DFOwner.waitMs(st.attempts);
          throw new DFOwner.OwnerAuthError('That passphrase is not correct.' + (w ? ' Further attempts are delayed for ' + Math.ceil(w / 1000) + ' seconds.' : ''));
        }
        throw e;
      }
      st.attempts = DFOwner.freshAttempts();
      await chrome.storage.local.set({ [OWNER_VAULT_KEY]: st });
      arm();
      notify();
    },

    // Destroys the vault and everything sealed with it. It cannot reveal anything.
    // Sealed Workspace items are left in place (unreadable without the old passphrase) rather than
    // deleted, and new items are stored plainly again; the Workspace tab lists them as sealed.
    async reset() {
      await chrome.storage.local.remove([OWNER_VAULT_KEY, OWNER_SEALED_KEY, OWNER_WORKSPACE_KEY, OWNER_ORIGINS_KEY, OWNER_PREFS_KEY]);
      idleMs = OWNER_IDLE_DEFAULT * 60 * 1000;
      wsActive = false;
      lock();
    },

    /* ---- idle timeout ---- */
    idleMinutes: () => Math.round(idleMs / 60000),
    async setIdleMinutes(m) {
      if (!OWNER_IDLE_CHOICES.includes(m)) throw new Error('Choose one of ' + OWNER_IDLE_CHOICES.join(', ') + ' minutes.');
      need();
      idleMs = m * 60 * 1000;
      await chrome.storage.local.set({ [OWNER_PREFS_KEY]: { idleMinutes: m } });
      arm();
    },

    /* ---- authorised origins ----
     * A standing, written-down version of the per-scan "I own this site or have permission"
     * checkbox, for the owner who works on several sites. It is sealed with the owner key, so it is
     * ignored while locked and cannot be added to by a page or by editing storage. It does not change
     * what a scan may do: limits, same-origin scope and the Advanced confirmation are unchanged. */
    async originsList() {
      const k = need();
      const blob = (await chrome.storage.local.get(OWNER_ORIGINS_KEY))[OWNER_ORIGINS_KEY];
      return blob ? await DFOwner.open(k, blob, 'origins') : [];
    },
    async authorizeOrigin(input, attested) {
      const k = need();
      if (!attested) throw new Error('Confirm that you own this site or have permission to run security checks on it.');
      let u;
      try {
        u = new URL(String(input).trim());
      } catch (_) {
        throw new Error('Enter a full address such as https://staging.example.com');
      }
      if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https sites can be authorised.');
      const list = await this.originsList();
      if (list.some((o) => o.origin === u.origin)) return list;
      if (list.length >= OWNER_MAX_ORIGINS) throw new Error('At most ' + OWNER_MAX_ORIGINS + ' sites can be authorised. Remove one first.');
      list.push({ origin: u.origin, at: new Date().toISOString() });
      await chrome.storage.local.set({ [OWNER_ORIGINS_KEY]: await DFOwner.seal(k, list, 'origins') });
      this.record({ event: 'origin authorised', detail: u.origin });
      return list;
    },
    async revokeOrigin(origin) {
      const k = need();
      const list = (await this.originsList()).filter((o) => o.origin !== origin);
      await chrome.storage.local.set({ [OWNER_ORIGINS_KEY]: await DFOwner.seal(k, list, 'origins') });
      this.record({ event: 'origin revoked', detail: origin });
      return list;
    },
    // True only while unlocked and only for an exact origin match. Never throws: a locked or
    // unreadable list simply means "not authorised", so the ordinary confirmation applies.
    async originAuthorized(origin) {
      if (!key) return null;
      try {
        return (await this.originsList()).find((o) => o.origin === origin) || null;
      } catch (_) {
        return null;
      }
    },

    /* ---- Workspace encryption (see lib/wsseal.js) ---- */
    async workspaceInit() {
      const prefs = (await chrome.storage.local.get(OWNER_PREFS_KEY))[OWNER_PREFS_KEY];
      if (prefs && OWNER_IDLE_CHOICES.includes(prefs.idleMinutes)) idleMs = prefs.idleMinutes * 60 * 1000;
      wsActive = !!((await chrome.storage.local.get(OWNER_WORKSPACE_KEY))[OWNER_WORKSPACE_KEY] || {}).enabled;
      DFStore.setCodec({
        active: () => wsActive,
        canOpen: () => key !== null,
        seal: (item) => DFWsSeal.sealItem(need(), item),
        reveal: (rec) => DFWsSeal.revealItem(need(), rec),
      });
    },
    workspaceActive: () => wsActive,
    async workspaceStatus() {
      const raw = await DFStore.rawItems();
      const sealed = raw.filter(DFWsSeal.isSealed).length;
      return { enabled: wsActive, total: raw.length, sealed, plain: raw.length - sealed };
    },
    // Encrypts every existing item. Each one is read back and compared before its plaintext record
    // is replaced, so a failure leaves that record as it was. Items already sealed are skipped.
    async workspaceSealAll(onProgress) {
      const k = need();
      await chrome.storage.local.set({ [OWNER_WORKSPACE_KEY]: { enabled: true, since: Date.now() } });
      wsActive = true;
      const raw = await DFStore.rawItems();
      let done = 0;
      for (const rec of raw) {
        if (!DFWsSeal.isSealed(rec)) {
          const sealed = await DFWsSeal.sealItem(k, rec);
          const back = await DFWsSeal.revealItem(k, sealed);
          if (DFWsSeal.canonical(back) !== DFWsSeal.canonical(rec)) throw new Error('Could not verify the encrypted copy of "' + (rec.title || rec.id) + '"; nothing was changed for it.');
          await DFStore.putRaw(sealed);
        }
        if (onProgress) onProgress(++done, raw.length);
      }
    },
    // Turns encryption off and writes every item back as plain data. Needs the passphrase.
    async workspaceUnsealAll(onProgress) {
      const k = need();
      const raw = await DFStore.rawItems();
      let done = 0;
      for (const rec of raw) {
        if (DFWsSeal.isSealed(rec)) await DFStore.putRaw(await DFWsSeal.revealItem(k, rec));
        if (onProgress) onProgress(++done, raw.length);
      }
      await chrome.storage.local.remove(OWNER_WORKSPACE_KEY);
      wsActive = false;
    },

    /* ---- sealed technical diagnostics ---- */
    async sealTechnical(id, meta, technical) {
      const k = need();
      const store = await readSealed();
      const index = (store.index ? await DFOwner.open(k, store.index) : []).filter((m) => m.id !== id);
      index.unshift({ id, ...meta });
      store.items = store.items || {};
      store.items[id] = await DFOwner.seal(k, technical);
      for (const old of index.splice(OWNER_MAX_SEALED)) delete store.items[old.id];
      store.index = await DFOwner.seal(k, index);
      await chrome.storage.local.set({ [OWNER_SEALED_KEY]: store });
    },
    listTechnical: () => readIndex(),
    async openTechnical(id) {
      const k = need();
      const store = await readSealed();
      if (!store.items || !store.items[id]) throw new Error('That technical record no longer exists.');
      return DFOwner.open(k, store.items[id]);
    },
    async deleteTechnical(id) {
      const k = need();
      const store = await readSealed();
      const index = (store.index ? await DFOwner.open(k, store.index) : []).filter((m) => m.id !== id);
      if (store.items) delete store.items[id];
      store.index = await DFOwner.seal(k, index);
      await chrome.storage.local.set({ [OWNER_SEALED_KEY]: store });
    },
    // How many sealed records exist. Visible without the passphrase on purpose: it is only a count.
    async sealedCount() {
      const s = await readSealed();
      return Object.keys(s.items || {}).length;
    },

    /* ---- in-memory diagnostic log ---- */
    record(event) {
      if (!key) return; // nothing is recorded while locked
      events.push({ at: new Date().toISOString(), ...event });
      if (events.length > 300) events.splice(0, events.length - 300);
    },
    log() {
      need();
      return events.slice();
    },
  };
})();

/* ---------- safe inspection of the extension's own state ---------- */

async function ownerExtensionState() {
  const perms = await chrome.permissions.getAll();
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const [localBytes, sessionBytes] = await Promise.all([chrome.storage.local.getBytesInUse(null), chrome.storage.session.getBytesInUse(null)]);
  const session = await chrome.storage.session.get(null);
  const items = await DFStore.allItems().catch(() => []);
  let capture;
  try {
    capture = (await netCall('ping')) === 'pong' ? 'connected on this tab' : 'not connected on this tab';
  } catch (e) {
    capture = 'unavailable (' + e.message + ')';
  }
  const m = chrome.runtime.getManifest();
  return {
    'Extension version': m.version,
    'Page agent version': String(AGENT_VERSION),
    'Granted permissions': (perms.permissions || []).join(', ') || '–',
    'Granted site access': (perms.origins || []).join(', ') || 'none beyond the active tab',
    'Registered content scripts': scripts.length ? scripts.map((s) => s.id + ' (' + s.matches.join(', ') + ')').join('; ') : 'none',
    'Network capture': capture,
    // Names only. The values include capture keys and are never shown.
    'Session storage keys': Object.keys(session).join(', ') || 'none',
    'Local storage in use': fmtBytes(localBytes),
    'Session storage in use': fmtBytes(sessionBytes),
    'Workspace items': String(items.length),
    'Sealed technical records': String(await DFOwnerSession.sealedCount()),
  };
}

// Runs inside the page's own world, like an untrusted script, and reports what it could see.
function ownerPageIsolationProbe() {
  // The pre-4.1 global name is built from pieces so that no source file spells it out (check.js).
  const out = { dfNetGlobal: typeof window['__df' + 'Net'], agentGlobal: typeof window.__DF, keyHolderGlobal: typeof globalThis.__dfNetKey, entryPoints: 0, answeredWithoutSecret: false };
  for (const k of Object.getOwnPropertyNames(window)) {
    if (!/^_[0-9a-f]{20}$/.test(k)) continue;
    let f;
    try {
      f = window[k];
    } catch (_) {
      continue;
    }
    if (typeof f !== 'function') continue;
    out.entryPoints++;
    for (const cmd of ['changes', 'get', 'captured', 'ruleHits', 'ping'])
      try {
        if (f('not-the-secret', cmd, 0) !== undefined) out.answeredWithoutSecret = true;
      } catch (_) {
        /* a throwing entry point reveals nothing either */
      }
  }
  return out;
}

/* ---------- the tab ---------- */

const ownerBadge = (kind, text) => h('span', { class: 'sec-badge sec-' + kind }, text);

function ownerIntroCard() {
  return h(
    'details',
    { class: 'card intro', open: true },
    h('summary', null, icon('owner', 15), ' ', h('b', null, 'About Owner mode')),
    h('p', null, 'Owner mode adds detailed technical diagnostics for the person who runs DevForge and is authorised to assess a site: how each scan ran, what the target answered, and the state of the extension itself.'),
    h(
      'ul',
      null,
      h('li', null, 'It is protected by a passphrase you choose. Detailed data is encrypted with a key made from it, so other people using this browser profile, and web pages, cannot read it.'),
      h('li', null, 'It does not prove who you are to any website or server, and it cannot protect against someone who can change DevForge’s files or run code in its own pages while it is unlocked.'),
      h('li', null, 'It never raises scan limits, skips the ownership confirmation for public sites, or lets DevForge reach anything it could not before. Secrets, cookie and token values and response bodies are never collected.'),
      h('li', null, 'Nothing is sent anywhere. If you forget the passphrase the sealed data cannot be recovered; you can only reset it.')
    )
  );
}

function ownerFormRow(label, input) {
  return h('label', { class: 'sec-filter' }, label, input);
}

async function ownerSetupView(box) {
  const pass = h('input', { type: 'password', id: 'owner-pass', autocomplete: 'new-password', 'aria-describedby': 'owner-msg' });
  const again = h('input', { type: 'password', id: 'owner-pass2', autocomplete: 'new-password' });
  const ack = h('input', { type: 'checkbox', id: 'owner-ack' });
  const msg = h('div', { id: 'owner-msg', role: 'alert', class: 'sev-error' });
  const go = h('button', { class: 'primary' }, 'Set up Owner mode');
  go.addEventListener(
    'click',
    guard(async () => {
      msg.textContent = '';
      const check = DFOwner.checkPassphrase(pass.value);
      if (!check.ok) return (msg.textContent = check.reason), pass.focus();
      if (pass.value !== again.value) return (msg.textContent = 'The two passphrases do not match.'), again.focus();
      if (!ack.checked) return (msg.textContent = 'Please confirm that you understand there is no recovery.'), ack.focus();
      go.disabled = true;
      status('Setting up…');
      try {
        await DFOwnerSession.setup(pass.value);
        status('');
        toast('Owner mode is set up and unlocked');
      } catch (e) {
        msg.textContent = e.message;
      } finally {
        go.disabled = false;
        pass.value = again.value = '';
      }
    })
  );
  box.append(
    ownerIntroCard(),
    h(
      'div',
      { class: 'card' },
      h('b', null, 'Choose an owner passphrase'),
      h('p', { class: 'sev-info' }, 'At least 12 characters; a few unrelated words work well. Do not reuse a password from elsewhere. It is never stored, only a salted hash used to check it.'),
      ownerFormRow('Passphrase', pass),
      ownerFormRow('Repeat passphrase', again),
      h('label', { class: 'sec-ack', for: 'owner-ack' }, ack, ' I understand that a forgotten passphrase cannot be recovered and that resetting deletes the sealed data.'),
      msg,
      h('div', { class: 'row' }, go)
    )
  );
}

async function ownerLockedView(box) {
  const pass = h('input', { type: 'password', id: 'owner-pass', autocomplete: 'current-password', 'aria-describedby': 'owner-msg' });
  const msg = h('div', { id: 'owner-msg', role: 'alert', class: 'sev-error' });
  const go = h('button', { class: 'primary' }, icon('owner', 14), ' Unlock');
  const wait = await DFOwnerSession.waitMs();
  if (wait > 0) msg.textContent = 'Too many wrong attempts. Try again in ' + Math.ceil(wait / 1000) + ' seconds.';
  const submit = guard(async () => {
    msg.textContent = '';
    go.disabled = true;
    status('Unlocking…');
    try {
      await DFOwnerSession.unlock(pass.value);
      status('');
    } catch (e) {
      status('');
      msg.textContent = e.message;
      pass.focus();
    } finally {
      go.disabled = false;
      pass.value = '';
    }
  });
  go.addEventListener('click', submit);
  pass.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const count = await DFOwnerSession.sealedCount();
  box.append(
    ownerIntroCard(),
    h(
      'div',
      { class: 'card' },
      h('b', null, 'Owner mode is locked'),
      h('p', { class: 'sev-info' }, count ? count + ' sealed technical record' + (count === 1 ? '' : 's') + ' are stored. They stay unreadable until you unlock.' : 'Unlock to see technical diagnostics.'),
      ownerFormRow('Passphrase', pass),
      msg,
      h('div', { class: 'row' }, go)
    ),
    h(
      'details',
      { class: 'card' },
      h('summary', null, 'Forgot the passphrase?'),
      h('p', null, 'It cannot be recovered or bypassed. Resetting deletes the owner passphrase and every sealed technical record on this browser profile. Settings and Workspace items that are not encrypted are not touched. If Workspace encryption is on, its encrypted items stay in the database but can never be opened again.'),
      h('button', { class: 'danger', on: { click: async () => {
        const ws = await DFOwnerSession.workspaceStatus();
        if (ws.sealed > 0) {
          const typed = prompt(ws.sealed + ' encrypted Workspace item(s) will become permanently unreadable.\nTo continue, type RESET exactly:');
          if (typed !== 'RESET') return toast('Reset cancelled; nothing was changed');
        } else if (!confirm('Delete the owner passphrase and all sealed technical records? This cannot be undone.')) return;
        await DFOwnerSession.reset();
        toast('Owner mode was reset');
      } } }, 'Reset Owner mode')
    )
  );
}

const OWNER_EXPORT_LABELS = {
  hostnames: 'Include host names',
  paths: 'Include request and file paths',
  headerValues: 'Include header values (credential-bearing headers are always omitted)',
  requestLog: 'Include the full request log',
  cookieNames: 'Include cookie names and flags',
};

function ownerTechnicalDetail(tech) {
  const opts = { ...DFOwner.EXPORT_DEFAULTS };
  const preview = h('div');
  const draw = () => {
    clear(preview);
    const t = tech;
    preview.append(
      section('Scan configuration', kv({ Target: t.target, Level: t.level, 'Request budget': t.budget ? t.budget.maxRequests + ', pause ' + t.budget.delayMs + ' ms' : '–', Duration: t.durationMs + ' ms', Generated: t.generatedAt, 'Extension': (t.environment || {}).extensionVersion || '–', Browser: (t.environment || {}).userAgent || '–' })),
      section('Check timings', table(['Check', 'Result', 'Requests', 'Time', 'Note'], t.checks.map((c) => [c.id, c.state, c.requests, c.ms == null ? '–' : c.ms + ' ms', h('span', { class: 'sev-info' }, c.reason)]))),
      t.responseHeaders ? section('Response headers of the page (' + (t.headerRequest.method || '') + ' ' + (t.headerRequest.status || '') + ')', kv(Object.fromEntries(Object.entries(t.responseHeaders).map(([k, v]) => [k, v == null ? 'absent' : v])))) : h('div', { class: 'sev-info' }, 'Response headers were not collected: ' + ((t.headerRequest && t.headerRequest.error) || '')),
      t.contentSecurityPolicy ? section('Content-Security-Policy, by directive', h('ul', null, t.contentSecurityPolicy.map((d) => h('li', null, mono(d))))) : '',
      t.baseline ? section('Missing-path baseline', kv({ Status: t.baseline.status, Type: t.baseline.type, 'Content fingerprint': t.baseline.fingerprint })) : '',
      section('Path probes (' + t.probes.length + ')', t.probes.length ? table(['Probe', 'Path', 'Status', 'Type', 'Bytes', 'Matched'], t.probes.map((p) => [p.id, mono(p.path), p.status || p.error || '–', p.type, p.bytes, p.matched ? 'yes' : 'no'])) : h('div', { class: 'sev-info' }, 'No probes ran at this level.')),
      section('Scripts read (' + t.scripts.length + ')', t.scripts.length ? table(['Path', 'Bytes', 'Fingerprint', 'Source map'], t.scripts.map((s) => [mono(s.path), s.bytes, s.fingerprint, s.sourceMap ? (s.sourceMap.exposed ? 'readable' : 'HTTP ' + s.sourceMap.status) : 'none'])) : h('div', { class: 'sev-info' }, 'None read.')),
      section('Cookies seen (names and flags only)', t.cookies.length ? table(['Name', 'Secure', 'HttpOnly', 'SameSite'], t.cookies.map((c) => [c.name, String(c.secure), String(c.httpOnly), String(c.sameSite)])) : h('div', { class: 'sev-info' }, 'None.')),
      t.traffic ? section('Observed traffic (' + t.traffic.count + ')', table(['Method', 'Address', 'Status'], t.traffic.samples.map((s) => [s.method, mono(s.url), s.status]))) : '',
      section('Requests this scan made (' + t.requests.length + ')', table(['Method', 'Path', 'Result', 'Purpose'], t.requests.map((r) => [r.method, mono(r.path), r.status || r.note || '', r.purpose || '']))),
      section('Limits in force', kv({ 'Hard request ceiling': t.limits.hardMaxRequests, 'Minimum pause': t.limits.hardMinDelayMs + ' ms', Note: t.limits.note }))
    );
  };
  draw();
  const name = 'devforge-technical-' + slug(tech.target || 'scan') + '-' + stamp();
  return h(
    'div',
    null,
    preview,
    section(
      'Export with redaction controls',
      h('p', { class: 'sev-info' }, 'Everything below is off by default. Secret values, cookie and storage values, tokens and response bodies are never part of this data.'),
      Object.entries(OWNER_EXPORT_LABELS).map(([k, label]) => h('label', { class: 'sec-ack' }, h('input', { type: 'checkbox', checked: opts[k], on: { change: (e) => (opts[k] = e.target.checked) } }), ' ' + label)),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', on: { click: () => download(name + '.json', JSON.stringify(DFOwner.redactTechnical(tech, opts), null, 2), 'application/json') } }, icon('download', 14), ' Download redacted .json'),
        h('button', { on: { click: () => copy(JSON.stringify(DFOwner.redactTechnical(tech, opts), null, 2)) } }, icon('copy', 14), ' Copy redacted .json')
      )
    )
  );
}

function ownerPlanner() {
  const level = h('select', { 'aria-label': 'Scan level' }, ['passive', 'standard', 'advanced'].map((l) => h('option', { value: l, selected: l === 'standard' }, DFSecScan.LEVELS[l].label)));
  const max = h('input', { type: 'number', min: 3, max: DFSecScan.HARD_MAX_REQUESTS, placeholder: 'level default', 'aria-label': 'Maximum requests' });
  const delay = h('input', { type: 'number', min: DFSecScan.HARD_MIN_DELAY_MS, step: 50, placeholder: 'level default', 'aria-label': 'Pause in milliseconds' });
  const scripts = h('input', { type: 'number', min: 0, max: 100, value: 8, 'aria-label': 'Number of scripts on the page' });
  const out = h('div', { role: 'status', 'aria-live': 'polite' });
  const run = () => {
    const p = DFSecScan.planScan(level.value, { maxRequests: max.value, delayMs: delay.value }, { scripts: +scripts.value || 0 });
    clear(out).append(
      kv({ Level: DFSecScan.LEVELS[p.level].label, 'Total requests': p.minTotal === p.maxTotal ? String(p.maxTotal) : p.minTotal + ' to ' + p.maxTotal, 'Budget': p.budget.maxRequests + ' requests, pause ' + p.budget.delayMs + ' ms', Methods: p.methods, Credentials: p.credentials, Scope: p.scope }),
      table(['Step', 'Requests'], p.steps.map((s) => [s.purpose, s.min === s.max ? s.max : s.min + ' to ' + s.max])),
      p.probes.total ? h('details', null, h('summary', null, p.probes.planned + ' of ' + p.probes.total + ' sensitive paths fit the budget'), codeBlock(p.probes.paths.join('\n'))) : '',
      h('div', { class: 'sev-ok' }, icon('check', 14), ' Nothing was sent. This is only the plan.')
    );
  };
  return section(
    'Dry run: what a scan would send',
    h('p', { class: 'sev-info' }, 'Plan the requests before you run a scan. Limits are the same as for a normal scan.'),
    h('div', { class: 'sec-toolbar' }, ownerFormRow('Level', level), ownerFormRow('Max requests', max), ownerFormRow('Pause (ms)', delay), ownerFormRow('Scripts on page', scripts)),
    h('div', { class: 'row' }, h('button', { on: { click: run } }, 'Show plan')),
    out
  );
}

// Authorised sites, idle timeout and approval revocation (Owner tab, unlocked only).
function ownerAccessCard() {
  const box = h('div');
  const msg = h('div', { id: 'owner-origin-msg', role: 'alert', class: 'sev-error' });
  const input = h('input', { type: 'url', id: 'owner-origin', placeholder: 'https://staging.example.com', 'aria-label': 'Site address to authorise', 'aria-describedby': 'owner-origin-msg' });
  const attest = h('input', { type: 'checkbox', id: 'owner-origin-ack' });
  const idle = h('select', { id: 'owner-idle', 'aria-label': 'Lock automatically after' }, OWNER_IDLE_CHOICES.map((m) => h('option', { value: String(m), selected: m === DFOwnerSession.idleMinutes() }, m + ' minutes')));
  idle.addEventListener('change', guard(async () => {
    await DFOwnerSession.setIdleMinutes(+idle.value);
    toast('Owner mode will lock after ' + idle.value + ' minutes without use');
  }));
  const draw = async () => {
    const list = await DFOwnerSession.originsList();
    clear(box).append(
      list.length
        ? table(['Site', 'Authorised', ''], list.map((o) => [mono(o.origin), new Date(o.at).toLocaleDateString(), h('button', { 'aria-label': 'Remove ' + o.origin, on: { click: guard(async () => { await DFOwnerSession.revokeOrigin(o.origin); draw(); }) } }, 'Remove')]))
        : emptyState('No sites authorised yet', 'Add a site you own or have written permission to test. The Security tab then skips the per-site checkbox for it while Owner mode is unlocked.')
    );
  };
  const add = h('button', { class: 'primary', id: 'owner-origin-add' }, 'Authorise site');
  add.addEventListener('click', guard(async () => {
    msg.textContent = '';
    try {
      await DFOwnerSession.authorizeOrigin(input.value, attest.checked);
      input.value = '';
      attest.checked = false;
      toast('Site authorised');
    } catch (e) {
      msg.textContent = e.message;
      input.focus();
    }
    draw();
  }));
  const revoke = h('button', { id: 'owner-revoke-approvals' }, 'Revoke this session’s scan approvals');
  revoke.addEventListener('click', guard(async () => {
    await chrome.storage.session.remove(SEC_ACK_KEY);
    toast('Per-site scan approvals for this browser session were cleared');
  }));
  draw();
  return section(
    'Access and sessions',
    h('p', { class: 'sev-info' }, 'Owner mode never raises scan limits or widens a scan beyond the site in the active tab. These settings only save you repeating the same confirmation and let you control how long Owner mode stays open.'),
    h('div', { class: 'row' }, h('label', null, 'Lock automatically after ', idle)),
    h('b', null, 'Authorised sites'),
    box,
    h('div', { class: 'row' }, h('label', { class: 'sec-filter' }, 'Site address', input)),
    h('label', { class: 'sec-ack', for: 'owner-origin-ack' }, attest, ' I own this site or have permission to run security checks on it.'),
    msg,
    h('div', { class: 'row' }, add, revoke),
    h('div', { class: 'sev-info' }, 'Advanced scans on a public site still need their own confirmation every time.')
  );
}

// Optional encryption of Workspace items at rest. See lib/wsseal.js for what is and is not covered.
function ownerWorkspaceCard() {
  const box = h('div', { role: 'status', 'aria-live': 'polite' });
  const msg = h('div', { id: 'owner-ws-msg', role: 'alert', class: 'sev-error' });
  const draw = async () => {
    const st = await DFOwnerSession.workspaceStatus();
    const on = st.enabled;
    const enable = h('button', { class: 'primary', id: 'owner-ws-enable' }, 'Encrypt Workspace');
    const disable = h('button', { id: 'owner-ws-disable' }, 'Decrypt Workspace and turn off');
    const backup = h('button', { id: 'owner-ws-backup' }, 'Download a plain backup first');
    enable.addEventListener('click', guard(async () => {
      msg.textContent = '';
      if (!confirm('Encrypt ' + st.plain + ' Workspace item(s) with your owner passphrase?\n\nYou will need to unlock Owner mode to open them. If you forget the passphrase they cannot be recovered. Download a plain backup first if you are unsure.')) return;
      enable.disabled = true;
      try {
        await DFOwnerSession.workspaceSealAll((n, t) => status('Encrypting ' + n + ' of ' + t + '…'));
        status('');
        toast('Workspace is now encrypted');
      } catch (e) {
        status('');
        msg.textContent = e.message;
      } finally {
        enable.disabled = false;
        draw();
      }
    }));
    disable.addEventListener('click', guard(async () => {
      msg.textContent = '';
      disable.disabled = true;
      try {
        await DFOwnerSession.workspaceUnsealAll((n, t) => status('Decrypting ' + n + ' of ' + t + '…'));
        status('');
        toast('Workspace encryption is off; items are stored as plain data again');
      } catch (e) {
        status('');
        msg.textContent = e.message;
      } finally {
        disable.disabled = false;
        draw();
      }
    }));
    backup.addEventListener('click', guard(async () => {
      const items = await DFStore.allItems();
      const projects = await DFStore.listProjects();
      download('devforge-workspace-backup.json', JSON.stringify({ exportedAt: new Date().toISOString(), note: 'Plain (unencrypted) copy. Keep it somewhere private.', projects, items }, null, 2), 'application/json');
    }));
    clear(box).append(
      kv({ 'Workspace encryption': on ? 'on' : 'off', 'Items': String(st.total), 'Encrypted': String(st.sealed), 'Stored as plain data': String(st.plain) }),
      h('div', { class: 'row' }, on ? disable : enable, backup),
      msg
    );
  };
  draw();
  return section(
    'Workspace encryption (optional)',
    h('p', { class: 'sev-info' }, 'Encrypts the title, address and content of saved Workspace items (reports, screenshots, snapshots, workflows) with your owner key. Item kind, project and date stay readable so lists work. While Owner mode is locked these items show as “Sealed”, and saving a new item requires unlocking. It does not protect data while unlocked or against someone who can change DevForge’s files. Decrypting needs the passphrase; there is no recovery without it.'),
    box
  );
}

async function ownerUnlockedView(box) {
  const detail = h('div');
  const sealed = h('div');
  const drawSealed = async () => {
    const list = await DFOwnerSession.listTechnical();
    clear(sealed).append(
      list.length
        ? table(
            ['Site', 'Level', 'When', ''],
            list.map((m) => [
              m.host,
              m.level,
              new Date(m.at).toLocaleString(),
              h(
                'span',
                null,
                h('button', { on: { click: async () => { const t = await DFOwnerSession.openTechnical(m.id); clear(detail).append(section('Technical evidence: ' + m.host, ownerTechnicalDetail(t))); detail.scrollIntoView(); } } }, 'Open'),
                ' ',
                h('button', { 'aria-label': 'Delete record for ' + m.host, on: { click: async () => { await DFOwnerSession.deleteTechnical(m.id); clear(detail); drawSealed(); } } }, '✕')
              ),
            ])
          )
        : emptyState('No sealed technical records yet', 'Run a scan from the Security tab with "Collect technical diagnostics" on. The detail is sealed here and never appears in the ordinary report.')
    );
  };
  const stateBox = h('div');
  const drawState = async () => {
    try {
      clear(stateBox).append(kv(await ownerExtensionState()));
    } catch (e) {
      clear(stateBox).append(h('div', { class: 'sev-error' }, e.message));
    }
  };
  const probeBox = h('div', { role: 'status', 'aria-live': 'polite' });
  const logBox = h('div');
  const drawLog = () => {
    const rows = DFOwnerSession.log();
    clear(logBox).append(rows.length ? table(['Time', 'Event', 'Detail'], rows.slice(-60).reverse().map((e) => [e.at.slice(11, 19), e.event, h('span', { class: 'sev-info' }, e.detail || '')])) : emptyState('Nothing recorded yet', 'Events from scans and capture appear here while Owner mode is unlocked.'));
  };
  box.append(
    h('div', { class: 'card' }, ownerBadge('observed', 'Unlocked'), ' ', h('span', { class: 'sev-info' }, 'Locks itself after ' + DFOwnerSession.idleMinutes() + ' minutes of no use, or when this panel closes.'), h('div', { class: 'row' }, h('button', { on: { click: () => DFOwnerSession.lock() } }, icon('owner', 14), ' Lock now'))),
    section('Sealed technical evidence', sealed, detail),
    ownerWorkspaceCard(),
    ownerAccessCard(),
    ownerPlanner(),
    section(
      'This browser tab: can page scripts see DevForge?',
      h('p', { class: 'sev-info' }, 'Runs a probe in the page’s own JavaScript world, the way an untrusted script would, and reports what it could find.'),
      h('div', { class: 'row' }, h('button', { on: { click: guard(async () => {
        const r = await exec(ownerPageIsolationProbe, [], 'MAIN');
        const ok = r.dfNetGlobal === 'undefined' && r.agentGlobal === 'undefined' && r.keyHolderGlobal === 'undefined' && !r.answeredWithoutSecret;
        clear(probeBox).append(
          h('div', { class: ok ? 'sev-ok' : 'sev-error' }, icon(ok ? 'check' : 'alert', 14), ok ? ' The page world cannot read DevForge data here.' : ' Something is reachable from the page world. See the details.'),
          kv({ 'Old capture global (the pre-4.1 name)': r.dfNetGlobal, 'Page-agent global (window.__DF)': r.agentGlobal, 'Key holder global': r.keyHolderGlobal, 'Hidden capture entry points found': r.entryPoints, 'An entry point answered without the secret': String(r.answeredWithoutSecret) }),
          h('div', { class: 'sev-info' }, 'A page script can still notice that capture is running (the wrapped fetch is visible); it cannot read or call it without the secret.')
        );
      }) } }, 'Run isolation probe')),
      probeBox
    ),
    section('Extension state (names and counts only, never values)', stateBox, h('div', { class: 'row' }, h('button', { on: { click: drawState } }, icon('retry', 14), ' Refresh'))),
    section('Diagnostic log (this unlock session)', logBox, h('div', { class: 'row' }, h('button', { on: { click: drawLog } }, icon('retry', 14), ' Refresh')))
  );
  drawSealed();
  drawState();
  drawLog();
}

registerTab('owner', 'Owner', async (v) => {
  const body = h('div');
  v.append(body);
  const draw = async () => {
    clear(body);
    if (!(await DFOwnerSession.exists())) return ownerSetupView(body);
    if (!DFOwnerSession.isUnlocked()) return ownerLockedView(body);
    return ownerUnlockedView(body);
  };
  const off = DFOwnerSession.onChange(() => {
    if (DF.state.tab === 'owner') draw();
  });
  onLeave(off);
  await draw();
});

// Installs the Workspace encryption codec as soon as the panel loads.
DFOwnerSession.workspaceInit().catch((e) => console.warn('DevForge: Workspace encryption state could not be read', e.message));

// A visible reminder in the header while Owner mode is open; activating it locks immediately.
(() => {
  const chip = document.getElementById('owner-chip');
  if (!chip) return;
  const sync = () => {
    const open = DFOwnerSession.isUnlocked();
    chip.hidden = !open;
    if (open && !chip.firstChild) chip.append(icon('owner', 14), ' ', h('span', null, 'Owner'));
  };
  chip.addEventListener('click', () => DFOwnerSession.lock());
  DFOwnerSession.onChange(sync);
  sync();
})();
