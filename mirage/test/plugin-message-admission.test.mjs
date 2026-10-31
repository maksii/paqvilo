// @test-kind contract: Paqvilo refuses named messages without an implemented plug-in pipeline (501) before any write
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPluginMessageAdmission } from '../lib/plugin-message-admission.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { install as installRecordMessages } from '../lib/dataverse-record-messages.mjs';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const mergeBody = () => ({
  Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: a },
  Subordinate: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: b },
  PerformParentingChecks: false,
});
const registration = (message, extra = {}) => ({
  id: a,
  message,
  entity: 'account',
  enabled: true,
  mode: 0,
  stage: 20,
  rank: 1,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Named.Guard',
  assemblyId: 'invented',
  ...extra,
});
const unsupported = (error) => error.status === 501 && error.code === 'LocalPluginUnsupported';

test('missing named pipelines refuse every explicit execution choice but retain inventory and binding controls', () => {
  for (const mode of ['handler', 'clr', 'mock', 'webhook']) {
    let item = { ...registration('Merge'), mode, contract: { mode: 0, supportedDeployment: 0 } };
    const store = { pluginPipeline: { steps: () => [item] } };
    assert.throws(() => assertPluginMessageAdmission(store, 'Merge', {}, 'account'), unsupported, mode);
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, 'Merge', {}, 'contact'));
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, 'Assign', {}, 'account'));
    assert.throws(() => assertPluginMessageAdmission(store, 'Merge'), /binding is unresolved/);
    for (const changes of [
      { enabled: false },
      { mode: 'disabled' },
      { mode: 'placeholder' },
      { contract: { mode: 0, supportedDeployment: 1 } },
      { customApi: { name: 'Merge' } },
    ]) {
      const original = item;
      item = { ...item, ...changes };
      assert.doesNotThrow(() => assertPluginMessageAdmission(store, 'Merge', {}, 'account'));
      item = original;
    }
  }
});

test('missing pipelines apply synchronous and asynchronous bypass separately and preserve protected ownership', () => {
  for (const mode of [0, 1]) {
    let item = { ...registration('Assign'), mode: 'handler', contract: { mode, supportedDeployment: 0 } };
    const store = { pluginPipeline: { steps: () => [item] } };
    const bypass = mode === 1 ? { bypassCustomAsync: true } : { bypassCustomPlugins: true };
    const other = mode === 1 ? { bypassCustomPlugins: true } : { bypassCustomAsync: true };
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, 'Assign', bypass, 'account'));
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, 'Assign', { bypassStepIds: [a] }, 'account'));
    assert.throws(() => assertPluginMessageAdmission(store, 'Assign', other, 'account'), unsupported);
    item = { ...item, bypassOwnership: { kind: 'microsoft', evidence: 'Invented owned solution evidence' } };
    assert.throws(() => assertPluginMessageAdmission(store, 'Assign', bypass, 'account'), unsupported);
    assert.throws(() => assertPluginMessageAdmission(store, 'Assign', { bypassStepIds: [a] }, 'account'), unsupported);
  }
});

// @test-kind unproven: local model of a registered operation's message pipeline (no native capture of a Web API action's steps)
test('static and mutable registry operations run their message pipeline before their own handler', async (t) => {
  for (const dynamic of [false, true]) {
    const name = dynamic ? 'OtherAction' : 'InventedAction';
    // The request's Target names the message's table (PrimaryEntityName), also for an unbound action.
    const f = await fixture(t, name);
    let calls = 0;
    const registry = createOperationRegistry({ store: f.store });
    const op = { name: 'InventedAction', kind: 'action', binding: 'unbound', handle: () => ++calls };
    if (dynamic) registry.setProvider('invented', () => [{ ...op, name }]);
    else registry.register(op);
    const found = registry.find({ name, kind: 'action', binding: 'unbound' });
    // The PreOperation step (the fixture's guard) runs before the operation and its refusal stops it.
    await assert.rejects(
      () => found.handle({ body: { Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: a } } }),
      /Named guard/,
    );
    assert.equal(calls, 0);
    assert.equal(f.calls(), 1);
  }
});

test('entity-set aliases use the same canonical table binding as the operation handler', () => {
  const store = {
    resolveMapping: (entity) => ({ logicalName: entity === 'accounts' ? 'account' : entity }),
    pluginPipeline: { steps: () => [{ ...registration('Assign'), mode: 'handler' }] },
  };
  assert.throws(
    () => assertPluginMessageAdmission(store, 'Assign', { params: { Target: { logicalName: 'accounts' } } }),
    unsupported,
  );
  assert.doesNotThrow(() =>
    assertPluginMessageAdmission(store, 'Assign', { params: { Target: { logicalName: 'contacts' } } }),
  );
});

