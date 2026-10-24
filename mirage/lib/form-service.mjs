import { randomUUID } from 'node:crypto';
import { withNativeFormContactAssociation } from './native-form-association.mjs';
import { approximateFormSchema, approximateAdvancedFormSchema } from './form-schema-fallback.mjs';
import { DataError } from './data.mjs';
import { isSecuredField } from './dataverse-fls.mjs';
import { portalField } from './importer.mjs';
import { siteSetting } from './redirects.mjs';
import {
  schemaFromFormXml,
  nativeControlKind,
  nativeRangeMessage,
  nativeDateOnly,
  resolveFormRecord,
} from './platform.mjs';
import { parseDateValue } from './dataverse-values.mjs';
import { nativeFormActions, NATIVE_STATE_ACTIONS, nativeActionStateValues } from './native-form-actions.mjs';
import { isExactNumeric, decimalParts, compareNumeric, parseNumericLiteral } from './exact-numeric.mjs';

const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const fail = (message, status = 400, code = 'InvalidFormSubmission') => {
  throw new DataError(message, status, code);
};
const truthy = (value) => value === true || /^(true|1)$/i.test(String(value ?? ''));
const falsy = (value) => value === false || /^(false|0)$/i.test(String(value ?? ''));

// Required-field text uses lexical HTML handling, including
// unterminated comments falling back to an ordinary <...> span. Failed comment
// and tag searches are terminal: repeating opening delimiters cannot rescan the
// same suffix for every candidate.
function richTextRequiredText(value) {
  const source = String(value ?? ''),
    parts = [];
  let cursor = 0,
    canCloseComment = true;
  while (cursor < source.length) {
    const opening = source.indexOf('<', cursor);
    if (opening < 0) break;
    parts.push(source.slice(cursor, opening));
    if (canCloseComment && source.startsWith('<!--', opening)) {
      const closing = source.indexOf('-->', opening + 4);
      if (closing >= 0) {
        cursor = closing + 3;
        continue;
      }
      canCloseComment = false;
    }
    const closing = source.indexOf('>', opening + 1);
    if (closing < 0) {
      cursor = opening;
      break;
    }
    cursor = closing + 1;
  }
  parts.push(source.slice(cursor));
  return parts
    .join('')
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .trim();
}

/** Server-resolved context for a rendered form; submitted controls cannot replace it. */
export function nativeFormSubmissionContext({
  kind,
  formId,
  entity,
  mode,
  recordId = null,
  stepId = null,
  sessionId = null,
  recordQueryName = 'id',
}) {
  if (
    !['entityform', 'webform'].includes(kind) ||
    typeof formId !== 'string' ||
    !formId ||
    typeof entity !== 'string' ||
    !entity
  )
    fail('Resolved native form context required');
  if (![100000000, 100000001, 100000002].includes(mode)) fail('Resolved native form mode required');
  for (const value of [recordId, stepId, sessionId])
    if (value != null && typeof value !== 'string') fail('Resolved native form reference must be textual');
  if (typeof recordQueryName !== 'string') fail('Resolved record query name must be textual');
  return Object.freeze({ kind, formId, entity, mode, recordId, stepId, sessionId, recordQueryName });
}

/**
 * A localized form label or message: plain text, or [{LCID, Value}] (PAC exports) in the
 * request's selected website language, else the website's default language, else the first
 * value. `language` is { lcid, defaultLcid }.
 */
export function formText(value, fallback = '', language = {}) {
  if (value == null || value === '') return fallback;
  let rows = value;
  if (typeof value === 'string') {
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

// ---- Advanced (multistep) form sessions
// Native Power Pages persists the step history in adx_webformsession, per signed-in user or
// anonymous visitor; unless Start New Session On Load, the user can leave and resume where they
// left off. Each runtime keeps its own sessions in memory (a restart starts new ones).
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
      owner
        ? [...sessions.values()]
            .reverse()
            .filter((session) => session.webformId === canonical(webformId) && session.owner === owner)
        : [],
    create(webformId, owner, startNew = false) {
      const session = {
        id: randomUUID(),
        webformId: canonical(webformId),
        owner,
        history: [],
        current: null,
        active: true,
        completed: false,
        startNew,
      };
      sessions.set(session.id, session);
      if (sessions.size > limit) sessions.delete(sessions.keys().next().value);
      return session;
    },
    /** Forget every session (a data reset removes the adx_webformsession equivalents with the records). */
    clear: () => sessions.clear(),
  };
}
// Direct library callers that pass no runtime sessions share these.
const librarySessions = createWebFormSessions();

/**
 * The session of `owner` for a form: the one named by `sessionId`, else (unless `startNew`)
 * the owner's latest active session, else a new one when `create`.
 */
export function webFormSession({
  webformId,
  owner,
  identity,
  sessionId,
  startNew = false,
  create = false,
  sessions = librarySessions,
}) {
  owner ??= webFormSessionOwner(identity);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session && session.webformId === canonical(webformId) && session.owner === owner && session.active)
      return session;
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
function sessionSteps(session, initialStepId) {
  const steps = new Set();
  if (session?.current) steps.add(canonical(session.current));
  for (const entry of session?.history ?? []) steps.add(canonical(entry.stepId));
  if (!steps.size) steps.add(canonical(initialStepId));
  return steps;
}

// The platform documents this default for Edit Expired Message; Edit Not Permitted Message has
// no documented default, so the same completion message stands in for an unset one.
const COMPLETED_MESSAGE = 'You have already completed a submission. Thank you!';

/**
 * Form-level access of an advanced form:
 * - Authentication Required: an anonymous visitor is sent to sign in ({ signIn: true }).
 * - Multiple Records Per User Permitted = No: a signed-in user who completed the form
 *   continues that submission ({ session }, its saved steps edit their records again) when
 *   Edit Existing Record Permitted and the record does not match Edit Expired State Code and
 *   Status Reason; otherwise the form shows Edit Not Permitted or Edit Expired Message
 *   ({ message, code }) instead of accepting another submission.
 * Returns null when neither setting applies.
 */
