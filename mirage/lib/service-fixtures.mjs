// Service fixtures: the generic "fixture / disabled by default" mechanism for services Paqvilo never executes (Power BI
// embed, AI Builder predict, Copilot ask, Dynamics-specific operations). Keyed by service and operation rather than by
// Dataverse message name, so Liquid components and other hosts can use it too. The Dataverse precedent is registerAddon
// (dataverse-addon-common.mjs), which this follows.
//
// Resolution, in the registerAddon order:
//   1. a trusted pack's serviceFixtures[service][operation] wins (level 'fixture', source 'pack:<id>');
//   2. else the registered handle (level 'behaviour', source 'core');
//   3. else the fallback (level 'disabled', source 'core'). The default fallback answers
//      { error: { code: 'ServiceDisabled', service, operation } } and reports SERVICE_FIXTURE_DISABLED once per service
//      and operation. An operation that was never registered resolves to the default fallback as well.
// Out of scope by decision (ARCH-DECISIONS section 1): Power BI / Fabric rendering, AI Builder model inference and Copilot
// orchestration. This module never renders, infers or orchestrates; it answers with a pack fixture or the disabled error.
// The built-in catalogue is powerBi.embed, aiBuilder.predict and copilot.ask, each with the default fallback only.
// dynamics.* is not pre-registered: packs add its operations.
//
// Host seams: platform.mjs powerBiMarkup calls resolve('powerBi', 'embed')
// and uses { html } from a fixture before the placeholder; server.mjs runtimeState capabilities (about :1379) adds
// services: describe().
// ponytail: a fixture runs in-process with no timeout; packs are trusted code, as dataverseMessages handlers are.
// ponytail: each registry dedupes its own diagnostics; a process with several registries reports once per registry.
import { packCheck, registerPackExport } from "./pack-exports.mjs";

// Weakest first: a service's describe() level is the lowest level among its operations.
const LEVELS = ["disabled", "fixture", "behaviour"];
const BUILT_IN = [["powerBi", "embed"], ["aiBuilder", "predict"], ["copilot", "ask"]];

const key = (service, operation) => `${service}\u0000${operation}`;
const isName = (value) => typeof value === "string" && value.trim() !== "";

/** Validates the pack export 'serviceFixtures'. Returns the normalised map; throws TypeError naming the bad entry. */
export function validateServiceFixtures(map) {
  if (map === undefined) return {};
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new TypeError("serviceFixtures must map service names to objects of operation functions.");
  const result = {};
  for (const [service, operations] of Object.entries(map)) {
    if (!isName(service)) throw new TypeError("serviceFixtures service names must be non-empty strings.");
    if (!operations || typeof operations !== "object" || Array.isArray(operations)) throw new TypeError(`serviceFixtures.${service} must map operation names to functions.`);
    result[service] = {};
    for (const [operation, fn] of Object.entries(operations)) {
      if (!isName(operation)) throw new TypeError(`serviceFixtures.${service} operation names must be non-empty strings.`);
      if (typeof fn !== "function") throw new TypeError(`serviceFixtures.${service}.${operation} must be a function.`);
      // ponytail: the seam that consumes a fixture (platform.mjs Liquid render) is synchronous; a promise would leak to it.
      if (fn.constructor?.name === "AsyncFunction") throw new TypeError(`serviceFixtures.${service}.${operation} must be a synchronous function.`);
      result[service][operation] = fn;
    }
  }
  return result;
}

/**
 * createServiceFixtureRegistry({ packs, diagnostic }) -> { register, resolve, list, describe }.
 * packs: trusted pack objects (id, serviceFixtures). diagnostic(entry) receives SERVICE_FIXTURE_DISABLED entries.
 */
export function createServiceFixtureRegistry({ packs = [], diagnostic } = {}) {
  const registrations = new Map(); // key -> { signature, handle, fallback }
  const fixtures = new Map();      // key -> { run, source, packId }
  const reported = new Set();

  function defaultFallback(service, operation) {
    return () => {
      const k = key(service, operation);
      if (!reported.has(k)) {
        reported.add(k);
        diagnostic?.({
          code: "SERVICE_FIXTURE_DISABLED", severity: "warning", service, operation,
          message: `${service}.${operation} is not executed locally and no pack serviceFixtures entry answers it.`,
        });
      }
      return { error: { code: "ServiceDisabled", service, operation } };
    };
  }

  function register({ service, operation, signature, handle, fallback } = {}) {
    if (!isName(service) || !isName(operation)) throw new TypeError("register needs a service and an operation name.");
    if (handle !== undefined && typeof handle !== "function") throw new TypeError(`${service}.${operation} handle must be a function.`);
    if (fallback !== undefined && typeof fallback !== "function") throw new TypeError(`${service}.${operation} fallback must be a function.`);
    const k = key(service, operation);
    if (registrations.has(k)) throw new Error(`Service fixture ${service}.${operation} is already registered.`);
    registrations.set(k, { signature: signature ?? null, handle: handle ?? null, fallback: fallback ?? defaultFallback(service, operation) });
  }

  for (const [service, operation] of BUILT_IN) register({ service, operation });

  for (const pack of packs) {
    const packId = pack.id ?? "anonymous";
    let map;
    try { map = validateServiceFixtures(pack.serviceFixtures); } catch (error) { throw new TypeError(`Data pack ${packId}: ${error.message}`); }
    for (const [service, operations] of Object.entries(map)) {
      for (const [operation, run] of Object.entries(operations)) {
        const k = key(service, operation);
        const previous = fixtures.get(k);
        if (previous) throw new Error(`Ambiguous serviceFixtures registration for ${service}.${operation} in packs ${previous.packId} and ${packId}`);
        fixtures.set(k, { run, source: `pack:${packId}`, packId });
      }
    }
  }

  function resolve(service, operation) {
    const k = key(service, operation);
    const registration = registrations.get(k) ?? { signature: null, handle: null, fallback: defaultFallback(service, operation) };
    const fixture = fixtures.get(k);
    if (fixture) return { level: "fixture", source: fixture.source, signature: registration.signature, run: fixture.run };
    if (registration.handle) return { level: "behaviour", source: "core", signature: registration.signature, run: registration.handle };
    return { level: "disabled", source: "core", signature: registration.signature, run: registration.fallback };
  }

  function list() {
    const pairs = new Set([...registrations.keys(), ...fixtures.keys()]);
    return [...pairs].map((k) => k.split("\u0000")).sort(([a, x], [b, y]) => (a + "\u0000" + x < b + "\u0000" + y ? -1 : 1))
      .map(([service, operation]) => {
        const { level, source } = resolve(service, operation);
        return { service, operation, level, source };
      });
  }

  // One capability record per service (ARCH-DECISIONS section 2 item 4).
  function describe() {
    const services = new Map();
    for (const entry of list()) {
      if (!services.has(entry.service)) services.set(entry.service, []);
      services.get(entry.service).push({ name: entry.operation, level: entry.level });
    }
    return [...services].map(([service, operations]) => ({
      name: `service:${service}`, version: 1, kind: "provider",
      level: LEVELS[Math.min(...operations.map((operation) => LEVELS.indexOf(operation.level)))],
      operations, requires: [], principal: "none", stateOwner: "none", lifecycle: "in-process",
    }));
  }

  return { register, resolve, list, describe };
}

registerPackExport("serviceFixtures", { kind: "value", check: packCheck(validateServiceFixtures),
  entries: (map) => Object.entries(map).flatMap(([service, operations]) => Object.entries(operations).map(([operation, run]) => [`${service}.${operation}`, run])) });
