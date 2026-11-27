(function () {
  'use strict';
  if (globalThis.__paqviloPcf) return;
  const constructors = new Map(),
    loaded = new Map(),
    instances = new Map(),
    counts = new Map(),
    history = [];
  const errorText = (value) => {
    try {
      return typeof value?.message === 'string' ? value.message : String(value);
    } catch {
      return 'Unknown PCF failure';
    }
  };
  const debugValue = (value, depth = 0) => {
    try {
      if (value == null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
      if (depth > 5) return '[depth limit]';
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => debugValue(item, depth + 1));
      return Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(value))
          .slice(0, 100)
          .filter(([, descriptor]) => !('value' in descriptor) || typeof descriptor.value !== 'function')
          .map(([key, descriptor]) => [
            key,
            'value' in descriptor ? debugValue(descriptor.value, depth + 1) : '[accessor]',
          ]),
      );
    } catch {
      return '[snapshot unavailable]';
    }
  };
  const valuesOf = (value) => {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    return [value];
  };
  const debugSnapshot = (entry) => {
    try {
      return {
        id: entry.id,
        constructor: entry.constructor,
        state: entry.state,
        error: entry.error ?? null,
        lifecycle: entry.lifecycle.map((item) => ({ ...item })),
        outputs: debugValue(entry.outputs ?? {}),
        refusedOutputs: debugValue(entry.refusedOutputs ?? []),
        webApiErrors: debugValue(entry.webApiErrors ?? []),
        hostCalls: debugValue(entry.hostCalls ?? []),
        lastParameterUpdate: debugValue(entry.lastParameterUpdate ?? null),
        parameters: Object.fromEntries(
          Object.entries(entry.parameters ?? {}).map(([name, parameter]) => [
            name,
            Object.hasOwn(parameter, 'raw')
              ? {
                  raw: debugValue(parameter.raw),
                  formatted: parameter.formatted,
                  type: parameter.type,
                  attributes: debugValue(parameter.attributes),
                  error: Boolean(parameter.error),
                  errorMessage: parameter.errorMessage,
                }
              : {
                  dataset: true,
                  loading: parameter.loading,
                  error: parameter.error,
                  errorMessage: parameter.errorMessage,
                  sortedRecordIds: debugValue(parameter.sortedRecordIds),
                  paging: debugValue(parameter.paging),
                },
          ]),
        ),
      };
    } catch (error) {
      return {
        id: entry.id,
        constructor: entry.constructor,
        state: entry.state,
        error: entry.error ?? null,
        snapshotError: errorText(error),
      };
    }
  };
  const framework = (globalThis.ComponentFramework = globalThis.ComponentFramework || {});
  const prior = framework.registerControl;
  framework.registerControl = function (name, constructor) {
    constructors.set(name, constructor);
    if (prior) prior.call(this, name, constructor);
  };
  function virtualControl(control, container) {
    const ReactDOM = globalThis.ReactDOM;
    if (!ReactDOM || typeof ReactDOM.render !== 'function')
      throw new Error('The supplied ReactDOM platform library did not define window.ReactDOM.');
    const updateView = control.updateView;
    control.updateView = function (context) {
      const element = updateView.call(this, context);
      if (element != null) ReactDOM.render(element, container);
      return element;
    };
    const destroy = control.destroy;
    control.destroy = function () {
      ReactDOM.unmountComponentAtNode?.(container);
      return destroy?.call(this);
    };
  }
  function registered(spec) {
    return (
      constructors.has(spec.constructor) ||
      typeof spec.constructor.split('.').reduce((value, key) => value?.[key], globalThis) === 'function' ||
      spec.resources.some((item) => item.exportGlobal && Object.getOwnPropertyDescriptor(globalThis, item.exportGlobal))
    );
  }
  function resource(item) {
    if (loaded.has(item.url)) return loaded.get(item.url);
    const promise = new Promise((resolve, reject) => {
      const node = document.createElement(item.kind === 'css' ? 'link' : 'script');
      if (item.kind === 'css') {
        node.rel = 'stylesheet';
        node.href = item.url;
      } else node.src = item.url;
      node.onload = resolve;
      node.onerror = () => {
        node.remove();
        loaded.delete(item.url);
        reject(new Error('The declared PCF resource failed to load: ' + item.url));
      };
      document.head.appendChild(node);
    });
    loaded.set(item.url, promise);
    return promise;
  }
  function typedTwoOptions(value) {
    if ([true, 'true', 1, '1'].includes(value)) return true;
    if ([false, 'false', 0, '0'].includes(value)) return false;
    throw new Error('PCF TwoOptions requires a Boolean value');
  }
  function typedNumber(value, type) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('PCF ' + type + ' requires a finite number');
    if (/^(Whole|Enum|OptionSet)/.test(type) && !Number.isInteger(number))
      throw new Error('PCF ' + type + ' requires an integer');
    return number;
  }
  // Date-only and time-zone-independent values are wall-clock values: "2026-11-26" is that calendar
  // date in the browser's zone, never UTC midnight (which shifts a day west of UTC).
  function wallClock(behavior, type) {
    if (type === 'DateAndTime.DateOnly' || behavior === 2 || behavior === 'DateOnly') return 'date';
    if (behavior === 3 || behavior === 'TimeZoneIndependent') return 'time';
    return null;
  }
  function typedDate(value, type, behavior) {
    const wall = wallClock(behavior, type);
    let date;
    if (value instanceof Date)
      date = new Date(value.getTime()); // NOSONAR: Date subclass may override getTime
    else if (wall && /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(String(value))) {
      // Like the model-driven field host (rawDate), a zone suffix on a wall-clock value is nominal.
      const [year, month, day, hour = 0, minute = 0, second = 0] = String(value).match(/\d+/g).map(Number);
      date = wall === 'date' ? new Date(year, month - 1, day) : new Date(year, month - 1, day, hour, minute, second);
    } else date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('PCF date parameter is invalid');
    return date;
  }
  // Enum: when the manifest declares no <value> entries (property.values is empty) the
  // value stays an integer. With declared values it is one of them: a string, or a number
  // when every declared value is numeric. Enum raw values arrive as strings on Power Pages.
  function enumValues(property) {
    return Array.isArray(property?.values) ? property.values : null;
  }
  /** @returns {number|string} A declared value: a number when every declared value is numeric, a string otherwise. */
  function typedEnum(value, property) {
    const declared = enumValues(property);
    if (!declared) return typedNumber(value, 'Enum');
    const values = declared.map((item) => String(item?.value ?? item?.text ?? item));
    const numeric = values.length > 0 && values.every((item) => item !== '' && Number.isFinite(Number(item)));
    if (value === null || typeof value === 'object' || !values.includes(String(value)))
      throw new Error('PCF Enum requires one of its declared values');
    return numeric ? Number(value) : String(value);
  }
  function typedMultiSelect(value) {
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((item) => {
      if (item === '' || !Number.isInteger(Number(item)))
        throw new Error('PCF MultiSelectOptionSet requires integer option values');
      return Number(item);
    });
  }
  function typedLookup(value) {
    let values = value;
    if (typeof values === 'string') {
      try {
        values = JSON.parse(values);
      } catch {
        throw new Error('PCF lookup parameters require lookup objects, not display text');
      }
    }
    if (!Array.isArray(values)) values = [values];
    // An empty lookup is null on both the server-rendered arguments and the native field read.
    if (!values.length) return null;
    return values.map((item) => {
      if (!item || typeof item !== 'object' || !item.id || !item.entityType)
        throw new Error('PCF lookup objects require id and entityType');
      return { id: String(item.id), entityType: String(item.entityType), name: String(item.name ?? '') };
    });
  }
  function typed(value, type, meta = {}) {
    if (value == null || value === '') return null;
    if (type === 'TwoOptions') return typedTwoOptions(value);
    if (type === 'Enum') return typedEnum(value, meta.property);
    if (/^(Whole|Decimal|FP|Currency|OptionSet)/.test(type)) return typedNumber(value, type);
    if (type.startsWith('DateAndTime')) return typedDate(value, type, meta.behavior);
    if (type === 'MultiSelectOptionSet') return typedMultiSelect(value);
    if (type.startsWith('Lookup.')) return typedLookup(value);
    return value;
  }
  // A component's getOutputs value must already have its property type: nothing is coerced, so an
  // invalid output is refused instead of being stored or written to the native field.
  function outputValue(value, type, attributes = {}) {
    if (value == null) return null;
    checkOutputType(value, type, attributes);
    return value;
  }
  function refuseOutput(message) {
    throw new Error('PCF output ' + message);
  }
  function checkOutputType(value, type, attributes) {
    if (type === 'TwoOptions') checkTwoOptionsOutput(value);
    else if (/^(Whole|Decimal|FP|Currency|OptionSet)/.test(type)) checkNumberOutput(value, type, attributes);
    else if (type.startsWith('DateAndTime')) checkDateOutput(value, type);
    else if (type === 'MultiSelectOptionSet') checkChoicesOutput(value);
    else if (type.startsWith('Lookup.')) checkLookupOutput(value, type);
    else if (type === 'Enum') checkEnumOutput(value);
    else if (/^(SingleLine\.|Multiple$)/.test(type)) checkTextOutput(value, type, attributes);
  }
  function checkTwoOptionsOutput(value) {
    if (typeof value !== 'boolean') refuseOutput('for TwoOptions must be a boolean');
  }
  const outsideColumnRange = (value, attributes) =>
    (Number.isFinite(attributes.MinValue) && value < attributes.MinValue) ||
    (Number.isFinite(attributes.MaxValue) && value > attributes.MaxValue);
  const columnOptionMissing = (value, type, attributes) =>
    type === 'OptionSet' &&
    Array.isArray(attributes.Options) &&
    attributes.Options.length &&
    !attributes.Options.some((option) => Number(option.Value) === value);
  function checkNumberOutput(value, type, attributes) {
    if (typeof value !== 'number' || !Number.isFinite(value)) refuseOutput('for ' + type + ' must be a finite number');
    if (/^(Whole|OptionSet)/.test(type) && !Number.isInteger(value))
      refuseOutput('for ' + type + ' must be an integer');
    if (outsideColumnRange(value, attributes)) refuseOutput('is outside the column range');
    if (columnOptionMissing(value, type, attributes)) refuseOutput('is not a column option');
  }
  function checkDateOutput(value, type) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      refuseOutput('for ' + type + ' must be a valid Date');
  }
  function checkChoicesOutput(value) {
    if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item)))
      refuseOutput('for MultiSelectOptionSet must be an array of integer option values');
  }
  function checkLookupOutput(value, type) {
    const items = Array.isArray(value) ? value : [value];
    if (items.some((item) => !item || typeof item !== 'object' || !item.id || !(item.entityType || item.etn)))
      refuseOutput('for ' + type + ' must contain lookup references');
  }
  function checkEnumOutput(value) {
    if (typeof value !== 'string' && typeof value !== 'number') refuseOutput('for Enum must be an enum value');
  }
  function checkTextOutput(value, type, attributes) {
    if (typeof value !== 'string') refuseOutput('for ' + type + ' must be text');
    if (Number.isInteger(attributes.MaxLength) && value.length > attributes.MaxLength)
      refuseOutput('exceeds the column length');
  }
  // The display text of a value. Choice and Two Options labels come from the column options and a
  // lookup shows its record name.
  function formatParameter(raw, type, attributes = {}) {
    if (raw == null) return '';
    const label = (value) =>
      (Array.isArray(attributes.Options) ? attributes.Options : []).find(
        (option) => String(option.Value) === String(value),
      )?.Label;
    if (type === 'TwoOptions') return label(raw ? 1 : 0) ?? String(raw);
    if (type === 'OptionSet' || type === 'Enum') return label(raw) ?? String(raw);
    if (type === 'MultiSelectOptionSet' && Array.isArray(raw))
      return raw.map((value) => label(value) ?? String(value)).join('; ');
    if (type.startsWith('Lookup.')) return String((Array.isArray(raw) ? raw[0] : raw)?.name ?? '');
    return String(raw);
  }
  function groupType(types, boundType) {
    if (!types?.length) return null;
    if (boundType) return types.includes(boundType) ? boundType : null;
    if (
      types.every((type) =>
        [
          'SingleLine.Text',
          'Multiple',
          'SingleLine.TextArea',
          'SingleLine.Email',
          'SingleLine.Phone',
          'SingleLine.URL',
          'SingleLine.Ticker',
        ].includes(type),
      )
    )
      return 'SingleLine.Text';
    if (types.every((type) => ['Decimal', 'FP', 'Whole.None', 'Currency'].includes(type)))
      return types.length === 1 ? types[0] : 'Decimal';
    if (types.every((type) => ['DateAndTime.DateAndTime', 'DateAndTime.DateOnly'].includes(type)))
      return types.length === 1 ? types[0] : 'DateAndTime.DateAndTime';
    return types.length === 1 ? types[0] : null;
  }
  // ---- Power Pages form field host (basic and multistep forms), as captured on a live site. The platform renders no native control: the field value lives in a hidden input as
  // JSON (strings quoted, numbers bare, booleans, a choice as an option object, choices as an array of them, dates as
  // ISO text), the component's outputs are written there and the form posts it (lib/pcf-field-host.mjs decodes it).
  function nativeScope(container) {
    return (
      container.closest('.control[data-logical-name]') ||
      container.closest('[data-mirage-component="entityform"], [data-mirage-component="webform"]') ||
      container.closest('form') ||
      document
    );
  }
  function nativeField(spec, container) {
    const field = nativeScope(container).querySelector('input[type="hidden"]#' + CSS.escape(spec.nativeBinding.id));
    if (!field) throw new Error('PCF native binding input was not found: ' + spec.nativeBinding.id);
    return field;
  }
  const FIELD_TYPES = {
    Multiple: { Type: 'memo', Format: '2', MaxLength: 2000 },
    'SingleLine.Text': { Type: 'string', Format: 'Text' },
    'SingleLine.Email': { Type: 'string', Format: 'Email' },
    'SingleLine.TextArea': { Type: 'string', Format: 'TextArea' },
    'SingleLine.Phone': { Type: 'string', Format: 'Phone' },
    'SingleLine.Ticker': { Type: 'string', Format: 'TickerSymbol' },
    'Whole.None': { Type: 'integer', Format: '0', MinValue: -2147483648, MaxValue: 2147483647, Precision: 0 },
    // Duration, time zone and language formats report the plain whole number type (captured).
    'Whole.Duration': { Type: 'integer', Format: '0', MinValue: -2147483648, MaxValue: 2147483647, Precision: 0 },
    'Whole.TimeZone': { Type: 'integer', Format: '0', MinValue: -2147483648, MaxValue: 2147483647, Precision: 0 },
    'Whole.Language': { Type: 'integer', Format: '0', MinValue: -2147483648, MaxValue: 2147483647, Precision: 0 },
    Decimal: { Type: 'decimal' },
    FP: { Type: 'double', MinValue: 0, MaxValue: 1000000000 },
    Currency: { Type: 'money', MinValue: -922337203685477, MaxValue: 922337203685477 },
    TwoOptions: { Type: 'boolean' },
    OptionSet: { Type: 'string', DefaultValue: undefined },
    MultiSelectOptionSet: { Type: 'string' },
    'DateAndTime.DateOnly': { Type: 'datetime', Format: 'date', Behavior: 2 },
    'DateAndTime.DateAndTime': { Type: 'datetime', Format: 'datetime', Behavior: 3 },
  };
  // The attributes of a column-bound property: the property name as display name, the column's logical name and
  // options, and the type's defaults, not the column's (the type's range and precision, Behavior 2 or 3 by the date
  // type whatever the column behaviour; captured). A type without its own entry uses the "1"
  // format (captured for SingleLine.URL) and the text defaults.
  // A text column reports its own maximum length up to 100, a longer column 100 (captured: a ticker column of 10
  // reports 10).
  const textMaxLength = (length) => (Number.isInteger(length) && length > 0 && length <= 100 ? length : 100);
  function fieldAttributes(spec, name, type) {
    const binding = spec.nativeBinding;
    const defaults = FIELD_TYPES[type] ?? { Type: type.startsWith('SingleLine.') ? 'string' : type };
    const options = ['TwoOptions', 'OptionSet', 'MultiSelectOptionSet'].includes(type)
      ? (binding.attributes?.Options ?? [])
      : null;
    return {
      DisplayName: name,
      LogicalName: binding.column?.logicalName ?? binding.attributes?.LogicalName ?? binding.id,
      Type: defaults.Type,
      IsSecured: binding.attributes?.IsSecured === true,
      // RequiredLevel is 0 also for an ApplicationRequired column (captured).
      RequiredLevel: 0,
      MinValue: defaults.MinValue ?? -100000000000,
      MaxValue: defaults.MaxValue ?? 100000000000,
      ImeMode: 0,
      MaxLength: defaults.MaxLength ?? textMaxLength(binding.attributes?.MaxLength),
      EntityLogicalName: '',
      Precision: defaults.Precision ?? 2,
      Format: defaults.Format ?? '1',
      TimeZoneByCode: {},
      Behavior: defaults.Behavior ?? 0,
      Targets: [],
      Options: options ? options.map((option) => ({ ...option })) : null,
      DefaultValue: Object.hasOwn(defaults, 'DefaultValue') ? defaults.DefaultValue : '',
    };
  }
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  // Dates without a zone are the wall clock of a date-only or time-zone-independent column (local time); dates with
  // one are instants.
  function fieldDate(text) {
    const value = String(text);
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return new Date(value);
    const parts = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
    if (!parts) return new Date(Number.NaN);
    const [, year, month, day, hour = 0, minute = 0, second = 0] = parts.map((item) => item ?? 0);
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  // The raw value of a column-bound property from the hidden input text, as the host converts it to the property
  // type: an empty column is "" (text), 0 (numbers), false (Two Options), null (choice, choices) or undefined
  // (dates); a value the type cannot hold is NaN with "Value is not a valid number" (numbers); a status (statecode)
  // column is null (captured).
  function fieldRaw(spec, text, type) {
    let value = null;
    if (text !== '' && text != null) value = JSON.parse(text);
    const empty = value == null || value === '';
    if (spec.nativeBinding.control === 'state') return { raw: null };
    if (/^(SingleLine\.|Multiple$)/.test(type)) return { raw: empty ? '' : String(value) };
    if (/^(Whole|Decimal|FP|Currency)/.test(type)) return fieldNumberRaw(value, empty);
    if (type === 'TwoOptions') return { raw: value === true || value === 1 || value === 'true' };
    if (type === 'OptionSet') return fieldOptionRaw(value, empty);
    if (type === 'MultiSelectOptionSet') return fieldChoicesRaw(value);
    if (type.startsWith('DateAndTime')) return fieldDateRaw(value, empty);
    return { raw: empty ? null : value };
  }
  function fieldNumberRaw(value, empty) {
    if (empty) return { raw: 0 };
    const number = typeof value === 'number' ? value : Number.NaN;
    return Number.isFinite(number) ? { raw: number } : { raw: Number.NaN, error: 'Value is not a valid number' };
  }
  function fieldOptionRaw(value, empty) {
    if (empty) return { raw: null };
    const option = typeof value === 'object' ? value.Value : value;
    return { raw: Number.isFinite(Number(option)) ? Number(option) : null };
  }
  function fieldChoicesRaw(value) {
    const items = Array.isArray(value) ? value : [];
    return { raw: items.length ? items.map((item) => Number(typeof item === 'object' ? item?.Value : item)) : null };
  }
  function fieldDateRaw(value, empty) {
    if (empty) return { raw: undefined };
    const date = value instanceof Date ? value : fieldDate(value);
    return { raw: Number.isFinite(date.getTime()) ? date : undefined };
  }
  // The display text the host gives a column-bound value (captured): whole, decimal and float numbers as plain text
  // ("34567", "1234.5"), currency as the number itself, option labels (choices each followed by ";"), Two Options by
  // their labels, dates "dd/MM/yyyy" or "dd/MM/yyyy HH:mm:ss" in the browser's time zone, null for no value.
  function fieldFormatted(raw, type, attributes) {
    if (raw == null) return null;
    const label = (value) =>
      (Array.isArray(attributes?.Options) ? attributes.Options : []).find(
        (option) => Number(option.Value) === Number(value),
      )?.Label;
    if (type === 'Currency') return raw;
    if (type === 'TwoOptions') return label(raw ? 1 : 0) ?? (raw ? 'Yes' : 'No');
    if (type === 'OptionSet') return label(raw) ?? String(raw);
    if (type === 'MultiSelectOptionSet')
      return Array.isArray(raw) ? raw.map((value) => (label(value) ?? String(value)) + ';').join('') : String(raw);
    if (type.startsWith('DateAndTime')) return fieldDateFormatted(raw, type);
    return String(raw);
  }
  function fieldDateFormatted(raw, type) {
    if (!(raw instanceof Date) || !Number.isFinite(raw.getTime())) return null;
    const day = `${pad(raw.getDate())}/${pad(raw.getMonth() + 1)}/${pad(raw.getFullYear(), 4)}`;
    return type === 'DateAndTime.DateOnly'
      ? day
      : `${day} ${pad(raw.getHours())}:${pad(raw.getMinutes())}:${pad(raw.getSeconds())}`;
  }
  // A field host parameter. Column-bound properties carry the column attributes and full security; every other
  // property (inputs, a FormXml binding of an input property or of another column) has no value unless the FormXml
  // sets a static one: raw null, or NaN with "Value is not a valid number" for a number type, formatted null,
  // attributes {} and security {}; the manifest default-value is not applied (captured).
  function fieldHostParameter(spec, property, type, hiddenText) {
    const binding = spec.nativeBinding;
    const parameter = {
      raw: null,
      formatted: null,
      type,
      attributes: {},
      security: {},
      error: false,
      errorMessage: null,
    };
    const number = /^(Whole|Decimal|FP|Currency)/.test(type);
    if ((binding.columnProperties ?? binding.properties ?? []).includes(property.name)) {
      parameter.attributes = fieldAttributes(spec, property.name, type);
      // The server models a column-secured field (lib/platform.mjs); the captured columns were not secured.
      parameter.security = {
        secured: binding.security?.secured === true,
        editable: binding.security?.editable !== false,
        readable: binding.security?.readable !== false,
      };
      if (!binding.properties?.includes(property.name)) return parameter;
      try {
        const { raw, error } = fieldRaw(spec, hiddenText, type);
        parameter.raw = raw;
        parameter.formatted = fieldFormatted(raw, type, parameter.attributes);
        if (error) Object.assign(parameter, { error: true, errorMessage: error });
      } catch (error) {
        Object.assign(parameter, { error: true, errorMessage: errorText(error) });
      }
      return parameter;
    }
    // A static FormXml input arrives converted by the server (lib/pcf-field-host.mjs nativeStaticValue): its raw
    // value as is, formatted null, attributes {} and security {} (captured). A date static
    // is typed from its text (LOCAL MODEL, unproven).
    const value = Object.hasOwn(spec.args, property.name) ? spec.args[property.name] : undefined;
    if (value == null || value === '') {
      if (number)
        Object.assign(parameter, { raw: Number.NaN, error: true, errorMessage: 'Value is not a valid number' });
      return parameter;
    }
    if (!type.startsWith('DateAndTime')) {
      parameter.raw = value;
      return parameter;
    }
    try {
      parameter.raw = typed(value, type, { property });
    } catch (error) {
      Object.assign(parameter, { error: true, errorMessage: errorText(error) });
    }
    return parameter;
  }
  // The hidden input text of an output (captured): JSON of the value, an option object
  // for a choice and an array of them for choices, a Date as its ISO instant; no value is "".
  function fieldHiddenText(raw, type, attributes) {
    if (raw == null) return '';
    const option = (value) => {
      const item = (Array.isArray(attributes?.Options) ? attributes.Options : []).find(
        (candidate) => Number(candidate.Value) === Number(value),
      );
      const label = item ? { Label: item.Label } : null;
      return {
        Value: Number(value),
        Label: { LocalizedLabels: label ? [label] : [], UserLocalizedLabel: label },
        Color: item?.Color ?? null,
      };
    };
    // An output of another type is written as it is (captured for Whole.None).
    if (type === 'OptionSet' && Number.isInteger(raw)) return JSON.stringify(option(raw));
    if (type === 'MultiSelectOptionSet' && Array.isArray(raw)) return JSON.stringify(raw.map(option));
    return JSON.stringify(raw);
  }
  // The bound native properties that an output batch would write. Throws on conflicting values.
  function nativeOutputProperties(spec, outputs) {
    const properties = (spec.nativeBinding?.properties ?? []).filter((name) => Object.hasOwn(outputs, name));
    if (properties.some((name) => JSON.stringify(outputs[name]) !== JSON.stringify(outputs[properties[0]])))
      throw new Error('PCF returned conflicting outputs for one native field');
    return properties;
  }
  // Writes a bound output into the hidden input. The host sets the value without an event: page scripts see no
  // change event, and only the form's dirty state is marked.
  function writeFieldOutput(spec, container, outputs, parameters) {
    const properties = nativeOutputProperties(spec, outputs);
    if (!properties.length) return;
    const field = nativeField(spec, container);
    const parameter = parameters[properties[0]];
    field.value = fieldHiddenText(outputs[properties[0]], parameter.type, parameter.attributes);
    if (typeof globalThis.setIsDirty === 'function') globalThis.setIsDirty(field.id);
  }
  // The page fetches the anti-forgery token once, before its first webAPI request, and reuses it; a
  // failed fetch is retried by the next request.
  let pageToken = null;
  function token() {
    pageToken ??= new Promise((resolve, reject) => {
      if (!globalThis.shell?.getTokenDeferred)
        return reject(new Error('PCF Web API requires the local portal CSRF token provider'));
      globalThis.shell.getTokenDeferred().done(resolve).fail(reject);
    }).catch((error) => {
      pageToken = null;
      throw error;
    });
    return pageToken;
  }
  function options(value) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || /[\r\n#]/.test(value))
      throw new Error('PCF Web API options must be an OData or FetchXML query');
    if (!value.startsWith('?') && /^[a-z][a-z\d+.-]*:|^\//i.test(value))
      throw new Error('PCF Web API queries cannot target a different URL');
    return value.startsWith('?') ? value : '?' + value;
  }
  function recordId(value) {
    const id = String(value ?? '').replace(/^\{|\}$/g, '');
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
      throw new Error('PCF Web API requires a record GUID');
    return id;
  }
  // PCF DataSet ConditionOperator values (the Microsoft.Xrm.Sdk.Query.ConditionOperator numbers) to the FetchXML
  // operator and its value form: none, one value, a list (one or more) or exactly two (pair). ChildOf (45), Contains
  // (49), DoesNotContain (50) and EqualRoleBusinessId (89) have no FetchXML condition operator. Operators the local
  // query engine does not evaluate (business unit, teams) are refused by it with their reason.
  const datasetOperators = new Map(
    Object.entries({
      0: ['eq', 'one'],
      1: ['ne', 'one'],
      2: ['gt', 'one'],
      3: ['lt', 'one'],
      4: ['ge', 'one'],
      5: ['le', 'one'],
      6: ['like', 'one'],
      7: ['not-like', 'one'],
      8: ['in', 'list'],
      9: ['not-in', 'list'],
      10: ['between', 'pair'],
      11: ['not-between', 'pair'],
      12: ['null', 'none'],
      13: ['not-null', 'none'],
      14: ['yesterday', 'none'],
      15: ['today', 'none'],
      16: ['tomorrow', 'none'],
      17: ['last-seven-days', 'none'],
      18: ['next-seven-days', 'none'],
      19: ['last-week', 'none'],
      20: ['this-week', 'none'],
      21: ['next-week', 'none'],
      22: ['last-month', 'none'],
      23: ['this-month', 'none'],
      24: ['next-month', 'none'],
      25: ['on', 'one'],
      26: ['on-or-before', 'one'],
      27: ['on-or-after', 'one'],
      28: ['last-year', 'none'],
      29: ['this-year', 'none'],
      30: ['next-year', 'none'],
      31: ['last-x-hours', 'one'],
      32: ['next-x-hours', 'one'],
      33: ['last-x-days', 'one'],
      34: ['next-x-days', 'one'],
      35: ['last-x-weeks', 'one'],
      36: ['next-x-weeks', 'one'],
      37: ['last-x-months', 'one'],
      38: ['next-x-months', 'one'],
      39: ['last-x-years', 'one'],
      40: ['next-x-years', 'one'],
      41: ['eq-userid', 'none'],
      42: ['ne-userid', 'none'],
      43: ['eq-businessid', 'none'],
      44: ['ne-businessid', 'none'],
      46: ['mask', 'one'],
      47: ['not-mask', 'one'],
      48: ['masks-select', 'one'],
      51: ['eq-userlanguage', 'none'],
      52: ['not-on', 'one'],
      53: ['olderthan-x-months', 'one'],
      54: ['begins-with', 'one'],
      55: ['not-begin-with', 'one'],
      56: ['ends-with', 'one'],
      57: ['not-end-with', 'one'],
      58: ['this-fiscal-year', 'none'],
      59: ['this-fiscal-period', 'none'],
      60: ['next-fiscal-year', 'none'],
      61: ['next-fiscal-period', 'none'],
      62: ['last-fiscal-year', 'none'],
      63: ['last-fiscal-period', 'none'],
      64: ['last-x-fiscal-years', 'one'],
      65: ['last-x-fiscal-periods', 'one'],
      66: ['next-x-fiscal-years', 'one'],
      67: ['next-x-fiscal-periods', 'one'],
      68: ['in-fiscal-year', 'one'],
      69: ['in-fiscal-period', 'one'],
      70: ['in-fiscal-period-and-year', 'pair'],
      71: ['in-or-before-fiscal-period-and-year', 'pair'],
      72: ['in-or-after-fiscal-period-and-year', 'pair'],
      73: ['eq-userteams', 'none'],
      74: ['eq-useroruserteams', 'none'],
      75: ['under', 'one'],
      76: ['not-under', 'one'],
      77: ['eq-or-under', 'one'],
      78: ['above', 'one'],
      79: ['eq-or-above', 'one'],
      80: ['eq-useroruserhierarchy', 'none'],
      81: ['eq-useroruserhierarchyandteams', 'none'],
      82: ['olderthan-x-years', 'one'],
      83: ['olderthan-x-weeks', 'one'],
      84: ['olderthan-x-days', 'one'],
      85: ['olderthan-x-hours', 'one'],
      86: ['olderthan-x-minutes', 'one'],
      87: ['contain-values', 'list'],
      88: ['not-contain-values', 'list'],
    }).map(([number, entry]) => [Number(number), entry]),
  );
  const datasetIdentifier = /^[a-z_][a-z\d_]*$/i;
  /** An own property of a binding object (never an Object.prototype member such as constructor). */
  const own = (object, key) => (object != null && Object.hasOwn(object, key) ? object[key] : undefined);
  /** A filter value as FetchXML text: dates as ISO 8601, Booleans as 1/0. */
  function datasetFilterValue(value) {
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new Error('PCF dataset filter date value is invalid');
      return value.toISOString();
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (value == null || typeof value === 'object')
      throw new Error('PCF dataset filter values must be strings, numbers, Booleans or dates');
    return String(value);
  }
  function datasetFilterCondition(xml, scope, condition, conditions) {
    if (++conditions.count > 500) throw new Error('PCF dataset filter exceeds 500 conditions');
    const number = condition.conditionOperator;
    const entry = datasetOperators.get(typeof number === 'string' ? Number(number) : number);
    if (!entry)
      throw new Error(
        'PCF dataset filter operator ' + number + ' is unsupported: it has no FetchXML condition operator',
      );
    const [operator, form] = entry;
    if (!scope.filterable(condition.attributeName, condition.entityAliasName || null))
      throw new Error('PCF dataset filter column/alias is unsupported: ' + condition.attributeName);
    const child = xml.createElement('condition');
    if (condition.entityAliasName) child.setAttribute('entityname', condition.entityAliasName);
    child.setAttribute('attribute', condition.attributeName);
    child.setAttribute('operator', operator);
    const values = condition.value;
    if (form === 'list' || form === 'pair') appendFilterValues(xml, child, operator, form, values);
    else if (form === 'one') {
      if (Array.isArray(values)) throw new Error('PCF dataset ' + operator + ' filters take one value, not an array');
      child.setAttribute('value', datasetFilterValue(values ?? ''));
    }
    return child;
  }
  // The <value> children of a list or pair condition.
  function appendFilterValues(xml, child, operator, form, values) {
    if (!Array.isArray(values) || !values.length || (form === 'pair' && values.length !== 2))
      throw new Error(
        'PCF dataset ' +
          operator +
          ' filters require ' +
          (form === 'pair' ? 'exactly two values' : 'an array of values'),
      );
    for (const value of values) {
      const item = xml.createElement('value');
      item.textContent = datasetFilterValue(value);
      child.append(item);
    }
  }
  function datasetFilterNode(xml, scope, expression, depth, conditions) {
    // At most 16 nested filter levels, the root included (pcf-grid-query.mjs refuses deeper filters).
    if (depth >= 16 || !expression || ![0, 1].includes(expression.filterOperator))
      throw new Error('PCF dataset filter has an unsupported structure');
    const node = xml.createElement('filter');
    node.setAttribute('type', expression.filterOperator === 1 ? 'or' : 'and');
    for (const condition of expression.conditions ?? [])
      node.append(datasetFilterCondition(xml, scope, condition, conditions));
    for (const child of expression.filters ?? [])
      node.append(datasetFilterNode(xml, scope, child, depth + 1, conditions));
    return node;
  }
  /** The value cells of one Web API row for a dataset column: raw value and its annotations. */
  function datasetCell(row, name) {
    const annotation = (suffix) => row['_' + name + '_value@' + suffix] ?? row[name + '@' + suffix];
    return {
      raw: row[name] ?? row['_' + name + '_value'] ?? null,
      target: annotation('Microsoft.Dynamics.CRM.lookuplogicalname'),
      formatted:
        row[name + '@OData.Community.Display.V1.FormattedValue'] ??
        row['_' + name + '_value@OData.Community.Display.V1.FormattedValue'],
    };
  }
  /** One entity reference of a lookup cell: the response's annotation or the column's single exported target. */
  function datasetReference(id, target, name, field, column) {
    const etn = target ?? (field.targets?.length === 1 ? field.targets[0] : null);
    if (!etn) throw new Error('PCF dataset lookup has no exported or response-provided target type: ' + column);
    return { id: { guid: String(id) }, etn: String(etn), name: String(name ?? id) };
  }
  /** A party list cell: every party as an entity reference (local model: the platform shape is not captured). */
  function datasetParties(cell, field, column) {
    const parties = Array.isArray(cell.raw) ? cell.raw : [cell.raw];
    return parties.map((party) => {
      if (party && typeof party === 'object') {
        const id = party.id?.guid ?? party.id ?? party.partyid;
        if (!id) throw new Error('PCF dataset party list entry has no party ID: ' + column);
        return datasetReference(
          id,
          party.etn ?? party.logical_name ?? party.entityType,
          party.name ?? party.formatted,
          field,
          column,
        );
      }
      return datasetReference(party, cell.target, cell.formatted, field, column);
    });
  }
  // Values of a native grid record attribute (entity-grid-data.json Records[].Attributes[]) as the Power Pages
  // dataset reports them (captured, "Record
  // values"): a choice is its value as a string, a multi-select its numbers, money its amount, a date a Date.
  function gridDate(value) {
    const ticks = /^\/Date\((-?\d+)\)\/$/.exec(String(value));
    return new Date(ticks ? Number(ticks[1]) : value);
  }
  function gridValue(attribute) {
    const value = attribute?.Value;
    if (value == null) return null;
    switch (attribute.Type) {
      case 'Microsoft.Xrm.Sdk.EntityReference':
        return { etn: value.LogicalName, id: { guid: value.Id }, name: value.Name };
      case 'Microsoft.Xrm.Sdk.OptionSetValue':
        return String(value.Value);
      case 'Microsoft.Xrm.Sdk.OptionSetValueCollection':
        return value.map((item) => item.Value);
      // A party list column arrives as an EntityCollection; the data set exposes null and '' for it (captured,
      // paqvilo-developer pcf-parity summary-F section 7, an activity list).
      case 'Microsoft.Xrm.Sdk.EntityCollection':
        return null;
      case 'Microsoft.Xrm.Sdk.Money':
        return value.Value;
      case 'System.DateTime':
        return gridDate(value);
      default:
        return value;
    }
  }
  // A date and time is formatted in the browser's zone ("3/15/2026 10:05 AM" for 14:05Z in New York); a
  // time-zone-independent value too, as if its wall time were UTC: the capture's surprising but observed behaviour.
  function gridLocalDateTime(date) {
    const hour = date.getHours() % 12 || 12;
    return (
      date.getMonth() +
      1 +
      '/' +
      date.getDate() +
      '/' +
      date.getFullYear() +
      ' ' +
      hour +
      ':' +
      String(date.getMinutes()).padStart(2, '0') +
      ' ' +
      (date.getHours() < 12 ? 'AM' : 'PM')
    );
  }
  function gridFormatted(attribute) {
    const value = attribute?.Value;
    if (value == null) return '';
    switch (attribute.Type) {
      case 'Microsoft.Xrm.Sdk.EntityCollection':
        return '';
      case 'Microsoft.Xrm.Sdk.EntityReference':
        return String(value.Name ?? attribute.FormattedValue ?? '');
      case 'Microsoft.Xrm.Sdk.OptionSetValueCollection':
        return String(attribute.DisplayValue ?? '');
      case 'System.Boolean':
      case 'System.Int32':
      case 'System.Int64':
      case 'System.Decimal':
      case 'System.Double':
        return String(value);
      case 'System.DateTime':
        // A date-only value keeps the service's date; a date and time is formatted in the browser's zone.
        return attribute.DateTimeFormat === 'DateOnly'
          ? String(attribute.FormattedValue ?? '')
          : gridLocalDateTime(gridDate(value));
      case 'Microsoft.Xrm.Sdk.OptionSetValue':
      case 'Microsoft.Xrm.Sdk.Money':
        return String(attribute.FormattedValue ?? '');
      default:
        return String(value);
    }
  }
  async function gridRequest(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        __RequestVerificationToken: await token(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error('PCF dataset grid service returned HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  const datasetCapabilities = () => ({
    canCreateNewRecords: true,
    canPaginate: true,
    isEditable: true,
    isFilterable: true,
    isSortable: true,
    hasRecordNavigation: false,
  });
  /**
   * A data set of the Power Pages host. `binding.transport` is "grid" (a list or subgrid: the native grid service),
   * "none" (the Liquid tag: no view, no rows, an error after the first load), "empty" (a list's or subgrid's other data
   * sets: no rows) or "webapi" (the local pcf.liquidDatasetBinding "view" binding through the portal Web API).
   * `updated(properties)` runs one updateView per completed load with the captured updatedProperties.
   */
  // Adds <attribute name="name"> to a FetchXML entity or link-entity node that does not select it yet.
  function ensureAttribute(xml, node, name) {
    if (
      !Array.from(node.children).some((child) => child.tagName === 'attribute' && child.getAttribute('name') === name)
    ) {
      const attribute = xml.createElement('attribute');
      attribute.setAttribute('name', name);
      node.append(attribute);
    }
  }
  // Dataset bindings come from selected solution views/table metadata, never from table-name guessing.
  function datasetAdapter(binding, api, updated, settled = () => {}) {
    const transport = binding.transport ?? 'webapi';
    let pageSize = binding.pageSize ?? 25,
      first = 1,
      last = 1,
      filter,
      selected = [],
      loaded = false,
      generation = 0;
    const linked = [],
      reasons = new Set(['Items']);
    let loadedSorting = JSON.stringify(binding.sorting ?? []);
    const prefix = binding.prefix ?? '';
    // The captured updatedProperties of a completed load: dataset, the reason (Items for the first load, sortorder,
    // filter, page, linking) and records; the Liquid tag's unbound data set omits records (and reports [] without a
    // reason); a data set other than the first prefixes every name with its own (second_dataset).
    const properties = () => {
      let names = ['dataset', ...reasons, 'records'];
      if (transport === 'none') names = reasons.size ? ['dataset', ...reasons] : [];
      return names.map((name) => prefix + name);
    };
    const linkOf = (alias) =>
      (binding.links ?? []).find((link) => link.alias === alias) ?? linked.find((link) => link.alias === alias);
    const fieldOf = (name, alias) => {
      if (alias == null) return own(binding.fields, name);
      const link = linkOf(alias);
      return link ? own(own(own(binding.tables, link.name), 'fields'), name) : undefined;
    };
    const columnField = (name) => {
      const parts = String(name).split('.');
      const field = parts.length === 2 ? fieldOf(parts[1], parts[0]) : own(binding.fields, name);
      return field ?? dataset.columns.find((item) => item.name === name);
    };
    const scope = {
      filterable: (name, alias) =>
        datasetIdentifier.test(String(name ?? '')) &&
        (alias == null
          ? dataset.columns.some((item) => item.name === name) || Boolean(own(binding.fields, name))
          : Boolean(fieldOf(name, alias))),
    };
    const unbound = () => {
      throw new TypeError("Cannot read properties of undefined (reading '0')");
    };
    const pagePosition = (from, to) => {
      first = from;
      last = to;
      dataset.paging.firstPageNumber = from;
      dataset.paging.lastPageNumber = to;
      dataset.paging.hasPreviousPage = from > 1;
    };
    const dataset = {
      columns: (binding.columns ?? []).map((item) => ({ ...item })),
      records: {},
      sortedRecordIds: [],
      sorting: (binding.sorting ?? []).map((item) => ({ ...item })),
      loading: true,
      error: false,
      errorCode: undefined,
      errorMessage: '',
      innerError: undefined,
      getTargetEntityType: () => binding.entity,
      getViewId: () => (transport === 'none' ? unbound() : binding.viewId),
      getTitle: () => (transport === 'none' ? unbound() : binding.viewName),
      getDataSetCapabilities: datasetCapabilities,
      // A list's and a subgrid's data set has aggregation and grouping with get, add, remove and clear, and
      // getAggregations() and getGroupBys() answer [] (captured, paqvilo-developer pcf-parity summary-F section 4,
      // runs fc and fd). What add and remove change is not captured: they change nothing here.
      aggregation: {
        getAggregations: () => [],
        addAggregation: () => undefined,
        removeAggregation: () => undefined,
        clear: () => undefined,
      },
      grouping: {
        getGroupBys: () => [],
        addGroupBy: () => undefined,
        removeGroupBy: () => undefined,
        clear: () => undefined,
      },
      getSelectedRecordIds: () => [...selected],
      // Selection never runs updateView.
      setSelectedRecordIds(ids) {
        if (!Array.isArray(ids)) throw new Error('PCF dataset selection requires an array of record IDs');
        // Before the first page loads (a control restoring its selection in init) every valid id is kept and the
        // load prunes it; afterwards only records of the current page can be selected, with the page's record key.
        const keys = new Map(Object.keys(dataset.records).map((key) => [key.toLowerCase(), key]));
        selected = [
          ...new Set(ids.map((id) => (loaded ? keys.get(recordId(id).toLowerCase()) : recordId(id))).filter(Boolean)),
        ];
      },
      clearSelectedRecordIds() {
        selected = [];
      },
      newRecord: () => Promise.reject(new TypeError("Cannot read properties of null (reading 'getRecordId')")),
      filtering: {
        getFilter: () => (filter == null ? filter : JSON.parse(JSON.stringify(filter))), // NOSONAR: JSON round trip semantics differ from structuredClone
        setFilter(value) {
          const serialized = JSON.stringify(value);
          if (serialized.length > 65536) throw new Error('PCF dataset filter exceeds 64 KiB');
          filter = JSON.parse(serialized);
          reasons.add('filter');
          pagePosition(1, 1);
        },
        clearFilter() {
          filter = null;
          reasons.add('filter');
          pagePosition(1, 1);
        },
      },
      linking: {
        // Only links the control added: the view's own link-entities are not listed.
        getLinkedEntities: () => linked.map((link) => ({ ...link })),
        addLinkedEntity(expression) {
          const link = {
            name: expression?.name,
            from: expression?.from,
            to: expression?.to,
            linkType: expression?.linkType ?? 'inner',
            alias: expression?.alias,
          };
          if (transport !== 'none' && transport !== 'empty') {
            const table = typeof link.name === 'string' ? own(binding.tables, link.name) : undefined;
            if (
              !table ||
              ![link.from, link.to, link.alias].every((value) => datasetIdentifier.test(String(value ?? ''))) ||
              !['inner', 'outer'].includes(link.linkType) ||
              !(own(table.fields, link.from) || link.from === table.idColumn) ||
              !(own(binding.fields, link.to) || link.to === binding.idColumn)
            )
              throw new Error(
                'PCF dataset links need an exported table with a Web API mapping, its from column, a column of ' +
                  binding.entity +
                  ', an alias and an inner or outer link type',
              );
            if (linkOf(link.alias)) throw new Error('PCF dataset link alias is already used: ' + link.alias);
          }
          linked.push(link);
          reasons.add('linking');
        },
      },
      paging: {
        hasNextPage: false,
        hasPreviousPage: false,
        totalResultCount: -1,
        pageSize,
        firstPageNumber: 1,
        lastPageNumber: 1,
        setPageSize(value) {
          if (!Number.isInteger(value) || value < 1 || value > 5000)
            throw new Error('PCF dataset page size must be between 1 and 5000');
          pageSize = value;
          dataset.paging.pageSize = value;
          pagePosition(1, 1);
        },
        // Paging follows the capture literally: loadNextPage() loads only the next page but
        // keeps firstPageNumber, so hasPreviousPage stays false; loadNextPage(true) moves both numbers.
        loadNextPage(loadOnlyNewPage) {
          if (!dataset.paging.hasNextPage && transport !== 'none') return;
          pagePosition(loadOnlyNewPage === true ? last + 1 : first, last + 1);
          reasons.add('page');
          return load(last);
        },
        // The captured call requests the same page again, from page 2 or 3 too: only reset()
        // returns to page 1.
        loadPreviousPage() {
          reasons.add('page');
          return load(last);
        },
        loadExactPage(value) {
          if (!Number.isInteger(value) || value < 1 || value > 100000)
            throw new Error('PCF dataset page number is invalid');
          pagePosition(value, value);
          reasons.add('page');
          return load(value);
        },
        reset() {
          pagePosition(1, 1);
          reasons.add('page');
          return load(1);
        },
      },
      refresh() {
        pagePosition(1, 1);
        return load(1);
      },
      addColumn(name, entityAlias) {
        const qualified = entityAlias == null ? name : entityAlias + '.' + name;
        if (transport === 'none' || transport === 'empty') return;
        const field = typeof name === 'string' && datasetIdentifier.test(name) ? fieldOf(name, entityAlias) : undefined;
        if (!field) throw new Error('PCF dataset column has no exported definition: ' + qualified);
        if (dataset.columns.some((item) => item.name === qualified)) return;
        const order = Math.max(0, ...dataset.columns.map((item) => Number(item.order) || 0)) + 1;
        dataset.columns.push({
          name: qualified,
          displayName: field.label ?? qualified,
          dataType: field.dataType ?? 'unknown',
          alias: qualified,
          order,
          visualSizeFactor: 1,
        });
      },
      // Lists and subgrids return undefined and do not navigate, even with a details page.
      openDatasetItem(reference) {
        if (transport === 'grid' || transport === 'empty') return undefined;
        throw new Error(
          'PCF dataset record navigation requires a portal page/form binding; the view alone does not supply it: ' +
            String(reference?.etn ?? ''),
        );
      },
    };
    // The pcfFilter member: the FetchXML <filter> the platform posts, its percent signs as &#37;.
    function filterXml() {
      if (filter == null) return '';
      const xml = document.implementation.createDocument(null, 'fetch', null);
      return new XMLSerializer()
        .serializeToString(datasetFilterNode(xml, scope, filter, 0, { count: 0 }))
        .replaceAll('%', '&#37;');
    }
    // The sortExpression member: the first ascending or descending sorting column (one column; '' without one).
    function sortExpression() {
      const sort = (Array.isArray(dataset.sorting) ? dataset.sorting : []).find((item) =>
        [0, 1].includes(item?.sortDirection),
      );
      if (!sort) return '';
      return String(sort.name) + (sort.sortDirection === 1 ? ' DESC' : ' ASC');
    }
    function applySorting(xml, fetch, entity) {
      // The view's own order stays exact (link-entity orders included) until the control changes the sorting; then
      // the control's sorting replaces every order, and a None (-1) entry adds none.
      if (JSON.stringify(dataset.sorting) === JSON.stringify(binding.sorting ?? [])) return;
      if (!Array.isArray(dataset.sorting)) throw new Error('PCF dataset sorting must be an array');
      for (const node of Array.from(fetch.getElementsByTagName('order'))) node.remove();
      for (const sort of dataset.sorting) {
        if (sort?.sortDirection === -1) continue;
        const parts = String(sort?.name ?? '').split('.');
        if (
          parts.length > 2 ||
          !(dataset.columns.some((item) => item.name === sort.name) || columnField(sort.name)) ||
          ![0, 1].includes(sort.sortDirection)
        )
          throw new Error('PCF dataset sorting requires an exported column and a none/ascending/descending direction');
        const node = xml.createElement('order');
        if (parts.length === 2) node.setAttribute('entityname', parts[0]);
        node.setAttribute('attribute', parts.at(-1));
        node.setAttribute('descending', String(sort.sortDirection === 1));
        entity.append(node);
      }
    }
    function linkNodes(xml, entity) {
      const nodes = new Map(
        Array.from(xml.getElementsByTagName('link-entity')).map((node) => [node.getAttribute('alias'), node]),
      );
      for (const link of linked) {
        const node = xml.createElement('link-entity');
        node.setAttribute('name', link.name);
        node.setAttribute('from', link.from);
        node.setAttribute('to', link.to);
        node.setAttribute('link-type', link.linkType);
        node.setAttribute('alias', link.alias);
        entity.append(node);
        nodes.set(link.alias, node);
      }
      return nodes;
    }
    // The local Web API binding's request (pcf.liquidDatasetBinding "view").
    function query(page) {
      const xml = new DOMParser().parseFromString(binding.fetchXml, 'text/xml');
      const fetch = xml.documentElement,
        entity = Array.from(fetch.children).find((node) => node.tagName === 'entity');
      if (
        xml.querySelector('parsererror') ||
        fetch.tagName !== 'fetch' ||
        entity?.getAttribute('name') !== binding.entity
      )
        throw new Error('PCF dataset exported FetchXML does not match its table binding');
      if (fetch.getAttribute('aggregate') === 'true' || fetch.hasAttribute('top'))
        throw new Error('PCF dataset record host does not support aggregate or top-limited views');
      fetch.removeAttribute('paging-cookie');
      fetch.setAttribute('count', String(pageSize));
      fetch.setAttribute('page', String(page));
      fetch.setAttribute('returntotalrecordcount', 'true');
      // Records are keyed by the primary key, which is queried whether or not the layout shows it.
      ensureAttribute(xml, entity, binding.idColumn);
      if (binding.queryNameColumn && datasetIdentifier.test(binding.nameColumn ?? ''))
        ensureAttribute(xml, entity, binding.nameColumn);
      const links = linkNodes(xml, entity);
      for (const item of dataset.columns) {
        if (item.name == null) continue;
        const parts = item.name.split('.');
        if (parts.length === 1 && datasetIdentifier.test(item.name)) ensureAttribute(xml, entity, item.name);
        else if (parts.length === 2 && links.has(parts[0]) && datasetIdentifier.test(parts[1]))
          ensureAttribute(xml, links.get(parts[0]), parts[1]);
      }
      applySorting(xml, fetch, entity);
      if (filter != null) entity.append(datasetFilterNode(xml, scope, filter, 0, { count: 0 }));
      return '?fetchXml=' + encodeURIComponent(new XMLSerializer().serializeToString(xml));
    }
    function webApiRecord(row, id) {
      const rawValue = (name) => {
        const cell = datasetCell(row, name),
          field = columnField(name);
        if (cell.raw == null || !field?.dataType) return cell.raw;
        if (/^(Lookup\.PartyList|partylist)$/.test(field.dataType)) return datasetParties(cell, field, name);
        if (/^(Lookup\.|lookup$|customer$|owner$)/.test(field.dataType))
          return datasetReference(cell.raw, cell.target, cell.formatted, field, name);
        // The column's date behaviour reaches the typed conversion (typed(value, type, { behavior })).
        return typed(cell.raw, field.dataType, { behavior: field.dateTimeBehavior });
      };
      return {
        getRecordId: () => String(id),
        getNamedReference: () => ({
          id: { guid: String(id) },
          etn: binding.entity,
          name: String(row[binding.nameColumn] ?? ''),
        }),
        getValue: (name) => rawValue(name),
        getFormattedValue: (name) => {
          const cell = datasetCell(row, name);
          return String(cell.formatted ?? cell.raw ?? '');
        },
        isDirty: () => false,
        isValid: () => true,
        setValue() {
          throw new Error(
            'PCF dataset records are read-only in this adapter; use context.webAPI.updateRecord for explicit local CRUD',
          );
        },
        save() {
          return Promise.reject(
            new Error(
              'PCF dataset record save is unsupported; use context.webAPI.updateRecord for explicit local CRUD',
            ),
          );
        },
      };
    }
    // A native grid record: getNamedReference names the entity set and
    // the table's logical name; a list record keeps JSON-encoded changes and saves them through the grid update
    // service; a subgrid record's setValue throws as the platform's does.
    function gridRecord(entry) {
      const id = String(entry.Id);
      const attributes = new Map((entry.Attributes ?? []).map((attribute) => [attribute.Name, attribute]));
      const changes = {};
      const recordObject = {
        getRecordId: () => id,
        getNamedReference: () => ({ etn: binding.entitySet, id: { guid: id }, name: binding.entity }),
        getValue: (name) => gridValue(attributes.get(name)),
        getFormattedValue: (name) => gridFormatted(attributes.get(name)),
        isDirty: () => Object.keys(changes).length > 0,
        isValid: () => true,
        getChanges: () => ({ ...changes }),
        setValue(name, value) {
          if (binding.kind !== 'list') throw new TypeError("Cannot read properties of null (reading 'isValid')");
          if (!datasetIdentifier.test(String(name)) || !own(binding.fields, name))
            return Promise.reject(new Error('PCF dataset column has no exported definition: ' + name));
          changes[name] = JSON.stringify(value === undefined ? null : value);
          return Promise.resolve();
        },
        save() {
          if (binding.kind !== 'list') return undefined;
          // The record stays dirty after the save, as captured (isRecordDirty true on the saved record).
          // The captured body { Id, EntityName, Attributes }; the signed list configuration is Mirage's
          // own addition that scopes the save to the bound list.
          return gridRequest(binding.update, {
            Id: id,
            EntityName: binding.entity,
            Attributes: Object.entries(changes).map(([Name, Value]) => ({ Name, Value })),
            base64SecureConfiguration: binding.secure,
          }).then(() => recordObject);
        },
      };
      return recordObject;
    }
    async function fetchPage(page) {
      if (transport === 'none') unbound();
      // A list's other data set posts the same grid with an empty sortExpression and a null search, and shows no rows.
      if (transport === 'empty') {
        if (binding.service)
          await gridRequest(binding.service, {
            base64SecureConfiguration: binding.secure,
            sortExpression: '',
            search: null,
            page,
            pageSize,
            pcfFilter: '',
            timezoneOffset: new Date().getTimezoneOffset(),
            entityName: binding.entity,
          });
        return { rows: [], total: -1, more: false };
      }
      if (transport === 'grid') {
        // The captured request members; added columns and links are not sent, so their values
        // stay empty unless the view has them.
        const result = await gridRequest(binding.service, {
          base64SecureConfiguration: binding.secure,
          sortExpression: sortExpression(),
          search: '',
          page,
          pageSize,
          pcfFilter: filterXml(),
          timezoneOffset: new Date().getTimezoneOffset(),
          entityName: binding.entity,
          ...(binding.kind === 'subgrid' ? { entityId: binding.context?.entityId } : {}),
        });
        // A visitor without read permission: the service answers 200 { AccessDenied: true }.
        if (result.AccessDenied) return { denied: true };
        return {
          rows: (result.Records ?? []).map((entry) => ({ id: entry.Id, record: gridRecord(entry) })),
          total: Number.isInteger(result.ItemCount) ? result.ItemCount : -1,
          more: Boolean(result.MoreRecords),
          // The service's own page size (it caps what a request asks for); never the requested one.
          pageSize: Number.isInteger(result.PageSize) && result.PageSize > 0 ? result.PageSize : undefined,
          paged: true,
        };
      }
      const { result } = await api(binding.entity, query(page), 'GET');
      return {
        rows: (result.value ?? []).map((row) => {
          const id = row[binding.idColumn];
          if (!id) throw new Error('PCF dataset response omitted its primary record ID');
          return { id, record: webApiRecord(row, id) };
        }),
        total: result['@odata.count'] ?? result['@Microsoft.Dynamics.CRM.totalrecordcount'] ?? -1,
        more: false,
        limited: Boolean(result['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded']),
      };
    }
    // The records and paging of a loaded page.
    function applyLoadedPage(result) {
      const records = {},
        ids = [];
      for (const { id, record } of result.rows) {
        // Records are keyed by the primary key: a one-to-many link that repeats a record keeps its first row.
        if (Object.hasOwn(records, id)) continue;
        ids.push(String(id));
        records[id] = record;
      }
      dataset.records = records;
      dataset.sortedRecordIds = ids;
      const size = result.pageSize ?? pageSize;
      let hasNextPage;
      if (result.paged) hasNextPage = result.more;
      else if (result.total >= 0 && !result.limited) hasNextPage = last * size < result.total;
      else hasNextPage = result.more || ids.length === size;
      Object.assign(dataset.paging, { totalResultCount: result.total, pageSize: size, hasNextPage });
    }
    async function load(page = 1) {
      const revision = ++generation;
      // A load starts without an updateView: the platform runs one updateView when it completes.
      dataset.loading = true;
      const sorting = JSON.stringify(dataset.sorting);
      if (sorting !== loadedSorting) reasons.add('sortorder');
      try {
        const result = await fetchPage(page);
        if (revision !== generation) return;
        if (result.denied) {
          // The platform's data set then stays loading with no records, no error and no updateView.
          dataset.records = {};
          dataset.sortedRecordIds = [];
          Object.assign(dataset.paging, { totalResultCount: -1, hasNextPage: false });
          Object.assign(dataset, { error: false, errorMessage: '', errorCode: undefined });
          reasons.clear();
          settled('denied');
          return;
        }
        applyLoadedPage(result);
        dataset.error = false;
        dataset.errorMessage = '';
        dataset.errorCode = undefined;
      } catch (error) {
        if (revision !== generation) return;
        // A grid service failure (HTTP 500 for a filter the server cannot evaluate) runs no updateView.
        if (error.status >= 500) {
          reasons.clear();
          settled('failed');
          return;
        }
        dataset.records = {};
        dataset.sortedRecordIds = [];
        dataset.error = true;
        dataset.errorMessage = error.message;
        dataset.errorCode = error.errorCode;
        dataset.paging.hasNextPage = false;
      } finally {
        if (revision === generation) {
          loaded = true;
          loadedSorting = sorting;
          // A selected record the reloaded page no longer holds leaves the selection.
          selected = selected
            .map((id) => Object.keys(dataset.records).find((key) => key.toLowerCase() === id.toLowerCase()))
            .filter(Boolean);
        }
      }
      if (revision !== generation) return;
      dataset.loading = false;
      const names = properties();
      reasons.clear();
      updated(names);
      settled('loaded');
    }
    return { dataset, load: () => load(1) };
  }
  function controlConstructor(spec) {
    let Constructor =
      constructors.get(spec.constructor) ||
      spec.constructor.split('.').reduce((value, key) => value?.[key], globalThis);
    if (!Constructor) {
      const exportName = spec.constructor.split('.').at(-1);
      const candidates = [
        ...new Set(
          spec.resources
            .filter((item) => item.kind === 'code' && item.exportGlobal)
            .map((item) => Object.getOwnPropertyDescriptor(globalThis, item.exportGlobal)?.value?.[exportName])
            .filter((item) => typeof item === 'function'),
        ),
      ];
      if (candidates.length > 1)
        throw new Error('The declared PCF resources expose ambiguous constructor exports: ' + spec.constructor);
      Constructor = candidates[0];
    }
    // A development build loads its modules with eval, which a confined page's script policy refuses (as the model-driven host says).
    if (typeof Constructor !== 'function')
      throw new Error(
        'The PCF bundle did not register ' +
          spec.constructor +
          '. A development build that loads its modules with eval is refused by the page script policy: build the control in production mode.' +
          ' The page loads declared code resources as classic scripts, so an ES module bundle (import or export declarations) cannot register either (PCF_CODE_RESOURCE_MODULE).',
      );
    return Constructor;
  }
  // Attributes of an input/static (or unbound) property come from its manifest declaration. LogicalName (the
  // property name) and an empty Options list are the earlier local values (local model).
  function baseInputAttributes(spec, property) {
    return {
      DisplayName: spec.strings[property['display-name-key']] ?? property['display-name-key'] ?? property.name,
      LogicalName: property.name,
      RequiredLevel: [true, 'true', 1, '1'].includes(property.required) ? 1 : 0,
      Options: [],
    };
  }
  function inputAttributes(spec, property, type) {
    const text = (key) => (key ? (spec.strings[key] ?? key) : undefined);
    const attributes = baseInputAttributes(spec, property);
    const description = text(property['description-key']);
    if (description !== undefined) attributes.Description = description;
    if (type === 'Enum' && enumValues(property))
      attributes.Options = enumValues(property).map((item) => {
        const value = item?.value ?? item?.text ?? item;
        return {
          Label: text(item?.['display-name-key']) ?? String(item?.name ?? value),
          Value: typedEnum(value, property),
        };
      });
    return attributes;
  }
  // On the field host a type-group property takes the first type of its group (the server resolves bound ones).
  function parameterType(spec, property) {
    if (spec.nativeBinding)
      return property['of-type'] || spec.nativeBinding.propertyTypes?.[property.name] || property.types?.[0];
    return property['of-type'] || groupType(property.types);
  }
  // A parameter of a host other than the Liquid tag and the field host. An invalid static or default value, or a
  // malformed Enum declaration, is the parameter's error; the control still mounts.
  function inputParameter(spec, property, type) {
    const parameter = {
      raw: null,
      formatted: '',
      type,
      attributes: baseInputAttributes(spec, property),
      security: { readable: true, editable: true, secured: false },
      error: false,
      errorMessage: '',
    };
    try {
      parameter.attributes = inputAttributes(spec, property, type);
      parameter.raw = typed(
        spec.args[property.name] ?? spec.args[property.name.toLowerCase()] ?? property['default-value'] ?? null,
        type,
        { property, behavior: parameter.attributes.Behavior },
      );
      parameter.formatted = formatParameter(parameter.raw, type, parameter.attributes);
    } catch (error) {
      parameter.error = true;
      parameter.errorMessage = errorText(error);
    }
    return parameter;
  }
  // One manifest property as a parameter; a bound or output property is writable. A Liquid parameter left out (a
  // missing or invalid date) is neither.
  function addControlParameter(spec, property, { parameters, writable, hiddenText }) {
    const type = parameterType(spec, property);
    if (!type) throw new Error('PCF property ' + property.name + ' has an ambiguous type-group binding');
    const writes = property.usage === 'bound' || property.usage === 'output';
    if (spec.host === 'liquid') {
      const parameter = liquidParameter(spec, property, type);
      if (!parameter) return;
      parameters[property.name] = parameter;
      if (writes) writable.add(property.name);
      return;
    }
    if (writes) writable.add(property.name);
    parameters[property.name] = spec.nativeBinding
      ? fieldHostParameter(spec, property, type, hiddenText)
      : inputParameter(spec, property, type);
  }
  function controlParameters(spec, debug, container) {
    const parameters = {},
      writable = new Set();
    debug.parameters = parameters;
    debug.editableParameters = spec.properties
      .filter((property) => property.usage !== 'output')
      .map((property) => property.name);
    // The field host reads the column value from the field's hidden input (lib/platform.mjs renders it).
    const hiddenText = spec.nativeBinding ? nativeField(spec, container).value : null;
    for (const property of spec.properties) addControlParameter(spec, property, { parameters, writable, hiddenText });
    if (spec.host !== 'liquid' && spec.host !== 'field') return { parameters, writable };
    const ordered = withHostSystemParameters(spec, parameters);
    debug.parameters = ordered;
    return { parameters: ordered, writable };
  }
  // The two parameters the Power Pages field and Liquid hosts add to every control: labelForPrefix before and
  // deviceSizeMode after the manifest properties (captured). Both hosts
  // call this one helper with their manifest parameters in declaration order.
  function withHostSystemParameters(spec, parameters) {
    const controlName = spec.constructor.split('.').at(-1);
    return {
      labelForPrefix: {
        type: '',
        raw: controlName + '-' + controlName + '-' + controlName,
        error: false,
        errorMessage: '',
        security: null,
      },
      ...parameters,
      deviceSizeMode: {
        raw: 0,
        formatted: '0',
        attributes: {
          ...liquidBoundAttributes('deviceSizeMode', 'Whole.None'),
          LogicalName: 'deviceSizeMode',
          MinValue: 0,
          MaxValue: 100,
          TimeZoneByCode: null,
          Options: [],
          DefaultValue: 0,
        },
        type: 'Whole.None',
        error: false,
        errorMessage: null,
        notifications: null,
        security: { secured: false, editable: true, readable: true },
      },
    };
  }
  function randomGuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  // Attributes of a bound Liquid-tag property (captured for SingleLine.Text: the property name as display name, a
  // fresh GUID as logical name). Type and Format of the other PCF types are not captured yet.
  function liquidBoundAttributes(name, type) {
    const text = type.startsWith('SingleLine.') || type === 'Multiple';
    return {
      DisplayName: name,
      LogicalName: randomGuid(),
      Type: text ? 'string' : type,
      IsSecured: false,
      RequiredLevel: 0,
      MinValue: -100000000000,
      MaxValue: 100000000000,
      ImeMode: 0,
      MaxLength: 100,
      EntityLogicalName: '',
      Precision: 2,
      Format: text ? (type.split('.')[1] ?? 'Text') : '1',
      LanguageByCode: { 1033: 'English (United States)', '-1': 'All Languages' },
      TimeZoneByCode: {},
      Behavior: 0,
      Targets: [],
      Options: null,
      DefaultValue: '',
      lastUpdatedField: null,
      lastUpdatedValue: null,
      rollupStateField: null,
      rollupStateValue: 0,
      calculatedFieldValid: false,
      rollupValid: false,
      SourceType: null,
      recalculate: () => undefined,
    };
  }
  // A Liquid-tag parameter from the server's ControlProperties value (captured): names match case-sensitively, manifest defaults are not used,
  // inputs carry formatted null, attributes {} and security {}; a missing number is NaN with an error; a missing or
  // invalid date leaves the parameter out. Types the capture did not cover keep the local typed() conversion.
  function liquidParameter(spec, property, type) {
    const present = Object.hasOwn(spec.args ?? {}, property.name);
    const value = present ? spec.args[property.name] : undefined;
    const bound = property.usage === 'bound';
    const parameter = {
      raw: null,
      formatted: null,
      attributes: bound ? liquidBoundAttributes(property.name, type) : {},
      type,
      error: false,
      errorMessage: null,
      notifications: null,
      security: bound ? { secured: false, editable: true, readable: true } : {},
    };
    if (type.startsWith('DateAndTime.')) {
      const date = liquidDateRaw(present, value);
      if (!date) return null;
      parameter.raw = date;
    } else setLiquidRaw(parameter, { present, value, type, property });
    if (bound) parameter.formatted = parameter.raw == null ? null : formatParameter(parameter.raw, type, {});
    return parameter;
  }
  // A Liquid date argument as a Date, or null when it is missing or invalid (the parameter is then left out). The
  // server sends a date-only value as local midnight ("2026-03-15T00:00:00"); a bare date reads the same.
  function liquidDateRaw(present, value) {
    if (!present || value == null || value === '') return null;
    const text = String(value);
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? text + 'T00:00:00' : text);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  // The raw value (and error) of a Liquid parameter other than a date.
  function setLiquidRaw(parameter, { present, value, type, property }) {
    if (/^(Whole\.|Decimal$|FP$|Currency$)/.test(type)) setLiquidNumber(parameter, present, value);
    else if (type === 'TwoOptions') parameter.raw = liquidTwoOptionsRaw(value, parameter.raw);
    else if (type === 'Enum' || type.startsWith('SingleLine.') || type === 'Multiple')
      parameter.raw = present && value != null ? String(value) : null;
    else setLiquidTyped(parameter, present ? value : null, type, property);
  }
  // A missing number is NaN with an error.
  function setLiquidNumber(parameter, present, value) {
    const number = present && value !== null && value !== '' ? Number(value) : Number.NaN;
    parameter.raw = number;
    if (!Number.isFinite(number)) {
      parameter.error = true;
      parameter.errorMessage = 'Value is not a valid number';
    }
  }
  // Types the capture did not cover keep the local typed() conversion; a value it refuses is the parameter's error.
  function setLiquidTyped(parameter, value, type, property) {
    try {
      parameter.raw = typed(value, type, { property });
    } catch (error) {
      parameter.error = true;
      parameter.errorMessage = errorText(error);
    }
  }
  function liquidTwoOptionsRaw(value, fallback) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fallback;
  }
  function pcfEntitySet(spec, name) {
    const mapping = spec.mappings[String(name).toLowerCase()];
    if (!mapping || !/^[a-z_][a-z\d_]*$/i.test(mapping.entitySet))
      throw new Error('PCF Web API table has no imported mapping: ' + name);
    return mapping.entitySet;
  }
  // The host's webAPI requests (headers carrying pcf-entity-logical-name) address the table by its logical name
  // (captured, paqvilo-developer pcf-parity summary-A and summary-F section 1); the local Liquid view binding reads
  // through the entity set name of the imported mapping.
  function pcfSegment(spec, name, headers) {
    const logical = headers['pcf-entity-logical-name'];
    if (logical === undefined) return pcfEntitySet(spec, name);
    if (!/^[a-z_][a-z\d_]*$/.test(logical)) throw new Error('PCF Web API needs a table logical name: ' + name);
    return logical;
  }
  async function pcfApi(spec, name, suffix, method, body, extraHeaders = {}) {
    const headers = {
      // A read sends accept */* with content-type application/json and the anti-forgery token (captured,
      // paqvilo-developer pcf-parity summary-F section 1); the headers of a write are not captured.
      Accept: method === 'GET' ? '*/*' : 'application/json',
      'Content-Type': 'application/json',
      __RequestVerificationToken: await token(),
      ...extraHeaders,
    };
    const response = await fetch('/_api/' + pcfSegment(spec, name, headers) + suffix, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error('PCF Web API returned a non-JSON response (HTTP ' + response.status + ')'), {
        status: response.status,
      });
    }
    if (!response.ok) {
      const error = new Error(result.error?.message || 'PCF Web API HTTP ' + response.status);
      error.errorCode = result.error?.code;
      error.status = response.status;
      throw error;
    }
    return {
      result,
      id:
        response.headers.get('entityid') || /\(([0-9a-f-]+)\)/i.exec(response.headers.get('OData-EntityId') || '')?.[1],
    };
  }
  // ---- Power Pages PCF context surface ----
  // The Power Pages field, Liquid and subgrid hosts expose the Unified Interface control framework context: the same
  // namespaces, members (own or on the prototype) and arities as the capture of 2026-11-26 (basic form,
  // Liquid tag). Members whose behaviour was captured follow it, quirks included; the others follow the documented PCF
  // semantics on the local portal and are recorded in inspect().hostCalls as not yet captured.
  const PCF_APP_ID = '047efa7c-0976-e711-8104-000d3aa167ac';
  // .NET (Windows NLS) en-US culture data the platform sends (captured field for field).
  const EN_US_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const EN_US_MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
    '',
  ];
  const EN_US_PATTERNS = {
    FullDateTimePattern: 'dddd, MMMM dd, yyyy h:mm:ss tt',
    LongDatePattern: 'dddd, MMMM dd, yyyy',
    LongTimePattern: 'h:mm:ss tt',
    MonthDayPattern: 'MMMM dd',
    ShortDatePattern: 'M/d/yyyy',
    ShortTimePattern: 'h:mm tt',
    YearMonthPattern: 'MMMM, yyyy',
  };
  const NUMBER_NEGATIVE_PATTERNS = ['(n)', '-n', '- n', 'n-', 'n -'];
  const CURRENCY_POSITIVE_PATTERNS = ['$n', 'n$', '$ n', 'n $'];
  const CURRENCY_NEGATIVE_PATTERNS = [
    '($n)',
    '-$n',
    '$-n',
    '$n-',
    '(n$)',
    '-n$',
    'n-$',
    'n$-',
    '-n $',
    '-$ n',
    'n $-',
    '$ n-',
    '$ -n',
    'n- $',
    '($ n)',
    '(n $)',
    '$- n',
  ];
  // The short date pattern of a page culture as Intl (ICU CLDR) gives it, with a four-digit year: the culture's day,
  // month and year order, widths and separators (de-DE dd.MM.yyyy, en-US M/d/yyyy).
  const CULTURE_SAMPLE = new Date(Date.UTC(2026, 0, 5));
  const SHORT_DATE_TOKENS = {
    year: () => 'yyyy',
    month: (value) => (value.length === 2 ? 'MM' : 'M'),
    day: (value) => (value.length === 2 ? 'dd' : 'd'),
  };
  // A language Intl does not know keeps the fallback pattern.
  function cultureShortDatePattern(locale, fallback) {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' })
        .formatToParts(CULTURE_SAMPLE)
        .map(({ type, value }) => {
          if (Object.hasOwn(SHORT_DATE_TOKENS, type)) return SHORT_DATE_TOKENS[type](value);
          return /[A-Za-z]/.test(value) ? `'${value}'` : value;
        })
        .join('');
    } catch {
      return fallback;
    }
  }
  function enUsCulture() {
    return {
      dateTimeFormat: {
        AMDesignator: 'AM',
        DateSeparator: '/',
        FirstDayOfWeek: 0,
        CalendarWeekRule: 0,
        ...EN_US_PATTERNS,
        PMDesignator: 'PM',
        TimeSeparator: ':',
        AbbreviatedDayNames: EN_US_DAYS.map((name) => name.slice(0, 3)),
        ShortestDayNames: EN_US_DAYS.map((name) => name.slice(0, 2)),
        DayNames: [...EN_US_DAYS],
        AbbreviatedMonthNames: EN_US_MONTHS.map((name) => name.slice(0, 3)),
        MonthNames: [...EN_US_MONTHS],
        AbbreviatedMonthGenitiveNames: EN_US_MONTHS.map((name) => name.slice(0, 3)),
        MonthGenitiveNames: [...EN_US_MONTHS],
      },
      numberFormat: {
        CurrencyDecimalDigits: 2,
        CurrencyDecimalSeparator: '.',
        CurrencyGroupSizes: [3],
        NumberGroupSizes: [3],
        PercentGroupSizes: [3],
        CurrencyGroupSeparator: ',',
        CurrencySymbol: '$',
        CurrencyNegativePattern: 0,
        NumberNegativePattern: 1,
        PercentPositivePattern: 0,
        PercentNegativePattern: 0,
        NegativeSign: '-',
        NumberDecimalSeparator: '.',
        NumberGroupSeparator: ',',
        CurrencyPositivePattern: 0,
        PercentDecimalSeparator: '.',
        PercentGroupSeparator: ',',
      },
    };
  }
  // DateTimeFormatInfo and NumberFormatInfo in the platform's member order, fresh per control. They are the en-US
  // culture whatever the page language: a de-DE page reports the en-US objects of a 1033 page (captured).
  function cultureInfo() {
    const { dateTimeFormat: d, numberFormat: n } = enUsCulture();
    return {
      dateTimeFormat: {
        AMDesignator: d.AMDesignator,
        Calendar: {
          MinSupportedDateTime: new Date(-62135568000000),
          MaxSupportedDateTime: new Date(253402300799999),
          AlgorithmType: 1,
          CalendarType: 1,
          Eras: [1],
          TwoDigitYearMax: 2029,
          IsReadOnly: false,
        },
        DateSeparator: d.DateSeparator,
        FirstDayOfWeek: d.FirstDayOfWeek,
        CalendarWeekRule: d.CalendarWeekRule,
        FullDateTimePattern: d.FullDateTimePattern,
        LongDatePattern: d.LongDatePattern,
        LongTimePattern: d.LongTimePattern,
        MonthDayPattern: d.MonthDayPattern,
        PMDesignator: d.PMDesignator,
        RFC1123Pattern: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'",
        ShortDatePattern: d.ShortDatePattern,
        ShortTimePattern: d.ShortTimePattern,
        SortableDateTimePattern: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
        TimeSeparator: d.TimeSeparator,
        UniversalSortableDateTimePattern: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
        YearMonthPattern: d.YearMonthPattern,
        AbbreviatedDayNames: [...d.AbbreviatedDayNames],
        ShortestDayNames: [...d.ShortestDayNames],
        DayNames: [...d.DayNames],
        AbbreviatedMonthNames: [...d.AbbreviatedMonthNames],
        MonthNames: [...d.MonthNames],
        IsReadOnly: false,
        NativeCalendarName: 'Gregorian Calendar',
        AbbreviatedMonthGenitiveNames: [...d.AbbreviatedMonthGenitiveNames],
        MonthGenitiveNames: [...d.MonthGenitiveNames],
      },
      numberFormat: {
        CurrencyDecimalDigits: n.CurrencyDecimalDigits,
        CurrencyDecimalSeparator: n.CurrencyDecimalSeparator,
        IsReadOnly: false,
        CurrencyGroupSizes: [...n.CurrencyGroupSizes],
        NumberGroupSizes: [...n.NumberGroupSizes],
        PercentGroupSizes: [...n.PercentGroupSizes],
        CurrencyGroupSeparator: n.CurrencyGroupSeparator,
        CurrencySymbol: n.CurrencySymbol,
        NaNSymbol: 'NaN',
        CurrencyNegativePattern: n.CurrencyNegativePattern,
        NumberNegativePattern: n.NumberNegativePattern,
        PercentPositivePattern: n.PercentPositivePattern,
        PercentNegativePattern: n.PercentNegativePattern,
        NegativeInfinitySymbol: '-Infinity',
        NegativeSign: n.NegativeSign,
        NumberDecimalDigits: 2,
        NumberDecimalSeparator: n.NumberDecimalSeparator,
        NumberGroupSeparator: n.NumberGroupSeparator,
        CurrencyPositivePattern: n.CurrencyPositivePattern,
        PositiveInfinitySymbol: 'Infinity',
        PositiveSign: '+',
        PercentDecimalDigits: 2,
        PercentDecimalSeparator: n.PercentDecimalSeparator,
        PercentGroupSeparator: n.PercentGroupSeparator,
        PercentSymbol: '%',
        PerMilleSymbol: '‰',
        NativeDigits: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
        DigitSubstitution: 1,
      },
    };
  }
  // A .NET custom date and time format string over the local (or UTC) fields of a date. An invalid date formats its
  // numbers as NaN, as the platform does ("NaN/NaN/NaN").
  function formatDatePattern(date, pattern, info, utc = false) {
    const get = (name) => date[(utc ? 'getUTC' : 'get') + name]();
    const fields = {
      get,
      info,
      year: get('FullYear'),
      month: get('Month'),
      day: get('Date'),
      weekday: get('Day'),
      hours: get('Hours'),
      genitive: /(^|[^d])d{1,2}(?!d)/.test(pattern.replace(/'[^']*'/g, '')),
    };
    let out = '';
    for (let index = 0; index < pattern.length;) {
      const character = pattern[index];
      if (character === "'" || character === '"') {
        const literal = quotedPatternLiteral(pattern, index, character);
        out += literal.text;
        index = literal.next;
        continue;
      }
      if (character === '\\') {
        out += pattern[index + 1] ?? '';
        index += 2;
        continue;
      }
      let length = 1;
      while (pattern[index + length] === character) length++;
      index += length;
      out += datePatternRun(character, length, fields);
    }
    return out;
  }
  // A quoted literal of a format string: its text and the index after its closing quote (the end without one).
  function quotedPatternLiteral(pattern, index, quote) {
    const end = pattern.indexOf(quote, index + 1);
    if (end < 0) return { text: pattern.slice(index + 1), next: pattern.length };
    return { text: pattern.slice(index + 1, end), next: end + 1 };
  }
  const patternNumber = (value, width) => (Number.isFinite(value) ? String(value).padStart(width, '0') : 'NaN');
  // One run of a repeated format character (d, dd, ddd, dddd, M..., y..., h, H, m, s, f/F, t) over the date's fields.
  function datePatternRun(character, length, fields) {
    const { get, hours } = fields;
    const width = Math.min(length, 2);
    switch (character) {
      case 'd':
        return dayPatternRun(length, fields);
      case 'M':
        return monthPatternRun(length, fields);
      case 'y':
        return yearPatternRun(length, fields.year);
      case 'h':
        return patternNumber(Number.isFinite(hours) ? hours % 12 || 12 : hours, width);
      case 'H':
        return patternNumber(hours, width);
      case 'm':
        return patternNumber(get('Minutes'), width);
      case 's':
        return patternNumber(get('Seconds'), width);
      case 'f':
      case 'F':
        return patternNumber(get('Milliseconds'), 3).padEnd(length, '0').slice(0, length);
      case 't': {
        const designator = hours < 12 ? fields.info.AMDesignator : fields.info.PMDesignator;
        return length === 1 ? designator.slice(0, 1) : designator;
      }
      default:
        return character.repeat(length);
    }
  }
  function dayPatternRun(length, { info, weekday, day }) {
    if (length >= 4) return info.DayNames[weekday] ?? '';
    if (length === 3) return info.AbbreviatedDayNames[weekday] ?? '';
    return patternNumber(day, length);
  }
  function monthPatternRun(length, { info, month, genitive }) {
    if (length >= 4) return (genitive ? info.MonthGenitiveNames : info.MonthNames)[month] ?? '';
    if (length === 3) return (genitive ? info.AbbreviatedMonthGenitiveNames : info.AbbreviatedMonthNames)[month] ?? '';
    return patternNumber(month + 1, length);
  }
  function yearPatternRun(length, year) {
    if (length > 2) return patternNumber(year, length);
    return patternNumber(Number.isFinite(year) ? year % 100 : year, length);
  }
  // A number with fixed precision, .NET grouping and the culture's negative pattern; rounding is half away from zero
  // and a negative value keeps its sign when it rounds to zero ("-0.00", captured).
  // pattern: { positive, negative } .NET templates over n (the number), $ (the symbol) and - (the negative sign),
  // substituted in one pass so a symbol or separator is never re-read as a template character.
  function formatNumberPattern(value, precision, separators, pattern) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(number);
    const digits = Number.isInteger(precision) && precision >= 0 && precision <= 20 ? precision : 2;
    const [integer, fraction] = Math.abs(number).toFixed(digits).split('.');
    const sizes = separators.sizes?.length ? separators.sizes : [3];
    const groups = [];
    let rest = integer,
      sizeIndex = 0;
    while (rest.length > 0) {
      const size = sizes[Math.min(sizeIndex, sizes.length - 1)] || rest.length;
      groups.unshift(rest.slice(-size));
      rest = rest.slice(0, -size);
      sizeIndex++;
    }
    const text = groups.join(separators.group) + (fraction ? separators.decimal + fraction : '');
    const tokens = { n: text, $: pattern.symbol ?? '', '-': pattern.sign ?? '-' };
    return (number >= 0 ? pattern.positive : pattern.negative).replace(/[n$-]/g, (token) => tokens[token]);
  }
  function parseDatePattern(text, info) {
    const values = String(text ?? '').match(/\d+/g);
    const order = (info.ShortDatePattern.match(/d+|M+|y+/g) ?? ['M', 'd', 'yyyy']).map((token) => token[0]);
    if (!values || values.length < 3) return null;
    const read = Object.fromEntries(order.map((token, index) => [token, Number(values[index])]));
    let year = read.y;
    if (values[order.indexOf('y')].length <= 2) year += year > info.Calendar.TwoDigitYearMax % 100 ? 1900 : 2000;
    const date = new Date(year, read.M - 1, read.d);
    return date.getFullYear() === year && date.getMonth() === read.M - 1 && date.getDate() === read.d ? date : null;
  }
  const asDate = (value) => (value instanceof Date ? value : new Date(value));
  // A function with the platform's name and arity (Function.length).
  function hostMethod(name, length, implementation) {
    Object.defineProperty(implementation, 'name', { value: name });
    Object.defineProperty(implementation, 'length', { value: length });
    return implementation;
  }
  // An object with own data members and methods on its prototype (non-enumerable), as the platform's classes.
  function hostObject(own, methods = {}) {
    const prototype = {};
    for (const [name, [length, implementation]] of Object.entries(methods))
      Object.defineProperty(prototype, name, {
        value: hostMethod(name, length, implementation),
        writable: true,
        configurable: true,
      });
    return Object.assign(Object.create(prototype), own);
  }
  // The formatting namespace: en-US results whatever the page language (captured on a de-DE page), except
  // formatLanguage and formatUserDateTimeToUTC, which follow the page language (`locale`).
  function pcfFormatting(culture, offset, languages, locale) {
    const info = culture.dateTimeFormat,
      numbers = culture.numberFormat;
    const separators = (kind) => ({
      group: numbers[kind + 'GroupSeparator'],
      decimal: numbers[kind + 'DecimalSeparator'],
      sizes: numbers[kind + 'GroupSizes'],
    });
    const plainNumber = (value, precision) =>
      formatNumberPattern(value, precision ?? numbers.NumberDecimalDigits, separators('Number'), {
        positive: 'n',
        negative: NUMBER_NEGATIVE_PATTERNS[numbers.NumberNegativePattern] ?? '-n',
        sign: numbers.NegativeSign,
      });
    const dateTime = (value, utc) =>
      formatDatePattern(value, info.ShortDatePattern + ' ' + info.ShortTimePattern, info, utc);
    // A website language's English name on an English page (en-US: 1033 "English (United States)", an LCID that is no
    // website language its number); on another page language the LCID as text (captured on de-DE only: 1033 "1033").
    const englishPage = /^en(?:-|$)/i.test(locale);
    const languageName = (code) => {
      const language = languages.find((item) => item.lcid === Number(code));
      if (!englishPage || !language?.code) return String(code);
      try {
        return (
          new Intl.DisplayNames(['en-US'], { type: 'language', languageDisplay: 'standard' }).of(language.code) ??
          String(code)
        );
      } catch {
        return String(code);
      }
    };
    // formatUserDateTimeToUTC writes the page culture's short date (captured: en-US 3/15/2026, de-DE 15.03.2026), the
    // other results keep the en-US culture. The pattern comes from Intl for the page language (observed for de-DE only).
    const userDatePattern = /^en-US$/i.test(locale)
      ? info.ShortDatePattern
      : cultureShortDatePattern(locale, info.ShortDatePattern);
    const userDate = (value) => formatDatePattern(asDate(value), userDatePattern, info);
    return hostObject(
      {},
      {
        parseDateFromString: [2, (value) => parseDatePattern(value, info)],
        parseDateFromInput: [2, (value) => parseDatePattern(value, info)],
        formatDateShort: [
          2,
          (value, includeTime) =>
            includeTime
              ? dateTime(asDate(value), false)
              : formatDatePattern(asDate(value), info.ShortDatePattern, info),
        ],
        formatDateLongAbbreviated: [
          1,
          (value) =>
            formatDatePattern(
              asDate(value),
              info.LongDatePattern.replaceAll('dddd', 'ddd').replaceAll('MMMM', 'MMM'),
              info,
            ),
        ],
        formatDateLong: [1, (value) => formatDatePattern(asDate(value), info.LongDatePattern, info)],
        formatDateYearMonth: [1, (value) => formatDatePattern(asDate(value), info.YearMonthPattern, info)],
        parseFormatted: [
          4,
          (value) => {
            const text = String(value ?? '')
              .split(numbers.NumberGroupSeparator)
              .join('')
              .replace(numbers.NumberDecimalSeparator, '.');
            return Number(text);
          },
        ],
        parseFormattedValue: [
          2,
          (value) =>
            Number(
              String(value ?? '')
                .split(numbers.NumberGroupSeparator)
                .join('')
                .replace(numbers.NumberDecimalSeparator, '.'),
            ),
        ],
        formatInteger: [1, (value) => plainNumber(value, 0)],
        formatDecimal: [2, (value, precision) => plainNumber(value, precision)],
        formatCurrency: [
          3,
          (value, precision, symbol) =>
            formatNumberPattern(value, precision ?? numbers.CurrencyDecimalDigits, separators('Currency'), {
              positive: CURRENCY_POSITIVE_PATTERNS[numbers.CurrencyPositivePattern] ?? '$n',
              negative: CURRENCY_NEGATIVE_PATTERNS[numbers.CurrencyNegativePattern] ?? '-$n',
              symbol: symbol ?? numbers.CurrencySymbol,
              sign: numbers.NegativeSign,
            }),
        ],
        // The platform always returns the short date and time; the date-time behaviour selects the clock: UserLocal
        // (1) is UTC plus the user's offset, TimeZoneIndependent (3) the local clock shifted back by the browser's
        // offset at that instant, anything else the browser clock (captured New York and Kyiv).
        formatTime: [
          2,
          (value, behavior) => {
            const date = asDate(value);
            if (behavior === 1) return dateTime(new Date(date.getTime() + offset * 60000), true);
            if (behavior === 3) return dateTime(new Date(date.getTime() - date.getTimezoneOffset() * 60000), false);
            return dateTime(date, false);
          },
        ],
        getWeekOfYear: [1, () => Number.NaN],
        getTimeZoneOffsetInMinutes: [1, () => offset],
        formatDateAsFilterStringInUTC: [
          2,
          (value, includeTime) =>
            formatDatePattern(asDate(value), includeTime ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd', info),
        ],
        formatLanguage: [1, (value) => languageName(value)],
        formatUserDateTimeToUTC: [2, (value, behavior) => (behavior === 1 ? userDate(Number.NaN) : userDate(value))],
        formatUTCDateTimeToUserDate: [2, (value) => new Date(asDate(value))],
        formatUserInput: [2, (value) => (value == null ? '' : String(value))],
      },
    );
  }
  const THEMING_COLORS = {
    whitebackground: '#FFFFFF',
    defaulttheming: '#3B79B7',
    header: '#F26151',
    globallink: '#1160B7',
    selectedlinkeffect: '#F26158',
    selectedlinkeffectcolor: '#F26158',
    hoverlinkeffect: '#E7EFF7',
    processcontrol: '#41A053',
    defaultentity: '#666666',
    defaultcustomentity: '#00CCA3',
    controlshade: '#FFFFFF',
    controlborder: '#BDC3C7',
  };
  // The theming values of the capture (the organization's default theme). Nested objects beyond these scalars were
  // not captured and stay empty.
  function pcfTheming(record) {
    const nested = (keys) => Object.fromEntries(keys.split(' ').map((key) => [key, {}]));
    const em = (value) => value + 'em';
    return hostObject(
      {
        useUpdatedDesignSystem: false,
        normalfontcolor: '#F26197',
        normalfontfamily: "'SegoeUI', 'Segoe UI'",
        normalfontsize: '13px',
        solidborderstyle: 'solid',
        noneborderstyle: 'none',
        colors: {
          ...THEMING_COLORS,
          ...nested(
            'navbarshelf control navbar pageheader pagepanel defaultsurface customentity entity title status statuscolor accent maintheme base basecolor links linkcolor grays',
          ),
        },
        textbox: {
          fonticonsize: em(1),
          fontweight: 400,
          contentfontweight: '600',
          fontsize: em(1),
          errorfontsize: em(0.9),
          spacing: em(0.25),
          notificationiconcontainerheight: 'calc(100% - 0.5em)',
          containerspacing: em(0.75),
          rightmargin: em(2),
          lineheight: em(1.5),
          linethickness: '1px',
          horizontalpadding: em(0.5),
          verticalpadding: em(0.5),
          maxlength: 200,
          labelcolor: '#444444',
          contentcolor: '#000000',
          linecolor: '#DDDDDD',
          hoverboxcolor: '#0072C6',
          backgroundcolor: '#F2F8FF',
          errorbackgroundcolor: '#FFF5F5',
          redcolor: '#EA0600',
          bluecolor: '#0000FF',
          restmodecolor: '#FFFFFF',
        },
        spacings: {
          xshorizontal: em(0.5),
          shorizontal: em(0.5),
          bhorizontal: em(1),
          mhorizontal: em(2),
          lhorizontal: em(2.5),
          xlhorizontal: em(3.5),
          xxlhorizontal: em(4.5),
          xsvertical: em(0.5),
          svertical: em(0.5),
          bvertical: em(1),
          mvertical: em(2),
          lvertical: em(2.5),
          xlvertical: em(3.5),
          xxlvertical: em(4.5),
        },
        fontfamilies: {
          semilight: "'SegoeUI-Light', 'Segoe UI Semilight', 'Segoe UI Regular', 'Segoe UI'",
          semibold: "'SegoeUI-Semibold', 'Segoe UI Semibold', 'Segoe UI Regular', 'Segoe UI'",
          regular: "'Segoe UI Regular', 'Segoe UI'",
          bold: "'SegoeUI-Bold', 'Segoe UI Bold', 'Segoe UI'",
        },
        fontsizes: {
          xsfontsize: '0.750rem',
          sfontsize: '0.875rem',
          bfontsize: '1rem',
          mfontsize: '1rem',
          lfontsize: '1.25rem',
          xlfontsize: '1.5rem',
          font225: '2.25rem',
          font200: '2.00rem',
          font175: '1.75rem',
          font150: '1.50rem',
          font125: '1.25rem',
          font115: '1.15rem',
          font100: '1.00rem',
          font085: '0.85rem',
          font075: '0.75rem',
          font1143: '1.143rem',
        },
        breakpoints: { dimensionxs: 320, dimensions: 480, dimensionm: 768, dimensionl: 1024, dimensionxl: 1024 },
        measures: Object.fromEntries(
          [25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500, 550, 600].map((value) => [
            'measure' + String(value).padStart(3, '0'),
            (value === 50 ? '0.5' : (value / 100).toFixed(2)) + 'rem',
          ]),
        ),
        lookup: { tagpadding: '6px', tagmargin: '-5px', tagbackgroundcolor: '#ECF4FA' },
        borders: {
          border01: '1px solid #efefef',
          border02: '1px solid #d8d8d8',
          border03: '1px dashed black',
          border04: '1px solid #666666',
          border05: '1px dashed #000000',
        },
        shadows: { shadow01: '0px 2px 4px 0px rgba(0, 0, 0, 0.5);' },
        buttons: {},
      },
      {
        getEntityColor: [1, record('theming.getEntityColor', () => THEMING_COLORS.defaultentity)],
        disableUiTransitions: [0, record('theming.disableUiTransitions', () => false)],
        rightAlignEdit: [0, record('theming.rightAlignEdit', () => false)],
        inlineLayout: [0, record('theming.inlineLayout', () => false)],
      },
    );
  }
  // The platform's error for a member it declares without an implementation (captured).
  function nonImplemented(name) {
    return () => {
      const error = new Error(name + ': Method not implemented.');
      error.name = 'PCFNonImplementedError';
      throw error;
    };
  }
  // Same-origin or absolute http(s) URLs only: a script or data URL is not a navigation target.
  function navigationUrl(value) {
    const url = new URL(String(value ?? ''), location.href);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PCF navigation needs an http(s) URL');
    return url.href;
  }
  // Navigation on Power Pages: every member except openErrorDialog throws PCFNonImplementedError (no dialog, no
  // navigation); openErrorDialog resolves with its options object and shows nothing.
  // Two messages name another member: openGrid's names openGridPage and openEditForm's names openForm (captured).
  const NAVIGATION_MESSAGE_NAMES = { openGrid: 'openGridPage', openEditForm: 'openForm' };
  function pcfNavigation() {
    const members = { updateBag: [1, () => undefined] };
    for (const [name, length] of [
      ['openEditForm', 5],
      ['openGridPage', 5],
      ['openGrid', 8],
      ['openDashboard', 1],
      ['openCreateForm', 3],
      ['openForm', 2],
      ['openSearch', 1],
      ['openPowerBIFullScreenPage', 7],
      ['openUrl', 2],
      ['openUrlWithProtocol', 2],
      ['openPhoneNumber', 6],
      ['openMaps', 1],
      ['openMap', 1],
      ['openAlertDialog', 2],
      ['openConfirmDialog', 2],
      ['openErrorDialog', 1],
      ['openDialog', 3],
      ['openFile', 2],
      ['openTaskFlow', 3],
      ['openWebResource', 3],
      ['navigateTo', 2],
    ]) {
      if (name === 'openErrorDialog') members[name] = [length, (options) => Promise.resolve(options)];
      else members[name] = [length, nonImplemented(NAVIGATION_MESSAGE_NAMES[name] ?? name)];
    }
    return hostObject({}, members);
  }
  // Device on Power Pages: the capture methods and openARViewer throw PCFNonImplementedError; getMessageReceiver's
  // message names openARViewer, getDeclaredFeatures' names isCaptureAudioOperationAvailable; pickFile returns a promise
  // that never settles; isTakePictureOperationAvailable() returns null. The other
  // is…Available checks (false) and getFeatureClassName are not captured (unproven, hostCalls).
  function pcfDevice(record) {
    const unavailable = (api) => record('device.' + api, () => false);
    return hostObject(
      {},
      {
        captureImage: [1, nonImplemented('captureImage')],
        captureAudio: [1, nonImplemented('captureAudio')],
        captureVideo: [1, nonImplemented('captureVideo')],
        pickFile: [1, () => new Promise(() => {})],
        getBarcodeValue: [0, nonImplemented('getBarcodeValue')],
        getCurrentPosition: [0, nonImplemented('getCurrentPosition')],
        isGetBarcodeValueOperationAvailable: [0, unavailable('isGetBarcodeValueOperationAvailable')],
        isTakePictureOperationAvailable: [0, () => null],
        isCaptureVideoOperationAvailable: [0, unavailable('isCaptureVideoOperationAvailable')],
        isCaptureAudioOperationAvailable: [0, unavailable('isCaptureAudioOperationAvailable')],
        isOpenARViewerAvailable: [0, unavailable('isOpenARViewerAvailable')],
        openARViewer: [1, nonImplemented('openARViewer')],
        isGetMessageReceiverAvailable: [0, unavailable('isGetMessageReceiverAvailable')],
        getMessageReceiver: [2, nonImplemented('openARViewer')],
        getDeclaredFeatures: [0, nonImplemented('isCaptureAudioOperationAvailable')],
        getFeatureClassName: [0, record('device.getFeatureClassName', () => undefined)],
      },
    );
  }
  // The popup service: the captured prototype members over plain DOM nodes (their behaviour is unproven). Nodes are
  // removed when the control is destroyed.
  function pcfPopupService(record, onDispose) {
    // Keyed by popup name without a prototype, so no name reaches Object.prototype.
    const popups = Object.create(null);
    let popupsId = '';
    // A closed popup is not displayed at all: it neither covers the page nor takes its clicks.
    const show = (name, open) => {
      const popup = popups[name];
      if (!popup) return;
      popup.node.hidden = !open;
      popup.node.style.display = open ? 'flex' : 'none';
    };
    const remove = (name) => {
      popups[name]?.node.remove();
      delete popups[name];
    };
    onDispose(() => {
      for (const name of Object.keys(popups)) remove(name);
    });
    const api = (name) => 'factory.getPopupService().' + name;
    const create = (properties) => {
      const name = properties?.name;
      if (typeof name !== 'string' || !name) throw new Error('PCF popup service: createPopup needs a popup name');
      // A popup created again under the same name replaces the earlier one and its node.
      remove(name);
      const node = document.createElement('div');
      node.dataset.paqviloPcfPopup = name;
      node.hidden = true;
      node.style.cssText = 'position:fixed;z-index:9999;inset:0;align-items:center;justify-content:center;display:none';
      if (properties.content instanceof Node) node.append(properties.content);
      document.body.append(node);
      popups[name] = { properties, node };
    };
    return hostObject(
      { _popups: popups },
      {
        createPopup: [1, record(api('createPopup'), create)],
        openPopup: [1, record(api('openPopup'), (name) => show(name, true))],
        closePopup: [1, record(api('closePopup'), (name) => show(name, false))],
        updatePopup: [
          2,
          record(api('updatePopup'), (name, properties) => {
            const popup = popups[name];
            if (!popup) return;
            popup.properties = { ...popup.properties, ...properties };
            if (properties?.content instanceof Node) popup.node.replaceChildren(properties.content);
          }),
        ],
        deletePopup: [1, record(api('deletePopup'), (name) => remove(name))],
        getPopups: [0, record(api('getPopups'), () => Object.values(popups).map((popup) => popup.properties))],
        setPopupsId: [
          1,
          record(api('setPopupsId'), (id) => {
            popupsId = String(id ?? '');
          }),
        ],
        getPopupsId: [0, record(api('getPopupsId'), () => popupsId)],
        renderPopups: [0, record(api('renderPopups'))],
      },
    );
  }
  // The EntityMetadata members the platform's result carries, in its order.
  const ENTITY_METADATA_MEMBERS = [
    'ActivityTypeMask',
    'AutoRouteToOwnerQueue',
    'CanEnableSyncToExternalSearchIndex',
    'CanTriggerWorkflow',
    'Description',
    'DisplayCollectionName',
    'DisplayName',
    'EnforceStateTransitions',
    'EntityColor',
    'EntitySetName',
    'IsActivity',
    'IsActivityParty',
    'IsBusinessProcessEnabled',
    'IsChildEntity',
    'IsConnectionsEnabled',
    'IsCustomEntity',
    'IsCustomizable',
    'IsDocumentManagementEnabled',
    'IsDocumentRecommendationsEnabled',
    'IsDuplicateDetectionEnabled',
    'IsEnabledForCharts',
    'IsImportable',
    'IsInteractionCentricEnabled',
    'IsKnowledgeManagementEnabled',
    'IsMailMergeEnabled',
    'IsManaged',
    'IsOneNoteIntegrationEnabled',
    'IsOptimisticConcurrencyEnabled',
    'IsQuickCreateEnabled',
    'IsReadOnlyInMobileClient',
    'IsStateModelAware',
    'IsValidForAdvancedFind',
    'IsVisibleInMobileClient',
    'LogicalCollectionName',
    'LogicalName',
    'ObjectTypeCode',
    'PrimaryIdAttribute',
    'PrimaryImageAttribute',
    'PrimaryNameAttribute',
    'Privileges',
  ];
  const LABEL_MEMBERS = new Set(['Description', 'DisplayCollectionName', 'DisplayName']);
  // The attribute collection of the platform's result: not an Array; its own Attributes array and, on
  // the prototype, get (the whole list, whatever the argument), getByIndex, forEach (item, index) and getLength.
  function attributeCollection(attributes) {
    return hostObject(
      { Attributes: attributes },
      {
        get: [1, () => attributes],
        getByIndex: [1, (index) => attributes[index]],
        forEach: [1, (callback) => attributes.forEach((attribute, index) => callback(attribute, index))],
        getLength: [0, () => attributes.length],
      },
    );
  }
  // utils.getEntityMetadata: the control's call sends exactly one request, no caching (captured URL encoding).
  async function pcfEntityMetadata(name, attributes) {
    const logical = String(name ?? '').toLowerCase();
    if (!/^[a-z_][a-z\d_]*$/.test(logical)) throw new Error('PCF utils.getEntityMetadata needs a table logical name');
    const requested = valuesOf(attributes).map((column) => String(column).toLowerCase());
    const columns = requested.filter((column) => /^[a-z_][a-z\d_]*$/.test(column));
    if (requested.length && !columns.length)
      throw new Error('PCF utils.getEntityMetadata needs column logical names: ' + requested.join(', '));
    const filter = columns.map((column) => "LogicalName eq '" + column + "'").join(' or ');
    const query = filter
      ? '?$expand=Attributes($filter=' + filter.replaceAll(' ', '%20').replaceAll("'", '%27') + ')'
      : '';
    const response = await fetch("/_api/EntityDefinitions(LogicalName='" + logical + "')" + query, {
      credentials: 'same-origin',
      // The host's request headers: the portal answers EntityDefinitions only with
      // pcf-entity-logical-name; no anti-forgery token is sent.
      headers: {
        'pcf-entity-logical-name': logical,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
        accept: '*/*',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error('PCF utils.getEntityMetadata HTTP ' + response.status), {
        status: response.status,
      });
    const definition = await response.json();
    // The platform flattens the table labels to the user's label.
    const label = (value) => value?.UserLocalizedLabel?.Label ?? value?.LocalizedLabels?.[0]?.Label ?? null;
    const metadata = {};
    for (const key of ENTITY_METADATA_MEMBERS)
      if (Object.hasOwn(definition, key))
        metadata[key] = LABEL_MEMBERS.has(key) ? label(definition[key]) : definition[key];
    metadata.Attributes = attributeCollection(Array.isArray(definition.Attributes) ? definition.Attributes : []);
    return metadata;
  }
  function userAgentFlags() {
    const agent = navigator.userAgent;
    return {
      isWin: /Windows/.test(agent),
      isAndroid: /Android/.test(agent),
      isAndroidModern: /Android/.test(agent) && /Chrome\//.test(agent),
      isIos: /iPhone|iPad|iPod/.test(agent),
      isBrowserIE: /Trident\//.test(agent),
      // Chromium browsers, Edge included (the capture ran in Edge).
      isBrowserChrome: /Chrome\//.test(agent),
      isBrowserFirefox: /Firefox\//.test(agent),
    };
  }
  function pcfOrgSettings(languageId) {
    const undefinedMembers =
      'webResourceHash enableBingMapsIntegration bingMapsApiKey availableBingMapLocales excludedCountriesForMaps bFDatacenter securitySettingForEmail appointmentRichEditorExperience gridTotalRecordCountLimit lookupCharacterCountBeforeResolve lookupResolveDelayMS advancedLookupEnabled isCollaborationExperienceEnabled pcfDatasetGridEnabled allowUsersHidingSystemViews appointmentWithTeamsMeeting appointmentWithTeamsMeetingV2 isEmailAddressValidationEnabled';
    return hostObject(
      {
        languageId,
        attributes: {},
        uniqueName: null,
        isAutoSaveEnabled: false,
        tenantId: undefined,
        isRTL: false,
        // The environment's fiscal year start as captured; Mirage has no fiscal settings of its own.
        fiscalYearStartDate: new Date('2017-01-01T18:59:00Z'),
        fiscalPeriodFormat: 1,
        fiscalPeriodType: 2002,
        fiscalYearFormatYear: 1,
        fiscalYearFormatPrefix: 1,
        fiscalYearFormatSuffix: 3,
        fiscalYearDisplayCode: 1,
        fiscalPeriodConnector: 's',
        showWeekNumber: false,
        boundDashboardDefaultCardExpanded: false,
        allowUnresolvedPartiesOnEmailSend: false,
        ...Object.fromEntries(undefinedMembers.split(' ').map((name) => [name, undefined])),
      },
      { updateBag: [0, () => undefined] },
    );
  }
  // The context object of one control. `host` connects it to the mount: schedule(names, source), notify(),
  // debug, trace(stage), stateKey, nativeDisabled() and the controlling container.
  function pcfContext(spec, container, parameters, host) {
    const { debug } = host;
    const record =
      (api, implementation = () => undefined) =>
      (...args) => {
        debug.hostCalls = [...(debug.hostCalls ?? []), { api, at: Date.now() }].slice(-50);
        return implementation(...args);
      };
    const lcid = spec.language?.lcid ?? (Number(document.documentElement.getAttribute('crm-lcid')) || 1033);
    const locale = spec.language?.code || document.documentElement.lang || 'en-US';
    const isRTL = spec.language?.isRTL ?? document.documentElement.dir === 'rtl';
    const offset = -new Date().getTimezoneOffset();
    const culture = cultureInfo();
    const languages = spec.languages?.length ? spec.languages : [{ lcid, code: locale }];
    const native = spec.nativeBinding?.context;
    // Captured hosts: a form field and a subgrid (spec.datasetContext, the parent form record) report the form record
    // ('' on insert) with entityRecordName '' although the row has a name; a Liquid tag and an entity list report no
    // record. A loopback mount without `host` takes the same shape (unproven).
    const recordContext = native ?? spec.datasetContext;
    const formRecord = recordContext
      ? { entityTypeName: recordContext.entityTypeName, entityId: recordContext.entityId ?? '', entityRecordName: '' }
      : { entityTypeName: undefined, entityId: undefined, entityRecordName: '' };
    const controlName = spec.constructor.split('.').at(-1);
    // mode.label is the control name, except on a multi-select or status reason column, where it is the column's
    // display name (captured: "Choices", "Status Reason"); a Liquid tag reports the control name.
    const columnLabel = ['multiselect', 'status'].includes(spec.nativeBinding?.control) && native?.label;
    const modeLabel = columnLabel || spec.schemaName || spec.constructor;
    const readOnly = spec.args?.disabled === true || spec.args?.disabled === 'true';
    const webApiFailure = (operation, entityType, error) => {
      const detail = {
        operation,
        entityType: entityType ?? null,
        message: errorText(error),
        errorCode: error?.errorCode ?? null,
        status: error?.status ?? null,
        at: Date.now(),
      };
      debug.webApiErrors = [...(debug.webApiErrors ?? []), detail].slice(-20);
      host.trace('webAPI:rejected');
      console.warn(
        'Paqvilo: PCF webAPI.' +
          operation +
          ' rejected; Power Pages rejects with undefined, the detail is in inspect().webApiErrors',
        detail,
      );
      return Promise.reject(undefined); // NOSONAR: the Power Pages host rejects every webAPI call with undefined (captured)
    };
    const webApi = (operation, entityType, run) => {
      try {
        return run().catch((error) => webApiFailure(operation, entityType, error));
      } catch (error) {
        return webApiFailure(operation, entityType, error);
      }
    };
    const unsupportedWebApi = (operation) => () =>
      webApi(operation, null, () =>
        Promise.reject(new Error('PCF webAPI.' + operation + ' is not available on the local Power Pages host')),
      );
    // The host's webAPI requests name their table in pcf-entity-logical-name; the portal Web API
    // handler's authorization is not changed by it.
    const api = (name, suffix, method, body) =>
      host.api(name, suffix, method, body, {
        'pcf-entity-logical-name': String(name ?? '').toLowerCase(),
      });
    let tracking = false;
    const mode = hostObject(
      {
        hasFocus: true,
        isPreview: false,
        isAuthoringMode: false,
        isActive: false,
        isRead: Boolean(spec.nativeBinding) && readOnly,
        // The Power Pages host reports no allocated size (-1), also after trackContainerResize(true) (captured).
        allocatedWidth: -1,
        allocatedHeight: -1,
        // One updateView(['layout']) the first time tracking starts; later calls and resizes report nothing.
        // Latched: false then true again schedules nothing more (local choice, unproven: the capture called true once).
        trackContainerResize: hostMethod('trackContainerResize', 0, (value) => {
          if (value !== true || tracking) return;
          tracking = true;
          host.schedule(['layout'], 'layout');
        }),
        // setFullScreen(true) fails inside the platform's host; false returns undefined.
        setFullScreen: hostMethod('setFullScreen', 0, (value) => {
          if (value === true) throw new TypeError('r.overrideStyle is not a function');
        }),
        isControlDisabled: host.nativeDisabled(),
        isVisible: true,
        label: modeLabel,
        accessibilityLabel: null,
        isOffline: false,
        fullPageParam: null,
        rowSpan: 1,
        contextInfo: { ...formRecord },
      },
      {
        setNotification: [2, record('mode.setNotification', () => true)],
        clearNotification: [1, record('mode.clearNotification', () => true)],
        requestAlwaysRender: [1, record('mode.requestAlwaysRender')],
        // A saved state returns true and causes no updateView.
        setControlState: [
          3,
          (state) => {
            try {
              sessionStorage.setItem(host.stateKey, JSON.stringify(state));
            } catch (error) {
              host.trace('setControlState:failed');
              debug.stateError = errorText(error);
              return false;
            }
            return true;
          },
        ],
        blur: [0, record('mode.blur', () => container.querySelector(':focus')?.blur())],
        focus: [
          0,
          record('mode.focus', () => container.querySelector('input,select,textarea,button,[tabindex]')?.focus()),
        ],
      },
    );
    const userSettings = hostObject(
      {
        // The platform reports no user, even for a signed-in contact (captured).
        userId: null,
        userName: null,
        dateFormattingInfo: culture.dateTimeFormat,
        numberFormattingInfo: culture.numberFormat,
        isRTL,
        languageId: lcid,
        locale: undefined,
        securityRoles: [],
        isHighContrastEnabled: false,
        timeZoneUtcOffsetMinutes: offset,
        pagingLimit: null,
        workDayStartTime: '08:00',
        workDayStopTime: undefined,
        formatInfoCultureName: String(lcid),
        formatInfoCultureId: undefined,
        aadObjectId: undefined,
      },
      {
        updateBag: [1, () => undefined],
        // The browser's offset when the control mounted, whatever date is passed (captured January and July).
        getTimeZoneOffsetMinutes: [1, () => offset],
      },
    );
    const client = hostObject(
      {
        formFactor: 2,
        userAgent: userAgentFlags(),
        languageCode: String(lcid),
        isRTL,
        locale: String(lcid),
        orgSettings: {
          isRTL: false,
          fiscalYearStartDate: new Date('2017-01-01T18:59:00Z'),
          fiscalPeriodFormat: 1,
          fiscalPeriodType: 2002,
          fiscalYearFormatYear: 1,
          fiscalYearFormatPrefix: 1,
          fiscalYearFormatSuffix: 3,
          fiscalYearDisplayCode: 1,
          fiscalPeriodConnector: 's',
          showWeekNumber: false,
          boundDashboardDefaultCardExpanded: false,
          // The capture shows the environment's organization id here; the local payload carries none (unproven value).
          organizationId: null,
          isActionCardEnabled: false,
          isEmailMonitoringAllowed: false,
          allowUnresolvedPartiesOnEmailSend: false,
        },
        dateFormattingInfo: culture.dateTimeFormat,
        numberFormattingInfo: culture.numberFormat,
        userTimeZoneUtcOffsetMinutes: offset,
        getUserTimeZoneUtcOffset: hostMethod(
          'getUserTimeZoneUtcOffset',
          1,
          record('client.getUserTimeZoneUtcOffset', () => offset),
        ),
        allocatedWidth: -1,
        allocatedHeight: -1,
        trackContainerResize: hostMethod('trackContainerResize', 0, (value) => mode.trackContainerResize(value)),
        setFullScreen: hostMethod('setFullScreen', 0, record('client.setFullScreen')),
        setFullscreen: hostMethod('setFullscreen', 0, record('client.setFullscreen')),
        ignoreSelfUpdates: hostMethod('ignoreSelfUpdates', 0, record('client.ignoreSelfUpdates')),
        disableScroll: false,
        fnoDetails: undefined,
      },
      {
        getClient: [0, () => 'Web'],
        isOffline: [0, () => false],
        isNetworkAvailable: [
          0,
          () => {
            throw new Error('Function not implemented.');
          },
        ],
        // getFormFactor() answers 1 although formFactor is 2 (captured).
        getFormFactor: [0, () => 1],
        getClientState: [0, () => null],
        getEnvironmentEndpoint: [
          2,
          () => {
            throw new Error('getEnvironmentEndpoint API not supported');
          },
        ],
        getClientInfo: [
          0,
          () => {
            throw new Error('getClientInfo API not supported');
          },
        ],
        updateClientBag: [1, () => undefined],
      },
    );
    const utilsStub = (name, length, result) => [length, record('utils.' + name, result)];
    const utils = hostObject(
      {
        setNotification: hostMethod(
          'setNotification',
          2,
          record('utils.setNotification', () => true),
        ),
        clearNotification: hostMethod(
          'clearNotification',
          1,
          record('utils.clearNotification', () => true),
        ),
      },
      {
        doesControlExist: utilsStub('doesControlExist', 1, () => false),
        beginSecureSessionForResource: utilsStub('beginSecureSessionForResource', 4),
        createPerformanceMarker: utilsStub('createPerformanceMarker', 1),
        createPerformanceStopwatch: utilsStub('createPerformanceStopwatch', 1),
        log: utilsStub('log', 3),
        getEntityMetadata: [2, (name, attributes) => pcfEntityMetadata(name, attributes)],
        // Rejects with undefined.
        getEntitiesMetadata: [1, () => Promise.reject(undefined)], // NOSONAR: the Power Pages host rejects with undefined
        getParentControlName: utilsStub('getParentControlName', 0),
        getResourceString: [2, nonImplemented('getResourceString')],
        // false for PcfDatasetGrid (captured); other feature names unproven.
        isFeatureEnabled: [1, () => false],
        isDisruptiveFeatureEnabled: utilsStub('isDisruptiveFeatureEnabled', 3, () => false),
        canOpenUrl: utilsStub('canOpenUrl', 1, (url) => {
          try {
            return Boolean(navigationUrl(url));
          } catch {
            return false;
          }
        }),
        getFormId: [2, nonImplemented('getFormId')],
        lookupObjects: [1, nonImplemented('lookupObjects')],
        bindDOMElement: utilsStub('bindDOMElement', 2),
        fireEvent: utilsStub('fireEvent', 2),
        getControlDefaultMapping: utilsStub('getControlDefaultMapping', 3),
        getPopupService: utilsStub('getPopupService', 0, () => popupService),
        requestRender: [1, () => undefined],
        unbindDOMComponent: utilsStub('unbindDOMComponent', 1),
        updateComponent: utilsStub('updateComponent', 2),
        createCrmUri: utilsStub('createCrmUri', 1, (path) => new URL(String(path ?? ''), location.origin).href),
        createServerUri: utilsStub('createServerUri', 1, (path) => new URL(String(path ?? ''), location.origin).href),
        openInBrowser: utilsStub('openInBrowser', 1, (url) => {
          globalThis.open(navigationUrl(url), '_blank', 'noopener,noreferrer');
        }),
        getServiceUri: utilsStub('getServiceUri', 0, () => location.origin),
        setState: utilsStub('setState', 1),
        // An unknown dependency rejects with undefined at once (captured); declared manifest dependencies are never loaded.
        loadDependency: [
          1,
          (name) => {
            debug.hostCalls = [...(debug.hostCalls ?? []), { api: 'utils.loadDependency', name, at: Date.now() }].slice(
              -50,
            );
            return Promise.reject(undefined); // NOSONAR: the Power Pages host rejects with undefined (captured)
          },
        ],
        crmUrlEncode: [1, (value) => encodeURIComponent(String(value ?? ''))],
        hasEntityPrivilege: [3, nonImplemented('hasEntityPrivilege')],
        crmHtmlEncode: [
          1,
          (value) =>
            String(value ?? '').replace(
              /[&<>"']/g,
              (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
            ),
        ],
        isNullOrUndefined: [1, (value) => value == null],
        isNullOrEmptyString: [1, (value) => value == null || value === ''],
        notifyOutputChanged: [0, record('utils.notifyOutputChanged', () => host.notify())],
        eventListenerExists: utilsStub('eventListenerExists', 1, () => false),
        getElementByRef: utilsStub('getElementByRef', 0),
        disablePanoramaScroll: utilsStub('disablePanoramaScroll', 0),
        scrollToView: utilsStub('scrollToView', 0, () => container.scrollIntoView?.()),
        setNotification: utilsStub('setNotification', 0, () => true),
        clearNotification: utilsStub('clearNotification', 0, () => true),
        triggerOfflineMetadataSync: utilsStub('triggerOfflineMetadataSync', 0),
        addGlobalNotification: utilsStub('addGlobalNotification', 6),
        clearGlobalNotification: utilsStub('clearGlobalNotification', 1),
        clearGlobalNotifications: utilsStub('clearGlobalNotifications', 0),
        retrieveChartDrilldownAttributes: utilsStub('retrieveChartDrilldownAttributes', 1),
        retrieveFormWithAttributes: utilsStub('retrieveFormWithAttributes', 3),
        getEntityName: utilsStub('getEntityName', 1),
        retrieveRecordCommand: utilsStub('retrieveRecordCommand', 6),
        getDeclaredFeatures: utilsStub('getDeclaredFeatures', 0, () => []),
        getFeatureClassName: utilsStub('getFeatureClassName', 0),
        encodeFilterString: utilsStub('encodeFilterString', 2, (value) => String(value ?? '').replaceAll("'", "''")),
        getUserSettings: [0, () => userSettings],
      },
    );
    const popupService = pcfPopupService(record, host.onDispose);
    const factoryStub = (name, length, result) => [length, record('factory.' + name, result)];
    const factory = hostObject(
      {
        createElement: hostMethod('createElement', 3, record('factory.createElement')),
        createComponent: hostMethod('createComponent', 3, record('factory.createComponent')),
      },
      {
        createElement: factoryStub('createElement', 3),
        createComponent: factoryStub('createComponent', 3),
        bindDOMElement: factoryStub('bindDOMElement', 2),
        bindDOMComponent: factoryStub('bindDOMComponent', 2),
        createFileObject: factoryStub('createFileObject', 1),
        fireEvent: factoryStub('fireEvent', 2),
        getControlDefaultMapping: factoryStub('getControlDefaultMapping', 3),
        getPopupService: [0, () => popupService],
        // Returns undefined and renders nothing (captured: no updateView follows).
        requestRender: [1, () => undefined],
        unbindDOMComponent: factoryStub('unbindDOMComponent', 1),
        updateComponent: factoryStub('updateComponent', 2),
      },
    );
    const events = Object.fromEntries(
      (spec.events ?? [])
        .filter((event) => typeof event?.name === 'string' && event.name)
        .map((event) => [
          event.name,
          hostMethod(event.name, 0, () => {
            debug.hostCalls = [...(debug.hostCalls ?? []), { api: 'events.' + event.name, at: Date.now() }].slice(-50);
            container.dispatchEvent(
              new CustomEvent('paqvilo:pcf-event', { bubbles: true, detail: { name: event.name } }),
            );
            return null;
          }),
        ]),
    );
    const diagnostics = (level, write) => [
      4,
      (...args) => {
        write('PCF ' + controlName + ' ' + level + ':', ...args);
      },
    ];
    const unavailableApi = (prefix) => (name) =>
      record(prefix + '.' + name, () =>
        Promise.reject(new Error('PCF ' + prefix + '.' + name + ' is not available on the local Power Pages host')),
      );
    const intelligence = unavailableApi('intelligenceApi');
    return {
      formatting: pcfFormatting(culture, offset, languages, locale),
      factory,
      navigation: pcfNavigation(),
      reporting: hostObject(
        {},
        {
          addControlId: [1, () => undefined],
          reportSuccess: [2, () => undefined],
          reportFailure: [4, () => undefined],
          reportEvent: [1, () => undefined],
        },
      ),
      diagnostics: hostObject(
        {},
        {
          addControlId: [1, () => undefined],
          traceError: diagnostics('error', console.error),
          traceWarning: diagnostics('warning', console.warn),
          traceInfo: diagnostics('info', console.info),
          traceDebug: diagnostics('debug', console.debug),
          isInMonitorSession: [0, () => false],
        },
      ),
      resources: hostObject(
        {},
        {
          getString: [1, (key) => spec.strings[key] ?? key],
          // Power Pages calls the failure callback at once with no argument and never loads the resource (captured
          // for a declared image, a missing path and the RESX file).
          getResource: [
            3,
            (_name, _success, failure) => {
              if (typeof failure === 'function') failure();
            },
          ],
        },
      ),
      theming: pcfTheming(record),
      design: {
        DesignLanguageId: 'Fluent',
        ThemeId: 'default',
        Colors: { Palette: {}, Patterns: {} },
        Components: Object.fromEntries(
          'TextInput Link ButtonPrimary ButtonSecondary Label Dropdown DropdownMenu Gauge CommandBar Form MessageBar Grid AppHeader Navigation Dashboard'
            .split(' ')
            .map((name) => [name, {}]),
        ),
      },
      fluentDesignLanguage: undefined,
      performance: hostObject(
        {},
        {
          createPerformanceStopwatch: [3, () => ({ start() {}, stop() {} })],
          trackWork: [1, () => undefined],
          addKeyPerformanceIndicator: [3, () => undefined],
          addKeyPerformanceIndicatorOnIdle: [2, () => undefined],
        },
      ),
      utils,
      // The page LCID, not the organization base language (captured: 1031 on a de-DE page of an en-US site).
      orgSettings: pcfOrgSettings(lcid),
      userSettings,
      offline: undefined,
      learningPath: { DOMAttributeName: 'data-lp-id', baseControlId: controlName + '|' + controlName + '|undefined' },
      page: hostObject(
        {
          appId: PCF_APP_ID,
          entityTypeName: formRecord.entityTypeName,
          entityId: formRecord.entityId,
          isPageReadOnly: false,
          getClientUrl: hostMethod('getClientUrl', 0, () => location.origin),
        },
        { updateBag: [1, () => undefined] },
      ),
      webAPI: hostObject(
        {},
        {
          retrieveRecord: [
            3,
            // Without options the platform sends no request and returns undefined synchronously (captured). A read
            // resolves { data, entityType, values: undefined } with the row under data (captured, paqvilo-developer
            // pcf-parity summary-F section 1, field and dataset hosts alike).
            (entityType, id, query) => {
              if (!query) return undefined;
              return webApi('retrieveRecord', entityType, async () => ({
                data: (await api(entityType, '(' + recordId(id) + ')' + options(query), 'GET')).result,
                entityType,
                values: undefined,
              }));
            },
          ],
          createRecord: [
            2,
            (entityType, data) =>
              webApi('createRecord', entityType, async () => ({
                id: (await api(entityType, '', 'POST', data)).id,
                entityType,
              })),
          ],
          updateRecord: [
            3,
            (entityType, id, data) =>
              webApi('updateRecord', entityType, async () => {
                await api(entityType, '(' + recordId(id) + ')', 'PATCH', data);
                return { id, entityType };
              }),
          ],
          // A delete resolves with a null id (captured).
          deleteRecord: [
            2,
            (entityType, id) =>
              webApi('deleteRecord', entityType, async () => {
                await api(entityType, '(' + recordId(id) + ')', 'DELETE');
                return { id: null, entityType };
              }),
          ],
          // The host ignores maxPageSize (no Prefer header, every row of the query) and a FetchXML top, and resolves
          // { entities, nextLink: undefined } (captured, paqvilo-developer pcf-parity summary-F section 1, runs fa and
          // fb, field and dataset hosts alike).
          retrieveMultipleRecords: [
            4,
            (entityType, query) =>
              webApi('retrieveMultipleRecords', entityType, async () => {
                const { result } = await api(entityType, options(query ?? ''), 'GET');
                return { entities: result.value ?? [], nextLink: undefined };
              }),
          ],
          execute: [1, unsupportedWebApi('execute')],
          executeMultiple: [1, unsupportedWebApi('executeMultiple')],
          getDeclaredFeatures: [0, record('webAPI.getDeclaredFeatures', () => [])],
          getFeatureClassName: [0, record('webAPI.getFeatureClassName')],
        },
      ),
      graphApi: hostObject(
        {},
        {
          sendRequest: [5, unavailableApi('graphApi')('sendRequest')],
          getDeclaredFeatures: [0, record('graphApi.getDeclaredFeatures', () => [])],
          getFeatureClassName: [0, record('graphApi.getFeatureClassName')],
        },
      ),
      intelligenceApi: hostObject(
        {},
        {
          getPredictionSchemaAsync: [2, intelligence('getPredictionSchemaAsync')],
          predictAsync: [2, intelligence('predictAsync')],
          getPreTrainedModelIdAsync: [1, intelligence('getPreTrainedModelIdAsync')],
          getLabelsForObjectDetectionModelAsync: [1, intelligence('getLabelsForObjectDetectionModelAsync')],
          invokeAiModelActionAsync: [2, intelligence('invokeAiModelActionAsync')],
          invokeGlobalOperationAsync: [2, intelligence('invokeGlobalOperationAsync')],
          invokeCopilotActionAsync: [2, intelligence('invokeCopilotActionAsync')],
          hasOrganizationSettingsAsync: [0, intelligence('hasOrganizationSettingsAsync')],
          getOrganizationSettingsAsync: [1, intelligence('getOrganizationSettingsAsync')],
        },
      ),
      connectors: null,
      client,
      parameters,
      mode,
      accessibility: hostObject(
        {
          assignedTabIndex: 0,
          assignedTooltip: null,
          accessibilityInternalData: { keyboardShortcuts: [] },
          isHighContrastEnabled: false,
        },
        {
          registerShortcut: [6, record('accessibility.registerShortcut')],
          getUniqueId: [1, record('accessibility.getUniqueId', (id) => container.id + '_' + String(id ?? ''))],
          focusElementById: [2, record('accessibility.focusElementById', (id) => document.getElementById(id)?.focus())],
          blurElementById: [2, record('accessibility.blurElementById', (id) => document.getElementById(id)?.blur())],
        },
      ),
      updatedProperties: [],
      device: pcfDevice(record),
      externalContext: hostObject(
        {},
        {
          getAvailableExternalContexts: [0, record('externalContext.getAvailableExternalContexts', () => [])],
          getExternalContextProperty: [3, unavailableApi('externalContext')('getExternalContextProperty')],
          invokeExternalContextAction: [3, unavailableApi('externalContext')('invokeExternalContextAction')],
          removeExternalContextPropertyListener: [3, record('externalContext.removeExternalContextPropertyListener')],
        },
      ),
      // Own undefined members shadow the prototype functions of the same name (captured).
      communicationChannel: hostObject(
        {
          getPresenceMappedField: hostMethod(
            'getPresenceMappedField',
            1,
            record('communicationChannel.getPresenceMappedField', () => null),
          ),
          isPresenceEnabled: hostMethod(
            'isPresenceEnabled',
            1,
            record('communicationChannel.isPresenceEnabled', () => false),
          ),
          getPersonaInfo: undefined,
          getPresenceStatus: undefined,
          getProfilePhoto: undefined,
          getAadObjectIdInfos: undefined,
        },
        {
          getPresenceMappedField: [1, record('communicationChannel.getPresenceMappedField', () => null)],
          isPresenceEnabled: [1, record('communicationChannel.isPresenceEnabled', () => false)],
          getPersonaInfo: [1, unavailableApi('communicationChannel')('getPersonaInfo')],
          getPresenceStatus: [2, unavailableApi('communicationChannel')('getPresenceStatus')],
          getProfilePhoto: [2, unavailableApi('communicationChannel')('getProfilePhoto')],
          getAadObjectIdInfos: [1, unavailableApi('communicationChannel')('getAadObjectIdInfos')],
        },
      ),
      events,
      appSettings: undefined,
      copilot: hostObject(
        {},
        {
          updateBag: [1, () => undefined],
          resolvePrediction: [1, unavailableApi('copilot')('resolvePrediction')],
        },
      ),
      children: {},
      decorators: undefined,
    };
  }
  async function loadControlResources(spec) {
    // The platform libraries (React, ReactDOM, FluentUIReact) load first, in order, once per page, as the Power Pages
    // host provides them on every page with a code component (pcf.platformLibraries: project files).
    // A library the page's own script element already defined (Liquid host markup) is not loaded again.
    for (const library of spec.platformLibraries ?? [])
      if (globalThis[library.name] === undefined) await resource({ kind: 'code', url: library.url });
    // The live page lists Fluent UI in window.__packages__; a supplied build that does not register itself gets it.
    const fluent = (spec.platformLibraries ?? []).find((library) => /^fluentuireact$/i.test(library.name));
    if (fluent && globalThis.FluentUIReact && globalThis.__packages__ === undefined)
      globalThis.__packages__ = { '@fluentui/react': [fluent.version] };
    for (const item of spec.resources.filter((item) => item.kind === 'code' || item.kind === 'css')) {
      // A Liquid tag host's bundle ran from its native address in the markup; only a registered constructor proves it
      // (a script inserted as HTML, refused by the page policy, missing or failing did not register): else load it.
      if (item.nativeUrl && registered(spec)) continue;
      await resource(item);
    }
    // The field host's hidden input follows the control view in the markup: a mount script that runs while the page
    // is still parsing (its bundle already loaded) waits for the document.
    if (spec.nativeBinding && document.readyState === 'loading')
      await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  async function mount(spec, target) {
    const container = target || document.getElementById(spec.id);
    if (!container || instances.has(container)) return;
    const ordinal = (counts.get(spec.id) || 0) + 1;
    counts.set(spec.id, ordinal);
    container.id = spec.id + '-' + ordinal;
    const debug = { id: container.id, constructor: spec.constructor, state: 'loading', lifecycle: [] };
    const trace = (stage) => {
      debug.lifecycle.push({ stage, at: Date.now() });
      if (debug.lifecycle.length > 100) debug.lifecycle.shift();
    };
    let control,
      disposed = false,
      detachNative = () => {},
      updateQueued = false,
      outputTimer = null;
    const disposers = [];
    const pending = new Set(),
      sources = new Set();
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(outputTimer);
      detachNative();
      for (const dispose of disposers.splice(0))
        try {
          dispose();
        } catch {
          /* A host resource that fails to release does not stop the teardown. */
        }
      instances.delete(container);
      try {
        if (control) {
          trace('destroy');
          control.destroy?.();
        }
      } catch (error) {
        container.dataset.pcfCleanupError = errorText(error);
        debug.error ??= errorText(error);
      }
      debug.state = debug.error ? 'failed' : 'destroyed';
      history.push(debugSnapshot(debug));
      if (history.length > 100) history.shift();
    };
    const failure = (error) => {
      debug.error = errorText(error);
      cleanup();
      container.setAttribute('aria-busy', 'false');
      container.setAttribute('role', 'alert');
      container.textContent = debug.error;
      container.dataset.pcfError = 'true';
      delete container.dataset.pcfReady;
    };
    // Reserve before resource loading so duplicate calls cannot create two instances.
    instances.set(container, { cleanup, debug, spec });
    try {
      await loadControlResources(spec);
      if (disposed || !container.isConnected) {
        cleanup();
        return;
      }
      const Constructor = controlConstructor(spec);
      const { parameters, writable } = controlParameters(spec, debug, container);
      const api = (name, suffix, method, body, headers) => pcfApi(spec, name, suffix, method, body, headers);
      const stateKey = 'paqvilo-pcf:' + controlStateId(spec, container);
      // A read-only form disables the field host's controls, and the host disables a status or status reason
      // column on every form (captured: statuscode and statecode isControlDisabled true).
      // Page scripts that disable the hidden input change nothing (captured).
      const nativeDisabled = () =>
        spec.args.disabled === true ||
        spec.args.disabled === 'true' ||
        ['status', 'state'].includes(spec.nativeBinding?.control);
      const context = pcfContext(spec, container, parameters, {
        debug,
        trace,
        stateKey,
        api,
        nativeDisabled,
        schedule: (names, source) => schedule(names, source),
        notify: () => changed(),
        onDispose: (dispose) => disposers.push(dispose),
      });
      context.mode.isVisible = hostVisible(container);
      const datasetHosts = (spec.datasets ?? []).map((binding) => {
        const host = datasetAdapter(
          binding,
          api,
          (properties) => {
            if (control && !disposed) {
              context.updatedProperties = properties;
              try {
                trace('updateView:dataset');
                control.updateView(context);
              } catch (error) {
                failure(error);
              }
            }
          },
          // Every settled dataset load is traced, with or without an updateView (inspect() lifecycle).
          (outcome) => trace('dataset:' + outcome),
        );
        // Each data set comes with its selection parameters and its property-sets as parameters of their own, before
        // the data set itself (captured on lists, subgrids and the Liquid tag).
        const empty = (type, attributes = {}) => ({
          raw: null,
          formatted: null,
          type,
          attributes,
          security: {},
          error: false,
          errorMessage: null,
        });
        parameters[binding.name + '_Selected'] ??= empty('Object');
        parameters[binding.name + '_SelectedItems'] ??= empty('DataSet');
        for (const set of binding.propertySets ?? [])
          parameters[set.name] ??= empty('String', { DisplayName: set.name, Type: 'string' });
        parameters[binding.name] = host.dataset;
        return host;
      });
      control = new Constructor();
      // A virtual control returns a React element from updateView; the supplied ReactDOM renders it into the container.
      if (spec.type === 'virtual') virtualControl(control, container);
      // One updateView per microtask: changes queued in the same turn are delivered together, in order,
      // after the notifyOutputChanged event that caused them.
      const flush = () => {
        updateQueued = false;
        const names = [...pending],
          stages = [...sources];
        pending.clear();
        sources.clear();
        if (disposed || !names.length) return;
        try {
          context.updatedProperties = names;
          trace('updateView:' + stages.join('+'));
          control.updateView(context);
        } catch (error) {
          failure(error);
        }
      };
      const schedule = (names, source) => {
        if (disposed || !names.length) return;
        for (const name of names) pending.add(name);
        sources.add(source);
        if (updateQueued) return;
        updateQueued = true;
        queueMicrotask(flush);
      };
      const types = Object.fromEntries(Object.entries(parameters).map(([name, item]) => [name, item.type]));
      // The control's outputs. On the Liquid host every output is checked against its property type; an invalid one is refused
      // (recorded, not stored and not written) and the valid ones still apply. A value that cannot be compared
      // (cyclic, throwing getter) fails the control. Answers the valid outputs, or null after a failure.
      const takeOutputs = () => {
        const refused = [];
        let outputs;
        try {
          trace('getOutputs');
          outputs = Object.fromEntries(
            Object.entries(control.getOutputs?.() || {}).filter(([name]) => writable.has(name)),
          );
          for (const raw of Object.values(outputs)) JSON.stringify(raw);
          // The field host takes an output of the wrong type as it is: it is JSON-encoded into the hidden input and the
          // column's native validators refuse the submit (captured).
          for (const [name, raw] of spec.nativeBinding ? [] : Object.entries(outputs))
            try {
              outputValue(raw, types[name], parameters[name].attributes);
            } catch (error) {
              refused.push({ name, message: errorText(error) });
              delete outputs[name];
            }
          nativeOutputProperties(spec, outputs);
          debug.outputs = outputs;
        } catch (error) {
          failure(error);
          return null;
        }
        if (refused.length) {
          trace('getOutputs:refused');
          debug.refusedOutputs = [...(debug.refusedOutputs ?? []), ...refused].slice(-20);
          container.dispatchEvent(new CustomEvent('paqvilo:pcf-output-refused', { bubbles: true, detail: refused }));
        }
        return outputs;
      };
      // The field and Liquid tag hosts debounce notifyOutputChanged (captured, paqvilo-developer pcf-parity summary-F
      // section 2, runs fa and fb): notifyOutputChanged returns at once, and getOutputs runs once, about 100 ms after
      // the last notify, reading the last value; notifies in one turn, in microtasks or in setTimeout(0) tasks share one
      // call, notifies 50 ms apart keep moving it, notifies 150 ms apart get one call each. The field host follows a
      // getOutputs with one updateView with updatedProperties [] and the output as the new raw value, and with none
      // when the value is unchanged; a disabled control (statuscode) takes outputs too. The Liquid host never runs
      // updateView after a notify. Lists and subgrids keep the local model below (not captured).
      const NOTIFY_DEBOUNCE_MS = 100;
      // "Unchanged" compares with the previous getOutputs answer: a first output equal to the column value still runs
      // updateView (captured, summary-B: the status reason output 1 on a row whose value is 1), a repeated one does not
      // (summary-F section 2, sameValueTwice).
      let previousOutputs = null;
      const fieldOutputs = () => {
        const outputs = takeOutputs();
        if (!outputs) return;
        const changedValues =
          previousOutputs === null ||
          Object.entries(outputs).some(
            ([name, raw]) => !Object.hasOwn(previousOutputs, name) || JSON.stringify(raw) !== previousOutputs[name],
          );
        previousOutputs = Object.fromEntries(Object.entries(outputs).map(([name, raw]) => [name, JSON.stringify(raw)]));
        for (const [name, raw] of Object.entries(outputs)) {
          const parameter = parameters[name];
          parameter.raw = raw;
          parameter.formatted = fieldFormatted(raw, parameter.type, parameter.attributes);
          parameter.error = false;
          parameter.errorMessage = null;
        }
        try {
          writeFieldOutput(spec, container, outputs, parameters);
        } catch (error) {
          failure(error);
          return;
        }
        container.dispatchEvent(new CustomEvent('paqvilo:pcf-output', { bubbles: true, detail: outputs }));
        if (!changedValues) return;
        try {
          context.updatedProperties = [];
          trace('updateView:output');
          control.updateView(context);
        } catch (error) {
          failure(error);
        }
      };
      // Stores the outputs as the parameters' raw and formatted values; answers the names whose value changed, or null
      // after a failure.
      const applyOutputs = (outputs) => {
        let prepared;
        try {
          // Prepare every comparison/format before mutating parameter values.
          prepared = Object.entries(outputs).map(([name, raw]) => ({
            name,
            raw,
            previous: JSON.stringify(parameters[name].raw),
            formatted: formatParameter(raw, types[name], parameters[name].attributes),
          }));
        } catch (error) {
          failure(error);
          return null;
        }
        for (const { name, raw, formatted } of prepared) {
          parameters[name].raw = raw;
          parameters[name].formatted = formatted;
        }
        container.dispatchEvent(new CustomEvent('paqvilo:pcf-output', { bubbles: true, detail: outputs }));
        return prepared.filter((item) => JSON.stringify(item.raw) !== item.previous).map((item) => item.name);
      };
      // The Liquid host takes the outputs and runs no updateView.
      const liquidOutputs = () => {
        const outputs = takeOutputs();
        if (outputs) applyOutputs(outputs);
      };
      const debounced = spec.nativeBinding ? fieldOutputs : liquidOutputs;
      const changed = () => {
        if (disposed) return;
        if (spec.nativeBinding || spec.host === 'liquid') {
          clearTimeout(outputTimer);
          outputTimer = setTimeout(() => {
            outputTimer = null;
            if (!disposed) debounced();
          }, NOTIFY_DEBOUNCE_MS);
          return;
        }
        // Lists, subgrids and a mount without a host (LOCAL MODEL, unproven): getOutputs at once, and one updateView
        // in a microtask with the outputs whose value changed.
        const outputs = takeOutputs();
        if (!outputs) return;
        const updates = applyOutputs(outputs);
        if (updates) schedule(updates, 'output');
      };
      let state = {};
      try {
        state = JSON.parse(sessionStorage.getItem(stateKey) || '{}');
      } catch {
        /* Malformed or unavailable saved client state falls back to an empty state. */
      }
      trace('init');
      control.init(context, changed, state, container);
      if (disposed) return;
      trace('updateView');
      context.updatedProperties = [];
      control.updateView(context);
      debug.updateParameters = (values) => {
        if (disposed) throw new Error('PCF instance is disposed');
        if (!values || typeof values !== 'object' || Array.isArray(values))
          throw new Error('PCF parameter updates require an object');
        const updates = Object.entries(values).map(([name, value]) => {
          const property = spec.properties.find((item) => item.name === name);
          if (!property || property.usage === 'output') throw new Error('PCF parameter is not editable: ' + name);
          return [
            name,
            typed(value, parameters[name].type, { property, behavior: parameters[name].attributes.Behavior }),
          ];
        });
        const nativeUpdates = updates.filter(([name]) => spec.nativeBinding?.properties?.includes(name));
        if (nativeUpdates.some(([, value]) => JSON.stringify(value) !== JSON.stringify(nativeUpdates[0][1])))
          throw new Error('PCF returned conflicting outputs for one native field');
        debug.lastParameterUpdate = {
          names: updates.map(([name]) => name),
          phase: 'validated',
          parameterValuesApplied: false,
          nativeValuesMayHaveChanged: false,
        };
        for (const [name, raw] of updates) {
          parameters[name].raw = raw;
          parameters[name].formatted = formatParameter(raw, parameters[name].type, parameters[name].attributes);
          parameters[name].error = false;
          parameters[name].errorMessage = '';
        }
        debug.lastParameterUpdate.parameterValuesApplied = true;
        try {
          debug.lastParameterUpdate.phase = 'native-output';
          debug.lastParameterUpdate.nativeValuesMayHaveChanged = nativeUpdates.length > 0;
          if (spec.nativeBinding)
            writeFieldOutput(
              spec,
              container,
              Object.fromEntries(updates.filter(([name]) => writable.has(name))),
              parameters,
            );
          context.updatedProperties = updates.map(([name]) => name);
          debug.lastParameterUpdate.phase = 'updateView';
          trace('debug:updateView');
          control.updateView(context);
          debug.lastParameterUpdate.phase = 'completed';
        } catch (error) {
          failure(error);
          throw error;
        }
        return debugSnapshot(debug);
      };
      debug.state = 'ready';
      if (disposed) return;
      if (spec.nativeBinding)
        detachNative = attachFieldHost(spec, container, {
          parameters,
          context,
          control,
          failure,
          disposed: () => disposed,
          trace,
        });
      // Data sets load in declaration order, each with its own updateView (first, then second_*).
      for (const host of datasetHosts) await host.load();
      if (disposed) return;
      container.setAttribute('aria-busy', 'false');
      container.dataset.pcfReady = 'true';
    } catch (error) {
      failure(error);
    }
  }
  function hostVisible(container) {
    return container.isConnected && container.checkVisibility?.() !== false;
  }
  // The saved control state belongs to the control's place on the page (page path, form, field and
  // configuration), not to its current value. The ordinal is the control's position among the connected
  // controls with the same state id, so an in-page remount reuses its state.
  function controlStateId(spec, container) {
    if (!spec.stateId) return container.id;
    container.dataset.pcfStateId = spec.stateId;
    const same = Array.from(document.querySelectorAll('[data-pcf-state-id="' + CSS.escape(spec.stateId) + '"]'));
    return location.pathname + ':' + spec.stateId + '-' + (same.indexOf(container) + 1);
  }
  // Page scripts reach the field host only through a value change with a change event on the hidden input (jQuery
  // .val(v).trigger('change'), which runs jQuery handlers only, or a dispatched change event): the host reads the
  // input's JSON and calls updateView with updatedProperties [] and the new raw value. Disabling, read-only, hiding
  // the field or assigning .value without an event produce no updateView and leave isControlDisabled and isVisible
  // as they are; native validators never set a parameter error (captured).
  // Text that is not JSON throws from the handler, as on the live host (a page error there).
  function attachFieldHost(spec, container, host) {
    const field = nativeField(spec, container);
    const handler = () => {
      if (host.disposed()) return;
      host.trace('native:change');
      const text = field.value;
      for (const name of spec.nativeBinding.properties ?? []) {
        const parameter = host.parameters[name];
        if (!parameter) continue;
        const { raw, error } = fieldRaw(spec, text, parameter.type);
        parameter.raw = raw;
        parameter.formatted = fieldFormatted(raw, parameter.type, parameter.attributes);
        parameter.error = Boolean(error);
        parameter.errorMessage = error ?? null;
      }
      try {
        host.context.updatedProperties = [];
        host.trace('updateView:native');
        host.control.updateView(host.context);
      } catch (error) {
        host.failure(error);
      }
    };
    const jquery = globalThis.jQuery;
    if (typeof jquery === 'function' && typeof jquery.fn?.on === 'function') {
      jquery(field).on('change.paqviloPcf', handler);
      return () => jquery(field).off('change.paqviloPcf', handler);
    }
    field.addEventListener('change', handler);
    return () => field.removeEventListener('change', handler);
  }
  const removed = new MutationObserver(() => {
    for (const [container, instance] of instances) if (!container.isConnected) instance.cleanup();
  });
  removed.observe(document.documentElement, { childList: true, subtree: true });
  // The mount specification of a list's or subgrid's control bound to another of its views: the bound data set takes
  // that view's columns, links, sorting and signed configuration. Null when the data sets have no such view.
  function viewSpec(spec, viewId) {
    const wanted = String(viewId ?? '').toLowerCase();
    let found = false;
    const datasets = (spec.datasets ?? []).map((binding) => {
      const view = binding.views?.find((entry) => String(entry.viewId).toLowerCase() === wanted);
      if (!view) return binding;
      found = true;
      return { ...binding, ...view };
    });
    return found ? { ...spec, datasets } : null;
  }
  // A view chosen in a list's or subgrid's toolbar (entity-grid-compat.js): the host destroys the control and
  // initialises a new one, in a new host element, whose data set reports the chosen view; it then loads as on the page
  // load (init, updateView [], updateView ['dataset', 'Items', 'records']), also for the view already shown (captured,
  // paqvilo-developer pcf-parity summary-F section 4, runs fa and fb).
  document.addEventListener('paqvilo:pcf-view', (event) => {
    const grid = event.target;
    if (!(grid instanceof Element)) return;
    // The instances found before any remount: a remount adds its new instance to the map.
    const hosted = Array.from(instances).filter(([container, instance]) => grid.contains(container) && instance.spec);
    for (const [container, instance] of hosted) {
      const next = viewSpec(instance.spec, event.detail?.viewId);
      if (!next) continue;
      instance.cleanup();
      const replacement = document.createElement('div');
      for (const name of ['data-mirage-component', 'data-pcf-schema'])
        if (container.hasAttribute(name)) replacement.setAttribute(name, container.getAttribute(name));
      replacement.setAttribute('aria-busy', 'true');
      container.replaceWith(replacement);
      void mount(next, replacement);
    }
  });
  // A page entering the back/forward cache (persisted) keeps its live controls for the restore; only a
  // real unload destroys them.
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    for (const instance of instances.values()) instance.cleanup();
  });
  globalThis.__paqviloPcf = {
    mount,
    inspect(id) {
      const current = [...instances.values()].map((instance) => debugSnapshot(instance.debug));
      return [...current, ...history].filter((entry) => id === undefined || entry.id === id);
    },
    updateParameters(id, values) {
      const instance = [...instances.values()].find((item) => item.debug.id === id);
      if (!instance?.debug.updateParameters) throw new Error('PCF ready instance not found: ' + id);
      return instance.debug.updateParameters(values);
    },
    openDebugger() {
      const existing = document.querySelector('[data-paqvilo-pcf-debugger]');
      if (existing) {
        if (!existing.open) existing.showModal();
        return existing;
      }
      const dialog = document.createElement('dialog');
      dialog.dataset.paqviloPcfDebugger = '';
      dialog.setAttribute('aria-label', 'Code component debugger');
      dialog.style.cssText =
        'max-width:760px;width:90%;max-height:85vh;padding:20px;border:1px solid #777;border-radius:8px;overflow:auto';
      const title = document.createElement('h2');
      title.textContent = 'Code component debugger';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Code component instance');
      const editor = document.createElement('textarea');
      editor.setAttribute('aria-label', 'Parameter values (JSON)');
      editor.rows = 8;
      editor.style.cssText = 'display:block;width:100%;margin:12px 0;font-family:monospace';
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      const details = document.createElement('pre');
      details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
      const button = (text) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.textContent = text;
        return node;
      };
      const apply = button('Apply parameters'),
        refresh = button('Refresh state'),
        close = button('Close');
      const render = () => {
        const entry = globalThis.__paqviloPcf.inspect(select.value)[0];
        apply.disabled = entry?.state !== 'ready';
        details.textContent = JSON.stringify(entry ?? {}, null, 2);
        const instance = [...instances.values()].find((item) => item.debug.id === select.value);
        const editable = Object.entries(instance?.debug.parameters ?? {}).filter(
          ([name, parameter]) => instance.debug.editableParameters.includes(name) && Object.hasOwn(parameter, 'raw'),
        );
        editor.value = JSON.stringify(
          Object.fromEntries(editable.map(([name, parameter]) => [name, debugValue(parameter.raw)])),
          null,
          2,
        );
      };
      const inventory = () => {
        const id = select.value;
        select.replaceChildren();
        for (const entry of globalThis.__paqviloPcf.inspect()) {
          const option = document.createElement('option');
          option.value = entry.id;
          option.textContent = `${entry.id} · ${entry.state}`;
          select.append(option);
        }
        if ([...select.options].some((option) => option.value === id)) select.value = id;
        render();
      };
      select.addEventListener('change', render);
      refresh.addEventListener('click', inventory);
      apply.addEventListener('click', () => {
        try {
          globalThis.__paqviloPcf.updateParameters(select.value, JSON.parse(editor.value));
          status.textContent = 'Parameters applied.';
          render();
        } catch (error) {
          status.textContent = errorText(error);
          details.textContent = JSON.stringify(globalThis.__paqviloPcf.inspect(select.value)[0] ?? {}, null, 2);
        }
      });
      close.addEventListener('click', () => dialog.close());
      dialog.append(title, select, editor, apply, refresh, close, status, details);
      document.body.append(dialog);
      inventory();
      dialog.showModal();
      return dialog;
    },
  };
})();
