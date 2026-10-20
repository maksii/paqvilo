// Operation registry for extension-defined Web API functions and actions. Pure: it stores and finds definitions;
// the router in dataverse-api.mjs calls handle(ctx) for the one it finds.
import { platformOperationCsdl, platformCsdl } from "./dataverse-operation-contracts.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(["function", "action"]);
const BINDINGS = new Set(["unbound", "entity", "collection"]);

// The CSDL declaration of an operation that has no csdl text of its own, from its signature: { params: [[name, type]],
// response: [[property, type]] (a <Name>Response complex type), returns: type }, the shape the modules' csdlOf helpers take.
// The binding comes from the registration. An operation with no signature is still declared, with no parameters.
function declarationOf(op) {
  const tag = op.kind === "action" ? "Action" : "Function";
  const sig = op.signature ?? {};
  const table = op.entity === "*" ? "mscrm.crmbaseentity" : `mscrm.${op.entity}`;
  const bound = op.binding === "collection" ? `Collection(${table})` : op.binding === "entity" ? table : null;
  const returns = sig.response ? `mscrm.${op.name}Response` : (sig.returns ?? null);
  const complex = sig.response
    ? `<ComplexType Name="${op.name}Response">${sig.response.map(([p, t]) => `<Property Name="${p}" Type="${t}" />`).join("")}</ComplexType>`
    : null;
  const parts = bound ? [`<Parameter Name="entity" Type="${bound}" Nullable="false" />`] : [];
  for (const [param, type] of sig.params ?? []) parts.push(`<Parameter Name="${param}" Type="${type}" />`);
  if (returns) parts.push(`<ReturnType Type="${returns}" Nullable="false" />`);
  const head = `<${tag} Name="${op.name}"${bound ? ' IsBound="true"' : ""}>`;
  const body = parts.map((part) => `  ${part}`).join("\n");
  return [complex, `${head}\n${body}\n</${tag}>`].filter(Boolean).join("\n");
}

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
      // No csdl text (undefined or null): the declaration comes from the signature, so $metadata lists the operation. An empty
      // string means the CSDL is declared by another fragment (no second declaration).
      const csdl = platformOperationCsdl(op.csdl == null ? declarationOf({ ...op, entity, binding: op.binding }) : op.csdl, { ...op, entity });
      operations.push({ name: op.name, kind: op.kind, binding: op.binding, entity, handle: op.handle, csdl, ...(op.soapResult ? { soapResult: op.soapResult } : {}) });
    },
    // Exact entity first, then the '*' wildcard. Unbound operations ignore the entity.
    find({ name, kind, binding, entity }) {
      const matches = operations.filter((op) => op.name === name && op.kind === kind && op.binding === binding);
      if (binding === "unbound") return matches[0] ?? null;
      return matches.find((op) => op.entity === entity) ?? matches.find((op) => op.entity === "*") ?? null;
    },
    // True for a name registered under any kind, binding or entity.
    has: (name) => operations.some((op) => op.name === name),
    // Every distinct registered name (plug-in registration seeds one sdkmessage row per name).
    names: () => [...new Set(operations.map((op) => op.name))],
    csdlFragments: () => platformCsdl(operations.map((op) => op.csdl).filter(Boolean).join("\n")),
  };
}
