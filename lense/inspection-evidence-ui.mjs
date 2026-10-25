/** Self-contained renderer embedded in both serialized browser interfaces. */
export function renderInspectionEvidence(evidence, options = {}) {
  if (options.part === 'styles')
    return `
    .inspection-evidence{font:inherit;color:var(--fg,#212529);min-width:0}.inspection-evidence h4{font-size:12px;margin:0 0 5px}.inspection-evidence .ie-role{padding:10px 0;border-bottom:1px solid var(--line,#d8dfe7)}.inspection-evidence .ie-state{display:inline-block;font-size:10px;border:1px solid var(--line,#d8dfe7);border-radius:4px;padding:1px 5px;margin-left:5px;font-weight:400}.inspection-evidence [data-status=exact]{color:var(--link,#17604d)}.inspection-evidence [data-status=candidate],.inspection-evidence [data-status=conflicting],.inspection-evidence [data-status=stale]{color:var(--muted,#69551c)}.inspection-evidence .ie-row{margin:5px 0;overflow-wrap:anywhere}.inspection-evidence .ie-note{font-size:11px;color:var(--muted,#667085);margin:3px 0;overflow-wrap:anywhere}.inspection-evidence .ie-ref{font:11px/1.5 Consolas,monospace;overflow-wrap:anywhere}.inspection-evidence .ie-actions{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}.inspection-evidence button{font:inherit;font-size:11px;border:1px solid var(--line,#d8dfe7);border-radius:4px;background:var(--bg,#fff);color:var(--link,#175cd3);padding:3px 7px;cursor:pointer}.inspection-evidence button:disabled{opacity:.6;cursor:default}.inspection-evidence button:focus-visible,.inspection-evidence summary:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}.inspection-evidence details{margin:0}.inspection-evidence summary{cursor:pointer;font-size:12px;padding:3px 0;color:inherit}.inspection-evidence .ie-notice{padding:7px 9px;border-left:3px solid var(--line,#d8dfe7);margin:7px 0}.inspection-evidence .ie-empty{font-size:11px;color:var(--muted,#667085)}
  `;
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    );
  const states = ['exact', 'candidate', 'conflicting', 'unavailable', 'stale'];
  const status = (value) => (states.includes(value) ? value : 'unavailable');
  const stateLabel = {
    exact: 'Exact',
    candidate: 'Candidate',
    conflicting: 'Conflicting',
    unavailable: 'Unavailable',
    stale: 'Stale',
  };
  const badge = (value) => `<span class="ie-state" data-status="${status(value)}">${stateLabel[status(value)]}</span>`;
  const text = (value) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? escape(value) : '';
  const note = (item) => text(typeof item === 'string' ? item : (item?.label ?? item?.reason ?? item?.kind));
  const kindLabel = {
    column: 'Column',
    field: 'Column',
    form: 'Form',
    FormXml: 'Form',
    table: 'Table',
    'basic-form': 'Basic form',
    'advanced-form': 'Advanced form',
    'advanced-form-step': 'Advanced form step',
    webpage: 'Webpage',
    page: 'Webpage',
    view: 'View',
    list: 'List',
    pcf: 'Code component',
    control: 'Control',
  };
  const component = (item) => {
    if (!item) return '<span class="ie-empty">No owner established</span>';
    const details = [
      kindLabel[item.kind] ?? item.kind,
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
    return `<strong>${escape(item.name ?? item.label ?? item.field ?? item.id ?? item.kind ?? 'Unresolved component')}</strong>${details.length ? `<div class="ie-note">${details.map(escape).join(' · ')}</div>` : ''}`;
  };
  const list = (items, render, empty) =>
    Array.isArray(items) && items.length ? items.map(render).join('') : `<div class="ie-empty">${escape(empty)}</div>`;
  const valid = evidence?.version === 1;
  const owner = valid ? (evidence.owner ?? {}) : {};
  const source = valid ? (evidence.source ?? {}) : {};
  const ownerStatus = status(owner.status),
    sourceStatus = status(source.status);
  const sourceOrder = { exact: 0, candidate: 1, conflicting: 2, stale: 3, unavailable: 4 };
  const sourceRows = Array.isArray(source.refs)
    ? [...source.refs].sort(
        (a, b) => sourceOrder[status(a?.status ?? sourceStatus)] - sourceOrder[status(b?.status ?? sourceStatus)],
      )
    : [];
  if (options.part === 'headline') {
    const selectedSource = sourceRows[0];
    const reference = typeof selectedSource === 'string' ? selectedSource : selectedSource?.ref;
    const field = Array.isArray(selectedSource?.fieldPath) ? selectedSource.fieldPath.join('.') : '';
    const sourceContext =
      options.context === 'panel'
        ? `<span class="ie-ref" data-evidence-source-context style="display:block">${escape(reference ?? 'Local source unavailable')}${field ? ' · Field: ' + escape(field) : ''}${sourceRows.length > 1 ? ` · +${sourceRows.length - 1} references` : ''}</span>`
        : '';
    return `<span class="inspection-evidence" data-evidence-headline>Owner${badge(ownerStatus)} · Local source${badge(sourceStatus)}${sourceContext}</span>`;
  }
  const panel = options.context === 'panel';
  const action = panel ? 'data-act' : 'data-action';
  const sourceRow = (item, index) => {
    const ref = typeof item === 'string' ? { ref: item } : (item ?? {});
    const certainty = ['stale', 'conflicting', 'unavailable'].includes(sourceStatus)
      ? sourceStatus
      : status(ref.status ?? sourceStatus);
    const key = ref.sourceKey ?? ref.key;
    const guarded =
      typeof key === 'string' && key && ref.sourceRevision !== undefined && ref.contentRevision !== undefined;
    const enabled = guarded && ['exact', 'candidate'].includes(certainty);
    const focusKey = 'evidence-source-' + encodeURIComponent(key ?? ref.ref ?? index);
    const attributes = `data-source-key="${escape(key)}" data-source-revision="${escape(ref.sourceRevision)}" data-content-revision="${escape(ref.contentRevision)}"${ref.region ? ` data-source-region="${escape(JSON.stringify(ref.region))}"` : ''}`;
    const observations = ref.observations ?? {};
    const observation = (value, yes, no) => (value === 'observed' || value === true ? yes : no);
    const delivery =
      ref.kind === 'script' || ref.kind === 'stylesheet' || ref.kind === 'asset' || Object.keys(observations).length
        ? `<div class="ie-note" data-source-delivery>${observation(observations.served, 'Served', 'Serving not observed')} · ${observation(observations.executed, 'Execution observed', 'Execution not observed')}${observations.mounted !== undefined ? ' · ' + observation(observations.mounted, 'Mount observed', 'Mount not observed') : ''}</div>`
        : '';
    const label = certainty === 'candidate' ? 'Open candidate' : 'Open source';
    const identityDetails = [
      ref.recordId ? `Record: ${ref.recordId}` : '',
      Array.isArray(ref.fieldPath) && ref.fieldPath.length ? `Field: ${ref.fieldPath.join('.')}` : '',
      ref.languageId ? `Language: ${ref.languageId}` : '',
      ref.lcid ? `LCID: ${ref.lcid}` : '',
      ref.profileId ? `Profile: ${ref.profileId}` : '',
    ].filter(Boolean);
    return `<div class="ie-row" data-evidence-source data-rel="${escape(ref.ref)}" data-path="${escape(ref.path)}"><strong>${escape(ref.name ?? ref.label ?? ref.kind ?? 'Local source')}</strong>${badge(certainty)}<div class="ie-ref">${escape(ref.ref ?? 'Source reference unavailable')}</div>${identityDetails.length ? `<div class="ie-note" data-source-identity>${identityDetails.map(escape).join(' · ')}</div>` : ''}${ref.evidenceLabel ? `<div class="ie-note">${escape(ref.evidenceLabel)}</div>` : ''}${delivery}<div class="ie-actions"><button ${action}="open" ${panel ? 'data-rel' : 'data-ref'}="${escape(ref.ref)}" ${attributes} data-focus-key="${focusKey}-open" ${enabled ? '' : 'disabled'} title="${enabled ? 'Backend verifies source identity and both revisions before opening' : 'Current verified source identity is unavailable'}">${label}</button>${ref.ref ? `<button ${action}="copy" data-copy="${escape(ref.path ?? ref.ref)}" data-copy-kind="${ref.path ? 'path' : 'reference'}" data-focus-key="${focusKey}-copy">Copy ${ref.path ? 'path' : 'reference'}</button>` : ''}</div></div>`;
  };
  const disclosure = (role, title, body) =>
    `<details class="ie-role" data-evidence-role="${role}" data-disclosure="evidence-${role}"${options.openGroups?.includes(role) || (!options.openGroups && role === 'enclosing' && evidence?.enclosing?.length) ? ' open' : ''}><summary data-focus-key="evidence-${role}-summary">${title}</summary>${body}</details>`;
  const notices = [...(valid ? (evidence.conflicts ?? []) : []), ...(valid ? (evidence.unavailable ?? []) : [])];
  const omissions = Object.entries(valid ? (evidence.limits?.omitted ?? {}) : {}).filter(
    ([, count]) => Number.isSafeInteger(count) && count > 0,
  );
  const omittedCount = omissions.reduce((total, [, count]) => total + count, 0);
  const limitSources = (valid && Array.isArray(evidence.limits?.sources) ? evidence.limits.sources : []).slice(0, 32);
  const limitSummary =
    'Limits & freshness' +
    (evidence?.limits?.truncated ? ' · Search limited' : '') +
    (omittedCount ? ` · ${omittedCount} omitted` : '');
  return `<section class="inspection-evidence" data-inspection-evidence data-owner-status="${ownerStatus}" data-source-status="${sourceStatus}" aria-label="Selected element evidence">
    ${options.selectedLabel ? `<div class="ie-note">${escape(options.selectedLabel)}</div>` : ''}
    <div class="ie-role" data-evidence-role="owner" data-hierarchy-kind="${escape(owner.component?.kind ?? 'unavailable')}"><h4>Owner${badge(ownerStatus)}</h4>${component(owner.component)}${list(owner.evidence, (item) => `<div class="ie-note">${note(item)}</div>`, 'No direct owner evidence')}</div>
    ${disclosure(
      'enclosing',
      'Enclosing components',
      list(
        valid ? evidence.enclosing : [],
        (item) =>
          `<div class="ie-row" data-hierarchy-kind="${escape((item.component ?? item).kind)}" data-hierarchy-key="${escape((item.component ?? item).key)}">${component(item.component ?? item)}${badge(item.status)}<div class="ie-note">${escape(item.relationship?.replaceAll('-', ' ') ?? 'Enclosing context; ownership is separate')}</div></div>`,
        'No enclosing component established',
      ),
    )}
    <div class="ie-role" data-evidence-role="source"><h4>Local source${badge(sourceStatus)}</h4>${list(sourceRows, sourceRow, 'Local source unavailable')}</div>
    ${notices.length ? `<div class="ie-notice">${notices.map((item) => `<div class="ie-note">${note(item)}</div>`).join('')}</div>` : ''}
    ${disclosure(
      'context',
      'Context',
      list(
        valid ? evidence.facts : [],
        (item) =>
          `<div class="ie-row">${item.component ? component(item.component) + badge(item.status) : text(item.label ?? item.kind)}${item.value !== undefined ? ': ' + text(item.value) : ''}${item.component ? `<div class="ie-note">${note(item)}${item.relationship ? ' · ' + escape(item.relationship) : ''}</div>` : ''}</div>`,
        'No additional observed context',
      ),
    )}
    ${disclosure(
      'alternatives',
      'Alternatives',
      list(
        valid ? evidence.candidates : [],
        (item) =>
          `<div class="ie-row">${component(item.component ?? item)}${badge(item.status ?? 'candidate')}<div class="ie-note">${note(item)}</div></div>`,
        'No alternatives admitted',
      ),
    )}
    ${disclosure('limits', limitSummary, `${evidence?.limits?.truncated ? '<div class="ie-notice">Search limited; more matches may exist.</div>' : '<div class="ie-empty">No reported truncation</div>'}${list(valid ? evidence.limits?.reasons : [], (item) => `<div class="ie-note">${note(item)}</div>`, '')}${omissions.length ? '<div class="ie-note">' + omissions.map(([kind, count]) => escape(kind) + ': ' + count).join(' · ') + '</div>' : ''}${limitSources.length ? '<div class="ie-notice">Index omissions; not attributed to the selected element</div>' + limitSources.map((item) => '<div class="ie-note">' + escape(item.reason ?? 'Omitted source') + '</div><div class="ie-ref">' + escape(item.ref ?? '') + '</div>').join('') : ''}<div class="ie-note">Owner and local source certainty are independent. Deployed revision is unverified unless separately observed.</div>`)}
  </section>`;
}
