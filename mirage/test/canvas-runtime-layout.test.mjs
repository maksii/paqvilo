import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasApp, createCanvasRuntime } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';

test('viewport resize recomputes responsive screen and nested control formulas', async () => {
  const app = {
    uniqueName: 'responsive',
    source: {
      app: { format: 'pa.yaml' },
      tree: {
        format: 'pa.yaml',
        screens: [
          {
            name: 'Home',
            controls: [
              { name: 'Box', control: 'GroupContainer@1.0.0', variant: 'AutoLayout' },
              { name: 'Caption', control: 'Label@2.5.1', parent: 'Box' },
            ],
          },
        ],
      },
      formulas: [
        { owner: 'App', property: 'MinScreenWidth', text: '=400' },
        { owner: 'Box', property: 'Width', text: '=Parent.Width / 2' },
        { owner: 'Box', property: 'LayoutDirection', text: '=LayoutDirection.Vertical' },
        { owner: 'Caption', property: 'Width', text: '=Parent.Width - Self.X' },
        { owner: 'Caption', property: 'Text', text: '=If(Home.Size >= ScreenSize.Medium, "wide", "small")' },
      ],
    },
  };
  const runtime = createCanvasApp({ app, evaluator: createPowerFxEvaluator() });
  let snapshot = await runtime.start();
  assert.equal(snapshot.rendered, false);
  assert.equal(snapshot.screens[0].controls[0].variant, 'AutoLayout');
  assert.equal(snapshot.screens[0].controls[0].properties.LayoutDirection, 'Vertical');
  assert.equal(snapshot.screens[0].controls[1].properties.Width, 683);
  snapshot = (await runtime.act({ action: 'resize', width: 500, height: 700 })).snapshot;
  assert.deepEqual(snapshot.viewport, { width: 500, height: 700 });
  assert.equal(snapshot.screens[0].properties.Width, 500);
  assert.equal(snapshot.screens[0].properties.Size, 1);
  assert.equal(snapshot.screens[0].properties.Orientation, 'Vertical');
  assert.equal(snapshot.screens[0].controls[1].properties.Width, 250);
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 'small');
  snapshot = (await runtime.act({ action: 'resize', width: 200, height: 700 })).snapshot;
  assert.equal(snapshot.screens[0].properties.Width, 400);
  await assert.rejects(runtime.act({ action: 'resize', width: 0, height: 700 }), { code: 'CanvasActionInvalid' });
  await assert.rejects(runtime.act({ action: 'resize', width: 10.5, height: 700 }), { code: 'CanvasActionInvalid' });
});

test('formula errors identify their source file and line', async () => {
  const app = {
    uniqueName: 'diagnostic',
    source: {
      tree: { screens: [{ name: 'Home', controls: [{ name: 'Bad', control: 'Label@2.5.1' }] }] },
      formulas: [{ owner: 'Bad', property: 'Text', text: '=MissingFunction()', source: 'Src/Home.pa.yaml', line: 12 }],
    },
  };
  const runtime = createCanvasApp({ app, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.ok(
    snapshot.errors.some(
      (error) => error.source === 'Bad.Text' && error.file === 'Src/Home.pa.yaml' && error.line === 12,
    ),
  );
});

test('connector properties recompute when their input changes', async () => {
  const calls = [];
  const app = {
    uniqueName: 'connector',
    source: {
      dataSources: [{ name: 'Svc', connectorId: 'invented' }],
      tree: {
        screens: [
          {
            name: 'Home',
            controls: [
              { name: 'Input', control: 'Classic/TextInput@2.3.2' },
              { name: 'Output', control: 'Label@2.5.1' },
            ],
          },
        ],
      },
      formulas: [{ owner: 'Output', property: 'Text', text: '=Svc.Echo({text: Input.Text}).text' }],
    },
  };
  const runtime = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    connectors: async ({ body }) => {
      calls.push(body.text);
      return { statusCode: 200, body: { text: `echo ${body.text}` } };
    },
  });
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 'echo ');
  snapshot = (await runtime.act({ action: 'input', control: 'Input', value: 'new' })).snapshot;
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 'echo new');
  assert.deepEqual(calls, ['', 'new']);
});

