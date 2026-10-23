import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenInspectionCatalogue } from '../lense/model-driven-inspection.mjs';
import { modelDrivenPanelInspection } from '../lense/model-driven-panel.mjs';

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

// Metadata as importModelDrivenProject reads it (importSolutionMetadata and solutionApps): invented tables, one main form with a
// bound column and a subgrid, two views and one app.
const SUBGRID = 'e7a81278-8635-4d9e-8d4d-59480b391c5b';
const formXml = `<form><tabs><tab name="general"><labels><label description="General" languagecode="1033"/></labels><columns><column width="100%"><sections><section name="details"><labels><label description="Details" languagecode="1033"/></labels><rows>`
  + '<row><cell><labels><label description="Name" languagecode="1033"/></labels><control id="inv_name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="inv_name"/></cell></row>'
  + `<row><cell><labels><label description="Parts" languagecode="1033"/></labels><control id="parts" classid="{${SUBGRID}}"><parameters><TargetEntityType>inv_part</TargetEntityType><ViewId>{00000000-0000-4000-8000-0000000000a2}</ViewId><RelationshipName>inv_item_inv_part</RelationshipName></parameters></control></cell></row>`
  + '</rows></section></sections></column></columns></tab></tabs></form>';
const metadataImport = () => ({ layers: [{}], appActions: [], ribbonDocuments: [],
  metadata: {
    entities: {
      inv_item: { entity: 'inv_item', label: 'Item', collectionLabel: 'Items', entitySet: 'inv_items', primaryIdAttribute: 'inv_itemid', primaryNameAttribute: 'inv_name', sources: ['/invented/Entities/inv_item/Entity.xml'],
        fields: { inv_itemid: { name: 'inv_itemid', label: 'Item', dataverseType: 'primarykey', isPrimaryId: true, source: '/invented/Entities/inv_item/Entity.xml' },
          inv_name: { name: 'inv_name', label: 'Name', dataverseType: 'nvarchar', requiredLevel: 'required', maxLength: 100, isPrimaryName: true, source: '/invented/Entities/inv_item/Entity.xml' } } },
      inv_part: { entity: 'inv_part', label: 'Part', entitySet: 'inv_parts', sources: ['/invented/Entities/inv_part/Entity.xml'], fields: { inv_partid: { name: 'inv_partid', dataverseType: 'primarykey', source: '/invented/Entities/inv_part/Entity.xml' } } },
    },
    forms: [{ id: '00000000-0000-4000-8000-0000000000f1', entity: 'inv_item', name: 'Item', formType: 'main', xml: formXml, file: '/invented/Entities/inv_item/FormXml/main/form.xml' }],
    views: [{ id: '00000000-0000-4000-8000-0000000000a1', entity: 'inv_item', name: 'Active items', queryType: 0, isDefault: true, fields: [{ name: 'inv_name' }], file: '/invented/Entities/inv_item/SavedQueries/a1.xml' },
      { id: '00000000-0000-4000-8000-0000000000a2', entity: 'inv_part', name: 'Parts of an item', queryType: 2, fields: [{ name: 'inv_partid' }], file: '/invented/Entities/inv_part/SavedQueries/a2.xml' }],
  },
  apps: [{ id: '00000000-0000-4000-8000-0000000000aa', uniqueName: 'inv_app', name: 'Invented app', sourceFile: '/invented/AppModules/inv_app/AppModule.xml',
    navigation: [{ title: 'Work', groups: [{ title: 'Items', items: [{ title: 'Items', entity: 'inv_item' }] }] }] }] });

test('the catalogue carries typed columns, form types, subgrids, views and apps from the Solution metadata', () => {
  const catalogue = modelDrivenInspectionCatalogue(metadataImport());
  const form = catalogue.forms[0];
  assert.equal(form.type, 'main');
  assert.deepEqual(form.controls.map(control => [control.kind, control.name || control.id]), [['field', 'inv_name'], ['subgrid', 'parts']]);
  assert.deepEqual(form.controls[1].subgrid, { entity: 'inv_part', view: '00000000-0000-4000-8000-0000000000a2', relationship: 'inv_item_inv_part' });
  const item = catalogue.tables.find(table => table.logicalName === 'inv_item');
  assert.equal(item.entitySet, 'inv_items'); assert.equal(item.fieldCount, 2); assert.equal(item.source, '/invented/Entities/inv_item/Entity.xml');
  assert.deepEqual(item.columns.find(column => column.name === 'inv_name'), { name: 'inv_name', label: 'Name', type: 'nvarchar', required: 'required', maxLength: 100, primaryName: true, source: '/invented/Entities/inv_item/Entity.xml' });
  assert.deepEqual(catalogue.views.map(view => [view.name, view.type]), [['Active items', 'public'], ['Parts of an item', 'associated']]);
  assert.deepEqual(catalogue.apps[0].navigation, [{ title: 'Items', entity: 'inv_item', area: 'Work' }]);
});

test('Inspect and X-ray read a record form by its ID and a list page by its view, never as Power Pages forms', () => {
  const catalogue = modelDrivenInspectionCatalogue(metadataImport());
  const base = { catalogue, resources: [], diagnostics: [] };
  const record = modelDrivenPanelInspection({ ...base, context: { pageType: 'entityrecord', entity: 'inv_item', formId: '00000000-0000-4000-8000-0000000000f1' } });
  assert.equal(record.forms[0].kind, 'model-driven-form'); assert.equal(record.forms[0].formType, 'main'); assert.match(record.forms[0].evidenceLabel, /Form ID of this page matched/);
  assert.deepEqual(record.columns.map(column => [column.name, column.type, column.required, column.ref]), [['inv_name', 'nvarchar', true, '/invented/Entities/inv_item/Entity.xml']]);
  assert.deepEqual(record.nativeComponents.map(item => [item.id, item.kind, item.entity, item.relationship]), [['parts', 'subgrid', 'inv_part', 'inv_item_inv_part']]);
  assert.deepEqual(record.tables.map(table => [table.logicalName, table.entitySet, table.fieldCount]), [['inv_item', 'inv_items', 2], ['inv_part', 'inv_parts', 1]]);
  assert.deepEqual(record.views.map(view => view.name), ['Parts of an item']);
  assert.doesNotMatch(JSON.stringify(record), /basic form/i);
  // Without the native form ID the table's main form is a candidate, named as one.
  const candidate = modelDrivenPanelInspection({ ...base, context: { pageType: 'entityrecord', entity: 'inv_item' } });
  assert.match(candidate.forms[0].evidenceLabel, /Candidate: the only main form of inv_item/);
  // A list page has no form: its views come first, the one in the address first, and its columns are the view's.
  const list = modelDrivenPanelInspection({ ...base, context: { pageType: 'entitylist', entity: 'inv_item', viewId: '00000000-0000-4000-8000-0000000000a1' } });
  assert.deepEqual(list.forms, []); assert.deepEqual(list.views.map(view => [view.name, view.evidence]), [['Active items', 'rendered-view-id']]);
  assert.deepEqual(list.columns.map(column => [column.name, column.type]), [['inv_name', 'nvarchar']]);
});
