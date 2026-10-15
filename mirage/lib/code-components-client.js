(function () {
  'use strict';
  if (window.__paqviloPcf) return;
  const constructors = new Map(), loaded = new Map(), instances = new Map(), counts = new Map(), history = [];
  const errorText = value => { try { return typeof value?.message === 'string' ? value.message : String(value); } catch { return 'Unknown PCF failure'; } };
  const debugValue = (value, depth = 0) => {
    try {
    if (value == null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (depth > 5) return '[depth limit]';
    if (Array.isArray(value)) return value.slice(0, 100).map(item => debugValue(item, depth + 1));
    return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 100).filter(([, descriptor]) => !('value' in descriptor) || typeof descriptor.value !== 'function').map(([key, descriptor]) => [key, 'value' in descriptor ? debugValue(descriptor.value, depth + 1) : '[accessor]']));
    } catch { return '[snapshot unavailable]'; }
  };
  const debugSnapshot = entry => { try { return {
    id: entry.id, constructor: entry.constructor, state: entry.state, error: entry.error ?? null,
    lifecycle: entry.lifecycle.map(item => ({ ...item })), outputs: debugValue(entry.outputs ?? {}), lastParameterUpdate: debugValue(entry.lastParameterUpdate ?? null),
    parameters: Object.fromEntries(Object.entries(entry.parameters ?? {}).map(([name, parameter]) => [name,
      Object.hasOwn(parameter, 'raw') ? { raw: debugValue(parameter.raw), formatted: parameter.formatted, type: parameter.type, attributes: debugValue(parameter.attributes), error: Boolean(parameter.error), errorMessage: parameter.errorMessage }
        : { dataset: true, loading: parameter.loading, error: parameter.error, errorMessage: parameter.errorMessage, sortedRecordIds: debugValue(parameter.sortedRecordIds), paging: debugValue(parameter.paging) }])),
  }; } catch (error) { return { id: entry.id, constructor: entry.constructor, state: entry.state, error: entry.error ?? null, snapshotError: errorText(error) }; } };
  const framework = window.ComponentFramework = window.ComponentFramework || {};
  const prior = framework.registerControl;
  framework.registerControl = function (name, constructor) {
    constructors.set(name, constructor);
    if (prior) prior.call(this, name, constructor);
  };
  function resource(item) {
    if (loaded.has(item.url)) return loaded.get(item.url);
    const promise = new Promise((resolve, reject) => {
      const node = document.createElement(item.kind === 'css' ? 'link' : 'script');
      if (item.kind === 'css') { node.rel = 'stylesheet'; node.href = item.url; } else node.src = item.url;
      node.onload = resolve;
      node.onerror = () => { node.remove(); loaded.delete(item.url); reject(new Error('The declared PCF resource failed to load: ' + item.url)); };
      document.head.appendChild(node);
    });
    loaded.set(item.url, promise);
    return promise;
  }
  function typed(value, type) {
    if (value == null || value === '') return null;
    if (type === 'TwoOptions') {
      if ([true, 'true', 1, '1'].includes(value)) return true;
      if ([false, 'false', 0, '0'].includes(value)) return false;
      throw new Error('PCF TwoOptions requires a Boolean value');
    }
    if (/^(Whole|Decimal|FP|Currency|Enum|OptionSet)/.test(type)) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error('PCF ' + type + ' requires a finite number');
      if (/^(Whole|Enum|OptionSet)/.test(type) && !Number.isInteger(number)) throw new Error('PCF ' + type + ' requires an integer');
      return number;
    }
    if (/^DateAndTime/.test(type)) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error('PCF date parameter is invalid');
      return date;
    }
    if (type === 'MultiSelectOptionSet') {
      const values = Array.isArray(value) ? value : String(value).split(',');
      return values.map(item => {
        if (item === '' || !Number.isInteger(Number(item))) throw new Error('PCF MultiSelectOptionSet requires integer option values');
        return Number(item);
      });
    }
    if (/^Lookup\./.test(type)) {
      let values = value;
      if (typeof values === 'string') { try { values = JSON.parse(values); } catch { throw new Error('PCF lookup parameters require lookup objects, not display text'); } }
      if (!Array.isArray(values)) values = [values];
      return values.map(item => {
        if (!item || typeof item !== 'object' || !item.id || !item.entityType) throw new Error('PCF lookup objects require id and entityType');
        return { id: String(item.id), entityType: String(item.entityType), name: String(item.name ?? '') };
      });
    }
    return value;
  }
  function groupType(types, boundType) {
    if (!types?.length) return null;
    if (boundType) return types.includes(boundType) ? boundType : null;
    if (types.every(type => ['SingleLine.Text', 'Multiple', 'SingleLine.TextArea', 'SingleLine.Email', 'SingleLine.Phone', 'SingleLine.URL', 'SingleLine.Ticker'].includes(type))) return 'SingleLine.Text';
    if (types.every(type => ['Decimal', 'FP', 'Whole.None', 'Currency'].includes(type))) return types.length === 1 ? types[0] : 'Decimal';
    if (types.every(type => ['DateAndTime.DateAndTime', 'DateAndTime.DateOnly'].includes(type))) return types.length === 1 ? types[0] : 'DateAndTime.DateAndTime';
    return types.length === 1 ? types[0] : null;
  }
  function nativeScope(container) {
    return container.closest('[data-pcf-native-field]') || container.closest('[data-mirage-component="entityform"], [data-mirage-component="webform"]') || container.closest('form') || document;
  }
  function nativeValue(spec, container) {
    const binding = spec.nativeBinding, scope = nativeScope(container);
    const byId = id => scope.querySelector('#' + CSS.escape(id));
    const field = byId(binding.id);
    if (!field) throw new Error('PCF native binding input was not found: ' + binding.id);
    if (binding.control === 'lookup') {
      if (!field.value) return null;
      return [{ id: recordId(field.value), name: byId(binding.id + '_name')?.value ?? '', entityType: byId(binding.id + '_entityname')?.value ?? '' }];
    }
    if (field.matches('input[type="checkbox"]')) return field.checked;
    const radios = field.matches('input[type="radio"]') ? [field] : Array.from(field.querySelectorAll('input[type="radio"]'));
    if (radios.length) return radios.find(radio => radio.checked)?.value ?? null;
    if (field.matches('select[multiple]')) return Array.from(field.selectedOptions, option => option.value);
    return field.value;
  }
  function nativeOutput(spec, container, outputs) {
    const binding = spec.nativeBinding;
    if (!binding || spec.args.disabled === true || spec.args.disabled === 'true') return;
    const properties = (binding.properties ?? []).filter(name => Object.hasOwn(outputs, name));
    if (!properties.length) return;
    const raw = outputs[properties[0]];
    if (properties.some(name => JSON.stringify(outputs[name]) !== JSON.stringify(raw))) throw new Error('PCF returned conflicting outputs for one native field');
    const scope = nativeScope(container);
    const byId = id => scope.querySelector('#' + CSS.escape(id));
    const field = byId(binding.id);
    if (!field) throw new Error('PCF native binding input was not found: ' + binding.id);
    if (field.disabled || field.readOnly) return;
    const events = new Set();
    const write = (node, value, derived = false) => { if (!node || node.disabled || node.readOnly && !derived) return; node.value = value; events.add(node); };
    const radios = field.matches('input[type="radio"]') ? [field] : Array.from(field.querySelectorAll('input[type="radio"]'));
    if (binding.control === 'lookup') {
      const item = Array.isArray(raw) ? raw[0] : raw;
      if (item != null && (typeof item !== 'object' || !item.id || !(item.entityType || item.etn))) throw new Error('PCF native lookup output requires a record reference');
      write(field, item ? recordId(item.id.guid ?? item.id) : '');
      write(byId(binding.id + '_name'), item?.name ?? '', true);
      write(byId(binding.id + '_entityname'), item?.entityType ?? item?.etn ?? '', true);
    } else if (field.matches('input[type="checkbox"]')) { field.checked = raw === true || raw === 1; events.add(field); }
    else if (radios.length) { for (const radio of radios) { if (!radio.disabled) { radio.checked = String(radio.value) === String(raw); events.add(radio); } } }
    else if (field.matches('select[multiple]')) { const values = new Set((raw == null ? [] : Array.isArray(raw) ? raw : [raw]).map(String)); for (const option of field.options) option.selected = values.has(option.value); events.add(field); }
    else if (field.matches('input,select,textarea')) {
      let value = raw == null ? '' : raw instanceof Date ? raw.toISOString() : String(raw);
      if (raw instanceof Date) {
        const date = new Date(raw.getTime()), pad = (item, size = 2) => String(item).padStart(size, '0');
        if (field.dataset.type === 'date' || field.type === 'date') date.setHours(0, 0, 0, 0);
        const local = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        if (field.dataset.ui === 'datetimepicker') value = field.dataset.behavior === 'UserLocal'
          ? date.toISOString().replace(/\.(\d{3})Z$/, '.$10000Z')
          : local + '.' + pad(date.getMilliseconds(), 3) + '0000';
        else if (field.type === 'date') value = local.slice(0, 10);
        else if (field.type === 'datetime-local') value = local;
      }
      write(field, value);
      if (binding.control === 'multiselect') {
        const values = new Set((raw == null ? [] : Array.isArray(raw) ? raw : [raw]).map(String));
        const selection = byId(binding.id + '_0');
        if (selection) { for (const option of selection.options) option.selected = values.has(option.value); events.add(selection); }
        const list = byId(binding.id + '_i');
        if (list) {
          for (const checkbox of list.querySelectorAll('.msos-selection input[type="checkbox"]')) checkbox.checked = values.has(checkbox.value);
          const chosen = Array.from(list.querySelectorAll('.msos-selection .msos-option'), (item) => { const box = item.querySelector('input[type="checkbox"]'); item.classList.toggle('msos-option-selected', box.checked); if (box.checked) item.setAttribute('aria-selected', 'true'); else item.removeAttribute('aria-selected'); return box.checked ? { value: box.value, label: box.getAttribute('aria-label') ?? box.value, index: item.parentElement ? Array.prototype.indexOf.call(item.parentElement.children, item) + 1 : 0 } : null; }).filter(Boolean);
          const selected = list.querySelector('.msos-selecteditems');
          if (selected) {
            selected.replaceChildren(...chosen.map(option => { const item = document.createElement('li'); item.className = 'msos-selected-display-item msos-visible'; item.setAttribute('name', binding.id + '-selected-item-' + option.index); item.id = binding.id + '-selected-item-' + option.index; item.tabIndex = -1; item.title = ''; item.dataset.value = option.value; const text = document.createElement('span'); text.className = 'msos-selected-display-item-text'; text.textContent = option.label; item.append(text); return item; }));
          }
          const text = chosen.map(option => option.label).join(', ');
          const view = list.querySelector('.msos-viewmode-text');
          if (view) { view.textContent = text || '---'; view.title = text || '---'; }
          list.classList.toggle('msos-none-selected', !list.classList.contains('msos-disabled') && values.size === 0);
        }
      }
      if (binding.control === 'datetime') {
        const display = byId(binding.id + '_datepicker_description');
        if (display?.type === 'date' || display?.type === 'datetime-local') write(display, value.slice(0, display.type === 'date' ? 10 : 16), true);
        // The captured/local DateTimePicker listens to the underlying change event below.
      }
    } else throw new Error('PCF native binding has an unsupported input structure: ' + binding.id);
    for (const node of events) { node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }
    if (events.size && typeof window.setIsDirty === 'function') window.setIsDirty(true);
  }
  function token() {
    return new Promise((resolve, reject) => {
      if (!window.shell?.getTokenDeferred) return reject(new Error('PCF Web API requires the local portal CSRF token provider'));
      window.shell.getTokenDeferred().done(resolve).fail(reject);
    });
  }
  function options(value) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || /[\r\n#]/.test(value)) throw new Error('PCF Web API options must be an OData or FetchXML query');
    if (!value.startsWith('?') && /^[a-z][a-z\d+.-]*:|^\//i.test(value)) throw new Error('PCF Web API queries cannot target a different URL');
    return value.startsWith('?') ? value : '?' + value;
  }
  function recordId(value) {
    const id = String(value ?? '').replace(/^\{|\}$/g, '');
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('PCF Web API requires a record GUID');
    return id;
  }
  // Dataset bindings come from selected solution views/table metadata, never from table-name guessing.
  function datasetAdapter(binding, api, updated) {
    let page = 1, pageSize = 25, filter = null, selected = [], generation = 0;
    const dataset = {
      columns: binding.columns.map(column => ({ ...column })), records: {}, sortedRecordIds: [], sorting: [], loading: true, error: false, errorCode: 0, errorMessage: '',
      getTargetEntityType: () => binding.entity, getViewId: () => binding.viewId, getTitle: () => binding.viewName,
      getSelectedRecordIds: () => [...selected],
      setSelectedRecordIds(ids) { selected = ids.map(recordId); updated(binding.name); },
      clearSelectedRecordIds() { selected = []; updated(binding.name); },
      filtering: {
        getFilter: () => filter == null ? null : JSON.parse(JSON.stringify(filter)),
        setFilter(value) {
          const serialized = JSON.stringify(value);
          if (serialized.length > 65536) throw new Error('PCF dataset filter exceeds 64 KiB');
          filter = JSON.parse(serialized); page = 1;
        },
        clearFilter() { filter = null; page = 1; },
      },
      paging: {
        hasNextPage: false, hasPreviousPage: false, totalResultCount: -1,
        setPageSize(value) { if (!Number.isInteger(value) || value < 1 || value > 5000) throw new Error('PCF dataset page size must be between 1 and 5000'); pageSize = value; page = 1; },
        loadNextPage() { if (dataset.paging.hasNextPage) { page++; return load(); } },
        loadPreviousPage() { if (page > 1) { page--; return load(); } },
        loadExactPage(value) { if (!Number.isInteger(value) || value < 1 || value > 100000) throw new Error('PCF dataset page number is invalid'); page = value; return load(); },
        reset() { page = 1; return load(); },
      },
      refresh() { page = 1; return load(); },
      addColumn(name) {
        const field = binding.fields[name];
        if (!field) throw new Error('PCF dataset column has no exported definition: ' + name);
        if (!dataset.columns.some(column => column.name === name)) dataset.columns.push({ name, displayName: field.label ?? name, dataType: field.dataType ?? 'unknown', targets: field.targets, order: dataset.columns.length, visualSizeFactor: 100 });
      },
      openDatasetItem() { throw new Error('PCF dataset record navigation requires a portal page/form binding; the view alone does not supply it'); },
    };
    function query() {
      const xml = new DOMParser().parseFromString(binding.fetchXml, 'text/xml');
      const fetch = xml.documentElement, entity = Array.from(fetch.children).find(node => node.tagName === 'entity');
      if (xml.querySelector('parsererror') || fetch.tagName !== 'fetch' || entity?.getAttribute('name') !== binding.entity) throw new Error('PCF dataset exported FetchXML does not match its table binding');
      if (fetch.getAttribute('aggregate') === 'true' || fetch.hasAttribute('top')) throw new Error('PCF dataset record host does not support aggregate or top-limited views');
      fetch.removeAttribute('paging-cookie'); fetch.setAttribute('count', String(pageSize)); fetch.setAttribute('page', String(page)); fetch.setAttribute('returntotalrecordcount', 'true');
      for (const column of dataset.columns) if (/^[a-z_][a-z\d_]*$/i.test(column.name) && !Array.from(entity.children).some(node => node.tagName === 'attribute' && node.getAttribute('name') === column.name)) {
        const node = xml.createElement('attribute'); node.setAttribute('name', column.name); entity.append(node);
      }
      if (dataset.sorting.length) {
        for (const node of Array.from(entity.children).filter(node => node.tagName === 'order')) node.remove();
        for (const sort of dataset.sorting) {
          if (!dataset.columns.some(column => column.name === sort.name) || ![0, 1].includes(sort.sortDirection)) throw new Error('PCF dataset sorting requires an exported column and ascending/descending direction');
          const node = xml.createElement('order'); node.setAttribute('attribute', sort.name); node.setAttribute('descending', String(sort.sortDirection === 1)); entity.append(node);
        }
      }
      let conditions = 0;
      function filterNode(expression, depth) {
        if (depth > 16 || !expression || ![0, 1].includes(expression.filterOperator)) throw new Error('PCF dataset filter has an unsupported structure');
        const node = xml.createElement('filter'); node.setAttribute('type', expression.filterOperator === 1 ? 'or' : 'and');
        for (const condition of expression.conditions ?? []) {
          if (++conditions > 500) throw new Error('PCF dataset filter exceeds 500 conditions');
          const operators = { 0: 'eq', 1: 'ne', 2: 'gt', 3: 'lt', 4: 'ge', 5: 'le', 6: 'like', 8: 'in', 12: 'null', 13: 'not-null', 25: 'on', 26: 'on-or-before', 27: 'on-or-after' };
          const operator = operators[condition.conditionOperator];
          if (!operator || !dataset.columns.some(column => column.name === condition.attributeName) || condition.entityAliasName) throw new Error('PCF dataset filter operator/column/alias is unsupported');
          const child = xml.createElement('condition'); child.setAttribute('attribute', condition.attributeName); child.setAttribute('operator', operator);
          if (operator === 'in') {
            if (!Array.isArray(condition.value)) throw new Error('PCF dataset In filters require an array');
            for (const value of condition.value) { const item = xml.createElement('value'); item.textContent = String(value); child.append(item); }
          } else if (!['null', 'not-null'].includes(operator)) child.setAttribute('value', String(condition.value ?? ''));
          node.append(child);
        }
        for (const child of expression.filters ?? []) node.append(filterNode(child, depth + 1));
        return node;
      }
      if (filter != null) entity.append(filterNode(filter, 0));
      return '?fetchXml=' + encodeURIComponent(new XMLSerializer().serializeToString(xml));
    }
    async function load() {
      const revision = ++generation;
      dataset.loading = true; dataset.error = false; dataset.errorMessage = ''; updated(binding.name);
      try {
        const { result } = await api(binding.entity, query(), 'GET');
        if (revision !== generation) return;
        const records = {}, ids = [];
        for (const row of result.value ?? []) {
          const id = row[binding.idColumn];
          if (!id) throw new Error('PCF dataset response omitted its primary record ID');
          ids.push(String(id));
          const value = name => row[name] ?? row['_' + name + '_value'] ?? null;
          const rawValue = name => {
            const raw = value(name), field = binding.fields[name];
            if (raw == null || !field?.dataType) return raw;
            if (/^Lookup\./.test(field.dataType)) {
              const target = row['_' + name + '_value@Microsoft.Dynamics.CRM.lookuplogicalname'] ?? (field.targets?.length === 1 ? field.targets[0] : null);
              if (!target) throw new Error('PCF dataset lookup has no exported or response-provided target type: ' + name);
              return { id: { guid: String(raw) }, etn: target, name: String(row['_' + name + '_value@OData.Community.Display.V1.FormattedValue'] ?? raw) };
            }
            return typed(raw, field.dataType);
          };
          records[id] = {
            getRecordId: () => String(id),
            getNamedReference: () => ({ id: { guid: String(id) }, etn: binding.entity, name: String(row[binding.nameColumn] ?? id) }),
            getValue: name => rawValue(name),
            getFormattedValue: name => String(row[name + '@OData.Community.Display.V1.FormattedValue'] ?? row['_' + name + '_value@OData.Community.Display.V1.FormattedValue'] ?? value(name) ?? ''),
            isDirty: () => false,
            setValue() { throw new Error('PCF dataset records are read-only in this adapter; use context.webAPI.updateRecord for explicit local CRUD'); },
            save() { return Promise.reject(new Error('PCF dataset record save is unsupported; use context.webAPI.updateRecord for explicit local CRUD')); },
          };
        }
        dataset.records = records; dataset.sortedRecordIds = ids;
        const total = result['@odata.count'] ?? result['@Microsoft.Dynamics.CRM.totalrecordcount'] ?? -1;
        dataset.paging.totalResultCount = total; dataset.paging.hasPreviousPage = page > 1;
        dataset.paging.hasNextPage = total >= 0 && !result['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'] ? page * pageSize < total : ids.length === pageSize;
        dataset.errorCode = 0;
      } catch (error) {
        if (revision !== generation) return;
        dataset.records = {}; dataset.sortedRecordIds = []; dataset.error = true; dataset.errorMessage = error.message; dataset.errorCode = error.errorCode ?? 'LocalDatasetError'; dataset.paging.hasNextPage = false;
      } finally { if (revision === generation) { dataset.loading = false; updated(binding.name); } }
    }
    return { dataset, load };
  }
  async function mount(spec, target) {
    const container = target || document.getElementById(spec.id);
    if (!container || instances.has(container)) return;
    const ordinal = (counts.get(spec.id) || 0) + 1;
    counts.set(spec.id, ordinal);
    container.id = spec.id + '-' + ordinal;
    const debug = { id: container.id, constructor: spec.constructor, state: 'loading', lifecycle: [] };
    const trace = stage => { debug.lifecycle.push({ stage, at: Date.now() }); if (debug.lifecycle.length > 100) debug.lifecycle.shift(); };
    let control, observer, disposed = false, tracked = false, detachNative = () => {}, nativeWriting = false, updatingFromNative = false, nativeQueued = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true; observer?.disconnect(); detachNative(); instances.delete(container);
      try { if (control) { trace('destroy'); control.destroy?.(); } } catch (error) { container.dataset.pcfCleanupError = errorText(error); debug.error ??= errorText(error); }
      debug.state = debug.error ? 'failed' : 'destroyed'; history.push(debugSnapshot(debug)); if (history.length > 100) history.shift();
    };
    const failure = error => {
      debug.error = errorText(error);
      cleanup(); container.setAttribute('aria-busy', 'false'); container.setAttribute('role', 'alert'); container.textContent = debug.error; container.dataset.pcfError = 'true'; delete container.dataset.pcfReady;
      const fallback = container.closest('[data-pcf-native-field]')?.querySelector('[data-pcf-native-input]');
      if (fallback) fallback.hidden = false;
    };
    // Reserve before resource loading so duplicate calls cannot create two instances.
    instances.set(container, { cleanup, debug });
    try {
      for (const item of spec.resources.filter(item => item.kind === 'code' || item.kind === 'css')) await resource(item);
      if (disposed || !container.isConnected) { cleanup(); return; }
      let Constructor = constructors.get(spec.constructor) || spec.constructor.split('.').reduce((value, key) => value?.[key], window);
      if (!Constructor) {
        const exportName = spec.constructor.split('.').at(-1);
        const candidates = [...new Set(spec.resources.filter(item => item.kind === 'code' && item.exportGlobal)
          .map(item => Object.getOwnPropertyDescriptor(window, item.exportGlobal)?.value?.[exportName]).filter(item => typeof item === 'function'))];
        if (candidates.length > 1) throw new Error('The declared PCF resources expose ambiguous constructor exports: ' + spec.constructor);
        Constructor = candidates[0];
      }
      if (typeof Constructor !== 'function') throw new Error('The PCF bundle did not register ' + spec.constructor);
      const parameters = {}, writable = new Set();
      debug.parameters = parameters;
      debug.editableParameters = spec.properties.filter(property => property.usage !== 'output').map(property => property.name);
      for (const property of spec.properties) {
        const type = property['of-type'] || groupType(property.types, spec.nativeBinding?.propertyTypes?.[property.name]);
        if (!type) throw new Error('PCF property ' + property.name + ' has an ambiguous type-group binding');
        const raw = typed(spec.args[property.name] ?? spec.args[property.name.toLowerCase()] ?? property['default-value'] ?? null, type);
        const attributes = spec.nativeBinding?.properties?.includes(property.name) && spec.nativeBinding.attributes
          ? spec.nativeBinding.attributes
          : { DisplayName: spec.strings[property['display-name-key']] ?? property['display-name-key'] ?? property.name, LogicalName: property.name, RequiredLevel: property.required === 'true' ? 1 : 0, Options: [] };
        parameters[property.name] = { raw, formatted: raw == null ? '' : String(raw), type, attributes: { ...attributes }, error: false, errorMessage: '' };
        if (property.usage === 'bound' || property.usage === 'output') writable.add(property.name);
      }
      const entitySet = name => {
        const mapping = spec.mappings[String(name).toLowerCase()];
        if (!mapping || !/^[a-z_][a-z\d_]*$/i.test(mapping.entitySet)) throw new Error('PCF Web API table has no imported mapping: ' + name);
        return mapping.entitySet;
      };
      async function api(name, suffix, method, body, maxPageSize) {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json', __RequestVerificationToken: await token() };
        if (maxPageSize !== undefined) {
          if (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 5000) throw new Error('PCF Web API maxPageSize must be between 1 and 5000');
          headers.Prefer = 'odata.maxpagesize=' + maxPageSize;
        }
        const response = await fetch('/_api/' + entitySet(name) + suffix, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text(); let result;
        try { result = text ? JSON.parse(text) : {}; } catch { throw new Error('PCF Web API returned a non-JSON response'); }
        if (!response.ok) { const error = new Error(result.error?.message || 'PCF Web API HTTP ' + response.status); error.errorCode = result.error?.code; throw error; }
        return { result, id: response.headers.get('entityid') || /\(([0-9a-f-]+)\)/i.exec(response.headers.get('OData-EntityId') || '')?.[1] };
      }
      const stateKey = 'paqvilo-pcf:' + container.id;
      const locale = spec.language?.code || document.documentElement.lang || undefined;
      const numberFormat = (value, precision) => new Intl.NumberFormat(locale, precision == null ? {} : { minimumFractionDigits: precision, maximumFractionDigits: precision }).format(value);
      const context = {
        parameters, updatedProperties: [],
        mode: {
          allocatedWidth: container.clientWidth, allocatedHeight: container.clientHeight,
          isControlDisabled: spec.args.disabled === true || spec.args.disabled === 'true', isVisible: true,
          trackContainerResize(value) { tracked = value === true; },
          setControlState(state) { sessionStorage.setItem(stateKey, JSON.stringify(state)); },
        },
        userSettings: { userId: spec.identity.id, languageId: spec.language?.lcid ?? (Number(document.documentElement.getAttribute('crm-lcid')) || null), isRTL: spec.language?.isRTL ?? document.documentElement.dir === 'rtl', roles: spec.identity.roles },
        resources: {
          getString: key => spec.strings[key] ?? key,
          getResource: (name, success, failure) => {
            const item = spec.resources.find(item => item.path ? item.path === name : decodeURIComponent(item.url).endsWith('/' + name));
            if (!item) return failure?.();
            fetch(item.url).then(response => { if (!response.ok) throw new Error('PCF resource HTTP ' + response.status); return response.arrayBuffer(); })
              .then(bytes => { let binary = ''; const values = new Uint8Array(bytes); for (let index = 0; index < values.length; index += 8192) binary += String.fromCharCode(...values.subarray(index, index + 8192)); success(btoa(binary)); }).catch(failure);
          },
        },
        formatting: { formatCurrency: (value, precision) => numberFormat(value, precision), formatDecimal: (value, precision) => numberFormat(value, precision), formatInteger: value => numberFormat(value, 0), formatDateShort: value => value instanceof Date ? value.toLocaleDateString(locale) : String(value) },
        webAPI: {
          retrieveMultipleRecords: async (name, query = '', maxPageSize) => { const { result } = await api(name, options(query), 'GET', undefined, maxPageSize); return { entities: result.value ?? [], nextLink: result['@odata.nextLink'] }; },
          retrieveRecord: async (name, id, query = '') => (await api(name, '(' + recordId(id) + ')' + options(query), 'GET')).result,
          createRecord: async (name, data) => ({ id: (await api(name, '', 'POST', data)).id, entityType: name }),
          updateRecord: async (name, id, data) => { await api(name, '(' + recordId(id) + ')', 'PATCH', data); return { id, entityType: name }; },
          deleteRecord: async (name, id) => { await api(name, '(' + recordId(id) + ')', 'DELETE'); return { id, entityType: name }; },
        },
        navigation: { openAlertDialog: async options => { window.alert(options.text); }, openConfirmDialog: async options => ({ confirmed: window.confirm(options.text) }) },
      };
      const datasetHosts = (spec.datasets ?? []).map(binding => {
        const host = datasetAdapter(binding, api, name => { if (control && !disposed) { context.updatedProperties = [name]; try { trace('updateView:dataset'); control.updateView(context); } catch (error) { failure(error); } } });
        parameters[binding.name] = host.dataset; return host;
      });
      control = new Constructor();
      const changed = () => {
        if (disposed || updatingFromNative) return;
        let outputs, prepared;
        try {
          trace('getOutputs'); outputs = Object.fromEntries(Object.entries(control.getOutputs?.() || {}).filter(([name]) => writable.has(name)));
          debug.outputs = outputs;
          // Prepare every comparison/format before mutating parameter values. A
          // cyclic value or getter can fail after getOutputs itself succeeded.
          prepared = Object.entries(outputs).map(([name, raw]) => ({ name, raw, changed: JSON.stringify(parameters[name].raw) !== JSON.stringify(raw), formatted: raw == null ? '' : String(raw) }));
        } catch (error) { failure(error); return; }
        const updates = prepared.filter(item => item.changed).map(item => item.name);
        for (const { name, raw, formatted } of prepared) { parameters[name].raw = raw; parameters[name].formatted = formatted; }
        try { nativeWriting = true; nativeOutput(spec, container, outputs); }
        catch (error) { failure(error); return; }
        finally { nativeWriting = false; }
        container.dispatchEvent(new CustomEvent('paqvilo:pcf-output', { bubbles: true, detail: outputs }));
        if (updates.length) queueMicrotask(() => { if (!disposed) { context.updatedProperties = updates; try { trace('updateView:output'); control.updateView(context); } catch (error) { failure(error); } } });
      };
      let state = {}; try { state = JSON.parse(sessionStorage.getItem(stateKey) || '{}'); } catch {}
      trace('init'); control.init(context, changed, state, container); if (disposed) return; trace('updateView'); control.updateView(context);
      debug.updateParameters = values => {
        if (disposed) throw new Error('PCF instance is disposed');
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('PCF parameter updates require an object');
        const updates = Object.entries(values).map(([name, value]) => {
          const property = spec.properties.find(item => item.name === name);
          if (!property || property.usage === 'output') throw new Error('PCF parameter is not editable: ' + name);
          return [name, typed(value, parameters[name].type)];
        });
        const nativeUpdates = updates.filter(([name]) => spec.nativeBinding?.properties?.includes(name));
        if (nativeUpdates.some(([, value]) => JSON.stringify(value) !== JSON.stringify(nativeUpdates[0][1]))) throw new Error('PCF returned conflicting outputs for one native field');
        debug.lastParameterUpdate = { names: updates.map(([name]) => name), phase: 'validated', parameterValuesApplied: false, nativeValuesMayHaveChanged: false };
        for (const [name, raw] of updates) { parameters[name].raw = raw; parameters[name].formatted = raw == null ? '' : String(raw); parameters[name].error = false; parameters[name].errorMessage = ''; }
        debug.lastParameterUpdate.parameterValuesApplied = true;
        try {
          debug.lastParameterUpdate.phase = 'native-output'; debug.lastParameterUpdate.nativeValuesMayHaveChanged = nativeUpdates.length > 0;
          nativeWriting = true; nativeOutput(spec, container, Object.fromEntries(updates.filter(([name]) => writable.has(name))));
          context.updatedProperties = updates.map(([name]) => name); debug.lastParameterUpdate.phase = 'updateView'; trace('debug:updateView'); control.updateView(context); debug.lastParameterUpdate.phase = 'completed';
        } catch (error) { failure(error); throw error; }
        finally { nativeWriting = false; }
        return debugSnapshot(debug);
      };
      debug.state = 'ready';
      if (disposed) return;
      if (spec.nativeBinding) {
        const scope = nativeScope(container), binding = spec.nativeBinding;
        const synchronize = () => {
          nativeQueued = false;
          if (disposed) return;
          const updates = [];
          for (const name of binding.properties ?? []) {
            const property = parameters[name];
            if (!property || !writable.has(name)) continue;
            try {
              const raw = typed(nativeValue(spec, container), property.type);
              if (JSON.stringify(raw) !== JSON.stringify(property.raw) || property.error) updates.push(name);
              property.raw = raw; property.formatted = raw == null ? '' : String(raw); property.error = false; property.errorMessage = '';
            } catch (error) { if (!property.error || property.errorMessage !== error.message) updates.push(name); property.error = true; property.errorMessage = error.message; }
          }
          if (updates.length) {
            try { updatingFromNative = true; context.updatedProperties = updates; trace('updateView:native'); control.updateView(context); }
            catch (error) { failure(error); }
            finally { updatingFromNative = false; }
          }
        };
        const listener = event => {
          if (nativeWriting || disposed || nativeQueued || container.contains(event.target)) return;
          const field = scope.querySelector('#' + CSS.escape(binding.id));
          const ids = [binding.id, binding.id + '_name', binding.id + '_entityname', binding.id + '_0'];
          if (!ids.includes(event.target.id) && !field?.contains(event.target)) return;
          nativeQueued = true; queueMicrotask(synchronize);
        };
        scope.addEventListener('input', listener); scope.addEventListener('change', listener);
        detachNative = () => { scope.removeEventListener('input', listener); scope.removeEventListener('change', listener); };
        synchronize();
      }
      await Promise.all(datasetHosts.map(host => host.load()));
      if (disposed) return;
      container.setAttribute('aria-busy', 'false'); container.dataset.pcfReady = 'true';
      const fallback = container.closest('[data-pcf-native-field]')?.querySelector('[data-pcf-native-input]');
      if (fallback) fallback.hidden = true;
      observer = new ResizeObserver(() => {
        if (!tracked || disposed) return;
        const width = container.clientWidth, height = container.clientHeight;
        if (width === context.mode.allocatedWidth && height === context.mode.allocatedHeight) return;
        context.mode.allocatedWidth = width; context.mode.allocatedHeight = height; context.updatedProperties = ['layout']; try { trace('updateView:layout'); control.updateView(context); } catch (error) { failure(error); }
      });
      observer.observe(container);
    } catch (error) {
      failure(error);
    }
  }
  const removed = new MutationObserver(() => { for (const [container, instance] of instances) if (!container.isConnected) instance.cleanup(); });
  removed.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => { for (const instance of instances.values()) instance.cleanup(); }, { once: true });
  window.__paqviloPcf = {
    mount,
    inspect(id) {
      const current = [...instances.values()].map(instance => debugSnapshot(instance.debug));
      return [...current, ...history].filter(entry => id === undefined || entry.id === id);
    },
    updateParameters(id, values) {
      const instance = [...instances.values()].find(item => item.debug.id === id);
      if (!instance?.debug.updateParameters) throw new Error('PCF ready instance not found: ' + id);
      return instance.debug.updateParameters(values);
    },
    openDebugger() {
      const existing = document.querySelector('[data-paqvilo-pcf-debugger]');
      if (existing) { if (!existing.open) existing.showModal(); return existing; }
      const dialog = document.createElement('dialog'); dialog.setAttribute('data-paqvilo-pcf-debugger', ''); dialog.setAttribute('aria-label', 'Code component debugger');
      dialog.style.cssText = 'max-width:760px;width:90%;max-height:85vh;padding:20px;border:1px solid #777;border-radius:8px;overflow:auto';
      const title = document.createElement('h2'); title.textContent = 'Code component debugger';
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Code component instance');
      const editor = document.createElement('textarea'); editor.setAttribute('aria-label', 'Parameter values (JSON)'); editor.rows = 8; editor.style.cssText = 'display:block;width:100%;margin:12px 0;font-family:monospace';
      const status = document.createElement('p'); status.setAttribute('role', 'status');
      const details = document.createElement('pre'); details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
      const button = text => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; return node; };
      const apply = button('Apply parameters'), refresh = button('Refresh state'), close = button('Close');
      const render = () => {
        const entry = window.__paqviloPcf.inspect(select.value)[0];
        apply.disabled = entry?.state !== 'ready'; details.textContent = JSON.stringify(entry ?? {}, null, 2);
        const instance = [...instances.values()].find(item => item.debug.id === select.value);
        const editable = Object.entries(instance?.debug.parameters ?? {}).filter(([name, parameter]) => instance.debug.editableParameters.includes(name) && Object.hasOwn(parameter, 'raw'));
        editor.value = JSON.stringify(Object.fromEntries(editable.map(([name, parameter]) => [name, debugValue(parameter.raw)])), null, 2);
      };
      const inventory = () => { const id = select.value; select.replaceChildren(); for (const entry of window.__paqviloPcf.inspect()) { const option = document.createElement('option'); option.value = entry.id; option.textContent = `${entry.id} · ${entry.state}`; select.append(option); } if ([...select.options].some(option => option.value === id)) select.value = id; render(); };
      select.addEventListener('change', render); refresh.addEventListener('click', inventory);
      apply.addEventListener('click', () => {
        try { window.__paqviloPcf.updateParameters(select.value, JSON.parse(editor.value)); status.textContent = 'Parameters applied.'; render(); }
        catch (error) { status.textContent = errorText(error); details.textContent = JSON.stringify(window.__paqviloPcf.inspect(select.value)[0] ?? {}, null, 2); }
      });
      close.addEventListener('click', () => dialog.close()); dialog.append(title, select, editor, apply, refresh, close, status, details); document.body.append(dialog); inventory(); dialog.showModal(); return dialog;
    },
  };
})();
