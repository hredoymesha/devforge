# agent.js audit ledger (4.1.0 hardening pass)

`agent.js` (3,477 lines at the time of the audit, 3669 lines now) is the page agent: it runs in the page's
**isolated world**, is called by the side panel by name, and reads an **untrusted** page. This ledger
accounts for **every line** of the file. The file was split at function boundaries into seven ranges;
each range was read in full (not sampled) by a separate read-only reviewer who returned a per-function
ledger and findings. The author (me) then triaged every finding, fixed the ones with real impact, and
wrote regression tests. Line numbers below are those of the audited version; fixes shifted them.

What this is not: a proof that `agent.js` is free of bugs. It is a complete read with a recorded
verdict per block, plus the findings. Reviewers read; they did not fuzz. Where a finding says
"reading only" nobody ran it.

## 1. Coverage

| Range (audited version) | Contents | Read in full | Reviewer notes |
| --- | --- | --- | --- |
| 1–533 | injection guard, helpers, selector engine, XPath, handles, overlay, picker, tree, search, context info | yes | RPC dispatch lives later; no listener or sink here except `chrome.runtime.sendMessage({type, handle})` |
| 534–1076 | a11y info, roles, `describe`, forms, handlers, framework detection, assets, specificity, sheets, rule matching, `cssFor`, fonts | yes (to 1115) | no eval, no HTML sinks, panel renders every returned value as text |
| 1077–1547 | keyframes, computed dump, override sheet, `applyOp`, `edit`, undo/redo, patch, `forceState`, `scriptsInfo`, contrast helpers | yes (to 1552) | all DOM sinks are in the page's own DOM, none in extension pages |
| 1548–2002 | accessibility / performance / security audits, `absCssUrls`, `absolutizeTree` | yes (to 2185) | no network, no navigation |
| 2003–2497 | `collectComponent` (rest), `defaultsFor`, tidy/collapse helpers, `recreate` walker | yes (to 2500) | clone never attached to the live DOM |
| 2498–2943 | `compareRecreation`, `extractData`, `repeated`, `resourceMap`, `pageInfo`, `fullDom`, `responsiveReport` | yes (2470–2964) | the comparison iframe is sandboxed without scripts |
| 2944–3477 | recorder, `resolveSel`, `setValue`, `runWorkflow`, resource discovery, `fetchInPage`, `rectOf`, `fixedToggle`, `xray`, hooks, the `window.__DF` export list | yes (2900–EOF) | exported API surface reviewed function by function |

Lines the reviewers could not judge on their own because they call code outside their range
(`target`, `byHandle`, `selectorsFor`, `allSheets`) were covered by the range that contains them.

## 2. Verdict by block (summary of the seven ledgers)

Every function was recorded OK unless it appears in the register below. Blocks with **no finding**:
`xpathStr`, `deepestAt`, `parentOf`, handle registry (`handleOf`/`byHandle`/`target`: monotonic ids, WeakRef,
disconnected elements rejected), `relative`, `contextInfo`, `ancestry`, `implicitRole`, `detectFramework`,
`specificity`, `parseDecls`, `luminance`/`parseRGBA`/`contrastOf`, `accessibilityAudit` rules, `performanceAudit`,
`observeLongTasks`, `animatedProps`, `tidyDecls`, `classify`/`rulesCss`, `countTree`, `pageInfo`, `countShadow`,
`resolveSel`, `setValue`, `kindFromUrl`, `rectOf`, `fixedToggle`, `probeDispatch`, `takeContextTarget`, `xray`
(constant style text), `destroy` (removes listeners, overlay, style sheet, frames, global), version/re-injection logic.

Properties confirmed for the whole file: no `eval`/`new Function`; no `innerHTML`/`outerHTML` **assignment**
from page data (the only `innerHTML =` is the undo of a text edit, see AG-12); no `document.write` of page data;
no network request except `fetchInPage` (same-origin, panel-initiated); no navigation except the `navigate`
workflow step (http/https only); one outgoing message type pair (`df:selected`, `df:pick-cancelled`) carrying only an
agent-generated handle; every function that takes an element goes through `target()`.

