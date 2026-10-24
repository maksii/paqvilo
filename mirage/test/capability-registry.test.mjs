import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createCapabilityRegistry,
  normalizeCapabilityRecord,
  globMatcher,
  packCapabilityRecords,
} from '../lib/capability-registry.mjs';
import { EXTENSION as bpf } from '../lib/dataverse-bpf.mjs';
import { EXTENSION as cascade } from '../lib/dataverse-cascade.mjs';
import { EXTENSION as rollup } from '../lib/dataverse-rollup.mjs';
import { EXTENSION as hierarchy } from '../lib/dataverse-hierarchy.mjs';
import { EXTENSION as calculated } from '../lib/dataverse-calculated.mjs';
import { EXTENSION as formula } from '../lib/dataverse-formula.mjs';
import { EXTENSION as virtualProviders } from '../lib/dataverse-virtual-providers.mjs';
import { EXTENSION as sharepoint } from '../lib/sharepoint-documents.mjs';
import { createServiceFixtureRegistry } from '../lib/service-fixtures.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { azuriteDescriptor } from '../lib/storage-azurite.mjs';
import { localMessageBusDescriptor, serviceBusEmulatorDescriptor } from '../lib/message-bus.mjs';
import { describeLocalServices } from '../lib/local-services.mjs';

const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const levels = (record) => Object.fromEntries(record.operations.map((operation) => [operation.name, operation.level]));

test('the normaliser accepts string and object operations, contractOperations, operationLevels and seams', () => {
  const strings = normalizeCapabilityRecord({
    name: 'x-strings',
    kind: 'organization-module',
    level: 'behaviour',
    operations: ['A', 'B'],
  });
  assert.deepEqual(levels(strings), { A: 'behaviour', B: 'behaviour' });
  assert.equal(strings.level, 'behaviour');
  assert.equal(strings.version, version);

  const objects = normalizeCapabilityRecord({
    name: 'x-objects',
    kind: 'provider',
    operations: [
      { name: 'A', level: 'behaviour' },
      { name: 'B', level: 'contract', reason: 'NotImplemented' },
    ],
  });
  assert.equal(objects.level, 'contract', 'without a stated level the lowest operation level applies');
  assert.equal(objects.operations[1].reason, 'NotImplemented');

  const contract = normalizeCapabilityRecord({
    name: 'x-contract',
    kind: 'organization-module',
    level: 'behaviour',
    operations: ['Run'],
    contractOperations: ['Mass'],
  });
  assert.deepEqual(levels(contract), { Run: 'behaviour', Mass: 'contract' });
  assert.equal(contract.level, 'contract', 'an operation below the stated level lowers the record');

  const perOperation = normalizeCapabilityRecord({
    name: 'x-levels',
    kind: 'dataverse-extension',
    level: 'contract',
    operations: ['Seen', 'Known'],
    operationLevels: { Seen: 'inventory', Known: 'contract' },
    seams: { Known: 'hook' },
    version: 1,
  });
  assert.equal(perOperation.kind, 'organization-module', 'dataverse-extension is read as organization-module');
  assert.equal(perOperation.level, 'inventory');
  assert.deepEqual(perOperation.seams, { Known: 'hook' });
  assert.equal(perOperation.version, '1');

  const kept = normalizeCapabilityRecord({
    name: 'x-kept',
    kind: 'organization-module',
    level: 'contract',
    operations: [{ name: 'Fast', level: 'behaviour' }],
  });
  assert.equal(kept.level, 'contract', 'a stated level is kept when no operation is below it');

  const aliases = normalizeCapabilityRecord({
    name: 'x-aliases',
    kind: 'service',
    operations: [
      { name: 'a', level: 'fixture' },
      { name: 'b', level: 'disabled' },
    ],
  });
  assert.deepEqual(levels(aliases), { a: 'contract', b: 'inventory' });

  const dropped = normalizeCapabilityRecord({
    name: 'x-dropped',
    kind: 'provider',
    level: 'contract',
    preflight() {},
    fidelity: { notes: [] },
    principal: 'none',
  });
  assert.equal(dropped.preflight, undefined);
  assert.equal(dropped.fidelity, undefined);
  assert.equal(dropped.principal, 'none');
});

