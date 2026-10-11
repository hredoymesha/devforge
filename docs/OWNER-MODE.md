# Owner mode (Security Admin): design, capability matrix and trust boundary

Owner mode is a passphrase that the person using this browser profile chooses. It protects a small amount of
sensitive local data at rest, gives that person a few conveniences for working on several sites, and shows
detailed technical diagnostics. It is deliberately modest: it is **not** a licence check, an account, an identity
proof, or a way to widen what a scan may do. This page separates what was **verified by a test** from what is a
**stated limit**.

## 1. What it is

* A passphrase (12+ characters, rejected when too short, too repetitive or an obvious word) is turned into 64 bytes
  with PBKDF2-SHA256 (600,000 iterations, random 16-byte salt, NFKC-normalised). The first 32 bytes are stored as a
  verifier; the last 32 become an AES-GCM key held only as a non-extractable `CryptoKey` inside the `DFOwnerSession`
  closure while unlocked. The passphrase and the key are never stored. (`lib/owner.js`)
* Wrong passphrases: 4 free attempts, then a delay that doubles from 30 s to 15 min. The right passphrase is refused
  during the delay. The counter is local state: whoever can edit extension storage can reset it (stated limit).
* It locks by itself after 5, 10 (default), 30 or 60 minutes without use (your choice), when the panel closes, or when
  you press the header indicator or **Lock now**. Locking drops the key, the in-memory log and any scan approvals Owner
  mode granted.
* While unlocked, an **Owner** chip with an accessible name sits in the header; activating it locks immediately.

## 2. What it protects, and how

| Data | Protection | Test |
| --- | --- | --- |
| Technical scan diagnostics (headers with values, probes, timings, request log, extension state) | sealed (AES-GCM) under `ownerSealed`; only a count is visible while locked; never part of the ordinary report | `e2e` "Owner mode", `test/owner.test.js` |
| Authorised-site list | sealed under `ownerOrigins`, bound to the context `origins` | e2e "authorised sites" |
| **Workspace items (optional)**: title, address and content of saved reports, screenshots, snapshots, workflows | sealed per item; id, project, kind and date stay readable and are *authenticated* (editing them breaks the record). Saving while locked is refused rather than writing plaintext. Migration is in place with a read-back check per item; turning it off writes plain data back; reset keeps the ciphertext (unreadable) rather than deleting it | `test/wsseal.test.js`, e2e "Workspace encryption at rest" |
| Exports of technical data | redacted by default (host names, paths, header values, request log, cookie names removed); each option adds one thing back; credential-bearing headers are never exported | `test/owner.test.js`, e2e |

## 3. Capability matrix

"Normal" is Owner mode off or locked.

| Capability | Normal | Owner mode unlocked | Why / what stays |
| --- | --- | --- | --- |
| Which sites a scan may target | the tab you are on | the tab you are on | scope is the active tab's origin; Owner mode does not add cross-site scanning (no such feature, and browser permissions still apply) |
| Per-site ownership confirmation on **public** sites | ticked each browser session | satisfied by the sealed **authorised-site list** (exact origin, with date), removed again on lock; you can untick it | the confirmation exists so nobody scans a site by accident; a standing, explicit, revocable attestation is the same promise made once |
| Advanced-level confirmation on public sites | required | **still required every time** | Advanced sends the most requests |
| Request budget | Passive 3 / Standard 60 / Advanced 150; you may lower | same; custom values only within the same ceiling | hard ceiling **200** requests, minimum pause **100 ms**, enforced in the page agent (`HARD_MAX_REQUESTS`), not only the UI: protects the target from floods and DevForge from being turned into a load generator |
| Same-origin, GET/HEAD only, no cookies, no bodies, redirects not followed | enforced | enforced | `secRequest` in `agent/security.js`; tested with off-origin, POST, `//host`, `data:`, `javascript:`, credentials, dot-segment and port-change attempts |
| Technical diagnostics | not collected | collected and sealed (option on by default while unlocked) | never includes cookie, storage or token values, secrets or response bodies |
| Redirect handling | not followed | not followed (a Settings option for downloads, guarded at the network layer) | see SECURITY-REVIEW #2 |
| Workspace storage | plain IndexedDB | optionally sealed | see §2 |
| Export | redacted | redacted by default; each unredacted category is a separate, explained tick | credential-bearing values are never exported |
| Session lifetime | n/a | 5/10/30/60 min idle, lock on close, manual lock, lock chip | the setting itself is not secret and lives in `ownerPrefs` |
| Dangerous or destructive actions | confirm dialogs | reset needs a confirmation, and typing `RESET` when encrypted Workspace items exist | nothing is deleted without saying what becomes unreadable |
| Browser permission requests | per site / per feature, from a click | unchanged | Owner mode requests nothing; the `cookies` permission still comes from the Security tab's own button |
| Restricted pages (`chrome://`, the Web Store, other extensions' pages, PDF viewer) | not reachable | not reachable | a browser rule; no DevForge setting changes it |

Things that are **platform restrictions, not DevForge policy:** cross-origin reads without host permission, restricted
browser pages, a page's own CORS rules, closed shadow roots, `sidePanel.open()` needing a user gesture,
optional permissions needing a user gesture, Chrome's refusal to side-load extensions in branded builds.

## 4. Trust boundary (what is and is not defended)

| Threat | Result |
| --- | --- |
| A web page or its scripts | cannot reach `DFOwnerSession` (it lives in the extension page); the capture channel is secret-gated and tested against replay, forged key events, navigation, and a page that poisons built-ins (see SECURITY-REVIEW #1, #10a) |
| Someone who copies the profile's files while locked | sees ciphertext. Offline guessing costs 600,000 PBKDF2 rounds per try; the passphrase is the protection |
| Someone at your unlocked browser | can read everything Owner mode shows until it locks. Lock when you leave |
| Someone who can edit extension storage | can reset the attempt counter, remove the vault (Owner mode then looks "not set up") or delete sealed data; cannot decrypt or forge sealed data |
| Someone who can modify the extension's files, or run code in an unlocked extension page | **not defended**: such code could capture the passphrase or the key |
| Malware with memory or debugger access | not defended |
| A forgotten passphrase | unrecoverable by design (technical records, authorised sites and encrypted Workspace items) |
| A false claim of ownership | not detectable; the confirmation is an attestation, as it always was |

Argon2/scrypt would resist GPUs better than PBKDF2, but WebCrypto offers only PBKDF2; adding a WASM KDF would add
unreviewed code to a security feature, so it is **not** done. Documented here as the choice it is.

## 5. Not done / not tested

* A cross-site "scan these ten sites" runner: not built; each scan is of the active tab.
* Lockout counter in `chrome.storage.session` or server-side: not possible without a server.
* Idle lock was tested with a shortened timer, not with the real wait.
* Behaviour in browsers other than Chromium: see docs/BROWSER-SUPPORT.md.
