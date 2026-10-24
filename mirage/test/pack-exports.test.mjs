import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PACK_EXPORTS, CORE, validatePackExports, collectPackExport, packProvides, registerPackExport, snapshotPackExports } from '../lib/pack-exports.mjs';
import { discoverPacks, validatePack } from '../lib/preset-registry.mjs';
import { operationHandlers } from '../lib/exported-operations.mjs';

const STEP = '77777777-7777-4777-8777-777777777777';
const pack = (id, extra = {}) => ({ id, name: `Invented ${id}`, description: 'Invented pack', matches: () => true, presets: () => ({}), ...extra });
const PRE_REGISTERED = ['connectors', 'httpFixtures', 'connectionPrincipals', 'storageProviders', 'messageProviders', 'virtualTableProviders',
  'outboxHandlers', 'serviceFixtures', 'powerFx', 'calculatedColumns', 'businessRules', 'rollups', 'capabilities'];

test('unknown pack keys are diagnostics, and errors in strict mode', () => {
  const typo = pack('fx-typo', { customAPIs: { x_Echo: () => ({}) } });
  assert.deepEqual(validatePackExports(typo).map(d => [d.code, d.pack, d.key]), [['PACK_EXPORT_UNKNOWN', 'fx-typo', 'customAPIs']]);
  assert.throws(() => validatePackExports(typo, { strict: true }), /Data pack fx-typo: unknown exports customAPIs/);
  assert.deepEqual(validatePackExports(pack('fx-core', { generators: {}, parity: {}, dataset() {} })), []);
  assert.ok(CORE.includes('configurationPresets'));
  // validatePack keeps loading the pack and records the diagnostic for discoverPacks.
  // validatePack returns a frozen snapshot of the pack with the same exports.
  const validatedTypo = validatePack(typo);
  assert.ok(Object.isFrozen(validatedTypo));
  assert.deepEqual(Object.keys(validatedTypo), Object.keys(typo));
  assert.equal(validatedTypo.id, typo.id);
});

test('recognised exports are validated at load with their collector rules', () => {
  assert.throws(() => validatePackExports(pack('fx-a', { pluginTypes: { 'Invented.Type': async () => {} } })), /pluginTypes must map plug-in type names to synchronous functions/);
  assert.throws(() => validatePackExports(pack('fx-a', { customApis: { x_Echo: { handler: () => ({}), pluginType: ' ' } } })), /customApis pluginType for x_Echo must be non-empty text/);
  assert.throws(() => validatePackExports(pack('fx-a', { workflows: { '{}': () => {} } })), /workflows must map/);
  assert.throws(() => validatePackExports(pack('fx-a', { dataverseMessages: { x_Run: 'no' } })), /dataverseMessages must map/);
  assert.throws(() => validatePackExports(pack('fx-a', { shell: { footerLogoClass: 'not a class' } })), /CSS class name/);
});

test('one collision message format and per-export key normalisers', () => {
  const handler = () => ({});
  assert.throws(() => collectPackExport([pack('fx-a', { serverLogics: { Sample: handler } }), pack('fx-b', { serverLogics: { sample: handler } })], 'serverLogics'),
    /^Error: Ambiguous serverLogics registration for sample in packs fx-a and fx-b$/);
  assert.throws(() => collectPackExport([pack('fx-a', { pluginSteps: { [`{${STEP.toUpperCase()}}`]: handler } }), pack('fx-b', { pluginSteps: { [STEP]: handler } })], 'pluginSteps'),
    new RegExp(`Ambiguous pluginSteps registration for ${STEP} in packs fx-a and fx-b`));
  assert.throws(() => collectPackExport([pack('fx-a', { shell: { footerLogoClass: 'x-logos' } }), pack('fx-b', { shell: { footerLogoClass: 'x-logos' } })], 'shell'),
    /Ambiguous shell registration for footerLogoClass:x-logos in packs fx-a and fx-b/);
  // Exact keys stay distinct; endpoints keep the first registration.
  const messages = collectPackExport([pack('fx-a', { dataverseMessages: { x_Run: handler } }), pack('fx-b', { dataverseMessages: { X_RUN: handler } })], 'dataverseMessages');
  assert.deepEqual([...messages.keys()], ['x_Run', 'X_RUN']);
  const endpoint = id => ({ id, methods: ['GET'], pattern: /^\/__sim\/fx$/, handle() {} });
  const endpoints = collectPackExport([pack('fx-a', { endpoints: [endpoint('ping')] }), pack('fx-b', { endpoints: [endpoint('ping')] })], 'endpoints');
  assert.equal(endpoints.get('ping').pack, 'fx-a');
  const workflows = collectPackExport([pack('fx-a', { workflows: { '{ABCDEF00-0000-4000-8000-000000000000}': handler } })], 'workflows');
  assert.deepEqual([...workflows.keys()], ['abcdef00-0000-4000-8000-000000000000']);
  assert.throws(() => collectPackExport([], 'nope'), /Unknown pack export nope/);
});

