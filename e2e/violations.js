// Chrome 158 and later report an inline event handler attribute (onclick="...") whenever markup that
// has one is parsed, even in a parsed copy that never runs it. The Site rewrite and the exports parse
// page markup inside the panel on purpose, so those sessions may carry these reports. Every other
// kind of refusal, in every session, still fails the test.
const PARSE_REPORT = /^script-src-attr .*blocked=inline\]$/;

function splitReports(list) {
  const parse = [];
  const other = [];
  for (const v of list || []) (PARSE_REPORT.test(v) ? parse : other).push(v);
  return { parse, other };
}

module.exports = { splitReports, PARSE_REPORT };
