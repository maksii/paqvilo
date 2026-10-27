import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasApp } from '../lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { controlKind } from '../lib/canvas-controls.mjs';

test('add picture aliases are recognized in both source formats', () => {
  for (const format of ['pa.yaml', 'fx.yaml']) {
    assert.equal(controlKind('AddMedia', format), 'addmedia');
    assert.equal(controlKind('AddPicture', format), 'addmedia');
  }
});

function fixture(controls, formulas = []) {
  return createCanvasApp({
    app: { uniqueName: 'controls', source: { tree: { screens: [{ name: 'Home', controls }] }, formulas } },
    evaluator: createPowerFxEvaluator(),
  });
}

test('gallery template fill evaluates in each row scope', async () => {
  const runtime = fixture(
    [{ name: 'List', control: 'Gallery@2.0' }],
    [
      { owner: 'List', property: 'Items', text: '=Table({Selected: true}, {Selected: false})' },
      { owner: 'List', property: 'TemplateFill', text: '=If(ThisItem.Selected, "red", "blue")' },
    ],
  );
  const snapshot = await runtime.start();
  const gallery = snapshot.screens[0].controls[0];
  assert.equal(gallery.properties.TemplateFill, undefined);
  assert.deepEqual(
    gallery.items.map((item) => item.templateProperties.TemplateFill),
    ['red', 'blue'],
  );
  assert.deepEqual(snapshot.errors, []);
});

test('gallery AllItemsCount drives visibility and height for loaded items', async () => {
  const runtime = fixture(
    [{ name: 'List', control: 'Gallery@2.0' }],
    [
      { owner: 'List', property: 'Items', text: '=Table({Value: 1})' },
      { owner: 'List', property: 'Visible', text: '=Self.AllItemsCount > 0' },
      { owner: 'List', property: 'Height', text: '=Self.AllItemsCount * 40' },
    ],
  );
  const gallery = (await runtime.start()).screens[0].controls[0];
  assert.equal(gallery.properties.AllItemsCount, 1);
  assert.equal(gallery.properties.Visible, true);
  assert.equal(gallery.properties.Height, 40);
});

test('UpdateIf updates collection rows in record scope with first matching condition', async () => {
  const runtime = fixture(
    [{ name: 'Run', control: 'Button@1' }],
    [
      { owner: 'App', property: 'OnStart', text: '=ClearCollect(colSteps, {Id: 1, Score: 3}, {Id: 2, Score: 7})' },
      { owner: 'Run', property: 'OnSelect', text: '=UpdateIf(colSteps, Id = 1, {Score: Score + 2}, true, {Score: 0})' },
    ],
  );
  await runtime.start();
  const result = await runtime.act({ action: 'select', control: 'Run' });
  assert.deepEqual(result.snapshot.collections.colSteps, [
    { Id: 1, Score: 5 },
    { Id: 2, Score: 0 },
  ]);
  assert.deepEqual(result.errors, []);
});

test('gallery windows expose later rows and retain absolute indexes', async () => {
  const runtime = fixture(
    [
      { name: 'List', control: 'Gallery@2.0' },
      { name: 'Caption', control: 'Label@2.0', parent: 'List' },
    ],
    [
      { owner: 'List', property: 'Items', text: '=Sequence(120)' },
      { owner: 'Caption', property: 'Text', text: '=ThisItem.Value' },
    ],
  );
  let gallery = (await runtime.start()).screens[0].controls[0];
  assert.equal(gallery.total, 120);
  assert.equal(gallery.items.length, 50);
  assert.equal(gallery.hasMore, true);
  gallery = (await runtime.act({ action: 'gallery-window', control: 'List', offset: 100 })).snapshot.screens[0]
    .controls[0];
  assert.equal(gallery.offset, 100);
  assert.equal(gallery.items.length, 20);
  assert.equal(gallery.hasMore, false);
  assert.equal(gallery.items[0].index, 100);
  assert.equal(gallery.items[0].controls.Caption.Text, 101);
  await assert.rejects(runtime.act({ action: 'gallery-window', control: 'List', offset: -1 }), {
    code: 'CanvasActionInvalid',
  });
});

test('numeric, radio and searchable multiple selection maintain output state', async () => {
  const runtime = fixture(
    [
      { name: 'Slide', control: 'Slider@1.0' },
      { name: 'Number', control: 'NumberInput@1.0' },
      { name: 'Radio', control: 'Radio@1.0' },
      { name: 'Combo', control: 'Combobox@1.0' },
    ],
    [
      { owner: 'Radio', property: 'Items', text: '=["a","b"]' },
      { owner: 'Combo', property: 'Items', text: '=["a","b","c"]' },
    ],
  );
  await runtime.start();
  await runtime.act({ action: 'input', control: 'Slide', value: 75 });
  await runtime.act({ action: 'input', control: 'Number', value: 3 });
  await runtime.act({ action: 'input', control: 'Radio', value: 1 });
  await runtime.act({ action: 'input', control: 'Combo', value: [0, 2] });
  const snapshot = (await runtime.act({ action: 'search', control: 'Combo', value: 'c' })).snapshot;
  const [slide, number, radio, combo] = snapshot.screens[0].controls;
  assert.equal(slide.properties.Value, 75);
  assert.equal(number.properties.Value, 3);
  assert.deepEqual(radio.properties.Selected, { Value: 'b' });
  assert.deepEqual(combo.properties.SelectedItems, [{ Value: 'a' }, { Value: 'c' }]);
  assert.equal(combo.properties.SearchText, 'c');
  await assert.rejects(runtime.act({ action: 'input', control: 'Slide', value: 101 }), { code: 'CanvasInputInvalid' });
});

