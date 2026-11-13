# Exports

DevForge has three ways to take code out of a page. Pick by how much of the page you need.

| You want | Use | Result |
| --- | --- | --- |
| One part of a page: a card, a form, a header | Export → Selected part | A ZIP, or a single file |
| The files a page loads, as a browsable copy | Site → Download all site code | A ZIP with a rewritten copy of the page |
| A hand-picked mix (scripts, stylesheets, storage, network, HAR) | Export → Page bundle | One ZIP, or separate files |

Nothing is uploaded anywhere. Downloads of images, fonts and scripts come from the site that serves
them and follow the private-address rules in [SECURITY-MODEL.md](SECURITY-MODEL.md).

## Selected part

Pick an element (Inspect → pick, or the shortcut `Ctrl+Shift+U`), then open Export. The ZIP is laid
out like this:

```text
part-<name>/
  README.md                  what the part is, what it contains, how to use the files
  preview.png                a picture of the part as drawn when it was exported
  html/outer.html            the element and everything inside it (scripts removed)
  html/inner.html            only what is inside the element
  html/in-context.html       the part wrapped in the opening tags of its ancestors
  html/with-shadow-dom.html  the part with open shadow roots written out (only if it has any)
  html/standalone.html       opens in a browser with the styles applied; no scripts run
  html/svg/01.svg …          each inline SVG as its own file
  css/styles.css             the rules that apply to the part, with their media queries,
                             animations, fonts and the custom properties they read
  css/computed.css           the final value of every property of the outer element that
                             differs from the browser default
  css/matched-rules.json     every rule matching the outer element: stylesheet, specificity, winner
  css/inherited.json         which ancestor sets each inherited text property (font, colour …)
  css/shadow-dom.css         styles that live inside open shadow roots (only if there are any)
  js/handlers.js             inline event handler attributes (onclick, …)
  js/inline-scripts.js       code from inline scripts that refers to the part
  js/external-fragments.js   pieces of the page's script files that refer to the part
  data/selectors.txt         CSS selectors, XPath and a JS path that find the part again
  data/accessibility.json    role, accessible name and related facts
  data/structure.json        element tree, headings, forms, links, images, attributes
  data/text.txt              the visible text
  data/pseudo-elements.json  ::before / ::after content, which is not in the HTML
  data/framework-attributes.json  attributes added by frameworks (scoped-style ids and similar)
  data/json-ld.json          structured data inside the part (only if there is any)
  data/media-rules.json      media queries in the part's CSS, their breakpoints, and which apply at each preview width
  preview-responsive/        the part at 360, 768 and 1280 px (only with "capture 3 widths")
  data/assets.json           every image, font and media address, and the download result
  data/meta.json             page address, selector, framework hints, provenance
  assets/                    downloaded images, fonts and media
```

Files marked "only if" are written only when the part has that kind of content. Two options change
the output: **format code** (readable indentation, on by default; off keeps the text exactly as
the browser serialised it) and **include a preview picture** (uses the visible-tab capture, so the
part is scrolled into view and the tab must stay visible for a moment).

The buttons beside the ZIP download one file each: Outer HTML, Inner HTML, CSS, JavaScript (handlers,
inline scripts and script-file fragments joined), Documentation (the README) and Metadata.

**How script code is matched to the part.** Script text is parsed, and a statement is included when a
string in it contains the part's `#id`, a `.class`, or a `[data-attribute]`, or when it declares a
function that the part's inline handlers call. A whole function is returned when it is short enough.
This is name matching, not execution tracing, so treat it as a starting point and check it before
you reuse it. Listeners added with `addEventListener` cannot be listed by an extension; they appear
only when the script that adds them is found.

**Selecting the whole page.** If the selection covers (nearly) the whole page, the export becomes a
page export: rendered HTML, every inline and external script, every stylesheet, source maps, the web
app manifest and service worker scripts, a `_manifest.json` that lists what could not be read and why,
and a README for the page.

## What it finds, compared with Chrome DevTools

| DevTools can | DevForge's Selected part export | Notes |
| --- | --- | --- |
| Copy outerHTML / innerHTML | `html/outer.html`, `html/inner.html` | Formatted by default. The DOM as rendered now, not the original template. |
| Show the element inside its parents | `html/in-context.html` | Ancestors' opening tags, not their other children. |
| Show shadow DOM | `html/with-shadow-dom.html`, `css/shadow-dom.css` | Open roots only. Closed roots are invisible to extensions. |
| Matched rules, computed values | `css/matched-rules.json`, `css/computed.css`, `css/styles.css` | Rules from stylesheets the browser lets the extension read. |
| Inherited styles | `css/inherited.json` | The ancestor that sets each inherited property. |
| ::before / ::after | `data/pseudo-elements.json`, assets used by generated content | |
| Copy selector / XPath / JS path | `data/selectors.txt` | |
| Capture node screenshot | `preview.png` | |
| Sources panel, source maps | `js/*` fragments; the Site export recovers source-map sources | Fragments are found by name matching. |
| Event listeners panel | not available | Listeners added with `addEventListener` can be read only through the debugger, which DevForge deliberately does not request. |
| Coverage, request initiators | not available | Same reason. Network capture covers fetch/XHR made by scripts. |

