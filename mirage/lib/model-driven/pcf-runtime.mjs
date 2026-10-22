// Trusted, exported standard field components. This adapter deliberately has no
// native credentials or remote service fallback; unsupported APIs fail visibly.
const loaded = new Map();
const constructors = new Map();
let registrationInstalled = false;
const safeName = value => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value ?? '') && !String(value).split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
const unsupported = name => { throw new Error(`PCF ${name} is not supported by the local standard field host.`); };
const scalarType = type => /^(?:SingleLine\.(?:Text|TextArea|Email|Phone|URL|Ticker)|Multiple|Whole\.(?:None|Duration|TimeZone|Language)|Decimal|FP|Currency|Enum|OptionSet|TwoOptions|DateAndTime\.(?:DateAndTime|DateOnly))$/i.test(type ?? '');
const dateOnly = field => String(field?.format).toLowerCase() === 'dateonly' || field?.dateTimeBehavior === 'DateOnly';
const pad = value => String(value).padStart(2, '0');
const wallDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
function rawDate(source, field) {
  // The native field host gives date-only/independent components wall-clock
  // Dates. Parsing midnight as UTC shifts a reused date-only component west of UTC.
  if (typeof source === 'string' && /^\d{4}-\d{2}-\d{2}/.test(source) && (dateOnly(field) || field?.dateTimeBehavior === 'TimeZoneIndependent')) {
    const [year, month, day, hour = 0, minute = 0, second = 0] = source.match(/\d+/g).map(Number);
    return new Date(year, month - 1, day, dateOnly(field) ? 0 : hour, dateOnly(field) ? 0 : minute, dateOnly(field) ? 0 : second);
  }
  return new Date(source);
}

/** The documented context when no staff session is known (the session request failed): no user, no roles,
 * English (1033), UTC, no currency and no formatting info. A known session always supplies its server-built context. */
export const ANONYMOUS_STAFF_CONTEXT = Object.freeze({ userId: '', userName: '', roles: Object.freeze([]), securityRoles: Object.freeze([]), languageId: 1033, localeId: 1033,
  locale: 'en-US', localeResolved: true, isRTL: false, timeZone: Object.freeze({ code: 92, standardName: 'UTC', iana: 'UTC' }), transactionCurrency: null,
  numberFormattingInfo: null, dateFormattingInfo: null, anonymous: true });

