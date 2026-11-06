// Source diagnostics only: no provider, workflow, project module or external reference is executed.
import YAML from 'yaml';
import { inspectFlowExpressions } from './flow-source-expressions.mjs';
import { inspectConnectorSource } from './flow-source-connectors.mjs';
import { inspectMcpTools } from './flow-source-mcp.mjs';
import { unencryptedTarget } from './flow-source-common.mjs';

const wdl = 'https://learn.microsoft.com/en-us/azure/logic-apps/workflow-definition-language-schema';
const flowGuidance = 'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/';
const connectorGuidance = 'https://learn.microsoft.com/en-us/connectors/custom-connectors/define-openapi-definition';
const rule = (id, title, severity, category, message, remediation, options = {}) => {
  const { reference = wdl, confidence = 'high' } = typeof options === 'string' ? { reference: options } : options;
  return { id, title, severity, category, confidence, message, remediation, references: [reference] };
};
export const flowRules = [
  rule(
    'FLOW-SOURCE-001',
    'Unreadable flow definition',
    'error',
    'reliability',
    'A recognized workflow source cannot be parsed as its declared JSON or YAML format.',
    'Correct the source syntax and rerun analysis; parser messages and source values are deliberately withheld.',
  ),
  rule(
    'FLOW-SOURCE-002',
    'Unresolved flow source shape',
    'hint',
    'compatibility',
    'A workflow source does not expose a supported definition shape in this file.',
    'Supply the exported definition or review the source format; this file was not certified by structural flow checks.',
  ),
  rule(
    'FLOW-DEF-001',
    'Invalid definition collections',
    'error',
    'reliability',
    'A workflow definition has invalid or missing trigger/action collections.',
    'Use object-valued triggers and actions in the exported Workflow Definition Language definition.',
  ),
  rule(
    'FLOW-DEF-002',
    'Invalid action or trigger declaration',
    'error',
    'reliability',
    'An action or trigger declaration lacks a nonempty string type or has an invalid structural member.',
    'Correct the declaration and its object-valued nested action collections before deployment.',
  ),
  rule(
    'FLOW-GRAPH-001',
    'Invalid action dependency',
    'error',
    'reliability',
    'An action runAfter entry references an absent sibling or an invalid completion status.',
    'Reference existing actions in the same scope and documented completion statuses.',
  ),
  rule(
    'FLOW-GRAPH-002',
    'Cyclic action dependencies',
    'error',
    'reliability',
    'A workflow action scope contains a cycle in its runAfter dependency graph.',
    'Remove the circular dependency and explicitly order actions within their scope.',
  ),
  rule(
    'FLOW-CONNECTION-001',
    'Incomplete connector host',
    'error',
    'reliability',
    'An OpenApiConnection action or trigger has an incomplete host declaration.',
    'Restore its exported apiId, operationId and connectionName host fields.',
  ),
  rule(
    'FLOW-CONNECTION-002',
    'Unresolved connection binding',
    'warning',
    'reliability',
    'A connector host name is not present in the supplied document connection references.',
    'Reconcile the exported connection-reference key and its environment-specific deployment binding; a partial export may omit it.',
    'https://learn.microsoft.com/power-apps/maker/data-platform/create-connection-reference',
  ),
  rule(
    'FLOW-CONNECTION-003',
    'Invoker binding needs API-trigger review',
    'hint',
    'compatibility',
    'An HTTP-triggered flow includes an Invoker connection binding.',
    'Verify the actual caller token contract; API/service invocations may require a deliberately configured Embedded binding.',
    { reference: 'https://learn.microsoft.com/power-automate/service-principal-support', confidence: 'medium' },
  ),
  rule(
    'FLOW-CONNECTION-004',
    'Connector body key shape needs review',
    'hint',
    'compatibility',
    'An OpenApiConnection input uses a nested body object or an OData binding-suffixed parameter.',
    'Compare exact parameter keys with the connector operation metadata; many Power Automate operations use slash-path parameters.',
    { reference: connectorGuidance, confidence: 'medium' },
  ),
  rule(
    'FLOW-SEC-001',
    'Unencrypted literal HTTP target',
    'warning',
    'security',
    'An HTTP action uses a literal non-loopback unencrypted target.',
    'Use an authenticated HTTPS endpoint or document and verify the intentional transport boundary.',
    'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/secure-data-used-in-cloud-flows',
  ),
  rule(
    'FLOW-SEC-002',
    'Literal credential input',
    'warning',
    'security',
    'An action input contains a literal credential-bearing header or property.',
    'Replace the literal with an appropriate secret/environment binding and review secure input/output logging; no value is printed.',
    'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/use-secure-inputs-outputs-triggers',
  ),
  rule(
    'FLOW-SEC-003',
    'Credential input logging needs review',
    'warning',
    'security',
    'A credential-bearing dynamic action input has no explicit secure-input logging declaration.',
    'Review secure inputs and outputs and the secret provider; source inspection cannot establish runtime redaction.',
    {
      reference:
        'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/use-secure-inputs-outputs-triggers',
      confidence: 'medium',
    },
  ),
  rule(
    'FLOW-SEC-004',
    'HTTP trigger authorization needs verification',
    'hint',
    'security',
    'An HTTP request trigger requires separate verification of its effective authorization posture.',
    'Verify Entra/SAS/caller restrictions on the target service; an exported definition alone does not prove anonymous access.',
    {
      reference: 'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/understand-access-to-flows',
      confidence: 'medium',
    },
  ),
  rule(
    'FLOW-PERF-001',
    'Flow complexity review',
    'hint',
    'maintainability',
    'The workflow exceeds the review heuristic of fifty actions or four nested action levels.',
    'Review decomposition, observability and child-flow boundaries; these numbers are review heuristics, not platform limits.',
    { reference: flowGuidance, confidence: 'medium' },
  ),
  rule(
    'FLOW-PERF-002',
    'HTTP retry behavior needs review',
    'hint',
    'reliability',
    'An HTTP action has no explicit retry policy in the supplied source.',
    'Review the platform default and operation idempotency before choosing a retry policy; omission does not mean retries are disabled.',
    {
      reference: 'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/error-handling',
      confidence: 'medium',
    },
  ),
  rule(
    'FLOW-PERF-003',
    'Loop concurrency needs review',
    'hint',
    'performance',
    'A Foreach action relies on implicit concurrency behavior.',
    'Review ordering, shared variable writes, request limits and desired concurrency before changing the setting.',
    {
      reference: 'https://learn.microsoft.com/power-automate/guidance/coding-guidelines/implement-parallel-execution',
      confidence: 'medium',
    },
  ),
  rule(
    'FLOW-EXPR-001',
    'Unbalanced expression structure',
    'error',
    'reliability',
    'A workflow expression contains an unmatched quote, bracket or parenthesis.',
    'Correct the expression delimiters; expression values are deliberately omitted from diagnostics.',
  ),
  rule(
    'FLOW-EXPR-002',
    'Unresolved action expression reference',
    'warning',
    'reliability',
    'A literal action reference in a workflow expression is not present in the supplied definition.',
    'Check the exact action identity and scope; source analysis cannot validate dynamic action references.',
  ),
  rule(
    'FLOW-SOURCE-003',
    'Workflow analysis budget reached',
    'hint',
    'reliability',
    'A workflow source exceeds a bounded structural-analysis budget.',
    'Split or inspect the source with appropriate tooling and retain its incomplete coverage status.',
  ),
  rule(
    'CONN-SOURCE-001',
    'Invalid connector document',
    'error',
    'reliability',
    'A recognized connector source has invalid JSON or OpenAPI paths/operation structure.',
    'Correct the local OpenAPI structure and rerun the connector-specific checks.',
    connectorGuidance,
  ),
  rule(
    'CONN-SOURCE-002',
    'Connector source shape unresolved',
    'hint',
    'compatibility',
    'A recognized connector source cannot be fully interpreted by the supplied source adapter.',
    'Supply a supported bundled OpenAPI definition and retain the unresolved coverage; valid unsupported source is not a syntax error.',
    connectorGuidance,
  ),
  rule(
    'CONN-OP-001',
    'Duplicate operation identity',
    'error',
    'reliability',
    'An OpenAPI document declares a duplicate operationId.',
    'Assign unique operation identifiers and update their dependent references.',
    connectorGuidance,
  ),
  rule(
    'CONN-OP-002',
    'Missing operation identity',
    'hint',
    'compatibility',
    'An OpenAPI operation lacks a usable operationId.',
    'Declare a stable operation identifier before binding the operation to a Power Platform connector.',
    connectorGuidance,
  ),
  rule(
    'CONN-REF-001',
    'Unresolved local schema reference',
    'error',
    'reliability',
    'An OpenAPI local JSON pointer cannot be resolved in the same document.',
    'Correct its fragment encoding and target; recursive schema references are permitted and are not expanded.',
    connectorGuidance,
  ),
  rule(
    'CONN-REF-002',
    'Context-dependent connector reference not inspected',
    'hint',
    'compatibility',
    'An OpenAPI reference depends on an external resource, named anchor or dynamic context that this adapter does not resolve.',
    'Supply reviewed reference context or separately validate external/anchor resolution with provenance; a valid unsupported reference is not malformed.',
    connectorGuidance,
  ),
  rule(
    'CONN-SEC-001',
    'Undefined security scheme',
    'error',
    'security',
    'An OpenAPI security requirement names a scheme absent from the same document.',
    'Declare the referenced security scheme or correct the requirement name.',
    connectorGuidance,
  ),
  rule(
    'CONN-SEC-002',
    'Explicit public operation',
    'hint',
    'security',
    'An OpenAPI operation explicitly disables inherited authentication.',
    'Verify that public access is intentional and enforce server-side authorization for protected operations.',
    { reference: connectorGuidance, confidence: 'medium' },
  ),
  rule(
    'CONN-SEC-003',
    'Unencrypted connector server',
    'warning',
    'security',
    'An OpenAPI document explicitly advertises a non-loopback HTTP server or an HTTP-only scheme.',
    'Use HTTPS or document and validate the intended local/network transport boundary.',
    connectorGuidance,
  ),
  rule(
    'CONN-PARAM-001',
    'Optional path parameter',
    'error',
    'reliability',
    'An OpenAPI path parameter is explicitly optional.',
    'Declare path parameters required and keep optional values in the query or body.',
    connectorGuidance,
  ),
  rule(
    'MCP-SOURCE-001',
    'Invalid tool registration source',
    'error',
    'reliability',
    'A tool registration sidecar cannot be parsed as JSON.',
    'Correct the JSON registration source; no module is imported or executed.',
    'https://modelcontextprotocol.io/specification/2025-06-18/server/tools',
  ),
  rule(
    'MCP-META-001',
    'Incomplete codeful tool registration',
    'warning',
    'reliability',
    'A codeful tool sidecar has invalid identity, annotations or object-root schema declarations.',
    'Restore its name, description, four boolean annotations, and object-root input and output schemas.',
    'https://github.com/microsoft/power-platform-skills/tree/2eb182a8b7a2faa65bb2363139763291c920fbf3/plugins/mcp-apps',
  ),
  rule(
    'MCP-SOURCE-002',
    'Tool registration host unresolved',
    'hint',
    'compatibility',
    'A tool sidecar does not expose the expected codeful-tool registration shape.',
    'Select the actual host contract and validate its metadata; another valid tool format is not a malformed MCP registration.',
    'https://modelcontextprotocol.io/specification/2025-06-18/server/tools',
  ),
  rule(
    'MCP-META-002',
    'Conflicting tool annotations',
    'warning',
    'security',
    'A tool declares both read-only and destructive behavior.',
    'Reconcile the hints with the implementation and enforce authorization in the tool host; annotations are not security controls.',
    'https://modelcontextprotocol.io/specification/2025-06-18/server/tools',
  ),
  rule(
    'MCP-META-003',
    'Tool host boundary needs review',
    'hint',
    'compatibility',
    'A codeful tool declares an open-world capability unlike the constrained generated runtime.',
    'Verify the actual host contract and network boundary rather than treating a registration hint as runtime enforcement.',
    {
      reference:
        'https://github.com/microsoft/power-platform-skills/tree/2eb182a8b7a2faa65bb2363139763291c920fbf3/plugins/mcp-apps',
      confidence: 'medium',
    },
  ),
  rule(
    'MCP-PAIR-001',
    'Tool implementation not supplied',
    'hint',
    'reliability',
    'A codeful tool registration has no matching supplied JavaScript sidecar.',
    'Supply the same-root matching tool implementation or retain the incomplete paired-source coverage; no code is loaded.',
    'https://github.com/microsoft/power-platform-skills/tree/2eb182a8b7a2faa65bb2363139763291c920fbf3/plugins/mcp-apps',
  ),
  rule(
    'MCP-SCHEMA-001',
    'Unsatisfiable closed input schema',
    'error',
    'reliability',
    'A closed object schema requires a property that its own property declarations cannot admit.',
    'Align required properties with the closed input schema or deliberately permit the additional property.',
    'https://json-schema.org/understanding-json-schema/reference/object',
  ),
  rule(
    'MCP-SCHEMA-002',
    'Private result channel needs review',
    'hint',
    'security',
    'A model-visible output schema declares a private metadata channel.',
    'Verify that private widget data stays in the host metadata channel and is not accidentally included in model-visible structured content.',
    {
      reference:
        'https://github.com/microsoft/power-platform-skills/tree/2eb182a8b7a2faa65bb2363139763291c920fbf3/plugins/mcp-apps',
      confidence: 'medium',
    },
  ),
];

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim() !== '';
const flowPath =
  /(?:^|\/)(?:workflows|modernflows)\/|(?:^|\/)(?:flow|workflow|definition)(?:\.[^.]+)?\.json$|\.flow\.json$/i;
