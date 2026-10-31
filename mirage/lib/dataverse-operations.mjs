// Operation registry for extension-defined Web API functions and actions. Pure: it stores and finds definitions;
// the router in dataverse-api.mjs calls handle(ctx) for the one it finds.
import { PLATFORM_OPERATIONS, platformOperationCsdl, platformCsdl } from './dataverse-operation-contracts.mjs';
import { entryMessageActive, entryParameters, runEntryMessage } from './plugin-platform-messages.mjs';
import { requestMessage } from './dataverse-sdk-message-catalogue.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KINDS = new Set(['function', 'action']);
const BINDINGS = new Set(['unbound', 'entity', 'collection']);
const ENTITY_RESPONSE_TYPES = new Set([
  'mscrm.crmbaseentity',
  'Collection(mscrm.crmbaseentity)',
  'Microsoft.Dynamics.CRM.crmbaseentity',
  'Collection(Microsoft.Dynamics.CRM.crmbaseentity)',
]);
const responseMember = ([name, type]) => {
  const tag = ENTITY_RESPONSE_TYPES.has(type) ? 'NavigationProperty' : 'Property';
  return `<${tag} Name="${name}" Type="${type}" />`;
};
const platformNames = PLATFORM_OPERATIONS.map(([, attributes]) => attributes.Name.toLowerCase());

// The CSDL declaration of an operation that has no csdl text of its own, from its signature: { params: [[name, type]],
// response: [[property, type]] (a <Name>Response complex type), returns: type }, the shape the modules' csdlOf helpers take.
// The binding comes from the registration. An operation with no signature is still declared, with no parameters.
function declarationOf(op) {
  const tag = op.kind === 'action' ? 'Action' : 'Function';
  const sig = op.signature ?? {};
  const table = op.entity === '*' ? 'mscrm.crmbaseentity' : `mscrm.${op.entity}`;
  const bound = op.binding === 'collection' ? `Collection(${table})` : op.binding === 'entity' ? table : null;
  const returns = sig.response ? `mscrm.${op.name}Response` : (sig.returns ?? null);
  const complex = sig.response
    ? `<ComplexType Name="${op.name}Response">${sig.response.map(responseMember).join('')}</ComplexType>`
    : null;
  const parts = bound ? [`<Parameter Name="entity" Type="${bound}" Nullable="false" />`] : [];
  for (const [param, type] of sig.params ?? []) parts.push(`<Parameter Name="${param}" Type="${type}" />`);
  if (returns) parts.push(`<ReturnType Type="${returns}" Nullable="false" />`);
  const head = `<${tag} Name="${op.name}"${bound ? ' IsBound="true"' : ''}>`;
  const body = parts.map((part) => `  ${part}`).join('\n');
  return [complex, `${head}\n${body}\n</${tag}>`].filter(Boolean).join('\n');
}

// A registered operation's message runs its plug-in pipeline around the operation (Web API actions and functions, and the
// SOAP requests relayed to them): Target is the bound row, the other inputs the request's values, the outputs the
// response's properties. An operation that runs its own pipeline (ownPipeline: Merge) and custom APIs (their own steps)
// call the handler directly, as does a message without a registered step for the request table.
async function runOperationMessage(store, op, context) {
  const bound = context.target?.mapping,
    boundId = context.target?.id;
  const inputs = {
    ...(boundId
      ? {
          Target: {
            $type: 'EntityReference',
            logicalName: bound.logicalName,
            id: boundId,
            name: null,
            ...(context.target.keyAttributes ? { keyAttributes: { ...context.target.keyAttributes } } : {}),
          },
        }
      : {}),
    ...entryParameters(store, op.kind === 'action' ? context.body : context.params),
  };
  // The message's primary row is its Target (a record message's Target, also of an unbound one, natively: GrantAccess,
  // RetrieveSharedPrincipalsAndAccess, Merge), else the bound table, else none.
  const subject = inputs.Target?.$type === 'EntityReference' ? inputs.Target : null;
  let response;
  await runEntryMessage(store, {
    // The request's sdkmessage (AddMembersTeam runs AddMembers, SendEmail runs Send: dataverse-sdk-message-catalogue.mjs).
    message: requestMessage(op.name),
    entity: subject?.logicalName ?? bound?.logicalName ?? 'none',
    id: subject?.id ?? boundId,
    inputs,
    context,
    main: async () => {
      response = await op.handle(context);
      const body = response?.body;
      return body && typeof body === 'object' && !Buffer.isBuffer(body) ? entryParameters(store, body) : {};
    },
  });
  return response;
}

