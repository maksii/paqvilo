// @test-kind contract: Owned offline source rules check supplied definitions, not native service behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFlows, flowRules } from '../lense/analysis/flow-rules.mjs';

const entry = (file, value) => ({ file, text: typeof value === 'string' ? value : JSON.stringify(value) });
const definition = (actions = {}) => ({ triggers: { manual: { type: 'Request', kind: 'Button' } }, actions });
const scope = (actions) => ({ type: 'Scope', actions, runAfter: {} });
const compose = (inputs, runAfter = {}) => ({ type: 'Compose', inputs, runAfter });
const connectorAction = (connectionName = 'invented') => ({
  type: 'OpenApiConnection',
  inputs: {
    host: {
      apiId: '/providers/Microsoft.PowerApps/apis/shared_invented',
      operationId: 'Get',
      connectionName,
    },
  },
  runAfter: {},
});
const swagger = (paths = {}) => ({ swagger: '2.0', info: { title: 'Invented', version: '1' }, paths });
function review(entries) {
  const findings = [];
  const coverage = analyzeFlows(entries, (id, source, field) => {
    const rule = flowRules.find((candidate) => candidate.id === id);
    assert.ok(rule, id);
    findings.push({ ruleId: id, file: source.file, field, message: rule.message, remediation: rule.remediation });
  });
  return { ids: findings.map((item) => item.ruleId), findings, coverage };
}

test('well-formed exported flow wrappers and non-flow data do not become findings', () => {
  const result = review([
    entry('Workflows/one.json', {
      properties: {
        definition: definition({
          First: compose('hello'),
          Next: compose("@outputs('First')", { First: ['Succeeded'] }),
        }),
      },
    }),
    entry('Workflows/two.json', { clientdata: JSON.stringify({ properties: { definition: definition() } }) }),
    entry('settings.json', { arbitrary: true }),
    entry('other-settings.json', { definition: { type: 'business' }, triggers: {} }),
  ]);
  assert.deepEqual(result.ids, []);
  assert.equal(result.coverage.flows, 2);
});

test('malformed recognized sources are errors while missing definition metadata is incomplete', () => {
  const result = review([
    entry('Workflows/broken.json', '{'),
    entry('modernflows/other/definition.yaml', 'definition: ['),
    entry('Workflows/partial.json', { name: 'not printed' }),
    entry('connectors/apiDefinition.json', '{'),
  ]);
  assert.equal(result.ids.filter((id) => id === 'FLOW-SOURCE-001').length, 2);
  assert.ok(result.ids.includes('CONN-SOURCE-001'));
  assert.ok(result.ids.includes('FLOW-SOURCE-002'));
  assert.deepEqual(result.coverage.limited, [
    { file: 'Workflows/broken.json', reason: 'source-syntax-invalid' },
    { file: 'modernflows/other/definition.yaml', reason: 'source-syntax-invalid' },
    { file: 'Workflows/partial.json', reason: 'flow-definition-unrecognized' },
    { file: 'connectors/apiDefinition.json', reason: 'source-syntax-invalid' },
  ]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.domains.find((domain) => domain.domain === 'flows').complete, false);
});

test('modern flow YAML is inspected without alias expansion', () => {
  const valid = review([
    entry(
      'modernflows/invented/definition.yaml',
      'definition:\n  triggers:\n    manual:\n      type: Request\n      kind: Button\n  actions: {}\n',
    ),
  ]);
  assert.equal(valid.coverage.flows, 1);
  assert.deepEqual(valid.ids, []);
  const aliases = review([
    entry(
      'modernflows/invented/a.yaml',
      'base: &a { type: Compose }\ndefinition:\n  triggers: {}\n  actions: { copy: *a }',
    ),
  ]);
  assert.ok(aliases.ids.includes('FLOW-SOURCE-002'));
  assert.ok(!aliases.ids.includes('FLOW-SOURCE-001'));
  assert.equal(aliases.coverage.complete, false);
  const customTag = review([
    entry('modernflows/custom/definition.yaml', 'definition: !unresolved {triggers: {}, actions: {}}'),
  ]);
  assert.ok(customTag.ids.includes('FLOW-SOURCE-002'));
  assert.ok(!customTag.ids.includes('FLOW-SOURCE-001'));
});

