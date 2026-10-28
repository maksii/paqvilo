import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePluginRegistrations } from '../fixtures.mjs';
import { parsePluginDocument } from '../lib/exported-plugins.mjs';

const id = (index) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const step = () => ({
  id: id(1),
  name: 'Synthetic step',
  entity: 'x_item',
  message: 'Update',
  stage: 20,
  rank: 1,
  mode: 0,
  enabled: true,
  filteringAttributes: ['x_b', 'x_a'],
  images: [{ name: 'Before', alias: 'pre', type: 0, attributes: ['x_b', 'x_a'] }],
  sourceFile: '/invented/step.xml',
});
test('parsed execution modes, registration changes and image changes compare without configuration leakage', () => {
  const original = {
    steps: [{ ...step(), configuration: 'private configuration', secureConfiguration: 'private secret' }],
  };
  const next = structuredClone(original);
  next.steps[0].stage = 40;
  next.steps[0].mode = 1;
  next.steps[0].images[0].alias = 'previous';
  next.steps[0].configuration = 'new private value';
  const untouched = structuredClone([original, next]);
  const report = comparePluginRegistrations(original, next);
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.changed[0].fields.map((change) => change.field),
    ['stage', 'mode', 'images'],
  );
  assert.equal(report.changed[0].fields[1].before, 0);
  assert.equal(report.changed[0].fields[1].after, 1);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.deepEqual([original, next], untouched);
});
test('GUID case/braces and set order are neutral while assembly/type differences and added/removed IDs are explicit', () => {
  const before = {
    steps: [step()],
    assemblies: [{ id: id(2), name: 'Local', version: '1' }],
    types: [{ id: id(3), name: 'Local.Handler', assemblyId: id(2) }],
  };
  const after = structuredClone(before);
  after.steps[0].id = `{${id(1).toUpperCase()}}`;
  after.steps[0].filteringAttributes = ['X_A', 'x_b', 'x_a'];
  after.steps[0].images[0].attributes = ['x_a', 'x_b'];
  assert.deepEqual(comparePluginRegistrations(before, after).unchanged, { assemblies: 1, types: 1, steps: 1 });
  after.assemblies[0].version = '2';
  after.types[0].name = 'Local.Other';
  after.steps = [{ ...step(), id: id(4) }];
  const report = comparePluginRegistrations(before, after);
  assert.deepEqual(
    report.changed.map((change) => change.kind),
    ['assemblies', 'types'],
  );
  assert.equal(report.added[0].id, id(4));
  assert.equal(report.removed[0].id, id(1));
});
test('ambiguous IDs and missing identity do not silently become registration additions or removals', () => {
  const before = { steps: [step(), { ...step(), stage: 40 }, { ...step(), id: null }] };
  const report = comparePluginRegistrations(before, { steps: [step()] });
  assert.equal(report.complete, false);
  assert.deepEqual(report.added, []);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(
    report.diagnostics.map((row) => row.code),
    ['REGISTRATION_ID_AMBIGUOUS', 'REGISTRATION_ID_UNRESOLVED'],
  );
});
test('comparison rejects malformed or unbounded registration inventories', () => {
  assert.throws(() => comparePluginRegistrations(null, {}), /inventories/);
  assert.throws(() => comparePluginRegistrations({ steps: Array(20001).fill(step()) }, {}), /record limit/);
  assert.throws(() => comparePluginRegistrations({ steps: [{ ...step(), images: [null] }] }, {}), /images/);
});

test('actual parsed assembly full identity changes remain visible without including binary or configuration content', () => {
  const source = (culture, token) =>
    parsePluginDocument(
      `<ImportExportXml><PluginAssembly><PluginAssemblyId>${id(2)}</PluginAssemblyId><FullName>Local, Version=1.0.0.0, Culture=${culture}, PublicKeyToken=${token}</FullName><FileName>private-binary-path</FileName></PluginAssembly></ImportExportXml>`,
    );
  const report = comparePluginRegistrations(source('neutral', '1234'), source('en-US', '5678'));
  assert.equal(report.complete, true);
  assert.deepEqual(
    report.changed[0].fields.map((change) => change.field),
    ['fullName'],
  );
  assert.equal(report.changed[0].fields[0].after, 'Local, Version=1.0.0.0, Culture=en-US, PublicKeyToken=5678');
  assert.equal(JSON.stringify(report).includes('private-binary-path'), false);
});

test('unresolved SDK message names cannot hide changed source message bindings', () => {
  const source = (message) =>
    parsePluginDocument(
      `<ImportExportXml><SdkMessageProcessingStep><SdkMessageProcessingStepId>${id(1)}</SdkMessageProcessingStepId><SdkMessageId>${message}</SdkMessageId></SdkMessageProcessingStep></ImportExportXml>`,
    );
  const report = comparePluginRegistrations(source(id(10)), source(id(11)));
  assert.deepEqual(
    report.changed[0].fields.map((change) => change.field),
    ['messageId'],
  );
});

test('aliased image/attribute products and malformed primitive facts refuse before unbounded work', () => {
  const attributes = Array(10000).fill('x_value');
  const images = Array(1000).fill({ name: 'Shared', alias: 'pre', type: 0, attributes });
  assert.throws(() => comparePluginRegistrations({ steps: [{ ...step(), images }] }, {}), /inspection limit/);
  assert.throws(() => comparePluginRegistrations({ steps: [{ ...step(), mode: { bad: true } }] }, {}), /primitive/);
});
