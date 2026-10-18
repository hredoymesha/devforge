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

## What no export can contain

Server-side code and databases, private APIs, credentials, content a page never requested, closed
shadow roots, the content of cross-origin frames (they are listed, not downloaded), HttpOnly cookies, and original sources when no
source map is published. Content that a script builds after an interaction is included only if it is in the page when you export. Use exports only for pages you are allowed to copy.
