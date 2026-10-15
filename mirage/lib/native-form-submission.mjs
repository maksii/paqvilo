import { NativePostbackError, parseNativePostback, decodeNativeViewState } from './native-postback.mjs';
import { nativeFormSubmissionContext, submitPortalForm } from './form-service.mjs';
import { approximateFormSchema, approximateAdvancedFormSchema } from './form-schema-fallback.mjs';
import { nativeControlKind, schemaFromFormXml } from './platform.mjs';
import { parseNumericLiteral } from './exact-numeric.mjs';
import { formWriteError } from './form-error-presentation.mjs';
import { portalField } from './importer.mjs';

const truthy = (value) => value === true || value === 1 || /^(?:true|1)$/i.test(String(value ?? ''));
const CAPTCHA_MESSAGE = 'Captcha is incorrect, please re-enter captcha.';

/** Decode against descriptors collected while rendering this server-owned page. */
export function resolveNativeFormSubmission(entries, rendered, requestUrl) {
  if (!Array.isArray(rendered)) throw new NativePostbackError('Rendered native forms required');
  const contexts = rendered.map(item => {
    const context = nativeFormSubmissionContext(item?.context ?? {});
    if (item?.descriptor?.kind !== context.kind || item.descriptor.formId !== context.formId)
      throw new NativePostbackError('Rendered native form context differs from its descriptor');
    return context;
  });
  const decoded = parseNativePostback(entries, rendered.map(item => item.descriptor));
  const selected = contexts.filter(context => context.kind === decoded.kind && context.formId === decoded.formId);
  if (selected.length !== 1) throw new NativePostbackError('Rendered native form context is ambiguous');
  // An auto-generated step form: the earlier tabs' values and the current tab come from __VIEWSTATE.
  const viewState = decodeNativeViewState([...entries].find(([name]) => name === '__VIEWSTATE')?.[1]);
  const carried = viewState?.form === decoded.formId ? viewState : null;
  const context = decoded.body.action === 'tab' ? { ...selected[0], autoStep: decoded.body.actionIndex } : carried ? { ...selected[0], autoStep: carried.autoStep } : selected[0];
  let page;
  try { page = new URL(requestUrl); }
  catch { throw new NativePostbackError('Native submission page URL required'); }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password)
    throw new NativePostbackError('Native submission page URL required');
  const query = Object.fromEntries(page.searchParams);
  // Only the page's resolved record and session can reach the submission service.
  // A record query parameter the page URL carries is pinned to the resolved record; one it does not
  // carry stays absent, so step URLs keep the page's own query (live: ?stepid=… after Previous).
  if (context.recordQueryName && context.recordId && page.searchParams.has(context.recordQueryName)) query[context.recordQueryName] = context.recordId;
  if (context.stepId) query.stepid = context.stepId;
  else delete query.stepid;
  if (context.sessionId) query.sessionid = context.sessionId;
  else delete query.sessionid;
  return {
    kind: decoded.kind,
    formId: decoded.formId,
    context,
    body: {
      ...decoded.body,
      // WebForms posts the whole page, but navigation/state handlers do not save
      // the editable successful controls included in that request.
      ...(decoded.body.action === 'submit' || decoded.body.action === 'tab' ? { values: { ...carried?.values, ...decoded.body.values } } : { values: {} }),
      recordId: context.recordId,
      ...(context.stepId ? { stepId: context.stepId } : {}),
      query,
      pageUrl: page.pathname,
    },
    ignoredEntryCount: decoded.ignoredEntryCount,
  };
}

