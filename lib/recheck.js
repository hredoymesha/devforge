// Re-checking one finding after the site was changed. This module only decides what to re-run and how
// to read the answer; the panel sends the requests through the Security checker's gate (same origin,
// GET or HEAD, budgeted, paced). Pure.
const DFRecheck = (() => {
  const Probe = typeof DFSecProbe !== 'undefined' ? DFSecProbe : require('./secprobe.js');

  // Ids that analyzeHeaders() in lib/secscan.js can produce. The theme is not enough: other findings share
  // 'disclosure' and 'cors'. test/recheck.test.js fails if analyzeHeaders gains an id that is missing here.
  const HEADER_FINDING = /^(csp-|hsts-|nosniff-|referrer-|permissions-policy-|version-disclosure-|cors-wildcard)|^(clickjacking|cache-sensitive-page)$/;

  // What to run again for a finding, or null when only a full scan can answer it.
  //   probe:   a path that was exposed (needs the missing-path baseline too, so a single-page app that
  //            answers every path with 200 is not mistaken for an exposure)
  //   headers: the page's response headers
  function plan(f) {
    if (!f || typeof f.id !== 'string') return null;
    if (f.id.startsWith('exposed-')) {
      const probe = Probe.PROBES.find((p) => p.id === f.id.slice('exposed-'.length));
      if (probe && typeof f.resource === 'string' && Probe.isSafeProbePath(f.resource)) return { kind: 'probe', probe: probe.id, path: f.resource, requests: 2 };
      return null;
    }
    if (HEADER_FINDING.test(f.id)) return { kind: 'headers', requests: 2 };
    return null;
  }

  // fresh: the findings the same analyzers give for the new responses.
  function decide(f, fresh) {
    return (fresh || []).some((x) => x.id === f.id && x.resource === f.resource) ? 'still-present' : 'fixed';
  }

  const TEXT = {
    fixed: 'Fixed. The check no longer reports this.',
    'still-present': 'Still present. The check reports it again.',
    'could-not-check': 'Could not check',
  };
  const NOTE = 'This does not change the saved report. Run a new scan to update it.';

  return { plan, decide, TEXT, NOTE };
})();
if (typeof module !== 'undefined') module.exports = DFRecheck;
