import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createModelDrivenMetadataIndex,
  normalizeModelDrivenMetadataRequest,
} from '../lense/model-driven-metadata.mjs';
import { compileForm } from '../mirage/lib/model-driven/solution.mjs';
import { modelDrivenControlKey } from '../mirage/lib/model-driven/provenance-registry.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';
import { createSolutionMetadataOverlay } from '../mirage/lib/dataverse-solution-metadata.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const guid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// 205 items and 1105 details exceed the former global inspection caps (200 items per kind, 1000 details), which
// once dropped the active form, view or command when it came late in the catalogue.
test('cold native command selectors prioritize full scoped exported declarations beyond catalogue caps', () => {
  const identifier = 'fixture_item|NoRelationship|Form|fixture.review';
  const commands = Array.from({ length: 1105 }, (_, index) => ({
    id: `fixture_command_${index}`,
    entity: 'fixture_item',
    locations: ['form'],
    label: `Command ${index}`,
    nativeControlIds: [],
  }));
  commands[1104].nativeControlIds = [identifier];
  const index = createModelDrivenMetadataIndex({
    appActions: [
      ...commands,
      { ...commands[1104], id: 'wrong_table', entity: 'fixture_other' },
      { ...commands[1104], id: 'wrong_location', locations: ['grid'] },
      { ...commands[1104], id: 'duplicate' },
    ],
  });
  const selector = `native-command:${encodeURIComponent(identifier)}`;
  const selected = index.query({ active: { entity: 'fixture_item' }, componentKeys: [selector], budget: { items: 2 } });
  assert.deepEqual(
    selected.catalogue.commands.map((command) => command.id),
    ['fixture_command_1104', 'duplicate'],
  );
  assert.ok(
    selected.catalogue.commands.every((command) => command.sourceRefs.length === 0),
    'a parsed declaration without an actual local file cannot invent source identity',
  );
  const wrongTable = index.query({
    active: { entity: 'fixture_other' },
    componentKeys: [selector],
    budget: { items: 1 },
  });
  assert.ok(wrongTable.unavailable.some((item) => item.key === selector));
});
async function fixture(t, count = 3) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-model-metadata-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const formFile = path.join(directory, 'form.xml'),
    entityFile = path.join(directory, 'Entity.xml');
  const fields = Object.fromEntries(
    Array.from({ length: count }, (_, n) => [
      `fixture_field_${n}`,
      { name: `fixture_field_${n}`, type: 'String', source: entityFile },
    ]),
  );
  const controls = Array.from(
    { length: count },
    (_, n) =>
      `<row><cell><control id="fixture_field_${n}" uniqueid="{${guid(n + 1000)}}" datafieldname="fixture_field_${n}"/></cell></row>`,
  ).join('\n');
  const xml = `<form>\n<header><rows><row><cell><control id="shared" uniqueid="{${guid(10)}}" datafieldname="fixture_field_0"/></cell></row></rows></header>\n<tabs><tab id="tab-guid" name="fixture_tab"><columns><column><sections><section id="section-guid" name="fixture_section"><rows>\n${controls}\n</rows></section></sections></column></columns></tab></tabs>\n<footer><rows><row><cell><control id="shared" uniqueid="{${guid(11)}}" datafieldname="fixture_field_0"/></cell></row></rows></footer>\n</form>`;
  const entity = `<Entity><Name>fixture_item</Name><EntityInfo><entity Name="fixture_item"><attributes>${Object.keys(
    fields,
  )
    .map(
      (name) => `<attribute PhysicalName="${name}"><LogicalName>${name}</LogicalName><Type>nvarchar</Type></attribute>`,
    )
    .join('\n')}</attributes></entity></EntityInfo></Entity>`;
  await fs.writeFile(formFile, xml);
  await fs.writeFile(entityFile, entity);
  const imported = {
    assets: new Map(),
    layers: [],
    metadata: {
      sourceRevisions: { [formFile]: hash(xml), [entityFile]: hash(entity) },
      entities: { fixture_item: { entity: 'fixture_item', fields, sources: [entityFile] } },
      forms: [{ id: guid(1), entity: 'fixture_item', name: 'Fixture', xml, file: formFile, systemFormType: 2 }],
      views: [],
    },
  };
  return { imported, xml, fields, formFile, entityFile };
}

