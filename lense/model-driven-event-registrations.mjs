import { createHash } from 'node:crypto';
import { parseHandlerParameters, normalizeClientLibrary } from '../mirage/lib/model-driven/client-runtime.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = (value) => String(value).replace(/[{}]/g, '').toLowerCase();
const fail = (message, code = 'EVENT_REGISTRATION_REQUEST_INVALID') => {
  throw Object.assign(new Error(message), { code });
};
const filter = (value, name, maximum = 256) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > maximum) fail(`Invalid event ${name} filter.`);
  return value;
};

function advanceRegistrationForm(state) {
  state.position = [state.position[0] + 1, 0, 0];
}

function skipFilteredRegistrationForm(state, definition, filters) {
  if (!(
    (filters.entity && norm(definition.entity) !== norm(filters.entity)) ||
    (filters.formId && norm(definition.id) !== norm(filters.formId))
  ))
    return false;
  if (state.position[1] || state.position[2]) fail('Event cursor is outside the selected forms.');
  advanceRegistrationForm(state);
  state.examined++;
  return true;
}

function loadRegistrationForm(state, key, compile) {
  if (state.currentFormIndex !== state.position[0]) {
    state.compiled++;
    state.currentFormIndex = state.position[0];
    state.currentForm = compile(key);
  }
  return state.currentForm;
}

function unavailableRegistrationForm(state, key, definition, diagnose) {
  if (state.position[1] || state.position[2]) fail('Event cursor is outside this unavailable form.');
  if (!diagnose({ code: 'EVENT_FORM_UNAVAILABLE', formKey: key, formId: definition.id, entity: definition.entity }))
    return 'break';
  advanceRegistrationForm(state);
  return 'continue';
}

function prepareRegistrationHandler(state, form) {
  const events = form.events ?? [];
  if (state.position[1] > events.length) fail('Event cursor is outside this form.');
  if (state.position[1] === events.length) {
    if (state.position[2]) fail('Event cursor is outside this form.');
    advanceRegistrationForm(state);
    return null;
  }
  const event = events[state.position[1]],
    handlers = event.handlers?.length ? event.handlers : [null];
  if (state.position[2] >= handlers.length) fail('Event cursor is outside this handler list.');
  const handler = handlers[state.position[2]],
    eventIndex = state.position[1],
    handlerIndex = handler ? state.position[2] : null;
  let next = [state.position[0] + 1, 0, 0];
  if (state.position[2] + 1 < handlers.length) next = [state.position[0], state.position[1], state.position[2] + 1];
  else if (state.position[1] + 1 < events.length) next = [state.position[0], state.position[1] + 1, 0];
  state.examined++;
  return { event, handler, eventIndex, handlerIndex, next };
}

function registrationLibraryStatuses(handler, form, matches) {
  const declared =
    handler &&
    form.libraries.some((library) => normalizeClientLibrary(library) === normalizeClientLibrary(handler.library));
  let libraryStatus = 'available';
  if (!handler) libraryStatus = 'not-applicable';
  else if (!declared) libraryStatus = 'undeclared';
  else if (!matches.length) libraryStatus = 'missing';
  else if (matches.length > 1) libraryStatus = 'ambiguous';
  else if (matches[0].type !== 'script') libraryStatus = 'not-script';
  let resourceStatus = 'available';
  if (!handler) resourceStatus = 'not-applicable';
  else if (!matches.length) resourceStatus = 'missing';
  else if (matches.length > 1) resourceStatus = 'ambiguous';
  else if (matches[0].type !== 'script') resourceStatus = 'not-script';
  return { libraryStatus, resourceStatus };
}

function registrationParameterStatus(handler) {
  let parameterCount,
    parameterStatus = 'literal';
  try {
    parameterCount = parseHandlerParameters(handler?.parameters ?? '').length;
  } catch {
    parameterCount = null;
    parameterStatus = 'unsupported';
  }
  return { parameterCount, parameterStatus };
}

