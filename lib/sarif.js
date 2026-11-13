// Security findings as SARIF 2.1.0, and the OWASP ASVS chapter each finding falls under. The optional
// $schema field is left out, so the code names no address outside the AI sites. The result
// carries the title, the rule id, the severity and the address without its query string. Details
// and evidence stay in the report, so a secret that reached a finding does not reach a SARIF file.
const DFSarif = (() => {
  const LEVEL = { high: 'error', medium: 'warning', low: 'note', info: 'note' };
  const SECURITY_SEVERITY = { high: '8.0', medium: '5.0', low: '2.0', info: '0.0' };
  const SEVERITY_TEXT = { high: 'high', medium: 'medium', low: 'low', info: 'information' };

  // ASVS 4.0.3 chapter names. The mapping is to chapter level only: a finding is placed in the chapter
  // whose subject it is about. Themes that do not fit any chapter are reported as not mapped.
  const ASVS = {
    V1: 'Architecture, Design and Threat Modeling',
    V2: 'Authentication',
    V3: 'Session Management',
    V4: 'Access Control',
    V5: 'Validation, Sanitization and Encoding',
    V7: 'Error Handling and Logging',
    V8: 'Data Protection',
    V9: 'Communication',
    V10: 'Malicious Code',
    V13: 'API and Web Service',
    V14: 'Configuration',
  };
  const THEME_TO_ASVS = {
    headers: 'V14',
    transport: 'V9',
    cookies: 'V3',
    storage: 'V8',
    disclosure: 'V14',
    exposure: 'V14',
    admin: 'V4',
    'access-control': 'V4',
    cors: 'V14',
    forms: 'V5',
    code: 'V5',
    'third-party': 'V10',
    dependencies: 'V14',
    traffic: 'V13',
    misc: null,
  };

  const asvsOf = (theme) => (theme && THEME_TO_ASVS[theme]) || null;

  // The address without the query string or fragment. A query often carries a token.
  function addressOf(resource) {
    try {
      const u = new URL(String(resource));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.search = '';
      u.hash = '';
      u.username = '';
      u.password = '';
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function ruleId(f) {
    return String(f.id || f.theme || 'finding').replace(/[^A-Za-z0-9._-]/g, '-');
  }

  // Every finding becomes a result. Severity sets the level: high is an error, medium a warning, and
  // low or info a note.
  function toSarif(findings, opts = {}) {
    const rules = new Map();
    const results = [];
    for (const f of findings || []) {
      const id = ruleId(f);
      if (!rules.has(id)) {
        const asvs = asvsOf(f.theme);
        rules.set(id, {
          id,
          name: id,
          shortDescription: { text: String(f.title || id).slice(0, 200) },
          defaultConfiguration: { level: LEVEL[f.severity] || 'note' },
          properties: {
            'security-severity': SECURITY_SEVERITY[f.severity] || '0.0',
            tags: ['security', ...(f.owasp ? ['OWASP ' + f.owasp] : []), ...(asvs ? ['ASVS ' + asvs] : [])],
            owasp: f.owasp || null,
            asvs: asvs ? { chapter: asvs, name: ASVS[asvs] } : null,
          },
        });
      }
      const result = {
        ruleId: id,
        level: LEVEL[f.severity] || 'note',
        message: { text: String(f.title || id).slice(0, 500) + ' (severity ' + (SEVERITY_TEXT[f.severity] || 'unknown') + ')' },
        properties: { status: f.status || 'open', theme: f.theme || null },
      };
      const uri = addressOf(f.resource || '');
      if (uri) result.locations = [{ physicalLocation: { artifactLocation: { uri } } }];
      results.push(result);
    }
    return {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'DevForge', version: String(opts.version || ''), rules: [...rules.values()] } },
          results,
          invocations: [{ executionSuccessful: true, endTimeUtc: opts.endedAt || new Date(0).toISOString() }],
        },
      ],
    };
  }

  // A check for the fields that SARIF 2.1.0 requires and the ones this file writes. Returns the list
  // of problems; an empty list means the file has what a reader needs.
  function validateSarif(doc) {
    const p = [];
    if (!doc || typeof doc !== 'object') return ['The file is not an object.'];
    if (doc.version !== '2.1.0') p.push('version must be "2.1.0".');
    if (!Array.isArray(doc.runs) || !doc.runs.length) p.push('runs must be a non-empty array.');
    for (const [i, run] of (Array.isArray(doc.runs) ? doc.runs : []).entries()) {
      if (!run || typeof run !== 'object') {
        p.push('runs[' + i + '] is not an object.');
        continue;
      }
      const driver = run.tool && run.tool.driver;
      if (!driver || typeof driver.name !== 'string' || !driver.name) p.push('runs[' + i + '].tool.driver.name is missing.');
      const rules = Array.isArray(driver && driver.rules) ? driver.rules : [];
      const ids = new Set();
      for (const r of rules) {
        if (!r || typeof r !== 'object') {
          p.push('a rule is not an object.');
          continue;
        }
        if (!r.id) p.push('a rule has no id.');
        if (ids.has(r.id)) p.push('rule id ' + r.id + ' appears twice.');
        ids.add(r.id);
      }
      if (!Array.isArray(run.results)) p.push('runs[' + i + '].results must be an array.');
      for (const [j, res] of (Array.isArray(run.results) ? run.results : []).entries()) {
        if (!res || typeof res !== 'object') {
          p.push('result ' + j + ' is not an object.');
          continue;
        }
        if (!res.message || typeof res.message.text !== 'string') p.push('result ' + j + ' has no message.text.');
        if (!ids.has(res.ruleId)) p.push('result ' + j + ' points at a rule that is not listed.');
        if (!['none', 'note', 'warning', 'error'].includes(res.level)) p.push('result ' + j + ' has an unknown level.');
        for (const loc of Array.isArray(res.locations) ? res.locations : []) {
          if (!loc || typeof loc !== 'object') continue;
          const uri = loc.physicalLocation && loc.physicalLocation.artifactLocation && loc.physicalLocation.artifactLocation.uri;
          if (typeof uri !== 'string') p.push('result ' + j + ' has a location without a uri.');
          else if (/[?#]/.test(uri) || /:\/\/[^/]*@/.test(uri)) p.push('result ' + j + ' keeps a query, fragment or user name in its address.');
        }
      }
    }
    return p;
  }

  // Findings grouped by ASVS chapter, with the chapters that have no finding listed too. Themes
  // with no chapter are counted apart.
  function asvsCoverage(findings) {
    const chapters = Object.entries(ASVS).map(([id, name]) => ({ id, name, findings: 0, ids: [] }));
    const byId = new Map(chapters.map((c) => [c.id, c]));
    let notMapped = 0;
    for (const f of findings || []) {
      const c = byId.get(asvsOf(f.theme));
      if (!c) {
        notMapped++;
        continue;
      }
      c.findings++;
      if (!c.ids.includes(f.id || f.theme)) c.ids.push(f.id || f.theme);
    }
    return { chapters, notMapped, version: '4.0.3', level: 'chapter' };
  }

  return { toSarif, validateSarif, asvsCoverage, addressOf, ASVS, THEME_TO_ASVS };
})();
if (typeof module !== 'undefined') module.exports = DFSarif;