const connectorPaths = [
  /(?:^|\/)(?:connectors|customconnectors)\//i,
  /(?:^|\/)(?:apiDefinition|openapi|swagger)(?:\.swagger)?\.(?:json|ya?ml)$/i,
  /\.swagger\.(?:json|ya?ml)$/i,
];
const jsonFile = /\.json$/i;
const sourceAt = (entry) => ({ ...entry, exactLocation: false });
const status = new Set(['Succeeded', 'Failed', 'Skipped', 'TimedOut']);
const actionLimit = 10000;
const nodeLimit = 100000;
const unresolvedSource = Symbol('unresolved source conversion');

function yamlData(document, entry, emit, ruleId) {
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    emit(ruleId === 'CONN-SOURCE-001' ? 'CONN-SOURCE-002' : 'FLOW-SOURCE-002', sourceAt(entry));
    return unresolvedSource;
  }
}

function parseSource(entry, emit, ruleId = 'FLOW-SOURCE-001') {
  try {
    if (jsonFile.test(entry.file)) return JSON.parse(entry.text);
    const document = YAML.parseDocument(entry.text, { uniqueKeys: true });
    if (document.errors.length) throw new Error('YAML syntax');
    if (document.warnings.length) {
      emit(ruleId === 'CONN-SOURCE-001' ? 'CONN-SOURCE-002' : 'FLOW-SOURCE-002', sourceAt(entry));
      return unresolvedSource;
    }
    return yamlData(document, entry, emit, ruleId);
  } catch {
    emit(ruleId, sourceAt(entry));
    return undefined;
  }
}