**Three widths.** Tick **capture 3 widths** before you export. DevForge resizes this browser window to
360, 768 and 1280 pixels, takes a picture of the part at each one, and puts the window back to its
old size, even when a picture fails. Each picture is in `preview-responsive/`. The window only
resizes when it is in the normal state. A maximised or full-screen window is skipped, and the README
says so. The resize is short, but the window does change for a few seconds.

`data/media-rules.json` lists the media queries in the part's stylesheet. It says which breakpoints
each query uses and whether it applies at each of the three widths. Only `min-width` and `max-width`
(in px or em) are judged. A query with another feature, such as `prefers-color-scheme`, is marked
`unknown` and not guessed.

## Component code

Under the same **Selected part** section, pick a **component type** and click **Generate component
(ZIP)**. The code is built from the part's computed styles, the same way the Recreate tab builds it,
so it looks like the part but is not the original source.

| Type | Files |
| --- | --- |
| React component (JSX and CSS) | `Name.jsx`, `Name.css` |
| Vue single-file component | `Name.vue` |
| Web Component (shadow DOM) | `element-name.js`. The file defines a custom element and puts the styles inside its shadow root. |
| React project (runs with Vite) | `package.json`, `index.html`, `vite.config.js`, `src/main.jsx`, `src/Name.jsx`, `src/Name.css` |

Every ZIP has a README that says where the code came from (the element's selector and the page
address) and how to run it. The code files start with a comment that says the same.

Limits: event handlers, page scripts and state are not copied. Compare the result with the original
before you use it. A custom element name needs a hyphen, so a name without one gets `-part` added.
The React project pins React 18.3 and Vite 5.4. Run `npm install` once before you use it.

## Compare two exports

In the Export tab, under **Compare two exports**, pick two ZIP files made by Export or Site and click
**Compare**. The report lists the files that were added, removed or changed, and it can be saved as
Markdown or JSON. Nothing is uploaded; both ZIPs are read in the panel.

How each kind of file is compared:

- **HTML** ignores whitespace, comments and the ids DevForge writes (`df-…`, `__df_…`). It reports
  the elements and the text that were added or removed.
- **CSS** is compared rule by rule, by selector. A rule with the same selector and a different body
  is reported as changed. A media block is one rule.
- **JSON** ignores the fields that hold a time (`created`, `generatedAt` and similar).
- **Everything else** is compared by its SHA-256.
- `README.md`, `_manifest.json`, `_devforge/report.json` and `RECREATION-REPORT.md` are left out,
  because they hold the time of the export. The report says which files were left out.

The top folder with the export's name is ignored, so two exports of the same part can be compared.
A ZIP with a name that tries to leave its folder (`../`, an absolute path, `C:/`) is skipped and
listed. A file over 2 MB is compared by its bytes. A comparison of more than 5,000 files is refused.

## Site → Download all site code

Scan the page first, then download. The ZIP contains:

```text
README.md                    counts, layout and the files that failed
index.html                   the rendered page, links to downloaded files pointed at the local copies
_original/page.html          the HTML exactly as the server sent it
site/<host>/…                every downloaded file, laid out like its address
inline/                      each inline <script> and <style> as a file
app/                         web app manifest and service worker scripts
data/page.json               title, meta tags, headings, forms, links, microdata
data/json-ld.json            structured data
docs/OVERVIEW.md             a plain description of the page
_sourcemaps/                 original sources recovered from source maps with embedded content
_captured-api/               responses seen while Network capture was on, secrets masked
_devforge/report.json        every file: saved, failed or skipped, and why
```

Limits: at most 1,500 files, 150 MB in total, 25 MB per file. Private and loopback addresses that the
page is not on are never fetched. API addresses are not requested again; responses captured in the
Network tab are included instead.

## Bundle analysis

Under **Bundle analysis** in the Site tab, pick a ZIP from **Download all site code** and click
**Analyse**. For each script that has a source map, the script's bytes are split between the
original files the map names. The table lists the largest files, and a second table lists packages
that appear in more than one folder (two copies of `lodash`, for example). Nothing is uploaded.

What the numbers mean:

- A map is found through the `sourceMappingURL` comment at the end of a script, through a `.map` file
  with the script's name, or as an inline base64 map. A map at an `https:` address is not followed.
- Sizes are estimates from the mapping. A byte that the map does not cover is counted as unmapped.
- Indexed maps (with `sections`) are not analysed. The report says so.
- If no map in the ZIP has its source text (`sourcesContent`), the report says that. The file names
  and sizes still come from the map.

Save JSON writes the same figures for another tool. The source text is never shown in this report.

## OpenAPI and types from captured calls

In the Network tab, **OpenAPI + types** writes a ZIP from the calls in the current filter:

```text
api-<time>/
  openapi.json   OpenAPI 3.0.3, one operation per method and path
  types.d.ts     TypeScript types for each request and response body
  README.md      what was used and what was left out
```

The schemas are guesses from the JSON that was captured. They are not the real API.