/** Minutes to add to UTC for the local time in an IANA zone at a date (Learn: getTimeZoneOffsetMinutes). */
export function timeZoneOffsetMinutes(iana = 'UTC', date = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'longOffset' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

/** PCF context.formatting over the staff context: its locale, currency and time zone. */
export function staffFormatting(staff = ANONYMOUS_STAFF_CONTEXT) {
  const locale = staff.locale ?? 'en-US', timeZone = staff.timeZone?.iana ?? 'UTC', currency = staff.transactionCurrency;
  const number = (value, options) => new Intl.NumberFormat(locale, options).format(value);
  const date = (value, options) => new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(value instanceof Date ? value : new Date(value));
  return {
    formatDecimal: (value, precision = staff.numberFormattingInfo?.numberDecimalDigits ?? 2) => number(value, { minimumFractionDigits: precision, maximumFractionDigits: precision }),
    formatInteger: value => number(value, { maximumFractionDigits: 0 }),
    formatCurrency: (value, precision = currency?.precision ?? 2, symbol = currency?.symbol ?? '') => new Intl.NumberFormat(locale, { style: 'currency', currency: /^[A-Z]{3}$/.test(currency?.isoCode ?? '') ? currency.isoCode : 'XXX',
      minimumFractionDigits: precision, maximumFractionDigits: precision }).formatToParts(value).map(part => part.type === 'currency' ? symbol : part.value).join('').trim(),
    formatDateShort: (value, includeTime = false) => date(value, { dateStyle: 'short', ...(includeTime ? { timeStyle: 'short' } : {}) }),
    formatDateLong: value => date(value, { dateStyle: 'full' }),
    formatDateYearMonth: value => date(value, { year: 'numeric', month: 'long' }),
    formatTime: value => date(value, { timeStyle: 'short' }),
    getTimeZoneOffsetMinutes: value => timeZoneOffsetMinutes(timeZone, value === undefined ? new Date() : new Date(value)),
  };
}

/** PCF context.userSettings (Learn: UserSettings) from the staff context. */
export function pcfUserSettings(staff = ANONYMOUS_STAFF_CONTEXT) {
  return { dateFormattingInfo: staff.dateFormattingInfo, isRTL: staff.isRTL, languageId: staff.languageId, numberFormattingInfo: staff.numberFormattingInfo,
    securityRoles: [...staff.securityRoles], userId: staff.userId, userName: staff.userName, getTimeZoneOffsetMinutes: staffFormatting(staff).getTimeZoneOffsetMinutes };
}

function resource(url, kind) {
  const parsed = new URL(url, location.href);
  if (parsed.origin !== location.origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('PCF resources must use the local Mirage origin.');
  const key = `${kind}:${parsed.href}`;
  if (!loaded.has(key)) {
    const element = document.createElement(kind === 'script' ? 'script' : 'link');
    if (kind === 'script') { element.src = parsed.href; element.async = false; }
    else { element.rel = 'stylesheet'; element.href = parsed.href; }
    const promise = new Promise((resolve, reject) => {
      let timer;
      element.onload = () => { clearTimeout(timer); resolve(); };
      element.onerror = () => { clearTimeout(timer); element.remove(); loaded.delete(key); reject(new Error(`Unable to load local PCF ${kind} resource.`)); };
      timer = setTimeout(element.onerror, 15000);
      document.head.append(element);
    });
    loaded.set(key, promise);
  }
  return loaded.get(key);
}

function typed(value, property, field) {
  if (value == null) return null;
  const type = String(property.ofType ?? property['of-type'] ?? '');
  if (/^(Whole|Decimal|FP|Currency|Enum|OptionSet)/i.test(type) || field?.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`PCF output ${property.name} must be a finite number.`);
    if ((/Whole|Enum|OptionSet/i.test(type) || /^(int|integer|bigint)$/.test(field?.dataverseType)) && !Number.isInteger(value)) throw new Error(`PCF output ${property.name} must be an integer.`);
    if (field?.minValue !== undefined && value < field.minValue || field?.maxValue !== undefined && value > field.maxValue) throw new Error(`PCF output ${property.name} is outside the column range.`);
    return value;
  }
  if (/TwoOptions/i.test(type) || field?.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`PCF output ${property.name} must be a boolean.`);
    return value;
  }
  if (/DateAndTime/i.test(type) || field?.type === 'date') {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error(`PCF output ${property.name} must be a valid date.`);
    if (dateOnly(field)) return value instanceof Date ? wallDate(date) : String(value).slice(0, 10);
    if (field?.dateTimeBehavior === 'TimeZoneIndependent' && value instanceof Date) return `${wallDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}Z`;
    return date.toISOString();
  }
  if (/Lookup|MultiSelectOptionSet|Object/i.test(type) || ['lookup', 'json'].includes(field?.type)) unsupported(`property type ${type || field.type}`);
  if (typeof value !== 'string') throw new Error(`PCF output ${property.name} must be text.`);
  if (field?.maxLength && value.length > field.maxLength) throw new Error(`PCF output ${property.name} exceeds the column length.`);
  return value;
}

/** The one PCF admission rule of the Power Pages and model-driven hosts (code-components.mjs re-exports it).
 * standard: the field/dataset lifecycle. virtual (React): hosted only with every declared platform library, plus
 * ReactDOM of the declared React version, supplied as project files (modelDriven.clientSources <Library>@<version>.js);
 * else PCF_VIRTUAL_UNSUPPORTED names the control and what is missing. Other control types: PCF_CONTROL_TYPE_UNSUPPORTED. */
export function pcfAdmission(control, { platformLibraries = [] } = {}) {
  const name = control?.name ?? control?.schemaName ?? '';
  const type = control?.controlType ?? control?.type ?? 'standard', declared = control?.libraries ?? [];
  const dataset = Boolean(control?.dataset || control?.datasets?.length);
  if (control?.supported === false) return { admitted: false, code: 'PCF_UNSUPPORTED', reason: control.reason ?? `The exported PCF component ${name} is not supported locally.` };
  if (type !== 'standard' && type !== 'virtual') return { admitted: false, code: 'PCF_CONTROL_TYPE_UNSUPPORTED', reason: `Code component ${name} declares control-type ${type}, which no local host supports.` };
  const react = declared.find(library => /^react$/i.test(library.name));
  const needed = [...declared, ...(type === 'virtual' && react ? [{ name: 'ReactDOM', version: react.version }] : [])];
  const supplied = library => platformLibraries.find(entry => entry.name.toLowerCase() === String(library.name).toLowerCase() && entry.version === library.version);
  const missing = needed.filter(library => !supplied(library));
  if (type === 'virtual' && !react || missing.length) {
    const list = declared.map(library => `${library.name} ${library.version}`).join(', ') || 'none declared';
    return { admitted: false, kind: type, code: 'PCF_VIRTUAL_UNSUPPORTED', missing: missing.map(library => `${library.name}@${library.version}`),
      reason: `Code component ${name} requires platform libraries (${list}). ${type === 'virtual' && !react ? 'A virtual component must declare its React platform library.' : `Supply ${missing.map(library => `${library.name}@${library.version}.js`).join(', ')} as project files in modelDriven.clientSources.`}` };
  }
  return { admitted: true, kind: type === 'virtual' ? 'virtual' : dataset ? 'dataset' : 'standard', dataset, libraries: needed.map(supplied) };
}

