import { renderInspectionEvidence } from './inspection-evidence-ui.mjs';
import { lenseUiKit } from './ui-kit.mjs';

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
  if (globalThis.__paqviloRetiredSessions?.includes(data.token)) return;
  let host = document.getElementById(ID);
  if (!host) {
    if (!document.body) return;
    host = document.createElement('div');
    host.id = ID;
    document.body.appendChild(host);
  }
  if (!host.__pp) {
    // A panel whose host the page removed or replaced is not reachable through the document: release it before another
    // one is created. Its X-ray is the current one and stays.
    globalThis.__paqviloPanelUi?.release?.();
    host.__pp = globalThis.__paqviloPanelUi = create(host);
  }
  host.__pp.update(data);

  function create(host) {
    const lifetime = new AbortController();
    // The panel keeps its own look: nothing of the page's CSS reaches it. :host only resets the host's own box; page
    // rules that match the host element (div, #paqvilo-panel, an !important body rule) still win there, so .wrap
    // resets every inherited property again inside the shadow root and sets the ones it needs.
    // One Lense look: tokens, icons, buttons, chips and rows come from the kit X-ray and the evidence renderer use too.
    const kit = lenseUiKit();
    const CSS = `
      :host { all: initial; }
      @media print { :host { display:none!important; } }
      * { box-sizing: border-box; }
      [hidden] { display:none!important; }
      .wrap { all: initial; display: block; direction: ltr; unicode-bidi: isolate;
        ${kit.tokens}
        font: 13px/1.45 var(--font); color: var(--fg); text-align: left; letter-spacing: 0; }
      .wrap.hidden .pill, .wrap.hidden .panel { display: none !important; }
      mark { background: var(--warn-bg); color: inherit; padding: 0; }

      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .pp-persona-picker { margin-top: 8px; min-width: 0; }
      .pp-find { display: flex; align-items: center; gap: 2px; }
      .pp-find .search { margin-right: 4px; }
      .pp-facets { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; padding: 6px 8px; background: var(--tint); border-radius: var(--radius); }
      .pp-facet { display: grid; grid-template-columns: 64px 1fr; align-items: baseline; gap: 4px; }
      .pp-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
      .pp-persona-picker .group { margin: 8px 0 0; }
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
      .branch { display: inline-flex; align-items: center; gap: 4px; }
      .branch > span { overflow: hidden; text-overflow: ellipsis; }
      .group-note { padding: 6px 8px; white-space: normal; }
      /* A kind the row's own name already says takes no room. */
      .ico:empty { display: none; }
      .caution .pill, .caution .panel { border-color: var(--danger); }
      .real { background: var(--danger); color: var(--on-danger); font-weight: 700; font-size: 11px; padding: 1px 6px; border-radius: var(--radius); }

      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); flex: none; }
      .dot.paused { background: var(--warn); }
      .dot.off { background: var(--muted); }

      .panel { display: none; flex-direction: column; width: min(500px, calc(100vw - 16px)); height: min(620px, calc(100vh - 16px)); border-radius: var(--radius); overflow: hidden;
        background: var(--bg); border: 1px solid var(--panel-line); box-shadow: var(--shadow); }
      .wrap.open .panel { display: flex; }
      .wrap.large .panel { width: min(860px, calc(100vw - 16px)); height: min(900px, calc(100vh - 16px)); }
      .wrap.dragging .panel { opacity: .9; }

      .head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--line); cursor: grab; user-select: none; -webkit-user-drag: none; touch-action: none; }
      /* The controls stay one row; on a narrow screen that row moves below the name as a whole. */
      .ident { flex: 1 1 90px; min-width: 0; line-height: 1.3; }
      .ident > div { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
      .ident .where { padding-left: 14px; font-size: 12px; }
      .ctl { display: flex; align-items: center; gap: 2px; flex: none; margin-left: auto; }
      .ctl .seg { margin-right: 4px; }
      .brand { color: var(--link); font-size: 14px; white-space: nowrap; }
      /* the site name gives way first: the environment says what the page is running against */
      .tag { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1000 auto; }
      .tag.env { color: var(--fg); font-weight: 600; flex: 0 1 auto; }
      @media (max-width: 520px) { .foot .stats { display: none; } .pill .branch { max-width: 70px; } }
      .grow { flex: 1; min-width: 4px; }

      .tabs { display: flex; gap: 2px; padding: 0 6px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: thin; }
      .targets { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
      .target-confirm { flex-basis:100%; padding:8px; border:1px solid var(--danger); border-radius:var(--radius); }
      .target-confirm p { margin:0 0 8px; }
      .targets label { flex: none; font-size: 12px; color: var(--muted); }
      .targets select { flex: 1; }
      .tw select { flex: 1 1 260px; }
      .gitline { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
      .gitline:empty { display: none; }
      .gitline .branch { min-width: 0; flex: 1; max-width: none; }
      .gitline .commit { flex: none; }
      .tab { padding: 8px 8px 6px; color: var(--fg); border-bottom: 3px solid transparent; display: inline-flex; gap: 5px; align-items: center; flex: none; white-space: nowrap; }
      .tab:hover { color: var(--primary); }
      .tab.on { color: var(--fg); border-bottom-color: var(--primary); font-weight: 600; }

      .tools { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
      .toolbtns { display: flex; align-items: center; gap: 2px; }
      .toolbtns:empty { display: none; }
      .subtools { padding: 0 10px 6px; }
      .subtools:empty { display: none; }
      .subtools .filters { margin: 0; }
      .inspect-nav { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 2px; }
      .inspect-nav .f { flex: none; }

      .body { flex: 1; overflow: auto; padding: 0 10px 10px; overscroll-behavior: contain; }
      button[aria-busy=true]{cursor:wait;} .working{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--tint);font-size:12px;color:var(--fg)}.spinner{display:inline-block;width:14px;height:14px;flex:none;border:2px solid var(--line);border-top-color:var(--primary);border-radius:50%;animation:panel-spin .9s linear infinite}.loading-state{display:flex;gap:10px;align-items:flex-start;padding:24px 10px;color:var(--muted)}.loading-state strong{display:block;color:var(--fg);margin-bottom:4px}.loading-state .spinner{margin-top:3px}@keyframes panel-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
      .foot { display: flex; gap: 10px; align-items: center; padding: 5px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11.5px; background: var(--tint); white-space: nowrap; overflow: hidden; }
      .foot .stats { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

      .card { padding: 2px 2px 8px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
      .card .path { font-size: 15px; overflow-wrap: anywhere; }
      .card .dim { color: var(--muted); font-size: 12.5px; }
      .srcs { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; align-items: center; }
      .card > .sub { white-space: normal; overflow-wrap: anywhere; margin-top: 4px; }
      .banner .grow { flex: 1; }
      .selection-summary { position: relative; margin: 8px 0; border: 1px solid var(--line); border-radius: var(--radius); }
      .selection-summary > summary { width: auto; margin-right: 34px; }
      .sel-head { display: flex; flex-direction: column; min-width: 0; }
      .sel-head .eyebrow { font-size: 11px; font-weight: 400; color: var(--muted); }
      .sel-name { overflow-wrap: anywhere; }
      .selection-summary[open] > summary [data-evidence-headline] { display: none; }
      .selection-summary > summary .inspection-evidence { flex: 1; min-width: 0; font-weight: 400; }
      .selection-summary > .inspection-evidence { padding: 0 8px 8px; }
      .selection-summary > .selection-clear { position: absolute; right: 3px; top: 2px; }
      div.selection-summary { padding: 7px 10px; }

      .filters { display: flex; align-items: center; gap: 6px; margin: 2px 2px 8px; flex-wrap: wrap; }
      .lbl2 { color: var(--muted); font-size: 12px; }
      .scope { display: inline-flex; align-items: center; gap: 6px; }

      .group { margin-bottom: 10px; }
      .gh .line { flex: 1; }

      .row.fresh { animation: fresh 2.2s ease-out 1; }
      @keyframes fresh { 0% { background: var(--head-bg); } 100% { background: transparent; } }
      .row.off .name > span:first-child { color: var(--muted); font-weight: 400; }
      .wrapt .sub, .wrapt .name > span:first-child { white-space: normal; overflow-wrap: anywhere; }
      /* Row actions are always shown, the same on every tab, so a row never moves or rewraps its text on hover. */
      .time { color: var(--muted); font-size: 11.5px; flex: none; font-variant-numeric: tabular-nums; }

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

      .toast, .float { background: var(--fg); color: var(--bg); border-radius: var(--radius); width: max-content; white-space: normal; overflow-wrap: anywhere; text-align: center; pointer-events: none; opacity: 0; transition: opacity .15s; }
      .toast { position: absolute; left: 50%; bottom: 36px; transform: translateX(-50%); padding: 5px 12px; max-width: 90%; box-sizing: border-box; z-index: 3; }
      .toast.show, .float.show { opacity: 1; }
      .toast.bad { background: var(--danger); color: var(--on-danger); }
      .float { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 7px 14px; max-width: calc(100vw - 32px); box-sizing: border-box; font: 13px var(--font); box-shadow: 0 2px 8px rgba(0,0,0,.2); }
      .panelwrap { position: relative; }
      .row.d1 { padding-left: 22px; } .row.d2 { padding-left: 36px; } .row.d3 { padding-left: 50px; }
      .row.d4 { padding-left: 64px; } .row.d5 { padding-left: 78px; } .row.d6 { padding-left: 92px; }
      .morebtn { display: block; width: 100%; padding: 6px 8px; color: var(--link); text-align: center; border-bottom: 1px solid var(--line); }
      .morebtn:hover { background: var(--tint); }
      .tw { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
      .who { margin: 4px 0 2px; }
      .srcs .dim { overflow-wrap: anywhere; }
      @media (prefers-reduced-motion: reduce) { .row.fresh { animation: none; } }
    `;
    const { ICON, icon, kindLabel, displayPath } = kit;
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
      ['mirage', 'Mirage'],
      ['issues', 'Issues'],
      ['activity', 'Activity'],
      ['explore', 'Explore'],
      ['actions', 'Actions'],
    ];
    const MIRAGE_TABS = new Set(['tweaks', 'mirage']);
    const MODEL_DRIVEN_PLACEHOLDER = {
      runtime: 'Filter tables, forms, views, columns ...',
      explore: 'Find a table, form, view, web resource ...',
    };
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
      /** @type {null | { rel: string, loading?: boolean, [key: string]: unknown }} */
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
    const nativeFetch = globalThis.fetch.bind(globalThis);
    // A change the runtime has seen but not reloaded yet: behind a running reload, or before one starts.
    const pendingReloadText = (s) => (s.reloading ? 'another reload queued' : 'source change waiting to reload');
    const esc = (s) =>
      String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      );
    /** A local runtime that serves the local sources itself: there is no other version to switch to. */
    const sourcesOnly = (d) => Boolean(d.mirageMode || d.localSimulation);
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
      String(p).split('#')[0].split(/[\\/]/).pop() + (String(p).includes('#') ? ' #' + String(p).split('#')[1] : '');
    /** "Home.en-US" for Home.en-US.webpage.custom_javascript.js: the kind is shown next to it */
    const shortName = (rel) =>
      baseName(rel).replace(
        /\.(?:webpage|basicform|advancedformstep|list|webtemplate|contentsnippet)\.[a-z_]+\.(?:js|css|html)$/i,
        '',
      );
    /** The kit kind of a file row: its own kind, else what its extension says. */
    const fileKind = (item) => {
      if (item.kind && item.kind !== 'web-file' && kindLabel(item.kind)) return item.kind;
      const ext = (/\.([a-z0-9]+)$/i.exec(item.url || item.rel || '')?.[1] ?? '').toLowerCase();
      if (ext === 'js' || ext === 'mjs') return 'script';
      if (ext === 'css') return 'stylesheet';
      if (/^(?:png|jpe?g|gif|svg|ico|webp)$/.test(ext)) return 'image';
      if (/^(?:woff2?|ttf|eot|otf)$/.test(ext)) return 'font';
      return 'web-file';
    };
    /** A sentence without its closing full stop, to continue it ("No grant: read, create"). */
    const withoutFullStop = (text) => {
      const trimmed = String(text).trimEnd();
      return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
    };
    const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    // Words a row name uses for a kind: "JavaScript (en-US)" already says Script, "Project · table" says Table.
    const SAID = { Script: /script|\bjs\b/i, Style: /\bcss\b|style/i };
    /**
     * A row's kind cell, in words; the tooltip names the kind in full. When the row's name already says the kind, the
     * cell stays empty (its tooltip still names it), so a row never repeats its own word.
     */
    const ico = (kind, tone = '', name = '') => {
      const [label, title] = kindLabel(kind) ?? [kind, kind];
      const said = Boolean(name) && (SAID[label] ?? new RegExp(String.raw`\b${escapeRegExp(label)}\b`, 'i')).test(name);
      const tip = title && (said || title !== label) ? ` title="${esc(title)}"` : '';
      return `<span class="ico${tone ? ' ' + tone : ''}"${tip}>${said ? '' : esc(label)}</span>`;
    };
    /** A kit icon in the kind column, for rows whose name says what they are (the Mirage tab). */
    const icoIcon = (name, title) => `<span class="ico icon" title="${esc(title)}">${icon(name)}</span>`;
    /** A path line: an ID segment reads "{…}", the full path is the tooltip (and what Copy copies). */
    const pathLine = (value, marked = esc(displayPath(value))) => {
      const tip = displayPath(value) === String(value) ? '' : ' title="' + esc(value) + '"';
      return `<div class="sub path"${tip}><bdi>${marked}</bdi></div>`;
    };
    /** An attribute only when it says something: no empty title, no title that repeats the visible text. */
    const attr = (name, value, visible = '') =>
      value && String(value) !== String(visible) ? ` ${name}="${esc(value)}"` : '';
    // A file row opens with its own click; its buttons are only what the row cannot do itself: Copy, on every tab.
    const fileActs = () => `<button class="ib" data-act="copy" title="Copy the file path">${icon('copy')}</button>`;

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
          if (typeof globalThis.__paqviloModelPanelApi !== 'function')
            return { ok: false, error: 'The model-driven dev loop is unavailable.' };
          return await Promise.race([
            globalThis.__paqviloModelPanelApi({ token: S.d.token, name, body: body ?? {} }),
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
        let error = 'the dev loop does not answer (is it still running?)';
        if (lifetime.signal.aborted) error = 'the dev loop has stopped';
        else if (timedOut && writing)
          error = 'The request timed out. Its result is unknown; check the current state before retrying.';
        else if (timedOut) error = 'The request timed out. Check the dev loop and retry.';
        return { ok: false, error };
      } finally {
        clearTimeout(timeout);
        lifetime.signal.removeEventListener('abort', stop);
      }
    };

    // Page CSS that matches the host (body>div, div, *) must not filter, rotate, fade, pad or frame the panel: the host
    // resets every property inline with !important, as the X-ray host does, and its position is set the same way.
    host.style.cssText =
      'all:initial!important;display:block!important;position:fixed!important;z-index:2147483647!important;direction:ltr!important;unicode-bidi:isolate!important;';
    const pin = (sides) => {
      for (const [side, value] of Object.entries(sides)) host.style.setProperty(side, value, 'important');
    };
    const root = host.attachShadow({ mode: 'open' });
    // a constructed stylesheet is not subject to the page's Content-Security-Policy for inline styles
    const sheet = new CSSStyleSheet();
    // The evidence styles start with the kit too: the panel's sheet carries the kit once.
    const evidenceStyles = renderInspectionEvidence(null, { part: 'styles' });
    sheet.replaceSync(
      kit.css + CSS + (evidenceStyles.startsWith(kit.css) ? evidenceStyles.slice(kit.css.length) : evidenceStyles),
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
            <div class="subtools"></div>
            <div class="body" role="tabpanel" id="paqvilo-tab-content"><div class="selection-host"></div><div class="content"></div></div>
            <div class="foot"></div>
          </div>
          <div class="toast" role="status" aria-live="polite"></div>
        </div>
        <div class="float" role="status" aria-live="polite"></div>
      </div>`;
    const $ = (sel) => root.querySelector(sel);
    // The selected element's details scroll with the tab content: one scroll area, no nested one.
    const selectionHost = $('.selection-host');
    const wrap = $('.wrap');

    const el = {
      pill: $('.pill'),
      panel: $('.panel'),
      head: $('.head'),
      targets: $('.targets'),
      git: $('.gitline'),
      tabs: $('.tabs'),
      body: $('.body'),
      content: $('.body > .content'),
      foot: $('.foot'),
      input: $('.search input'),
      toolbtns: $('.toolbtns'),
      subtools: $('.subtools'),
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
          if (
            !(/* NOSONAR: hasAttribute ignores inherited dataset properties */ button.hasAttribute('data-paqvilo-busy'))
          )
            button.dataset.paqviloBusy = String(button.disabled);
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
        } else if (
          /* NOSONAR: hasAttribute ignores inherited dataset properties */ button.hasAttribute('data-paqvilo-busy')
        ) {
          button.disabled = button.dataset.paqviloBusy === 'true';
          delete button.dataset.paqviloBusy;
          button.removeAttribute('aria-busy');
        }
      }
    };

    // ---- feedback
    let toastTimer = 0;
    const toast = (text, bad = false) => {
      // An answer that arrives after the panel was removed arms no timer.
      if (lifetime.signal.aborted) return;
      // An error is announced at once (alert); other notes wait for a pause (status). The role is set before the text.
      el.toast.setAttribute('role', bad ? 'alert' : 'status');
      el.toast.setAttribute('aria-live', bad ? 'assertive' : 'polite');
      el.toast.textContent = text;
      el.toast.className = 'toast show' + (bad ? ' bad' : '');
      clearTimeout(toastTimer);
      // An error stays long enough to read in full: at least five seconds, longer for a long message.
      toastTimer = setTimeout(
        () => (el.toast.className = 'toast'),
        bad ? Math.max(5000, String(text).length * 60) : 1800,
      );
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
        if (S.d) void api('ui', S.ui);
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
          void api('ui', S.ui);
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
    /* NOSONAR: single-pass routine, splitting it would change shared state */ const place = () => {
      if (!S.ui.open) S.pillPos ??= { h: 'left', v: 'bottom', dx: 12, dy: 12 };
      const pos = S.ui.open ? S.ui.pos : S.pillPos;
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      const box = (S.ui.open ? el.panel : el.pill).getBoundingClientRect();
      const dx = Math.max(4, Math.min(pos.dx, vw - box.width - 4));
      const dy = Math.max(4, Math.min(pos.dy, vh - box.height - 4));
      pin({
        left: pos.h === 'left' ? dx + 'px' : 'auto',
        right: pos.h === 'right' ? dx + 'px' : 'auto',
        top: pos.v === 'top' ? dy + 'px' : 'auto',
        bottom: pos.v === 'bottom' ? dy + 'px' : 'auto',
      });
      if (!S.ui.open && !S.ui.hidden && !stopDrag) {
        const rect = el.pill.getBoundingClientRect();
        // The X-ray's own bar, legend and card count as controls too: the pill moves to a corner they leave free.
        const xrayChrome = document.getElementById('paqvilo-xray')?.shadowRoot?.querySelectorAll('.bar,.legend,.card');
        const controls = [
          ...[
            ...document.querySelectorAll(
              'a[href],button,input:not([type=hidden]),select,textarea,[role=button],iframe',
            ),
          ].filter((node) => !node.closest('#paqvilo-panel,#paqvilo-xray')),
          ...(xrayChrome ?? []),
        ].flatMap((node) => {
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
        // Every corner, then along each edge from it: a corner the page fills (a sign-in link, a footer card) gives way
        // to the nearest free place on the same edge. Fewest covered controls, then least covered area, then nearest
        // to a corner.
        const better = (a, b) => {
          if (a.count !== b.count) return a.count < b.count;
          if (a.area !== b.area) return a.area < b.area;
          return a.offset < b.offset;
        };
        const at = (candidate) => ({
          ...score(
            candidate.h === 'left' ? candidate.dx : vw - candidate.dx - rect.width,
            candidate.v === 'top' ? candidate.dy : vh - candidate.dy - rect.height,
          ),
          offset: candidate.dx + candidate.dy,
        });
        // Where the pill is now (the default corner, or where it was dragged) stays unless a place covers less.
        const current = { pos, score: { ...score(rect.left, rect.top), offset: -1 } };
        let best = current;
        const STEP = 24;
        for (const h of ['left', 'right'])
          for (const v of ['bottom', 'top']) {
            const candidates = [];
            for (let dx = 12; dx <= Math.max(12, (vw - rect.width) / 2); dx += STEP)
              candidates.push({ h, v, dx, dy: 12 });
            for (let dy = 12 + STEP; dy <= Math.max(12, (vh - rect.height) / 2); dy += STEP)
              candidates.push({ h, v, dx: 12, dy });
            for (const candidate of candidates) {
              const candidateScore = at(candidate);
              if (better(candidateScore, best.score)) best = { pos: candidate, score: candidateScore };
            }
          }
        S.pillPos = best.pos;
        pin({
          left: best.pos.h === 'left' ? best.pos.dx + 'px' : 'auto',
          right: best.pos.h === 'right' ? best.pos.dx + 'px' : 'auto',
          top: best.pos.v === 'top' ? best.pos.dy + 'px' : 'auto',
          bottom: best.pos.v === 'bottom' ? best.pos.dy + 'px' : 'auto',
        });
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
    globalThis.addEventListener(
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
    // The environment's name stays in the header: next to Local, a chip such as "≠ local" reads as nonsense.
    // What a local file is compared with: the deployed site, or (in front of a local Mirage) the version it serves.
    const servedWords = () =>
      sourcesOnly(S.d)
        ? {
            differs: 'differs from served version',
            same: 'unchanged',
            group: 'Unchanged',
            filter: 'Differs from served version',
            filterTitle: 'Files whose local version differs from the version this site serves',
            against: 'the served version',
            isNew: 'The served site has no such file',
            differsTitle: 'Your local file differs from the version this site serves',
            sameTitle: 'Same content as the served file: this override changes nothing',
            pause: 'Pause this override: show the served version',
          }
        : {
            differs: 'differs from deployed',
            same: 'same as deployed',
            group: 'Same as deployed',
            filter: 'Differs from deployed',
            filterTitle: 'Files whose local version differs from the deployed one that Online shows',
            against: 'the deployed version',
            isNew: 'Not deployed yet: Online has no such file',
            differsTitle: 'Your local file differs from the deployed one that Online shows',
            sameTitle: 'Same content as the deployed file: this override changes nothing',
            pause: 'Pause this override: show the online version',
          };
    const chips = (it) => {
      const words = servedWords();
      let out = '';
      if (it.paused) out += '<span class="c muted">paused</span>';
      if (it.edited) out += '<span class="c info" title="Differs from the Git baseline: your change">edited</span>';
      if (it.isNew) out += `<span class="c ok" title="${words.isNew}">new</span>`;
      else if (it.differs === true) out += `<span class="c warn" title="${words.differsTitle}">${words.differs}</span>`;
      else if (it.differs === false) out += `<span class="c muted" title="${words.sameTitle}">${words.same}</span>`;
      if (it.note) out += `<span class="c act">${esc(it.note)}</span>`;
      if (it.count > 1)
        out += `<span class="c act" title="This page requested the file ${it.count} times">${it.count} requests</span>`;
      return out;
    };
    const itemRow = (it) => {
      const kind = fileKind(it);
      const title = it.title || shortName(it.rel);
      const sub = it.url && it.kind === 'web-file' ? `${it.url} · ${it.rel}` : it.rel;
      const whatTag =
        kindLabel(it.kind) && it.kind !== 'web-file' ? `<span class="what">${esc(kindLabel(it.kind)[1])}</span>` : '';
      const diffButton = it.canDiff
        ? `<button class="ib" data-act="diff" title="Compare ${esc(title)} with ${servedWords().against}">${icon('diff')}</button>`
        : '';
      const toggleButton = () => {
        if (!it.canPause) return '';
        const label = it.paused ? 'Use the local file again' : servedWords().pause;
        return `<button class="ib" data-act="toggle" data-off="${it.paused ? '' : '1'}" title="${label}">${icon(it.paused ? 'play' : 'pause')}</button>`;
      };
      return `<div class="row${it.fresh ? ' fresh' : ''}${it.paused ? ' off' : ''}" data-rel="${esc(it.rel)}" data-path="${esc(it.path ?? '')}" data-url="${esc(it.url ?? '')}" data-label="${esc(title)}">
        ${ico(kind)}
        <button class="main" data-act="open" title="Open ${esc(title)} in the editor">
          <div class="name"><span>${hl(title)}</span>${whatTag}${chips(it)}</div>
          ${pathLine(sub, hl(displayPath(sub)))}
        </button>
        <div class="acts">${diffButton}${toggleButton()}${fileActs()}</div>
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

    /* NOSONAR: single-pass routine, splitting it would change shared state */ const overridesHtml = () => {
      const d = S.d;
      let out = '';
      if (d.page) {
        // The page's own files, as the file rows of every tab (X-ray lists them as "Page files" too).
        const files = d.page.sources.map(
          (s) =>
            `<div class="row${s.empty ? ' off' : ''}" data-rel="${esc(s.rel)}" data-label="${esc(s.label)}">${ico(kindLabel(s.kind) ? s.kind : 'page-metadata', '', s.label)}<button class="main" data-act="open" title="Open ${esc(s.label)} in the editor"><div class="name"><span>${esc(s.label)}</span>${s.empty ? '<span class="what">empty</span>' : ''}</div>${pathLine(s.rel)}</button><div class="acts">${fileActs()}</div></div>`,
        );
        // A model-driven app has one address for every page: its table or form names the page, not /main.aspx.
        const pageDir = d.page.dir ? ' &middot; ' + esc(d.page.dir) : '';
        out += d.modelDriven
          ? `<div class="card"><div class="path">${esc(d.page.title ?? d.page.name ?? '')}</div></div>`
          : `<div class="card"><div class="path">${esc(d.page.path)} <span class="dim">&nbsp;${esc(d.page.name ?? '')}${pageDir}</span></div></div>`;
        out += group('page-files', 'Page files', files);
      } else {
        out += `<div class="card"><div class="path">${esc(location.pathname)} <span class="dim">&nbsp;no web page with this address in the local sources</span></div></div>`;
      }
      if (d.online) {
        // In front of a local Mirage the environment is often named "local": "as local serves it" reads as nonsense.
        const servedBy = sourcesOnly(d) ? 'your local Mirage' : `<b>${esc(d.env)}</b>`;
        out += `<div class="banner grey"><span class="grow">Overrides are off: this is the page exactly as ${servedBy} serves it.</span><button class="btn" data-act="mode" data-v="local">Back to local</button></div>`;
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
      // Model-driven rows not observed on this revision are listed under the same filters, so they count too.
      const counted = d.modelDriven ? [...all, ...(d.unobserved ?? [])] : all;
      const counts = {
        all: counted.length,
        edited: counted.filter((i) => i.edited).length,
        differs: counted.filter((i) => i.differs === true || i.isNew).length,
      };
      // Without a Git baseline nothing is Edited and "changed vs Git" would override nothing: neither is offered.
      const noBaseline = d.git?.baseline?.available === false;
      const filter = counts[S.ui.filter] == null || !counts.all ? 'all' : S.ui.filter;
      const scopeButton = ([s, label, title]) => {
        const unavailable = s === 'changed' && noBaseline && d.scope !== 'changed';
        return `<button class="${d.scope === s ? 'on' : ''}" data-act="scope" data-v="${s}" aria-pressed="${d.scope === s}" title="${unavailable ? 'Needs a Git baseline: Issues says why there is none' : title}"${unavailable ? ' disabled' : ''}>${label}</button>`;
      };
      const scopeSwitch =
        d.mirageMode || d.capabilities?.scope === false
          ? ''
          : `<span class="scope"><span class="lbl2">Local files</span><span class="seg" role="group" aria-label="Local files that override the site">${[
              ['all', 'all', 'Every local file overrides the site. Reloads the page.'],
              [
                'changed',
                'changed vs Git',
                'Only files that differ from the Git baseline override the site. Reloads the page.',
              ],
            ]
              .map(scopeButton)
              .join('')}</span></span>`;
      // With nothing to filter, the filters and the scope switch are noise above the empty state; a scope that hides
      // every file stays switchable.
      if (counts.all || d.scope === 'changed')
        S.subtools = `<div class="filters">
        ${[
          ['all', 'All', 'Every file of this page that comes from your local sources'],
          ['edited', 'Edited', 'Files that differ from the Git baseline: your changes'],
          ['differs', servedWords().filter, servedWords().filterTitle],
        ]
          // A filter that would show nothing is left out, unless it is the one chosen.
          .filter(
            ([id]) =>
              id === 'all' ||
              (d.capabilities?.comparison !== false &&
                (counts[id] > 0 || filter === id) &&
                !(id === 'edited' && noBaseline)),
          )
          .map(
            ([id, label, title]) =>
              `<button class="f${filter === id ? ' on' : ''}" data-act="filter" data-v="${id}" aria-pressed="${filter === id}" title="${title}">${esc(label)} <b>${counts[id]}</b></button>`,
          )
          .join('')}
        <span class="grow"></span>${scopeSwitch}
      </div>`;
      const inFilter = (i) => {
        if (filter === 'edited') return i.edited;
        if (filter === 'differs') return i.differs === true || i.isNew;
        return true;
      };
      const shown = all.filter((i) => inFilter(i) && matches(i.rel, i.url ?? '', i.title ?? ''));
      let lists = '';
      for (const [id, title] of GROUPS) lists += group(id, title, shown.filter((i) => i.group === id).map(itemRow));
      const paused = d.paused.filter((i) => matches(i.rel, i.url ?? ''));
      lists += group('paused', 'Paused overrides', paused.map(itemRow));
      if (d.modelDriven)
        lists += group(
          'unobserved',
          'Not loaded by this page',
          (d.unobserved ?? []).filter((i) => inFilter(i) && matches(i.rel, i.url ?? '', i.title ?? '')).map(itemRow),
        );
      const insync = d.insync.filter((i) => matches(i.rel));
      lists += group('insync', servedWords().group, insync.map(itemRow));
      if (!lists) {
        if (S.q || filter !== 'all')
          out += emptyState('Nothing matches', 'Clear the filter to see every override of this page.');
        else if (d.online)
          out += emptyState('Online mode', 'Switch back to <b>Local</b> to lay your sources over the site.');
        else {
          let hint = 'No web file, script, template or snippet of the local sources was found in this page.';
          if (d.scope === 'changed')
            hint =
              'Scope is <i>changed vs Git</i>: only files that differ from the Git baseline override the site. Edit a file and save.';
          else if (d.modelDriven)
            hint =
              'No web resource or code component (PCF) of your Solution sources was loaded by this page. Open Inspect for its table, form and views.';
          out += d.mirageMode
            ? emptyState(
                'Mirage renders this page from your sources',
                'Open Inspect to see this page’s templates, tables, permissions and sources, or Tweaks to change the persona.',
              )
            : emptyState('Nothing on this page comes from local sources', hint);
        }
      }
      return out + lists;
    };

    // ---- Mirage: Inspect and Tweaks
    const FORM_MODE = { 100000000: 'insert', 100000001: 'edit', 100000002: 'read only' };
    const PERMISSION_CHIPS = ['read', 'create', 'update', 'delete'];
    const isGuid = (value) => /^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i.test(String(value ?? ''));
    // "Language page JavaScript" is page JavaScript: the kind is the end of the source's name.
    const pageSourceKind = (name, kind = '') =>
      [
        [/form$/i, 'form', kind],
        [/^view$/i, 'view', kind],
        [/^table/i, 'table', kind],
      ].find(([pattern, , text]) => pattern.test(text))?.[1] ??
      [
        [/copy$/i, 'page-copy'],
        [/javascript$/i, 'page-js'],
        [/css$/i, 'page-css'],
        [/summary$/i, 'page-summary'],
      ].find(([pattern]) => pattern.test(name ?? ''))?.[1] ??
      'page-metadata';
    // Why the current persona may or may not read the page, in words (Mirage reports a code and a reason).
    const ACCESS_WORDS = {
      'public-or-role': 'No page access rule restricts this page',
      'grant-change': 'A Grant Change rule gives this persona access',
      'service-page': 'A system page (access denied, page not found): always readable',
      'external-url': 'Links to an external address',
      PAGE_ACCESS_DENIED: 'A Restrict Read rule applies and none of its web roles is this persona’s',
      PAGE_RULE_UNRESOLVED: 'A page access rule has roles or pages that are not in your sources',
      PAGE_UNPUBLISHED: 'The page is in a publishing state that is not visible',
      LANGUAGE_UNPUBLISHED: 'The page’s language is not published',
      WEB_FILE_NOT_RELEASED: 'The web file is outside its release and expiration dates',
      PAGE_IDENTITY_UNRESOLVED: 'The page is not in your sources',
      PAGE_HIERARCHY_UNRESOLVED: 'A parent page is not in your sources',
    };
    const accessWords = (access) =>
      ACCESS_WORDS[access.reason] ??
      ACCESS_WORDS[access.code] ??
      access.diagnostics?.find((item) => item?.code === access.code)?.message ??
      (access.allowed === false ? 'Denied by the local access rules' : '');
    const RUNTIME_LIMIT = 80;
    /** A Mirage group: collapsible (with a default), filtered, and capped until "Show all". */
    const rgroup = (id, title, items, toRow, { count, collapsed = false, note = '' } = {}) => {
      if (!items.length && !note) return '';
      S.defaults[id] = collapsed;
      const closed = (S.ui.collapsed[id] ?? collapsed) && !S.q;
      const capped = !closed && items.length > RUNTIME_LIMIT && !S.more[id];
      // Rows are built only for open groups, and only up to the cap.
      let shown = [];
      if (!closed) shown = (capped ? items.slice(0, RUNTIME_LIMIT) : items).map(toRow);
      const moreButton = capped
        ? `<button class="morebtn" data-act="more" data-id="${id}">Show all ${items.length}</button>`
        : '';
      const noteLine = note && !closed ? `<div class="sub group-note">${esc(note)}</div>` : '';
      return `<div class="group" data-group="${id}"><button class="gh${closed ? '' : ' openg'}" data-act="fold" data-id="${id}" aria-expanded="${!closed}">${icon('right')}<span>${esc(title)}</span><span class="n dimn">${count ?? items.length}</span><span class="line"></span></button>${shown.join('')}${moreButton}${noteLine}</div>`;
    };
    /** One reported item; rows with a reference open their local source (at `find` when given). */
    const rrow = (
      item,
      {
        kind,
        title,
        what = '',
        sub = '',
        subTitle = '',
        chips = '',
        acts = '',
        depth = 0,
        find = '',
        wrap = false,
        tone = '',
      },
    ) => {
      const ref = item?.ref ?? '';
      // Enhanced components keep each field as a JSON key inside powerpagecomponent.xml.
      const findText =
        find ||
        (/powerpagecomponent\.xml$/i.test(ref) && /^[a-z_]+$/i.test(item?.fieldPath ?? '')
          ? `"${item.fieldPath}":`
          : '');
      // A sub line that is only the file path keeps the file name visible.
      let subLine = sub ? `<div class="sub"${attr('title', subTitle, sub)}>${hl(displayPath(sub))}</div>` : '';
      if (sub && sub === ref && !wrap) subLine = pathLine(sub, hl(displayPath(sub)));
      const whatTag = what ? `<span class="what">${hl(what)}</span>` : '';
      const body = `<div class="name"><span>${hl(title)}</span>${whatTag}${chips}</div>${subLine}`;
      const depthClass = depth ? ` d${Math.min(depth, 6)}` : '';
      const mainHtml = ref
        ? `<button class="main" data-act="open" title="Open ${esc(title)} in the editor">${body}</button>`
        : `<div class="main">${body}</div>`;
      return `<div class="row${wrap ? ' wrapt' : ''}${depthClass}" data-rel="${esc(ref)}" data-path="${esc(item?.path ?? '')}" data-find="${esc(findText)}" data-label="${esc(title)}">
        ${ico(kind, tone, title)}
        ${mainHtml}
        <div class="acts">${acts}${ref ? fileActs() : ''}</div>
      </div>`;
    };
    const simButton = (hash, title) =>
      S.d.mirageMode
        ? `<button class="ib" data-act="sim" data-hash="${esc(hash)}" title="${esc(title)}">${icon('sim')}</button>`
        : '';
    const pageRecordId = () => {
      try {
        return new URLSearchParams(location.search).get('id');
      } catch {
        return null;
      }
    };
    const recordsHash = (entity) => {
      const recordId = pageRecordId();
      const idQuery = recordId ? `&id=${encodeURIComponent(recordId)}` : '';
      return `records?entity=${encodeURIComponent(entity)}${idQuery}`;
    };
    /* NOSONAR: single-pass routine, splitting it would change shared state */ const runtimeHtml = () => {
      const runtime = S.d.inspection ?? S.d.mirage;
      if (!runtime || (inspectionPending(runtime) && !(S.inspect?.report && S.inspect.version >= runtime.version)))
        return loadingState(
          'Reading local sources…',
          runtime?.phase ?? 'Finding the page for this address in your sources.',
        );
      if (!runtime?.active)
        return emptyState(
          'Source inspection unavailable',
          esc(runtime?.error ?? 'Your local sources could not be read.'),
        );
      const live = ['live-sources', 'model-driven'].includes(runtime.mode);
      // The runtime itself is on the Mirage tab: Inspect starts with the inspection.
      let out = '';
      if (inspectionPending(runtime) && S.inspect?.report)
        out += loadingState('Updating source inspection…', runtime.phase ?? '');
      if (!S.inspect || S.inspect.version < runtime.version)
        return (
          out + loadingState('Inspecting this page…', 'Matching templates, fields and controls to their local sources.')
        );
      if (S.inspect.error && !S.inspect.report)
        return (
          out +
          emptyState('Inspection failed', esc(S.inspect.error)) +
          '<button class="btn" data-act="inspect-refresh">Retry inspection</button>'
        );
      const report = S.inspect.report;
      if (!report)
        return (
          out +
          emptyState('Inspection failed', esc(runtime.error ?? 'No result for this page. Click Refresh inspection.')) +
          '<button class="btn" data-act="inspect-refresh">Refresh inspection</button>'
        );
      // The tools come first; what this page is follows them, as on a portal page.
      const head = out;
      out = '';
      if (report.modelDriven) {
        const c = report.modelDriven,
          catalogue = c.catalogue ?? {};
        // Names, not IDs: the IDs stay in the tooltip.
        const app = (catalogue.apps ?? []).find((item) => c.appId && [item.id, item.appId, item.key].includes(c.appId));
        const form = (catalogue.forms ?? []).find((item) => c.formId && [item.id, item.formId].includes(c.formId));
        const table = (catalogue.tables ?? []).find((item) => item.logicalName === c.entity || item.name === c.entity);
        const appName = c.appName ?? app?.name ?? app?.label ?? app?.uniqueName;
        const formName = c.formName ?? form?.name;
        const formType = c.formType ?? form?.formType ?? form?.type;
        // Only names: an app or form without one in your sources is left out (its ID is in the tooltip).
        const facts = [
          appName && `App: ${appName}`,
          formName && 'Form: ' + formName + (formType ? ' (' + formType + ')' : ''),
        ].filter(Boolean);
        const ids = [c.appId && 'App ID ' + c.appId, c.formId && 'Form ID ' + c.formId].filter(Boolean).join(' · ');
        const tableLabel = c.entityLabel ?? table?.label ?? table?.displayName;
        const logical = tableLabel && c.entity ? ' <span class="dim">' + esc(c.entity) + '</span>' : '';
        const factLine = facts.length
          ? '<div class="sub" title="' + esc(ids) + '">' + esc(facts.join(' · ')) + '</div>'
          : '';
        out += `<div class="card"><div class="path">${esc(tableLabel ?? c.entity ?? 'App context')}${logical}</div>${factLine}</div>`;
      }
      const sections = [
        ['all', 'All', 'Show every group'],
        report.modelDriven
          ? ['source', 'Solution sources', 'The form, view and table files this app page comes from']
          : ['source', 'Page & templates', 'The page, its template chain and related metadata'],
        ['components', 'Forms & controls', 'Forms, views, fields, grids, code components and server logic'],
        ['data', 'Tables & access', 'Tables, table permissions, page access rules and Web API references'],
        report.modelDriven
          ? ['assets', 'Resources', 'Web resources of your Solutions']
          : ['assets', 'Files & snippets', 'Web files, content snippets and site settings'],
        ['unresolved', 'Not found', 'References that no file of your sources matches'],
      ];
      const sectionButtons = sections
        .map(
          ([id, label, title]) =>
            `<button class="f${S.inspectSection === id ? ' on' : ''}" data-act="inspect-section" data-v="${id}" aria-pressed="${S.inspectSection === id}" title="${title}">${label}</button>`,
        )
        .join('');
      // The section chips sit under the search box, above the selection: the selection never moves them.
      S.subtools = `<div class="inspect-nav" role="group" aria-label="Inspection sections">${sectionButtons}</div>`;
      if (S.pickingElement)
        out +=
          '<div class="card"><div class="path">Select an element on the page</div><div class="sub">Click a control or content block. Its action is paused for this click. Press Escape to cancel.</div></div>';
      const page = report.page;
      if (page) {
        const access = page.access ?? {};
        const why = accessWords(access);
        let verdict = '';
        if (access.allowed === true) verdict = '<span class="c ok">allowed</span>';
        else if (access.allowed === false) verdict = '<span class="c bad">denied</span>';
        const pageName = page.pageName ?? page.name ?? location.pathname;
        // A live portal cannot say whether the persona may read the page: it says what it does not know instead.
        const whyLine = why ? '<span class="dim">' + esc(why) + '</span>' : '';
        const accessLine = live
          ? '<div class="sub">' +
            esc(report.evidence?.identity ?? 'Live web-role membership and record access are not known here.') +
            '</div>'
          : `<div class="srcs"><span class="lbl2">Current persona</span>${verdict}${whyLine}</div>`;
        const hiddenState = page.publishingState?.visible === false ? ' (not visible)' : '';
        const publishing = page.publishingState?.name
          ? page.publishingState.name + hiddenState
          : 'Publishing state not set';
        const facts = [
          `Template: ${page.pageTemplateName ?? 'none'}`,
          page.parent && `Parent: ${page.parent.name ?? page.parent.url}`,
          publishing,
        ].filter(Boolean);
        out += `<div class="card"><div class="path">${esc(pageName)} <span class="dim">${esc(page.url ?? '')}</span></div>
          <div class="sub">${esc(facts.join(' · '))}</div>
          ${accessLine}</div>`;
      } else if (!report.modelDriven)
        out += `<div class="card"><div class="path">${esc(location.pathname)} <span class="dim">&nbsp;no web page in your sources has this address</span></div></div>`;
      const keep = (...texts) => matches(...texts.map((text) => String(text ?? '')));
      const groups = [];
      // Names, never IDs: a record the report names by ID is looked up among the records it lists.
      const plainId = (value) =>
        String(value ?? '')
          .replace(/[{}]/g, '')
          .toLowerCase();
      const named = [
        ...(report.webTemplates ?? []),
        ...(report.templateChain ?? []),
        ...(report.forms ?? []),
        ...(report.views ?? []),
        ...(report.components ?? []).map((item) => ({ ...item, id: item.recordId ?? item.id })),
        ...(report.permissionRules ?? []),
      ].filter((item) => item?.id && item.name);
      const nameOf = (id) => named.find((item) => plainId(item.id) === plainId(id))?.name ?? null;
      const OWNER_ROOT = {
        page: 'in this page',
        'website-header': 'in the website header',
        'website-footer': 'in the website footer',
        'page-shell': 'in the page shell',
      };
      const ownerName = (owner) => {
        if (!owner) return '';
        if (OWNER_ROOT[owner]) return OWNER_ROOT[owner];
        const at = String(owner).indexOf(':');
        const [kind, key] = at < 0 ? [owner, ''] : [owner.slice(0, at), owner.slice(at + 1)];
        const kindName = ((kindLabel(kind) ?? [kind, kind.replaceAll('-', ' ')])[1] ?? '').toLowerCase();
        const name = isGuid(key) ? nameOf(key) : key;
        return name ? `in ${kindName} ${name}` : `in a ${kindName}`;
      };
      const ruleSub = (rule) => {
        const named = (rule.roles ?? []).filter((role) => role.name).map((role) => role.name);
        const unknown = (rule.roles ?? []).length - named.length;
        const roles =
          [...named, ...(unknown ? [`${unknown} role${unknown > 1 ? 's' : ''} not in your sources`] : [])].join(', ') ||
          'no roles';
        const inherited = rule.inherited
          ? ` · inherited from ${rule.page?.name ?? rule.page?.url ?? 'an ancestor'}`
          : '';
        return [rule.page?.url, rule.rightLabel, rule.scopeLabel, roles].filter(Boolean).join(' · ') + inherited;
      };
      // How a template joined the chain; Mirage names one way by a code.
      const VIA = { 'page-template': 'the page template renders it' };
      const chainSub = (row) => {
        if (row.kind === 'root') return 'renders the templates below';
        return [
          row.via && row.kind === 'web-template' ? (VIA[row.via] ?? row.via) : '',
          row.repeated ? 'included again' : '',
          row.ref,
        ]
          .filter(Boolean)
          .join(' · ');
      };
      const sourceRows = (report.pageSources ?? []).filter((item) => keep(item.name, item.ref));
      groups.push(
        rgroup('runtime-page-sources', 'Page source files', sourceRows, (item) =>
          rrow(item, {
            kind: pageSourceKind(item.name, item.kind),
            title: item.name,
            sub: item.ref ?? item.fieldPath ?? '',
          }),
        ),
      );
      const rules = (page?.access?.rules ?? []).filter((rule) =>
        keep(rule.name, rule.rightLabel, rule.page?.url, ...(rule.roles ?? []).map((role) => role.name ?? role.id)),
      );
      groups.push(
        rgroup('runtime-access', 'Page access rules', rules, (rule) =>
          rrow(rule, {
            kind: rule.right === 1 ? 'access-grant' : 'access-rule',
            title: rule.name,
            sub: ruleSub(rule),
            chips: `${rule.matches ? '<span class="c ok">current persona</span>' : ''}${rule.overridden ? '<span class="c info">local override</span>' : ''}`,
            find: rule.id,
            wrap: true,
            acts: simButton(
              `portal?kind=access-rules&name=${encodeURIComponent(rule.id)}`,
              'Edit this rule in Mirage admin',
            ),
          }),
        ),
      );
      const chain = (report.templateChain ?? []).filter((row) => keep(row.name, row.kind, row.via, row.ref));
      groups.push(
        rgroup('runtime-chain', 'Template chain', chain, (row) =>
          rrow(row, {
            kind: row.kind === 'root' ? 'page' : row.kind,
            title: row.name,
            sub: chainSub(row),
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
          const chips = PERMISSION_CHIPS.map((op) => {
            const result = operations[op];
            if (!result) return '';
            let tone = 'ok',
              label = op;
            if (!result.allowed) [tone, label] = ['bad', `no ${op}`];
            else if (result.scoped) [tone, label] = ['warn', `${op}, scoped`];
            return `<span class="c ${tone}"${attr('title', result.reason)}>${label}</span>`;
          }).join('');
          // One reason for several operations is said once: "No grant for Anonymous Users: read, create".
          const byReason = new Map();
          for (const op of PERMISSION_CHIPS)
            if (operations[op]?.reason)
              byReason.set(operations[op].reason, [...(byReason.get(operations[op].reason) ?? []), op]);
          const reasons = [...byReason]
            .map(([reason, ops]) => `${withoutFullStop(reason)}: ${ops.join(', ')}`)
            .join(' · ');
          const layers =
            (table.sourceRefs ?? []).length > 1
              ? (table.sourceRefs ?? [])
                  .map(
                    (layer, index) =>
                      `<button class="ib text" data-act="open" data-rel="${esc(layer.ref)}" title="Open layer ${index + 1} of this table: ${esc(layer.ref)}">Layer ${index + 1}</button>`,
                  )
                  .join('')
              : '';
          const inferred = table.entitySetInferred ? ' (inferred)' : '';
          const entitySetText = table.entitySet ? `entity set ${table.entitySet}${inferred}` : 'no entity set';
          const accessNote = !live && table.permissions?.mode === 'permissive' ? ' · permissions not enforced' : '';
          const reasonNote = reasons ? ` · ${reasons}` : '';
          return rrow(table, {
            kind: 'table',
            title: table.displayName || table.logicalName,
            what: table.displayName ? table.logicalName : '',
            sub: `${entitySetText} · ${table.fieldCount ?? 0} columns in your sources${accessNote}${reasonNote}`,
            chips,
            wrap: true,
            acts:
              layers + simButton(recordsHash(table.logicalName), `Open ${table.logicalName} records in Mirage admin`),
          });
        }),
      );
      const grants = (report.permissionRules ?? []).filter((rule) =>
        keep(rule.name, rule.entity, rule.scope, ...(rule.roles ?? [])),
      );
      const permissionSub = (rule) => {
        const operations = (rule.operations ?? []).join(', ') || 'no operations';
        const roles = (rule.roles ?? []).join(', ') || 'none';
        const relationship = rule.relationshipName ? ` · relationship ${rule.relationshipName}` : '';
        const parentName = (report.permissionRules ?? []).find((item) => item.id === rule.parentPermissionId)?.name;
        let parent = '';
        if (rule.parentPermissionId) parent = ` · parent ${parentName ?? 'permission not in your sources'}`;
        return `${rule.entity} · ${rule.scope} · ${operations} · roles ${roles}${relationship}${parent}`;
      };
      groups.push(
        rgroup('runtime-permissions', 'Table permissions and web roles', grants, (rule) =>
          rrow(rule, {
            kind: 'table-permission',
            title: rule.name,
            sub: permissionSub(rule),
            wrap: true,
          }),
        ),
      );
      const formSub = (form) => {
        let kind = 'basic form';
        if (form.kind === 'advanced-form') kind = 'advanced form';
        else if (form.kind === 'model-driven-form') kind = `${form.formType ?? 'main'} form`;
        const mode = FORM_MODE[form.mode] ? ` · ${FORM_MODE[form.mode]}` : '';
        const formName = form.formName ? ` · form ${form.formName}` : '';
        let evidence = '';
        if (form.evidence === 'rendered-component-id') evidence = ' · open on this page';
        else if (form.evidence === 'configured-modal-form') evidence = ' · opens as a pop-up';
        return `${kind}${mode} · table ${form.entity ?? 'unknown'}${formName}${evidence}`;
      };
      const stepSub = (step) => {
        const mode = FORM_MODE[step.mode] ? ` · ${FORM_MODE[step.mode]}` : '';
        const formName = step.formName ? ` · form ${step.formName}` : '';
        return `${step.entity ?? 'no table'}${mode}${formName}`;
      };
      const forms = (report.forms ?? []).filter((form) =>
        keep(form.name, form.entity, form.formName, form.kind, ...(form.steps ?? []).map((step) => step.name)),
      );
      groups.push(
        rgroup('runtime-forms', 'Forms', forms, (form) =>
          [
            rrow(form, {
              kind: form.kind === 'advanced-form' ? 'advanced-form' : 'basic-form',
              title: form.name,
              sub: formSub(form),
              acts: form.entity
                ? simButton(recordsHash(form.entity), `Open ${form.entity} records in Mirage admin`)
                : '',
            }),
            ...(report.components ?? [])
              .filter(
                (component) =>
                  component.recordId === form.id && component.kind === 'basic-form' && component.ref !== form.ref,
              )
              .map((component) =>
                rrow(component, {
                  kind: 'basic-form-js',
                  title: 'Form JavaScript',
                  sub: component.ref ?? 'Custom JavaScript',
                  depth: 1,
                }),
              ),
            ...(form.formXml?.ref
              ? [
                  rrow(form.formXml, {
                    kind: 'formxml',
                    title: form.formXml.name ?? 'Form XML',
                    sub: form.formXml.ref,
                    depth: 1,
                  }),
                ]
              : []),
            ...(form.steps ?? []).flatMap((step) => [
              rrow(step, {
                kind: 'advanced-form-step',
                title: step.name ?? 'Unnamed step',
                sub: stepSub(step),
                depth: 1,
              }),
              ...(step.formXml?.ref
                ? [
                    rrow(step.formXml, {
                      kind: 'formxml',
                      title: step.formXml.name ?? 'Form XML',
                      sub: step.formXml.ref,
                      depth: 2,
                    }),
                  ]
                : []),
            ]),
          ].join(''),
        ),
      );
      const viewSub = (view) => {
        const columnNames = (view.fields ?? []).map((field) => field.name).join(', ');
        const usedBy = view.usedBy?.length ? ` · used by ${[...new Set(view.usedBy)].join(', ')}` : '';
        const observed = view.evidence === 'rendered-view-id' ? ' · shown on this page' : '';
        return `${view.entity} · ${(view.fields ?? []).length} columns: ${columnNames}${usedBy}${observed}`;
      };
      const views = (report.views ?? []).filter((view) =>
        keep(view.name, view.entity, ...(view.fields ?? []).map((field) => field.name)),
      );
      groups.push(
        rgroup('runtime-views', 'Views', views, (view) =>
          rrow(view, {
            kind: 'view',
            title: view.name,
            sub: viewSub(view),
            wrap: true,
          }),
        ),
      );
      const nativeKind = (item) => (['subgrid', 'quickform'].includes(item.kind) ? item.kind : 'notes');
      const nativeSub = (item) => {
        const relationship = item.relationship ? ` · relationship ${item.relationship}` : '';
        const lookup = item.lookup ? ` · lookup ${item.lookup}` : '';
        const control = item.evidence === 'rendered-control-id' ? 'on this page' : 'in the form layout';
        const hidden = item.hidden ? ' · hidden on the form' : '';
        return `${item.owner} · table ${item.entity ?? 'unknown'}${relationship}${lookup} · ${control}${hidden}`;
      };
      const native = (report.nativeComponents ?? []).filter((item) =>
        keep(item.name, item.id, item.kind, item.entity, item.owner, item.relationship),
      );
      groups.push(
        rgroup('runtime-native', 'Native grids, quick views and notes', native, (item) =>
          [
            rrow(item, {
              kind: nativeKind(item),
              title: item.name,
              sub: nativeSub(item),
              wrap: true,
            }),
            ...(item.metadataSources ?? []).map((source) =>
              rrow(source, { kind: 'metadata', title: source.name, sub: source.ref ?? '', depth: 1 }),
            ),
            ...(item.actions ?? []).map((action) => {
              const formName = action.formName ? `: ${action.formName}` : '';
              const modal = action.formId && !action.formName ? ' · opens a form in a pop-up' : '';
              const conditional = action.conditional ? ' · shown only when its condition is met' : '';
              return rrow(action, {
                kind: 'grid-action',
                title: `${action.name}${formName}`,
                sub: `grid action${modal}${conditional}`,
                depth: 1,
                wrap: true,
              });
            }),
          ].join(''),
        ),
      );
      const columnSub = (column) => {
        if (column.resolved === false) return 'column not found in your Solution sources';
        const required = column.required ? ' · required' : '';
        const maxLength = column.maxLength ? ` · max ${column.maxLength}` : '';
        let options = '';
        if (column.optionCount) {
          const more = column.optionCount > (column.options ?? []).length ? ' ...' : '';
          const labels = (column.options ?? []).map((option) => option.label).join(', ');
          options = ` · ${column.optionCount} options: ${labels}${more}`;
        }
        return `${column.label ?? column.name} · ${column.type ?? 'unknown type'}${required}${maxLength}${options}`;
      };
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
              kind: 'column',
              title: `${column.entity}.${column.name}`,
              sub: columnSub(column),
              chips: column.required ? '<span class="c info">required</span>' : '',
              find: `<LogicalName>${column.name}</LogicalName>`,
              acts: `<button class="ib" data-act="inspect-locate" data-field="${esc(column.name)}" title="Find this field on the page">${icon('locate')}</button>`,
            }),
          { collapsed: columns.length > 25 },
        ),
      );
      const USAGE_KIND = {
        entityform: 'basic-form',
        entitylist: 'list',
        webform: 'advanced-form',
        entityview: 'view',
        editable: 'editable',
        include: 'include',
        snippet: 'snippet',
        fetchxml: 'fetchxml',
      };
      const usageTitle = (usage) => {
        const kindName = (kindLabel(USAGE_KIND[usage.kind]) ?? [usage.kind, usage.kind])[1];
        if (!usage.reference) return `${kindName} chosen at run time`;
        const name = isGuid(usage.reference) ? nameOf(usage.reference) : usage.reference;
        return name ? `${kindName}: ${name}` : `${kindName} not in your sources`;
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
                  kind: 'list',
                  title: list.name,
                  sub: list.entity ? `table ${list.entity}` : '',
                })
              : rrow(
                  {},
                  {
                    kind: USAGE_KIND[usage.kind] ?? 'include',
                    title: usageTitle(usage),
                    // The Liquid line says more than the title only when the reference is chosen at run time.
                    sub: [usage.reference ? '' : usage.expression, ownerName(usage.owner)].filter(Boolean).join(' · '),
                    wrap: true,
                  },
                ),
          { collapsed: usages.length > 40 },
        ),
      );
      const renderedSub = (item) => [item.tag, item.type].filter(Boolean).join(' · ');
      const allControls = (report.renderedControls ?? []).filter((item) =>
        keep(item.id, item.name, item.field, item.entity),
      );
      const controls = allControls.filter((item) => item.evidence === 'rendered-and-source');
      const unmatched = allControls.length - controls.length;
      const unmatchedNote = (count) => {
        if (!count) return '';
        return count > 1
          ? `${count} more controls on this page match no source`
          : '1 more control on this page matches no source';
      };
      groups.push(
        rgroup(
          'runtime-rendered',
          'Rendered controls',
          controls,
          (item) =>
            rrow(item, {
              kind: 'control',
              title: item.field ?? item.name ?? item.id ?? item.tag,
              sub: renderedSub(item),
              acts:
                item.id || item.name
                  ? `<button class="ib" data-act="inspect-locate" data-field="${esc(item.id || item.name)}" title="Find this control on the page">${icon('locate')}</button>`
                  : '',
            }),
          {
            collapsed: controls.length > 25,
            note: unmatchedNote(unmatched),
          },
        ),
      );
      const apiSub = (item) => {
        const target = item.entity ? `table ${item.entity}` : 'table not found in your Solution sources';
        const evidence =
          item.evidence === 'observed-api-request' ? 'requested by this page' : 'referenced in source code';
        return `${target} · ${evidence}`;
      };
      groups.push(
        rgroup(
          'runtime-api',
          'Web API references',
          (report.apiReferences ?? []).filter((item) => keep(item.name, item.entity)),
          (item) =>
            rrow(item, {
              kind: 'api',
              title: `/_api/${item.name}`,
              sub: apiSub(item),
            }),
        ),
      );
      const logicKind = (item) => (['cloud-flow', 'plugin-step'].includes(item.kind) ? item.kind : 'logic');
      const logicSourceKind = (source) =>
        ['plugin-type', 'plugin-code'].includes(source.kind) ? source.kind : 'plugin-assembly';
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
                kind: logicKind(item),
                title: item.name,
                sub: item.kind === 'plugin-step' ? item.description : (item.description ?? item.path ?? ''),
                wrap: true,
              }),
              ...(item.sources ?? []).map((source) =>
                rrow(source, {
                  kind: logicSourceKind(source),
                  title: source.name,
                  sub:
                    source.kind === 'plugin-code'
                      ? 'Plug-in source (C#) · changes need a build and a deployment'
                      : 'Registration settings',
                  depth: 1,
                }),
              ),
            ].join(''),
        ),
      );
      const pcfSub = (item) => {
        let binding = 'not bound in your Solution sources';
        if (item.binding === 'native-formxml') {
          binding = `Bound on the form · ${item.selectedDesktop ? 'desktop' : 'other device type'} · portal ${item.enablement}`;
        } else if (item.binding === 'declared-schema-name') binding = 'Matched by schema name';
        else if (item.schemaName) binding = 'Matched by component setting';
        return `${item.expression} · ${binding}`;
      };
      const datasetSub = (dataset) => {
        let detail = 'table or view not found';
        if (dataset.resolved) {
          const view = dataset.viewName ? ` · ${dataset.viewName}` : '';
          detail = `${dataset.entity}${view} · ${dataset.fields?.length ?? 0} columns`;
        }
        return `${dataset.binding || 'no binding'} · ${detail}`;
      };
      groups.push(
        rgroup(
          'runtime-pcf',
          'Code components',
          (report.codeComponents ?? []).filter((item) => keep(item.name, item.schemaName, item.owner)),
          (item) =>
            [
              rrow(item, {
                kind: 'pcf',
                title: item.schemaName ?? item.name,
                sub: pcfSub(item),
                wrap: true,
              }),
              ...(item.formSourceFile
                ? [
                    rrow(item.formSource, {
                      kind: 'formxml',
                      title: item.owner,
                      sub: `${item.entity ?? ''}.${item.field ?? ''} · ${(item.boundAttributes ?? []).join(', ') || 'No bound columns'}`,
                      depth: 1,
                    }),
                  ]
                : []),
              ...(item.metadataSources ?? []).map((source) =>
                rrow(source, { kind: 'pcf-settings', title: source.name, sub: 'Column settings', depth: 1 }),
              ),
              ...(item.datasets ?? []).map((dataset) =>
                rrow(dataset, {
                  kind: 'dataset',
                  title: dataset.name,
                  sub: datasetSub(dataset),
                  depth: 1,
                }),
              ),
              ...(item.resources ?? []).map((resource) =>
                rrow(resource, {
                  kind: 'pcf-file',
                  title: resource.ref ?? resource.url,
                  sub: resource.name,
                  depth: 1,
                }),
              ),
            ].join(''),
        ),
      );
      const assetKind = (item) => (report.modelDriven ? 'web-resource' : fileKind({ url: item.url }));
      groups.push(
        rgroup(
          'runtime-assets',
          report.modelDriven ? 'Web resources of your Solutions' : 'Web files used on this page',
          (report.assets ?? []).filter((item) => keep(item.name, item.url, item.ref)),
          (item) =>
            rrow(item, {
              kind: assetKind(item),
              title: item.url,
              sub: `${item.evidence === 'rendered-asset' ? 'loaded on this page' : 'referenced in source'} · ${item.ref ?? 'no local file'}`,
            }),
        ),
      );
      // Markup reads as what it is ("HTML · 1 line · link"); plain text as itself, shortened.
      const snippetSub = (snippet) => {
        if (snippet.deleted) return 'removed locally';
        if (snippet.value == null) return '';
        const value = String(snippet.value);
        const tags = [...new Set([...value.matchAll(/<([a-z][a-z0-9-]*)/gi)].map((match) => match[1].toLowerCase()))];
        if (tags.length) {
          const lines = value.split(/\r?\n/).filter((line) => line.trim()).length;
          return `HTML · ${lines} line${lines === 1 ? '' : 's'} · ${tags.slice(0, 3).join(', ')}${tags.length > 3 ? ' ...' : ''}`;
        }
        return `“${value.length > 120 ? value.slice(0, 117) + '...' : value}”`;
      };
      const snippets = (report.snippets ?? []).filter((snippet) => keep(snippet.name, snippet.value, snippet.ref));
      groups.push(
        rgroup(
          'runtime-snippets',
          'Content snippets',
          snippets,
          (snippet) =>
            rrow(snippet, {
              kind: 'snippet',
              title: snippet.name,
              sub: snippetSub(snippet),
              subTitle: snippet.value ?? '',
              chips: snippet.overridden ? '<span class="c info">local override</span>' : '',
              acts:
                (snippet.value
                  ? `<button class="ib" data-act="copy" data-copy="${esc(snippet.value)}" data-copy-kind="value" title="Copy the snippet value">${icon('copy')}</button>`
                  : '') +
                simButton(
                  `portal?kind=snippets&name=${encodeURIComponent(snippet.name)}`,
                  'Edit this snippet in Mirage admin',
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
              kind: 'setting',
              title: setting.name,
              sub: setting.deleted ? 'removed locally' : `= ${setting.value ?? ''}`,
              chips: setting.overridden ? '<span class="c info">local override</span>' : '',
              find: setting.recordId ?? setting.name,
              acts: simButton(
                `portal?kind=settings&name=${encodeURIComponent(setting.name)}`,
                'Edit this setting in Mirage admin',
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
      const relatedRow = ({ kind, item }) => {
        if (kind === 'link')
          return rrow(item, {
            kind: 'link',
            title: item.name,
            sub: `web link in ${item.set ?? 'an unknown set'}`,
            find: item.id,
          });
        if (kind === 'marker') return rrow(item, { kind: 'marker', title: item.name, find: item.id });
        if (kind === 'redirect') {
          const name = item.name ? ` · ${item.name}` : '';
          return rrow(item, {
            kind: 'redirect',
            title: `/${String(item.inboundUrl ?? '').replace(/^\//, '')}`,
            sub: `redirect ${item.statusCode ?? ''} to this page${name}`,
            find: item.id,
          });
        }
        return rrow(item, { kind: 'shortcut', title: item.title ?? item.name, find: item.id });
      };
      groups.push(rgroup('runtime-related', 'Related metadata', relatedItems, relatedRow));
      const unresolved = (report.unresolved ?? []).filter((item) =>
        keep(item.name, item.expression, item.kind, item.reason, item.owner),
      );
      groups.push(
        rgroup(
          'runtime-unresolved',
          'Not found in your sources',
          unresolved,
          (item) => {
            const owner = item.owner ? ` · ${esc(ownerName(item.owner))}` : '';
            const kindName = (kindLabel(USAGE_KIND[item.kind] ?? item.kind) ?? [])[1] ?? '';
            const kindTag = kindName ? '<span class="what">' + esc(kindName) + '</span>' : '';
            return `<div class="row wrapt">${ico('unresolved', 'warn')}<div class="main"><div class="name"><span>${hl(item.expression ?? item.name ?? kindName ?? 'Dependency')}</span>${kindTag}</div><div class="sub">${hl(item.reason ?? item.message ?? '')}${owner}</div></div></div>`;
          },
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
      const shownGroups = groups.filter(
        (group) =>
          S.inspectSection === 'all' || sectionOf[/data-group="([^"]+)"/.exec(group)?.[1]] === S.inspectSection,
      );
      const listed = shownGroups.join('');
      // A closed group draws its header without the "openg" class; the search row's fold button follows it.
      S.inspectAnyClosed = shownGroups.some((group) => group.includes('class="gh"'));
      S.inspectGroups = shownGroups.length > 0;
      return (
        head +
        out +
        (listed ||
          emptyState(
            S.q ? 'Nothing matches' : 'Nothing in this section',
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
                a.key.localeCompare(b.key, 'en'),
            ),
        };
      return personaOrderCache.ordered.filter(
        (entry) =>
          entry.persona &&
          entry.persona.active !== false &&
          terms.every((term) => entry.text.includes(term)) &&
          ['roles', 'tags', 'accounts'].every(
            (facet) => !query[facet]?.length || query[facet].some((value) => entry[facet].includes(personaFold(value))), // NOSONAR: callbacks capture request-scoped state
          ) &&
          (query.any ?? []).every((facet) => personaFacetValues(entry, facet).length > 0) &&
          (!query.groups?.length || query.groups.map(personaFold).includes(entry.group)) &&
          (!query.subgroups?.length ||
            query.subgroups.some((value) => personaFold(value) === `${entry.group}:${entry.subgroup}`)),
      );
    };
    const PERSONA_FACETS = ['roles', 'tags', 'accounts', 'groups', 'subgroups'];
    const personaFilterCount = (query = S.personaFilters ?? {}) =>
      PERSONA_FACETS.reduce((total, key) => total + (query[key]?.length ?? 0), 0) + (query.any?.length ?? 0);
    const personaFacetValues = (entry, name) => {
      if (name === 'groups') return entry.group && entry.group !== '__other' ? [entry.group] : [];
      if (name === 'subgroups') return entry.subgroup ? [`${entry.group}:${entry.subgroup}`] : [];
      return entry[name] ?? [];
    };
    // The persona list: pinned, recent and default personas first (each listed once), then the catalogue groups as the
    // panel's group headers, 50 rows a page. A row signs this browser in (or sets the runtime persona) in one click.
    const personaRowsHtml = () => {
      const matching = personaMatches(),
        preferences = personaPreferences(),
        session = S.tweaks?.session?.supported ? S.tweaks.session : null,
        filtering = Boolean(S.personaFilters?.q) || personaFilterCount() > 0,
        offset = Math.max(0, Math.min(S.personaPage ?? 0, Math.max(0, matching.length - 1))),
        paged = matching.length > 50,
        pageRows = new Set(matching.slice(offset, offset + 50));
      const row = (entry) => {
        const p = entry.persona,
          name = p.label ?? p.name ?? p.contactId,
          pinned = preferences.pinned.includes(entry.key);
        const setup = p.context
          ? `isolated setup in Mirage admin: ${S.tweaks.personaCatalog?.contexts?.find((c) => c.id === p.context)?.label ?? p.context}`
          : '';
        const facts = [(p.roles ?? []).join(', ') || 'no web roles', p.tags?.join(', '), p.account?.name, setup]
          .filter(Boolean)
          .join(' · ');
        const contact = p.name && p.name !== name ? `<span class="what">${esc(p.name)}</span>` : '';
        const description = p.description
          ? `<div class="sub" title="${esc(p.description)}">${esc(p.description.split(/\r?\n/, 1)[0])}</div>`
          : '';
        const use = session
          ? ['signin', `Sign in as ${name}`, "through the portal's sign-in, in this browser only"]
          : ['persona', `Use ${name}`, 'pages without their own sign-in run as this persona'];
        // The persona this browser is signed in as is marked, and signing in as it again is not offered.
        const current = Boolean(session?.signedIn && p.contactId && p.contactId === session.contactId);
        const signedIn = current ? '<span class="c ok">signed in</span>' : '';
        const [useTitle, useLabel] = current
          ? ['This browser is signed in as ' + name, 'Signed in as ' + name]
          : [use[1] + ': ' + use[2], use[1]];
        const useButton = `<button class="ib" data-act="${use[0]}" data-contact="${esc(p.contactId)}" data-key="${esc(entry.key)}" title="${esc(useTitle)}" aria-label="${esc(useLabel)}"${current ? ' disabled' : ''}>${icon('signin')}</button>`;
        const favoriteTitle = pinned
          ? 'Remove ' + name + ' from favorites'
          : 'Add ' + name + ' to favorites: favorites stay on top in this browser';
        const defaultChip = p.default ? '<span class="c muted" title="The Mirage default persona">default</span>' : '';
        return `<div class="row wrapt" data-panel-persona-row="${esc(entry.key)}"${current ? ' aria-current="true"' : ''}><div class="main"><div class="name"><span>${esc(name)}</span>${contact}${defaultChip}${signedIn}</div>${description}<div class="sub">${esc(facts)}</div></div><div class="acts"><button class="ib${pinned ? ' on' : ''}" data-act="pinpersona" data-key="${esc(entry.key)}" aria-pressed="${pinned}" title="${esc(favoriteTitle)}">${icon(pinned ? 'starred' : 'star')}</button>${useButton}</div></div>`;
      };
      // A group header as on every tab. Unless a search or filter narrows the list, a group starts folded when it has no
      // row on this page, or (on an unpaged list) more than 25 rows.
      const section = (id, title, entries, count = entries.length, more = '') => {
        if (!count) return '';
        S.defaults[id] = !filtering && (!entries.length || (!paged && count > 25));
        const closed = S.ui.collapsed[id] ?? S.defaults[id];
        return `<div class="group" data-group="${esc(id)}"><button class="gh${closed ? '' : ' openg'}" data-act="fold" data-id="${esc(id)}" aria-expanded="${!closed}">${icon('right')}<span>${esc(title)}</span><span class="n dimn">${count}</span><span class="line"></span></button>${closed ? '' : entries.map(row).join('') + more}</div>`;
      };
      const listed = new Set();
      const shortcut = (id, title, keys) => {
        const byKey = new Map(matching.map((entry) => [entry.key, entry]));
        const entries = keys
          .map((key) => byKey.get(key))
          .filter((entry) => entry && !listed.has(entry))
          .slice(0, 10);
        for (const entry of entries) listed.add(entry);
        return section(id, title, entries);
      };
      const shortcuts = offset
        ? ''
        : shortcut('persona:pinned', 'Favorites', preferences.pinned) +
          shortcut('persona:recent', 'Recent', preferences.recent) +
          shortcut(
            'persona:default',
            'Default',
            matching.filter((entry) => entry.persona.default).map((entry) => entry.key),
          );
      const groups = [
        ...(S.tweaks?.personaCatalog?.groups ?? []).filter((group) =>
          matching.some((entry) => entry.persona.group === group.id),
        ),
        { id: '__other', label: 'Other contacts' },
      ];
      // The entries of one group and subgroup not listed above, and those of them on this page.
      const sectionEntries = (groupId, subId) => {
        const all = [],
          shown = [];
        for (const entry of matching) {
          if ((entry.group || '__other') !== groupId || (entry.persona.subgroup || '') !== subId || listed.has(entry))
            continue;
          all.push(entry);
          if (pageRows.has(entry)) shown.push(entry);
        }
        return { all, shown };
      };
      // One header per group and subgroup ("Group / Subgroup"): a single level, like every other list in the panel.
      const groupHtml = (group) =>
        [{ id: '', label: '' }, ...(group.subgroups ?? [])]
          .map((sub) => {
            const { all, shown } = sectionEntries(group.id, sub.id);
            const more =
              paged && shown.length < all.length
                ? `<button class="morebtn" data-act="persona-group" data-group="${esc(group.id)}">Show only the ${all.length} ${esc(group.label)}</button>`
                : '';
            return section(
              `persona:${group.id}:${sub.id}`,
              sub.id ? `${group.label} / ${sub.label}` : group.label,
              shown,
              all.length,
              more,
            );
          })
          .join('');
      const range = `${matching.length ? offset + 1 : 0}–${Math.min(offset + 50, matching.length)} of ${matching.length} personas`;
      const previous = offset
        ? '<button class="btn sec" data-act="persona-page" data-direction="-1">Previous</button>'
        : '';
      const following =
        offset + 50 < matching.length
          ? '<button class="btn sec" data-act="persona-page" data-direction="1">Show more</button>'
          : '';
      const paging = paged ? `<div class="tw">${previous}${following}</div>` : '';
      // The count is announced always and shown only when the list is paged.
      return `<p class="${paged ? 'dim' : 'sr'}" role="status" data-panel-persona-count>${range}</p>${shortcuts}${groups.map(groupHtml).join('')}${matching.length ? '' : '<p class="dim">No personas match. Clear a filter or use fewer terms.</p>'}${paging}`;
    };
    const personaPickerHtml = () => {
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
      const facetValues = (entry, name) => (name === 'groups' ? [entry.group] : personaFacetValues(entry, name));
      // A filter offers only values that still match something (and keeps the ones selected).
      for (const facet of facets) {
        const [name] = facet,
          available = new Set();
        for (const entry of personaMatches({ ...query, [name]: [] })) {
          const values = facetValues(entry, name);
          for (const value of values) available.add(personaFold(value));
        }
        facet[2] = facet[2].filter((item) => available.has(personaFold(item.id)) || query[name]?.includes(item.id));
      }
      const active = personaFilterCount(query),
        open = S.personaFilterDisclosureOpen ?? active > 0;
      const chip = (name, item) => {
        const on = Boolean(query[name]?.includes(item.id));
        return `<button class="f${on ? ' on' : ''}" data-act="persona-facet" data-facet="${name}" data-v="${esc(item.id)}" aria-pressed="${on}">${esc(item.label)}</button>`;
      };
      // Filters are the panel's toggle chips; a long facet shows its first values and the selected ones.
      const facetHtml = ([name, label, options]) => {
        const shown = options.filter((item, index) => index < 24 || query[name]?.includes(item.id));
        // Every facet starts with the same "any" chip: personas that have any value of it.
        const anyOn = Boolean(query.any?.includes(name));
        const any = `<button class="f${anyOn ? ' on' : ''}" data-act="persona-any" data-facet="${name}" aria-pressed="${anyOn}" title="Only personas with any ${label.toLowerCase()}">any</button>`;
        const hidden = options.length - shown.length;
        const more = hidden ? '<span class="lbl2">+' + hidden + ': search finds them</span>' : '';
        return `<div class="pp-facet" role="group" aria-label="${label}"><span class="lbl2">${label}</span><div class="pp-chips">${any}${shown.map((item) => chip(name, item)).join('')}${more}</div></div>`;
      };
      const facetArea = open
        ? `<div class="pp-facets" data-panel-persona-facets>${facets
            .filter(([, , options]) => options.length)
            .map(facetHtml)
            .join('')}</div>`
        : '';
      const activeNote = active ? ` · ${active} active` : '';
      const clear =
        active || query.q
          ? `<button class="ib" data-act="persona-clear" title="Clear the search and filters">${icon('close')}</button>`
          : '';
      return `<div class="pp-persona-picker"><div class="pp-find"><label class="search">${icon('search')}<input type="search" data-panel-persona-query value="${esc(query.q)}" aria-label="Find a persona" placeholder="Find a persona: name, account, role, tag"><kbd>/</kbd></label><button class="ib${active ? ' on' : ''}" data-act="persona-filters" aria-expanded="${open}" aria-label="Filters${activeNote}" title="Filter by web role, tag, account or group${activeNote}">${icon('filter')}</button>${clear}<button class="ib" data-act="sim" data-hash="identity" title="Open the persona picker in Mirage admin: details, editing and isolated setups">${icon('sim')}</button></div>${facetArea}<div data-panel-persona-results>${personaRowsHtml()}</div></div>`;
    };
    /* NOSONAR: single-pass routine, splitting it would change shared state */ const refreshPersonaRows = () => {
      // Recompute available facets as well as rows, preserving the focused search/control.
      const picker = el.panel.querySelector('.pp-persona-picker');
      if (!picker) return;
      const active = root.activeElement,
        search = active?.hasAttribute('data-panel-persona-query'),
        selection = search ? [active.selectionStart, active.selectionEnd] : null;
      const identity = active && picker.contains(active) ? { tag: active.tagName, data: { ...active.dataset } } : null;
      picker.outerHTML = personaPickerHtml();
      delete S.html.body;
      const replacement = identity
        ? [...el.panel.querySelectorAll('.pp-persona-picker button,.pp-persona-picker input')].find(
            (node) =>
              node.tagName === identity.tag &&
              Object.entries(identity.data).every(([key, value]) => node.dataset[key] === value),
          )
        : null;
      // A control that is gone hands focus to its sibling (the other paging button), else to the persona search.
      const fallback = () =>
        (identity.data.act &&
          el.panel.querySelector(`.pp-persona-picker [data-act="${globalThis.CSS.escape(identity.data.act)}"]`)) ||
        el.panel.querySelector('.pp-persona-picker [data-panel-persona-query]');
      if (identity) (replacement ?? fallback())?.focus({ preventScroll: true });
      if (search && selection)
        try {
          replacement?.setSelectionRange(...selection);
        } catch {
          /* Optional inspection or cleanup failure must not interrupt the owning operation. */
        }
    };

    /** How the portal signs in through an identity provider: its name, type, callback and local port. */
    const providerSignIn = (provider, idp) => {
      const type = provider.type ? ' (' + provider.type + ')' : '';
      const port = idp.port ? ' · local identity provider on port ' + idp.port : '';
      return `Signs in through ${provider.caption ?? provider.name ?? provider.id}${type} · callback ${provider.callbackPath ?? 'not reported'}${port}`;
    };
    /** How the portal signs in without one: the local page, and why ("; external sign-in is off (...)."). */
    const localSignIn = (reason) => {
      if (!reason) return 'Signs in on the local sign-in page.';
      const sentence = reason.charAt(0).toLowerCase() + withoutFullStop(reason.slice(1)) + '.';
      return `Signs in on the local sign-in page; ${sentence}`;
    };
    /* NOSONAR: single-pass routine, splitting it would change shared state */ const tweaksHtml = () => {
      const runtime = S.d.mirage;
      if (S.d.mirageMode && !runtime) return loadingState('Connecting to Mirage…', '');
      // A failed read stays shown until a navigation or this control reads the runtime again.
      if (runtime?.active === false && runtime.error)
        return (
          emptyState('Mirage is not active', esc(runtime.error)) +
          '<button class="btn" data-act="inspect-refresh">Read again</button>'
        );
      if (!runtime?.active) return emptyState('Mirage is not active', 'Tweaks change the local Mirage runtime.');
      const t = S.tweaks;
      // A refresh keeps the current Tweaks (the body is aria-busy meanwhile), so an open
      // confirmation and its keyboard focus survive a newer runtime version.
      if (!t) return loadingState('Loading local setup…', 'Reading personas, permissions and scenarios.');
      if (!t.ok)
        return (
          emptyState('Tweaks unavailable', esc(t.error ?? '')) +
          '<button class="btn" data-act="tweaks-retry">Retry</button>'
        );
      let out = '';
      if (S.confirm)
        out += `<div class="banner" role="alertdialog" aria-label="Confirm local setup"><span class="grow">${esc(S.confirm.text)}</span><button class="btn" data-act="confirm-yes">${esc(S.confirm.label)}</button><button class="btn sec" data-act="confirm-no">Cancel</button></div>`;
      const option = (value, label, selected) =>
        `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
      const scenarioLabel = (item) => {
        const name = item.name ?? item.id;
        if (!item.catalogue) return name;
        const context = item.context ? ', isolated setup' : '';
        return `${name} (${item.persona} at ${item.startPath ?? '/'}${context})`;
      };
      const session = t.session?.supported ? t.session : null;
      const noPersonas =
        '<div class="dim">No local personas yet: create one in Mirage admin, Identity &amp; permissions.</div>';
      if (session) {
        // This browser's own sign-in session (a cookie): not the Mirage default persona. One line says who this browser
        // is; how the portal signs in is its tooltip: the site's identity provider (the local stand-in on loopback), or
        // the local persona sign-in page when the site has no external provider.
        const idp = session.identityProvider;
        const provider = idp?.available ? idp.provider : null;
        const via = provider ? providerSignIn(provider, idp) : localSignIn(idp?.reason);
        const who = session.signedIn
          ? `Signed in as <b>${esc(session.name ?? session.contactId)}</b>`
          : '<b>Not signed in</b>';
        const override =
          session.roleSource === 'override'
            ? ' <span class="c warn" title="Set in Mirage admin: the roles of this signed-in session are overridden">Simulation override</span>'
            : '';
        const signout = session.signedIn
          ? `<button class="btn sec" data-act="signout" title="Sign out through the portal's own sign-out; other browsers keep their sessions">Sign out</button>`
          : '';
        const account = session.accountId ? ` · account ${session.accountId}` : '';
        const sessionError = session.error ? '<div class="dim">' + esc(session.error) + '</div>' : '';
        out += `<div class="card"><div class="path">Browser session</div><div class="tw who" data-idp="${provider ? 'external' : 'local'}" title="${esc(via + account)}"><span class="grow">${who} · ${esc((session.roles ?? []).join(', ') || 'no web roles')}${override}</span>${signout}</div>${sessionError}${t.personas.length ? personaPickerHtml() : noPersonas}</div>`;
      } else {
        // No sign-in sessions: the runtime persona serves every request without one.
        const current = t.identity?.contactId
          ? `Pages run as <b>${esc(t.identity.name ?? t.identity.contactId)}</b>`
          : '<b>Anonymous visitor</b>';
        const anonymous = t.identity?.contactId
          ? '<button class="btn sec" data-act="persona" data-contact="" title="Run pages without their own sign-in anonymously; pages reload">Anonymous</button>'
          : '';
        out += `<div class="card"><div class="path">Persona</div><div class="tw who"><span class="grow">${current} · ${esc((t.identity?.roles ?? []).join(', ') || 'no web roles')}</span>${anonymous}</div>${t.personasAvailable ? personaPickerHtml() : '<div class="dim">This Mirage does not report personas.</div>'}</div>`;
      }
      const permissionButton = ([value, label]) => {
        const title =
          value === 'enforce'
            ? 'Apply table permissions, web roles and scopes'
            : 'Sandbox: every identity may read and write all local tables';
        return `<button class="${t.permissionMode === value ? 'on' : ''}" data-act="permissions" data-v="${value}" aria-pressed="${t.permissionMode === value}" title="${title}">${label}</button>`;
      };
      const PERMISSION_SOURCE = {
        exported: 'Rules from your sources',
        configured: 'Rules set in Mirage admin',
        combined: 'Rules from your sources and Mirage admin',
      };
      const permissionSource = PERMISSION_SOURCE[t.permissionSource]
        ? `<span class="dim">${PERMISSION_SOURCE[t.permissionSource]}</span>`
        : '';
      out += `<div class="card"><div class="path">Table permissions</div><div class="tw"><span class="seg" role="group" aria-label="Table permissions">${[
        ['enforce', 'Enforce'],
        ['permissive', 'Permissive'],
      ]
        .map(permissionButton)
        .join('')}</span>${permissionSource}</div></div>`;
      if (t.scenarios.length) {
        const pick = S.pick.scenario ?? t.activeScenario?.id ?? t.scenarios[0].id;
        const activeNote = t.activeScenario ? `active: ${esc(t.activeScenario.name ?? t.activeScenario.id)}` : '';
        const scenarioOptions = t.scenarios
          .map((item) => option(item.id, scenarioLabel(item), pick === item.id))
          .join('');
        out += `<div class="card"><div class="path">Scenario <span class="dim">${activeNote}</span></div><div class="tw"><select data-pick="scenario" aria-label="Scenario">${scenarioOptions}</select><button class="btn" data-act="ask" data-kind="scenario" title="Apply its preset, persona and permission mode in one step; pages reload">Apply scenario</button></div></div>`;
      }
      if (t.presets.length) {
        const pick = S.pick.preset ?? t.presets[0].id;
        const chosen = t.presets.find((item) => item.id === pick);
        const presetNote = chosen?.description ? `<div class="dim">${esc(chosen.description)}</div>` : '';
        out += `<div class="card"><div class="path">Preset</div><div class="tw"><select data-pick="preset" aria-label="Preset">${t.presets.map((item) => option(item.id, item.name ?? item.id, pick === item.id)).join('')}</select><button class="btn" data-act="ask" data-kind="preset" title="Replace the local data with this preset; pages reload">Apply preset</button></div>${presetNote}</div>`;
      }
      return out;
    };

    // The Mirage tab: the runtime this page runs on and the Mirage admin pages for it, as the panel's rows.
    const MIRAGE_ICON = {
      runtime: ['sim', 'Local Mirage runtime'],
      diagnostics: ['alert', 'Runtime findings'],
      requests: ['swap', 'Requests of this page'],
      policy: ['shield', 'Content policy'],
      identity: ['user', 'Personas and permissions'],
      setting: ['setup', 'Site settings and content snippets'],
      administration: ['grid', 'Mirage admin'],
      address: ['link', 'Page address'],
      table: ['table', 'Table records'],
    };
    const mirageRow = (name, { kind, sub = '', path = '', what = '', chips = '', hash, act, title, acts = '' }) => {
      const subLine = path
        ? `<div class="sub path"><bdi>${esc(path)}</bdi></div>`
        : sub && `<div class="sub">${esc(sub)}</div>`;
      const whatTag = what ? '<span class="what">' + esc(what) + '</span>' : '';
      const body = `<div class="name"><span>${esc(name)}</span>${whatTag}${chips}</div>${subLine}`;
      const target = hash === undefined ? `data-act="${act}"` : `data-act="sim" data-hash="${esc(hash)}"`;
      const main =
        act || hash !== undefined
          ? `<button class="main" ${target} title="${esc(title)}">${body}</button>`
          : `<div class="main">${body}</div>`;
      // Every row here opens a Mirage admin page: the Mirage icon, as in the header and on Tweaks.
      const open =
        act || hash !== undefined ? `<button class="ib" ${target} title="${esc(title)}">${icon('sim')}</button>` : '';
      return `<div class="row wrapt">${icoIcon(...(MIRAGE_ICON[kind] ?? ['sim', 'Mirage']))}${main}<div class="acts">${acts}${open}</div></div>`;
    };
    // Loopback confinement of local pages (an opt-in Content-Security-Policy) and its exceptions; null when unknown.
    const contentPolicyText = (s) => {
      if (typeof s.confinePortalPages !== 'boolean') return null;
      if (!s.confinePortalPages) return 'Not confined: pages carry only the headers their site settings define';
      const plural = s.externalFrameOrigins === 1 ? '' : 's';
      const frames = s.externalFrameOrigins
        ? `${s.externalFrameOrigins} online embed origin${plural} allowed`
        : 'no online embedded content';
      return `Confined to loopback · external assets ${s.externalAssets ? 'allowed' : 'blocked'} · ${frames}`;
    };
    const mirageHtml = () => {
      const runtime = S.d.mirage;
      if (!runtime) return loadingState('Connecting to Mirage…', '');
      if (runtime.active === false && runtime.error)
        return (
          emptyState('Mirage is not active', esc(runtime.error)) +
          '<button class="btn" data-act="inspect-refresh">Read again</button>'
        );
      if (!runtime.active) return emptyState('Mirage is not active', '');
      // The runtime's Tweaks read adds rows (content policy, records) above others: until it answered, the tab waits, so
      // a row is never replaced under the pointer between pressing and releasing a button.
      if (!S.tweaks && S.tweaksLoading !== null) return loadingState('Reading the Mirage runtime…', '');
      const t = S.tweaks?.ok ? S.tweaks : null;
      // The pushed runtime status is the current one; the Tweaks read adds what it alone reports (content policy).
      const s = {
        ...t?.status,
        ...Object.fromEntries(Object.entries(runtime.status ?? {}).filter(([, value]) => value != null)),
      };
      const diagnostics = Number(s.diagnostics?.total ?? s.diagnostics ?? 0);
      const reload =
        (s.reloading ? '<span class="c warn">reloading sources</span>' : '') +
        (s.pendingReload ? '<span class="c warn">' + pendingReloadText(s) + '</span>' : '');
      const policy = contentPolicyText(s);
      const id = pageRecordId();
      const rows = [
        mirageRow(s.site ?? S.d.site, {
          kind: 'runtime',
          what: s.format ?? 'portal source',
          sub: s.revision == null ? '' : `revision ${s.revision}`,
          chips: reload,
        }),
        mirageRow('Diagnostics', {
          kind: 'diagnostics',
          chips: `<span class="c ${diagnostics ? 'warn' : 'muted'}">${diagnostics}</span>`,
          hash: 'activity?tab=findings',
          title: 'Open the findings of this runtime in Mirage admin',
        }),
        mirageRow('Requests for this page', {
          kind: 'requests',
          sub: location.pathname,
          hash: `audit?path=${encodeURIComponent(location.pathname)}`,
          title: 'Open the requests this page made in Mirage admin',
        }),
        policy &&
          `<div data-policy="${s.confinePortalPages ? 'confined' : 'open'}">${mirageRow('Content policy', {
            kind: 'policy',
            sub: policy,
            hash: 'connection',
            title: 'Change the content policy of local pages in Mirage admin',
          })}</div>`,
        mirageRow('Personas & permissions', {
          kind: 'identity',
          hash: 'access',
          title: 'Edit personas, web roles and table permissions in Mirage admin',
        }),
        mirageRow('Settings & snippets', {
          kind: 'setting',
          hash: 'portal',
          title: 'Edit site settings and content snippets in Mirage admin',
        }),
        mirageRow('Administration', { kind: 'administration', act: 'admin', title: 'Open Mirage admin' }),
        mirageRow('Local URL', {
          kind: 'address',
          path: location.href,
          acts: `<button class="ib" data-act="copypage" title="Copy the local address of this page">${icon('copy')}</button>`,
        }),
      ];
      const records = (t?.tables ?? []).map((table) =>
        mirageRow(table, {
          kind: 'table',
          sub: id ? 'at this page’s record' : '',
          hash: recordsHash(table),
          title: `Open the ${table} records${id ? ' at this page’s id' : ''} in Mirage admin`,
        }),
      );
      return rows.filter(Boolean).join('') + group('mirage-records', 'Records', records);
    };

    const issueKind = (p) => {
      if (p.type === 'http' || p.type === 'failed') return ['request', 'bad'];
      if (['deploy', 'baseline', 'note', 'warning'].includes(p.type)) return [p.type, 'warn'];
      return ['error', 'bad'];
    };
    const issueRow = (p) => {
      const kind = issueKind(p);
      const line = p.line ? ':' + p.line : '';
      const where = p.rel ? `${p.rel}${line}` : (p.where ?? '');
      const status = p.status ? `<span class="c bad">${p.status}</span>` : '';
      const localBadge =
        p.rel && p.type !== 'deploy' && p.type !== 'note'
          ? '<span class="c info" title="Comes from one of your local files">local</span>'
          : '';
      const count = p.count > 1 ? `<span class="c act">${p.count} times</span>` : '';
      const main = `<div class="name"><span>${hl(p.text)}</span>${status}${localBadge}${count}</div><div class="sub">${hl(where)}</div>`;
      const mainLine = p.line ? ' at line ' + p.line : '';
      const timeTag = p.at ? `<span class="time">${clock(p.at)}</span>` : '';
      const mainHtml = p.rel
        ? `<button class="main" data-act="open" title="Open ${esc(baseName(p.rel))} in the editor${mainLine}">${main}</button>`
        : `<div class="main">${main}</div>`;
      // A message that explains a raw error copies the raw error, for a bug report or a search.
      return `<div class="row wrapt" data-rel="${esc(p.rel ?? '')}" data-line="${p.line ?? ''}" data-col="${p.col ?? ''}" data-text="${esc(p.detail ?? p.text)}">
        ${ico(kind[0], kind[1])}
        ${mainHtml}
        ${timeTag}
        <div class="acts"><button class="ib" data-act="copytext" title="${p.detail ? 'Copy the Git error' : 'Copy the message'}">${icon('copy')}</button></div>
      </div>`;
    };
    const issuesHtml = () => {
      const d = S.d;
      const keep = (p) => (!S.ui.localOnly || p.rel) && matches(p.text, p.rel ?? '', p.where ?? '');
      const deploy = d.needsDeploy.map((n) => ({ type: 'deploy', text: n.reason, rel: n.rel })).filter(keep);
      const notes = d.notes
        .filter((n) => n.kind !== 'baseline')
        .map((n) => ({ type: 'note', text: n.reason, rel: n.rel }))
        .filter(keep);
      const baseline = d.notes
        .filter((n) => n.kind === 'baseline')
        .map((n) => ({ type: 'baseline', text: n.reason, detail: n.detail }))
        .filter(keep);
      const errors = d.problems.filter((p) => p.type === 'error' || p.type === 'console').filter(keep);
      const net = d.problems.filter((p) => p.type === 'http' || p.type === 'failed').filter(keep);
      const warnings = d.problems.filter((p) => p.type === 'warning').filter(keep);
      const lists =
        group('deploy', 'Needs deployment or a source fix', deploy.map(issueRow)) +
        group('baseline', 'Comparison unavailable', baseline.map(issueRow)) +
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
            : 'JavaScript errors, failed requests and changes that need deployment show up here.',
        )
      );
    };

    const activityKind = (a) => {
      if (a.type === 'fault') return ['error', 'bad'];
      if (a.type === 'signin' || a.type === 'action') return [a.type, a.failed ? 'bad' : ''];
      if (a.type === 'dialog' || a.type === 'deploy') return [a.type, 'warn'];
      if (a.type === 'switch') return ['switch', ''];
      return a.how === 'css' ? ['style-swap', ''] : ['save', ''];
    };
    const activityHtml = () => {
      const rows = S.d.activity
        .filter((a) => matches(a.text, (a.files ?? []).join(' ')))
        .map((a) => {
          const kind = activityKind(a);
          const files = a.files?.length ? `<div class="sub">${hl(a.files.join(', '))}</div>` : '';
          return `<div class="row wrapt">${ico(kind[0], kind[1])}<div class="main"><div class="name"><span>${hl(a.text)}</span></div>${files}</div><span class="time">${clock(a.at)}</span></div>`;
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
        if (names.includes(q)) return 0;
        return names.some((n) => n.startsWith(q)) ? 1 : 2;
      };
      const found = S.catalog.filter((c) => matches(c.title ?? '', c.url ?? '', c.rel ?? ''));
      if (q) found.sort((a, b) => rank(a) - rank(b));
      const rows = found.slice(0, 150).map((c) => {
        const kind = c.t === 'page' ? 'page' : fileKind(c);
        const sub = [c.url, c.rel].filter(Boolean).join(' · ');
        const isPage = c.t === 'page';
        const goButton = c.url
          ? `<button class="ib" data-act="go" title="Go to ${esc(c.url)}">${icon('go')}</button>`
          : '';
        const label = c.title || shortName(c.rel);
        const openTitle = `Open ${esc(label)} in the editor`;
        return `<div class="row" data-rel="${esc(c.rel ?? '')}" data-path="${esc(c.path ?? '')}" data-url="${esc(c.url ?? '')}" data-label="${esc(label)}">
          ${ico(kind, '', label)}
          <button class="main" data-act="${isPage || !c.rel ? 'go' : 'open'}" title="${isPage || !c.rel ? `Go to ${esc(c.url)}` : openTitle}">
            <div class="name"><span>${hl(label)}</span></div>${pathLine(sub, hl(displayPath(sub)))}
          </button>
          <div class="acts">
            ${goButton}
            <button class="ib" data-act="${c.rel ? 'copy' : 'copyurl'}" title="Copy the ${c.rel ? 'file path' : 'address'}">${icon('copy')}</button>
          </div>
        </div>`;
      });
      // The count says something only when the search narrows the list or the list is cut.
      const cut = found.length > 150 ? '<span class="lbl2">first 150 shown</span>' : '';
      const head =
        found.length < S.catalog.length || cut
          ? `<div class="filters"><span class="lbl2">Matches</span><span class="n dimn">${found.length}</span>${cut}</div>`
          : '';
      return (
        head +
        (rows.join('') || emptyState('Nothing found', 'Try part of a page address, a file name or a template name.'))
      );
    };

    const diffHtml = () => {
      const f = S.diff;
      if (f.loading)
        return (
          `<div class="dhead"><button class="ib" data-act="closediff" title="Back (Esc)">${icon('back')}</button><span class="t">${esc(baseName(f.rel))}</span></div>` +
          loadingState('Comparing sources…', 'You can go back while the comparison runs.')
        );
      const counts = f.ok ? `<b class="plus">+${f.added}</b> <b class="minus">&minus;${f.removed}</b>` : '';
      const head = `<div class="dhead"><button class="ib" data-act="closediff" title="Back (Esc)">${icon('back')}</button><span class="t" title="${esc(f.rel)}">${esc(baseName(f.rel))}</span>
        <span class="lbl2">local vs ${esc(f.against ?? '')}</span><span class="grow"></span>${counts}
        <button class="ib" data-act="open" data-rel="${esc(f.rel)}" title="Open ${esc(baseName(f.rel))} in the editor">${icon('code')}</button></div>`;
      if (!f.ok) return head + emptyState('Cannot compare', esc(f.error ?? ''));
      if (!f.lines.length)
        return (
          head +
          (f.rawEqual === false
            ? emptyState(
                'No line difference',
                'Raw bytes differ, including BOM or newline formatting. The line comparison normalizes that formatting.',
              )
            : emptyState('No difference', `The local file has the same content as the ${esc(f.against)} version.`))
        );
      const diffLine = ([t, a, b, s]) => {
        if (t === '@') return `<div class="dl g"><span>${esc(s)}</span></div>`;
        let tone = '';
        if (t === '+') tone = 'a';
        else if (t === '-') tone = 'r';
        const target = t !== '-' && b ? ` data-act="open" data-rel="${esc(f.rel)}" data-line="${b}"` : '';
        return `<div class="dl ${tone}"${target}><i>${a ?? ''}</i><i>${b ?? ''}</i><span>${t}${esc(s)}</span></div>`;
      };
      const lines = f.lines.map(diffLine).join('');
      return (
        head +
        `<div class="difft">${lines}</div>${f.truncated ? '<div class="sub group-note">The comparison is long; only its beginning is shown.</div>' : ''}`
      );
    };

    // ---- render
    /**
     * Brings `from` to the markup of `to` while keeping every node that did not change: a status tick that changes one
     * row must not replace the element under the pointer (the browser would drop its tooltip and :hover) or the
     * focused one. A form control whose markup changed is replaced, so it shows the drawn state, as before.
     */
    /** Gives `a` the attributes of `b`, touching only those that differ. */
    const morphAttributes = (a, b) => {
      // getAttributeNames is a copy: removing while iterating it skips nothing.
      for (const name of a.getAttributeNames()) if (!b.hasAttribute(name)) a.removeAttribute(name);
      for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    };
    const morph = (from, to) => {
      const next = [...to.childNodes];
      next.forEach((b, i) => {
        const a = from.childNodes[i];
        if (!a) from.append(b);
        else if (a.isEqualNode(b)) return;
        else if (a.nodeType === 3 && b.nodeType === 3) a.data = b.data;
        else if (a.nodeType !== 1 || a.nodeName !== b.nodeName || /^(?:INPUT|TEXTAREA|SELECT)$/.test(a.nodeName))
          a.replaceWith(b);
        else {
          morphAttributes(a, b);
          morph(a, b);
        }
      });
      while (from.childNodes.length > next.length) from.lastChild.remove();
    };
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
      const parsed = document.createElement('template');
      parsed.innerHTML = html;
      morph(node, parsed.content);
      const same = (item) =>
        item.tagName === focused.tag &&
        item.id === focused.id &&
        identity(item) === focused.row &&
        Object.entries(focused.data).every(([key, value]) => item.dataset[key] === value);
      // A focused element that was kept as it was stays focused; otherwise focus moves to the one that now stands for it.
      if (focused && !(active.isConnected && same(active))) {
        const replacement = [...node.querySelectorAll('button,input,select,summary,a,[tabindex]')].find(same);
        (replacement ?? el.tabs.querySelector('[aria-selected=true]'))?.focus({ preventScroll: true });
      }
      return true;
    };
    // Refresh, select an element, and expand or collapse every group: icon buttons with their action as name.
    const inspectToolButtons = () => {
      const pickTitle = S.pickingElement
        ? 'Stop selecting (Esc)'
        : 'Select an element on the page to see its form, column or template and its source file';
      const pick = `<button class="ib${S.pickingElement ? ' on' : ''}" data-act="inspect-pick" aria-pressed="${S.pickingElement}" aria-label="Select an element" title="${pickTitle}">${icon('locate')}</button>`;
      const [foldValue, foldLabel, foldTitle, foldIcon] = S.inspectAnyClosed
        ? ['open', 'Expand all', 'Expand all groups', 'expand']
        : ['closed', 'Collapse all', 'Collapse all groups', 'collapse'];
      const fold = S.inspectGroups
        ? `<button class="ib" data-act="inspect-fold" data-v="${foldValue}" aria-label="${foldLabel}" title="${foldTitle}">${icon(foldIcon)}</button>`
        : '';
      return `<button class="ib" data-act="inspect-refresh" aria-label="Refresh inspection" title="Refresh inspection: re-read your local sources and what the page shows now">${icon('reload')}</button>${pick}${fold}`;
    };
    /* NOSONAR: single-pass routine, splitting it would change shared state */ const render = () => {
      if (lifetime.signal.aborted) return;
      const d = S.d;
      if (!d) return;
      const ui = S.ui;
      const localOnly = sourcesOnly(d);
      const errs = d.problems.filter((p) => p.type === 'error' || p.type === 'console').length;
      const warns = d.needsDeploy.length + d.notes.length + d.problems.filter((p) => p.type === 'warning').length;
      const net = d.problems.filter((p) => p.type === 'http' || p.type === 'failed').length;
      wrap.className = `wrap${ui.open ? ' open' : ''}${ui.hidden ? ' hidden' : ''}${ui.large ? ' large' : ''}${d.caution ? ' caution' : ''}`;
      host.dataset.mode = d.online ? 'online' : 'local';
      host.dataset.overrides = String(d.items.length);
      host.dataset.issues = String(warns + errs + net);
      // A model-driven project names itself by its app or project (siteLabel), not by its file name.
      const siteName = d.siteLabel || d.site;
      host.dataset.label = `${d.site} @ ${d.env}`;
      // The drawn local runtime state: a failed read is distinguishable from a runtime that is still being read.
      let runtimeState = '';
      if (d.mirage?.active) runtimeState = 'active';
      else if (d.mirage?.error) runtimeState = 'failed';
      else if (d.mirage) runtimeState = 'inactive';
      host.dataset.runtime = runtimeState;
      place();
      let dotState = ' paused';
      if (d.online) dotState = ' off';
      else if (d.mirageMode || d.live) dotState = '';
      let dotTitle = 'live reload is off';
      if (d.mirageMode) dotTitle = 'Mirage renders your local sources and reloads the page when they change';
      else if (d.online) dotTitle = 'overrides are off';
      else if (d.live) dotTitle = 'live reload is on';
      const dot = `<span class="dot${dotState}" title="${dotTitle}"></span>`;
      const real = d.caution ? '<span class="real" title="this environment holds real data">REAL DATA</span>' : '';
      // which checkout state the overlay serves: branch, HEAD commit and the comparison baseline
      const git = d.git ?? {};
      const gitLabel = git.branch ?? (git.commit ? git.commit.slice(0, 7) : null);
      let baselineText = 'no Git baseline';
      if (git.baseline?.available) {
        const pinned = git.baseline.pinned ? ` pinned at ${(git.baseline.commit ?? '').slice(0, 7)}` : '';
        baselineText = `baseline ${git.baseline.requested}${pinned}`;
      }
      let gitTitle = baselineText;
      if (gitLabel) {
        const head = git.detached ? 'detached HEAD' : `branch ${git.branch}`;
        const moved = git.headMoved ? ' · HEAD differs from the comparison baseline' : '';
        gitTitle = `${head} @ ${(git.commit ?? '').slice(0, 7)} · ${baselineText}${moved}`;
      }
      let branch = '';
      if (gitLabel) {
        const movedFromBaseline = git.headMoved && git.baseline?.pinned;
        branch = `<span class="branch${movedFromBaseline ? ' moved' : ''}" title="${esc(gitTitle)}">${icon('branch')}<span>${esc(gitLabel)}${movedFromBaseline ? ' · moved' : ''}</span></span>`;
      }
      const overrideCount =
        d.online || d.mirageMode || !d.items.length
          ? ''
          : `<span class="n ok" title="${d.items.length} overrides on this page">${d.items.length}</span>`;
      const warnTitle = d.mirageMode
        ? 'source notes or runtime issues'
        : `${warns} source notes, deployment limitations or console warnings`;
      const warnCount = warns ? `<span class="n warn" title="${warnTitle}">${warns}</span>` : '';
      const errorLabel = errs === 1 ? 'error' : 'errors';
      const requestLabel = net === 1 ? 'request' : 'requests';
      const errorCount =
        errs + net
          ? `<span class="n err" title="${errs} JavaScript ${errorLabel}, ${net} failed ${requestLabel}">${errs + net}</span>`
          : '';
      const pendingTitle = d.mirageMode
        ? 'source changes are being applied by Mirage'
        : 'sources or baseline changed since this page loaded';
      const pendingMark =
        d.pending.length || d.pendingBaseline
          ? `<span class="n warn" title="${pendingTitle}">${icon('reload')}</span>`
          : '';
      set(
        'pill',
        el.pill,
        `${dot}<b>${d.online ? 'ONLINE' : 'LOCAL'}</b><span class="lbl" title="${esc(siteName)} @ ${esc(d.env)}">${esc(siteName)}</span>${real}${branch}
         ${overrideCount}
         ${warnCount}
         ${errorCount}
         ${pendingMark}`,
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
          let changeVerb = 'Saved';
          if (d.lastChange.how === 'css') changeVerb = 'Styles swapped';
          else if (d.lastChange.how === 'reload') changeVerb = 'Reloaded';
          const names =
            d.lastChange.files.slice(0, 2).map(baseName).join(', ') +
              (d.lastChange.files.length > 2 ? ` +${d.lastChange.files.length - 2}` : '') ||
            (d.lastChange.baselineChanged ? 'Git baseline updated' : '');
          float(`${changeVerb} &middot; ${esc(names)}`);
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
      let selectionMarkup = '';
      if (S.selectedElement)
        selectionMarkup = `<details class="selection-summary" data-selected-identity data-disclosure="selected-summary"${ui.tab === 'runtime' ? ' open' : ''}><summary class="gh" data-focus-key="selected-summary">${icon('right')}<span class="sr">Selected:</span><span class="sel-head"><span class="eyebrow">${esc(S.selectedIdentity?.kind || 'Selected element')}</span><span class="sel-name">${esc(S.selectedIdentity?.title || S.selectedElement.tag || 'element')}</span></span>${renderInspectionEvidence(S.selectedIdentity?.evidence, { part: 'headline', context: 'panel' })}</summary><button class="ib selection-clear" data-act="selection-clear" data-focus-key="selection-clear" aria-label="Clear selection" title="Deselect the element and remove its highlight on the page">${icon('close')}</button>${renderInspectionEvidence(S.selectedIdentity?.evidence, { context: 'panel' })}</details>`;
      else if (S.selectionReason === 'anchor-detached')
        selectionMarkup =
          '<div class="selection-summary" role="status">The page replaced this element. Select it again.</div>';
      const disclosures = [...selectionHost.querySelectorAll('details[data-disclosure]')].map((item) => [
        item.dataset.disclosure,
        item.open,
      ]);
      // A tab switch decides the selection's fold again; on one tab, the user's fold stays.
      const selectionTabChanged = S.selectionTab !== ui.tab;
      S.selectionTab = ui.tab;
      if (set('selection', selectionHost, selectionMarkup)) {
        for (const [key, open] of disclosures) {
          if (selectionTabChanged && key === 'selected-summary') continue;
          const item = [...selectionHost.querySelectorAll('[data-disclosure]')].find(
            (node) => node.dataset.disclosure === key,
          );
          if (item) item.open = open;
        }
      }
      const localClass = d.online ? '' : 'on live';
      const onlineClass = d.online ? 'on online' : '';
      const liveClass = d.live ? 'on' : 'warn';
      const liveState = d.live ? 'on: saving a file reloads the page' : 'off: reload the page yourself';
      const liveIcon = icon(d.live ? 'bolt' : 'pause');
      // What each side serves: the session's overrides switched on or off (session.bypass, or the model-driven overlay's
      // online flag), for every tab of this target in this browser. The environment's name stays out: the header shows
      // it, and a name such as "local" reads badly in a sentence.
      const env = esc(d.env);
      const key = esc(d.keys.mode);
      const [localTip, onlineTip] = d.modelDriven
        ? [
            `Load web resources from your local Solution files (${key})`,
            `Load the deployed web resources, without your local files. All tabs of this app switch (${key})`,
          ]
        : [
            `Show the site with your local files applied (${key})`,
            `Show the site as deployed, without your local files. All tabs of this site switch (${key})`,
          ];
      // Against a local Mirage (portal or model-driven local simulation) Online would show the same local sources.
      const modeSwitch = localOnly
        ? ''
        : `<span class="seg" role="group" aria-label="Source mode"><button class="${localClass}" data-act="mode" data-v="local" aria-pressed="${!d.online}" title="${localTip}">Local</button><button class="${onlineClass}" data-act="mode" data-v="online" aria-pressed="${Boolean(d.online)}" title="${onlineTip}">Online</button></span>`;
      // Mirage reloads portal pages itself; a model-driven local simulation still reloads through Lense.
      const liveButton = d.mirageMode
        ? ''
        : `<button class="ib ${liveClass}" data-act="live" title="Live reload is ${liveState}">${liveIcon}</button>`;
      const setupLink = d.setupUrl
        ? `<a class="ib" href="${esc(d.setupUrl)}" target="_blank" rel="noopener noreferrer" title="Project setup: sources, sites and browser (opens in a new tab)" aria-label="Project setup">${icon('setup')}</a>`
        : '';
      const simLink = d.mirageMode
        ? `<a class="ib" href="/_sim/" target="_blank" rel="noopener noreferrer" title="Manage data and personas" aria-label="Manage data and personas">${icon('sim')}</a>`
        : '';
      set(
        'head',
        el.head,
        `<div class="ident"><div>${dot}<span class="brand">paqvilo</span>${real}</div><div class="where" title="${esc(siteName)} @ ${env}"><span class="tag">${esc(siteName)}</span><span class="tag env">${env}</span></div></div>
         <div class="ctl">${modeSwitch}${liveButton}
         <button class="ib" data-act="xray" title="X-ray: highlight page elements and show the source file of each (Alt+Shift+X)" aria-label="Toggle Lense X-ray" aria-pressed="${Boolean(document.getElementById('paqvilo-xray')?.__px?.enabled)}">${icon('xray')}</button>
         ${setupLink}
         ${simLink}
         <button class="ib" data-act="size" title="${ui.large ? 'Smaller panel' : 'Larger panel'}">${icon('size')}</button>
         <button class="ib" data-act="hide" title="Hide everything (${d.keys.hide})">${icon('hide')}</button>
         <button class="ib" data-act="close" title="Collapse (${d.keys.panel} or Esc)">${icon('down')}</button></div>`,
      );
      const inspection = d.inspection ?? d.mirage;
      const issueTone = errs + net ? 'err' : 'warn';
      const tabCount = {
        overrides: d.items.length ? `<span class="n ok">${d.items.length}</span>` : '',
        runtime: '',
        tweaks: '',
        issues: warns + errs + net ? `<span class="n ${issueTone}">${warns + errs + net}</span>` : '',
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
            .map((target, index) => {
              if (!keep(target)) return '';
              const selected = target.origin === location.origin ? 'selected' : '';
              return `<option value="${index}" ${selected}>${esc(target.siteName)} @ ${esc(target.envName)}</option>`;
            })
            .join('');
          return options ? `<optgroup label="${name}">${options}</optgroup>` : '';
        })
        .join('');
      const pendingTarget = S.pendingTarget;
      const realNote = pendingTarget?.caution ? ' (REAL DATA)' : '';
      const confirmBox = pendingTarget
        ? `<div class="target-confirm" role="alertdialog" aria-labelledby="paqvilo-target-title"><p id="paqvilo-target-title">Open ${esc(pendingTarget.siteName)} @ ${esc(pendingTarget.envName)}${realNote}? Browser actions can change live data.</p><button class="btn sec" data-target-cancel>Cancel</button> <button class="btn" data-target-confirm>Confirm</button></div>`
        : '';
      set(
        'targets',
        el.targets,
        `<label for="paqvilo-target">Portal / environment</label><select id="paqvilo-target">${targetGroups}</select><button data-target-go class="btn" aria-busy="${Boolean(S.targetSwitching)}" title="Open the chosen portal or environment in this tab" ${S.targetSwitching || currentTarget() >= 0 ? 'disabled' : ''}>${S.targetSwitching ? 'Opening…' : 'Go'}</button>${confirmBox}`,
      );
      const gitMoved = git.headMoved && git.baseline?.pinned ? ' moved' : '';
      const gitHead = gitLabel
        ? `<span class="branch${gitMoved}" title="${esc(gitTitle)}">${icon('branch')}<span>${esc(gitLabel)} <span class="commit">@ ${esc((git.commit ?? '').slice(0, 7))}</span></span></span>`
        : '<span class="grow"></span>';
      // One chip says that there is no baseline; Issues says why and what to do, when it has a note on it.
      const baselineWhy = d.notes.some((note) => note.kind === 'baseline') ? ' Issues says why there is none.' : '';
      const baselineNeeds = d.modelDriven
        ? 'Edited markers and the changed vs Git choice need a Git baseline.'
        : 'Edited markers, template and snippet changes and the changed vs Git choice need a Git baseline.';
      // A model-driven app without local web resources has nothing a baseline would compare.
      let gitBaseline = git.baseline?.available
        ? `<span class="commit" title="${esc(baselineText)}">baseline ${esc((git.baseline.commit ?? '').slice(0, 7))}</span>`
        : `<span class="commit" title="${baselineNeeds}${baselineWhy}">No Git baseline</span>`;
      if (!git.baseline?.available && d.modelDriven && !d.stats?.webFiles) gitBaseline = '';
      set('git', el.git, d.mirageMode ? '' : gitHead + gitBaseline);
      // Only a target other than this one is a choice; with none the row is noise.
      el.targets.hidden =
        d.capabilities?.targets === false || !S.targets.some((target) => target.origin !== location.origin);
      el.git.hidden = d.capabilities?.git === false;
      set(
        'tabs',
        el.tabs,
        TABS.filter(
          ([id]) => (id !== 'actions' || d.capabilities?.actions === true) && (!MIRAGE_TABS.has(id) || d.mirageMode),
        )
          .map(
            ([id, label]) =>
              `<button class="tab${ui.tab === id ? ' on' : ''}" data-act="tab" data-v="${id}" id="paqvilo-tab-${id}" role="tab" aria-selected="${ui.tab === id}" aria-controls="paqvilo-tab-content" tabindex="${ui.tab === id ? 0 : -1}">${label}${tabCount[id] ?? ''}</button>`,
          )
          .join(''),
      );
      el.body.setAttribute('aria-labelledby', 'paqvilo-tab-' + ui.tab);
      el.input.placeholder = (d.modelDriven ? MODEL_DRIVEN_PLACEHOLDER[ui.tab] : null) ?? PLACEHOLDER[ui.tab] ?? '';
      el.input.setAttribute('aria-label', el.input.placeholder || 'Search');
      el.input.closest('.search').hidden = ['tweaks', 'mirage', 'actions'].includes(ui.tab);
      if (ui.tab === 'runtime') ensureInspect();
      if (MIRAGE_TABS.has(ui.tab)) ensureTweaks();
      let body;
      S.subtools = '';
      if (S.diff) body = diffHtml();
      else if (ui.tab === 'actions' && d.capabilities?.actions) body = '<div data-panel-actions-host></div>';
      else if (ui.tab === 'runtime') body = runtimeHtml();
      else if (ui.tab === 'tweaks') body = tweaksHtml();
      else if (ui.tab === 'mirage') body = mirageHtml();
      else if (ui.tab === 'issues') body = issuesHtml();
      else if (ui.tab === 'activity') body = activityHtml();
      else if (ui.tab === 'explore') body = exploreHtml();
      else body = overridesHtml();
      let toolButtons = '';
      if (ui.tab === 'issues')
        toolButtons = `<button class="f${ui.localOnly ? ' on' : ''}" data-act="localonly" aria-pressed="${Boolean(ui.localOnly)}" title="Show only issues that come from your local files">Local files only</button> <button class="ib" data-act="clear" data-v="problems" title="Clear the list"${d.problems.length ? '' : ' disabled'}>${icon('clear')}</button>`;
      else if (ui.tab === 'activity')
        toolButtons = `<button class="ib" data-act="clear" data-v="activity" title="Clear the list"${d.activity.length ? '' : ' disabled'}>${icon('clear')}</button>`;
      else if (ui.tab === 'runtime' && S.inspect?.report && !S.diff)
        // Inspect's commands are icon buttons beside its filter; the fold button follows the groups below.
        toolButtons = inspectToolButtons();
      set('toolbtns', el.toolbtns, toolButtons);
      set('subtools', el.subtools, S.diff ? '' : S.subtools);
      const top = el.body.scrollTop;
      if (set('body', el.content, body)) el.body.scrollTop = S.keepScroll === false ? 0 : top;
      host.dispatchEvent(new CustomEvent('paqvilo-panel-render', { detail: { token: d.token, tab: ui.tab } }));
      el.body.setAttribute(
        'aria-busy',
        String(
          Boolean(
            S.diff?.loading ||
            (ui.tab === 'runtime' && (S.inspectLoading !== null || inspectionPending(inspection))) ||
            (MIRAGE_TABS.has(ui.tab) && S.tweaksLoading !== null) ||
            (ui.tab === 'explore' && S.catalogLoading !== null),
          ),
        ),
      );
      pendingFeedback();
      S.keepScroll = true;
      const modeHint = localOnly ? '' : `, ${d.keys.mode} switches between local and online`;
      const modeKey = localOnly ? '' : ` &nbsp;<kbd>${d.keyCodes.mode.slice(-1)}</kbd> online`;
      let statsTitle =
        'What the local sources hold: web files, custom scripts and styles, changed templates and snippets';
      if (d.mirageMode) statsTitle = 'Mirage renders your local sources and reloads the page when they change';
      else if (d.modelDriven) statsTitle = 'The web resources of your Solution sources that Lense can serve';
      const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      let statsText = 'Mirage runtime';
      if (d.modelDriven) statsText = count(d.stats.webFiles, 'web resource', 'web resources');
      else if (!d.mirageMode)
        statsText =
          [
            d.stats.webFiles && count(d.stats.webFiles, 'file', 'files'),
            d.stats.blocks && count(d.stats.blocks, 'script', 'scripts'),
            d.stats.patches && count(d.stats.patches, 'patch', 'patches'),
          ]
            .filter(Boolean)
            .join(' &middot; ') || 'no local overrides';
      // Esc and / are shown where they apply (the search box, the panel's own Esc); the footer keeps the global keys.
      set(
        'foot',
        el.foot,
        `<span title="${d.keys.hide} hides or shows paqvilo, ${d.keys.panel} opens or closes this panel${modeHint}, Esc closes it">Alt+Shift+ <kbd>${d.keyCodes.hide.slice(-1)}</kbd> hide &nbsp;<kbd>${d.keyCodes.panel.slice(-1)}</kbd> panel${modeKey} &nbsp;<kbd>X</kbd> X-ray</span><span class="grow"></span><span class="stats" title="${statsTitle}">${statsText}</span>`,
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
      // Opening the panel ends X-ray; nothing is left to bring back afterwards.
      if (open) S.restoreAfterXray = null;
      if (open) document.getElementById('paqvilo-xray')?.__px?.toggle(false);
      if (open && !S.ui.open) previousFocus = root.activeElement ?? document.activeElement;
      S.ui.open = open;
      if (open) S.ui.hidden = false;
      if (open && S.ui.tab === 'explore' && !S.catalog) void loadCatalog();
      saveUi();
      render();
      if (open) el.tabs.querySelector('[aria-selected=true]')?.focus();
      else (previousFocus?.isConnected ? previousFocus : el.pill).focus();
    };
    const setHidden = (hidden) => {
      S.ui.hidden = hidden;
      // Hiding wins over the panel coming back when X-ray, which this also turns off, ends.
      if (hidden) S.restoreAfterXray = null;
      saveUi();
      render();
      if (hidden) float(`paqvilo is hidden &middot; <kbd>${S.d.keys.hide}</kbd> brings it back`, 3200);
    };
    const reloadPage = () => {
      // reload() may repeat the POST that produced a form result. Navigating explicitly uses GET.
      const url = new URL(location.href);
      // A same-URL navigation with a fragment is only a scroll; vary the query to fetch a document.
      if (url.href.includes('#'))
        url.searchParams.set('paqvilo', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`); // NOSONAR: pseudo-random value for simulation, not a secret
      location.assign(url.href);
    };
    let reloadTimer = 0;
    /** A Mirage change reloads open pages through its own event; reload here only if that never comes. */
    const reloadAfterTweak = (text) => {
      toast(text);
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = 0;
        reloadPage();
      }, 2000);
      window.addEventListener(
        'pagehide',
        () => {
          clearTimeout(reloadTimer);
          reloadTimer = 0;
        },
        { once: true, signal: lifetime.signal },
      );
    };
    const setMode = async (online) => {
      // A local Mirage has no other version to show; turning overrides back on stays possible (--no-overrides).
      if (online && sourcesOnly(S.d)) return;
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
      void api('inspect', { scope }).then((r) => {
        acceptInspection(request, version, r, scope);
      });
    };
    // A failed read is requested again by the next draws, up to this many reads per runtime version.
    const TWEAKS_ATTEMPTS = 3;
    const ensureTweaks = () => {
      const c = S.d?.mirage;
      if (!c?.active || !c.version || S.tweaksLoading === c.version) return;
      const current = S.tweaks;
      const retry = current?.version === c.version && !current.ok && current.failures < TWEAKS_ATTEMPTS;
      if (current && current.version >= c.version && !retry) return;
      const version = c.version;
      const failures = current?.version === version && !current.ok ? current.failures : 0;
      S.tweaksLoading = version;
      void api('tweaks').then((r) => {
        if (lifetime.signal.aborted || S.tweaksLoading !== version) return;
        S.tweaksLoading = null;
        S.tweaks = {
          ...r,
          version,
          failures: r.ok ? 0 : failures + 1,
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
    /* NOSONAR */ const performAction = async (name, t) => {
      const row = t.closest('[data-rel]');
      const rel = t.dataset.rel || row?.dataset.rel || '';
      const url = row?.dataset.url || '';
      const d = S.d;
      /* NOSONAR: reviewed, a rewrite would not preserve behaviour */ switch (name) {
        case 'selection-clear':
          document.getElementById('paqvilo-xray')?.__px?.clearSelection?.('user-clear');
          S.selectedElement = null;
          S.selectedIdentity = null;
          render();
          break;
        case 'xray':
          stopPicking();
          if (S.ui.open) S.restoreAfterXray = { tab: S.ui.tab };
          document.getElementById('paqvilo-xray')?.__px?.toggle();
          S.ui.open = false;
          render();
          break;
        case 'persona-filters':
          S.personaFilterDisclosureOpen = !(S.personaFilterDisclosureOpen ?? personaFilterCount() > 0);
          refreshPersonaRows();
          break;
        case 'persona-facet': {
          S.personaFilters ??= { q: '', roles: [], tags: [], groups: [], subgroups: [] };
          const values = S.personaFilters[t.dataset.facet] ?? [];
          S.personaFilters[t.dataset.facet] = values.includes(t.dataset.v)
            ? values.filter((value) => value !== t.dataset.v)
            : [...values, t.dataset.v];
          S.personaPage = 0;
          refreshPersonaRows();
          break;
        }
        case 'persona-any': {
          S.personaFilters ??= { q: '', roles: [], tags: [], groups: [], subgroups: [] };
          const any = S.personaFilters.any ?? [];
          S.personaFilters.any = any.includes(t.dataset.facet)
            ? any.filter((facet) => facet !== t.dataset.facet)
            : [...any, t.dataset.facet];
          S.personaPage = 0;
          refreshPersonaRows();
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
          refreshPersonaRows();
          break;
        case 'persona-page':
          S.personaPage = Math.max(0, (S.personaPage ?? 0) + Number(t.dataset.direction) * 50);
          refreshPersonaRows();
          break;
        case 'persona-clear':
          S.personaFilters = { q: '', roles: [], tags: [], groups: [], subgroups: [] };
          S.personaFilterDisclosureOpen = false;
          S.personaPage = 0;
          refreshPersonaRows();
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
            // A cancelled pick brings the panel back on this tab; a pick opens Inspect with the selection.
            S.restoreAfterXray = { tab: S.ui.tab };
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
          if (S.ui.tab === 'explore' && !S.catalog) void loadCatalog();
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
          void copy(location.href, 'Address');
          break;
        case 'persona': {
          const contactId = t.dataset.contact || null;
          if (contactId && !S.tweaks?.personas?.some((item) => item.contactId === contactId)) break;
          const r = await api('persona', { contactId });
          if (r.ok) reloadAfterTweak('Persona switched; reloading ...');
          else toast(r.error ?? 'Could not switch the persona', true);
          break;
        }
        case 'signin': {
          const personas = S.tweaks?.personas ?? [];
          const contactId = t.dataset.contact;
          if (!contactId || !personas.some((item) => item.contactId === contactId)) break;
          const name = personas.find((item) => item.contactId === contactId)?.name ?? contactId;
          // The page posts the portal's sign-in form and navigates; it comes back signed in.
          const r = await api('signin', { contactId });
          if (r.ok) {
            const value = personaPreferences(),
              key = t.dataset.key || `@contact:${contactId}`;
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
          let text = `Apply scenario "${item.name ?? id}"? Its preset, persona and permission mode change in one step; pages reload.`;
          if (kind === 'preset')
            text = `Apply preset "${item.name ?? id}"? It replaces the local records, roles and settings it defines; pages reload.`;
          else if (item.catalogue) {
            const setup =
              item.context || item.preset
                ? 'Its setup opens in an isolated local runtime.'
                : 'This browser signs in through the portal.';
            text = `Open "${item.name}" as ${item.persona} at ${item.startPath ?? '/'}? ${setup}`;
          }
          S.confirm =
            kind === 'preset'
              ? { kind, id, label: 'Apply preset', text }
              : {
                  kind,
                  id,
                  catalogue: item.catalogue === true,
                  ...(item.catalogueId ? { id: item.catalogueId } : {}),
                  label: 'Apply scenario',
                  text,
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
          void copy(
            t.dataset.copy ?? (row?.dataset.path || d.sourceDir.replace(/[\\/]$/, '') + '/' + rel.split('#')[0]),
            t.dataset.copyKind === 'reference' ? 'Source reference' : 'Path',
          );
          break;
        case 'copyurl':
          void copy(location.origin + url, 'Address');
          break;
        case 'copytext':
          void copy(row.dataset.text, 'Message');
          break;
        case 'open': {
          if (!rel) break;
          const line = Number(t.dataset.line || row?.dataset.line) || undefined;
          // The row's own name, as the user saw it: a file name can be an ID (a form's GUID.xml).
          const label = t.dataset.label || row?.dataset.label || baseName(rel);
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
              r.ok ? `Opened ${label} in the editor` : (r.error ?? 'Could not open the editor'),
              feedbackSelection,
            );
          if (r.ok) toast(`Opened ${label}${line ? ' at line ' + line : ''} in the editor`);
          else if (r.url) {
            // the editor's own link; the browser asks once. Say why the command itself did not run.
            if (r.error) toast(r.error, true);
            location.href = r.url;
          } else toast(r.error ?? 'Could not open the editor', true);
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
          const pending = { loading: true, rel };
          S.diff = pending;
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
      if (t) void act(t.dataset.act, t);
    });
    el.panel.addEventListener('input', (event) => {
      if (!event.target.matches('[data-panel-persona-query]')) return;
      S.personaFilters ??= { q: '', roles: [], tags: [], groups: [], subgroups: [] };
      S.personaFilters.q = event.target.value;
      S.personaPage = 0;
      refreshPersonaRows();
    });
    el.panel.addEventListener('change', (e) => {
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
      el.targets.querySelector('select')?.focus();
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
        // Go is disabled again (the selection is back on this target): the choice keeps focus.
        el.targets.querySelector('select')?.focus();
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
    // Go opens another target: it is enabled only while the selection names one.
    const currentTarget = () => S.targets.findIndex((target) => target.origin === location.origin);
    el.targets.addEventListener('change', () => {
      const go = el.targets.querySelector('[data-target-go]');
      if (go && !S.targetSwitching) go.disabled = el.targets.querySelector('select')?.value === String(currentTarget());
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
    // The search "/" goes to: the tab's filter box, the persona search on Tweaks, none on Mirage and Actions.
    const searchBox = () => {
      if (S.ui.tab === 'tweaks') return el.panel.querySelector('[data-panel-persona-query]');
      return MIRAGE_TABS.has(S.ui.tab) || S.ui.tab === 'actions' ? null : el.input;
    };
    // typing in the panel must not trigger shortcuts of the portal page
    for (const type of ['keydown', 'keyup', 'keypress']) {
      /* NOSONAR */ el.panel.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'keydown') return;
        if (e.target.matches('[role=tab]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          const tabs = [...el.tabs.querySelectorAll('[role=tab]')],
            at = tabs.indexOf(e.target);
          let next = (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          if (e.key === 'Home') next = 0;
          else if (e.key === 'End') next = tabs.length - 1;
          e.preventDefault();
          void act('tab', tabs[next]);
          el.tabs.querySelector('[aria-selected=true]')?.focus();
          return;
        }
        // Esc in a filled persona search clears it first, as in the main search; the panel stays open.
        if (e.key === 'Escape' && e.target.matches('[data-panel-persona-query]') && e.target.value) {
          e.preventDefault();
          e.target.value = '';
          S.personaFilters = { ...(S.personaFilters ?? { roles: [], tags: [], groups: [], subgroups: [] }), q: '' };
          S.personaPage = 0;
          refreshPersonaRows();
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
          searchBox() &&
          !e.target.matches('input,textarea,select,[contenteditable]:not([contenteditable=false])')
        ) {
          e.preventDefault();
          searchBox().focus();
        }
      });
    }
    document.addEventListener(
      'paqvilo-xray',
      (event) => /* NOSONAR: single-pass routine, splitting it would change shared state */ {
        const detail = event.detail ?? {};
        if (detail.action === 'open') {
          void act('open', {
            evidenceScope: detail.scope,
            anchorGeneration: detail.anchorGeneration,
            dataset: {
              rel: detail.ref,
              ...(detail.label ? { label: detail.label } : {}),
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
          void act('inspect-refresh', { dataset: {}, closest: () => null });
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
          el.head.querySelector('[data-act=xray]')?.setAttribute('aria-pressed', String(Boolean(detail.enabled)));
          delete S.html.head;
          if (detail.enabled) {
            // X-ray takes the panel's place while it runs; turning it off brings the panel back as it was.
            if (S.ui.open) S.restoreAfterXray ??= { tab: S.ui.tab };
            S.ui.hidden = false;
            S.ui.open = false;
          } else if (S.restoreAfterXray) {
            S.ui.tab = S.restoreAfterXray.tab;
            S.restoreAfterXray = null;
            setOpen(true);
            return;
          }
          render();
        }
      },
      { signal: lifetime.signal },
    );
    const onKey = (e) => {
      if (!host.isConnected) return globalThis.removeEventListener('keydown', onKey, true);
      if (
        S.ui.open &&
        searchBox() &&
        e.key === '/' &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e
          .composedPath()
          .some((node) => node?.matches?.('input,textarea,select,[contenteditable]:not([contenteditable=false])'))
      ) {
        e.preventDefault();
        searchBox().focus();
        return;
      }
      if (!S.d || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      // by key position, so it works on any keyboard layout
      if (e.code === S.d.keyCodes.hide) setHidden(!S.ui.hidden);
      else if (e.code === S.d.keyCodes.panel) setOpen(!S.ui.open || S.ui.hidden);
      else if (e.code === S.d.keyCodes.mode && !sourcesOnly(S.d))
        void act('mode', { dataset: { v: S.d.online ? 'local' : 'online' }, closest: () => null });
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    globalThis.addEventListener('keydown', onKey, { capture: true, signal: lifetime.signal });

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
      /** The panel's icon markup, so parts drawn into it (model-driven Actions) use the same icons. */
      icon(name) {
        return ICON[name] ? icon(name) : '';
      },
      dispose() {
        stopPicking();
        // Disposing turns X-ray off as well: that must not bring the panel back.
        S.restoreAfterXray = null;
        // The X-ray of this realm, also when the page removed its host from the document.
        (globalThis.__paqviloXrayUi ?? document.getElementById('paqvilo-xray')?.__px)?.dispose();
        host.__pp.release();
      },
      /** Ends this panel alone: its listeners, timers and host. */
      release() {
        stopPicking();
        lifetime.abort();
        clearTimeout(toastTimer);
        clearTimeout(floatTimer);
        clearTimeout(saveTimer);
        clearTimeout(placeTimer);
        clearTimeout(reloadTimer);
        host.remove();
        if (globalThis.__paqviloPanelUi === host.__pp) globalThis.__paqviloPanelUi = null;
      },
      /* NOSONAR: single-pass routine, splitting it would change shared state */ update(d) {
        if (lifetime.signal.aborted) return;
        const catalogChanged = S.d && S.d.catalogVersion !== d.catalogVersion;
        const previousInspection = S.d?.inspection ?? S.d?.mirage,
          nextInspection = d.inspection ?? d.mirage;
        if (catalogChanged || (previousInspection && previousInspection.version !== nextInspection?.version)) {
          S.inspectRequest++;
          S.inspectLoading = null;
        }
        S.d = d;
        // A failed runtime read is drawn on the Tweaks tab with its Read again control; a redraw, including the
        // one Read again itself schedules while it is still reading, must not move the user off that tab.
        if (MIRAGE_TABS.has(S.ui.tab) && (!d.mirageMode || (d.mirage?.active === false && !d.mirage.error)))
          S.ui.tab = 'overrides';
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
          if (S.ui.open && S.ui.tab === 'explore') void loadCatalog();
        }
        if (S.first) {
          // where it was left, in whatever tab or page that was
          const saved = d.ui ?? {};
          S.ui = {
            ...S.ui,
            ...saved,
            pos: { ...S.ui.pos, ...saved.pos },
            collapsed: { ...S.ui.collapsed, ...saved.collapsed },
          };
          if (S.ui.open && S.ui.tab === 'explore') void loadCatalog();
        }
        if (S.ui.tab === 'actions' && !d.capabilities?.actions) S.ui.tab = 'overrides';
        render();
        S.first = false;
      },
    };
  }
}

// Fixed owned source keeps page.evaluate and panel.mjs composition self-contained.
/* NOSONAR: intentional local script execution or generated handler */ export const panelUi = new Function(
  'data',
  `const renderInspectionEvidence=(${renderInspectionEvidence.toString()});const lenseUiKit=(${lenseUiKit.toString()});return (${panelBrowserImpl.toString()})(data);`,
);

/** Evaluated in the page during detach; a queued old draw cannot recreate a stopped panel. */
export function removePanelUi({ token }) {
  const retired = Array.isArray(globalThis.__paqviloRetiredSessions) ? globalThis.__paqviloRetiredSessions : [];
  if (!retired.includes(token)) retired.push(token);
  if (retired.length > 32) retired.splice(0, retired.length - 32);
  globalThis.__paqviloRetiredSessions = retired;
  // The live panel and X-ray of this realm are registered at creation, so a host the page removed from the document
  // (a body swap) is still torn down: its listeners, timers and attachShadow hook do not outlive the session.
  for (const ui of new Set([
    document.getElementById('paqvilo-panel')?.__pp,
    globalThis.__paqviloPanelUi,
    document.getElementById('paqvilo-xray')?.__px,
    globalThis.__paqviloXrayUi,
  ]))
    if (ui?.token === token) ui.dispose();
}