test('active form/control lookup passes old global caps without serializing arbitrary prefix details', async (t) => {
  const source = await fixture(t, 1105);
  source.imported.metadata.forms = Array.from({ length: 205 }, (_, index) => ({
    ...source.imported.metadata.forms[0],
    id: guid(index + 1),
  }));
  const index = createModelDrivenMetadataIndex(source.imported, { sourceRevision: 'source:1' });
  assert.equal(index.counts().forms, 205);
  const report = index.query({
    active: { entity: 'fixture_item', formId: guid(205), controlNames: ['fixture_field_1104'] },
    budget: { items: 8, bytes: 32768 },
  });
  assert.equal(report.catalogue.forms[0].id, guid(205));
  assert.equal(report.catalogue.forms[0].controls[0].id, 'fixture_field_1104');
  assert.equal(report.catalogue.forms[0].controlCount, 1107);
  assert.equal(report.catalogue.forms[0].controlsComplete, false);
  assert.deepEqual(report.catalogue.forms[0].regions, ['header', 'body', 'footer']);
  assert.equal(report.catalogue.forms[0].structure[0].name, 'fixture_tab');
  const key = modelDrivenControlKey(guid(205), { uniqueId: guid(2104) });
  const refs = index.sourceRefsFor([key]);
  assert.equal(refs.length, 1);
  assert.match(source.xml.slice(refs[0].region.start, refs[0].region.end), /fixture_field_1104/);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= report.limits.maxBytes);
});

test('cold semantic source keys resolve through the complete index and ignore client paths or positions', async (t) => {
  const source = await fixture(t);
  const first = createModelDrivenMetadataIndex(source.imported);
  const keys = [
    modelDrivenControlKey(guid(1), { uniqueId: guid(1000) }),
    `tab:${guid(1)}:fixture_tab`,
    `section:${guid(1)}:section-guid`,
  ];
  for (const ref of first.sourceRefsFor(keys)) {
    const cold = createModelDrivenMetadataIndex(source.imported);
    const result = cold.resolveOpen({
      sourceKey: ref.id,
      sourceRevision: ref.sourceRevision,
      contentRevision: ref.contentRevision,
      ref: '/forged/path',
      line: 9999,
      region: { line: 9999 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.line, ref.region.line);
    assert.equal(result.file, await fs.realpath(source.formFile));
    assert.equal(
      cold.resolveOpen({
        sourceKey: ref.id,
        componentKey: 'table:other',
        sourceRevision: ref.sourceRevision,
        contentRevision: ref.contentRevision,
      }).ok,
      false,
    );
  }
});

test('acknowledged script callsite offsets open the current resource with server-derived BOM/Unicode positions', async (t) => {
  const source = await fixture(t);
  const file = path.join(path.dirname(source.formFile), 'fixture.js');
  const text = '\ufeff// Invented Unicode 🌿\r\nconst value = 1;\u2028document.createElement("section");\n';
  await fs.writeFile(file, text);
  source.imported.assets.set('/WebResources/fixture.js', {
    name: 'fixture.js',
    file,
    data: Buffer.from(text),
    mime: 'text/javascript',
  });
  const index = createModelDrivenMetadataIndex(source.imported);
  const [ref] = index.sourceRefsFor(['resource:fixture.js']);
  const body = {
    sourceKey: ref.id,
    sourceRevision: ref.sourceRevision,
    contentRevision: ref.contentRevision,
    region: { start: 0, end: 1, line: 999, column: 999 },
  };
  assert.equal(
    index.resolveOpen(body).locationAvailable,
    false,
    'unscoped client positions cannot create an exact resource location',
  );
  const start = text.indexOf('document'),
    end = text.indexOf(';', start) + 1;
  const opened = index.resolveOpen(body, { observedRegion: { start, end, line: 999, column: 999 } });
  assert.equal(opened.line, 3);
  assert.equal(opened.column, 1);
  assert.equal(
    index.resolveOpen(body, { observedRegion: { start, end: text.length + 1 } }).reason,
    'source-location-unavailable',
  );
  await fs.writeFile(file, text + '// edited');
  assert.equal(index.resolveOpen(body, { observedRegion: { start, end } }).ok, false);
});

test('bounded form detail pages preserve every structural region and placement without hiding omitted sections', async (t) => {
  const source = await fixture(t, 220);
  const sections = Array.from(
    { length: 220 },
    (_, number) =>
      `<section id="fixture_section_${number}" name="fixture_section_${number}"><rows><row><cell><control id="fixture_field_${number}" uniqueid="{${guid(number + 1000)}}" datafieldname="fixture_field_${number}"/></cell></row></rows></section>`,
  ).join('');
  const xml = source.xml.replace(/<sections>[\s\S]*<\/sections>/, `<sections>${sections}</sections>`);
  await fs.writeFile(source.formFile, xml);
  source.imported.metadata.forms[0].xml = xml;
  source.imported.metadata.sourceRevisions[source.formFile] = hash(xml);
  const index = createModelDrivenMetadataIndex(source.imported),
    controlKeys = new Set(),
    structureKeys = new Set();
  let cursor,
    pages = 0;
  do {
    const report = index.query({
      active: { formId: guid(1), controlNames: ['fixture_field_219'] },
      cursor,
      budget: { items: 12, bytes: 16384 },
    });
    const form = report.catalogue.forms[0];
    assert.ok(form, 'an oversized structure cannot discard the active form');
    if (!pages) assert.equal(form.controls[0].id, 'fixture_field_219');
    assert.deepEqual(form.regions, ['header', 'body', 'footer']);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) <= report.limits.maxBytes);
    for (const control of form.controls) {
      assert.ok(!controlKeys.has(control.key));
      controlKeys.add(control.key);
    }
    for (const structure of form.structure) {
      assert.ok(!structureKeys.has(structure.key));
      structureKeys.add(structure.key);
    }
    const next = form.detailsCursor;
    if (next) assert.notDeepEqual(next, cursor, 'detail continuation always makes progress');
    cursor = next;
    assert.ok(++pages < 500);
  } while (cursor);
  assert.equal(controlKeys.size, 222);
  assert.equal(structureKeys.size, 221);
  assert.ok(pages > 1);
});