test('every describe() shape the modules declare normalises', () => {
  const registry = createCapabilityRegistry();
  registry.fromExtensions([bpf, cascade, rollup, hierarchy, calculated, formula, virtualProviders, sharepoint]);
  assert.equal(registry.get('sharepoint-documents').level, 'contract', 'object operations with a stated level');
  assert.equal(registry.get('dataverse-bpf').level, 'inventory', 'BusinessProcessFlowInventory is inventory');
  assert.equal(registry.get('dataverse-cascade').level, 'contract');
  assert.ok(registry.get('dataverse-cascade').seams.CascadeShare);
  assert.equal(levels(registry.get('dataverse-rollup')).MassRecalculation, 'contract');
  assert.equal(registry.get('dataverse-rollup').level, 'contract');
  assert.ok(
    registry
      .get('dataverse-hierarchy')
      .operations.some((operation) => operation.name.startsWith('query:') && operation.level === 'contract'),
  );
  assert.equal(registry.get('dataverse-hierarchy').level, 'contract');
  assert.equal(registry.get('dataverse-calculated').level, 'contract'); // placeholder for exported formulas until a pack covers every column
  registry.fromServices(createServiceFixtureRegistry());
  registry.add(createPowerFxEvaluator().describe());
  assert.equal(registry.get('power-fx').level, 'behaviour'); // the core engine (power-fx.mjs) is the default evaluator
  registry.fromProviders([
    azuriteDescriptor,
    localMessageBusDescriptor,
    serviceBusEmulatorDescriptor,
    ...describeLocalServices({ functions: { kind: 'http', baseUrl: 'http://127.0.0.1:7071' } }),
  ]);
  assert.equal(registry.get('storage:azurite').kind, 'provider');
  assert.equal(registry.get('storage:azurite').providerKind, 'azurite');
  assert.equal(registry.get('message-bus:local').level, 'behaviour');
  assert.equal(registry.get('local-service:functions').level, 'contract');
  assert.ok(registry.list({ kind: 'service' }).every((record) => record.kind === 'service'));
  assert.ok(registry.list({ level: 'contract' }).some((record) => record.name === 'storage:azurite'));
});

test('operations, inventory and packs map to levels', () => {
  const registry = createCapabilityRegistry();
  registry.fromOperations([
    { key: 'cloud-flow:a', kind: 'cloud-flow', mode: 'placeholder' },
    { key: 'cloud-flow:b', kind: 'cloud-flow', mode: 'mock' },
    { key: 'server-logic:c', kind: 'server-logic', mode: 'exported' },
    {
      key: 'plugin-step:d',
      kind: 'plugin-step',
      mode: 'handler',
      unsupported: 'Only synchronous stages are simulated.',
    },
  ]);
  assert.deepEqual(
    registry.list({ kind: 'operation' }).map((record) => record.level),
    ['inventory', 'contract', 'behaviour', 'inventory'],
  );
  assert.equal(registry.get('plugin-step:d').reason, 'Only synchronous stages are simulated.');
  registry.fromInventory([
    { component: 'canvasapp', name: 'x_app', level: 'inventory', reason: 'CANVAS' },
    { component: 'canvasapp', name: 'x_app', level: 'inventory' },
  ]);
  assert.equal(registry.get('canvasapp:x_app').kind, 'inventory');
  registry.addAll(
    packCapabilityRecords([
      { id: 'invented-pack', capabilities: [{ name: 'x-pack', kind: 'provider', level: 'behaviour' }] },
      { id: 'invented-map', capabilities: { 'x-map': { kind: 'provider', level: 'contract' } } },
    ]),
  );
  assert.equal(registry.get('x-pack').source, 'pack:invented-pack');
  assert.equal(registry.get('x-map').level, 'contract');
});

