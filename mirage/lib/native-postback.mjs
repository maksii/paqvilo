/** Source-derived WebForms names shared by rendering and postback decoding. */
export const compactNativeControlId = (value) => String(value ?? "")
  .replace(/[{}]/g, "")
  .toLowerCase()
  .replace(/-/g, "")
  .replace(/[^A-Za-z0-9_]/g, "_");

export function nativeFormControlIds(kind, id, { modal = false, pageControl = false } = {}) {
  const N = compactNativeControlId(id);
  const prefix = "ctl00$ContentContainer$MainContent$EntityControls$";
  if (kind === "webform") return pageControl
    ? { wrapper: "WebFormControl", panel: "WebFormPanel", view: "EntityFormView", names: `${prefix}WebFormControl$EntityFormView$`, buttons: `${prefix}WebFormControl$` }
    : { wrapper: `WebFormControl_${N}`, panel: "WebFormPanel", view: "EntityFormView", names: `ctl00$ContentContainer$WebFormControl_${N}$EntityFormView$`, buttons: `ctl00$ContentContainer$WebFormControl_${N}$` };
  if (kind === "entityform") return modal || pageControl
    ? { wrapper: "EntityFormControl", panel: "EntityFormPanel", view: "EntityFormControl_EntityFormView", names: `${pageControl ? prefix : "ctl00$ContentContainer$MainContent$"}EntityFormControl$EntityFormControl_EntityFormView$`, buttons: `${pageControl ? prefix : "ctl00$ContentContainer$MainContent$"}EntityFormControl$` }
    : { wrapper: `EntityFormControl_${N}`, panel: "EntityFormPanel", view: `EntityFormControl_${N}_EntityFormView`, names: `ctl00$ContentContainer$EntityFormControl_${N}$EntityFormControl_${N}_EntityFormView$`, buttons: `ctl00$ContentContainer$EntityFormControl_${N}$` };
  throw new TypeError("Unknown native form kind");
}

export class NativePostbackError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativePostbackError";
    this.code = "InvalidNativePostback";
    this.status = 400;
  }
}

const invalid = (message) => { throw new NativePostbackError(message); };
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
const actions = new Set(["submit", "previous", "delete", "deactivate", "activate"]);

/**
 * The caller supplies only fields and actions resolved for a rendered component.
 * Record, step, identity and permission context remain server-owned.
 */
export function nativeFormPostbackDescriptor({ kind, formId, fields = [], actions: declaredActions = [], modal = false, pageControl = false }) {
  if (typeof formId !== "string" || !formId) invalid("Native form identity required");
  if (!Array.isArray(fields) || !Array.isArray(declaredActions)) invalid("Native form fields and actions must be arrays");
  const ids = nativeFormControlIds(kind, formId, { modal, pageControl });
  const names = new Set();
  const boundFields = [];
  for (const field of fields) {
    if (!field || typeof field.name !== "string" || !field.name || dangerous.has(field.name)) invalid("Invalid declared native form field");
    if (field.readOnly || field.disabled || field.ownerHidden) continue;
    const wireName = ids.names + field.name;
    // A column placed on the form more than once renders (and posts) only its first cell.
    if (names.has(wireName)) continue;
    names.add(wireName);
    boundFields.push({ name: field.name, wireName, multiple: field.multiple === true });
  }
  const targets = new Set();
  const boundActions = declaredActions.map((action) => {
    if (!action || typeof action.button !== "string" || !action.button || action.button.includes("$") || !actions.has(action.action)) invalid("Invalid declared native form action");
    if (action.actionIndex != null && (!Number.isInteger(action.actionIndex) || action.actionIndex < 0)) invalid("Invalid declared native action index");
    const target = ids.buttons + action.button;
    if (targets.has(target)) invalid("Ambiguous declared native form action");
    targets.add(target);
    return { target, action: action.action, ...(action.actionIndex != null ? { actionIndex: action.actionIndex } : {}) };
  });
  return { kind, formId, ids, fields: boundFields, actions: boundActions };
}

