// RetrieveEnvironmentVariableSecretValue through api.secrets (secret-resolver.mjs): resolved, denied, missing, unbound,
// expired, wrong type and the 501 without a secrets configuration; metadata reads and the /_sim environment table carry
// the reference only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { seed as seedStandard } from '../lib/dataverse-standard.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { runAtomic } from '../lib/dataverse-api.mjs';
import { install } from '../lib/dataverse-org-messages.mjs';
import { createSecretResolver } from '../lib/secret-resolver.mjs';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const VALUE = 'invented-secret-value-9c1d';
const REFERENCE = 'https://fx-vault.vault.azure.net/secrets/func-key';
const SETTINGS = {
  organizationId: '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [{ objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};

async function setup() {
  const store = new DataStore({ state: emptyState() });
  await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes,
  });
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    principals,
    metadata: null,
    metadataFields: () => undefined,
    records,
    changes,
    settings: SETTINGS,
    clock: () => 0,
    log: () => {},
  };
  api.runAtomic = (fn) => runAtomic(api, fn);
  install(api);
  const admin = principals.byObjectId(ADMIN_OID);
  const call = (name, { kind = 'action', params, body } = {}) => {
    const op = api.registry.find({ name, kind, binding: 'unbound' });
    return Promise.resolve().then(() =>
      op.handle({
        user: admin,
        caller: null,
        params,
        body,
        identity: { admin: true },
        origin: ORIGIN,
        version: 'v9.2',
        url: new URL(`${ORIGIN}/api/data/v9.2/${name}`),
      }),
    );
  };
  await call('UpsertEnvironmentVariable', {
    body: { SchemaName: 'fx_Key', Type: 100000005, SecretStore: 0, Value: REFERENCE },
  });
  await call('UpsertEnvironmentVariable', { body: { SchemaName: 'fx_Plain', Type: 100000000, Value: 'plain' } });
  const secrets = (entry, extra = {}) =>
    createSecretResolver({
      secrets: { 'fx-vault/func-key': { variable: 'FX_FUNC_KEY', ...entry } },
      env: { FX_FUNC_KEY: VALUE },
      clock: () => Date.parse('2026-10-22T00:00:00Z'),
      ...extra,
    });
  return { api, store, admin, call, secrets };
}
const secretValue = (t, name = 'fx_Key') =>
  t.call('RetrieveEnvironmentVariableSecretValue', { body: { EnvironmentVariableName: name } });

test('without a secrets configuration the secret value stays not simulated (501)', async () => {
  const t = await setup();
  await assert.rejects(secretValue(t), (e) => e.status === 501 && e.details?.innerCode === '0x80040216');
});

test('the secret value resolves for an allowed caller and each refusal has its status', async () => {
  const t = await setup();
  t.api.secrets = t.secrets({ allow: [t.admin.systemuserid] });
  const answer = await secretValue(t);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.EnvironmentVariableSecretValue, VALUE);
  assert.match(answer.body['@odata.context'], /RetrieveEnvironmentVariableSecretValueResponse$/);

  const cases = [
    [t.secrets({}), 403],
    [t.secrets({ allow: [t.admin.systemuserid] }, { env: {} }), 404],
    [t.secrets({ allow: [t.admin.systemuserid], expiresOn: '2026-01-01T00:00:00Z' }), 400],
    [createSecretResolver({ secrets: {} }), 404],
  ];
  for (const [resolver, status] of cases) {
    t.api.secrets = resolver;
    await assert.rejects(
      secretValue(t),
      (e) => e.status === status && !String(e.message).includes(VALUE),
      `status ${status}`,
    );
  }
  t.api.secrets = t.secrets({ allow: [t.admin.systemuserid] });
  await assert.rejects(secretValue(t, 'fx_Plain'), (e) => e.status === 400);
  await assert.rejects(secretValue(t, 'fx_Missing'), (e) => e.status === 404);
});

test('RetrieveEnvironmentVariables and OData environmentvariablevalues reads return the reference, never the value', async () => {
  const t = await setup();
  t.api.secrets = t.secrets({ allow: [t.admin.systemuserid] });
  const listed = await t.call('RetrieveEnvironmentVariables', { kind: 'function' });
  assert.equal(listed.body.value.find((row) => row.schemaname === 'fx_Key').value, REFERENCE);
  const path = '/api/data/v9.2/environmentvariablevalues';
  const read = await t.api.records.handle({
    method: 'GET',
    route: parseDataverseRoute(path),
    url: new URL(ORIGIN + path),
    origin: ORIGIN,
    version: 'v9.2',
    prefer: parsePrefer(undefined),
    headers: {},
    user: t.admin,
    caller: null,
    identity: { admin: true },
  });
  assert.equal(read.status, 200);
  assert.ok(read.body.value.some((row) => row.value === REFERENCE));
  assert.doesNotMatch(JSON.stringify([listed.body, read.body]), new RegExp(VALUE));
});

test('NotifyEnvironmentVariableSecretChange stays validate-only with a secrets configuration', async () => {
  const t = await setup();
  t.api.secrets = t.secrets({ allow: [t.admin.systemuserid] });
  assert.equal(
    (
      await t.call('NotifyEnvironmentVariableSecretChange', {
        body: { KeyVaultUrl: 'https://fx-vault.vault.azure.net', SecretName: 'func-key' },
      })
    ).status,
    204,
  );
});

test('the /_sim environment table carries no value for secret definitions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-secret-sim-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries({
    'website.yml': 'adx_websiteid: site\nadx_name: Secret table fixture',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<p>home</p>',
  })) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const initial = {
    version: 1,
    mappings: {
      environmentvariabledefinition: {
        entitySet: 'environmentvariabledefinitions',
        idColumn: 'environmentvariabledefinitionid',
      },
      environmentvariablevalue: { entitySet: 'environmentvariablevalues', idColumn: 'environmentvariablevalueid' },
    },
    tables: {
      environmentvariabledefinition: [
        { environmentvariabledefinitionid: 'def-key', schemaname: 'fx_Key', type: 100000005, secretstore: 0 },
        {
          environmentvariabledefinitionid: 'def-store',
          schemaname: 'fx_Stored',
          type: 100000000,
          secretstore: 1,
          defaultvalue: VALUE,
        },
        {
          environmentvariabledefinitionid: 'def-plain',
          schemaname: 'fx_Plain',
          type: 100000000,
          defaultvalue: 'plain',
        },
      ],
      environmentvariablevalue: [
        { environmentvariablevalueid: 'val-key', environmentvariabledefinitionid: 'def-key', value: REFERENCE },
      ],
    },
    permissions: [],
  };
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state', 'state.json'),
    port: 0,
    watch: false,
    initial,
  });
  ownedFixture(t).add(() => app.close());
  const response = await fetch(app.url + '/__sim/api/environment', { headers: { 'x-sim-csrf': app.csrf } });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const byName = Object.fromEntries(
    JSON.parse(text).environmentVariables.definitions.map((item) => [item.schemaName, item]),
  );
  assert.equal(byName.fx_Key.reference, REFERENCE);
  assert.deepEqual(byName.fx_Key.secretStatus, {
    bound: false,
    status: 'not-configured',
    version: null,
    expiresOn: null,
  });
  for (const name of ['fx_Key', 'fx_Stored']) {
    assert.equal(byName[name].secret, true);
    assert.equal('value' in byName[name], false);
    assert.equal('effectiveValue' in byName[name], false);
  }
  assert.equal(byName.fx_Stored.reference, null);
  assert.equal(byName.fx_Plain.effectiveValue, 'plain');
  assert.doesNotMatch(text, new RegExp(VALUE));
});
