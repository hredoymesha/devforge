const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/stored.js');
const gen = require('../e2e/fuzzgen.js');

const DEFAULTS = {
  theme: 'system',
  shortcuts: {},
  lastTab: 'home',
  seenWelcome: false,
  followRedirects: false,
  allowAllSites: true,
  siteAllowlist: [],
  autoSaveScans: true,
  scanRetention: 20,
  perfHistoryLimit: 30,
  tempCleanup: 'close',
  captureBodyKB: 200,
  captureTotalMB: 16,
  captureEntries: 1000,
};

/* ---------- settings ---------- */

test('nothing stored: defaults, current version, nothing to report', () => {
  for (const raw of [undefined, null]) {
    const r = S.settings(raw, DEFAULTS);
    assert.deepEqual(r.value, { ...DEFAULTS, schemaVersion: 2 });
    assert.deepEqual(r.ignored, []);
    assert.equal(r.migrated, false);
  }
});

test('settings written by 4.2.0 (no version) are read and marked as migrated', () => {
  const old = { theme: 'dark', lastTab: 'network', shortcuts: { pick: 'Ctrl+Shift+U' }, siteAllowlist: ['https://a.example'], allowAllSites: false, scanRetention: 5 };
  const r = S.settings(old, DEFAULTS);
  assert.equal(r.value.theme, 'dark');
  assert.equal(r.value.allowAllSites, false);
  assert.deepEqual(r.value.siteAllowlist, ['https://a.example']);
  assert.equal(r.value.scanRetention, 5);
  assert.equal(r.value.schemaVersion, 2);
  assert.equal(r.from, 1);
  assert.equal(r.migrated, true);
  assert.deepEqual(r.ignored, []);
  assert.equal(r.value.captureBodyKB, 200, 'a setting that was never saved keeps its default');
});

test('corrupt values fall back to the default and are named, one line each', () => {
  const r = S.settings({ theme: 'neon', lastTab: '../x', scanRetention: -4, perfHistoryLimit: 1e9, captureBodyKB: '200', shortcuts: 'Ctrl+K', siteAllowlist: 'https://a.example', allowAllSites: 'yes', tempCleanup: 7 }, DEFAULTS);
  for (const k of ['theme', 'lastTab', 'scanRetention', 'perfHistoryLimit', 'captureBodyKB', 'shortcuts', 'siteAllowlist', 'allowAllSites', 'tempCleanup']) {
    assert.deepEqual(r.value[k], DEFAULTS[k], k);
    assert.ok(r.ignored.some((l) => l.startsWith(k + ':')), k + ' is reported');
  }
});

test('a settings value that is not an object is ignored as a whole', () => {
  for (const raw of ['x', 7, true, ['theme']]) {
    const r = S.settings(raw, DEFAULTS);
    assert.deepEqual(r.value, { ...DEFAULTS, schemaVersion: 2 });
    assert.equal(r.ignored.length, 1);
  }
});

test('shortcuts and the site list are cleaned item by item', () => {
  const r = S.settings({
    shortcuts: { pick: 'Ctrl+U', 'bad key!': 'x', other: 5, __proto__x: 'a', ok2: 'Alt+1', long: 'x'.repeat(100) },
    siteAllowlist: ['https://a.example', 'https://a.example', 'javascript:alert(1)', 'https://a.example/path', 42, 'not a url', 'http://b.example:8080', 'ftp://c.example'],
  }, DEFAULTS);
  assert.deepEqual(r.value.shortcuts, { pick: 'Ctrl+U', ok2: 'Alt+1' });
  assert.deepEqual(r.value.siteAllowlist, ['https://a.example', 'http://b.example:8080']);
  assert.equal(Object.getPrototypeOf(r.value.shortcuts), Object.prototype);
});

test('a prototype-pollution key in the saved settings changes nothing', () => {
  const raw = JSON.parse('{"__proto__": {"polluted": true}, "theme": "dark", "shortcuts": {"__proto__": "Ctrl+P"}}');
  const r = S.settings(raw, DEFAULTS);
  assert.equal({}.polluted, undefined);
  assert.equal(r.value.theme, 'dark');
  assert.equal(Object.keys(r.value.shortcuts).length, 0);
});

test('settings from a newer version are read as far as they are understood, with a note', () => {
  const r = S.settings({ schemaVersion: 7, theme: 'light', futureThing: { a: 1 } }, DEFAULTS);
  assert.equal(r.value.theme, 'light');
  assert.ok(r.ignored.some((l) => /newer DevForge/.test(l)));
  assert.ok(r.ignored.some((l) => /1 unknown setting left out \(futureThing\)/.test(l)));
  assert.equal(r.value.futureThing, undefined);
});

test('a bad schemaVersion is reported and read as version 1', () => {
  const r = S.settings({ schemaVersion: 'two', theme: 'dark' }, DEFAULTS);
  assert.equal(r.from, 1);
  assert.equal(r.value.theme, 'dark');
  assert.ok(r.ignored.some((l) => l.startsWith('schemaVersion:')));
});