test('active view beyond the old cap remains first and unverified parsed revisions cannot produce source actions', async (t) => {
  const source = await fixture(t);
  source.imported.metadata.views = Array.from({ length: 205 }, (_, number) => ({
    id: guid(number + 500),
    entity: 'fixture_item',
    file: source.formFile,
    name: 'Invented view ' + number,
  }));
  const index = createModelDrivenMetadataIndex(source.imported);
  const report = index.query({ active: { viewId: guid(704) }, budget: { items: 4, bytes: 8192 } });
  assert.equal(report.catalogue.views[0].id, guid(704));
  assert.ok(report.limits.truncated);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= report.limits.maxBytes);
  delete source.imported.metadata.sourceRevisions[source.formFile];
  const unverified = createModelDrivenMetadataIndex(source.imported);
  const [ref] = unverified.sourceRefsFor([modelDrivenControlKey(guid(1), { uniqueId: guid(1000) })]);
  assert.equal(ref.currentState, 'unavailable');
  assert.equal(
    unverified.resolveOpen({
      sourceKey: ref.id,
      sourceRevision: ref.sourceRevision,
      contentRevision: ref.contentRevision,
    }).reason,
    'source-origin-revision-unverified',
  );
});

test('an indivisible oversized detail reports its limit instead of producing an endless continuation', async (t) => {
  const source = await fixture(t, 1);
  const xml = source.xml.replace(
    '<form>',
    `<form><formLibraries><Library name="${'invented'.repeat(10000)}"/></formLibraries>`,
  );
  await fs.writeFile(source.formFile, xml);
  source.imported.metadata.forms[0].xml = xml;
  source.imported.metadata.sourceRevisions[source.formFile] = hash(xml);
  const index = createModelDrivenMetadataIndex(source.imported);
  const report = index.query({ active: { formId: guid(1) }, budget: { items: 32, bytes: 32768 } });
  assert.ok(
    report.unavailable.some((item) => item.detail === 'libraries' && item.reason === 'detail-exceeds-response-budget'),
  );
  assert.equal(report.catalogue.forms[0].libraryCount, 1);
  assert.equal(report.catalogue.forms[0].librariesComplete, false);
  assert.equal(report.catalogue.forms[0].detailsCursor, undefined);
});