export function pcfDescriptor(binding, extensions, { webAPI, kind = 'field' } = {}) {
  const definition = extensions?.pcf?.controls?.find(control => control.name === binding?.name);
  if (extensions?.trusted !== true) return { reason: 'Trust local Solution code in model-driven configuration to run this component.' };
  if (!definition) return { reason: `The exported PCF component ${binding?.name ?? ''} is unavailable.` };
  const admission = pcfAdmission(definition, { platformLibraries: extensions.pcf.platformLibraries });
  if (!admission.admitted) return { reason: admission.reason, code: admission.code };
  if (admission.dataset !== (kind === 'dataset')) return { reason: kind === 'dataset' ? `Code component ${definition.name} is a field component; bind it to a column.` : `Code component ${definition.name} is a dataset component; bind it to a subgrid.`, code: 'PCF_BINDING_MISMATCH' };
  const requiredFeatures = (definition.features ?? []).filter(feature => ['true', '1'].includes(String(feature.required).toLowerCase()) && !(String(feature.name).toLowerCase() === 'webapi' && webAPI));
  if (requiredFeatures.length) return { reason: `This PCF requires host features that are not implemented locally: ${requiredFeatures.map(feature => feature.name).join(', ')}.` };
  const unknown = (definition.properties ?? []).find(property => !scalarType(property.ofType ?? property['of-type']));
  if (unknown) return { reason: `PCF property ${unknown.name} uses unsupported type ${unknown.ofType ?? unknown['of-type'] ?? '(unknown)'}.` };
  const missing = (definition.properties ?? []).find(property => ['true', '1'].includes(String(property.required).toLowerCase()) && !Object.hasOwn(binding?.bindings ?? {}, property.name) && property.defaultValue == null && property['default-value'] == null && property.usage !== 'output');
  if (missing) return { reason: `The required PCF property ${missing.name} has no exported binding.` };
  return { definition, admission };
}

const staffOf = options => options.staffContext ?? (options.user ? { ...ANONYMOUS_STAFF_CONTEXT, anonymous: false, userId: options.user.id ?? '', userName: options.user.name ?? '' } : ANONYMOUS_STAFF_CONTEXT);
// Column security of a bound column from the record capabilities (field-level security): secured columns say so.
const columnSecurity = (name, rights, disabled) => { const right = name ? rights?.[name] : undefined; return { editable: !disabled, readable: right?.read !== false, secured: right?.secured === true }; };

// Loads the admitted platform libraries, then the component's declared CSS and code, and resolves its constructor.
async function loadComponent(definition, admission, gone) {
  if (!registrationInstalled) {
    registrationInstalled = true;
    const framework = window.ComponentFramework = window.ComponentFramework ?? {}, prior = framework.registerControl;
    framework.registerControl = function (name, Constructor) { if (safeName(name) && typeof Constructor === 'function') constructors.set(name, Constructor); if (typeof prior === 'function') prior.call(this, name, Constructor); };
  }
  const constructorName = Object.hasOwn(definition, 'constructor') ? definition.constructor : definition.name;
  if (!safeName(constructorName)) throw new Error('Invalid PCF constructor namespace.');
  for (const library of admission.libraries ?? []) { if (gone()) return null; await resource(library.url, 'script'); }
  for (const url of definition.resources?.css ?? []) { if (gone()) return null; await resource(url, 'style'); }
  for (const url of definition.resources?.code ?? []) { if (gone()) return null; await resource(url, 'script'); }
  if (gone()) return null;
  let Constructor = constructors.get(constructorName) ?? constructorName.split('.').reduce((owner, key) => owner && Object.hasOwn(owner, key) ? owner[key] : undefined, window);
  if (!Constructor) {
    const exportName = constructorName.split('.').at(-1);
    const candidates = [...new Set((definition.resources?.exports ?? []).filter(safeName).map(name => Object.getOwnPropertyDescriptor(window, name)?.value?.[exportName]).filter(value => typeof value === 'function'))];
    if (candidates.length > 1) throw new Error('The declared PCF resources expose ambiguous constructor exports.');
    Constructor = candidates[0];
  }
  if (typeof Constructor !== 'function') throw new Error(`The local bundle did not register ${constructorName}.`);
  return { Constructor, constructorName };
}

// A virtual component returns a React element from updateView; the supplied ReactDOM renders it into the host element.
function virtualView(element) {
  const ReactDOM = window.ReactDOM;
  if (!ReactDOM || typeof ReactDOM.render !== 'function' && typeof ReactDOM.createRoot !== 'function') throw new Error('The supplied ReactDOM platform library did not define window.ReactDOM.');
  const root = typeof ReactDOM.createRoot === 'function' ? ReactDOM.createRoot(element) : null;
  return { render: view => { if (root) root.render(view); else ReactDOM.render(view, element); },
    unmount: () => { if (root) root.unmount(); else ReactDOM.unmountComponentAtNode?.(element); } };
}