export function createOperationRegistry({ store } = {}) {
  const operations = [];
  const providers = new Map();
  const normalize = (op) => {
    if (!NAME.test(op?.name ?? '')) throw new Error(`Operation name must be a Dataverse identifier: ${op?.name}`);
    if (!KINDS.has(op.kind)) throw new Error(`Operation ${op.name} kind must be function or action.`);
    if (!BINDINGS.has(op.binding))
      throw new Error(`Operation ${op.name} binding must be unbound, entity or collection.`);
    if (op.binding !== 'unbound' && typeof op.entity !== 'string')
      throw new Error(`Operation ${op.name} needs an entity logical name or '*'.`);
    if (typeof op.handle !== 'function') throw new Error(`Operation ${op.name} needs a handle(ctx) function.`);
    const entity = op.binding === 'unbound' ? undefined : op.entity;
    const csdl = platformOperationCsdl(
      op.csdl == null ? declarationOf({ ...op, entity, binding: op.binding }) : op.csdl,
      { ...op, entity },
    );
    return {
      name: op.name,
      kind: op.kind,
      binding: op.binding,
      entity,
      handle: store
        ? (context) =>
            !op.ownPipeline &&
            entryMessageActive(store, requestMessage(op.name), context.target?.mapping?.logicalName, context)
              ? runOperationMessage(store, op, context)
              : op.handle(context)
        : op.handle,
      // The operation's own handler (or its synchronous sdk variant), without the entry pipeline: a plug-in's SDK Execute
      // runs that pipeline itself (plugin-platform-messages.mjs executeOperationSdkMessage).
      main: op.sdk ?? op.handle,
      csdl,
      ...(op.soapResult ? { soapResult: op.soapResult } : {}),
      ...(op.ownPipeline ? { ownPipeline: true } : {}),
    };
  };
  const current = () => {
    const names = new Set([...platformNames, ...operations.map((op) => op.name.toLowerCase())]),
      dynamic = [];
    for (const provider of providers.values())
      for (const definition of provider()) {
        // Authored providers cannot replace platform registrations or declare a
        // second mutable operation under the same name.
        if (names.has(String(definition?.name).toLowerCase())) continue;
        // Row-authored metadata may be temporarily incomplete. It must remain
        // repairable through the record API instead of breaking every lookup in
        // the registry. Trusted static registrations still fail loudly in normalize.
        if (
          !NAME.test(definition?.name ?? '') ||
          !KINDS.has(definition.kind) ||
          !BINDINGS.has(definition.binding) ||
          typeof definition.handle !== 'function' ||
          (definition.binding !== 'unbound' && !NAME.test(definition.entity ?? ''))
        )
          continue;
        const op = normalize(definition);
        names.add(op.name.toLowerCase());
        dynamic.push(op);
      }
    return [...operations, ...dynamic];
  };
  return {
    register(op) {
      const normalized = normalize(op);
      if (
        operations.some(
          (item) =>
            item.name === normalized.name &&
            item.kind === normalized.kind &&
            item.binding === normalized.binding &&
            item.entity === normalized.entity,
        )
      ) {
        throw new Error(`Operation ${op.name} is already registered for this kind and binding.`);
      }
      // No csdl text (undefined or null): the declaration comes from the signature, so $metadata lists the operation. An empty
      // string means the CSDL is declared by another fragment (no second declaration).
      operations.push(normalized);
    },
    // Only explicitly installed trusted modules supply providers. Replacing a
    // provider on reseed leaves one live source of mutable operation metadata.
    setProvider(name, provider) {
      if (typeof name !== 'string' || !name || typeof provider !== 'function')
        throw new Error('An operation provider needs a name and function.');
      providers.set(name, provider);
    },
    // Exact entity first, then the '*' wildcard. Unbound operations ignore the entity.
    find({ name, kind, binding, entity }) {
      const matches = current().filter((op) => op.name === name && op.kind === kind && op.binding === binding);
      if (binding === 'unbound') return matches[0] ?? null;
      return matches.find((op) => op.entity === entity) ?? matches.find((op) => op.entity === '*') ?? null;
    },
    // True for a name registered under any kind, binding or entity.
    has: (name) => current().some((op) => op.name === name),
    // Every distinct registered name (plug-in registration seeds one sdkmessage row per name).
    names: () => [...new Set(current().map((op) => op.name))],
    csdlFragments: () =>
      platformCsdl(
        current()
          .map((op) => op.csdl)
          .filter(Boolean)
          .join('\n'),
      ),
  };
}