test('timer advances only on explicit ticks, repeats and runs callbacks', async () => {
  const runtime = fixture(
    [{ name: 'Clock', control: 'Timer@2.0' }],
    [
      { owner: 'Clock', property: 'AutoStart', text: '=true' },
      { owner: 'Clock', property: 'Duration', text: '=1000' },
      { owner: 'Clock', property: 'Repeat', text: '=true' },
      { owner: 'Clock', property: 'OnTimerEnd', text: '=Set(ends, ends + 1)' },
    ],
  );
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Value, 0);
  snapshot = (await runtime.act({ action: 'tick', milliseconds: 2500 })).snapshot;
  assert.equal(snapshot.variables.ends, 2);
  assert.equal(snapshot.screens[0].controls[0].properties.Value, 500);
  assert.equal((await runtime.observe()).screens[0].controls[0].properties.Value, 500);
  await assert.rejects(runtime.act({ action: 'tick', milliseconds: 60001 }), { code: 'CanvasActionInvalid' });
});

test('media driver exposes position and event callbacks', async () => {
  const runtime = fixture(
    [{ name: 'Movie', control: 'Video@2.0' }],
    [
      { owner: 'Movie', property: 'OnPause', text: '=Set(pauses, pauses + 1)' },
      { owner: 'Movie', property: 'OnEnd', text: '=Set(ends, ends + 1)' },
    ],
  );
  await runtime.start();
  await runtime.act({ action: 'media', control: 'Movie', event: 'play' });
  await runtime.act({ action: 'media', control: 'Movie', event: 'seek', time: 12 });
  const snapshot = (await runtime.act({ action: 'media', control: 'Movie', event: 'pause' })).snapshot;
  assert.equal(snapshot.screens[0].controls[0].properties.Time, 12);
  assert.equal(snapshot.screens[0].controls[0].properties.Paused, true);
  assert.equal(snapshot.variables.pauses, 1);
});

test('component instances isolate local controls and calculate output properties', async () => {
  const runtime = createCanvasApp({
    app: {
      uniqueName: 'components',
      source: {
        tree: {
          format: 'pa.yaml',
          components: [
            {
              name: 'Widget',
              definitionType: 'CanvasComponent',
              customProperties: { Input: { kind: 'Input', default: '=0' }, Output: { kind: 'Output' } },
              controls: [{ name: 'Caption', control: 'Label@2.0' }],
            },
          ],
          screens: [
            {
              name: 'Home',
              controls: [
                { name: 'One', control: 'CanvasComponent@1.0', componentName: 'Widget' },
                { name: 'Two', control: 'CanvasComponent@1.0', componentName: 'Widget' },
              ],
            },
          ],
        },
        formulas: [
          { owner: 'Home.One', property: 'Input', text: '=2' },
          { owner: 'Home.Two', property: 'Input', text: '=4' },
          { owner: 'Widget', property: 'Output', text: '=Caption.Text' },
          { owner: 'Widget.Caption', property: 'Text', text: '=Parent.Input * 2' },
        ],
      },
    },
    evaluator: createPowerFxEvaluator(),
  });
  const snapshot = await runtime.start();
  const roots = snapshot.screens[0].controls.filter((c) => ['One', 'Two'].includes(c.name));
  assert.deepEqual(
    roots.map((c) => c.properties.Output),
    [4, 8],
  );
});

test('modern control aliases expose Checked and enforce single selection', async () => {
  const runtime = fixture(
    [
      { name: 'ModernCheck', control: 'ModernCheckbox@1.0.0' },
      { name: 'ModernCombo', control: 'ModernCombobox@1.0.0' },
      { name: 'ModernText', control: 'ModernTextInput@1.0.0' },
    ],
    [
      { owner: 'ModernCheck', property: 'Checked', text: '=true' },
      { owner: 'ModernCombo', property: 'Items', text: '=["a","b"]' },
      { owner: 'ModernCombo', property: 'SelectMultiple', text: '=false' },
    ],
  );
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Checked, true);
  snapshot = (await runtime.act({ action: 'input', control: 'ModernCheck', value: false })).snapshot;
  assert.equal(snapshot.screens[0].controls[0].properties.Checked, false);
  await assert.rejects(runtime.act({ action: 'input', control: 'ModernCombo', value: [0, 1] }), {
    code: 'CanvasInputInvalid',
  });
  snapshot = (await runtime.act({ action: 'input', control: 'ModernText', value: 'hello' })).snapshot;
  assert.equal(snapshot.screens[0].controls[2].properties.Text, 'hello');
});