// Learn PCF client: isOffline follows the shell's mobile offline session (options.isOffline); the network is the loopback host.
const pcfClient = options => { const offline = () => Boolean(options.isOffline?.());
  return { getClient: () => offline() ? 'Mobile' : 'Web', getFormFactor: () => innerWidth < 768 ? 3 : 1, isOffline: offline, isNetworkAvailable: () => true }; };
export function renderPcfControl(field, initialValue, options = {}) {
  const element = document.createElement('div'); element.className = 'model-driven-pcf'; element.style.width = '100%'; element.setAttribute('role', 'group'); element.setAttribute('aria-label', field.label ?? field.name);
  const status = document.createElement('p'); status.className = 'unsupported';
  const binding = options.pcf, admission = pcfDescriptor(binding, options.clientExtensions, { webAPI: options.webAPI });
  const staff = staffOf(options);
  let value = initialValue, disabled = Boolean(options.disabled), instance, destroyed = false, failed = false, observer, updateQueued = false, state = {}, view;
  const virtual = admission.admission?.kind === 'virtual';
  const show = result => { if (view) view.render(result); };
  const cleanup = () => { observer?.disconnect(); observer = undefined; const current = instance, mounted = view; instance = undefined; view = undefined; try { mounted?.unmount(); current?.destroy?.(); } catch (error) { console.warn('Local PCF cleanup failed:', error.message); } };
  const showError = error => { failed = true; cleanup(); status.textContent = error.message; element.replaceChildren(status); element.dataset.pcfState = 'unsupported'; };
  if (!admission.definition) { showError(new Error(admission.reason)); return { element, read: () => value, supported: false, ready: Promise.resolve(), destroy() {} }; }
  const definition = admission.definition, properties = definition.properties ?? [], bindings = { ...binding.bindings };
  // Native FormXml serializes bound properties using their scalar type, with the
  // logical column name as text. Resolve that shape only for manifest-bound
  // properties and known exported columns; input literals stay literals.
  for (const property of properties) {
    const source = bindings[property.name];
    if (property.usage === 'bound' && !source?.field && typeof source?.value === 'string'
      && (source.value === field.name || Object.hasOwn(options.fields ?? {}, source.value))) bindings[property.name] = { field: source.value };
  }
  const bound = properties.filter(property => property.usage === 'bound' && bindings[property.name]?.field === field.name);
  const otherBound = properties.some(property => property.usage === 'bound' && bindings[property.name]?.field && bindings[property.name].field !== field.name);
  const compatible = property => field.type === 'text' || field.type === 'textarea' ? /^(?:SingleLine\.|Multiple$)/i.test(property.ofType ?? property['of-type'])
    : field.type === 'number' ? /^(?:Whole\.|Decimal$|FP$|Currency$|Enum$|OptionSet$)/i.test(property.ofType ?? property['of-type'])
      : field.type === 'boolean' ? /^TwoOptions$/i.test(property.ofType ?? property['of-type'])
        : field.type === 'date' ? /^DateAndTime\./i.test(property.ofType ?? property['of-type']) : false;
  const context = {
    parameters: {}, updatedProperties: [],
    mode: { isControlDisabled: disabled, isVisible: true, allocatedWidth: -1, allocatedHeight: -1,
      trackContainerResize(track) { observer?.disconnect(); observer = undefined; if (!destroyed && !failed && track && typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => schedule(['layout'])); observer.observe(element); } },
      setControlState(next) { state = structuredClone(next); }, setFullScreen() { unsupported('fullscreen'); } },
    resources: { getString: key => definition.resources?.resx?.[key] ?? key, getResource: () => unsupported('binary resources') },
    userSettings: pcfUserSettings(staff),
    client: pcfClient(options),
    navigation: new Proxy({}, { get: (_, name) => () => unsupported(`navigation.${String(name)}`) }),
    webAPI: new Proxy({}, { get: (_, name) => (...args) => {
      const api = typeof options.webAPI === 'function' ? options.webAPI() : options.webAPI;
      if (!destroyed && !failed && typeof api?.[name] === 'function') return api[name](...args);
      return Promise.reject(new Error(`PCF webAPI.${String(name)} is not supported by the configured local model-driven client API.`));
    } }),
    utils: { hasEntityPrivilege: () => unsupported('utils.hasEntityPrivilege'), getEntityMetadata: () => Promise.reject(new Error('PCF entity metadata API is not supported.')), lookupObjects: () => Promise.reject(new Error('PCF lookup dialog API is not supported.')) },
    formatting: staffFormatting(staff),
  };
  function refresh(changed = []) {
    // A trusted component may forget to honor isControlDisabled. The host still
    // blocks focus/user input, and notifyOutputChanged independently rejects edits.
    element.inert = disabled; element.setAttribute('aria-disabled', String(disabled));
    context.mode.isControlDisabled = disabled;
    context.mode.allocatedWidth = element.clientWidth; context.mode.allocatedHeight = element.clientHeight;
    context.updatedProperties = changed;
    for (const property of properties) {
      const link = bindings[property.name];
      let source = link?.field === field.name ? value : link?.field ? options.record?.[link.field] : link?.value ?? property.defaultValue ?? property['default-value'] ?? null;
      const propertyType = property.ofType ?? property['of-type'] ?? '';
      if (!link?.field && source != null) {
        if (/^(Whole|Decimal|FP|Currency|Enum|OptionSet)/i.test(propertyType)) source = Number(source);
        if (/TwoOptions/i.test(propertyType)) { if (![true, false, 'true', 'false', '1', '0'].includes(source)) throw new Error(`PCF input ${property.name} must be a boolean.`); source = source === true || source === 'true' || source === '1'; }
      }
      const raw = /DateAndTime/i.test(propertyType) && source != null ? rawDate(source, field) : source;
      const formatted = source == null ? '' : /OptionSet|TwoOptions/i.test(propertyType) ? field.options?.find(option => String(option.value) === String(typeof source === 'boolean' ? Number(source) : source))?.label ?? String(source) : String(source);
      context.parameters[property.name] = { raw, formatted, error: false, errorMessage: '',
        attributes: { LogicalName: link?.field ?? '', DisplayName: link?.field === field.name ? field.label ?? field.name : link?.field ?? property.name, RequiredLevel: field.required ? 2 : 0,
          ...(field.maxLength ? { MaxLength: field.maxLength } : {}), ...(field.options ? { Options: field.options.map(option => ({ Value: option.value, Label: option.label })) } : {}) }, security: columnSecurity(link?.field, options.fieldRights, disabled), type: property.ofType ?? property['of-type'] };
    }
  }
  function schedule(changed) {
    if (destroyed || failed || updateQueued) return;
    updateQueued = true;
    queueMicrotask(() => { updateQueued = false; if (destroyed || failed || !instance) return; try { refresh(changed); show(instance.updateView(context)); } catch (error) { showError(error); } });
  }
  function notifyOutputChanged() {
    if (destroyed || failed || disabled) return;
    try {
      const outputs = instance?.getOutputs?.() ?? {};
      let next = value, changed = false;
      for (const property of bound) if (Object.hasOwn(outputs, property.name)) { next = typed(outputs[property.name], property, field); changed ||= !Object.is(next, value); }
      if (changed) { value = next; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); schedule(bound.map(property => property.name)); }
    } catch (error) { showError(error); }
  }
  const ready = (async () => {
    try {
      if (bound.length !== 1 || otherBound) throw new Error('A local PCF field component requires one bound property matching this form field.');
      if (!compatible(bound[0])) throw new Error(`PCF bound property ${bound[0].name} is incompatible with column ${field.name}.`);
      const constructorName = Object.hasOwn(definition, 'constructor') ? definition.constructor : definition.name;
      if (!safeName(constructorName)) throw new Error('Invalid PCF constructor namespace.');
      const namespace = constructorName.includes('.') ? constructorName.slice(0, constructorName.lastIndexOf('.')) : null;
      element.classList.add('customControl', ...(namespace ? [namespace] : []), constructorName.split('.').at(-1), constructorName);
      const loaded = await loadComponent(definition, admission.admission, () => destroyed);
      if (!loaded || destroyed) return;
      instance = new loaded.Constructor();
      if (typeof instance.init !== 'function' || typeof instance.updateView !== 'function') throw new Error('The PCF bundle does not implement the standard field lifecycle.');
      if (virtual) view = virtualView(element);
      refresh(); instance.init(context, notifyOutputChanged, state, ...(virtual ? [] : [element])); refresh(bound.map(property => property.name)); show(instance.updateView(context)); element.dataset.pcfState = 'ready';
    } catch (error) { if (!destroyed) showError(error); }
  })();
  return { element, ready, get supported() { return !failed; }, read: () => value,
    setValue(next) { value = next; schedule(bound.map(property => property.name)); },
    setDisabled(next) { disabled = Boolean(next); schedule(['isControlDisabled']); },
    update(next, update = {}) { value = next; if (Object.hasOwn(update, 'disabled')) disabled = Boolean(update.disabled); schedule(bound.map(property => property.name)); },
    destroy() { if (destroyed) return; destroyed = true; cleanup(); element.replaceChildren(); },
  };
}


