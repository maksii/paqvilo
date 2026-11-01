import { definitionQuery } from './definition-query.mjs';

// All embedded code is owned; DOM nodes and bindings remain separate arguments.
export const observePortalNode = new Function(
  `return function observePortalNode(node,options={}){const definitionQuery=(${definitionQuery.toString()}); return (${observePortalNodeImpl.toString()})(node,options);};`,
)();

/** Self-contained structural Power Pages read. No field values, row IDs or text.
 * Definition URL hints may reject a conflicting placement, never prove one. */
function observePortalNodeImpl(
  node,
  { scope, bindings = {}, sourceRefs = [], sourceRefsByComponent = null, frameDepth = 0 } = {},
) {
  const result = { version: 1, scope, facts: [], sourceRefs: [], availability: [], componentAnchors: [] };
  if (!node?.isConnected || !node.ownerDocument) return result;
  const doc = node.ownerDocument;
  if (!['http:', 'https:'].includes(doc.defaultView?.location?.protocol)) {
    result.availability.push({ reason: 'component-origin-unverified' });
    return result;
  }
  const norm = (value) =>
    String(value ?? '')
      .replace(/[{}-]/g, '')
      .toLowerCase();
  const attribute = (element, name) => element?.getAttribute?.(name) ?? '';
  const componentId = (value) => norm(value?.id ?? value?.recordId);
  const compact = (value) =>
    String(value ?? '')
      .replace(/[{}-]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
  const ancestors = [];
  for (
    let current = node;
    current?.ownerDocument === doc && ancestors.length < 64;
    current = current.assignedSlot ?? current.parentElement ?? current.getRootNode?.()?.host
  )
    ancestors.push(current);
  const forms = bindings.forms ?? [],
    lists = bindings.lists ?? [],
    views = bindings.views ?? [];
  const formKind = (form) =>
    ({
      FormXml: 'form',
      systemform: 'form',
      entityform: 'basic-form',
      basicform: 'basic-form',
      webform: 'advanced-form',
      advancedform: 'advanced-form',
    })[form.kind] ??
    form.kind ??
    'basic-form';
  const nativeFormsFor = (element) =>
    forms.filter((form) => {
      const prefix =
        formKind(form) === 'advanced-form'
          ? 'WebFormControl_'
          : formKind(form) === 'basic-form'
            ? 'EntityFormControl_'
            : null;
      if (!prefix) return false;
      const base = prefix + compact(form.id);
      return (
        element.id === base ||
        element.id === base + '_EntityFormView' ||
        (prefix === 'WebFormControl_' && element.id === base + '_ProgressIndicator')
      );
    });
  const genericNativeId = (id) =>
    [
      'EntityFormControl',
      'WebFormControl',
      'EntityFormView',
      'EntityFormControl_EntityFormView',
      'WebFormControl_ProgressIndicator',
    ].includes(id);
  let boundary = null,
    declaredTable = '',
    chosenForm = null,
    chosenList = null,
    chosenView = null;
  let conflict = false,
    observedTable = false,
    conflictReason = 'conflicting-rendered-table-context';
  const gridCell = ancestors.find((item) => item.matches('td,th,[data-paqvilo-column]'));
  const gridTable = gridCell?.closest('table');
  let chosenGrid = false;
  let genericFormBoundary = false,
    modalCandidates = [];
  for (const current of ancestors) {
    if (current === gridTable && bindings.grid?.name) {
      const cloneId = attribute(current, 'data-paqvilo-grid');
      const targets = cloneId ? [...current.getRootNode().querySelectorAll('#' + CSS.escape(cloneId))] : [current];
      const table = targets.length === 1 && targets[0].localName === 'table' ? targets[0] : null;
      const name = attribute(table, 'data-paqvilo-table').toLowerCase();
      // The column comes from the passive declaration reader, but its table
      // must also be declared by this exact grid (or its explicit clone target).
      // Never borrow an enclosing form's table for an unbound custom grid.
      if (!/^[a-z][a-z0-9_]*$/.test(name) || bindings.grid.table?.toLowerCase() !== name) break;
      const tableNames = [...new Set([current, table])]
        .flatMap((element) =>
          ['data-entityname', 'data-entity', 'data-paqvilo-table'].map((key) => attribute(element, key).toLowerCase()),
        )
        .filter(Boolean);
      if ((declaredTable && declaredTable !== name) || tableNames.some((value) => value !== name)) conflict = true;
      declaredTable = name;
      observedTable = true;
      chosenGrid = true;
      boundary = current;
      break;
    }
    const layouts = [];
    const nativeWrapper = /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(current.id ?? '');
    const genericView = current.id === 'EntityFormView' || current.id === 'EntityFormControl_EntityFormView';
    const genericWrapper = genericNativeId(current.id);
    // A child frame's own layout constrains its target, not this containing form.
    const nativeLayouts =
      nativeWrapper || genericView
        ? [...current.querySelectorAll(':scope > [data-form-layout]:not(iframe)')].slice(0, 2)
        : [];
    if (current.id === 'WebFormControl')
      nativeLayouts.push(
        ...[
          ...current.querySelectorAll(':scope > #WebFormPanel > #EntityFormView > [data-form-layout]:not(iframe)'),
        ].slice(0, 2),
      );
    if (current.id === 'EntityFormControl')
      nativeLayouts.push(
        ...[
          ...current.querySelectorAll(
            ':scope > #EntityFormPanel > #EntityFormControl_EntityFormView > [data-form-layout]:not(iframe)',
          ),
        ].slice(0, 2),
      );
    if (nativeLayouts.length > 1) {
      result.availability.push({ reason: 'ambiguous-native-layout' });
      break;
    }
    let invalidLayout = false;
    for (const encoded of [
      attribute(current, 'data-form-layout'),
      attribute(nativeLayouts[0], 'data-form-layout'),
    ].filter(Boolean)) {
      if (encoded.length > 65536) {
        invalidLayout = true;
        break;
      }
      try {
        const parsed = JSON.parse(encoded);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) layouts.push(parsed);
        else invalidLayout = true;
      } catch {
        invalidLayout = true;
      }
    }
    if (invalidLayout) {
      result.availability.push({ reason: 'invalid-rendered-form-layout' });
      break;
    }
    const tableNames = [
      attribute(current, 'data-entityname'),
      attribute(current, 'data-entity'),
      attribute(current, 'data-paqvilo-table'),
      ...layouts.map((layout) => layout.EntityName),
    ]
      .filter((value) => typeof value === 'string' && /^[a-z][a-z0-9_]*$/i.test(value))
      .map((value) => value.toLowerCase());
    if (new Set(tableNames).size > 1) conflict = true;
    observedTable ||= tableNames.length > 0;
    declaredTable ||= tableNames[0] ?? '';
    const formIds = [
      attribute(current, 'data-formid'),
      ...layouts.map((layout) => {
        if (typeof layout.Id !== 'string') return '';
        // Native Power Pages layouts can carry the empty GUID even while the
        // wrapper names the actual basic form. This is an absent layout ID,
        // not a second component that can contradict that observed wrapper.
        if (norm(layout.Id) === '0'.repeat(32)) {
          result.availability.push({ capability: 'layout-form-id', reason: 'native-layout-form-id-unavailable' });
          return '';
        }
        return layout.Id;
      }),
    ].filter(Boolean);
    const declaredForms = formIds.map((formId) =>
      forms.filter((form) =>
        [form.id, form.formXml?.id, ...(form.formLayouts ?? []).map((layout) => layout.id)].some(
          (id) => id && norm(id) === norm(formId),
        ),
      ),
    );
    const nativeForms = nativeFormsFor(current);
    const outerWrapper = genericView
      ? ancestors
          .slice(ancestors.indexOf(current) + 1)
          .find((element) => /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(element.id ?? ''))
      : null;
    const outerForms = outerWrapper ? nativeFormsFor(outerWrapper) : [];
    const expectedKind =
      current.id === 'EntityFormView' || /^WebFormControl(?:_|$)/.test(current.id ?? '')
        ? 'advanced-form'
        : nativeWrapper || current.id === 'EntityFormControl_EntityFormView'
          ? 'basic-form'
          : null;
    const formConstraints = [
      ...declaredForms,
      ...(nativeForms.length ? [nativeForms] : []),
      ...(outerForms.length ? [outerForms] : []),
    ];
    if (formConstraints.length && expectedKind)
      formConstraints.push(forms.filter((form) => formKind(form) === expectedKind));
    const matchingForms = formConstraints.length
      ? forms.filter((form) => formConstraints.every((matches) => matches.includes(form)))
      : [];
    const listId =
      attribute(current, 'data-listid') ||
      /^EntityList(?:Control_)?([0-9a-f-]{32,36})(?:$|_)/i.exec(current.id ?? '')?.[1];
    const matchingLists = lists.filter((list) => listId && componentId(list) === norm(listId));
    const viewId = attribute(current, 'data-viewid') || attribute(current, 'data-selected-view');
    const matchingViews = views.filter((view) => viewId && componentId(view) === norm(viewId));
    const unrecognized =
      declaredForms.some((matches) => !matches.length) ||
      (nativeWrapper && !nativeForms.length && !genericWrapper) ||
      (outerWrapper && !outerForms.length && !genericNativeId(outerWrapper.id)) ||
      (listId && !matchingLists.length) ||
      (viewId && !matchingViews.length);
    if (unrecognized) {
      result.availability.push({ reason: 'nearest-component-definition-missing' });
      break;
    }
    if (formConstraints.length > 1 && !matchingForms.length) {
      conflict = true;
      conflictReason = 'conflicting-rendered-form-identifiers';
      break;
    }
    if (matchingForms.length > 1 || matchingLists.length > 1 || matchingViews.length > 1) {
      result.availability.push({ reason: 'ambiguous-rendered-component-id' });
      break;
    }
    if (matchingForms.length || matchingLists.length || matchingViews.length) {
      boundary = current;
      chosenForm = matchingForms[0];
      if (chosenForm && formKind(chosenForm) === 'advanced-form') {
        const renderedLayouts = (chosenForm.formLayouts ?? []).filter((layout) =>
          layouts.some((observed) => norm(observed.Id) === norm(layout.id)),
        );
        if (renderedLayouts.length === 1) {
          if (declaredTable && declaredTable !== renderedLayouts[0].entity) conflict = true;
          chosenForm = { ...chosenForm, formXml: renderedLayouts[0] };
          declaredTable ||= renderedLayouts[0].entity;
        }
      }
      chosenList = matchingLists[0];
      chosenView = matchingViews[0];
      const configuredEntities =
        formKind(chosenForm ?? {}) === 'advanced-form' ? (chosenForm?.configuredEntities ?? []) : [];
      const tables = [chosenForm, chosenList, chosenView]
        .map((item) => {
          if (item === chosenForm && formKind(item ?? {}) === 'advanced-form')
            return configuredEntities.length === 1 ? configuredEntities[0] : declaredTable || undefined;
          return item?.entity?.toLowerCase();
        })
        .filter(Boolean);
      if (declaredTable && configuredEntities.length && !configuredEntities.includes(declaredTable)) conflict = true;
      if (new Set(tables).size > 1 || (declaredTable && tables.some((table) => table !== declaredTable)))
        conflict = true;
      declaredTable ||= tables[0] ?? '';
      if (chosenForm && formKind(chosenForm) === 'advanced-form' && !declaredTable)
        result.availability.push({ capability: 'current-table', reason: 'advanced-form-active-table-unavailable' });
      break;
    }
    if (genericWrapper && expectedKind === 'basic-form' && layouts.length && declaredTable && !formConstraints.length) {
      // A native modal layout can expose its table while deliberately omitting
      // the form GUID. Retain that boundary instead of losing all context.
      boundary = current;
      genericFormBoundary = true;
      break;
    }
  }
  if (genericFormBoundary && frameDepth < 16) {
    let frame, modal, grid;
    try {
      const candidate = doc.defaultView.frameElement;
      const address = candidate?.getAttribute('data-page');
      const expected = address && new URL(address, candidate.ownerDocument.baseURI);
      const current = new URL(doc.URL);
      if (
        candidate?.isConnected &&
        !candidate.hasAttribute('sandbox') &&
        candidate.contentDocument === doc &&
        candidate.ownerDocument.defaultView.location.origin === current.origin &&
        expected?.origin === current.origin &&
        expected.pathname === current.pathname &&
        /^\/_portal\/modal-form-template-path\//i.test(current.pathname)
      ) {
        frame = candidate;
        modal = frame.closest('.modal-form');
        grid = modal?.closest('.entity-grid');
      }
    } catch {
      /* Inaccessible or replaced frames cannot establish a placement. */
    }
    if (grid && frame.closest('.entity-grid') === grid) {
      const kinds = [
        ['modal-form-insert', 'CreateAction'],
        ['modal-form-edit', 'EditAction'],
        ['modal-form-details', 'DetailsAction'],
      ].filter(([name]) => modal.classList.contains(name));
      // Exact ownership needs a rendered list/subgrid identity or a page-referenced
      // list; other exported lists sharing the rendered view only supply candidates.
      let owners = [],
        candidateOwners = null;
      const subgrid = grid.closest('.subgrid[id]');
      let placementConflict = false;
      if (subgrid) {
        const parent = observePortalNodeImpl(subgrid.parentElement, {
          scope,
          bindings,
          sourceRefs,
          sourceRefsByComponent,
          frameDepth: frameDepth + 1,
        });
        const parentForms = parent.facts.filter(
          (fact) =>
            fact.proof === 'native-component-id' && ['basic-form', 'advanced-form'].includes(fact.binding?.kind),
        );
        if (parentForms.length === 1)
          owners = (bindings.subgrids ?? []).filter(
            (component) => component.id === subgrid.id && norm(component.formId) === norm(parentForms[0].binding.id),
          );
      } else {
        const wrapper = grid.closest('[data-listid],[id^=EntityList]');
        const explicitId = attribute(wrapper, 'data-listid');
        const nativeId = /^EntityList(?:Control_)?([0-9a-f-]{32,36})(?:$|_)/i.exec(wrapper?.id ?? '')?.[1];
        const listId = explicitId || nativeId || (wrapper?.id === 'EntityListControl' ? bindings.pageListId : '');
        const viewId = attribute(grid, 'data-selected-view');
        placementConflict = !!(explicitId && nativeId && norm(explicitId) !== norm(nativeId));
        if (listId) owners = lists.filter((list) => componentId(list) === norm(listId));
        else if (!wrapper && viewId) {
          candidateOwners = lists.filter((list) => (list.viewIds ?? []).some((id) => norm(id) === norm(viewId)));
          owners = candidateOwners.filter((list) => list.pageReferenced === true);
        }
        if (listId && viewId && owners.some((list) => !(list.viewIds ?? []).some((id) => norm(id) === norm(viewId))))
          placementConflict = true;
      }
      const actionsOf = (rows, names) =>
        rows.flatMap((owner) =>
          (owner.actions ?? [])
            .filter((action) => action.formId && names.includes(action.name))
            .map((action) => ({ owner, action })),
        );
      const formsOf = (rows) =>
        forms.filter(
          (form) => formKind(form) === 'basic-form' && rows.some(({ action }) => norm(action.formId) === norm(form.id)),
        );
      const actions = kinds.length === 1 ? actionsOf(owners, [kinds[0][1]]) : [];
      // Candidate context: the declared action forms of the modal's kinds (all kinds
      // when the container names none) on the rendered layout table.
      modalCandidates = formsOf(
        actionsOf(
          candidateOwners ?? owners,
          kinds.length ? kinds.map(([, name]) => name) : ['CreateAction', 'EditAction', 'DetailsAction'],
        ),
      ).filter((form) => !form.entity || form.entity.toLowerCase() === declaredTable);
      const targets = formsOf(actions);
      if (!placementConflict && owners.length === 1 && actions.length === 1 && targets.length === 1) {
        const target = targets[0];
        const params = definitionQuery(new URL(doc.URL));
        const disagree = params.some(([key, value]) =>
          ['entityformid', 'formid'].includes(key)
            ? ![target.id, target.formXml?.id].some((id) => id && norm(id) === norm(value))
            : value.toLowerCase() !== declaredTable,
        );
        if (
          target.entity?.toLowerCase() !== declaredTable ||
          owners[0].entity?.toLowerCase() !== declaredTable ||
          disagree
        ) {
          conflict = true;
          conflictReason = 'conflicting-modal-placement';
        } else chosenForm = target;
      }
    }
  }
  if (conflict) {
    result.facts.push({
      id: 'portal-table-conflict',
      scope,
      dimension: 'owner',
      kind: 'binding-conflict',
      subject: 'selection',
      predicate: 'identity',
      reason: conflictReason,
    });
    return result;
  }
  if (!boundary && !result.availability.length && frameDepth < 16) {
    // Native quick views declare their control, lookup and form name on the
    // containing iframe. Join that exact placement to an independently observed
    // parent form and its exported QuickForms target. URL hints supply no proof.
    let frame;
    try {
      const candidate = doc.defaultView.frameElement;
      const expected = candidate?.getAttribute('data-path');
      const address = expected && new URL(expected, candidate.ownerDocument.baseURI);
      const current = new URL(doc.URL);
      if (
        candidate?.isConnected &&
        !candidate.hasAttribute('sandbox') &&
        candidate.contentDocument === doc &&
        candidate.ownerDocument.defaultView.location.origin === doc.defaultView.location.origin &&
        candidate.matches('iframe.quickform[data-controlid][data-lookup-element][data-formname]') &&
        address?.origin === current.origin &&
        address.pathname === current.pathname &&
        candidate.id === attribute(candidate, 'data-controlid')
      )
        frame = candidate;
    } catch {
      /* Inaccessible frames remain boundaries. */
    }
    if (
      frame &&
      ancestors.includes(doc.documentElement) &&
      !ancestors.some((item) => item.matches('[data-formid],[data-form-layout]') || genericNativeId(item.id))
    ) {
      const parent = observePortalNodeImpl(frame.assignedSlot ?? frame.parentElement ?? frame.getRootNode()?.host, {
        scope,
        bindings,
        sourceRefs,
        sourceRefsByComponent,
        frameDepth: frameDepth + 1,
      });
      const enclosingForms = parent.facts.filter((fact) =>
        ['basic-form', 'advanced-form', 'form'].includes(fact.binding?.kind),
      );
      const placements = (bindings.quickForms ?? []).filter(
        (placement) =>
          placement.id === frame.id &&
          placement.lookup === attribute(frame, 'data-lookup-element') &&
          placement.formName === attribute(frame, 'data-formname') &&
          enclosingForms.some((fact) =>
            [placement.formId, placement.ownerFormXmlId].some((id) => id && norm(id) === norm(fact.binding.id)),
          ),
      );
      const targets = placements.flatMap((placement) =>
        forms.filter(
          (form) =>
            formKind(form) === 'form' &&
            placement.targetFormId &&
            norm(form.id) === norm(placement.targetFormId) &&
            form.entity?.toLowerCase() === placement.entity?.toLowerCase() &&
            form.name === placement.formName,
        ),
      );
      if (placements.length === 1 && targets.length === 1) {
        // Parameters can contradict a declaration after navigation, but cannot
        // establish ownership in the absence of that rendered placement.
        const params = definitionQuery(new URL(doc.URL), { formName: true });
        const aliases = forms.filter((form) => norm(form.formXml?.id) === norm(targets[0].id)).map((form) => form.id);
        const frameTables = ['data-entityname', 'data-entity', 'data-paqvilo-table']
          .map((key) => attribute(frame, key).toLowerCase())
          .filter(Boolean);
        const frameForms = [attribute(frame, 'data-formid')].filter(Boolean);
        const encoded = attribute(frame, 'data-form-layout');
        if (encoded) {
          try {
            if (encoded.length > 65536) throw Error('Oversized layout');
            const layout = JSON.parse(encoded);
            if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw Error('Invalid layout');
            if (typeof layout.EntityName === 'string' && layout.EntityName)
              frameTables.push(layout.EntityName.toLowerCase());
            if (typeof layout.Id === 'string' && layout.Id && norm(layout.Id) !== '0'.repeat(32))
              frameForms.push(layout.Id);
          } catch {
            result.availability.push({ reason: 'invalid-rendered-form-layout' });
            return result;
          }
        }
        if (
          frameForms.some(
            (id) => !forms.some((form) => [form.id, form.formXml?.id].some((value) => norm(value) === norm(id))),
          )
        ) {
          result.availability.push({ reason: 'nearest-component-definition-missing' });
          return result;
        }
        const frameConflict =
          frameTables.some((entity) => entity !== targets[0].entity.toLowerCase()) ||
          frameForms.some((id) => ![targets[0].id, ...aliases].some((value) => norm(value) === norm(id)));
        const urlConflict = params.some(
          ([key, value]) =>
            value &&
            (['entityname', 'tablename', 'etn', 'typename'].includes(key.toLowerCase())
              ? value.toLowerCase() !== targets[0].entity.toLowerCase()
              : ['entityformid', 'formid'].includes(key.toLowerCase())
                ? ![targets[0].id, ...aliases].some((id) => norm(id) === norm(value))
                : key.toLowerCase() === 'formname' && value !== targets[0].name),
        );
        if (frameConflict || urlConflict || (declaredTable && declaredTable !== targets[0].entity.toLowerCase())) {
          result.facts.push({ scope, dimension: 'owner', kind: 'binding-conflict', reason: conflictReason });
          return result;
        }
        chosenForm = targets[0];
        declaredTable = chosenForm.entity.toLowerCase();
        boundary = doc.documentElement;
      }
    }
  }
  if (!boundary) {
    // Editor documents do not repeat their host's component/column IDs. Follow
    // only an accessible same-origin frame chain to a known attribute host,
    // never through an independent inner form or an unresolved component.
    const editor = ancestors.some((item) =>
      item.matches('textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"]'),
    );
    if (
      editor &&
      !result.availability.length &&
      !ancestors.some((item) => item.matches('form,[data-formid],[data-form-layout]') || genericNativeId(item.id))
    ) {
      let currentDoc = doc,
        depth = ancestors.length;
      const editorChain = [...ancestors];
      for (let level = 0; level < 16; level++) {
        let frame;
        try {
          frame = currentDoc.defaultView.frameElement;
          if (
            !frame?.isConnected ||
            frame.hasAttribute('sandbox') ||
            frame.contentDocument !== currentDoc ||
            frame.ownerDocument.defaultView.location.origin !== doc.defaultView.location.origin
          )
            break;
        } catch {
          break;
        }
        for (let parent = frame; parent && depth < 256; parent = parent.parentElement, depth++) {
          editorChain.push(parent);
          const name = /^(.*)_(?:ControlView|Container)$/i.exec(parent.id)?.[1];
          if (!name) {
            if (
              parent.matches('form,[data-formid],[data-form-layout]') ||
              /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(parent.id ?? '')
            )
              return result;
            continue;
          }
          const packet = observePortalNodeImpl(parent, { scope, bindings, sourceRefs, sourceRefsByComponent });
          const owner = packet.facts.find((fact) => fact.dimension === 'owner' && fact.binding?.kind === 'column');
          const innerNames = editorChain.flatMap((item) =>
            ['data-attribute', 'data-field', 'data-fieldname', 'data-pcf-native-field']
              .map((key) => attribute(item, key).toLowerCase())
              .filter(Boolean),
          );
          const innerTables = editorChain.flatMap((item) =>
            ['data-entityname', 'data-entity', 'data-paqvilo-table']
              .map((key) => attribute(item, key).toLowerCase())
              .filter((name) => /^[a-z][a-z0-9_]*$/.test(name)),
          );
          if (
            owner &&
            ((declaredTable && owner.binding.entity !== declaredTable) ||
              innerTables.some((name) => name !== owner.binding.entity.toLowerCase()) ||
              innerNames.some((name) => name !== owner.binding.field.toLowerCase()))
          ) {
            result.facts.push({ scope, dimension: 'owner', kind: 'binding-conflict', reason: conflictReason });
            return result;
          }
          // Even an unknown nearest host is a boundary; a more distant host
          // cannot replace its missing or conflicting definition.
          return {
            ...packet,
            componentAnchors: packet.componentAnchors.map((anchor) => ({
              ...anchor,
              ancestorDepth: depth + anchor.ancestorDepth,
            })),
          };
        }
        if (depth >= 256) {
          result.availability.push({ reason: 'editor-host-ancestor-limit' });
          break;
        }
        currentDoc = frame.ownerDocument;
      }
    }
    return result;
  }
  const refsFor = (key) => sourceRefsByComponent?.get(key) ?? sourceRefs.filter((ref) => ref.componentKey === key);
  const add = (binding, dimension, predicate = 'identity', proof = 'native-component-id', extra = {}) => {
    const refs = refsFor(binding.key);
    result.sourceRefs.push(...refs);
    result.facts.push({
      id: 'portal:' + binding.key + ':' + dimension,
      scope,
      dimension,
      proof,
      subject: 'selection',
      predicate,
      binding,
      sourceRefIds: refs.map((ref) => ref.id),
      label: 'Rendered component identifier joined to the selected export',
      ...extra,
    });
  };
  const selectedContainer =
    node === boundary &&
    !/_ProgressIndicator$/.test(boundary.id ?? '') &&
    !node.matches('input,select,textarea,output,label,td,th,[data-attribute],[data-field],[data-fieldname]');
  const primaryContainer = chosenList ?? chosenForm ?? chosenView;
  if (chosenForm?.formXml?.id) {
    const id = String(chosenForm.formXml.id).replace(/[{}]/g, '').toLowerCase();
    const key = 'form:' + id;
    add(
      { kind: 'form', key, id, name: chosenForm.formXml.name, entity: declaredTable },
      'enclosing',
      'uses-definition',
      'export-definition',
      {
        origin: 'configured',
        subject:
          formKind(chosenForm) +
          ':' +
          String(chosenForm.id ?? chosenForm.recordId)
            .replace(/[{}]/g, '')
            .toLowerCase(),
        reason: 'configured-layout-for-observed-component',
      },
    );
    result.componentAnchors.push({
      componentKey: key,
      relationship: 'uses-definition',
      ancestorDepth: ancestors.indexOf(boundary),
      localName: boundary.localName,
      id: boundary.id ?? '',
    });
  }
  if (declaredTable)
    add(
      { kind: 'table', key: 'table:' + declaredTable, entity: declaredTable, name: declaredTable },
      'enclosing',
      'defined-on',
      observedTable ? 'native-component-id' : 'export-definition',
      {
        origin: observedTable ? 'observed' : 'configured',
        reason: observedTable ? 'rendered-table-identifier' : 'configured-component-table',
      },
    );
  if (genericFormBoundary && !chosenForm) {
    for (const form of modalCandidates.slice(0, 32))
      add(
        {
          kind: 'basic-form',
          key: 'basic-form:' + String(form.id).replace(/[{}]/g, '').toLowerCase(),
          id: form.id,
          name: form.name,
          entity: form.entity,
        },
        'enclosing',
        'declared-modal-form',
        'export-definition',
      );
    result.availability.push({ reason: 'modal-form-placement-unresolved' });
    return result;
  }
  for (const [component, kind] of [
    [chosenForm, chosenForm ? formKind(chosenForm) : null],
    [chosenList, 'list'],
    [chosenView, 'view'],
  ])
    if (component) {
      const key =
        kind +
        ':' +
        String(component.id ?? component.recordId)
          .replace(/[{}]/g, '')
          .toLowerCase();
      add(
        {
          kind,
          key,
          id: component.id ?? component.recordId,
          name: component.name,
          entity: declaredTable,
        },
        selectedContainer && component === primaryContainer ? 'owner' : 'enclosing',
        selectedContainer && component === primaryContainer
          ? 'identity'
          : kind === 'view'
            ? 'current-view'
            : 'contains',
      );
      result.componentAnchors.push({
        componentKey: key,
        relationship: component === primaryContainer ? 'rendered-by' : 'current-view',
        ancestorDepth: ancestors.indexOf(boundary),
        localName: boundary.localName,
        id: boundary.id ?? '',
      });
    }
  let control = ancestors.find((item) =>
    item.matches('input:not([type=hidden]):not([type=password]),select,textarea,output'),
  );
  const label = ancestors.find((item) => item.localName === 'label');
  if (!control && label?.htmlFor) {
    const controls = [...boundary.querySelectorAll('[id]')].slice(0, 2000).filter((item) => item.id === label.htmlFor);
    if (
      controls.length === 1 &&
      controls[0].matches('input:not([type=hidden]):not([type=password]),select,textarea,output')
    )
      control = controls[0];
  }
  control ??= label?.querySelector('input:not([type=hidden]):not([type=password]),select,textarea,output');
  const cell = ancestors.find((item) => item.matches('td,th,[data-paqvilo-column]'));
  const structural = [control, ...ancestors]
    .filter(Boolean)
    .find((item) =>
      ['data-attribute', 'data-field', 'data-fieldname', 'data-pcf-native-field'].some((name) =>
        item.hasAttribute(name),
      ),
    );
  const explicitNames = structural
    ? ['data-attribute', 'data-field', 'data-fieldname', 'data-pcf-native-field']
        .map((name) => attribute(structural, name))
        .filter(Boolean)
    : [];
  const host = ancestors.slice(0, ancestors.indexOf(boundary)).find((item) => {
    const name = /^(.*)_(?:ControlView|Container)$/i.exec(item.id)?.[1];
    return (
      name &&
      (node === item ||
        control ||
        ancestors.some((ancestor) =>
          ancestor.matches('[contenteditable="true"],[contenteditable=""],[role="textbox"]'),
        ))
    );
  });
  const hostName = host && /^(.*)_(?:ControlView|Container)$/i.exec(host.id)[1];
  const names = hostName
    ? [hostName]
    : explicitNames.length
      ? explicitNames
      : chosenGrid && cell && bindings.grid?.name
        ? [bindings.grid.name]
        : control
          ? [control.id, attribute(control, 'name')].filter(Boolean)
          : [];
  const fields = (bindings.columns ?? bindings.fields ?? []).filter(
    (field) =>
      field.entity?.toLowerCase() === declaredTable &&
      names.some((name) => name.toLowerCase() === field.name?.toLowerCase()),
  );
  if (fields.length === 1) {
    const field = fields[0];
    if (explicitNames.some((name) => name.toLowerCase() !== field.name.toLowerCase())) {
      result.facts.push({
        id: 'portal-column-conflict',
        scope,
        dimension: 'owner',
        kind: 'binding-conflict',
        reason: 'conflicting-rendered-column-identifiers',
      });
      return result;
    }
    add(
      {
        kind: 'column',
        key: 'column:' + declaredTable + ':' + field.name.toLowerCase(),
        entity: declaredTable,
        field: field.name,
        name: field.name,
        label: field.label,
      },
      'owner',
      'identity',
      'native-field-id',
      {
        label: chosenGrid
          ? 'Rendered grid table and declared column joined to the selected export'
          : 'Rendered field or attribute host joined to the selected export',
      },
    );
  }
  result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
  return result;
}
