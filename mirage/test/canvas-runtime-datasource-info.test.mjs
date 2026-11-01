import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { fixtureApp, organization } from './canvas-runtime-fixture.mjs';

test('exported data source aliases resolve actual mapped columns', async (t) => {
  const org = await organization(t);
  const app = await fixtureApp();
  app.source.dataSources.find((entry) => entry.name === 'Widgets').fieldAliases = { fx_name: 'Exported Widget Title' };
  const runtime = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    principal: org.basic,
    api: org.api,
    caller: org.caller,
  });
  await runtime.start();
  const result = await runtime.act({
    action: 'evaluate',
    formula: 'LookUp(Widgets, \'Exported Widget Title\' = "Alpha").fx_name',
  });
  assert.equal(result.result, 'Alpha');
});

test('Errors retains caller-scoped write failures and clears on a subsequent successful write', async (t) => {
  const org = await organization(t);
  const app = await fixtureApp();
  const runtime = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    principal: org.basic,
    api: org.api,
    caller: org.caller,
  });
  await runtime.start();
  await runtime.act({
    action: 'run',
    formula: 'IfError(Patch(Widgets, Defaults(Widgets), {fx_name: "Denied"}), false)',
  });
  const errors = (await runtime.act({ action: 'evaluate', formula: 'Errors(Widgets, Blank())' })).result;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].Record, null);
  assert.ok(errors[0].Message);
  const admin = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    principal: org.admin,
    api: org.api,
    caller: org.caller,
  });
  await admin.start();
  assert.deepEqual((await admin.act({ action: 'evaluate', formula: 'Errors(Widgets)' })).result, []);
  await admin.act({
    action: 'run',
    formula:
      'IfError(Patch(Widgets, {fx_widgetid: GUID("77777777-7777-4777-8777-777777777799")}, {fx_name: "Missing"}), false)',
  });
  assert.equal((await admin.act({ action: 'evaluate', formula: 'CountRows(Errors(Widgets))' })).result, 1);
  assert.equal(
    (
      await admin.act({
        action: 'evaluate',
        formula: 'CountRows(Errors(Widgets, {fx_widgetid: GUID("77777777-7777-4777-8777-777777777799")}))',
      })
    ).result,
    1,
  );
  assert.equal(
    (
      await admin.act({
        action: 'evaluate',
        formula: 'CountRows(Errors(Widgets, {fx_widgetid: GUID("77777777-7777-4777-8777-777777777798")}))',
      })
    ).result,
    0,
  );
  await admin.act({ action: 'run', formula: 'Patch(Widgets, Defaults(Widgets), {fx_name: "Allowed"})' });
  assert.deepEqual((await admin.act({ action: 'evaluate', formula: 'Errors(Widgets)' })).result, []);
  await runtime.act({ action: 'run', formula: 'Refresh(Widgets)' });
  assert.deepEqual((await runtime.act({ action: 'evaluate', formula: 'Errors(Widgets)' })).result, []);
});

test('DataSourceInfo reads exported column facts and caller privileges', async (t) => {
  const org = await organization(t);
  Object.assign(org.store.state.mappings.fx_widget.fields.fx_name, {
    requiredLevel: 'applicationrequired',
    maxLength: 42,
  });
  const app = await fixtureApp();
  const runtime = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    principal: org.basic,
    api: org.api,
    caller: org.caller,
  });
  await runtime.start();
  const value = async (formula) => (await runtime.act({ action: 'evaluate', formula })).result;
  assert.equal(await value('DataSourceInfo(Widgets, DataSourceInfo.DisplayName, fx_name)'), 'Widget Name');
  assert.equal(await value('DataSourceInfo(Widgets, DataSourceInfo.Required, fx_name)'), true);
  assert.equal(await value('DataSourceInfo(Widgets, DataSourceInfo.MaxLength, fx_name)'), 42);
  assert.equal(await value('DataSourceInfo(Widgets, DataSourceInfo.ReadPermission)'), true);
  assert.equal(await value('DataSourceInfo(Widgets, DataSourceInfo.CreatePermission)'), false);
  assert.equal(await value('DataSourceInfo(Widgets, DataSourceInfo.Required, unknown)'), false);
  assert.ok(runtime.snapshot().diagnostics.some((entry) => entry.code === 'POWER_FX_DATASOURCE_INFO_UNAVAILABLE'));
});

test('Search uses caller-scoped reads and reports nondelegable evaluation', async (t) => {
  const org = await organization(t);
  const runtime = createCanvasApp({
    app: await fixtureApp(),
    evaluator: createPowerFxEvaluator(),
    principal: org.basic,
    api: org.api,
    caller: org.caller,
  });
  await runtime.start();
  const result = await runtime.act({
    action: 'evaluate',
    formula: 'CountRows(Search(Widgets, "ALP", \'Widget Name\'))',
  });
  assert.equal(result.result, 1);
  assert.ok(
    result.snapshot.diagnostics.some((entry) => entry.code === 'POWERFX_DELEGATION' && entry.operation === 'Search'),
  );
});

