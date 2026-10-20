import test from 'node:test';
import assert from 'node:assert/strict';
import { controlDescriptor } from '../lib/model-driven/control-descriptors.mjs';
import { compileForm } from '../lib/model-driven/solution.mjs';

test('control capabilities preserve explicit write restrictions and unknown placeholders', () => {
  assert.deepEqual(controlDescriptor({ type: 'text', validForUpdate: false }), { type: 'text', supported: true, create: true, update: false });
  assert.equal(controlDescriptor({ type: 'text', isPrimaryId: true }).create, false);
  assert.deepEqual(controlDescriptor({ type: 'unknown' }), { type: 'unknown', supported: false, create: false, update: false });
  assert.deepEqual(controlDescriptor({ type: 'text', dataverseType: 'file' }), { type: 'unsupported', supported: false, create: false, update: false });
});
test('compiled forms retain custom bindings and event dependencies for explicitly trusted hosts', () => {
  const xml = '<form><formLibraries><Library name="x_library" libraryUniqueId="lib"/></formLibraries><events><event name="onload"><Handlers><Handler functionName="neverExecute" libraryName="x_library"/></Handlers></event></events><tabs><tab name="main"><columns><column><sections><section><rows><row><cell><control id="custom" uniqueid="invented-control" classid="invented-class" datafieldname="x_name"><parameters><Unknown future="yes">opaque value</Unknown></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="invented-control"><customControl name="Invented.FutureControl" formFactor="0"><parameters><prop type="Bound">x_name</prop></parameters></customControl></controlDescription></controlDescriptions></form>';
  const form = compileForm({ id: 'invented-form', xml }, { x_name: { type: 'text' } });
  const control = form.tabs[0].sections[0].fields[0];
  assert.equal(control.supported, true);
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
  const xml = '<form><tabs><tab><columns><column><sections><section><rows><row><cell><control uniqueid="control" datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="control"><customControl name="Invented.Phone" formFactor="2"><parameters><value type="Bound">x_name</value></parameters></customControl><customControl name="Invented.Desktop" formFactor="0"><parameters><value type="Bound">x_name</value><prefix type="SingleLine.Text">Label</prefix></parameters></customControl></controlDescription></controlDescriptions></form>';
  const control = compileForm({ id: 'invented', xml }, { x_name: { type: 'text' } }).tabs[0].sections[0].fields[0];
  assert.deepEqual(control.pcf, { name: 'Invented.Desktop', bindings: { value: { field: 'x_name' }, prefix: { value: 'Label' } } });
  assert.equal(control.sourceControl.customBindings.length, 2);
  const phoneOnly = compileForm({ id: 'invented', xml: xml.replace('formFactor="0"', 'formFactor="1"') }, { x_name: { type: 'text' } }).tabs[0].sections[0].fields[0];
  assert.equal(phoneOnly.supported, false);
  assert.equal(phoneOnly.pcf, undefined);
});