function unwrapFlow(document) {
  for (let depth = 0; depth < 64 && object(document); depth++) {
    const client = Object.entries(document).find(([key]) => key.toLowerCase() === 'clientdata')?.[1];
    if (typeof client === 'string') {
      document = JSON.parse(client);
      continue;
    }
    if (object(client)) {
      document = client;
      continue;
    }
    const definition = document.properties?.definition ?? document.definition ?? document;
    if (!object(definition) || (!Object.hasOwn(definition, 'triggers') && !Object.hasOwn(definition, 'actions')))
      return null;
    return { definition, references: document.properties?.connectionReferences ?? document.connectionReferences };
  }
  return null;
}

function invalidAfter(action, actions) {
  if (action.runAfter === undefined) return false;
  if (!object(action.runAfter)) return true;
  return Object.entries(action.runAfter).some(
    ([name, states]) =>
      !Object.hasOwn(actions, name) ||
      !Array.isArray(states) ||
      states.length === 0 ||
      states.some((value) => !status.has(value)),
  );
}

function dependencyGraph(actions) {
  const degree = new Map(Object.keys(actions).map((name) => [name, 0]));
  const next = new Map();
  for (const [name, action] of Object.entries(actions)) {
    for (const parent of Object.keys(object(action?.runAfter) ? action.runAfter : {})) {
      if (!degree.has(parent)) continue;
      degree.set(name, degree.get(name) + 1);
      if (!next.has(parent)) next.set(parent, []);
      next.get(parent).push(name);
    }
  }
  return { degree, next };
}