// unverified: PCF ConditionOperator numbers (0 Equal, 1 NotEqual, 2 GreaterThan, 3 LessThan, 4 GreaterEqual, 5 LessEqual, 6 Like, 7 NotLike, 12 Null, 13 NotNull).
const CONDITION_OPERATORS = { 0: 'eq', 1: 'ne', 2: 'gt', 3: 'lt', 4: 'ge', 5: 'le', 6: 'like', 7: 'not-like', 12: 'null', 13: 'not-null' };
const DATA_TYPES = { text: 'SingleLine.Text', textarea: 'Multiple', boolean: 'TwoOptions', date: 'DateAndTime.DateAndTime', lookup: 'Lookup.Simple', multiselect: 'MultiSelectPicklist' };
const dataTypeOf = field => !field ? 'unknown' : field.type === 'number' ? field.options?.length ? 'OptionSet' : ({ decimal: 'Decimal', money: 'Currency', double: 'FP', float: 'FP' }[field.dataverseType] ?? 'Whole.None') : DATA_TYPES[field.type] ?? 'SingleLine.Text';
const linkName = /^[a-z_][a-z\d_]*$/i;

/** A PCF DataSet (Learn: component-framework/reference/dataset) over the model-driven view query engine.
 * query(input) runs the view query ({ view, page, pageSize, sort, direction, filters, columns, links }) and answers
 * { rows, total, more }. baseFilters narrow it (a related subgrid's parent); openRecord(entity, id) navigates. */
