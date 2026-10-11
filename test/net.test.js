const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchBounded } = require('../lib/net.js');

const stream = (text) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
// A minimal stand-in for fetch(): `url` is where the "redirects" ended up.
const stub = (finalUrl, body = 'hello', status = 200, headers = {}) => async () => ({
  ok: status < 400,
  status,
  url: finalUrl,
  headers: new Headers(headers),
  body: stream(body),
});
const page = 'https://example.com/';

test('downloads a public URL', async () => {
  const r = await fetchBounded('https://cdn.example.net/a.css', { pageUrl: page, fetchImpl: stub('https://cdn.example.net/a.css') });
  assert.equal(new TextDecoder().decode(r.bytes), 'hello');
  assert.equal(r.status, 200);
});

test('refuses a private target before any request is made', async () => {
  let called = false;
  await assert.rejects(
    fetchBounded('http://192.168.1.1/admin', { pageUrl: page, fetchImpl: async () => ((called = true), {}) }),
    /private or loopback/
  );
  assert.equal(called, false);
});

test('regression: a public URL that redirects to a private host is refused and its body is not read', async () => {
  let cancelled = false;
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: 'http://127.0.0.1:8080/secret',
    headers: new Headers(),
    body: { cancel: async () => (cancelled = true), getReader: () => assert.fail('body was read') },
  });
  await assert.rejects(
    fetchBounded('https://short.example/x', { pageUrl: page, fetchImpl }),
    /redirected to a private or loopback address/
  );
  assert.equal(cancelled, true);
});

test('a redirect to a non-web scheme is refused', async () => {
  await assert.rejects(
    fetchBounded('https://a.example/x', { pageUrl: page, fetchImpl: stub('file:///etc/passwd') }),
    /non-web/
  );
});

test('a page that is itself on a private host may fetch from that host', async () => {
  const r = await fetchBounded('http://localhost:3000/app.js', {
    pageUrl: 'http://localhost:3000/',
    fetchImpl: stub('http://localhost:3000/app.js'),
  });
  assert.equal(r.bytes.length, 5);
});

test('enforces the size limit and reports HTTP errors', async () => {
  await assert.rejects(
    fetchBounded('https://a.example/x', { pageUrl: page, maxBytes: 3, fetchImpl: stub('https://a.example/x') }),
    /too large/
  );
  await assert.rejects(
    fetchBounded('https://a.example/x', { pageUrl: page, fetchImpl: stub('https://a.example/x', '', 404) }),
    /HTTP 404/
  );
});

test('times out', async () => {
  const fetchImpl = (u, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' }))));
  await assert.rejects(fetchBounded('https://a.example/x', { pageUrl: page, timeoutMs: 20, fetchImpl }), /timed out/);
});

test('regression: redirects are not followed by default, so nothing is requested from the target', async () => {
  let init;
  const fetchImpl = async (url, i) => ((init = i), { type: 'opaqueredirect', ok: false, status: 0, url: '', headers: new Headers(), body: null });
  await assert.rejects(fetchBounded('https://short.example/x', { pageUrl: page, fetchImpl }), /redirect not followed/);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
});

test('with followRedirects the final address is still checked and the body never read', async () => {
  let init;
  const fetchImpl = async (url, i) => ((init = i), { ok: true, status: 200, url: 'http://10.0.0.5/admin', headers: new Headers(), body: { cancel: async () => {}, getReader: () => assert.fail('body was read') } });
  await assert.rejects(fetchBounded('https://short.example/x', { pageUrl: page, followRedirects: true, guard: async () => {}, fetchImpl }), /redirected to a private or loopback address/);
  assert.equal(init.redirect, 'follow');
});

test('regression: following redirects fails closed when the network guard is missing or cannot be installed', async () => {
  let called = 0;
  const fetchImpl = async () => (called++, { ok: true, status: 200, url: 'https://public.example/x', headers: new Headers(), body: null });
  await assert.rejects(fetchBounded('https://short.example/x', { pageUrl: page, followRedirects: true, fetchImpl }), /without the network guard/);
  await assert.rejects(fetchBounded('https://short.example/x', { pageUrl: page, followRedirects: true, guard: async () => { throw new Error('boom'); }, fetchImpl }), /cannot be followed safely \(boom\)/);
  assert.equal(called, 0, 'no request was sent');
});

test('the guard is installed before the request, with the page address, in both redirect modes', async () => {
  const order = [];
  const fetchImpl = async (u, i) => (order.push('fetch:' + i.redirect), { type: 'opaqueredirect', ok: false, status: 0, url: '', headers: new Headers(), body: null });
  const guard = async (p) => order.push('guard:' + p);
  await assert.rejects(fetchBounded('https://short.example/x', { pageUrl: page, guard, fetchImpl }), /redirect not followed/);
  assert.deepEqual(order, ['guard:' + page, 'fetch:manual']);
});

test('regression: an unknown page address fails closed instead of switching the private-address guard off', async () => {
  let called = false;
  const fetchImpl = async () => ((called = true), {});
  for (const bad of ['', undefined, null]) {
    await assert.rejects(fetchBounded('http://192.168.1.1/x', { pageUrl: bad, fetchImpl }), /address of the page is unknown/);
    await assert.rejects(fetchBounded('https://public.example/x', { pageUrl: bad, fetchImpl }), /address of the page is unknown/);
  }
  assert.equal(called, false);
});

test('regression: downloads revalidate instead of trusting any cached copy (force-cache served stale exports)', async () => {
  let init;
  const fetchImpl = async (url, i) => ((init = i), { type: 'basic', ok: true, status: 200, url, headers: new Headers({ 'content-length': '2' }), body: { getReader: () => { let d = false; return { read: async () => (d ? { done: true } : ((d = true), { done: false, value: new Uint8Array([104, 105]) })), cancel: async () => {} }; } } });
  const r = await fetchBounded('https://public.example/a.css', { pageUrl: page, fetchImpl });
  assert.equal(init.cache, 'no-cache');
  assert.equal(new TextDecoder().decode(r.bytes), 'hi');
});
