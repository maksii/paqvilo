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
  const sourceDir = String((evidence?.version === 1 && evidence.sourceDir) || options.sourceDir || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
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
  const rowHtml = ({ cls = '', attrs = '', name, nameTitle, what, chips = '', subs = [], path, actions = '' }) =>
    `<div class="row ie-row${cls ? ' ' + escape(cls) : ''}"${attrs}><div class="main">${name === undefined ? '' : `<div class="name"${nameTitle ? ` title="${escape(nameTitle)}"` : ''}><span>${escape(name)}</span>${what ? `<span class="what">${escape(what)}</span>` : ''}${chips}</div>`}${path === undefined ? '' : `<div class="sub path" title="${escape(path)}"><bdi>${escape(shownPath(path))}</bdi></div>`}${subs.filter(Boolean).join('')}</div>${actions ? `<div class="acts">${actions}</div>` : ''}</div>`;
  const subLine = (text, title, attrs = '') =>
    text ? `<div class="sub"${attrs}${title ? ` title="${escape(title)}"` : ''}>${escape(text)}</div>` : '';
  // Only human labels reach the page; machine codes stay in the evidence object.
  const labelOf = (item) => (typeof item === 'string' ? item : item?.label);
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
  };
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
    const title = enabled
      ? openName + (ref.region ? ' at the matching line' : '')
      : (closedReason[certainty] ?? 'Refresh inspection, then select the element again to open this file.');
    const attributes = `data-source-key="${escape(key)}" data-source-revision="${escape(ref.sourceRevision)}" data-content-revision="${escape(ref.contentRevision)}"${ref.region ? ` data-source-region="${escape(JSON.stringify(ref.region))}"` : ''}`; // NOSONAR: markup template composed inline, kept as authored
    const copyWhat = ref.path ? 'file path' : 'source reference';
    const open = `<button class="ib" ${action}="open" ${panel ? 'data-rel' : 'data-ref'}="${escape(ref.ref)}" ${attributes} data-focus-key="${focusKey}-open" aria-label="${escape(openName)}" title="${escape(title)}"${enabled ? '' : ' disabled'}>${icon('code')}</button>`;
    const copy = ref.ref
      ? `<button class="ib" ${action}="copy" data-copy="${escape(ref.path ?? ref.ref)}" data-copy-kind="${ref.path ? 'path' : 'reference'}" data-focus-key="${focusKey}-copy" aria-label="${escape(`Copy the ${copyWhat} of ${name}`)}" title="${escape(`Copy the ${copyWhat} of ${name}`)}">${icon('copy')}</button>`
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
    // One name format everywhere (the X-ray header, the hover summary, the panel): display name · logical name.
    const name =
      [...new Set([human(item.label), human(item.name)].filter(Boolean))].join(' · ') ||
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
    ].filter(Boolean);
    const identityDetails = [
      ref.recordId ? `Record: ${ref.recordId}` : '',
      fieldOf(ref) ? `Field: ${fieldOf(ref)}` : '',
      ref.languageId ? `Language: ${ref.languageId}` : '',
      ref.lcid ? `LCID: ${ref.lcid}` : '',
      ref.profileId ? `Profile: ${ref.profileId}` : '',
    ].filter(Boolean);
    // The part of a shared file that opens stays visible; record, language and profile IDs are in the tooltip.
    const shownIdentity = identityDetails.filter((item) => /^(?:Field|LCID):/.test(item));
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
  const disclosure = (role, title, body) =>
    body
      ? `<details data-evidence-role="${role}" data-disclosure="evidence-${role}"${options.openGroups?.includes(role) || (!options.openGroups && role === 'enclosing') ? ' open' : ''}><summary class="gh" data-focus-key="evidence-${role}-summary">${icon('right')}<span>${title}</span></summary>${body}</details>`
      : '';
  // Limit reasons the person can act on; every other reason is a detail of the search, not news.
  const limitHelp = {
    'node-detached-or-foreign': 'The page replaced this element. Select it again.',
    'origin-boundary': 'This element is in a frame from another site. Open the frame in its own tab.',
    'node-document-origin-boundary': 'This element is in a frame from another site. Open the frame in its own tab.',
    'native-structure-generation-changed': 'The app redrew the form. Select the element again.',
    'native-read-timed-out': 'The app did not answer in time. Click Refresh.',
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
  const limitsBody =
    truncated || omissions.length || limitSources.length
      ? (truncated ? '<div class="banner">Not all matches are shown.</div>' : '') +
        subLine(omissions.map(([kind, count]) => count + ' ' + omissionLabel[kind][count === 1 ? 0 : 1]).join(' · ')) +
        (limitSources.length ? '<h4 class="gh">Files skipped by the search</h4>' : '') +
        limitSources
          .map((item) =>
            rowHtml({
              name: !item.reason || item.reason === 'index-omission' ? 'Skipped file' : item.reason,
              path: item.ref ?? '',
            }),
          )
          .join('')
      : '';
  // The component's own exact file is shown on its row, not a second time under source files. A file in any other
  // state stays a source row, where its badge says so.
  const ownerRef =
    owner.component?.key && sourceStatus === 'exact'
      ? sourceRows.find(
          (ref) => ref?.ref && ref.componentKey === owner.component.key && (ref.status ?? sourceStatus) === 'exact',
        )
      : undefined;
  const shownSources = sourceRows.filter((ref) => ref !== ownerRef);
  const rows = (items, render) => (Array.isArray(items) ? items.map(render).filter(Boolean).join('') : '');
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
    ${
      shownSources.length || !ownerRef
        ? `<div data-evidence-role="source"><h4 class="gh">${shownSources.length > 1 ? 'Source files' : 'Source file'}</h4>${shownSources.length ? shownSources.map(sourceRow).join('') : '<div class="empty">No source file found</div>'}</div>`
        : ''
    }
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
    ${disclosure(
      'context',
      'Context',
      rows(valid ? evidence.facts : [], (item) => {
        // A context component without a name a person recognises adds a row that says nothing.
        if (item.component && !humanName(item.component)) return '';
        if (item.component)
          return component(item.component, {
            status: item.status,
            kind: 'enclosing',
            relationship: item.relationship,
            how: labelOf(item),
          });
        return labelOf(item) ? rowHtml({ subs: [`<div>${escape(labelOf(item))}</div>`] }) : '';
      }),
    )}
    ${disclosure('limits', 'Search limits' + (omittedCount ? ` <span class="n dimn" title="Not shown">${omittedCount}</span>` : ''), limitsBody)}
  </section>`;
}

// The kit travels inside the renderer's own source, so a host that embeds the renderer embeds the kit with it.
/* NOSONAR: intentional local script execution or generated handler */ export const renderInspectionEvidence =
  new Function(
    'evidence',
    'options',
    `const lenseUiKit=(${lenseUiKit.toString()}); return (${renderInspectionEvidenceImpl.toString()})(evidence, options);`,
  );