## 3. Finding register

Status words: **FIXED + TEST** (code changed, browser or unit test added), **FIXED** (code changed, no
dedicated test), **ACCEPTED** (understood, not worth its code; reason given), **UNRESOLVED**.

| ID | Where (audited lines) | Finding | Sev. | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| AG-01 | `selectorsFor` 95–107 | Attribute selector quoting escaped `"` but not `\`, so a page value could close the string early and show a misleading selector | low | reading | **FIXED + TEST** (round-trip test) |
| AG-02 | `select`, `selectBySelector` 347–369 | An XPath resolving to a text/attribute node became the selection | low | reading | **FIXED + TEST** |
| AG-03 | picker handlers 282–318 | Synthetic events from page scripts steered the picker (select, cancel, context menu) | low | reading | **FIXED + TEST** (forged click and Escape) |
| AG-04 | `ensureOverlay`, `ensureStyleEl`, `defaultsFor` | Page can remove DevForge's helper nodes; code kept using the detached copy | low | reading | **FIXED** (re-attach / rebuild); not tested |
| AG-05 | `matchedRules` 938–960 | `@import` rule: `walkRules(undefined)` threw, failing CSS inspection on any page with `@import` | low | reading | **FIXED + TEST** |
| AG-06 | `matchedRules`, `matchesAny` 918, 2025 | Comma-split regex rescanned to the end for every comma (quadratic on huge selector lists) | low | reading | **FIXED** (`splitSelectors`, linear, 4 KB cap); covered indirectly |
| AG-07 | `absCssUrls` 1960; `resourceMap` 2798/2805; `assetsOf` 773; `siteResources` 3177/3195 | `url(` regexes with lazy `.*?` and a back-reference were quadratic: 20,000 unclosed `url(` (80 KB) took seconds, 400 KB took minutes — a hostile page could freeze its own tab and the panel call | medium | **run** by the reviewer (3.5 s / 80 s) | **FIXED + TEST** (`cssUrls`, bounded single pass; 20k-`url(` page finishes < 2.5 s in e2e) |
| AG-08 | `resourceMap` 2800/2810/2835; `siteResources` 3193 | One unparseable address (`http://[`) made the developer report / site scan throw | low | **run** | **FIXED + TEST** |
| AG-09 | `fullDom` 2875–2885 | Script-free page save still contained live markup: a page-built `<noscript>` whose text is `</noscript><img onerror=…>` serialises with the `<img>` outside; `on*`, `javascript:`, `srcdoc`, `<meta refresh>` were kept | medium | **run** (serialisation) | **FIXED + TEST** (`neutralizeTree`, `escapeRawText`) |
| AG-10 | `collectComponent` stripHandlers 2118–2129; `recreate` attributes 2382–2393 | Handler stripping tested the raw value (`java<TAB>script:` evaded it) and ignored `srcdoc`, `formaction`, `<object>`, `<embed>`, `<meta refresh>`; recreate copied every non-`on*` attribute | low–medium | reading | **FIXED + TEST** (same sanitiser; normalises the characters the URL parser ignores) |
| AG-11 | `patch()` 1359–1378; stylesheet label 2093 | Page-controlled text inside `/* … */` could contain `*/` and add CSS to an exported patch / stylesheet | low | reading | **FIXED + TEST** (patch); label **FIXED** |
| AG-12 | `applyOp` text undo 1154 | Undo of a text edit re-parses saved `innerHTML` (re-fires `<img onerror>` the page already had; serialise/re-parse can change structure). Same power as DevTools, only after an explicit user edit; the `html` kind is refused | info | reading | **ACCEPTED** (restoring child nodes would be better; not worth the risk of changing undo now) |
| AG-13 | `undo`/`redo` 1324–1346 | A failed undo popped the op from both stacks and lost it | low | reading | **FIXED**; not tested |
| AG-14 | `forceState` 1379–1424 | `st` put into a `RegExp` unvalidated | info | reading | **FIXED** (whitelist) |
| AG-15 | `scriptsInfo`, `keyframesFor` | Source-map URL and keyframe text returned unclipped (megabyte `data:` maps) | low | reading | **FIXED**; not tested |
| AG-16 | `scriptsInfo` 1432 | The page can hide a script from the inventory by giving it id `__df_bridge` | info | reading | **UNRESOLVED** (integrity of an audit report only; fix = keep a reference to the agent's own element) |
| AG-17 | recorder 2943–2967 | Recorder accepted synthetic events and recorded values of hidden / card / one-time-code / secret-named fields | low | reading | **FIXED**: trusted events only; secret-looking fields recorded blank. Forged-click case **TESTED**; secret-field redaction **NOT TESTED** |
| AG-18 | `runWorkflow` 3006–3061 | No step cap, `delay` unbounded, overlapping runs, not cancelled by `destroy`; `steps` not validated | low | reading | **FIXED + TEST** (200 steps, 30 s delay clamp, 10 min cap, one run at a time, cancel) |
| AG-19 | `fetchInPage` 3251–3269 | No mandatory size limit (undefined = unlimited), body buffered before the limit, redirect to another origin not detected, `force-cache`, non-http(s) schemes | low | reading | **FIXED + TEST** |
| AG-20 | `children`, `nodeBrief`, `search`, `xpathFor` | Work and result size unbounded for huge/deep DOMs (a row and a handle per child before the cap) | low | reading | **PARTLY FIXED** (children capped before building rows; others ACCEPTED: the page can already hang itself) |
| AG-21 | `collectComponent`, `siteResources` | Number/size of returned inline scripts unbounded | low | reading | **FIXED** (20 related scripts; 500 inline scripts / 20 MB) |
| AG-22 | many (`form.id`, `.elements`, `.tagName`, `.children`, `.method`…) | **DOM clobbering:** a `<form>` with a control named `elements`/`tagName`/`children` makes those properties return the control, so inspection/extraction/responsive report throw or return non-cloneable data | low (availability of inspection only) | **run** (`lc(f.tagName)` threw) | **UNRESOLVED**: needs prototype-getter reads throughout (~100 sites). No confidentiality or integrity impact; the page can only break DevForge's view of its own forms |
| AG-23 | `extractData`, `resourceMap`, `pageInfo` | No cap on string length / total bytes in some results (inline `data:` URLs, table cells, meta) | low | reading | **ACCEPTED** (nuisance, text-rendered); partially mitigated by AG-21 |
| AG-24 | `resourceMap` `add()` | O(n²) node lookup | info | reading | **FIXED** (Set) |
| AG-25 | empty `catch` blocks | CLAUDE.md requires a reason for ignored errors | style | reading + ESLint `no-empty` | **FIXED** (every empty block ESLint flagged now says why) |
| AG-26 | `effectiveBg`/`contrastOf` per element | O(nodes × depth) | info | reading | **ACCEPTED** (bounded by `MAX_NODES`) |
| AG-27 | pick mode when the panel closes mid-pick | Page clicks stay blocked until Escape | info | reading | **UNRESOLVED / NOT TESTED** |

## 4. Boundary findings outside agent.js made while reading

* `netcap.js` compared the capture secret with `String.prototype.charCodeAt` looked up at call time; a page that
  replaced that function received the secret on every entry call (**reproduced in the browser, fixed, test added**).
  See docs/SECURITY-REVIEW.md.
* `lib/net.js` and `fetchInPage` used `force-cache` (stale exports): **fixed**.
* `lib/safe.js` did not treat `localhost.` (trailing dot) and several special-use ranges as private: **fixed**.