test('runAfter is confined to each nested sibling scope and cycles are errors', () => {
  const result = review([
    entry(
      'Workflows/graph.json',
      definition({
        A: compose('a', { B: ['Succeeded'] }),
        B: compose('b', { A: ['Succeeded'] }),
        Missing: compose('x', { Elsewhere: ['Succeeded'] }),
        Bad: compose('x', { A: ['Whatever'] }),
        Nested: scope({ Child: compose('x', { A: ['Succeeded'] }) }),
      }),
    ),
  ]);
  assert.ok(result.ids.includes('FLOW-GRAPH-002'));
  assert.equal(result.ids.filter((id) => id === 'FLOW-GRAPH-001').length, 3);
});

test('runAfter traversal visits newly enqueued multi-hop and fan-in actions while detecting a downstream cycle', () => {
  const actions = {
    Start: compose('start'),
    Left: compose('left', { Start: ['Succeeded'] }),
    Right: compose('right', { Start: ['Succeeded'] }),
    Join: compose('joined', { Left: ['Succeeded'], Right: ['Succeeded'] }),
    Finish: compose('finished', { Join: ['Succeeded'] }),
  };
  const valid = review([entry('Workflows/graph.json', definition(actions))]);
  assert.deepEqual(valid.ids, []);
  assert.equal(valid.coverage.complete, true);
  actions.Join.runAfter.Finish = ['Succeeded'];
  const cycle = review([entry('Workflows/graph.json', definition(actions))]);
  assert.deepEqual(cycle.ids, ['FLOW-GRAPH-002']);
});

test('else, default and switch case action scopes are all traversed', () => {
  const bad = () => ({ Broken: { inputs: {} } });
  const result = review([
    entry(
      'Workflows/nested.json',
      definition({
        Condition: { type: 'If', actions: {}, else: { actions: bad() } },
        Choose: { type: 'Switch', cases: { one: { case: 1, actions: bad() } }, default: { actions: bad() } },
      }),
    ),
  ]);
  assert.equal(result.ids.filter((id) => id === 'FLOW-DEF-002').length, 3);
});

test('OpenApiConnection host declarations and supplied bindings are checked separately', () => {
  const result = review([
    entry('Workflows/connections.json', {
      properties: {
        definition: definition({
          Valid: connectorAction(),
          Unknown: connectorAction('absent'),
          Invalid: { type: 'OpenApiConnection', inputs: { host: {} } },
        }),
        connectionReferences: {
          invented: { id: '/providers/Microsoft.PowerApps/apis/shared_invented', source: 'Embedded' },
        },
      },
    }),
  ]);
  assert.equal(result.ids.filter((id) => id === 'FLOW-CONNECTION-001').length, 1);
  assert.equal(result.ids.filter((id) => id === 'FLOW-CONNECTION-002').length, 1);
  assert.ok(
    !review([entry('Workflows/partial.json', definition({ Call: connectorAction() }))]).ids.includes(
      'FLOW-CONNECTION-002',
    ),
  );
});

test('connector operation parameter shape advice is conditional and does not reject all nested objects', () => {
  const call = connectorAction();
  call.inputs.parameters = { body: { value: true } };
  assert.ok(review([entry('Workflows/body.json', definition({ Call: call }))]).ids.includes('FLOW-CONNECTION-004'));
  call.inputs.parameters = { 'body/value': true };
  assert.ok(!review([entry('Workflows/body.json', definition({ Call: call }))]).ids.includes('FLOW-CONNECTION-004'));
});

test('HTTP transport, retry defaults and invoker posture remain review findings', () => {
  const result = review([
    entry('Workflows/http.json', {
      properties: {
        definition: {
          triggers: { request: { type: 'Request', kind: 'Http' } },
          actions: {
            Call: {
              type: 'Http',
              inputs: { uri: 'http://invented.invalid/private?token=never-output', method: 'GET' },
            },
            Local: { type: 'Http', inputs: { uri: 'http://127.0.0.1:8080/check', retryPolicy: { type: 'none' } } },
            Dynamic: { type: 'Http', inputs: { uri: "@parameters('endpoint')", retryPolicy: { type: 'none' } } },
          },
        },
        connectionReferences: { invented: { source: 'Invoker' } },
      },
    }),
  ]);
  for (const id of ['FLOW-SEC-001', 'FLOW-PERF-002', 'FLOW-SEC-004', 'FLOW-CONNECTION-003'])
    assert.ok(result.ids.includes(id), id);
  assert.equal(result.ids.filter((id) => id === 'FLOW-SEC-001').length, 1);
  assert.ok(!JSON.stringify(result.findings).includes('never-output'));
});

