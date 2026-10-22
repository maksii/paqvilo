// The canvas runtime on the engine's host contract: delegation (a delegable gallery pushes its filter down without a
// warning, a non-delegable one reads up to the row limit with the delegation warning), display-name aliases, a genuine
// formula cycle, and behaviour functions nested inside expressions behaving as at statement level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { fixtureApp, organization } from './canvas-runtime-fixture.mjs';

async function start(t, options = {}) {
  const org = await organization(t, options);
  const instance = createCanvasApp({ app: await fixtureApp(options.files), evaluator: createPowerFxEvaluator(), principal: org[options.principal ?? 'admin'], api: org.api, caller: org.caller });
  await instance.start();
  return { org, instance };
}

test('a ForAll whose writes are refused records the errors (Basic User, 403) and writes nothing', async t => {
  const { org, instance } = await start(t, { principal: 'basic' });
  const outcome = await instance.act({ action: 'run', formula: 'ForAll(Sequence(2), Patch(Widgets, Defaults(Widgets), {fx_name: "Many"}))' });
  assert.ok(outcome.errors.length >= 1, JSON.stringify(outcome.errors));
  assert.ok(outcome.errors.every(error => error.status === 403));
  assert.ok(!org.store.state.tables.fx_widget.some(row => row.fx_name === 'Many'));
});

test('Navigate in App.OnStart opens that screen and runs only its OnVisible', async t => {
  const files = { 'Src/App.pa.yaml': 'App:\n  Properties:\n    OnStart: =Navigate(SecondScreen)\n',
    'Src/FirstScreen.pa.yaml': 'Screens:\n  FirstScreen:\n    Properties:\n      OnVisible: =Set(fxFirst, true)\n',
    'Src/SecondScreen.pa.yaml': 'Screens:\n  SecondScreen:\n    Properties:\n      OnVisible: =Set(fxSecond, true)\n' };
  const { instance } = await start(t, { files });
  const snapshot = instance.snapshot();
  assert.equal(snapshot.currentScreen, 'SecondScreen');
  assert.deepEqual(snapshot.history, ['SecondScreen']);
  assert.deepEqual(snapshot.variables, { fxSecond: true });
});

test('Back() answers false with no earlier screen and true after a navigation', async t => {
  const { instance } = await start(t);
  assert.equal((await instance.act({ action: 'run', formula: 'Set(fxBack, Back())' })).snapshot.variables.fxBack, false);
  await instance.act({ action: 'navigate', screen: 'DetailScreen' });
  const back = await instance.act({ action: 'run', formula: 'Set(fxBack, Back())' });
  assert.equal(back.snapshot.variables.fxBack, true);
  assert.equal(back.snapshot.currentScreen, 'HomeScreen');
});
const control = (snapshot, screen, name) => snapshot.screens.find(entry => entry.name === screen).controls.find(entry => entry.name === name);
const delegation = snapshot => snapshot.diagnostics.filter(entry => entry.code === 'POWERFX_DELEGATION');

test('a delegable gallery filter pushes down with no warning; a non-delegable one warns and stops at the data row limit', async t => {
  const rows = Array.from({ length: 503 }, (_, index) => ({ fx_widgetid: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`, fx_name: `Widget ${index}` }));
  const { instance } = await start(t, { rows });
  const snapshot = (await instance.act({ action: 'input', control: 'SearchBox', value: 'Widget 50' })).snapshot;
  // StartsWith is delegable (Learn delegation table): every match, more than one page of the limit would allow.
  assert.equal(control(snapshot, 'HomeScreen', 'WidgetGallery').properties.AllItems.length, 4);
  const warnings = delegation(snapshot);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.equal(warnings[0].source, 'LongNames.Items');
  assert.equal(warnings[0].truncated, true);
  // Len is not delegable: the first 500 rows are filtered in memory.
  assert.equal(control(snapshot, 'HomeScreen', 'LongNames').properties.AllItems.length, 500);
});

test("rows expose display-name aliases: ThisItem.'Widget Name' and a Patch by display name resolve to fx_name", async t => {
  const { org, instance } = await start(t);
  assert.deepEqual(control(instance.snapshot(), 'HomeScreen', 'WidgetGallery').items.map(item => item.controls.WidgetTitle.Text), ['Alpha', 'Beta']);
  await instance.act({ action: 'input', control: 'SearchBox', value: 'Kappa' });
  const { snapshot, errors } = await instance.act({ action: 'select', control: 'NestedButton' });
  assert.deepEqual(errors, []);
  assert.ok(org.store.state.tables.fx_widget.some(row => row.fx_name === 'Kappa'));
  assert.equal(snapshot.variables.fxCreated.fx_name, 'Kappa');
});

test('a Patch nested in If runs only when its branch is taken, as at statement level', async t => {
  const { org, instance } = await start(t);
  const before = org.store.state.tables.fx_widget.length;
  const { errors, snapshot } = await instance.act({ action: 'select', control: 'NestedButton' }); // SearchBox is blank
  assert.deepEqual(errors, []);
  assert.equal(org.store.state.tables.fx_widget.length, before);
  assert.equal(snapshot.variables.fxCreated, undefined);
  const nested = await instance.act({ action: 'run', formula: 'If(true, Collect(fxPicked, {fx_name: "x"})); If(false, Collect(fxPicked, {fx_name: "y"}))' });
  assert.deepEqual(nested.errors, []);
  assert.deepEqual(nested.snapshot.collections.fxPicked, [{ fx_name: 'x' }]);
});

test('a genuine formula cycle records CANVAS_FORMULA_CYCLE naming the properties and reads blank', async t => {
  const { instance } = await start(t);
  const snapshot = instance.snapshot();
  assert.equal(control(snapshot, 'DetailScreen', 'CycleA').properties.Text, null);
  const cycle = snapshot.diagnostics.find(entry => entry.code === 'CANVAS_FORMULA_CYCLE');
  assert.deepEqual(cycle.properties, ['CycleA.Text', 'CycleB.Text', 'CycleA.Text']);
  // The form's card and input read each other through Parent without a cycle.
  assert.ok(!snapshot.diagnostics.some(entry => entry.code === 'CANVAS_FORMULA_CYCLE' && /Name/.test(entry.message)));
});
