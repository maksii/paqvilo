/** Self-contained browser runtime; no Node imports, record reads or copied API objects. */
export function modelDrivenObservationRuntime() {
  const snapshot = globalThis.structuredClone.bind(globalThis);
  const logical = (value) => (typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/i.test(value) ? value : undefined);
  const controlName = (value) =>
    typeof value === 'string' && /^[a-z_][a-z0-9_.-]{0,255}$/i.test(value) ? value : undefined;
  const guid = (value) =>
    typeof value === 'string' && /^[{]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[}]?$/i.test(value)
      ? value.replace(/[{}]/g, '').toLowerCase()
      : undefined;
  const safe = (callback) => {
    try {
      return { state: 'available', value: callback() };
    } catch {
      return { state: 'throws' };
    }
  };
  const property = (object, name) => safe(() => object?.[name]).value;
  const method = (object, name, ...args) => {
    const read = safe(() => object?.[name]);
    return read.state !== 'available'
      ? read
      : typeof read.value === 'function'
        ? safe(() => read.value.apply(object, args))
        : { state: 'unsupported' };
  };
  let nativeGeneration = 0,
    contextSignature = '',
    structureSignature = '';
  const quickStates = new Map();
  const refreshGeneration = (context) => {
    const next = JSON.stringify([
      context?.entity,
      context?.formId,
      context?.formType,
      context?.pageType,
      context?.requested,
    ]);
    if (next !== contextSignature) {
      contextSignature = next;
      structureSignature = '';
      quickStates.clear();
      nativeGeneration++;
    }
    return nativeGeneration;
  };
  const readContext = (origin) => {
    if (location.origin !== origin) return null;
    const form = safe(() => globalThis.Xrm?.Page).value;
    const input = safe(() => globalThis.Xrm?.Utility?.getPageContext?.()?.input).value;
    const pageType = property(input, 'pageType'),
      ui = property(form, 'ui');
    const type = ['entityrecord', 'entitylist'].includes(pageType) ? pageType : undefined;
    const selector = method(property(ui, 'formSelector'), 'getCurrentItem');
    const formId = selector.value == null ? undefined : guid(method(selector.value, 'getId').value);
    const formType = method(ui, 'getFormType').value;
    const observedEntity = logical(method(property(property(form, 'data'), 'entity'), 'getEntityName').value);
    const entity = observedEntity ?? logical(property(input, 'entityName'));
    const requestedForm = guid(property(input, 'formId')),
      requestedView = guid(property(input, 'viewId')),
      requestedViewType = property(input, 'viewType');
    return {
      version: 1,
      pageType: type,
      entity,
      entityOrigin: observedEntity ? 'form-api' : 'requested-input',
      formId,
      ...(Number.isInteger(formType) && formType >= 0 && formType <= 20 ? { formType } : {}),
      requested: {
        ...(requestedForm ? { formId: requestedForm } : {}),
        ...(requestedView ? { viewId: requestedView } : {}),
        ...(['savedquery', 'userquery'].includes(requestedViewType) ? { viewType: requestedViewType } : {}),
      },
      availability: {
        formSelector: selector.state === 'available' && selector.value == null ? 'null' : selector.state,
        currentView: 'unavailable-without-grid-context',
      },
      frameBoundary: false,
    };
  };
  const controlStructure = (control) => {
    const name = controlName(method(control, 'getName').value);
    const kind = controlName(method(control, 'getControlType').value);
    const attribute = logical(method(method(control, 'getAttribute').value, 'getName').value);
    const sectionObject = method(control, 'getParent').value;
    const section = controlName(method(sectionObject, 'getName').value);
    const tab = controlName(method(method(sectionObject, 'getParent').value, 'getName').value);
    return {
      ...(name ? { name } : {}),
      ...(kind ? { kind } : {}),
      ...(attribute ? { attribute } : {}),
      ...(section ? { section } : {}),
      ...(tab ? { tab } : {}),
    };
  };
  const currentNativeGeneration = (origin) => {
    refreshGeneration(readContext(origin));
    const form = safe(() => globalThis.Xrm?.Page).value;
    const nextStructure = JSON.stringify(
      ['controls', 'tabs', 'quickForms'].map((name) => method(safe(() => form?.ui?.[name]).value, 'getLength').value),
    );
    if (structureSignature && structureSignature !== nextStructure) nativeGeneration++;
    structureSignature = nextStructure;
    for (const [index, previous] of quickStates) {
      const quick = method(safe(() => form?.ui?.quickForms).value, 'get', index).value;
      const loaded = method(quick, 'isLoaded');
      const next = JSON.stringify([
        controlName(method(quick, 'getName').value),
        loaded.value === true,
        loaded.state === 'available' && loaded.value !== true ? 'not-ready' : loaded.state,
      ]);
      if (next !== previous) {
        quickStates.set(index, next);
        nativeGeneration++;
      }
    }
    return nativeGeneration;
  };
  const collectionPage = (collection, cursor, limit, transform) => {
    const count = method(collection, 'getLength');
    if (!Number.isSafeInteger(count.value) || count.value < 0)
      return { rows: [], complete: false, availability: count.state === 'available' ? 'unavailable' : count.state };
    const start = Number.isSafeInteger(cursor) ? Math.max(0, Math.min(count.value, cursor)) : 0;
    const rows = [];
    let offset = start;
    for (; offset < count.value && rows.length < limit; offset++) {
      const read = method(collection, 'get', offset);
      if (read.state !== 'available' || !read.value)
        return { rows, complete: false, total: count.value, next: offset, availability: read.state };
      const row = transform(read.value, offset);
      if (row == null)
        return { rows, offset: start, complete: false, total: count.value, next: offset, availability: 'budget' };
      rows.push(row);
    }
    return {
      rows,
      offset: start,
      total: count.value,
      complete: offset >= count.value,
      ...(offset < count.value ? { next: offset } : {}),
      availability: 'available',
    };
  };
  const collectionFrom = (access, cursor, limit, transform) => {
    const read = safe(access);
    return read.state === 'available'
      ? collectionPage(read.value, cursor, limit, transform)
      : { rows: [], complete: false, availability: read.state };
  };
  const observe = ({ origin, scope, anchorGeneration, cursor = {}, budget = {} }) => {
    const context = readContext(origin);
    if (!context)
      return { version: 1, scope, anchorGeneration, context: null, availability: [{ reason: 'origin-boundary' }] };
    const form = safe(() => globalThis.Xrm?.Page).value;
    refreshGeneration(context);
    if (cursor.nativeGeneration !== undefined && cursor.nativeGeneration !== nativeGeneration)
      return {
        version: 1,
        scope,
        anchorGeneration,
        context,
        nativeGeneration,
        obsolete: true,
        availability: [{ reason: 'native-structure-generation-changed' }],
      };
    const limit = Math.max(1, Math.min(512, Number.isSafeInteger(budget.items) ? budget.items : 128));
    let remaining = limit,
      remainingBytes = Math.max(
        1024,
        Math.min(256 * 1024, Number.isSafeInteger(budget.bytes) ? budget.bytes : 64 * 1024),
      );
    const take = (row) => {
      const size = new TextEncoder().encode(JSON.stringify(row)).length;
      if (remaining < 1 || size > remainingBytes) return null;
      remaining--;
      remainingBytes -= size;
      return row;
    };
    const controls = collectionFrom(
      () => form?.ui?.controls,
      cursor.controls,
      limit,
      (control) => take(controlStructure(control)),
    );
    const tabs = collectionFrom(
      () => form?.ui?.tabs,
      cursor.tabs,
      limit,
      (tab, index) => {
        const row = take({ name: controlName(method(tab, 'getName').value), index });
        if (!row) return null;
        row.sections = collectionFrom(
          () => tab.sections,
          cursor.sections?.[index],
          limit,
          (section) => take({ name: controlName(method(section, 'getName').value) }),
        );
        return row;
      },
    );
    const quickForms = collectionFrom(
      () => form?.ui?.quickForms,
      cursor.quickForms,
      limit,
      (quick, quickIndex) => {
        const loaded = method(quick, 'isLoaded');
        const result = take({
          ...controlStructure(quick),
          index: quickIndex,
          loaded: loaded.value === true,
          availability: loaded.state === 'available' && loaded.value !== true ? 'not-ready' : loaded.state,
        });
        if (!result) return null;
        const signature = JSON.stringify([result.name, result.loaded, result.availability]);
        if (quickStates.has(quickIndex) && quickStates.get(quickIndex) !== signature) nativeGeneration++;
        quickStates.set(quickIndex, signature);
        if (quickStates.size > 2048) quickStates.delete(quickStates.keys().next().value);
        if (loaded.value === true) {
          const controls = [];
          let complete = false;
          const start = Number.isSafeInteger(cursor.quickControls?.[quickIndex])
            ? Math.max(0, cursor.quickControls[quickIndex])
            : 0;
          for (let index = start; index < start + limit; index++) {
            const item = method(quick, 'getControl', index);
            if (item.state !== 'available') {
              result.availability = item.state;
              break;
            }
            if (!item.value) {
              complete = true;
              break;
            }
            const row = take(controlStructure(item.value));
            if (!row) break;
            controls.push(row);
          }
          result.controls = {
            rows: controls,
            offset: start,
            complete,
            ...(!complete && result.availability === 'available' ? { next: start + controls.length } : {}),
          };
        }
        return result;
      },
    );
    const nextSignature = JSON.stringify([controls.total, tabs.total, quickForms.total]);
    if (structureSignature && structureSignature !== nextSignature) nativeGeneration++;
    structureSignature = nextSignature;
    refreshGeneration(readContext(origin));
    const nextCursor = {
      nativeGeneration,
      controls: controls.next ?? controls.total ?? 0,
      tabs: tabs.next ?? tabs.total ?? 0,
      quickForms: quickForms.next ?? quickForms.total ?? 0,
      sections: {},
      quickControls: {},
    };
    for (const row of tabs.rows)
      if (!row.sections.complete) {
        tabs.complete = false;
        nextCursor.tabs = Math.min(nextCursor.tabs, row.index);
        nextCursor.sections[row.index] = row.sections.next ?? row.sections.offset ?? 0;
      }
    quickForms.descendantsComplete = quickForms.rows.every((row) => row.loaded && row.controls?.complete);
    for (const row of quickForms.rows)
      if (row.controls && !row.controls.complete) {
        quickForms.complete = false;
        nextCursor.quickForms = Math.min(nextCursor.quickForms, row.index);
        nextCursor.quickControls[row.index] = row.controls.next ?? row.controls.offset ?? 0;
      }
    for (const row of quickForms.rows)
      if (!row.loaded) nextCursor.quickForms = Math.min(nextCursor.quickForms, row.index);
    return {
      version: 1,
      scope,
      anchorGeneration,
      context,
      nativeGeneration,
      ...(cursor.nativeGeneration !== undefined && cursor.nativeGeneration !== nativeGeneration
        ? { obsolete: true }
        : {}),
      nextCursor,
      controls,
      tabs,
      quickForms,
      availability: [
        {
          capability: 'current-form',
          reason: context.formId ? 'available' : `form-selector-${context.availability.formSelector}`,
        },
        { capability: 'main-grid-current-view', reason: 'documented-grid-context-not-supplied' },
        { capability: 'footer', reason: 'native-footer-api-removed' },
      ],
      limits: {
        truncated: !controls.complete || !tabs.complete || !quickForms.complete || !quickForms.descendantsComplete,
      },
    };
  };
  const hints = (node) => {
    let control, column, grid, command;
    for (
      let element = node.nodeType === 1 ? node : node.parentElement, count = 0;
      element && count++ < 32;
      element = element.parentElement ?? element.getRootNode?.().host
    ) {
      if (element.ownerDocument !== node.ownerDocument) break;
      const name = controlName(element.getAttribute('name'));
      if (!control && name) control = name;
      const data = element.getAttribute('data-id');
      if (
        !command &&
        typeof data === 'string' &&
        data.length <= 2048 &&
        (element.localName === 'button' || element.getAttribute('role') === 'button') &&
        // eslint-disable-next-line no-control-regex -- Reject control bytes in native metadata selectors.
        /^[a-z][a-z0-9_]*\|NoRelationship\|(?:Form|Grid)\|[^|\u0000-\u001f]+$/i.test(data)
      )
        command = data;
      if (typeof data !== 'string' || data.length > 512) continue;
      const candidate = data.startsWith('dataSetRoot_') ? controlName(data.slice(12)) : controlName(data.split('.')[0]);
      if (candidate && !control) control = candidate;
      if (data.startsWith('dataSetRoot_') && candidate) grid = candidate;
      if (candidate && logical(candidate)) column ??= candidate;
    }
    return { control, column, grid, command };
  };
  const queryNative = (node, { scope, anchorGeneration, data = {} } = {}) => {
    const result = {
      version: 1,
      mode: 'live',
      scope,
      anchorGeneration,
      facts: [],
      contextFacts: [],
      sourceKeys: [],
      sourceRefs: [],
      availability: [],
      limits: {},
      providerGeneration: 0,
    };
    if (!node || node.ownerDocument !== document || !node.isConnected || location.origin !== data.origin) {
      result.availability.push({ reason: 'node-document-origin-boundary' });
      return result;
    }
    const context = readContext(data.origin),
      form = safe(() => globalThis.Xrm?.Page).value;
    result.providerGeneration = refreshGeneration(context);
    const hint = hints(node);
    result.active = {
      entity: context?.entity,
      formId: context?.formId,
      controlNames: hint.control ? [hint.control] : [],
    };
    const fact = (binding, proof, dimension = 'owner', extra = {}) => ({
      subject: dimension === 'owner' ? 'selection' : binding.key,
      predicate: dimension === 'owner' ? 'identity' : 'contains',
      dimension,
      kind: 'observed',
      proof,
      binding,
      scope,
      ...extra,
    });
    if (context?.entity)
      result.contextFacts.push(
        fact(
          { key: `table:${context.entity}`, kind: 'table', entity: context.entity },
          context.entityOrigin === 'form-api' ? 'native-api' : 'requested-input',
          'context',
        ),
      );
    if (context?.formId)
      result.contextFacts.push(
        fact(
          { key: `form:${context.formId}`, kind: 'form', id: context.formId, entity: context.entity },
          'native-api',
          'context',
        ),
      );
    for (const [kind, id] of Object.entries(context?.requested ?? {}))
      if (['formId', 'viewId'].includes(kind)) {
        const type = kind === 'formId' ? 'form' : 'view';
        result.contextFacts.push(
          fact({ key: `${type}:${id}`, kind: type, id }, 'requested-input', 'context', {
            predicate: `requested-${type}`,
            reason: 'opening-input-is-not-current-identity',
          }),
        );
      }
    const forms = data.catalogue?.forms ?? [];
    const current = forms.find((item) => item.id === context?.formId);
    const controls = current?.controls ?? [];
    const bindControl = (name, direct = false) => {
      const matched = controls.filter((control) => control.id === name);
      const selected = matched.length === 1 ? matched[0] : null;
      const binding = selected
        ? {
            key: selected.key,
            kind: selected.kind === 'subgrid' ? 'subgrid' : 'control',
            controlName: name,
            formId: context.formId,
            entity: context.entity,
          }
        : {
            key: `native-control:${scope?.frameId ?? 'current'}:${name}`,
            kind: 'native-control',
            controlName: name,
            ...(context?.formId ? { formId: context.formId } : {}),
          };
      result.facts.push(fact(binding, direct ? 'native-api' : 'native-dom'));
      result.sourceKeys.push(binding.key);
    };
    if (hint.command) {
      const [entity, , location] = hint.command.split('|');
      const commandKey = `native-command:${encodeURIComponent(hint.command)}`;
      result.active.componentKeys = [commandKey];
      result.sourceKeys.push(commandKey);
      const matches = (data.catalogue?.commands ?? []).filter(
        (command) =>
          command.entity === context?.entity &&
          entity === context?.entity &&
          command.locations?.includes(location.toLowerCase()) &&
          command.nativeControlIds?.includes(hint.command),
      );
      for (const command of matches) {
        result.facts.push(
          fact(
            { key: command.key, kind: 'command', id: command.id, entity: command.entity, label: command.label },
            'native-dom',
            'owner',
            {
              reason:
                matches.length > 1
                  ? 'ambiguous-exported-command-identifier'
                  : 'exported-command-identifier-is-not-execution-proof',
            },
          ),
        );
        result.sourceKeys.push(command.key);
      }
      if (!matches.length)
        result.availability.push({
          capability: 'selected-command',
          reason: 'no-current-exported-command-identifier-match',
        });
    }
    const candidates = [];
    const frameElement = node.nodeType === 1 && (node.localName === 'iframe' || node.closest?.('iframe'));
    if (hint.control) {
      const selected = method(form, 'getControl', hint.control);
      if (selected.value) candidates.push(selected.value);
    }
    for (const control of frameElement
      ? controls.filter((item) => ['web-resource', 'other'].includes(item.kind))
      : []) {
      const selected = method(form, 'getControl', control.id);
      if (selected.value && !candidates.includes(selected.value)) candidates.push(selected.value);
      if (candidates.length >= 128) break;
    }
    const nativeControls = frameElement ? safe(() => form?.ui?.controls) : null;
    const count = frameElement ? method(nativeControls.value, 'getLength') : null;
    const length = count?.value;
    if (frameElement && (nativeControls.state !== 'available' || count.state !== 'available'))
      result.availability.push({
        capability: 'native-control-collection',
        reason: nativeControls.state === 'throws' ? 'throws' : count.state,
      });
    for (let index = 0; Number.isSafeInteger(length) && index < Math.min(length, 128); index++) {
      const control = method(nativeControls.value, 'get', index).value;
      if (control && !candidates.includes(control)) candidates.push(control);
    }
    let direct = false;
    for (const control of frameElement ? candidates : []) {
      const type = method(control, 'getControlType').value;
      if (!['iframe', 'webresource'].includes(type)) continue;
      const object = method(control, 'getObject');
      if (object.state !== 'available' || !object.value) {
        result.availability.push({
          capability: 'control-object',
          reason: object.state === 'available' ? 'not-ready' : object.state,
        });
        continue;
      }
      if (!(object.value instanceof document.defaultView.HTMLIFrameElement)) {
        result.availability.push({ capability: 'control-object', reason: 'unsupported-object-type' });
        continue;
      }
      if (object.value.ownerDocument === document && object.value === node) {
        const name = controlName(method(control, 'getName').value);
        if (name) {
          bindControl(name, true);
          direct = true;
          break;
        }
      }
    }
    if (!hint.command && !direct && hint.control && context?.pageType !== 'entitylist') bindControl(hint.control);
    if (!result.facts.length && hint.column && context?.entity) {
      const key = `column:${context.entity}:${hint.column}`;
      result.facts.push(fact({ key, kind: 'column', entity: context.entity, field: hint.column }, 'native-dom'));
      result.sourceKeys.push(key);
    }
    // A subgrid context comes from a current form control, not from page input or a default view.
    if (hint.grid) {
      const grid = method(form, 'getControl', hint.grid).value;
      const selector = method(grid, 'getViewSelector');
      const view = method(selector.value, 'getCurrentView');
      const id = guid(property(view.value, 'id'));
      if (id)
        result.contextFacts.push(
          fact({ key: `view:${id}`, kind: 'view', id }, 'native-api', 'context', { predicate: 'current-view' }),
        );
      else
        result.availability.push({
          capability: 'subgrid-current-view',
          reason: view.state === 'available' ? 'unavailable' : view.state,
        });
    }
    if (!context?.formId)
      result.availability.push({
        capability: 'current-form',
        reason: `form-selector-${context?.availability.formSelector ?? 'unavailable'}`,
      });
    if (context?.pageType === 'entitylist')
      result.availability.push({
        capability: 'main-grid-current-view',
        reason: 'documented-grid-context-not-supplied',
      });
    if (Number.isSafeInteger(length) && length > 128)
      result.limits = { truncated: true, controlCount: length, reason: 'native-structure-paged' };
    if (!result.facts.length)
      result.availability.push({ capability: 'selected-owner', reason: 'no-direct-native-association' });
    result.context = context;
    return result;
  };
  const enrich = (packet, current) => {
    const refs = current.sourceRefs ?? [];
    const validated =
      current.validatedAnchorGeneration === packet.anchorGeneration &&
      current.validatedScope &&
      ['documentId', 'frameId', 'uiEpoch', 'sourceRevision'].every(
        (key) => current.validatedScope[key] === packet.scope?.[key],
      );
    const rendered =
      packet.mode === 'local'
        ? packet.sourceRefs.map((ref) => {
            const next = refs.find((item) => item.id === ref.id);
            return {
              ...ref,
              currentState:
                ref.currentState === 'unavailable' || next?.currentState === 'unavailable'
                  ? 'unavailable'
                  : validated && next
                    ? 'available'
                    : 'pending',
              ...(next ? { currentContentRevision: next.currentContentRevision ?? next.contentRevision } : {}),
            };
          })
        : null;
    if (rendered) packet.sourceRefs = rendered;
    for (const fact of packet.facts ?? []) {
      const matches = (
        rendered ??
        refs.map((ref) => ({
          ...ref,
          currentState: ref.currentState === 'unavailable' ? 'unavailable' : validated ? 'available' : 'pending',
        }))
      ).filter((ref) => ref.componentKey === fact.binding?.key);
      fact.sourceRefIds = matches.map((ref) => ref.id);
      packet.sourceRefs.push(...matches);
    }
    packet.sourceRefs = [...new Map(packet.sourceRefs.map((ref) => [ref.id, ref])).values()];
    if (packet.sourceRefs.some((ref) => ref.currentState === 'pending'))
      packet.availability.push({
        capability: 'editable-source',
        reason: validated ? 'render-source-not-in-current-index' : 'current-source-details-pending',
      });
    if (packet.sourceRefs.some((ref) => ref.currentState === 'unavailable'))
      packet.availability.push({ capability: 'editable-source', reason: 'source-origin-revision-unverified' });
    if (packet.mode === 'live' && packet.sourceRefs.length)
      packet.availability.push({ capability: 'deployed-source-revision', reason: 'not-observed' });
    for (const item of current.unavailable ?? [])
      if (packet.sourceKeys.includes(item.key))
        packet.availability.push({ capability: 'editable-source', key: item.key, reason: item.reason });
    packet.limits = { ...packet.limits, metadata: current.limits };
    return packet;
  };
  const install = (data) => {
    if (location.origin !== data.origin) return false;
    const previous = globalThis.__paqviloModelDrivenProvider;
    if (previous?.token === data.token) {
      previous.update(data);
      return true;
    }
    if (previous) return false;
    let current = data;
    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver((records) => {
            if (
              records.some(
                (record) =>
                  !(record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest?.(
                    '#paqvilo-panel,#paqvilo-xray',
                  ),
              )
            )
              nativeGeneration++;
          })
        : null;
    observer?.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-id', 'name', 'id', 'role'],
    });
    const provider = Object.freeze({
      version: 1,
      token: data.token,
      kind: 'model-driven',
      update(next) {
        if (next.token === current.token && next.origin === current.origin) current = next;
      },
      query(node, options = {}) {
        const local = current.localSimulation && globalThis.__paqviloMirageProvenance;
        if (local && (local.version !== 1 || local.kind !== 'mirage-private-registry'))
          return {
            version: 1,
            mode: 'local',
            scope: options.scope,
            anchorGeneration: options.anchorGeneration,
            facts: [],
            contextFacts: [],
            sourceKeys: [],
            sourceRefs: [],
            availability: [{ reason: 'unsupported-local-registry-version' }],
          };
        const packet =
          local?.kind === 'mirage-private-registry'
            ? local.query(node, options)
            : queryNative(node, { ...options, data: current });
        packet.sourceRefs ??= [];
        packet.contextFacts ??= [];
        if (local?.kind === 'mirage-private-registry') {
          const context = local.context?.() ?? {};
          packet.active = {
            entity: context.entity,
            formId: context.formId,
            viewId: context.viewId,
            componentKeys: packet.sourceKeys,
            controlKeys: packet.sourceKeys.filter((key) => key.startsWith('control:')),
          };
        }
        return snapshot(enrich(packet, current));
      },
      observe(options) {
        return observe({ ...options, origin: current.origin });
      },
      generation() {
        return currentNativeGeneration(current.origin);
      },
      dispose() {
        observer?.disconnect();
        if (globalThis.__paqviloModelDrivenProvider === provider) delete globalThis.__paqviloModelDrivenProvider;
      },
    });
    Object.defineProperty(globalThis, '__paqviloModelDrivenProvider', { value: provider, configurable: true });
    return true;
  };
  return { readContext, observe, queryNative, install, enrich };
}
