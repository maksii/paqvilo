import {
  NativePostbackError,
  parseNativePostback,
  decodeNativeViewState,
  numberCultureMarks,
} from './native-postback.mjs';
import { nativeFormSubmissionContext, submitPortalForm, validateFormCaptcha } from './form-service.mjs';
import { approximateFormSchema, approximateAdvancedFormSchema } from './form-schema-fallback.mjs';
import { formRichTextField, nativeControlKind, schemaFromFormXml } from './platform.mjs';
import { parseNumericLiteral } from './exact-numeric.mjs';
import { formWriteError } from './form-error-presentation.mjs';
import { pcfHiddenValue } from './pcf-field-host.mjs';
import { DataError } from './data.mjs';
import { siteSetting } from './redirects.mjs';

function nativeSubmissionContext(item) {
  const context = nativeFormSubmissionContext(item?.context ?? {});
  if (item?.descriptor?.kind !== context.kind || item.descriptor.formId !== context.formId)
    throw new NativePostbackError('Rendered native form context differs from its descriptor');
  return context;
}

function selectNativeSubmissionContext(contexts, decoded, entries) {
  const selected = contexts.filter((context) => context.kind === decoded.kind && context.formId === decoded.formId);
  if (selected.length !== 1) throw new NativePostbackError('Rendered native form context is ambiguous');
  // An auto-generated step form: the earlier tabs' values and the current tab come from __VIEWSTATE.
  const viewState = decodeNativeViewState([...entries].find(([name]) => name === '__VIEWSTATE')?.[1]);
  const carried = viewState?.form === decoded.formId ? viewState : null;
  let context;
  if (decoded.body.action === 'tab') context = { ...selected[0], autoStep: decoded.body.actionIndex };
  else if (carried) context = { ...selected[0], autoStep: carried.autoStep };
  else context = selected[0];
  return { context, carried };
}

function nativeSubmissionPage(requestUrl) {
  let page;
  try {
    page = new URL(requestUrl);
  } catch {
    throw new NativePostbackError('Native submission page URL required');
  }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password)
    throw new NativePostbackError('Native submission page URL required');
  return page;
}

function nativeSubmissionQuery(context, page) {
  const query = Object.fromEntries(page.searchParams);
  // Only the page's resolved record and session can reach the submission service.
  // A record query parameter the page URL carries is pinned to the resolved record; one it does not
  // carry stays absent, so step URLs keep the page's own query (e.g. ?stepid=… after Previous).
  if (context.recordQueryName && context.recordId && page.searchParams.has(context.recordQueryName))
    query[context.recordQueryName] = context.recordId;
  if (context.stepId) query.stepid = context.stepId;
  else delete query.stepid;
  if (context.sessionId) query.sessionid = context.sessionId;
  else delete query.sessionid;
  return query;
}