- Paths with numbers or UUIDs in them are grouped: `/users/42` and `/users/7` become `/users/{id}`.
- A key is required only when every sample had it. A value that is sometimes null is nullable.
  A value of more than one type becomes a union.
- Query keys are listed as parameters. Their values are not written.
- Only the origin with the most calls is used. Calls to other origins are counted in the README.
- Bodies that are not JSON, or are cut short, are skipped and counted.
- The output holds types only, never the values in the bodies, so a token in a body is not copied.
  The export still goes through the secrets check before the download.

## Resources that load after the page

Some scripts, stylesheets and images arrive after the first render. They are not in the HTML that
the browser first loaded, so an export made before they arrive does not have them.

To catch them, press **Start watching for late resources** in the Export tab, or tick
**resources that load after the page** in the Site tab's options, before the page loads them. Two
observers then record what arrives: one for script, stylesheet, image and media elements added to
the page, and one for the browser's resource timing, which keeps entries after the timing buffer is
full.

- **Part export.** Tick **include resources that load after the page**. The files go in
  `loaded-later/` (`js/`, `css/`, `images/`, `other/`), and `data/loaded-later.json` lists each
  resource with its status.
- **Site ZIP.** The same resources join the download queue, under `site/`, with their own entries
  in the report.

What is not done, and why:

- **API and XHR calls** are listed, not sent again. Sending a request again can change data on the
  server, so the Site download has always left these out. Network capture keeps their responses.
- **Resources loaded before watching started** are listed only if the browser still has their
  timing. Nothing before that point is recorded, and the file says so.
- **Frames, shadow roots and elements that are added and removed again** are not watched.
- **Private addresses** that the page is not on are skipped, as in every other download.
- **Limits:** 300 entries, 60 files, 8 MB per file.

## Secrets check

Before a ZIP, a single exported file or an AI prompt leaves the panel, DevForge looks for values that
have the shape of a credential: AWS access keys, Stripe live keys, GitHub, Slack and SendGrid tokens,
Google API keys, private keys, JSON Web Tokens, and assignments such as `apiKey: "…"` or
`"password": "…"` with a long, non-placeholder value. Images, fonts and other binary files are not
read. If anything matches, a dialog lists each match as kind, file and line (the value is never shown)
and asks what to do:

- **Mask them** replaces each value with `[REDACTED:kind]`. A private key is replaced from its first
  line to its last. The rest of the file is unchanged.
- **Keep, with a warning** exports the files as they are.
- **Leave those files out** drops every file that has a match (ZIPs only).
- **Cancel** saves nothing.

Unless you cancel, the ZIP also contains `_devforge-secrets.md`, which lists the same kind, file and
line. It is a check on shape only. It can flag a public key or an example, and it cannot find a secret
that looks like ordinary text. Review the files yourself before you share them.

## Storage: IndexedDB, Cache Storage and service workers

The Storage tab lists the databases, caches and service workers of the page. Each one has a
**Browse** button.

- **IndexedDB.** A store shows up to 200 records at a time. A record can be edited when its key is
  kept outside the value. The editor takes JSON. Dates written as `{"$date": "…"}` are saved as dates.
  Other marked values (binary data, blobs, maps) are written as they are shown, so they change. A
  store whose key is inside the value cannot be edited or deleted here. **Export this store** writes
  up to 10,000 records or 20 MB as JSON. The file says whether it is complete.
- **Cache Storage.** Lists up to 500 entries with their status, type and size. **Export cache (ZIP)**
  saves each body under `cache/` with a `manifest.json`. It stops at 50 MB of bodies, and bodies
  over 8 MB are listed but not saved. An opaque response has no body the browser lets scripts read.
  The export goes through the secrets check.
- **Service workers.** **Unregister** stops the worker for its scope. The page can register it again
  on its next visit.

Every delete asks first. Deleted data cannot be recovered from DevForge. Export first if you need a
copy.

## Encrypted ZIP

Tick **encrypt the full ZIP with a passphrase** in the Export tab, type the passphrase twice (at
least 12 characters), and click **Download everything (ZIP)**. The file is named
`<name>.zip.devforge-enc`. It is a JSON file that holds the ZIP sealed with:

- a key from your passphrase, made with PBKDF2-SHA256 (600,000 rounds and a random salt), and
- AES-GCM with a random IV.

The header (the key settings, the IV and the time) is checked with the data, so changing any part of
the file makes it fail to open. There is no way to recover a file whose passphrase you lost.

To open the file, open `tools/decrypt.html` from the DevForge source folder in a browser. It works
without a network connection, and it does not send the file or the passphrase anywhere. Choose the
file, type the passphrase and save the ZIP. A wrong passphrase gives one message and no output.

Not included: sealing with the Owner key. The decrypt page cannot open the Owner vault, so a file
sealed that way could not be opened without DevForge's Owner mode. Only the passphrase method is
available for exports.

## What no export can contain

Server-side code and databases, private APIs, credentials, content a page never requested, closed
shadow roots, the content of cross-origin frames (they are listed, not downloaded), HttpOnly cookies, and original sources when no
source map is published. Content that a script builds after an interaction is included only if it is in the page when you export. Use exports only for pages you are allowed to copy.
