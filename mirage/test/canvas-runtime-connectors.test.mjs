// Connector operations run where the engine calls them (an untaken If branch calls nothing, a taken one calls once and
// uses the answer; writes before the call happen once), property formulas wait for their connector answer, and the driver
// API keeps every digit of an exact decimal.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { stringify } from 'yaml';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { createCanvasApp, createCanvasRuntime } from '../lib/canvas-runtime.mjs';
import { createCanvasHandler } from '../lib/canvas-http.mjs';
import { fixtureApp, organization } from './canvas-runtime-fixture.mjs';

const files = {
  'Src/App.pa.yaml': stringify({ App: { Properties: {} }, DataSources: {
    Widgets: { Type: 'Table', Parameters: { TableLogicalName: 'fx_widget' } }, Svc: { Type: 'Actions', ConnectorId: 'shared_fxinvented' } } }),
  'Src/HomeScreen.pa.yaml': stringify({ Screens: { HomeScreen: { Children: [
    { UntakenButton: { Control: 'Classic/Button@2.2.0', Properties: { OnSelect: '=If(false, Set(fxReply, Svc.Echo({text: "no"}).text))' } } },
    { TakenButton: { Control: 'Classic/Button@2.2.0', Properties: {
      OnSelect: '=Patch(Widgets, Defaults(Widgets), {fx_name: "Before"}); If(true, Set(fxReply, Svc.Echo({text: "yes"}).text)); Notify("Done")' } } },
    { ReplyLabel: { Control: 'Label@2.5.1', Properties: { Text: '=Svc.Echo({text: "label"}).text' } } },
  ] } } }),
};

async function start(t) {
  const org = await organization(t);
  const calls = [];
  const connectors = async ({ reference, operationId, body }) => { calls.push([reference.apiId, operationId, body.text]); return { text: `echo ${body.text}` }; };
  const app = await fixtureApp(files);
  const launched = [];
  const instance = createCanvasApp({ app, evaluator: createPowerFxEvaluator(), principal: org.admin, api: org.api, caller: org.caller, connectors, launch: entry => launched.push(entry) });
  await instance.start();
  return { org, calls, instance, app, connectors, launched };
}
const label = snapshot => snapshot.screens[0].controls.find(control => control.name === 'ReplyLabel').properties.Text;

test('a connector call in an untaken If branch is never made', async t => {
  const { calls, instance } = await start(t);
  const before = calls.length;
  const { errors, snapshot } = await instance.act({ action: 'select', control: 'UntakenButton' });
  assert.deepEqual(errors, []);
  assert.equal(calls.length, before);
  assert.equal(snapshot.variables.fxReply, undefined);
});

test('a taken branch calls the connector once, uses its answer, and the write before it happens once', async t => {
  const { org, calls, instance } = await start(t);
  const before = calls.length;
  const { errors, snapshot } = await instance.act({ action: 'select', control: 'TakenButton' });
  assert.deepEqual(errors, []);
  assert.deepEqual(calls.slice(before), [['shared_fxinvented', 'Echo', 'yes']]);
  assert.equal(snapshot.variables.fxReply, 'echo yes');
  assert.equal(org.store.state.tables.fx_widget.filter(row => row.fx_name === 'Before').length, 1);
  assert.deepEqual(snapshot.notifications.map(item => item.message), ['Done']);
});

test('a property formula reads its connector answer once it has arrived', async t => {
  const { calls, instance } = await start(t);
  assert.equal(label(instance.snapshot()), 'echo label');
  assert.equal(calls.filter(call => call[2] === 'label').length, 1);
  await instance.act({ action: 'refresh' });
  assert.equal(calls.filter(call => call[2] === 'label').length, 2);
});

