/**
 * The native form transport of a site: a Power Pages export is always a WebForms portal, so
 * native forms post the page back (__doPostBack) unless the project selects the JSON endpoint
 * with observed.nativeFormTransport: json.
 */
export const nativeFormTransport = (observed) => (observed?.nativeFormTransport === 'json' ? 'json' : 'postback');

/** Source-derived WebForms names shared by rendering and postback decoding. */
export const compactNativeControlId = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase()
    .replaceAll('-', '')
    .replace(/\W/g, '_');

export function nativeFormControlIds(kind, id, { modal = false, pageControl = false } = {}) {
  const N = compactNativeControlId(id);
  // Legacy ASPX page templates nest the content master in the site master: the page controls sit
  // under ctl00$ctl00$.
  const prefix = 'ctl00$ctl00$ContentContainer$MainContent$EntityControls$';
  if (kind === 'webform')
    return pageControl
      ? {
          wrapper: 'WebFormControl',
          panel: 'WebFormPanel',
          view: 'EntityFormView',
          names: `${prefix}WebFormControl$EntityFormView$`,
          buttons: `${prefix}WebFormControl$`,
        }
      : {
          wrapper: `WebFormControl_${N}`,
          panel: 'WebFormPanel',
          view: 'EntityFormView',
          names: `ctl00$ContentContainer$WebFormControl_${N}$EntityFormView$`,
          buttons: `ctl00$ContentContainer$WebFormControl_${N}$`,
        };
  if (kind === 'entityform')
    return modal || pageControl
      ? {
          wrapper: 'EntityFormControl',
          panel: 'EntityFormPanel',
          view: 'EntityFormControl_EntityFormView',
          names: `${pageControl ? prefix : 'ctl00$ContentContainer$MainContent$'}EntityFormControl$EntityFormControl_EntityFormView$`,
          buttons: `${pageControl ? prefix : 'ctl00$ContentContainer$MainContent$'}EntityFormControl$`,
        }
      : {
          wrapper: `EntityFormControl_${N}`,
          panel: 'EntityFormPanel',
          view: `EntityFormControl_${N}_EntityFormView`,
          names: `ctl00$ContentContainer$EntityFormControl_${N}$EntityFormControl_${N}_EntityFormView$`,
          buttons: `ctl00$ContentContainer$EntityFormControl_${N}$`,
        };
  throw new TypeError('Unknown native form kind');
}

export class NativePostbackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NativePostbackError';
    this.code = 'InvalidNativePostback';
    this.status = 400;
  }
}

const invalid = (message) => {
  throw new NativePostbackError(message);
};
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
// "tab": an auto-generated step's Next/Previous (no save; actionIndex names the tab to show).
const actions = new Set(['submit', 'previous', 'delete', 'deactivate', 'activate', 'tab']);

/**
 * Mirage's own __VIEWSTATE payload: an auto-generated step form keeps the tab index and the
 * earlier tabs' posted values in the page's hidden field, as the platform keeps them in its
 * ViewState. The value is client-supplied and bounded; only string values of safe names survive.
 */
export const encodeNativeViewState = (state) =>
  '/wE' + Buffer.from(JSON.stringify({ v: 1, ...state })).toString('base64');
/**
 * The anti-forgery key a page's __VIEWSTATE carries (k), as ASP.NET binds ViewState to the
 * visitor (ViewStateUserKey): a WebForms postback then posts the page's own fields only, without
 * a separate __RequestVerificationToken. Null for any other value.
 */
export function nativeViewStateKey(text) {
  if (typeof text !== 'string' || text.length > 262144 || !text.startsWith('/wE')) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text.slice(3), 'base64').toString('utf8'));
    return parsed?.v === 1 && typeof parsed.k === 'string' && parsed.k ? parsed.k : null;
  } catch {
    return null;
  }
}
export function decodeNativeViewState(text) {
  if (typeof text !== 'string' || text.length > 262144 || !text.startsWith('/wE')) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(text.slice(3), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || typeof parsed.form !== 'string') return null;
  const values = {};
  for (const [key, value] of Object.entries(parsed.values && typeof parsed.values === 'object' ? parsed.values : {}))
    if (typeof value === 'string' && /^[a-z]\w*$/i.test(key) && !dangerous.has(key)) values[key] = value;
  return {
    form: parsed.form,
    autoStep: Number.isInteger(parsed.autoStep) && parsed.autoStep >= 0 ? parsed.autoStep : 0,
    values,
  };
}

/** The posted binding of a declared native form field. */
function boundNativeField(field, wireName) {
  return {
    name: field.name,
    wireName,
    multiple: field.multiple === true,
    ...(field.numberLocale ? { numberLocale: field.numberLocale } : {}),
    // A mounted field component posts its hidden input as JSON (lib/pcf-field-host.mjs), never a check box.
    ...(field.control === 'pcf' ? { pcf: true } : {}),
    // The rendered rich text editor posts its HTML as a JSON string; a plain textarea posts its text (platform.mjs).
    ...(field.control === 'richtext' ? { richText: true } : {}),
    ...(field.control !== 'pcf' && (field.control === 'checkbox' || field.type === 'checkbox')
      ? { checkbox: true }
      : {}),
  };
}

