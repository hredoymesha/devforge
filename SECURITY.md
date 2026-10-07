# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private reporting:
**Security tab > Report a vulnerability** on this repository. Include the page or file that
triggers the problem and the browser version. You can expect a first reply within a week.

## Scope

DevForge handles untrusted page content. These are in scope:

- Page-controlled data reaching a place where it can run script (the side panel, exports,
  generated code, the preview frames).
- Writing outside the intended folder when a ZIP is extracted.
- Requests to private or loopback addresses that the page did not make itself.
- Secrets appearing in exports when redaction is on.

Out of scope: behaviour of the sites you inspect, and anything that needs an already-compromised
browser profile.