/**
 * Decode textual successful controls without choosing a transport or response.
 * Text, empty values and declared repeated values are retained for the service's
 * typed validation. Unposted fields are omitted; no checkbox value is invented.
 * Opaque state/token fields and controls belonging to other forms are not copied.
 */
export function parseNativePostback(entries, descriptors) {
  if (!entries || typeof entries[Symbol.iterator] !== "function" || !Array.isArray(descriptors)) invalid("Native postback entries and descriptors required");
  const posted = new Map();
  let entryCount = 0;
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") invalid("Native postback requires textual entries");
    const values = posted.get(pair[0]) ?? [];
    values.push(pair[1]);
    posted.set(pair[0], values);
    entryCount++;
  }
  const targets = posted.get("__EVENTTARGET") ?? [];
  if (targets.length !== 1 || !targets[0]) invalid("One native postback target required");
  const matches = descriptors.flatMap((descriptor) => {
    if (!descriptor || !Array.isArray(descriptor.actions) || !Array.isArray(descriptor.fields)) invalid("Invalid native postback descriptor");
    if (!["entityform", "webform"].includes(descriptor.kind) || typeof descriptor.formId !== "string" || !descriptor.formId) invalid("Invalid native postback identity");
    const fieldNames = new Set();
    const logicalNames = new Set();
    for (const field of descriptor.fields) {
      if (!field || typeof field.name !== "string" || !field.name || dangerous.has(field.name) || typeof field.wireName !== "string" || !field.wireName || fieldNames.has(field.wireName) || logicalNames.has(field.name)) invalid("Invalid or ambiguous native postback field");
      fieldNames.add(field.wireName);
      logicalNames.add(field.name);
    }
    for (const action of descriptor.actions) {
      if (!action || typeof action.target !== "string" || !actions.has(action.action) || (action.actionIndex != null && (!Number.isInteger(action.actionIndex) || action.actionIndex < 0))) invalid("Invalid native postback action");
    }
    return descriptor.actions.filter((action) => action.target === targets[0]).map((action) => ({ descriptor, action }));
  });
  if (matches.length !== 1) invalid("Native postback target is unknown or ambiguous");
  const { descriptor, action } = matches[0];
  const argumentsPosted = posted.get("__EVENTARGUMENT") ?? [];
  if (argumentsPosted.length > 1) invalid("Ambiguous native postback argument");
  const values = {};
  let consumed = targets.length + argumentsPosted.length;
  for (const field of descriptor.fields) {
    const found = posted.get(field.wireName);
    if (!found) continue;
    if (!field.multiple && found.length !== 1) invalid("Ambiguous scalar native form value");
    if (dangerous.has(field.name)) invalid("Invalid native form field");
    values[field.name] = field.multiple ? [...found] : found[0];
    consumed += found.length;
  }
  return {
    kind: descriptor.kind,
    formId: descriptor.formId,
    body: { action: action.action, ...(action.actionIndex != null ? { actionIndex: action.actionIndex } : {}), values },
    eventArgument: argumentsPosted[0] ?? "",
    ignoredEntryCount: entryCount - consumed,
  };
}

/**
 * Text controls of a multipart/form-data postback, in posted order. Empty file inputs are
 * skipped; a selected file is refused because native file controls save through their own
 * services, not the form postback.
 */
export async function multipartControls(bytes, contentType) {
  let data;
  try { data = await new Response(bytes, { headers: { "content-type": contentType } }).formData(); }
  catch { throw new NativePostbackError("Malformed multipart native postback"); }
  const controls = new URLSearchParams();
  for (const [name, value] of data) {
    if (typeof value === "string") controls.append(name, value);
    else if (value.size || value.name) throw Object.assign(new NativePostbackError("Native postback file submission is not supported"), { status: 415 });
  }
  return controls;
}