test('unique asset identifiers resolve to local URLs and ambiguous names remain unbound', async () => {
  const assets = new Map([
    ['logo.png', Buffer.from('x')],
    ['dupe.png', Buffer.from('x')],
    ['dupe.jpg', Buffer.from('y')],
  ]);
  const source = {
    tree: {
      screens: [
        {
          name: 'Home',
          controls: [
            { name: 'Picture', control: 'Image@1' },
            { name: 'Ambiguous', control: 'Image@1' },
          ],
        },
      ],
    },
    formulas: [
      { owner: 'Picture', property: 'Image', text: '=logo' },
      { owner: 'Ambiguous', property: 'Image', text: '=dupe' },
    ],
    [Symbol.for('paqvilo.canvas.assets')]: assets,
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'invented', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Image, '/_apps/canvas/invented/assets/logo.png');
  assert.ok(snapshot.diagnostics.some((d) => d.code === 'CANVAS_ASSET_NAME_AMBIGUOUS'));
  assert.ok(snapshot.errors.some((d) => d.source === 'Ambiguous.Image'));
});

test('timer pauses off-screen and reset clears elapsed value', async () => {
  const runtime = createCanvasApp({
    app: {
      uniqueName: 'timers',
      source: {
        tree: {
          screens: [
            { name: 'Home', controls: [{ name: 'Clock', control: 'Timer@2' }] },
            { name: 'Other', controls: [] },
          ],
        },
        formulas: [
          { owner: 'Clock', property: 'AutoStart', text: '=true' },
          { owner: 'Clock', property: 'Duration', text: '=1000' },
        ],
      },
    },
    evaluator: createPowerFxEvaluator(),
  });
  await runtime.start();
  await runtime.act({ action: 'tick', milliseconds: 200 });
  await runtime.act({ action: 'navigate', screen: 'Other' });
  let snapshot = (await runtime.act({ action: 'tick', milliseconds: 300 })).snapshot;
  assert.equal(snapshot.screens[0].controls[0].properties.Value, 200);
  await runtime.act({ action: 'navigate', screen: 'Home' });
  snapshot = (await runtime.act({ action: 'run', formula: 'Reset(Clock)' })).snapshot;
  assert.equal(snapshot.screens[0].controls[0].properties.Value, 0);
});

test('combo search inside galleries is scoped to the selected row', async () => {
  const runtime = fixture(
    [
      { name: 'List', control: 'Gallery@2' },
      { name: 'Combo', control: 'ModernCombobox@1', parent: 'List' },
    ],
    [
      { owner: 'List', property: 'Items', text: '=Sequence(2)' },
      { owner: 'Combo', property: 'Items', text: '=["a","b"]' },
    ],
  );
  await runtime.start();
  const snapshot = (await runtime.act({ action: 'search', control: 'Combo', item: 1, value: 'needle' })).snapshot;
  const rows = snapshot.screens[0].controls[0].items;
  assert.equal(rows[0].controls.Combo.SearchText, '');
  assert.equal(rows[1].controls.Combo.SearchText, 'needle');
});

test('nested component inputs evaluate in their parent definition scope', async () => {
  const runtime = createCanvasApp({
    app: {
      uniqueName: 'nested',
      source: {
        tree: {
          format: 'pa.yaml',
          components: [
            {
              name: 'Inner',
              definitionType: 'CanvasComponent',
              customProperties: { Input: { kind: 'Input' }, Output: { kind: 'Output' } },
              controls: [],
            },
            {
              name: 'Outer',
              definitionType: 'CanvasComponent',
              customProperties: { Output: { kind: 'Output' } },
              controls: [
                { name: 'Caption', control: 'Label@2' },
                { name: 'Nested', control: 'CanvasComponent@1', componentName: 'Inner' },
              ],
            },
          ],
          screens: [
            { name: 'Home', controls: [{ name: 'Root', control: 'CanvasComponent@1', componentName: 'Outer' }] },
          ],
        },
        formulas: [
          { owner: 'Outer.Caption', property: 'Text', text: '=42' },
          { owner: 'Outer.Nested', property: 'Input', text: '=Caption.Text' },
          { owner: 'Inner', property: 'Output', text: '=Inner.Input * 2' },
          { owner: 'Outer', property: 'Output', text: '=Nested.Output' },
        ],
      },
    },
    evaluator: createPowerFxEvaluator(),
  });
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls.find((control) => control.name === 'Root').properties.Output, 84);
});

