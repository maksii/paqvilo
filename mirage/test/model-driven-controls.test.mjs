import test from 'node:test';
import assert from 'node:assert/strict';
import { controlDescriptor } from '../lib/model-driven/control-descriptors.mjs';
import { compileForm } from '../lib/model-driven/solution.mjs';

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
  assert.equal(fields[4].reason, 'This control is not supported locally yet.');
});

test('compiled forms retain custom bindings and event dependencies for explicitly trusted hosts', () => {
  const xml =
    '<form><formLibraries><Library name="x_library" libraryUniqueId="lib"/></formLibraries><events><event name="onload"><Handlers><Handler functionName="neverExecute" libraryName="x_library"/></Handlers></event></events><tabs><tab name="main"><columns><column><sections><section><rows><row><cell><control id="custom" uniqueid="invented-control" classid="invented-class" datafieldname="x_name"><parameters><Unknown future="yes">opaque value</Unknown></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="invented-control"><customControl name="Invented.FutureControl" formFactor="0"><parameters><prop type="Bound">x_name</prop></parameters></customControl></controlDescription></controlDescriptions></form>';
  const form = compileForm({ id: 'invented-form', xml }, { x_name: { type: 'text' } });
  const control = form.tabs[0].sections[0].fields[0];
  assert.equal(control.supported, true);
  assert.equal(Object.hasOwn(control, 'reason'), false);
  assert.deepEqual(control.pcf, { name: 'Invented.FutureControl', bindings: { prop: { field: 'x_name' } } });
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
