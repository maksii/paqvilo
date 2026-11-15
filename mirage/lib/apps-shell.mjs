// The document shell of the Canvas pages (canvas-http.mjs, canvas-player.mjs): the administration's sidebar, top bar and
// style sheets, so the app list and the player look like /_sim/. The admin's own rules are in mirage/admin/shell.css.
import { escapeHtml } from '../admin/ui-kit.mjs';

const crumbHtml = (crumbs) =>
  crumbs
    .map(([label, href], index) =>
      index === crumbs.length - 1
        ? `<strong>${escapeHtml(label)}</strong>`
        : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`,
    )
    .join(' <span aria-hidden="true">/</span> ');

// crumbs: [label] or [label, href] pairs; the last one names the page. actions: { extra } where extra is the HTML of
// further top-bar buttons; without extra the page has no Apps & actions menu. head and bodyAttributes are trusted HTML
// (the caller escapes its values).
// script: false makes a static shell (no script, no Menu or Apps & actions button): the navigation shows above the content
// at phone width (shell.css, .shell-static).
export function appsShellPage({
  title,
  prefix,
  crumbs,
  body,
  head = '',
  bodyAttributes = '',
  actions = {},
  script = true,
}) {
  const scriptTag = script ? `<script defer src="${prefix}_shell-menu.js"></script>` : '';
  const navToggle = script
    ? '<button type="button" class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="navigation"><span aria-hidden="true">☰</span> Menu</button>'
    : '';
  const extra = script ? (actions.extra ?? '') : '';
  const topMore = extra
    ? '<button type="button" class="button top-more" id="top-more" aria-expanded="false" aria-controls="top-actions">Apps &amp; actions <span aria-hidden="true">▾</span></button>'
    : '';
  const topActions = extra ? `<div class="top-actions" id="top-actions">${extra}</div>` : '';
  const attributes = [script ? '' : 'class="shell-static"', bodyAttributes].filter(Boolean).join(' ');
  const bodyOpen = attributes ? `<body ${attributes}>` : '<body>';
  const navigation = [
    '<a class="nav-item" href="/_sim/"><span class="nav-icon" aria-hidden="true">▣</span>Simulator workspace</a>',
    '<a class="nav-item" href="/_setup/"><span class="nav-icon" aria-hidden="true">⚙</span>Project setup</a>',
    '<a class="nav-item active" href="/_apps/canvas/" aria-current="page">Canvas apps</a>',
    '<a class="nav-item" href="/_apps/code/">Code apps</a>',
  ].join('');
  return (
    `<!doctype html><html lang="en" data-ui-theme="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${prefix}_ui-kit.css"><link rel="stylesheet" href="${prefix}_shell.css">${head}${scriptTag}</head>` +
    `${bodyOpen}<a class="skip-link" href="#main">Skip to content</a><div class="shell"><aside class="sidebar" aria-label="Workspace navigation"${script ? ' data-nav-collapsible' : ''}>` +
    `<a class="brand" href="/_sim/"><span class="brand-symbol" aria-hidden="true">P</span><span><span>Paqvilo</span><small>SIMULATOR WORKSPACE</small></span></a>` +
    navToggle +
    `<nav class="nav-group" id="navigation" aria-label="Simulator views">${navigation}</nav>` +
    `</aside><div class="workspace"><header class="topbar"><span class="breadcrumb">${crumbHtml(crumbs)}</span>` +
    topMore +
    topActions +
    `</header>` +
    `<main id="main" tabindex="-1">${body}</main></div></div></body></html>`
  );
}
