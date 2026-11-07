import test from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { readCanvasSource, canvasInventoryRecord } from '../lib/canvas-source.mjs';
import { prepareCanvasSource } from '../lib/canvas-components.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const control = (name, type, properties = {}, componentName) => ({
  [name]: { Control: type, Properties: properties, ...(componentName ? { ComponentName: componentName } : {}) },
});
const archive = (sources) =>
  writeSolutionAssetEntries(
    Object.entries(sources).map(([name, value]) => ({ name, data: Buffer.from(stringify(value)) })),
  );

test('component expansion creates isolated names and preserves input and output formulas', async () => {
  const source = await readCanvasSource({
    msapp: archive({
      'Src/Home.pa.yaml': {
        Screens: {
          Home: {
            Children: [
              control('First', 'CanvasComponent', { Input: '=1' }, 'Widget'),
              control('Second', 'CanvasComponent', { Input: '=2' }, 'Widget'),
            ],
          },
        },
      },
      'Src/Component/Widget.pa.yaml': {
        ComponentDefinitions: {
          Widget: {
            DefinitionType: 'CanvasComponent',
            AccessAppScope: false,
            CustomProperties: {
              Input: { PropertyKind: 'Input', DataType: 'Number', Default: '=0' },
              Output: { PropertyKind: 'Output', DataType: 'Number' },
            },
            Properties: { Output: '=Inner.Text' },
            Children: [control('Inner', 'Label', { Text: '=Widget.Input' })],
          },
        },
      },
    }),
  });
  const prepared = prepareCanvasSource(source),
    screen = prepared.tree.screens[0];
  assert.equal(prepareCanvasSource(prepared), prepared);
  assert.equal(prepareCanvasSource({ ...prepared, codeComponents: {} }).componentScopes, prepared.componentScopes);
  assert.equal(screen.controls.length, 4);
  const one = screen.controls.find((item) => item.originalName === 'Inner' && item.componentInstance === 'First');
  const two = screen.controls.find((item) => item.originalName === 'Inner' && item.componentInstance === 'Second');
  assert.ok(one && two && one.name !== two.name);
  assert.equal(prepared.componentScopes[one.name].locals.Inner, one.name);
  assert.equal(prepared.componentScopes[two.name].locals.Inner, two.name);
  assert.ok(
    prepared.formulas.some(
      (row) => row.owner === 'Home.First' && row.property === 'Output' && row.text === '=Inner.Text',
    ),
  );
  assert.ok(
    prepared.formulas.some((row) => row.owner === 'Home.Second' && row.property === 'Input' && row.text === '=2'),
  );
  assert.equal(canvasInventoryRecord(source).tree.components[0].customProperties.Input.default, '=0');
});

test('component expansion is bounded and keeps legacy data bindings without guessing direction', () => {
  const legacy = prepareCanvasSource({
    app: { format: 'fx.yaml' },
    diagnostics: [],
    screens: [{ name: 'Home', controls: [{ name: 'Widget1', control: 'CanvasComponent', componentName: 'Widget' }] }],
    components: [
      {
        name: 'Widget',
        definitionType: 'CanvasComponent',
        customProperties: { Caption: { kind: 'LegacyUnknown', directionKnown: false, functionScope: false } },
        controls: [{ name: 'Text', control: 'label' }],
      },
    ],
    formulas: [
      { owner: 'Home.Widget1', property: 'Caption', text: '="instance"' },
      { owner: 'Widget', property: 'Caption', text: '="default"' },
      { owner: 'Widget.Text', property: 'Text', text: '=Widget.Caption' },
    ],
  });
  assert.equal(legacy.tree.screens[0].controls.length, 2);
  assert.equal(legacy.formulas.filter((row) => row.owner === 'Home.Widget1' && row.property === 'Caption').length, 1);
  assert.equal(
    legacy.formulas.find((row) => row.owner === 'Home.Widget1' && row.property === 'Caption').text,
    '="instance"',
  );
  const limited = prepareCanvasSource({
    app: {},
    diagnostics: [],
    formulas: [],
    screens: [
      {
        name: 'Home',
        controls: Array.from({ length: 5001 }, (_, index) => ({ name: `Label${index}`, control: 'Label' })),
      },
    ],
  });
  assert.equal(limited.tree.screens[0].controls.length, 5000);
  assert.ok(limited.diagnostics.some((item) => item.code === 'CANVAS_COMPONENT_EXPANSION_LIMIT'));
});

test('missing, recursive and unsupported component properties are explicit', async () => {
  const source = await readCanvasSource({
    msapp: archive({
      'Src/Home.pa.yaml': {
        Screens: {
          Home: {
            Children: [
              control('Missing', 'CanvasComponent', {}, 'Absent'),
              control('Loop', 'CanvasComponent', {}, 'Recursive'),
              control('Advanced', 'CanvasComponent', {}, 'FunctionWidget'),
            ],
          },
        },
      },
      'Src/Component/Defs.pa.yaml': {
        ComponentDefinitions: {
          Recursive: {
            DefinitionType: 'CanvasComponent',
            Children: [control('Again', 'CanvasComponent', {}, 'Recursive')],
          },
          FunctionWidget: {
            DefinitionType: 'CanvasComponent',
            CustomProperties: { Call: { PropertyKind: 'InputFunction' } },
          },
        },
      },
    }),
  });
  const prepared = prepareCanvasSource(source);
  assert.deepEqual(
    new Set(prepared.diagnostics.map((item) => item.code)),
    new Set([
      'CANVAS_COMPONENT_DEFINITION_UNAVAILABLE',
      'CANVAS_COMPONENT_RECURSIVE',
      'CANVAS_COMPONENT_PROPERTY_UNSUPPORTED',
    ]),
  );
  const record = canvasInventoryRecord(source);
  assert.ok(record.sourceDiagnostics.some((item) => item.code === 'CANVAS_COMPONENT_DEFINITION_UNAVAILABLE'));
  assert.ok(record.sourceDiagnostics.some((item) => item.code === 'CANVAS_COMPONENT_RECURSIVE'));
});

test('screen and component definition name collision retains formulas and blocks expansion', async () => {
  const source = await readCanvasSource({
    msapp: archive({
      'Src/Home.pa.yaml': { Screens: { Shared: { Properties: { OnVisible: '=Set(visits, 1)' } } } },
      'Src/Component/Shared.pa.yaml': {
        ComponentDefinitions: { Shared: { DefinitionType: 'CanvasComponent', Properties: { Fill: '=Color.Red' } } },
      },
    }),
  });
  assert.ok(source.diagnostics.some((item) => item.code === 'CANVAS_SOURCE_NAME_COLLISION'));
  assert.equal(prepareCanvasSource(source), source);
  assert.ok(source.formulas.some((row) => row.owner === 'Shared' && row.property === 'OnVisible'));
});
