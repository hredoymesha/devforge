const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/schema.js');

const orders = [
  { id: 1, total: 9.5, paid: true, note: null, created: '2026-01-02T03:04:05Z' },
  { id: 2, total: 10, paid: false, note: 'x' },
];

test('a key is required only when every sample has it, and null makes a type nullable', () => {
  const s = S.schemaFor(orders);
  assert.equal(s.type, 'object');
  assert.deepEqual(s.required, ['id', 'note', 'paid', 'total']);
  assert.deepEqual(s.properties.note, { type: 'string', nullable: true });
  assert.deepEqual(s.properties.created, { type: 'string', format: 'date-time' });
  assert.deepEqual(s.properties.id, { type: 'integer' });
  assert.deepEqual(s.properties.total, { type: 'number' });
});

test('a value that changes type becomes a union, and integers and numbers merge', () => {
  assert.deepEqual(S.schemaFor([1, 2.5]), { type: 'number' });
  const u = S.schemaFor([{ a: 1 }, { a: 'x' }]);
  assert.deepEqual(u.properties.a.oneOf, [{ type: 'integer' }, { type: 'string' }]);
});

test('an empty array has no item type, and an array of objects keeps the item schema', () => {
  assert.deepEqual(S.schemaFor([[]]), { type: 'array', items: {} });
  assert.equal(S.schemaFor([[{ a: 1 }]]).items.type, 'object');
});

test('a date that is not in every string is not marked as a date', () => {
  const s = S.schemaFor([{ d: '2026-01-02T03:04:05Z' }, { d: 'not a date' }]);
  assert.deepEqual(s.properties.d, { type: 'string' });
});

test('numeric and UUID path segments become placeholders, and the query keys are kept', () => {
  const t = S.templatePath('https://api.test/users/42/orders/3f2a1b4c-1111-2222-3333-444455556666?page=2&sort=asc');
  assert.equal(t.origin, 'https://api.test');
  assert.equal(t.path, '/users/{id}/orders/{uuid}');
  assert.deepEqual(t.query, ['page', 'sort']);
  assert.equal(S.templatePath('not a url'), null);
});

test('requests are grouped by origin and template, the main origin wins, and bodies that do not parse are counted', () => {
  const entries = [
    { method: 'GET', url: 'https://api.test/users/1', status: 200, resBody: '{"a":1}' },
    { method: 'GET', url: 'https://api.test/users/2', status: 200, resBody: '{"a":2}' },
    { method: 'GET', url: 'https://api.test/users/3', status: 500, resBody: '{"a":' },
    { method: 'GET', url: 'https://other.test/users/9', status: 200, resBody: '{}' },
    { method: 'GET', url: 'https://api.test/ping', status: 200, resBody: 'pong' },
  ];
  const r = S.groupEndpoints(entries);
  assert.equal(r.origin, 'https://api.test');
  assert.equal(r.skipped, 1);
  // The truncated JSON and the plain text 'pong' both count: neither is a JSON body.
  assert.equal(r.unparsed, 2);
  assert.deepEqual(r.groups.map((g) => g.method + ' ' + g.path), ['GET /ping', 'GET /users/{id}']);
  const users = r.groups.find((g) => g.path === '/users/{id}');
  assert.equal(users.count, 3);
  assert.equal(users.responses.get(200).samples.length, 2);
});

test('the request method suffix from some capture tools is removed', () => {
  const r = S.groupEndpoints([{ method: 'GET?', url: 'https://api.test/x', status: 200, resBody: '[]' }]);
  assert.equal(r.groups[0].method, 'GET');
});

const sample = [
  { method: 'GET', url: 'https://api.test/users/1/orders', status: 200, resBody: JSON.stringify(orders) },
  { method: 'POST', url: 'https://api.test/login?next=/x', status: 401, reqBody: JSON.stringify({ user: 'a', password: 'supersecret123' }), resBody: '{"error":' },
];

test('OpenAPI output has the required parts, marks itself inferred, and holds no values', () => {
  const doc = S.toOpenApi(S.groupEndpoints(sample), { title: 'Shop' });
  assert.equal(doc.openapi, '3.0.3');
  assert.equal(doc.info.version, 'inferred');
  assert.match(doc.info.description, /not a specification/);
  assert.deepEqual(doc.servers, [{ url: 'https://api.test' }]);
  const get = doc.paths['/users/{id}/orders'].get;
  assert.equal(get.responses['200'].content['application/json'].schema.type, 'array');
  const post = doc.paths['/login'].post;
  assert.deepEqual(post.parameters, [{ name: 'next', in: 'query', required: false, schema: { type: 'string' } }]);
  assert.equal(post.requestBody.content['application/json'].schema.properties.password.type, 'string');
  assert.equal(doc['x-devforge'].inferred, true);
  assert.equal(doc['x-devforge'].bodiesNotJson, 1);
  assert.doesNotMatch(JSON.stringify(doc), /supersecret123/);
});

test('TypeScript output names each type, quotes odd keys, and marks optional and nullable fields', () => {
  const ts = S.toTypeScript(S.groupEndpoints([
    { method: 'GET', url: 'https://api.test/u', status: 200, resBody: JSON.stringify([{ 'first-name': 'a', ok: true }, { ok: false, 'first-name': null }]) },
  ]));
  assert.match(ts, /^\/\/ Inferred from captured network traffic/);
  assert.match(ts, /export type GetUResponse200 = \(\{/);
  assert.match(ts, /"first-name": string \| null;/);
  assert.match(ts, /ok: boolean;/);
  assert.doesNotMatch(ts, /supersecret/);
});

test('TypeScript output keeps request and response names apart and does not reuse a name', () => {
  const ts = S.toTypeScript(S.groupEndpoints(sample));
  assert.match(ts, /export type PostLoginRequest = \{/);
  assert.match(ts, /export type GetUsersIdOrdersResponse200 = /);
  assert.doesNotMatch(ts, /supersecret123/);
});

test('an empty capture still gives a valid empty document', () => {
  const doc = S.toOpenApi(S.groupEndpoints([]));
  assert.deepEqual(doc.paths, {});
  assert.deepEqual(doc.servers, []);
  assert.equal(S.toTypeScript(S.groupEndpoints([])).includes('export type'), false);
});
