import { argsOf } from './dataverse-message-context.mjs';
export { argsOf, idOf } from './dataverse-message-context.mjs';
// Shared plumbing for the Dataverse add-on families (lib/dataverse-addon-*.mjs and the add-on messages of the other modules).
//
// registerAddon(api, spec) registers one message. The router answers a call in this order:
//   1. a trusted pack's dataverseMessages handler for the message name (addonHandlers, from the packs);
//   2. spec.handle(c), the deterministic store-backed behaviour, where the module has one;
//   3. spec.fallback(), the documented default error (an unavailable service, a feature that is not enabled).
// A pack handler gets ctx { name, args, target, caller, user, origin, version, api }. target is { logicalName, id, row }
// for a bound call, else null. A returned object is the response body (wrapped with its @odata.context); undefined is 204.
//
// Internal-only messages: some messages are documented "For internal use only", yet they exist in the native $metadata,
// so they are registered too. registerInternalMessage(api, spec) is registerAddon with fallback = notSimulated(name):
// a pack handler still replaces it, and otherwise the call answers 501 NotImplemented, innerCode 0x80040216,
// "<Name> is for internal use only and is not simulated." (a simulator answer, not a native one).
//
// Default errors: aiUnavailable is the documented Predict error (403 0x80048d06), and featureNotEnabled is the web service
// error 0x80061113. The HTTP status of featureNotEnabled is a guess.
import { DataError } from './data-error.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { invokeTrustedHandler } from './trusted-handler-invocation.mjs';

// Columns the store stamps for the caller (owner, audit and version columns): a caller's value for one of them is not stored.
export const STAMPED_COLUMNS = new Set([
  'ownerid',
  'owninguser',
  'owningteam',
  'owningbusinessunit',
  'createdby',
  'createdon',
  'createdonbehalfby',
  'modifiedby',
  'modifiedon',
  'modifiedonbehalfby',
  'versionnumber',
  'organizationid',
]);

// An OData annotation key of a payload entry: any key with '@' other than a bind ("<nav>@odata.bind"). That covers "@odata.type"
// and the value annotations on a column ("<column>@odata.type"). A bind is not an annotation: the caller decides what it means.
const isAnnotationKey = (name) => name.includes('@') && !name.endsWith('@odata.bind');

// The entry's keys that are not OData annotations, with their values.
function withoutAnnotations(entry) {
  return Object.fromEntries(Object.entries(entry ?? {}).filter(([name]) => !isAnnotationKey(name)));
}

// The columns a caller's entry sets on a row the operation creates: its keys without annotations, the stamped ones dropped.
// A "<nav>@odata.bind" key is refused with a 400 that names it and the operation, and any other key the table does not declare
// is a 400 too. `reason` says why the caller cannot set that navigation.
export function callerColumns(store, table, entry, { operation, reason }) {
  const known = store.fieldDefinitions(table);
  const columns = {};
  for (const [name, value] of Object.entries(withoutAnnotations(entry))) {
    if (name.endsWith('@odata.bind'))
      throw new DataError(`'${name}' is not supported on ${operation}: ${reason}.`, 400, 'InvalidRequest', {
        innerCode: '0x80040203',
      });
    if (!Object.hasOwn(known, name))
      throw new DataError(`'${name}' is not a column of ${table}.`, 400, 'InvalidRequest', {
        innerCode: '0x80040203',
      });
    if (!STAMPED_COLUMNS.has(name)) columns[name] = value;
  }
  return columns;
}

// A response with the native @odata.context for the <name>Response complex type.
export function respond(c, name, payload) {
  return {
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...payload },
  };
}

// Trusted pack handlers: a pack's dataverseMessages maps a message name (exact, case-sensitive) to async (ctx) => body | undefined.
// Returns Map(name -> { handler, pack }), where pack is the pack id that supplied it.
export function addonHandlers(packs = []) {
  return new Map(
    [...collectPackExport(packs, 'dataverseMessages')].map(([name, { value, pack }]) => [
      name,
      { handler: value, pack: pack ?? null },
    ]),
  );
}

// Attaches the handlers to the API (api.addonHandlers). Install it after every add-on module: it fails when a pack names a
// message that no module registered.
export function addonHandlerExtension(handlers) {
  return {
    name: 'dataverse-addon-handlers',
    install(api) {
      for (const [name, { pack }] of handlers) {
        if (!api.registry.has(name))
          throw new Error(`Data pack ${pack}: dataverseMessages names unknown message ${name}`);
      }
      api.addonHandlers = handlers;
    },
    // A pack handler is a declared answer, not the platform's behaviour: every message it answers is at contract.
    describe: () => ({
      name: 'dataverse-addon-handlers',
      version: 1,
      kind: 'dataverse-extension',
      level: 'contract',
      operations: [...handlers.keys()].map((name) => ({ name, level: 'contract' })),
      reason: 'Routes add-on messages to trusted pack dataverseMessages handlers; their answers are pack-declared.',
      requires: [],
      principal: 'caller',
      stateOwner: 'pack',
      lifecycle: 'per-request',
    }),
  };
}