function cyclic(actions) {
  const { degree, next } = dependencyGraph(actions);
  const queue = [...degree].filter(([, value]) => value === 0).map(([name]) => name);
  for (const parent of queue) {
    for (const name of next.get(parent) ?? []) {
      degree.set(name, degree.get(name) - 1);
      if (degree.get(name) === 0) queue.push(name);
    }
  }
  return queue.length !== degree.size;
}

function nestedScopes(action) {
  const scopes = [];
  if (Object.hasOwn(action, 'actions')) scopes.push(action.actions);
  if (Object.hasOwn(action.else ?? {}, 'actions')) scopes.push(action.else.actions);
  if (Object.hasOwn(action.default ?? {}, 'actions')) scopes.push(action.default.actions);
  if (object(action.cases))
    for (const branch of Object.values(action.cases))
      if (Object.hasOwn(branch ?? {}, 'actions')) scopes.push(branch.actions);
  return scopes;
}

function validNestedShape(action) {
  if (['Scope', 'Foreach', 'Until', 'If'].includes(action.type) && !object(action.actions)) return false;
  if (action.type === 'If' && Object.hasOwn(action, 'else') && !object(action.else?.actions)) return false;
  if (action.type !== 'Switch') return true;
  if (!object(action.cases)) return false;
  if (Object.values(action.cases).some((branch) => !object(branch?.actions))) return false;
  return !Object.hasOwn(action, 'default') || object(action.default?.actions);
}