test('the driver API keeps every digit of an exact decimal', async t => {
  const org = await organization(t);
  const app = await fixtureApp(files);
  const runtime = createCanvasRuntime({ apps: () => [app], evaluator: createPowerFxEvaluator(), api: org.api, caller: org.caller, connectors: async () => ({ text: '' }) });
  const handler = createCanvasHandler({ apps: () => [app], runtime, principal: () => org.admin, csrf: () => 'fx-token' });
  const server = http.createServer((req, res) => { if (!handler(req, res)) { res.writeHead(418); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/_apps/api/canvas/fx_inventedcanvas`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': 'fx-token' },
    body: JSON.stringify({ action: 'run', formula: 'Set(fxBig, Value("1234567890123456789.012345678") + 0); Set(fxSafe, Value("9007199254740993"))' }) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /"fxBig":1234567890123456789\.012345678[,}]/);
  assert.match(text, /"fxSafe":9007199254740993[,}]/);
});

test('connector answers follow call order: Now() or a just-created id in the arguments still makes one call', async t => {
  const { org, calls, instance, launched } = await start(t);
  const before = calls.length;
  const { errors, snapshot } = await instance.act({ action: 'run', formula:
    'Set(fxRow, Patch(Widgets, Defaults(Widgets), {fx_name: "Order"})); Launch("https://example.test/a"); Set(fxReply, Svc.Echo({text: Text(Now()) & Text(fxRow.fx_widgetid)}).text); Set(fxSecond, Svc.Echo({text: "two"}).text)' });
  assert.deepEqual(errors, []);
  assert.deepEqual(calls.slice(before).map(call => call[1]), ['Echo', 'Echo']);
  assert.match(snapshot.variables.fxReply, /^echo /);
  assert.equal(snapshot.variables.fxSecond, 'echo two');
  assert.equal(org.store.state.tables.fx_widget.filter(row => row.fx_name === 'Order').length, 1);
  // The Launch before the connector call reaches the host once, although the formula ran three times.
  assert.equal(snapshot.launches.length, 1);
  assert.equal(launched.length, 1);
});

// A provider answers { statusCode, body } (connector-runtime.mjs invoke); Fail answers 404, Throw throws.
async function httpStart(t) {
  const org = await organization(t);
  const sent = [];
  const connectors = async ({ operationId, body }) => {
    sent.push([operationId, body]);
    if (operationId === 'Fail') return { statusCode: 404, body: { error: { message: 'invented missing' } } };
    if (operationId === 'Throw') throw Object.assign(new Error('invented provider down'), { status: 502, code: 'ProviderFailed' });
    return { statusCode: 200, body: { text: `echo ${body.text}` } };
  };
  const instance = createCanvasApp({ app: await fixtureApp(files), evaluator: createPowerFxEvaluator(), principal: org.admin, api: org.api, caller: org.caller, connectors });
  await instance.start();
  return { org, sent, instance };
}

test('a Patch before a connector call commits the id the connector was sent; GUID() keeps its value across the replay', async t => {
  const { org, sent, instance } = await httpStart(t);
  const { errors, snapshot } = await instance.act({ action: 'run', formula:
    'Set(fxRow, Patch(Widgets, Defaults(Widgets), {fx_name: "Sixty"})); Set(fxG, GUID()); Set(fxReply, Svc.Echo({text: Text(fxRow.fx_widgetid) & "|" & Text(fxG)}).text)' });
  assert.deepEqual(errors, []);
  const committed = org.store.state.tables.fx_widget.filter(row => row.fx_name === 'Sixty').map(row => row.fx_widgetid);
  assert.equal(committed.length, 1);
  assert.equal(sent.at(-1)[1].text, `${committed[0]}|${snapshot.variables.fxG}`);
  assert.equal(snapshot.variables.fxReply, `echo ${committed[0]}|${snapshot.variables.fxG}`);
});

test('a connector failure is an error value: IfError sees Kind Network with Details, later statements run, unhandled it is the result', async t => {
  const { instance } = await httpStart(t);
  let { errors, snapshot } = await instance.act({ action: 'run', formula:
    'Set(fxKind, IfError(Svc.Fail({text: "x"}).text, FirstError.Kind & "/" & FirstError.Details.HttpStatusCode & "/" & FirstError.Details.HttpResponse)); Set(fxAfter, "ran")' });
  assert.deepEqual(errors, []);
  assert.equal(snapshot.variables.fxKind, '23/404/{"error":{"message":"invented missing"}}');
  assert.equal(snapshot.variables.fxAfter, 'ran');
  ({ errors, snapshot } = await instance.act({ action: 'run', formula: 'Set(fxIs, IsError(Svc.Throw({text: "x"}))); Set(fxAfter2, "ran")' }));
  assert.deepEqual(errors, []);
  assert.equal(snapshot.variables.fxIs, true);
  assert.equal(snapshot.variables.fxAfter2, 'ran');
  ({ errors, snapshot } = await instance.act({ action: 'run', formula: 'Svc.Fail({text: "x"}); Set(fxAfter3, "ran")' }));
  assert.deepEqual(errors.map(error => [error.kind, error.status, error.message]), [['Network', 404, 'Svc.Fail failed: invented missing']]);
  assert.equal(snapshot.variables.fxAfter3, 'ran');
});

test('a connector operation that is not simulated is NotSupported (20) without network Details', async t => {
  const org = await organization(t);
  const app = await fixtureApp(files);
  const instance = createCanvasApp({ app, evaluator: createPowerFxEvaluator(), principal: org.admin, api: org.api, caller: org.caller, connectors: async () => undefined });
  await instance.start();
  const { errors, snapshot } = await instance.act({ action: 'run', formula: 'Set(fxKind, IfError(Svc.Echo({text: "x"}).text, FirstError.Kind)); Svc.Echo({text: "y"})' });
  assert.equal(snapshot.variables.fxKind, 20);
  assert.deepEqual(errors.map(error => [error.kind, error.status]), [['NotSupported', undefined]]);
});
