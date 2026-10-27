import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { stringify } from 'yaml';
import { fixtureApp } from './canvas-runtime-fixture.mjs';

const parameter = (name, dataType, optional = false, value = null) => ({ name, dataType, optional, default: value });
function componentRuntime() {
  return createCanvasApp({
    app: {
      uniqueName: 'functions',
      source: {
        tree: {
          format: 'pa.yaml',
          components: [
            {
              name: 'Counter',
              definitionType: 'CanvasComponent',
              customProperties: {
                Double: {
                  kind: 'OutputFunction',
                  returnType: 'Number',
                  parameters: [parameter('x', 'Number'), parameter('y', 'Number', true, '=2')],
                },
                Transform: { kind: 'InputFunction', returnType: 'Number', parameters: [parameter('x', 'Number')] },
                Add: { kind: 'Action', returnType: 'None', parameters: [parameter('x', 'Number')] },
                OnAdded: { kind: 'Event', returnType: 'None', parameters: [parameter('x', 'Number')] },
                Output: { kind: 'Output', dataType: 'Number' },
              },
              controls: [],
            },
          ],
          screens: [
            {
              name: 'Home',
              controls: [
                { name: 'One', control: 'CanvasComponent@1', componentName: 'Counter' },
                { name: 'Two', control: 'CanvasComponent@1', componentName: 'Counter' },
                { name: 'Label', control: 'Label@1' },
              ],
            },
          ],
        },
        formulas: [
          { owner: 'App', property: 'OnStart', text: '=Set(x,100)' },
          { owner: 'Counter', property: 'Double', text: '=x * y' },
          {
            owner: 'Counter',
            property: 'Add',
            text: '=Set(total, Coalesce(total, 0) + Counter.Transform(x)); Counter.OnAdded(x)',
          },
          { owner: 'Counter', property: 'Output', text: '=Coalesce(total, 0)' },
          { owner: 'Home.One', property: 'OnAdded', text: '=Set(last, x)' },
          { owner: 'Home.One', property: 'Transform', text: '=x + 3' },
          { owner: 'Label', property: 'Text', text: '=One.Double(3)' },
        ],
      },
    },
    evaluator: createPowerFxEvaluator(),
  });
}

test('component output functions and actions use instance scope, parameters, defaults and callbacks', async () => {
  const runtime = componentRuntime();
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls.find((control) => control.name === 'Label').properties.Text, 6);
  assert.equal(
    Object.hasOwn(snapshot.screens[0].controls.find((control) => control.name === 'One').properties, 'Double'),
    false,
  );
  snapshot = (await runtime.act({ action: 'run', formula: 'One.Add(5); Set(after, One.Output)' })).snapshot;
  assert.equal(snapshot.variables.last, 5);
  assert.equal(snapshot.variables.after, 8);
  assert.equal(snapshot.screens[0].controls.find((control) => control.name === 'Two').properties.Output, 0);
  const outside = await runtime.act({ action: 'run', formula: 'One.OnAdded(5)' });
  assert.ok(outside.errors.some((error) => error.code === 'CanvasComponentActionInvalid'));
  const invalid = await runtime.act({ action: 'run', formula: 'One.Double()' });
  assert.ok(invalid.errors.some((error) => error.code === 'CanvasComponentArgumentInvalid'));
});

