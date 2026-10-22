// Line icons for the infrastructure dashboard (dashboard-map.mjs): 20×20, stroke currentColor, decorative only
// (aria-hidden, focusable false). Pure strings, no imports, so both /_sim/ and /_setup/ can serve this file.
const PATHS = Object.freeze({
  mark: '<path d="M10 1.8 17.2 6v8L10 18.2 2.8 14V6z"/><path d="M10 6.2 13.6 8.3v4.1L10 14.5l-3.6-2.1V8.3z"/><path d="M10 1.8v4.4M17.2 14l-3.6-1.6M2.8 14l3.6-1.6"/>',
  visitor: '<circle cx="10" cy="6.5" r="3.2"/><path d="M3.5 17.5c.8-3.4 3.4-5.2 6.5-5.2s5.7 1.8 6.5 5.2"/>',
  staff: '<rect x="2.5" y="6" width="15" height="10.5" rx="2"/><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h3A1.5 1.5 0 0 1 13 4.5V6M2.5 10.5h15M9 10.5v1.5h2v-1.5"/>',
  client: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="m7.5 8-2 2 2 2M12.5 8l2 2-2 2"/>',
  lense: '<path d="M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10z"/><circle cx="10" cy="10" r="2.6"/>',
  persona: '<circle cx="10" cy="10" r="7.7"/><circle cx="10" cy="8.2" r="2.5"/><path d="M5.2 15.8c.9-2.1 2.7-3.2 4.8-3.2s3.9 1.1 4.8 3.2"/>',
  link: '<path d="M8.3 11.7a3.3 3.3 0 0 0 4.7 0l2.8-2.8a3.3 3.3 0 0 0-4.7-4.7l-1 1"/><path d="M11.7 8.3a3.3 3.3 0 0 0-4.7 0l-2.8 2.8a3.3 3.3 0 0 0 4.7 4.7l1-1"/>',
  globe: '<circle cx="10" cy="10" r="7.7"/><path d="M2.3 10h15.4M10 2.3c2.2 2.3 3.2 4.9 3.2 7.7s-1 5.4-3.2 7.7c-2.2-2.3-3.2-4.9-3.2-7.7s1-5.4 3.2-7.7z"/>',
  apps: '<rect x="2.5" y="2.5" width="6" height="6" rx="1.4"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.4"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.4"/><rect x="11.5" y="11.5" width="6" height="6" rx="1.4"/>',
  canvas: '<path d="M3 17l1.2-4.2L13.5 3.5a2 2 0 0 1 2.9 0l.1.1a2 2 0 0 1 0 2.9L7.2 15.8z"/><path d="m12 5 3 3"/>',
  code: '<path d="m6.5 5.5-4 4.5 4 4.5M13.5 5.5l4 4.5-4 4.5M11.5 3.5l-3 13"/>',
  component: '<path d="M8 3h4v2.2a1.8 1.8 0 1 0 3.6 0V3H17v5h-2.2a1.8 1.8 0 1 0 0 3.6H17V17H3v-5.4h2.2a1.8 1.8 0 1 0 0-3.6H3V3z"/>',
  api: '<rect x="2.5" y="3.5" width="15" height="5" rx="1.5"/><rect x="2.5" y="11.5" width="15" height="5" rx="1.5"/><path d="M5.5 6h.01M5.5 14h.01M9 6h5M9 14h5"/>',
  sql: '<ellipse cx="10" cy="4.8" rx="6.5" ry="2.5"/><path d="M3.5 4.8v10.4c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V4.8"/><path d="M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/>',
  key: '<circle cx="6.5" cy="13.5" r="3.5"/><path d="m9 11 7.5-7.5M13.5 6.5l2 2M11.5 8.5l1.5 1.5"/>',
  admin: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2v2.2M10 15.8V18M2 10h2.2M15.8 10H18M4.3 4.3l1.6 1.6M14.1 14.1l1.6 1.6M4.3 15.7l1.6-1.6M14.1 5.9l1.6-1.6"/>',
  setup: '<path d="M3 5h9M15 5h2M3 10h3M9 10h8M3 15h7M13 15h4"/><circle cx="13.5" cy="5" r="1.6"/><circle cx="7.5" cy="10" r="1.6"/><circle cx="11.5" cy="15" r="1.6"/>',
  table: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M2.5 8h15M2.5 12.3h15M8 8v8.5"/>',
  shield: '<path d="M10 2.3 16.5 5v4.6c0 4-2.7 6.9-6.5 8.1-3.8-1.2-6.5-4.1-6.5-8.1V5z"/><path d="m7.2 10 2 2 3.8-3.8"/>',
  logic: '<path d="M11 2 4.5 11.2H10L9 18l6.5-9.2H10z"/>',
  flow: '<circle cx="4.5" cy="5" r="2"/><circle cx="15.5" cy="10" r="2"/><circle cx="4.5" cy="15" r="2"/><path d="M6.5 5h3a3 3 0 0 1 3 3v2h1M6.5 15h3a3 3 0 0 0 3-3v-2"/>',
  clock: '<circle cx="10" cy="10" r="7.7"/><path d="M10 5.5V10l3 2"/>',
  queue: '<rect x="2.5" y="4" width="15" height="3.5" rx="1"/><rect x="2.5" y="8.3" width="15" height="3.5" rx="1"/><rect x="2.5" y="12.6" width="15" height="3.5" rx="1"/>',
  webhook: '<circle cx="10" cy="5.5" r="2.5"/><circle cx="4.8" cy="14.5" r="2.5"/><circle cx="15.2" cy="14.5" r="2.5"/><path d="M8.7 7.7 6 12.3M7.3 14.5h5.4M11.3 7.7l2.6 4.6"/>',
  layers: '<path d="m10 2.5 7.5 4-7.5 4-7.5-4z"/><path d="m2.5 10 7.5 4 7.5-4M2.5 13.5l7.5 4 7.5-4"/>',
  storage: '<path d="M2.5 6.5 4.6 3h10.8l2.1 3.5v9a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M2.5 6.5h15M8 10h4"/>',
  mail: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3 5.5 7 5.5 7-5.5"/>',
  plug: '<path d="M7 2.5v4M13 2.5v4M5 6.5h10v3a5 5 0 0 1-10 0z"/><path d="M10 14.5v3"/>',
  vault: '<rect x="3.5" y="8.5" width="13" height="9" rx="2"/><path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5M10 12v2"/>',
  service: '<rect x="3" y="5.5" width="14" height="9" rx="2"/><path d="M6 14.5V17M14 14.5V17M6 3v2.5M14 3v2.5M7 10h6"/>',
  chart: '<path d="M3 17h14M5.5 14V9M10 14V5M14.5 14v-3.5"/>',
  sparkle: '<path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6z"/>',
  bot: '<rect x="3.5" y="6.5" width="13" height="10" rx="3"/><path d="M10 3v3.5M7.5 11h.01M12.5 11h.01M7.5 14h5"/>',
  fx: '<path d="M10.5 3.5c-1.8 0-2.6 1-2.9 2.8L6.2 16.5H4M5.5 9h5M11.5 9.5l4.5 6M16 9.5l-4.5 6"/>',
  cloud: '<path d="M5.8 15.5a3.8 3.8 0 0 1-.4-7.6 5 5 0 0 1 9.5 1.4 3.1 3.1 0 0 1-.4 6.2z"/>',
  bus: '<path d="M2.5 10h15M14 6.5l3.5 3.5-3.5 3.5"/><circle cx="5.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/>',
  functions: '<path d="M7.5 3.5 3 10l4.5 6.5M12.5 3.5 17 10l-4.5 6.5M11 6l-2 4h3l-2 4"/>',
  unknown: '<circle cx="10" cy="10" r="7.7"/><circle cx="10" cy="10" r="2"/>',
  arrowUp: '<path d="M10 16V4M5 9l5-5 5 5"/>',
  arrowDown: '<path d="M10 4v12M5 11l5 5 5-5"/>',
  minus: '<path d="M5 10h10"/>',
});
export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

/** A decorative 20×20 line icon; unknown names fall back to a neutral ring. */
export function icon(name, className = 'dm-icon') {
  const body = PATHS[name] ?? PATHS.unknown;
  return `<svg class="${String(className).replace(/[^a-z0-9 _-]/gi, '')}" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