test('component local variables persist independently across instances', async () => {
  const runtime = createCanvasApp({
    app: {
      uniqueName: 'local-vars',
      source: {
        tree: {
          format: 'pa.yaml',
          components: [
            {
              name: 'Counter',
              definitionType: 'CanvasComponent',
              customProperties: { Output: { kind: 'Output' } },
              controls: [{ name: 'Add', control: 'Button@1' }],
            },
          ],
          screens: [
            {
              name: 'Home',
              controls: [
                { name: 'One', control: 'CanvasComponent@1', componentName: 'Counter' },
                { name: 'Two', control: 'CanvasComponent@1', componentName: 'Counter' },
              ],
            },
          ],
        },
        formulas: [
          { owner: 'Counter', property: 'Output', text: '=Coalesce(count, 0)' },
          { owner: 'Counter.Add', property: 'OnSelect', text: '=Set(count, Coalesce(count, 0) + 1)' },
        ],
      },
    },
    evaluator: createPowerFxEvaluator(),
  });
  let snapshot = await runtime.start();
  const add = snapshot.screens[0].controls.find((control) => control.parent === 'One');
  snapshot = (await runtime.act({ action: 'select', control: add.name })).snapshot;
  const roots = snapshot.screens[0].controls.filter((control) => ['One', 'Two'].includes(control.name));
  assert.deepEqual(
    roots.map((control) => control.properties.Output),
    [1, 0],
  );
});

test('combo options evaluate modern item labels per row', async () => {
  const runtime = fixture(
    [{ name: 'Combo', control: 'ModernCombobox@1' }],
    [
      { owner: 'Combo', property: 'Items', text: '=[{title:"first"},{title:"second"}]' },
      { owner: 'Combo', property: 'ItemDisplayText', text: '=ThisItem.title' },
    ],
  );
  const snapshot = await runtime.start();
  assert.deepEqual(
    snapshot.screens[0].controls[0].options.map((option) => option.label),
    ['first', 'second'],
  );
  assert.equal(snapshot.errors.length, 0);
});

test('admitted code component output actions validate manifest and update dependent formulas', async () => {
  const app = {
    uniqueName: 'pcf',
    source: {
      tree: {
        screens: [
          {
            name: 'Home',
            controls: [
              { name: 'Meter', control: 'CodeComponent@1', componentName: 'Invented.Meter' },
              { name: 'Output', control: 'Label@1' },
            ],
          },
        ],
      },
      codeComponents: {
        Meter: {
          admitted: true,
          name: 'Invented.Meter',
          constructor: 'Invented.Meter',
          properties: [
            { name: 'Input', usage: 'input', ofType: 'SingleLine.Text' },
            { name: 'Amount', usage: 'bound', ofType: 'Whole.None' },
          ],
        },
      },
      formulas: [
        { owner: 'Meter', property: 'Amount', text: '=2' },
        { owner: 'Output', property: 'Text', text: '=Meter.Amount' },
      ],
    },
  };
  const runtime = createCanvasApp({ app, evaluator: createPowerFxEvaluator() });
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 2);
  snapshot = (await runtime.act({ action: 'codecomponent', control: 'Meter', values: { Amount: 5 } })).snapshot;
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 5);
  await assert.rejects(runtime.act({ action: 'codecomponent', control: 'Meter', values: { Input: 'x' } }), {
    code: 'CanvasActionInvalid',
  });
  await assert.rejects(runtime.act({ action: 'codecomponent', control: 'Meter', values: { Amount: 1.5 } }), {
    code: 'CanvasInputInvalid',
  });
  assert.equal(runtime.snapshot().screens[0].controls[1].properties.Text, 5);
});

test('timer Start formula begins after a state change without an initial tick', async () => {
  const runtime = fixture(
    [{ name: 'Clock', control: 'Timer@2' }],
    [
      { owner: 'App', property: 'OnStart', text: '=Set(enabled, false)' },
      { owner: 'Clock', property: 'Start', text: '=enabled' },
    ],
  );
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Running, false);
  snapshot = (await runtime.act({ action: 'run', formula: 'Set(enabled, true)' })).snapshot;
  assert.equal(snapshot.screens[0].controls[0].properties.Running, true);
  assert.equal(snapshot.screens[0].controls[0].properties.Value, 0);
});

test('timer clock ownership keys are stable per instance and distinct across instances', async () => {
  const one = fixture([{ name: 'Clock', control: 'Timer@2' }]);
  const two = fixture([{ name: 'Clock', control: 'Timer@2' }]);
  const first = await one.start(),
    second = await two.start();
  assert.equal((await one.observe()).clockKey, first.clockKey);
  assert.notEqual(first.clockKey, second.clockKey);
});