test('expression delimiters and literal action identities work with inline interpolation and escaped quotes', () => {
  const result = review([
    entry(
      'Workflows/expressions.json',
      definition({
        First: compose('okay'),
        LiteralInsideExpression: compose("@concat('@{', 'literal')"),
        Valid: compose("prefix @{concat('it''s', body('First'))}"),
        Missing: compose("@outputs('absent')"),
        Broken: compose("@concat('unterminated)"),
        BusinessDescription: compose({ description: "@concat('unterminated)" }),
        Literal: compose("@@{not_an_expression('}"),
        Description: { ...compose('fine'), description: "@'not expression" },
      }),
    ),
  ]);
  assert.equal(result.ids.filter((id) => id === 'FLOW-EXPR-001').length, 2);
  assert.equal(result.ids.filter((id) => id === 'FLOW-EXPR-002').length, 1);
});

test('heuristic action complexity and implicit loop concurrency are hints, not platform caps', () => {
  const actions = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`Action${index}`, compose(index)]));
  actions.Each = { type: 'Foreach', foreach: "@triggerBody()?['values']", actions: {} };
  const result = review([entry('Workflows/complex.json', definition(actions))]);
  assert.ok(result.ids.includes('FLOW-PERF-001'));
  assert.ok(result.ids.includes('FLOW-PERF-003'));
  assert.equal(flowRules.find((rule) => rule.id === 'FLOW-PERF-001').severity, 'hint');
});

test('local and recursive OpenAPI references are resolved without expansion; external references are explicit', () => {
  const doc = {
    ...swagger({
      '/invented': { get: { operationId: 'Read', responses: { 200: { schema: { $ref: '#/definitions/Item' } } } } },
    }),
    definitions: {
      Item: { type: 'object', properties: { next: { $ref: '#/definitions/Item' } } },
      External: { $ref: 'https://invented.invalid/schema.json' },
      Missing: { $ref: '#/definitions/NoSuch' },
      Escaped: { $ref: '#/definitions/a~1b' },
      'a/b': { type: 'string' },
      BadEscape: { $ref: '#/definitions/a~2b' },
    },
  };
  const result = review([entry('connectors/apiDefinition.swagger.json', doc)]);
  assert.equal(result.coverage.connectors, 1);
  assert.equal(result.ids.filter((id) => id === 'CONN-REF-001').length, 2);
  assert.equal(result.ids.filter((id) => id === 'CONN-REF-002').length, 1);
});

test('connector operations, security schemes and required path parameters get distinct source diagnostics', () => {
  const doc = swagger({
    '/one': { get: { operationId: 'Same', responses: {}, security: [{ missing: [] }] } },
    '/two': {
      post: {
        operationId: 'Same',
        responses: {},
        security: [],
        parameters: [{ in: 'path', name: 'id', required: false }],
      },
    },
  });
  doc.schemes = ['http'];
  const result = review([entry('customconnectors/test.json', doc)]);
  for (const id of ['CONN-OP-001', 'CONN-SEC-001', 'CONN-SEC-002', 'CONN-PARAM-001', 'CONN-SEC-003'])
    assert.ok(result.ids.includes(id), id);
});

test('OpenAPI examples containing business $ref data are not interpreted as schema references', () => {
  const doc = swagger({
    '/one': { get: { operationId: 'One', responses: { 200: { examples: { json: { $ref: 'business-data' } } } } } },
  });
  assert.deepEqual(review([entry('api.swagger.json', doc)]).ids, []);
});