function emitRegistrationHandler(state, item, context) {
  const { filters, resourcesByName, sourceRefs, component, emit, maxBytes, envelopeBytes } = context;
  const { key, definition, form, event, handler, eventIndex, handlerIndex, next } = item;
  if (filters.library && normalizeClientLibrary(handler?.library) !== normalizeClientLibrary(filters.library)) {
    state.position = next;
    return 'continue';
  }
  const matches = handler?.library ? (resourcesByName.get(normalizeClientLibrary(handler.library)) ?? []) : [];
  const { libraryStatus, resourceStatus } = registrationLibraryStatuses(handler, form, matches);
  const { parameterCount, parameterStatus } = registrationParameterStatus(handler);
  const row = {
    formKey: key,
    formId: definition.id,
    entity: definition.entity,
    formName: component(key)?.name,
    eventIndex,
    event: event.name,
    attribute: event.attribute ?? null,
    eventActive: event.active,
    handlerIndex,
    handlerId: handler?.handlerUniqueId ?? null,
    library: handler?.library ?? null,
    functionName: handler?.functionName ?? null,
    enabled: handler?.enabled ?? null,
    passExecutionContext: handler?.passExecutionContext ?? null,
    parameterCount,
    parameterStatus,
    ...(filters.includeParameters && handler ? { parameters: handler.parameters } : {}),
    libraryStatus,
    resourceStatus,
    sourceRefs: sourceRefs(key),
  };
  const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
  if (bytes > maxBytes - envelopeBytes) {
    if (!context.diagnose({ code: 'EVENT_REGISTRATION_ROW_LIMIT', formKey: key, eventIndex, handlerIndex, bytes }))
      return 'break';
  } else if (!emit(row)) return 'break';
  state.position = next;
  return 'continue';
}

function processRegistrationIteration(state, context) {
  const [key, definition] = context.definitions[state.position[0]];
  if (skipFilteredRegistrationForm(state, definition, context.filters)) return 'continue';
  const form = loadRegistrationForm(state, key, context.compile);
  if (!form) return unavailableRegistrationForm(state, key, definition, context.diagnose);
  const prepared = prepareRegistrationHandler(state, form);
  if (!prepared) return 'continue';
  return emitRegistrationHandler(state, { key, definition, form, ...prepared }, context);
}

function validateRegistrationRequest(request, inventoryRevision, definitionCount) {
  const filters = {
    entity: filter(request.entity, 'entity'),
    formId: filter(request.formId, 'form'),
    library: filter(request.library, 'library', 2048),
    includeParameters: request.includeParameters ?? false,
  };
  if (typeof filters.includeParameters !== 'boolean') fail('includeParameters must be boolean.');
  const selection = digest(filters),
    maxItems = request.budget?.items ?? 100,
    maxBytes = request.budget?.bytes ?? 128 * 1024;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 512) fail('Event item budget must be 1..512.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > 512 * 1024)
    fail('Event byte budget must be 2048..524288.');
  const cursor = request.cursor;
  if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)))
    fail('Invalid event registration cursor.');
  if (cursor && (cursor.inventoryRevision !== inventoryRevision || cursor.selection !== selection))
    fail(
      'Event registrations changed or filters differ; restart without the cursor.',
      'EVENT_REGISTRATION_CURSOR_STALE',
    );
  const position = cursor?.position ?? [0, 0, 0];
  if (
    !Array.isArray(position) ||
    position.length !== 3 ||
    position.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    position[0] > definitionCount ||
    (position[0] === definitionCount && (position[1] !== 0 || position[2] !== 0))
  )
    fail('Invalid event registration cursor.');
  return { filters, selection, maxItems, maxBytes, position: [...position] };
}