test('unknown setting names are shown in a safe form and the list is capped', () => {
  const raw = {};
  for (let i = 0; i < 30; i++) raw['<img src=x onerror=1>' + i] = 1;
  const r = S.settings(raw, DEFAULTS);
  const line = r.ignored.find((l) => /unknown setting/.test(l));
  assert.match(line, /30 unknown settings/);
  assert.ok(!/[<>]/.test(line), line);
  assert.ok(line.length < 300);
});

test('fuzz: random stored values never throw and always give a usable settings object' + ' (seed 1)', () => {
  const r = gen.rng(1);
  const junk = [null, undefined, 0, -1, 1.5, NaN, Infinity, '', 'x', 'x'.repeat(10000), true, false, [], {}, [1, 2], { a: 1 }, ['https://a.example'], () => 1];
  for (let i = 0; i < 3000; i++) {
    const raw = {};
    for (const k of [...Object.keys(DEFAULTS), 'schemaVersion', 'x']) if (r.chance(0.7)) raw[k] = r.pick(junk);
    const out = S.settings(r.chance(0.1) ? r.pick(junk) : raw, DEFAULTS);
    assert.equal(typeof out.value.theme, 'string');
    assert.ok(Array.isArray(out.value.siteAllowlist) && typeof out.value.shortcuts === 'object');
    assert.ok(Number.isInteger(out.value.scanRetention) && out.value.scanRetention >= 0);
    assert.equal(out.value.schemaVersion, 2);
    assert.ok(Array.isArray(out.ignored));
  }
});

/* ---------- interception rules ---------- */

const rule = (over = {}) => ({ match: '/api/users', regex: false, method: '*', kinds: 'any', action: 'block', ...over });

test('good rules of every action pass through unchanged', () => {
  const good = [
    rule(),
    rule({ action: 'mock', status: 201, contentType: 'application/json', body: '{"a":1}', headers: { 'x-a': 'b' } }),
    rule({ action: 'delay', delay: 1500 }),
    rule({ action: 'headers', headers: { 'x-test': '1' }, match: '' }),
    rule({ action: 'redirect', redirect: 'https://b.example/x' }),
    rule({ regex: true, match: '^https://a\\.example/' , enabled: false }),
  ];
  const r = S.rules(JSON.parse(JSON.stringify(good)));
  assert.deepEqual(r.ignored, []);
  assert.deepEqual(r.value, good);
});

test('rules that cannot work are left out, one note each, and the good ones stay', () => {
  const raw = [
    rule(),
    null,
    'x',
    rule({ action: 'explode' }),
    rule({ action: 'mock', status: 99 }),
    rule({ action: 'delay', delay: 999999 }),
    rule({ action: 'headers', headers: {} }),
    rule({ action: 'redirect', redirect: '' }),
    rule({ regex: true, match: '(' }),
    rule({ match: 5 }),
    rule({ match: 'x'.repeat(5000) }),
    rule({ action: 'delay', delay: 10 }),
  ];
  const r = S.rules(raw);
  assert.equal(r.value.length, 2);
  assert.equal(r.ignored.length, 10);
  assert.ok(r.ignored.every((l) => /^Interception rule \d+: /.test(l)));
});

test('rules: a stored value that is not a list is ignored, and the list is capped', () => {
  assert.deepEqual(S.rules({ a: 1 }).value, []);
  assert.equal(S.rules('x').ignored.length, 1);
  assert.deepEqual(S.rules(undefined), { value: [], ignored: [] });
  const many = Array.from({ length: 500 }, (_, i) => rule({ match: '/p' + i }));
  const r = S.rules(many);
  assert.equal(r.value.length, S.MAX_RULES);
  assert.match(r.ignored[0], /Only the first 200 of 500/);
});

test('rules: odd header names and values are dropped, and the total size is bounded', () => {
  const r = S.rules([rule({ action: 'mock', status: 200, body: 'ok', headers: { 'good-name': 'v', 'bad name': 'v', 'x-n': 5, __proto__: 'x' } })]);
  assert.deepEqual(r.value[0].headers, { 'good-name': 'v' });
  const big = Array.from({ length: 5 }, (_, i) => rule({ action: 'mock', status: 200, match: '/' + i, body: 'x'.repeat(900000) }));
  const b = S.rules(big);
  assert.equal(b.value.length, 2);
  assert.ok(b.ignored.some((l) => /too large/.test(l)));
});

test('fuzz: random stored rules never throw and every kept rule has a known action' + ' (seed 2)', () => {
  const r = gen.rng(2);
  const junk = [null, undefined, 0, 5, -1, NaN, '', 'x', '(', {}, [], true, 'x'.repeat(3000), { a: 1 }, 'mock', 'block', 'delay', 'headers', 'redirect', 200, 99999];
  for (let i = 0; i < 2000; i++) {
    const raw = Array.from({ length: r.int(6) }, () => (r.chance(0.2) ? r.pick(junk) : Object.fromEntries(['match', 'regex', 'method', 'kinds', 'action', 'status', 'delay', 'redirect', 'headers', 'body', 'enabled'].filter(() => r.chance(0.7)).map((k) => [k, r.pick(junk)]))));
    const out = S.rules(r.chance(0.1) ? r.pick(junk) : raw);
    for (const x of out.value) assert.ok(['block', 'mock', 'delay', 'headers', 'redirect'].includes(x.action));
  }
});

