// Power Fx-backed custom APIs (Dataverse Functions) and automated low-code plug-ins route through api.providers.powerFx:
// with the engine explicitly disabled a Function and a write an automated plug-in covers answer 501
// PowerFxEvaluatorMissing (never default outputs, never an unchanged row; POWERFX_AUTOMATED_NOT_EVALUATED once); with a
// pack adapter the result is returned or applied. The core engine's behaviour is in power-fx-dataverse.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { describeCustomApis, powerFxRequirements } from '../lib/dataverse-customapi.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const FX = '77777777-7777-4777-8777-777777777710';
const AUTO = '77777777-7777-4777-8777-777777777711';
const ids = { add: '77777777-7777-4777-8777-777777777712', plain: '77777777-7777-4777-8777-777777777713' };

// An adapter: '{ Z: X + Y }' adds, 'Upper' upper-cases ThisRecord.x_name. Synchronous, as a pack may export it.
const adapter = { evaluate: (expression, { values }) => (expression === 'Upper' ? { value: { x_name: String(values.ThisRecord.x_name).toUpperCase() } } : { value: { Z: values.X + values.Y } }) };

async function organization(t, { withAdapter }) {
  const variable = `PAQVILO_POWERFX_${process.pid}_${Math.random().toString(36).slice(2).toUpperCase()}`;
  process.env[variable] = 'invented';
  t.after(() => { delete process.env[variable]; });
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' } } };
  state.tables.x_item = [];
  state.tables.fxexpression = [
    { fxexpressionid: FX, name: 'x_Add', uniquename: 'x_Add', expression: '{ Z: X + Y }', statecode: 0 },
    { fxexpressionid: AUTO, name: 'x_Upper', uniquename: 'x_Upper', expression: 'Upper', messagename: 'Create', entitylogicalname: 'x_item', statecode: 0 },
  ];
  state.tables.customapi = [
    { customapiid: ids.add, uniquename: 'x_Add', name: 'x_Add', bindingtype: 0, isfunction: false, fxexpressionid: { id: FX, logical_name: 'fxexpression' } },
    { customapiid: ids.plain, uniquename: 'x_Plain', name: 'x_Plain', bindingtype: 0, isfunction: false },
  ];
  state.tables.customapirequestparameter = ['X', 'Y'].map((name, index) => ({ customapirequestparameterid: `77777777-7777-4777-8777-77777777772${index}`, uniquename: name, name, type: 6, isoptional: false, customapiid: ids.add }));
  state.tables.customapiresponseproperty = [
    { customapiresponsepropertyid: '77777777-7777-4777-8777-777777777730', uniquename: 'Z', name: 'Z', type: 7, customapiid: ids.add },
    { customapiresponsepropertyid: '77777777-7777-4777-8777-777777777731', uniquename: 'Out', name: 'Out', type: 10, customapiid: ids.plain },
  ];
  const store = await new DataStore({ state }).init();
  const diagnostics = [];
  const providers = { powerFx: createPowerFxEvaluator(withAdapter === 'disabled' ? { engine: false } : withAdapter ? { adapter: withAdapter === true ? adapter : withAdapter } : {}) };
  const runtime = await createOrganizationRuntime({ store, providers, diagnostic: (entry) => diagnostics.push(entry), extensions: await sourceOrganizationExtensions({}),
    settings: dataverseSettings({ enabled: true, applications: [{ appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] }] }) });
  const transport = await startDataverseApi({ organization: runtime });
  t.after(async () => { await transport.close(); await runtime.close(); });
  const token = (await (await fetch(transport.authority + '/oauth2/v2.0/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: APP, client_secret: 'invented', scope: transport.origin + '/.default' }) })).json()).access_token;
  const call = async (method, route, value) => {
    const response = await fetch(transport.origin + '/api/data/v9.2/' + route, { method,
      headers: { authorization: `Bearer ${token}`, prefer: 'return=representation', ...(value ? { 'content-type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { store, runtime, call, diagnostics, providers };
}

test('with the engine disabled a Function answers 501 PowerFxEvaluatorMissing and a plain custom API keeps its default outputs', async (t) => {
  const { call } = await organization(t, { withAdapter: 'disabled' });
  const fx = await call('POST', 'x_Add', { X: 2, Y: 3 });
  assert.equal(fx.status, 501, JSON.stringify(fx.body));
  assert.match(fx.body.error.message, /the Power Fx engine is disabled/);
  const plain = await call('POST', 'x_Plain', {});
  assert.equal(plain.status, 200);
  assert.equal(plain.body.Out, null, 'a custom API without fxexpressionid and without a handler keeps the documented defaults');
});

test('with a pack adapter a Function returns the evaluated record', async (t) => {
  const { call } = await organization(t, { withAdapter: true });
  const fx = await call('POST', 'x_Add', { X: 2, Y: 3 });
  assert.equal(fx.status, 200, JSON.stringify(fx.body));
  assert.equal(fx.body.Z, 5);
});

test('an automated low-code plug-in changes the target pre-operation with an adapter; with the engine disabled the write answers 501', async (t) => {
  const evaluated = await organization(t, { withAdapter: true });
  const created = await evaluated.call('POST', 'x_items', { x_name: 'invented' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.x_name, 'INVENTED');

  // Never stored unchanged (a row the plug-in changes natively): 501 PowerFxEvaluatorMissing, the diagnostic once.
  const refused = await organization(t, { withAdapter: 'disabled' });
  for (const name of ['first', 'second']) {
    const answer = await refused.call('POST', 'x_items', { x_name: name });
    assert.equal(answer.status, 501, JSON.stringify(answer.body));
    assert.match(answer.body.error.message, /the Power Fx engine is disabled/);
  }
  assert.equal(refused.store.tableRows('x_item').length, 0);
  assert.equal(refused.diagnostics.filter((entry) => entry.code === 'POWERFX_AUTOMATED_NOT_EVALUATED').length, 1);
});

const SDK_USER = '77777777-7777-4777-8777-777777777790';
const sdkOf = (store) => localOrganizationService(store, { userId: SDK_USER, evidence: 'invented test grant', grants: [{ entity: 'x_item', operations: ['read', 'create'] }] });

test('a synchronous SDK create runs the automated plug-in inline with a synchronous adapter', async (t) => {
  const { store } = await organization(t, { withAdapter: true });
  const row = sdkOf(store).create('x_item', { x_name: 'sdk' });
  assert.equal(row.x_name, 'SDK');
  assert.equal(store.tableRows('x_item').find((item) => item.x_itemid === row.x_itemid)?.x_name, 'SDK');
});

test('a synchronous SDK create refuses an async-only adapter before storing (SdkAsyncPreOperationUnsupported)', async (t) => {
  const { store } = await organization(t, { withAdapter: { evaluate: async () => ({ value: { x_name: 'LATE' } }) } });
  assert.throws(() => sdkOf(store).create('x_item', { x_name: 'sdk' }), (error) => error.status === 501 && error.code === 'SdkAsyncPreOperationUnsupported' && /dataverse-customapi/.test(error.message));
  assert.equal(store.tableRows('x_item').length, 0);
});

test('a bind on a name that is not a navigation (FxExpressionId) answers 400 0x80048d19 and creates nothing', async (t) => {
  const { call, store } = await organization(t, { withAdapter: true });
  const before = store.tableRows('customapi').length;
  const answer = await call('POST', 'customapis', { uniquename: 'x_Bound', name: 'x_Bound', bindingtype: 0, isfunction: true, 'FxExpressionId@odata.bind': `/fxexpressions(${FX})` });
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, '0x80048d19');
  assert.match(answer.body.error.message, /An undeclared property 'FxExpressionId'/);
  assert.equal(store.tableRows('customapi').length, before);
});

test('the capability record and the preflight rows follow the adapter', async (t) => {
  const absent = await organization(t, { withAdapter: 'disabled' });
  const record = describeCustomApis(absent.runtime.api);
  const level = (name) => record.operations.find((operation) => operation.name === name)?.level;
  assert.equal(level('function:x_Add'), 'contract');
  assert.equal(level('automated:x_Upper'), 'contract');
  assert.equal(record.level, 'contract');
  const rows = powerFxRequirements(absent.store, absent.providers.powerFx);
  assert.deepEqual(rows.map((row) => [row.id, row.reachable]), [['power-fx:evaluator', false], ['power-fx:evaluator', false]]);
  const present = await organization(t, { withAdapter: true });
  assert.equal(describeCustomApis(present.runtime.api).operations.find((operation) => operation.name === 'function:x_Add').level, 'behaviour');
  assert.deepEqual(powerFxRequirements(present.store, present.providers.powerFx), [], 'no power-fx:evaluator requirement while an evaluator answers');
  const core = await organization(t, { withAdapter: false });
  assert.equal(describeCustomApis(core.runtime.api).level, 'behaviour');
  assert.deepEqual(powerFxRequirements(core.store, core.providers.powerFx), [], 'the core engine satisfies every Power Fx-backed operation');
});
