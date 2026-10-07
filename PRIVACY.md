# Privacy

DevForge does not collect, store remotely or transmit personal data. There is no analytics, no
account and no server operated by the project.

- Page data you inspect stays in the browser. Workspace items are stored locally in IndexedDB;
  theme and shortcuts in `chrome.storage.local`.
- Network requests DevForge makes are the ones you trigger: downloading assets or a site copy
  from the sites that served them (without your cookies, except same-origin files fetched from
  inside the page), and opening an AI website in a new tab with a prompt you reviewed. That
  prompt is also copied to your clipboard.
- AI prompts can contain page content. Review the text before you send it; once it is on another
  service, that service's terms apply.
- Network capture redacts secrets by default. Turning that off is a per-session checkbox.