// OAS 3.1.1/3.2.0 Operation Objects make responses optional; Swagger 2.0/OAS 3.0.4 require it.
// https://spec.openapis.org/oas/v3.1.1.html#operation-object
// https://spec.openapis.org/oas/v3.2.0.html#operation-object
test('connector operation response requiredness follows the declared OpenAPI feature version', () => {
  const paths = { '/invented': { get: { operationId: 'ReadInvented' } } };
  for (const version of ['3.1.0', '3.1.1', '3.1.12']) {
    const result = review([entry('openapi.json', { openapi: version, paths })]);
    assert.deepEqual(result.ids, []);
    assert.equal(result.coverage.complete, true);
  }
  for (const document of [swagger(paths), { openapi: '3.0.4', paths }])
    assert.ok(review([entry('openapi.json', document)]).ids.includes('CONN-SOURCE-001'));
  for (const responses of [null, [], 'PRIVATE-RESPONSE-SHAPE']) {
    const result = review([
      entry('openapi.json', {
        openapi: '3.1.1',
        paths: { '/invented': { get: { operationId: 'ReadInvented', responses } } },
      }),
    ]);
    assert.ok(result.ids.includes('CONN-SOURCE-001'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-RESPONSE-SHAPE/);
  }
});

// https://spec.openapis.org/oas/v3.1.1.html#openapi-object permits components/webhooks without paths.
test('valid non-path OpenAPI forms retain explicit partial coverage instead of false syntax errors', () => {
  for (const extra of [
    { components: { schemas: { Invented: { type: 'string' } } } },
    { webhooks: { Invented: { post: { operationId: 'ReceiveInvented' } } } },
    { paths: {}, webhooks: {} },
  ]) {
    const result = review([entry('openapi.json', { openapi: '3.1.1', ...extra })]);
    assert.ok(!result.ids.includes('CONN-SOURCE-001'));
    assert.ok(result.ids.includes('CONN-SOURCE-002'));
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.domains.find((domain) => domain.domain === 'connectors').complete, false);
  }
  for (const document of [swagger(), { openapi: '3.0.4' }]) {
    delete document.paths;
    assert.ok(review([entry('openapi.json', document)]).ids.includes('CONN-SOURCE-001'));
  }
  for (const extra of [{ paths: null }, { paths: [] }, { components: [] }, { webhooks: null }, {}])
    assert.ok(review([entry('openapi.json', { openapi: '3.1.1', ...extra })]).ids.includes('CONN-SOURCE-001'));
});

test('unknown or partially supported OpenAPI feature versions cannot certify complete source inspection', () => {
  for (const openapi of ['3.2.0', '3.2.1', '3.3.0', '4.0.0', 'PRIVATE-UNKNOWN-VERSION']) {
    const result = review([
      entry('openapi.json', { openapi, paths: { '/invented': { get: { operationId: 'ReadInvented' } } } }),
    ]);
    assert.ok(!result.ids.includes('CONN-SOURCE-001'));
    assert.ok(result.ids.includes('CONN-SOURCE-002'));
    assert.equal(result.coverage.complete, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-UNKNOWN-VERSION/);
  }
});

test('schema properties and default responses named like data keywords still receive reference checks', () => {
  const doc = swagger({
    '/one': {
      get: {
        operationId: 'One',
        responses: {
          default: { schema: { $ref: '#/definitions/MissingResponse' } },
        },
      },
    },
  });
  doc.definitions = {
    Item: { properties: { default: { $ref: '#/definitions/MissingField' }, $ref: { type: 'string' } } },
  };
  const result = review([entry('api.swagger.json', doc)]);
  assert.equal(result.ids.filter((id) => id === 'CONN-REF-001').length, 2);
  doc.host = 'localhost:8080';
  doc.schemes = ['http'];
  assert.ok(!review([entry('api.swagger.json', doc)]).ids.includes('CONN-SEC-003'));
});

test('OpenAPI YAML and invalid nested control collections receive source-specific coverage', () => {
  const result = review([
    entry(
      'connectors/openapi.yaml',
      'openapi: 3.0.3\ninfo: {title: Invented, version: one}\npaths:\n  /one:\n    get:\n      operationId: One\n      responses: {}\n',
    ),
    entry(
      'Workflows/invalid-controls.json',
      definition({ Missing: { type: 'Scope' }, Wrong: { type: 'Switch', cases: [] } }),
    ),
  ]);
  assert.equal(result.coverage.connectors, 1);
  assert.equal(result.ids.filter((id) => id === 'FLOW-DEF-002').length, 2);
  assert.equal(result.coverage.domains.find((domain) => domain.domain === 'connectors').recognized, 1);
});

