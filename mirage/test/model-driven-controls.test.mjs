// @test-kind contract: model-driven control descriptors and the PCF host are Paqvilo's own designed runtime behaviour, checked against invented components and a stub document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { controlDescriptor } from '../lib/model-driven/control-descriptors.mjs';
import { compileForm } from '../lib/model-driven/solution.mjs';
import { renderCanvasPcfControl, renderPcfControl } from '../lib/model-driven/pcf-runtime.mjs';

test('registered native column types select scalar controls without redundant presentation metadata', () => {
  for (const [dataverseType, type] of [
    ['int', 'number'],
    ['nvarchar', 'text'],
    ['bit', 'boolean'],
    ['datetime', 'date'],
    ['lookup', 'lookup'],
    ['ntext', 'textarea'],
  ])
    assert.equal(controlDescriptor({ dataverseType }).type, type);
});

test('control capabilities preserve explicit write restrictions and unknown placeholders', () => {
  assert.deepEqual(controlDescriptor({ type: 'text', validForUpdate: false }), {
    type: 'text',
    supported: true,
    create: true,
    update: false,
  });
  assert.equal(controlDescriptor({ type: 'text', isPrimaryId: true }).create, false);
  assert.deepEqual(controlDescriptor({ type: 'unknown' }), {
    type: 'unknown',
    supported: false,
    create: false,
    update: false,
  });
  assert.deepEqual(controlDescriptor({ type: 'text', dataverseType: 'file' }), {
    type: 'unsupported',
    supported: false,
    create: false,
    update: false,
  });
  assert.deepEqual(controlDescriptor({ type: 'text', dataverseType: 'multiselectpicklist' }), {
    type: 'multiselect',
    supported: true,
    create: true,
    update: true,
  });
  assert.equal(controlDescriptor({ type: 'multiselect', validForUpdate: false }).update, false);
});

test('supported scalar, lookup and choice controls have no unsupported reason; unresolved controls explain their boundary', () => {
  const names = ['x_text', 'x_lookup', 'x_choice', 'x_missing', ''];
  const xml = `<form><tabs><tab><columns><column><sections><section><rows><row>${names.map((name) => `<cell><control${name ? ` datafieldname="${name}"` : ''}/></cell>`).join('')}</row></rows></section></sections></column></columns></tab></tabs></form>`;
  const fields = compileForm(
    { id: 'diagnostics', xml },
    { x_text: { type: 'text' }, x_lookup: { type: 'lookup' }, x_choice: { type: 'choice' } },
  ).tabs[0].sections[0].fields;
  for (const field of fields.slice(0, 3)) {
    assert.equal(field.supported, true);
    assert.equal(Object.hasOwn(field, 'reason'), false);
  }
  assert.equal(fields[3].supported, false);
  assert.equal(fields[3].reason, 'Column metadata is unavailable.');
  assert.equal(fields[4].supported, false);
  assert.equal(fields[4].reason, 'This control is not available in the local host.');
});

test('compiled forms retain custom bindings and event dependencies for explicitly trusted hosts', () => {
  const xml =
    '<form><formLibraries><Library name="x_library" libraryUniqueId="lib"/></formLibraries><events><event name="onload"><Handlers><Handler functionName="neverExecute" libraryName="x_library"/></Handlers></event></events><tabs><tab name="main"><columns><column><sections><section><rows><row><cell><control id="custom" uniqueid="invented-control" classid="invented-class" datafieldname="x_name"><parameters><Unknown future="yes">opaque value</Unknown></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="invented-control"><customControl name="Invented.FutureControl" formFactor="0"><parameters><prop type="Bound">x_name</prop></parameters></customControl></controlDescription></controlDescriptions></form>';
  const form = compileForm({ id: 'invented-form', xml }, { x_name: { type: 'text' } });
  const control = form.tabs[0].sections[0].fields[0];
  assert.equal(control.supported, true);
  assert.equal(Object.hasOwn(control, 'reason'), false);
  assert.deepEqual(control.pcf, {
    name: 'Invented.FutureControl',
    formFactor: 0,
    bindings: { prop: { field: 'x_name' } },
  });
  assert.match(control.sourceControl.xml, /Unknown future="yes"/);
  assert.equal(control.sourceControl.attributes.classid, 'invented-class');
  assert.equal(control.sourceControl.customBindings[0].attributes.name, 'Invented.FutureControl');
  assert.match(control.sourceControl.customBindings[0].xml, /x_name/);
  assert.equal(form.hasScripts, true);
  assert.match(form.dependencies.events[0].xml, /neverExecute/);
  assert.equal(form.dependencies.libraries[0].attributes.name, 'x_library');
});

test('custom field hosts preserve all form factors and select only the desktop binding', () => {
  const xml =
    '<form><tabs><tab><columns><column><sections><section><rows><row><cell><control uniqueid="control" datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="control"><customControl name="Invented.Phone" formFactor="2"><parameters><value type="Bound">x_name</value></parameters></customControl><customControl name="Invented.Desktop" formFactor="0"><parameters><value type="Bound">x_name</value><prefix type="SingleLine.Text">Label</prefix></parameters></customControl></controlDescription></controlDescriptions></form>';
  const control = compileForm({ id: 'invented', xml }, { x_name: { type: 'text' } }).tabs[0].sections[0].fields[0];
  assert.deepEqual(control.pcf, {
    name: 'Invented.Desktop',
    formFactor: 0,
    bindings: { value: { field: 'x_name' }, prefix: { value: 'Label' } },
  });
  assert.equal(control.sourceControl.customBindings.length, 2);
  const phoneOnly = compileForm(
    { id: 'invented', xml: xml.replace('formFactor="0"', 'formFactor="1"') },
    { x_name: { type: 'text' } },
  ).tabs[0].sections[0].fields[0];
  assert.equal(phoneOnly.supported, false);
  assert.equal(phoneOnly.pcf, undefined);
});

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

