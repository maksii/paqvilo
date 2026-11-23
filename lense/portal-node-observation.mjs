import { definitionQuery } from './definition-query.mjs';

// All embedded code is owned; DOM nodes and bindings remain separate arguments.
/* NOSONAR: intentional local script execution or generated handler */ export const observePortalNode = new Function(
  `return function observePortalNode(node,options={}){const definitionQuery=(${definitionQuery.toString()}); return (${observePortalNodeImpl.toString()})(node,options);};`,
)();

/** Self-contained structural Power Pages read. No field values, row IDs or text.
 * Definition URL hints may reject a conflicting placement, never prove one. */
/* NOSONAR: single-pass routine, splitting it would change shared state */ function observePortalNodeImpl(
  node,
  { scope, bindings = {}, sourceRefs = [], sourceRefsByComponent = null, frameDepth = 0 } = {},
) {
  const result = { version: 1, scope, facts: [], sourceRefs: [], availability: [], componentAnchors: [] };
  // A <form>'s named controls shadow its own members (an <input name="matches"> makes form.matches that input), and a
  // document's named elements shadow the document's. Power Pages wraps the whole page in <form id="content_form">, so
  // every member of a page node is read through its prototype's own getter or method, never off the instance.
  const get = (object, name) => {
    try {
      const prototype = object == null ? null : Object.getPrototypeOf(object);
      return prototype ? Reflect.get(prototype, name, object) : undefined;
    } catch {
      return undefined;
    }
  };
  const call = (object, name, ...args) => {
    const method = get(object, name);
    return typeof method === 'function' ? Reflect.apply(method, object, args) : undefined;
  };
  const idOf = (element) => get(element, 'id') ?? '';
  const tagOf = (element) => get(element, 'localName');
  const parentOf = (element) => get(element, 'parentElement') ?? null;
  const childrenOf = (element) => [...(get(element, 'children') ?? [])];
  if (!get(node, 'isConnected') || !get(node, 'ownerDocument')) return result;
  const doc = get(node, 'ownerDocument');
  if (!['http:', 'https:'].includes(get(doc, 'defaultView')?.location?.protocol)) {
    result.availability.push({ reason: 'component-origin-unverified' });
    return result;
  }
  const norm = (value) =>
    String(value ?? '')
      .replace(/[{}-]/g, '')
      .toLowerCase();
  const attribute = (element, name) => call(element, 'getAttribute', name) ?? '';
  const componentId = (value) => norm(value?.id ?? value?.recordId);
  const compact = (value) =>
    String(value ?? '')
      .replace(/[{}-]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
  // Markers only Mirage's own renderers write (a live portal never does): read on Mirage pages only.
  const mirage = bindings.mirage === true;
  // The document of the web page the report describes. Its page record names the basic form, multistep form and list
  // the portal renders there under generic IDs (EntityFormControl, WebFormControl, EntityListControl).
  const pageDocument = bindings.pageDocument ?? globalThis.document;
  // Rendered table and column declarations: a list row's data-entity and a control's or list cell's data-attribute
  // (Power Pages), the documented data-paqvilo-table opt-in, and Mirage's own data-entityname/data-pcf-native-field.
  const TABLE_ATTRIBUTES = mirage
    ? ['data-entityname', 'data-entity', 'data-paqvilo-table']
    : ['data-entity', 'data-paqvilo-table'];
  const FIELD_ATTRIBUTES = mirage ? ['data-attribute', 'data-pcf-native-field'] : ['data-attribute'];
  const FORM_STATE = /_(?:EntityName|EntityID|EntityState|EntityStatus|EntityLayoutConfig)$/;
  const tableName = (value) =>
    typeof value === 'string' && /^[a-z][a-z0-9_]*$/i.test(value) ? value.toLowerCase() : '';
  const ancestors = [];
  for (
    let current = node;
    get(current, 'ownerDocument') === doc && ancestors.length < 64;
    current = get(current, 'assignedSlot') ?? get(current, 'parentElement') ?? get(call(current, 'getRootNode'), 'host')
  )
    ancestors.push(current);
  const forms = bindings.forms ?? [],
    lists = bindings.lists ?? [],
    views = bindings.views ?? [];
  // Components identified through the page's configuration rather than an ID the portal rendered.
  const configured = new Set();
  // The view layouts a grid declares (base64 JSON: Id, Columns[].LogicalName/Name, Configuration.EntityName).
  const viewLayouts = (grid) => {
    const encoded = attribute(grid, 'data-view-layouts');
    if (!encoded) return [];
    if (encoded.length > 262144) return null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.codePointAt(0))));
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object').slice(0, 32) : null;
    } catch {
      return null;
    }
  };
  const gridView = (grid, layouts = viewLayouts(grid) ?? []) =>
    attribute(grid, 'data-selected-view') || (layouts.length === 1 ? String(layouts[0].Id ?? '') : '');
  // A filter panel's EntityList<list id>, or a typed EntityListControl_<list id without dashes>.
  const listIdOf = (id) =>
    /^EntityList(?:Control_)?([0-9a-f]{32})(?:$|_)/i.exec(id)?.[1] ??
    /^EntityList(?:Control_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|_)/i.exec(id)?.[1] ??
    /^EntityListControl_([0-9a-z]+)$/i.exec(id)?.[1];
  // The list IDs the element, its list wrapper and the list controls inside that wrapper render.
  const renderedListIds = (element, wrapper, control) => {
    const ids = new Set();
    for (const item of [
      element,
      wrapper,
      control,
      ...[...call(wrapper, 'querySelectorAll', '[id^="EntityList"]')].slice(0, 64),
    ]) {
      if (!item) continue;
      if (
        ![element, wrapper, control].includes(item) &&
        call(item, 'closest', '.entitylist:not(.entity-grid)') !== wrapper
      )
        continue;
      const id = listIdOf(get(item, 'id') ?? '');
      if (id) ids.add(norm(id));
    }
    return ids;
  };
  // The list a list wrapper or grid renders: its rendered list ID (a filter panel's EntityList<id>, a typed
  // EntityListControl_<id>), the list the web page names (generic #EntityListControl), or the one list the page
  // references (Liquid tag, page record) that shows the rendered view when no other grid of the document shows it.
  const listOf = (element) => {
    const owner = get(element, 'ownerDocument');
    const wrapper =
      call(element, 'closest', '.entitylist:not(.entity-grid)') ??
      call(element, 'closest', '[id^="EntityListControl"]') ??
      element;
    const control = call(element, 'closest', '[id^="EntityListControl"]');
    const ids = renderedListIds(element, wrapper, control);
    if (ids.size > 1) return { ambiguous: true, lists: [] };
    if (ids.size === 1) {
      const matches = lists.filter((list) => componentId(list) === [...ids][0]);
      return matches.length ? { lists: matches, proof: 'native-component-id' } : { missing: true, lists: [] };
    }
    if (call(element, 'closest', '#EntityListControl') && owner === pageDocument && bindings.pageListId) {
      const matches = lists.filter((list) => componentId(list) === norm(bindings.pageListId));
      return matches.length
        ? { lists: matches, proof: 'page-configured-component', label: 'List of this web page' }
        : { missing: true, lists: [] };
    }
    const grid = call(element, 'matches', '.entity-grid')
      ? element
      : call(wrapper, 'querySelector', '.entity-grid:not(.subgrid,.entity-lookup .entity-grid)');
    const viewId = grid ? gridView(grid) : '';
    if (!viewId || owner !== pageDocument) return { lists: [] };
    const shows = (list, id) => (list.viewIds ?? []).some((item) => norm(item) === norm(id));
    const candidates = lists.filter((list) => list.pageReferenced === true && shows(list, viewId));
    const grids = [...call(owner, 'querySelectorAll', '.entity-grid')]
      .slice(0, 64)
      .filter(
        (item) =>
          !call(item, 'closest', '.subgrid[id],.entity-lookup') &&
          candidates.some((list) => shows(list, gridView(item))),
      );
    if (candidates.length !== 1 || grids.length !== 1 || grids[0] !== grid) return { lists: [] };
    // The rendered view names the list only when no other exported list shows it: a list the page does not reference
    // (or one rendered through a template the report does not see) can be the one rendering this grid.
    if (lists.filter((list) => shows(list, viewId)).length > 1)
      return { lists: [], likely: candidates[0], reason: 'view-shown-by-several-lists' };
    return { lists: candidates, proof: 'page-configured-component', label: 'List this page uses, showing this view' };
  };
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
  const PAGE_WRAPPERS = {
    EntityFormControl: ['basic-form', bindings.pageFormId],
    EntityFormControl_EntityFormView: ['basic-form', bindings.pageFormId],
    WebFormControl: ['advanced-form', bindings.pageWebFormId],
    WebFormControl_ProgressIndicator: ['advanced-form', bindings.pageWebFormId],
  };
  const nativeFormsFor = (element) => {
    const typed = forms.filter((form) => {
      const kind = formKind(form);
      let prefix = null;
      if (kind === 'advanced-form') prefix = 'WebFormControl_';
      else if (kind === 'basic-form') prefix = 'EntityFormControl_';
      if (!prefix) return false;
      const base = prefix + compact(form.id);
      return (
        get(element, 'id') === base ||
        get(element, 'id') === base + '_EntityFormView' ||
        (prefix === 'WebFormControl_' && get(element, 'id') === base + '_ProgressIndicator')
      );
    });
    if (
      typed.length ||
      get(element, 'ownerDocument') !== pageDocument ||
      !Object.hasOwn(PAGE_WRAPPERS, get(element, 'id'))
    )
      return typed;
    // A generic wrapper of the page's own document renders the form its web page record names.
    const [kind, id] = PAGE_WRAPPERS[get(element, 'id')];
    const matches = id ? forms.filter((form) => formKind(form) === kind && componentId(form) === norm(id)) : [];
    for (const form of matches) configured.add(form);
    return matches;
  };
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
  const gridCell = ancestors.find((item) => call(item, 'matches', 'td,th,[data-paqvilo-column]'));
  const gridTable = call(gridCell, 'closest', 'table');
  let chosenGrid = false;
  let genericFormBoundary = false,
    modalCandidates = [];
  // A lookup's dialog (<column>_lookupmodal) shows a grid of the lookup's target table inside the form's control:
  // the form owns it, so the dialog's own grid and rows are not boundaries of the selection.
  const lookupHost = ancestors.find((item) =>
    call(item, 'matches', '.lookup-modal,.entity-lookup[data-lookup-datafieldname]'),
  );
  let chosenSubgrid = null,
    gridElement = null,
    gridLayout = null,
    viewMissing = false,
    listProof = 'native-component-id',
    listLabel = '',
    profileForm = false,
    likelyList = null;
  for (const current of ancestors) {
    if (lookupHost && (current === lookupHost || call(lookupHost, 'contains', current))) continue;
    if (call(current, 'matches', '.entity-grid,[data-view-layouts]')) {
      // A grid: its view (selected view, else its only layout) and the list or subgrid that renders it. A view that
      // is not in the Solution sources does not stop the read: the grid's declared table and columns remain.
      const layouts = viewLayouts(current);
      if (!layouts) {
        result.availability.push({ reason: 'invalid-rendered-view-layouts' });
        break;
      }
      const viewId = gridView(current, layouts);
      gridLayout = layouts.find((item) => viewId && norm(item.Id) === norm(viewId)) ?? null;
      const matchedViews = views.filter((view) => viewId && componentId(view) === norm(viewId));
      if (matchedViews.length > 1) {
        result.availability.push({ reason: 'ambiguous-rendered-component-id' });
        break;
      }
      // The grid's own table declarations count with its rows'.
      for (const name of TABLE_ATTRIBUTES.map((key) => tableName(attribute(current, key))).filter(Boolean)) {
        if (declaredTable && declaredTable !== name) conflict = true;
        declaredTable ||= name;
        observedTable = true;
      }
      const subgridHost = call(current, 'closest', '.subgrid[id]:not(.entity-grid)');
      if (subgridHost && frameDepth < 16) {
        const parent = observePortalNodeImpl(get(subgridHost, 'parentElement'), {
          scope,
          bindings,
          sourceRefs,
          sourceRefsByComponent,
          frameDepth: frameDepth + 1,
        });
        const parentForms = parent.facts.filter(
          (fact) =>
            ['native-component-id', 'page-configured-component'].includes(fact.proof) &&
            ['basic-form', 'advanced-form'].includes(fact.binding?.kind),
        );
        const matches =
          parentForms.length === 1
            ? (bindings.subgrids ?? []).filter(
                (component) =>
                  component.id === get(subgridHost, 'id') && norm(component.formId) === norm(parentForms[0].binding.id),
              )
            : [];
        if (matches.length === 1) chosenSubgrid = matches[0];
      } else if (!subgridHost) {
        const found = listOf(current);
        if (found.missing) {
          result.availability.push({ reason: 'nearest-component-definition-missing' });
          break;
        }
        if (found.ambiguous || found.lists.length > 1) {
          result.availability.push({ reason: 'ambiguous-rendered-component-id' });
          break;
        }
        if (found.lists.length) {
          chosenList = found.lists[0];
          listProof = found.proof;
          listLabel = found.label ?? '';
        } else likelyList = found.likely ?? null;
      }
      chosenView = matchedViews[0];
      viewMissing = Boolean(viewId && !chosenView);
      const layoutTable = tableName(gridLayout?.Configuration?.EntityName);
      const tables = [
        layoutTable,
        tableName(chosenView?.entity),
        tableName(chosenList?.entity),
        tableName(chosenSubgrid?.entity),
        declaredTable,
      ].filter(Boolean);
      if (new Set(tables).size > 1) conflict = true;
      if (chosenList && viewId && !(chosenList.viewIds ?? []).some((id) => norm(id) === norm(viewId))) {
        conflict = true;
        conflictReason = 'conflicting-rendered-list-view';
      }
      observedTable ||= Boolean(layoutTable);
      declaredTable ||= tables[0] ?? '';
      gridElement = boundary = current;
      break;
    }
    if (get(current, 'id') === 'ProfileFormView' && get(current, 'ownerDocument') === pageDocument) {
      // The profile page's built-in contact form: no basic form record renders it, its layout names the table.
      const layouts = [...call(current, 'querySelectorAll', ':scope > [data-form-layout]')].slice(0, 2);
      let table;
      try {
        const encoded = attribute(layouts[0], 'data-form-layout');
        table = layouts.length === 1 && encoded.length <= 65536 ? tableName(JSON.parse(encoded)?.EntityName) : '';
      } catch {
        table = '';
      }
      // Its state input <view>_EntityName holds the table's logical name (the record ID input is not read).
      table ||= tableName(
        attribute(
          call(current, 'querySelector', ':scope > input[type=hidden][id="ProfileFormView_EntityName"]'),
          'value',
        ),
      );
      if (table) {
        if (declaredTable && declaredTable !== table) conflict = true;
        declaredTable ||= table;
        observedTable = true;
        profileForm = true;
        boundary = current;
      }
      break;
    }
    if (call(current, 'matches', '.entitylist') || idOf(current).startsWith('EntityList')) {
      // A list's wrapper and the parts around its grid (filter panel, list chrome) belong to that list only.
      const found = listOf(current);
      if (found.missing) result.availability.push({ reason: 'nearest-component-definition-missing' });
      else if (found.ambiguous || found.lists.length > 1)
        result.availability.push({ reason: 'ambiguous-rendered-component-id' });
      else if (found.lists.length) {
        chosenList = found.lists[0];
        listProof = found.proof;
        listLabel = found.label ?? '';
        const table = tableName(chosenList.entity);
        if (declaredTable && table && declaredTable !== table) conflict = true;
        declaredTable ||= table;
        boundary = call(current, 'closest', '.entitylist:not(.entity-grid)') ?? current;
      } else if (found.likely) {
        likelyList = found.likely;
        boundary = call(current, 'closest', '.entitylist:not(.entity-grid)') ?? current;
      }
      break;
    }
    if (current === gridTable && bindings.grid?.name) {
      const cloneId = attribute(current, 'data-paqvilo-grid');
      const targets = cloneId
        ? [...call(call(current, 'getRootNode'), 'querySelectorAll', '#' + CSS.escape(cloneId))]
        : [current];
      const table = targets.length === 1 && get(targets[0], 'localName') === 'table' ? targets[0] : null;
      const name = attribute(table, 'data-paqvilo-table').toLowerCase();
      // The column comes from the passive declaration reader, but its table
      // must also be declared by this exact grid (or its explicit clone target).
      // Never borrow an enclosing form's table for an unbound custom grid.
      if (!/^[a-z][a-z0-9_]*$/.test(name) || bindings.grid.table?.toLowerCase() !== name) break;
      const tableNames = [...new Set([current, table])]
        .flatMap((element) => TABLE_ATTRIBUTES.map((key) => attribute(element, key).toLowerCase()))
        .filter(Boolean);
      if ((declaredTable && declaredTable !== name) || tableNames.some((value) => value !== name)) conflict = true;
      declaredTable = name;
      observedTable = true;
      chosenGrid = true;
      boundary = current;
      break;
    }
    const layouts = [];
    // The form's state inputs and layout span carry the wrapper's ID as a prefix; they are parts, not wrappers.
    const nativeWrapper =
      /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(get(current, 'id') ?? '') &&
      !FORM_STATE.test(get(current, 'id') ?? '');
    const genericView =
      get(current, 'id') === 'EntityFormView' || get(current, 'id') === 'EntityFormControl_EntityFormView';
    const genericWrapper = genericNativeId(get(current, 'id'));
    // A child frame's own layout constrains its target, not this containing form.
    const nativeLayouts =
      nativeWrapper || genericView
        ? [...call(current, 'querySelectorAll', ':scope > [data-form-layout]:not(iframe)')].slice(0, 2)
        : [];
    if (get(current, 'id') === 'WebFormControl')
      nativeLayouts.push(
        ...[
          ...call(
            current,
            'querySelectorAll',
            ':scope > #WebFormPanel > #EntityFormView > [data-form-layout]:not(iframe)',
          ),
        ].slice(0, 2),
      );
    if (get(current, 'id') === 'EntityFormControl')
      nativeLayouts.push(
        ...[
          ...call(
            current,
            'querySelectorAll',
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
    // A list row names its table (tr[data-entity]); Mirage's own renderers also write data-entityname.
    const tableNames = [
      mirage ? attribute(current, 'data-entityname') : '',
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
          .find((element) => /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(get(element, 'id') ?? ''))
      : null;
    const outerForms = outerWrapper ? nativeFormsFor(outerWrapper) : [];
    let expectedKind = null;
    if (get(current, 'id') === 'EntityFormView' || /^WebFormControl(?:_|$)/.test(get(current, 'id') ?? ''))
      expectedKind = 'advanced-form';
    else if (nativeWrapper || get(current, 'id') === 'EntityFormControl_EntityFormView') expectedKind = 'basic-form';
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
    // Lists and views are read at their grid and list wrapper above.
    const unrecognized =
      declaredForms.some((matches) => !matches.length) ||
      (nativeWrapper && !nativeForms.length && !genericWrapper) ||
      (outerWrapper && !outerForms.length && !genericNativeId(get(outerWrapper, 'id')));
    if (unrecognized) {
      result.availability.push({ reason: 'nearest-component-definition-missing' });
      break;
    }
    if (formConstraints.length > 1 && !matchingForms.length) {
      conflict = true;
      conflictReason = 'conflicting-rendered-form-identifiers';
      break;
    }
    if (matchingForms.length > 1) {
      result.availability.push({ reason: 'ambiguous-rendered-component-id' });
      break;
    }
    if (matchingForms.length) {
      boundary = current;
      chosenForm = matchingForms[0];
      if (chosenForm && formKind(chosenForm) === 'advanced-form') {
        let renderedLayouts = (chosenForm.formLayouts ?? []).filter((layout) =>
          layouts.some((observed) => norm(observed.Id) === norm(layout.id)),
        );
        // The portal renders a step's layout with the empty GUID: the step's form is then the only step form on the
        // table the layout names.
        const layoutTables = [...new Set(layouts.map((observed) => tableName(observed.EntityName)).filter(Boolean))];
        if (!renderedLayouts.length && layoutTables.length === 1)
          renderedLayouts = (chosenForm.formLayouts ?? []).filter((layout) => layout.entity === layoutTables[0]);
        if (renderedLayouts.length === 1) {
          if (declaredTable && declaredTable !== renderedLayouts[0].entity) conflict = true;
          chosenForm = { ...chosenForm, formXml: renderedLayouts[0] };
          declaredTable ||= renderedLayouts[0].entity;
        }
        if (configured.has(matchingForms[0])) configured.add(chosenForm);
      }
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
      const candidate = get(doc, 'defaultView')?.frameElement;
      const address = call(candidate, 'getAttribute', 'data-page'); // NOSONAR: reads attributes of observed DOM, dataset would differ
      const expected = address && new URL(address, get(get(candidate, 'ownerDocument'), 'baseURI'));
      const current = new URL(get(doc, 'URL'));
      if (
        get(candidate, 'isConnected') &&
        !call(candidate, 'hasAttribute', 'sandbox') &&
        get(candidate, 'contentDocument') === doc &&
        get(get(candidate, 'ownerDocument'), 'defaultView').location.origin === current.origin &&
        expected?.origin === current.origin &&
        expected.pathname === current.pathname &&
        /^\/_portal\/modal-form-template-path\//i.test(current.pathname)
      ) {
        frame = candidate;
        modal = call(frame, 'closest', '.modal-form');
        grid = call(modal, 'closest', '.entity-grid');
      }
    } catch {
      /* Inaccessible or replaced frames cannot establish a placement. */
    }
    if (grid && call(frame, 'closest', '.entity-grid') === grid) {
      const kinds = [
        ['modal-form-insert', 'CreateAction'],
        ['modal-form-edit', 'EditAction'],
        ['modal-form-details', 'DetailsAction'],
      ].filter(([name]) => get(modal, 'classList').contains(name));
      // Exact ownership needs a rendered list/subgrid identity or a page-referenced
      // list; other exported lists sharing the rendered view only supply candidates.
      let owners = [],
        candidateOwners = null;
      const subgrid = call(grid, 'closest', '.subgrid[id]');
      let placementConflict = false;
      if (subgrid) {
        const parent = observePortalNodeImpl(get(subgrid, 'parentElement'), {
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
            (component) =>
              component.id === get(subgrid, 'id') && norm(component.formId) === norm(parentForms[0].binding.id),
          );
      } else {
        const found = listOf(grid);
        const viewId = attribute(grid, 'data-selected-view');
        placementConflict = Boolean(found.ambiguous);
        owners = found.lists;
        if (!owners.length && !found.missing && viewId)
          candidateOwners = lists.filter((list) => (list.viewIds ?? []).some((id) => norm(id) === norm(viewId)));
        if (viewId && owners.some((list) => !(list.viewIds ?? []).some((id) => norm(id) === norm(viewId))))
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
        const params = definitionQuery(new URL(get(doc, 'URL')));
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
      const candidate = get(doc, 'defaultView')?.frameElement;
      const expected = call(candidate, 'getAttribute', 'data-path'); // NOSONAR: reads attributes of observed DOM, dataset would differ
      const address = expected && new URL(expected, get(get(candidate, 'ownerDocument'), 'baseURI'));
      const current = new URL(get(doc, 'URL'));
      if (
        get(candidate, 'isConnected') &&
        !call(candidate, 'hasAttribute', 'sandbox') &&
        get(candidate, 'contentDocument') === doc &&
        get(get(candidate, 'ownerDocument'), 'defaultView').location.origin ===
          get(doc, 'defaultView').location.origin &&
        call(candidate, 'matches', 'iframe.quickform[data-controlid][data-lookup-element][data-formname]') &&
        address?.origin === current.origin &&
        address.pathname === current.pathname &&
        get(candidate, 'id') === attribute(candidate, 'data-controlid')
      )
        frame = candidate;
    } catch {
      /* Inaccessible frames remain boundaries. */
    }
    if (
      frame &&
      ancestors.includes(get(doc, 'documentElement')) &&
      !ancestors.some((item) => call(item, 'matches', '[data-form-layout]') || genericNativeId(get(item, 'id')))
    ) {
      const parent = observePortalNodeImpl(
        get(frame, 'assignedSlot') ?? get(frame, 'parentElement') ?? get(call(frame, 'getRootNode'), 'host'),
        {
          scope,
          bindings,
          sourceRefs,
          sourceRefsByComponent,
          frameDepth: frameDepth + 1,
        },
      );
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
        const params = definitionQuery(new URL(get(doc, 'URL')), { formName: true });
        const aliases = forms.filter((form) => norm(form.formXml?.id) === norm(targets[0].id)).map((form) => form.id);
        const frameTables = TABLE_ATTRIBUTES.map((key) => attribute(frame, key).toLowerCase()).filter(Boolean);
        const frameForms = [];
        const encoded = attribute(frame, 'data-form-layout');
        if (encoded) {
          try {
            if (encoded.length > 65536) throw new Error('Oversized layout');
            const layout = JSON.parse(encoded);
            if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('Invalid layout');
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
        const urlConflict = params.some(([key, value]) => {
          if (!value) return false;
          const name = key.toLowerCase();
          if (['entityname', 'tablename', 'etn', 'typename'].includes(name))
            return value.toLowerCase() !== targets[0].entity.toLowerCase();
          if (['entityformid', 'formid'].includes(name))
            return ![targets[0].id, ...aliases].some((id) => norm(id) === norm(value));
          return name === 'formname' && value !== targets[0].name;
        });
        if (frameConflict || urlConflict || (declaredTable && declaredTable !== targets[0].entity.toLowerCase())) {
          result.facts.push({ scope, dimension: 'owner', kind: 'binding-conflict', reason: conflictReason });
          return result;
        }
        chosenForm = targets[0];
        declaredTable = chosenForm.entity.toLowerCase();
        boundary = get(doc, 'documentElement');
      }
    }
  }
  if (!boundary) {
    // Editor documents do not repeat their host's component/column IDs. Follow
    // only an accessible same-origin frame chain to a known attribute host,
    // never through an independent inner form or an unresolved component.
    const editor = ancestors.some((item) =>
      call(item, 'matches', 'textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"]'),
    );
    if (
      editor &&
      !result.availability.length &&
      !ancestors.some((item) => call(item, 'matches', 'form,[data-form-layout]') || genericNativeId(get(item, 'id')))
    ) {
      let currentDoc = doc,
        depth = ancestors.length;
      const editorChain = [...ancestors];
      for (let level = 0; level < 16; level++) {
        let frame;
        try {
          frame = get(currentDoc, 'defaultView')?.frameElement;
          if (
            !get(frame, 'isConnected') ||
            call(frame, 'hasAttribute', 'sandbox') ||
            get(frame, 'contentDocument') !== currentDoc ||
            get(get(frame, 'ownerDocument'), 'defaultView').location.origin !== get(doc, 'defaultView').location.origin
          )
            break;
        } catch {
          break;
        }
        for (let parent = frame; parent && depth < 256; parent = get(parent, 'parentElement'), depth++) {
          editorChain.push(parent);
          const name = /^(.*)_(?:ControlView|Container)$/i.exec(get(parent, 'id'))?.[1];
          if (!name) {
            if (
              call(parent, 'matches', 'form,[data-form-layout]') ||
              /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(get(parent, 'id') ?? '')
            )
              return result;
            continue;
          }
          const packet = observePortalNodeImpl(parent, { scope, bindings, sourceRefs, sourceRefsByComponent });
          const owner = packet.facts.find((fact) => fact.dimension === 'owner' && fact.binding?.kind === 'column');
          const innerNames = editorChain.flatMap((item) =>
            FIELD_ATTRIBUTES.map((key) => attribute(item, key).toLowerCase()).filter(Boolean),
          );
          const innerTables = editorChain.flatMap((item) =>
            TABLE_ATTRIBUTES.map((key) => attribute(item, key).toLowerCase()).filter((name) =>
              /^[a-z][a-z0-9_]*$/.test(name),
            ),
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
        currentDoc = get(frame, 'ownerDocument');
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
      ...extra,
    });
  };
  const selectedContainer =
    node === boundary &&
    !String(get(boundary, 'id') ?? '').endsWith('_ProgressIndicator') &&
    !call(node, 'matches', 'input,select,textarea,output,label,td,th,[data-attribute]');
  // A grid's own element is its view, as the list renderers name it; the list or subgrid encloses it.
  const primaryContainer = gridElement
    ? (chosenView ?? chosenSubgrid ?? chosenList)
    : (chosenList ?? chosenForm ?? chosenView);
  // A grid whose view is not in the Solution sources, rendered by no identified list or subgrid: its table and columns
  // are only what the page declares.
  const declaredOnly = viewMissing && !chosenList && !chosenSubgrid;
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
      localName: get(boundary, 'localName'),
      id: get(boundary, 'id') ?? '',
    });
  }
  // The table is named either by a rendered table identifier or by the configured table of a form, list or view
  // identified by its rendered ID (a component's record fixes its table; conflicts returned above). Both are exact,
  // so one form's table does not change certainty with the control picked inside it; origin records which it was.
  if (declaredTable) {
    let tableReason = 'configured-component-table';
    if (declaredOnly) tableReason = 'view-definition-missing';
    else if (observedTable) tableReason = 'rendered-table-identifier';
    add(
      { kind: 'table', key: 'table:' + declaredTable, entity: declaredTable, name: declaredTable },
      'enclosing',
      'defined-on',
      declaredOnly ? 'rendered-declaration' : 'native-component-id',
      { origin: observedTable ? 'observed' : 'configured', reason: tableReason },
    );
  }
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
  const keyOf = (kind, component) =>
    kind +
    ':' +
    String(component.id ?? component.recordId)
      .replace(/[{}]/g, '')
      .toLowerCase();
  const subgridKey = chosenSubgrid
    ? 'subgrid:' + norm(chosenSubgrid.formId) + ':' + String(chosenSubgrid.id).toLowerCase()
    : '';
  const ownerBindings = new Map();
  for (const [component, kind] of [
    [chosenForm, chosenForm ? formKind(chosenForm) : null],
    [chosenList, 'list'],
    [chosenSubgrid, 'subgrid'],
    [chosenView, 'view'],
  ])
    if (component) {
      const key = kind === 'subgrid' ? subgridKey : keyOf(kind, component);
      const isPrimary = selectedContainer && component === primaryContainer;
      let role = 'contains';
      if (isPrimary) role = 'identity';
      else if (kind === 'view') role = 'current-view';
      let proof = 'native-component-id',
        label;
      if (kind === 'list') {
        proof = listProof;
        label = listLabel || undefined;
      } else if (configured.has(component)) {
        proof = 'page-configured-component';
        label = 'Form of this web page';
      }
      const bound = {
        kind,
        key,
        id: component.id ?? component.recordId,
        name: component.name ?? (kind === 'subgrid' ? component.id : undefined),
        entity: kind === 'subgrid' ? tableName(component.entity) || declaredTable : declaredTable,
        ...(kind === 'subgrid' ? { controlName: component.id, formId: component.formId } : {}),
      };
      ownerBindings.set(kind, { binding: bound, proof });
      add(bound, isPrimary ? 'owner' : 'enclosing', role, proof, label ? { label } : {});
      result.componentAnchors.push({
        componentKey: key,
        relationship: component === primaryContainer ? 'rendered-by' : 'current-view',
        ancestorDepth: ancestors.indexOf(boundary),
        localName: get(boundary, 'localName'),
        id: get(boundary, 'id') ?? '',
      });
    }
  // The one list the page references that shows the rendered view, while another exported list shows it too: it may
  // be the list, not proof that it is.
  if (likelyList && !chosenList)
    add(
      {
        kind: 'list',
        key: keyOf('list', likelyList),
        id: likelyList.id ?? likelyList.recordId,
        name: likelyList.name,
        entity: tableName(likelyList.entity),
      },
      selectedContainer && !gridElement ? 'owner' : 'enclosing',
      selectedContainer && !gridElement ? 'identity' : 'contains',
      'rendered-declaration',
      {
        reason: 'view-shown-by-several-lists',
        label: 'This page uses this list, but another list in your sources shows the same view',
      },
    );
  // The selection's ancestors below its component boundary, and the parts of a lookup's dialog among them.
  const within = ancestors.slice(0, Math.max(0, ancestors.indexOf(boundary)));
  const inLookup = (item) => Boolean(lookupHost && (item === lookupHost || call(lookupHost, 'contains', item)));
  const formControl = 'input:not([type=hidden]):not([type=password]),select,textarea,output';
  // An element that loads a file is that file (X-ray names it by its address); the column or part around it encloses it.
  const ownRole = call(
    node,
    'matches',
    'img,picture,source,video,audio,embed,object,track,input[type=image],script[src],link[href],use,image',
  )
    ? 'enclosing'
    : 'owner';
  let control = ancestors.find((item) => !inLookup(item) && call(item, 'matches', formControl));
  const label = ancestors.find((item) => get(item, 'localName') === 'label');
  if (!control && get(label, 'htmlFor')) {
    const controls = [...call(boundary, 'querySelectorAll', '[id]')]
      .slice(0, 2000)
      .filter((item) => get(item, 'id') === get(label, 'htmlFor'));
    if (controls.length === 1 && call(controls[0], 'matches', formControl)) control = controls[0];
  }
  control ??= call(label, 'querySelector', formControl);
  const cell = ancestors.some((item) => call(item, 'matches', 'td,th,[data-paqvilo-column]'));
  const structural = [control, ...ancestors]
    .filter((item) => item && !inLookup(item))
    .find((item) => FIELD_ATTRIBUTES.some((name) => call(item, 'hasAttribute', name)));
  const explicitNames = structural ? FIELD_ATTRIBUTES.map((name) => attribute(structural, name)).filter(Boolean) : [];
  // A code component's <column>_ControlView/_Container host names its column for every element inside it (on Mirage
  // pages, whose render registry names those parts, only for the host itself, a control or an editor inside it).
  const editable = ancestors.some((item) =>
    call(item, 'matches', '[contenteditable="true"],[contenteditable=""],[role="textbox"]'),
  );
  const host = within.find(
    (item) =>
      /^(.*)_(?:ControlView|Container)$/i.test(get(item, 'id') ?? '') &&
      (!mirage || node === item || control || editable),
  );
  const hostName = host ? /^(.*)_(?:ControlView|Container)$/i.exec(get(host, 'id'))[1] : '';
  // Power Pages form cells: <td class="cell"> holds the label (<column>_label), its validators and
  // <div class="control" data-logical-name="<column>">, which holds every part of the column's control (lookup
  // name/entity inputs and buttons, the lookup dialog, date picker, options, a code component host).
  const live = !mirage;
  const logicalHost = live ? within.find((item) => call(item, 'matches', '.control[data-logical-name]')) : null;
  const logicalName = attribute(logicalHost, 'data-logical-name');
  const formCell = live && !gridElement ? within.find((item) => call(item, 'matches', 'td.cell')) : null;
  const cellControls = formCell
    ? [...call(formCell, 'querySelectorAll', '.control[data-logical-name]')].slice(0, 2)
    : [];
  const cellName = cellControls.length === 1 ? attribute(cellControls[0], 'data-logical-name') : '';
  const labelName = live
    ? (within
        .filter((item) => get(item, 'localName') === 'label' && !get(item, 'htmlFor'))
        .map((item) => /^(.+)_label$/.exec(attribute(item, 'id'))?.[1])
        .find(Boolean) ?? '')
    : '';
  // A list header or cell without a column attribute: the column at its index among the row's layout cells, when the
  // header's or cell's display name is that layout column's name and no other layout column shows that name. The
  // portal's own selection and action columns (a header with markup in data-th, as "Select" and "Actions" render; a
  // check box or action menu cell) and cells showing no layout column's name (a column a script inserts) are not
  // layout cells, so they do not shift the index.
  let headerName = '';
  const gridCellElement = gridElement && live ? within.find((item) => call(item, 'matches', 'th,td')) : null;
  const layoutColumns = Array.isArray(gridLayout?.Columns) ? gridLayout.Columns.slice(0, 256) : [];
  const shownName = (cell) =>
    tagOf(cell) === 'th'
      ? attribute(call(cell, 'querySelector', ':scope > a[aria-label]'), 'aria-label') || attribute(cell, 'aria-label')
      : attribute(cell, 'data-th');
  const layoutNames = new Set(layoutColumns.map((column) => String(column?.Name ?? '')).filter(Boolean));
  const layoutCell = (cell) =>
    call(cell, 'matches', 'th,td') &&
    !call(cell, 'matches', '.multi-select,th[data-th*="<"],td[aria-label="action menu"]') &&
    !call(cell, 'querySelector', '[role=checkbox],.dropdown.action') &&
    layoutNames.has(shownName(cell));
  if (gridCellElement && layoutColumns.length && tagOf(get(gridCellElement, 'parentElement')) === 'tr') {
    const shown = shownName(gridCellElement);
    const sameName = layoutColumns.filter((column) => String(column?.Name ?? '') === shown);
    const cells = childrenOf(get(gridCellElement, 'parentElement')).slice(0, 256).filter(layoutCell);
    const column = sameName.length === 1 ? layoutColumns[cells.indexOf(gridCellElement)] : null;
    if (
      column === sameName[0] &&
      typeof column?.LogicalName === 'string' &&
      /^[a-z][a-z0-9_]*$/i.test(column.LogicalName)
    )
      headerName = column.LogicalName;
  }
  // Composite parts of one control carry the column with a suffix; the base must be the column's own (hidden)
  // input in the same control or cell.
  const SUFFIX =
    /_(?:name|entityname|datepicker_description|datepicker|timepicker_description|timepicker|i\d+|option_\d+|\d+|selected|value|container)$/i;
  const controlNames = control ? [get(control, 'id'), attribute(control, 'name')].filter(Boolean) : [];
  if (live && get(control, 'id') && SUFFIX.test(get(control, 'id'))) {
    const base = get(control, 'id').replace(SUFFIX, '');
    const scopeOf = call(control, 'closest', '.control,td.cell,.form-group') ?? get(control, 'parentElement');
    if ([...(call(scopeOf, 'querySelectorAll', '[id]') ?? [])].slice(0, 200).some((item) => get(item, 'id') === base))
      controlNames.push(base);
  }
  let names = [];
  if (hostName) names = [hostName];
  else if (logicalName) names = [logicalName];
  else if (explicitNames.length) names = explicitNames;
  else if (chosenGrid && cell && bindings.grid?.name) names = [bindings.grid.name];
  else if (cellName) names = [cellName];
  else if (labelName) names = [labelName];
  else if (headerName) names = [headerName];
  // A control names its column by its own ID only inside a cell, of a form or of a grid (on Mirage pages, wherever
  // Mirage renders it): an author's input outside the platform's cells is not a column because its ID matches one.
  else if (control && (!live || formCell || gridCellElement)) names = controlNames;
  let lookupName = '';
  if (lookupHost) {
    const lookupField = call(lookupHost, 'matches', '.entity-lookup')
      ? lookupHost
      : call(lookupHost, 'querySelector', '.entity-lookup');
    lookupName =
      attribute(lookupField, 'data-lookup-datafieldname') ||
      /^(.+)_lookupmodal$/.exec(get(lookupHost, 'id') ?? '')?.[1];
  }
  const declaredNames = [hostName, logicalName, live ? lookupName : '']
    .filter(Boolean)
    .map((name) => name.toLowerCase());
  const columnConflict = () => {
    result.facts.push({
      id: 'portal-column-conflict',
      scope,
      dimension: 'owner',
      kind: 'binding-conflict',
      reason: 'conflicting-rendered-column-identifiers',
    });
    return result;
  };
  if (new Set(declaredNames).size > 1) return columnConflict();
  const fields = (bindings.columns ?? bindings.fields ?? []).filter(
    (field) =>
      field.entity?.toLowerCase() === declaredTable &&
      names.some((name) => name.toLowerCase() === field.name?.toLowerCase()),
  );
  // What part of the column's control the selection is, in the words of the Component row.
  const partLabel = () => {
    if (!live) return '';
    if (lookupHost) return 'Lookup dialog of this column';
    if (within.some((item) => /^PcfControl_/i.test(get(item, 'id') ?? '') || item === host))
      return 'Code component of this column';
    if (within.some((item) => get(item, 'localName') === 'label')) return 'Label of this column';
    if (within.some((item) => call(item, 'matches', '.validators') || /Validator/.test(get(item, 'id') ?? '')))
      return 'Validator of this column';
    // A lookup's own inputs are `<column>_name` and `<column>_entityname`; a column that is itself called
    // `..._name` is that column's plain input.
    const column = String(fields[0]?.name ?? names[0] ?? '').toLowerCase();
    const id = String(get(node, 'id') ?? '').toLowerCase();
    if (
      within.some((item) => call(item, 'matches', '.launchentitylookup,.clearlookupfield')) ||
      (column !== '' && (id === column + '_name' || id === column + '_entityname'))
    )
      return 'Lookup of this column';
    if (
      within.some((item) => call(item, 'matches', '.input-append,[data-ui="datetimepicker"]')) ||
      /_(?:date|time)picker/.test(get(node, 'id') ?? '')
    )
      return 'Date picker of this column';
    if (call(node, 'matches', 'input[type=radio],input[type=checkbox]') && get(node, 'id') !== names[0])
      return 'Option of this column';
    if (call(node, 'matches', 'td.cell,.table-info,.control')) return 'Cell of this column';
    return '';
  };
  // What the portal itself renders in a form cell, as captures of live portals show it: <td class="cell"> holds
  // div.table-info (label.field-label <column>_label, div.validators) and div.control[data-logical-name], which holds
  // the control, its input-group and date picker wrappers, the lookup's inputs, buttons and dialog, an option list
  // (elements named <column> or <column>_…) and a code component host. A description is the column's too. Anything
  // else a script or the page's author puts in the cell is not a part of the column: the column is only the cell it
  // stands in. Mirage pages are named by Mirage's render registry instead.
  const platformPart = (column) => {
    if (!live || gridElement || !(formCell || logicalHost)) return true;
    if (lookupHost || host || within.some((item) => /^PcfControl_/i.test(get(item, 'id') ?? ''))) return true;
    const top = formCell ?? logicalHost;
    const path = within.slice(0, within.indexOf(top) + 1);
    const name = String(column ?? '').toLowerCase();
    if (call(node, 'matches', 'td.cell,.control[data-logical-name]')) return true;
    if (call(node, 'matches', '.table-info') && parentOf(node) === formCell) return true;
    return path.some((item) => {
      if (item === top) return false;
      const id = String(get(item, 'id') ?? '').toLowerCase();
      return (
        (name !== '' && (id === name || id.startsWith(name + '_'))) ||
        call(
          item,
          'matches',
          'label,.validators,.description,.input-group,.input-append,.datetimepicker,[data-ui="datetimepicker"],' +
            'input:not([type=button],[type=submit],[type=reset],[type=image],[type=search]),select,textarea',
        ) === true
      );
    });
  };
  const insideCell = { label: "Inside this column's cell" };
  // A grid whose view is not in the Solution sources: the column the cell or header declares (data-attribute, the
  // layout column at its index) is only named by the page.
  const declaredColumn = explicitNames[0] ?? headerName;
  if (
    !fields.length &&
    gridElement &&
    viewMissing &&
    declaredTable &&
    /^[a-z][a-z0-9_]*$/i.test(declaredColumn ?? '')
  ) {
    add(
      {
        kind: 'column',
        key: 'column:' + declaredTable + ':' + declaredColumn.toLowerCase(),
        entity: declaredTable,
        field: declaredColumn,
        name: declaredColumn,
      },
      ownRole,
      'identity',
      'rendered-declaration',
      { reason: 'view-definition-missing', label: 'Named by the page; the view is not in your Solution sources' },
    );
    result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
    return result;
  }
  // A form control whose column is not in the Solution sources (its FormXml or table definition is missing, or the
  // form is the portal's built-in profile form): the column its cell declares is only named by the page.
  const formDeclared = hostName || logicalName || cellName || labelName;
  if (
    !fields.length &&
    live &&
    (chosenForm || profileForm) &&
    !gridElement &&
    declaredTable &&
    /^[a-z][a-z0-9_]*$/i.test(formDeclared)
  ) {
    add(
      {
        kind: 'column',
        key: 'column:' + declaredTable + ':' + formDeclared.toLowerCase(),
        entity: declaredTable,
        field: formDeclared,
        name: formDeclared,
      },
      platformPart(formDeclared) ? ownRole : 'enclosing',
      'identity',
      'rendered-declaration',
      profileForm
        ? { reason: 'profile-form', label: "Named by the page; the portal's built-in profile form renders it" }
        : {
            reason: 'column-definition-missing',
            label: 'Named by the page; this column is not in your Solution sources',
          },
    );
    result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
    return result;
  }
  if (fields.length === 1) {
    const field = fields[0];
    const columnBinding = {
      kind: 'column',
      key: 'column:' + declaredTable + ':' + field.name.toLowerCase(),
      entity: declaredTable,
      field: field.name,
      name: field.name,
      label: field.label,
    };
    if (!platformPart(field.name)) {
      add(columnBinding, 'enclosing', 'contains', 'native-field-id', insideCell);
      result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
      return result;
    }
    if (explicitNames.some((name) => name.toLowerCase() !== field.name.toLowerCase())) return columnConflict();
    // A real code component host names the component rendering the column: join it to the code component the
    // form configures for that column (FormXml customControl, the inspection's native code component binding).
    const pcfRoot = live
      ? (within.find((item) => /^PcfControl_[0-9a-f]{32}$/i.test(get(item, 'id') ?? '')) ??
        within.find(
          (item) =>
            /_Container$/i.test(get(item, 'id') ?? '') &&
            call(item, 'querySelector', ':scope > [id^="PcfControlConfig_"]'),
        ))
      : null;
    const config = call(pcfRoot, 'querySelector', '[id^="PcfControlConfig_"][data-pcf-control]');
    let mounted = null;
    if (config && get(config, 'id') === 'PcfControlConfig_' + field.name) {
      try {
        const encoded = attribute(config, 'pcf-controlcontext');
        const context = encoded.length <= 16384 ? JSON.parse(encoded) : null;
        const controlName = typeof context?.ControlName === 'string' ? context.ControlName.toLowerCase() : '';
        const rows = (bindings.codeComponents ?? []).filter(
          (row) =>
            controlName &&
            String(row.field ?? '').toLowerCase() === field.name.toLowerCase() &&
            [row.schemaName, row.name].some((name) => typeof name === 'string' && name.toLowerCase() === controlName) &&
            (!chosenForm || !row.formId || norm(row.formId) === norm(chosenForm.id)),
        );
        const schemaNames = [...new Set(rows.map((row) => String(row.schemaName ?? row.name)))];
        if (context?.ControlId === field.name && schemaNames.length === 1)
          mounted = {
            kind: 'pcf',
            key: 'pcf:' + schemaNames[0].toLowerCase(),
            name: schemaNames[0],
            field: field.name,
            entity: declaredTable,
            controlName: field.name,
            ...(chosenForm ? { formId: chosenForm.id } : {}),
          };
      } catch {
        /* An unreadable host context names no component; the column remains. */
      }
    }
    const label = partLabel();
    if (mounted) {
      add(columnBinding, 'enclosing', 'contains', 'native-field-id', { label: 'Column of this code component' });
      add(mounted, ownRole, 'identity', 'native-component-id', { label: 'Code component of this column' });
    } else if (declaredOnly)
      add(columnBinding, ownRole, 'identity', 'rendered-declaration', {
        reason: 'view-definition-missing',
        label: 'Named by the page; the view is not in your Solution sources',
      });
    else
      add(columnBinding, ownRole, 'identity', 'native-field-id', {
        label:
          label ||
          (chosenGrid || gridElement ? 'Matched by grid column on the page' : 'Matched by field name on the page'),
      });
    result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
    return result;
  }
  if (live && !selectedContainer && !lookupHost && ownRole === 'owner') namePart();
  result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
  return result;

  function namedPart(owner, part, label) {
    if (!owner) return;
    add(
      {
        ...owner.binding,
        key: owner.binding.key + '#' + part,
        name: owner.binding.name ?? part,
        part,
      },
      'owner',
      'identity',
      owner.proof,
      { label },
    );
  }

  function closestWithin(selector) {
    return within.find((item) => call(item, 'matches', selector)) ?? null;
  }

  // The form's progress indicator, validation summary, message, actions and spam protection; true when one is named.
  function nameFormChrome(form) {
    if (idOf(boundary).endsWith('_ProgressIndicator') || closestWithin('[id$="_ProgressIndicator"],ol.progress')) {
      namedPart(form, 'progress', 'Progress indicator of this form');
      return true;
    }
    if (closestWithin('.validation-summary,[id^="ValidationSummary"]')) {
      namedPart(form, 'validation-summary', 'Validation summary of this form');
      return true;
    }
    const message = closestWithin('#MessagePanel');
    if (message) {
      const part = call(message, 'matches', '.alert-success,.success') ? 'success-message' : 'message';
      namedPart(form, part, 'Message of this form');
      return true;
    }
    if (closestWithin('.actions,.form-custom-actions,#PreviousButton,#NextButton')) {
      namedPart(form, 'actions', 'Actions of this form');
      return true;
    }
    if (within.some((item) => [...item.classList].some((name) => name.startsWith('frm-g-')))) {
      namedPart(form, 'honeypot', 'Spam protection field of this form');
      return true;
    }
    return false;
  }

  // The form's instructions, record state, custom JavaScript, file attachment, CAPTCHA and panel; true when one is named.
  function nameFormAuxiliaryPart(form) {
    if (closestWithin('.instructions')) {
      namedPart(form, 'instructions', 'Instructions of this form');
      return true;
    }
    if (FORM_STATE.test(get(node, 'id') ?? '')) {
      namedPart(form, 'state', 'Record state of this form');
      return true;
    }
    // The form's custom JavaScript: <span><script> first inside the wrapper.
    if (
      get(node, 'localName') === 'span' &&
      tagOf(get(node, 'firstElementChild')) === 'script' &&
      !attribute(get(node, 'firstElementChild'), 'src')
    ) {
      namedPart(form, 'custom-javascript', 'Custom JavaScript of this form');
      return true;
    }
    if (closestWithin('[id*="AttachFile"]')) {
      namedPart(form, 'attach-file', 'File attachment of this form');
      return true;
    }
    if (closestWithin('.captcha-cell,[id*="Captcha"]')) {
      namedPart(form, 'captcha', 'CAPTCHA of this form');
      return true;
    }
    if (form && call(node, 'matches', '.crmEntityFormView')) {
      add(form.binding, 'owner', 'identity', form.proof, { label: 'Panel of this form' });
      return true;
    }
    return false;
  }

  // Tabs and sections carry their FormXml names (data-name). They are exact when the inspection report lists
  // the form's layout with that name, otherwise only named by the page. Only the portal's own structure counts,
  // as captured basic, multistep and profile forms render it: the tab (div.tab, preceded by its h2.tab-title)
  // directly under the form view, holding div.tab-column; each tab column holds a div with the fieldsets, and a
  // fieldset (with its legend) holds the section table. An element with the same classes elsewhere in the form
  // (an author's or a script's markup) is not a tab or section, and neither is what it holds.
  function isFormView(element) {
    return /(?:^|_)EntityFormView$|^ProfileFormView$/.test(idOf(element));
  }

  function isPlatformTab(element) {
    return (
      call(element, 'matches', 'div.tab[data-name]') === true &&
      isFormView(parentOf(element)) &&
      childrenOf(element).some((item) => call(item, 'matches', 'div.tab-column'))
    );
  }

  function isPlatformSection(element) {
    if (call(element, 'matches', 'table.section[data-name]') !== true) return false;
    const fieldset = parentOf(element);
    const column = parentOf(parentOf(fieldset));
    return (
      tagOf(fieldset) === 'fieldset' &&
      call(column, 'matches', 'div.tab-column') === true &&
      isPlatformTab(parentOf(column))
    );
  }

  // The structure between the selection and its section or tab: platform markup only.
  function passesThrough(container, allowed) {
    const index = within.indexOf(container);
    return index >= 0 && within.slice(0, index).every((item) => call(item, 'matches', allowed) === true);
  }

  // [kind, name] of the platform section or tab the selection stands in, or null when it stands in neither.
  function formLayoutPlace() {
    const sectionTable = within.find(isPlatformSection);
    const fieldsetOf = within.find(
      (item) =>
        tagOf(item) === 'fieldset' &&
        childrenOf(item).filter((child) => call(child, 'matches', 'table.section[data-name]')).length === 1,
    );
    const fieldsetSection = fieldsetOf
      ? childrenOf(fieldsetOf).find((child) => call(child, 'matches', 'table.section[data-name]'))
      : null;
    let section = null;
    if (sectionTable && passesThrough(sectionTable, 'tbody,thead,tr,td.cell,colgroup,col')) section = sectionTable;
    else if (!sectionTable && isPlatformSection(fieldsetSection) && passesThrough(fieldsetOf, 'legend,legend *'))
      section = fieldsetSection;
    // A tab's title (h2.tab-title) stands right before the tab it names.
    const title = within.find((item) => call(item, 'matches', 'h2.tab-title'));
    const titled = get(title, 'nextElementSibling');
    const tabElement = within.find(isPlatformTab);
    let tab = null;
    if (tabElement && passesThrough(tabElement, 'div.tab-column,div.tab-column > div')) tab = tabElement;
    else if (!tabElement && isPlatformTab(titled)) tab = titled;
    if (section) return ['section', attribute(section, 'data-name')];
    return tab ? ['tab', attribute(tab, 'data-name')] : null;
  }

  function nameFormLayoutPart(form) {
    const place = formLayoutPlace();
    const formXml = chosenForm.formXml;
    if (place && !formXml?.id && form) {
      const [kind, name] = place;
      add(
        { kind: 'form-' + kind, key: form.binding.key + '#' + kind + ':' + name, name },
        'owner',
        'identity',
        'rendered-declaration',
        { reason: 'form-layout-unavailable', label: 'Named by the page; the form layout was not read' },
      );
      return;
    }
    if (!place || !formXml?.id) return;
    const [kind, name] = place;
    const layoutOf = Array.isArray(formXml?.layout) ? formXml.layout : null;
    const known = layoutOf
      ? layoutOf.some((item) =>
          kind === 'tab'
            ? item?.name === name
            : (item?.sections ?? []).some((entry) => (entry?.name ?? entry) === name),
        )
      : null;
    if (known === false) return;
    add(
      {
        kind: 'form-' + kind,
        key: 'form:' + String(formXml.id).replace(/[{}]/g, '').toLowerCase() + ':' + kind + ':' + name,
        name,
        formId: String(formXml.id).replace(/[{}]/g, '').toLowerCase(),
      },
      'owner',
      'identity',
      known ? 'native-component-id' : 'rendered-declaration',
      known
        ? { label: kind === 'tab' ? 'Tab of this form' : 'Section of this form' }
        : { reason: 'form-layout-unavailable', label: 'Named by the page; the form layout was not read' },
    );
  }

  // The action a subgrid or list dialog (a Bootstrap modal) opens, from its modal-form-<action> or modal-<name> class.
  function modalAction(modal) {
    const classes = [...modal.classList];
    const typed = classes.map((name) => /^modal-form-(.+)$/.exec(name)?.[1]).find(Boolean);
    const generic = classes
      .map((name) => /^modal-(.+)$/.exec(name)?.[1])
      .find(
        (name) =>
          name &&
          !['form', 'fade', 'dialog', 'content', 'header', 'body', 'footer', 'title', 'lg', 'sm'].includes(name),
      );
    const action = typed === 'insert' ? 'create' : (typed ?? generic ?? 'dialog');
    return action === 'run-workflow' ? 'workflow' : action;
  }

  function nameCollectionPart() {
    const collection = ownerBindings.get('subgrid') ?? ownerBindings.get('list');
    if (!collection) return;
    const modal = closestWithin('.modal');
    if (modal)
      return namedPart(
        collection,
        'action:' + modalAction(modal),
        'Dialog of this ' + (chosenSubgrid ? 'subgrid' : 'list'),
      );
    const owner = chosenSubgrid ? 'subgrid' : 'list';
    // A list shown as a calendar or map: the layout its wrapper declares (data-view).
    const shownAs = attribute(call(boundary, 'closest', '.entitylist[data-view]'), 'data-view');
    if (!gridElement && ['calendar', 'map'].includes(shownAs) && within.length)
      return namedPart(collection, shownAs, (shownAs === 'map' ? 'Map' : 'Calendar') + ' of this list');
    // The grid's body: the rows and cells of the view it shows.
    if (closestWithin('.view-grid')) {
      const view = ownerBindings.get('view');
      if (view) return add(view.binding, 'owner', 'identity', view.proof, { label: 'Grid of this view' });
      return namedPart(collection, 'grid', 'Grid of this ' + owner);
    }
    for (const [selector, part, words] of [
      ['.view-empty-maker', 'empty-maker', 'Empty message for makers'],
      ['.view-empty', 'empty', 'Empty message'],
      ['.view-access-denied', 'access-denied', 'Access denied message'],
      ['.view-error', 'error', 'Error message'],
      ['.view-loading', 'loading', 'Loading message'],
      ['.view-pagination,.pagination', 'pagination', 'Pagination'],
      ['.view-search,.entitylist-search,[id^="SearchCountText"]', 'search', 'Search box'],
      ['.view-select,.view-selector', 'view-selector', 'View selector'],
      ['.entitylist-filter,[id^="EntityList"]:not([id^="EntityListControl"])', 'filter', 'Filter'],
      ['.view-toolbar,.grid-actions,.toolbar-actions', 'toolbar', 'Toolbar'],
    ])
      if (closestWithin(selector)) return namedPart(collection, part, words + ' of this ' + owner);
  }

  // A recognised part of the selection's component (the vocabulary of Mirage's form and list renderers): the
  // Component row names the component and the part.
  function namePart() {
    const form = ownerBindings.get(chosenForm ? formKind(chosenForm) : '');
    if (chosenForm && !gridElement) {
      if (nameFormChrome(form) || nameFormAuxiliaryPart(form)) return;
      nameFormLayoutPart(form);
      return;
    }
    nameCollectionPart();
  }
}