test('component action and event callbacks resume connector replay in order without duplicating effects', async () => {
  let calls = 0;
  const source = {
    dataSources: [{ name: 'Svc', connectorId: 'invented' }],
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Worker',
          definitionType: 'CanvasComponent',
          accessAppScope: true,
          customProperties: {
            Run: { kind: 'Action', returnType: 'None', parameters: [parameter('value', 'Number')] },
            OnDone: { kind: 'Event', returnType: 'None', parameters: [parameter('value', 'Number')] },
          },
          controls: [],
        },
      ],
      screens: [{ name: 'Home', controls: [{ name: 'One', control: 'CanvasComponent@1', componentName: 'Worker' }] }],
    },
    formulas: [
      { owner: 'App', property: 'OnStart', text: '=Set(before,0); Set(after,0)' },
      {
        owner: 'Worker',
        property: 'Run',
        text: '=Set(before,before+1); Set(answer,Svc.Echo({value:value}).value); Worker.OnDone(value); Set(after,after+1)',
      },
      { owner: 'Home.One', property: 'OnDone', text: '=Set(callback,value)' },
    ],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'replay-component', source },
    evaluator: createPowerFxEvaluator(),
    connectors: async ({ body }) => {
      calls++;
      return { statusCode: 200, body };
    },
  });
  await runtime.start();
  const result = await runtime.act({ action: 'run', formula: 'One.Run(7); Set(last, after)' });
  assert.deepEqual(result.errors, []);
  assert.equal(calls, 1);
  assert.equal(result.snapshot.variables.before, 1);
  assert.equal(result.snapshot.variables.after, 1);
  assert.equal(result.snapshot.variables.callback, 7);
  assert.equal(result.snapshot.variables.last, 1);
});

test('recursive action calls and unsupported complex types are refused', async () => {
  const source = {
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Comp',
          definitionType: 'CanvasComponent',
          customProperties: {
            Recur: { kind: 'Action', returnType: 'None', parameters: [] },
            ImageArg: { kind: 'Action', returnType: 'None', parameters: [parameter('x', 'Image')] },
          },
          controls: [],
        },
      ],
      screens: [{ name: 'Home', controls: [{ name: 'One', control: 'CanvasComponent@1', componentName: 'Comp' }] }],
    },
    formulas: [
      { owner: 'Comp', property: 'Recur', text: '=Comp.Recur()' },
      { owner: 'Comp', property: 'ImageArg', text: '=true' },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'recursion', source }, evaluator: createPowerFxEvaluator() });
  await runtime.start();
  const recursion = await runtime.act({ action: 'run', formula: 'One.Recur()' });
  assert.ok(recursion.errors.some((error) => error.code === 'CanvasComponentRecursion'));
  const unsupported = await runtime.act({ action: 'run', formula: 'One.ImageArg("x")' });
  assert.ok(unsupported.errors.some((error) => error.code === 'CanvasComponentFunctionUnsupported'));
});

test('component functions retain typed date, record, and table arguments and cannot mutate app state', async () => {
  const source = {
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Fns',
          definitionType: 'CanvasComponent',
          customProperties: {
            DateId: { kind: 'OutputFunction', returnType: 'DateAndTime', parameters: [parameter('x', 'DateAndTime')] },
            RecordId: { kind: 'OutputFunction', returnType: 'Record', parameters: [parameter('x', 'Record')] },
            TableId: { kind: 'OutputFunction', returnType: 'Table', parameters: [parameter('x', 'Table')] },
            Bad: { kind: 'OutputFunction', returnType: 'Boolean', parameters: [] },
          },
          controls: [],
        },
      ],
      screens: [{ name: 'Home', controls: [{ name: 'One', control: 'CanvasComponent@1', componentName: 'Fns' }] }],
    },
    formulas: [
      { owner: 'Fns', property: 'DateId', text: '=x' },
      { owner: 'Fns', property: 'RecordId', text: '=x' },
      { owner: 'Fns', property: 'TableId', text: '=x' },
      { owner: 'Fns', property: 'Bad', text: '=Set(leak,true)' },
    ],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'typed-component', source },
    evaluator: createPowerFxEvaluator(),
  });
  await runtime.start();
  assert.equal((await runtime.act({ action: 'evaluate', formula: 'Year(One.DateId(Date(2026,1,2)))' })).result, 2026);
  assert.equal((await runtime.act({ action: 'evaluate', formula: 'One.RecordId({n:7}).n' })).result, 7);
  assert.equal((await runtime.act({ action: 'evaluate', formula: 'CountRows(One.TableId([1,2]))' })).result, 2);
  const bad = await runtime.act({ action: 'evaluate', formula: 'One.Bad()' });
  assert.ok(bad.result.error);
  assert.equal(runtime.snapshot().variables.leak, undefined);
});

