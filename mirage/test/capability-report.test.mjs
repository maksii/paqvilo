import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPreflightReport, preflightExitCode, preflight } from '../lib/capability-report.mjs';
import { createCapabilityRegistry } from '../lib/capability-registry.mjs';

// A fake source graph with one requirement of every graph status and one satisfied component node.
function fakeGraph() {
  const nodes = new Map([
    [
      'layer:inventedcore',
      {
        kind: 'layer',
        id: 'layer:inventedcore',
        layer: 0,
        solution: 'InventedCore',
        version: '1.0.0.0',
        source: '/invented/core',
        format: 'xml',
        level: 'behaviour',
      },
    ],
    [
      'table:x_item',
      { kind: 'table', id: 'table:x_item', level: 'behaviour', source: '/invented/core/Entities/x_item/Entity.xml' },
    ],
  ]);
  return {
    nodes,
    fingerprint: 'f'.repeat(64),
    requirements: () => [
      {
        id: 'connectionreference:x_shared',
        kind: 'connectionreference',
        source: 'Other/Customizations.xml',
        status: 'missing',
        reason: 'SOLUTION_CONNREF_UNBOUND',
      },
      {
        id: 'environmentvariable:x_apibase',
        kind: 'environmentvariable',
        source: 'environmentvariabledefinitions/x_ApiBase.xml',
        status: 'satisfied',
        reason: null,
      },
      {
        id: 'workflow:x_old',
        kind: 'workflow',
        source: 'Workflows/old.xml',
        status: 'disabled',
        reason: 'WORKFLOW_INACTIVE',
      },
      {
        id: 'canvasapp:x_app',
        kind: 'canvasapp',
        source: 'CanvasApps/x_app.msapp',
        status: 'placeholder',
        reason: null,
      },
      {
        id: 'report:x_report',
        kind: 'report',
        source: 'Reports/x.rdl',
        status: 'unsupported',
        reason: 'SOLUTION_COMPONENT_INVENTORY',
      },
    ],
  };
}
const operations = [
  { key: 'cloud-flow:x1', kind: 'cloud-flow', mode: 'placeholder', registered: false, sourceFile: 'Workflows/x1.json' },
  { key: 'server-logic:x2', kind: 'server-logic', mode: 'handler', registered: true, sourceFile: null },
  {
    key: 'plugin-step:x3',
    kind: 'plugin-step',
    mode: 'placeholder',
    enabled: true,
    unsupported: 'Only synchronous stages 10, 20 and 40 are simulated.',
  },
];

function report(options = {}) {
  const registry = createCapabilityRegistry({ runtime: { kind: 'power-pages' } });
  registry.add({
    name: 'x-core',
    kind: 'organization-module',
    level: 'behaviour',
    operations: ['Create'],
    contractOperations: ['Mass'],
    requires: ['x-absent'],
  });
  registry.fromOperations(operations);
  const packs = Object.defineProperty([], 'diagnostics', {
    value: [{ code: 'PACK_EXPORT_UNKNOWN', severity: 'warning', pack: 'invented-pack', key: 'customAPIs' }],
  });
  return buildPreflightReport({
    runtime: { kind: 'power-pages' },
    simulation: { level: 'dry-run' },
    registry,
    graph: fakeGraph(),
    operations,
    packs,
    localServices: [
      { id: 'functions', kind: 'http', reachable: false, message: 'http://127.0.0.1:7071/ is not reachable.' },
    ],
    providers: [{ id: 'provider:storage/blob', reachable: true, message: 'Azurite answered 200.' }],
    ...options,
  });
}
const row = (result, id) => result.requirements.find((item) => item.id === id);

test('requirement statuses come from the graph, operations, local services and providers', () => {
  const result = report();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, 'paqvilo.mirage.preflight');
  assert.deepEqual(result.runtime, {
    kind: 'power-pages',
    simulation: 'dry-run',
    capabilities: { powerPages: true, modelDriven: true, organization: true },
  });
  assert.deepEqual(result.sources.layers, [
    { index: 0, solution: 'InventedCore', version: '1.0.0.0', type: 'xml', input: '/invented/core' },
  ]);
  assert.equal(result.sources.graphFingerprint, 'f'.repeat(64));
  assert.equal(row(result, 'connectionreference:x_shared').status, 'missing');
  assert.equal(row(result, 'environmentvariable:x_apibase').status, 'satisfied');
  assert.equal(row(result, 'workflow:x_old').status, 'disabled');
  assert.equal(row(result, 'canvasapp:x_app').status, 'placeholder');
  assert.equal(row(result, 'report:x_report').status, 'unsupported');
  assert.equal(row(result, 'cloud-flow:x1').status, 'placeholder');
  assert.deepEqual(row(result, 'server-logic:x2').resolution, { by: 'pack', mode: 'handler' });
  assert.equal(row(result, 'plugin-step:x3').status, 'unsupported');
  assert.match(row(result, 'plugin-step:x3').message, /synchronous stages/);
  assert.equal(row(result, 'local-service:functions').status, 'missing');
  assert.equal(row(result, 'provider:storage/blob').status, 'satisfied');
  assert.deepEqual(result.summary, {
    total: 10,
    satisfied: 3,
    missing: 2,
    placeholder: 2,
    unsupported: 2,
    disabled: 1,
    secret: 0,
    blocking: 0,
  });
  assert.ok(
    result.requirements.every((item) => item.inScope && !item.blocking),
    'without a scenario or strict nothing blocks',
  );
  assert.ok(result.modules.some((module) => module.name === 'x-core' && module.level === 'contract'));
  assert.deepEqual(
    result.diagnostics.map((item) => item.code),
    ['PACK_EXPORT_UNKNOWN', 'CAPABILITY_REQUIRES_UNREGISTERED'],
  );
  assert.equal(preflightExitCode(result), 0);
});