test('code component updates are atomic and refused for disabled controls', async () => {
  const source = {
    tree: {
      screens: [
        { name: 'Home', controls: [{ name: 'Widget', control: 'CodeComponent@1', componentName: 'Fixture.Widget' }] },
      ],
    },
    codeComponents: {
      Widget: {
        admitted: true,
        properties: [
          { name: 'Value', usage: 'bound', ofType: 'Whole.None' },
          { name: 'Input', usage: 'input', ofType: 'SingleLine.Text' },
        ],
      },
    },
    formulas: [
      { owner: 'App', property: 'OnStart', text: '=Set(locked, false)' },
      { owner: 'Widget', property: 'DisplayMode', text: '=If(locked, DisplayMode.Disabled, DisplayMode.Edit)' },
      { owner: 'Widget', property: 'OnChange', text: '=Set(changes, changes + 1)' },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'atomic', source }, evaluator: createPowerFxEvaluator() });
  await runtime.start();
  await assert.rejects(
    runtime.act({ action: 'codecomponent', control: 'Widget', values: { Value: 3, Input: 'bad' } }),
    { code: 'CanvasActionInvalid' },
  );
  assert.equal(runtime.snapshot().screens[0].controls[0].properties.Value, null);
  const snapshot = (await runtime.act({ action: 'codecomponent', control: 'Widget', values: { Value: 5 } })).snapshot;
  assert.equal(snapshot.variables.changes, 1);
  await runtime.act({ action: 'run', formula: 'Set(locked, true)' });
  await assert.rejects(runtime.act({ action: 'codecomponent', control: 'Widget', values: { Value: 6 } }), {
    code: 'CanvasActionInvalid',
  });
});

test('manifest-declared code component events run only on explicit event actions', async () => {
  const source = {
    tree: {
      screens: [
        { name: 'Home', controls: [{ name: 'Widget', control: 'CodeComponent@1', componentName: 'Fixture.Widget' }] },
      ],
    },
    codeComponents: { Widget: { admitted: true, properties: [], events: ['changed'] } },
    formulas: [{ owner: 'Widget', property: 'changed', text: '=Set(calls, calls + 1)' }],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'events', source }, evaluator: createPowerFxEvaluator() });
  let snapshot = await runtime.start();
  assert.equal(snapshot.variables.calls, undefined);
  assert.ok(snapshot.screens[0].controls[0].behaviours.includes('changed'));
  assert.equal(Object.hasOwn(snapshot.screens[0].controls[0].properties, 'changed'), false);
  snapshot = (await runtime.act({ action: 'codecomponent-event', control: 'Widget', event: 'changed' })).snapshot;
  assert.equal(snapshot.variables.calls, 1);
  await assert.rejects(runtime.act({ action: 'codecomponent-event', control: 'Widget', event: 'other' }), {
    code: 'CanvasActionInvalid',
  });
});

test('code component scalar types accept admitted shapes and reject wrong types atomically', async () => {
  const types = [
    'Whole.Duration',
    'Whole.TimeZone',
    'Whole.Language',
    'Enum',
    'OptionSet',
    'SingleLine.Email',
    'SingleLine.Phone',
    'SingleLine.URL',
    'SingleLine.TextArea',
    'SingleLine.Ticker',
  ];
  const source = {
    tree: {
      screens: [
        { name: 'Home', controls: [{ name: 'Widget', control: 'CodeComponent@1', componentName: 'Fixture.Widget' }] },
      ],
    },
    codeComponents: {
      Widget: {
        admitted: true,
        properties: types.map((ofType, index) => ({ name: `p${index}`, usage: 'output', ofType })),
      },
    },
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'types', source }, evaluator: createPowerFxEvaluator() });
  await runtime.start();
  const values = {
    p0: 10,
    p1: 42,
    p2: 1033,
    p3: 'one',
    p4: 2,
    p5: 'a@example.test',
    p6: '123',
    p7: 'https://example.test',
    p8: 'text',
    p9: 'FOO',
  };
  const snapshot = (await runtime.act({ action: 'codecomponent', control: 'Widget', values })).snapshot;
  for (const [key, value] of Object.entries(values))
    assert.equal(snapshot.screens[0].controls[0].properties[key], value);
  await assert.rejects(runtime.act({ action: 'codecomponent', control: 'Widget', values: { p0: 1.5 } }), {
    code: 'CanvasInputInvalid',
  });
});

test('simple icon, shape and HTML control types are catalogued', async () => {
  const runtime = fixture([
    { name: 'Icon', control: 'Icon@1' },
    { name: 'Box', control: 'Rectangle@1' },
    { name: 'Dot', control: 'Circle@1' },
    { name: 'Text', control: 'HtmlText@1' },
  ]);
  const snapshot = await runtime.start();
  assert.deepEqual(
    snapshot.screens[0].controls.map((control) => control.kind),
    ['icon', 'rectangle', 'circle', 'htmlviewer'],
  );
  assert.equal(snapshot.screens[0].controls[3].properties.HtmlText, '');
});