test('v3 YAML preserves callable property parameters and default formulas', async () => {
  const app = await fixtureApp({
    'Src/App.pa.yaml': stringify({ App: { Properties: {} } }),
    'Src/Home.pa.yaml': stringify({
      Screens: {
        Home: {
          Children: [
            { Instance: { Control: 'CanvasComponent@1.0.0', ComponentName: 'Calc' } },
            { Result: { Control: 'Label@1.0.0', Properties: { Text: '=Instance.Scale(4)' } } },
          ],
        },
      },
    }),
    'Src/Component/Calc.pa.yaml': stringify({
      ComponentDefinitions: {
        Calc: {
          DefinitionType: 'CanvasComponent',
          CustomProperties: {
            Scale: {
              PropertyKind: 'OutputFunction',
              ReturnType: 'Number',
              Parameters: [
                { x: { DataType: 'Number' } },
                { factor: { DataType: 'Number', IsOptional: true, Default: '=3' } },
              ],
            },
          },
          Properties: { Scale: '=x * factor' },
        },
      },
    }),
  });
  const runtime = createCanvasApp({ app, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls.find((control) => control.name === 'Result').properties.Text, 12);
});

test('nested component actions resolve the inner instance and its parent callback', async () => {
  const source = {
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Inner',
          definitionType: 'CanvasComponent',
          customProperties: {
            Run: { kind: 'Action', returnType: 'None', parameters: [parameter('x', 'Number')] },
            OnDone: { kind: 'Event', returnType: 'None', parameters: [parameter('x', 'Number')] },
          },
          controls: [],
        },
        {
          name: 'Outer',
          definitionType: 'CanvasComponent',
          customProperties: {
            Start: { kind: 'Action', returnType: 'None', parameters: [parameter('x', 'Number')] },
            Output: { kind: 'Output', dataType: 'Number' },
          },
          controls: [{ name: 'Child', control: 'CanvasComponent@1', componentName: 'Inner' }],
        },
      ],
      screens: [{ name: 'Home', controls: [{ name: 'One', control: 'CanvasComponent@1', componentName: 'Outer' }] }],
    },
    formulas: [
      { owner: 'Inner', property: 'Run', text: '=Inner.OnDone(x)' },
      { owner: 'Outer.Child', property: 'OnDone', text: '=Set(result,x)' },
      { owner: 'Outer', property: 'Start', text: '=Child.Run(x)' },
      { owner: 'Outer', property: 'Output', text: '=result' },
    ],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'nested-action', source },
    evaluator: createPowerFxEvaluator(),
  });
  await runtime.start();
  const result = await runtime.act({ action: 'run', formula: 'One.Start(9)' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.snapshot.screens[0].controls.find((control) => control.name === 'One').properties.Output, 9);
});

test('malformed callable parameter declarations remain explicit source gaps', async () => {
  const app = await fixtureApp({
    'Src/Home.pa.yaml': stringify({
      Screens: { Home: { Children: [{ Instance: { Control: 'CanvasComponent@1.0.0', ComponentName: 'Calc' } }] } },
    }),
    'Src/Component/Calc.pa.yaml': stringify({
      ComponentDefinitions: {
        Calc: {
          DefinitionType: 'CanvasComponent',
          CustomProperties: {
            Scale: { PropertyKind: 'OutputFunction', ReturnType: 'Number', Parameters: [{ x: {} }] },
          },
          Properties: { Scale: '=x' },
        },
      },
    }),
  });
  assert.ok(app.source.diagnostics.some((entry) => entry.code === 'CANVAS_SOURCE_STRUCTURE_INVALID'));
  const runtime = createCanvasApp({ app, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.ok(snapshot.unsupported.some((entry) => entry.name === 'Instance'));
});

test('explicit component reset runs only the selected instance OnReset, not on startup', async () => {
  const source = {
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Widget',
          definitionType: 'CanvasComponent',
          customProperties: { Output: { kind: 'Output', dataType: 'Number' } },
          controls: [],
        },
      ],
      screens: [
        {
          name: 'Home',
          controls: [
            { name: 'One', control: 'CanvasComponent@1', componentName: 'Widget' },
            { name: 'Two', control: 'CanvasComponent@1', componentName: 'Widget' },
          ],
        },
      ],
    },
    formulas: [
      { owner: 'Widget', property: 'Output', text: '=Coalesce(count,0)' },
      { owner: 'Widget', property: 'OnReset', text: '=Set(count,8)' },
    ],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'reset-component', source },
    evaluator: createPowerFxEvaluator(),
  });
  let snapshot = await runtime.start();
  const outputs = () =>
    snapshot.screens[0].controls
      .filter((entry) => ['One', 'Two'].includes(entry.name))
      .map((entry) => entry.properties.Output);
  assert.deepEqual(outputs(), [0, 0]);
  snapshot = (await runtime.act({ action: 'run', formula: 'Reset(One)' })).snapshot;
  assert.deepEqual(outputs(), [8, 0]);
});