function connectorHost(action, references, source, emit) {
  if (!['OpenApiConnection', 'OpenApiConnectionWebhook'].includes(action.type)) return;
  const host = action.inputs?.host;
  if (!object(host) || !['apiId', 'operationId', 'connectionName'].every((key) => nonempty(host[key]))) {
    emit('FLOW-CONNECTION-001', source, 'host');
    return;
  }
  if (object(references) && !Object.hasOwn(references, host.connectionName))
    emit('FLOW-CONNECTION-002', source, 'connectionReferences');
  const parameters = action.inputs?.parameters;
  if (
    object(parameters) &&
    (object(parameters.body) || Object.keys(parameters).some((key) => key.endsWith('@odata.bind')))
  )
    emit('FLOW-CONNECTION-004', source, 'parameters');
}

function credentialMember(action, key, member, source, emit) {
  if (
    !/^(?:authorization|password|clientsecret|client_secret|access_token|apikey|api-key)$/i.test(key) ||
    !nonempty(member)
  )
    return;
  if (!member.startsWith('@')) {
    emit('FLOW-SEC-002', source, 'inputs');
    return;
  }
  const secured = action.runtimeConfiguration?.secureData?.properties;
  if (!Array.isArray(secured) || !secured.includes('inputs')) emit('FLOW-SEC-003', source, 'runtimeConfiguration');
}

