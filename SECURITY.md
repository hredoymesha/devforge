# Security policy

## Reporting a vulnerability

Please report security problems privately and do not open a public issue.

Use GitHub's private reporting: open the **Security** tab of this repository and choose
**Report a vulnerability**. Include the DevForge version (shown in `chrome://extensions`), the
Chrome version, what you did, what you expected and what happened. A small page that reproduces
the problem helps most.

You can expect an acknowledgement within a few days. Fixes are released as a new version and
listed in [CHANGELOG.md](CHANGELOG.md).

## Supported versions

Only the latest release receives fixes.

## Scope

In scope: the extension in this repository, including the network capture channel, the page agent,
the download and export code, Owner mode and the Security checker's request limits.

Out of scope: weaknesses in sites that you inspect with DevForge, and the limits of browser
extensions that [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) already lists.

## Using the Security checker

The Security tab is for sites you own, sites you have permission to test, and local or training
environments. It makes a small, limited number of same-origin read requests and never attempts to
break in. You are responsible for having permission to test a site.