async function fixture(t, message, extra = {}) {
  const f = await contractModuleFixture(t, {
    mappings: {
      account: {
        entitySet: 'accounts',
        idColumn: 'accountid',
        fields: {
          title: { dataverseType: 'nvarchar' },
          statecode: { dataverseType: 'state' },
        },
      },
    },
    tables: {
      account: [
        { accountid: a, title: null },
        { accountid: b, title: 'Subordinate' },
      ],
    },
    extension: { name: 'invented-admission', install: () => {} },
  });
  let calls = 0;
  const step = registration(message, extra);
  const handlers = new Map([
    [
      step.typeName,
      () => {
        calls++;
        throw new Error('Named guard');
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, calls: () => calls };
}

// @test-kind unproven: local model of the Merge pipeline (no native capture of Merge steps on a mergeable table)
test('HTTP Merge runs its named step before target, subordinate or child writes', async (t) => {
  const f = await fixture(t, 'Merge');
  const before = structuredClone(f.store.tableRows('account'));
  const response = await f.request('POST', '/Merge', mergeBody());
  const text = await response.text();
  assert.ok(response.status >= 400, text);
  assert.match(text, /Named guard/);
  assert.deepEqual(f.store.tableRows('account'), before);
  assert.equal(f.calls(), 1);
});

// @test-kind unproven: local model of the Merge pipeline (no native capture of Merge steps on a mergeable table)
test('direct record-message installation also runs the Merge step before delegated writes', async (t) => {
  const f = await fixture(t, 'Merge'),
    operations = new Map();
  installRecordMessages({
    store: f.store,
    registry: { register: (operation) => operations.set(operation.name, operation) },
    change: (fn) => fn(),
    principals: f.api.principals,
  });
  const before = structuredClone(f.store.tableRows('account'));
  await assert.rejects(
    () => operations.get('Merge').handle({ body: mergeBody(), identity: { admin: true } }),
    /Named guard/,
  );
  assert.deepEqual(f.store.tableRows('account'), before);
  assert.equal(f.calls(), 1);
});

// @test-kind parity: native recorder corpus 2026-10-30, upsert and bulk scenarios captured twice: globally registered Upsert and UpsertMultiple steps never execute
// @parity-evidence: native recorder corpus 2026-10-30 (two captures each of upsert and bulk): zero Upsert/UpsertMultiple step events while the delegated Create/Update (CreateMultiple/UpdateMultiple) steps run; registration probes round 2: account has no Upsert or UpsertMultiple sdkmessagefilter, so these steps can only be registered without a table (global)
// Recorded native corpus: registered Upsert and UpsertMultiple steps never execute. The platform runs the delegated
// Create/Update (or CreateMultiple/UpdateMultiple) pipelines instead, so these requests neither refuse nor run the step.
for (const message of ['Upsert', 'UpsertMultiple'])
  test(`HTTP ${message} runs its delegated writes without executing its own never-executed steps`, async (t) => {
    const f = await fixture(t, message, { entity: null, unfiltered: true });
    const response = await f.request(
      message === 'Upsert' ? 'PATCH' : 'POST',
      message === 'Upsert' ? `/accounts(${a})` : '/accounts/Microsoft.Dynamics.CRM.UpsertMultiple',
      message === 'Upsert' ? { title: 'Changed' } : { Targets: [{ '@odata.id': `accounts(${a})`, title: 'Changed' }] },
    );
    assert.ok(response.status < 300, await response.text());
    assert.equal(f.store.tableRows('account')[0].title, 'Changed');
    assert.equal(f.calls(), 0);
    // An explicit update does not claim to execute Upsert.
    assert.equal((await f.request('PATCH', `/accounts(${a})`, { title: 'Update' }, { 'if-match': '*' })).status, 200);
  });

// SetState is absent: its registered steps never execute natively (it runs as SetStateDynamicEntity).
// Assign runs its pipeline (its PreOperation guard stops it before the owner write); GrantAccess is no SOAP message
// here; the batch messages have no pipeline and refuse the chosen step.
// @test-kind unproven: Assign's SOAP pipeline is a local model (no native capture of a SOAP-issued Assign)
for (const message of ['Assign', 'ExecuteMultiple', 'ExecuteTransaction', 'GrantAccess'])
  test(`SOAP ${message} applies no effect when its chosen step refuses or has no pipeline`, async (t) => {
    const f = await fixture(t, message);
    const targetKey = message === 'SetState' ? 'EntityMoniker' : 'Target';
    const assignee =
      message === 'Assign'
        ? `<a:KeyValuePairOfstringanyType><b:key>Assignee</b:key><b:value i:type="a:EntityReference"><a:Id>${b}</a:Id><a:LogicalName>systemuser</a:LogicalName></b:value></a:KeyValuePairOfstringanyType>`
        : '';
    const declarations = Object.entries(NS)
      .map(([key, uri]) => `xmlns:${key}="${uri}"`)
      .join(' ');
    const xml = `<s:Envelope ${declarations}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:${message}Request"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>${targetKey}</b:key><b:value i:type="a:EntityReference"><a:Id>${a}</a:Id><a:LogicalName>account</a:LogicalName></b:value></a:KeyValuePairOfstringanyType>${assignee}</a:Parameters><a:RequestName>${message}</a:RequestName></request></Execute></s:Body></s:Envelope>`;
    const before = structuredClone(f.store.tableRows('account'));
    const result = await handleSoap(
      {
        method: 'POST',
        headers: {},
        bodyText: xml,
        user: {},
        caller: {},
        identity: { admin: true },
        origin: f.server.origin,
        version: 'v9.2',
      },
      f.api,
    );
    assert.match(
      result.body,
      message === 'Assign'
        ? /Named guard/
        : message === 'GrantAccess'
          ? /not simulated by the SOAP service/
          : /plug-in pipeline is not implemented/,
    );
    assert.deepEqual(f.store.tableRows('account'), before);
    assert.equal(f.calls(), message === 'Assign' ? 1 : 0);
  });