const literalPatterns = new Map();
const SPACE_GROUP_MARKS = /^[\u0020\u00a0\u202f]$/u;
const SPACE_GROUP_CLASS = String.raw`[\u0020\u00a0\u202f]`;
const escapeMark = (mark) => mark.replaceAll(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`);

// The page culture's number literal, with the culture's marks from the locale data (lib/native-postback.mjs): group
// marks are ignored in the integer part (also noncanonical group sizes) and the decimal mark starts the fraction.
function cultureLiteralPattern(locale) {
  if (literalPatterns.has(locale)) return literalPatterns.get(locale);
  const marks = numberCultureMarks(locale);
  let culture = null;
  if (marks) {
    // A space group mark (fr-FR U+202F in the locale data, U+00A0 in other culture data) accepts every space a visitor
    // can type or paste there: U+0020, U+00A0 and U+202F.
    const spaceGroup = marks.group != null && SPACE_GROUP_MARKS.test(marks.group);
    let groupMark = null;
    if (spaceGroup) groupMark = SPACE_GROUP_CLASS;
    else if (marks.group) groupMark = escapeMark(marks.group);
    const group = groupMark ? String.raw`(?:${groupMark}\d+)*` : '';
    const decimal = escapeMark(marks.decimal);
    const pattern = new RegExp(String.raw`^([+-]?\d+${group})(?:${decimal}(\d*))?([eE][+-]?\d+)?$`);
    culture = { pattern, group: groupMark && new RegExp(groupMark, 'g') };
  }
  if (literalPatterns.size < 64) literalPatterns.set(locale, culture);
  return culture;
}

function nativeNumberLiteral(value, locale) {
  if (!locale) return /^[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(value) ? value : null;
  const culture = cultureLiteralPattern(locale);
  const parts = culture?.pattern.exec(value);
  if (!parts) return null;
  const [, integer, fraction, exponent] = parts;
  return (
    (culture.group ? integer.replaceAll(culture.group, '') : integer) +
    (fraction == null ? '' : '.' + fraction) +
    (exponent ?? '')
  );
}

// The choices control posts its selection as a JSON array of the selected options' metadata (hosted F2): an empty array
// clears the column, text that is not such an array fails the save with HTTP 500. A comma list of option values, which
// the local runtime has always accepted, stays accepted. The values are stored as the column's comma list.
function postedChoices(value) {
  const text = value.trim();
  let items;
  if (/^\d+(?:\s*,\s*\d+)*$/.test(text)) items = text.split(',').map(Number);
  else
    try {
      items = JSON.parse(text);
    } catch {
      items = null;
    }
  const values = Array.isArray(items)
    ? items.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? item.Value : item))
    : null;
  if (!values || values.some((item) => !Number.isSafeInteger(item)))
    throw new DataError('The posted choices value is not a list of options', 500, 'FormChoicesValueInvalid');
  return values.length ? [...new Set(values)].join(',') : null;
}

/* NOSONAR */ function normalizePostedValue(value, control, numberLocale) {
  if (typeof value !== 'string') return value;
  if (value === '') return null;
  if (['integer', 'decimal', 'money', 'double', 'picklist'].includes(control)) {
    // Malformed text remains textual for the native format validator. Exact
    // decimal/Int64 tokens never pass through a rounded JavaScript Number.
    const literal = nativeNumberLiteral(value, numberLocale);
    if (literal != null) {
      try {
        return control === 'double' ? Number(literal) : parseNumericLiteral(literal);
      } catch {
        /* The service will reject the original textbox value. */
      }
    }
    return value;
  }
  if (control === 'boolean' && /^(?:0|1|true|false)$/i.test(value)) return /^(?:1|true)$/i.test(value);
  if (control === 'multiselect') return postedChoices(value);
  if (control === 'textarea') return value.replace(/\r\n|\r/g, '\n');
  // The rich text control's hidden value is the editor's HTML as a JSON string (lib/platform.mjs).
  if (control === 'richtext' && value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      /* posted text stays as typed */
    }
  }
  return value;
}

function applyNativeLookup(field, value, posted, descriptor, mapping, submission, store) {
  const relationships = Object.entries(mapping?.relationships ?? {}).filter(
    ([, relation]) => relation.many === false && relation.from === field.name,
  );
  const wire = descriptor.fields.find((item) => item.name === field.name)?.wireName;
  const postedEntities = posted.filter(([name]) => name === wire + '_entityname').map(([, text]) => text);
  if (postedEntities.length > 1) throw new NativePostbackError('Ambiguous native lookup target');
  // An unselected native lookup posts both hidden controls as empty.
  const entities = postedEntities.filter((text) => text !== '');
  const targets = entities.length
    ? relationships.filter(([, relation]) => relation.entity === entities[0])
    : relationships;
  if (value == null) {
    if (!relationships.length || (entities.length && !targets.length))
      throw new NativePostbackError('Native lookup target is unresolved');
    // A polymorphic column has several navigation names but one stored
    // value. Clearing each navigation separately supplies the same column
    // twice; use the source-bound column's explicit null instead.
    if (submission.context.mode === 100000000) delete submission.body.values[field.name];
    else submission.body.values[field.name] = null;
    return;
  }
  if (targets.length !== 1) throw new NativePostbackError('Native lookup target is unresolved');
  const [navigation, relation] = targets[0],
    target = store.resolveMapping(relation.entity);
  delete submission.body.values[field.name];
  submission.body.values[navigation + '@odata.bind'] = `/${target.entitySet}(${encodeURIComponent(value)})`;
}

function resolveSubmissionSchema(submission, options, definition) {
  let schema = options.schemas?.[definition?.id] ?? options.schemas?.[definition?.name];
  if (submission.kind === 'entityform' && !schema)
    schema = approximateFormSchema({ definition, portal: options.portal, metadata: options.metadata });
  if (submission.kind === 'webform')
    schema = approximateAdvancedFormSchema({ definition, portal: options.portal, metadata: options.metadata, schema });
  if (schema?.steps) schema = schema.steps.find((step) => step.stepId === submission.context.stepId);
  return schema;
}

/** Decode against descriptors collected while rendering this server-owned page. */
export function resolveNativeFormSubmission(entries, rendered, requestUrl) {
  if (!Array.isArray(rendered)) throw new NativePostbackError('Rendered native forms required');
  const contexts = rendered.map(nativeSubmissionContext);
  const decoded = parseNativePostback(
    entries,
    rendered.map((item) => item.descriptor),
  );
  const { context, carried } = selectNativeSubmissionContext(contexts, decoded, entries);
  const page = nativeSubmissionPage(requestUrl);
  const query = nativeSubmissionQuery(context, page);
  return {
    kind: decoded.kind,
    formId: decoded.formId,
    context,
    body: {
      ...decoded.body,
      // WebForms posts the whole page, but navigation/state handlers do not save
      // the editable successful controls included in that request.
      ...(decoded.body.action === 'submit' || decoded.body.action === 'tab'
        ? { values: { ...carried?.values, ...decoded.body.values } }
        : { values: {} }),
      recordId: context.recordId,
      ...(context.stepId ? { stepId: context.stepId } : {}),
      query,
      pageUrl: page.pathname,
    },
    ignoredEntryCount: decoded.ignoredEntryCount,
  };
}

function fixtureProof(posted, names) {
  const controls = new URLSearchParams(posted);
  const ids = controls.getAll(`${names}captcha$FixtureChallengeToken`);
  const answers = controls.getAll(`${names}captcha$FixtureAnswerToken`);
  return ids.length === 1 && answers.length === 1 ? { challengeId: ids[0], answer: answers[0] } : null;
}

function applyNativeCaptcha(submission, schema, definition, descriptor, posted, options) {
  if (options.verifyCaptcha && submission.body.action === 'submit') {
    submission.body.captchaProofToken = fixtureProof(posted, descriptor.ids.names);
    return;
  }
  // Without a local fixture, retain the native CAPTCHA outcome before textbox coercion and lookup binding.
  validateFormCaptcha(submission.body.action, schema?.metadata ?? definition.metadata, options.identity);
}

/** Converts the posted values of the schema's fields to the values the form service accepts. */
function normalizeNativeValues(schema, submission, descriptor, posted, mapping, options) {
  const postbackFields = new Map(descriptor.fields.map((field) => [field.name, field]));
  for (const field of schema?.fields ?? []) {
    if (!Object.hasOwn(submission.body.values, field.name)) continue;
    const rawValue = submission.body.values[field.name];
    const binding = postbackFields.get(field.name);
    // The hidden input of a mounted field component is decoded by the form service (lib/pcf-field-host.mjs).
    if (binding?.pcf) {
      submission.body.values[field.name] = pcfHiddenValue(rawValue);
      continue;
    }
    // A rich text binding the form rendered as a plain textarea (no code component metadata) posts textarea text.
    const control = nativeControlKind(binding && !binding.richText ? formRichTextField(field, null) : field);
    // A value carried from an earlier auto-generated step tab has no binding on this tab: its field's page culture
    // comes from the form's number locales.
    const numberLocale = binding ? binding.numberLocale : descriptor.numberLocales?.[field.name]?.parse;
    const value = normalizePostedValue(rawValue, control, numberLocale);
    if (control === 'lookup') applyNativeLookup(field, value, posted, descriptor, mapping, submission, options.store);
    else submission.body.values[field.name] = value;
  }
}

const REQUEST_VALIDATION_MESSAGE =
  'Request validation has detected potentially dangerous input value(s) such as HTML, or script. Please review the input value(s) and try again.';

// The default rule (Site/DisableFormDataSafeHtmlValidation absent or true): only a script block is refused. Hosted F2
// state-0 runs s0g, s0h and s0r refused `<script>` on a basic form and on a multistep step and accepted, stored as posted,
// `<img src=x onerror=…>`, `<svg onload=…>`, `<a href="javascript:…">`, `<iframe …>`, `<b onclick=…>` and `<p><strong>`.
const SCRIPT_BLOCK = /<\s*script\b/i;
// The safe-HTML rule (the setting false): besides script blocks, an event-handler attribute is refused (s0i, s0j refused
// `onerror` and accepted `<p><strong>`). The script and HTML-document URLs, the entity inside a tag and the embedding
// elements are refused by inference from Learn's "prevent any malicious code execution"; no capture tested them.
const UNSAFE_MARKUP = [
  SCRIPT_BLOCK,
  /<\s*(?:iframe|object|embed|frame|frameset)\b/i,
  /^\s*(?:javascript|vbscript)\s*:/i,
  /^\s*data\s*:\s*text\/html/i,
];
// The same rule's tokens that count only inside a tag (`<[^>]*` before them): an event-handler attribute, a script or
// HTML-document URL and an entity. None of them can hold `<` or `>`.
const UNSAFE_IN_TAG = [/[\s/"'`]on[a-z]+\s*=/gi, /(?:javascript|vbscript)\s*:/gi, /data\s*:\s*text\/html/gi, /&#/g];

