// A bounded client API for explicitly trusted, locally exported Solution scripts.
// Scripts execute through ordinary same-origin script elements; no expressions are evaluated.
const loadedLibraries = new Map();
const normalizeLibrary = value => String(value ?? '').replace(/^\$webresource:/i, '');
const blockedNames = new Set(['__proto__', 'prototype', 'constructor']);
const unsupported = name => { throw new Error(`Mirage client API does not support ${name}.`); };
const bounded = (value, path) => new Proxy(value, { get(target, key) {
  if (typeof key === 'symbol' || key === 'then') return Reflect.get(target, key);
  if (!Object.hasOwn(target, key)) return unsupported(`${path}.${key}`);
  return target[key];
} });
const collection = items => bounded({ get: key => key === undefined ? items : typeof key === 'number' ? items[key] : typeof key === 'function' ? items.filter(key) : items.find(item => item.getName() === key),
  getLength: () => items.length, forEach: callback => items.forEach(callback) }, 'collection');

export function resolveClientFunction(scope, name) {
  const parts = String(name ?? '').split('.');
  if (!parts.length || parts.some(part => !/^[A-Za-z_$][\w$]*$/.test(part) || blockedNames.has(part))) throw new Error('The exported client function name is invalid.');
  let owner = scope, fn;
  for (const [index, part] of parts.entries()) { if (owner == null || !Object.hasOwn(owner, part)) throw new Error(`Exported client function ${name} is unavailable.`); fn = owner[part]; if (index < parts.length - 1) owner = fn; }
  if (typeof fn !== 'function') throw new Error(`Exported client function ${name} is unavailable.`);
  return { fn, owner };
}

export function parseHandlerParameters(text = '') {
  if (!text.trim()) return [];
  // Exported parameters are constants, not JavaScript source. JSON primitives and
  // the common single-quoted string notation cover the supported native subset.
  const tokens = String(text).match(/'(?:[^'\\]|\\['\\])*'|"(?:[^"\\]|\\.)*"|[^,]+/g) ?? [];
  if (tokens.join(',').replace(/\s/g, '') !== String(text).replace(/\s/g, '')) throw new Error('Unsupported exported event parameters. Use primitive constants.');
  return tokens.map(token => {
    const value = token.trim();
    if (/^'(?:[^'\\]|\\['\\])*'$/.test(value)) return value.slice(1, -1).replace(/\\(['\\])/g, '$1');
    let parsed; try { parsed = JSON.parse(value); } catch { throw new Error('Unsupported exported event parameters. Use primitive constants.'); }
    if (parsed !== null && !['string', 'number', 'boolean'].includes(typeof parsed)) throw new Error('Unsupported exported event parameters. Use primitive constants.');
    return parsed;
  });
}

export function loadClientLibrary(name, extensions, { document = globalThis.document, location = globalThis.location } = {}) {
  if (extensions?.trusted !== true) return Promise.reject(new Error('Solution client extensions are disabled. Explicitly trust this project in Mirage configuration to run them.'));
  const resource = extensions.resources?.find(resource => normalizeLibrary(resource.name) === normalizeLibrary(name) && resource.type === 'script');
  if (!resource) return Promise.reject(new Error(`Exported script ${name} is not available in the imported Solution resources.`));
  const url = new URL(resource.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/_apps/') || url.search || url.hash) return Promise.reject(new Error('Client script URLs must be local imported Solution resources.'));
  if (!loadedLibraries.has(url.href)) loadedLibraries.set(url.href, new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = url.href; script.async = false;
    const timeout = setTimeout(() => { script.remove(); loadedLibraries.delete(url.href); reject(new Error(`Timed out loading exported script ${name}.`)); }, 15000);
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); loadedLibraries.delete(url.href); script.remove(); reject(new Error(`Could not load exported script ${name}.`)); };
    document.head.append(script);
  }));
  return loadedLibraries.get(url.href);
}