test('initial viewport is validated before OnStart and forwarded to new sessions', async () => {
  const app = {
    uniqueName: 'initial',
    source: {
      tree: { screens: [{ name: 'Home', controls: [] }] },
      formulas: [{ owner: 'App', property: 'OnStart', text: '=Set(initialWidth, App.Width)' }],
    },
  };
  const runtime = createCanvasRuntime({ apps: () => [app], evaluator: createPowerFxEvaluator() });
  await assert.rejects(runtime.session('initial', null, { viewport: { width: 0, height: 844 } }), {
    code: 'CanvasActionInvalid',
  });
  assert.equal(runtime.size, 0);
  const viewport = { width: 390, height: 844 };
  const session = await runtime.session('initial', null, { viewport });
  viewport.width = 100;
  assert.equal(session.snapshot().variables.initialWidth, 390);
  assert.deepEqual(session.snapshot().viewport, { width: 390, height: 844 });
});

test('an unchanged viewport does not repeat a connector-backed property', async () => {
  const widths = [];
  const runtime = createCanvasApp({
    app: {
      uniqueName: 'viewport-connector',
      source: {
        dataSources: [{ name: 'Svc', connectorId: 'invented' }],
        tree: { screens: [{ name: 'Home', controls: [{ name: 'Result', control: 'Label@2.5.1' }] }] },
        formulas: [{ owner: 'Result', property: 'Text', text: '=Svc.Width({width: App.Width}).text' }],
      },
    },
    evaluator: createPowerFxEvaluator(),
    connectors: async ({ body }) => {
      widths.push(body.width);
      return { statusCode: 200, body: { text: String(body.width) } };
    },
  });
  await runtime.start();
  await runtime.act({ action: 'resize', width: 1366, height: 768 });
  assert.deepEqual(widths, [1366]);
  const outcome = await runtime.act({ action: 'resize', width: 390, height: 844 });
  assert.deepEqual(widths, [1366, 390]);
  assert.equal(outcome.snapshot.screens[0].controls[0].properties.Text, '390');
});

test('checkbox and toggle transitions run their change and check callbacks once with the new value', async () => {
  const app = {
    uniqueName: 'checks',
    source: {
      tree: {
        screens: [
          {
            name: 'Home',
            controls: [
              { name: 'Check', control: 'Classic/CheckBox@2.1.0' },
              { name: 'Toggle', control: 'Classic/Toggle@2.1.0' },
            ],
          },
        ],
      },
      formulas: ['Check', 'Toggle'].flatMap((owner) => [
        {
          owner,
          property: 'OnChange',
          text: `=Collect(events, {control: "${owner}", event: "change", value: ${owner}.Value})`,
        },
        {
          owner,
          property: 'OnCheck',
          text: `=Collect(events, {control: "${owner}", event: "check", value: ${owner}.Value})`,
        },
        {
          owner,
          property: 'OnUncheck',
          text: `=Collect(events, {control: "${owner}", event: "uncheck", value: ${owner}.Value})`,
        },
      ]),
    },
  };
  const runtime = createCanvasApp({ app, evaluator: createPowerFxEvaluator() });
  await runtime.start();
  for (const control of ['Check', 'Toggle']) {
    for (const value of [true, true, false, false]) await runtime.act({ action: 'input', control, value });
  }
  assert.deepEqual(
    runtime.snapshot().collections.events,
    ['Check', 'Toggle'].flatMap((control) => [
      { control, event: 'change', value: true },
      { control, event: 'check', value: true },
      { control, event: 'change', value: false },
      { control, event: 'uncheck', value: false },
    ]),
  );
});
