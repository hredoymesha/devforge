# DevForge 4.1 — audit, roadmap and Security checker design

Written during the 4.0.0 → 4.1.0 work (two passes). It separates what was **verified** from what is
only **suspected**, what is **done** from what is **proposed**, and what was **reviewed** from what
was not.

## 1. Scope of the review

**Read in full or in the relevant part:** `manifest.json`, `background.js`, `sidepanel.html`,
`panel/core.js`, `panel/boot.js`, `panel/audit.js`, `panel/automate.js` (import and add-step paths),
`panel/workspace.js`, `lib/safe.js`, `sandbox.html/js`, `netcap.js` (whole file), `panel/network.js`
(polling, rules, replay, export, filters, row rendering), the fetch paths in `panel/css.js`,
`panel/export.js` and `panel/site.js`, and in `agent.js`: selectors, picker, DOM tree, describe,
CSS matching, the live-edit/undo code, the security and header code, the workflow runner and
`fetchInPage`.

**Searched with targeted patterns only** (`innerHTML`, `eval`, `postMessage`, `chrome.*`,
`fetch(`, listeners): the rest of `agent.js` (accessibility and performance audits, component
collection, recreate, data extraction, full-DOM and resource maps), `agent/mutations.js`,
`agent/vitals.js`, `agent/tokens.js`, `agent/storage.js`, and the other panels. **These were not
reviewed line by line**, and accessibility was checked only for the tab bar, Home and Security
(automated checks of names and `aria-selected`, plus screenshots), not for every panel.

**Tooling at the start:** no `package.json`, tests, linter or CI, although comments and the README
referred to Node unit tests.

## 2. Findings

Severity: how bad if real. Confidence: how sure I am it is real. "Verified" means reproduced or
traced in the code path; "Suspected" means not reproduced.

