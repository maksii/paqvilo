import { randomUUID } from 'node:crypto';
import {
  withNativeFormContactAssociation,
  currentContactParty,
  currentContactPartyRow,
  currentContactPartyDeepInsert,
} from './native-form-association.mjs';
import { approximateFormSchema, approximateAdvancedFormSchema } from './form-schema-fallback.mjs';
import { DataError } from './data.mjs';
import { activityTables } from './portal-timeline.mjs';
import { isSecuredField } from './dataverse-fls.mjs';
import { portalField } from './importer.mjs';
import { siteSetting } from './redirects.mjs';
import {
  schemaFromFormXml,
  nativeControlKind,
  formChoiceField,
  acceptsFormChoice,
  rejectedFormChoices,
  nativeRangeMessage,
  nativeRangeBounds,
  nativeNumberFormatMessage,
  nativeDateOnly,
  resolveFormRecord,
} from './platform.mjs';
import { parseDateValue } from './dataverse-values.mjs';
import {
  nativeFormActions,
  nativeFormActionApplies,
  nativeFormWorkflowId,
  NATIVE_STATE_ACTIONS,
  nativeActionStateValues,
  nativeCloseActivity,
  assertActionSource,
  stateValues as recordStateValues,
  invariantNow,
} from './native-form-actions.mjs';
import { isExactNumeric, decimalParts, compareNumeric, parseNumericLiteral } from './exact-numeric.mjs';
import { xmlEscapeAttribute } from './fetchxml-engine.mjs';
import {
  isPcfHiddenValue,
  nativeFieldAdmission,
  nativeFieldPostedValue,
  PcfFieldValueError,
} from './pcf-field-host.mjs';

// A column the Power Pages form host hands to a field component: code component style on the form metadata, an
// exported desktop binding and an admitted column type (lib/pcf-field-host.mjs).
const pcfFieldOf = (field, metadata) =>
  Boolean(
    field.codeComponent &&
    Number(portalField(metadata ?? {}, 'controlstyle')) === 756150001 &&
    nativeFieldAdmission(nativeControlKind(field), field.dataverseType).admitted,
  );
