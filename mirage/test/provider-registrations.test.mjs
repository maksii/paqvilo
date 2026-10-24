import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/provider-modules.mjs';
import { parseSetting, pendingSettingParsers } from '../lib/config-keys.mjs';
import { PACK_EXPORTS, validatePackExports, collectPackExport } from '../lib/pack-exports.mjs';

const USER = '77777777-7777-4777-8777-777777777777';
const RULE = '88888888-8888-4888-8888-888888888888';
const fn = () => null;
const pack = (id, exports) => ({
  id,
  name: id,
  description: 'Invented',
  matches: () => true,
  presets: () => ({}),
  ...exports,
});

test('provider-modules registers every contract setting parser and pack export', () => {
  assert.deepEqual(pendingSettingParsers(), []);
  assert.deepEqual(
    Object.keys(PACK_EXPORTS).filter((name) => PACK_EXPORTS[name].pending),
    [],
  );
});

const SETTINGS = {
  connections: [
    { x_conn: { provider: 'http', connector: 'x_widgets' } },
    { x_conn: { password: 'literal' } },
    /not a connection setting/,
  ],
  secrets: [
    { 'x-vault/x-secret': { variable: 'X_SECRET' } },
    { 'x-vault/x-secret': { value: 'literal' } },
    /never live in config/,
  ],
  localServices: [
    { 'x-api': { kind: 'http', baseUrl: 'http://127.0.0.1:7071' } },
    { 'x-api': { kind: 'http', baseUrl: 'https://remote.example.test' } },
    /localhost/,
  ],
  canvas: [{ enabled: true, sources: ['apps/x'] }, { enabled: 'yes' }, /canvas.enabled must be true or false/],
  codeApps: [[{ name: 'x-app', dir: 'apps/x' }], [{ name: 'x app', dir: 'apps/x' }], /name must be/],
};

for (const [key, [good, bad, message]] of Object.entries(SETTINGS)) {
  test(`${key} parser accepts a valid sample and rejects an invalid one`, () => {
    const diagnostics = [];
    assert.ok(parseSetting(key, good, { diagnostics }));
    assert.deepEqual(diagnostics, []);
    assert.throws(() => parseSetting(key, bad), message);
  });
}

test('providers parser validates storage, messaging and outbox through their modules', () => {
  const diagnostics = [];
  const parsed = parseSetting(
    'providers',
    {
      storage: { disk: { kind: 'local-disk', root: 'blobs' } },
      routes: { annotations: 'disk' },
      messaging: { queue: { kind: 'local-queue' } },
      outbox: { retention: 10 },
    },
    { diagnostics },
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(parsed.storage.disk.root, 'blobs');
  assert.equal(parsed.routes.annotations, 'disk');
  assert.equal(parsed.messaging.queue.kind, 'local-queue');
  assert.deepEqual(parsed.outbox, { kind: 'local', retention: 10 });
  assert.throws(
    () => parseSetting('providers', { storage: { disk: { kind: 'local-disk', root: '../outside' } } }),
    /under the state directory/,
  );
  assert.throws(() => parseSetting('providers', { routes: { annotations: 'missing' } }), /unknown storage id/);
  assert.throws(() => parseSetting('providers', { messaging: { queue: { kind: 'smtp' } } }), /kind must be/);
  assert.throws(() => parseSetting('providers', { outbox: { kind: 'smtp' } }), /kind must be local or pack/);
  assert.throws(() => parseSetting('providers', { outbox: { retention: 0 } }), /retention must be/);
});

const EXPORTS = {
  connectors: [{ x_widgets: { operations: { List: fn } } }, { http: { operations: { List: fn } } }],
  httpFixtures: [
    [{ id: 'a', method: 'GET', url: /x/, respond: fn }],
    [{ id: 'a', method: 'GET', url: /x/g, respond: fn }],
  ],
  connectionPrincipals: [
    { owner: { userId: USER, evidence: 'Invented owner', grants: [{ entity: 'x_item', operations: ['read'] }] } },
    { owner: { userId: 'x' } },
  ],
  storageProviders: [{ blob: fn }, { blob: 'text' }],
  messageProviders: [{ queue: fn }, { queue: {} }],
  outboxHandlers: [{ deliver: fn }, { deliver: 1 }],
  serviceFixtures: [{ aiBuilder: { predict: fn } }, { aiBuilder: { predict: async () => null } }],
  powerFx: [{ evaluate: fn }, { check: fn }],
  calculatedColumns: [{ 'x_item.x_total': fn }, { x_total: fn }],
  businessRules: [{ [RULE]: fn }, { 'not-a-guid': fn }],
  rollups: [{ 'x_item.x_count': fn }, { 'x_item.x_count': async () => 1 }],
  formulaColumns: [{ 'x_item.x_label': fn }, { 'x_item.x_label': 'text' }],
  virtualTableProviders: [{ x_remote: { retrieveMultiple: fn } }, { x_remote: { fetch: fn } }],
  hierarchies: [{ x_item: 'x_parentid' }, { x_item: 3 }],
  transitions: [{ x_item: { 1: [2] } }, { x_item: { 1: 'two' } }],
  capabilities: [
    [{ name: 'x-capability', kind: 'provider', level: 'contract' }],
    [{ name: 'x-capability', kind: 'provider', level: 'perfect' }],
  ],
};

test('every provider pack export has a registered check', () => {
  const unchecked = Object.keys(PACK_EXPORTS).filter(
    (name) =>
      PACK_EXPORTS[name].group === null &&
      !(name in EXPORTS) &&
      !['customApis', 'workflows', 'dataverseMessages', 'expressionOperators', 'endpoints', 'shell'].includes(name),
  );
  assert.deepEqual(unchecked, []);
});

for (const [name, [good, bad]] of Object.entries(EXPORTS)) {
  test(`pack export ${name} accepts a valid sample and rejects an invalid one`, () => {
    assert.deepEqual(validatePackExports(pack('fx-good', { [name]: good })), []);
    assert.throws(() => validatePackExports(pack('fx-bad', { [name]: bad })), /fx-bad/);
  });
}

test('two packs exporting the same provider key collide with the single message', () => {
  assert.throws(
    () =>
      collectPackExport(
        [pack('fx-a', { powerFx: { evaluate: fn } }), pack('fx-b', { powerFx: { evaluate: fn } })],
        'powerFx',
      ),
    /^Error: Ambiguous powerFx registration for adapter in packs fx-a and fx-b$/,
  );
  assert.throws(
    () =>
      collectPackExport(
        [
          pack('fx-a', { calculatedColumns: { 'X_Item.X_Total': fn } }),
          pack('fx-b', { calculatedColumns: { 'x_item.x_total': fn } }),
        ],
        'calculatedColumns',
      ),
    /Ambiguous calculatedColumns registration for x_item.x_total in packs fx-a and fx-b/,
  );
  assert.deepEqual(
    [...collectPackExport([pack('fx-a', { serviceFixtures: { copilot: { ask: fn } } })], 'serviceFixtures').keys()],
    ['copilot.ask'],
  );
});