/**
 * The caller supplies only fields and actions resolved for a rendered component.
 * Record, step, identity and permission context remain server-owned.
 */
export function nativeFormPostbackDescriptor({
  kind,
  formId,
  fields = [],
  actions: declaredActions = [],
  modal = false,
  pageControl = false,
  numberLocales = {},
}) {
  if (typeof formId !== 'string' || !formId) invalid('Native form identity required');
  if (!Array.isArray(fields) || !Array.isArray(declaredActions))
    invalid('Native form fields and actions must be arrays');
  const ids = nativeFormControlIds(kind, formId, { modal, pageControl });
  const names = new Set();
  const boundFields = [];
  for (const field of fields) {
    if (!field || typeof field.name !== 'string' || !field.name || dangerous.has(field.name))
      invalid('Invalid declared native form field');
    if (field.readOnly || field.disabled || field.ownerHidden) continue;
    const wireName = ids.names + field.name;
    // A column placed on the form more than once renders (and posts) only its first cell.
    if (names.has(wireName)) continue;
    names.add(wireName);
    boundFields.push(boundNativeField(field, wireName));
  }
  const targets = new Set();
  const boundActions = declaredActions.map((action) => {
    if (
      !action ||
      typeof action.button !== 'string' ||
      !action.button ||
      action.button.includes('$') ||
      !actions.has(action.action)
    )
      invalid('Invalid declared native form action');
    if (action.actionIndex != null && (!Number.isInteger(action.actionIndex) || action.actionIndex < 0))
      invalid('Invalid declared native action index');
    // Auto-generated step buttons are named inside the view (ids.names), the others after the control.
    const target = (action.view ? ids.names : ids.buttons) + action.button;
    if (targets.has(target)) invalid('Ambiguous declared native form action');
    targets.add(target);
    return {
      target,
      action: action.action,
      ...(action.actionIndex != null ? { actionIndex: action.actionIndex } : {}),
    };
  });
  const locales = nativeNumberLocales(numberLocales);
  return {
    kind,
    formId,
    ids,
    fields: boundFields,
    actions: boundActions,
    ...(Object.keys(locales).length ? { numberLocales: locales } : {}),
  };
}

// Bounded: the tags are site languages, and a posted descriptor never grows the cache past this.
const CULTURE_CACHE_LIMIT = 64;
const cultureMarks = new Map();

/**
 * The decimal and group marks of a page culture's numbers, from the locale data (Intl, Latin digits), or null for a
 * tag that is not a language tag Intl supports. Captured for en-US and de-DE only (hosted evidence summary E); other
 * cultures are inferred from the same locale data.
 */
export function numberCultureMarks(locale) {
  if (typeof locale !== 'string' || !/^[a-z]{2,3}(?:-[a-z\d]{2,8}){0,3}$/i.test(locale)) return null;
  if (cultureMarks.has(locale)) return cultureMarks.get(locale);
  let marks = null;
  try {
    if (Intl.NumberFormat.supportedLocalesOf([locale]).length) {
      const parts = new Intl.NumberFormat(locale, { numberingSystem: 'latn' }).formatToParts(12345.6);
      const decimal = parts.find((part) => part.type === 'decimal')?.value;
      if (decimal)
        marks = Object.freeze({ decimal, group: parts.find((part) => part.type === 'group')?.value ?? null });
    }
  } catch {
    marks = null;
  }
  if (cultureMarks.size < CULTURE_CACHE_LIMIT) cultureMarks.set(locale, marks);
  return marks;
}

// The page cultures whose native number boxes hosted forms were captured with (evidence summary E, FORM-06).
const CAPTURED_NUMBER_CULTURES = new Set(['en-US', 'de-DE']);

/**
 * Whether native number boxes of a page culture show and parse that culture's marks: the captured cultures always;
 * another culture only for a site that sets observed.nativeNumberCultures: locale-data (its marks then come from the
 * locale data, an uncaptured model). Otherwise the boxes keep invariant numbers.
 */
export function localizedNumberCulture(locale, observed) {
  if (CAPTURED_NUMBER_CULTURES.has(locale)) return true;
  return observed?.nativeNumberCultures === 'locale-data' && numberCultureMarks(locale) !== null;
}

/** The page culture of each localized number field: { [field]: { parse?, messages } }, on a null prototype. */
function nativeNumberLocales(declared) {
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) invalid('Invalid native number locales');
  const locales = Object.create(null);
  for (const [name, locale] of Object.entries(declared)) {
    if (!name || dangerous.has(name) || !locale || typeof locale !== 'object') invalid('Invalid native number locale');
    if (!numberCultureMarks(locale.messages) || (locale.parse != null && !numberCultureMarks(locale.parse)))
      invalid('Invalid native number locale');
    locales[name] = Object.freeze({ ...(locale.parse ? { parse: locale.parse } : {}), messages: locale.messages });
  }
  return locales;
}