/* ---------- performance history ---------- */

const KEY = 'k' + 'a1b2c3d4e5f6a1b2c3d4e5f6';

test('a good history passes through; bad keys, points and numbers are dropped with a count', () => {
  const good = { t: 1700000000000, lcp: 1200, fcp: 800, ttfb: 100, inp: null, cls: 0.05, load: 2000 };
  const r = S.perfHistory({
    [KEY]: [good, { t: 'now', lcp: 1 }, null, { t: 1700000001000, lcp: -5, fcp: 'x' }, { t: 1700000002000, lcp: 99999999 }, { t: 1700000003000, lcp: 900 }],
    'bad key': [good],
    ['k' + 'b'.repeat(24)]: 'nope',
  });
  assert.deepEqual(r.value[KEY].map((p) => p.t), [1700000000000, 1700000003000]);
  assert.equal(r.value[KEY][1].fcp, null);
  assert.equal(Object.keys(r.value).length, 1);
  assert.equal(r.ignored.length, 2);
  assert.match(r.ignored.join(' '), /2 saved entr/);
  assert.match(r.ignored.join(' '), /4 saved readings/);
});

test('history: not an object, or too long, is handled', () => {
  assert.deepEqual(S.perfHistory([1, 2]).value, {});
  assert.equal(S.perfHistory('x').ignored.length, 1);
  assert.deepEqual(S.perfHistory(undefined), { value: {}, ignored: [] });
  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: 1700000000000 + i, lcp: 100 + i }));
  assert.equal(S.perfHistory({ [KEY]: pts }).value[KEY].length, 200);
});

/* ---------- Workspace records ---------- */

test('items: a good record is kept; a missing id or project is left out; bad fields are repaired', () => {
  assert.equal(S.item({ id: 'a', project: 'p', kind: 'element', title: 'T', created: 5, payload: { html: '<b>' } }).ok, true);
  assert.equal(S.item({ project: 'p' }).ok, false);
  assert.equal(S.item({ id: 'a' }).ok, false);
  assert.equal(S.item(null).ok, false);
  assert.equal(S.item('x').ok, false);
  const fixed = S.item({ id: 'a', project: 'p', kind: 7, title: { x: 1 }, created: 'yesterday', payload: null });
  assert.deepEqual([fixed.ok, fixed.item.kind, fixed.item.title, fixed.item.created], [true, 'other', 'Untitled', 0]);
  assert.equal(S.item({ id: 'a', project: 'p', title: 'x'.repeat(900) }).item.title.length, 500);
});

test('items: a record far larger than the limit is left out without being copied', () => {
  const huge = { id: 'a', project: 'p', kind: 'screenshot', title: 'big', payload: { data: 'x'.repeat(30 * 1000 * 1000) } };
  const t = Date.now();
  const r = S.item(huge);
  assert.equal(r.ok, false);
  assert.match(r.why, /larger than 25 MB/);
  assert.ok(Date.now() - t < 1000);
  assert.equal(S.item({ id: 'a', project: 'p', payload: { data: 'x'.repeat(5 * 1000 * 1000) } }).ok, true);
});

test('items: a sealed record keeps its stored fields', () => {
  const sealed = { id: 's', project: 'p', kind: 'security', created: 9, title: 'Sealed item', sealed: true, v: 1, iv: 'AAAA', ct: 'BBBB' };
  assert.deepEqual(S.item(sealed).item, sealed);
});

test('records(): filters a list and says how many were left out and why', () => {
  const list = [{ id: 'a', project: 'p' }, null, { id: 'b' }, { id: 'c', project: 'p', kind: 'data' }];
  const r = S.records(list, S.item, 'items');
  assert.equal(r.value.length, 2);
  assert.equal(r.ignored.length, 1);
  assert.match(r.ignored[0], /Workspace: 2 saved items left out \(not a record; it does not belong to a project\)/);
  assert.equal(S.records('x', S.item, 'items').ignored.length, 1);
  assert.equal(S.records([{ id: 'p1', name: 5 }, { name: 'x' }], S.project, 'projects').value[0].name, 'Untitled project');
});

test('weight() stops early on a huge value and counts bytes of binary data', () => {
  const t = Date.now();
  assert.ok(S.weight({ a: 'x'.repeat(50 * 1000 * 1000) }, 1000) > 1000);
  assert.ok(Date.now() - t < 500);
  assert.equal(S.weight({ a: new Uint8Array(100) }, 1e9), 100);
  const cyc = { a: 'x' };
  cyc.self = cyc;
  assert.ok(S.weight(cyc, 1e6) > 0, 'a self-referencing value ends instead of looping');
});