// Whether the global `pattern` (whose match holds neither `<` nor `>`) matches after a `<` with no `>` between them: the
// test `/<[^>]*(?:pattern)/` makes, in one pass instead of one backtracking scan per `<`.
function matchesInsideTag(text, pattern) {
  let cursor = 0,
    open = false;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    for (; cursor < match.index; cursor++) {
      if (text[cursor] === '<') open = true;
      else if (text[cursor] === '>') open = false;
    }
    if (open) return true;
  }
  return false;
}

/**
 * Request validation of a basic or multistep form post (Microsoft Learn, basic forms, "Request validation"): the default
 * rule refuses script blocks only; with Site/DisableFormDataSafeHtmlValidation false the safe-HTML rule applies.
 * DisableValidationWebTemplate true turns request validation off. A field the rich text editor renders follows the same
 * rule as any other field (inferred: no editor post was determinable). Every posted text is checked, array values
 * included; a post whose form is not in the sources is checked as a whole.
 */
function validateNativeRequest(submission, portal) {
  const setting = (name) =>
    String(siteSetting(portal ?? {}, name) ?? '')
      .trim()
      .toLowerCase();
  if (setting('DisableValidationWebTemplate') === 'true') return;
  const safeHtml = setting('Site/DisableFormDataSafeHtmlValidation') === 'false';
  const unsafe = (text) =>
    safeHtml
      ? UNSAFE_MARKUP.some((pattern) => pattern.test(text)) ||
        UNSAFE_IN_TAG.some((pattern) => matchesInsideTag(text, pattern))
      : SCRIPT_BLOCK.test(text);
  for (const value of Object.values(submission.body.values ?? {})) {
    const texts = (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string');
    if (texts.some(unsafe))
      throw new DataError(REQUEST_VALIDATION_MESSAGE, 400, 'FormRequestValidation', { requestValidation: true });
  }
}

/** Transport-neutral adapter: source/session/permission checks stay in the service. */
export async function submitNativePostback(entries, rendered, options) {
  const posted = [...entries];
  const submission = resolveNativeFormSubmission(posted, rendered, options?.requestUrl);
  // Files posted with the page (the attach-file control) are the submission's attachments.
  if (Array.isArray(options?.attachments) && options.attachments.length)
    submission.body.attachments = options.attachments.map(({ name, type, content, noteId, regarding }) => ({
      name,
      type,
      content,
      // A staged note row of the runtime's own upload staging (server.mjs), never a posted value.
      ...(noteId ? { noteId, regarding } : {}),
    }));
  // Next/Previous of an auto-generated step form re-render the page on another tab without a save.
  if (submission.body.action === 'tab') return { result: { outcome: { type: 'tab' } }, context: submission.context };
  const definition = (submission.kind === 'webform' ? options.portal.advancedForms : options.portal.forms)?.find(
    (row) => row.id === submission.formId,
  );
  const descriptor = rendered.find(
    (item) => item.descriptor.kind === submission.kind && item.descriptor.formId === submission.formId,
  )?.descriptor;
  // Request validation reads the whole post before the form handles it, for every form kind and without a known form.
  validateNativeRequest(submission, options.portal);
  if (!definition)
    return {
      result: await submitPortalForm(submission.kind, submission.formId, submission.body, options),
      context: submission.context,
    };
  let schema = resolveSubmissionSchema(submission, options, definition);
  applyNativeCaptcha(submission, schema, definition, descriptor, posted, options);

  if (schema?.formXml)
    schema = {
      ...schema,
      ...schemaFromFormXml(schema.formXml, { ...schema, entity: schema.entity ?? definition?.entityName }),
    };
  const mapping = schema?.entity ? options.store.resolveMapping(schema.entity) : null;
  normalizeNativeValues(schema, submission, descriptor, posted, mapping, options);
  const result = await submitPortalForm(submission.kind, submission.formId, submission.body, {
    ...options,
    nativePostback: true,
    // The page language of each localized number field's validation copy.
    nativeNumberLocales: new Map(
      Object.entries(descriptor.numberLocales ?? {}).map(([name, locale]) => [name, locale.messages]),
    ),
  });
  return { result, context: submission.context };
}

const nativeValidationCodes = new Set([
  'FormFieldRequired',
  'FormFieldInvalid',
  'FormFieldOutOfRange',
  'FormFieldTooLong',
  'FormAttachmentRequired',
  'FormAttachmentTooMany',
  'CaptchaInvalid',
]);

/** Only native field validators have an observed successful HTML response status. */
export function nativePostbackResponse({ result, error, context, values, observed, portal }) {
  if (error) {
    // Request validation re-renders the form with its own error panel (hosted F2: `message alert error alert alert-danger`).
    if (error.code === 'FormRequestValidation' && error.details?.requestValidation === true)
      return {
        status: 200,
        state: { ...context, values, outcome: { type: 'error', panel: 'request-validation', message: error.message } },
      };
    const presentation = formWriteError(error, observed, context?.kind, portal);
    if (presentation) return { status: 200, state: { ...context, values, outcome: presentation } };
    const errors = error.details?.validationErrors;
    if (
      error.status !== 400 ||
      !Array.isArray(errors) ||
      !errors.length ||
      errors.some((item) => !nativeValidationCodes.has(item.code))
    )
      throw error;
    return { status: 200, state: { ...context, values, validationErrors: errors } };
  }
  const outcome = result?.outcome;
  if (['redirect', 'step'].includes(outcome?.type) && typeof outcome.url === 'string' && outcome.url)
    return { status: 302, location: outcome.url };
  if (outcome?.type === 'tab') return { status: 200, state: { ...context, values, outcome: { type: 'none' } } };
  // A form that stays visible after its save re-renders the posted values.
  return {
    status: 200,
    state: {
      ...context,
      ...(outcome?.type === 'message' && outcome.hideForm === false && values ? { values } : {}),
      outcome: outcome ?? { type: 'none' },
      savedId: result?.recordId ?? null,
      savedName: result?.name ?? null,
    },
  };
}