/**
 * Decode textual successful controls without choosing a transport or response.
 * Text, empty values and declared repeated values are retained for the service's
 * typed validation. Only server-described editable checkboxes default to false
 * when absent; other unposted fields remain omitted.
 * Opaque state/token fields and controls belonging to other forms are not copied.
 */
export function parseNativePostback(entries, descriptors) {
  if (!entries || typeof entries[Symbol.iterator] !== 'function' || !Array.isArray(descriptors))
    invalid('Native postback entries and descriptors required');
  const { posted, entryCount } = collectNativeEntries(entries);
  const target = nativePostbackTarget(posted, descriptors);
  const matches = descriptors.flatMap((descriptor) => matchingActions(descriptor, target));
  if (matches.length !== 1) invalid('Native postback target is unknown or ambiguous');
  const { descriptor, action } = matches[0];
  const argumentsPosted = posted.get('__EVENTARGUMENT') ?? [];
  if (argumentsPosted.length > 1) invalid('Ambiguous native postback argument');
  let consumed = 1 + argumentsPosted.length + (posted.has(target) ? posted.get(target).length : 0);
  const parsedFields = parseNativeFields(descriptor, posted);
  consumed += parsedFields.consumed;
  return {
    kind: descriptor.kind,
    formId: descriptor.formId,
    body: {
      action: action.action,
      ...(action.actionIndex != null ? { actionIndex: action.actionIndex } : {}),
      values: parsedFields.values,
    },
    eventArgument: argumentsPosted[0] ?? '',
    ignoredEntryCount: entryCount - consumed,
  };
}

function collectNativeEntries(entries) {
  const posted = new Map();
  let entryCount = 0;
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string')
      invalid('Native postback requires textual entries');
    const values = posted.get(pair[0]) ?? [];
    values.push(pair[1]);
    posted.set(pair[0], values);
    entryCount++;
  }
  return { posted, entryCount };
}

function nativePostbackTarget(posted, descriptors) {
  const targets = posted.get('__EVENTTARGET') ?? [];
  if (targets.length !== 1) invalid('One native postback target required');
  if (!targets[0]) {
    const buttons = descriptors
      .flatMap((descriptor) => (descriptor?.actions ?? []).map((action) => action?.target))
      .filter((target) => posted.has(target));
    if (buttons.length !== 1) invalid('One native postback target required');
    targets[0] = buttons[0];
  }
  return targets[0];
}

/* NOSONAR */ function parseNativeFields(descriptor, posted) {
  const values = {};
  let consumed = 0;
  for (const field of descriptor.fields) {
    const found = posted.get(field.wireName);
    if (!found) {
      if (field.checkbox === true) values[field.name] = 'false';
      continue;
    }
    if (!field.multiple && found.length !== 1) invalid('Ambiguous scalar native form value');
    if (dangerous.has(field.name)) invalid('Invalid native form field');
    if (field.checkbox === true) values[field.name] = found[0] ? 'true' : 'false';
    else if (field.multiple) values[field.name] = [...found];
    else values[field.name] = found[0];
    consumed += found.length;
  }
  return { values, consumed };
}

function matchingActions(descriptor, target) {
  validatePostbackDescriptor(descriptor);
  return descriptor.actions.filter((action) => action.target === target).map((action) => ({ descriptor, action }));
}

function validatePostbackDescriptor(descriptor) {
  if (!descriptor || !Array.isArray(descriptor.actions) || !Array.isArray(descriptor.fields))
    invalid('Invalid native postback descriptor');
  if (
    !['entityform', 'webform'].includes(descriptor.kind) ||
    typeof descriptor.formId !== 'string' ||
    !descriptor.formId
  )
    invalid('Invalid native postback identity');
  const fieldNames = new Set();
  const logicalNames = new Set();
  for (const field of descriptor.fields) {
    if (
      !field ||
      typeof field.name !== 'string' ||
      !field.name ||
      dangerous.has(field.name) ||
      typeof field.wireName !== 'string' ||
      !field.wireName ||
      fieldNames.has(field.wireName) ||
      logicalNames.has(field.name)
    )
      invalid('Invalid or ambiguous native postback field');
    fieldNames.add(field.wireName);
    logicalNames.add(field.name);
  }
  for (const action of descriptor.actions)
    if (
      !action ||
      typeof action.target !== 'string' ||
      !actions.has(action.action) ||
      (action.actionIndex != null && (!Number.isInteger(action.actionIndex) || action.actionIndex < 0))
    )
      invalid('Invalid native postback action');
}

/**
 * Text controls of a multipart/form-data postback, in posted order. Empty file inputs are
 * skipped; selected files (the attach-file control) are returned on `files` as
 * {field, name, type, content (base64)} for the form service to save as annotations.
 */
export async function multipartControls(bytes, contentType) {
  let data;
  try {
    data = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new NativePostbackError('Malformed multipart native postback');
  }
  const controls = new URLSearchParams();
  controls.files = [];
  for (const [name, value] of data) {
    if (typeof value === 'string') controls.append(name, value);
    else if (value.size || value.name)
      controls.files.push({
        field: name,
        name: value.name,
        type: value.type,
        content: Buffer.from(await value.arrayBuffer()).toString('base64'),
      });
  }
  return controls;
}