/** Transport-neutral adapter: source/session/permission checks stay in the service. */
export async function submitNativePostback(entries, rendered, options) {
  const posted = [...entries];
  const submission = resolveNativeFormSubmission(posted, rendered, options?.requestUrl);
  // Files posted with the page (the attach-file control) are the submission's attachments.
  if (Array.isArray(options?.attachments) && options.attachments.length) submission.body.attachments = options.attachments.map(({ name, type, content }) => ({ name, type, content }));
  // Next/Previous of an auto-generated step form re-render the page on another tab without a save.
  if (submission.body.action === 'tab') return { result: { outcome: { type: 'tab' } }, context: submission.context };
  const definition = (submission.kind === 'webform' ? options.portal.advancedForms : options.portal.forms)?.find(row => row.id === submission.formId);
  if (!definition) return { result: await submitPortalForm(submission.kind, submission.formId, submission.body, options), context: submission.context };
  let schema = options.schemas?.[definition?.id] ?? options.schemas?.[definition?.name];
  if (submission.kind === 'entityform' && !schema) schema = approximateFormSchema({ definition, portal: options.portal, metadata: options.metadata });
  if (submission.kind === 'webform') schema = approximateAdvancedFormSchema({ definition, portal: options.portal, metadata: options.metadata, schema });
  if (schema?.steps) schema = schema.steps.find(step => step.stepId === submission.context.stepId);
  // A basic form or step that requires the captcha (for a signed-in visitor only with "show
  // captcha for authenticated users") rejects its save postback with the captcha message and
  // re-renders with the posted values (live multistep-survey step1-submit and captcha-all insert: 200).
  // ponytail: the local challenge (platform.mjs captchaChallenge) has no answer, so such a save never passes.
  const captchaSettings = schema?.metadata ?? definition?.metadata ?? {};
  if (submission.body.action === 'submit' && truthy(portalField(captchaSettings, 'captcharequired', false))) {
    const signedIn = Boolean(options?.identity?.contactId ?? options?.identity?.id);
    if (!signedIn || truthy(portalField(captchaSettings, 'showcaptchaforauthenticatedusers', false)))
      throw Object.assign(new Error(CAPTCHA_MESSAGE), { status: 400, code: 'CaptchaInvalid', details: { validationErrors: [{ field: 'captcha', code: 'CaptchaInvalid', message: CAPTCHA_MESSAGE }] } });
  }
  if (schema?.formXml) schema = { ...schema, ...schemaFromFormXml(schema.formXml, { ...schema, entity: schema.entity ?? definition?.entityName }) };
  const mapping = schema?.entity ? options.store.resolveMapping(schema.entity) : null;
  const descriptor = rendered.find(item => item.descriptor.kind === submission.kind && item.descriptor.formId === submission.formId).descriptor;
  for (const field of schema?.fields ?? []) {
    if (!Object.hasOwn(submission.body.values, field.name)) continue;
    let value = submission.body.values[field.name];
    const control = nativeControlKind(field);
    if (typeof value === 'string') {
      if (value === '') value = null;
      else if (['integer', 'decimal', 'money', 'double', 'picklist'].includes(control)) {
        // Malformed text remains textual for the native format validator. Exact
        // decimal/Int64 tokens never pass through a rounded JavaScript Number.
        if (/^[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(value)) {
          try { value = control === 'double' ? Number(value) : parseNumericLiteral(value); }
          catch { /* The service will reject the original textbox value. */ }
        }
      } else if (control === 'boolean' && /^(?:0|1|true|false)$/i.test(value)) value = /^(?:1|true)$/i.test(value);
      else if (control === 'textarea') value = value.replace(/\r\n|\r/g, '\n');
      // The rich text control's hidden value is the editor's HTML as a JSON string (lib/platform.mjs).
      else if (control === 'richtext' && value[0] === '"') { try { value = JSON.parse(value); } catch { /* posted text stays as typed */ } }
    }
    if (control === 'lookup') {
      const relationships = Object.entries(mapping?.relationships ?? {}).filter(([, relation]) => relation.many === false && relation.from === field.name);
      const wire = descriptor.fields.find(item => item.name === field.name)?.wireName;
      const postedEntities = posted.filter(([name]) => name === wire + '_entityname').map(([, text]) => text);
      if (postedEntities.length > 1) throw new NativePostbackError('Ambiguous native lookup target');
      // An unselected native lookup posts both hidden controls as empty.
      const entities = postedEntities.filter(text => text !== '');
      const targets = entities.length ? relationships.filter(([, relation]) => relation.entity === entities[0]) : relationships;
      if (value == null) {
        if (!relationships.length || (entities.length && !targets.length)) throw new NativePostbackError('Native lookup target is unresolved');
        // A polymorphic column has several navigation names but one stored
        // value. Clearing each navigation separately supplies the same column
        // twice; use the source-bound column's explicit null instead.
        if (submission.context.mode === 100000000) delete submission.body.values[field.name];
        else submission.body.values[field.name] = null;
      } else {
        if (targets.length !== 1) throw new NativePostbackError('Native lookup target is unresolved');
        const [navigation, relation] = targets[0], target = options.store.resolveMapping(relation.entity);
        delete submission.body.values[field.name];
        submission.body.values[navigation + '@odata.bind'] = `/${target.entitySet}(${encodeURIComponent(value)})`;
      }
    } else submission.body.values[field.name] = value;
  }
  const result = await submitPortalForm(submission.kind, submission.formId, submission.body, { ...options, nativePostback: true });
  return { result, context: submission.context };
}

const nativeValidationCodes = new Set(['FormFieldRequired', 'FormFieldInvalid', 'FormFieldOutOfRange', 'FormFieldTooLong', 'CaptchaInvalid']);

/** Only native field validators have an observed successful HTML response status. */
export function nativePostbackResponse({ result, error, context, values, observed }) {
  if (error) {
    const presentation = formWriteError(error, observed, context?.kind);
    if (presentation) return { status: 200, state: { ...context, values, outcome: presentation } };
    const errors = error.details?.validationErrors;
    if (error.status !== 400 || !Array.isArray(errors) || !errors.length || errors.some(item => !nativeValidationCodes.has(item.code))) throw error;
    return { status: 200, state: { ...context, values, validationErrors: errors } };
  }
  const outcome = result?.outcome;
  if (['redirect', 'step'].includes(outcome?.type) && typeof outcome.url === 'string' && outcome.url)
    return { status: 302, location: outcome.url };
  if (outcome?.type === 'tab') return { status: 200, state: { ...context, values, outcome: { type: 'none' } } };
  // A form that stays visible after its save re-renders the posted values (live insert captures).
  return { status: 200, state: { ...context, ...(outcome?.type === 'message' && outcome.hideForm === false && values ? { values } : {}), outcome: outcome ?? { type: 'none' }, savedId: result?.recordId ?? null, savedName: result?.name ?? null } };
}
