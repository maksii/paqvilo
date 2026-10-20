import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenInspectionCatalogue } from '../lense/model-driven-inspection.mjs';

const source = id => ({ id, entity: 'inv_item', name: 'Invented form', xml: '<form><formLibraries><Library name="inv_events.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="inv_events.js" functionName="Invented.load"/></Handlers></event></events></form>' });
const imported = forms => ({ layers: [{ documents: [{ file: '/invented/form.xml', facts: { appComponents: { forms } } }] }], appActions: [], ribbonDocuments: [] });

test('model-driven provenance derives from selected Solution facts and respects later form layers', () => {
  const first = source('form1'), second = { ...source('form1'), name: 'Overridden form' };
  const data = imported([first]); data.layers.push({ documents: [{ file: '/invented/later.xml', facts: { appComponents: { forms: [second] } } }] });
  const report = modelDrivenInspectionCatalogue(data);
  assert.equal(report.forms.length, 1); assert.equal(report.forms[0].name, 'Overridden form'); assert.equal(report.forms[0].source, '/invented/later.xml');
  assert.deepEqual(report.forms[0].libraries, ['inv_events.js']); assert.equal(report.forms[0].events[0].handlers[0].functionName, 'Invented.load');
});

test('provenance bounds total retained forms, commands, nested details and serialized payload', () => {
  const data = imported(Array.from({ length: 1000 }, (_, id) => source('form' + id)));
  data.appActions = Array.from({ length: 10000 }, (_, id) => ({ id: 'inv.action' + id, entity: 'inv_item', actions: Array.from({ length: 100 }, () => ({ library: 'inv_events.js', functionName: 'Invented.command' })) }));
  const report = modelDrivenInspectionCatalogue(data);
  assert.equal(report.limits.truncated, true); assert.ok(report.forms.length <= 200); assert.ok(report.commands.length <= 200);
  const details = report.forms.reduce((sum, form) => sum + form.controls.length + form.libraries.length + form.events.reduce((events, event) => events + event.handlers.length + 1, 0), 0) + report.commands.reduce((sum, command) => sum + command.actions.length, 0);
  assert.ok(details <= report.limits.maxDetails); assert.ok(Buffer.byteLength(JSON.stringify(report)) < report.limits.maxBytes + 4096);
});

test('oversized/malformed inspection metadata does not block other declared sources', () => {
  const report = modelDrivenInspectionCatalogue(imported([{ ...source('big'), xml: 'x'.repeat(2 * 1024 * 1024 + 1) }, source('normal')]));
  assert.equal(report.limits.truncated, true); assert.equal(report.forms.length, 1); assert.equal(report.forms[0].id, 'normal');
});