function credentialInputs(action, source, emit) {
  const pending = [{ value: action.inputs, depth: 0 }];
  let count = 0;
  while (pending.length && count++ < nodeLimit) {
    const { value, depth } = pending.pop();
    if (!object(value) || depth > 64) continue;
    for (const [key, member] of Object.entries(value)) {
      if (object(member)) pending.push({ value: member, depth: depth + 1 });
      credentialMember(action, key, member, source, emit);
    }
  }
}

function inspectAction(action, references, source, emit) {
  if (!object(action) || !nonempty(action.type)) {
    emit('FLOW-DEF-002', source, 'type');
    return false;
  }
  if (!validNestedShape(action)) emit('FLOW-DEF-002', source, 'actions');
  connectorHost(action, references, source, emit);
  credentialInputs(action, source, emit);
  if (action.type === 'Http') {
    if (unencryptedTarget(action.inputs?.uri)) emit('FLOW-SEC-001', source, 'uri');
    if (!Object.hasOwn(action.inputs ?? {}, 'retryPolicy')) emit('FLOW-PERF-002', source, 'retryPolicy');
  }
  if (action.type === 'Foreach' && !Object.hasOwn(action.runtimeConfiguration ?? {}, 'concurrency'))
    emit('FLOW-PERF-003', source, 'runtimeConfiguration');
  return true;
}

function inspectTriggers(definition, references, source, emit) {
  for (const trigger of Object.values(definition.triggers)) {
    inspectAction(trigger, references, source, emit);
    if (trigger?.type !== 'Request' || trigger.kind !== 'Http') continue;
    emit('FLOW-SEC-004', source, 'triggers');
    if (object(references) && Object.values(references).some((value) => value?.source === 'Invoker'))
      emit('FLOW-CONNECTION-003', source, 'connectionReferences');
  }
}

function inspectActionScope(actions, names, context) {
  const { references, source, emit } = context,
    children = [];
  if (cyclic(actions)) emit('FLOW-GRAPH-002', source, 'runAfter');
  for (const [name, action] of Object.entries(actions)) {
    names.add(name);
    if (!inspectAction(action, references, source, emit)) continue;
    if (invalidAfter(action, actions)) emit('FLOW-GRAPH-001', source, 'runAfter');
    children.push(...nestedScopes(action));
  }
  return children;
}

function collectActions(definition, references, source, emit, limited) {
  const pending = [{ actions: definition.actions, depth: 0 }],
    names = new Set();
  let count = 0,
    maxDepth = 0;
  while (pending.length) {
    const { actions, depth } = pending.pop();
    if (!object(actions)) {
      emit('FLOW-DEF-002', source, 'actions');
      continue;
    }
    if (depth > 64 || count + Object.keys(actions).length > actionLimit) {
      emit('FLOW-SOURCE-003', source);
      limited.push({ file: source.file, reason: 'flow-action-budget' });
      break;
    }
    maxDepth = Math.max(maxDepth, depth);
    count += Object.keys(actions).length;
    for (const child of inspectActionScope(actions, names, { references, source, emit }))
      pending.push({ actions: child, depth: depth + 1 });
  }
  if (count > 50 || maxDepth > 4) emit('FLOW-PERF-001', source, 'actions');
  return names;
}

function inspectFlow(document, entry, emit, limited) {
  let flow;
  try {
    flow = unwrapFlow(document);
  } catch {
    emit('FLOW-SOURCE-001', sourceAt(entry));
    return false;
  }
  if (!flow) {
    emit('FLOW-SOURCE-002', sourceAt(entry));
    limited.push({ file: entry.file, reason: 'flow-definition-unrecognized' });
    return false;
  }
  const { definition, references } = flow,
    source = sourceAt(entry);
  if (!object(definition.triggers) || !object(definition.actions)) {
    emit('FLOW-DEF-001', source);
    return true;
  }
  inspectTriggers(definition, references, source, emit);
  const names = collectActions(definition, references, source, emit, limited);
  inspectFlowExpressions(definition, names, source, emit, limited);
  return true;
}