test('invalid records, duplicates and unproven native-qualified records are refused', () => {
  const registry = createCapabilityRegistry();
  registry.add({ name: 'x-one', kind: 'provider', level: 'behaviour' });
  assert.throws(
    () => registry.add({ name: 'x-one', kind: 'service', level: 'contract' }),
    /Capability x-one is already registered \(kind provider\)/,
  );
  assert.throws(() => registry.add({ kind: 'provider', level: 'behaviour' }), /needs a name/);
  assert.throws(() => registry.add({ name: 'x-kind', kind: 'widget', level: 'behaviour' }), /kind must be one of/);
  assert.throws(() => registry.add({ name: 'x-level', kind: 'provider', level: 'excellent' }), /level must be one of/);
  assert.throws(() => registry.add({ name: 'x-none', kind: 'provider' }), /level is required/);
  assert.throws(
    () => registry.add({ name: 'x-op', kind: 'provider', operations: ['Run'] }),
    /operation Run has no level/,
  );
  assert.throws(
    () => registry.add({ name: 'x-native', kind: 'provider', level: 'native-qualified', evidence: ['docs/x.md'] }),
    /compared scenario id/,
  );
  assert.throws(
    () =>
      registry.add({
        name: 'x-native-op',
        kind: 'provider',
        level: 'behaviour',
        operations: [{ name: 'Run', level: 'native-qualified' }],
      }),
    /compared scenario id/,
  );
  const native = registry.add({
    name: 'x-native',
    kind: 'provider',
    level: 'native-qualified',
    evidence: [{ scenario: 'invented-compare' }],
  });
  assert.deepEqual(native.evidence, [{ scenario: 'invented-compare' }]);
});

test('summary merges runtime capabilities with host-surface booleans', () => {
  const registry = createCapabilityRegistry({ runtime: { kind: 'dataverse-api' } });
  registry.add({ name: 'dataverseApi', kind: 'host-surface', level: 'behaviour', enabled: true });
  registry.add({ name: 'portalRendering', kind: 'host-surface', level: 'behaviour', enabled: false });
  registry.add({ name: 'setup', kind: 'host-surface', level: 'behaviour' });
  assert.deepEqual(registry.summary(), {
    powerPages: false,
    modelDriven: false,
    organization: true,
    dataverseApi: true,
    portalRendering: false,
    setup: true,
  });
});

test('report and assertExecutable name the gaps below behaviour', () => {
  const registry = createCapabilityRegistry();
  registry.add({
    name: 'x-core',
    kind: 'organization-module',
    level: 'behaviour',
    operations: ['Create'],
    requires: ['x-scheduler', 'table:x_item'],
  });
  registry.add({
    name: 'x-rollup',
    kind: 'organization-module',
    level: 'behaviour',
    operations: ['Recalculate'],
    contractOperations: ['Mass'],
  });
  registry.fromOperations([{ key: 'cloud-flow:x1', kind: 'cloud-flow', mode: 'placeholder' }]);
  const report = registry.report();
  assert.deepEqual(
    report.missing,
    [{ module: 'x-core', requires: 'x-scheduler' }],
    'prefixed prerequisites are left to preflight',
  );
  assert.ok(report.unsupported.some((item) => item.id === 'x-rollup/Mass'));
  assert.deepEqual(
    registry.report({ scenario: { requires: ['cloud-flow:*'] } }).unsupported.map((item) => item.id),
    ['cloud-flow:x1'],
  );
  assert.equal(registry.assertExecutable(['x-core', 'x-rollup/Recalculate']), true);
  assert.throws(
    () => registry.assertExecutable(['x-rollup/*', 'cloud-flow:*', 'x-absent']),
    (error) => {
      assert.equal(error.code, 'CapabilityUnavailable');
      assert.deepEqual(
        error.details.gaps.map((gap) => gap.name),
        ['x-rollup/Mass', 'cloud-flow:x1', null],
      );
      assert.match(error.message, /x-rollup\/Mass is contract; cloud-flow:x1 is inventory; x-absent is not registered/);
      return true;
    },
  );
  assert.equal(globMatcher('Cloud-Flow:*')('cloud-flow:x1'), true);
  assert.equal(globMatcher('x.y')('xzy'), false, 'only * is a wildcard');
});
