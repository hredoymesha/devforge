// Icons for the tab bar, Home tab and Security tab. Simple 24px outline shapes drawn with
// currentColor, so they follow the theme and the active/hover colours. Decorative by default:
// the label or the button's aria-label carries the meaning.
const DF_ICON_PATHS = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h5v-6h4v6h5V10'],
  inspect: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  css: ['M8 4c-2 0-2 1-2 3v2c0 1.5-1 2.500-2 3 1 .5 2 1.500 2 3v2c0 2 0 3 2 3', 'M16 4c2 0 2 1 2 3v2c0 1.500 1 2.500 2 3-1 .5-2 1.500-2 3v2c0 2 0 3-2 3'],
  network: ['M7 20V5', 'M3 9l4-4 4 4', 'M17 4v15', 'M13 15l4 4 4-4'],
  perf: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  mutations: ['M3 12h4l3-8 4 16 3-8h4'],
  storage: ['M4 6c0-1.700 3.600-3 8-3s8 1.300 8 3-3.600 3-8 3-8-1.300-8-3z', 'M4 6v6c0 1.700 3.600 3 8 3s8-1.300 8-3V6', 'M4 12v6c0 1.700 3.600 3 8 3s8-1.300 8-3v-6'],
  tokens: ['M12 3a9 9 0 1 0 0 18c1.500 0 2-1 1.500-2.200-.5-1.300.3-2.300 1.700-2.300H17a4 4 0 0 0 4-4c0-5-4-9.500-9-9.500z', 'M7.500 11h.01', 'M10 7.500h.01', 'M14 7.500h.01'],
  export: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
  site: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'],
  recreate: ['M9 9h11v11H9z', 'M5 15V4h11'],
  audit: ['M9 4h6l1 2h3v14H5V6h3z', 'M9 13l2 2 4-4'],
  owner: ['M15 3a5 5 0 1 0 1 9.600', 'M13 11L4 20', 'M7 17l2.500 2.500', 'M10 14l2.500 2.500'],
  security: ['M12 3l8 3v6c0 4.500-3.200 7.600-8 9-4.800-1.400-8-4.500-8-9V6z', 'M9 12l2 2 4-4'],
  data: ['M3 5h18v14H3z', 'M3 10h18', 'M9 5v14'],
  ai: ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'],
  play: ['M6 4l14 8-14 8z'],
  auto: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'],
  work: ['M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  settings: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', 'M15 4v4', 'M9 10v4', 'M17 16v4'],
  check: ['M5 12l5 5 9-10'],
  alert: ['M12 3l10 18H2z', 'M12 10v5', 'M12 18h.01'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 8h.01'],
  skip: ['M5 12h14'],
  pick: ['M4 4l7 16 2.500-6.500L20 11z'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5H5V6h5'],
  copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
  download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
  retry: ['M4 12a8 8 0 1 1 3 6.200', 'M4 19v-5h5'],
  stop: ['M6 6h12v12H6z'],
  link: ['M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1', 'M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1'],
  path: ['M5 6a2 2 0 1 0 0-.01', 'M19 18a2 2 0 1 0 0-.01', 'M7 6h6a4 4 0 0 1 0 8h-2a4 4 0 0 0 0 8'],
};

function icon(name, size = 16) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ico');
  for (const d of DF_ICON_PATHS[name] || DF_ICON_PATHS.info) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