function sourceKind(entry) {
  const name = entry.relativeFile ?? entry.file;
  if (connectorPaths.some((pattern) => pattern.test(name))) return 'connectors';
  return flowPath.test(name) ? 'flows' : null;
}

function readCandidate(entry, kind, emit) {
  if (kind) return parseSource(entry, emit, kind === 'connectors' ? 'CONN-SOURCE-001' : 'FLOW-SOURCE-001');
  try {
    return JSON.parse(entry.text);
  } catch {
    return undefined;
  }
}

const connectorDocument = (document) =>
  object(document) && (document.swagger === '2.0' || typeof document.openapi === 'string');
function definitionShape(value) {
  if (!object(value)) return false;
  if (Object.hasOwn(value, 'triggers') && Object.hasOwn(value, 'actions')) return true;
  return typeof value.$schema === 'string' && value.$schema.includes('/workflowdefinition.json');
}
function flowDocument(document) {
  if (!object(document)) return false;
  return [document.definition, document.properties?.definition, document].some(definitionShape);
}

function analyzeEntry(entry, emit, coverage) {
  const kind = sourceKind(entry);
  if (!/\.(?:json|ya?ml)$/i.test(entry.file) || (!kind && !jsonFile.test(entry.file))) return;
  if (kind) coverage.sourceKinds.set(entry.file, kind);
  const document = readCandidate(entry, kind, emit);
  if (document === unresolvedSource) {
    coverage.limited.push({ file: entry.file, reason: 'source-yaml-conversion-unresolved' });
    return;
  }
  if (document === undefined) {
    if (kind) coverage.limited.push({ file: entry.file, reason: 'source-syntax-invalid' });
    return;
  }
  if (connectorDocument(document)) {
    coverage.sourceKinds.set(entry.file, 'connectors');
    coverage.files++;
    coverage.connectors++;
    inspectConnectorSource(document, sourceAt(entry), emit, coverage.limited);
    return;
  }
  if (kind === 'flows' || flowDocument(document)) {
    coverage.sourceKinds.set(entry.file, 'flows');
    coverage.files++;
    if (inspectFlow(document, entry, emit, coverage.limited)) coverage.flows++;
  } else if (kind === 'connectors') {
    emit('CONN-SOURCE-002', sourceAt(entry));
    coverage.limited.push({ file: entry.file, reason: 'connector-definition-unrecognized' });
  }
}

/** Pure review of bounded, already-confined source entries. */
export function analyzeFlows(entries, emit) {
  const coverage = {
    files: 0,
    flows: 0,
    connectors: 0,
    limited: [],
    sourceKinds: new Map(),
    notPerformed: [
      'flow-execution',
      'effective-flow-authorization',
      'connection-health',
      'external-openapi-reference-fetch',
      'openapi-anchor-and-dynamic-reference-resolution',
      'full-openapi-json-schema-validation',
      'connector-runtime-operation-validation',
      'complete-wdl-type-checking',
    ],
  };
  for (const entry of entries) analyzeEntry(entry, emit, coverage);
  coverage.mcpTools = inspectMcpTools(entries, emit);
  coverage.files += coverage.mcpTools.files;
  coverage.limited.push(...coverage.mcpTools.limited);
  coverage.notPerformed.push('mcp-tool-execution', 'mcp-implementation-dataflow', 'mcp-host-authorization');
  for (const entry of entries) if (entry.file.endsWith('.tool.json')) coverage.sourceKinds.set(entry.file, 'mcp-apps');
  coverage.domains = ['flows', 'connectors', 'mcp-apps'].map((domain) => {
    const files = new Set([...coverage.sourceKinds].filter(([, kind]) => kind === domain).map(([file]) => file));
    const limitations = coverage.limited.filter((item) => files.has(item.file));
    const recognized = domain === 'mcp-apps' ? coverage.mcpTools.tools : coverage[domain];
    return { domain, files: files.size, recognized, complete: limitations.length === 0, limitations };
  });
  coverage.complete = coverage.domains.every((domain) => domain.complete);
  coverage.files = coverage.sourceKinds.size;
  delete coverage.sourceKinds;
  return coverage;
}