| # | Finding | Location | Sev. | Conf. | Status |
| --- | --- | --- | --- | --- | --- |
| F1 | Redaction matched sensitive words as substrings (`author`, `design`, `shipping` hidden). | `lib/safe.js` | Medium (usability) | Verified (Node) | **Fixed**, tests |
| F2 | Old Audit header check used HEAD only; servers answering 405 produced false "missing" findings. | `agent.js` | Medium | Read; GET fallback verified in Chromium | **Fixed** (new tab retries with GET; old call removed) |
| F3 | "Fetch blocked stylesheets" had no private/loopback guard. | `panel/css.js` | Low–Medium | Read | **Fixed** |
| F4 | No tests, lint or CI. | repo | Medium | Verified | **Partly fixed**: scripts, 117 unit tests, 260 browser checks. No linter or CI workflow yet |
| F5 | Page-derived downloads followed redirects into private hosts; only the first URL was checked. | `panel/core.js` | Low | Verified in unit test with a stub fetch (mutation-checked) | **Fixed** (`lib/net.js`). The request itself is still sent before the check; stopping that needs declarativeNetRequest |
| F6 | An XHR aborted while a latency rule held it was still sent (or threw) when the rule expired. | `netcap.js` | Low | **Verified in Chromium before and after** against the original commit | **Fixed** |
| F7 | Automate `navigate` accepted any URL scheme from pasted JSON. | `agent.js`, `panel/automate.js` | Low | **Not exploitable in practice**: the original build was tested in Chromium and a `javascript:` step did not run script (the extension's MV3 CSP blocks it). My first assessment, "code execution", was wrong and is withdrawn. | **Hardened**: only http/https accepted |
| F8 | The Network capture log was `window.__dfNet` in the page's own world; page and third-party scripts could read it (unredacted requests and headers) and change rules. | Medium → High | **Verified in Chromium** on the original build | **Fixed in the hardening pass**: closure-private log, secret handshake via `netbridge.js`; see SECURITY-REVIEW.md #1 |
| F9 | `a[target=_blank]` "missing noopener" rule is obsolete (Chrome 88+). | `agent.js` `securityAudit` | Low | Verified | Open (not in the new tab). `securityAudit` is still used by the developer report |
| F10 | `fetchBytes` uses `cache: 'force-cache'`, which can serve stale assets in exports. | `lib/net.js` | Low | Suspected | Open |
| F11 | `sandbox.js` does not check the sender of the `run` message. Opaque origin, user's own code. | `sandbox.js` | Low | Suspected | **Fixed** (sender must be the embedding panel) |
| F12 | `agent.js` is 3.4k lines and `panel/network.js` 1.7k; changes are risky. | repo | Maintainability | Verified | Open |
| F13 | The `html` edit kind in the agent (`innerHTML` from a string) can run event-handler attributes while the `attr` kind refuses them. No panel uses it. | `agent.js` | Low | Verified by reading | **Fixed**: the kind is refused (AGENT_VERSION 7) |
| F14 | Workspace stores data unencrypted in IndexedDB; saved security reports describe a site's weaknesses. | `lib/store.js` | Low | Verified | Documented |

Bugs in the new code that browser testing caught before release (kept here because they show why
the e2e suite matters): tab buttons exposed `aria-selected=""` instead of `"true"`; `display:
inline-flex` overrode `[hidden]`, so tabs moved to the overflow menu were still laid out; parameter
reflection was searched in serialised HTML (missing values with quotes) and was noisy for plain
text; a null dereference for the advanced checkbox on local targets; one request timeout aborted the
scan-wide controller.

Checked and fine: permissions are minimal and host access is optional; the extension CSP forbids
inline and remote script; DOM is built with text nodes through `h()`; CSV export neutralises
formulas; the Playground runs on an opaque origin with `connect-src 'none'`; the service worker is
tiny and stateless; runtime messages come only from the extension's own content scripts.

## 3. Website Security Checker specification

The task referred to a separate Website Security Checker specification. **It is not available**:
it is not in the repository or its history (`git log --all`), `/mnt/attach` and
`/mnt/user-data/uploads` are empty, and no file or session transcript contains it. I did not read it
and cannot say how the implementation compares. The checker was built from the requirements stated
in the two task descriptions. To reconcile it with the real document, add it to the repo (for
example `docs/website-security-checker-spec.md`) or paste it into a session.

## 4. Security checker: design and status

### Layers
1. **Collector** `agent/security.js`: reads the page (names and kinds only) and owns `secRequest`,
   the only way a scan touches the network.
2. **Detectors** `lib/secprobe.js`: probe catalog with content signatures, secret patterns with
   masking, library advisories (offline), error and listing detectors, robots parsing.
3. **Analysis** `lib/secscan.js`: findings from headers, CSP, page facts, cookies, storage, traffic,
   probes, scripts, `security.txt`; scan levels and budget clamping.
4. **Report** `lib/secreport.js`: de-duplication, attack paths, remediation plan, coverage,
   Markdown, disclosure template, last-line scrubbing.
5. **Runner and UI** `panel/securityrun.js`, `panel/security.js`.

### Enforced limits
Same origin only; GET/HEAD; no cookies, bodies or custom headers; probe paths are plain absolute
paths; redirects not followed; budget 3/60/150 (hard ceiling 200); minimum pause 100 ms when more
than 3 requests; 10 s timeout; response bytes capped; cancel; the scan aborts if the tab or origin
changes; every request is logged and listed in the report. These are enforced in the agent and
tested on the wire in Chromium (including `//host`, `/\host`, `data:`, `javascript:`, `ftp:`,
credentials, other ports, budget exhaustion and cancel).

### What can and cannot be checked

| Area | Status |
| --- | --- |
| Headers, CSP, HSTS, framing, referrer, permissions policy, CORS (observed), version banners | Done |
| Mixed content, HTTP page, password forms, SRI, frames, inline handlers, `javascript:` URLs | Done |
| Cookies | Script-visible by default; exact flags with the optional `cookies` permission (HttpOnly, Secure, SameSite, lifetime, Domain). Values never read |
| Credential-like values, source maps, library versions, risky hosts | Done as **Potential** (never tested against a service) |
| Exposed files, backups, dumps, logs, directory listings, debug and admin tools | Done at Standard/Advanced, signature-based |
| XSS, open redirect, IDOR, CSRF | **Indicators only**, marked Needs manual verification with safe steps |
| Observed requests | Done when Network capture is on |
| TLS configuration, injection, XSS execution, access control, authentication strength, CORS reflection, rate limiting, other subdomains, DNS and email security, server patch level, business logic | **Not testable** from an extension without sending payloads or touching other systems; listed in every report with how to check |

### Verification performed
Unit tests for every analyzer (positive and negative), attack paths, plan, coverage, redaction,
Markdown and disclosure output; mutation checks that the redaction, the redirect guard and secret
masking tests fail when the code is broken; Chromium tests against a deliberately weak local site and
a clean single-page app that answers every path with 200. **Not tested:** real public websites,
HTTPS targets, pages behind login, large or framed pages, other Chrome versions, Firefox/Edge.
Library advisories and probe signatures are hand-maintained from public knowledge and are not
guaranteed complete or current.

## 5. Roadmap

### Done in 4.1.0
Everything in the CHANGELOG: Security checker v2, request gate, Home tab, tab icons and compact bar,
network security signals and filters, F1–F7 fixes, tooling, unit tests and the e2e suite.

### Next (highest priority first)
1. **CI and lint**: a GitHub Actions workflow running `npm run verify` (and `npm run e2e` where a
   browser is available), plus ESLint with a flat config declaring the panel globals.
2. **F8**: decide on capture-time redaction for the page-world log, or a user-visible warning when
   capture is on for sensitive sites.
3. **Split `agent.js` and `panel/network.js`** by area as files are touched (F12).
4. **Accessibility pass** over every panel with a real screen reader and keyboard walk-through.
5. **Security checker**: per-check retry (today a failed check is rerun by running the scan again),
   scan history and diff in Workspace, a CSP report-only builder from observed requests, and a
   signed update path for the library advisory list.
6. Remove the obsolete noopener rule (F9); the unused `html` edit kind (F13) is already refused.

### Optional, later
Opt-in external lookups (TLS, DNS, advisories) with clear consent because they send the site name to
a third party; localisation; a Web Store listing checklist; Firefox support (which has TLS details
through `webRequest.getSecurityInfo`).

## Tooling evaluation: linting and CI (not added)

- **ESLint:** would catch unused variables and some mistakes, but this codebase shares one global
  scope across classic scripts (cross-file globals), so a useful config needs a long `globals` list
  maintained by hand, plus a dev dependency. `scripts/check.js` already checks syntax, references and
  forbidden patterns. Recommendation: add ESLint only if you accept a dev dependency; start with
  `no-undef` limited to `lib/` (which are self-contained) and `no-unused-vars`.
- **CI:** a GitHub Actions workflow running `npm run verify` on Node 18/22 is safe and dependency-free.
  It was **not created**: adding a workflow changes the repository's automation, which this work was
  told not to touch. A suggested file is `.github/workflows/verify.yml` with `actions/checkout`,
  `actions/setup-node`, then `npm run verify`. `npm run e2e` needs Playwright and Chromium and is
  better run locally or in a separate, opt-in job.