// Per API: add-on message name -> whether its module gave it an own handler (registerAddon `handle`). Read by addonLevel.
const addonOwnHandlers = new WeakMap();

/**
 * The capability level an add-on message takes regardless of its module's rating, or null when the module rates it:
 * a trusted pack handler answers it (contract), or it has no own handler and answers its default error (inventory).
 * null as well for a name registerAddon did not register on this api.
 */
export function addonLevel(api, name) {
  const own = api ? addonOwnHandlers.get(api)?.get(name) : undefined;
  if (own === undefined) return null;
  if (api.addonHandlers?.has(name))
    return { level: 'contract', reason: 'Answered by a trusted pack dataverseMessages handler.' };
  if (own) return null;
  return {
    level: 'inventory',
    reason: 'No local behaviour: answers its documented default error unless a trusted pack handler replaces it.',
  };
}

// spec: { name, kind ("function" | "action"), binding ("unbound" | "entity" | "collection"), entity, signature, csdl?, handle?, fallback }.
// signature is { params: [[name, type]], response: [[property, type]] } or { params, returns }, as in dataverse-operations.mjs.
// fallback is a function that returns the error to throw when neither a pack handler nor handle answers.
export function registerAddon(api, spec) {
  const { name, kind, binding, entity, signature, csdl, handle: own, fallback } = spec;
  if (!addonOwnHandlers.has(api)) addonOwnHandlers.set(api, new Map());
  addonOwnHandlers.get(api).set(name, Boolean(own));
  api.registry.register({
    name,
    kind,
    binding,
    entity,
    signature,
    csdl,
    handle: async (c) => {
      const packed = api.addonHandlers?.get(name);
      let result;
      if (packed) {
        result = await invokeTrustedHandler(
          api,
          packed.handler,
          {
            name,
            args: argsOf(c),
            target: c.target
              ? {
                  logicalName: c.target.mapping?.logicalName ?? null,
                  id: c.target.id ?? null,
                  row: c.target.row ?? null,
                }
              : null,
            caller: c.caller,
            user: c.user,
            origin: c.origin,
            version: c.version,
          },
          { label: `The data pack's dataverseMessages handler for "${name}"` },
        );
      } else if (own) result = await own(c);
      else throw fallback();
      if (result === undefined || result === null) return undefined;
      // A Collection(mscrm.crmbaseentity) return type answers its entities as an OData collection.
      if (Array.isArray(result))
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(c.origin, c.version, 'Collection(Microsoft.Dynamics.CRM.crmbaseentity)'),
            value: result,
          },
        };
      return respond(c, name, result);
    },
  });
}

// An internal-only message with its native signature, a pack override and the "not simulated" default.
export function registerInternalMessage(api, spec) {
  registerAddon(api, { ...spec, fallback: () => notSimulated(spec.name) });
}

function notSimulated(name) {
  return new DataError(`${name} is for internal use only and is not simulated.`, 501, 'NotImplemented', {
    innerCode: '0x80040216',
  });
}

// Predict and the other AI messages without capacity: the documented Predict error body.
export function aiUnavailable() {
  return new DataError(
    '{"operationStatus":"Error","error":{"type":"Error","code":"EntitlementNotAvailable","innerErrors":[{"scope":"Generic","target":null,"code":"NoCapacity","type":"Error","message":"No capacity was found."}]},"predictionId":null}',
    403,
    'EntitlementNotAvailable',
    { innerCode: '0x80048d06' },
  );
}

// A message that needs a feature the organization has not enabled (web service error 0x80061113).
export function featureNotEnabled() {
  return new DataError(
    "This operation couldn't be completed because this feature isn’t enabled for your organization.",
    400,
    'FeatureNotEnabled',
    { innerCode: '0x80061113' },
  );
}

// Pack overrides from the runtime's pack export registry: api.packExport(name) is a Map of key -> { value, pack }, converted to
// the plain object a module's validator reads. undefined when the runtime has no registry or no pack exports the name.
export function packOverrides(api, name) {
  const found = api.packExport?.(name);
  return found && Object.fromEntries([...found].map(([key, { value }]) => [key, value]));
}

// Once-per-key diagnostics for the Dataverse extension modules: report(entry, key) records an entry (severity warning unless the
// entry names one) and forwards it to `diagnostic` the first time its key is seen; clear() starts again (a reseed).
export function onceReporter(diagnostic = null) {
  const seen = new Set();
  const diagnostics = [];
  return {
    diagnostics,
    report(entry, key) {
      if (seen.has(key)) return;
      seen.add(key);
      const recorded = { severity: 'warning', ...entry };
      diagnostics.push(recorded);
      diagnostic?.(recorded);
    },
    clear() {
      seen.clear();
      diagnostics.length = 0;
    },
  };
}
