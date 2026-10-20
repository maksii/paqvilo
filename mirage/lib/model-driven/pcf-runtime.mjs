// Trusted, exported standard field components. This adapter deliberately has no
// native credentials or remote service fallback; unsupported APIs fail visibly.
const loaded = new Map();
const constructors = new Map();
let registrationInstalled = false;
const safeName = value => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value ?? '') && !String(value).split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part));
const unsupported = name => { throw new Error(`PCF ${name} is not supported by the local standard field host.`); };
const scalarType = type => /^(?:SingleLine\.(?:Text|TextArea|Email|Phone|URL|Ticker)|Multiple|Whole\.(?:None|Duration|TimeZone|Language)|Decimal|FP|Currency|Enum|OptionSet|TwoOptions|DateAndTime\.(?:DateAndTime|DateOnly))$/i.test(type ?? '');

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
    return field?.format === 'dateonly' || field?.dateTimeBehavior === 'DateOnly' ? date.toISOString().slice(0, 10) : date.toISOString();
  }
  if (/Lookup|MultiSelectOptionSet|Object/i.test(type) || ['lookup', 'json'].includes(field?.type)) unsupported(`property type ${type || field.type}`);
  if (typeof value !== 'string') throw new Error(`PCF output ${property.name} must be text.`);
  if (field?.maxLength && value.length > field.maxLength) throw new Error(`PCF output ${property.name} exceeds the column length.`);
  return value;
}

export function pcfDescriptor(binding, extensions) {
  const definition = extensions?.pcf?.controls?.find(control => control.name === binding?.name);
  if (extensions?.trusted !== true) return { reason: 'Trust local Solution code in model-driven configuration to run this component.' };
  if (!definition) return { reason: `The exported PCF component ${binding?.name ?? ''} is unavailable.` };
  if ((definition.controlType ?? definition.type) && (definition.controlType ?? definition.type) !== 'standard' || definition.dataset || definition.datasets?.length || definition.libraries?.length || definition.supported === false) return { reason: definition.reason ?? 'Only standard scalar field PCF components are supported locally.' };
  const requiredFeatures = (definition.features ?? []).filter(feature => ['true', '1'].includes(String(feature.required).toLowerCase()));
  if (requiredFeatures.length) return { reason: `This PCF requires host features that are not implemented locally: ${requiredFeatures.map(feature => feature.name).join(', ')}.` };
  const unknown = (definition.properties ?? []).find(property => !scalarType(property.ofType ?? property['of-type']));
  if (unknown) return { reason: `PCF property ${unknown.name} uses unsupported type ${unknown.ofType ?? unknown['of-type'] ?? '(unknown)'}.` };
  const missing = (definition.properties ?? []).find(property => ['true', '1'].includes(String(property.required).toLowerCase()) && !Object.hasOwn(binding?.bindings ?? {}, property.name) && property.defaultValue == null && property['default-value'] == null && property.usage !== 'output');
  if (missing) return { reason: `The required PCF property ${missing.name} has no exported binding.` };
  return { definition };
}

