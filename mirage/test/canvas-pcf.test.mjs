import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasPcfApps } from '../lib/canvas-pcf.mjs';
import { canvasSettings } from '../lib/canvas-source.mjs';
import { CANVAS_ASSETS } from '../lib/canvas-assets.mjs';

const control = { name: 'Editor', control: 'CodeComponent', componentName: 'tst_Invented.Editor' };
const definition = {
  schemaName: 'tst_Invented.Editor',
  constructor: 'Invented.Editor',
  type: 'standard',
  properties: [{ name: 'Value', usage: 'bound', 'of-type': 'SingleLine.Text' }],
  events: [{ name: 'Saved' }],
  resources: [{ kind: 'code', url: '/__sim-static/pcf/invented/bundle.js' }],
};
const catalog = (entry = definition) => ({ controls: new Map([[entry.schemaName, entry]]) });
const canvasCodeComponent = (control, catalog, options) =>
  canvasPcfApps(
    [
      {
        uniqueName: 'invented',
        source: {
          app: { name: 'Invented' },
          screens: [{ name: 'Home', controls: [control] }],
          components: [],
          formulas: [],
          diagnostics: [],
        },
      },
    ],
    catalog,
    options,
  )[0].source.codeComponents[control.name];

test('Canvas PCF needs explicit trust, exact exported identity and supported manifest contracts', () => {
  assert.equal(canvasCodeComponent(control, catalog()).code, 'CANVAS_PCF_TRUST_REQUIRED');
  assert.equal(canvasCodeComponent(control, catalog(), { enabled: true }).admitted, true);
  assert.equal(
    canvasCodeComponent({ ...control, componentName: 'Other.Editor' }, catalog(), { enabled: true }).code,
    'CANVAS_PCF_MANIFEST_UNAVAILABLE',
  );
  assert.equal(
    canvasCodeComponent(control, catalog({ ...definition, dataset: true }), { enabled: true }).code,
    'CANVAS_PCF_DATASET_UNSUPPORTED',
  );
  assert.equal(
    canvasCodeComponent(control, catalog({ ...definition, features: [{ name: 'WebAPI', required: 'true' }] }), {
      enabled: true,
    }).code,
    'CANVAS_PCF_FEATURE_UNSUPPORTED',
  );
  assert.equal(
    canvasCodeComponent(
      control,
      catalog({ ...definition, properties: [{ name: '__proto__', usage: 'bound', 'of-type': 'SingleLine.Text' }] }),
      { enabled: true },
    ).code,
    'CANVAS_PCF_PROPERTY_UNSUPPORTED',
  );
  assert.equal(
    canvasCodeComponent(control, catalog({ ...definition, events: [{ name: 'constructor' }] }), { enabled: true }).code,
    'CANVAS_PCF_EVENT_UNSUPPORTED',
  );
});

test('Canvas PCF only admits virtual controls with exact local platform libraries', () => {
  const virtual = { ...definition, type: 'virtual', libraries: [{ name: 'React', version: '18.2.0' }] };
  assert.equal(canvasCodeComponent(control, catalog(virtual), { enabled: true }).code, 'PCF_VIRTUAL_UNSUPPORTED');
  const descriptor = canvasCodeComponent(control, catalog(virtual), {
    enabled: true,
    platformLibraries: [
      { name: 'React', version: '18.2.0', url: '/_apps/client/react.js' },
      { name: 'ReactDOM', version: '18.2.0', url: '/_apps/client/react-dom.js' },
    ],
  });
  assert.equal(descriptor.admitted, true);
  assert.equal(descriptor.platformLibraries.length, 2);
});

test('Canvas app descriptors preserve source and expose exact manifest output/event metadata', () => {
  const source = {
    app: { name: 'Invented' },
    screens: [{ name: 'Home', controls: [control] }],
    components: [],
    formulas: [],
    diagnostics: [],
  };
  const result = canvasPcfApps([{ uniqueName: 'invented', source }], catalog(), { enabled: true })[0];
  assert.equal(source.codeComponents, undefined);
  assert.deepEqual(result.source.codeComponents.Editor.events, ['Saved']);
  assert.deepEqual(result.source.codeComponents.Editor.properties, [
    { name: 'Value', usage: 'bound', ofType: 'SingleLine.Text', required: false },
  ]);
  assert.deepEqual(canvasSettings({ codeComponents: true }), { codeComponents: true });
  assert.throws(() => canvasSettings({ codeComponents: 'yes' }), /must be true or false/);
});

test('Canvas PCF defaults preserve Power Fx expressions and type scalar literal defaults', () => {
  const property = (name, ofType, extra) => ({ name, usage: 'input', 'of-type': ofType, ...extra });
  const descriptor = canvasCodeComponent(
    control,
    catalog({
      ...definition,
      properties: [
        property('Count', 'Whole.None', { 'default-value': '3' }),
        property('Enabled', 'TwoOptions', { 'default-value': 'false' }),
        property('Width', 'Whole.None', { 'default-value': '99', 'pfx-default-value': 'Parent.Width / 2' }),
      ],
    }),
    { enabled: true },
  );
  assert.equal(descriptor.admitted, true);
  assert.equal(descriptor.properties[0].defaultValue, 3);
  assert.equal(descriptor.properties[1].defaultValue, false);
  assert.equal(descriptor.properties[2].defaultFormula, 'Parent.Width / 2');
  assert.equal(descriptor.properties[2].defaultValue, undefined);
  assert.equal(
    canvasCodeComponent(
      control,
      catalog({ ...definition, properties: [property('Bad', 'Whole.None', { 'default-value': 'bad' })] }),
      { enabled: true },
    ).code,
    'CANVAS_PCF_DEFAULT_UNSUPPORTED',
  );
});

test('Canvas source revisions include enums and media bytes and reuse unchanged preparation', () => {
  const source = {
    app: { name: 'Invented' },
    screens: [{ name: 'Home', controls: [] }],
    components: [],
    formulas: [],
    diagnostics: [],
    enums: { 'State (Invented)': { Active: 0 } },
  };
  const entries = [{ uniqueName: 'invented', source }],
    components = catalog();
  const first = canvasPcfApps(entries, components)[0];
  assert.equal(canvasPcfApps(entries, components)[0], first);
  source.enums = { 'State (Invented)': { Active: 1 } };
  const second = canvasPcfApps(entries, components)[0];
  assert.notEqual(second.source.revision, first.source.revision);
  source[CANVAS_ASSETS] = new Map([['logo.png', { type: 'image/png', data: Buffer.from('private-media-marker') }]]);
  const third = canvasPcfApps(entries, components)[0];
  source[CANVAS_ASSETS] = new Map([['logo.png', { type: 'image/png', data: Buffer.from('two') }]]);
  assert.notEqual(canvasPcfApps(entries, components)[0].source.revision, third.source.revision);
  assert.equal(JSON.stringify(third.source).includes('private-media-marker'), false);
});