test('metadata transport admits only supported versions and bounded selector shapes', () => {
  const request = {
    version: 1,
    active: { formId: guid(1), controlNames: ['fixture_name'] },
    componentKeys: ['column:fixture_item:fixture_name'],
  };
  assert.deepEqual(normalizeModelDrivenMetadataRequest(request), {
    active: request.active,
    componentKeys: request.componentKeys,
  });
  for (const patch of [
    { version: 2 },
    { active: [] },
    { active: { controlNames: 'fixture_name' } },
    { componentKeys: [1] },
    { componentKeys: Array(129).fill('x') },
    { cursor: { sourceRevision: '1', offset: -1 } },
  ])
    assert.equal(normalizeModelDrivenMetadataRequest({ ...request, ...patch }), null);
});

test('effective simulated form, view and column edits lose the unchanged imported file origin', async (t) => {
  const source = await fixture(t);
  const form = source.imported.metadata.forms[0],
    viewId = guid(300),
    column = source.fields.fixture_field_0;
  column.columnMetadata = { maxLength: 20 };
  const viewFile = path.join(path.dirname(source.formFile), 'view.xml');
  const viewXml = `<savedquery><savedqueryid>{${viewId}}</savedqueryid><fetchxml><fetch><entity name="fixture_item"/></fetch></fetchxml></savedquery>`;
  await fs.writeFile(viewFile, viewXml);
  const view = {
    id: viewId,
    entity: 'fixture_item',
    name: 'Fixture view',
    fetchXml: '<fetch><entity name="fixture_item"/></fetch>',
    queryType: 0,
    fields: [{ name: 'fixture_field_0', width: 180 }],
    file: viewFile,
  };
  source.imported.metadata.views = [view];
  source.imported.metadata.sourceRevisions[viewFile] = hash(viewXml);
  const state = {
    dataverse: {
      sourceSolutionComponents: { baseline: { [`systemform/${form.id}`]: {}, [`savedquery/${viewId}`]: {} } },
    },
    tables: {
      systemform: [{ formid: form.id, name: form.name, formxml: form.xml, type: 2 }],
      savedquery: [{ savedqueryid: viewId, name: view.name, fetchxml: view.fetchXml, querytype: 0 }],
    },
    mappings: { fixture_item: { fields: { fixture_field_0: structuredClone(column) } } },
  };
  const overlay = createSolutionMetadataOverlay();
  const key = modelDrivenControlKey(form.id, { uniqueId: guid(1000) }),
    keys = [key, 'column:fixture_item:fixture_field_0', 'view:' + viewId];
  assert.equal(
    createModelDrivenMetadataIndex({ metadata: overlay(source.imported.metadata, state) }).sourceRefsFor(keys).length,
    3,
  );
  state.tables.systemform[0].formxml = form.xml.replace('id="fixture_field_0"', 'id="changed_control"');
  state.tables.savedquery[0].fetchxml = '<fetch><entity name="different_fixture_table"/></fetch>';
  state.mappings.fixture_item.fields.fixture_field_0.columnMetadata.maxLength = 30;
  const changed = overlay(source.imported.metadata, state);
  assert.equal(changed.forms[0].sourceOriginVerified, false);
  assert.equal(changed.views[0].sourceOriginVerified, false);
  assert.equal(changed.entities.fixture_item.fields.fixture_field_0.sourceOriginVerified, false);
  const index = createModelDrivenMetadataIndex({ metadata: changed });
  assert.deepEqual(index.sourceRefsFor(keys), []);
  assert.ok(
    index
      .query({ active: { formId: form.id }, componentKeys: keys })
      .unavailable.some((item) => item.reason === 'effective-definition-has-no-local-file-origin'),
  );
  assert.equal(
    source.imported.metadata.forms[0].sourceOriginVerified,
    undefined,
    'imported definitions remain immutable',
  );
});