test('declared unconfigured data sources report a dependency gap rather than an unknown name or empty table', async () => {
  const source = {
    dataSources: [{ name: 'Unavailable', kind: 'Table', table: 'fixture_missing' }],
    tree: { screens: [{ name: 'Home', controls: [{ name: 'Result', control: 'Label@1' }] }] },
    formulas: [{ owner: 'Result', property: 'Text', text: '=CountRows(Unavailable)' }],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'missing-data', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Text, null);
  assert.ok(snapshot.errors.some((error) => error.source === 'Result.Text' && error.kind === 'NotSupported'));
  assert.ok(
    snapshot.diagnostics.some(
      (entry) => entry.code === 'CANVAS_DATASOURCE_UNAVAILABLE' && entry.source === 'Unavailable',
    ),
  );
  await assert.rejects(runtime.act({ action: 'evaluate', formula: 'CountRows(Undeclared)' }), {
    code: 'PowerFxNameUnknown',
  });
  const choices = await runtime.act({ action: 'evaluate', formula: 'Choices(Unavailable.fx_missing)' });
  assert.equal(choices.result.error[0].kind, 'NotSupported');
  await assert.rejects(runtime.act({ action: 'evaluate', formula: 'Choices(Undeclared.fx_missing)' }), {
    code: 'PowerFxNameUnknown',
  });
});

test('Choices uses exported options and secured lookup targets with bounded diagnostics', async (t) => {
  const org = await organization(t);
  Object.assign(org.store.state.mappings.fx_widget.fields, {
    fx_choice: {
      dataverseType: 'picklist',
      options: [
        { value: 1, label: 'Alpha' },
        { value: 2, label: 'Beta' },
      ],
    },
    fx_parent: { dataverseType: 'lookup', targets: ['fx_widget'] },
    fx_unknown: { dataverseType: 'picklist' },
  });
  org.store.state.mappings.fx_parent = {
    logicalName: 'fx_parent',
    entitySet: 'fx_parents',
    idColumn: 'fx_parentid',
    nameColumn: 'fx_name',
    ownership: 'OrganizationOwned',
    fields: { fx_name: { dataverseType: 'nvarchar' } },
  };
  org.store.state.tables.fx_parent = [
    { fx_parentid: '77777777-7777-4777-8777-777777777801', fx_name: 'First' },
    { fx_parentid: '77777777-7777-4777-8777-777777777802', fx_name: 'Second' },
  ];
  const app = await fixtureApp();
  const admin = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    principal: org.admin,
    api: org.api,
    caller: org.caller,
  });
  await admin.start();
  const options = await admin.act({ action: 'evaluate', formula: 'Choices(Widgets.fx_choice,"b")' });
  assert.deepEqual(options.result, [{ Value: 'Beta', Id: 2 }]);
  assert.ok(options.snapshot.diagnostics.some((entry) => entry.code === 'POWER_FX_CHOICE_APPROXIMATION'));
  const lookup = await admin.act({ action: 'evaluate', formula: 'Choices(Widgets.fx_parent,"Al")' });
  assert.equal(lookup.result.length, 1);
  assert.equal(lookup.result[0].fx_name, 'Alpha');
  assert.ok(
    lookup.snapshot.diagnostics.some((entry) => entry.code === 'POWERFX_DELEGATION' && entry.operation === 'Choices'),
  );
  const missing = await admin.act({ action: 'evaluate', formula: 'Choices(Widgets.fx_unknown)' });
  assert.equal(missing.result.error[0].kind, 'NotSupported');
  assert.ok(missing.snapshot.diagnostics.some((entry) => entry.code === 'POWER_FX_CHOICES_UNAVAILABLE'));
  org.store.state.mappings.fx_widget.fields.fx_parent.targets = ['fx_parent'];
  const alias = await admin.act({ action: 'run', formula: 'Set(alias, Widgets); Choices(alias.fx_choice)' });
  assert.ok(alias.errors.some((entry) => entry.kind === 'NotSupported'));
  const basic = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    principal: org.basic,
    api: org.api,
    caller: org.caller,
  });
  await basic.start();
  await assert.rejects(basic.act({ action: 'evaluate', formula: 'Choices(Widgets.fx_parent)' }), { status: 403 });
});

test('declared local collection is empty before nested population and is not resolved as a provider', async () => {
  const source = {
    dataSources: [{ name: 'LocalRows', kind: 'CollectionDataSourceInfo' }],
    tree: { screens: [{ name: 'Home', controls: [] }] },
    formulas: [
      {
        owner: 'Home',
        property: 'OnVisible',
        text: '=Clear(LocalRows); ForAll([1,2], Collect(LocalRows, {n: Value}))',
      },
    ],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'local-collection', source },
    evaluator: createPowerFxEvaluator(),
  });
  const snapshot = await runtime.start();
  assert.deepEqual(snapshot.collections.LocalRows, [{ n: 1 }, { n: 2 }]);
  assert.equal(snapshot.errors.length, 0);
  assert.ok(!snapshot.diagnostics.some((entry) => entry.code === 'CANVAS_DATASOURCE_UNAVAILABLE'));
});
