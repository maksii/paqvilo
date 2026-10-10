import { randomUUID } from "node:crypto";
import { approximateFormSchema, approximateAdvancedFormSchema } from "./form-schema-fallback.mjs";
import { DataError } from "./data.mjs";
import { portalField } from "./importer.mjs";
import { schemaFromFormXml } from "./platform.mjs";

const canonical = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const fail = (message, status = 400, code = "InvalidFormSubmission") => {
  throw new DataError(message, status, code);
};
const truthy = (value) => value === true || /^(true|1)$/i.test(String(value ?? ""));
const falsy = (value) => value === false || /^(false|0)$/i.test(String(value ?? ""));

/**
 * A localized form label or message: plain text, or [{LCID, Value}] (PAC exports) in the
 * request's selected website language, else the website's default language, else the first
 * value. `language` is { lcid, defaultLcid }.
 */
export function formText(value, fallback = "", language = {}) {
  if (value == null || value === "") return fallback;
  let rows = value;
  if (typeof value === "string") {
    if (!/^\s*\[\s*\{/.test(value)) return value;
    try {
      rows = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (!Array.isArray(rows)) return String(value);
  const byLcid = (lcid) => (lcid ? rows.find((row) => Number(row?.LCID) === Number(lcid)) : undefined);
  return (byLcid(language?.lcid) ?? byLcid(language?.defaultLcid) ?? rows[0])?.Value || fallback;
}

// ---------------------------------------------------------------------------
// Advanced (multistep) form sessions. Native Power Pages persists the step history in
// adx_webformsession, per signed-in user or anonymous visitor; unless Start New Session On
// Load, the user can leave and resume where they left off (Learn, "Define multistep form
// properties"). Each runtime keeps its own sessions in memory (a restart starts new ones).
// The owner is the signed-in contact ("contact:<id>", resumed from any browser session of
// that contact) or the anonymous visitor of one browser session ("visitor:<id>", from a
// runtime cookie); a request with neither resumes nothing.

/** The session owner of a request: the signed-in contact, else the anonymous browser visitor. */
export function webFormSessionOwner(identity, visitorId) {
  const contact = canonical(identity?.contactId ?? identity?.id);
  if (contact) return `contact:${contact}`;
  const visitor = canonical(visitorId);
  return visitor ? `visitor:${visitor}` : null;
}

/** The advanced form sessions of one runtime. */
export function createWebFormSessions({ limit = 1000 } = {}) {
  const sessions = new Map();
  return {
    get: (id) => sessions.get(canonical(id)) ?? null,
    /** The sessions of `owner` for one form, newest first. */
    list: (webformId, owner) =>
      owner ? [...sessions.values()].reverse().filter((session) => session.webformId === canonical(webformId) && session.owner === owner) : [],
    create(webformId, owner, startNew = false) {
      const session = { id: randomUUID(), webformId: canonical(webformId), owner, history: [], current: null, active: true, completed: false, startNew };
      sessions.set(session.id, session);
      if (sessions.size > limit) sessions.delete(sessions.keys().next().value);
      return session;
    },
  };
}
// Direct library callers that pass no runtime sessions share these.
const librarySessions = createWebFormSessions();

/**
 * The session of `owner` for a form: the one named by `sessionId`, else (unless `startNew`)
 * the owner's latest active session, else a new one when `create`.
 */
export function webFormSession({ webformId, owner, identity, sessionId, startNew = false, create = false, sessions = librarySessions }) {
  owner ??= webFormSessionOwner(identity);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session && session.webformId === canonical(webformId) && session.owner === owner && session.active) return session;
  }
  if (!startNew) {
    const resumed = sessions.list(webformId, owner).find((session) => session.active);
    if (resumed) return resumed;
  }
  return create ? sessions.create(webformId, owner, startNew) : null;
}

/**
 * The steps a session accepts: its current step and the steps it already saved (Previous
 * returns to them); a session without progress accepts only the start step. Other steps,
 * and condition and redirect steps, are reached only through the session's own routing.
 */
export function sessionSteps(session, initialStepId) {
  const steps = new Set();
  if (session?.current) steps.add(canonical(session.current));
  for (const entry of session?.history ?? []) steps.add(canonical(entry.stepId));
  if (!steps.size) steps.add(canonical(initialStepId));
  return steps;
}

// Learn documents this default for Edit Expired Message; Edit Not Permitted Message has no
// documented default, so the same completion message stands in for an unset one.
const COMPLETED_MESSAGE = "You have already completed a submission. Thank you!";

/**
 * Form-level access of an advanced form (Learn, "Define multistep form properties"):
 * - Authentication Required: an anonymous visitor is sent to sign in ({ signIn: true }).
 * - Multiple Records Per User Permitted = No: a signed-in user who completed the form
 *   continues that submission ({ session }, its saved steps edit their records again) when
 *   Edit Existing Record Permitted and the record does not match Edit Expired State Code and
 *   Status Reason; otherwise the form shows Edit Not Permitted or Edit Expired Message
 *   ({ message, code }) instead of accepting another submission.
 * Returns null when neither setting applies.
 */
export async function advancedFormAccess({ definition, identity, owner, sessions = librarySessions, initialStepId, readRecord, language = {} }) {
  const form = definition?.metadata ?? {};
  const signedIn = Boolean(canonical(identity?.contactId ?? identity?.id));
  if (truthy(portalField(form, "authenticationrequired")) && !signedIn) return { signIn: true, code: "FormAuthenticationRequired" };
  if (!signedIn || !falsy(portalField(form, "multiplerecordsperuserpermitted"))) return null;
  owner ??= webFormSessionOwner(identity);
  const previous = sessions.list(definition.id, owner).find((session) => session.completed);
  if (!previous) return null;
  const message = (name) => formText(portalField(form, name), "", language) || COMPLETED_MESSAGE;
  if (falsy(portalField(form, "editexistingrecordpermitted"))) return { message: message("editnotpermittedmessage"), code: "FormEditNotPermitted" };
  const saved = previous.history.find((entry) => entry.recordId);
  const stateCode = portalField(form, "editexpiredstatecode"),
    statusCode = portalField(form, "editexpiredstatuscode");
  if (saved && readRecord && stateCode != null && stateCode !== "" && statusCode != null && statusCode !== "") {
    const record = await readRecord(saved.entity, saved.recordId);
    const code = (value) => Number(value && typeof value === "object" ? value.value : value);
    if (record && code(record.statecode) === Number(stateCode) && code(record.statuscode) === Number(statusCode))
      return { message: message("editexpiredmessage"), code: "FormEditExpired" };
  }
  previous.active = true;
  previous.completed = false;
  previous.current = canonical(initialStepId);
  return { session: previous };
}
export function sessionRecord(session, stepId) {
  return session?.history.find((entry) => canonical(entry.stepId) === canonical(stepId))?.recordId ?? null;
}
/** The record of the step saved before `stepId` (or the latest saved step) in this session. */
export function previousSessionRecord(session, stepId) {
  const history = session?.history ?? [];
  const index = history.findIndex((entry) => canonical(entry.stepId) === canonical(stepId));
  const earlier = index >= 0 ? history.slice(0, index) : history;
  return [...earlier].reverse().find((entry) => entry.recordId)?.recordId ?? null;
}

// ---------------------------------------------------------------------------
// Multistep condition expressions: "attr = value & (other != 2 | !flag)".

export function evaluateStepCondition(expression, record) {
  const tokens = [];
  const source = String(expression ?? "");
  const pattern = /\s*(\(|\)|&|\||!(?!=)|==\*|=\*|!=\*|~=|==|!=|>=|<=|=|>|<|'[^']*'|"[^"]*"|[^\s()&|!=<>~]+)/gy;
  let match;
  while ((match = pattern.exec(source))) tokens.push(match[1]);
  if (tokens.join("").replace(/\s/g, "") !== source.replace(/\s/g, "")) fail("Unsupported multistep condition expression", 501, "ADVANCEDFORM_CONDITION_UNSUPPORTED");
  let index = 0;
  const peek = () => tokens[index];
  const literal = (text) => {
    if (/^['"].*['"]$/.test(text)) return text.slice(1, -1);
    if (/^null$/i.test(text)) return null;
    if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text;
  };
  const value = (name) => {
    const raw = record?.[name];
    const scalar = raw && typeof raw === "object" ? (raw.id ?? raw.value) : raw;
    return scalar;
  };
  const compare = (left, operator, right) => {
    const a = typeof right === "number" && left != null && left !== "" ? Number(left) : typeof right === "boolean" ? truthy(left) : left;
    const like = (text, patternText) => new RegExp(`^${String(patternText).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, ".*")}$`, "i").test(String(text ?? ""));
    switch (operator) {
      case "=":
      case "==":
        return right === null ? a == null || a === "" : typeof right === "string" && /\*/.test(right) ? like(a, right) : String(a ?? "").toLowerCase() === String(right ?? "").toLowerCase();
      case "!=":
        return right === null ? !(a == null || a === "") : String(a ?? "").toLowerCase() !== String(right ?? "").toLowerCase();
      case "=*":
      case "==*":
      case "~=":
        return like(a, right);
      case "!=*":
        return !like(a, right);
      case ">":
        return a > right;
      case "<":
        return a < right;
      case ">=":
        return a >= right;
      case "<=":
        return a <= right;
      default:
        return fail(`Unsupported condition operator ${operator}`, 501, "ADVANCEDFORM_CONDITION_UNSUPPORTED");
    }
  };
  const primary = () => {
    const token = tokens[index++];
    if (token === "(") {
      const result = or();
      if (tokens[index++] !== ")") fail("Unbalanced multistep condition", 501, "ADVANCEDFORM_CONDITION_UNSUPPORTED");
      return result;
    }
    if (token === "!") return !primary();
    if (!/^[a-z_][\w]*$/i.test(token ?? "")) fail("Multistep condition requires an attribute name", 501, "ADVANCEDFORM_CONDITION_UNSUPPORTED");
    const operator = peek();
    if (!/^(==\*|=\*|!=\*|~=|==|!=|>=|<=|=|>|<)$/.test(operator ?? "")) return truthy(value(token));
    index++;
    return compare(value(token), operator, literal(tokens[index++]));
  };
  const and = () => {
    let result = primary();
    while (peek() === "&") {
      index++;
      result = primary() && result;
    }
    return result;
  };
  const or = () => {
    let result = and();
    while (peek() === "|") {
      index++;
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (index !== tokens.length) fail("Unsupported multistep condition expression", 501, "ADVANCEDFORM_CONDITION_UNSUPPORTED");
  return Boolean(result);
}

function appendRedirectQuery(target, query) {
  target.search += `${target.search ? '&' : '?'}${query}`;
}

/** A missing exported name produces the native bare record identifier query. */
export function appendRedirectRecordId(target, name, recordId) {
  const value = canonical(recordId);
  appendRedirectQuery(target, name ? new URLSearchParams([[name, value]]).toString() : encodeURIComponent(value));
}

/** Native redirect composition (adx_redirect* and appended query strings). */
export function redirectTarget(settings, { portal, recordId, record, requestUrl }) {
  const origin = new URL(requestUrl ?? "http://localhost/");
  const configured = portalField(settings, "redirecturl");
  let target;
  if (configured) target = new URL(/^https?:/i.test(configured) ? configured : /^\//.test(configured) ? configured : `https://${configured}`, origin);
  else {
    const pageId = canonical(portalField(settings, "redirectwebpage"));
    const page = pageId ? portal.pages.find((candidate) => canonical(candidate.id) === pageId) : null;
    if (!page) return null;
    target = new URL(page.url, origin);
  }
  if (truthy(portalField(settings, "redirecturlappendentityidquerystring")) && recordId)
    appendRedirectRecordId(target, portalField(settings, "redirecturlquerystringname"), recordId);
  if (truthy(portalField(settings, "appendquerystring"))) for (const [key, value] of origin.searchParams) appendRedirectQuery(target, new URLSearchParams([[key, value]]).toString());
  const custom = portalField(settings, "redirecturlcustomquerystring");
  if (custom) for (const [key, value] of new URLSearchParams(String(custom).replace(/^\?/, ""))) appendRedirectQuery(target, new URLSearchParams([[key, value]]).toString());
  const parameter = portalField(settings, "redirecturlquerystringattributeparamname");
  const attribute = portalField(settings, "redirecturlquerystringattribute");
  if (parameter && attribute && record) {
    const raw = record[attribute];
    const value = raw && typeof raw === "object" ? (raw.id ?? raw.value) : raw;
    if (value != null) appendRedirectQuery(target, new URLSearchParams([[parameter, canonical(value) === String(value).toLowerCase() && /^[0-9a-f-]{36}$/i.test(String(value)) ? canonical(value) : String(value)]]).toString());
  }
  return target.origin === origin.origin ? target.pathname + target.search + target.hash : target.href;
}

/**
 * A multistep step by id: the imported layout step, or a condition/redirect
 * step synthesized from the exported adx_webformstep record.
 */
export function advancedFormStep(portal, formSchema, stepId) {
  const id = canonical(stepId);
  if (!id) return null;
  const record = (portal.records ?? []).find((row) => row.kind === "advancedformstep" && canonical(row.id) === id);
  const type = record ? Number(portalField(record, "type") ?? 100000001) : null;
  const imported = (formSchema?.steps ?? []).find((step) => canonical(step.stepId) === id);
  if (imported) return { ...imported, metadata: imported.metadata ?? record ?? {} };
  if (!record) return null;
  if (type === 100000000)
    return {
      stepId: id,
      type: "condition",
      condition: portalField(record, "condition"),
      nextStepId: canonical(portalField(record, "nextstep")),
      conditionDefaultNextStepId: canonical(portalField(record, "conditiondefaultnextstep")),
      metadata: record,
    };
  if (type === 100000003) return { stepId: id, type: "redirect", metadata: record };
  return null;
}

/** Redirect step settings: the exported adx_webformstep, else an explicit schema step. */
function redirectSettings(step) {
  if (step.metadata && Object.keys(step.metadata).length) return step.metadata;
  return {
    adx_redirecturl: step.redirectUrl,
    adx_redirectwebpage: step.redirectWebPageId,
    adx_redirecturlappendentityidquerystring: step.appendRecordId,
    adx_redirecturlquerystringname: step.recordQueryName,
  };
}

function nextStepUrl(stepId, session, requestUrl, startNew) {
  const target = new URL(requestUrl ?? "http://localhost/");
  target.searchParams.set("stepid", stepId);
  if (startNew) target.searchParams.set("sessionid", session.id);
  else target.searchParams.delete("sessionid");
  return target.pathname + target.search;
}

/**
 * Run `work(operations)` as one unit of writes: the provider's transaction(work) when it has
 * one (the runtime: its local store, or the live bridge with compensation), a DataStore's
 * transact over its record operations, else the provider's own operations in sequence.
 */
async function writeUnit(provider, work) {
  if (typeof provider.transaction === "function") return provider.transaction(work);
  if (typeof provider.transact === "function" && typeof provider.createRecord === "function")
    return provider.transact(() =>
      work({
        create: (entity, values, identity) => provider.createRecord(entity, values, identity),
        update: (entity, id, values, identity) => provider.updateRecord(entity, id, values, identity),
        associate: (entity, id, navigation, targetId, identity) => provider.changeAssociationRecord(entity, id, navigation, targetId, identity, true),
      }),
    );
  return work(provider);
}

/** Native form saves have their own schema and table-permission boundary, separate from Web API site settings. */
export async function submitPortalForm(
  kind,
  componentId,
  body,
  {
    portal,
    store,
    schemas = {},
    metadata = null,
    identity = {},
    writeProvider = store,
    readProvider = store,
    now = () => new Date(),
    requestUrl,
    // The runtime's advanced form sessions and the request's session owner (webFormSessionOwner).
    sessions = librarySessions,
    owner,
    // The request's selected website language: { lcid, defaultLcid }.
    language = {},
  },
) {
  const text = (value, fallback = "") => formText(value, fallback, language);
  if (!["entityform", "webform"].includes(kind)) fail("Unsupported native form kind", 404);
  const definition = (kind === "webform" ? portal.advancedForms : portal.forms)?.find(
    (row) => canonical(row.id) === canonical(componentId),
  );
  if (!definition) fail("Native form is not exported", 404, "FormNotFound");
  if (!body || typeof body !== "object" || Array.isArray(body) || !body.values || typeof body.values !== "object" || Array.isArray(body.values))
    fail("Native form submission requires a values object");
  const action = body.action ?? "submit";
  if (!["submit", "previous"].includes(action)) fail("Unsupported native form action", 400, "InvalidFormAction");
  const pageUrl = (() => {
    try {
      const base = new URL(requestUrl ?? "http://localhost/");
      const query = body.query && typeof body.query === "object" && !Array.isArray(body.query) ? body.query : {};
      const target = new URL(typeof body.pageUrl === "string" && body.pageUrl.startsWith("/") ? body.pageUrl : base.pathname, base);
      for (const [key, value] of Object.entries(query)) if (typeof value === "string") target.searchParams.set(key, value);
      return target.href;
    } catch {
      return requestUrl;
    }
  })();
  const query = body.query && typeof body.query === "object" && !Array.isArray(body.query) ? body.query : {};
  // Forms whose systemform is absent from the solutions submit the approximated layout
  // that the renderer displayed (lib/form-schema-fallback.mjs).
  let formSchema = schemas[definition.id] ?? schemas[definition.name];
  if (!formSchema && kind === "entityform") formSchema = approximateFormSchema({ definition, portal, metadata });
  if (kind === "webform") formSchema = approximateAdvancedFormSchema({ definition, portal, metadata, schema: formSchema });
  if (!formSchema) fail("Native form layout is unresolved", 501, "FormSchemaRequired");
  let schema = formSchema;
  let session = null;
  const startNew = truthy(portalField(definition.metadata ?? {}, "startnewsessiononload"));
  if (schema.steps) {
    owner = owner === undefined ? webFormSessionOwner(identity) : owner;
    const access = await advancedFormAccess({
      definition,
      identity,
      owner,
      sessions,
      initialStepId: schema.initialStepId,
      readRecord: (entity, id) => readProvider.get(entity, id, identity),
      language,
    });
    if (access?.signIn) fail("Sign in to submit this form.", 401, access.code);
    if (access?.message) fail(access.message, 403, access.code);
    session = access?.session ?? webFormSession({ webformId: definition.id, owner, sessionId: query.sessionid, startNew, sessions });
    // A submission names a step its session accepts (the current step or one it saved) or the
    // step its page URL opened directly (stepid, as platform step URLs and portal links carry).
    const stepId = body.stepId ?? query.stepid ?? session?.current ?? schema.initialStepId;
    const opened = typeof query.stepid === "string" && canonical(query.stepid) === canonical(stepId);
    if (!opened && !sessionSteps(session, schema.initialStepId).has(canonical(stepId)))
      fail(`Step '${stepId}' is neither a step of this form session nor the step its page opened`, 400, "InvalidFormStep");
    schema = schema.steps.find((step) => canonical(step.stepId) === canonical(stepId));
    if (!schema || ["redirect", "condition"].includes(schema.type)) fail("Native form step does not accept a submission", 400, "InvalidFormStep");
    session ??= sessions.create(definition.id, owner, startNew);
    if (action === "previous") {
      const index = session.history.findIndex((entry) => canonical(entry.stepId) === canonical(schema.stepId));
      const previous = index > 0 ? session.history[index - 1] : session.history.at(-1);
      if (!previous || canonical(previous.stepId) === canonical(schema.stepId)) fail("There is no previous step", 400, "InvalidFormStep");
      if (portalField(schema.metadata ?? {}, "movepreviouspermitted") === false) fail("Moving to the previous step is not permitted", 403, "InvalidFormStep");
      session.current = previous.stepId;
      return { operation: "navigate", stepId: schema.stepId, recordId: previous.recordId ?? null, outcome: { type: "step", url: nextStepUrl(previous.stepId, session, pageUrl, startNew) } };
    }
  } else if (body.stepId) fail("Basic forms do not accept an advanced step", 400, "InvalidFormStep");
  else if (action === "previous") fail("Basic forms do not have a previous step", 400, "InvalidFormAction");
  if (schema.formXml) schema = { ...schema, ...schemaFromFormXml(schema.formXml, { ...schema, entity: schema.entity ?? definition.entityName }) };
  if (!schema.entity) fail("Native form table is unresolved", 501, "FormEntityRequired");
  const componentMetadata = schema.metadata ?? definition.metadata ?? {};
  let mode = Number(schema.mode ?? definition.mode);
  if (mode === 100000002) fail("This native form is read-only", 403, "FormReadOnly");
  // A multistep insert step becomes an edit once its record exists in the session.
  const sessionRecordId = session ? sessionRecord(session, schema.stepId) : null;
  if (session && mode === 100000000 && sessionRecordId) mode = 100000001;
  // Allow Create If Null applies only to a record associated to the current portal user
  // (basic form 756150003, advanced form step 100000004), as when the form renders; an
  // advanced form step carries its own record source.
  const sourceMetadata = kind === "webform" ? (schema.metadata ?? {}) : (definition.metadata ?? {});
  const sourceType = Number(portalField(sourceMetadata, "entitysourcetype") ?? 0);
  const create =
    mode === 100000000 ||
    (!body.recordId && [756150003, 100000004].includes(sourceType) && truthy(portalField(sourceMetadata, "recordsourceallowcreateonnull")));
  if (create && body.recordId) fail("A create form cannot select an existing record");
  const recordId = schema.recordId ?? body.recordId ?? sessionRecordId;
  if (!create && !recordId) fail("This native form requires its record identifier", 400, "FormRecordRequired");
  if (schema.recordId && body.recordId && canonical(schema.recordId) !== canonical(body.recordId))
    fail("The submitted record differs from the form record", 403, "FormRecordMismatch");
  const mapping = store.resolveMapping(schema.entity);
  const formMetadata = (portal.records ?? []).filter(
    (row) =>
      ["basicformmetadata", "advancedformmetadata"].includes(row.kind) &&
      (canonical(portalField(row, "entityform")) === canonical(definition.id) ||
        (schema.stepId && canonical(portalField(row, "webformstep")) === canonical(schema.stepId))),
  );
  const effectiveFields = (schema.fields ?? [])
    .filter((field) => !(field.name === "ownerid" && portalField(definition.metadata ?? {}, "showownerfields", false) === false))
    .map((field) => {
      const metadata = formMetadata.find((row) => Number(portalField(row, "type") ?? 100000000) === 100000000 && portalField(row, "attributelogicalname") === field.name);
      const immutable = create ? field.validForCreate === false : field.validForUpdate === false;
      return {
        ...field,
        required: Boolean(portalField(metadata ?? {}, "fieldisrequired", portalField(metadata ?? {}, "requiredfield", field.required)) || truthy(portalField(componentMetadata, "forceallfieldsrequired"))),
        readOnly: immutable || portalField(metadata ?? {}, "readonly", field.readOnly),
        pattern: portalField(metadata ?? {}, "validationregularexpression") || field.pattern || null,
        patternMessage: text(portalField(metadata ?? {}, "validationregularexpressionerrormessage"), ""),
        label: text(portalField(metadata ?? {}, "label"), field.label ?? field.name),
      };
    });
  const fields = new Set(effectiveFields.map((field) => canonical(field.name)));
  const values = {};
  const changed = {};
  for (const [key, value] of Object.entries(body.values)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail("Invalid native form field");
    const binding = key.endsWith("@odata.bind");
    const relation = binding ? mapping.relationships?.[key.slice(0, -11)] : null;
    const column = relation?.many === false ? canonical(relation.from) : canonical(key);
    if (!fields.has(column) || (binding && !relation)) fail(`Field '${key}' is not bound to this native form`, 403, "FormFieldNotBound");
    values[key] = value;
    changed[column] = binding
      ? value === null
        ? null
        : typeof value === "string"
          ? decodeURIComponent(value.match(/\(([^()]*)\)$/)?.[1] ?? value)
          : value
      : value;
  }
  // The providers retain table, relationship, plugin and validation checks. Reads
  // prevent an update form from being used to manufacture a missing record.
  const current = create ? {} : await readProvider.get(schema.entity, recordId, identity);
  if (!current) fail(`Entity '${schema.entity}' With Id = ${canonical(recordId)} Does Not Exist`, 404, "FormRecordNotFound");
  const scalar = (value) => value?.id ?? value?.value ?? value;
  const empty = (value) => value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
  const assigned = new Set();
  let contactRecord;
  if (create && portalField(componentMetadata, "associatecurrentportaluser", false) === true) {
    if (portalField(componentMetadata, "portaluserlookupattributeisactivityparty", false) === true)
      fail("Current-user activity-party association requires an activity-party component", 501, "FormUserAssociationUnsupported");
    const name = canonical(portalField(componentMetadata, "targetentityportaluserlookupattribute", portalField(componentMetadata, "portaluserlookupattribute")));
    const attribute = effectiveFields.find((field) => canonical(field.name) === name) ?? schema.currentUserAssociationField;
    if (!name || !attribute || canonical(attribute.name) !== name || attribute.type !== "lookup")
      fail("Current-user association requires an imported contact lookup column", 501, "FormUserAssociationUnresolved");
    formMetadata.push({ adx_attributelogicalname: name, adx_setvalueonsave: true, adx_onsavetype: 100000002, adx_onsavefromattribute: "contactid" });
  }
  // These values come from exported metadata and authenticated server context,
  // never from additional client columns. Lookup bindings also work upstream.
  for (const metadata of formMetadata.filter((row) => portalField(row, "setvalueonsave", false) === true)) {
    const name = canonical(portalField(metadata, "attributelogicalname"));
    const field =
      effectiveFields.find((candidate) => canonical(candidate.name) === name) ??
      schema.onSaveFields?.find((candidate) => canonical(candidate.name) === name) ??
      (canonical(schema.currentUserAssociationField?.name) === name ? schema.currentUserAssociationField : null);
    if (!field) fail(`On-save attribute '${name}' is absent in the selected form schema`, 501, "FormSaveAttributeUnresolved");
    if (name === canonical(mapping.idColumn) || /^(uniqueidentifier|primarykey)$/i.test(field.dataverseType ?? ""))
      fail(`On-save unique identifier '${name}' is unsupported`, 501, "FormSaveAttributeUnsupported");
    const type = Number(portalField(metadata, "onsavetype"));
    let value, logical;
    if (type === 100000000) value = portalField(metadata, "onsavevalue");
    else if (type === 100000001) value = now().toISOString();
    else if (type === 100000002) {
      const contactId = identity.contactId ?? identity.id;
      if (!contactId) fail("On-save current contact requires a signed-in identity", 401, "FormSaveContactRequired");
      const attribute = canonical(portalField(metadata, "onsavefromattribute"));
      if (!/^[a-z][a-z0-9_]*$/.test(attribute) || ["constructor", "prototype", "__proto__"].includes(attribute))
        fail("On-save contact attribute is invalid", 501, "FormSaveAttributeUnsupported");
      if (attribute === "contactid") {
        value = contactId;
        logical = "contact";
      } else {
        contactRecord ??= await readProvider.get("contact", contactId, identity);
        if (!contactRecord) fail("On-save current contact record is unavailable", 404, "FormSaveContactNotFound");
        value = contactRecord[attribute];
        logical = value?.logical_name;
        if (value === undefined) fail(`On-save contact attribute '${attribute}' is absent`, 501, "FormSaveAttributeUnresolved");
      }
    } else fail(`On-save type '${type}' is unsupported`, 501, "FormSaveTypeUnsupported");
    if (value === undefined) fail(`On-save value for '${name}' is absent`, 501, "FormSaveValueRequired");
    for (const key of Object.keys(values)) {
      const relation = key.endsWith("@odata.bind") ? mapping.relationships?.[key.slice(0, -11)] : null;
      if (canonical(relation?.from ?? key) === name) delete values[key];
    }
    if (field.type === "lookup") {
      const targets = Object.entries(mapping.relationships ?? {}).filter(
        ([, relation]) => relation.many === false && canonical(relation.from) === name && (!logical || relation.entity === logical),
      );
      if (targets.length !== 1) fail(`On-save lookup '${name}' has an unresolved navigation target`, 501, "FormSaveLookupUnresolved");
      const [navigation, relation] = targets[0],
        target = store.resolveMapping(relation.entity),
        id = scalar(value);
      values[navigation + "@odata.bind"] = empty(id) ? null : `/${target.entitySet}(${encodeURIComponent(canonical(id))})`;
    } else {
      value = scalar(value);
      if (["boolean", "checkbox"].includes(field.type)) {
        if (value === true || value === false) {
        } else if (/^(true|false|0|1)$/i.test(String(value))) value = /^(true|1)$/i.test(String(value));
        else fail(`On-save boolean '${name}' is invalid`, 501, "FormSaveValueInvalid");
      } else if (field.type === "number") {
        if (value === "" || !Number.isFinite(Number(value))) fail(`On-save number '${name}' is invalid`, 501, "FormSaveValueInvalid");
        value = Number(value);
        if ((field.options || /^(int|picklist|state|status)$/i.test(field.dataverseType ?? "")) && !Number.isInteger(value))
          fail(`On-save integer '${name}' is invalid`, 501, "FormSaveValueInvalid");
      } else if (["date", "datetime-local"].includes(field.type)) {
        if (!Number.isFinite(new Date(value).getTime())) fail(`On-save date '${name}' is invalid`, 501, "FormSaveValueInvalid");
        value = new Date(value).toISOString();
      } else if (![undefined, "text", "textarea", "email", "url"].includes(field.type))
        fail(`On-save field type '${field.type}' is unsupported`, 501, "FormSaveAttributeUnsupported");
      values[field.name] = value;
    }
    changed[name] = scalar(value);
    assigned.add(name);
  }
  for (const field of effectiveFields) {
    const key = canonical(field.name),
      hasChange = Object.hasOwn(changed, key),
      value = hasChange ? changed[key] : (current[field.name] ?? field.default);
    if (field.readOnly && hasChange && !assigned.has(key)) {
      const expected = scalar(current[field.name] ?? field.default);
      if (!(empty(expected) && empty(scalar(value))) && String(scalar(value)) !== String(expected))
        fail(`Field '${field.name}' is read-only in this native form`, 403, "FormFieldReadOnly");
      for (const name of Object.keys(values)) {
        const relation = name.endsWith("@odata.bind") ? mapping.relationships?.[name.slice(0, -11)] : null;
        if (canonical(relation?.from ?? name) === key) delete values[name];
      }
    }
    const requiredEmpty =
      field.richText && !/<img\b/i.test(String(value ?? ""))
        ? empty(
            String(value ?? "")
              .replace(/<!--[\s\S]*?-->|<[^>]*>/g, "")
              .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
              .trim(),
          )
        : empty(scalar(value));
    if (field.required && !field.hidden && !field.readOnly && requiredEmpty) fail(`${field.label} is a required field.`, 400, "FormFieldRequired");
    // Server-side counterparts of the native regular-expression and length validators.
    if (hasChange && !empty(value) && typeof value === "string") {
      if (field.pattern) {
        let expression;
        try {
          expression = new RegExp(field.pattern);
        } catch {
          fail(`Field '${field.name}' has an invalid exported validation expression`, 501, "FormValidationExpressionInvalid");
        }
        const match = expression.exec(value);
        if (!match || match[0] !== value) fail(field.patternMessage || `${field.label} is not valid.`, 400, "FormFieldInvalid");
      }
      if (field.maxLength && !field.richText && value.length > Number(field.maxLength))
        fail(`${field.label} exceeds the maximum length of ${field.maxLength} characters.`, 400, "FormFieldTooLong");
    }
  }
  // Native reference parameters (refentity/refid/refrel) relate a created child
  // to its subgrid parent; Set Entity Reference metadata does the same from a query parameter.
  const relateAfterCreate = [];
  if (create) {
    const references = [];
    if (query.refentity && query.refid && query.refrel) references.push({ entity: canonical(query.refentity), id: canonical(query.refid), relationship: query.refrel, role: query.refrelrole });
    if (truthy(portalField(componentMetadata, "setentityreference"))) {
      const sourceType = Number(portalField(componentMetadata, "referenceentitysourcetype") ?? 756150000);
      const parameter = portalField(componentMetadata, "referencequerystringname");
      const entity = canonical(portalField(componentMetadata, "referenceentitylogicalname"));
      if (sourceType === 756150000 && parameter && entity && query[parameter]) {
        let referenceId = query[parameter];
        if (portalField(componentMetadata, "referencequerystringisprimarykey") === false) {
          const attribute = portalField(componentMetadata, "referencequeryattributelogicalname");
          if (!/^[a-z_][\w]*$/i.test(attribute ?? "")) fail("Entity reference query attribute is invalid", 501, "FormReferenceUnresolved");
          const targetMapping = store.resolveMapping(entity);
          const found = await readProvider.query(entity, { $filter: `${attribute} eq '${String(referenceId).replace(/'/g, "''")}'`, $top: 1 }, identity);
          referenceId = found.value?.[0]?.[targetMapping.idColumn];
        }
        if (referenceId)
          references.push({
            entity,
            id: canonical(referenceId),
            relationship: portalField(componentMetadata, "referenceentityrelationshipname"),
            lookup: portalField(componentMetadata, "referencetargetlookupattributelogicalname"),
          });
      }
    }
    for (const reference of references) {
      const lookup = Object.entries(mapping.relationships ?? {}).find(
        ([, relation]) =>
          relation.many === false &&
          relation.entity === reference.entity &&
          (reference.lookup ? canonical(relation.from) === canonical(reference.lookup) : relation.schemaName === reference.relationship),
      );
      if (lookup) {
        values[`${lookup[0]}@odata.bind`] = `/${store.resolveMapping(reference.entity).entitySet}(${encodeURIComponent(reference.id)})`;
        continue;
      }
      const parentMapping = store.resolveMapping(reference.entity);
      const parentNavigation = Object.entries(parentMapping.relationships ?? {}).find(
        ([name, relation]) => relation.many && relation.intersect && (name === reference.relationship || relation.schemaName === reference.relationship) && relation.entity === canonical(schema.entity),
      );
      if (!parentNavigation) fail(`Reference relationship '${reference.relationship}' is not mapped`, 501, "FormReferenceUnresolved");
      relateAfterCreate.push({ entity: reference.entity, id: reference.id, navigation: parentNavigation[0] });
    }
  }
  // Attach file: one annotation per uploaded file, as native forms store notes. Every file
  // is checked before anything is written.
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const notes = [];
  if (attachments.length) {
    if (!truthy(portalField(componentMetadata, "attachfile"))) fail("This native form does not accept attachments", 403, "FormAttachmentNotEnabled");
    if (!truthy(portalField(componentMetadata, "attachfileallowmultiple")) && attachments.length > 1) fail("This native form accepts one attachment", 400, "FormAttachmentInvalid");
    const maxKb = Number(portalField(componentMetadata, "attachfilemaxsize")) || 0;
    const accept = [portalField(componentMetadata, "attachfileaccept"), portalField(componentMetadata, "attachfileacceptextensions")].filter(Boolean).join(",");
    const restrict = truthy(portalField(componentMetadata, "attachfilerestrictaccept"));
    const fullname = identity?.fullname ?? identity?.name ?? "";
    const contactId = canonical(identity?.contactId ?? identity?.id);
    const annotationMapping = store.resolveMapping("annotation");
    const objectBinding = Object.entries(annotationMapping.relationships ?? {}).find(([, relation]) => relation.many === false && relation.from === "objectid" && relation.entity === canonical(schema.entity));
    for (const file of attachments) {
      if (!file || typeof file.name !== "string" || typeof file.content !== "string") fail("Attachment requires a name and base64 content", 400, "FormAttachmentInvalid");
      const size = Buffer.from(file.content, "base64").length;
      if (maxKb && size > maxKb * 1024) fail(text(portalField(componentMetadata, "attachfilesizeerrormessage"), `${file.name} exceeds the maximum file size.`), 400, "FormAttachmentTooLarge");
      if (restrict && accept && !accept.split(",").some((entry) => {
        const pattern = entry.trim().toLowerCase();
        if (!pattern) return false;
        if (pattern.startsWith(".")) return file.name.toLowerCase().endsWith(pattern);
        if (pattern.endsWith("/*")) return String(file.type ?? "").toLowerCase().startsWith(pattern.slice(0, -1));
        return String(file.type ?? "").toLowerCase() === pattern;
      }))
        fail(text(portalField(componentMetadata, "attachfiletypeerrormessage"), `${file.name} is not of the file type(s) "${accept}".`), 400, "FormAttachmentType");
      notes.push((savedId) => ({
        subject: `Note created on ${now().toUTCString()} by ${fullname}${contactId ? ` [contact:${contactId}]` : ""}`,
        notetext: "*WEB*",
        objecttypecode: schema.entity,
        filename: file.name.slice(0, 255),
        mimetype: String(file.type || "application/octet-stream").slice(0, 255),
        documentbody: file.content,
        filesize: size,
        ...(objectBinding ? { [`${objectBinding[0]}@odata.bind`]: `/${mapping.entitySet}(${savedId})` } : { objectid: { id: savedId, logical_name: schema.entity } }),
      }));
    }
  }
  // The record, its reference associations and its notes are written as one unit: a failure
  // in any of them (a table permission, a plugin, the provider) leaves none of them saved.
  const { record, savedId } = await writeUnit(writeProvider, async (operations) => {
    const record = create ? await operations.create(schema.entity, values, identity) : await operations.update(schema.entity, recordId, values, identity);
    const savedId = canonical(record?.[mapping.idColumn] ?? recordId);
    for (const relation of relateAfterCreate) {
      if (!operations.associate) fail("Native form reference association requires an association provider", 501, "FormReferenceUnsupported");
      await operations.associate(relation.entity, relation.id, relation.navigation, savedId, identity);
    }
    for (const note of notes) await operations.create("annotation", note(savedId), identity);
    return { record, savedId };
  });
  // Outcome: success message, redirect, or the next multistep step.
  const savedRecord = { ...current, ...record };
  let outcome;
  if (session) {
    const entryIndex = session.history.findIndex((entry) => canonical(entry.stepId) === canonical(schema.stepId));
    const entry = { stepId: schema.stepId, recordId: savedId, entity: schema.entity };
    if (entryIndex >= 0) session.history.splice(entryIndex, session.history.length - entryIndex, entry);
    else session.history.push(entry);
    let next = advancedFormStep(portal, formSchema, schema.nextStepId);
    const guard = new Set();
    while (next?.type === "condition" && !guard.has(next.stepId)) {
      guard.add(next.stepId);
      const passed = evaluateStepCondition(next.condition, savedRecord);
      next = advancedFormStep(portal, formSchema, passed ? next.nextStepId : next.conditionDefaultNextStepId);
    }
    if (next && next.type !== "redirect") {
      session.current = next.stepId;
      outcome = { type: "step", url: nextStepUrl(next.stepId, session, pageUrl, startNew) };
    } else {
      session.active = false;
      session.completed = true;
      const redirect = next?.type === "redirect" ? redirectTarget(redirectSettings(next), { portal, recordId: savedId, record: savedRecord, requestUrl: pageUrl }) : null;
      outcome = redirect
        ? { type: "redirect", url: redirect }
        : { type: "message", message: text(portalField(schema.metadata ?? {}, "successmessage"), "Submission completed successfully."), hideForm: portalField(schema.metadata ?? {}, "hideformonsuccess") !== false };
    }
  } else {
    const settings = (() => {
      try {
        return JSON.parse(portalField(componentMetadata, "settings") || "{}");
      } catch {
        return {};
      }
    })();
    const submitAction = (settings.Actions ?? []).find((candidate) => candidate.Type === "SubmitAction");
    const onSuccess = Number(portalField(componentMetadata, "onsuccess") ?? 756150000);
    if (onSuccess === 756150001) {
      const url = redirectTarget(componentMetadata, { portal, recordId: savedId, record: savedRecord, requestUrl: pageUrl });
      // A redirect without a resolvable target re-renders the page (native traces the error).
      outcome = url ? { type: "redirect", url } : { type: "none" };
    } else
      outcome = {
        type: "message",
        message: text(portalField(componentMetadata, "successmessage"), "") || text(submitAction?.SuccessMessage, "") || "Submission completed successfully.",
        hideForm: portalField(componentMetadata, "hideformonsuccess") !== false,
      };
  }
  const primaryName = mapping.nameColumn;
  return {
    record,
    recordId: savedId,
    entity: schema.entity,
    operation: create ? "create" : "update",
    componentId: definition.id,
    stepId: schema.stepId ?? null,
    sessionId: session?.id ?? null,
    name: primaryName ? (record?.[primaryName] ?? null) : null,
    outcome,
  };
}