test('RaiseOnReset runs only for changed opted-in instance inputs after an action', async () => {
  const source = {
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Widget',
          definitionType: 'CanvasComponent',
          customProperties: {
            Input: { kind: 'Input', dataType: 'Number', raiseOnReset: true },
            Output: { kind: 'Output', dataType: 'Number' },
          },
          controls: [],
        },
      ],
      screens: [
        {
          name: 'Home',
          controls: [
            { name: 'One', control: 'CanvasComponent@1', componentName: 'Widget' },
            { name: 'Two', control: 'CanvasComponent@1', componentName: 'Widget' },
          ],
        },
      ],
    },
    formulas: [
      { owner: 'App', property: 'OnStart', text: '=Set(base,1)' },
      { owner: 'Home.One', property: 'Input', text: '=base' },
      { owner: 'Home.Two', property: 'Input', text: '=10' },
      { owner: 'Widget', property: 'Output', text: '=Coalesce(resets,0)' },
      { owner: 'Widget', property: 'OnReset', text: '=Set(resets,Coalesce(resets,0)+1)' },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'raise-reset', source }, evaluator: createPowerFxEvaluator() });
  let snapshot = await runtime.start();
  const outputs = () =>
    snapshot.screens[0].controls
      .filter((entry) => ['One', 'Two'].includes(entry.name))
      .map((entry) => entry.properties.Output);
  assert.deepEqual(outputs(), [0, 0]);
  snapshot = (await runtime.act({ action: 'run', formula: 'Set(base,2)' })).snapshot;
  assert.deepEqual(outputs(), [1, 0]);
  snapshot = (await runtime.act({ action: 'run', formula: 'Set(base,2)' })).snapshot;
  assert.deepEqual(outputs(), [1, 0]);
  snapshot = await runtime.observe();
  assert.deepEqual(outputs(), [1, 0]);
});

test('RaiseOnReset feedback is bounded and reports a diagnostic', async () => {
  const source = {
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Widget',
          definitionType: 'CanvasComponent',
          customProperties: {
            Input: { kind: 'Input', dataType: 'Number', raiseOnReset: true },
            Output: { kind: 'Output', dataType: 'Number' },
          },
          controls: [],
        },
      ],
      screens: [{ name: 'Home', controls: [{ name: 'One', control: 'CanvasComponent@1', componentName: 'Widget' }] }],
    },
    formulas: [
      { owner: 'App', property: 'OnStart', text: '=Set(trigger,0)' },
      { owner: 'Home.One', property: 'Input', text: '=trigger + One.Output' },
      { owner: 'Widget', property: 'Output', text: '=Coalesce(resets,0)' },
      { owner: 'Widget', property: 'OnReset', text: '=Set(resets,Coalesce(resets,0)+1)' },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'reset-loop', source }, evaluator: createPowerFxEvaluator() });
  await runtime.start();
  const snapshot = (await runtime.act({ action: 'run', formula: 'Set(trigger,1)' })).snapshot;
  assert.ok(snapshot.diagnostics.some((entry) => entry.code === 'CANVAS_COMPONENT_RESET_LIMIT'));
  assert.equal(snapshot.screens[0].controls[0].properties.Output, 32);
});
