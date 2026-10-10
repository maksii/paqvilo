(function () {
  'use strict';
  if (window.__paqviloPcf) return;
  const constructors = new Map(), loaded = new Map(), instances = new Map(), counts = new Map();
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
  function groupType(types) {
    if (!types?.length) return null;
    if (types.every(type => ['SingleLine.Text', 'Multiple', 'SingleLine.TextArea', 'SingleLine.Email', 'SingleLine.Phone', 'SingleLine.URL', 'SingleLine.Ticker'].includes(type))) return 'SingleLine.Text';
    if (types.every(type => ['Decimal', 'FP', 'Whole.None', 'Currency'].includes(type))) return types.length === 1 ? types[0] : 'Decimal';
    if (types.every(type => ['DateAndTime.DateAndTime', 'DateAndTime.DateOnly'].includes(type))) return types.length === 1 ? types[0] : 'DateAndTime.DateAndTime';
    return types[0];
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
      if (raw instanceof Date && (field.type === 'date' || field.dataset.type === 'date')) value = value.slice(0, 10);
      if (raw instanceof Date && field.type === 'datetime-local') value = value.slice(0, 19);
      write(field, value);
      if (binding.control === 'multiselect') {
        const values = new Set((raw == null ? [] : Array.isArray(raw) ? raw : [raw]).map(String));
        const selection = byId(binding.id + '_0');
        if (selection) { for (const option of selection.options) option.selected = values.has(option.value); events.add(selection); }
        const list = byId(binding.id + '_i');
        if (list) {
          for (const checkbox of list.querySelectorAll('.msos-selection input[type="checkbox"]')) checkbox.checked = values.has(checkbox.value);
          const selected = list.querySelector('.msos-selecteditems');
          if (selected && selection) {
            selected.replaceChildren(...Array.from(selection.selectedOptions, option => { const item = document.createElement('li'); item.className = 'msos-selected-display-item'; item.dataset.value = option.value; item.textContent = option.textContent; return item; }));
          }
          list.classList.toggle('msos-some-selected', values.size > 0); list.classList.toggle('msos-none-selected', values.size === 0);
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
    let control, observer, disposed = false, tracked = false, detachNative = () => {}, nativeWriting = false, updatingFromNative = false, nativeQueued = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true; observer?.disconnect(); detachNative(); instances.delete(container);
      try { control?.destroy?.(); } catch (error) { container.dataset.pcfCleanupError = error.message; }
    };
    const failure = error => {
      cleanup(); container.setAttribute('aria-busy', 'false'); container.setAttribute('role', 'alert'); container.textContent = error.message; container.dataset.pcfError = 'true'; delete container.dataset.pcfReady;
      const fallback = container.closest('[data-pcf-native-field]')?.querySelector('[data-pcf-native-input]');
      if (fallback) fallback.hidden = false;
    };
    // Reserve before resource loading so duplicate calls cannot create two instances.
    instances.set(container, { cleanup });
    try {
      for (const item of spec.resources.filter(item => item.kind === 'code' || item.kind === 'css')) await resource(item);
      if (disposed || !container.isConnected) { cleanup(); return; }
      const Constructor = constructors.get(spec.constructor) || spec.constructor.split('.').reduce((value, key) => value?.[key], window);
      if (typeof Constructor !== 'function') throw new Error('The PCF bundle did not register ' + spec.constructor);
      const parameters = {}, writable = new Set();
      for (const property of spec.properties) {
        const type = property['of-type'] || groupType(property.types);
        if (!type) throw new Error('PCF property ' + property.name + ' has an ambiguous type-group binding');
        const raw = typed(spec.args[property.name] ?? spec.args[property.name.toLowerCase()] ?? property['default-value'] ?? null, type);
        parameters[property.name] = { raw, formatted: raw == null ? '' : String(raw), type, attributes: { DisplayName: spec.strings[property['display-name-key']] || property['display-name-key'] || property.name, LogicalName: property.name, RequiredLevel: property.required === 'true' ? 1 : 0, Options: [] }, error: false, errorMessage: '' };
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
        const host = datasetAdapter(binding, api, name => { if (control && !disposed) { context.updatedProperties = [name]; try { control.updateView(context); } catch (error) { failure(error); } } });
        parameters[binding.name] = host.dataset; return host;
      });
      control = new Constructor();
      const changed = () => {
        if (disposed || updatingFromNative) return;
        const outputs = Object.fromEntries(Object.entries(control.getOutputs?.() || {}).filter(([name]) => writable.has(name)));
        const updates = [];
        for (const [name, raw] of Object.entries(outputs)) {
          if (JSON.stringify(parameters[name].raw) !== JSON.stringify(raw)) updates.push(name);
          parameters[name].raw = raw; parameters[name].formatted = raw == null ? '' : String(raw);
        }
        try { nativeWriting = true; nativeOutput(spec, container, outputs); }
        catch (error) { failure(error); return; }
        finally { nativeWriting = false; }
        container.dispatchEvent(new CustomEvent('paqvilo:pcf-output', { bubbles: true, detail: outputs }));
        if (updates.length) queueMicrotask(() => { if (!disposed) { context.updatedProperties = updates; try { control.updateView(context); } catch (error) { failure(error); } } });
      };
      let state = {}; try { state = JSON.parse(sessionStorage.getItem(stateKey) || '{}'); } catch {}
      control.init(context, changed, state, container); control.updateView(context);
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
            try { updatingFromNative = true; context.updatedProperties = updates; control.updateView(context); }
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
        context.mode.allocatedWidth = width; context.mode.allocatedHeight = height; context.updatedProperties = ['layout']; try { control.updateView(context); } catch (error) { failure(error); }
      });
      observer.observe(container);
    } catch (error) {
      failure(error);
    }
  }
  const removed = new MutationObserver(() => { for (const [container, instance] of instances) if (!container.isConnected) instance.cleanup(); });
  removed.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('pagehide', () => { for (const instance of instances.values()) instance.cleanup(); }, { once: true });
  window.__paqviloPcf = { mount };
})();