function makeRegistrationEmitter(state, { maxItems, maxBytes, envelopeBytes, registrations, diagnostics }) {
  let usedBytes = envelopeBytes,
    items = 0;
  const emit = (value, diagnostic = false) => {
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (items >= maxItems || usedBytes + bytes > maxBytes) return false;
    (diagnostic ? diagnostics : registrations).push(value);
    usedBytes += bytes;
    items++;
    return true;
  };
  const diagnose = (value) =>
    emit(
      Buffer.byteLength(JSON.stringify(value)) + 1 > maxBytes - envelopeBytes
        ? {
            code: value.code,
            formIndex: state.position[0],
            eventIndex: state.position[1],
            handlerIndex: state.position[2],
            detailsOmitted: true,
          }
        : value,
      true,
    );
  return { emit, diagnose };
}

/** Source declarations only. This never loads a library or interprets a handler. */
export function createEventRegistrationReader({
  forms,
  compile,
  component,
  sourceRefs,
  resources,
  sourceRevision,
  lcid,
}) {
  const definitions = [...forms],
    declaredResources = [...resources];
  const fingerprint = createHash('sha256').update(JSON.stringify([sourceRevision, lcid]));
  for (const [key, form] of definitions)
    fingerprint.update(JSON.stringify([key, form.entity, form.name, form.xml, form.file ?? form.source]));
  const resourcesByName = new Map();
  for (const resource of declaredResources) {
    fingerprint.update(JSON.stringify(resource));
    const name = normalizeClientLibrary(resource.name),
      matching = resourcesByName.get(name) ?? [];
    matching.push(resource);
    resourcesByName.set(name, matching);
  }
  const inventoryRevision = fingerprint.digest('hex');
  return (request = {}) => {
    const { filters, selection, maxItems, maxBytes, position } = validateRegistrationRequest(
      request,
      inventoryRevision,
      definitions.length,
    );
    const registrations = [],
      diagnostics = [];
    const limits = { items: maxItems, bytes: maxBytes, examined: 10000, compiledForms: 256 };
    const envelopeCursor = { inventoryRevision, selection, position: new Array(3).fill(Number.MAX_SAFE_INTEGER) };
    // Charge the revision-dependent envelope too, reserving the optional CLI
    // token at its largest cursor position so every completed page fits.
    const envelopeBytes =
      Buffer.byteLength(
        JSON.stringify({
          version: 1,
          kind: 'source-registration-inventory',
          sourceRevision,
          inventoryRevision,
          registrations: [],
          diagnostics: [],
          complete: false,
          truncated: true,
          limits,
          nextCursor: envelopeCursor,
          nextCursorToken: Buffer.from(JSON.stringify(envelopeCursor)).toString('base64url'),
        }),
      ) + 32;
    if (envelopeBytes > maxBytes)
      fail('Event report metadata exceeds the byte budget.', 'EVENT_REGISTRATION_ENVELOPE_LIMIT');
    const state = {
      position,
      examined: 0,
      compiled: 0,
      currentFormIndex: -1,
      currentForm: undefined,
    };
    const { emit, diagnose } = makeRegistrationEmitter(state, {
      maxItems,
      maxBytes,
      envelopeBytes,
      registrations,
      diagnostics,
    });
    const iterationContext = {
      definitions,
      filters,
      compile,
      diagnose,
      emit,
      maxBytes,
      envelopeBytes,
      resourcesByName,
      sourceRefs,
      component,
    };
    while (state.position[0] < definitions.length && state.examined < 10000 && state.compiled < 256) {
      if (processRegistrationIteration(state, iterationContext) === 'break') break;
    }
    const finalPosition = state.position;
    const complete = finalPosition[0] === definitions.length;
    return {
      version: 1,
      kind: 'source-registration-inventory',
      sourceRevision,
      inventoryRevision,
      registrations,
      diagnostics,
      complete,
      truncated:
        !complete || diagnostics.some((item) => item.code === 'EVENT_REGISTRATION_ROW_LIMIT' || item.detailsOmitted),
      limits,
      ...(complete ? {} : { nextCursor: { inventoryRevision, selection, position: finalPosition } }),
    };
  };
}