function writeData(data, table, tables) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Xrm.WebApi requires a record values object.');
  const values = {};
  for (const [key, value] of Object.entries(data)) {
    if (blockedNames.has(key)) throw new Error('Xrm.WebApi column name is invalid.');
    if (key.endsWith('@odata.bind')) {
      const navigation = key.slice(0, -11), relationship = table?.relationships?.[navigation];
      const name = relationship?.many === false ? relationship.from : navigation;
      const field = table?.fields?.[name];
      if (field?.type !== 'lookup' || relationship?.many === true) unsupported(`Xrm.WebApi lookup binding ${navigation}; import its single-valued relationship metadata`);
      if (!relationship && Object.values(table?.relationships ?? {}).some(candidate => candidate.many === false && candidate.from === name)) unsupported(`Xrm.WebApi lookup binding ${navigation}; use its exported navigation-property name`);
      const match = value === null ? null : typeof value === 'string' && /^\/([A-Za-z][\w]*)\(([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\)$/i.exec(value);
      if (value !== null && !match) throw new Error('Xrm.WebApi lookup binding requires a local entity-set record path.');
      const targets = (field.targets ?? []).filter(entity => tables[entity]?.entitySet === match?.[1] && (!relationship?.entity || relationship.entity === entity));
      if (value !== null && targets.length !== 1) throw new Error(`Xrm.WebApi lookup binding ${navigation} does not resolve an imported target.`);
      if (Object.hasOwn(values, name) || Object.hasOwn(data, name)) throw new Error(`Xrm.WebApi provides conflicting values for ${name}.`);
      values[name] = value === null ? null : { id: match[2].toLowerCase(), entity: targets[0] };
    } else if (table?.fields?.[key]?.type === 'multiselect' && typeof value === 'string') {
      if (!/^\s*[+-]?\d+(?:\s*,\s*[+-]?\d+)*\s*$/.test(value)) throw new Error(`Xrm.WebApi ${key} requires comma-separated choice values.`);
      values[key] = value.split(',').map(Number);
    } else values[key] = value;
  }
  return values;
}

export function createFormClientRuntime(host) {
  let live = true, depth = 0, saving = false;
  const activeEvents = new Map();
  const assertLive = () => { if (!live) throw new Error('This form context has been disposed.'); };
  const client = (value, path) => bounded(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'function' ? (...args) => { assertLive(); return entry(...args); } : entry])), path);
  const events = new Map(), notifications = new Set(), initial = structuredClone(host.record);
  const add = (key, callback) => { if (typeof callback !== 'function') throw new Error('Client event handler must be a function.'); const handlers = events.get(key) ?? []; handlers.push(callback); events.set(key, handlers); };
  const remove = (key, callback) => events.set(key, (events.get(key) ?? []).filter(handler => handler !== callback));
  const saveForm = close => { assertLive(); if (activeEvents.size) throw new Error(`Saving from an active ${[...activeEvents.keys()].at(-1)} handler is not supported. Finish the event before saving.`); return host.save(close); };
  const fieldValue = name => { assertLive(); return host.read(name); };
  const clientValue = (name, value) => {
    if (value == null) return null;
    const field = host.table.fields[name];
    if (field.type === 'date') return new Date(value);
    if (field.type === 'multiselect') return Array.isArray(value) ? [...value] : String(value).split(',').filter(part => part.trim()).map(Number);
    if (field.type === 'lookup') return [{ id: `{${String(value.id ?? value).replace(/[{}]/g, '')}}`, name: value.name ?? '', entityType: value.entity ?? value.logicalName ?? field.targets?.[0] }];
    return value;
  };
  const attributes = Object.values(host.table.fields).map(field => {
    const name = field.name;
    return client({ getName: () => name, getValue: () => clientValue(name, fieldValue(name)), getInitialValue: () => clientValue(name, initial[name]),
      setValue: value => { assertLive(); const next = field.type === 'date' && value instanceof Date ? value.toISOString() : field.type === 'lookup' && Array.isArray(value) ? value.length ? { id: String(value[0].id).replace(/[{}]/g, ''), entity: value[0].entityType, name: value[0].name } : null : value; host.write(name, next); },
      getIsDirty: () => host.isDirty(name), getAttributeType: () => ({ text: 'string', textarea: 'memo', number: field.options?.length ? 'optionset' : ({ decimal: 'decimal', money: 'money', double: 'double', float: 'double' }[field.dataverseType] ?? 'integer'), date: 'datetime', multiselect: 'multiselectoptionset' }[field.type] ?? field.type),
      getOptions: () => (field.options ?? []).map(option => ({ text: option.label, value: option.value })),
      getOption: value => { const option = (field.options ?? []).find(option => typeof value === 'number' ? option.value === value : option.label === value); return option ? { text: option.label, value: option.value } : null; },
      getText: () => field.type === 'multiselect' ? clientValue(name, fieldValue(name))?.map(value => field.options?.find(option => option.value === value)?.label).filter(value => value !== undefined) ?? null : field.options?.find(option => option.value === fieldValue(name))?.label ?? null,
      getRequiredLevel: () => host.required?.(name) ? 'required' : 'none', setRequiredLevel: value => { if (!['none', 'required', 'recommended'].includes(value)) throw new Error('Invalid required level.'); host.required?.(name, value); },
      getSubmitMode: () => 'dirty', setSubmitMode: mode => { if (mode !== 'dirty') unsupported(`attribute.setSubmitMode(${mode})`); },
      addOnChange: callback => add(`onchange:${name}`, callback), removeOnChange: callback => remove(`onchange:${name}`, callback), fireOnChange: () => dispatch('onchange', name),
      controls: collection(host.controlNames(name).map(controlName => makeControl(controlName, name))),
    }, `attribute(${name})`);
  });
  function makeControl(name, fieldName = host.controlField(name)) {
    return client({ getName: () => name, getAttribute: () => attributes.find(attribute => attribute.getName() === fieldName),
      getDisabled: () => host.controlState(name, 'disabled'), setDisabled: value => host.controlState(name, 'disabled', Boolean(value)),
      getVisible: () => !host.controlState(name, 'hidden'), setVisible: value => host.controlState(name, 'hidden', !value),
      getLabel: () => host.controlState(name, 'label'), setLabel: value => host.controlState(name, 'label', String(value)),
      setFocus: () => host.controlState(name, 'focus', true), setNotification: (message, id = 'default') => host.controlState(name, `notification:${id}`, String(message)),
      clearNotification: (id = 'default') => host.controlState(name, `notification:${id}`, null),
    }, `control(${name})`);
  }
  const controls = host.controlNames().map(name => makeControl(name));
  const formContext = client({ getAttribute: name => name === undefined ? attributes : attributes.find(attribute => attribute.getName() === name) ?? null,
    getControl: name => name === undefined ? controls : controls.find(control => control.getName() === name) ?? null,
    data: client({ entity: client({ getId: () => host.record[host.table.idColumn] ? `{${host.record[host.table.idColumn]}}` : '', getEntityName: () => host.table.entity,
      getPrimaryAttributeValue: () => host.read(host.table.nameColumn), getIsDirty: () => host.isDirty(), attributes: collection(attributes),
      addOnSave: callback => add('onsave', callback), removeOnSave: callback => remove('onsave', callback),
      save: mode => saveForm(mode === 'saveandclose') }, 'formContext.data.entity'),
      getIsDirty: () => host.isDirty(), save: () => saveForm(false), refresh: save => save ? saveForm(false) : host.refresh(),
      addOnLoad: callback => add('onload', callback), removeOnLoad: callback => remove('onload', callback),
    }, 'formContext.data'),
    ui: client({ controls: collection(controls), getFormType: () => host.record[host.table.idColumn] ? 2 : 1,
      setFormNotification: (message, level, id = 'default') => { notifications.add(id); host.notification(String(message), level, id); return true; },
      clearFormNotification: (id = 'default') => { notifications.delete(id); host.notification(null, null, id); return true; }, close: () => host.close(),
    }, 'formContext.ui'),
  }, 'formContext');
  const call = async (handler, args) => {
    assertLive(); if (++depth > 10) { depth--; throw new Error('Client event recursion exceeded 10 calls.'); }
    try {
      let callback = handler;
      if (typeof handler !== 'function') { await loadClientLibrary(handler.library, host.extensions, host.environment); const resolved = resolveClientFunction(host.scope ?? globalThis, handler.functionName); callback = resolved.fn.bind(resolved.owner); }
      assertLive(); return await callback(...args);
    } finally { depth--; }
  };
  async function dispatch(name, attribute, saveMode = 1) {
    assertLive(); if (name === 'onsave' && saving) throw new Error('Recursive save from an OnSave handler is not supported.');
    if (name === 'onsave') saving = true;
    activeEvents.set(name, (activeEvents.get(name) ?? 0) + 1);
    let prevented = false;
    const eventArgs = client({ getSaveMode: () => saveMode, preventDefault: () => { if (name !== 'onsave') unsupported(`${name}.preventDefault`); prevented = true; }, isDefaultPrevented: () => prevented }, 'eventArgs');
    const context = client({ getFormContext: () => formContext, getEventSource: () => attribute ? formContext.getAttribute(attribute) : formContext.data.entity,
      getEventArgs: () => eventArgs, getDepth: () => Math.max(1, depth) }, 'executionContext');
    try {
      for (const event of host.extensions?.trusted === true ? host.form.clientEvents ?? [] : []) if (event.active !== false && event.name === name && (name !== 'onchange' || event.attribute === attribute)) for (const handler of event.handlers ?? []) {
        if (handler.enabled === false) continue;
        await call(handler, [...(handler.passExecutionContext ? [context] : []), ...parseHandlerParameters(handler.parameters)]);
      }
      for (const handler of [...(events.get(name === 'onchange' ? `onchange:${attribute}` : name) ?? [])]) await call(handler, [context]);
      return { prevented };
    } finally { const count = activeEvents.get(name) - 1; if (count) activeEvents.set(name, count); else activeEvents.delete(name); if (name === 'onsave') saving = false; }
  }
  // Recheck after each asynchronous boundary: a form or staff identity may have
  // changed while a read was in flight. In particular, never send a follow-up
  // PATCH/DELETE from a context revoked during its ETag preflight.
  const request = async (...args) => { assertLive(); const result = await host.request(...args); assertLive(); return result; };
  const onlineWebApi = client({
    retrieveRecord: async (entity, id, options = '') => { if (typeof options !== 'string' || options && !options.startsWith('?')) throw new Error('Xrm.WebApi query options must start with ?.'); return request(entity, id, { query: { scope: 'odata', options } }); },
    retrieveMultipleRecords: async (entity, options = '', maxPageSize) => {
      if (maxPageSize !== undefined && (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 5000)) throw new Error('Xrm.WebApi maxPageSize must be between 1 and 5000.');
      if (typeof options !== 'string') throw new Error('Xrm.WebApi query options must be text.');
      if (options && !options.startsWith('?')) {
        const location = host.environment?.location ?? globalThis.location, next = new URL(options, location.href);
        if (next.origin !== location.origin || next.pathname !== `/api/data/v9.2/${host.tables[entity]?.entitySet}` || next.hash) throw new Error('Xrm.WebApi continuation must target this local imported table.');
        options = next.search;
      }
      return request(entity, undefined, { query: { scope: 'odata', options, ...(maxPageSize === undefined ? {} : { pageSize: maxPageSize }) } });
    },
    createRecord: async (entity, data) => { const values = writeData(data, host.tables[entity], host.tables); const result = await request(entity, undefined, { method: 'POST', data: values }); return { id: result.row[host.tables[entity].idColumn], entityType: entity }; },
    updateRecord: async (entity, id, data) => { const values = writeData(data, host.tables[entity], host.tables); const current = await request(entity, id); await request(entity, id, { method: 'PATCH', data: values, etag: current.etag }); return { id, entityType: entity }; },
    deleteRecord: async (entity, id) => { const current = await request(entity, id); await request(entity, id, { method: 'DELETE', etag: current.etag }); return { id, entityType: entity }; },
  }, 'Xrm.WebApi');
  const webApi = client({ ...onlineWebApi, online: onlineWebApi }, 'Xrm.WebApi');
  const Xrm = client({ Page: formContext, WebApi: webApi,
    Navigation: client({ openAlertDialog: options => host.alert(options.text ?? '', options.title ?? 'Message'), openConfirmDialog: options => host.confirm(options.text ?? '', options.title ?? 'Confirm').then(confirmed => ({ confirmed })), openForm: options => host.openForm(options),
    }, 'Xrm.Navigation'),
    Utility: client({ getGlobalContext: () => client({ getClientUrl: () => (host.environment?.location ?? globalThis.location).origin,
      userSettings: client({ userId: host.user?.userId ?? host.user?.principalId ?? host.user?.id ?? '', userName: host.user?.userName ?? host.user?.name ?? '' }, 'globalContext.userSettings'), client: client({ getClient: () => 'Web', getClientState: () => 'Online' }, 'globalContext.client'),
    }, 'globalContext') }, 'Xrm.Utility'),
  }, 'Xrm');
  return { formContext, Xrm, dispatch,
    async prepare() { if (host.extensions?.trusted === true) for (const library of host.form.libraries ?? []) { assertLive(); await loadClientLibrary(library, host.extensions, host.environment); } },
    async command(command, selection = []) { assertLive(); if (!command.supported) throw new Error(command.reason ?? 'Unsupported exported ribbon command.'); for (const action of command.actions) {
      const args = action.parameters.map(parameter => parameter.kind === 'crm' ? parameter.value === 'PrimaryControl' ? formContext : parameter.value === 'SelectedControlSelectedItemIds' ? selection : host.table.entity : parameter.kind === 'number' ? Number(parameter.value) : parameter.kind === 'boolean' ? parameter.value === 'true' : parameter.value);
      await call(action, args);
    } },
    destroy() { live = false; events.clear(); for (const id of notifications) host.notification(null, null, id); },
  };
}

export function evaluateRibbonRules(rules = [], { mode, entity, selection = [], read = () => null, existing = false } = {}) {
  return rules.every(rule => rule.clauses.every(clause => {
    let value;
    if (clause.type === 'FormStateRule') value = clause.State === (existing ? 'Existing' : 'Create');
    else if (clause.type === 'EntityRule') value = clause.EntityName === entity && (!clause.AppliesTo || clause.AppliesTo === 'PrimaryEntity');
    else if (clause.type === 'ValueRule') value = String(read(clause.Field) ?? '') === String(clause.Value ?? '');
    else if (clause.type === 'SelectionCountRule') value = mode === 'grid' && selection.length >= Number(clause.Minimum ?? 0) && selection.length <= Number(clause.Maximum ?? Infinity);
    else return false;
    return clause.InvertResult === 'true' ? !value : value;
  }));
}
