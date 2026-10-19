// Operation registry for extension-defined Web API functions and actions. Pure: it stores and finds definitions;
// the router in dataverse-api.mjs calls handle(ctx) for the one it finds.

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(["function", "action"]);
const BINDINGS = new Set(["unbound", "entity", "collection"]);

export function createOperationRegistry() {
  const operations = [];
  return {
    register(op) {
      if (!NAME.test(op?.name ?? "")) throw new Error(`Operation name must be a Dataverse identifier: ${op?.name}`);
      if (!KINDS.has(op.kind)) throw new Error(`Operation ${op.name} kind must be function or action.`);
      if (!BINDINGS.has(op.binding)) throw new Error(`Operation ${op.name} binding must be unbound, entity or collection.`);
      if (op.binding !== "unbound" && typeof op.entity !== "string") throw new Error(`Operation ${op.name} needs an entity logical name or '*'.`);
      if (typeof op.handle !== "function") throw new Error(`Operation ${op.name} needs a handle(ctx) function.`);
      const entity = op.binding === "unbound" ? undefined : op.entity;
      if (operations.some((item) => item.name === op.name && item.kind === op.kind && item.binding === op.binding && item.entity === entity)) {
        throw new Error(`Operation ${op.name} is already registered for this kind and binding.`);
      }
      operations.push({ name: op.name, kind: op.kind, binding: op.binding, entity, handle: op.handle, csdl: op.csdl ?? null });
    },
    // Exact entity first, then the '*' wildcard. Unbound operations ignore the entity.
    find({ name, kind, binding, entity }) {
      const matches = operations.filter((op) => op.name === name && op.kind === kind && op.binding === binding);
      if (binding === "unbound") return matches[0] ?? null;
      return matches.find((op) => op.entity === entity) ?? matches.find((op) => op.entity === "*") ?? null;
    },
    // True for a name registered under any kind, binding or entity.
    has: (name) => operations.some((op) => op.name === name),
    csdlFragments: () => operations.map((op) => op.csdl).filter(Boolean).join("\n"),
  };
}
