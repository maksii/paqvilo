// OpenAPI source consistency only. No schema expansion, remote loading or request execution.
import { unencryptedTarget } from './flow-source-common.mjs';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const methods = new Set(['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace']);
const namedMaps = new Set([
  'properties',
  'schemas',
  'definitions',
  '$defs',
  'patternProperties',
  'responses',
  'paths',
  'headers',
  'content',
  'securityDefinitions',
  'securitySchemes',
]);

function resolves(document, reference) {
  if (!reference.startsWith('#')) return null;
  let pointer;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return false;
  }
  if (pointer === '') return true;
  if (!pointer.startsWith('/')) return null;
  let at = document;
  for (const key of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(key)) return false;
    const name = key.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!at || typeof at !== 'object' || !Object.hasOwn(at, name)) return false;
    at = at[name];
  }
  return true;
}

function security(requirements, schemes, emit, at) {
  if (!Array.isArray(requirements)) return;
  for (const requirement of requirements) {
    if (!object(requirement)) continue;
    const unknown = Object.keys(requirement).find((name) => !Object.hasOwn(schemes, name));
    if (unknown !== undefined) emit('CONN-SEC-001', at(requirement, unknown), 'security');
  }
}

function inspectOperation(operation, operations, schemes, emit, at, here, responsesRequired) {
  if (
    !object(operation) ||
    ((responsesRequired || Object.hasOwn(operation, 'responses')) && !object(operation.responses))
  ) {
    emit('CONN-SOURCE-001', object(operation) ? at(operation, 'responses') : here(), 'responses');
    return;
  }
  const id = operation.operationId;
  if (typeof id !== 'string' || !id.trim()) emit('CONN-OP-002', at(operation, 'operationId'), 'operationId');
  else if (operations.has(id)) emit('CONN-OP-001', at(operation, 'operationId'), 'operationId');
  else operations.add(id);
  security(operation.security, schemes, emit, at);
  if (Array.isArray(operation.security) && operation.security.length === 0)
    emit('CONN-SEC-002', at(operation, 'security'), 'security');
}

function inspectOperations(document, emit, at, responsesRequired) {
  const operations = new Set();
  const schemes = document.securityDefinitions ?? document.components?.securitySchemes ?? {};
  security(document.security, object(schemes) ? schemes : {}, emit, at);
  for (const [route, item] of Object.entries(document.paths)) {
    if (route.startsWith('x-')) continue;
    if (!route.startsWith('/') || !object(item)) {
      emit('CONN-SOURCE-001', at(document.paths, route), 'paths');
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      inspectOperation(
        operation,
        operations,
        object(schemes) ? schemes : {},
        emit,
        at,
        () => at(item, method),
        responsesRequired,
      );
    }
  }
}

function inspectNode(document, node, emit, at, changedResource) {
  let external = false;
  if (Object.hasOwn(node, '$dynamicRef')) {
    emit('CONN-REF-002', at(node, '$dynamicRef'), '$ref');
    external = true;
  }
  if (Object.hasOwn(node, '$ref') && typeof node.$ref !== 'string') emit('CONN-REF-001', at(node, '$ref'), '$ref');
  if (typeof node.$ref === 'string') {
    const result = changedResource ? null : resolves(document, node.$ref);
    if (result === false) emit('CONN-REF-001', at(node, '$ref'), '$ref');
    if (result === null) emit('CONN-REF-002', at(node, '$ref'), '$ref');
    external = result === null || external;
  }
  if (node.in === 'path' && node.required === false) emit('CONN-PARAM-001', at(node, 'required'), 'required');
  return external;
}

function inspectReferences(document, source, emit, limited, at) {
  const pending = [{ node: document, depth: 0, namedMap: false, changedResource: false }];
  let nodes = 0;
  let external = false;
  while (pending.length) {
    const { node, depth, namedMap, changedResource } = pending.pop();
    if (++nodes > 100000 || depth > 64) {
      emit('FLOW-SOURCE-003', source);
      limited.push({ file: source.file, reason: 'connector-schema-budget' });
      return;
    }
    if (node === null || typeof node !== 'object') continue;
    const resource = changedResource || (node !== document && typeof node.$id === 'string');
    const unresolvedExternal = !namedMap && inspectNode(document, node, emit, at, resource);
    external = unresolvedExternal || external;
    for (const [key, member] of Object.entries(node)) {
      if (!namedMap && ['example', 'examples', 'default', 'enum'].includes(key)) continue;
      pending.push({
        node: member,
        depth: depth + 1,
        namedMap: !namedMap && namedMaps.has(key),
        changedResource: resource,
      });
    }
  }
  if (external) limited.push({ file: source.file, reason: 'connector-context-reference-not-resolved' });
}

function connectorDialect(document) {
  if (document.swagger === '2.0' && document.openapi === undefined) return 'legacy';
  if (document.swagger !== undefined || typeof document.openapi !== 'string') return 'unsupported';
  if (/^3\.0\.\d+$/.test(document.openapi)) return 'legacy';
  if (/^3\.1\.\d+$/.test(document.openapi)) return 'optional';
  // 3.2 keeps these fields optional but adds operation forms this adapter does not inspect.
  if (/^3\.2\.\d+$/.test(document.openapi)) return 'partial';
  return 'unsupported';
}

function inspectConnectorStructure(document, source, emit, limited, dialect, at) {
  const hasPaths = Object.hasOwn(document, 'paths');
  if ((hasPaths || dialect === 'legacy') && !object(document.paths))
    emit('CONN-SOURCE-001', at(document, 'paths'), 'paths');
  if (dialect === 'legacy') return;
  for (const key of ['components', 'webhooks'])
    if (Object.hasOwn(document, key) && !object(document[key])) emit('CONN-SOURCE-001', at(document, key), key);
  if (!hasPaths || Object.hasOwn(document, 'webhooks')) {
    emit('CONN-SOURCE-002', source);
    limited.push({ file: source.file, reason: 'connector-operation-forms-not-inspected' });
  }
  if (!['paths', 'components', 'webhooks'].some((key) => Object.hasOwn(document, key)))
    emit('CONN-SOURCE-001', at(document, 'paths'), 'paths');
}

export function inspectConnectorSource(document, source, emit, limited, at) {
  const dialect = connectorDialect(document);
  if (dialect === 'unsupported' || dialect === 'partial') {
    emit('CONN-SOURCE-002', source);
    limited.push({ file: source.file, reason: 'connector-version-not-fully-supported' });
    if (dialect === 'unsupported') return;
  }
  inspectConnectorStructure(document, source, emit, limited, dialect, at);
  if (object(document.paths)) inspectOperations(document, emit, at, dialect === 'legacy');
  inspectReferences(document, source, emit, limited, at);
  if (
    Array.isArray(document.schemes) &&
    document.schemes.length > 0 &&
    document.schemes.every((scheme) => scheme === 'http') &&
    (typeof document.host !== 'string' || unencryptedTarget(`http://${document.host}`))
  )
    emit('CONN-SEC-003', at(document, 'schemes'), 'schemes');
  const server = Array.isArray(document.servers)
    ? document.servers.find((item) => unencryptedTarget(item?.url))
    : undefined;
  if (server !== undefined) emit('CONN-SEC-003', at(server, 'url'), 'servers');
}