export async function advancedFormAccess({
  definition,
  identity,
  owner,
  sessions = librarySessions,
  initialStepId,
  readRecord,
  language = {},
}) {
  const form = definition?.metadata ?? {};
  const signedIn = Boolean(canonical(identity?.contactId ?? identity?.id));
  if (truthy(portalField(form, 'authenticationrequired')) && !signedIn)
    return { signIn: true, code: 'FormAuthenticationRequired' };
  if (!signedIn || !falsy(portalField(form, 'multiplerecordsperuserpermitted'))) return null;
  owner ??= webFormSessionOwner(identity);
  const previous = sessions.list(definition.id, owner).find((session) => session.completed);
  if (!previous) return null;
  const message = (name) => formText(portalField(form, name), '', language) || COMPLETED_MESSAGE;
  if (falsy(portalField(form, 'editexistingrecordpermitted')))
    return { message: message('editnotpermittedmessage'), code: 'FormEditNotPermitted' };
  const saved = previous.history.find((entry) => entry.recordId);
  const stateCode = portalField(form, 'editexpiredstatecode'),
    statusCode = portalField(form, 'editexpiredstatuscode');
  if (saved && readRecord && stateCode != null && stateCode !== '' && statusCode != null && statusCode !== '') {
    const record = await readRecord(saved.entity, saved.recordId);
    const code = (value) => Number(value && typeof value === 'object' ? value.value : value);
    if (record && code(record.statecode) === Number(stateCode) && code(record.statuscode) === Number(statusCode))
      return { message: message('editexpiredmessage'), code: 'FormEditExpired' };
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

// ---- Multistep condition expressions: "attr = value & (other != 2 | !flag)".

export function evaluateStepCondition(expression, record) {
  const tokens = [];
  const ranges = [];
  const source = String(expression ?? '');
  const pattern = /\s*(\(|\)|&|\||!(?!=)|==\*|=\*|!=\*|~=|==|!=|>=|<=|=|>|<|'[^']*'|"[^"]*"|[^\s()&|!=<>~]+)/gy;
  let match;
  while ((match = pattern.exec(source))) {
    tokens.push(match[1]);
    ranges.push({ start: match.index + match[0].length - match[1].length, end: match.index + match[0].length });
  }
  if (tokens.join('').replace(/\s/g, '') !== source.replace(/\s/g, ''))
    fail('Unsupported multistep condition expression', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
  let index = 0;
  const peek = () => tokens[index];
  const literal = (text) => {
    if (/^(['"]).*\1$/.test(text)) return text.slice(1, -1);
    if (/^null$/i.test(text)) return null;
    if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
    if (/^-?\d+(\.\d+)?$/.test(text)) return parseNumericLiteral(text);
    return text;
  };
  const readLiteral = () => {
    const first = index;
    const token = tokens[index];
    if (token == null || /^(?:\(|\)|&|\||!|==\*|=\*|!=\*|~=|==|!=|>=|<=|=|>|<)$/.test(token))
      fail('Multistep condition requires a comparison value', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
    index++;
    if (/^['"]/.test(token) && !/^(['"]).*\1$/.test(token))
      fail('Multistep condition has an unterminated quoted value', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
    if (/^(['"]).*\1$/.test(token)) return literal(token);
    while (index < tokens.length && !/^(?:\(|\)|&|\||!|==\*|=\*|!=\*|~=|==|!=|>=|<=|=|>|<)$/.test(tokens[index])) {
      // A quoted literal cannot be extended by adjoining unquoted tokens.
      if (/^['"]/.test(tokens[index]))
        fail('Multistep condition mixes quoted and unquoted values', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
      index++;
    }
    return literal(source.slice(ranges[first].start, ranges[index - 1].end));
  };
  const value = (name) => {
    const raw = record?.[name];
    if (isExactNumeric(raw)) return raw;
    const scalar = raw && typeof raw === 'object' ? (raw.id ?? raw.value) : raw;
    return scalar;
  };
  const compare = (left, operator, right) => {
    const numericRight = typeof right === 'number' || isExactNumeric(right);
    if (numericRight && ['=', '==', '!=', '>', '<', '>=', '<='].includes(operator)) {
      // Keep saved Int64/Decimal digits and numeric literal digits out of
      // Number(). Numeric-string/boolean coercion still applies;
      // an empty/null value still does not equal the numeric literal zero.
      const numericLeft = isExactNumeric(left)
        ? left
        : typeof left === 'string' && /^\s*[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\s*$/.test(left)
          ? left.trim()
          : Number(left);
      const order = compareNumeric(numericLeft, right);
      const equal = left != null && left !== '' && order === 0;
      switch (operator) {
        case '=':
        case '==':
          return equal;
        case '!=':
          return !equal;
        case '>':
          return order > 0;
        case '<':
          return order < 0;
        case '>=':
          return order >= 0;
        case '<=':
          return order <= 0;
      }
    }
    const scalarLeft = isExactNumeric(left) ? left.value : left;
    const scalarRight = isExactNumeric(right) ? right.value : right;
    const a =
      typeof scalarRight === 'number' && scalarLeft != null && scalarLeft !== ''
        ? Number(scalarLeft)
        : typeof scalarRight === 'boolean'
          ? truthy(scalarLeft)
          : scalarLeft;
    right = scalarRight;
    const like = (text, patternText) =>
      new RegExp(
        `^${String(patternText)
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/%/g, '.*')}$`,
        'i',
      ).test(String(text ?? ''));
    switch (operator) {
      case '=':
      case '==':
        return right === null
          ? a == null || a === ''
          : typeof right === 'string' && /\*/.test(right)
            ? like(a, right)
            : String(a ?? '').toLowerCase() === String(right ?? '').toLowerCase();
      case '!=':
        return right === null
          ? !(a == null || a === '')
          : String(a ?? '').toLowerCase() !== String(right ?? '').toLowerCase();
      case '=*':
      case '==*':
      case '~=':
        return like(a, right);
      case '!=*':
        return !like(a, right);
      case '>':
        return a > right;
      case '<':
        return a < right;
      case '>=':
        return a >= right;
      case '<=':
        return a <= right;
      default:
        return fail(`Unsupported condition operator ${operator}`, 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
    }
  };
  const primary = () => {
    const token = tokens[index++];
    if (token === '(') {
      const result = or();
      if (tokens[index++] !== ')') fail('Unbalanced multistep condition', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
      return result;
    }
    if (token === '!') return !primary();
    if (!/^[a-z_][\w]*$/i.test(token ?? ''))
      fail('Multistep condition requires an attribute name', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
    const operator = peek();
    if (!/^(==\*|=\*|!=\*|~=|==|!=|>=|<=|=|>|<)$/.test(operator ?? '')) {
      const raw = value(token);
      return truthy(isExactNumeric(raw) ? raw.value : raw);
    }
    index++;
    return compare(value(token), operator, readLiteral());
  };
  const and = () => {
    let result = primary();
    while (peek() === '&') {
      index++;
      result = primary() && result;
    }
    return result;
  };
  const or = () => {
    let result = and();
    while (peek() === '|') {
      index++;
      result = and() || result;
    }
    return result;
  };
  const result = or();
  if (index !== tokens.length)
    fail('Unsupported multistep condition expression', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
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
  const origin = new URL(requestUrl ?? 'http://localhost/');
  const configured = portalField(settings, 'redirecturl');
  let target;
  if (configured)
    target = new URL(
      /^https?:/i.test(configured) ? configured : /^\//.test(configured) ? configured : `https://${configured}`,
      origin,
    );
  else {
    const pageId = canonical(portalField(settings, 'redirectwebpage'));
    const page = pageId ? portal.pages.find((candidate) => canonical(candidate.id) === pageId) : null;
    if (!page) return null;
    target = new URL(page.url, origin);
  }
  if (truthy(portalField(settings, 'redirecturlappendentityidquerystring')) && recordId)
    appendRedirectRecordId(target, portalField(settings, 'redirecturlquerystringname'), recordId);
  if (truthy(portalField(settings, 'appendquerystring')))
    for (const [key, value] of origin.searchParams)
      appendRedirectQuery(target, new URLSearchParams([[key, value]]).toString());
  const custom = portalField(settings, 'redirecturlcustomquerystring');
  if (custom)
    for (const [key, value] of new URLSearchParams(String(custom).replace(/^\?/, '')))
      appendRedirectQuery(target, new URLSearchParams([[key, value]]).toString());
  const parameter = portalField(settings, 'redirecturlquerystringattributeparamname');
  const attribute = portalField(settings, 'redirecturlquerystringattribute');
  if (parameter && attribute && record) {
    const raw = record[attribute];
    const value = raw && typeof raw === 'object' ? (raw.id ?? raw.value) : raw;
    if (value != null)
      appendRedirectQuery(
        target,
        new URLSearchParams([
          [
            parameter,
            canonical(value) === String(value).toLowerCase() && /^[0-9a-f-]{36}$/i.test(String(value))
              ? canonical(value)
              : String(value),
          ],
        ]).toString(),
      );
  }
  return target.origin === origin.origin ? target.pathname + target.search + target.hash : target.href;
}

/**
 * A multistep step by id: the imported layout step, or a condition/redirect
 * step synthesized from the exported adx_webformstep record.
 */
function advancedFormStep(portal, formSchema, stepId) {
  const id = canonical(stepId);
  if (!id) return null;
  const record = (portal.records ?? []).find((row) => row.kind === 'advancedformstep' && canonical(row.id) === id);
  const type = record ? Number(portalField(record, 'type') ?? 100000001) : null;
  const imported = (formSchema?.steps ?? []).find((step) => canonical(step.stepId) === id);
  if (imported) return { ...imported, metadata: imported.metadata ?? record ?? {} };
  if (!record) return null;
  if (type === 100000000)
    return {
      stepId: id,
      type: 'condition',
      condition: portalField(record, 'condition'),
      nextStepId: canonical(portalField(record, 'nextstep')),
      conditionDefaultNextStepId: canonical(portalField(record, 'conditiondefaultnextstep')),
      metadata: record,
    };
  if (type === 100000003) return { stepId: id, type: 'redirect', metadata: record };
  return null;
}

/** Missing referenced steps are incomplete local configuration, not terminal success. */
function requiredAdvancedFormStep(portal, schema, id) {
  if (!canonical(id)) return null;
  const step = advancedFormStep(portal, schema, id);
  if (!step) fail(`Referenced multistep '${id}' has no resolved local step`, 501, 'FormStepUnresolved');
  return step;
}

function nextAdvancedFormStep(portal, schema, id, record) {
  let next = requiredAdvancedFormStep(portal, schema, id);
  const visited = new Set();
  while (next?.type === 'condition') {
    if (visited.has(canonical(next.stepId)))
      fail(
        'Conditional multistep routing repeats a step without reaching a load or redirect step',
        501,
        'FormConditionCycle',
      );
    visited.add(canonical(next.stepId));
    const passed = evaluateStepCondition(next.condition, record);
    next = requiredAdvancedFormStep(portal, schema, passed ? next.nextStepId : next.conditionDefaultNextStepId);
  }
  return next;
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

/** Record a submitted (or viewed read-only) step in the session and return the step's outcome. */
function advanceSession(session, schema, next, savedId, savedRecord, { portal, pageUrl, startNew, text }) {
  const entryIndex = session.history.findIndex((entry) => canonical(entry.stepId) === canonical(schema.stepId));
  const entry = { stepId: schema.stepId, recordId: savedId, entity: schema.entity };
  if (entryIndex >= 0) session.history.splice(entryIndex, session.history.length - entryIndex, entry);
  else session.history.push(entry);
  if (next && next.type !== 'redirect') {
    session.current = next.stepId;
    return { type: 'step', url: nextStepUrl(next.stepId, session, pageUrl, startNew) };
  }
  session.active = false;
  session.completed = true;
  const redirect =
    next?.type === 'redirect'
      ? redirectTarget(redirectSettings(next), { portal, recordId: savedId, record: savedRecord, requestUrl: pageUrl })
      : null;
  return redirect
    ? { type: 'redirect', url: redirect }
    : {
        type: 'message',
        message: text(portalField(schema.metadata ?? {}, 'successmessage'), 'Submission completed successfully.'),
        hideForm: portalField(schema.metadata ?? {}, 'hideformonsuccess') !== false,
      };
}

function nextStepUrl(stepId, session, requestUrl, startNew) {
  const target = new URL(requestUrl ?? 'http://localhost/');
  target.searchParams.set('stepid', stepId);
  if (startNew) target.searchParams.set('sessionid', session.id);
  else target.searchParams.delete('sessionid');
  return target.pathname + target.search;
}

/**
 * Run `work(operations)` as one unit of writes: the provider's transaction(work) when it has
 * one (the runtime: its local store, or the live bridge with compensation), a DataStore's
 * transact over its record operations, else the provider's own operations in sequence.
 */
async function writeUnit(provider, work) {
  try {
    if (typeof provider.transaction === 'function') return await provider.transaction(work);
    if (typeof provider.transact === 'function' && typeof provider.createRecord === 'function')
      return await provider.transact(
        () =>
          work({
            ...portalRecordWrites(provider),
            associate: (entity, id, navigation, targetId, identity) =>
              provider.changeAssociationRecord(entity, id, navigation, targetId, identity, true),
          }),
        { incremental: true },
      );
    return await work(provider);
  } catch (cause) {
    // Only failures inside the atomic write become error postbacks.
    if (cause && typeof cause === 'object') cause.nativeFormWriteFailure = true;
    throw cause;
  }
}

/**
 * A portal form's record writes on a local store, inside the caller's store transaction: through the organization's
 * internal entries (dataverse-records.mjs, store.recordPipeline) when the store has an organization, so a form submission
 * runs the organization rules (state defaults, record hooks, audit and version columns, alternate-key answers) like any
 * other write; the form has authorized the write with its own permission checks. Without an organization the store writes.
 * options are the store write options of the caller (e.g. portalRequest); values are not coerced.
 * Every portal write outside the Web API (forms, list and subgrid actions, notes, server logic's Dataverse connector) uses
 * this one path, so enhanced authorization's principal (portal-authorization.mjs) and column security apply to all of them.
 */
export function portalRecordWrites(store, options = {}) {
  const records = store.recordPipeline;
  const internal = (identity) => [
    {
      identity,
      portal: true,
      caller: null,
      method: 'POST',
      headers: {},
      ...store.portalAuthorization?.principal(identity),
    },
    { authorized: true, writeOptions: { coerce: false, dataverseWebApi: false, ...options } },
  ];
  return {
    create: (entity, values, identity) => {
      if (!records) return store.createRecordAsync(entity, values, identity, options);
      const [c, opts] = internal(identity);
      return records.createInternal(c, entity, { ...values }, opts);
    },
    update: (entity, id, values, identity) => {
      if (!records) return store.updateRecordAsync(entity, id, values, identity, options);
      const [c, opts] = internal(identity);
      return records.updateInternal(c, entity, id, { ...values }, opts);
    },
    remove: (entity, id, identity) => {
      if (!records) return store.removeRecordAsync(entity, id, identity, options);
      const [c, opts] = internal(identity);
      return records.removeInternal(c, entity, id, opts);
    },
  };
}

// The provider key of a cloud attachment: attachments/<uuid>/<file name in key characters>.
const cloudKey = (name) =>
  `attachments/${randomUUID()}/${
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 200) || 'file'
  }`;
/** The note-text prefix that marks portal-visible notes: site setting KnowledgeManagement/NotesFilter, `*WEB*` by default. */
export const notesFilter = (portal) => siteSetting(portal ?? {}, 'KnowledgeManagement/NotesFilter') ?? '*WEB*';

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
    // Internal same-page adapter only; public JSON submissions retain their validation contract.
    nativePostback = false,
    // Cloud attachments (FileStorage/CloudStorageAccount): () => the guarded provider of storage route portalCloudAttachments
    // (throws ProviderError when the route is unset or not ready); diagnostic receives the refusal.
    cloudAttachments = null,
    diagnostic = () => {},
  },
) {
  const text = (value, fallback = '') => formText(value, fallback, language);
  if (!['entityform', 'webform'].includes(kind)) fail('Unsupported native form kind', 404);
  const definition = (kind === 'webform' ? portal.advancedForms : portal.forms)?.find(
    (row) => canonical(row.id) === canonical(componentId),
  );
  if (!definition) fail('Native form is not exported', 404, 'FormNotFound');
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !body.values ||
    typeof body.values !== 'object' ||
    Array.isArray(body.values)
  )
    fail('Native form submission requires a values object');
  const action = body.action ?? 'submit';
  if (!['submit', 'previous', ...Object.keys(NATIVE_STATE_ACTIONS)].includes(action))
    fail('Unsupported native form action', 400, 'InvalidFormAction');
  const stateAction = NATIVE_STATE_ACTIONS[action];
  if (stateAction && kind !== 'entityform') fail('Record state actions require a basic form', 400, 'InvalidFormAction');
  const pageUrl = (() => {
    try {
      const base = new URL(requestUrl ?? 'http://localhost/');
      const query = body.query && typeof body.query === 'object' && !Array.isArray(body.query) ? body.query : {};
      const target = new URL(
        typeof body.pageUrl === 'string' && body.pageUrl.startsWith('/') ? body.pageUrl : base.pathname,
        base,
      );
      for (const [key, value] of Object.entries(query))
        if (typeof value === 'string') target.searchParams.set(key, value);
      return target.href;
    } catch {
      return requestUrl;
    }
  })();
  const query = body.query && typeof body.query === 'object' && !Array.isArray(body.query) ? body.query : {};
  // Forms whose systemform is absent from the solutions submit the approximated layout
  // that the renderer displayed (lib/form-schema-fallback.mjs).
  let formSchema = schemas[definition.id] ?? schemas[definition.name];
  if (!formSchema && kind === 'entityform') formSchema = approximateFormSchema({ definition, portal, metadata });
  if (kind === 'webform')
    formSchema = approximateAdvancedFormSchema({ definition, portal, metadata, schema: formSchema });
  if (!formSchema) fail('Native form layout is unresolved', 501, 'FormSchemaRequired');
  let schema = formSchema;
  let session = null;
  const startNew = truthy(portalField(definition.metadata ?? {}, 'startnewsessiononload'));
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
    if (access?.signIn) fail('Sign in to submit this form.', 401, access.code);
    if (access?.message) fail(access.message, 403, access.code);
    session =
      access?.session ??
      webFormSession({ webformId: definition.id, owner, sessionId: query.sessionid, startNew, sessions });
    // A submission names a step its session accepts (the current step or one it saved) or the
    // step its page URL opened directly (stepid, as platform step URLs and portal links carry).
    const stepId = body.stepId ?? query.stepid ?? session?.current ?? schema.initialStepId;
    const opened = typeof query.stepid === 'string' && canonical(query.stepid) === canonical(stepId);
    if (!opened && !sessionSteps(session, schema.initialStepId).has(canonical(stepId)))
      fail(
        `Step '${stepId}' is neither a step of this form session nor the step its page opened`,
        400,
        'InvalidFormStep',
      );
    schema = schema.steps.find((step) => canonical(step.stepId) === canonical(stepId));
    if (!schema || ['redirect', 'condition'].includes(schema.type))
      fail('Native form step does not accept a submission', 400, 'InvalidFormStep');
    session ??= sessions.create(definition.id, owner, startNew);
    if (action === 'previous') {
      const index = session.history.findIndex((entry) => canonical(entry.stepId) === canonical(schema.stepId));
      const previous = index > 0 ? session.history[index - 1] : session.history.at(-1);
      if (!previous || canonical(previous.stepId) === canonical(schema.stepId))
        fail('There is no previous step', 400, 'InvalidFormStep');
      if (portalField(schema.metadata ?? {}, 'movepreviouspermitted') === false)
        fail('Moving to the previous step is not permitted', 403, 'InvalidFormStep');
      session.current = previous.stepId;
      return {
        operation: 'navigate',
        stepId: schema.stepId,
        recordId: previous.recordId ?? null,
        outcome: { type: 'step', url: nextStepUrl(previous.stepId, session, pageUrl, startNew) },
      };
    }
  } else if (body.stepId) fail('Basic forms do not accept an advanced step', 400, 'InvalidFormStep');
  else if (action === 'previous') fail('Basic forms do not have a previous step', 400, 'InvalidFormAction');
  if (schema.formXml)
    schema = {
      ...schema,
      ...schemaFromFormXml(schema.formXml, { ...schema, entity: schema.entity ?? definition.entityName }),
    };
  if (!schema.entity) fail('Native form table is unresolved', 501, 'FormEntityRequired');
  const componentMetadata = schema.metadata ?? definition.metadata ?? {};
  let mode = Number(schema.mode ?? definition.mode);
  if (mode === 100000002 && !stateAction) {
    if (!session) fail('This native form is read-only', 403, 'FormReadOnly');
    // A read-only advanced form step saves nothing: Next records the step as visited and moves on
    // (its postback answers 302 ?stepid=<next>).
    const source = await resolveFormRecord({
      kind,
      definition,
      schema,
      metadata,
      context: { request: { params: query } },
      readProvider,
      store,
      identity,
      session,
    });
    const viewedId = source.id ? canonical(source.id) : null;
    let viewed;
    try {
      viewed = (viewedId && (await readProvider.get(schema.entity, viewedId, identity))) || {};
    } catch {
      viewed = {};
    }
    const next = nextAdvancedFormStep(portal, formSchema, schema.nextStepId, viewed);
    return {
      record: null,
      recordId: viewedId,
      entity: schema.entity,
      operation: 'navigate',
      componentId: definition.id,
      stepId: schema.stepId,
      outcome: advanceSession(session, schema, next, viewedId, viewed, { portal, pageUrl, startNew, text }),
    };
  }
  // A multistep insert step becomes an edit once its record exists in the session.
  const sessionRecordId = session ? sessionRecord(session, schema.stepId) : null;
  if (session && mode === 100000000 && sessionRecordId) mode = 100000001;
  // Allow Create If Null applies only to a record associated to the current portal user
  // (basic form 756150003, advanced form step 100000004), as when the form renders; an
  // advanced form step carries its own record source.
  const sourceMetadata = kind === 'webform' ? (schema.metadata ?? {}) : (definition.metadata ?? {});
  const sourceType = Number(portalField(sourceMetadata, 'entitysourcetype') ?? 0);
  const create =
    mode === 100000000 ||
    (!body.recordId &&
      [756150003, 100000004].includes(sourceType) &&
      truthy(portalField(sourceMetadata, 'recordsourceallowcreateonnull')));
  if (create && body.recordId) fail('A create form cannot select an existing record');
  const recordId = schema.recordId ?? body.recordId ?? sessionRecordId;
  if (!create && !recordId) fail('This native form requires its record identifier', 400, 'FormRecordRequired');
  if (schema.recordId && body.recordId && canonical(schema.recordId) !== canonical(body.recordId))
    fail('The submitted record differs from the form record', 403, 'FormRecordMismatch');
  const mapping = store.resolveMapping(schema.entity);
  const configuredActions = nativeFormActions(componentMetadata);
  if (stateAction) {
    const matches = configuredActions
      .map((source, index) => ({ source, index }))
      .filter(
        ({ source, index }) =>
          source.Type === stateAction.type && (body.actionIndex == null || body.actionIndex === index),
      );
    if (matches.length !== 1)
      fail('This record action is not configured for the native form', 403, 'FormActionNotEnabled');
    const configured = matches[0].source;
    if (create) fail('Record actions require an existing record', 400, 'FormRecordRequired');
    if (Object.keys(body.values).length || (body.attachments?.length ?? 0))
      fail('Record actions do not accept field changes or attachments', 400, 'FormActionInvalid');
    if (configured.FilterCriteria)
      fail('Native record action filter criteria are unsupported', 501, 'FormActionFilterUnsupported');
    const source = await resolveFormRecord({
      kind,
      definition,
      schema,
      metadata,
      context: { request: { params: query } },
      readProvider,
      store,
      identity,
    });
    if (!source.id || canonical(source.id) !== canonical(recordId))
      fail('The submitted record differs from the form record source', 403, 'FormRecordMismatch');
    const current = await readProvider.get(schema.entity, recordId, identity);
    if (!current)
      fail(`Entity '${schema.entity}' With Id = ${canonical(recordId)} Does Not Exist`, 404, 'FormRecordNotFound');
    const stateValues = nativeActionStateValues(schema.entity, action, { metadata, store, schema });
    if (!stateValues)
      fail('Native record actions require unambiguous state and status metadata', 501, 'FormActionStateUnresolved');
    const { record } = await writeUnit(writeProvider, async (operations) => ({
      record: await operations.update(schema.entity, recordId, stateValues, identity),
    }));
    const savedId = canonical(recordId),
      savedRecord = { ...current, ...record };
    const redirect = [1, 2].includes(Number(configured.OnComplete))
      ? redirectTarget(
          { adx_redirectwebpage: configured.RedirectWebpageId, adx_redirecturl: configured.RedirectUrl },
          { portal, recordId: savedId, record: savedRecord, requestUrl: pageUrl },
        )
      : null;
    return {
      record,
      recordId: savedId,
      entity: schema.entity,
      operation: action,
      componentId: definition.id,
      name: mapping.nameColumn ? (savedRecord[mapping.nameColumn] ?? null) : null,
      outcome: redirect
        ? { type: 'redirect', url: redirect }
        : {
            type: 'message',
            message: text(
              configured.SuccessMessage,
              action === 'deactivate' ? 'The record has been deactivated.' : 'The record has been activated.',
            ),
            hideForm: false,
          },
    };
  }
  if (
    kind === 'entityform' &&
    configuredActions.length &&
    !configuredActions.some((candidate) => candidate.Type === 'SubmitAction')
  )
    fail('Submitting fields is not configured for this native form', 403, 'FormSubmitNotEnabled');
  const formMetadata = (portal.records ?? []).filter(
    (row) =>
      ['basicformmetadata', 'advancedformmetadata'].includes(row.kind) &&
      (canonical(portalField(row, 'entityform')) === canonical(definition.id) ||
        (schema.stepId && canonical(portalField(row, 'webformstep')) === canonical(schema.stepId))),
  );
  const effectiveFields = (schema.fields ?? [])
    .filter(
      (field) =>
        !(field.name === 'ownerid' && portalField(definition.metadata ?? {}, 'showownerfields', false) === false),
    )
    .map((field) => {
      const metadata = formMetadata.find(
        (row) =>
          Number(portalField(row, 'type') ?? 100000000) === 100000000 &&
          portalField(row, 'attributelogicalname') === field.name,
      );
      const immutable = create ? field.validForCreate === false : field.validForUpdate === false;
      return {
        ...field,
        required: Boolean(
          portalField(
            metadata ?? {},
            'fieldisrequired',
            portalField(metadata ?? {}, 'requiredfield', field.required),
          ) || truthy(portalField(componentMetadata, 'forceallfieldsrequired')),
        ),
        readOnly: immutable || portalField(metadata ?? {}, 'readonly', field.readOnly),
        prepopulateType: Number(portalField(metadata ?? {}, 'prepopulatetype')),
        pattern: portalField(metadata ?? {}, 'validationregularexpression') || field.pattern || null,
        patternMessage: text(portalField(metadata ?? {}, 'validationregularexpressionerrormessage'), ''),
        validationMessage: text(portalField(metadata ?? {}, 'validationerrormessage'), field.validationMessage ?? ''),
        rangeMessage: text(portalField(metadata ?? {}, 'rangevalidationerrormessage'), field.rangeMessage ?? ''),
        label: text(portalField(metadata ?? {}, 'label'), field.label ?? field.name),
      };
    });
  const fields = new Set(effectiveFields.map((field) => canonical(field.name)));
  const values = {};
  const changed = {};
  for (const [key, value] of Object.entries(body.values)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Invalid native form field');
    const binding = key.endsWith('@odata.bind');
    const relation = binding ? mapping.relationships?.[key.slice(0, -11)] : null;
    const column = relation?.many === false ? canonical(relation.from) : canonical(key);
    if (!fields.has(column) || (binding && !relation))
      fail(`Field '${key}' is not bound to this native form`, 403, 'FormFieldNotBound');
    values[key] = value;
    changed[column] = binding
      ? value === null
        ? null
        : typeof value === 'string'
          ? decodeURIComponent(value.match(/\(([^()]*)\)$/)?.[1] ?? value)
          : value
      : value;
  }
  // The providers retain table, relationship, plugin and validation checks. Reads
  // prevent an update form from being used to manufacture a missing record.
  const current = create ? {} : await readProvider.get(schema.entity, recordId, identity);
  if (!current)
    fail(`Entity '${schema.entity}' With Id = ${canonical(recordId)} Does Not Exist`, 404, 'FormRecordNotFound');
  const scalar = (value) => value?.id ?? value?.value ?? value;
  const empty = (value) =>
    value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
  // A secured column the form read masked or null (column security of the reader, data.mjs get) and posted back unchanged
  // is no change: writing it would replace the stored value with its mask or with null.
  if (!create) {
    const rows = store.tableRows?.(mapping.logicalName) ?? [],
      stored = rows[store.rowIndex?.(mapping, rows, recordId) ?? -1];
    for (const column of Object.keys(changed)) {
      const read = current[column],
        posted = changed[column];
      if (!stored || !isSecuredField(store.fieldDefinition?.(mapping.logicalName, column)) || read === stored[column])
        continue;
      if (!((empty(read) && empty(posted)) || String(scalar(read)) === String(scalar(posted)))) continue;
      delete changed[column];
      for (const name of Object.keys(values)) if (canonical(name) === column) delete values[name];
    }
  }
  const assigned = new Set();
  let currentContactAssociation = null;
  let contactRecord;
  if (create && portalField(componentMetadata, 'associatecurrentportaluser', false) === true) {
    if (portalField(componentMetadata, 'portaluserlookupattributeisactivityparty', false) === true)
      fail(
        'Current-user activity-party association requires an activity-party component',
        501,
        'FormUserAssociationUnsupported',
      );
    const name = canonical(
      portalField(
        componentMetadata,
        'targetentityportaluserlookupattribute',
        portalField(componentMetadata, 'portaluserlookupattribute'),
      ),
    );
    const attribute =
      effectiveFields.find((field) => canonical(field.name) === name) ?? schema.currentUserAssociationField;
    if (!name || !attribute || canonical(attribute.name) !== name || attribute.type !== 'lookup')
      fail('Current-user association requires an imported contact lookup column', 501, 'FormUserAssociationUnresolved');
    currentContactAssociation = {
      entity: canonical(mapping.logicalName),
      column: name,
      contactId: canonical(identity.contactId ?? identity.id),
    };
    formMetadata.push({
      adx_attributelogicalname: name,
      adx_setvalueonsave: true,
      adx_onsavetype: 100000002,
      adx_onsavefromattribute: 'contactid',
    });
  }
  // These values come from exported metadata and authenticated server context,
  // never from additional client columns. Lookup bindings also work upstream.
  for (const metadata of formMetadata.filter((row) => portalField(row, 'setvalueonsave', false) === true)) {
    const name = canonical(portalField(metadata, 'attributelogicalname'));
    const field =
      effectiveFields.find((candidate) => canonical(candidate.name) === name) ??
      schema.onSaveFields?.find((candidate) => canonical(candidate.name) === name) ??
      (canonical(schema.currentUserAssociationField?.name) === name ? schema.currentUserAssociationField : null);
    if (!field)
      fail(`On-save attribute '${name}' is absent in the selected form schema`, 501, 'FormSaveAttributeUnresolved');
    if (name === canonical(mapping.idColumn) || /^(uniqueidentifier|primarykey)$/i.test(field.dataverseType ?? ''))
      fail(`On-save unique identifier '${name}' is unsupported`, 501, 'FormSaveAttributeUnsupported');
    const type = Number(portalField(metadata, 'onsavetype'));
    let value, logical;
    if (type === 100000000) value = portalField(metadata, 'onsavevalue');
    else if (type === 100000001) value = now().toISOString();
    else if (type === 100000002) {
      const contactId = identity.contactId ?? identity.id;
      if (!contactId) fail('On-save current contact requires a signed-in identity', 401, 'FormSaveContactRequired');
      const attribute = canonical(portalField(metadata, 'onsavefromattribute'));
      if (!/^[a-z][a-z0-9_]*$/.test(attribute) || ['constructor', 'prototype', '__proto__'].includes(attribute))
        fail('On-save contact attribute is invalid', 501, 'FormSaveAttributeUnsupported');
      if (attribute === 'contactid') {
        value = contactId;
        logical = 'contact';
      } else {
        contactRecord ??= await readProvider.get('contact', contactId, identity);
        if (!contactRecord) fail('On-save current contact record is unavailable', 404, 'FormSaveContactNotFound');
        value = contactRecord[attribute];
        logical = value?.logical_name;
        if (value === undefined)
          fail(`On-save contact attribute '${attribute}' is absent`, 501, 'FormSaveAttributeUnresolved');
      }
    } else fail(`On-save type '${type}' is unsupported`, 501, 'FormSaveTypeUnsupported');
    if (value === undefined) fail(`On-save value for '${name}' is absent`, 501, 'FormSaveValueRequired');
    for (const key of Object.keys(values)) {
      const relation = key.endsWith('@odata.bind') ? mapping.relationships?.[key.slice(0, -11)] : null;
      if (canonical(relation?.from ?? key) === name) delete values[key];
    }
    if (field.type === 'lookup') {
      const targets = Object.entries(mapping.relationships ?? {}).filter(
        ([, relation]) =>
          relation.many === false && canonical(relation.from) === name && (!logical || relation.entity === logical),
      );
      if (targets.length !== 1)
        fail(`On-save lookup '${name}' has an unresolved navigation target`, 501, 'FormSaveLookupUnresolved');
      const [navigation, relation] = targets[0],
        target = store.resolveMapping(relation.entity),
        id = scalar(value);
      values[navigation + '@odata.bind'] = empty(id)
        ? null
        : `/${target.entitySet}(${encodeURIComponent(canonical(id))})`;
    } else {
      value = scalar(value);
      if (['boolean', 'checkbox'].includes(field.type)) {
        if (value === true || value === false) {
          /* The value is already a Boolean and needs no coercion. */
        } else if (/^(true|false|0|1)$/i.test(String(value))) value = /^(true|1)$/i.test(String(value));
        else fail(`On-save boolean '${name}' is invalid`, 501, 'FormSaveValueInvalid');
      } else if (field.type === 'number') {
        if (value === '' || !Number.isFinite(Number(value)))
          fail(`On-save number '${name}' is invalid`, 501, 'FormSaveValueInvalid');
        value = Number(value);
        if (
          (field.options || /^(int|picklist|state|status)$/i.test(field.dataverseType ?? '')) &&
          !Number.isInteger(value)
        )
          fail(`On-save integer '${name}' is invalid`, 501, 'FormSaveValueInvalid');
      } else if (['date', 'datetime-local'].includes(field.type)) {
        if (!Number.isFinite(new Date(value).getTime()))
          fail(`On-save date '${name}' is invalid`, 501, 'FormSaveValueInvalid');
        value = new Date(value).toISOString();
      } else if (![undefined, 'text', 'textarea', 'email', 'url'].includes(field.type))
        fail(`On-save field type '${field.type}' is unsupported`, 501, 'FormSaveAttributeUnsupported');
      values[field.name] = value;
    }
    changed[name] = scalar(value);
    assigned.add(name);
  }
  const validationErrors = [];
  const invalid = (field, code, message) => validationErrors.push({ field: field.name, code, message });
  for (const field of effectiveFields) {
    const key = canonical(field.name),
      hasChange = Object.hasOwn(changed, key),
      value = hasChange ? changed[key] : (current[field.name] ?? field.default);
    if (field.readOnly && hasChange && !assigned.has(key)) {
      const expected = scalar(current[field.name] ?? field.default);
      if (!(empty(expected) && empty(scalar(value))) && String(scalar(value)) !== String(expected))
        fail(`Field '${field.name}' is read-only in this native form`, 403, 'FormFieldReadOnly');
      for (const name of Object.keys(values)) {
        const relation = name.endsWith('@odata.bind') ? mapping.relationships?.[name.slice(0, -11)] : null;
        if (canonical(relation?.from ?? name) === key) delete values[name];
      }
    }
    const requiredEmpty =
      field.richText && !/<img\b/i.test(String(value ?? ''))
        ? empty(richTextRequiredText(value))
        : empty(scalar(value));
    if (field.required && !field.hidden && !field.readOnly && requiredEmpty)
      invalid(field, 'FormFieldRequired', `${field.label} is a required field.`);
    // Native format CustomValidators are server-side, unlike the Web API's
    // JSON type checks. Validate before invoking either local or live providers.
    // Preserve a malformed numeric textbox as text so it cannot become JSON null.
    if (hasChange && !empty(value) && !field.hidden && !field.readOnly) {
      const control = nativeControlKind(field);
      // Native lists validate posted values against the exported options, before
      // invoking Dataverse. The Web API may accept unlisted integer values.
      if (
        control === 'picklist' &&
        field.options?.length &&
        !field.options.some((option) => Number(option.value) === Number(value))
      )
        fail('Invalid postback or callback argument. Event validation is enabled.', 500, 'FormEventValidationInvalid');
      if (control === 'email' && (typeof value !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(value)))
        invalid(field, 'FormFieldInvalid', field.validationMessage || `${field.label} must be a valid email address.`);
      if (['integer', 'decimal', 'double', 'money'].includes(control)) {
        const number = typeof value === 'number' ? value : NaN;
        const exact = nativePostback && isExactNumeric(value) ? decimalParts(value) : null;
        const valid = exact
          ? control !== 'double' && (control !== 'integer' || exact.scale === 0)
          : Number.isFinite(number) && (control !== 'integer' || Number.isInteger(number));
        if (!valid) {
          const kind = control === 'integer' ? 'integer' : control === 'double' ? 'floating-point' : 'decimal';
          invalid(
            field,
            'FormFieldInvalid',
            field.validationMessage || `${field.label} must be a valid ${kind} value.`,
          );
        }
        const minimum = field.minimum ?? field.minValue,
          maximum = field.maximum ?? field.maxValue;
        if (
          (minimum != null || maximum != null) &&
          (!valid ||
            (minimum != null && (exact ? compareNumeric(value, minimum) < 0 : number < Number(minimum))) ||
            (maximum != null && (exact ? compareNumeric(value, maximum) > 0 : number > Number(maximum))))
        )
          invalid(field, 'FormFieldOutOfRange', field.rangeMessage || nativeRangeMessage(field));
      }
      if (control === 'boolean' && typeof value !== 'boolean')
        invalid(field, 'FormFieldInvalid', field.validationMessage || `${field.label} must be a valid Boolean value.`);
      if (control === 'datetime') {
        // Native DateFormatValidator consumes the round-trip hidden control,
        // not the Web API's ISO date/date-time literals. Server-assigned on-save
        // dates have already been typed and do not come from that control.
        const behavior = field.dateTimeBehavior ?? field.behavior ?? (nativeDateOnly(field) ? 'DateOnly' : 'UserLocal');
        const clockDateOnly = behavior === 'DateOnly' && field.prepopulateType === 100000001;
        const native = clockDateOnly
          ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z?$/
          : behavior === 'UserLocal'
            ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/
            : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}$/;
        if (typeof value !== 'string' || !parseDateValue(value) || (!assigned.has(key) && !native.test(value)))
          invalid(
            field,
            'FormFieldInvalid',
            field.validationMessage || `${field.label} must have a valid date format.`,
          );
      }
    }
    // Server-side counterparts of the native regular-expression and length validators.
    if (hasChange && !empty(value) && typeof value === 'string') {
      if (field.pattern) {
        let expression;
        try {
          expression = new RegExp(field.pattern);
        } catch {
          fail(
            `Field '${field.name}' has an invalid exported validation expression`,
            501,
            'FormValidationExpressionInvalid',
          );
        }
        const match = expression.exec(value);
        if (!match || match[0] !== value)
          invalid(field, 'FormFieldInvalid', field.patternMessage || `${field.label} is not valid.`);
      }
      if (field.maxLength && !field.richText && value.length > Number(field.maxLength))
        invalid(
          field,
          'FormFieldTooLong',
          `${field.label} exceeds the maximum length of ${field.maxLength} characters.`,
        );
    }
  }
  if (validationErrors.length)
    throw new DataError(validationErrors[0].message, 400, validationErrors[0].code, { validationErrors });
  // Native reference parameters (refentity/refid/refrel) relate a created child
  // to its subgrid parent; Set Entity Reference metadata does the same from a query parameter.
  const relateAfterCreate = [];
  if (create) {
    const references = [];
    if (query.refentity && query.refid && query.refrel)
      references.push({
        entity: canonical(query.refentity),
        id: canonical(query.refid),
        relationship: query.refrel,
        role: query.refrelrole,
      });
    if (truthy(portalField(componentMetadata, 'setentityreference'))) {
      const sourceType = Number(portalField(componentMetadata, 'referenceentitysourcetype') ?? 756150000);
      const parameter = portalField(componentMetadata, 'referencequerystringname');
      const entity = canonical(portalField(componentMetadata, 'referenceentitylogicalname'));
      if (sourceType === 756150000 && parameter && entity && query[parameter]) {
        let referenceId = query[parameter];
        if (portalField(componentMetadata, 'referencequerystringisprimarykey') === false) {
          const attribute = portalField(componentMetadata, 'referencequeryattributelogicalname');
          if (!/^[a-z_][\w]*$/i.test(attribute ?? ''))
            fail('Entity reference query attribute is invalid', 501, 'FormReferenceUnresolved');
          const targetMapping = store.resolveMapping(entity);
          const found = await readProvider.query(
            entity,
            { $filter: `${attribute} eq '${String(referenceId).replace(/'/g, "''")}'`, $top: 1 },
            identity,
          );
          referenceId = found.value?.[0]?.[targetMapping.idColumn];
        }
        if (referenceId)
          references.push({
            entity,
            id: canonical(referenceId),
            relationship: portalField(componentMetadata, 'referenceentityrelationshipname'),
            lookup: portalField(componentMetadata, 'referencetargetlookupattributelogicalname'),
          });
      }
    }
    for (const reference of references) {
      const lookup = Object.entries(mapping.relationships ?? {}).find(
        ([, relation]) =>
          relation.many === false &&
          relation.entity === reference.entity &&
          (reference.lookup
            ? canonical(relation.from) === canonical(reference.lookup)
            : relation.schemaName === reference.relationship),
      );
      if (lookup) {
        values[`${lookup[0]}@odata.bind`] =
          `/${store.resolveMapping(reference.entity).entitySet}(${encodeURIComponent(reference.id)})`;
        continue;
      }
      const parentMapping = store.resolveMapping(reference.entity);
      const parentNavigation = Object.entries(parentMapping.relationships ?? {}).find(
        ([name, relation]) =>
          relation.many &&
          relation.intersect &&
          (name === reference.relationship || relation.schemaName === reference.relationship) &&
          relation.entity === canonical(schema.entity),
      );
      if (!parentNavigation)
        fail(`Reference relationship '${reference.relationship}' is not mapped`, 501, 'FormReferenceUnresolved');
      relateAfterCreate.push({ entity: reference.entity, id: reference.id, navigation: parentNavigation[0] });
    }
  }
  // Attach file: one annotation per uploaded file, as native forms store notes. Every file
  // is checked before anything is written.
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const notes = [],
    cloudUploads = [];
  if (attachments.length) {
    if (!truthy(portalField(componentMetadata, 'attachfile')))
      fail('This native form does not accept attachments', 403, 'FormAttachmentNotEnabled');
    // Advanced form steps name multiple files with their own column (adx_allowmultiplefiles), as the markup reads it.
    const multiple =
      portalField(componentMetadata, 'attachfileallowmultiple') ?? portalField(componentMetadata, 'allowmultiplefiles');
    if (!truthy(multiple) && attachments.length > 1)
      fail('This native form accepts one attachment', 400, 'FormAttachmentInvalid');
    const maxKb = Number(portalField(componentMetadata, 'attachfilemaxsize')) || 0;
    const accept = [
      portalField(componentMetadata, 'attachfileaccept'),
      portalField(componentMetadata, 'attachfileacceptextensions'),
    ]
      .filter(Boolean)
      .join(',');
    const restrict = truthy(portalField(componentMetadata, 'attachfilerestrictaccept'));
    const fullname = identity?.fullname ?? identity?.name ?? '';
    const contactId = canonical(identity?.contactId ?? identity?.id);
    const annotationMapping = store.resolveMapping('annotation');
    // FileStorage/CloudStorageAccount set: the file goes to storage route portalCloudAttachments and the note is the documented
    // placeholder <name>.txt holding { Name, Type, Size, Url }. No route: PROVIDER_ROUTE_MISSING fails the save; the bytes
    // never fall back to the note. Url is the provider key here; native carries the blob's URL.
    let cloud = null;
    if (String(siteSetting(portal, 'FileStorage/CloudStorageAccount') ?? '').trim()) {
      try {
        cloud = cloudAttachments?.() ?? null;
        if (!cloud)
          throw Object.assign(
            new Error(
              'Storage route portalCloudAttachments is not configured; set providers.routes.portalCloudAttachments.',
            ),
            { diagnostic: 'PROVIDER_ROUTE_MISSING' },
          );
      } catch (error) {
        const code = error.diagnostic ?? 'PROVIDER_ROUTE_MISSING';
        diagnostic({
          code,
          severity: 'error',
          form: componentId,
          message: `FileStorage/CloudStorageAccount is set, but the attachment cannot be stored: ${error.message}`,
        });
        fail(`The attachment cannot be stored in cloud storage: ${error.message}`, 500, code);
      }
    }
    const objectBinding = Object.entries(annotationMapping.relationships ?? {}).find(
      ([, relation]) =>
        relation.many === false && relation.from === 'objectid' && relation.entity === canonical(schema.entity),
    );
    for (const file of attachments) {
      if (!file || typeof file.name !== 'string' || typeof file.content !== 'string')
        fail('Attachment requires a name and base64 content', 400, 'FormAttachmentInvalid');
      const size = Buffer.from(file.content, 'base64').length;
      if (maxKb && size > maxKb * 1024)
        fail(
          text(
            portalField(componentMetadata, 'attachfilesizeerrormessage'),
            `${file.name} exceeds the maximum file size.`,
          ),
          400,
          'FormAttachmentTooLarge',
        );
      if (
        restrict &&
        accept &&
        !accept.split(',').some((entry) => {
          const pattern = entry.trim().toLowerCase();
          if (!pattern) return false;
          if (pattern.startsWith('.')) return file.name.toLowerCase().endsWith(pattern);
          if (pattern.endsWith('/*'))
            return String(file.type ?? '')
              .toLowerCase()
              .startsWith(pattern.slice(0, -1));
          return String(file.type ?? '').toLowerCase() === pattern;
        })
      )
        fail(
          text(
            portalField(componentMetadata, 'attachfiletypeerrormessage'),
            `${file.name} is not of the file type(s) "${accept}".`,
          ),
          400,
          'FormAttachmentType',
        );
      const placeholder = cloud
        ? { key: cloudKey(file.name), type: String(file.type || 'application/octet-stream') }
        : null;
      if (placeholder) cloudUploads.push({ ...placeholder, content: file.content });
      const stored = placeholder
        ? Buffer.from(JSON.stringify({ Name: file.name, Type: placeholder.type, Size: size, Url: placeholder.key }))
        : null;
      notes.push((savedId) => ({
        subject: `Note created on ${now().toLocaleString('en-US', { timeZone: 'UTC', hour12: true, month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(',', '')} UTC by ${fullname}${contactId ? ` [contact:${contactId}]` : ''}`,
        notetext: notesFilter(portal),
        objecttypecode: schema.entity,
        ...(stored
          ? {
              filename: `${file.name}.txt`.slice(0, 255),
              mimetype: 'text/plain',
              documentbody: stored.toString('base64'),
              filesize: stored.length,
            }
          : {
              filename: file.name.slice(0, 255),
              mimetype: String(file.type || 'application/octet-stream').slice(0, 255),
              documentbody: file.content,
              filesize: size,
            }),
        ...(objectBinding
          ? { [`${objectBinding[0]}@odata.bind`]: `/${mapping.entitySet}(${savedId})` }
          : { objectid: { id: savedId, logical_name: schema.entity } }),
      }));
    }
  }
  // The record, its reference associations and its notes are written as one unit: a failure
  // in any of them (a table permission, a plugin, the provider) leaves none of them saved.
  // A directly unresolved source edge can be rejected before any write. Branches
  // depend on the saved row, including plugin changes, so resolve those inside
  // the provider's existing write unit before changing the session history.
  if (session) requiredAdvancedFormStep(portal, formSchema, schema.nextStepId);
  // Cloud attachment bytes are put before the write unit; a failed unit deletes them again.
  const cloudStore = cloudUploads.length ? cloudAttachments() : null;
  for (const upload of cloudUploads)
    await cloudStore.put(upload.key, Buffer.from(upload.content, 'base64'), { contentType: upload.type });
  const { record, savedId, next } = await writeUnit(writeProvider, async (operations) => {
    const record = create
      ? await withNativeFormContactAssociation(currentContactAssociation, () =>
          operations.create(schema.entity, values, identity),
        )
      : await operations.update(schema.entity, recordId, values, identity);
    const savedId = canonical(record?.[mapping.idColumn] ?? recordId);
    for (const relation of relateAfterCreate) {
      if (!operations.associate)
        fail('Native form reference association requires an association provider', 501, 'FormReferenceUnsupported');
      await operations.associate(relation.entity, relation.id, relation.navigation, savedId, identity);
    }
    for (const note of notes) await operations.create('annotation', note(savedId), identity);
    const next = session
      ? nextAdvancedFormStep(portal, formSchema, schema.nextStepId, { ...current, ...record })
      : null;
    return { record, savedId, next };
  }).catch(async (error) => {
    for (const upload of cloudUploads) await cloudStore.delete(upload.key).catch(() => {});
    throw error;
  });
  // Outcome: success message, redirect, or the next multistep step.
  const savedRecord = { ...current, ...record };
  let outcome;
  if (session) {
    outcome = advanceSession(session, schema, next, savedId, savedRecord, { portal, pageUrl, startNew, text });
    if (nativePostback && outcome.type === 'message') {
      const target = new URL(requestUrl ?? pageUrl, 'http://localhost/');
      target.searchParams.set('msg', 'success');
      target.searchParams.set('stepid', schema.stepId);
      if (startNew) target.searchParams.set('sessionid', session.id);
      else target.searchParams.delete('sessionid');
      outcome = { type: 'redirect', url: target.pathname + target.search };
    }
  } else {
    const settings = (() => {
      try {
        return JSON.parse(portalField(componentMetadata, 'settings') || '{}');
      } catch {
        return {};
      }
    })();
    const submitAction = (settings.Actions ?? []).find((candidate) => candidate.Type === 'SubmitAction');
    const onSuccess = Number(portalField(componentMetadata, 'onsuccess') ?? 756150000);
    if (onSuccess === 756150001) {
      const url = redirectTarget(componentMetadata, {
        portal,
        recordId: savedId,
        record: savedRecord,
        requestUrl: pageUrl,
      });
      // A redirect without a resolvable target re-renders the page (native traces the error).
      outcome = url ? { type: 'redirect', url } : { type: 'none' };
    } else
      outcome = {
        type: 'message',
        message:
          text(portalField(componentMetadata, 'successmessage'), '') ||
          text(submitAction?.SuccessMessage, '') ||
          'Submission completed successfully.',
        hideForm: portalField(componentMetadata, 'hideformonsuccess') !== false,
      };
  }
  const primaryName = mapping.nameColumn;
  return {
    record,
    recordId: savedId,
    entity: schema.entity,
    operation: create ? 'create' : 'update',
    componentId: definition.id,
    stepId: schema.stepId ?? null,
    sessionId: session?.id ?? null,
    name: primaryName ? (record?.[primaryName] ?? null) : null,
    outcome,
  };
}

/**
 * A create (insert) form renders for an identity holding a Create table permission of any
 * scope on its table; without one the platform shows its create access-denied message in
 * place of the form.
 */
export function formCreateAllowed(store, entity, identity = {}) {
  if (typeof store?.rules !== 'function' || identity.admin || store.state?.settings?.permissionMode === 'permissive')
    return true;
  return store.rules(store.resolveMapping(entity).logicalName, 'create', identity).length > 0;
}
