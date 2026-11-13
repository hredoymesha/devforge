# Privacy

DevForge has no account, no server of its own and no analytics. It does not phone home. Its code
contains no address to send usage data to. This page says what it keeps on your computer, what it
sends and when, and why it asks for each permission. Each claim was checked against the code.

## What DevForge keeps, and where

Everything stays in your browser profile.

| Where | What | Cleared by |
| --- | --- | --- |
| `chrome.storage.local` | Your settings (`settings`); interception rules (`netRules`); performance readings per page (`perfHistory`, under a hashed key, not the address); acknowledged Security findings (`secFindingAcks`); a random salt for those keys (`installSalt`); the time of the last clean-up. With Owner mode: the sealed passphrase check, sealed scan records, the sealed list of sites you authorised and the idle-lock choice. | Settings, Stored data and clean-up buttons; removing the extension |
| `chrome.storage.session` | Short-lived state: the list of sites DevForge worked on (`siteLog`, web addresses without paths; in memory only, cleared when the browser closes, never written to disk), a command waiting for the panel (`pendingCommand`), the capture channel's key for a tab, the per-site ownership confirmations for the Security checker (`secAcknowledged`), Owner scan approvals. | Closing the browser |
| IndexedDB, database `devforge` | Workspace projects and the items you save (elements, components, screenshots, data, workflows, playgrounds, AI tasks, Security reports). | Deleting items or projects in Workspace; removing the extension |

Workspace items and saved Security reports are **not encrypted** unless you turn on Owner mode
encryption. A Security report describes a site's weak points, so treat it like any sensitive file.
Network captures live in the page's memory while capture is on. Saved bodies and headers are redacted
by default.

When DevForge reads this data back, it checks it first (`lib/stored.js`). Anything not valid is ignored
and listed in Settings, under Stored data.

To delete everything: use the clean-up buttons in Settings, delete your projects in Workspace, then
remove the extension. Removing the extension deletes its storage and its IndexedDB database.

## What DevForge sends, and when

Only requests that you start:

- **Exports, the Site download and source-map recovery** download the files a page uses, from the sites
  that serve them. They omit credentials, refuse private and loopback addresses that the page is not on,
  and have size and time limits.
- **The Security checker** sends `GET` and `HEAD` requests to the site in the open tab only, without
  cookies, within a request budget. **Check again** and the integrity-hash helper work the same way; the
  integrity helper also downloads the page's third-party scripts and stylesheets.
- **Network tab replay and mocks** send the request you chose to replay, to the address in it.
- **AI tab.** *Copy only* stays on your computer. *Copy & open* opens the AI site you picked in a new tab
  (claude.ai, chatgpt.com, gemini.google.com or copilot.microsoft.com). For some sites and prompts under
  6,000 characters it puts the prompt in that address, so it is sent to that site when the tab opens.
  Before the prompt is copied, DevForge checks it for credential-like values and offers to mask them.
- **Exports** are checked for credential-like values before they are saved, and nothing is uploaded.

DevForge does not send your settings, saved items, browsing history or page contents anywhere else.
Pages you work on can see the traces listed in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) section 6.

## Permissions and why

| Permission | Why |
| --- | --- |
| `activeTab` | Temporary access to the tab you open DevForge on. |
| `scripting` | Injects the inspector and the network capture, only when you use them. |
| `sidePanel` | Shows the panel. |
| `storage` | Keeps the settings and data above. |
| `contextMenus` | Adds "Inspect with DevForge" to the right-click menu. |
| `clipboardWrite` | Copies code and prompts when you ask. |
| `declarativeNetRequest` | Installs a rule that blocks DevForge's own downloads from reaching private, loopback or link-local addresses, including at each redirect step. It only blocks. It cannot read or change pages. |
| Site access (all sites) | So DevForge works on any page without a prompt for each site (exports, capture from page start, screenshots). In Settings you can limit it to sites you list. Chrome's own Site access control on the extension page still applies. |
| `cookies` (optional) | Asked for only from the Security tab, for one site, to read whether cookies are HttpOnly, Secure and SameSite. Cookie values are never read into reports. |

The `debugger` permission is not requested.

## Third-party code

DevForge bundles Acorn and js-beautify (see the README). They run inside the extension and make no
network requests of their own.

## Questions

Open an issue in the repository. Do not include secrets in it.
