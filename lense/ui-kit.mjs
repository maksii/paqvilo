/**
 * The one visual vocabulary of Lense in the page: theme tokens, icons, icon buttons, toggle chips, status chips and
 * file rows. The dev panel, X-ray and the selection-evidence renderer draw with it, so a control or row looks and
 * behaves the same wherever it appears. Self-contained: hosts embed its source in their serialized browser code.
 */
export function lenseUiKit() {
  const ICON = {
    setup:
      '<path d="M12.8 6.8 14.5 7v2l-1.7.2-.6 1.3 1.1 1.4-1.4 1.4-1.4-1.1-1.3.6-.2 1.7H7l-.2-1.7-1.3-.6-1.4 1.1-1.4-1.4 1.1-1.4-.6-1.3L1.5 9V7l1.7-.2.6-1.3-1.1-1.4 1.4-1.4 1.4 1.1 1.3-.6L7 1.5h2l.2 1.7 1.3.6 1.4-1.1 1.4 1.4-1.1 1.4z"/><circle cx="8" cy="8" r="2"/>',
    xray: '<circle cx="8" cy="8" r="5"/><circle cx="8" cy="8" r="1.4"/><path d="M8 1v3M8 12v3M1 8h3M12 8h3"/>',
    sim: '<path d="M5 2h6M6 2v5l-4 6h12l-4-6V2M4.5 10h7"/>',
    code: '<path d="M6 4 2 8l4 4M10 4l4 4-4 4"/>',
    diff: '<rect x="1.5" y="2.5" width="5.5" height="11" rx="1"/><rect x="9" y="2.5" width="5.5" height="11" rx="1"/><path d="M3 8h2.5M10.5 8H13M11.75 6.75v2.5"/>',
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
    up: '<path d="M8 13V4M4.5 7.5 8 4l3.5 3.5"/>',
    close: '<path d="M4 4l8 8M12 4l-8 8"/>',
    swap: '<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>',
    star: '<path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    starred: '<path fill="currentColor" d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    show: '<path d="M1.5 8c.8-2.4 3.3-4.5 6.5-4.5s5.7 2.1 6.5 4.5c-.8 2.4-3.3 4.5-6.5 4.5S2.3 10.4 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    signin: '<path d="M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3M2.5 8h7M6.5 5l3 3-3 3"/>',
    filter: '<path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z"/>',
    // Find an element on the page (a field, a selected element): never "go to another page".
    locate:
      '<path d="M8 14.5s4.5-4.2 4.5-7.6a4.5 4.5 0 0 0-9 0c0 3.4 4.5 7.6 4.5 7.6z"/><circle cx="8" cy="6.9" r="1.6"/>',
    expand: '<path d="M5 6l3-3 3 3M5 10l3 3 3-3"/>',
    collapse: '<path d="M5 3l3 3 3-3M5 13l3-3 3 3"/>',
    alert: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.5v.01"/>',
    shield: '<path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4z"/>',
    user: '<circle cx="8" cy="5.5" r="3"/><path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>',
    grid: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    link: '<path d="M6.5 9.5l3-3M7 4.5l1-1a3 3 0 0 1 4.2 4.2l-1 1M9 11.5l-1 1a3 3 0 0 1-4.2-4.2l1-1"/>',
    table: '<rect x="2" y="2.5" width="12" height="11" rx="1"/><path d="M2 6h12M2 9.5h12M6.5 6v7.5"/>',
    branch:
      '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5" r="1.5"/><path d="M5 5v6M11 6.5c0 2.6-6 2.2-6 4.5"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
  // Declarations for the host's root element. Every colour has a light and a dark value; the operating system's
  // colour scheme picks one (color-scheme: light dark), so the panel, X-ray and the model-driven panel follow it.
  const tokens = `color-scheme: light dark;
    --bg: light-dark(#fff, #1f2125); --fg: light-dark(#212529, #e3e5e8); --muted: light-dark(#6c757d, #a2a9b1);
    --primary: light-dark(#0d6efd, #6ea8fe); --on-primary: light-dark(#fff, #0b1d36); --link: light-dark(#0d6efd, #8bb9fe);
    --radius: 4px; --font: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
    --warn-bg: light-dark(#fff3cd, #3b3220); --warn: light-dark(#d39e00, #e0b43a);
    --danger: light-dark(#b02a37, #f08a93); --on-danger: light-dark(#fff, #1e1e1e); --success: light-dark(#146c43, #79c29a);
    --danger-bg: color-mix(in srgb, var(--danger) 10%, var(--bg)); --success-bg: color-mix(in srgb, var(--success) 10%, var(--bg));
    --tint: color-mix(in srgb, var(--primary) 6%, var(--bg)); --head-bg: color-mix(in srgb, var(--primary) 10%, var(--bg));
    --line: color-mix(in srgb, var(--primary) 20%, var(--bg)); --input-line: var(--line);
    --panel-line: light-dark(rgba(0,0,0,.15), rgba(255,255,255,.2)); --shadow: 0 6px 12px light-dark(rgba(0,0,0,.18), rgba(0,0,0,.55));
    --badge-bg: light-dark(#777, #5c636a); --badge-fg: #fff;`;
  // What a row is, in words: [short label for the .ico column, full name for its tooltip]. One meaning, one label, in
  // the words X-ray uses for the same kind (Web template, Content snippet, Multistep form, Stylesheet, ...).
  const KINDS = {
    page: ['Page', 'Web page'],
    'page-copy': ['Copy', 'Page copy'],
    'page-summary': ['Summary', 'Page summary'],
    'page-js': ['Script', 'Page JavaScript'],
    'page-css': ['Style', 'Page stylesheet'],
    'page-metadata': ['Page', 'Web page metadata'],
    'page-template': ['Page template', 'Page template'],
    'web-template': ['Template', 'Web template'],
    template: ['Template', 'Web template'],
    'content-snippet': ['Snippet', 'Content snippet'],
    snippet: ['Snippet', 'Content snippet'],
    include: ['Include', 'Web template include'],
    editable: ['Editable', 'Editable content'],
    'basic-form': ['Form', 'Basic form'],
    'basic-form-js': ['Script', 'Basic form JavaScript'],
    'advanced-form': ['Multistep form', 'Multistep form'],
    'advanced-form-step': ['Step', 'Multistep form step'],
    'advanced-form-step-js': ['Script', 'Multistep form step JavaScript'],
    'model-driven-form': ['Form', 'Form'],
    form: ['Form', 'Form'],
    app: ['App', 'Model-driven app'],
    command: ['Command', 'Command bar button'],
    formxml: ['Form XML', 'Form definition in your Solution sources'],
    list: ['List', 'List'],
    'list-js': ['Script', 'List JavaScript'],
    view: ['View', 'View'],
    table: ['Table', 'Table'],
    column: ['Column', 'Column'],
    'access-grant': ['Access', 'Page access rule that grants access'],
    'access-rule': ['Access', 'Page access rule'],
    'table-permission': ['Permission', 'Table permission'],
    subgrid: ['Grid', 'Subgrid'],
    quickform: ['Quick view', 'Quick view form'],
    notes: ['Notes', 'Notes control'],
    'grid-action': ['Action', 'Grid action'],
    metadata: ['Metadata', 'Column metadata'],
    fetchxml: ['FetchXML', 'FetchXML query'],
    control: ['Control', 'Rendered control'],
    api: ['Web API', 'Web API reference'],
    'cloud-flow': ['Flow', 'Cloud flow'],
    'plugin-step': ['Plug-in', 'Plug-in step'],
    logic: ['Logic', 'Server logic'],
    'plugin-type': ['Plug-in', 'Plug-in type'],
    'plugin-code': ['C#', 'Plug-in source code'],
    'plugin-assembly': ['Assembly', 'Plug-in assembly'],
    pcf: ['Component', 'Code component'],
    'pcf-settings': ['Settings', 'Code component column settings'],
    dataset: ['Dataset', 'Code component dataset'],
    'pcf-file': ['File', 'Code component file'],
    script: ['Script', 'Script'],
    stylesheet: ['Style', 'Stylesheet'],
    image: ['Image', 'Image'],
    font: ['Font', 'Font file'],
    'web-file': ['File', 'Web file'],
    'web-resource': ['Resource', 'Web resource'],
    setting: ['Setting', 'Site setting'],
    link: ['Link', 'Web link'],
    marker: ['Marker', 'Site marker'],
    redirect: ['Redirect', 'Redirect'],
    shortcut: ['Shortcut', 'Shortcut'],
    unresolved: ['Missing', 'Not found in your sources'],
    error: ['Error', 'JavaScript error'],
    request: ['Request', 'Failed request'],
    deploy: ['Deploy', 'Needs deployment or a source fix'],
    baseline: ['Git', 'Git baseline'],
    note: ['Note', 'Change not applied on this page'],
    warning: ['Warning', 'Console warning'],
    dialog: ['Dialog', 'Page dialog'],
    save: ['Saved', 'Saved file'],
    'style-swap': ['Style', 'Styles swapped without a reload'],
    switch: ['Setting', 'Panel setting changed'],
    signin: ['Sign-in', 'Browser sign-in or sign-out'],
    action: ['Action', 'Model-driven action'],
    runtime: ['Runtime', 'Local Mirage runtime'],
    diagnostics: ['Findings', 'Runtime findings'],
    requests: ['Requests', 'Requests of this page'],
    policy: ['Policy', 'Content policy'],
    identity: ['Personas', 'Personas and permissions'],
    administration: ['Admin', 'Mirage administration'],
    address: ['Address', 'Page address'],
  };
  /** [label, tooltip] for a kind; null for a kind without a name (the caller then names it itself). */
  const kindLabel = (kind) => KINDS[kind] ?? null;
  /**
   * A path as shown on screen: an ID segment (a Solution form's {GUID}.xml) reads "{…}". The full path stays for the
   * tooltip and for copying.
   */
  const displayPath = (value) =>
    String(value ?? '').replace(/\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?/gi, '{…}');
  // Controls and rows. A host adds its layout; it never restyles these.
  const css = `
    button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: left; }
    button:disabled { opacity: .45; cursor: default; }
    /* Text boxes too; :where keeps them below any host rule, such as the search box's own input. */
    select, :where(input:not([type=checkbox]):not([type=radio]):not([type=search]), textarea) { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--input-line); border-radius: var(--radius); padding: 4px; min-width: 0; max-width: 100%; box-sizing: border-box; }
    button:focus-visible, summary:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible,
    a:focus-visible, [tabindex]:focus-visible { outline: 2px solid color-mix(in srgb, var(--primary) 50%, transparent); outline-offset: 1px; }
    svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; flex: none; display: block; }
    .ib { text-decoration: none; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius); color: var(--muted); }
    .ib:hover { background: var(--tint); color: var(--primary); }
    .ib.on { color: var(--primary); }
    .ib.warn { color: var(--fg); background: var(--warn-bg); }
    .ib:disabled { opacity: .45; cursor: default; background: none; color: var(--muted); }
    .ib.text { width: auto; padding: 0 6px; font-size: 11px; font-weight: 600; }
    .f { padding: 2px 10px; border-radius: var(--radius); border: 1px solid var(--primary); color: var(--primary); display: inline-flex; gap: 5px; align-items: center; font-size: 12.5px; background: var(--bg); white-space: nowrap; }
    .f:hover { background: var(--tint); }
    .f.on { background: var(--primary); color: var(--on-primary); }
    .f:disabled { opacity: .45; cursor: default; background: var(--bg); }
    .btn { padding: 3px 12px; border-radius: var(--radius); background: var(--primary); border: 1px solid var(--primary); color: var(--on-primary); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; text-align: center; }
    .btn:hover { filter: brightness(.92); }
    .btn.sec { background: var(--bg); color: var(--primary); }
    .btn.sec:hover { background: var(--tint); filter: none; }
    .btn:disabled { filter: none; }
    .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--primary); border-radius: var(--radius); overflow: hidden; }
    .seg button { padding: 2px 10px; color: var(--primary); font-size: 12.5px; background: var(--bg); }
    .seg button + button { border-left: 1px solid var(--primary); }
    .seg button:hover { background: var(--tint); }
    .seg button.on, .seg button[aria-pressed=true] { background: var(--primary); color: var(--on-primary); }
    .seg button:disabled { background: var(--bg); color: var(--primary); }
    .search { flex: 1; display: flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--input-line); border-radius: var(--radius); padding: 0 8px; height: 30px; color: var(--muted); }
    .search:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent); }
    .search input { all: unset; flex: 1; min-width: 0; color: var(--fg); font: inherit; }
    .search input::placeholder { color: var(--muted); }
    kbd { font: 11px Consolas, "Cascadia Mono", monospace; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 3px; padding: 0 4px; }
    .banner { display: flex; align-items: center; gap: 8px; border-radius: var(--radius); padding: 7px 10px; margin-bottom: 8px; background: var(--warn-bg); border-left: 4px solid var(--warn); color: var(--fg); }
    .banner.grey { background: var(--tint); border-left-color: var(--primary); }
    .empty { text-align: center; color: var(--muted); padding: 26px 20px; }
    .empty > b:first-child { display: block; color: var(--fg); margin-bottom: 4px; font-size: 14px; }
    .n { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; font-size: 11.5px; font-weight: 600; }
    .n.ok, .n.dimn { background: var(--badge-bg); color: var(--badge-fg); }
    .n.warn { background: var(--warn); color: #1e1e1e; }
    .n.err { background: var(--danger); color: var(--on-danger); }
    .gh { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; color: var(--fg); font-size: 13px; font-weight: 700; background: var(--head-bg); border-bottom: 1px solid color-mix(in srgb, var(--primary) 55%, var(--bg)); }
    .gh:hover { color: var(--link); }
    .gh svg { transition: transform .12s; width: 12px; height: 12px; color: var(--muted); }
    .gh.openg svg, details[open] > .gh svg { transform: rotate(90deg); }
    .gh .n { font-weight: 400; }
    summary.gh { list-style: none; cursor: pointer; } summary.gh::-webkit-details-marker { display: none; }
    .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--line); position: relative; }
    .row:hover { background: var(--tint); }
    .main { flex: 1; min-width: 0; text-align: left; display: block; }
    .name { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .name > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .name .what { color: var(--muted); white-space: nowrap; flex: none; font-size: 12px; }
    .sub { color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub.path { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; direction: rtl; text-align: left; }
    button.main:hover .name > span:first-child { color: var(--link); text-decoration: underline; }
    .c { font-size: 11px; padding: 0 6px; border-radius: 3px; white-space: nowrap; flex: none; line-height: 17px; border: 1px solid transparent; }
    /* Status by meaning, each a chip: ok (exact, allowed, same), warn (likely, outdated, differs), bad (conflict,
       denied, error), muted (not found, not applied), info (your own change). .c.act is a plain note, not a chip. */
    .c.ok { background: var(--success-bg); color: var(--success); }
    .c.warn { background: var(--warn-bg); color: var(--fg); border-color: var(--warn); }
    .c.bad { background: var(--danger-bg); color: var(--danger); }
    .c.muted { background: var(--tint); color: var(--muted); border-color: var(--line); }
    .c.info { background: var(--head-bg); color: var(--link); }
    .c.act { color: var(--muted); padding: 0; }
    /* The kind of a row, in words (kindLabel); it wraps onto a second line rather than being cut. */
    .ico { width: 62px; font-size: 10.5px; font-weight: 600; line-height: 1.2; color: var(--muted); flex: none; text-align: left; overflow-wrap: anywhere; }
    .ico.bad { color: var(--danger); }
    .ico.icon { width: 20px; }
    .ico.warn { color: var(--fg); }
    .acts { display: flex; gap: 1px; flex: none; }
  `;
  return { ICON, icon, tokens, css, kindLabel, displayPath };
}
