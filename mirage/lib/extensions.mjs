// Extension points that data packs contribute through the preset registry.
// The runtime itself stays project-neutral: project-specific plugin
// expression operators, shell conventions and HTTP endpoints live in packs.
// Operators and shell conventions are per-runtime registries built from the
// packs that matched the runtime's portal (createPackRegistries). The lookups
// below read the registry of the current scope (runWithPackRegistries), else
// every activated registry plus the legacy process-wide registrations.
import { AsyncLocalStorage } from 'node:async_hooks';
import { collectPackExport } from './pack-exports.mjs';

const emptyRegistries = () => ({ operators: new Map(), footerLogos: new Map(), notificationQueries: new Map() });
// Process-wide registrations made directly through registerExpressionOperators/registerShellConventions.
const legacy = emptyRegistries();
const operators = legacy.operators;
// ponytail: one activated registry per distinct matched pack set (bounded by the packs a process loads);
// a host that runs several runtimes isolates them by entering runWithPackRegistries per request.
const active = new Map();
const scope = new AsyncLocalStorage();

/** Registries of operators and shell conventions for the packs of one runtime; duplicates across packs throw. */
export function createPackRegistries(packs = []) {
  const registries = emptyRegistries();
  for (const [name, { value, pack }] of collectPackExport(packs, 'expressionOperators')) registries.operators.set(name, { packId: pack, evaluate: value });
  for (const [key, { value, pack }] of collectPackExport(packs, 'shell'))
    (key.startsWith('footerLogoClass:') ? registries.footerLogos : registries.notificationQueries).set(value, pack);
  return Object.freeze({ ...registries, packIds: packs.map(pack => pack.id) });
}

/** Makes a runtime's registries visible to lookups outside any runWithPackRegistries scope. */
export function activatePackRegistries(registries) {
  active.set(JSON.stringify(registries.packIds ?? []), registries);
  return registries;
}

/** Runs fn with lookups confined to one runtime's registries (plus the legacy registrations). */
export function runWithPackRegistries(registries, fn) {
  return scope.run(registries, fn);
}

const sources = () => {
  const scoped = scope.getStore();
  return scoped ? [scoped, legacy] : [legacy, ...active.values()];
};
const keysOf = field => [...new Set(sources().flatMap(registries => [...registries[field].keys()]))];

/**
 * Register plugin expression operators of `packId` ({ name: evaluate }).
 * evaluate({ store, context, args, expression, fail }) runs synchronously
 * inside a DataStore transaction and returns the expression value.
 */
export function registerExpressionOperators(packId, definitions) {
  if (definitions == null) return;
  if (typeof definitions !== "object" || Array.isArray(definitions))
    throw new TypeError(`Pack ${packId}: expressionOperators must be an object of functions`);
  for (const [name, evaluate] of Object.entries(definitions)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || typeof evaluate !== "function")
      throw new TypeError(`Pack ${packId}: expression operator ${name} must be a named function`);
    const existing = operators.get(name);
    if (existing && existing.packId !== packId)
      throw new Error(`Expression operator ${name} is already provided by pack ${existing.packId}`);
    operators.set(name, { packId, evaluate });
  }
}

/** The evaluate function of a registered operator, or null. */
export function expressionOperator(name) {
  for (const registries of sources()) {
    const found = registries.operators.get(name);
    if (found) return found.evaluate;
  }
  return null;
}

/** Names and packs of the registered operators (diagnostics). */
export function expressionOperators() {
  const seen = new Map();
  for (const registries of sources()) for (const [name, { packId }] of registries.operators) if (!seen.has(name)) seen.set(name, packId);
  return [...seen].map(([name, packId]) => ({ name, packId }));
}

/**
 * Validate pack HTTP endpoints: [{ id, methods: ["GET", ...], pattern:
 * RegExp, handle(context) }]. The server dispatches a request to the first
 * endpoint of an active pack whose pattern matches the path.
 */
export function validateEndpoints(packId, endpoints) {
  if (endpoints == null) return [];
  if (!Array.isArray(endpoints)) throw new TypeError(`Pack ${packId}: endpoints must be an array`);
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint.id !== "string" || !(endpoint.pattern instanceof RegExp) || typeof endpoint.handle !== "function")
      throw new TypeError(`Pack ${packId}: every endpoint needs id, pattern (RegExp) and handle(context)`);
    if (!Array.isArray(endpoint.methods) || !endpoint.methods.length || endpoint.methods.some((method) => !/^[A-Z]+$/.test(method)))
      throw new TypeError(`Pack ${packId}: endpoint ${endpoint.id} needs upper-case methods`);
    if (!/^\^\\\/__sim\\\//.test(endpoint.pattern.source))
      throw new TypeError(`Pack ${packId}: endpoint ${endpoint.id} must be anchored under /__sim/`);
  }
  return endpoints;
}

/** Endpoints of the given packs, tagged with their pack id. */
export function packEndpoints(packs = []) {
  return packs.flatMap((pack) => validateEndpoints(pack.id, pack.endpoints).map((endpoint) => ({ ...endpoint, packId: pack.id })));
}

// Shell conventions packs declare for the portals they serve, for example the
// CSS class of the footer logo container that shell capture records and Liquid
// rendering reconciles. Without a registered class that capture is off. A pack
// also names the web template whose JSON lists the header notifications
// (headerNotificationQuery); rendering reproduces observed header notifications
// only with a named template that the export contains. The template owns audience
// rules and returns { notifications: [{ notificationText, severity, visible }] };
// severity is a Bootstrap alert kind and visible is an explicit boolean.
const footerLogos = legacy.footerLogos;
const notificationQueries = legacy.notificationQueries;
const claim = (map, value, packId, field) => {
  const owner = map.get(value);
  if (owner !== undefined && owner !== packId) throw new Error(`Ambiguous shell registration for ${field}:${value} in packs ${owner} and ${packId}`);
  map.set(value, packId);
};

export function registerShellConventions(packId, conventions) {
  if (conventions == null) return;
  const className = conventions.footerLogoClass;
  if (className != null) {
    if (typeof className !== "string" || !/^[A-Za-z_][\w-]*$/.test(className))
      throw new TypeError(`Pack ${packId}: shell.footerLogoClass must be a CSS class name`);
    claim(footerLogos, className, packId, 'footerLogoClass');
  }
  const query = conventions.headerNotificationQuery;
  if (query != null) {
    if (typeof query !== "string" || !query.trim() || query.length > 256)
      throw new TypeError(`Pack ${packId}: shell.headerNotificationQuery must name a web template`);
    claim(notificationQueries, query, packId, 'headerNotificationQuery');
  }
}

/** Registered footer logo container classes. */
export function footerLogoClasses() {
  return keysOf('footerLogos');
}

/** Web template names that packs declare as the query behind observed header notifications. */
export function headerNotificationQueries() {
  return keysOf('notificationQueries');
}