test('named and dynamic JSON Schema anchors remain unresolved instead of malformed pointer errors', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {},
    components: {
      schemas: {
        Item: { $anchor: 'item', properties: { next: { $ref: '#item' }, dynamic: { $dynamicRef: '#item' } } },
        Resource: {
          $id: 'urn:invented',
          properties: { name: { type: 'string' }, self: { $ref: '#/properties/name' } },
        },
      },
    },
  };
  const result = review([entry('openapi.json', doc)]);
  assert.ok(!result.ids.includes('CONN-REF-001'));
  assert.ok(result.ids.includes('CONN-REF-002'));
  assert.equal(result.coverage.complete, false);
});

const tool = () => ({
  name: 'invented',
  description: 'Invented tool',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {} },
});

test('MCP registration checks pair supplied source without importing it', () => {
  const result = review([
    entry('tools/invented.tool.json', tool()),
    entry('tools/invented.tool.js', 'throw new Error("Never execute this");'),
  ]);
  assert.deepEqual(result.ids, []);
  assert.equal(result.coverage.mcpTools.tools, 1);
  const absent = review([entry('tools/invented.tool.json', tool())]);
  assert.ok(absent.ids.includes('MCP-PAIR-001'));
  assert.equal(absent.coverage.limited[0].reason, 'mcp-implementation-not-supplied');
});

test('MCP annotation and closed-schema contradictions are separate from private-channel advice', () => {
  const doc = tool();
  doc.annotations.destructiveHint = true;
  doc.annotations.openWorldHint = true;
  doc.inputSchema.required = ['notDeclared'];
  doc.outputSchema.properties._meta = { type: 'object' };
  const result = review([entry('tools/invented.tool.json', doc)]);
  for (const id of ['MCP-META-002', 'MCP-META-003', 'MCP-SCHEMA-001', 'MCP-SCHEMA-002'])
    assert.ok(result.ids.includes(id), id);
  assert.ok(review([entry('tools/bad.tool.json', { ...tool(), annotations: 'invalid' })]).ids.includes('MCP-META-001'));
  assert.ok(review([entry('tools/other.tool.json', { command: 'other-host' })]).ids.includes('MCP-SOURCE-002'));
  assert.ok(review([entry('tools/bad.tool.json', '{')]).ids.includes('MCP-SOURCE-001'));
});

// @test-kind security: Credential values and executable paired modules never enter findings or execution.
test('credential-bearing inputs are redacted and malformed secure logging metadata does not throw', () => {
  const actions = {
    Literal: {
      type: 'Http',
      inputs: { uri: 'https://invented.invalid', headers: { Authorization: 'Bearer synthetic-secret-value' } },
    },
    Dynamic: {
      type: 'Http',
      inputs: { headers: { Authorization: "@parameters('secret')" } },
      runtimeConfiguration: { secureData: { properties: {} } },
    },
    Secured: {
      type: 'Http',
      inputs: { headers: { Authorization: "@parameters('secret')" } },
      runtimeConfiguration: { secureData: { properties: ['inputs', 'outputs'] } },
    },
  };
  const result = review([entry('Workflows/secret.json', definition(actions))]);
  assert.ok(result.ids.includes('FLOW-SEC-002'));
  assert.equal(result.ids.filter((id) => id === 'FLOW-SEC-003').length, 1);
  assert.ok(!JSON.stringify(result.findings).includes('synthetic-secret-value'));
});

// @test-kind security: Deep and wide attacker-controlled definitions stop at explicit local analysis budgets.
test('wide and deeply nested action trees retain incomplete coverage instead of recursion failure', () => {
  const wide = Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`A${index}`, compose(index)]));
  const result = review([entry('Workflows/wide.json', definition(wide))]);
  assert.ok(result.ids.includes('FLOW-SOURCE-003'));
  assert.ok(result.coverage.limited.length > 0);
  let nested = {};
  for (let index = 0; index < 80; index++) nested = { Child: scope(nested) };
  assert.ok(review([entry('Workflows/deep.json', definition(nested))]).ids.includes('FLOW-SOURCE-003'));
});