test('strict blocks every unsatisfied requirement', () => {
  const result = report({ strict: true });
  assert.equal(result.summary.blocking, 7);
  assert.equal(row(result, 'environmentvariable:x_apibase').blocking, false);
  assert.equal(result.scope.strict, true);
  assert.equal(preflightExitCode(result), 1);
});

test('a scenario scopes blocking with globs and resolves components and capabilities', () => {
  const result = report({
    scenario: {
      id: 'invented-flow',
      file: 'scenarios/flow.json',
      requires: ['cloud-flow:*', 'table:x_item', 'x-core/Mass', 'x-core/Create', 'custom-api:x_absent'],
    },
  });
  assert.deepEqual(result.scope, {
    scenario: { id: 'invented-flow', file: 'scenarios/flow.json' },
    requires: ['cloud-flow:*', 'table:x_item', 'x-core/Mass', 'x-core/Create', 'custom-api:x_absent'],
    strict: false,
  });
  assert.equal(row(result, 'cloud-flow:x1').blocking, true);
  assert.equal(row(result, 'report:x_report').inScope, false);
  assert.equal(row(result, 'report:x_report').blocking, false, 'unused unsupported features do not block');
  assert.equal(row(result, 'table:x_item').status, 'satisfied');
  assert.equal(row(result, 'x-core/Mass').status, 'unsupported');
  assert.equal(row(result, 'x-core/Create').status, 'satisfied');
  assert.equal(row(result, 'custom-api:x_absent').status, 'missing');
  assert.deepEqual(
    result.requirements
      .filter((item) => item.blocking)
      .map((item) => item.id)
      .sort(),
    ['cloud-flow:x1', 'custom-api:x_absent', 'x-core/Mass'],
  );
  assert.equal(preflightExitCode(result), 1);
  assert.equal(preflightExitCode(report({ scenario: { id: 'invented-table', requires: ['table:x_item'] } })), 0);
  assert.throws(() => report({ scenario: { id: 'x', requires: 'cloud-flow:*' } }), /scenario.requires/);
});

test('exit code 2 when no report was produced', () => {
  assert.equal(preflightExitCode(null), 2);
  assert.equal(preflightExitCode({ kind: 'other' }), 2);
});

test('configured values never appear in the report', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = 'INVENTED-SECRET-7f3a9c';
  await fs.mkdir(path.join(root, 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedSecrets</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const result = await preflight({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [root],
    packs: [],
    strict: true,
    environmentVariables: { x_ApiKey: secret },
    localServices: { functions: { kind: 'service-bus', connectionStringVariable: 'X_INVENTED_BUS' } },
    providers: {
      storage: { blob: { kind: 'azurite', connectionString: 'env:X_INVENTED_STORAGE' } },
      messaging: { bus: { kind: 'servicebus-emulator', connectionString: 'env:X_INVENTED_BUS' } },
    },
    env: {
      X_INVENTED_STORAGE: `DefaultEndpointsProtocol=http;AccountKey=${secret};BlobEndpoint=https://storage-host.example.test/x`,
      X_INVENTED_BUS: `Endpoint=sb://invented.example.test;SharedAccessKey=${secret}`,
    },
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes(secret), 'secret-like values stay out of the report');
  assert.ok(!text.includes('storage-host.example.test'), 'the endpoint host from the connection string stays out too');
  assert.match(text, /BlobEndpoint in X_INVENTED_STORAGE is not loopback/);
  // The core Azurite transport refuses a non-loopback endpoint: its preflight is not ready (missing), the refusal in its message.
  assert.equal(
    row(result, 'provider:storage/blob').status,
    'missing',
    'a non-loopback endpoint is refused, not contacted',
  );
  assert.match(row(result, 'provider:storage/blob').message, /is not loopback/);
  assert.equal(
    row(result, 'provider:messaging/bus').status,
    'missing',
    'the core emulator bus refuses a non-loopback endpoint without contacting it',
  );
  assert.equal(row(result, 'local-service:functions').status, 'missing');
  // The offline report uses the running host's composition: an Azurite store without a usable connection string is at contract.
  assert.ok(result.modules.some((module) => module.name === 'provider:storage/blob' && module.level === 'contract'));
  assert.equal(preflightExitCode(result), 1);
});
