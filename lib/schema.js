// Infers JSON schemas for the endpoints in captured network traffic, then writes them as an OpenAPI
// 3.0 document and as TypeScript declarations. Every schema is a guess from the samples that were
// captured: a key is required only when every sample had it, and a type that varies becomes a
// union. Values are never written out, so a secret in a body cannot end up in the output.
const DFSchema = (() => {
  const SAMPLE_LIMIT = 200;
  const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const IDENT = /^[A-Za-z_$][\w$]*$/;

  function kindOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v === 'object' ? 'object' : typeof v;
  }

  // An accumulator collects every sample of one place in the JSON (one key, one array element).
  const newAcc = () => ({ kinds: new Set(), props: null, objects: 0, items: null, strings: 0, dates: 0 });

  function add(acc, v) {
    const k = kindOf(v);
    acc.kinds.add(k);
    if (k === 'object') {
      acc.objects++;
      acc.props = acc.props || new Map();
      for (const key of Object.keys(v)) {
        if (!acc.props.has(key)) acc.props.set(key, { acc: newAcc(), present: 0 });
        const p = acc.props.get(key);
        p.present++;
        add(p.acc, v[key]);
      }
    } else if (k === 'array') {
      if (v.length) acc.items = acc.items || newAcc();
      for (const el of v.slice(0, SAMPLE_LIMIT)) add(acc.items, el);
    } else if (k === 'string') {
      acc.strings++;
      if (DATE.test(v)) acc.dates++;
    }
  }

  // The JSON schema for an accumulator. Null is kept apart and marked nullable.
  function finish(acc) {
    const kinds = [...acc.kinds];
    const nullable = kinds.includes('null');
    const real = kinds.filter((k) => k !== 'null');
    if (!real.length) return { type: 'null' };
    const list = [];
    for (const k of real) {
      if (k === 'integer' && real.includes('number')) continue;
      if (k === 'object') {
        const properties = {};
        const required = [];
        for (const [key, p] of [...(acc.props || new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          properties[key] = finish(p.acc);
          if (p.present === acc.objects) required.push(key);
        }
        list.push({ type: 'object', properties, required });
      } else if (k === 'array') {
        list.push({ type: 'array', items: acc.items ? finish(acc.items) : {} });
      } else if (k === 'string') {
        list.push(acc.dates && acc.dates === acc.strings ? { type: 'string', format: 'date-time' } : { type: 'string' });
      } else {
        list.push({ type: k });
      }
    }
    const core = list.length === 1 ? list[0] : { oneOf: list };
    return nullable ? { ...core, nullable: true } : core;
  }

  // Schema for a list of parsed JSON samples.
  function schemaFor(samples) {
    const acc = newAcc();
    for (const s of samples.slice(0, SAMPLE_LIMIT)) add(acc, s);
    return finish(acc);
  }

  // /users/42/orders/3f2a… becomes /users/{id}/orders/{uuid}. Only the segments are changed.
  function templatePath(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    const segs = u.pathname.split('/').map((s) => {
      if (/^\d+$/.test(s)) return '{id}';
      if (UUID.test(s)) return '{uuid}';
      return s;
    });
    return { origin: u.origin, path: segs.join('/') || '/', query: [...new Set([...u.searchParams.keys()])] };
  }

  // A body is JSON when it starts with { or [ and parses. A truncated body does not parse, so it is
  // skipped rather than guessed at.
  function parseBody(text) {
    if (typeof text !== 'string') return undefined;
    const t = text.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
    try {
      return JSON.parse(t);
    } catch (_) {
      return undefined;
    }
  }

  // Groups captured requests by origin, method and path template. Requests on other origins are
  // counted and left out; the origin with the most requests is the API.
  function groupEndpoints(entries, opts = {}) {
    const parsed = entries
      .map((e) => ({ e, t: templatePath(e.url || '') }))
      .filter((x) => x.t && (x.t.origin.startsWith('http://') || x.t.origin.startsWith('https://')));
    const counts = new Map();
    for (const x of parsed) counts.set(x.t.origin, (counts.get(x.t.origin) || 0) + 1);
    const origin = opts.origin || [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const groups = new Map();
    let skipped = 0;
    let unparsed = 0;
    for (const { e, t } of parsed) {
      if (t.origin !== origin) {
        skipped++;
        continue;
      }
      const method = String(e.method || 'GET').toUpperCase().replace(/\?$/, '');
      const key = method + ' ' + t.path;
      if (!groups.has(key)) groups.set(key, { method, path: t.path, query: new Set(), responses: new Map(), requests: [], count: 0 });
      const g = groups.get(key);
      g.count++;
      t.query.forEach((q) => g.query.add(q));
      const reqJson = parseBody(e.reqBody);
      if (reqJson !== undefined && g.requests.length < SAMPLE_LIMIT) g.requests.push(reqJson);
      const status = Number(e.status) || 0;
      if (!status) continue;
      const body = parseBody(e.resBody);
      if (!g.responses.has(status)) g.responses.set(status, { samples: [], seen: 0 });
      const r = g.responses.get(status);
      r.seen++;
      if (body === undefined) {
        if (e.resBody != null && e.resBody !== '') unparsed++;
      } else if (r.samples.length < SAMPLE_LIMIT) r.samples.push(body);
    }
    return { origin, groups: [...groups.values()].sort((a, b) => (a.path + a.method < b.path + b.method ? -1 : 1)), skipped, unparsed, total: entries.length };
  }

  const pascal = (s) =>
    String(s)
      .replace(/\{(\w+)\}/g, '$1')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('') || 'Root';

  function toOpenApi(res, meta = {}) {
    const paths = {};
    let operations = 0;
    for (const g of res.groups) {
      const p = paths[g.path] || (paths[g.path] = {});
      const op = {
        operationId: g.method.toLowerCase() + pascal(g.path),
        summary: 'Inferred from ' + g.count + ' captured request' + (g.count === 1 ? '' : 's'),
        parameters: [...g.query].sort().map((name) => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
        responses: {},
      };
      if (g.requests.length) {
        op.requestBody = { content: { 'application/json': { schema: schemaFor(g.requests) } } };
      }
      for (const [status, r] of [...g.responses].sort((a, b) => a[0] - b[0])) {
        const resp = { description: 'Captured response (' + r.seen + ' seen)' };
        if (r.samples.length) resp.content = { 'application/json': { schema: schemaFor(r.samples) } };
        op.responses[String(status)] = resp;
      }
      if (!Object.keys(op.responses).length) op.responses.default = { description: 'No response was captured' };
      p[g.method.toLowerCase()] = op;
      operations++;
    }
    return {
      openapi: '3.0.3',
      info: {
        title: meta.title || 'Inferred API',
        version: 'inferred',
        description: 'Inferred from captured network traffic. This is not a specification. Check every schema against the real API before you rely on it.',
      },
      servers: res.origin ? [{ url: res.origin }] : [],
      paths,
      'x-devforge': { inferred: true, operations, requestsUsed: res.total, requestsOtherOrigins: res.skipped, bodiesNotJson: res.unparsed },
    };
  }

  // TypeScript for one schema. Optional keys get "?", nullable types get "| null".
  function tsType(s, indent) {
    if (!s || typeof s !== 'object') return 'unknown';
    let core;
    if (s.oneOf) core = s.oneOf.map((x) => tsType(x, indent)).join(' | ');
    else if (s.type === 'null') core = 'null';
    else if (s.type === 'string') core = 'string';
    else if (s.type === 'number' || s.type === 'integer') core = 'number';
    else if (s.type === 'boolean') core = 'boolean';
    else if (s.type === 'array') {
      const item = tsType(s.items, indent);
      core = /[|]/.test(item) ? '(' + item + ')[]' : item + '[]';
    } else if (s.type === 'object') {
      const pad = '  '.repeat(indent + 1);
      const req = new Set(s.required || []);
      const lines = Object.keys(s.properties || {}).map((k) => {
        const key = IDENT.test(k) ? k : JSON.stringify(k);
        return pad + key + (req.has(k) ? '' : '?') + ': ' + tsType(s.properties[k], indent + 1) + ';';
      });
      core = lines.length ? '{\n' + lines.join('\n') + '\n' + '  '.repeat(indent) + '}' : '{}';
    } else core = 'unknown';
    return s.nullable ? core + ' | null' : core;
  }

  function toTypeScript(res) {
    const out = [
      '// Inferred from captured network traffic. These types are guesses from the samples,',
      '// not the real API. Check them before you rely on them.',
      '',
    ];
    const used = new Map();
    const name = (base) => {
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      return n ? base + (n + 1) : base;
    };
    for (const g of res.groups) {
      const base = pascal(g.method.toLowerCase() + ' ' + g.path);
      if (g.requests.length) {
        const s = schemaFor(g.requests);
        out.push('// ' + g.method + ' ' + g.path + ', request body, inferred from ' + g.requests.length + ' sample(s)');
        out.push('export type ' + name(base + 'Request') + ' = ' + tsType(s, 0) + ';', '');
      }
      for (const [status, r] of [...g.responses].sort((a, b) => a[0] - b[0])) {
        if (!r.samples.length) continue;
        const s = schemaFor(r.samples);
        out.push('// ' + g.method + ' ' + g.path + ' ' + status + ', inferred from ' + r.samples.length + ' sample(s)');
        out.push('export type ' + name(base + 'Response' + status) + ' = ' + tsType(s, 0) + ';', '');
      }
    }
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  return { kindOf, add, finish, schemaFor, templatePath, parseBody, groupEndpoints, toOpenApi, toTypeScript };
})();
if (typeof module !== 'undefined') module.exports = DFSchema;
