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
test('compiled forms retain inert unknown control parameters, custom bindings and event dependencies', () => {
  const xml = '<form><formLibraries><Library name="x_library" libraryUniqueId="lib"/></formLibraries><events><event name="onload"><Handlers><Handler functionName="neverExecute" libraryName="x_library"/></Handlers></event></events><tabs><tab name="main"><columns><column><sections><section><rows><row><cell><control id="custom" uniqueid="invented-control" classid="invented-class" datafieldname="x_name"><parameters><Unknown future="yes">opaque value</Unknown></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="invented-control"><customControl name="Invented.FutureControl" formFactor="0"><parameters><prop type="Bound">x_name</prop></parameters></customControl></controlDescription></controlDescriptions></form>';
  const form = compileForm({ id: 'invented-form', xml }, { x_name: { type: 'text' } });
  const control = form.tabs[0].sections[0].fields[0];
  assert.equal(control.supported, false);
  assert.match(control.sourceControl.xml, /Unknown future="yes"/);
  assert.equal(control.sourceControl.attributes.classid, 'invented-class');
  assert.equal(control.sourceControl.customBindings[0].attributes.name, 'Invented.FutureControl');
  assert.match(control.sourceControl.customBindings[0].xml, /x_name/);
  assert.equal(form.hasScripts, true);
  assert.match(form.dependencies.events[0].xml, /neverExecute/);
  assert.equal(form.dependencies.libraries[0].attributes.name, 'x_library');
});