test('blank saved formulas and layout enumerations do not fail Canvas startup', async () => {
  const source = {
    tree: { screens: [{ name: 'Home', controls: [{ name: 'Card', control: 'Label@1' }] }] },
    formulas: [
      { owner: 'App', property: 'OnStart', text: '=Set(weight, FontWeight.Semibold)' },
      { owner: 'Card', property: 'Text', text: '=' },
      { owner: 'Card', property: 'BorderStyle', text: '=BorderStyle.Solid' },
      { owner: 'Card', property: 'VerticalAlign', text: '=VerticalAlign.Middle' },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'layout', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.equal(snapshot.variables.weight, 'Semibold');
  assert.equal(snapshot.screens[0].controls[0].properties.Text, null);
  assert.equal(snapshot.screens[0].controls[0].properties.BorderStyle, 'Solid');
  assert.equal(snapshot.errors.length, 0);
});

test('random values are replayed when a behavior waits for a connector', async () => {
  const calls = [];
  const app = {
    uniqueName: 'random-replay',
    source: {
      dataSources: [{ name: 'Svc', connectorId: 'invented' }],
      tree: { screens: [{ name: 'Home', controls: [] }] },
      formulas: [],
    },
  };
  const runtime = createCanvasApp({
    app,
    evaluator: createPowerFxEvaluator(),
    connectors: async ({ body }) => {
      calls.push(body.value);
      return { statusCode: 200, body: { value: body.value } };
    },
  });
  await runtime.start();
  const snapshot = (
    await runtime.act({ action: 'run', formula: 'Set(number, Rand()); Set(answer, Svc.Echo({value: number}).value)' })
  ).snapshot;
  assert.equal(calls.length, 1);
  assert.equal(snapshot.variables.number, calls[0]);
  assert.equal(snapshot.variables.answer, calls[0]);
});

test('restricted component can reference registered media but not app globals', async () => {
  const source = {
    [Symbol.for('paqvilo.canvas.assets')]: new Map([['Images/icon.svg', Buffer.from('<svg/>')]]),
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Widget',
          definitionType: 'CanvasComponent',
          accessAppScope: false,
          customProperties: {},
          controls: [
            { name: 'Picture', control: 'Image@1' },
            { name: 'Secret', control: 'Label@1' },
          ],
        },
      ],
      screens: [{ name: 'Home', controls: [{ name: 'One', control: 'CanvasComponent@1', componentName: 'Widget' }] }],
    },
    formulas: [
      { owner: 'App', property: 'OnStart', text: '=Set(privateValue,"not visible")' },
      { owner: 'Widget.Picture', property: 'Image', text: '=icon' },
      { owner: 'Widget.Secret', property: 'Text', text: '=privateValue' },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'assets', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  const children = snapshot.screens[0].controls.filter((entry) => entry.parent === 'One');
  assert.equal(
    children.find((entry) => entry.kind === 'image').properties.Image,
    '/_apps/canvas/assets/assets/Images%2Ficon.svg',
  );
  assert.equal(children.find((entry) => entry.kind === 'label').properties.Text, null);
  assert.ok(snapshot.errors.some((entry) => entry.code === 'PowerFxNameUnknown'));
});

test('comment-only saved formulas are blank while invalid expressions remain errors', async () => {
  const runtime = fixture(
    [
      { name: 'Line', control: 'Label@1' },
      { name: 'Block', control: 'Label@1' },
      { name: 'Bad', control: 'Label@1' },
    ],
    [
      { owner: 'Line', property: 'Text', text: '= // disabled\n' },
      { owner: 'Block', property: 'Text', text: '= /* disabled */ // again' },
      { owner: 'Bad', property: 'Text', text: '=1+' },
    ],
  );
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Text, null);
  assert.equal(snapshot.screens[0].controls[1].properties.Text, null);
  assert.ok(snapshot.errors.some((error) => error.source === 'Bad.Text'));
  assert.equal(
    snapshot.errors.some((error) => error.source === 'Line.Text' || error.source === 'Block.Text'),
    false,
  );
});

