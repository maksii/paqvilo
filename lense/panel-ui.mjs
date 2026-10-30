import { renderInspectionEvidence } from './inspection-evidence-ui.mjs';

// The dev panel as it runs inside the portal page.
//
// panelUi is handed to page.evaluate, which sends its source text to the browser: it must not use
// anything from this module's scope. It keeps its state on the host element, so calling it again
// with new data updates the panel that is already there. Everything lives in a shadow root (the
// portal's CSS does not reach in, ours does not leak out) and talks to the dev loop with requests
// to /__paqvilo/api/, which the overlay answers itself: they never reach the portal.

/** @param {object} data what panel.mjs builds for one tab */
function panelBrowserImpl(data) {
  // A queued draw may execute after the tab has navigated to another configured portal.
  if (location.origin !== data.origin) return;
  const ID = 'paqvilo-panel';
  if (window.__paqviloRetiredSessions?.includes(data.token)) return;
  let host = document.getElementById(ID);
  if (!host) {
    if (!document.body) return;
    host = document.createElement('div');
    host.id = ID;
    document.body.appendChild(host);
  }
  if (!host.__pp) host.__pp = create(host);
  host.__pp.update(data);

  function create(host) {
    const lifetime = new AbortController();
    // The look is the portal's own: font, colours, corner radius and button style are read from
    // the page (see readTheme) and arrive here as custom properties. The values below only apply
    // when the page gives nothing.
    const CSS = `
      :host { all: initial; }
      @media print { :host { display:none!important; } }
      * { box-sizing: border-box; }
      [hidden] { display:none!important; }
      .wrap { --bg: #fff; --fg: #212529; --muted: #6c757d; --primary: #0d6efd; --on-primary: #fff; --link: #0d6efd;
        --radius: 4px; --font: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
        --warn-bg: #fff3cd; --warn: #d39e00; --danger: #b02a37; --success: #146c43;
        --danger-bg: color-mix(in srgb, var(--danger) 10%, var(--bg)); --success-bg: color-mix(in srgb, var(--success) 10%, var(--bg));
        --tint: color-mix(in srgb, var(--primary) 6%, var(--bg)); --head-bg: color-mix(in srgb, var(--primary) 10%, var(--bg));
        --line: color-mix(in srgb, var(--primary) 20%, var(--bg)); --input-line: var(--line);
        --panel-line: rgba(0,0,0,.15); --shadow: 0 6px 12px rgba(0,0,0,.18);
        --badge-bg: #777; --badge-fg: #fff;
        font: 13px/1.45 var(--font); color: var(--fg); text-align: left; letter-spacing: 0; }
      .wrap.hidden .pill, .wrap.hidden .panel { display: none !important; }
      button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: left; }
      button:focus-visible, .pill:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 50%, transparent); outline-offset: 1px; }
      svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; display: block; }
      mark { background: var(--warn-bg); color: inherit; padding: 0; }

      .pp-persona-picker { width:100%;min-width:0; } .pp-persona-picker input,.pp-persona-facets select {box-sizing:border-box;width:100%;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:5px} .pp-persona-picker [data-panel-persona-results]{max-height:320px;overflow:auto;overscroll-behavior:contain;border-block:1px solid var(--line);margin-block:8px} .pp-persona-picker input[type=checkbox]{width:auto} .pp-persona-facets{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:8px 0}.pp-persona-row{display:flex;gap:8px;border-top:1px solid var(--line);padding:7px}.pp-persona-row.selected{background:var(--tint);box-shadow:inset 3px 0 var(--primary)}.pp-persona-choice{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}.pp-persona-choice span{font-size:11px;color:var(--muted)}.pp-persona-group{margin:8px 0}.pp-persona-group>summary{font-weight:600;cursor:pointer}.pp-persona-group h4,.pp-persona-picker h4{margin:8px 0 3px;font-size:12px}
      .pill { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; border-radius: var(--radius);
        max-width: calc(100vw - 16px);
        background: var(--bg); border: 1px solid var(--panel-line); box-shadow: var(--shadow);
        cursor: grab; user-select: none; -webkit-user-drag: none; white-space: nowrap; touch-action: none; }
      .pill:hover { border-color: var(--primary); }
      .wrap.open .pill { display: none; }
      .pill b { font-weight: 700; color: var(--link); }
      .pill .lbl { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
      .branch { color: var(--muted); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .branch.moved { color: var(--warn); font-weight: 600; }
      .caution .pill, .caution .panel { border-color: var(--danger); }
      .real { background: var(--danger); color: #fff; font-weight: 700; font-size: 11px; padding: 1px 6px; border-radius: var(--radius); }

      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); flex: none; }
      .dot.paused { background: var(--warn); }
      .dot.off { background: var(--muted); }

      .n { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; font-size: 11.5px; font-weight: 600; }
      .n.ok, .n.dimn { background: var(--badge-bg); color: var(--badge-fg); }
      .n.warn { background: var(--warn); color: #1e1e1e; }
      .n.err { background: var(--danger); color: #fff; }

      .panel { display: none; flex-direction: column; width: min(500px, calc(100vw - 16px)); height: min(620px, calc(100vh - 16px)); border-radius: var(--radius); overflow: hidden;
        background: var(--bg); border: 1px solid var(--panel-line); box-shadow: var(--shadow); }
      .wrap.open .panel { display: flex; }
      .wrap.large .panel { width: min(860px, calc(100vw - 16px)); height: min(900px, calc(100vh - 16px)); }
      .wrap.dragging .panel { opacity: .9; }

      .head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--line); cursor: grab; user-select: none; -webkit-user-drag: none; touch-action: none; }
      .head > * { flex: none; }
      .head .grow { flex: 1; }
      .brand { color: var(--link); font-size: 14px; white-space: nowrap; }
      .tag { color: var(--muted); white-space: nowrap; }
      .tag.env { color: var(--fg); font-weight: 600; }
      @media (max-width: 520px) { .head .tag, .foot .stats { display: none; } .pill .branch { max-width: 70px; } }
      .grow { flex: 1; min-width: 4px; }
      .ib { text-decoration: none; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius); color: var(--muted); }
      .ib:hover { background: var(--tint); color: var(--primary); }
      .ib.on { color: var(--primary); }
      .ib.warn { color: var(--fg); background: var(--warn-bg); }
      .seg { display: inline-flex; border: 1px solid var(--primary); border-radius: var(--radius); overflow: hidden; }
      .seg button { padding: 2px 10px; color: var(--primary); font-size: 12.5px; background: var(--bg); }
      .seg button + button { border-left: 1px solid var(--primary); }
      .seg button:hover { background: var(--tint); }
      .seg button.on { background: var(--primary); color: var(--on-primary); }

      .tabs { display: flex; gap: 2px; padding: 0 6px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: thin; }
      .targets { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
      .target-confirm { flex-basis:100%; padding:8px; border:1px solid var(--danger); border-radius:var(--radius); }
      .target-confirm p { margin:0 0 8px; }
      .targets label { flex: none; font-size: 12px; color: var(--muted); }
      .targets select { flex: 1; min-width: 0; max-width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--input-line); border-radius: var(--radius); padding: 4px; }
      .targets select:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
      .gitline { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
      .gitline:empty { display: none; }
      .gitline .branch { min-width: 0; flex: 1; max-width: none; }
      .gitline .commit { flex: none; }
      .tab { padding: 8px 8px 6px; color: var(--fg); border-bottom: 3px solid transparent; display: inline-flex; gap: 5px; align-items: center; flex: none; white-space: nowrap; }
      .tab:hover { color: var(--primary); }
      .tab.on { color: var(--tab-ink,var(--fg)); border-bottom-color: var(--primary); font-weight: 600; }

      .tools { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
      .search { flex: 1; display: flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--input-line); border-radius: var(--radius); padding: 0 8px; height: 30px; color: var(--muted); }
      .search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent); }
      .search input { all: unset; flex: 1; min-width: 0; color: var(--fg); font: inherit; }
      .search input::placeholder { color: var(--muted); }
      .search kbd, .foot kbd { font: 11px Consolas, monospace; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; color: var(--muted); background: var(--bg); }

      .body { flex: 1; overflow: auto; padding: 0 10px 10px; overscroll-behavior: contain; }
      button:disabled { opacity:.5;cursor:default; } button[aria-busy=true]{cursor:wait;} .working{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--tint);font-size:12px;color:var(--fg)}.spinner{display:inline-block;width:14px;height:14px;flex:none;border:2px solid var(--line);border-top-color:var(--primary);border-radius:50%;animation:panel-spin .9s linear infinite}.loading-state{display:flex;gap:10px;align-items:flex-start;padding:24px 10px;color:var(--muted)}.loading-state strong{display:block;color:var(--fg);margin-bottom:4px}.loading-state .spinner{margin-top:3px}@keyframes panel-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
      .foot { display: flex; gap: 10px; align-items: center; padding: 5px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; background: var(--tint); white-space: nowrap; overflow: hidden; }

      .card { padding: 2px 2px 8px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
      .card .path { font-size: 15px; overflow-wrap: anywhere; }
      .card .dim { color: var(--muted); font-size: 12.5px; }
      .srcs { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; align-items: center; }
      .src { color: var(--link); font-size: 12.5px; }
      .src:hover { text-decoration: underline; }
      .src.none { color: var(--muted); }
      .inspect-nav { gap: 6px; }
      .inspect-nav .f { padding: 4px 8px; font-size: 11.5px; }
      .inspection-help { white-space: normal; margin-top: 8px; line-height: 1.45; }
      .card > .sub { white-space: normal; overflow-wrap: anywhere; margin-top: 4px; }
      .inspect-tools { gap: 6px; }
      .inspect-tools .src { padding: 5px 8px; border: 1px solid var(--line); border-radius: var(--radius); }
      .inspect-tools .src:hover { background: var(--tint); text-decoration: none; }
      .banner { display: flex; align-items: center; gap: 8px; border-radius: var(--radius); padding: 7px 10px; margin-bottom: 8px; background: var(--warn-bg); border-left: 4px solid var(--warn); color: var(--fg); }
      .banner.grey { background: var(--tint); border-left-color: var(--primary); }
      .banner .grow { flex: 1; }
      .btn { padding: 3px 12px; border-radius: var(--radius); background: var(--primary); border: 1px solid var(--primary); color: var(--on-primary); white-space: nowrap; }
      .btn:hover { filter: brightness(.92); }

      .filters { display: flex; align-items: center; gap: 6px; margin: 2px 2px 8px; flex-wrap: wrap; }
      .f { padding: 2px 10px; border-radius: var(--radius); border: 1px solid var(--primary); color: var(--primary); display: inline-flex; gap: 5px; align-items: center; font-size: 12.5px; background: var(--bg); white-space: nowrap; }
      .f:hover { background: var(--tint); }
      .f.on { background: var(--primary); color: var(--on-primary); }
      .lbl2 { color: var(--muted); font-size: 12px; }

      .group { margin-bottom: 10px; }
      .gh { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; color: var(--fg); font-weight: 700; background: var(--head-bg); border-bottom: 1px solid color-mix(in srgb, var(--primary) 55%, var(--bg)); }
      .gh:hover { color: var(--link); }
      .gh svg { transition: transform .12s; width: 12px; height: 12px; color: var(--muted); }
      .gh.openg svg { transform: rotate(90deg); }
      .gh .n { font-weight: 400; }
      .gh .line { flex: 1; }

      .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--line); position: relative; }
      .row:hover { background: var(--tint); }
      .row.fresh { animation: fresh 2.2s ease-out 1; }
      @keyframes fresh { 0% { background: var(--head-bg); } 100% { background: transparent; } }
      .row.off .name, .row.off .sub { opacity: .6; }
      .ico { width: 34px; font-size: 10.5px; font-weight: 600; color: var(--muted); flex: none; text-align: left; }
      .k-err { color: var(--danger); }
      .k-warn { color: var(--fg); }
      .main { flex: 1; min-width: 0; text-align: left; display: block; }
      .name { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .name .what { color: var(--muted); white-space: nowrap; flex: none; font-size: 12px; }
      .sub { color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wrapt .sub, .wrapt .name > span:first-child { white-space: normal; overflow-wrap: anywhere; }
      button.main:hover .name > span:first-child { color: var(--link); text-decoration: underline; }
      .c { font-size: 11px; padding: 0 6px; border-radius: 3px; white-space: nowrap; flex: none; line-height: 17px; border: 1px solid transparent; }
      .c.edited { background: var(--head-bg); color: var(--link); }
      .c.diff { background: var(--warn-bg); color: var(--fg); border-color: var(--warn); }
      .c.same, .c.act { color: var(--muted); padding: 0; }
      .c.new, .c.local { background: var(--success-bg); color: var(--success); }
      .c.st { background: var(--danger-bg); color: var(--danger); }
      .acts { display: none; gap: 1px; flex: none; }
      .row:hover .acts, .row:focus-within .acts { display: flex; }
      .group[data-group^="runtime-"] .acts { display: flex; }
      .time { color: var(--muted); font-size: 11.5px; flex: none; font-variant-numeric: tabular-nums; }

      .empty { text-align: center; color: var(--muted); padding: 26px 20px; }
      .empty > b:first-child { display: block; color: var(--fg); margin-bottom: 4px; font-size: 14px; }

      .dhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .dhead .t { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .plus { color: var(--success); } .minus { color: var(--danger); }
      .difft { font: 12px/1.5 Consolas, "Cascadia Mono", monospace; border: 1px solid var(--line); border-radius: var(--radius); overflow: auto; background: var(--bg); }
      .dl { display: flex; white-space: pre; min-width: max-content; }
      .dl[data-act] { cursor: pointer; }
      .dl i { font-style: normal; width: 42px; text-align: right; padding-right: 8px; color: var(--muted); background: var(--tint); flex: none; user-select: none; }
      .dl span { padding: 0 8px; flex: 1; }
      .dl.a, .dl.a i { background: var(--success-bg); }
      .dl.r, .dl.r i { background: var(--danger-bg); }
      .dl.g { background: var(--tint); color: var(--muted); justify-content: center; font-family: var(--font); }

      .toast, .float { background: var(--fg); color: var(--bg); border-radius: var(--radius); white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .15s; }
      .toast { position: absolute; left: 50%; bottom: 36px; transform: translateX(-50%); padding: 5px 12px; max-width: 90%; overflow: hidden; text-overflow: ellipsis; z-index: 3; }
      .toast.show, .float.show { opacity: 1; }
      .toast.bad { background: var(--danger); color: #fff; }
      .float { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 7px 14px; font: 13px var(--font); box-shadow: 0 2px 8px rgba(0,0,0,.2); }
      .float kbd { font: 11.5px Consolas, monospace; border: 1px solid color-mix(in srgb, var(--bg) 50%, transparent); border-radius: 3px; padding: 0 4px; }
      .panelwrap { position: relative; }
      .row.d1 { padding-left: 22px; } .row.d2 { padding-left: 36px; } .row.d3 { padding-left: 50px; }
      .row.d4 { padding-left: 64px; } .row.d5 { padding-left: 78px; } .row.d6 { padding-left: 92px; }
      .morebtn { display: block; width: 100%; padding: 6px 8px; color: var(--link); text-align: center; border-bottom: 1px solid var(--line); }
      .morebtn:hover { background: var(--tint); }
      .ib.lay { width: auto; padding: 0 5px; font-size: 11px; font-weight: 600; }
      .tw { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
      .who { margin: 4px 0 2px; }
      .tw select { flex: 1; min-width: 0; max-width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--input-line); border-radius: var(--radius); padding: 4px; }
      .tw select:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
      .srcs .dim { overflow-wrap: anywhere; }
      @media (prefers-reduced-motion: reduce) { .row.fresh { animation: none; } }
    `;
    const ICON = {
      setup:
        '<circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M3 13l1.5-1.5M11.5 4.5 13 3"/>',
      sim: '<path d="M5 2h6M6 2v5l-4 6h12l-4-6V2M4.5 10h7"/>',
      code: '<path d="M6 4 2 8l4 4M10 4l4 4-4 4"/>',
      diff: '<path d="M4 4.5h5M6.5 2v5M4 12h5M12.5 2.5v11"/>',
      copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 10h1.5"/>',
      pause: '<path d="M5.5 3v10M10.5 3v10"/>',
      play: '<path d="M5 3l8 5-8 5z"/>',
      hide: '<path d="M2 2l12 12M6.6 6.7a2 2 0 0 0 2.8 2.8M4.3 4.4A7.6 7.6 0 0 0 1.5 8c.8 2.4 3.3 4.5 6.5 4.5 1.1 0 2.1-.3 3-.7M7 3.6c.3-.1.7-.1 1-.1 3.2 0 5.7 2.1 6.5 4.5-.3.9-.9 1.8-1.6 2.6"/>',
      down: '<path d="M4 6l4 4 4-4"/>',
      right: '<path d="M6 4l4 4-4 4"/>',
      size: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>',
      search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
      reload: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
      bolt: '<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/>',
      clear: '<path d="M3 4.5h10M6 4.5v-2h4v2M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
      go: '<path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/>',
      back: '<path d="M13 8H4M7.5 4.5 4 8l3.5 3.5"/>',
    };
    const icon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
    const KIND = {
      'page-js': ['JS', '', 'page JavaScript'],
      'page-css': ['CSS', '', 'page CSS'],
      'page-copy': ['HTML', '', 'page copy'],
      'page-summary': ['HTML', '', 'page summary'],
      'basic-form-js': ['FORM', '', 'basic form JavaScript'],
      'advanced-form-step-js': ['STEP', '', 'advanced form step JavaScript'],
      'list-js': ['LIST', '', 'list JavaScript'],
      'web-template': ['TPL', '', 'web template'],
      'content-snippet': ['SNIP', '', 'content snippet'],
      page: ['PAGE', '', 'web page'],
    };
    const GROUPS = [
      ['page', 'This page'],
      ['forms', 'Forms & lists'],
      ['markup', 'Templates & snippets'],
      ['js', 'Script files'],
      ['css', 'Style files'],
      ['media', 'Images & fonts'],
      ['other', 'Other files'],
    ];
    const TABS = [
      ['overrides', 'Overrides'],
      ['runtime', 'Inspect'],
      ['tweaks', 'Tweaks'],
      ['issues', 'Issues'],
      ['activity', 'Activity'],
      ['explore', 'Explore'],
      ['actions', 'Actions'],
    ];
    const MIRAGE_TABS = ['tweaks'];
    const PLACEHOLDER = {
      overrides: 'Filter overrides',
      runtime: 'Filter tables, templates, settings ...',
      issues: 'Filter issues',
      activity: 'Filter activity',
      explore: 'Find a page, file, template, snippet ...',
    };

    const S = {
      d: null,
      ui: {
        pos: { h: 'left', v: 'bottom', dx: 12, dy: 12 },
        open: false,
        hidden: false,
        tab: 'overrides',
        large: false,
        collapsed: { insync: true },
        filter: 'all',
        localOnly: false,
      },
      first: true,
      q: '',
      catalog: null,
      catalogLoading: null,
      catalogError: null,
      diff: null,
      html: {},
      flashed: (() => {
        try {
          return Number(sessionStorage.getItem('paqvilo:last-change:' + data.token)) || 0;
        } catch {
          return 0;
        }
      })(),
      dragged: 0,
      targets: [],
      // Mirage: the page report is fetched once per runtime version, tweaks once per revision.
      inspect: null,
      inspectLoading: null,
      inspectRequest: 0,
      completedInspectionLoadingId: 0,
      tweaks: null,
      tweaksLoading: null,
      defaults: {},
      more: {},
      pick: {},
      confirm: null,
      inspectSection: 'all',
      selectedElement: null,
      selectedIdentity: null,
      selectionScope: null,
      selectionGeneration: -1,
      selectionAnchor: null,
      selectionReason: '',
      pickingElement: false,
      pendingActions: new Map(),
    };
    const nativeFetch = window.fetch.bind(window);
    const esc = (s) =>
      String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      );
    const terms = () => S.q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (...texts) => {
      const hay = texts.join('\n').toLowerCase();
      return terms().every((t) => hay.includes(t));
    };
    /** escaped text with the search terms marked */
    const hl = (text) => {
      const s = String(text ?? '');
      const low = s.toLowerCase();
      const spans = [];
      for (const t of terms())
        for (let at = low.indexOf(t); at >= 0; at = low.indexOf(t, at + t.length)) spans.push([at, at + t.length]);
      if (!spans.length) return esc(s);
      spans.sort((a, b) => a[0] - b[0]);
      let out = '';
      let pos = 0;
      for (const [from, to] of spans) {
        if (to <= pos) continue;
        const start = Math.max(from, pos);
        out += esc(s.slice(pos, start)) + '<mark>' + esc(s.slice(start, to)) + '</mark>';
        pos = to;
      }
      return out + esc(s.slice(pos));
    };
    const clock = (at) => new Date(at).toLocaleTimeString('en-GB');
    const baseName = (p) =>
      String(p).split('#')[0].split('/').pop() + (String(p).includes('#') ? ' #' + String(p).split('#')[1] : '');
    /** "Home.en-US" for Home.en-US.webpage.custom_javascript.js: the kind is shown next to it */
    const shortName = (rel) =>
      baseName(rel).replace(
        /\.(?:webpage|basicform|advancedformstep|list|webtemplate|contentsnippet)\.[a-z_]+\.(?:js|css|html)$/i,
        '',
      );
    const fileIcon = (item) => {
      if (KIND[item.kind]) return KIND[item.kind];
      const ext = (/\.([a-z0-9]+)$/i.exec(item.url || item.rel || '')?.[1] ?? '').toLowerCase();
      if (ext === 'js' || ext === 'mjs') return ['JS', '', 'web file'];
      if (ext === 'css') return ['CSS', '', 'web file'];
      if (/^(?:png|jpe?g|gif|svg|ico|webp)$/.test(ext)) return ['IMG', '', 'web file'];
      if (/^(?:woff2?|ttf|eot|otf)$/.test(ext)) return ['FONT', '', 'web file'];
      return [(ext || 'FILE').slice(0, 4).toUpperCase(), '', 'web file'];
    };

    const api = async (name, body) => {
      if (lifetime.signal.aborted) return { ok: false, error: 'the dev loop has stopped' };
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 120_000);
      const stop = () => controller.abort();
      lifetime.signal.addEventListener('abort', stop, { once: true });
      try {
        if (S.d.transport === 'model-driven') {
          if (typeof window.__paqviloModelPanelApi !== 'function')
            return { ok: false, error: 'The model-driven dev loop is unavailable.' };
          return await Promise.race([
            window.__paqviloModelPanelApi({ token: S.d.token, name, body: body ?? {} }),
            new Promise((resolve) =>
              controller.signal.addEventListener(
                'abort',
                () =>
                  resolve({
                    ok: false,
                    error: timedOut
                      ? 'The request timed out. Its result is unknown; inspect current state before retrying.'
                      : 'The dev loop has stopped.',
                  }),
                { once: true },
              ),
            ),
          ]);
        }
        return await nativeFetch('/__paqvilo/api/' + name, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-paqvilo-token': S.d.token },
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        }).then((r) => r.json());
      } catch {
        const writing = [
          'mode',
          'live',
          'persona',
          'signin',
          'signout',
          'permissions',
          'preset',
          'scenario',
          'toggle',
          'scope',
          'rebaseline',
          'clear',
          'ui',
        ].includes(name);
        return {
          ok: false,
          error: lifetime.signal.aborted
            ? 'the dev loop has stopped'
            : timedOut
              ? writing
                ? 'The request timed out. Its result is unknown; check the current state before retrying.'
                : 'The request timed out. Check the dev loop and retry.'
              : 'the dev loop does not answer (is it still running?)',
        };
      } finally {
        clearTimeout(timeout);
        lifetime.signal.removeEventListener('abort', stop);
      }
    };

    host.style.cssText = 'position:fixed;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    // a constructed stylesheet is not subject to the page's Content-Security-Policy for inline styles
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      CSS +
        renderInspectionEvidence(null, { part: 'styles' }) +
        '.selection-summary{position:relative;margin:8px 12px;border:1px solid var(--line);border-radius:5px;padding:7px 10px;flex:none}.selection-summary>summary{cursor:pointer;font-size:12px;padding-right:90px}.selection-summary .selection-evidence-body{max-height:240px;overflow:auto;overscroll-behavior:contain}.selection-summary .selection-clear{position:absolute;right:8px;top:7px}',
    );
    root.adoptedStyleSheets = [sheet];
    for (const type of ['click', 'dblclick', 'auxclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup'])
      root.addEventListener(type, (event) => event.stopPropagation(), { signal: lifetime.signal });
    root.innerHTML = `
      <div class="wrap">
        <div class="pill" role="button" tabindex="0" title="paqvilo: click to open, drag to move"></div>
        <div class="panelwrap">
          <div class="panel" role="dialog" aria-label="paqvilo dev panel">
            <div class="head"></div>
            <div class="targets"></div>
            <div class="gitline"></div>
            <div class="tabs" role="tablist" aria-label="Dev panel tabs"></div>
            <div class="tools">
              <label class="search">${icon('search')}<input type="text" spellcheck="false" autocomplete="off"><kbd>/</kbd></label>
              <span class="toolbtns"></span>
            </div>
            <div class="body" role="tabpanel" id="paqvilo-tab-content"></div>
            <div class="foot"></div>
          </div>
          <div class="toast" role="status" aria-live="polite"></div>
        </div>
        <div class="float" role="status" aria-live="polite"></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    const selectionHost = document.createElement('div');
    selectionHost.className = 'selection-host';
    $('.body').before(selectionHost);
    const wrap = $('.wrap');

    // ---- the portal's look
    /**
     * Font, colours and corner radius as the portal's own stylesheet gives them to ordinary
     * elements (a link, a primary button, an input, the alerts), so the panel looks like a part
     * of the site it sits on, whatever theme that site has.
     */
    const readTheme = () => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;';
      const classes = [
        'btn btn-primary',
        'form-control',
        'text-muted',
        'alert alert-warning',
        'alert alert-danger',
        'alert alert-success',
        'btn btn-danger',
        'btn btn-success',
        'badge',
        'dropdown-menu',
      ];
      probe.innerHTML = '<a href="#">a</a>' + classes.map((c) => `<div class="${c}">x</div>`).join('');
      probe.dataset.paqviloThemeProbe = '';
      host.appendChild(probe);
      const [link, button, input, muted, warning, danger, success, dangerButton, successButton, badge, menu] = [
        ...probe.children,
      ].map((node) => getComputedStyle(node));
      const solid = (color) => (color && !/^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(color) ? color : null);
      // the colour that says "warning" / "error" / "done" on this site: the accent bar of its
      // alerts where it has one, else its coloured buttons
      const accent = (alert, btn) =>
        (parseFloat(alert.borderLeftWidth) >= 2 ? solid(alert.borderLeftColor) : null) ??
        (btn ? solid(btn.backgroundColor) : null);
      const body = getComputedStyle(document.body);
      // a data table of the page, when there is one, has the site's header shade and row lines
      const th = document.querySelector('table thead th');
      const td = document.querySelector('table tbody td');
      const cellLine =
        td && parseFloat(getComputedStyle(td).borderBottomWidth) > 0
          ? solid(getComputedStyle(td).borderBottomColor)
          : null;
      const primary = solid(button.backgroundColor);
      const theme = {
        '--font': body.fontFamily,
        '--fg': solid(body.color),
        '--bg': solid(body.backgroundColor) ?? solid(getComputedStyle(document.documentElement).backgroundColor),
        '--link': solid(link.color),
        '--primary': primary,
        '--on-primary': primary && solid(button.color),
        '--radius': primary ? `${Math.min(parseFloat(button.borderTopLeftRadius) || 0, 10)}px` : null,
        '--input-line': parseFloat(input.borderTopWidth) > 0 ? solid(input.borderTopColor) : null,
        '--muted':
          muted.color !== body.color
            ? solid(muted.color)
            : solid(warning.backgroundColor) && warning.color !== body.color
              ? solid(warning.color)
              : null,
        '--warn-bg': solid(warning.backgroundColor),
        '--warn':
          accent(warning, null) ?? (parseFloat(warning.borderTopWidth) > 0 ? solid(warning.borderTopColor) : null),
        '--danger': accent(danger, dangerButton),
        '--danger-bg': solid(danger.backgroundColor),
        '--success': accent(success, successButton),
        '--success-bg': solid(success.backgroundColor),
        '--head-bg': th ? solid(getComputedStyle(th).backgroundColor) : null,
        '--line': cellLine,
        '--badge-bg': solid(badge.backgroundColor),
        '--badge-fg': solid(badge.backgroundColor) && solid(badge.color),
        '--panel-line': parseFloat(menu.borderTopWidth) > 0 ? solid(menu.borderTopColor) : null,
        '--shadow': menu.boxShadow && menu.boxShadow !== 'none' ? menu.boxShadow : null,
      };
      // The host does not inherit the portal's ancestor backgrounds. Resolve alpha against
      // the document canvas before checking contrast or using that colour in the shadow root.
      const sample = document.createElement('canvas');
      sample.width = sample.height = 1;
      const sampler = sample.getContext('2d', { willReadFrequently: true });
      const rgba = (color) => {
        if (!color) return null;
        if (sampler) {
          sampler.clearRect(0, 0, 1, 1);
          sampler.fillStyle = 'transparent';
          sampler.fillStyle = color;
          sampler.fillRect(0, 0, 1, 1);
          const pixels = sampler.getImageData(0, 0, 1, 1).data;
          return [pixels[0], pixels[1], pixels[2], pixels[3] / 255];
        }
        const match = /^rgba?\(([^)]+)\)$/.exec(String(color));
        if (!match) return null;
        const channels = match[1]
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return channels.length >= 3 ? [...channels.slice(0, 3), channels[3] ?? 1] : null;
      };
      const blend = (foreground, background) =>
        foreground
          .slice(0, 3)
          .map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
      const canvas = blend(
        rgba(getComputedStyle(document.documentElement).backgroundColor) ?? [255, 255, 255, 1],
        [255, 255, 255],
      );
      const background = blend(rgba(body.backgroundColor) ?? [0, 0, 0, 0], canvas);
      if (rgba(theme['--bg'])) theme['--bg'] = `rgb(${background.join(',')})`;
      probe.remove();
      const luminance = (color) => {
        const channels = rgba(color);
        if (!channels) return null;
        return blend(channels, background)
          .map((c) => {
            c /= 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      };
      const bg = luminance(theme['--bg'] ?? '#fff'),
        fg = luminance(theme['--primary']);
      theme['--tab-ink'] =
        bg !== null && fg !== null && (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) >= 4.5
          ? theme['--primary']
          : (bg ?? 1) > 0.179
            ? '#000'
            : '#fff';
      for (const [name, value] of Object.entries(theme)) {
        if (value) wrap.style.setProperty(name, value);
        else wrap.style.removeProperty(name);
      }
    };
    // Probe once after stylesheets load, rather than caching the unstyled document's colours.
    if (document.readyState === 'complete') readTheme();
    else window.addEventListener('load', readTheme, { once: true, signal: lifetime.signal });
    const el = {
      pill: $('.pill'),
      panel: $('.panel'),
      head: $('.head'),
      targets: $('.targets'),
      git: $('.gitline'),
      tabs: $('.tabs'),
      body: $('.body'),
      foot: $('.foot'),
      input: $('.search input'),
      toolbtns: $('.toolbtns'),
      toast: $('.toast'),
      float: $('.float'),
    };
    const working = document.createElement('div');
    working.className = 'working';
    working.hidden = true;
    working.setAttribute('role', 'status');
    working.setAttribute('aria-live', 'polite');
    el.body.before(working);
    const actionLabels = {
      mode: 'Switching source mode…',
      live: 'Updating live reload…',
      persona: 'Switching persona…',
      signin: 'Signing in…',
      signout: 'Signing out…',
      permissions: 'Updating permissions…',
      'confirm-yes': 'Applying local setup…',
      open: 'Opening the source editor…',
      toggle: 'Updating override…',
      scope: 'Updating source scope…',
      rebaseline: 'Pinning the comparison baseline…',
      clear: 'Clearing the list…',
    };
    const mutationActions = new Set([
      'mode',
      'live',
      'persona',
      'signin',
      'signout',
      'permissions',
      'confirm-yes',
      'toggle',
      'scope',
      'rebaseline',
    ]);
    const pendingFeedback = () => {
      const jobs = [...S.pendingActions.values()];
      working.hidden = !jobs.length;
      const message = jobs[0]?.label ?? '',
        html = `<span class="spinner" aria-hidden="true"></span><span>${esc(message)}</span>`;
      if (working.innerHTML !== html) working.innerHTML = html;
      const mutating = jobs.some((job) => mutationActions.has(job.name));
      for (const button of el.panel.querySelectorAll('[data-act]')) {
        const busy = S.pendingActions.has(button.dataset.act) || (mutating && mutationActions.has(button.dataset.act));
        if (busy) {
          if (!button.hasAttribute('data-paqvilo-busy')) button.dataset.paqviloBusy = String(button.disabled);
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
        } else if (button.hasAttribute('data-paqvilo-busy')) {
          button.disabled = button.dataset.paqviloBusy === 'true';
          delete button.dataset.paqviloBusy;
          button.removeAttribute('aria-busy');
        }
      }
    };

    // ---- feedback
    let toastTimer = 0;
    const toast = (text, bad = false) => {
      el.toast.textContent = text;
      el.toast.className = 'toast show' + (bad ? ' bad' : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.toast.className = 'toast'), bad ? 5000 : 1800);
    };
    let floatTimer = 0;
    const float = (html, ms = 2600) => {
      el.float.innerHTML = html;
      el.float.classList.add('show');
      clearTimeout(floatTimer);
      floatTimer = setTimeout(() => el.float.classList.remove('show'), ms);
    };
    let saveTimer = 0;
    const saveUi = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = 0;
        if (S.d) api('ui', S.ui);
      }, 250);
    };
    // A navigation inside the delay would drop the change, so a pending save goes out with keepalive as the page hides.
    window.addEventListener(
      'pagehide',
      () => {
        if (!saveTimer || !S.d) return;
        clearTimeout(saveTimer);
        saveTimer = 0;
        if (S.d.transport === 'model-driven') {
          api('ui', S.ui);
          return;
        }
        nativeFetch('/__paqvilo/api/ui', {
          method: 'POST',
          keepalive: true,
          headers: { 'content-type': 'application/json', 'x-paqvilo-token': S.d.token },
          body: JSON.stringify(S.ui),
        }).catch(() => {});
      },
      { signal: lifetime.signal },
    );

    // ---- placement
    const place = () => {
      const pos = S.ui.open ? S.ui.pos : (S.pillPos ??= { h: 'left', v: 'bottom', dx: 12, dy: 12 });
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      const box = (S.ui.open ? el.panel : el.pill).getBoundingClientRect();
      const dx = Math.max(4, Math.min(pos.dx, vw - box.width - 4));
      const dy = Math.max(4, Math.min(pos.dy, vh - box.height - 4));
      host.style.left = pos.h === 'left' ? dx + 'px' : 'auto';
      host.style.right = pos.h === 'right' ? dx + 'px' : 'auto';
      host.style.top = pos.v === 'top' ? dy + 'px' : 'auto';
      host.style.bottom = pos.v === 'bottom' ? dy + 'px' : 'auto';
      if (!S.ui.open && !S.ui.hidden && !stopDrag) {
        const rect = el.pill.getBoundingClientRect();
        const controls = [
          ...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],iframe'),
        ]
          .filter((node) => !node.closest('#paqvilo-panel,#paqvilo-xray'))
          .flatMap((node) => {
            const r = node.getBoundingClientRect();
            return r.width &&
              r.height &&
              r.right > 0 &&
              r.bottom > 0 &&
              r.left < vw &&
              r.top < vh &&
              getComputedStyle(node).visibility !== 'hidden'
              ? [r]
              : [];
          });
        const score = (left, top) => {
          let count = 0,
            area = 0;
          for (const r of controls) {
            const overlap =
              Math.max(0, Math.min(left + rect.width, r.right) - Math.max(left, r.left)) *
              Math.max(0, Math.min(top + rect.height, r.bottom) - Math.max(top, r.top));
            if (overlap) {
              count++;
              area += overlap;
            }
          }
          return { count, area };
        };
        let best = { pos, score: score(rect.left, rect.top) };
        for (const h of ['left', 'right'])
          for (const v of ['bottom', 'top']) {
            const candidate = { h, v, dx: 12, dy: 12 },
              candidateScore = score(
                h === 'left' ? 12 : vw - 12 - rect.width,
                v === 'top' ? 12 : vh - 12 - rect.height,
              );
            if (
              candidateScore.count < best.score.count ||
              (candidateScore.count === best.score.count && candidateScore.area < best.score.area)
            )
              best = { pos: candidate, score: candidateScore };
          }
        S.pillPos = best.pos;
        host.style.left = best.pos.h === 'left' ? best.pos.dx + 'px' : 'auto';
        host.style.right = best.pos.h === 'right' ? best.pos.dx + 'px' : 'auto';
        host.style.top = best.pos.v === 'top' ? best.pos.dy + 'px' : 'auto';
        host.style.bottom = best.pos.v === 'bottom' ? best.pos.dy + 'px' : 'auto';
      }
    };
    let stopDrag = null;
    const startDrag = (e) => {
      if (e.button !== 0 || e.target.closest('a, button, input, .seg')) return;
      stopDrag?.();
      const handle = e.currentTarget;
      const box = (S.ui.open ? el.panel : el.pill).getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      let moved = false;
      const move = (ev) => {
        // the button was let go where this page did not see it (another window, a dialog)
        if (!(ev.buttons & 1)) return stop();
        const mx = ev.clientX - x0;
        const my = ev.clientY - y0;
        if (!moved && Math.hypot(mx, my) < 5) return;
        moved = true;
        wrap.classList.add('dragging');
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = window.innerHeight;
        const left = Math.max(4, Math.min(vw - box.width - 4, box.left + mx));
        const top = Math.max(4, Math.min(vh - box.height - 4, box.top + my));
        // anchored to the nearest corner, so it stays put when the window is resized
        const pos = S.ui.open ? S.ui.pos : S.pillPos;
        pos.h = left + box.width / 2 < vw / 2 ? 'left' : 'right';
        pos.v = top + box.height / 2 < vh / 2 ? 'top' : 'bottom';
        pos.dx = Math.round(pos.h === 'left' ? left : vw - left - box.width);
        pos.dy = Math.round(pos.v === 'top' ? top : vh - top - box.height);
        place();
        ev.preventDefault();
      };
      const stop = () => {
        for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'])
          handle.removeEventListener(type, type === 'pointermove' ? move : stop);
        stopDrag = null;
        wrap.classList.remove('dragging');
        if (moved) {
          S.dragged = Date.now();
          saveUi();
        }
      };
      stopDrag = stop;
      // every event of this pointer comes to the handle until the button is let go, wherever the
      // pointer is and whatever the page does with its own listeners
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that is already gone */
      }
      handle.addEventListener('pointermove', move);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, stop);
    };
    for (const handle of [el.pill, el.head]) {
      handle.addEventListener('pointerdown', startDrag);
      // Without this the browser may begin a drag of its own (of a link of the page that lies
      // under the panel) and take the pointer away after the first few pixels.
      handle.addEventListener('mousedown', (e) => {
        if (!e.target.closest('a, button, input, .seg')) e.preventDefault();
      });
    }
    window.addEventListener(
      'dragstart',
      (e) => {
        if (stopDrag) e.preventDefault();
      },
      { capture: true, signal: lifetime.signal },
    );
    let placeTimer;
    const schedulePlace = () => {
      clearTimeout(placeTimer);
      placeTimer = setTimeout(place, 100);
    };
    window.addEventListener('resize', schedulePlace, { signal: lifetime.signal });
    window.addEventListener('scroll', schedulePlace, { capture: true, passive: true, signal: lifetime.signal });
    window.addEventListener('scrollend', schedulePlace, { capture: true, passive: true, signal: lifetime.signal });

    // ---- pieces
    const chips = (it) => {
      const env = esc(S.d.env);
      let out = '';
      if (it.paused) out += '<span class="c same">paused</span>';
      if (it.edited) out += '<span class="c edited" title="differs from the git baseline: your change">edited</span>';
      if (it.isNew) out += `<span class="c new" title="does not exist on ${env} yet">new</span>`;
      else if (it.differs === true)
        out += `<span class="c diff" title="the local version differs from what ${env} serves">&ne; ${env}</span>`;
      else if (it.differs === false)
        out += `<span class="c same" title="same content as on ${env}: this override changes nothing">= ${env}</span>`;
      if (it.note) out += `<span class="c act">${esc(it.note)}</span>`;
      if (it.count > 1) out += `<span class="c same" title="requested ${it.count} times">&times;${it.count}</span>`;
      return out;
    };
    const itemRow = (it) => {
      const [code, cls, what] = fileIcon(it);
      const title = it.title || shortName(it.rel);
      const sub = it.url && it.kind === 'web-file' ? `${it.url}  ←  ${it.rel}` : it.rel;
      return `<div class="row${it.fresh ? ' fresh' : ''}${it.paused ? ' off' : ''}" data-rel="${esc(it.rel)}" data-path="${esc(it.path ?? '')}" data-url="${esc(it.url ?? '')}">
        <span class="ico ${cls}" title="${esc(what)}">${code}</span>
        <button class="main" data-act="open" title="Open ${esc(it.rel)} in the editor">
          <div class="name" title="${esc(title)}"><span>${hl(title)}</span>${KIND[it.kind] ? `<span class="what">${esc(what)}</span>` : ''}${chips(it)}</div>
          <div class="sub">${hl(sub)}</div>
        </button>
        <div class="acts">
          ${it.canDiff ? `<button class="ib" data-act="diff" title="Show what differs">${icon('diff')}</button>` : ''}
          <button class="ib" data-act="copy" title="Copy the file path">${icon('copy')}</button>
          ${it.canPause ? `<button class="ib" data-act="toggle" data-off="${it.paused ? '' : '1'}" title="${it.paused ? 'Use the local file again' : 'Pause this override: show the online version'}">${icon(it.paused ? 'play' : 'pause')}</button>` : ''}
        </div>
      </div>`;
    };
    const group = (id, title, rows, count) => {
      if (!rows.length) return '';
      const closed = Boolean(S.ui.collapsed[id]) && !S.q;
      return `<div class="group"><button class="gh${closed ? '' : ' openg'}" data-act="fold" data-id="${id}" aria-expanded="${!closed}">${icon('right')}<span>${esc(title)}</span><span class="n dimn">${count ?? rows.length}</span><span class="line"></span></button>${closed ? '' : rows.join('')}</div>`;
    };
    const emptyState = (title, text) => `<div class="empty"><b>${esc(title)}</b>${text}</div>`;
    const loadingState = (title, text) =>
      `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span><div><strong>${esc(title)}</strong>${esc(text)}</div></div>`;
    // Loading epochs let a completed response retire a delayed progress push without
    // hiding a newer background metadata refresh that retains the previous report.
    const inspectionPending = (inspection) =>
      Boolean(
        inspection?.loading &&
        (Number.isSafeInteger(inspection.loadingId)
          ? inspection.loadingId > S.completedInspectionLoadingId
          : !S.inspect?.report),
      );

    const overridesHtml = () => {
      const d = S.d;
      let out = '';
      if (d.page) {
        const srcs = d.page.sources
          .map(
            (s) =>
              `<button class="src${s.empty ? ' none' : ''}" data-act="open" data-rel="${esc(s.rel)}" title="${esc(s.rel)}${s.empty ? ' (empty)' : ''}">${esc(s.label)}</button>`,
          )
          .join('');
        out += `<div class="card"><div class="path">${esc(d.page.path)} <span class="dim">&nbsp;${esc(d.page.name ?? '')}${d.page.dir ? ' &middot; ' + esc(d.page.dir) : ''}</span></div>${srcs ? `<div class="srcs"><span class="lbl2">Sources of this page</span>${srcs}</div>` : ''}</div>`;
      } else {
        out += `<div class="card"><div class="path">${esc(location.pathname)} <span class="dim">&nbsp;no web page with this address in the local sources</span></div></div>`;
      }
      if (d.online) {
        out += `<div class="banner grey"><span class="grow">Overrides are off: this is the page exactly as <b>${esc(d.env)}</b> serves it.</span><button class="btn" data-act="mode" data-v="local">Back to local</button></div>`;
      }
      if (d.pendingBaseline)
        out +=
          '<div class="banner"><span class="grow">The Git baseline changed since this page loaded.</span><button class="btn" data-act="reload">Reload</button></div>';
      const git = d.git ?? {};
      if (git.headMoved && git.baseline?.pinned) {
        out += `<div class="banner"><span class="grow">Git HEAD moved to <b>${esc(git.branch ?? 'detached')} ${esc((git.commit ?? '').slice(0, 7))}</b> after the baseline was pinned at <b>${esc((git.baseline.commit ?? '').slice(0, 7))}</b>: edited markers and template patches still compare with that commit.</span>${git.canRepin ? '<button class="btn" data-act="rebaseline" title="Compare with the current HEAD from now on, as a restart would">Pin HEAD</button>' : ''}</div>`;
      }
      if (d.pending.length) {
        out += `<div class="banner"><span class="grow"><b>${d.pending.length}</b> file${d.pending.length > 1 ? 's' : ''} changed since this page loaded: ${esc(d.pending.slice(0, 2).map(baseName).join(', '))}${d.pending.length > 2 ? ' ...' : ''}</span><button class="btn" data-act="reload">Reload</button></div>`;
      }
      const all = d.items;
      const counts = {
        all: all.length,
        edited: all.filter((i) => i.edited).length,
        differs: all.filter((i) => i.differs === true || i.isNew).length,
      };
      const filter = counts[S.ui.filter] == null ? 'all' : S.ui.filter;
      out += `<div class="filters">
        ${[
          ['all', 'All'],
          ['edited', 'Edited'],
          ['differs', '≠ ' + d.env],
        ]
          .filter(([id]) => id === 'all' || d.capabilities?.comparison !== false)
          .map(
            ([id, label]) =>
              `<button class="f${filter === id ? ' on' : ''}" data-act="filter" data-v="${id}">${esc(label)} <b>${counts[id]}</b></button>`,
          )
          .join('')}
        <span class="grow"></span>${d.mirageMode || d.capabilities?.scope === false ? '' : `<span class="lbl2">scope</span><span class="seg">${['all', 'changed'].map((s) => `<button class="${d.scope === s ? 'on' : ''}" data-act="scope" data-v="${s}" title="${s === 'all' ? 'every local file overrides the site' : 'only files that differ from the git baseline override the site'}">${s}</button>`).join('')}</span>`}
      </div>`;
      const shown = all.filter(
        (i) =>
          (filter === 'edited' ? i.edited : filter === 'differs' ? i.differs === true || i.isNew : true) &&
          matches(i.rel, i.url ?? '', i.title ?? ''),
      );
      let lists = '';
      for (const [id, title] of GROUPS) lists += group(id, title, shown.filter((i) => i.group === id).map(itemRow));
      const paused = d.paused.filter((i) => matches(i.rel, i.url ?? ''));
      lists += group('paused', 'Paused overrides', paused.map(itemRow));
      if (d.modelDriven)
        lists += group(
          'unobserved',
          'Not observed on this revision',
          (d.unobserved ?? []).filter((i) => matches(i.rel, i.url ?? '', i.title ?? '')).map(itemRow),
        );
      const insync = d.insync.filter((i) => matches(i.rel));
      lists += group('insync', `Recognised, same as ${d.env}`, insync.map(itemRow));
      if (!lists) {
        if (S.q || filter !== 'all')
          out += emptyState('Nothing matches', 'Clear the filter to see every override of this page.');
        else if (d.online)
          out += emptyState('Online mode', 'Switch back to <b>Local</b> to lay your sources over the site.');
        else
          out += d.mirageMode
            ? emptyState(
                'Mirage owns source rendering',
                'Open Inspect to see this page’s templates, tables, permissions and sources, or Tweaks to change the persona.',
              )
            : emptyState(
                'Nothing on this page comes from local sources',
                d.scope === 'changed'
                  ? 'Scope is <i>changed</i>: only files that differ from the git baseline override the site. Edit a file and save.'
                  : d.modelDriven
                    ? 'No web resource or code component (PCF) of your Solution sources was loaded by this page. Open Inspect for its table, form and views.'
                    : 'No web file, script, template or snippet of the local sources was found in this page.',
              );
      }
      return out + lists;
    };

    // ---- Mirage: Inspect and Tweaks
    const FORM_MODE = { 100000000: 'insert', 100000001: 'edit', 100000002: 'read only' };
    const PERMISSION_CHIPS = [
      ['read', 'R'],
      ['create', 'C'],
      ['update', 'U'],
      ['delete', 'D'],
    ];
    const RUNTIME_LIMIT = 80;
    /** A Mirage group: collapsible (with a default), filtered, and capped until "Show all". */
    const rgroup = (id, title, items, toRow, { count, collapsed = false } = {}) => {
      if (!items.length) return '';
      S.defaults[id] = collapsed;
      const closed = (S.ui.collapsed[id] ?? collapsed) && !S.q;
      const capped = !closed && items.length > RUNTIME_LIMIT && !S.more[id];
      // Rows are built only for open groups, and only up to the cap.
      const shown = closed ? [] : (capped ? items.slice(0, RUNTIME_LIMIT) : items).map(toRow);
      return `<div class="group" data-group="${id}"><button class="gh${closed ? '' : ' openg'}" data-act="fold" data-id="${id}" aria-expanded="${!closed}">${icon('right')}<span>${esc(title)}</span><span class="n dimn">${count ?? items.length}</span><span class="line"></span></button>${shown.join('')}${capped ? `<button class="morebtn" data-act="more" data-id="${id}">Show all ${items.length}</button>` : ''}</div>`;
    };
    /** One reported item; rows with a reference open their local source (at `find` when given). */
    const rrow = (
      item,
      { code, title, sub = '', chips = '', acts = '', depth = 0, find = '', wrap = false, cls = '' },
    ) => {
      const ref = item?.ref ?? '';
      // Enhanced components keep each field as a JSON key inside powerpagecomponent.xml.
      const findText =
        find ||
        (/powerpagecomponent\.xml$/i.test(ref) && /^[a-z_]+$/i.test(item?.fieldPath ?? '')
          ? `"${item.fieldPath}":`
          : '');
      const body = `<div class="name" title="${esc(title)}"><span>${hl(title)}</span>${chips}</div>${sub ? `<div class="sub">${hl(sub)}</div>` : ''}`;
      return `<div class="row${wrap ? ' wrapt' : ''}${depth ? ` d${Math.min(depth, 6)}` : ''}" data-rel="${esc(ref)}" data-path="${esc(item?.path ?? '')}" data-find="${esc(findText)}">
        <span class="ico ${cls}">${esc(code)}</span>
        ${ref ? `<button class="main" data-act="open" title="Open ${esc(ref)} in the editor">${body}</button>` : `<div class="main">${body}</div>`}
        <div class="acts">${acts}${ref ? `<button class="ib" data-act="open" title="Open in the editor">${icon('code')}</button><button class="ib" data-act="copy" title="Copy the file path">${icon('copy')}</button>` : ''}</div>
      </div>`;
    };
    const simButton = (hash, title) =>
      S.d.mirageMode
        ? `<button class="ib" data-act="sim" data-hash="${esc(hash)}" title="${esc(title)}">${icon('go')}</button>`
        : '';
    const pageRecordId = () => {
      try {
        return new URLSearchParams(location.search).get('id');
      } catch {
        return null;
      }
    };
    const recordsHash = (entity) =>
      `records?entity=${encodeURIComponent(entity)}${pageRecordId() ? `&id=${encodeURIComponent(pageRecordId())}` : ''}`;
    const mirageStatusCard = (c) => {
      const s = c.status ?? {};
      // The browser's own sign-in session wins over the Mirage default persona.
      const session = c.session?.supported ? c.session : null;
      const who = session
        ? session.signedIn
          ? `Signed in as ${session.name ?? session.contactId}`
          : 'Anonymous (not signed in)'
        : s.identity?.contactId
          ? (s.identity.name ?? s.identity.contactId)
          : 'Anonymous visitor';
      const roles = session ? session.roles : s.identity?.roles;
      return `<div class="card"><div class="path">Local Mirage <span class="dim">${esc(s.site ?? S.d.site)} · ${esc(s.format ?? 'portal source')}</span></div>
        <div class="srcs"><span class="lbl2">Runtime</span><span class="dim" title="Source fingerprint ${esc(s.sourceFingerprint ?? 'unknown')}">revision ${esc(s.revision ?? '?')} · source ${esc(String(s.sourceFingerprint ?? '').slice(0, 8) || 'unknown')}</span>${s.reloading ? '<span class="c diff">reloading sources</span>' : ''}${s.pendingReload ? '<span class="c diff">another reload queued</span>' : ''}<button class="src" data-act="sim" data-hash="activity?tab=findings">${esc(s.diagnostics ?? 0)} diagnostics</button></div>
        <div class="srcs"><span class="lbl2">${session ? 'Session' : 'Persona'}</span><span class="dim">${esc(who)} · ${esc((roles ?? []).join(', ') || 'no web roles')} · permissions ${esc(s.permissionMode ?? 'unknown')}${s.activeScenario ? ` · scenario ${esc(s.activeScenario.name ?? s.activeScenario.id)}` : ''}</span><button class="src" data-act="tab" data-v="tweaks">Change</button></div>
        <div class="srcs"><button class="src" data-act="admin">Open _sim administration</button><button class="src" data-act="sim" data-hash="${esc(`audit?path=${encodeURIComponent(location.pathname)}`)}">Requests for this page</button><button class="src" data-act="copypage">Copy local URL</button></div></div>`;
    };

    const runtimeHtml = () => {
      const runtime = S.d.inspection ?? S.d.mirage;
      if (!runtime || (inspectionPending(runtime) && !(S.inspect?.report && S.inspect.version >= runtime.version)))
        return loadingState(
          'Reading local sources…',
          runtime?.phase ?? 'Matching the current address to the selected export.',
        );
      if (!runtime?.active)
        return emptyState(
          'Source inspection unavailable',
          esc(runtime?.error ?? 'The selected export could not be read.'),
        );
      const live = ['live-sources', 'model-driven'].includes(runtime.mode);
      let out = live
        ? `<div class="card"><div class="path">${runtime.mode === 'model-driven' ? 'Model-driven app · local Solution inspection' : 'Live portal · local source inspection'}</div><div class="sub">${esc(S.d.site)} · ${esc(S.d.env)} · ${runtime.status?.solutionCount ?? 0} Solution roots</div><div class="sub">Source references describe the selected checkout. Live role membership and effective record access are unknown.</div></div>`
        : mirageStatusCard(runtime);
      if (inspectionPending(runtime) && S.inspect?.report)
        out += loadingState(
          'Updating source inspection…',
          runtime.phase ?? 'Previous source details remain visible until the update finishes.',
        );
      if (!S.inspect || S.inspect.version < runtime.version)
        return (
          out + loadingState('Inspecting this page…', 'Matching templates, fields and controls to their local sources.')
        );
      if (S.inspect.error && !S.inspect.report)
        return (
          out +
          emptyState('Dependency inspection unavailable', esc(S.inspect.error)) +
          '<button class="btn" data-act="inspect-refresh">Retry inspection</button>'
        );
      const report = S.inspect.report;
      if (!report)
        return (
          out + emptyState('Dependency inspection unavailable', esc(runtime.error ?? 'No page report was returned.'))
        );
      if (report.modelDriven) {
        const c = report.modelDriven;
        out += `<div class="card"><div class="path">${esc(c.entity ?? 'App context')}</div><div class="sub">${esc([c.appId && 'App: ' + c.appId, c.formId && 'Form: ' + c.formId].filter(Boolean).join(' · '))}</div><div class="sub">Selected element ownership and local source identity are evaluated separately from native form context.</div></div>`;
      }
      const sections = [
        ['all', 'All'],
        ['source', report.modelDriven ? 'Solution sources' : 'Page & templates'],
        ['components', 'Forms & controls'],
        ['data', 'Tables & access'],
        ['assets', report.modelDriven ? 'Resources' : 'Files & snippets'],
        ['unresolved', 'Unresolved'],
      ];
      out += `<div class="card"><div class="srcs inspect-tools"><button class="src" data-act="xray" aria-pressed="${Boolean(document.getElementById('paqvilo-xray')?.__px?.enabled)}">◎ Lense X-ray</button><button class="src" data-act="inspect-refresh">Refresh inspection</button><button class="src" data-act="inspect-pick" aria-pressed="${S.pickingElement}">${S.pickingElement ? 'Cancel element selection' : 'Select an element'}</button><button class="src" data-act="inspect-fold" data-v="open">Expand all</button><button class="src" data-act="inspect-fold" data-v="closed">Collapse all</button></div><div class="srcs inspect-nav" role="group" aria-label="Inspection sections">${sections.map(([id, label]) => `<button class="f${S.inspectSection === id ? ' on' : ''}" data-act="inspect-section" data-v="${id}" aria-pressed="${S.inspectSection === id}">${label}</button>`).join('')}</div><div class="sub inspection-help">${esc(report.evidence?.source ?? 'Static dependencies and local runtime evidence.')} Click a source row to open its file.</div></div>`;
      if (S.pickingElement)
        out +=
          '<div class="card"><div class="path">Select an element on the portal</div><div class="sub">Click a control or content block. Its action is paused for this click. Press Escape to cancel.</div></div>';
      const page = report.page;
      if (page) {
        const access = page.access ?? {};
        const verdict =
          access.allowed === true
            ? '<span class="c new">allowed</span>'
            : access.allowed === false
              ? `<span class="c st" title="${esc(access.code ?? '')}">denied</span>`
              : '';
        out += `<div class="card"><div class="path">${esc(page.pageName ?? page.name ?? location.pathname)} <span class="dim">${esc(page.url ?? '')}</span></div>
          <div class="srcs"><span class="lbl2">Template</span><span class="dim">${esc(page.pageTemplateName ?? 'none')}</span><span class="lbl2">Publishing</span><span class="dim">${esc(page.publishingState?.name ?? 'not set')}${page.publishingState?.visible === false ? ' (not visible)' : ''}</span>${page.parent ? `<span class="lbl2">Parent</span><span class="dim">${esc(page.parent.name ?? page.parent.url)}</span>` : ''}</div>
          <div class="srcs"><span class="lbl2">${live ? 'Live access' : 'Current persona'}</span>${verdict || (live ? '<span class="dim">unknown</span>' : '')}<span class="dim">${esc(access.reason ?? access.code ?? '')}</span>${page.ref ? `<button class="src" data-act="open" data-rel="${esc(page.ref)}">Page source</button>` : ''}</div></div>`;
      } else if (!report.modelDriven)
        out += `<div class="card"><div class="path">${esc(location.pathname)} <span class="dim">&nbsp;no exported page matches this address</span></div></div>`;
      const keep = (...texts) => matches(...texts.map((text) => String(text ?? '')));
      const groups = [];
      const sourceRows = (report.pageSources ?? []).filter((item) => keep(item.name, item.ref));
      groups.push(
        rgroup('runtime-page-sources', 'Page source files', sourceRows, (item) =>
          rrow(item, { code: 'SRC', title: item.name, sub: item.ref ?? item.fieldPath ?? '' }),
        ),
      );
      const rules = (page?.access?.rules ?? []).filter((rule) =>
        keep(rule.name, rule.rightLabel, rule.page?.url, ...(rule.roles ?? []).map((role) => role.name ?? role.id)),
      );
      groups.push(
        rgroup('runtime-access', 'Page access rules', rules, (rule) =>
          rrow(rule, {
            code: rule.right === 1 ? 'GRANT' : 'RULE',
            title: rule.name,
            sub: `${rule.id} · ${rule.page?.url ?? ''} · ${rule.rightLabel} · ${rule.scopeLabel} · ${(rule.roles ?? []).map((role) => role.name ?? `${role.id} (unresolved)`).join(', ') || 'no roles'}${rule.inherited ? ` · inherited from ${rule.page?.name ?? rule.page?.url ?? 'an ancestor'}` : ''}`,
            chips: `${rule.matches ? '<span class="c new">current persona</span>' : ''}${rule.overridden ? '<span class="c edited">local override</span>' : ''}`,
            find: rule.id,
            wrap: true,
            acts: simButton(`portal?kind=access-rules&name=${encodeURIComponent(rule.id)}`, 'Edit this rule in _sim'),
          }),
        ),
      );
      const chain = (report.templateChain ?? []).filter((row) => keep(row.name, row.kind, row.via, row.ref));
      groups.push(
        rgroup('runtime-chain', 'Template chain', chain, (row) =>
          rrow(row, {
            code:
              { 'page-template': 'PT', 'web-template': 'TPL', 'content-snippet': 'SNIP', root: 'FROM' }[row.kind] ??
              'SRC',
            title: row.name,
            sub:
              row.kind === 'root'
                ? 'renders'
                : `${row.kind.replace(/-/g, ' ')}${row.via && row.kind === 'web-template' ? ` · ${row.via}` : ''}${row.repeated ? ' · included again' : ''}${row.ref ? ` · ${row.ref}` : ''}`,
            depth: row.depth,
          }),
        ),
      );
      const tables = (report.tables ?? []).filter((table) =>
        keep(table.logicalName, table.displayName, table.entitySet, table.ref),
      );
      groups.push(
        rgroup('runtime-tables', 'Tables', tables, (table) => {
          const operations = table.permissions?.operations ?? {};
          const chips = PERMISSION_CHIPS.map(([op, label]) => {
            const result = operations[op];
            if (!result) return '';
            const tone = !result.allowed ? 'st' : result.scoped ? 'diff' : 'new';
            return `<span class="c ${tone}" title="${esc(`${op}: ${result.reason ?? ''}`)}">${label}${result.allowed ? (result.scoped ? '~' : '') : '×'}</span>`;
          }).join('');
          const reasons = PERMISSION_CHIPS.map(([op]) => (operations[op] ? `${op}: ${operations[op].reason}` : ''))
            .filter(Boolean)
            .join(' ');
          const layers =
            (table.sourceRefs ?? []).length > 1
              ? (table.sourceRefs ?? [])
                  .map(
                    (layer, index) =>
                      `<button class="ib lay" data-act="open" data-rel="${esc(layer.ref)}" title="Open layer ${index + 1}: ${esc(layer.ref)}">L${index + 1}</button>`,
                  )
                  .join('')
              : '';
          return rrow(table, {
            code: 'TBL',
            title: `${table.logicalName}${table.displayName ? ` (${table.displayName})` : ''}`,
            sub: `${table.entitySet ? `entity set ${table.entitySet}${table.entitySetInferred ? ' (inferred)' : ''}` : 'entity set unavailable'} · ${table.fieldCount ?? 0} exported fields${live ? ' · effective live access unknown' : table.permissions?.mode === 'permissive' ? ' · permissions not enforced' : ''}${reasons ? ` · ${reasons}` : ''}`,
            chips,
            wrap: true,
            acts: layers + simButton(recordsHash(table.logicalName), `Open ${table.logicalName} records in _sim`),
          });
        }),
      );
      const grants = (report.permissionRules ?? []).filter((rule) =>
        keep(rule.name, rule.entity, rule.scope, ...(rule.roles ?? [])),
      );
      groups.push(
        rgroup('runtime-permissions', 'Table permissions and web roles', grants, (rule) =>
          rrow(rule, {
            code: 'RULE',
            title: rule.name,
            sub: `${rule.entity} · ${rule.scope} · ${(rule.operations ?? []).join(', ') || 'no operations'} · roles ${(rule.roles ?? []).join(', ') || 'none'}${rule.relationshipName ? ` · relationship ${rule.relationshipName}` : ''}${rule.parentPermissionId ? ` · parent ${rule.parentPermissionId}` : ''}${live ? ' · exported grant; live access unknown' : ''}`,
            wrap: true,
          }),
        ),
      );
      const forms = (report.forms ?? []).filter((form) =>
        keep(form.name, form.entity, form.formName, form.kind, ...(form.steps ?? []).map((step) => step.name)),
      );
      groups.push(
        rgroup('runtime-forms', 'Forms', forms, (form) =>
          [
            rrow(form, {
              code: form.kind === 'advanced-form' ? 'ADV' : 'FORM',
              title: form.name,
              sub: `${form.kind === 'advanced-form' ? 'advanced form' : form.kind === 'model-driven-form' ? `${form.formType ?? 'main'} form` : 'basic form'}${FORM_MODE[form.mode] ? ` · ${FORM_MODE[form.mode]}` : ''} · table ${form.entity ?? 'unknown'}${form.formName ? ` · form ${form.formName}` : ''}${form.evidence === 'rendered-component-id' ? ' · observed form ID' : form.evidence === 'configured-modal-form' ? ' · configured modal source' : ''}`,
              acts: form.entity ? simButton(recordsHash(form.entity), `Open ${form.entity} records in _sim`) : '',
            }),
            ...(report.components ?? [])
              .filter(
                (component) =>
                  component.recordId === form.id && component.kind === 'basic-form' && component.ref !== form.ref,
              )
              .map((component) =>
                rrow(component, {
                  code: 'JS',
                  title: 'Form JavaScript',
                  sub: component.ref ?? 'Custom script source',
                  depth: 1,
                }),
              ),
            ...(form.formXml?.ref
              ? [
                  rrow(form.formXml, {
                    code: 'XML',
                    title: form.formXml.name ?? 'FormXml',
                    sub: `Solution FormXml · ${form.formXml.ref}`,
                    depth: 1,
                  }),
                ]
              : []),
            ...(form.steps ?? []).flatMap((step) => [
              rrow(step, {
                code: 'STEP',
                title: step.name ?? step.id,
                sub: `${step.entity ?? 'no table'}${FORM_MODE[step.mode] ? ` · ${FORM_MODE[step.mode]}` : ''}${step.formName ? ` · form ${step.formName}` : ''}`,
                depth: 1,
              }),
              ...(step.formXml?.ref
                ? [
                    rrow(step.formXml, {
                      code: 'XML',
                      title: step.formXml.name ?? 'FormXml',
                      sub: `Solution FormXml · ${step.formXml.ref}`,
                      depth: 2,
                    }),
                  ]
                : []),
            ]),
          ].join(''),
        ),
      );
      const views = (report.views ?? []).filter((view) =>
        keep(view.name, view.entity, ...(view.fields ?? []).map((field) => field.name)),
      );
      groups.push(
        rgroup('runtime-views', 'Views', views, (view) =>
          rrow(view, {
            code: 'VIEW',
            title: view.name,
            sub: `${view.entity} · ${(view.fields ?? []).length} columns: ${(view.fields ?? []).map((field) => field.name).join(', ')}${view.usedBy?.length ? ` · used by ${[...new Set(view.usedBy)].join(', ')}` : ''}${view.evidence === 'rendered-view-id' ? ' · observed view ID' : ''}`,
            wrap: true,
          }),
        ),
      );
      const native = (report.nativeComponents ?? []).filter((item) =>
        keep(item.name, item.id, item.kind, item.entity, item.owner, item.relationship),
      );
      groups.push(
        rgroup('runtime-native', 'Native grids, quick views and notes', native, (item) =>
          [
            rrow(item, {
              code: item.kind === 'subgrid' ? 'GRID' : item.kind === 'quickform' ? 'QUICK' : 'NOTES',
              title: item.name,
              sub: `${item.owner} · table ${item.entity ?? 'unknown'}${item.relationship ? ` · relationship ${item.relationship}` : ''}${item.lookup ? ` · lookup ${item.lookup}` : ''} · ${item.evidence === 'rendered-control-id' ? 'observed control ID' : 'exported form control'}${item.hidden ? ' · hidden in FormXml' : ''}`,
              wrap: true,
            }),
            ...(item.metadataSources ?? []).map((source) =>
              rrow(source, { code: 'META', title: source.name, sub: source.ref ?? '', depth: 1 }),
            ),
            ...(item.actions ?? []).map((action) =>
              rrow(action, {
                code: 'ACTION',
                title: `${action.name}${action.formName ? `: ${action.formName}` : ''}`,
                sub: `exported action${action.formId ? ` · modal form ${action.formId}` : ''}${action.conditional ? ' · conditional visibility' : ''}`,
                depth: 1,
                wrap: true,
              }),
            ),
          ].join(''),
        ),
      );
      const columns = (report.columns ?? []).filter((column) =>
        keep(column.entity, column.name, column.label, column.type),
      );
      groups.push(
        rgroup(
          'runtime-columns',
          'Fields and columns',
          columns,
          (column) =>
            rrow(column, {
              code: 'COL',
              title: `${column.entity}.${column.name}`,
              sub:
                column.resolved === false
                  ? 'not described by the selected Solution metadata'
                  : `${column.label ?? column.name} · ${column.type ?? 'unknown type'}${column.required ? ' · required' : ''}${column.maxLength ? ` · max ${column.maxLength}` : ''}${column.optionCount ? ` · ${column.optionCount} options: ${(column.options ?? []).map((option) => option.label).join(', ')}${column.optionCount > (column.options ?? []).length ? ' ...' : ''}` : ''}`,
              chips: column.required ? '<span class="c edited">required</span>' : '',
              find: `<LogicalName>${column.name}</LogicalName>`,
              acts: `<button class="ib" data-act="inspect-locate" data-field="${esc(column.name)}" title="Find this field on the page">${icon('go')}</button>`,
            }),
          { collapsed: columns.length > 25 },
        ),
      );
      const USAGE_CODE = {
        entityform: 'FORM',
        entitylist: 'LIST',
        webform: 'ADV',
        entityview: 'VIEW',
        editable: 'EDIT',
        include: 'INC',
        snippet: 'SNIP',
        fetchxml: 'FXML',
      };
      const lists = (report.components ?? []).filter(
        (component) => component.kind === 'list' && keep(component.name, component.entity, 'list'),
      );
      const usages = (report.usages ?? []).filter((usage) =>
        keep(usage.kind, usage.reference, usage.expression, usage.owner, usage.target),
      );
      groups.push(
        rgroup(
          'runtime-components',
          'Components and controls',
          [...lists.map((list) => ({ list })), ...usages.map((usage) => ({ usage }))],
          ({ list, usage }) =>
            list
              ? rrow(list, {
                  code: 'LIST',
                  title: list.name,
                  sub: `list${list.entity ? ` · table ${list.entity}` : ''}`,
                })
              : rrow(
                  {},
                  {
                    code: USAGE_CODE[usage.kind] ?? 'USE',
                    title: `${usage.kind}${usage.reference ? `: ${usage.reference}` : ' (dynamic)'}`,
                    sub: `${usage.expression} · in ${usage.owner}`,
                    wrap: true,
                  },
                ),
          { collapsed: usages.length > 40 },
        ),
      );
      const controls = (report.renderedControls ?? []).filter((item) =>
        keep(item.id, item.name, item.field, item.entity),
      );
      groups.push(
        rgroup(
          'runtime-rendered',
          'Rendered controls',
          controls,
          (item) =>
            rrow(item, {
              code: 'DOM',
              title: item.field ?? item.name ?? item.id ?? item.tag,
              sub: `${item.tag}${item.type ? ` · ${item.type}` : ''} · ${item.evidence === 'rendered-and-source' ? 'observed with source match' : 'observed; source binding unknown'}`,
              acts:
                item.id || item.name
                  ? `<button class="ib" data-act="inspect-locate" data-field="${esc(item.id || item.name)}" title="Find on the page">${icon('go')}</button>`
                  : '',
            }),
          { collapsed: controls.length > 25 },
        ),
      );
      groups.push(
        rgroup(
          'runtime-api',
          'Web API references',
          (report.apiReferences ?? []).filter((item) => keep(item.name, item.entity)),
          (item) =>
            rrow(item, {
              code: 'API',
              title: `/_api/${item.name}`,
              sub: `${item.entity ? `table ${item.entity}` : 'Entity set binding is absent from selected Solution metadata'} · ${item.evidence === 'observed-api-request' ? 'observed request; IDs and query values excluded' : 'literal source reference'}`,
            }),
        ),
      );
      groups.push(
        rgroup(
          'runtime-logic',
          'Server logic, flows and plugin registrations',
          (report.logic ?? []).filter((item) =>
            keep(item.name, item.ref, item.entity, item.typeName, item.assemblyName),
          ),
          (item) =>
            [
              rrow(item, {
                code: item.kind === 'cloud-flow' ? 'FLOW' : item.kind === 'plugin-step' ? 'PLUGIN' : 'LOGIC',
                title: item.name,
                sub:
                  item.kind === 'plugin-step'
                    ? item.description
                    : `${item.description ?? item.path ?? ''} · static reference`,
                wrap: true,
              }),
              ...(item.sources ?? []).map((source) =>
                rrow(source, {
                  code: source.kind === 'plugin-type' ? 'TYPE' : source.kind === 'plugin-code' ? 'C#' : 'ASM',
                  title: source.name,
                  sub:
                    source.kind === 'plugin-code'
                      ? 'Explicit C# source mapping; editing requires build and deployment to affect live code'
                      : 'Exported metadata source; compiled code execution is not observed',
                  depth: 1,
                }),
              ),
            ].join(''),
        ),
      );
      groups.push(
        rgroup(
          'runtime-pcf',
          'Code components',
          (report.codeComponents ?? []).filter((item) => keep(item.name, item.schemaName, item.owner)),
          (item) =>
            [
              rrow(item, {
                code: 'PCF',
                title: item.schemaName ?? item.name,
                sub: `${item.expression} · ${item.binding === 'native-formxml' ? `Native binding · ${item.selectedDesktop ? 'desktop selected' : 'other form factor'} · portal ${item.enablement}` : item.binding === 'declared-schema-name' ? 'Exported schema name' : item.schemaName ? 'Configured component mapping' : 'Solution binding unknown'}`,
                wrap: true,
              }),
              ...(item.formSourceFile
                ? [
                    rrow(item.formSource, {
                      code: 'XML',
                      title: item.owner,
                      sub: `${item.entity ?? ''}.${item.field ?? ''} · ${(item.boundAttributes ?? []).join(', ') || 'No bound columns'}`,
                      depth: 1,
                    }),
                  ]
                : []),
              ...(item.metadataSources ?? []).map((source) =>
                rrow(source, { code: 'CFG', title: source.name, sub: 'Exported attribute metadata', depth: 1 }),
              ),
              ...(item.datasets ?? []).map((dataset) =>
                rrow(dataset, {
                  code: 'DATA',
                  title: dataset.name,
                  sub: `${dataset.binding || 'Binding missing'} · ${dataset.resolved ? `${dataset.entity}${dataset.viewName ? ` · ${dataset.viewName}` : ''} · ${dataset.fields?.length ?? 0} columns` : 'Table/view binding unknown'}`,
                  depth: 1,
                }),
              ),
              ...(item.resources ?? []).map((resource) =>
                rrow(resource, {
                  code: resource.name.toUpperCase(),
                  title: resource.ref ?? resource.url,
                  sub: 'Declared component resource',
                  depth: 1,
                }),
              ),
            ].join(''),
        ),
      );
      groups.push(
        rgroup(
          'runtime-assets',
          report.modelDriven ? 'Web resources of your Solutions' : 'Web files used on this page',
          (report.assets ?? []).filter((item) => keep(item.name, item.url, item.ref)),
          (item) =>
            rrow(item, {
              code: /\.css$/i.test(item.url) ? 'CSS' : /\.m?js$/i.test(item.url) ? 'JS' : 'FILE',
              title: item.url,
              sub: `${item.evidence === 'rendered-asset' ? 'observed in rendered DOM' : 'static source reference'} · ${item.ref ?? 'attachment source unavailable'}`,
            }),
        ),
      );
      const snippets = (report.snippets ?? []).filter((snippet) => keep(snippet.name, snippet.value, snippet.ref));
      groups.push(
        rgroup(
          'runtime-snippets',
          'Content snippets',
          snippets,
          (snippet) =>
            rrow(snippet, {
              code: 'SNIP',
              title: snippet.name,
              sub: snippet.deleted ? 'removed locally' : snippet.value == null ? '' : `“${snippet.value}”`,
              chips: snippet.overridden ? '<span class="c edited">local override</span>' : '',
              acts: simButton(
                `portal?kind=snippets&name=${encodeURIComponent(snippet.name)}`,
                'Edit this snippet in _sim',
              ),
            }),
          { collapsed: snippets.length > 40 },
        ),
      );
      const settings = (report.siteSettings ?? []).filter((setting) => keep(setting.name, setting.value));
      groups.push(
        rgroup(
          'runtime-settings',
          'Site settings',
          settings,
          (setting) =>
            rrow(setting, {
              code: 'SET',
              title: setting.name,
              sub: setting.deleted ? 'removed locally' : `= ${setting.value ?? ''}`,
              chips: setting.overridden ? '<span class="c edited">local override</span>' : '',
              find: setting.recordId ?? setting.name,
              acts: simButton(
                `portal?kind=settings&name=${encodeURIComponent(setting.name)}`,
                'Edit this setting in _sim',
              ),
            }),
          { collapsed: settings.length > 40 },
        ),
      );
      const related = report.related ?? {};
      const relatedItems = [
        ...(related.weblinks ?? []).filter((link) => keep(link.name, link.set)).map((item) => ({ kind: 'link', item })),
        ...(related.sitemarkers ?? [])
          .filter((marker) => keep(marker.name, 'site marker'))
          .map((item) => ({ kind: 'marker', item })),
        ...(related.redirects ?? [])
          .filter((redirect) => keep(redirect.name, redirect.inboundUrl, 'redirect'))
          .map((item) => ({ kind: 'redirect', item })),
        ...(related.shortcuts ?? [])
          .filter((shortcut) => keep(shortcut.name, shortcut.title, 'shortcut'))
          .map((item) => ({ kind: 'shortcut', item })),
      ];
      groups.push(
        rgroup('runtime-related', 'Related metadata', relatedItems, ({ kind, item }) =>
          kind === 'link'
            ? rrow(item, {
                code: 'LINK',
                title: item.name,
                sub: `web link in ${item.set ?? 'an unknown set'}`,
                find: item.id,
              })
            : kind === 'marker'
              ? rrow(item, { code: 'MARK', title: item.name, sub: 'site marker', find: item.id })
              : kind === 'redirect'
                ? rrow(item, {
                    code: 'REDIR',
                    title: `/${String(item.inboundUrl ?? '').replace(/^\//, '')}`,
                    sub: `redirect ${item.statusCode ?? ''} to this page${item.name ? ` · ${item.name}` : ''}`,
                    find: item.id,
                  })
                : rrow(item, { code: 'SHORT', title: item.title ?? item.name, sub: 'shortcut', find: item.id }),
        ),
      );
      const unresolved = (report.unresolved ?? []).filter((item) =>
        keep(item.name, item.expression, item.kind, item.reason, item.owner),
      );
      groups.push(
        rgroup(
          'runtime-unresolved',
          'Unresolved dependencies',
          unresolved,
          (item) =>
            `<div class="row wrapt"><span class="ico k-warn">?</span><div class="main"><div class="name"><span>${hl(item.expression ?? item.name ?? item.kind ?? 'Dependency')}</span><span class="what">${esc(item.kind ?? '')}</span></div><div class="sub">${hl(item.reason ?? item.message ?? '')}${item.owner ? ` · in ${esc(item.owner)}` : ''}</div></div></div>`,
          { collapsed: unresolved.length > 20 },
        ),
      );
      const sectionOf = {
        'runtime-page-sources': 'source',
        'runtime-chain': 'source',
        'runtime-access': 'data',
        'runtime-tables': 'data',
        'runtime-permissions': 'data',
        'runtime-api': 'data',
        'runtime-forms': 'components',
        'runtime-views': 'components',
        'runtime-native': 'components',
        'runtime-columns': 'components',
        'runtime-components': 'components',
        'runtime-rendered': 'components',
        'runtime-logic': 'components',
        'runtime-pcf': 'components',
        'runtime-assets': 'assets',
        'runtime-snippets': 'assets',
        'runtime-settings': 'assets',
        'runtime-related': 'source',
        'runtime-unresolved': 'unresolved',
      };
      const listed = groups
        .filter(
          (group) =>
            S.inspectSection === 'all' || sectionOf[/data-group="([^"]+)"/.exec(group)?.[1]] === S.inspectSection,
        )
        .join('');
      return (
        out +
        (listed ||
          emptyState(
            S.q ? 'Nothing matches' : 'No dependencies in this section',
            S.q
              ? 'Clear the filter to see the page inspection.'
              : 'Choose another section or refresh after navigating.',
          ))
      );
    };

    const personaFold = (value) =>
      String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[øæœßđðłþ]/g, (letter) => S.tweaks?.personaCatalog?.transliterations?.[letter] ?? letter);
    const personaPreferences = () => {
      try {
        const value = JSON.parse(
          localStorage.getItem(`paqvilo:panel-personas:${S.tweaks?.personaCatalog?.scope ?? location.origin}`) ?? '{}',
        );
        return {
          pinned: Array.isArray(value.pinned) ? value.pinned.filter((v) => typeof v === 'string').slice(0, 100) : [],
          recent: Array.isArray(value.recent) ? value.recent.filter((v) => typeof v === 'string').slice(0, 5) : [],
        };
      } catch {
        return { pinned: [], recent: [] };
      }
    };
    const savePersonaPreferences = (value) => {
      try {
        localStorage.setItem(
          `paqvilo:panel-personas:${S.tweaks?.personaCatalog?.scope ?? location.origin}`,
          JSON.stringify(value),
        );
      } catch {
        /* optional preference */
      }
    };
    const personaCollator = new Intl.Collator('en', { sensitivity: 'base' });
    let personaOrderCache;
    const personaMatches = (query = S.personaFilters ?? { q: '', roles: [], tags: [], groups: [], subgroups: [] }) => {
      const terms = personaFold(query.q).trim().split(/\s+/).filter(Boolean),
        people = S.tweaks?.personas ?? [];
      const index =
        S.tweaks?.personaIndex ??
        people.map((person) => ({
          key: person.key ?? `@contact:${person.contactId}`,
          text: personaFold([person.name, ...(person.roles ?? [])].join(' ')),
          roles: (person.roles ?? []).map(personaFold),
          tags: [],
          group: '__other',
        }));
      const groups = S.tweaks?.personaCatalog?.groups ?? [],
        groupOrder = new Map(groups.map((group, index) => [personaFold(group.id), index])),
        subgroups = new Map(
          groups.map((group) => [
            personaFold(group.id),
            new Map((group.subgroups ?? []).map((sub, index) => [personaFold(sub.id), index])),
          ]),
        );
      if (personaOrderCache?.people !== people)
        personaOrderCache = {
          people,
          ordered: index
            .map((entry, i) => ({ ...entry, persona: people[i] }))
            .filter((entry) => entry.persona)
            .sort(
              (a, b) =>
                (groupOrder.get(a.group) ?? groups.length) - (groupOrder.get(b.group) ?? groups.length) ||
                (a.subgroup ? (subgroups.get(a.group)?.get(a.subgroup) ?? 1000) : -1) -
                  (b.subgroup ? (subgroups.get(b.group)?.get(b.subgroup) ?? 1000) : -1) ||
                (a.persona.order ?? 1000) - (b.persona.order ?? 1000) ||
                personaCollator.compare(
                  String(a.persona.label ?? a.persona.name ?? a.key),
                  String(b.persona.label ?? b.persona.name ?? b.key),
                ) ||
                a.key.localeCompare(b.key),
            ),
        };
      return personaOrderCache.ordered.filter(
        (entry) =>
          entry.persona &&
          entry.persona.active !== false &&
          terms.every((term) => entry.text.includes(term)) &&
          ['roles', 'tags', 'accounts'].every(
            (facet) => !query[facet]?.length || query[facet].some((value) => entry[facet].includes(personaFold(value))),
          ) &&
          (!query.rolesOnly || entry.roles.length > 0) &&
          (!query.groups?.length || query.groups.map(personaFold).includes(entry.group)) &&
          (!query.subgroups?.length ||
            query.subgroups.some((value) => personaFold(value) === `${entry.group}:${entry.subgroup}`)),
      );
    };
    const personaRowsHtml = () => {
      const matching = personaMatches(),
        preferences = personaPreferences(),
        offset = Math.max(0, Math.min(S.personaPage ?? 0, Math.max(0, matching.length - 1))),
        pageRows = matching.slice(offset, offset + 50);
      const row = (entry) => {
        const p = entry.persona,
          selected = S.pick.personaKey ? S.pick.personaKey === entry.key : S.pick.persona === p.contactId;
        return `<div class="pp-persona-row${selected ? ' selected' : ''}" data-panel-persona-row="${esc(entry.key)}"><button class="pp-persona-choice" data-act="choosepersona" data-contact="${esc(p.contactId)}" data-key="${esc(entry.key)}" aria-pressed="${selected}"><strong>${esc(p.label ?? p.name ?? p.contactId)}${p.default ? ' · Default' : ''}</strong><span>${esc(p.name ?? p.contactId)}${p.account?.name ? ` · ${esc(p.account.name)}` : ''}</span>${p.description ? `<span>${esc(p.description.split(/\r?\n/, 1)[0])}</span>` : ''}<span>${esc((p.roles ?? []).join(', ') || 'No web roles')}${p.tags?.length ? ` · ${esc(p.tags.join(', '))}` : ''}${p.context ? ` · Setup available: ${esc(S.tweaks.personaCatalog?.contexts?.find((c) => c.id === p.context)?.label ?? p.context)} (full picker)` : ''}</span></button><button data-act="pinpersona" data-key="${esc(entry.key)}" aria-pressed="${preferences.pinned.includes(entry.key)}" aria-label="Pin ${esc(p.label ?? p.name)}">${preferences.pinned.includes(entry.key) ? '★' : '☆'}</button></div>`;
      };
      const shortcut = (keys, label) => {
        const byKey = new Map(matching.map((entry) => [entry.key, entry]));
        const rows = keys
          .map((key) => byKey.get(key))
          .filter(Boolean)
          .slice(0, 10);
        return rows.length ? `<section><h4>${label}</h4>${rows.map(row).join('')}</section>` : '';
      };
      const groups = [
        ...(S.tweaks?.personaCatalog?.groups ?? []).filter((group) =>
          matching.some((entry) => entry.persona.group === group.id),
        ),
        { id: '__other', label: 'Other contacts' },
      ];
      const defaultRow = offset === 0 ? matching.find((entry) => entry.persona.default) : null;
      return `<p class="dim" role="status" data-panel-persona-count>${matching.length ? offset + 1 : 0}–${Math.min(offset + 50, matching.length)} of ${matching.length} personas</p>${defaultRow ? `<section><h4>Default</h4>${row(defaultRow)}</section>` : ''}${shortcut(preferences.pinned, 'Pinned')}${shortcut(preferences.recent, 'Recent')}${groups
        .map((group) => {
          const all = matching.filter((entry) => (entry.group || '__other') === group.id),
            rows = pageRows.filter((entry) => (entry.group || '__other') === group.id && entry !== defaultRow);
          if (!all.length) return '';
          return `<details class="pp-persona-group"${all.length <= 25 || S.personaFilters?.q || S.personaFilters?.rolesOnly || ['roles', 'tags', 'accounts', 'groups', 'subgroups'].some((key) => S.personaFilters?.[key]?.length) ? ' open' : ''}><summary>${esc(group.label)} · ${all.length}${!rows.length ? `<button class="btn" data-act="persona-group" data-group="${esc(group.id)}">View ${esc(group.label)} matches</button>` : ''}</summary>${rows
            .filter((entry) => !entry.persona.subgroup)
            .map(row)
            .join('')}${(group.subgroups ?? [])
            .map((sub) => {
              const entries = rows.filter((entry) => entry.persona.subgroup === sub.id);
              return entries.length
                ? `<h4>${esc(sub.label)} · ${all.filter((entry) => entry.persona.subgroup === sub.id).length}</h4>${entries.map(row).join('')}`
                : '';
            })
            .join('')}</details>`;
        })
        .join(
          '',
        )}${matching.length ? '' : '<p class="dim">No personas match. Clear a filter or use fewer terms.</p>'}<div class="tw">${offset ? '<button class="btn" data-act="persona-page" data-direction="-1">Previous</button>' : ''}${offset + 50 < matching.length ? '<button class="btn" data-act="persona-page" data-direction="1">Show more</button>' : ''}</div>`;
    };
    const personaPickerHtml = (selectedId) => {
      if (S.pick.persona === undefined && selectedId !== undefined) S.pick.persona = selectedId;
      const query = S.personaFilters ?? { q: '', roles: [], tags: [], groups: [], subgroups: [] },
        people = S.tweaks?.personas ?? [],
        groups = [
          ...(S.tweaks?.personaCatalog?.groups ?? []).filter((group) =>
            people.some((person) => person.active !== false && person.group === group.id),
          ),
          ...(people.some((person) => person.active !== false && person.group === '__other')
            ? [{ id: '__other', label: 'Other contacts' }]
            : []),
        ];
      const facets = [
        ['roles', 'Web role', [...new Set(people.flatMap((p) => p.roles ?? []))].map((id) => ({ id, label: id }))],
        ['tags', 'Tag', [...new Set(people.flatMap((p) => p.tags ?? []))].map((id) => ({ id, label: id }))],
        [
          'accounts',
          'Account',
          [
            ...new Map(
              people.filter((p) => p.account?.id).map((p) => [p.account.id, p.account.name ?? p.account.id]),
            ).entries(),
          ].map(([id, label]) => ({ id, label })),
        ],
        ['groups', 'Group', groups],
        [
          'subgroups',
          'Subgroup',
          groups.flatMap((group) =>
            (group.subgroups ?? []).map((sub) => ({
              id: `${group.id}:${sub.id}`,
              label: `${group.label} / ${sub.label}`,
            })),
          ),
        ],
      ];
      for (const facet of facets) {
        const [name] = facet,
          available = new Set();
        for (const entry of personaMatches({ ...query, [name]: [] })) {
          const values =
            name === 'groups'
              ? [entry.group]
              : name === 'subgroups'
                ? entry.subgroup
                  ? [`${entry.group}:${entry.subgroup}`]
                  : []
                : (entry[name] ?? []);
          for (const value of values) available.add(personaFold(value));
        }
        facet[2] = facet[2].filter((item) => available.has(personaFold(item.id)) || query[name]?.includes(item.id));
      }
      const selected = people.find((p) => p.contactId === S.pick.persona),
        activeFilters =
          [query.roles, query.tags, query.groups, query.subgroups, query.accounts].reduce(
            (total, values) => total + (values?.length ?? 0),
            0,
          ) + (query.rolesOnly ? 1 : 0);
      return `<div class="pp-persona-picker"><label>Find a persona<input type="search" data-panel-persona-query value="${esc(query.q)}" placeholder="Name, account, role, tag or description"></label><details class="pp-persona-filter-disclosure"${(S.personaFilterDisclosureOpen ?? Boolean(activeFilters)) ? ' open' : ''}><summary>Filters${activeFilters ? ` · ${activeFilters} active` : ''}</summary><div class="pp-persona-facets">${facets
        .filter(([, , options]) => options.length)
        .map(
          ([name, label, options]) =>
            `<label>${label}<select data-panel-persona-facet="${name}" aria-label="${label}" multiple size="2">${options
              .filter((item, index) => index < 100 || query[name]?.includes(item.id))
              .map(
                (item) =>
                  `<option value="${esc(item.id)}"${query[name]?.includes(item.id) ? ' selected' : ''}>${esc(item.label)}</option>`,
              )
              .join('')}</select></label>`,
        )
        .join(
          '',
        )}</div><label><input type="checkbox" data-panel-persona-roles-only${query.rolesOnly ? ' checked' : ''}> Has web roles</label><p class="dim">All terms match. Any values within one filter match; filters combine.${facets.some(([, , options]) => options.length > 100) ? ' Filter menus show the first 100 values; use search for other names, roles, accounts or tags.' : ''}</p><button class="btn" data-act="persona-clear">Clear filters</button></details><div data-panel-persona-results>${personaRowsHtml()}</div><p class="dim" data-panel-persona-selected>Selected: ${esc(selected?.label ?? selected?.name ?? 'Choose a persona')}. ${S.tweaks?.session?.supported ? 'Sign-in changes this browser’s identity; runtime settings stay unchanged.' : 'Switch persona changes the runtime default for requests without their own sign-in session.'}</p><button class="btn" data-act="sim" data-hash="identity">Open full picker and isolated setups</button></div>`;
    };
    const refreshPersonaRows = () => {
      // Recompute available facets as well as rows, preserving the focused search/control.
      const picker = el.panel.querySelector('.pp-persona-picker');
      if (picker) {
        S.personaFilterDisclosureOpen = picker.querySelector('.pp-persona-filter-disclosure')?.open ?? false;
        const active = root.activeElement,
          search = active?.hasAttribute('data-panel-persona-query'),
          selection = search ? [active.selectionStart, active.selectionEnd] : null;
        const identity =
          active && picker.contains(active) ? { tag: active.tagName, data: { ...active.dataset } } : null;
        picker.outerHTML = personaPickerHtml();
        delete S.html.body;
        const replacement = identity
          ? [
              ...el.panel.querySelectorAll(
                '.pp-persona-picker button,.pp-persona-picker input,.pp-persona-picker select',
              ),
            ].find(
              (node) =>
                node.tagName === identity.tag &&
                Object.entries(identity.data).every(([key, value]) => node.dataset[key] === value),
            )
          : null;
        if (identity) (replacement ?? el.tabs.querySelector('[aria-selected=true]'))?.focus({ preventScroll: true });
        if (search && selection)
          try {
            replacement?.setSelectionRange(...selection);
          } catch {
            /* Optional inspection or cleanup failure must not interrupt the owning operation. */
          }
      }
      const query = S.personaFilters ?? {},
        count =
          ['roles', 'tags', 'groups', 'subgroups', 'accounts'].reduce(
            (total, key) => total + (query[key]?.length ?? 0),
            0,
          ) + (query.rolesOnly ? 1 : 0),
        summary = el.panel.querySelector('.pp-persona-filter-disclosure>summary');
      if (summary) summary.textContent = 'Filters' + (count ? ` · ${count} active` : '');
    };

    const tweaksHtml = () => {
      const runtime = S.d.mirage;
      if (S.d.mirageMode && !runtime) return emptyState('Connecting to the Mirage ...', '');
      if (!runtime?.active)
        return emptyState(
          'Mirage is not active',
          runtime?.error ? esc(runtime.error) : 'Tweaks change the local Mirage runtime.',
        );
      const t = S.tweaks;
      if (!t || S.tweaksLoading !== null)
        return loadingState('Loading local setup…', 'Reading personas, permissions and scenarios.');
      if (!t.ok)
        return (
          emptyState('Tweaks unavailable', esc(t.error ?? '')) +
          '<button class="btn" data-act="tweaks-retry">Retry</button>'
        );
      let out = '';
      if (S.confirm)
        out += `<div class="banner" role="alertdialog" aria-label="Confirm local setup"><span class="grow">${esc(S.confirm.text)}</span><button class="btn" data-act="confirm-yes">${esc(S.confirm.label)}</button><button class="f" data-act="confirm-no">Cancel</button></div>`;
      const option = (value, label, selected) =>
        `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
      const session = t.session?.supported ? t.session : null;
      if (session) {
        // This browser's own sign-in session (a cookie): not the Mirage default persona.
        const listed = (id) => t.personas.some((item) => item.contactId === id);
        const persona =
          [S.pick.persona, session.signedIn ? session.contactId : null, t.personas[0]?.contactId].find(
            (id) => id && listed(id),
          ) ?? '';
        const chosen = t.personas.find((item) => item.contactId === persona);
        // How the portal signs in: the site's identity provider (the local stand-in on loopback),
        // or the local persona sign-in page when the site has no external provider.
        const idp = session.identityProvider;
        const provider = idp?.available ? idp.provider : null;
        const via = provider
          ? `Signs in through ${esc(provider.caption ?? provider.name ?? provider.id)}${provider.type ? ` (${esc(provider.type)})` : ''} · callback ${esc(provider.callbackPath ?? 'not reported')}${idp.port ? ` · local identity provider on port ${idp.port}` : ''}`
          : `Signs in on the local sign-in page${idp?.reason ? ` (${esc(idp.reason)})` : ''}`;
        out += `<div class="card"><div class="path">Browser session <span class="c ${session.signedIn ? 'new' : 'st'}">${session.signedIn ? 'signed in' : 'anonymous'}</span>${session.roleSource === 'override' ? ' <span class="c diff" title="Set in _sim: the roles of this signed-in session are overridden">Simulation override</span>' : ''}</div>
          <div class="who">${session.signedIn ? `Signed in as <b>${esc(session.name ?? session.contactId)}</b>` : '<b>Anonymous</b> · this browser is not signed in'}</div>
          <div class="dim">${esc((session.roles ?? []).join(', ') || 'no web roles')}${session.roleSource === 'override' ? ' (simulation override)' : ''}${session.accountId ? ` · account ${esc(session.accountId)}` : ''}</div>
          <div class="dim" data-idp="${provider ? 'external' : 'local'}">${via}</div>
          ${session.signedIn ? '<div class="tw"><button class="btn" data-act="signout">Sign out</button></div>' : ''}
          ${t.personas.length ? `<div class="tw">${personaPickerHtml(persona)}<button class="btn" data-act="signin">Sign in as ${esc(chosen?.name ?? chosen?.contactId ?? 'persona')}</button></div>` : '<div class="dim">No local personas yet: create one in _sim, Identity &amp; permissions.</div>'}
          ${session.error ? `<div class="dim">${esc(session.error)}</div>` : ''}
          <div class="dim">This page runs the portal's own sign-in (or sign-out) and comes back here. Only this browser changes; other browsers keep their own sessions.</div></div>`;
      } else {
        const persona = S.pick.persona ?? t.identity?.contactId ?? '';
        out += `<div class="card"><div class="path">Persona</div>${t.personasAvailable ? `<div class="tw">${personaPickerHtml(persona)}<button class="btn" data-act="choosepersona" data-contact="" data-key="anonymous">Anonymous visitor</button><button class="btn" data-act="persona">Switch persona</button></div>` : '<div class="dim">This Mirage does not report personas.</div>'}<div class="dim">Current: ${esc(t.identity?.name ?? 'Anonymous')} · ${esc((t.identity?.roles ?? []).join(', ') || 'no web roles')}. Pages reload as this persona.</div></div>`;
      }
      out += `<div class="card"><div class="path">Table permissions</div><div class="tw"><span class="seg">${[
        ['enforce', 'Enforce'],
        ['permissive', 'Permissive'],
      ]
        .map(
          ([value, label]) =>
            `<button class="${t.permissionMode === value ? 'on' : ''}" data-act="permissions" data-v="${value}" title="${value === 'enforce' ? 'Apply table permissions, web roles and scopes' : 'Sandbox: every identity may read and write all local tables'}">${label}</button>`,
        )
        .join('')}</span><span class="dim">grant source ${esc(t.permissionSource ?? 'unknown')}</span></div></div>`;
      if (t.scenarios.length) {
        const pick = S.pick.scenario ?? t.activeScenario?.id ?? t.scenarios[0].id;
        out += `<div class="card"><div class="path">Scenario <span class="dim">${t.activeScenario ? `active: ${esc(t.activeScenario.name ?? t.activeScenario.id)}` : ''}</span></div><div class="tw"><select data-pick="scenario" aria-label="Scenario">${t.scenarios.map((item) => option(item.id, `${item.name ?? item.id}${item.catalogue ? ` · ${item.persona} → ${item.startPath ?? '/'}${item.context ? ' · isolated setup' : ''}` : ''}`, pick === item.id)).join('')}</select><button class="btn" data-act="ask" data-kind="scenario">Apply scenario</button></div></div>`;
      }
      if (t.presets.length) {
        const pick = S.pick.preset ?? t.presets[0].id;
        const chosen = t.presets.find((item) => item.id === pick);
        out += `<div class="card"><div class="path">Preset</div><div class="tw"><select data-pick="preset" aria-label="Preset">${t.presets.map((item) => option(item.id, item.name ?? item.id, pick === item.id)).join('')}</select><button class="btn" data-act="ask" data-kind="preset">Apply preset</button></div>${chosen?.description ? `<div class="dim">${esc(chosen.description)}</div>` : ''}</div>`;
      }
      const id = pageRecordId();
      out += `<div class="card"><div class="path">Open in _sim</div><div class="srcs"><button class="src" data-act="admin">Administration</button><button class="src" data-act="sim" data-hash="${esc(`audit?path=${encodeURIComponent(location.pathname)}`)}">Requests for this page</button><button class="src" data-act="sim" data-hash="activity?tab=findings">Diagnostics</button><button class="src" data-act="sim" data-hash="access">Personas &amp; permissions</button><button class="src" data-act="sim" data-hash="portal">Settings &amp; snippets</button></div>${t.tables.length ? `<div class="srcs"><span class="lbl2">Records${id ? ` (id ${esc(id)})` : ''}</span>${t.tables.map((table) => `<button class="src" data-act="sim" data-hash="${esc(recordsHash(table))}">${esc(table)}</button>`).join('')}</div>` : ''}<div class="srcs"><button class="src" data-act="copypage">Copy local URL</button><span class="dim">${esc(location.href)}</span></div></div>`;
      const s = t.status ?? {};
      // Loopback confinement of local pages (an opt-in Content-Security-Policy) and its exceptions.
      const policy =
        typeof s.confinePortalPages !== 'boolean'
          ? null
          : s.confinePortalPages
            ? `Confined to loopback · external assets ${s.externalAssets ? 'allowed' : 'blocked'} · ${s.externalFrameOrigins ? `${s.externalFrameOrigins} online embed origin${s.externalFrameOrigins === 1 ? '' : 's'} allowed` : 'no online embedded content'}`
            : 'Not confined: pages carry only the headers their site settings define';
      out += `<div class="card"><div class="path">Mirage status</div><div class="srcs"><span class="lbl2">Source</span><span class="dim">${esc(s.sourceFingerprint ?? 'unknown')}</span></div><div class="srcs"><span class="lbl2">Revision</span><span class="dim">${esc(s.revision ?? '?')}${s.reloading ? ' · reloading sources' : ''}${s.pendingReload ? ' · another reload queued' : ''}</span><span class="lbl2">Diagnostics</span><span class="dim">${esc(s.diagnostics?.total ?? s.diagnostics ?? 0)}</span></div>${policy ? `<div class="srcs"><span class="lbl2">Content policy</span><span class="dim" data-policy="${s.confinePortalPages ? 'confined' : 'open'}">${esc(policy)} · ${esc(s.contentPolicySource ?? 'runtime state')}</span><button class="src" data-act="sim" data-hash="connection">Change in _sim</button></div>` : ''}</div>`;
      return out;
    };

    const issueRow = (p) => {
      const kind =
        p.type === 'http' || p.type === 'failed'
          ? ['NET', 'k-err']
          : p.type === 'deploy'
            ? ['SRC', 'k-warn']
            : p.type === 'note'
              ? ['SKIP', 'k-warn']
              : p.type === 'warning'
                ? ['WARN', 'k-warn']
                : ['ERR', 'k-err'];
      const where = p.rel ? `${p.rel}${p.line ? ':' + p.line : ''}` : (p.where ?? '');
      const main = `<div class="name"><span>${hl(p.text)}</span>${p.status ? `<span class="c st">${p.status}</span>` : ''}${p.rel && p.type !== 'deploy' && p.type !== 'note' ? '<span class="c local" title="comes from a local file">local</span>' : ''}${p.count > 1 ? `<span class="c same">&times;${p.count}</span>` : ''}</div><div class="sub">${hl(where)}</div>`;
      return `<div class="row wrapt" data-rel="${esc(p.rel ?? '')}" data-line="${p.line ?? ''}" data-col="${p.col ?? ''}" data-text="${esc(p.text)}">
        <span class="ico ${kind[1]}">${kind[0]}</span>
        ${p.rel ? `<button class="main" data-act="open" title="Open in the editor${p.line ? ' at line ' + p.line : ''}">${main}</button>` : `<div class="main">${main}</div>`}
        ${p.at ? `<span class="time">${clock(p.at)}</span>` : ''}
        <div class="acts"><button class="ib" data-act="copytext" title="Copy the message">${icon('copy')}</button></div>
      </div>`;
    };
    const issuesHtml = () => {
      const d = S.d;
      const keep = (p) => (!S.ui.localOnly || p.rel) && matches(p.text, p.rel ?? '', p.where ?? '');
      const deploy = d.needsDeploy.map((n) => ({ type: 'deploy', text: n.reason, rel: n.rel })).filter(keep);
      const notes = d.notes.map((n) => ({ type: 'note', text: n.reason, rel: n.rel })).filter(keep);
      const errors = d.problems.filter((p) => p.type === 'error' || p.type === 'console').filter(keep);
      const net = d.problems.filter((p) => p.type === 'http' || p.type === 'failed').filter(keep);
      const warnings = d.problems.filter((p) => p.type === 'warning').filter(keep);
      const lists =
        group('deploy', 'Source and deployment limitations', deploy.map(issueRow)) +
        group('notes', 'Changes not applied on this page', notes.map(issueRow)) +
        group('errors', 'JavaScript errors', errors.map(issueRow)) +
        group('warnings', 'Console warnings', warnings.map(issueRow)) +
        group('net', 'Failed requests', net.map(issueRow));
      return (
        lists ||
        emptyState(
          S.q || S.ui.localOnly ? 'Nothing matches' : 'No issues on this page',
          S.q || S.ui.localOnly
            ? 'Clear the filter to see everything.'
            : 'JavaScript errors, failed requests and source or deployment limitations show up here.',
        )
      );
    };

    const activityHtml = () => {
      const rows = S.d.activity
        .filter((a) => matches(a.text, (a.files ?? []).join(' ')))
        .map((a) => {
          const kind =
            a.type === 'fault'
              ? ['ERR', 'k-err']
              : a.type === 'dialog'
                ? ['DIALOG', 'k-warn']
                : a.type === 'deploy'
                  ? ['DEPL', 'k-warn']
                  : a.type === 'switch'
                    ? ['SET', '']
                    : a.how === 'css'
                      ? ['CSS', '']
                      : ['SAVE', ''];
          return `<div class="row wrapt"><span class="ico ${kind[1]}">${kind[0]}</span><div class="main"><div class="name"><span>${hl(a.text)}</span></div>${a.files?.length ? `<div class="sub">${hl(a.files.join(', '))}</div>` : ''}</div><span class="time">${clock(a.at)}</span></div>`;
        });
      return (
        rows.join('') ||
        emptyState('Nothing happened yet', 'Saves, reloads and switches of this session are listed here.')
      );
    };

    const exploreHtml = () => {
      if (S.catalogLoading !== null)
        return loadingState('Reading the source catalogue…', 'Finding pages, files, templates and snippets.');
      if (S.catalogError)
        return (
          emptyState('Source catalogue unavailable', esc(S.catalogError)) +
          '<button class="btn" data-act="catalog-retry">Retry</button>'
        );
      if (!S.catalog) return loadingState('Reading the source catalogue…', '');
      const q = S.q.trim().toLowerCase();
      // an address or name that is exactly what was typed comes first, then the ones starting with it
      const rank = (c) => {
        const names = [c.url ?? '', (c.url ?? '').replace(/^\/|\/$/g, ''), c.title ?? ''].map((s) => s.toLowerCase());
        return names.includes(q) ? 0 : names.some((n) => n.startsWith(q)) ? 1 : 2;
      };
      const found = S.catalog.filter((c) => matches(c.title ?? '', c.url ?? '', c.rel ?? ''));
      if (q) found.sort((a, b) => rank(a) - rank(b));
      const rows = found.slice(0, 150).map((c) => {
        const [code, cls, what] = c.t === 'page' ? KIND.page : fileIcon(c);
        const sub = [c.url, c.rel].filter(Boolean).join('  ←  ');
        return `<div class="row" data-rel="${esc(c.rel ?? '')}" data-path="${esc(c.path ?? '')}" data-url="${esc(c.url ?? '')}">
          <span class="ico ${cls}" title="${esc(what)}">${code}</span>
          <button class="main" data-act="${c.t === 'page' ? 'go' : 'open'}" title="${c.t === 'page' ? 'Open this page' : 'Open in the editor'}">
            <div class="name"><span>${hl(c.title || shortName(c.rel))}</span>${c.t !== 'page' && KIND[c.kind] ? `<span class="what">${esc(what)}</span>` : ''}</div><div class="sub">${hl(sub)}</div>
          </button>
          <div class="acts">
            ${c.t !== 'page' && c.url ? `<button class="ib" data-act="go" title="Open ${esc(c.url)}">${icon('go')}</button>` : ''}
            ${c.rel ? `<button class="ib" data-act="open" title="Open in the editor">${icon('code')}</button>` : ''}
            <button class="ib" data-act="${c.rel ? 'copy' : 'copyurl'}" title="Copy the ${c.rel ? 'file path' : 'address'}">${icon('copy')}</button>
          </div>
        </div>`;
      });
      const head = `<div class="filters"><span class="lbl2">${found.length} of ${S.catalog.length} pages and sources${found.length > 150 ? ', first 150 shown' : ''}</span></div>`;
      return (
        head +
        (rows.join('') || emptyState('Nothing found', 'Try part of a page address, a file name or a template name.'))
      );
    };

    const diffHtml = () => {
      const f = S.diff;
      if (f.loading)
        return (
          `<div class="dhead"><button class="ib" data-act="closediff" title="Back">${icon('back')}</button><span class="t">${esc(baseName(f.rel))}</span></div>` +
          loadingState('Comparing sources…', 'You can go back while the comparison runs.')
        );
      const head = `<div class="dhead"><button class="ib" data-act="closediff" title="Back (Esc)">${icon('back')}</button><span class="t" title="${esc(f.rel)}">${esc(baseName(f.rel))}</span>
        <span class="lbl2">local vs ${esc(f.against ?? '')}</span><span class="grow"></span>${f.ok ? `<b class="plus">+${f.added}</b> <b class="minus">&minus;${f.removed}</b>` : ''}
        <button class="ib" data-act="open" data-rel="${esc(f.rel)}" title="Open in the editor">${icon('code')}</button></div>`;
      if (!f.ok) return head + emptyState('Cannot compare', esc(f.error ?? ''));
      if (!f.lines.length)
        return (
          head +
          (f.rawEqual === false
            ? emptyState(
                'No line difference',
                'Raw bytes differ, including BOM or newline formatting. The line comparison normalizes that formatting.',
              )
            : emptyState('No difference', `The local file has the same content as ${esc(f.against)}.`))
        );
      const lines = f.lines
        .map(([t, a, b, s]) =>
          t === '@'
            ? `<div class="dl g"><span>${esc(s)}</span></div>`
            : `<div class="dl ${t === '+' ? 'a' : t === '-' ? 'r' : ''}"${t !== '-' && b ? ` data-act="open" data-rel="${esc(f.rel)}" data-line="${b}"` : ''}><i>${a ?? ''}</i><i>${b ?? ''}</i><span>${t}${esc(s)}</span></div>`,
        )
        .join('');
      return (
        head +
        `<div class="difft">${lines}</div>${f.truncated ? '<div class="empty">The comparison is long; only its beginning is shown.</div>' : ''}`
      );
    };

    // ---- render
    const set = (key, node, html) => {
      if (S.html[key] === html) return false;
      S.html[key] = html;
      const active = root.activeElement;
      const identity = (item) => {
        const row = item.closest('[data-rel],[data-panel-persona-row],[data-group]');
        return row ? JSON.stringify({ ...row.dataset }) : '';
      };
      const focused =
        active && node.contains(active)
          ? { tag: active.tagName, data: { ...active.dataset }, id: active.id, row: identity(active) }
          : null;
      node.innerHTML = html;
      if (focused) {
        const replacement = [...node.querySelectorAll('button,input,select,summary,a,[tabindex]')].find(
          (item) =>
            item.tagName === focused.tag &&
            item.id === focused.id &&
            identity(item) === focused.row &&
            Object.entries(focused.data).every(([key, value]) => item.dataset[key] === value),
        );
        (replacement ?? el.tabs.querySelector('[aria-selected=true]'))?.focus({ preventScroll: true });
      }
      return true;
    };
    const render = () => {
      if (lifetime.signal.aborted) return;
      const d = S.d;
      if (!d) return;
      const ui = S.ui;
      const errs = d.problems.filter((p) => p.type === 'error' || p.type === 'console').length;
      const warns = d.needsDeploy.length + d.notes.length + d.problems.filter((p) => p.type === 'warning').length;
      const net = d.problems.filter((p) => p.type === 'http' || p.type === 'failed').length;
      wrap.className = `wrap${ui.open ? ' open' : ''}${ui.hidden ? ' hidden' : ''}${ui.large ? ' large' : ''}${d.caution ? ' caution' : ''}`;
      host.dataset.mode = d.online ? 'online' : 'local';
      host.dataset.overrides = String(d.items.length);
      host.dataset.issues = String(warns + errs + net);
      host.dataset.label = `${d.site} @ ${d.env}`;
      place();
      const dot = `<span class="dot${d.online ? ' off' : d.mirageMode || d.live ? '' : ' paused'}" title="${d.mirageMode ? 'Mirage renders local source and manages reloads' : d.online ? 'overrides are off' : d.live ? 'live reload is on' : 'live reload is off'}"></span>`;
      const real = d.caution ? '<span class="real" title="this environment holds real data">REAL DATA</span>' : '';
      // which checkout state the overlay serves: branch, HEAD commit and the comparison baseline
      const git = d.git ?? {};
      const gitLabel = git.branch ?? (git.commit ? git.commit.slice(0, 7) : null);
      const baselineText = git.baseline?.available
        ? `baseline ${git.baseline.requested}${git.baseline.pinned ? ` pinned at ${(git.baseline.commit ?? '').slice(0, 7)}` : ''}`
        : 'no Git baseline';
      const gitTitle = gitLabel
        ? `${git.detached ? 'detached HEAD' : `branch ${git.branch}`} @ ${(git.commit ?? '').slice(0, 7)} · ${baselineText}${git.headMoved ? ' · HEAD differs from the comparison baseline' : ''}`
        : baselineText;
      const branch = gitLabel
        ? `<span class="branch${git.headMoved && git.baseline?.pinned ? ' moved' : ''}" title="${esc(gitTitle)}">⎇ ${esc(gitLabel)}${git.headMoved && git.baseline?.pinned ? ' ≠ baseline' : ''}</span>`
        : '';
      set(
        'pill',
        el.pill,
        `${dot}<b>${d.online ? 'ONLINE' : 'LOCAL'}</b><span class="lbl">${esc(d.site)} @ ${esc(d.env)}</span>${real}${branch}
         ${d.online || d.mirageMode ? '' : `<span class="n ok" title="${d.items.length} overrides on this page">${d.items.length}</span>`}
         ${warns ? `<span class="n warn" title="${d.mirageMode ? 'source notes or runtime issues' : `${warns} source notes, deployment limitations or console warnings`}">${warns}</span>` : ''}
         ${errs + net ? `<span class="n err" title="${errs} JavaScript ${errs === 1 ? 'error' : 'errors'}, ${net} failed ${net === 1 ? 'request' : 'requests'}">${errs + net}</span>` : ''}
         ${d.pending.length || d.pendingBaseline ? `<span class="n warn" title="${d.mirageMode ? 'source changes are being applied by Mirage' : 'sources or baseline changed since this page loaded'}">${icon('reload')}</span>` : ''}`,
      );
      // a save that just arrived: say so even while the panel is closed or hidden
      if (d.lastChange && d.lastChange.at !== S.flashed) {
        const fresh = d.now - d.lastChange.at < 8000;
        S.flashed = d.lastChange.at;
        try {
          sessionStorage.setItem('paqvilo:last-change:' + d.token, String(S.flashed));
        } catch {
          /* optional toast deduplication */
        }
        if (fresh && !d.online && d.lastChange.how !== 'skipped') {
          const names =
            d.lastChange.files.slice(0, 2).map(baseName).join(', ') +
              (d.lastChange.files.length > 2 ? ` +${d.lastChange.files.length - 2}` : '') ||
            (d.lastChange.baselineChanged ? 'Git baseline updated' : '');
          float(
            `${d.lastChange.how === 'css' ? 'Styles swapped' : d.lastChange.how === 'reload' ? 'Reloaded' : 'Saved'} &middot; ${esc(names)}`,
          );
        }
      }
      const xray = document.getElementById('paqvilo-xray')?.__px;
      const currentInspection = d.inspection ?? d.mirage;
      const inspected =
        currentInspection?.active && S.inspect && S.inspect.version >= currentInspection.version ? S.inspect : null;
      xray?.update(
        {
          ...d,
          ui,
          inspectionLoading: S.inspectLoading !== null || inspectionPending(currentInspection),
          inspectionError: inspected?.error,
        },
        inspected?.report ?? null,
      );
      if (xray?.enabled) ensureInspect();
      if (!ui.open) {
        place();
        return;
      }
      const selectionMarkup = S.selectedElement
        ? `<details class="selection-summary" data-selected-identity data-disclosure="selected-summary" open><summary data-focus-key="selected-summary">Selected: ${esc(S.selectedIdentity?.title ?? S.selectedElement.tag ?? 'element')}<br>${renderInspectionEvidence(S.selectedIdentity?.evidence, { part: 'headline', context: 'panel' })}</summary><button class="selection-clear" data-act="selection-clear" data-focus-key="selection-clear">Clear selection</button><div class="selection-evidence-body">${renderInspectionEvidence(S.selectedIdentity?.evidence, { context: 'panel' })}</div></details>`
        : S.selectionReason === 'anchor-detached'
          ? '<div class="selection-summary" role="status">Element removed; select the replacement again.</div>'
          : '';
      const disclosures = [...selectionHost.querySelectorAll('details[data-disclosure]')].map((item) => [
        item.dataset.disclosure,
        item.open,
      ]);
      const selectionScroll = selectionHost.querySelector('.selection-evidence-body')?.scrollTop ?? 0;
      if (set('selection', selectionHost, selectionMarkup)) {
        for (const [key, open] of disclosures) {
          const item = [...selectionHost.querySelectorAll('[data-disclosure]')].find(
            (node) => node.dataset.disclosure === key,
          );
          if (item) item.open = open;
        }
        const body = selectionHost.querySelector('.selection-evidence-body');
        if (body) body.scrollTop = selectionScroll;
      }
      set(
        'head',
        el.head,
        `${dot}<span class="brand">paqvilo</span><span class="tag">${esc(d.site)}</span><span class="tag env">${esc(d.env)}</span>${real}<span class="grow"></span>
         ${d.mirageMode ? '' : `<span class="seg" title="Compare with the site as it is online (${d.keys.mode})"><button class="${d.online ? '' : 'on live'}" data-act="mode" data-v="local">Local</button><button class="${d.online ? 'on online' : ''}" data-act="mode" data-v="online">Online</button></span><button class="ib ${d.live ? 'on' : 'warn'}" data-act="live" title="Live reload is ${d.live ? 'on: saving a file reloads the page' : 'off: reload the page yourself'}">${icon(d.live ? 'bolt' : 'pause')}</button>`}
         <button class="ib" data-act="xray" title="Lense X-ray (Alt+Shift+X)" aria-label="Toggle Lense X-ray" aria-pressed="${Boolean(document.getElementById('paqvilo-xray')?.__px?.enabled)}">◎</button><button class="ib" data-act="reload" title="Reload this page">${icon('reload')}</button>
         ${d.setupUrl ? `<a class="ib" href="${esc(d.setupUrl)}" target="_blank" rel="noopener noreferrer" title="Project setup" aria-label="Project setup">${icon('setup')}</a>` : ''}
         ${d.mirageMode ? `<a class="ib" href="/_sim/" target="_blank" rel="noopener noreferrer" title="Manage data and personas" aria-label="Manage data and personas">${icon('sim')}</a>` : ''}
         <button class="ib" data-act="size" title="${ui.large ? 'Smaller panel' : 'Larger panel'}">${icon('size')}</button>
         <button class="ib" data-act="hide" title="Hide everything (${d.keys.hide})">${icon('hide')}</button>
         <button class="ib" data-act="close" title="Collapse (${d.keys.panel} or Esc)">${icon('down')}</button>`,
      );
      const inspection = d.inspection ?? d.mirage;
      const tabCount = {
        overrides: `<span class="n ${d.items.length ? 'ok' : 'dimn'}">${d.items.length}</span>`,
        runtime: '',
        tweaks: '',
        issues: warns + errs + net ? `<span class="n ${errs + net ? 'err' : 'warn'}">${warns + errs + net}</span>` : '',
        activity: '',
        explore: '',
      };
      const targetGroups = [
        [
          'Local runtimes',
          (t) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(t.origin) && !t.caution,
        ],
        ['Remote', (t) => !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(t.origin) && !t.caution],
        ['Caution · REAL DATA', (t) => t.caution],
      ]
        .map(([name, keep]) => {
          const options = S.targets
            .map((target, index) =>
              keep(target)
                ? `<option value="${index}" ${target.origin === location.origin ? 'selected' : ''}>${esc(target.siteName)} @ ${esc(target.envName)}</option>`
                : '',
            )
            .join('');
          return options ? `<optgroup label="${name}">${options}</optgroup>` : '';
        })
        .join('');
      const pendingTarget = S.pendingTarget;
      set(
        'targets',
        el.targets,
        `<label for="paqvilo-target">Portal / environment</label><select id="paqvilo-target" ${S.targets.length < 2 ? 'disabled' : ''}>${targetGroups}</select><button data-target-go class="btn" aria-busy="${Boolean(S.targetSwitching)}" ${S.targetSwitching ? 'disabled' : ''}>${S.targetSwitching ? 'Opening…' : 'Go'}</button>${pendingTarget ? `<div class="target-confirm" role="alertdialog" aria-labelledby="paqvilo-target-title"><p id="paqvilo-target-title">Open ${esc(pendingTarget.siteName)} @ ${esc(pendingTarget.envName)}${pendingTarget.caution ? ' (REAL DATA)' : ''}? Browser actions can change live data.</p><button class="btn" data-target-cancel>Cancel</button> <button class="btn" data-target-confirm>Confirm</button></div>` : ''}`,
      );
      set(
        'git',
        el.git,
        d.mirageMode
          ? ''
          : `<span class="branch${git.headMoved && git.baseline?.pinned ? ' moved' : ''}" title="${esc(gitTitle)}">${gitLabel ? `⎇ ${esc(gitLabel)} <span class="commit">@ ${esc((git.commit ?? '').slice(0, 7))}</span>` : 'Git HEAD unavailable'}</span><span class="commit" title="${esc(baselineText)}">${git.baseline?.available ? `baseline ${esc((git.baseline.commit ?? '').slice(0, 7))}` : 'baseline unavailable'}</span>`,
      );
      el.targets.hidden = d.capabilities?.targets === false;
      el.git.hidden = d.capabilities?.git === false;
      set(
        'tabs',
        el.tabs,
        TABS.filter(
          ([id]) =>
            (id !== 'actions' || d.capabilities?.actions === true) && (!MIRAGE_TABS.includes(id) || d.mirageMode),
        )
          .map(
            ([id, label]) =>
              `<button class="tab${ui.tab === id ? ' on' : ''}" data-act="tab" data-v="${id}" id="paqvilo-tab-${id}" role="tab" aria-selected="${ui.tab === id}" aria-controls="paqvilo-tab-content" tabindex="${ui.tab === id ? 0 : -1}">${label}${tabCount[id] ?? ''}</button>`,
          )
          .join(''),
      );
      el.body.setAttribute('aria-labelledby', 'paqvilo-tab-' + ui.tab);
      el.input.placeholder = PLACEHOLDER[ui.tab] ?? '';
      el.input.setAttribute('aria-label', el.input.placeholder || 'Search');
      el.input.closest('.search').hidden = ['tweaks', 'actions'].includes(ui.tab);
      set(
        'toolbtns',
        el.toolbtns,
        ui.tab === 'issues'
          ? `<button class="f${ui.localOnly ? ' on' : ''}" data-act="localonly" title="Only what comes from local files">local files only</button> <button class="ib" data-act="clear" data-v="problems" title="Clear the list">${icon('clear')}</button>`
          : ui.tab === 'activity'
            ? `<button class="ib" data-act="clear" data-v="activity" title="Clear the list">${icon('clear')}</button>`
            : '',
      );
      if (ui.tab === 'runtime') ensureInspect();
      if (ui.tab === 'tweaks') ensureTweaks();
      const body = S.diff
        ? diffHtml()
        : ui.tab === 'actions' && d.capabilities?.actions
          ? '<div data-panel-actions-host></div>'
          : ui.tab === 'runtime'
            ? runtimeHtml()
            : ui.tab === 'tweaks'
              ? tweaksHtml()
              : ui.tab === 'issues'
                ? issuesHtml()
                : ui.tab === 'activity'
                  ? activityHtml()
                  : ui.tab === 'explore'
                    ? exploreHtml()
                    : overridesHtml();
      const top = el.body.scrollTop;
      if (set('body', el.body, body)) el.body.scrollTop = S.keepScroll === false ? 0 : top;
      host.dispatchEvent(new CustomEvent('paqvilo-panel-render', { detail: { token: d.token, tab: ui.tab } }));
      el.body.setAttribute(
        'aria-busy',
        String(
          Boolean(
            S.diff?.loading ||
            (ui.tab === 'runtime' && (S.inspectLoading !== null || inspectionPending(inspection))) ||
            (ui.tab === 'tweaks' && S.tweaksLoading !== null) ||
            (ui.tab === 'explore' && S.catalogLoading !== null),
          ),
        ),
      );
      pendingFeedback();
      S.keepScroll = true;
      set(
        'foot',
        el.foot,
        `<span title="${d.keys.hide} hides or shows paqvilo, ${d.keys.panel} opens or closes this panel${d.mirageMode ? '' : `, ${d.keys.mode} switches between local and online`}">Alt+Shift+ <kbd>${d.keyCodes.hide.slice(-1)}</kbd> hide &nbsp;<kbd>${d.keyCodes.panel.slice(-1)}</kbd> panel${d.mirageMode ? '' : ` &nbsp;<kbd>${d.keyCodes.mode.slice(-1)}</kbd> online`} &nbsp;<kbd>X</kbd> X-ray &nbsp;<kbd>Esc</kbd> close &nbsp;<kbd>/</kbd> search</span><span class="grow"></span><span class="stats" title="${d.mirageMode ? 'Mirage renders source and owns source reloads' : 'what the local sources hold: web files, custom scripts and styles, changed templates and snippets'}">${d.mirageMode ? 'Mirage runtime' : `${d.stats.webFiles} ${d.modelDriven ? 'web resources' : `files &middot; ${d.stats.blocks} scripts &middot; ${d.stats.patches} patches`}`}</span>`,
      );
    };

    // ---- actions
    const copy = async (text, what) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${what} copied`);
      } catch {
        toast('The browser did not allow copying', true);
      }
    };
    const fresh = () => {
      S.keepScroll = false;
      render();
    };
    let previousFocus;
    const setOpen = (open) => {
      if (open) document.getElementById('paqvilo-xray')?.__px?.toggle(false);
      if (open && !S.ui.open) previousFocus = root.activeElement ?? document.activeElement;
      S.ui.open = open;
      if (open) S.ui.hidden = false;
      if (open && S.ui.tab === 'explore' && !S.catalog) loadCatalog();
      saveUi();
      render();
      if (open) el.tabs.querySelector('[aria-selected=true]')?.focus();
      else (previousFocus?.isConnected ? previousFocus : el.pill).focus();
    };
    const setHidden = (hidden) => {
      S.ui.hidden = hidden;
      saveUi();
      render();
      if (hidden) float(`paqvilo is hidden &middot; <kbd>${S.d.keys.hide}</kbd> brings it back`, 3200);
    };
    const reloadPage = () => {
      // reload() may repeat the POST that produced a form result. Navigating explicitly uses GET.
      const url = new URL(location.href);
      // A same-URL navigation with a fragment is only a scroll; vary the query to fetch a document.
      if (url.href.includes('#'))
        url.searchParams.set('paqvilo', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      location.assign(url.href);
    };
    /** A Mirage change reloads open pages through its own event; reload here only if that never comes. */
    const reloadAfterTweak = (text) => {
      toast(text);
      const timer = setTimeout(reloadPage, 2000);
      window.addEventListener('pagehide', () => clearTimeout(timer), { once: true, signal: lifetime.signal });
    };
    const setMode = async (online) => {
      if (S.d.mirageMode) return;
      if (online === S.d.online) return;
      const r = await api('mode', { online });
      if (r.ok) reloadPage();
      else toast(r.error ?? 'failed', true);
    };
    /** The Inspect report is requested once per runtime version, outside of every redraw. */
    const inspectionScope = () => document.getElementById('paqvilo-xray')?.__px?.getSelectionScope?.() ?? null;
    const sameInspectionScope = (a, b) =>
      (!a && !b) ||
      (a && b && ['documentId', 'frameId', 'uiEpoch', 'sourceRevision'].every((key) => a[key] === b[key]));
    const acceptInspection = (request, version, answer, scope) => {
      if (lifetime.signal.aborted || S.inspectRequest !== request) return false;
      S.inspectLoading = null;
      if (
        !sameInspectionScope(scope, inspectionScope()) ||
        (answer.scope && !sameInspectionScope(scope, answer.scope))
      ) {
        render();
        return false;
      }
      if (Number.isSafeInteger(answer.loadingId))
        S.completedInspectionLoadingId = Math.max(S.completedInspectionLoadingId, answer.loadingId);
      const current = S.d?.inspection ?? S.d?.mirage,
        resultVersion = Math.max(version, answer.version ?? 0);
      if (!current?.active || current.version > resultVersion) {
        render();
        return false;
      }
      S.inspect = answer.ok
        ? { version: resultVersion, report: answer.report, status: answer.status, error: answer.error, scope }
        : { version, report: null, error: answer.error ?? 'inspection failed', scope };
      render();
      return true;
    };
    const ensureInspect = () => {
      const c = S.d?.inspection ?? S.d?.mirage;
      if (S.inspect && !sameInspectionScope(S.inspect.scope ?? null, inspectionScope())) S.inspect = null;
      if (
        !c?.active ||
        c.loading ||
        !c.version ||
        (S.inspect && S.inspect.version >= c.version) ||
        S.inspectLoading === c.version
      )
        return;
      const version = c.version;
      const request = ++S.inspectRequest;
      const scope = inspectionScope();
      S.inspectLoading = version;
      api('inspect', { scope }).then((r) => {
        acceptInspection(request, version, r, scope);
      });
    };
    const ensureTweaks = () => {
      const c = S.d?.mirage;
      if (!c?.active || !c.version || (S.tweaks && S.tweaks.version >= c.version) || S.tweaksLoading === c.version)
        return;
      const version = c.version;
      S.tweaksLoading = version;
      api('tweaks').then((r) => {
        if (lifetime.signal.aborted || S.tweaksLoading !== version) return;
        S.tweaksLoading = null;
        S.tweaks = {
          ...r,
          version,
          personas: r.personas ?? [],
          presets: r.presets ?? [],
          scenarios: r.scenarios ?? [],
          tables: r.tables ?? [],
        };
        render();
      });
    };
    const loadCatalog = async () => {
      const version = S.d.catalogVersion;
      if (S.catalogLoading === version) return;
      S.catalogLoading = version;
      S.catalogError = null;
      const r = await api('catalog');
      if (lifetime.signal.aborted || S.catalogLoading !== version) return;
      S.catalogLoading = null;
      if (S.d.catalogVersion !== version) {
        if (S.ui.open && S.ui.tab === 'explore') void loadCatalog();
        return;
      }
      S.catalog = r.ok ? r.entries : null;
      S.catalogError = r.ok ? null : (r.error ?? 'No source catalogue was returned.');
      render();
    };
    const stopPicking = () => {
      if (S.pickHandler) document.removeEventListener('click', S.pickHandler, true);
      if (S.pickEscape) document.removeEventListener('keydown', S.pickEscape, true);
      S.pickHandler = null;
      S.pickEscape = null;
      S.pickingElement = false;
    };
    const locateElement = (field) => {
      const nodes = [...document.querySelectorAll('input,select,textarea,[id],[name]')];
      const node = nodes.find(
        (item) => !item.closest('#paqvilo-panel') && (item.id === field || item.getAttribute('name') === field),
      );
      if (!node) return toast('This field is not present in the rendered page.', true);
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const prior = { outline: node.style.outline, offset: node.style.outlineOffset };
      node.style.outline = '3px solid #c38a2e';
      node.style.outlineOffset = '4px';
      setTimeout(() => {
        node.style.outline = prior.outline;
        node.style.outlineOffset = prior.offset;
      }, 2500);
    };
    const performAction = async (name, t) => {
      const row = t.closest('[data-rel]');
      const rel = t.dataset.rel || row?.dataset.rel || '';
      const url = row?.dataset.url || '';
      const d = S.d;
      switch (name) {
        case 'selection-clear':
          document.getElementById('paqvilo-xray')?.__px?.clearSelection?.('user-clear');
          S.selectedElement = null;
          S.selectedIdentity = null;
          render();
          break;
        case 'xray':
          stopPicking();
          document.getElementById('paqvilo-xray')?.__px?.toggle();
          S.ui.open = false;
          render();
          break;
        case 'choosepersona': {
          if (t.dataset.contact && !S.tweaks?.personas?.some((p) => p.contactId === t.dataset.contact)) break;
          S.pick.persona = t.dataset.contact;
          S.pick.personaKey = t.dataset.key;
          render();
          break;
        }
        case 'pinpersona': {
          const value = personaPreferences();
          value.pinned = value.pinned.includes(t.dataset.key)
            ? value.pinned.filter((key) => key !== t.dataset.key)
            : [t.dataset.key, ...value.pinned].slice(0, 100);
          savePersonaPreferences(value);
          refreshPersonaRows();
          break;
        }
        case 'persona-group':
          S.personaFilters = { ...S.personaFilters, groups: [t.dataset.group], subgroups: [] };
          S.personaFilterDisclosureOpen = true;
          S.personaPage = 0;
          render();
          break;
        case 'persona-page':
          S.personaPage = Math.max(0, (S.personaPage ?? 0) + Number(t.dataset.direction) * 50);
          refreshPersonaRows();
          break;
        case 'persona-clear':
          S.personaFilters = { q: '', roles: [], tags: [], groups: [], subgroups: [] };
          S.personaFilterDisclosureOpen = false;
          S.personaPage = 0;
          render();
          break;

        case 'inspect-section':
          S.inspectSection = t.dataset.v;
          render();
          break;
        case 'inspect-fold':
          for (const key of Object.keys(S.defaults).filter((key) => key.startsWith('runtime-')))
            S.ui.collapsed[key] = t.dataset.v === 'closed';
          saveUi();
          render();
          break;
        case 'inspect-refresh': {
          if (S.inspectLoading !== null) break;
          const version = (S.d?.inspection ?? S.d?.mirage)?.version ?? 0,
            request = ++S.inspectRequest;
          const scope = inspectionScope();
          S.inspect = null;
          S.inspectLoading = version;
          render();
          const answer = await api('inspect', { refresh: true, scope });
          if (acceptInspection(request, version, answer, scope)) {
            if (!answer.ok) toast(answer.error ?? 'Inspection failed.', true);
            fresh();
          }
          break;
        }
        case 'catalog-retry':
          void loadCatalog();
          render();
          break;
        case 'tweaks-retry':
          S.tweaks = null;
          ensureTweaks();
          render();
          break;
        case 'inspect-locate':
          locateElement(t.dataset.field);
          break;
        case 'inspect-pick': {
          const xray = document.getElementById('paqvilo-xray')?.__px;
          if (xray) {
            stopPicking();
            S.ui.open = false;
            render();
            xray.pickOnce();
            break;
          }
          if (S.pickingElement) {
            stopPicking();
            render();
            break;
          }
          S.pickingElement = true;
          S.pickHandler = (event) => {
            const node = event.target instanceof Element ? event.target : event.target?.parentElement;
            if (!node || node.closest('#paqvilo-panel, #paqvilo-handle')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            S.selectedElement = {
              tag: node.tagName.toLowerCase(),
              id: node.id.slice(0, 160),
              name: (node.getAttribute('name') ?? '').slice(0, 160),
              classes: String(node.className ?? '').slice(0, 160),
            };
            stopPicking();
            render();
          };
          S.pickEscape = (event) => {
            if (event.key === 'Escape') {
              stopPicking();
              render();
            }
          };
          document.addEventListener('click', S.pickHandler, true);
          document.addEventListener('keydown', S.pickEscape, true);
          render();
          break;
        }
        case 'tab':
          stopPicking();
          S.ui.tab = t.dataset.v;
          S.diff = null;
          if (S.ui.tab === 'explore' && !S.catalog) loadCatalog();
          saveUi();
          fresh();
          break;
        case 'fold': {
          const id = t.dataset.id;
          S.ui.collapsed[id] = !(S.ui.collapsed[id] ?? S.defaults[id] ?? false);
          saveUi();
          render();
          break;
        }
        case 'more':
          S.more[t.dataset.id] = true;
          render();
          break;
        case 'sim':
          // Deep links into the Mirage administration open beside the page being inspected.
          window.open(`${location.origin}/_sim/#${t.dataset.hash}`, '_blank', 'noopener');
          break;
        case 'copypage':
          copy(location.href, 'Address');
          break;
        case 'persona': {
          const r = await api('persona', {
            contactId: (S.pick.persona ?? S.tweaks?.identity?.contactId ?? '') || null,
          });
          if (r.ok) reloadAfterTweak('Persona switched; reloading ...');
          else toast(r.error ?? 'Could not switch the persona', true);
          break;
        }
        case 'signin': {
          const personas = S.tweaks?.personas ?? [];
          const session = S.tweaks?.session ?? {};
          const contactId = [S.pick.persona, session.signedIn ? session.contactId : null, personas[0]?.contactId].find(
            (id) => id && personas.some((item) => item.contactId === id),
          );
          if (!contactId) break;
          const name = personas.find((item) => item.contactId === contactId)?.name ?? contactId;
          // The page posts the portal's sign-in form and navigates; it comes back signed in.
          const r = await api('signin', { contactId });
          if (r.ok) {
            const value = personaPreferences(),
              key = S.pick.personaKey ?? `@contact:${contactId}`;
            value.recent = [key, ...value.recent.filter((item) => item !== key)].slice(0, 5);
            savePersonaPreferences(value);
          }
          if (r.ok) toast(`Signing in as ${name} through ${r.via ?? 'the portal'} ...`);
          else toast(r.error ?? 'Could not sign in', true);
          break;
        }
        case 'signout': {
          const r = await api('signout', {});
          if (r.ok) toast(r.navigating ? 'Signing out through the portal ...' : 'This browser is not signed in.');
          else toast(r.error ?? 'Could not sign out', true);
          break;
        }
        case 'permissions': {
          if (S.tweaks?.permissionMode === t.dataset.v) break;
          const r = await api('permissions', { mode: t.dataset.v });
          if (r.ok)
            reloadAfterTweak(`Permissions ${t.dataset.v === 'enforce' ? 'enforced' : 'permissive'}; reloading ...`);
          else toast(r.error ?? 'Could not change permission enforcement', true);
          break;
        }
        case 'ask': {
          const kind = t.dataset.kind;
          const list = (kind === 'preset' ? S.tweaks?.presets : S.tweaks?.scenarios) ?? [];
          const id = S.pick[kind] ?? (kind === 'scenario' ? S.tweaks?.activeScenario?.id : null) ?? list[0]?.id;
          const item = list.find((entry) => entry.id === id);
          if (!item) break;
          S.confirm =
            kind === 'preset'
              ? {
                  kind,
                  id,
                  label: 'Apply preset',
                  text: `Apply preset "${item.name ?? id}"? It replaces the local records, roles and settings it defines; pages reload.`,
                }
              : {
                  kind,
                  id,
                  catalogue: item.catalogue === true,
                  ...(item.catalogueId ? { id: item.catalogueId } : {}),
                  label: 'Apply scenario',
                  text: item.catalogue
                    ? `Open "${item.name}" as ${item.persona} at ${item.startPath ?? '/'}? ${item.context || item.preset ? 'Its setup opens in an isolated local runtime.' : 'This browser signs in through the portal.'}`
                    : `Apply scenario "${item.name ?? id}"? Its preset, persona and permission mode change in one step; pages reload.`,
                };
          render();
          // The action can be below the fold. Reveal its confirmation and put keyboard focus
          // on the safe action, without applying anything until the user confirms.
          const cancel = el.body.querySelector('[data-act="confirm-no"]');
          cancel?.closest('[role="alertdialog"]')?.scrollIntoView({ block: 'start' });
          cancel?.focus({ preventScroll: true });
          break;
        }
        case 'confirm-no':
          S.confirm = null;
          render();
          break;
        case 'confirm-yes': {
          const pending = S.confirm;
          S.confirm = null;
          render();
          if (!pending) break;
          const r = await api(pending.kind, { id: pending.id, ...(pending.catalogue ? { catalogue: true } : {}) });
          // A scenario persona signs this browser in (or out) through the portal after the reload.
          if (r.ok && r.navigating)
            toast(
              `${pending.label.replace('Apply ', '')} applied; ${r.contactId ? 'signing in as its persona' : 'signing out'} after the reload ...`,
            );
          else if (r.ok) reloadAfterTweak(`${pending.label.replace('Apply ', '')} applied; reloading ...`);
          else toast(r.error ?? `Could not apply the ${pending.kind}`, true);
          break;
        }
        case 'filter':
          S.ui.filter = t.dataset.v;
          saveUi();
          render();
          break;
        case 'localonly':
          S.ui.localOnly = !S.ui.localOnly;
          saveUi();
          render();
          break;
        case 'size':
          S.ui.large = !S.ui.large;
          saveUi();
          render();
          break;
        case 'close':
          setOpen(false);
          break;
        case 'hide':
          setHidden(true);
          break;
        case 'reload':
          reloadPage();
          break;
        case 'go':
          if (url) location.href = url;
          break;
        case 'admin':
          window.open('/_sim/', '_blank', 'noopener');
          break;
        case 'copy':
          copy(
            t.dataset.copy ?? (row?.dataset.path || d.sourceDir.replace(/[\\/]$/, '') + '/' + rel.split('#')[0]),
            t.dataset.copyKind === 'reference' ? 'Source reference' : 'Path',
          );
          break;
        case 'copyurl':
          copy(location.origin + url, 'Address');
          break;
        case 'copytext':
          copy(row.dataset.text, 'Message');
          break;
        case 'open': {
          if (!rel) break;
          const line = Number(t.dataset.line || row?.dataset.line) || undefined;
          const feedbackSelection = document.getElementById('paqvilo-xray')?.__px?.feedbackState?.();
          const r = await api('open', {
            rel,
            line,
            col: Number(row?.dataset.col) || undefined,
            find: t.dataset.find || row?.dataset.find || undefined,
            ...(t.dataset.sourceKey
              ? {
                  sourceKey: t.dataset.sourceKey,
                  sourceRevision: t.dataset.sourceRevision,
                  contentRevision: t.dataset.contentRevision,
                  scope: t.evidenceScope ?? S.selectionScope,
                  anchorGeneration: t.anchorGeneration ?? S.selectionGeneration,
                  ...(t.dataset.sourceRegion ? { region: JSON.parse(t.dataset.sourceRegion) } : {}),
                }
              : {}),
          });
          document
            .getElementById('paqvilo-xray')
            ?.__px?.status(
              r.ok ? `Opened ${baseName(rel)} in the editor` : (r.error ?? 'Could not open the editor'),
              feedbackSelection,
            );
          if (r.ok) toast(`Opened ${baseName(rel)}${line ? ':' + line : ''} in the editor`);
          else if (r.url)
            location.href = r.url; // the editor's own link; the browser asks once
          else toast(r.error ?? 'Could not open the editor', true);
          break;
        }
        case 'toggle': {
          const r = await api('toggle', { rel, off: Boolean(t.dataset.off) });
          if (r.ok) reloadPage();
          else toast(r.error ?? 'failed', true);
          break;
        }
        case 'mode':
          if (!d.mirageMode) await setMode(t.dataset.v === 'online');
          break;
        case 'live': {
          const r = await api('live', { on: !d.live });
          if (r.ok) toast(`Live reload is ${d.live ? 'off' : 'on'}`);
          else toast(r.error ?? 'Could not update live reload', true);
          break;
        }
        case 'scope': {
          if (t.dataset.v === d.scope) break;
          const r = await api('scope', { scope: t.dataset.v });
          if (r.ok) reloadPage();
          else toast(r.error ?? 'failed', true);
          break;
        }
        case 'rebaseline': {
          const r = await api('rebaseline');
          if (r.ok) reloadPage();
          else toast(r.error ?? 'Could not pin the baseline', true);
          break;
        }
        case 'clear': {
          const r = await api('clear', { what: t.dataset.v });
          toast(r.ok ? 'List cleared' : (r.error ?? 'Could not clear the list'), !r.ok);
          break;
        }
        case 'diff': {
          const pending = (S.diff = { loading: true, rel });
          fresh();
          const r = await api('diff', { rel, url });
          if (S.diff === pending) S.diff = { ...r, rel };
          fresh();
          break;
        }
        case 'closediff':
          S.diff = null;
          fresh();
          break;
      }
    };
    const act = async (name, target) => {
      if (target.disabled) return;
      const label = actionLabels[name];
      if (!label) return performAction(name, target);
      if (
        S.pendingActions.has(name) ||
        (mutationActions.has(name) && [...S.pendingActions.values()].some((job) => mutationActions.has(job.name)))
      )
        return;
      S.pendingActions.set(name, { name, label });
      pendingFeedback();
      if (name === 'open') document.getElementById('paqvilo-xray')?.__px?.status(label);
      try {
        return await performAction(name, target);
      } catch (error) {
        if (!lifetime.signal.aborted) toast(error.message ?? 'The action could not finish.', true);
      } finally {
        S.pendingActions.delete(name);
        if (!lifetime.signal.aborted) pendingFeedback();
      }
    };

    el.panel.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act]');
      if (t) act(t.dataset.act, t);
    });
    el.panel.addEventListener(
      'toggle',
      (event) => {
        if (event.target.isConnected && event.target.matches('.pp-persona-filter-disclosure'))
          S.personaFilterDisclosureOpen = event.target.open;
      },
      true,
    );
    el.panel.addEventListener('input', (event) => {
      if (!event.target.matches('[data-panel-persona-query]')) return;
      S.personaFilters ??= { q: '', roles: [], tags: [], groups: [], subgroups: [] };
      S.personaFilters.q = event.target.value;
      S.personaPage = 0;
      refreshPersonaRows();
    });
    el.panel.addEventListener('change', (e) => {
      if (e.target.matches('[data-panel-persona-roles-only]')) {
        S.personaFilters ??= { q: '', roles: [], tags: [] };
        S.personaFilters.rolesOnly = e.target.checked;
        S.personaPage = 0;
        refreshPersonaRows();
        return;
      }
      if (e.target.matches('[data-panel-persona-facet]')) {
        S.personaFilters ??= { q: '', roles: [], tags: [], groups: [], subgroups: [] };
        S.personaFilters[e.target.dataset.panelPersonaFacet] = [...e.target.selectedOptions].map(
          (option) => option.value,
        );
        S.personaPage = 0;
        refreshPersonaRows();
        return;
      }
      const pick = e.target.closest?.('[data-pick]');
      if (!pick) return;
      S.pick[pick.dataset.pick] = pick.value;
      render();
    });
    el.pill.addEventListener('click', () => {
      if (Date.now() - S.dragged > 250) setOpen(true);
    });
    const resetTarget = () => {
      const select = el.targets.querySelector('select');
      if (select) select.value = String(S.targets.findIndex((target) => target.origin === location.origin));
    };
    const cancelTarget = () => {
      S.pendingTarget = null;
      resetTarget();
      render();
      el.targets.querySelector('[data-target-go]')?.focus();
    };
    const switchTarget = async (target) => {
      if (S.targetSwitching) return;
      S.pendingTarget = null;
      resetTarget();
      S.targetSwitching = true;
      render();
      try {
        if (!S.targets.some((item) => item.origin === target.origin && item.url === target.url))
          throw new Error('The selected target is no longer available');
        const result = await api('ui', S.ui);
        if (!result.ok) throw new Error(result.error ?? 'The dev loop did not save the current panel');
        location.assign(target.url);
      } catch (error) {
        toast(error.message, true);
      } finally {
        S.targetSwitching = false;
        resetTarget();
        render();
        el.targets.querySelector('[data-target-go]')?.focus();
      }
    };
    const goTarget = async () => {
      const value = el.targets.querySelector('select')?.value,
        target = /^\d+$/.test(value) ? S.targets[Number(value)] : null;
      if (!target || target.origin === location.origin) {
        cancelTarget();
        return;
      }
      if (
        target.caution ||
        (S.d.mirageMode && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(target.origin))
      ) {
        S.pendingTarget = target;
        resetTarget();
        render();
        el.targets.querySelector('[data-target-cancel]')?.focus();
        return;
      }
      await switchTarget(target);
    };
    el.targets.addEventListener('click', (event) => {
      if (event.target.closest('[data-target-cancel]')) cancelTarget();
      else if (event.target.closest('[data-target-confirm]') && S.pendingTarget) void switchTarget(S.pendingTarget);
      else if (event.target.closest('[data-target-go]')) void goTarget();
    });
    el.targets.addEventListener('change', () => {
      if (S.pendingTarget) {
        S.pendingTarget = null;
        render();
      }
    });
    el.targets.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('select')) {
        event.preventDefault();
        void goTarget();
      }
    });
    el.pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
    });
    el.input.addEventListener('input', () => {
      S.q = el.input.value;
      fresh();
    });
    // typing in the panel must not trigger shortcuts of the portal page
    for (const type of ['keydown', 'keyup', 'keypress']) {
      el.panel.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'keydown') return;
        if (e.target.matches('[role=tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          const tabs = [...el.tabs.querySelectorAll('[role=tab]')],
            at = tabs.indexOf(e.target),
            next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          e.preventDefault();
          void act('tab', tabs[next]);
          el.tabs.querySelector('[aria-selected=true]')?.focus();
          return;
        }
        if (e.key === 'Escape') {
          if (S.pendingTarget) {
            cancelTarget();
            return;
          }
          if (S.diff) S.diff = null;
          else if (S.q) S.q = el.input.value = '';
          else return setOpen(false);
          fresh();
        } else if (
          e.key === '/' &&
          S.ui.tab !== 'tweaks' &&
          !e.target.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])')
        ) {
          e.preventDefault();
          el.input.focus();
        }
      });
    }
    document.addEventListener(
      'paqvilo-xray',
      (event) => {
        const detail = event.detail ?? {};
        if (detail.action === 'open') {
          act('open', {
            evidenceScope: detail.scope,
            anchorGeneration: detail.anchorGeneration,
            dataset: {
              rel: detail.ref,
              line: detail.line,
              find: detail.find,
              sourceKey: detail.sourceKey,
              sourceRevision: detail.sourceRevision,
              contentRevision: detail.contentRevision,
              ...(detail.region ? { sourceRegion: JSON.stringify(detail.region) } : {}),
            },
            closest: () => null,
          });
        } else if (detail.action === 'refresh') {
          act('inspect-refresh', { dataset: {}, closest: () => null });
        } else if (['selected', 'updated', 'cleared', 'detached', 'stale'].includes(detail.action)) {
          const context = document.getElementById('paqvilo-xray')?.__px?.selectionState?.();
          if (!detail.scope || !Number.isSafeInteger(detail.selectionGeneration)) return;
          if (
            detail.identity?.evidence?.version === 1 &&
            !sameInspectionScope(detail.identity.evidence.scope, detail.scope)
          )
            return;
          const sameEpoch = !S.selectionScope || S.selectionScope.uiEpoch === detail.scope.uiEpoch;
          if (sameEpoch && detail.selectionGeneration < S.selectionGeneration) return;
          if (!sameEpoch && (detail.action !== 'selected' || detail.scope.uiEpoch < S.selectionScope.uiEpoch)) return;
          if (detail.identity && context?.scope && !sameInspectionScope(context.scope, detail.scope)) return;
          if (
            ['updated', 'stale'].includes(detail.action) &&
            S.selectionAnchor &&
            detail.anchorId !== S.selectionAnchor
          )
            return;
          S.selectionGeneration = detail.selectionGeneration;
          S.selectionScope = detail.scope;
          S.selectionAnchor = detail.identity ? detail.anchorId : null;
          S.selectionReason = detail.reason;
          S.selectedElement = detail.identity ? (detail.element ?? S.selectedElement) : null;
          S.selectedIdentity = detail.identity ?? null;
          if (detail.action === 'selected' && detail.oneShot) {
            S.ui.tab = 'runtime';
            setOpen(true);
          }
          render();
          if (detail.action === 'selected' && detail.oneShot)
            selectionHost.querySelector('[data-focus-key="selected-summary"]')?.focus({ preventScroll: true });
        } else if (detail.action === 'toggled') {
          if (detail.enabled) {
            S.ui.hidden = false;
            S.ui.open = false;
          }
          render();
        }
      },
      { signal: lifetime.signal },
    );
    const onKey = (e) => {
      if (!host.isConnected) return window.removeEventListener('keydown', onKey, true);
      if (
        S.ui.open &&
        S.ui.tab !== 'tweaks' &&
        e.key === '/' &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e
          .composedPath()
          .some((node) => node?.matches?.('input,textarea,select,[contenteditable]:not([contenteditable=false])'))
      ) {
        e.preventDefault();
        el.input.focus();
        return;
      }
      if (!S.d || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      // by key position, so it works on any keyboard layout
      if (e.code === S.d.keyCodes.hide) setHidden(!S.ui.hidden);
      else if (e.code === S.d.keyCodes.panel) setOpen(!S.ui.open || S.ui.hidden);
      else if (e.code === S.d.keyCodes.mode && !S.d.mirageMode)
        void act('mode', { dataset: { v: S.d.online ? 'local' : 'online' }, closest: () => null });
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, { capture: true, signal: lifetime.signal });

    return {
      get token() {
        return S.d?.token;
      },
      openTab(tab) {
        if (TABS.some(([id]) => id === tab) && (tab !== 'actions' || S.d?.capabilities?.actions)) {
          S.ui.tab = tab;
          setOpen(true);
          render();
        }
      },
      collapse() {
        setOpen(false);
      },
      dispose() {
        stopPicking();
        document.getElementById('paqvilo-xray')?.__px?.dispose();
        lifetime.abort();
        clearTimeout(toastTimer);
        clearTimeout(floatTimer);
        clearTimeout(saveTimer);
        clearTimeout(placeTimer);
        host.remove();
      },
      update(d) {
        if (lifetime.signal.aborted) return;
        const catalogChanged = S.d && S.d.catalogVersion !== d.catalogVersion;
        const previousInspection = S.d?.inspection ?? S.d?.mirage,
          nextInspection = d.inspection ?? d.mirage;
        if (catalogChanged || (previousInspection && previousInspection.version !== nextInspection?.version)) {
          S.inspectRequest++;
          S.inspectLoading = null;
        }
        S.d = d;
        if (MIRAGE_TABS.includes(S.ui.tab) && (!d.mirageMode || d.mirage?.active === false)) S.ui.tab = 'overrides';
        S.targets = (Array.isArray(d.targets) ? d.targets : []).flatMap((target) => {
          try {
            // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
            if (!target || typeof target.origin !== 'string' || /[\\\x00-\x20]/.test(target.origin)) return [];
            const origin = new URL(target.origin);
            const startPath = target.startPath ?? '/';
            if (
              !['http:', 'https:'].includes(origin.protocol) ||
              origin.username ||
              origin.password ||
              origin.pathname !== '/' ||
              origin.search ||
              origin.hash ||
              typeof startPath !== 'string' ||
              !startPath.startsWith('/') ||
              // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
              /[\\\x00-\x20]/.test(startPath)
            )
              return [];
            const url = new URL(startPath, origin);
            if (url.origin !== origin.origin || url.username || url.password) return [];
            return [
              {
                siteName: target.siteName,
                envName: target.envName,
                caution: Boolean(target.caution),
                origin: origin.origin,
                url: url.href,
              },
            ];
          } catch {
            return [];
          }
        });
        if (catalogChanged) {
          S.catalog = null;
          if (S.ui.open && S.ui.tab === 'explore') loadCatalog();
        }
        if (S.first) {
          // where it was left, in whatever tab or page that was
          const saved = d.ui ?? {};
          S.ui = {
            ...S.ui,
            ...saved,
            pos: { ...S.ui.pos, ...(saved.pos ?? {}) },
            collapsed: { ...S.ui.collapsed, ...(saved.collapsed ?? {}) },
          };
          if (S.ui.open && S.ui.tab === 'explore') loadCatalog();
        }
        if (S.ui.tab === 'actions' && !d.capabilities?.actions) S.ui.tab = 'overrides';
        render();
        S.first = false;
      },
    };
  }
}

// Fixed owned source keeps page.evaluate and panel.mjs composition self-contained.
export const panelUi = new Function(
  'data',
  `const renderInspectionEvidence=(${renderInspectionEvidence.toString()});return (${panelBrowserImpl.toString()})(data);`,
);

/** Evaluated in the page during detach; a queued old draw cannot recreate a stopped panel. */
export function removePanelUi({ token }) {
  const retired = Array.isArray(window.__paqviloRetiredSessions) ? window.__paqviloRetiredSessions : [];
  if (!retired.includes(token)) retired.push(token);
  if (retired.length > 32) retired.splice(0, retired.length - 32);
  window.__paqviloRetiredSessions = retired;
  const host = document.getElementById('paqvilo-panel');
  if (host?.__pp?.token === token) host.__pp.dispose();
  const xray = document.getElementById('paqvilo-xray');
  if (xray?.__px?.token === token) xray.__px.dispose();
}
