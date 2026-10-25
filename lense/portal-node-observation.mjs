/** Self-contained structural Power Pages read. No values, row IDs, text or URL parameters. */
export function observePortalNode(node, { scope, bindings = {}, sourceRefs = [], sourceRefsByComponent = null } = {}) {
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
  for (const current of ancestors) {
    const layouts = [];
    const nativeWrapper = /^(?:EntityFormControl|WebFormControl)(?:_|$)/.test(current.id ?? '');
    const genericView = current.id === 'EntityFormView' || current.id === 'EntityFormControl_EntityFormView';
    const genericWrapper = genericNativeId(current.id);
    const nativeLayouts =
      nativeWrapper || genericView ? [...current.querySelectorAll(':scope > [data-form-layout]')].slice(0, 2) : [];
    if (current.id === 'WebFormControl')
      nativeLayouts.push(
        ...[...current.querySelectorAll(':scope > #WebFormPanel > #EntityFormView > [data-form-layout]')].slice(0, 2),
      );
    if (current.id === 'EntityFormControl')
      nativeLayouts.push(
        ...[
          ...current.querySelectorAll(
            ':scope > #EntityFormPanel > #EntityFormControl_EntityFormView > [data-form-layout]',
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
      ...layouts.map((layout) => (typeof layout.Id === 'string' ? layout.Id : '')),
    ].filter(Boolean);
    const declaredForms = formIds.map((formId) =>
      forms.filter((form) => [form.id, form.formXml?.id].some((id) => norm(id) === norm(formId))),
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
  if (!boundary) return result;
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
  const names = explicitNames.length
    ? explicitNames
    : cell && bindings.grid?.name
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
    );
  }
  result.sourceRefs = [...new Map(result.sourceRefs.map((ref) => [ref.id, ref])).values()];
  return result;
}