test('packProvides lists every export key per pack', () => {
  const provided = packProvides([pack('fx-a', { cloudFlows: { Notify: () => {} }, shell: { headerNotificationQuery: 'Invented notices' } }), pack('fx-b', { pluginSteps: { [STEP]: () => {} } })]);
  assert.deepEqual(provided, [
    { pack: 'fx-a', export: 'cloudFlows', key: 'notify' },
    { pack: 'fx-a', export: 'shell', key: 'headerNotificationQuery:Invented notices' },
    { pack: 'fx-b', export: 'pluginSteps', key: STEP },
  ]);
});

test('provider exports are pre-registered as pending until their module registers the real check', () => {
  for (const name of PRE_REGISTERED) assert.ok(PACK_EXPORTS[name], name);
  const pendingName = PRE_REGISTERED.find(name => PACK_EXPORTS[name].pending && name !== 'httpFixtures');
  assert.ok(pendingName, 'this process has not imported every provider module, so one export is still pending');
  assert.equal(PACK_EXPORTS[pendingName].collide, 'error');
  const loaded = pack('fx-a', { [pendingName]: { first: { run() {} } } });
  assert.deepEqual(validatePackExports(loaded).map(d => d.code), ['PACK_EXPORT_PENDING']);
  assert.throws(() => validatePackExports(pack('fx-a', { [pendingName]: { first: 'text' } })), new RegExp(`${pendingName} must be an object of functions or objects`));
  assert.throws(() => collectPackExport([loaded, pack('fx-b', { [pendingName]: { first: {} } })], pendingName), new RegExp(`Ambiguous ${pendingName} registration for first in packs fx-a and fx-b`));
  const check = (value, packId) => { if (!value.first?.run) throw new Error(`Data pack ${packId}: ${pendingName}.first needs run()`); };
  registerPackExport(pendingName, { check, key: key => key.toUpperCase() });
  assert.equal(PACK_EXPORTS[pendingName].pending, null);
  assert.deepEqual(validatePackExports(loaded), []);
  assert.throws(() => validatePackExports(pack('fx-b', { [pendingName]: { first: {} } })), /first needs run\(\)/);
  assert.deepEqual([...collectPackExport([loaded], pendingName).keys()], ['FIRST']);
  assert.throws(() => registerPackExport(pendingName, { check: () => {} }), /already registered/);
  assert.throws(() => registerPackExport('id', { check }), /Invalid pack export name/);
});

test('discoverPacks surfaces export diagnostics of every loaded pack', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-exports-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'pack.mjs');
  await fs.writeFile(file, 'export default { id: "fx-disk", name: "Disk", description: "Invented", matches: () => false, presets: () => ({}), pluginType: {} };\n');
  const packs = await discoverPacks({ explicit: [file], portal: { website: { name: 'Invented' } } });
  assert.deepEqual(packs.map(item => item.id), []);
  assert.deepEqual(packs.diagnostics.map(d => [d.code, d.pack, d.key]), [['PACK_EXPORT_UNKNOWN', 'fx-disk', 'pluginType']]);
});

test('a getter export is refused at load, and a validated snapshot cannot diverge from what was checked', () => {
  const getter = pack('fx-getter');
  Object.defineProperty(getter, 'customApis', { enumerable: true, get: () => ({ x_Echo: () => ({}) }) });
  assert.throws(() => validatePackExports(getter), { name: 'TypeError', message: /Data pack fx-getter: export customApis must be a plain data property/ });
  assert.throws(() => validatePack(getter), /fx-getter.*customApis must be a plain data property/);

  // A Proxy shows a valid descriptor and answers something else through get.
  const checked = { x_Echo: () => ({}) };
  const proxy = new Proxy(pack('fx-proxy', { customApis: checked }), { get: (target, key) => (key === 'customApis' ? { x_Echo: 'not a function' } : target[key]) });
  assert.throws(() => collectPackExport([proxy], 'customApis'), /invalid customApis handler/);
  const snapshot = snapshotPackExports(proxy);
  assert.deepEqual(validatePackExports(snapshot), []);
  assert.equal(snapshot.customApis, checked);
  assert.equal(collectPackExport([snapshot], 'customApis').get('x_echo').value, checked.x_Echo);
  assert.ok(Object.isFrozen(snapshot));

  // Lazy core getters stay unevaluated in the snapshot.
  let evaluated = false;
  const lazy = pack('fx-lazy');
  Object.defineProperty(lazy, 'personas', { enumerable: true, get: () => { evaluated = true; return []; } });
  const lazySnapshot = snapshotPackExports(lazy);
  assert.equal(evaluated, false);
  assert.deepEqual(lazySnapshot.personas, []);
});

test('flowIdentities keeps the earlier collector: any key, brace-stripped and lowercased, and a null export', () => {
  const profile = { userId: STEP, evidence: 'Invented flow owner', grants: [{ entity: 'x_item', operations: ['read'] }] };
  const handlers = operationHandlers([pack('fx-flows', { flowIdentities: { 'Invented_Flow': profile, [`{${STEP.toUpperCase()}}`]: profile } }), pack('fx-none', { flowIdentities: null })]);
  assert.deepEqual([...handlers.flowIdentities.keys()], ['invented_flow', STEP]);
  assert.deepEqual(validatePackExports(pack('fx-none', { flowIdentities: null })), []);
  assert.throws(() => validatePackExports(pack('fx-bad', { flowIdentities: { Invented_Flow: 'text' } })), /flowIdentities must map/);
});
