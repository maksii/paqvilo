// Extension points that data packs contribute through the preset registry.
// The runtime itself stays project-neutral: project-specific plugin
// expression operators and HTTP endpoints live in packs and are registered
// here when a pack is loaded (lib/preset-registry.mjs).

const operators = new Map();

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
  return operators.get(name)?.evaluate ?? null;
}

/** Names and packs of the registered operators (diagnostics). */
export function expressionOperators() {
  return [...operators].map(([name, { packId }]) => ({ name, packId }));
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
// only with a named template that the export contains.
const footerLogos = new Map();
const notificationQueries = new Map();

export function registerShellConventions(packId, conventions) {
  if (conventions == null) return;
  const className = conventions.footerLogoClass;
  if (className != null) {
    if (typeof className !== "string" || !/^[A-Za-z_][\w-]*$/.test(className))
      throw new TypeError(`Pack ${packId}: shell.footerLogoClass must be a CSS class name`);
    footerLogos.set(className, packId);
  }
  const query = conventions.headerNotificationQuery;
  if (query != null) {
    if (typeof query !== "string" || !query.trim() || query.length > 256)
      throw new TypeError(`Pack ${packId}: shell.headerNotificationQuery must name a web template`);
    notificationQueries.set(query, packId);
  }
}

/** Registered footer logo container classes. */
export function footerLogoClasses() {
  return [...footerLogos.keys()];
}

/** Web template names that packs declare as the query behind observed header notifications. */
export function headerNotificationQueries() {
  return [...notificationQueries.keys()];
}