test('header/footer identity and structural source ranges distinguish repeated control names', async (t) => {
  const source = await fixture(t);
  const compiled = compileForm(source.imported.metadata.forms[0], source.fields);
  assert.deepEqual(
    compiled.regionControls.map((control) => control.sourceControl.uniqueId),
    [`{${guid(10)}}`, `{${guid(11)}}`],
  );
  assert.equal(compiled.tabs[0].sourceStructure.id, 'tab-guid');
  assert.equal(compiled.tabs[0].sections[0].sourceStructure.id, 'section-guid');
  const index = createModelDrivenMetadataIndex(source.imported, { sourceRevision: '1' });
  const refs = index.sourceRefsFor([
    modelDrivenControlKey(guid(1), { uniqueId: guid(10) }, 'header'),
    modelDrivenControlKey(guid(1), { uniqueId: guid(11) }, 'footer'),
  ]);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0].region.start, refs[1].region.start);
  assert.notEqual(refs[0].placementKey, refs[1].placementKey);
  for (const ref of refs) {
    const opened = index.resolveOpen({
      sourceKey: ref.id,
      sourceRevision: ref.sourceRevision,
      contentRevision: ref.contentRevision,
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.line, ref.region.line);
  }
  const [column] = index.sourceRefsFor(['column:fixture_item:fixture_field_2']);
  assert.deepEqual(column.fieldPath, ['fields', 'fixture_field_2']);
  assert.match(
    (await fs.readFile(source.entityFile, 'utf8')).slice(column.region.start, column.region.end),
    /fixture_field_2/,
  );
});

test('an edit between import and lazy indexing remains stale and cannot open the newer file as old evidence', async (t) => {
  const source = await fixture(t);
  const before = source.imported.metadata.sourceRevisions[source.formFile];
  await fs.writeFile(source.formFile, source.xml.replace('id="fixture_field_0"', 'id="changed_field"'));
  const index = createModelDrivenMetadataIndex(source.imported, { sourceRevision: '1' });
  const key = modelDrivenControlKey(guid(1), { uniqueId: guid(1000) });
  const [ref] = index.sourceRefsFor([key]);
  assert.equal(ref.contentRevision, before);
  assert.notEqual(ref.currentContentRevision, before);
  assert.equal(ref.region, undefined);
  const scope = { documentId: 'd', frameId: 'f', uiEpoch: 1, sourceRevision: '1' };
  const result = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'local',
    sourceRefs: [ref],
    facts: [
      {
        dimension: 'owner',
        subject: 'selection',
        predicate: 'identity',
        proof: 'mirage-registry',
        scope,
        binding: { kind: 'control', key },
        sourceRefIds: [ref.id],
      },
    ],
  });
  assert.equal(result.owner.status, 'exact');
  assert.equal(result.source.status, 'stale');
  assert.equal(index.resolveOpen({ sourceKey: ref.id, sourceRevision: '1', contentRevision: before }).ok, false);
  assert.equal(index.resolveOpen({ sourceKey: 'invented', sourceRevision: '1', contentRevision: before }).ok, false);
});

test('duplicate placement identity refuses a first-occurrence source range', async (t) => {
  const source = await fixture(t);
  const xml = source.xml.replace(
    '</rows></section>',
    `<row><cell><control id="fixture_field_0" uniqueid="{${guid(1000)}}" datafieldname="fixture_field_0"/></cell></row></rows></section>`,
  );
  await fs.writeFile(source.formFile, xml);
  source.imported.metadata.forms[0].xml = xml;
  source.imported.metadata.sourceRevisions[source.formFile] = hash(xml);
  const index = createModelDrivenMetadataIndex(source.imported);
  assert.deepEqual(index.sourceRefsFor([modelDrivenControlKey(guid(1), { uniqueId: guid(1000) })]), []);
});