test('enum choices filter and display labels while preserving numeric values', async () => {
  const source = {
    enums: { 'Invented Status': { Active: 1, Inactive: 2 }, Other: { Active: 1 } },
    tree: {
      screens: [
        {
          name: 'Home',
          controls: [
            { name: 'Pick', control: 'Dropdown@1' },
            { name: 'Caption', control: 'Label@1' },
          ],
        },
      ],
    },
    formulas: [
      {
        owner: 'Pick',
        property: 'Items',
        text: "=Filter(Choices('Invented Status'), Value <> 'Invented Status'.Inactive)",
      },
      { owner: 'Caption', property: 'Text', text: "='Invented Status'.Active" },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'choices', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  const pick = snapshot.screens[0].controls[0];
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 'Active');
  assert.deepEqual(
    pick.options.map((option) => [option.value.Value, option.label]),
    [[1, 'Active']],
  );
  assert.equal(
    (await runtime.act({ action: 'evaluate', formula: "Text('Invented Status'.Inactive)" })).result,
    'Inactive',
  );
  assert.equal((await runtime.act({ action: 'evaluate', formula: "'Invented Status'.Active = 1" })).result, true);
  const crossEnum = await runtime.act({ action: 'evaluate', formula: "'Invented Status'.Active = Other.Active" });
  assert.equal(crossEnum.result.error[0].kind, 'InvalidArgument');
  assert.equal(
    (await runtime.act({ action: 'run', formula: "Set(saved, 'Invented Status'.Inactive)" })).snapshot.variables.saved,
    2,
  );
});

test('source option enums resolve case-insensitive labels in restricted component scopes', async () => {
  const source = {
    enums: { 'Invented Status': { Ready: 1, Waiting: 2 } },
    tree: {
      format: 'pa.yaml',
      components: [
        {
          name: 'Widget',
          definitionType: 'CanvasComponent',
          accessAppScope: false,
          customProperties: { Output: { kind: 'Output', dataType: 'Number' } },
          controls: [],
        },
      ],
      screens: [
        {
          name: 'Home',
          controls: [
            { name: 'One', control: 'CanvasComponent@1', componentName: 'Widget' },
            { name: 'Result', control: 'Label@1' },
          ],
        },
      ],
    },
    formulas: [
      { owner: 'Widget', property: 'Output', text: "='Invented Status'.rEaDy" },
      { owner: 'Result', property: 'Text', text: "='Invented Status'.Unknown" },
    ],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'enums', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls.find((entry) => entry.name === 'One').properties.Output, 1);
  assert.equal(snapshot.screens[0].controls.find((entry) => entry.name === 'Result').properties.Text, null);
  assert.ok(snapshot.errors.some((entry) => entry.code === 'PowerFxNameUnknown' && entry.source === 'Result.Text'));
});

test('ambiguous or colliding source enum names are diagnosed and not bound', async () => {
  const source = {
    enums: {
      Foo: { Ready: 1 },
      foo: { Waiting: 2 },
      Color: { Red: 9 },
      Duplicate: { Ready: 1, READY: 2 },
      Home: { Yes: 1 },
    },
    tree: { screens: [{ name: 'Home', controls: [{ name: 'Result', control: 'Label@1' }] }] },
    formulas: [{ owner: 'Result', property: 'Text', text: '=Color.Red' }],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'enum-collisions', source },
    evaluator: createPowerFxEvaluator(),
  });
  const snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[0].properties.Text, 'rgba(255, 0, 0, 1)');
  assert.equal(snapshot.diagnostics.filter((entry) => entry.code === 'CANVAS_ENUM_NAME_AMBIGUOUS').length, 4);
  await assert.rejects(runtime.act({ action: 'evaluate', formula: 'Foo.Ready' }), { code: 'PowerFxNameUnknown' });
});

test('component-local identifiers that collide with source enums are diagnosed', async () => {
  const source = {
    enums: { Caption: { On: 1 } },
    tree: {
      format: 'pa.yaml',
      components: [
        { name: 'Widget', definitionType: 'CanvasComponent', controls: [{ name: 'Caption', control: 'Label@1' }] },
      ],
      screens: [
        { name: 'Home', controls: [{ name: 'Instance', control: 'CanvasComponent@1', componentName: 'Widget' }] },
      ],
    },
    formulas: [],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'component-enum-collision', source },
    evaluator: createPowerFxEvaluator(),
  });
  const snapshot = await runtime.start();
  assert.ok(
    snapshot.diagnostics.some((entry) => entry.code === 'CANVAS_ENUM_NAME_AMBIGUOUS' && entry.source === 'caption'),
  );
});

test('code component default formulas respect source bindings and diagnose reserved placeholders', async () => {
  const source = {
    tree: {
      screens: [
        { name: 'Home', controls: [{ name: 'Widget', control: 'CodeComponent@1', componentName: 'Fixture.Widget' }] },
      ],
    },
    codeComponents: {
      Widget: {
        admitted: true,
        properties: [
          { name: 'Calculated', usage: 'bound', ofType: 'Whole.None', defaultFormula: '=2+3' },
          { name: 'Override', usage: 'bound', ofType: 'Whole.None', defaultFormula: '=%Control.ID%' },
          { name: 'Unavailable', usage: 'bound', ofType: 'SingleLine.Text', defaultFormula: '=%Enum.RESERVED%' },
        ],
      },
    },
    formulas: [{ owner: 'Widget', property: 'Override', text: '=7' }],
  };
  const runtime = createCanvasApp({ app: { uniqueName: 'defaults', source }, evaluator: createPowerFxEvaluator() });
  const snapshot = await runtime.start();
  const properties = snapshot.screens[0].controls[0].properties;
  assert.equal(properties.Calculated, 5);
  assert.equal(properties.Override, 7);
  assert.equal(properties.Unavailable.error[0].kind, 'NotSupported');
  assert.ok(
    snapshot.diagnostics.some(
      (entry) => entry.code === 'CANVAS_PCF_DEFAULT_UNSUPPORTED' && entry.source === 'Widget.Unavailable',
    ),
  );
  assert.ok(
    !snapshot.diagnostics.some(
      (entry) => entry.code === 'CANVAS_PCF_DEFAULT_UNSUPPORTED' && entry.source === 'Widget.Override',
    ),
  );
});