export function createDatasetHost({ table, tables = {}, view, columns, query, openRecord, baseFilters = [], updated = () => {} }) {
  let page = 1, pageSize = 25, filter = null, selected = [], generation = 0;
  const linked = [], linkedColumns = [];
  const fail = message => { throw Object.assign(new Error(message), { code: 'PCF_DATASET_UNSUPPORTED' }); };
  const conditionsOf = expression => {
    if (!expression) return [];
    if (expression.filterOperator !== 0 && expression.filterOperator !== undefined || expression.filters?.length) fail('PCF dataset filters support one AND group of conditions locally.');
    return (expression.conditions ?? []).map(condition => {
      const operator = CONDITION_OPERATORS[condition.conditionOperator];
      if (!operator || condition.entityAliasName || !table.fields[condition.attributeName]) fail(`PCF dataset filter on ${condition.attributeName} with operator ${condition.conditionOperator} is not supported locally.`);
      if (Array.isArray(condition.value)) fail('PCF dataset In filters are not supported locally.');
      return { field: condition.attributeName, operator, ...(['null', 'not-null'].includes(operator) ? {} : { value: condition.value }) };
    });
  };
  const valueOf = (row, name) => {
    const field = table.fields[name], raw = row[name];
    if (raw == null) return null;
    if (field?.type === 'lookup') return { id: { guid: String(raw.id ?? raw) }, name: row[`${name}@OData.Community.Display.V1.FormattedValue`] ?? raw.name ?? '', etn: row[`${name}@Microsoft.Dynamics.CRM.lookuplogicalname`] ?? raw.entity ?? field.targets?.[0] };
    if (field?.type === 'date') return new Date(raw);
    return raw;
  };
  const columnOf = (field, name, order) => ({ name, displayName: field?.label ?? name, dataType: dataTypeOf(field), alias: name, order, visualSizeFactor: 100, isHidden: false, isPrimary: false });
  const dataset = {
    columns: columns.map((column, order) => ({ ...columnOf(table.fields[column.name], column.name, order), visualSizeFactor: column.width ?? 100, isPrimary: column.name === table.nameColumn })),
    records: {}, sortedRecordIds: [], sorting: [], loading: true, error: false, errorMessage: '', errorCode: 0,
    filtering: { getFilter: () => filter && structuredClone(filter), setFilter: expression => { conditionsOf(expression); filter = structuredClone(expression); }, clearFilter: () => { filter = null; } },
    linking: {
      getLinkedEntities: () => linked.map(link => ({ ...link })),
      addLinkedEntity: link => {
        if (!tables[link?.name] || !linkName.test(link.from ?? '') || !linkName.test(link.to ?? '') || !linkName.test(link.alias ?? '') || !['inner', 'outer'].includes(link.linkType ?? 'inner')) fail('PCF dataset links need an imported table, from/to columns, an alias and an inner or outer link type.');
        if (linked.some(entry => entry.alias === link.alias)) fail(`PCF dataset link alias ${link.alias} is already used.`);
        linked.push({ name: link.name, from: link.from, to: link.to, linkType: link.linkType ?? 'inner', alias: link.alias });
      },
    },
    paging: { totalResultCount: -1, hasNextPage: false, hasPreviousPage: false, pageSize, firstPageNumber: 1, lastPageNumber: 1,
      setPageSize: size => { if (!Number.isInteger(size) || size < 1 || size > 100) fail('PCF dataset page size must be between 1 and 100 locally (the view query engine limit).'); pageSize = size; dataset.paging.pageSize = size; page = 1; },
      loadNextPage: () => { if (!dataset.paging.hasNextPage) return Promise.resolve(); page++; return load(); },
      loadPreviousPage: () => { if (page <= 1) return Promise.resolve(); page--; return load(); },
      loadExactPage: number => { if (!Number.isInteger(number) || number < 1) fail('PCF dataset page number is invalid.'); page = number; return load(); },
      // Learn paging.reset: "Reload the results from the server, and reset to page 1."
      reset: () => { page = 1; return load(); } },
    refresh: () => dataset.paging.reset(),
    addColumn: (name, entityAlias) => {
      const link = entityAlias && linked.find(entry => entry.alias === entityAlias);
      if (entityAlias ? !link || !tables[link.name].fields?.[name] : !table.fields[name]) fail(`PCF dataset column ${entityAlias ? `${entityAlias}.` : ''}${name} is not an imported column.`);
      if (link) { linkedColumns.push({ alias: entityAlias, name }); dataset.columns.push(columnOf(tables[link.name].fields[name], `${entityAlias}.${name}`, dataset.columns.length)); }
      else if (!dataset.columns.some(column => column.name === name)) dataset.columns.push(columnOf(table.fields[name], name, dataset.columns.length));
    },
    getTargetEntityType: () => table.entity, getTitle: () => view?.name ?? table.label ?? table.entity, getViewId: () => view?.id ?? '',
    getSelectedRecordIds: () => [...selected], setSelectedRecordIds: ids => { selected = (ids ?? []).filter(id => Object.hasOwn(dataset.records, id)); }, clearSelectedRecordIds: () => { selected = []; },
    openDatasetItem: reference => {
      const id = String(reference?.id?.guid ?? reference?.id ?? '').replace(/[{}]/g, '');
      const entity = reference?.etn ?? reference?.entityType ?? table.entity;
      if (!tables[entity] && entity !== table.entity || !id) return Promise.reject(new Error('PCF openDatasetItem needs a record reference of an imported table.'));
      return Promise.resolve(openRecord(entity, id));
    },
  };
  async function load() {
    const revision = ++generation;
    dataset.loading = true; dataset.error = false; dataset.errorMessage = ''; updated();
    try {
      if (dataset.sorting.length > 1) fail('PCF dataset sorting supports one column locally (the view query engine sorts by one column).');
      const sort = dataset.sorting[0];
      if (sort && (!table.fields[sort.name] || ![0, 1].includes(sort.sortDirection))) fail('PCF dataset sorting needs an imported column and an ascending or descending direction.');
      const result = await query({ ...(view?.id ? { view: view.id } : {}), page, pageSize, ...(sort ? { sort: sort.name, direction: sort.sortDirection === 1 ? 'desc' : 'asc' } : {}),
        filters: [...baseFilters, ...conditionsOf(filter)], columns: dataset.columns.filter(column => !column.name.includes('.')).map(column => column.name),
        ...(linked.length ? { links: linked.map(link => ({ ...link, columns: linkedColumns.filter(column => column.alias === link.alias).map(column => column.name) })) } : {}) });
      if (revision !== generation) return;
      const records = {}, ids = [];
      for (const row of result.rows ?? []) {
        const id = String(row[table.idColumn]);
        ids.push(id);
        records[id] = { getRecordId: () => id, getNamedReference: () => ({ id: { guid: id }, name: row[table.nameColumn] ?? '', etn: table.entity }),
          getValue: name => valueOf(row, name),
          getFormattedValue: name => String(row[`${name}@OData.Community.Display.V1.FormattedValue`] ?? (typeof row[name] === 'object' && row[name] ? row[name].name ?? '' : row[name] ?? '')) };
      }
      dataset.records = records; dataset.sortedRecordIds = ids;
      selected = selected.filter(id => Object.hasOwn(records, id));
      const total = Number.isInteger(result.total) && result.total >= 0 ? result.total : -1;
      Object.assign(dataset.paging, { totalResultCount: total, pageSize, hasPreviousPage: page > 1, hasNextPage: total >= 0 ? page * pageSize < total : Boolean(result.more),
        firstPageNumber: 1, lastPageNumber: total >= 0 ? Math.max(1, Math.ceil(total / pageSize)) : page });
    } catch (error) {
      if (revision !== generation) return;
      dataset.records = {}; dataset.sortedRecordIds = []; dataset.error = true; dataset.errorMessage = error.message; dataset.errorCode = error.code ?? 'LocalDatasetError'; dataset.paging.hasNextPage = false;
    } finally { if (revision === generation) { dataset.loading = false; updated(); } }
  }
  return { dataset, load };
}

