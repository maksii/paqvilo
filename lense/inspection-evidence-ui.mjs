import { lenseUiKit } from './ui-kit.mjs';

/** Self-contained renderer embedded in both serialized browser interfaces; it draws with the shared Lense UI kit. */
function renderInspectionEvidenceImpl(evidence, options = {}) /* NOSONAR */ {
  const { icon, css, displayPath } = lenseUiKit();
  if (options.part === 'styles')
    return `${css}
    .inspection-evidence{font:inherit;color:var(--fg);min-width:0}.inspection-evidence>*+*{margin-top:8px}.inspection-evidence .gh{margin:0}.ie-rel{font-size:11px;padding:0 6px;border-radius:3px;white-space:nowrap;flex:none;line-height:17px;border:1px solid var(--line);color:var(--muted)}.inspection-evidence .row .main>.sub+.sub{margin-top:1px}.ie-row .name{flex-wrap:wrap;row-gap:2px}.ie-row .sub:not(.path){white-space:normal;overflow-wrap:anywhere}[data-evidence-source-context]{display:block}details[open]>summary [data-evidence-headline]{display:none}
  `;
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );
  const states = ['exact', 'candidate', 'conflicting', 'unavailable', 'stale']; // NOSONAR: set kept as authored
  const status = (value) => (states.includes(value) ? value : 'unavailable');
  const stateLabel = {
    exact: 'Exact',
    candidate: 'Likely',
    conflicting: 'Conflict',
    unavailable: 'Not found',
    stale: 'Outdated',
  };
  // A certainty means something else on the selected element's component, on a component around it and on a file.
  const stateHelp = {
    component: {
      exact: 'Identified from the selected element itself.',
      candidate: 'Matched by name or markup, not confirmed for this element. Check it before you edit.',
    },
    enclosing: {
      exact: 'Identified on this page around the selected element.',
      candidate:
        'Found through the configuration in your sources, not identified on this page. Check it before you edit.',
    },
    // A template, snippet or page that included the selected element where it rendered.
    context: {
      exact: 'This file included the selected element on this page.',
      candidate: 'This file included the selected element where it rendered. Check it before you edit.',
    },
    source: {
      exact: 'This file defines or renders the selected element.',
      candidate:
        'This file matches the element by name or markup, but may not be the one that rendered it. Check it before you edit.',
    },
    any: {
      conflicting: 'Several matches claim this element. Check which one applies before you edit.',
      unavailable: 'Not found in your sources. Refresh inspection.',
      stale: 'The page or your sources changed after this match. Select the element again.',
    },
  };
  const badge = (value, row, how) => {
    const state = status(value);
    const help = stateHelp[row]?.[state] ?? stateHelp.any[state] ?? stateHelp.any.unavailable;
    const meaning = help + (how ? '\n' + how : '');
    // The meaning is the accessible name: a tooltip alone reaches only a mouse, not a screen reader.
    return `<span class="c ${stateChip[state]} ie-state" data-status="${state}" title="${escape(meaning)}" role="img" tabindex="0" aria-label="${escape(stateLabel[state] + ': ' + meaning)}">${stateLabel[state]}</span>`;
  };
  // Certainty chips by meaning, the kit's status chips: confirmed, to check, outdated, contradicting, missing.
  const stateChip = { exact: 'ok', candidate: 'warn', stale: 'warn', conflicting: 'bad', unavailable: 'muted' };
  // One row layout for every file and component, the same as the panel's rows: name, kind and chips; detail lines;
  // the path on one line with its end visible; icon buttons on the right.
  // A file under the source folder shows its path from there, as Page files does; the tooltip keeps the full path.
  let sourceDir = String((evidence?.version === 1 && evidence.sourceDir) || options.sourceDir || '').replaceAll(
    '\\',
    '/',
  );
  while (sourceDir.endsWith('/')) sourceDir = sourceDir.slice(0, -1);
  const shownPath = (file) => {
    const value = String(file ?? '');
    const slashed = value.replaceAll('\\', '/');
    // An ID segment (a Solution form's {GUID}.xml) reads {…}: the kit's one display rule for paths.
    return displayPath(
      sourceDir && slashed.toLowerCase().startsWith(sourceDir.toLowerCase() + '/')
        ? slashed.slice(sourceDir.length + 1)
        : value,
    );
  };
  const titleAttr = (title) => (title ? ' title="' + escape(title) + '"' : '');
  const nameHtml = (name, nameTitle, what, chips) => {
    const kind = what ? '<span class="what">' + escape(what) + '</span>' : '';
    return `<div class="name"${titleAttr(nameTitle)}><span>${escape(name)}</span>${kind}${chips}</div>`;
  };
  const pathHtml = (path) =>
    `<div class="sub path" title="${escape(path)}"><bdi>${escape(shownPath(path))}</bdi></div>`;
  const rowHtml = ({ cls = '', attrs = '', name, nameTitle, what, chips = '', subs = [], path, actions = '' }) => {
    const rowClass = cls ? 'row ie-row ' + escape(cls) : 'row ie-row';
    const head = name === undefined ? '' : nameHtml(name, nameTitle, what, chips);
    const file = path === undefined ? '' : pathHtml(path);
    const acts = actions ? '<div class="acts">' + actions + '</div>' : '';
    return `<div class="${rowClass}"${attrs}><div class="main">${head}${file}${subs.filter(Boolean).join('')}</div>${acts}</div>`;
  };
  const subLine = (text, title, attrs = '') =>
    text ? `<div class="sub"${attrs}${titleAttr(title)}>${escape(text)}</div>` : '';
  // Only human labels reach the page; machine codes stay in the evidence object.
  // A producer's code (pcf-form-factor-0) is data for tools: the page shows its words, or nothing.
  const formFactors = ['desktop', 'tablet', 'phone'];
  const words = (label) => {
    const code = /^pcf-form-factor-(\d|unknown)$/.exec(label ?? '');
    if (code) return `Mounted for the ${formFactors[code[1]] ?? 'unknown'} layout`;
    return /^[a-z\d]+(?:-[a-z\d]+)+$/.test(label ?? '') ? '' : label;
  };
  const labelOf = (item) => words(typeof item === 'string' ? item : item?.label);
  // The relationships of a place where a script's DOM call was observed (lense/dom-provenance.mjs).
  const callsiteColumn = (relationship, region) =>
    ['created-by', 'cloned-by', 'attached-by', 'moved-by', 'changed-by', 'called-from', 'dom-call', 'through'].includes(
      relationship,
    ) &&
    Number.isSafeInteger(region?.column) &&
    region.column > 1;
  const labels = (items) =>
    (Array.isArray(items) ? items : [])
      .map(labelOf)
      .filter((item) => typeof item === 'string' && item)
      .join('\n');
  const kindLabel = {
    column: 'Column',
    field: 'Column',
    form: 'Form',
    FormXml: 'Form',
    'model-driven-form': 'Form',
    table: 'Table',
    'basic-form': 'Basic form',
    'advanced-form': 'Multistep form',
    'advanced-form-step': 'Multistep form step',
    webpage: 'Web page',
    page: 'Web page',
    view: 'View',
    list: 'List',
    pcf: 'Code component',
    control: 'Form field',
    section: 'Section',
    tab: 'Tab',
    subgrid: 'Subgrid',
    'form-tab': 'Form tab',
    'form-section': 'Form section',
    'form-control': 'Form control',
    'quick-view': 'Quick view',
    'lookup-view': 'Lookup view',
    'list-view': 'List view',
    'liquid-tag': 'Liquid tag',
    'builtin-template': 'Built-in template',
    'content-snippet': 'Content snippet',
    'webpage-field': 'Web page field',
    'page-template': 'Page template',
    template: 'Web template',
    markup: 'Markup',
    'platform-shell': 'Portal page shell',
    'platform-asset': 'Portal runtime file',
    'portal-endpoint': 'Portal endpoint',
    'web-file': 'Web file',
    'external-resource': 'File from another site',
  };
  // The kind of an exported file, by the record kind its source reference carries.
  const refKindLabel = {
    webtemplate: 'Web template',
    pagetemplate: 'Page template',
    contentsnippet: 'Content snippet',
    webpage: 'Web page',
    webfile: 'Web file',
    advancedformstep: 'Multistep form step',
  };
  // A part of a component (a key "<component>#<part>", Mirage's form and list renderers) in words:
  // "validation-summary" reads "validation summary", "action:create" reads "action: create".
  const partWords = {
    'custom-javascript': 'custom JavaScript',
    'client-validation': 'client validation',
    captcha: 'CAPTCHA',
    'empty-maker': 'empty message for makers',
    empty: 'empty message',
    'access-denied': 'access denied message',
    error: 'error message',
    loading: 'loading message',
  };
  const partOf = (item) => {
    const key = typeof item?.key === 'string' ? item.key : '';
    const at = key.indexOf('#');
    return at < 0 ? '' : key.slice(at + 1);
  };
  const partText = (part) =>
    String(part)
      .split(':')
      .map((piece) => partWords[piece] ?? piece.replaceAll('-', ' '))
      .join(': ');
  // How a component relates to the selected element: a short badge on the row, the full sentence in its tooltip.
  const relationLabel = {
    'configured-webpage': ['Contains it', 'The web page of this address, which contains this element'],
    'webpage-hosting-selected-frame': ['Hosts frame', 'The web page that hosts this frame'],
    declares: ['On this page', 'Used on this page'],
    'defined-on': ['Its table', 'The table of this element'],
    'uses-definition': ['Its layout', 'The form layout'],
    contains: ['Contains it', 'Contains this element'],
    'current-view': ['Shown here', 'The view shown here'],
    'declared-modal-form': ['Pop-up', 'A possible pop-up form'],
    'mounted-form-factor': ['Mounted', 'The code component mounted on this element'],
  };
  const relation = (value) =>
    relationLabel[value] ??
    (typeof value === 'string' && value.startsWith('requested-') ? ['From address', 'From the page address'] : null);
  // One badge for a relation wherever an evidence row appears; the panel and X-ray rows use it too (part 'row').
  const relationBadge = (rel) =>
    rel
      ? `<span class="ie-rel" data-relation title="${escape(rel[1])}" role="img" aria-label="${escape(rel[1])}">${escape(rel[0])}</span>`
      : '';
  const panel = options.context === 'panel';
  const action = panel ? 'data-act' : 'data-action';
  const closedReason = {
    stale: 'The page or your sources changed. Select the element again to open this file.',
    conflicting: 'Several files match this element, so none opens. Check the matches first.',
    unavailable: 'This file is not available in your sources. Refresh inspection.',
  };
  // One open/copy pair for a file; the same controls on component, enclosing and source rows. The accessible
  // names carry the row, so a screen reader tells the buttons of different rows apart.
  /* NOSONAR: markup template composed inline, kept as authored */ const sourceActions = (
    ref,
    certainty,
    focusKey,
    name,
  ) => {
    const key = ref.sourceKey ?? ref.key;
    const guarded =
      typeof key === 'string' && key && ref.sourceRevision !== undefined && ref.contentRevision !== undefined;
    const enabled = guarded && ['exact', 'candidate'].includes(certainty);
    const openName = `Open ${name} in the editor`;
    const where = ref.region ? ' at the matching line' : '';
    let title = closedReason[certainty] ?? 'Refresh inspection, then select the element again to open this file.';
    if (enabled) title = openName + where;
    const attributes = `data-source-key="${escape(key)}" data-source-revision="${escape(ref.sourceRevision)}" data-content-revision="${escape(ref.contentRevision)}"${ref.region ? ` data-source-region="${escape(JSON.stringify(ref.region))}"` : ''}`; // NOSONAR: markup template composed inline, kept as authored
    const copyWhat = ref.path ? 'file path' : 'source reference';
    const open = `<button class="ib" ${action}="open" ${panel ? 'data-rel' : 'data-ref'}="${escape(ref.ref)}" ${attributes} data-focus-key="${focusKey}-open" aria-label="${escape(openName)}" title="${escape(title)}"${enabled ? '' : ' disabled'}>${icon('code')}</button>`;
    const copyName = escape('Copy the ' + copyWhat + ' of ' + name);
    const copyKind = ref.path ? 'path' : 'reference';
    const copy = ref.ref
      ? `<button class="ib" ${action}="copy" data-copy="${escape(ref.path ?? ref.ref)}" data-copy-kind="${copyKind}" data-focus-key="${focusKey}-copy" aria-label="${copyName}" title="${copyName}">${icon('copy')}</button>`
      : '';
    return open + copy;
  };
  const sourceOrder = { exact: 0, candidate: 1, conflicting: 2, stale: 3, unavailable: 4 };
  // The file a component row opens: the most certain one; the producer lists a component's definition first.
  const bestRef = (refs) =>
    (Array.isArray(refs) ? refs : [])
      .filter((ref) => ref?.ref)
      .sort((a, b) => sourceOrder[status(a.status)] - sourceOrder[status(b.status)])[0];
  // The part of a shared file that opens, when it tells parts apart: a whole-file field (a template's source, a record's
  // name), an internal one ($record) or one that ends in the row's own name (controls.x_budget on the x_budget row)
  // says nothing to the person.
  const fieldOf = (ref) =>
    Array.isArray(ref?.fieldPath) &&
    ref.fieldPath.length &&
    !ref.fieldPath.some((part) => String(part).startsWith('$')) &&
    String(ref.fieldPath.at(-1)).toLowerCase() !== String(ref.name ?? '').toLowerCase() &&
    !(ref.fieldPath.length === 1 && ['name', 'source', 'value', 'copy', 'content'].includes(ref.fieldPath[0]))
      ? ref.fieldPath.join('.')
      : '';
  // A GUID names nothing a person recognises: such a component is named by its kind instead.
  const guid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const human = (value) => (typeof value === 'string' && value && !guid.test(value) ? value : '');
  const humanName = (item) => human(item.label) || human(item.name) || human(item.field) || human(item.id);

  /* NOSONAR: markup template composed inline, kept as authored */ const component = (item, row) => {
    const kind = kindLabel[item.kind] ?? item.kind;
    // A part is named in words; its code name (the part itself) is not shown.
    const part = partOf(item);
    const ownName = part && item.name === part ? '' : human(item.name);
    // One name format everywhere (the X-ray header, the hover summary, the panel): display name · logical name.
    const name =
      [...new Set([human(item.label), ownName].filter(Boolean))].join(' · ') ||
      (part ? partText(part) : '') ||
      humanName(item) ||
      kind ||
      'Unnamed component';
    // The kind is shown next to the name, so the detail line keeps what tells components of one kind apart.
    const short = [
      item.entity && item.entity !== name ? `Table: ${item.entity}` : '',
      item.field && item.field !== name ? `Column: ${item.field}` : '',
      item.controlName && item.controlName !== name ? `Control: ${item.controlName}` : '',
      item.mountState ? `Mount: ${item.mountState}` : '',
    ].filter(Boolean);
    const full = [
      kind,
      item.entity ? `Table: ${item.entity}` : '',
      item.field ? `Column: ${item.field}` : '',
      item.controlName ? `Control: ${item.controlName}` : '',
      item.formId ? `Form: ${item.formId}` : '',
      item.viewId ? `View: ${item.viewId}` : '',
      item.constructorName ? `Constructor: ${item.constructorName}` : '',
      item.mountState ? `Mount: ${item.mountState}` : '',
      Number.isSafeInteger(item.formFactor) ? `Form factor: ${item.formFactor}` : '',
      item.id ? `ID: ${item.id}` : '',
    ].filter(Boolean);
    const ref = row.ref;
    const actions = ref
      ? sourceActions(
          ref,
          status(ref.status ?? row.status),
          'evidence-component-' + encodeURIComponent((item.key ?? name) + '\0' + (ref.sourceKey ?? ref.key ?? ref.ref)),
          `${String(kind ?? '').toLowerCase()} ${name}`.trim(),
        )
      : '';
    const facts = [...short, fieldOf(ref) ? `Field: ${fieldOf(ref)}` : ''].filter(Boolean);
    // The X-ray card header already names the component, its kind and certainty: its row keeps the rest.
    if (row.compact)
      return facts.length || ref
        ? rowHtml({
            attrs: row.attrs,
            subs: [subLine(facts.join(' · '), full.join(' · '))],
            path: ref?.ref,
            actions,
          })
        : '';
    return rowHtml({
      attrs: row.attrs,
      name,
      // A tooltip that only repeats the kind shown next to the name says nothing.
      nameTitle: full.length > 1 ? full.join(' · ') : '',
      what: name === kind ? '' : kind,
      chips: relationBadge(relation(row.relationship)) + (row.status ? badge(row.status, row.kind, row.how) : ''),
      subs: [subLine(facts.join(' · '), full.join(' · ')), row.extra],
      path: row.showRef ? ref?.ref : undefined,
      actions,
    });
  };
  const valid = evidence?.version === 1;
  const owner = valid ? (evidence.owner ?? {}) : {};
  const source = valid ? (evidence.source ?? {}) : {};
  const ownerStatus = status(owner.status),
    sourceStatus = status(source.status);
  const sourceRows = Array.isArray(source.refs)
    ? [...source.refs].sort(
        (a, b) => sourceOrder[status(a?.status ?? sourceStatus)] - sourceOrder[status(b?.status ?? sourceStatus)],
      )
    : [];
  if (options.part === 'headline') {
    if (!panel) return '';
    const selectedSource = sourceRows[0];
    const reference = typeof selectedSource === 'string' ? selectedSource : selectedSource?.ref;
    const field = fieldOf(selectedSource);
    const text = `${reference ? shownPath(reference) : 'No source file found'}${field ? ' · Field: ' + field : ''}${sourceRows.length > 1 ? ` · +${sourceRows.length - 1} more file${sourceRows.length > 2 ? 's' : ''}` : ''}`; // NOSONAR: nested ternary kept as authored
    // No style attribute: a page whose CSP has no 'unsafe-inline' style source reports one as an error.
    return `<span class="inspection-evidence" data-evidence-headline><span class="sub path" data-evidence-source-context title="${escape(reference ? text.replace(shownPath(reference), () => reference) : text)}"><bdi>${escape(text)}</bdi></span></span>`;
  }
  /* NOSONAR: single-pass routine, splitting it would change shared state */ const sourceRow = (item, index) => {
    const ref = typeof item === 'string' ? { ref: item } : (item ?? {});
    const certainty = ['stale', 'conflicting', 'unavailable'].includes(sourceStatus)
      ? sourceStatus
      : status(ref.status ?? sourceStatus);
    const key = ref.sourceKey ?? ref.key;
    const focusKey = 'evidence-source-' + encodeURIComponent(key ?? ref.ref ?? index);
    const observations = ref.observations ?? {};
    const seen = (value) => value === 'observed' || value === true;
    // Why the file is listed, and only what was seen on this page: an unobserved step is not news.
    const why = [
      typeof ref.evidenceLabel === 'string' ? ref.evidenceLabel : '',
      seen(observations.served) ? 'Loaded by this page' : '',
      seen(observations.executed) ? 'Ran on this page' : '',
      seen(observations.mounted) ? 'Mounted on this page' : '',
      ref.servedVersion === 'differs' ? 'The portal serves another version of this file than your baseline' : '',
    ].filter(Boolean);
    const identityDetails = [
      ref.recordId ? `Record: ${ref.recordId}` : '',
      fieldOf(ref) ? `Field: ${fieldOf(ref)}` : '',
      ref.languageId ? `Language: ${ref.languageId}` : '',
      ref.lcid ? `LCID: ${ref.lcid}` : '',
      ref.profileId ? `Profile: ${ref.profileId}` : '',
    ].filter(Boolean);
    // The part of a shared file that opens stays visible; record, language and profile IDs are in the tooltip. The
    // line of the matching place (the Liquid code that generated the element) is shown when the producer knows it.
    // A place a script's DOM call was observed also names its column: in a minified one-line bundle the line alone
    // does not say where.
    let lineText = '';
    if (ref.region?.line) {
      lineText = `Line ${ref.region.line}`;
      if (callsiteColumn(ref.relationship, ref.region)) lineText += `, column ${ref.region.column}`;
    }
    if (lineText) identityDetails.unshift(lineText);
    const shownIdentity = identityDetails.filter((item) => /^(?:Field|LCID|Line)\b/.test(item));
    const name = ref.name ?? ref.label ?? ref.kind ?? 'Source file';
    return rowHtml({
      attrs: ` data-evidence-source data-rel="${escape(ref.ref)}" data-path="${escape(ref.path)}"`,
      name,
      chips: badge(certainty, 'source'),
      path: ref.ref ?? 'No file path',
      subs: [
        subLine(shownIdentity.join(' · '), identityDetails.join(' · '), ' data-source-identity'),
        subLine(why.join(' · '), '', ' data-source-delivery'),
      ],
      actions: sourceActions(ref, certainty, focusKey, name),
    });
  };
  // A disclosure with nothing in it is not rendered. Its header is the panel's group header.
  const disclosure = (role, title, body) => {
    if (!body) return '';
    const open = options.openGroups ? options.openGroups.includes(role) : role === 'enclosing';
    return `<details data-evidence-role="${role}" data-disclosure="evidence-${role}"${open ? ' open' : ''}><summary class="gh" data-focus-key="evidence-${role}-summary">${icon('right')}<span>${title}</span></summary>${body}</details>`;
  };
  // Limit reasons the person can act on; every other reason is a detail of the search, not news.
  const limitHelp = {
    'node-detached-or-foreign': 'The page replaced this element. Select it again.',
    'origin-boundary': 'This element is in a frame from another site. Open the frame in its own tab.',
    'node-document-origin-boundary': 'This element is in a frame from another site. Open the frame in its own tab.',
    'native-structure-generation-changed': 'The app redrew the form. Select the element again.',
    'native-read-timed-out': 'The app did not answer in time. Click Refresh.',
    'script-hash-conflict':
      'The script that made this element is the same as several of your files, so none of them is named.',
  };
  const notices = [
    ...new Set([
      // A conflict is always news: one without a label of its own still gets the generic line.
      ...(valid ? (evidence.conflicts ?? []) : []).map((item) => labelOf(item) || stateHelp.any.conflicting),
      ...(valid ? (evidence.unavailable ?? []) : []).map(labelOf),
      ...(valid && Array.isArray(evidence.limits?.reasons) ? evidence.limits.reasons : []).map(
        (reason) => limitHelp[reason],
      ),
    ]),
  ].filter((item) => typeof item === 'string' && item);
  const omissionLabel = {
    markupSources: ['large file skipped', 'large files skipped'],
    candidates: ['more match not shown', 'more matches not shown'],
  };
  const omissions = Object.entries(valid ? (evidence.limits?.omitted ?? {}) : {}).filter(
    ([kind, count]) => omissionLabel[kind] && Number.isSafeInteger(count) && count > 0,
  );
  const omittedCount = omissions.reduce((total, [, count]) => total + count, 0);
  const limitSources = (valid && Array.isArray(evidence.limits?.sources) ? evidence.limits.sources : []).slice(0, 32);
  const truncated = valid && evidence.limits?.truncated;
  const omissionText = ([kind, count]) => count + ' ' + omissionLabel[kind][count === 1 ? 0 : 1];
  const skippedRow = (item) =>
    rowHtml({
      name: !item.reason || item.reason === 'index-omission' ? 'Skipped file' : item.reason,
      path: item.ref ?? '',
    });
  // What a limit cut, in words, when the reason says it; any other limit keeps the general line.
  const limitWords = {
    'export-source-hint-index-truncated':
      'Your sources were searched in part: some files are too large or name too many elements.',
    'additional-source-candidates-omitted': 'More files match this element than are listed.',
    'registry-limit': 'This page has more elements than Lense records; this one was not recorded.',
    'dom-evidence-limit':
      'Scripts on this page added more elements than Lense records; how this one was made was not recorded. Reload the page to record it again.',
    'dom-evidence-transport-limit':
      'Scripts on this page changed it faster than Lense could read; how this element was made was not read. Reload the page to read it again.',
    'dom-observation-failed':
      'Lense could not watch the scripts of this page, so it does not know which script made an element. Reload the page to try again.',
    'script-provenance-limit':
      'Scripts on this page added more elements than Lense records; whether a script made this one is not known.',
    'response-proof-too-large':
      'The page the portal sent is too large to compare with your sources, so its elements are not matched to your files.',
    'response-proof-incomplete':
      'Only the first part of the page the portal sent was compared with your sources; this element comes after it.',
    'sign-in-page-untouched':
      'This is a sign-in page: Lense leaves it exactly as the portal sends it and marks nothing on it, so elements here are matched by their markup only.',
  };
  const limitLines = [
    ...new Set(
      (valid && Array.isArray(evidence.limits?.reasons) ? evidence.limits.reasons : [])
        .map((reason) => limitWords[reason])
        .filter(Boolean),
    ),
  ];
  let limitsBody = '';
  if (truncated)
    limitsBody += (limitLines.length ? limitLines : ['Not all matches are shown.'])
      .map((line) => `<div class="banner">${escape(line)}</div>`)
      .join('');
  limitsBody += subLine(omissions.map(omissionText).join(' · '));
  if (limitSources.length)
    limitsBody += '<h4 class="gh">Files skipped by the search</h4>' + limitSources.map(skippedRow).join('');
  // The component's own exact file is shown on its row, not a second time under source files. A file in any other
  // state stays a source row, where its badge says so.
  const ownerRef =
    owner.component?.key && sourceStatus === 'exact'
      ? sourceRows.find(
          (ref) => ref?.ref && ref.componentKey === owner.component.key && (ref.status ?? sourceStatus) === 'exact',
        )
      : undefined;
  const shownSources = sourceRows.filter((ref) => ref !== ownerRef);
  const rows = (items, render) =>
    Array.isArray(items)
      ? items
          .map((item) => render(item))
          .filter(Boolean)
          .join('')
      : '';
  const sourceHeading = shownSources.length > 1 ? 'Source files' : 'Source file';
  const sourceBody = shownSources.length
    ? shownSources.map((item, index) => sourceRow(item, index)).join('')
    : '<div class="empty">No source file found</div>';
  const sourceSection =
    shownSources.length || !ownerRef
      ? `<div data-evidence-role="source"><h4 class="gh">${sourceHeading}</h4>${sourceBody}</div>`
      : '';
  const notShown = omittedCount ? ' <span class="n dimn" title="Not shown">' + omittedCount + '</span>' : '';
  // The X-ray card shows the component's certainty next to its name in the card header.
  if (options.part === 'badge') return owner.component ? badge(ownerStatus, 'component', labels(owner.evidence)) : '';
  // A file row a host lists itself (X-ray's markup matches and page files), in the same layout and with the same
  // icon buttons. Each action: { act, icon, title, label (accessible name, default title), data: { name: value } }.
  if (options.part === 'row') {
    const row = options.row ?? {};
    const actions = (row.actions ?? [])
      .filter(Boolean)
      .map(
        (item) =>
          `<button class="ib" ${action}="${escape(item.act)}"${Object.entries(item.data ?? {})
            .map(([key, value]) => ` data-${key}="${escape(value)}"`)
            .join(
              '',
            )} title="${escape(item.title)}" aria-label="${escape(item.label ?? item.title)}">${icon(item.icon)}</button>`,
      )
      .join('');
    return rowHtml({
      cls: row.cls,
      name: row.name,
      what: row.what,
      chips: row.relation ? relationBadge(row.relation) : '',
      path: row.path,
      subs: (row.subs ?? []).map((text) => subLine(text)),
      actions,
    });
  }
  const ownerRow = owner.component
    ? component(owner.component, {
        attrs: ` data-evidence-role="owner" data-hierarchy-kind="${escape(owner.component.kind)}"`,
        status: ownerStatus,
        kind: 'component',
        how: labels(owner.evidence),
        ref: ownerRef,
        showRef: true,
        compact: options.context === 'xray',
      })
    : '';
  // The template, snippet or page that included the element: its name, file and line, with open and copy.
  const contextRefRow = (item, ref) => {
    const certainty = status(ref.status ?? item.status);
    const name = human(ref.name) || human(ref.label) || refKindLabel[ref.kind] || 'Source file';
    const region = item.region?.line ? item.region : ref.region;
    let line = null;
    if (region?.line) {
      line = String(region.line);
      if (callsiteColumn(item.relationship, region)) line += ', column ' + region.column;
    }
    return rowHtml({
      attrs: ` data-evidence-context data-rel="${escape(ref.ref)}"`,
      name,
      what: refKindLabel[ref.kind] && refKindLabel[ref.kind] !== name ? refKindLabel[ref.kind] : '',
      chips: badge(certainty, 'context', labelOf(item)),
      path: ref.ref,
      subs: [subLine([labelOf(item), line ? `line ${line}` : ''].filter(Boolean).join(' · '))],
      actions: sourceActions(
        ref,
        certainty,
        'evidence-context-' +
          encodeURIComponent((ref.sourceKey ?? ref.key ?? ref.ref) + '\0' + (item.region?.start ?? '')),
        name,
      ),
    });
  };
  const contextRow = (item) => {
    // A context component without a name a person recognises adds a row that says nothing.
    if (item.component && !humanName(item.component)) return '';
    if (item.component)
      return component(item.component, {
        status: item.status,
        kind: 'enclosing',
        relationship: item.relationship,
        how: labelOf(item),
      });
    const ref = bestRef(item.refs);
    if (ref) return contextRefRow(item, ref);
    return labelOf(item) ? rowHtml({ subs: [`<div>${escape(labelOf(item))}</div>`] }) : '';
  };
  return `<section class="inspection-evidence" data-inspection-evidence data-owner-status="${ownerStatus}" data-source-status="${sourceStatus}" aria-label="Selected element details">
    ${ownerRow || (owner.component ? `<div data-evidence-role="owner" data-hierarchy-kind="${escape(owner.component.kind)}"></div>` : '')}
    ${disclosure(
      'enclosing',
      'Contained in',
      rows(valid ? evidence.enclosing : [], (item) =>
        component(item.component ?? item, {
          attrs: ` data-hierarchy-kind="${escape((item.component ?? item).kind)}" data-hierarchy-key="${escape((item.component ?? item).key)}"`,
          status: item.status,
          kind: 'enclosing',
          relationship: item.relationship,
          ref: bestRef(item.refs),
        }),
      ),
    )}
    ${sourceSection}
    ${notices.map((item) => `<div class="banner">${escape(item)}</div>`).join('')}
    ${disclosure(
      'alternatives',
      'Other possible matches',
      rows(valid ? evidence.candidates : [], (item) =>
        component(item.component ?? item, {
          status: item.status ?? 'candidate',
          kind: 'component',
          extra: subLine(labelOf(item)),
        }),
      ),
    )}
    ${disclosure('context', 'Context', rows(valid ? evidence.facts : [], contextRow))}
    ${disclosure('limits', 'Search limits' + notShown, limitsBody)}
  </section>`;
}

// The kit travels inside the renderer's own source, so a host that embeds the renderer embeds the kit with it.
// Only this module's own functions are compiled; page data arrives as arguments.
/* NOSONAR: owned source */ export const renderInspectionEvidence = new Function(
  'evidence',
  'options',
  `const lenseUiKit=(${lenseUiKit.toString()}); return (${renderInspectionEvidenceImpl.toString()})(evidence, options);`,
);
