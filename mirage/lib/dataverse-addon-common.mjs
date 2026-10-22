// Shared plumbing for the Dataverse add-on families (lib/dataverse-addon-*.mjs and the add-on messages of the other modules).
//
// registerAddon(api, spec) registers one message. The router answers a call in this order:
//   1. a trusted pack's dataverseMessages handler for the message name (addonHandlers, from the packs);
//   2. spec.handle(c), the deterministic store-backed behaviour, where the module has one;
//   3. spec.fallback(), the documented default error (an unavailable service, a feature that is not enabled).
// A pack handler gets ctx { name, args, target, caller, user, origin, version, api }. target is { logicalName, id, row }
// for a bound call, else null. A returned object is the response body (wrapped with its @odata.context); undefined is 204.
//
// GC policy (internal-only messages): Learn marks some messages "For internal use only" (quote and URL in a comment at the
// call site), yet they exist in the native $metadata, so they are registered too. registerInternalMessage(api, spec) is
// registerAddon with fallback = notSimulated(name): a pack handler still replaces it, and otherwise the call answers
// 501 NotImplemented, innerCode 0x80040216, "<Name> is for internal use only and is not simulated." (unverified).
//
// Default errors: aiUnavailable is the Predict default from the code interpreter troubleshooting page (403 0x80048d06), and
// featureNotEnabled is the web service error 0x80061113. The HTTP status of featureNotEnabled is unverified.
// ponytail: argsOf, idOf and respond are copies of the helpers in dataverse-app-messages.mjs (not exported there).
import { DataError } from "./data-error.mjs";
import { collectPackExport } from "./pack-exports.mjs";
import { contextUrl } from "./dataverse-odata.mjs";

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export function idOf(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.match(GUID)?.[0] ?? null;
  if (typeof value !== "object") return null;
  const direct = value.id ?? value["@odata.id"];
  if (direct != null) return idOf(direct);
  return Object.values(value).map(idOf).find(Boolean) ?? null;
}

const body = (c) => (typeof c.body === "string" ? JSON.parse(c.body || "{}") : (c.body ?? {}));
export const argsOf = (c) => ({ ...body(c), ...(c.params ?? {}) });

// A response with the native @odata.context for the <name>Response complex type.
export function respond(c, name, payload) {
  return { status: 200, body: { "@odata.context": contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...payload } };
}

// Trusted pack handlers: a pack's dataverseMessages maps a message name (exact, case-sensitive) to async (ctx) => body | undefined.
// Returns Map(name -> { handler, pack }), where pack is the pack id that supplied it.
export function addonHandlers(packs = []) {
  return new Map([...collectPackExport(packs, "dataverseMessages")].map(([name, { value, pack }]) => [name, { handler: value, pack: pack ?? null }]));
}

// Attaches the handlers to the API (api.addonHandlers). Install it after every add-on module: it fails when a pack names a
// message that no module registered.
export function addonHandlerExtension(handlers) {
  return {
    name: "dataverse-addon-handlers",
    install(api) {
      for (const [name, { pack }] of handlers) {
        if (!api.registry.has(name)) throw new Error(`Data pack ${pack}: dataverseMessages names unknown message ${name}`);
      }
      api.addonHandlers = handlers;
    },
  };
}

// spec: { name, kind ("function" | "action"), binding ("unbound" | "entity" | "collection"), entity, signature, csdl?, handle?, fallback }.
// signature is { params: [[name, type]], response: [[property, type]] } or { params, returns }, as in dataverse-operations.mjs.
// fallback is a function that returns the error to throw when neither a pack handler nor handle answers.
export function registerAddon(api, spec) {
  const { name, kind, binding, entity, signature, csdl, handle: own, fallback } = spec;
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
        result = await packed.handler({
          name,
          args: argsOf(c),
          target: c.target ? { logicalName: c.target.mapping?.logicalName ?? null, id: c.target.id ?? null, row: c.target.row ?? null } : null,
          caller: c.caller,
          user: c.user,
          origin: c.origin,
          version: c.version,
          api,
        });
      } else if (own) result = await own(c);
      else throw fallback();
      if (result === undefined || result === null) return undefined;
      return respond(c, name, result);
    },
  });
}

// The GC stub: an internal-only message with its native signature, a pack override and the "not simulated" default.
export function registerInternalMessage(api, spec) {
  registerAddon(api, { ...spec, fallback: () => notSimulated(spec.name) });
}

export function notSimulated(name) {
  return new DataError(`${name} is for internal use only and is not simulated.`, 501, "NotImplemented", { innerCode: "0x80040216" });
}

// Predict and the other AI messages without capacity: the documented error body from the Predict troubleshooting section.
export function aiUnavailable() {
  return new DataError(
    '{"operationStatus":"Error","error":{"type":"Error","code":"EntitlementNotAvailable","innerErrors":[{"scope":"Generic","target":null,"code":"NoCapacity","type":"Error","message":"No capacity was found."}]},"predictionId":null}',
    403,
    "EntitlementNotAvailable",
    { innerCode: "0x80048d06" },
  );
}

// A message that needs a feature the organization has not enabled (web service error 0x80061113).
export function featureNotEnabled() {
  return new DataError("This operation couldn't be completed because this feature isn’t enabled for your organization.", 400, "FeatureNotEnabled", { innerCode: "0x80061113" });
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
      const recorded = { severity: "warning", ...entry };
      diagnostics.push(recorded);
      diagnostic?.(recorded);
    },
    clear() {
      seen.clear();
      diagnostics.length = 0;
    },
  };
}
