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
    let position = cursor?.position ?? [0, 0, 0];
    if (
      !Array.isArray(position) ||
      position.length !== 3 ||
      position.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      position[0] > definitions.length ||
      (position[0] === definitions.length && (position[1] !== 0 || position[2] !== 0))
    )
      fail('Invalid event registration cursor.');
    position = [...position];
    const registrations = [],
      diagnostics = [];
    const limits = { items: maxItems, bytes: maxBytes, examined: 10000, compiledForms: 256 };
    const envelopeCursor = { inventoryRevision, selection, position: Array(3).fill(Number.MAX_SAFE_INTEGER) };
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
    let usedBytes = envelopeBytes,
      items = 0,
      examined = 0,
      compiled = 0,
      currentFormIndex = -1,
      currentForm;
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
              formIndex: position[0],
              eventIndex: position[1],
              handlerIndex: position[2],
              detailsOmitted: true,
            }
          : value,
        true,
      );
    while (position[0] < definitions.length && examined < 10000 && compiled < 256) {
      const [key, definition] = definitions[position[0]];
      const advanceForm = () => {
        position = [position[0] + 1, 0, 0];
      };
      if (
        (filters.entity && norm(definition.entity) !== norm(filters.entity)) ||
        (filters.formId && norm(definition.id) !== norm(filters.formId))
      ) {
        if (position[1] || position[2]) fail('Event cursor is outside the selected forms.');
        advanceForm();
        examined++;
        continue;
      }
      if (currentFormIndex !== position[0]) {
        compiled++;
        currentFormIndex = position[0];
        currentForm = compile(key);
      }
      const form = currentForm;
      if (!form) {
        if (position[1] || position[2]) fail('Event cursor is outside this unavailable form.');
        if (
          !diagnose({ code: 'EVENT_FORM_UNAVAILABLE', formKey: key, formId: definition.id, entity: definition.entity })
        )
          break;
        advanceForm();
        continue;
      }
      const events = form.events ?? [];
      if (position[1] > events.length) fail('Event cursor is outside this form.');
      if (position[1] === events.length) {
        if (position[2]) fail('Event cursor is outside this form.');
        advanceForm();
        continue;
      }
      const event = events[position[1]],
        handlers = event.handlers?.length ? event.handlers : [null];
      if (position[2] >= handlers.length) fail('Event cursor is outside this handler list.');
      const handler = handlers[position[2]],
        eventIndex = position[1],
        handlerIndex = handler ? position[2] : null;
      const next =
        position[2] + 1 < handlers.length
          ? [position[0], position[1], position[2] + 1]
          : position[1] + 1 < events.length
            ? [position[0], position[1] + 1, 0]
            : [position[0] + 1, 0, 0];
      examined++;
      if (filters.library && normalizeClientLibrary(handler?.library) !== normalizeClientLibrary(filters.library)) {
        position = next;
        continue;
      }
      const matches = handler?.library ? (resourcesByName.get(normalizeClientLibrary(handler.library)) ?? []) : [];
      const declared =
        handler &&
        form.libraries.some((library) => normalizeClientLibrary(library) === normalizeClientLibrary(handler.library));
      const libraryStatus = !handler
        ? 'not-applicable'
        : !declared
          ? 'undeclared'
          : !matches.length
            ? 'missing'
            : matches.length > 1
              ? 'ambiguous'
              : matches[0].type !== 'script'
                ? 'not-script'
                : 'available';
      const resourceStatus = !handler
        ? 'not-applicable'
        : !matches.length
          ? 'missing'
          : matches.length > 1
            ? 'ambiguous'
            : matches[0].type !== 'script'
              ? 'not-script'
              : 'available';
      let parameterCount,
        parameterStatus = 'literal';
      try {
        parameterCount = parseHandlerParameters(handler?.parameters ?? '').length;
      } catch {
        parameterCount = null;
        parameterStatus = 'unsupported';
      }
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
        if (!diagnose({ code: 'EVENT_REGISTRATION_ROW_LIMIT', formKey: key, eventIndex, handlerIndex, bytes })) break;
      } else if (!emit(row)) break;
      position = next;
    }
    const complete = position[0] === definitions.length;
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
      ...(complete ? {} : { nextCursor: { inventoryRevision, selection, position } }),
    };
  };
}