// A stub document: elements record nothing, and appended script or link elements are kept for the test to settle.
function stubBrowser() {
  const appended = [];
  const element = () => ({
    className: '',
    dataset: {},
    style: {},
    classList: { add() {} },
    inert: false,
    clientWidth: 0,
    clientHeight: 0,
    setAttribute() {},
    dispatchEvent: () => true,
    replaceChildren() {},
    append() {},
    remove() {},
  });
  globalThis.document = { createElement: element, head: { append: (node) => appended.push(node) } };
  globalThis.location = { href: 'http://127.0.0.1:1234/main.aspx', origin: 'http://127.0.0.1:1234' };
  return {
    appended,
    restore() {
      delete globalThis.document;
      delete globalThis.location;
      delete globalThis.Invented;
    },
  };
}

const editorProperties = [
  { name: 'Value', usage: 'bound', ofType: 'SingleLine.Text' },
  { name: 'Label', usage: 'input', ofType: 'SingleLine.Text' },
];

class StubEditor {
  init() {}
  updateView() {
    return null;
  }
}

// @test-kind contract: the PCF host batches the property changes queued within one tick into a single updateView that names each of them.
test('PCF field host passes every property changed within one tick to one updateView', async () => {
  const browser = stubBrowser();
  const views = [];
  globalThis.Invented = {
    Editor: class extends StubEditor {
      updateView(context) {
        views.push([...context.updatedProperties]);
        return null;
      }
    },
  };
  const definition = {
    name: 'tst_Invented.Editor',
    constructor: 'Invented.Editor',
    type: 'standard',
    properties: [editorProperties[0]],
  };
  try {
    const runtime = renderPcfControl({ name: 'x_note', type: 'text', label: 'Note' }, 'a', {
      pcf: { name: 'tst_Invented.Editor', bindings: { Value: { field: 'x_note' } } },
      clientExtensions: { trusted: true, pcf: { controls: [definition], platformLibraries: [] } },
    });
    await runtime.ready;
    views.length = 0;
    runtime.setValue('b');
    runtime.setDisabled(true);
    await flush();
    assert.equal(views.length, 1);
    assert.ok(views[0].includes('Value'));
    assert.ok(views[0].includes('isControlDisabled'));
    runtime.destroy();
  } finally {
    browser.restore();
  }
});

// @test-kind contract: the Canvas PCF host batches the property changes queued within one tick into a single updateView that names each of them.
test('Canvas PCF host passes every property changed within one tick to one updateView', async () => {
  const browser = stubBrowser();
  const views = [];
  globalThis.Invented = {
    Editor: class extends StubEditor {
      updateView(context) {
        views.push([...context.updatedProperties]);
        return null;
      }
    },
  };
  try {
    const runtime = renderCanvasPcfControl(
      {
        name: 'tst_Invented.Editor',
        admitted: true,
        constructor: 'Invented.Editor',
        type: 'standard',
        properties: editorProperties,
      },
      { Value: 'a', Label: 'x' },
      {},
    );
    await runtime.ready;
    views.length = 0;
    runtime.update({ Value: 'b', Label: 'x' });
    runtime.update({ Value: 'b', Label: 'y' });
    await flush();
    assert.equal(views.length, 1);
    assert.ok(views[0].includes('Value'));
    assert.ok(views[0].includes('Label'));
    runtime.destroy();
  } finally {
    browser.restore();
  }
});

// @test-kind contract: a component resource settles on its load event however long the browser takes, so a slow same-origin load does not fail the component.
test('PCF resource load waits for the load event after fifteen seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const browser = stubBrowser();
  globalThis.Invented = { Editor: StubEditor };
  try {
    const runtime = renderCanvasPcfControl(
      {
        name: 'tst_Invented.Editor',
        admitted: true,
        constructor: 'Invented.Editor',
        type: 'standard',
        properties: editorProperties,
        resources: { code: ['/__sim-static/pcf/invented/bundle.js'] },
      },
      { Value: 'a', Label: 'x' },
      {},
    );
    await flush();
    const [script] = browser.appended;
    t.mock.timers.tick(20000);
    script.onload();
    await runtime.ready;
    assert.equal(runtime.inspect().state, 'ready');
    runtime.destroy();
  } finally {
    t.mock.timers.reset();
    browser.restore();
  }
});

// @test-kind compatibility: a two-options column is a two-option control, as Dataverse types it, whatever field type the import recorded.
test('a two-options column is a boolean control even when the import recorded text', () => {
  for (const dataverseType of ['bit', 'boolean'])
    assert.deepEqual(controlDescriptor({ dataverseType, type: 'text' }), {
      type: 'boolean',
      supported: true,
      create: true,
      update: true,
    });
});