/** A trusted dataset PCF on a form subgrid: the shared admission rule, the same staff context and formatting as field
 * components, and a DataSet over the subgrid's view (its rows narrowed to the parent record). */
export function renderPcfDataset(cell, options) {
  const element = document.createElement('div'); element.className = 'model-driven-pcf model-driven-pcf-dataset'; element.setAttribute('role', 'group'); element.setAttribute('aria-label', cell.label ?? 'Related records');
  const status = document.createElement('p'); status.className = 'unsupported';
  const admission = pcfDescriptor(cell.pcf, options.clientExtensions, { webAPI: options.webAPI, kind: 'dataset' });
  const staff = staffOf(options);
  let instance, view, destroyed = false, failed = false, state = {}, queued = false;
  const virtual = admission.admission?.kind === 'virtual';
  const cleanup = () => { const current = instance, mounted = view; instance = undefined; view = undefined; try { mounted?.unmount(); current?.destroy?.(); } catch (error) { console.warn('Local PCF cleanup failed:', error.message); } };
  const showError = error => { failed = true; cleanup(); status.textContent = error.message; element.replaceChildren(status); element.dataset.pcfState = 'unsupported'; };
  if (!admission.definition) { showError(new Error(admission.reason)); return { element, supported: false, ready: Promise.resolve(), destroy() {} }; }
  const definition = admission.definition;
  const datasetName = definition.datasets?.[0]?.name ?? Object.keys(cell.pcf.bindings ?? {}).find(name => cell.pcf.bindings[name]?.dataset);
  const context = {
    parameters: {}, updatedProperties: [],
    mode: { isControlDisabled: false, isVisible: true, allocatedWidth: -1, allocatedHeight: -1, trackContainerResize() {}, setControlState(next) { state = structuredClone(next); }, setFullScreen() { unsupported('fullscreen'); } },
    resources: { getString: key => definition.resources?.resx?.[key] ?? key, getResource: () => unsupported('binary resources') },
    userSettings: pcfUserSettings(staff), formatting: staffFormatting(staff),
    client: pcfClient(options),
    navigation: new Proxy({}, { get: (_, name) => () => unsupported(`navigation.${String(name)}`) }),
    webAPI: new Proxy({}, { get: (_, name) => (...args) => {
      const api = typeof options.webAPI === 'function' ? options.webAPI() : options.webAPI;
      if (!destroyed && !failed && typeof api?.[name] === 'function') return api[name](...args);
      return Promise.reject(new Error(`PCF webAPI.${String(name)} is not supported by the configured local model-driven client API.`));
    } }),
    utils: { hasEntityPrivilege: () => unsupported('utils.hasEntityPrivilege'), getEntityMetadata: () => Promise.reject(new Error('PCF entity metadata API is not supported.')), lookupObjects: () => Promise.reject(new Error('PCF lookup dialog API is not supported.')) },
  };
  const rerender = () => {
    if (!instance || destroyed || failed || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!instance || destroyed || failed) return; context.updatedProperties = ['dataset', datasetName]; try { const result = instance.updateView(context); if (view) view.render(result); } catch (error) { showError(error); } });
  };
  const host = createDatasetHost({ table: options.table, tables: options.tables, view: options.view, columns: options.view?.fields ?? [{ name: options.table.nameColumn }],
    query: options.query, openRecord: options.openRecord, baseFilters: options.baseFilters, updated: rerender });
  context.parameters[datasetName] = host.dataset;
  for (const property of definition.properties ?? []) {
    const source = cell.pcf.bindings?.[property.name]?.value ?? property.defaultValue ?? property['default-value'] ?? null;
    const type = property.ofType ?? property['of-type'] ?? '';
    context.parameters[property.name] = { raw: source != null && /^(Whole|Decimal|FP|Currency|Enum|OptionSet)/i.test(type) ? Number(source) : source, formatted: source == null ? '' : String(source), error: false, errorMessage: '', type };
  }
  const ready = (async () => {
    try {
      const constructorName = Object.hasOwn(definition, 'constructor') ? definition.constructor : definition.name;
      if (!safeName(constructorName)) throw new Error('Invalid PCF constructor namespace.');
      element.classList.add('customControl', constructorName.split('.').at(-1), constructorName);
      const loaded = await loadComponent(definition, admission.admission, () => destroyed);
      if (!loaded || destroyed) return;
      instance = new loaded.Constructor();
      if (typeof instance.init !== 'function' || typeof instance.updateView !== 'function') throw new Error('The PCF bundle does not implement the dataset lifecycle.');
      if (virtual) view = virtualView(element);
      instance.init(context, () => {}, state, ...(virtual ? [] : [element]));
      await host.load();
      if (!destroyed && !failed) element.dataset.pcfState = 'ready';
    } catch (error) { if (!destroyed) showError(error); }
  })();
  return { element, ready, get supported() { return !failed; }, dataset: host.dataset, destroy() { if (destroyed) return; destroyed = true; cleanup(); element.replaceChildren(); } };
}