test('add picture accepts bounded signature-matched image bytes and keeps input local', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a2kAAAAASUVORK5CYII=';
  const runtime = fixture(
    [{ name: 'Upload', control: 'AddMedia@1' }],
    [{ owner: 'Upload', property: 'OnChange', text: '=Set(changes, changes + 1)' }],
  );
  await runtime.start();
  const snapshot = (
    await runtime.act({ action: 'add-media', control: 'Upload', name: 'pixel.png', mime: 'image/png', data: png })
  ).snapshot;
  const props = snapshot.screens[0].controls[0].properties;
  assert.equal(props.FileName, 'pixel.png');
  assert.equal(props.Media, `data:image/png;base64,${png}`);
  assert.equal(snapshot.variables.changes, 1);
  for (const invalid of [
    { name: 'wrong.jpg', mime: 'image/jpeg', data: png },
    { name: 'x.svg', mime: 'image/svg+xml', data: png },
    { name: '../pixel.png', mime: 'image/png', data: png },
    { name: 'bad.png', mime: 'image/png', data: '%%%=' },
    { name: 'large.png', mime: 'image/png', data: Buffer.alloc(1024 * 1024 + 1).toString('base64') },
  ])
    await assert.rejects(runtime.act({ action: 'add-media', control: 'Upload', ...invalid }), {
      code: 'CanvasInputInvalid',
    });
  assert.equal(runtime.snapshot().screens[0].controls[0].properties.Media, props.Media);
});

test('commented behavior arguments establish global and collection names before their first use', async () => {
  const source = {
    tree: {
      screens: [
        {
          name: 'Home',
          controls: [
            { name: 'Button', control: 'Button@1' },
            { name: 'Result', control: 'Label@1' },
          ],
        },
      ],
    },
    formulas: [
      {
        owner: 'Button',
        property: 'OnSelect',
        text: "=Set(// explanatory comment\n 'Later Value',7); ClearCollect(/* declared here */ LocalItems,{n:1})",
      },
      { owner: 'Result', property: 'Text', text: "=Coalesce('Later Value',0) + CountRows(LocalItems)" },
    ],
  };
  const runtime = createCanvasApp({
    app: { uniqueName: 'commented-variables', source },
    evaluator: createPowerFxEvaluator(),
  });
  let snapshot = await runtime.start();
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 0);
  assert.equal(snapshot.errors.length, 0);
  snapshot = (await runtime.act({ action: 'select', control: 'Button' })).snapshot;
  assert.equal(snapshot.screens[0].controls[1].properties.Text, 8);
});

test('auto-layout derives stretched parent dimensions and weighted fill portions', async () => {
  const controls = [
    { name: 'Outer', control: 'GroupContainer@1', variant: 'AutoLayout' },
    { name: 'Fixed', control: 'Label@1', parent: 'Outer' },
    { name: 'Panel', control: 'GroupContainer@1', parent: 'Outer' },
    { name: 'Other', control: 'Label@1', parent: 'Outer' },
    { name: 'Nested', control: 'Label@1', parent: 'Panel' },
  ];
  const formulas = [
    { owner: 'Outer', property: 'Width', text: '=600' },
    { owner: 'Outer', property: 'Height', text: '=400' },
    { owner: 'Outer', property: 'LayoutDirection', text: '=LayoutDirection.Vertical' },
    { owner: 'Outer', property: 'LayoutAlignItems', text: '=LayoutAlignItems.Stretch' },
    ...['PaddingLeft', 'PaddingRight', 'PaddingTop', 'PaddingBottom'].map((property) => ({
      owner: 'Outer',
      property,
      text: '=10',
    })),
    { owner: 'Outer', property: 'LayoutGap', text: '=10' },
    { owner: 'Fixed', property: 'Height', text: '=100' },
    { owner: 'Panel', property: 'FillPortions', text: '=1' },
    { owner: 'Panel', property: 'LayoutMinHeight', text: '=20' },
    { owner: 'Panel', property: 'PaddingLeft', text: '=5' },
    { owner: 'Panel', property: 'PaddingRight', text: '=5' },
    { owner: 'Other', property: 'FillPortions', text: '=2' },
    { owner: 'Other', property: 'LayoutMinHeight', text: '=20' },
    { owner: 'Nested', property: 'Width', text: '=Parent.Width - Parent.PaddingLeft - Parent.PaddingRight' },
  ];
  const runtime = fixture(controls, formulas);
  const snapshot = await runtime.start();
  const byName = Object.fromEntries(snapshot.screens[0].controls.map((control) => [control.name, control.properties]));
  assert.equal(byName.Panel.Width, 580);
  assert.equal(byName.Nested.Width, 570);
  assert.ok(Math.abs(byName.Panel.Height - (20 + 220 / 3)) < 1e-9);
  assert.ok(Math.abs(byName.Other.Height - (20 + 440 / 3)) < 1e-9);
  assert.equal(
    snapshot.diagnostics.some((entry) => entry.code === 'CANVAS_FORMULA_CYCLE'),
    false,
  );
});
