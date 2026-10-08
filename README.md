# DevForge 4.0.0

A local-first web development workbench that lives in Chrome's side panel. DevForge sits next to
the page you are working on and gives you an inspector, a network layer you can intercept and
rewrite, Core Web Vitals profiling, a DOM mutation timeline, storage editing and design-token
extraction. Everything runs in your browser. There are no accounts, servers or analytics.

[English](#english) · [বাংলা](#বাংলা)

---

## English

### Why DevForge

Chrome DevTools is the reference, and DevForge does not try to replace it. It covers the work
that DevTools makes slow: mocking an API response without a proxy, seeing which element caused
your LCP, exporting a component with its computed styles, or turning a site's colours into
design tokens. DevForge is a Manifest V3 extension. It asks for the least access it needs, and
it only injects code into a page when you use a tool on that page.

### Panels

The panels are grouped the way you would move through a debugging session.

**Inspect and style**

| Panel | What it does |
| --- | --- |
| Inspect | Element picker, DOM tree, selectors, box model and accessibility info. Includes a component inspector for React, Vue 2/3, Svelte and Angular (dev mode), quick edits with undo/redo, and a layout X-ray. |
| CSS | Matched rules, computed styles and live edits that are checked before they are applied. Emulates `:hover`/`:focus` without the debugger permission. |
| Tokens | Pulls colours, type scale, spacing, radii and shadows from computed styles. Exports CSS variables, SCSS, W3C design-token JSON or a Tailwind theme. |

**Network**

| Panel | What it does |
| --- | --- |
| Network | Live capture of `fetch`, XHR, WebSocket, EventSource and `sendBeacon`. Filters work like DevTools (`status:4xx`, `method:post`, `domain:`, `larger-than:`, `is:mocked`, `-exclude`). Also: sortable columns, a waterfall, timing phases (DNS / TCP / TLS / TTFB / download), Server-Timing, GraphQL operation names, edit and replay, copy as cURL / fetch / PowerShell, and HAR 1.2 export. |
| Interception rules | Add latency, set request headers, block, mock a response or redirect. Rules are checked in order for each request and are saved between sessions. You can turn on capture from page start for each site. |

**Performance**

| Panel | What it does |
| --- | --- |
| Perf | LCP, CLS, INP, FCP and TTFB, each linked to the element that caused it. Slow interactions are split into input delay, processing and presentation. Also shows navigation timing, Long Animation Frame script attribution and a frame-rate profiler. |
| Mutations | A timeline of DOM changes with old and new values. Shows the most-changed elements and the change rate, detects writes that change nothing, can flash changes on the page, and exports to JSON. |
| Audit | Accessibility, performance and passive security checks, run only when you ask. |

**Application**

| Panel | What it does |
| --- | --- |
| Storage | View, edit, add and delete localStorage, sessionStorage and cookies that scripts can read. Also lists IndexedDB, Cache Storage, service workers and quota usage. |
| Data | Pulls links, images, tables, forms and headings from the page into CSV, JSON, Markdown or HTML. |

**Build and ship**

| Panel | What it does |
| --- | --- |
| Export | Exports a component as code, writes a developer report, and takes element, viewport or full-page screenshots (stitched, with sticky bars kept only once). Also compares snapshots pixel by pixel. |
| Site | Detects the site's technology and saves a snapshot of the files the page uses. Recovers the original sources where the site publishes source maps. Never fetches private or loopback addresses. |
| Recreate | Rebuilds an element from its computed styles, then refines the copy until its layout matches the original. |
| Playground | An HTML/CSS/JS scratchpad that runs in a sandboxed page with no access to extension APIs. |
| Automate | Records and replays step-by-step workflows, stored as JSON. |
| AI | Builds a prompt from the selected element or task. You paste it into the AI chat you already use. No API keys are needed, and nothing is sent until you click Send. |
| Workspace | Projects that collect what you save from other panels (elements, components, screenshots, data, workflows, playgrounds, AI tasks), stored in IndexedDB. |

A command palette (`Ctrl+K`), in-panel shortcuts you can rebind, and light, dark and system
themes are available in every panel.

### Architecture

```
background.js        Service worker. Opens the panel and passes keyboard and context-menu
                     commands to it. No other work happens here.
sidepanel.html       The workbench UI. Classic scripts that share one scope, in load order:
  lib/               Pure helpers (HAR, ZIP, token maths, redaction, validation, storage).
                     Each also exports itself through module.exports so it can be tested in Node.
  panel/core.js      Shared state, DOM helper, agent injection and messaging.
  panel/*.js         One file per panel, registered with registerTab().
  panel/boot.js      Tab bar, command palette, theming and startup. Loaded last.
agent.js, agent/*    The page agent. Injected on demand into the page's isolated world, never at
                     page load. It is versioned (AGENT_VERSION) so an outdated copy left in a tab
                     is replaced. Values it could not observe directly are tagged:
                     observed | extracted | inferred | generated | unavailable.
netcap.js            Network capture and interception. Runs in the page's MAIN world so it can
                     wrap fetch / XHR / WebSocket / EventSource / sendBeacon. Can be registered
                     at document_start for each site.
sandbox.html/.js     Runs Playground code on an opaque origin with its own strict CSP.
```

Where data is stored: settings and interception rules go in `chrome.storage.local`, a command
waiting for the panel to start goes in `chrome.storage.session`, and Workspace projects go in
IndexedDB. None of it leaves the browser.

### Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Temporary access to the tab you open DevForge on. |
| `scripting` | Injects the inspector and network capture, only when you use them. |
| `sidePanel` | Shows the workbench. |
| `storage` | Saves preferences and interception rules on your machine. |
| `contextMenus` | Adds **Inspect with DevForge** to the right-click menu. |
| `clipboardWrite` | Copies code and prompts when you ask. |
| Site access (optional) | Requested per site, only to export assets, read cross-origin stylesheets or capture from page start. You can revoke it in the extension's details page. |

### Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin DevForge and open it with the toolbar icon or `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS).
   Press `Ctrl+Shift+U` to pick an element.

Chrome 116 or newer is required.

### Development

The extension has no build step: the files in the repository are exactly what Chrome loads.
Before you commit, run at least a syntax check:

```sh
for f in $(git ls-files '*.js'); do node --check "$f" || exit 1; done
```

For a Chrome Web Store upload, zip the extension files only (leave out `README.md`,
`CHANGELOG.md` and `.gitignore`). Keep the manifest `description` at 132 characters or fewer.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## বাংলা

### DevForge কী

DevForge হলো Chrome-এর সাইড প্যানেলে চলা একটি লোকাল-ফার্স্ট ওয়েব ডেভেলপমেন্ট ওয়ার্কবেঞ্চ।
আপনি যে পেজে কাজ করছেন, তার পাশেই এটি থাকে। এতে আছে এলিমেন্ট ইন্সপেক্টর, নেটওয়ার্ক
ইন্টারসেপশন, Core Web Vitals প্রোফাইলিং, DOM মিউটেশন টাইমলাইন, স্টোরেজ এডিটর এবং ডিজাইন টোকেন
এক্সট্রাকশন। সবকিছু আপনার ব্রাউজারেই চলে। কোনো অ্যাকাউন্ট, সার্ভার বা অ্যানালিটিক্স নেই।

DevForge Chrome DevTools-এর বিকল্প নয়। DevTools-এ যে কাজগুলো ধীরগতির, সেগুলো এটি সহজ করে।
যেমন প্রক্সি ছাড়াই API রেসপন্স মক করা, কোন এলিমেন্টের কারণে LCP ধীর হলো তা দেখা, অথবা
একটি সাইটের রংগুলোকে ডিজাইন টোকেনে রূপান্তর করা।

### প্রধান ফিচার

**নেটওয়ার্ক**
- `fetch`, XHR, WebSocket, EventSource ও `sendBeacon`-এর লাইভ ক্যাপচার।
- DevTools-এর মতো ফিল্টার: `status:4xx`, `method:post`, `domain:`, `larger-than:`, `is:mocked`।
- ওয়াটারফল, টাইমিং ধাপ (DNS / TCP / TLS / TTFB / ডাউনলোড), Server-Timing এবং GraphQL অপারেশন শনাক্তকরণ।
- রিকোয়েস্ট এডিট করে আবার পাঠানো, cURL / fetch / PowerShell হিসেবে কপি, এবং HAR 1.2 এক্সপোর্ট।
- ইন্টারসেপশন রুল: দেরি যোগ করা, হেডার বসানো, ব্লক, মক রেসপন্স বা রিডাইরেক্ট। রুলগুলো
  সেশনের পরেও থেকে যায়।

**পারফরম্যান্স**
- LCP, CLS, INP, FCP ও TTFB, প্রতিটির জন্য দায়ী এলিমেন্টসহ।
- ধীর ইন্টারঅ্যাকশনকে input delay, processing ও presentation-এ ভাগ করে দেখানো।
- Long Animation Frame স্ক্রিপ্ট অ্যাট্রিবিউশন এবং ফ্রেম-রেট প্রোফাইলার।
- DOM মিউটেশন টাইমলাইন: আগের ও পরের মান, সবচেয়ে বেশি পরিবর্তিত এলিমেন্ট, এবং কিছুই বদলায় না
  এমন অপ্রয়োজনীয় রাইট শনাক্তকরণ।

**ডেভেলপার ওয়ার্কফ্লো**
- React, Vue, Svelte ও Angular কম্পোনেন্ট ইন্সপেক্টর, undo/redo সহ দ্রুত এডিট।
- localStorage, sessionStorage ও কুকি দেখা ও এডিট করা; IndexedDB ও Cache Storage দেখা।
- ডিজাইন টোকেনকে CSS ভেরিয়েবল, SCSS, W3C JSON বা Tailwind থিম হিসেবে এক্সপোর্ট।
- কম্পোনেন্ট এক্সপোর্ট, পুরো পেজের স্ক্রিনশট, অডিট এবং স্যান্ডবক্সড প্লেগ্রাউন্ড।
- কমান্ড প্যালেট (`Ctrl+K`) এবং নিজের মতো বদলানো যায় এমন শর্টকাট।

### আর্কিটেকচার সংক্ষেপে

- **সার্ভিস ওয়ার্কার** (`background.js`) খুব ছোট রাখা হয়েছে। এটি শুধু প্যানেল খোলে আর কমান্ড
  প্যানেলে পৌঁছে দেয়।
- **পেজ এজেন্ট** (`agent.js`) পেজ লোডের সময় নয়, কেবল আপনি কোনো টুল ব্যবহার করলে তখনই ইনজেক্ট হয়।
- **নেটওয়ার্ক ক্যাপচার** (`netcap.js`) পেজের MAIN world-এ চলে, তাই পেজের নিজের নেটওয়ার্ক কলগুলো
  দেখতে ও বদলাতে পারে।
- **প্লেগ্রাউন্ড** একটি আলাদা স্যান্ডবক্স পেজে চলে, যেখানে এক্সটেনশনের কোনো API-তে প্রবেশাধিকার নেই।
- সেটিংস ও রুল থাকে `chrome.storage.local`-এ, আর ওয়ার্কস্পেস থাকে IndexedDB-তে। কোনো ডেটা
  ব্রাউজারের বাইরে যায় না।

### ইনস্টল করার নিয়ম

1. এই রিপোজিটরি ক্লোন করুন।
2. `chrome://extensions` খুলে **Developer mode** চালু করুন।
3. **Load unpacked** ক্লিক করে রিপোজিটরির ফোল্ডারটি নির্বাচন করুন।
4. টুলবার আইকন বা `Ctrl+Shift+Y` দিয়ে DevForge খুলুন। এলিমেন্ট বাছাই করতে `Ctrl+Shift+U` চাপুন।

Chrome 116 বা তার নতুন ভার্সন প্রয়োজন।

### গোপনীয়তা

DevForge নিজে থেকে কোনো নেটওয়ার্ক রিকোয়েস্ট পাঠায় না। ব্যতিক্রম শুধু আপনার নিজের চালু করা কাজ:
এক্সপোর্টের জন্য পেজের অ্যাসেট ডাউনলোড করা, অথবা আপনি নিজে Send চাপলে কোনো AI সাইটে প্রম্পট খোলা।
সাইট অ্যাক্সেস ঐচ্ছিক এবং প্রতিটি সাইটের জন্য আলাদাভাবে চাওয়া হয়।