// The posted hidden input of a mounted field component (both transports mark it, lib/pcf-field-host.mjs) as the value
// the native control of its column would post. Only a mounted component field may post the marker, and a hidden
// component field posts nothing (the host renders no input for it); any other posted value is returned as is.
function pcfFieldValue(posted, fields, key) {
  const field = fields.find((candidate) => canonical(candidate.name) === canonical(key));
  if (field?.pcfField && field.hidden)
    fail(`Field '${key}' is not bound to this native form`, 403, 'FormFieldNotBound');
  if (!isPcfHiddenValue(posted)) return posted;
  if (!field?.pcfField)
    fail(`Field '${key}' is not a code component field of this native form`, 400, 'FormFieldInvalid');
  const behavior = field.dateTimeBehavior ?? field.behavior ?? (nativeDateOnly(field) ? 'DateOnly' : 'UserLocal');
  try {
    return nativeFieldPostedValue(posted.pcfHiddenValue, { control: nativeControlKind(field), behavior });
  } catch (error) {
    if (!(error instanceof PcfFieldValueError)) throw error;
    // The platform's save fails with HTTP 500 and saves nothing (captured, one load).
    return fail(`Field '${key}' posted a code component value the column cannot take`, 500, 'FormFieldValueMalformed');
  }
}

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
// same suffix for every candidate. work (optional, { scanned }) counts the characters the searches pass over.
function richTextRequiredText(value, work = null) {
  const source = String(value ?? ''),
    parts = [];
  const find = (needle, from) => {
    const at = source.indexOf(needle, from);
    if (work) work.scanned += (at < 0 ? source.length : at + needle.length) - from;
    return at;
  };
  let cursor = 0,
    canCloseComment = true;
  while (cursor < source.length) {
    const opening = find('<', cursor);
    if (opening < 0) break;
    parts.push(source.slice(cursor, opening));
    if (canCloseComment && source.startsWith('<!--', opening)) {
      const closing = find('-->', opening + 4);
      if (closing >= 0) {
        cursor = closing + 3;
        continue;
      }
      canCloseComment = false;
    }
    const closing = find('>', opening + 1);
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
export function formText(value, fallback = '', language = {}, onSelection = null) {
  if (value == null || value === '') {
    onSelection?.({ fallback: true });
    return fallback;
  }
  let rows = value;
  if (typeof value === 'string') {
    if (!/^\s*\[\s*\{/.test(value)) {
      onSelection?.({ fallback: false });
      return value;
    }
    try {
      rows = JSON.parse(value);
    } catch {
      onSelection?.({ fallback: false });
      return value;
    }
  }
  if (!Array.isArray(rows)) {
    onSelection?.({ fallback: false });
    return String(value);
  }
  const byLcid = (lcid) => (lcid ? rows.find((row) => Number(row?.LCID) === Number(lcid)) : undefined);
  const selected = byLcid(language?.lcid) ?? byLcid(language?.defaultLcid) ?? rows[0];
  onSelection?.({ lcid: Number(selected?.LCID), ordinal: rows.indexOf(selected), fallback: !selected?.Value });
  return selected?.Value || fallback;
}

/** Enforce the selected form's CAPTCHA on either transport. Without a trusted local fixture, refuse the save. */
export function validateFormCaptcha(action, component, identity, verify = null) {
  if (action !== 'submit' || !truthy(portalField(component ?? {}, 'captcharequired', false))) return;
  const signedIn = Boolean(identity?.contactId ?? identity?.id);
  if (signedIn && !truthy(portalField(component, 'showcaptchaforauthenticatedusers', false))) return;
  if (verify?.() === true) return;
  const code = 'CaptchaInvalid';
  const message = 'Captcha is incorrect, please re-enter captcha.';
  throw new DataError(message, 400, code, { validationErrors: [{ field: 'captcha', code, message }] });
}

// Basic/multistep form metadata control styles (mspp_entityformmetadata.mspp_controlstyle choices, Learn table reference).
const GEOLOCATION_STYLE = 100000002,
  CONSTANT_SUM_STYLE = 100000003,
  RANK_NO_TIES_STYLE = 100000004,
  MULTIPLE_CHOICE_STYLE = 100000007;

/** The survey control facts of one attribute metadata row: style, group, group bounds and group messages. */
function surveyFieldFacts(row, text) {
  if (!row) return {};
  const style = Number(portalField(row, 'controlstyle'));
  const bound = (name) => {
    const value = portalField(row, name);
    return value === undefined || value === null || value === '' || !Number.isFinite(Number(value))
      ? null
      : Number(value);
  };
  return {
    controlStyle: Number.isFinite(style) ? style : null,
    groupName: String(portalField(row, 'groupname') ?? ''),
    constantSum: { minimum: bound('constantsumminimumtotal'), maximum: bound('constantsummaximumtotal') },
    multipleChoice: {
      minimum: bound('minmultiplechoiceselectedcount'),
      maximum: bound('maxmultiplechoiceselectedcount'),
    },
    constantSumMessage: text(portalField(row, 'constantsumvalidationerrormessage'), ''),
    multipleChoiceMessage: text(portalField(row, 'multiplechoicevalidationerrormessage'), ''),
    rankOrderMessage: text(portalField(row, 'rankordernotiesvalidationerrormessage'), ''),
  };
}

const firstSet = (members, pick) => members.map(pick).find((value) => value !== null && value !== '') ?? null;
const surveyNumber = (value) => {
  const scalar = value?.value ?? value;
  return scalar === undefined || scalar === null || scalar === '' ? null : Number(scalar);
};
const surveyChosen = (value) =>
  value === true || value === 1 || /^(true|1)$/i.test(String(value?.value ?? value ?? ''));
function surveyRange(minimum, maximum) {
  if (minimum !== null && maximum !== null)
    return minimum === maximum ? String(minimum) : `between ${minimum} and ${maximum}`;
  return minimum === null ? `at most ${maximum}` : `at least ${minimum}`;
}

/** A constant sum group totals within its Constant Sum Minimum/Maximum Total. */
function constantSumError(members, valueOf) {
  const minimum = firstSet(members, (field) => field.constantSum.minimum),
    maximum = firstSet(members, (field) => field.constantSum.maximum);
  if (minimum === null && maximum === null) return null;
  const total = members.reduce((sum, field) => sum + (surveyNumber(valueOf(field)) || 0), 0);
  if ((minimum === null || total >= minimum) && (maximum === null || total <= maximum)) return null;
  return {
    field: members.at(-1).name,
    code: 'FormConstantSumInvalid',
    message:
      firstSet(members, (field) => field.constantSumMessage) ||
      `The total of ${members[0].groupName} must be ${surveyRange(minimum, maximum)}.`,
  };
}

/** A multiple choice group chooses between its Minimum Required and Max Selected Count of options. */
function multipleChoiceError(members, valueOf) {
  const minimum = firstSet(members, (field) => field.multipleChoice.minimum),
    maximum = firstSet(members, (field) => field.multipleChoice.maximum);
  if (minimum === null && maximum === null) return null;
  const chosen = members.filter((field) => surveyChosen(valueOf(field))).length;
  if ((minimum === null || chosen >= minimum) && (maximum === null || chosen <= maximum)) return null;
  return {
    field: members.at(-1).name,
    code: 'FormMultipleChoiceInvalid',
    message:
      firstSet(members, (field) => field.multipleChoiceMessage) ||
      `Select ${surveyRange(minimum, maximum)} options for ${members[0].groupName}.`,
  };
}

/** A rank order scale without ties repeats no rank. */
function rankTieErrors(members, valueOf) {
  const errors = [],
    seen = new Map();
  for (const field of members) {
    const rank = surveyNumber(valueOf(field));
    if (rank === null) continue;
    const earlier = seen.get(rank);
    if (!earlier) {
      seen.set(rank, field);
      continue;
    }
    errors.push({
      field: field.name,
      code: 'FormRankOrderTie',
      message:
        field.rankOrderMessage ||
        firstSet(members, (member) => member.rankOrderMessage) ||
        `${earlier.label} and ${field.label} have the same rank.`,
    });
  }
  return errors;
}

/**
 * Server-side counterparts of the survey group validators (Learn: configure basic form metadata, Control style and
 * Validation). A group is the editable fields sharing a control style and Group Name; its bounds and message are the
 * first member's that sets them, and a group error names the last member, which carries the rendered group validator.
 */
function surveyGroupErrors(fields, valueOf) {
  const groups = new Map();
  for (const field of fields) {
    if (![CONSTANT_SUM_STYLE, RANK_NO_TIES_STYLE, MULTIPLE_CHOICE_STYLE].includes(field.controlStyle)) continue;
    if (!field.groupName || field.hidden || field.readOnly) continue;
    const key = `${field.controlStyle}:${field.groupName}`;
    groups.set(key, [...(groups.get(key) ?? []), field]);
  }
  return [...groups.values()].flatMap((members) => {
    if (members[0].controlStyle === CONSTANT_SUM_STYLE) return [constantSumError(members, valueOf) ?? []].flat();
    if (members[0].controlStyle === MULTIPLE_CHOICE_STYLE) return [multipleChoiceError(members, valueOf) ?? []].flat();
    return rankTieErrors(members, valueOf);
  });
}

/** The form setting limits new annotations together with the record's existing files. */
export function formAttachmentLimit(component) {
  const multiple = portalField(component, 'attachfileallowmultiple') ?? portalField(component, 'allowmultiplefiles');
  return truthy(multiple) ? Math.max(0, Number(portalField(component, 'maximumnooffiles')) || 5) : 1;
}

// The form counts the record's files as the system, not as the visitor: a visitor whose note permission allows create
// but not read (or reads only their own notes) would otherwise count none, get the whole file count again on every save
// and fail Attach File Required on a record that has one. Only the count leaves this function; the caller has read the
// record, and the rendered control states the same number as its remaining file count.
const SYSTEM_READ = Object.freeze({ admin: true });
// The activityparty row of Associate Current Portal User (Is Activity Party) is written by the system with its record.
const SYSTEM_PARTY_WRITE = Object.freeze({ admin: true });

/** The record's existing file notes, counted by the system read; the visitor's identity does not narrow it. */
export async function formAttachmentCount(readProvider, _identity, entity, recordId) {
  if (!recordId || typeof readProvider?.fetchXml !== 'function') return 0;
  const xml = `<fetch><entity name="annotation"><attribute name="filename"/><attribute name="isdocument"/><attribute name="objectid"/><attribute name="objecttypecode"/><filter type="and"><condition attribute="objectid" operator="eq" value="${xmlEscapeAttribute(canonical(recordId))}"/></filter></entity></fetch>`;
  const result = await readProvider.fetchXml(xml, SYSTEM_READ);
  return (result.entities ?? result.value ?? []).filter((note) => {
    const regarding = canonical(note.objectid?.logical_name ?? note.objecttypecode?.value ?? note.objecttypecode);
    return (!regarding || regarding === canonical(entity)) && (note.filename || truthy(note.isdocument));
  }).length;
}

function validateFormAttachmentCount({ count, existing, limit, required, component, text }) {
  const invalid = (code, message) => {
    throw new DataError(message, 400, code, { validationErrors: [{ field: 'AttachFile', code, message }] });
  };
  if (required && count + existing === 0) {
    const label = text(portalField(component, 'attachfilelabel'), 'Attach a File');
    invalid(
      'FormAttachmentRequired',
      text(portalField(component, 'attachfilerequirederrormessage'), `${label} is a required field.`),
    );
  }
  const remaining = Math.max(0, limit - existing);
  if (count > remaining)
    invalid(
      'FormAttachmentTooMany',
      `You can upload a maximum of ${remaining} more file${remaining === 1 ? '' : 's'}.`,
    );
}

// ---- Advanced (multistep) form sessions
// Native Power Pages persists the step history in adx_webformsession, per signed-in user or
// anonymous visitor; unless Start New Session On Load, the user can leave and resume where they
// left off. Mirage stores progress in the same state as its records when a DataStore is supplied.
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
export function createWebFormSessions({ limit = 1000, store = null } = {}) {
  const sessions = new Map();
  const savedSessions = () => (Array.isArray(store?.state.portalFormSessions) ? store.state.portalFormSessions : []);
  const get = (id) =>
    store
      ? structuredClone(savedSessions().find((session) => session.id === canonical(id)) ?? null)
      : (sessions.get(canonical(id)) ?? null);
  const list = (webformId, owner) => {
    if (!owner) return [];
    const values = store ? savedSessions() : [...sessions.values()];
    const matches = values
      .filter((session) => session.webformId === canonical(webformId) && session.owner === owner)
      .reverse();
    return store ? structuredClone(matches) : matches;
  };
  const checkCurrent = (session, singleRecord = false) => {
    if (!store || !session.owner) return;
    const saved = get(session.id);
    if (
      (saved?.revision ?? 0) !== session.revision ||
      (!saved &&
        list(session.webformId, session.owner).some(
          (candidate) =>
            (candidate.active && (!session.startNew || singleRecord)) || (candidate.completed && singleRecord),
        ))
    )
      fail('This multistep form session changed. Reload the page before continuing.', 409, 'FormSessionChanged');
  };
  return {
    get,
    /** The sessions of `owner` for one form, newest first. */
    list,
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
        revision: 0,
      };
      if (!store) {
        sessions.set(session.id, session);
        if (sessions.size > limit) sessions.delete(sessions.keys().next().value);
      }
      return session;
    },
    checkCurrent,
    async stage(previous, progress, singleRecord) {
      if (!store || !previous.owner) return;
      const save = () => {
        checkCurrent(previous, singleRecord);
        // Only committed progress refreshes a session's place in the bounded history.
        const others = savedSessions().filter((session) => session.id !== progress.id);
        const revision = previous.revision + 1;
        store.state.portalFormSessions = [...others, { ...progress, revision }].slice(-limit);
      };
      if (store.inTransaction()) save();
      else await store.transact(save, { incremental: true });
    },
    publish(previous, progress) {
      if (!store) Object.assign(sessions.get(previous.id) ?? previous, progress);
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
    if (session?.webformId === canonical(webformId) && session.owner === owner && session.active) return session;
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
const signedInForForm = (identity) => Boolean(canonical(identity?.contactId ?? identity?.id));
const singleRecordForm = (form, identity) =>
  signedInForForm(identity) && falsy(portalField(form ?? {}, 'multiplerecordsperuserpermitted'));

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
  const signedIn = signedInForForm(identity);
  if (truthy(portalField(form, 'authenticationrequired')) && !signedIn)
    return { signIn: true, code: 'FormAuthenticationRequired' };
  if (!singleRecordForm(form, identity)) return null;
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
  return { session: { ...previous, active: true, completed: false, current: canonical(initialStepId) } };
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
  const pattern = /\s*([()&|]|!(?!=)|==?\*?|!=\*?|~=|>=|<=|[=><]|'[^']*'|"[^"]*"|[^\s()&|!=<>~]+)/y; // NOSONAR: regex kept: a rewrite would change matches or captures
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
    if (numericRight && ['=', '==', '!=', '>', '<', '>=', '<='].includes(operator))
      // Keep saved Int64/Decimal digits and numeric literal digits out of
      // Number(). Numeric-string/boolean coercion still applies;
      // an empty/null value still does not equal the numeric literal zero.
      return compareNumericCondition(left, operator, right);
    const scalarLeft = isExactNumeric(left) ? left.value : left;
    const scalarRight = isExactNumeric(right) ? right.value : right;
    let a = scalarLeft;
    if (typeof scalarRight === 'number' && scalarLeft != null && scalarLeft !== '') a = Number(scalarLeft);
    else if (typeof scalarRight === 'boolean') a = truthy(scalarLeft);
    return compareScalarCondition(a, operator, scalarRight);
  };
  const primary = () => {
    const token = tokens[index++];
    if (token === '(') {
      const result = or();
      if (tokens[index++] !== ')') fail('Unbalanced multistep condition', 501, 'ADVANCEDFORM_CONDITION_UNSUPPORTED');
      return result;
    }
    if (token === '!') return !primary();
    if (!/^[a-z_]\w*$/i.test(token ?? ''))
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

function appendQueryParameters(target, parameters) {
  for (const [key, value] of parameters) appendRedirectQuery(target, new URLSearchParams([[key, value]]).toString());
}

function appendRecordAttribute(target, parameter, record, attribute) {
  const raw = record[attribute];
  const value = raw && typeof raw === 'object' ? (raw.id ?? raw.value) : raw;
  if (value == null) return;
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

function compareNumericCondition(left, operator, right) {
  let numericLeft = left;
  if (!isExactNumeric(left))
    numericLeft =
      typeof left === 'string' && /^\s*[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\s*$/.test(left) ? left.trim() : Number(left);
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

// Linear glob match: the first and last segments anchor the value, and each middle
// segment is found from the end of the previous one, so no wildcard backtracks.
function conditionLike(text, patternText) {
  const value = String(text ?? '').toLowerCase();
  const segments = String(patternText).toLowerCase().split(/[*%]/);
  if (segments.length === 1) return value === segments[0];
  const first = segments[0];
  const last = segments.at(-1) ?? '';
  if (value.length < first.length + last.length || !value.startsWith(first) || !value.endsWith(last)) return false;
  const end = value.length - last.length;
  let cursor = first.length;
  for (const segment of segments.slice(1, -1)) {
    const found = value.indexOf(segment, cursor);
    if (found < 0 || found + segment.length > end) return false;
    cursor = found + segment.length;
  }
  return true;
}

function compareScalarCondition(a, operator, right) {
  switch (operator) {
    case '=':
    case '==':
      if (right === null) return a == null || a === '';
      if (typeof right === 'string' && /\*/.test(right)) return conditionLike(a, right);
      return String(a ?? '').toLowerCase() === String(right ?? '').toLowerCase();
    case '!=':
      return right === null
        ? !(a == null || a === '')
        : String(a ?? '').toLowerCase() !== String(right ?? '').toLowerCase();
    case '=*':
    case '==*':
    case '~=':
      return conditionLike(a, right);
    case '!=*':
      return !conditionLike(a, right);
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
      /^https?:/i.test(configured) || String(configured).startsWith('/') ? configured : `https://${configured}`,
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
  if (truthy(portalField(settings, 'appendquerystring'))) appendQueryParameters(target, origin.searchParams);
  const custom = portalField(settings, 'redirecturlcustomquerystring');
  if (custom) appendQueryParameters(target, new URLSearchParams(String(custom).replace(/^\?/, '')));
  const parameter = portalField(settings, 'redirecturlquerystringattributeparamname');
  const attribute = portalField(settings, 'redirecturlquerystringattribute');
  if (parameter && attribute && record) appendRecordAttribute(target, parameter, record, attribute);
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

/** Previous starts a new forward path from the reopened step, omitting its former successors. */
function checkForwardFormStep(session, current, next) {
  if (!next || next.type === 'condition' || next.type === 'redirect') return;
  const currentId = canonical(current.stepId);
  const nextId = canonical(next.stepId);
  const currentIndex = session.history.findIndex((entry) => canonical(entry.stepId) === currentId);
  const visited = currentIndex < 0 ? session.history : session.history.slice(0, currentIndex);
  if (nextId === currentId || visited.some((entry) => canonical(entry.stepId) === nextId))
    fail(`Multistep form step '${next.stepId}' was already used in this path.`, 400, 'FormStepReused');
}

function previousConditionStep(component, previous, history) {
  const sourceStep = canonical(portalField(component, 'entitysourcestep'));
  const previousStep = canonical(previous.stepId);
  if (!sourceStep || sourceStep === previousStep) return previous;
  const index = history.findIndex((entry) => canonical(entry.stepId) === previousStep);
  const pathToPrevious = index < 0 ? history : history.slice(0, index);
  return pathToPrevious.find((entry) => canonical(entry.stepId) === sourceStep);
}

async function conditionRecord(step, previous, { definition, query, readProvider, store, identity, session }) {
  const component = step.metadata ?? {};
  const sourceType = Number(portalField(component, 'entitysourcetype') ?? 100000003);
  let entity = canonical(step.entity ?? portalField(component, 'targetentitylogicalname'));
  let id;
  if (sourceType === 100000003) {
    const source = previousConditionStep(component, previous, session.history);
    const sourceEntity = canonical(source?.entity);
    entity ||= sourceEntity;
    if (source === previous && entity === sourceEntity) return previous.record;
    id = entity === sourceEntity ? source?.recordId : undefined;
  } else if ([100000001, 100000002, 100000004].includes(sourceType)) {
    entity ||= canonical(previous.entity);
    ({ id } = await resolveFormRecord({
      kind: 'webform',
      definition,
      schema: { ...step, entity, mode: 100000002 },
      context: { request: { params: query } },
      readProvider,
      store,
      identity,
    }));
  } else {
    fail('The multistep condition record source is unsupported.', 501, 'FormConditionSourceUnsupported');
  }
  if (id && entity) {
    if (canonical(id) === canonical(previous.recordId) && entity === canonical(previous.entity)) return previous.record;
    const record = await readProvider.get(entity, id, identity);
    if (record) return record;
  }
  return fail(
    'The record source for the multistep condition could not be resolved.',
    404,
    'FormConditionSourceMissing',
  );
}

async function nextAdvancedFormStep(portal, schema, id, previous, context) {
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
    const passed = evaluateStepCondition(next.condition, await conditionRecord(next, previous, context));
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

async function stageFormProgress(sessions, session, schema, next, savedId, savedRecord, response) {
  const progress = { ...session, history: [...session.history] };
  const outcome = advanceSession(progress, schema, next, savedId, savedRecord, response);
  await sessions.stage?.(session, progress, response.singleRecord);
  return { progress, outcome };
}

async function withFormCloudUploads(storage, uploads, write, diagnostic) {
  const attempted = [];
  try {
    for (const upload of uploads) {
      // A provider can write the object and then fail to acknowledge it.
      attempted.push(upload.key);
      await storage.put(upload.key, Buffer.from(upload.content, 'base64'), { contentType: upload.type });
    }
    return await write();
  } catch (error) {
    for (const key of attempted)
      try {
        await storage.delete(key);
      } catch {
        diagnostic({
          code: 'FORM_ATTACHMENT_CLEANUP_FAILED',
          severity: 'warning',
          message: 'A cloud attachment from an unsuccessful form save could not be removed.',
        });
      }
    throw error;
  }
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

const APPROPRIATE_PERMISSIONS = "You don't have the appropriate permissions.";
/**
 * A Dynamics 365 message action (Calculate Value, Create Order, Create Invoice, Generate Quote): the legacy service
 * checks Update on the record and Create on the new record's table, then runs the messages in order, each as its own
 * Dataverse operation of the site's application user.
 */
export async function runFormMessageAction({
  action,
  spec,
  configured,
  schema,
  mapping,
  recordId,
  current,
  store,
  identity,
  readProvider,
  available,
  website,
  ensureActionSource,
  runFormMessage,
  writeProvider,
  hostChange,
  now,
}) {
  if (typeof runFormMessage !== 'function')
    fail('This action needs the local Dataverse organization.', 501, 'FormActionMessageUnavailable');
  if (store.allowed && !store.allowed(schema.entity, 'update', current, identity))
    fail(APPROPRIATE_PERMISSIONS, 403, 'FormActionNotEnabled');
  if (spec.creates && store.allowed && !store.allowed(spec.creates, 'create', {}, identity))
    fail(APPROPRIATE_PERMISSIONS, 403, 'FormActionNotEnabled');
  ensureActionSource?.();
  const applies = await nativeFormActionApplies(configured, {
    entity: schema.entity,
    idColumn: mapping.idColumn,
    recordId,
    readProvider,
    identity,
    available,
    context: { website },
  });
  if (!applies) fail('This action is unavailable for the selected record.', 403, 'FormActionNotEnabled');
  assertActionSource(action, store.get?.(schema.entity, recordId, { admin: true }) ?? current);
  const steps = spec.messages({
    recordId: canonical(recordId),
    state: Number(current.statecode?.value ?? current.statecode ?? 0),
    subject: `${spec.subject ?? ''}${invariantNow(now)}`,
  });
  // The source is checked once before the first message: the legacy service runs the messages as separate operations.
  ensureActionSource?.();
  for (const step of steps) {
    if (step.update) {
      await hostChange(() =>
        writeUnit(writeProvider, (operations) =>
          operations.update(schema.entity, recordId, step.update, { ...identity, admin: true }),
        ),
      );
      continue;
    }
    const answer = await runFormMessage({ method: step.method, url: step.url, payload: step.payload, identity });
    if (answer.status >= 400)
      fail(answer.body?.error?.message ?? `${action} failed.`, answer.status, 'FormActionMessageFailed');
  }
}

// ActivityPointerState: Open 0 and Scheduled 3 are open; Canceled is 2.
const OPEN_ACTIVITY_STATES = new Set([0, 3]);
/** The open and scheduled activities regarding the record, each with its Canceled state and default status. */
export function openRegardingActivities(store, entity, recordId, metadata) {
  const id = canonical(recordId);
  const activities = [];
  for (const mapping of activityTables(store)) {
    const table = mapping.logicalName;
    for (const row of store.tableRows?.(table) ?? []) {
      const regarding = row.regardingobjectid ?? row._regardingobjectid_value;
      if (canonical(regarding?.id ?? regarding) !== id) continue;
      if (!OPEN_ACTIVITY_STATES.has(Number(row.statecode?.value ?? row.statecode ?? 0))) continue;
      const values = recordStateValues(table, 2, null, { metadata, store });
      if (!values)
        fail(`Canceling the case requires the ${table} Canceled state metadata`, 501, 'FormActionStateUnresolved');
      activities.push({ table, id: canonical(row[mapping.idColumn ?? 'activityid']), values });
    }
  }
  return activities;
}

function stateActionMessage(action, spec) {
  if (spec.message) return spec.message;
  return action === 'deactivate' ? 'The record has been deactivated.' : 'The record has been activated.';
}

/** A close activity's columns with its lookup to the closed record, bound through the activity table's relationship. */
export function closeActivityValues(store, activity, entity, mapping, recordId) {
  let relationships;
  try {
    relationships = store.resolveMapping(activity.table).relationships ?? {};
  } catch {
    relationships = {};
  }
  const binding = Object.entries(relationships).find(
    ([, relation]) =>
      relation.many === false && relation.from === activity.lookup && relation.entity === canonical(entity),
  );
  return {
    ...activity.values,
    ...(binding && mapping.entitySet
      ? { [`${binding[0]}@odata.bind`]: `/${mapping.entitySet}(${canonical(recordId)})` }
      : { [activity.lookup]: { id: canonical(recordId), logical_name: canonical(entity) } }),
  };
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
// A cloud placeholder note body as Mirage writes it, here and in the Azure file Web API (portal-file-api.mjs): exactly
// { Name, Type, Size, Url } in that order, Url a provider key <container>/<guid>/<file name in key characters>.
const PLACEHOLDER_KEYS = 'Name,Type,Size,Url';
const PLACEHOLDER_URL = /^[a-z0-9][a-z0-9_.-]*\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[a-z0-9][a-z0-9_.-]*$/;
/** True when a note body's text is a cloud attachment placeholder (it names a storage key, not file content). */
export function isCloudAttachmentPlaceholder(text) {
  if (typeof text !== 'string' || text.length > 4096) return false;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).join(',') === PLACEHOLDER_KEYS &&
    typeof value.Name === 'string' &&
    typeof value.Type === 'string' &&
    Number.isSafeInteger(value.Size) &&
    value.Size >= 0 &&
    typeof value.Url === 'string' &&
    PLACEHOLDER_URL.test(value.Url)
  );
}
/** The note-text prefix that marks portal-visible notes: site setting KnowledgeManagement/NotesFilter, `*WEB*` by default. */
export const notesFilter = (portal) => siteSetting(portal ?? {}, 'KnowledgeManagement/NotesFilter') ?? '*WEB*';

// Basic form modes (adx_mode) as the form span names them.
const FORM_MODES = { 100000000: 'insert', 100000001: 'edit', 100000002: 'readonly' };

function lookupBindingId(value) {
  const captured = value.match(/\(([^()]*)\)$/)?.[1] ?? value;
  try {
    return decodeURIComponent(captured);
  } catch {
    return fail('Lookup binding is not a valid entity reference', 400, 'InvalidLookup');
  }
}

// A save updates the record that the form's record source names; a posted recordId may only repeat that record.
// A record reached through the current contact or an associated record is never replaced by a posted recordId.
async function savedRecordId({ bodyRecordId, query, ...source }) {
  const record = await resolveFormRecord({ ...source, context: { request: { params: query } } });
  const id = record.id ? canonical(record.id) : null;
  const posted = bodyRecordId ? canonical(bodyRecordId) : null;
  const contactNamed = Boolean(record.sourceType || record.createOnNull);
  if (posted && (id || contactNamed) && posted !== id)
    fail('The submitted record differs from the form record source', 403, 'FormRecordMismatch');
  return id ?? posted;
}

function assertFormWorkflowDataScope(store, entity, identity) {
  const providers = store.recordPipeline?.virtualProviders;
  if (!providers) return;
  const assertLocal = (logical) => {
    if (providers.status(logical).virtual)
      fail('A Basic Form workflow requires a local target and local permission sources.', 501, 'WorkflowUnsupported');
  };
  assertLocal(entity);
  store.addPortalPermissionSources(
    identity,
    [
      [entity, 'read'],
      [entity, 'update'],
    ],
    assertLocal,
  );
}

async function submitBasicFormWorkflow({
  body,
  definition,
  schema,
  metadata,
  store,
  readProvider,
  identity,
  workflowIdentity,
  runFormWorkflow,
  ensureActionSource,
  query,
  portal,
  pageUrl,
  text,
}) {
  const entity = canonical(schema.entity);
  if (!runFormWorkflow || schema.approximated || entity !== canonical(definition.entityName))
    fail('This Basic Form workflow does not have a qualified local form and runner.', 501, 'WorkflowUnsupported');
  if (
    Object.keys(body.values).length ||
    (body.attachments != null && (!Array.isArray(body.attachments) || body.attachments.length))
  )
    fail('Record actions do not accept field changes or attachments', 400, 'FormActionInvalid');
  const configured = Number.isSafeInteger(body.actionIndex)
    ? nativeFormActions(definition.metadata)[body.actionIndex]
    : null;
  const workflowId = nativeFormWorkflowId(configured);
  if (!workflowId || typeof body.workflowId !== 'string' || canonical(body.workflowId) !== workflowId)
    fail('This workflow action is not configured for the Basic Form', 403, 'FormActionNotEnabled');

  const mapping = store.resolveMapping(entity);
  const recordId = canonical(body.recordId);
  let current;
  await runFormWorkflow({
    verify: ensureActionSource,
    authorize: async () => {
      ensureActionSource?.();
      const visitor = workflowIdentity?.() ?? identity;
      assertFormWorkflowDataScope(store, entity, visitor);
      const source = await resolveFormRecord({
        kind: 'entityform',
        definition,
        schema,
        metadata,
        context: { request: { params: query } },
        readProvider,
        store,
        identity: visitor,
      });
      if (![100000001, 100000002].includes(source.mode) || !recordId)
        fail('Record actions require an existing record', 400, 'FormRecordRequired');
      if (!source.id || canonical(source.id) !== recordId)
        fail('The submitted record differs from the form record source', 403, 'FormRecordMismatch');
      current = await readProvider.get(entity, recordId, visitor);
      const stored = current && store.get(entity, recordId, { admin: true });
      if (!stored || !store.allowed(entity, 'update', stored, visitor))
        fail('This action requires read and write access to the selected record.', 403, 'AccessDenied');
      if (
        !(await nativeFormActionApplies(configured, {
          entity,
          idColumn: mapping.idColumn,
          recordId,
          readProvider,
          identity: visitor,
          context: { website: portal.website },
        }))
      )
        fail('This action is unavailable for the selected record.', 403, 'FormActionNotEnabled');
      return { workflowId, entity, recordId, identity: visitor };
    },
  });
  const redirect = [1, 2].includes(Number(configured.OnComplete))
    ? redirectTarget(
        { adx_redirectwebpage: configured.RedirectWebpageId, adx_redirecturl: configured.RedirectUrl },
        { portal, recordId, record: current, requestUrl: pageUrl },
      )
    : null;
  return {
    recordId,
    entity,
    operation: 'workflow',
    componentId: definition.id,
    name: mapping.nameColumn ? (current[mapping.nameColumn] ?? null) : null,
    outcome: redirect
      ? { type: 'redirect', url: redirect }
      : {
          type: 'message',
          message: text(configured.SuccessMessage, 'The workflow ran successfully.'),
          hideForm: false,
        },
  };
}

/**
 * A portal form submission (a basic or advanced form save, a step, a record state action) is one `form` span above the
 * Dataverse operations it runs (D-R3-10): the form, its kind, mode, the action (button) and table; at level full the
 * submitted values as input and the outcome as output. The submission itself is submitForm below.
 */
export function submitPortalForm(kind, componentId, body, options = {}) {
  const traces = options.store?.traces;
  if (!traces?.enabled) return submitForm(kind, componentId, body, options);
  const definition = (kind === 'webform' ? options.portal?.advancedForms : options.portal?.forms)?.find(
    (row) => canonical(row.id) === canonical(componentId),
  );
  const label = definition?.name ?? String(componentId);
  return traces.wrap(
    {
      kind: 'form',
      name: `${kind === 'webform' ? 'Advanced form' : 'Basic form'} ${label}`,
      module: 'portal',
      operation: 'submit',
      entity: definition?.entityName ?? null,
      recordId: typeof body?.recordId === 'string' && body.recordId ? canonical(body.recordId) : null,
      attributes: {
        form: label,
        formId: definition?.id ?? String(componentId),
        formKind: kind,
        mode: FORM_MODES[Number(definition?.mode)] ?? null,
        button: typeof body?.action === 'string' ? body.action : 'submit',
        stepId: body?.stepId ?? null,
        native: options.nativePostback === true,
      },
      input: () => body?.values ?? null,
    },
    async (span) => {
      const result = await submitForm(kind, componentId, body, options);
      span.setEntity(result?.entity ?? definition?.entityName ?? null, result?.recordId ?? null);
      span.set({ formOperation: result?.operation ?? null, outcome: result?.outcome?.type ?? null });
      span.output(() => ({
        operation: result?.operation ?? null,
        recordId: result?.recordId ?? null,
        stepId: result?.stepId ?? null,
        outcome: result?.outcome ?? null,
      }));
      return result;
    },
  );
}

/* NOSONAR */

/* NOSONAR */

/** Native form saves have their own schema and table-permission boundary, separate from Web API site settings. */
/* NOSONAR: single-pass routine, splitting it would change shared state */ /* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ async function submitForm(
  kind,
  componentId,
  body,
  {
    portal,
    store,
    schemas = {},
    metadata = null,
    globalChoices,
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
    nativeNumberLocales,
    // Cloud attachments (FileStorage/CloudStorageAccount): () => the guarded provider of storage route portalCloudAttachments
    // (throws ProviderError when the route is unset or not ready); diagnostic receives the refusal.
    cloudAttachments = null,
    verifyCaptcha = null,
    actionFiltersAvailable = true,
    ensureActionSource = null,
    runFormWorkflow = null,
    runFormMessage = null,
    // Runs a write of a record action outside the request's own host change (server.mjs change).
    hostChange = (fn) => fn(),
    workflowIdentity = null,
    diagnostic = () => {},
    // Counts the characters the required rich-text check scans ({ scanned }) when given.
    validationWork = null,
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
  if (!['submit', 'previous', 'workflow', ...Object.keys(NATIVE_STATE_ACTIONS)].includes(action))
    fail('Unsupported native form action', 400, 'InvalidFormAction');
  const stateAction = NATIVE_STATE_ACTIONS[action];
  if (stateAction && kind !== 'entityform') fail('Record state actions require a basic form', 400, 'InvalidFormAction');
  if (action === 'workflow' && kind !== 'entityform')
    fail('Workflow actions require a Basic Form', 400, 'InvalidFormAction');
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
  const singleRecord = kind === 'webform' && singleRecordForm(definition.metadata, identity);
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
      const progress = { ...session, current: previous.stepId };
      await sessions.stage?.(session, progress, singleRecord);
      if (sessions.publish) sessions.publish(session, progress);
      else Object.assign(session, progress);
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
  if (action === 'workflow')
    return submitBasicFormWorkflow({
      body,
      definition,
      schema,
      metadata,
      store,
      readProvider,
      identity,
      workflowIdentity,
      runFormWorkflow,
      ensureActionSource,
      query,
      portal,
      pageUrl,
      text,
    });
  validateFormCaptcha(action, componentMetadata, identity, () =>
    verifyCaptcha?.({ kind, formId: definition.id, stepId: schema.stepId }, body.captchaProofToken),
  );
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
    const next = await nextAdvancedFormStep(
      portal,
      formSchema,
      schema.nextStepId,
      { ...schema, recordId: viewedId, record: viewed },
      { definition, query, readProvider, store, identity, session },
    );
    checkForwardFormStep(session, schema, next);
    const { progress, outcome } = await stageFormProgress(sessions, session, schema, next, viewedId, viewed, {
      portal,
      pageUrl,
      startNew,
      singleRecord,
      text,
    });
    if (sessions.publish) sessions.publish(session, progress);
    else Object.assign(session, progress);
    return {
      record: null,
      recordId: viewedId,
      entity: schema.entity,
      operation: 'navigate',
      componentId: definition.id,
      stepId: schema.stepId,
      outcome,
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
  const recordId = create
    ? (schema.recordId ?? sessionRecordId)
    : await savedRecordId({
        bodyRecordId: body.recordId,
        kind,
        definition,
        schema,
        metadata,
        query,
        readProvider,
        store,
        identity,
        session,
      });
  if (!create && !recordId) fail('This native form requires its record identifier', 400, 'FormRecordRequired');
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
    // A table-specific action (Close Case, Win Opportunity, ...) applies to its own table only.
    if (stateAction.table && canonical(schema.entity) !== stateAction.table)
      fail('This record action is not available for the form table', 403, 'FormActionNotEnabled');
    if (create) fail('Record actions require an existing record', 400, 'FormRecordRequired');
    if (Object.keys(body.values).length || (body.attachments?.length ?? 0))
      fail('Record actions do not accept field changes or attachments', 400, 'FormActionInvalid');
    const closeActivity = nativeCloseActivity(action, {
      configured,
      resolution: body.resolution && typeof body.resolution === 'object' ? body.resolution : null,
      now: now(),
    });
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
    // The record must be in the state the action accepts, before any write.
    assertActionSource(action, current);
    if (stateAction.messages) {
      await runFormMessageAction({
        action,
        spec: stateAction,
        configured,
        schema,
        mapping,
        recordId,
        current,
        store,
        identity,
        readProvider,
        available: actionFiltersAvailable,
        website: portal.website,
        ensureActionSource,
        runFormMessage,
        writeProvider,
        hostChange,
        now: now(),
      });
      return {
        record: null,
        recordId: canonical(recordId),
        entity: schema.entity,
        operation: action,
        componentId: definition.id,
        outcome: { type: 'message', message: text(configured.SuccessMessage, stateAction.message), hideForm: false },
      };
    }
    const stateValues = nativeActionStateValues(schema.entity, action, { metadata, store, schema });
    if (!stateValues)
      fail('Native record actions require unambiguous state and status metadata', 501, 'FormActionStateUnresolved');
    const { record } = await writeUnit(writeProvider, async (operations) => {
      ensureActionSource?.();
      // Again inside the write: a concurrent action may have changed the state since the read.
      assertActionSource(action, store.get?.(schema.entity, recordId, { admin: true }) ?? current);
      if (
        !(await nativeFormActionApplies(configured, {
          entity: schema.entity,
          idColumn: mapping.idColumn,
          recordId,
          readProvider,
          identity,
          available: actionFiltersAvailable,
          context: { website: portal.website },
        }))
      )
        fail('This action is unavailable for the selected record.', 403, 'FormActionNotEnabled');
      ensureActionSource?.();
      // The close activity (incidentresolution, opportunityclose) and the state change commit together, as the
      // CloseIncident, WinOpportunity and LoseOpportunity messages do.
      // The message creates the activity itself: the visitor needs no table permission on the activity table.
      if (closeActivity)
        await operations.create(
          closeActivity.table,
          closeActivityValues(store, closeActivity, schema.entity, mapping, recordId),
          { ...identity, admin: true },
        );
      // Cancel Case first cancels the case's open and scheduled activities (the legacy CaseDataAdapter.Cancel).
      if (stateAction.cancelActivities)
        for (const activity of openRegardingActivities(store, schema.entity, recordId, metadata))
          await operations.update(activity.table, activity.id, activity.values, { ...identity, admin: true });
      const record = await operations.update(schema.entity, recordId, stateValues, identity);
      // Source staging can overlap an asynchronous update. The local transaction can still roll it back here.
      ensureActionSource?.();
      return { record };
    });
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
            message: text(configured.SuccessMessage, stateActionMessage(action, stateAction)),
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
  const choiceColumns = metadata?.entities?.[canonical(schema.entity)]?.fields ?? {};
  const effectiveFields = (schema.fields ?? [])
    .map((field) =>
      formChoiceField(
        field,
        choiceColumns[canonical(field.name)],
        globalChoices,
        language.lcid ?? language.defaultLcid,
      ),
    )
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
        requiredMessage: text(portalField(metadata ?? {}, 'requiredfieldvalidationerrormessage'), ''),
        label: text(portalField(metadata ?? {}, 'label'), field.label ?? field.name),
        pcfField: pcfFieldOf(field, metadata),
        ...surveyFieldFacts(metadata, text),
      };
    });
  const fields = new Set(effectiveFields.map((field) => canonical(field.name)));
  const values = {};
  const changed = {};
  // Columns decoded from a field component's hidden input keep their exact numeric digits, as postback text does.
  const pcfDecoded = new Set();
  for (const [key, posted] of Object.entries(body.values)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Invalid native form field');
    const value = pcfFieldValue(posted, effectiveFields, key);
    if (isPcfHiddenValue(posted)) pcfDecoded.add(canonical(key));
    const binding = key.endsWith('@odata.bind');
    const relation = binding ? mapping.relationships?.[key.slice(0, -11)] : null;
    const column = relation?.many === false ? canonical(relation.from) : canonical(key);
    if (!fields.has(column) || (binding && !relation))
      fail(`Field '${key}' is not bound to this native form`, 403, 'FormFieldNotBound');
    values[key] = value;
    changed[column] = binding
      ? value === null // NOSONAR: preserve lazy branch evaluation and coercion
        ? null
        : typeof value === 'string' // NOSONAR: preserve lazy branch evaluation and coercion
          ? lookupBindingId(value)
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
  let currentContactPartyAssociation = null;
  const associateCurrentUser = create && portalField(componentMetadata, 'associatecurrentportaluser', false) === true;
  const associationColumn = canonical(
    portalField(
      componentMetadata,
      'targetentityportaluserlookupattribute',
      portalField(componentMetadata, 'portaluserlookupattribute'),
    ),
  );
  // Is Activity Party: the contact becomes an activityparty row of the configured party list column, written with the
  // record. A visitor value posted for that column is replaced, as Set Value On Save replaces a posted value.
  if (
    associateCurrentUser &&
    portalField(componentMetadata, 'portaluserlookupattributeisactivityparty', false) === true
  ) {
    currentContactPartyAssociation = currentContactParty({
      entity: mapping.logicalName,
      column: associationColumn,
      definition:
        (canonical(schema.currentUserAssociationField?.name) === associationColumn
          ? schema.currentUserAssociationField
          : null) ??
        choiceColumns[associationColumn] ??
        store.fieldDefinition?.(mapping.logicalName, associationColumn),
      participationTypes: store.fieldDefinition?.('activityparty', 'participationtypemask'),
      identity,
    });
    try {
      currentContactPartyAssociation.partyMapping = store.resolveMapping('activityparty');
      currentContactPartyAssociation.contactMapping = store.resolveMapping('contact');
    } catch {
      fail(
        'Current-user activity party association requires the activityparty table',
        501,
        'FormUserAssociationUnresolved',
      );
    }
    // A provider that writes through the Web API (the live bridge) cannot create activityparty rows on their own: it
    // sends the party inside the record create as a deep insert, one atomic request.
    if (writeProvider.activityPartyDeepInsert === true)
      currentContactPartyAssociation.deepInsert = currentContactPartyDeepInsert(currentContactPartyAssociation, {
        activityMapping: mapping,
        partyMapping: currentContactPartyAssociation.partyMapping,
        contactMapping: currentContactPartyAssociation.contactMapping,
      });
    for (const key of Object.keys(values))
      if (
        canonical(key.endsWith('@odata.bind') ? mapping.relationships?.[key.slice(0, -11)]?.from : key) ===
        associationColumn
      )
        delete values[key];
    // The column holds the current contact once saved (the party row, local or deep insert), so it counts as assigned by
    // the server for the required and read-only checks, as an on-save lookup does; it is not a record column value.
    changed[associationColumn] = currentContactPartyAssociation.contactId;
    assigned.add(associationColumn);
  } else if (associateCurrentUser) {
    const name = associationColumn;
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
        ? empty(richTextRequiredText(value, validationWork))
        : empty(scalar(value));
    if (field.required && !field.hidden && !field.readOnly && requiredEmpty)
      invalid(field, 'FormFieldRequired', field.requiredMessage || `${field.label} is a required field.`);
    // Native format CustomValidators are server-side, unlike the Web API's
    // JSON type checks. Validate before invoking either local or live providers.
    // Preserve a malformed numeric textbox as text so it cannot become JSON null.
    if (hasChange && !empty(value) && !field.hidden && !field.readOnly) {
      const control = nativeControlKind(field);
      // Native lists validate posted values against the exported options, before
      // invoking Dataverse. The Web API may accept unlisted integer values.
      if (control === 'picklist' && !acceptsFormChoice(field, value))
        fail('Invalid postback or callback argument. Event validation is enabled.', 500, 'FormEventValidationInvalid');
      // A choices control posts its selection in a hidden input: Dataverse refuses a value outside the bound choice.
      const rejectedChoice = control === 'multiselect' ? rejectedFormChoices(field, value) : null;
      if (rejectedChoice != null)
        throw new DataError(
          `A validation error occurred. The value ${rejectedChoice} of '${field.name}' on record of type '${schema.entity}' is outside the valid range. Accepted Values: ${field.options.map((option) => option.value).join(',')}`,
          400,
          'PicklistValueOutOfRange',
          { innerCode: '0x8004431a', value: rejectedChoice },
        );
      if (control === 'email' && (typeof value !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(value)))
        invalid(field, 'FormFieldInvalid', field.validationMessage || `${field.label} must be a valid email address.`);
      // A native text control posts a string; the server-assigned on-save values are exempt. Email is checked above.
      if (['text', 'textarea'].includes(control) && !assigned.has(key) && typeof value !== 'string')
        invalid(field, 'FormFieldInvalid', field.validationMessage || `${field.label} must be text.`);
      if (['integer', 'decimal', 'double', 'money'].includes(control)) {
        const number = typeof value === 'number' ? value : Number.NaN;
        const exact = (nativePostback || pcfDecoded.has(key)) && isExactNumeric(value) ? decimalParts(value) : null;
        const valid = exact
          ? control !== 'double' && (control !== 'integer' || exact.scale === 0)
          : Number.isFinite(number) && (control !== 'integer' || Number.isInteger(number));
        // The native validators' copy is in the page language of the rendered field (nativeNumberLocales).
        const copyLocale = nativeNumberLocales?.get(field.name);
        if (!valid)
          invalid(
            field,
            'FormFieldInvalid',
            field.validationMessage || nativeNumberFormatMessage(field, copyLocale, control),
          );
        // A bound the exported metadata omits beside a configured one is the column type's supported limit.
        const [minimum, maximum] = nativeRangeBounds(field);
        if (
          (minimum != null || maximum != null) &&
          (!valid ||
            (minimum != null && (exact ? compareNumeric(value, minimum) < 0 : number < Number(minimum))) ||
            (maximum != null && (exact ? compareNumeric(value, maximum) > 0 : number > Number(maximum))))
        )
          invalid(field, 'FormFieldOutOfRange', field.rangeMessage || nativeRangeMessage(field, copyLocale));
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
          : behavior === 'UserLocal' // NOSONAR: preserve lazy branch evaluation and coercion
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
        if (/* NOSONAR */ !match || match[0] !== value)
          // NOSONAR: retain the existing falsy-value guard and short circuit
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
  validationErrors.push(
    ...surveyGroupErrors(effectiveFields, (field) => {
      const key = canonical(field.name);
      return Object.hasOwn(changed, key) ? changed[key] : (current[field.name] ?? field.default);
    }),
  );
  if (effectiveFields.some((field) => field.controlStyle === GEOLOCATION_STYLE))
    diagnostic({
      code: 'FORM_GEOLOCATION_VALIDATOR_HOSTED',
      severity: 'warning',
      component: kind,
      form: definition.name ?? definition.id,
      message:
        'Single Line of Text as Geolocation Lookup Validator checks the text with the Bing Maps service of the hosted site; the local form saves it unvalidated.',
    });
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
          if (!/^[a-z_]\w*$/i.test(attribute ?? ''))
            fail('Entity reference query attribute is invalid', 501, 'FormReferenceUnresolved');
          const targetMapping = store.resolveMapping(entity);
          const found = await readProvider.query(
            entity,
            { $filter: `${attribute} eq '${String(referenceId).replaceAll("'", "''")}'`, $top: 1 },
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
  const attachmentsEnabled = truthy(portalField(componentMetadata, 'attachfile'));
  const attachmentLimit = formAttachmentLimit(componentMetadata);
  const attachmentRequired = truthy(portalField(componentMetadata, 'attachfilerequired'));
  const attachmentValidation = {
    count: attachments.length,
    limit: attachmentLimit,
    required: attachmentRequired,
    component: componentMetadata,
    text,
  };
  const notes = [],
    cloudUploads = [];
  let cloudStore = null;
  if (attachments.length) {
    if (!attachmentsEnabled) fail('This native form does not accept attachments', 403, 'FormAttachmentNotEnabled');
    // Advanced form steps name multiple files with their own column (adx_allowmultiplefiles), as the markup reads it.
    const multiple =
      portalField(componentMetadata, 'attachfileallowmultiple') ?? portalField(componentMetadata, 'allowmultiplefiles');
    if (!truthy(multiple) && attachments.length > 1)
      fail('This native form accepts one attachment', 400, 'FormAttachmentInvalid');
  }
  if (attachmentsEnabled && (create || attachments.length > attachmentLimit))
    validateFormAttachmentCount({ ...attachmentValidation, existing: 0 });
  if (attachments.length) {
    const maxKb = Number(portalField(componentMetadata, 'attachfilemaxsize')) || 0;
    const accept = [
      portalField(componentMetadata, 'attachfileaccept') ?? portalField(componentMetadata, 'accept'),
      portalField(componentMetadata, 'attachfileacceptextensions'),
    ]
      .filter(Boolean)
      .join(',');
    const restrict = truthy(portalField(componentMetadata, 'attachfilerestrictaccept'));
    const fullname = identity?.fullname ?? identity?.name ?? '';
    const contactId = canonical(identity?.contactId ?? identity?.id);
    const annotationMapping = store.resolveMapping('annotation');
    // The form location selects Dataverse or the configured storage route. Older exports with no location
    // keep the site-level behavior. The cloud note carries { Name, Type, Size, Url } as before.
    const location = String(portalField(componentMetadata, 'attachfilestoragelocation') ?? '').trim();
    if (location && !['756150000', '756150001'].includes(location))
      fail('The form attachment storage location is unsupported.', 501, 'FormAttachmentLocationUnsupported');
    const usesCloud = location
      ? location === '756150001'
      : Boolean(String(siteSetting(portal, 'FileStorage/CloudStorageAccount') ?? '').trim());
    if (usesCloud) {
      try {
        cloudStore = cloudAttachments?.() ?? null;
        if (!cloudStore)
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
          message: `Cloud storage is selected, but the attachment cannot be stored: ${error.message}`,
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
      const placeholder = cloudStore
        ? { key: cloudKey(file.name), type: String(file.type || 'application/octet-stream') }
        : null;
      if (placeholder) cloudUploads.push({ ...placeholder, content: file.content });
      const stored = placeholder
        ? Buffer.from(JSON.stringify({ Name: file.name, Type: placeholder.type, Size: size, Url: placeholder.key }))
        : null;
      notes.push((savedId) => ({
        subject: `Note created on ${now().toLocaleString('en-US', { timeZone: 'UTC', hour12: true, month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(',', '')} UTC by ${fullname}${contactId ? ` [contact:${contactId}]` : ''}`, // NOSONAR: preserve template coercion and selected evaluation
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
  if (session) checkForwardFormStep(session, schema, requiredAdvancedFormStep(portal, formSchema, schema.nextStepId));
  // Store cloud bytes first and remove attempted blobs if either storage or the record write fails.
  const save = async (operations) => {
    if (session) sessions.checkCurrent?.(session, singleRecord);
    if (attachmentsEnabled && !create && (attachmentRequired || attachments.length)) {
      const existing = await formAttachmentCount(readProvider, identity, schema.entity, recordId);
      validateFormAttachmentCount({ ...attachmentValidation, existing });
    }
    const record = create
      ? await withNativeFormContactAssociation(currentContactAssociation, () =>
          operations.create(
            schema.entity,
            currentContactPartyAssociation?.deepInsert
              ? { ...values, ...currentContactPartyAssociation.deepInsert }
              : values,
            identity,
          ),
        )
      : await operations.update(schema.entity, recordId, values, identity);
    const savedId = canonical(record?.[mapping.idColumn] ?? recordId);
    // The party row is the platform's part of the record create, not a visitor write: the record create carried the
    // visitor's permission check, and the current-contact stamp skips Append/Append To as the lookup association does.
    if (currentContactPartyAssociation && !currentContactPartyAssociation.deepInsert)
      await operations.create(
        'activityparty',
        currentContactPartyRow(currentContactPartyAssociation, savedId, {
          activityMapping: mapping,
          partyMapping: currentContactPartyAssociation.partyMapping,
          contactMapping: currentContactPartyAssociation.contactMapping,
        }),
        SYSTEM_PARTY_WRITE,
      );
    for (const relation of relateAfterCreate) {
      if (!operations.associate)
        fail('Native form reference association requires an association provider', 501, 'FormReferenceUnsupported');
      await operations.associate(relation.entity, relation.id, relation.navigation, savedId, identity);
    }
    for (const note of notes) await operations.create('annotation', note(savedId), identity);
    const savedRecord = { ...current, ...record };
    let advanced = null;
    if (session) {
      const next = await nextAdvancedFormStep(
        portal,
        formSchema,
        schema.nextStepId,
        { ...schema, recordId: savedId, record: savedRecord },
        { definition, query, readProvider, store, identity, session },
      );
      checkForwardFormStep(session, schema, next);
      advanced = await stageFormProgress(sessions, session, schema, next, savedId, savedRecord, {
        portal,
        pageUrl,
        startNew,
        singleRecord,
        text,
      });
    }
    return { record, savedRecord, savedId, advanced };
  };
  const { record, savedRecord, savedId, advanced } = await withFormCloudUploads(
    cloudStore,
    cloudUploads,
    () => writeUnit(writeProvider, save),
    diagnostic,
  );
  // Outcome: success message, redirect, or the next multistep step.
  let outcome;
  if (advanced) {
    if (sessions.publish) sessions.publish(session, advanced.progress);
    else Object.assign(session, advanced.progress);
    outcome = advanced.outcome;
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
