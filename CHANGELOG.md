# Changelog

## 3.1.0

- Site tab: download a page's code and assets as a ZIP, with an offline snapshot, source-map
  recovery, a per-file report, cancel support and size limits.
- Recreate: generated CSS can no longer close its `<style>` element, and the comparison frames run
  with scripts disabled.
- CSV export: cells that start with `=`, `+`, `-`, `@` or `|` are prefixed so spreadsheets read them
  as text.
- Playground: preview is offline (`connect-src 'none'` and friends). Imported or saved code waits
  for **Run**.
- Network capture: bodies are read as a bounded stream, with a cap on parallel reads and total
  memory. Secrets in URLs, headers, JSON and form bodies are redacted by default.
- Component export removes inline `on*` handlers and `javascript:` URLs unless turned off.
- Downloads never fetch loopback or private-network addresses the page is not itself on.
- Source-map paths and URLs are sanitised segment by segment (fixes a path traversal via
  percent-encoded `..`).
- Panel code split into one file per tab; ESLint and Prettier added.

## 3.0.0

- Rewrite as a Manifest V3 side-panel extension. Inspect, CSS, Export, Recreate, Network, Audit,
  Data, AI, Playground, Automate, Workspace and Settings tabs.
