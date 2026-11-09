// @test-kind parity: reproduced native Canvas v5/v6 flows qualify direct-card versus nested input resets, authored DefaultMode, Back/OnVisible delivery and positive en-US date/time values.
// @parity-evidence: canvas-form-reset-native.json protects two source-bound runs of each isolated native probe, original OnVisible bytes, exact producers and positive callback markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { powerFxEngine } from '../lib/power-fx.mjs';
import { fixtureApp, organization } from './canvas-runtime-fixture.mjs';
import { canvasDraftInputFiles } from './fixtures/canvas-draft-input.mjs';
const file = new URL('./fixtures/canvas-form-reset-native.json', import.meta.url);
const evidence = JSON.parse(fs.readFileSync(file));
test('native form-reset evidence binds original source preservation, repeated results and the exact producers', () => {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(fs.readFileSync(file)), 'c25852ab3809dbe7813925668f1575385f84e1f158e2804b58105b6cb2d67453');
  assert.equal(evidence.sourceAppPreserved, true);
  assert.equal(evidence.originalAppSha256, 'b22a13aa82f398a6290bae806a9c65c52a9009f977a3931d05fb8950d6f54860');
  assert.equal(evidence.captures.length, 2);
  assert.equal(evidence.captures[0].producerSha256, '9387714515e5457cf5bcf32a0785b35f703a4e099cac32e6f10420fc6f6027ed');
  assert.equal(evidence.captures[1].producerSha256, '05574554e09c96548f9b028dab57ae7a74f1a0b5e4bfd3dfacc30b157730c4ab');
  for (const capture of evidence.captures) {
    assert.equal(capture.rawSha256.length, 2);
    assert.equal(capture.rawSha256[0], capture.rawSha256[1]);
    assert.equal(capture.originalOnVisibleUnchanged, true);
    assert.equal(capture.originalOnVisibleSha256, 'b5df590154353cfa85e14e6346a0aeaae45867740a050e69751987abe925af3e');
    assert.equal(capture.canary, true);
    assert.equal(capture.saved, false);
  }
});
const control = (name, type, properties) => ({ [name]: { Control: type, Properties: properties } });
function sourceFiles() {
  const files = { ...canvasDraftInputFiles },
    app = parse(files['Src/App.pa.yaml']);
  app.DataSources.Drafts.Parameters.TableLogicalName = 'fx_widget';
  files['Src/App.pa.yaml'] = stringify(app);
  const draft = parse(files['Src/Draft.pa.yaml']),
    screen = draft.Screens.Draft;
  screen.Properties.OnVisible = '=ResetForm(DraftForm); Set(discardMarker,false)';
  const form = screen.Children.find((row) => row.DraftForm).DraftForm;
  form.Properties.OnReset = '=Set(resetMarker,!Coalesce(resetMarker,false))';
  const card = form.Children.find((row) => row.MultiCard).MultiCard,
    container = card.Children.find((row) => row.MultiContainer).MultiContainer;
  card.Children.push(container.Children.shift());
  screen.Children.push(
    control('ResetOnly', 'Classic/Button@2.2.0', { OnSelect: '=ResetForm(DraftForm)' }),
    control('ExplicitNew', 'Classic/Button@2.2.0', { OnSelect: '=NewForm(DraftForm); Set(discardMarker,true)' }),
    control('ToggleMode', 'Classic/Button@2.2.0', {
      OnSelect: '=Set(draftMode,If(draftMode=FormMode.New,FormMode.Edit,FormMode.New))',
    }),
  );
  files['Src/Draft.pa.yaml'] = stringify(draft);
  const confirmation = parse(files['Src/Confirmation.pa.yaml']);
  confirmation.Screens.Confirmation.Properties = { OnVisible: '=Set(discardMarker,true)' };
  confirmation.Screens.Confirmation.Children.find((row) => row.KeepDraft).KeepDraft.Properties.OnSelect =
    '=Set(discardMarker,true); Back()';
  files['Src/Confirmation.pa.yaml'] = stringify(confirmation);
  return files;
}
test('native ResetForm and NewForm reset direct-card controls, preserve nested inputs and deliver Back OnVisible', async (t) => {
  const org = await organization(t);
  const instance = createCanvasApp({
    app: await fixtureApp(sourceFiles()),
    evaluator: createPowerFxEvaluator(),
    principal: org.admin,
    api: org.api,
    caller: org.caller,
  });
  await instance.start();
  const select = async (control) => {
    const result = await instance.act({ action: 'select', control });
    assert.deepEqual(result.errors, []);
  };
  const read = () => {
    const snapshot = instance.snapshot(),
      items = snapshot.screens.find((row) => row.name === 'Draft').controls,
      props = (name) => items.find((row) => row.name === name).properties,
      mode = props('DraftForm').Mode.toLowerCase(),
      singleVisible = props('SingleInput').Visible,
      multiVisible = props('MultiInput').Visible;
    return {
      state: `Paqvilo mode=${mode};default=${snapshot.variables.draftMode.toLowerCase()};discard=${Boolean(snapshot.variables.discardMarker)};reset=${Boolean(snapshot.variables.resetMarker)}`,
      header: `Paqvilo header discard=${Boolean(snapshot.variables.discardMarker)}`,
      singleVisible,
      multiVisible,
      single: singleVisible ? props('SingleInput').Text : null,
      multi: multiVisible ? props('MultiInput').Text : null,
    };
  };
  const write = async () => {
    await instance.act({ action: 'input', control: 'SingleInput', value: 'Invented reset diagnostic' });
    await instance.act({ action: 'input', control: 'MultiInput', value: 'Invented retained comment' });
  };
  await select('OpenDraft');
  const snapshots = { initial: read() };
  await write();
  snapshots.edited = read();
  await select('CancelDraft');
  snapshots.confirmationHeader = `Paqvilo header discard=${Boolean(instance.snapshot().variables.discardMarker)}`;
  await select('KeepDraft');
  snapshots.afterBack = read();
  await select('ResetOnly');
  snapshots.implicitReset = read();
  await select('ExplicitNew');
  snapshots.explicitNew = read();
  await write();
  snapshots.explicitEdited = read();
  await select('ResetOnly');
  snapshots.explicitReset = read();
  assert.deepEqual(snapshots, evidence.captures[1].snapshots);
  await select('ToggleMode');
  const edit = read(),
    nativeEdit = evidence.captures[0].snapshots.toggleOne;
  assert.equal(edit.state.split(';').slice(0, 2).join(';'), nativeEdit.state.split(';').slice(0, 2).join(';'));
  for (const key of ['singleVisible', 'multiVisible', 'single', 'multi']) assert.deepEqual(edit[key], nativeEdit[key]);
  await select('ToggleMode');
  const reopened = read(),
    nativeReopened = evidence.captures[0].snapshots.toggleTwo;
  for (const key of ['singleVisible', 'multiVisible', 'single', 'multi'])
    assert.deepEqual(reopened[key], nativeReopened[key]);
});
// @parity-evidence: canvas-form-reset-native.json binds two native Canvas v5/v6 runs; app: 'canvas' selects that evidenced host profile while preserving the exact expressions and expected scalar values.
test('native positive time and numeric slash-date components reproduce the observed en-US values', () => {
  const run = (formula) =>
    powerFxEngine.evaluateSync(formula, { host: { app: 'canvas', timeZone: 'UTC', variables: {}, context: {} } }).value;
  assert.equal(
    'Paqvilo Time=' +
      run('Text(TimeValue("25:00","en-US"),"hh:mm:ss","en-US")') +
      ';parts=' +
      ['Hour', 'Minute', 'Second'].map((name) => run(`${name}(TimeValue("25:00","en-US"))`)).join(','),
    evidence.captures[1].scalar.Time,
  );
  assert.equal(
    'Paqvilo Date=' +
      run('Text(DateValue("13/01/2024","en-US"),"yyyy-mm-dd","en-US")') +
      ';parts=' +
      ['Year', 'Month', 'Day'].map((name) => run(`${name}(DateValue("13/01/2024","en-US"))`)).join(','),
    evidence.captures[1].scalar.Date,
  );
});