export function renderPcfControl(field, initialValue, options = {}) {
  const element = document.createElement('div'); element.className = 'model-driven-pcf'; element.setAttribute('role', 'group'); element.setAttribute('aria-label', field.label ?? field.name);
  const status = document.createElement('p'); status.className = 'unsupported';
  const binding = options.pcf, admission = pcfDescriptor(binding, options.clientExtensions);
  let value = initialValue, disabled = Boolean(options.disabled), instance, destroyed = false, failed = false, observer, updateQueued = false, state = {};
  const cleanup = () => { observer?.disconnect(); observer = undefined; const current = instance; instance = undefined; try { current?.destroy?.(); } catch (error) { console.warn('Local PCF cleanup failed:', error.message); } };
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
    userSettings: { languageId: options.languageId ?? 1033, isRTL: false, userId: options.user?.id ?? '', userName: options.user?.name ?? '', securityRoles: [] },
    client: { getClient: () => 'Web', getFormFactor: () => innerWidth < 768 ? 3 : 1, isOffline: () => false, isNetworkAvailable: () => true },
    navigation: new Proxy({}, { get: (_, name) => () => unsupported(`navigation.${String(name)}`) }),
    webAPI: new Proxy({}, { get: (_, name) => (...args) => {
      const api = typeof options.webAPI === 'function' ? options.webAPI() : options.webAPI;
      if (!destroyed && typeof api?.[name] === 'function') return api[name](...args);
      return Promise.reject(new Error(`PCF webAPI.${String(name)} is not supported by the configured local model-driven client API.`));
    } }),
    utils: { hasEntityPrivilege: () => unsupported('utils.hasEntityPrivilege'), getEntityMetadata: () => Promise.reject(new Error('PCF entity metadata API is not supported.')), lookupObjects: () => Promise.reject(new Error('PCF lookup dialog API is not supported.')) },
    formatting: { formatDecimal: number => String(number), formatInteger: number => String(number), formatCurrency: number => String(number), formatDateShort: date => new Date(date).toLocaleDateString(), formatDateLong: date => new Date(date).toLocaleDateString() },
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
      const raw = /DateAndTime/i.test(propertyType) && source != null ? new Date(source) : source;
      context.parameters[property.name] = { raw, formatted: source == null ? '' : String(source), error: false, errorMessage: '',
        attributes: { LogicalName: link?.field ?? '', DisplayName: link?.field === field.name ? field.label ?? field.name : link?.field ?? property.name, RequiredLevel: field.required ? 2 : 0,
          ...(field.maxLength ? { MaxLength: field.maxLength } : {}), ...(field.options ? { Options: field.options.map(option => ({ Value: option.value, Label: option.label })) } : {}) }, security: { editable: !disabled, readable: true, secured: false }, type: property.ofType ?? property['of-type'] };
    }
  }
  function schedule(changed) {
    if (destroyed || failed || updateQueued) return;
    updateQueued = true;
    queueMicrotask(() => { updateQueued = false; if (destroyed || failed || !instance) return; try { refresh(changed); instance.updateView(context); } catch (error) { showError(error); } });
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
      if (!registrationInstalled) {
        registrationInstalled = true;
        const framework = window.ComponentFramework = window.ComponentFramework ?? {}, prior = framework.registerControl;
        framework.registerControl = function (name, Constructor) { if (safeName(name) && typeof Constructor === 'function') constructors.set(name, Constructor); if (typeof prior === 'function') prior.call(this, name, Constructor); };
      }
      for (const url of definition.resources?.css ?? []) { if (destroyed) return; await resource(url, 'style'); }
      for (const url of definition.resources?.code ?? []) { if (destroyed) return; await resource(url, 'script'); }
      if (destroyed) return;
      let Constructor = constructors.get(constructorName) ?? constructorName.split('.').reduce((owner, key) => owner && Object.hasOwn(owner, key) ? owner[key] : undefined, window);
      if (!Constructor) {
        const exportName = constructorName.split('.').at(-1);
        const candidates = [...new Set((definition.resources?.exports ?? []).filter(safeName).map(name => Object.getOwnPropertyDescriptor(window, name)?.value?.[exportName]).filter(value => typeof value === 'function'))];
        if (candidates.length > 1) throw new Error('The declared PCF resources expose ambiguous constructor exports.');
        Constructor = candidates[0];
      }
      if (typeof Constructor !== 'function') throw new Error(`The local bundle did not register ${constructorName}.`);
      instance = new Constructor();
      if (typeof instance.init !== 'function' || typeof instance.updateView !== 'function') throw new Error('The PCF bundle does not implement the standard field lifecycle.');
      refresh(); instance.init(context, notifyOutputChanged, state, element); refresh(bound.map(property => property.name)); instance.updateView(context); element.dataset.pcfState = 'ready';
    } catch (error) { if (!destroyed) showError(error); }
  })();
  return { element, ready, get supported() { return !failed; }, read: () => value,
    setValue(next) { value = next; schedule(bound.map(property => property.name)); },
    setDisabled(next) { disabled = Boolean(next); schedule(['isControlDisabled']); },
    update(next, update = {}) { value = next; if (Object.hasOwn(update, 'disabled')) disabled = Boolean(update.disabled); schedule(bound.map(property => property.name)); },
    destroy() { if (destroyed) return; destroyed = true; cleanup(); element.replaceChildren(); },
  };
}
