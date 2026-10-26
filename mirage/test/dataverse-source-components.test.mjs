import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createSourceSolutionComponentStorage } from '../lib/dataverse-source-components.mjs';
import {
  solutionDocumentComponents,
  applySolutionPayloads,
  removeSolutionPayloads,
  withSolutionAppMembers,
} from '../lib/dataverse-solution-components.mjs';
import { standardTableDef } from '../lib/dataverse-standard.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { parseSchemaDocument, buildSolutionSchema } from '../lib/solution-schema.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';
import { readSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const FORM = '77777777-7777-4777-8777-777777777778';
const CLIENT = '77777777-7777-4777-8777-777777777779';
const ADMIN = { admin: true };
const source = (name = 'Source app') =>
  solutionDocumentComponents(
    `<AppModule><AppModuleId>${APP}</AppModuleId><UniqueName>new_sourceapp</UniqueName><Name>${name}</Name></AppModule>`,
  );

test('app members use known canonical targets, retain source reference provenance and omit unknown references', () => {
  const nativeTable = '77777777-7777-4777-8777-777777777783',
    localTable = '77777777-7777-4777-8777-777777777784';
  const components = solutionDocumentComponents(
    `<AppModule><AppModuleId>${APP}</AppModuleId><AppModuleComponents><AppModuleComponent type="1" schemaName="new_known" id="${nativeTable}"/><AppModuleComponent type="1" schemaName="new_unknown" id="${CLIENT}"/><AppModuleComponent type="60" id="${FORM}"/><AppModuleComponent type="26" id="${CLIENT}"/></AppModuleComponents></AppModule>`,
  );
  components.push(
    ...solutionDocumentComponents(
      `<Entity><Name>new_known</Name><FormXml><systemform><formid>${FORM}</formid><form/></systemform></FormXml></Entity>`,
    ),
  );
  const snapshot = JSON.stringify(components),
    state = { mappings: { new_known: {} }, tables: {} };
  const rows = withSolutionAppMembers(components, state, () => localTable).filter(
    (component) => component.kind === 'appmodulecomponent',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((component) => component.row.componenttype === 1).row.objectid, localTable);
  assert.equal(rows.find((component) => component.row.componenttype === 1).sourceObjectId, nativeTable);
  assert.match(rows[0].id, /^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  assert.equal(JSON.stringify(components), snapshot);
});

test('large application memberships resolve each source or existing table key within a bounded read budget', () => {
  const count = 2000,
    id = (value) => `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
  let componentReads = 0,
    rowReads = 0;
  const forms = Array.from({ length: count }, (_, index) => ({
    logical: 'systemform',
    kind: 'systemform',
    get id() {
      componentReads++;
      return id(index + 1);
    },
    row: {},
  }));
  const rows = Array.from({ length: count }, (_, index) => ({
    get savedqueryid() {
      rowReads++;
      return id(count + index + 1);
    },
  }));
  const members = forms
    .map((form, index) => ({ type: 60, objectId: id(index + 1) }))
    .concat(rows.map((row, index) => ({ type: 26, objectId: id(count + index + 1) })));
  const app = { logical: 'appmodule', kind: 'appmodule', id: APP, row: {}, members };
  const expanded = withSolutionAppMembers([...forms, app], { mappings: {}, tables: { savedquery: rows } });
  assert.equal(expanded.filter((component) => component.kind === 'appmodulecomponent').length, count * 2);
  assert.ok(componentReads <= count * 3, `Repeated source component scans: ${componentReads}`);
  assert.ok(rowReads <= count * 3, `Repeated existing-row scans: ${rowReads}`);
});

test('source metadata overlays are sparse, transactional and retain source siblings and deletion across restart', async (t) => {
  const store = new DataStore({ state: emptyState() });
  let components = source();
  const adapter = createSourceSolutionComponentStorage({ store, components: () => components });
  t.after(adapter.close);
  adapter.materialize();
  await store.update('appmodule', APP, { name: 'Local app' }, ADMIN);
  const before = store.snapshot();
  await assert.rejects(
    store.transact(
      async () => {
        await store.update('appmodule', APP, { name: 'Discarded' }, ADMIN);
        throw new Error('rollback');
      },
      { isolated: true },
    ),
    /rollback/,
  );
  assert.deepEqual(store.snapshot(), before);
  components = source('Changed source');
  components[0].row.uniquename = 'new_sourcechanged';
  adapter.materialize();
  assert.equal(store.state.tables.appmodule[0].name, 'Local app');
  assert.equal(store.state.tables.appmodule[0].uniquename, 'new_sourcechanged');
  assert.equal(components[0].row.name, 'Changed source');
  await store.remove('appmodule', APP, ADMIN);
  const restarted = new DataStore({ state: JSON.parse(JSON.stringify(store.state)) });
  const again = createSourceSolutionComponentStorage({ store: restarted, components: () => components });
  t.after(again.close);
  again.materialize();
  assert.equal(
    restarted.state.tables.appmodule.some((row) => row.appmoduleid === APP),
    false,
  );
});

test('active API solution layer does not leak into source deltas or resurrect after its removal', async (t) => {
  const store = new DataStore({ state: emptyState() });
  const adapter = createSourceSolutionComponentStorage({ store, components: () => source() });
  t.after(adapter.close);
  adapter.materialize();
  const solutionId = '77777777-7777-4777-8777-777777777780';
  applySolutionPayloads(store.state, solutionId, source('Imported app'), {
    overwrite: true,
    definitionOf: standardTableDef,
  });
  adapter.materialize();
  assert.equal(store.state.tables.appmodule[0].name, 'Imported app');
  await store.update('appmodule', APP, { name: 'Imported local edit' }, ADMIN);
  adapter.materialize();
  assert.equal(store.state.dataverse.sourceSolutionComponents.overlays[`appmodule/${APP}`], undefined);
  removeSolutionPayloads(store.state, [solutionId]);
  adapter.materialize();
  assert.equal(store.state.tables.appmodule[0].name, 'Source app');
  const metadata = solutionDocumentComponents(
    `<Entity><Name>x_item</Name><FormXml><systemform><formid>${FORM}</formid><form /></systemform></FormXml><SavedQueries><savedquery><savedqueryid>${CLIENT}</savedqueryid></savedquery></SavedQueries></Entity>`,
  );
  applySolutionPayloads(store.state, solutionId, metadata, { definitionOf: standardTableDef });
  assert.equal(store.state.mappings.savedquery.entitySet, 'savedqueries');
  assert.equal(store.state.mappings.systemform.idColumn, 'formid');
});

test('large source tables reconcile with bounded key reads while preserving order, local edits, tombstones and row versions', (t) => {
  const count = 2000,
    id = (value) => `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
  let components = Array.from({ length: count }, (_, index) => ({
    logical: 'systemform',
    kind: 'systemform',
    id: id(index + 1),
    type: 60,
    row: { formid: id(index + 1), name: `Source ${index}`, formxml: '<form/>' },
  }));
  const rows = components.map((component) => ({ ...component.row, __simVersion: 20, versionnumber: 20 }));
  rows[3].name = 'Local form edit';
  const local = { formid: id(count + 1), name: 'Local only form', formxml: '<form/>' };
  rows.splice(1000, 0, local);
  const state = emptyState();
  state.tables.systemform = rows;
  state.rowVersion = 20;
  const store = new DataStore({ state });
  let keyReads = 0;
  for (const row of store.state.tables.systemform) {
    const value = row.formid;
    Object.defineProperty(row, 'formid', {
      enumerable: true,
      configurable: true,
      get() {
        keyReads++;
        return value;
      },
    });
  }
  const adapter = createSourceSolutionComponentStorage({ store, components: () => components });
  t.after(adapter.close);
  adapter.materialize();
  assert.ok(keyReads <= count * 8, `Unexpected repeated source-table scan: ${keyReads} key reads for ${count} rows.`);
  assert.equal(store.state.rowVersion, 20);
  assert.equal(store.state.tables.systemform[3].name, 'Local form edit');
  const tombstone = `systemform/${id(6)}`;
  store.state.dataverse.sourceSolutionComponents.overlays[tombstone] = null;
  components = components.filter((_, index) => index % 2 === 1);
  components[4] = { ...components[4], row: { ...components[4].row, name: 'Changed source form' } };
  const added = {
    logical: 'systemform',
    kind: 'systemform',
    type: 60,
    id: id(count + 2),
    row: { formid: id(count + 2), name: 'Added source form', formxml: '<form/>' },
  };
  components.push(added);
  keyReads = 0;
  adapter.materialize();
  assert.ok(keyReads <= count * 12, `Unexpected repeated removal scan: ${keyReads} key reads.`);
  const expected = rows
    .filter((row) => row === local || (parseInt(row.formid.slice(0, 8), 16) % 2 === 0 && row.formid !== id(6)))
    .map((row) => row.formid)
    .concat(added.id);
  assert.deepEqual(
    store.state.tables.systemform.map((row) => row.formid),
    expected,
  );
  assert.equal(store.state.tables.systemform.find((row) => row.formid === id(4)).name, 'Local form edit');
  assert.equal(store.state.dataverse.sourceSolutionComponents.overlays[tombstone], null);
  assert.equal(store.state.rowVersion, 21);
  assert.equal(store.state.tables.systemform.find((row) => row.name === 'Changed source form').versionnumber, 21);
  assert.equal(store.state.dataverse.sourceSolutionComponents.baseline[`systemform/${id(1)}`], undefined);
});

test('source flags retain explicit false through layers and expose source ownership/providers', async () => {
  const entity = (flags) =>
    `<Entity><Name LocalizedName="Probe" OriginalName="new_probe" /><EntityInfo><entity Name="new_probe">${flags}<attributes /></entity></EntityInfo></Entity>`;
  const docs = [
    entity(
      '<OwnershipTypeMask>OrganizationOwned</OwnershipTypeMask><TableType>Virtual</TableType><DataSourceId>{11111111-2222-4333-8444-555555555555}</DataSourceId><DataProviderId>{11111111-2222-4333-8444-555555555556}</DataProviderId><ChangeTrackingEnabled>True</ChangeTrackingEnabled><IsOptimisticConcurrencyEnabled>1</IsOptimisticConcurrencyEnabled>',
    ),
    entity(
      '<ChangeTrackingEnabled>False</ChangeTrackingEnabled><IsOptimisticConcurrencyEnabled>0</IsOptimisticConcurrencyEnabled>',
    ),
  ];
  const scan = {
    inputs: [],
    diagnostics: [],
    layers: docs.map((xml, index) => ({
      index,
      name: `fixture${index}`,
      files: [],
      documents: [{ file: `fixture${index}.xml`, facts: parseSchemaDocument(xml) }],
    })),
  };
  const schema = buildSolutionSchema(scan);
  assert.equal(schema.tables.new_probe.changeTrackingEnabled, false);
  assert.equal(schema.tables.new_probe.isOptimisticConcurrencyEnabled, false);
  const metadata = await importSolutionMetadata([], { scan, schema });
  assert.equal(metadata.entities.new_probe.ownership, 'OrganizationOwned');
  assert.equal(metadata.entities.new_probe.tableType, 'Virtual');
  assert.equal(metadata.entities.new_probe.dataSourceId, '11111111-2222-4333-8444-555555555555');
});

async function client(sim, oldSecret) {
  const read = async (response, status = 200) => {
    const text = await response.text();
    assert.equal(response.status, status, text);
    return text ? JSON.parse(text) : null;
  };
  const secret =
    oldSecret ??
    (
      await read(
        await fetch(`${sim.url}/_sim/api/dataverse/applications`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
          body: JSON.stringify({
            appId: CLIENT,
            displayName: 'Source component fixture',
            roles: ['System Administrator'],
          }),
        }),
        201,
      )
    ).secret;
  const token = await read(
    await fetch(`${sim.dataverse.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: secret,
        scope: `${sim.dataverse.origin}/.default`,
      }),
    }),
  );
  return {
    secret,
    read,
    api: (method, suffix, body) =>
      fetch(`${sim.dataverse.origin}/api/data/v9.2${suffix}`, {
        method,
        headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    catalogue: () => fetch(`${sim.url}/_apps/api`).then(read),
  };
}

test('selected source app/form API writes and tombstones update catalogue, retain sitemap and survive restart without source writes', async (t) => {
  // The form id is edited into the export before the first start, so the fixture only writes its files.
  const fixture = await modelDrivenFixture(t, { dataverse: { enabled: true }, defer: true });
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(formFile, (await fs.readFile(formFile, 'utf8')).replace('{item-form}', `{${FORM}}`));
  const beforeForm = await fs.readFile(formFile, 'utf8');
  const appFile = path.join(fixture.solutionDir, 'AppModules/x_example/AppModule.xml'),
    beforeApp = await fs.readFile(appFile, 'utf8');
  const sim = await fixture.start();
  const connected = await client(sim);
  assert.equal((await connected.read(await connected.api('GET', `/appmodules(${APP})`))).uniquename, 'x_example');
  assert.equal((await connected.read(await connected.api('GET', `/systemforms(${FORM})`))).type, 2);
  const table = await connected.read(
    await connected.api('GET', "/EntityDefinitions(LogicalName='x_item')?$select=MetadataId"),
  );
  const members = await connected.read(await connected.api('GET', `/RetrieveAppComponents(AppModuleId=${APP})`));
  assert.equal(members.value.length, 1);
  assert.equal(members.value[0].componenttype, 1);
  assert.equal(members.value[0].objectid, table.MetadataId);
  await connected.read(
    await connected.api('POST', '/RemoveAppComponents', { AppId: APP, Components: [{ objectid: table.MetadataId }] }),
    204,
  );
  assert.equal(
    (await connected.read(await connected.api('GET', `/RetrieveAppComponents(AppModuleId=${APP})`))).value.length,
    0,
  );
  await connected.read(
    await connected.api('PATCH', `/appmodules(${APP})`, { name: 'Renamed source app', uniquename: 'x_renamed' }),
    204,
  );
  await connected.read(await connected.api('PATCH', `/systemforms(${FORM})`, { name: 'Renamed source form' }), 204);
  const catalogue = await connected.catalogue();
  const app = catalogue.apps.find((app) => app.id === APP);
  assert.equal(app.name, 'Renamed source app');
  assert.equal(app.uniqueName, 'x_renamed');
  assert.equal(app.navigation[0].groups[0].title, 'Work');
  assert.equal(catalogue.tables.x_item.forms.find((form) => form.id === FORM)?.name, 'Renamed source form');
  await connected.read(await connected.api('DELETE', `/systemforms(${FORM})`), 204);
  assert.equal(
    (await connected.catalogue()).tables.x_item.forms.some((form) => form.id === FORM),
    false,
  );
  await sim.close();
  const restarted = await fixture.start();
  const again = await client(restarted, connected.secret);
  assert.equal(
    (await again.read(await again.api('GET', `/RetrieveAppComponents(AppModuleId=${APP})`))).value.length,
    0,
    'source membership removal survives refresh/restart',
  );
  await again.read(
    await again.api('POST', '/AddAppComponents', {
      AppId: APP,
      Components: [{ '@odata.type': 'Microsoft.Dynamics.CRM.entity', objectid: table.MetadataId }],
    }),
    204,
  );
  assert.equal(
    (await again.read(await again.api('GET', `/RetrieveAppComponents(AppModuleId=${APP})`))).value.length,
    1,
  );
  assert.equal((await again.read(await again.api('GET', `/appmodules(${APP})`))).name, 'Renamed source app');
  await again.read(await again.api('GET', `/systemforms(${FORM})`), 404);
  assert.equal((await again.catalogue()).apps.find((app) => app.id === APP).navigation[0].groups[0].title, 'Work');
  await again.read(await again.api('DELETE', `/appmodules(${APP})`), 204);
  assert.equal(
    (await again.catalogue()).apps.some((app) => app.id === APP),
    false,
  );
  await restarted.close();
  const deletedRestart = await fixture.start();
  const deletedClient = await client(deletedRestart, connected.secret);
  await deletedClient.read(await deletedClient.api('GET', `/appmodules(${APP})`), 404);
  assert.equal(
    (await deletedClient.catalogue()).apps.some((app) => app.id === APP),
    false,
  );
  assert.equal(await fs.readFile(formFile, 'utf8'), beforeForm);
  assert.equal(await fs.readFile(appFile, 'utf8'), beforeApp);
});

test('API archive import runs its model app, shares UI/API CRUD, restarts and exports into a fresh instance', async (t) => {
  const appId = '88888888-8888-4888-8888-888888888881',
    formId = '88888888-8888-4888-8888-888888888882',
    viewId = '88888888-8888-4888-8888-888888888883';
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types />') },
    {
      name: 'solution.xml',
      data: Buffer.from(
        '<ImportExportXml><SolutionManifest><UniqueName>new_runtimeapp</UniqueName><Version>1.0.0.0</Version><Managed>0</Managed><Publisher><UniqueName>new_fixturepublisher</UniqueName><CustomizationPrefix>new</CustomizationPrefix></Publisher></SolutionManifest></ImportExportXml>',
      ),
    },
    {
      name: 'customizations.xml',
      data: Buffer.from(
        `<ImportExportXml><Entities><Entity><Name LocalizedName="Runtime item" OriginalName="new_runtimeitem"/><EntityInfo><entity Name="new_runtimeitem"><OwnershipTypeMask>OrganizationOwned</OwnershipTypeMask><attributes><attribute PhysicalName="new_Name"><Type>nvarchar</Type><Name>new_Name</Name><LogicalName>new_name</LogicalName><DisplayMask>ValidForRead|ValidForForm|PrimaryName</DisplayMask><MaxLength>100</MaxLength></attribute></attributes></entity></EntityInfo><FormXml><systemform><formid>${formId}</formid><type>2</type><LocalizedNames><LocalizedName languagecode="1033" description="Runtime form"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control datafieldname="new_name" /></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></FormXml><SavedQueries><savedquery><savedqueryid>${viewId}</savedqueryid><querytype>0</querytype><isdefault>1</isdefault><LocalizedNames><LocalizedName languagecode="1033" description="Runtime items"/></LocalizedNames><fetchxml><fetch><entity name="new_runtimeitem"><attribute name="new_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="new_name" width="240"/></row></grid></layoutxml></savedquery></SavedQueries></Entity></Entities><AppModules><AppModule><AppModuleId>${appId}</AppModuleId><UniqueName>new_runtime</UniqueName><Name>Runtime app</Name><SiteMap><Area Id="runtime"><Group Id="work"><SubArea Id="items" Entity="new_runtimeitem"/></Group></Area></SiteMap></AppModule></AppModules></ImportExportXml>`,
      ),
    },
    { name: 'WebResources/new_opaque.js', data: Buffer.from('throw new Error("never execute imported scripts");\n') },
  ];
  const fixture = await modelDrivenFixture(t, { dataverse: { enabled: true } }),
    connected = await client(fixture.sim);
  const sourceAppFile = path.join(fixture.solutionDir, 'AppModules/x_example/AppModule.xml'),
    sourceBefore = await fs.readFile(sourceAppFile, 'utf8');
  await connected.read(
    await connected.api('POST', '/ImportSolution', { CustomizationFile: zipOf(files).toString('base64') }),
    204,
  );
  const catalogue = await connected.catalogue(),
    app = catalogue.apps.find((app) => app.id === appId);
  assert.equal(app.navigation[0].groups[0].items[0].entity, 'new_runtimeitem');
  assert.equal(catalogue.tables.new_runtimeitem.forms[0].id, formId);
  assert.equal(catalogue.tables.new_runtimeitem.views[0].id, viewId);
  const created = await connected.read(
    await fetch(`${fixture.sim.url}/_apps/api/tables/new_runtimeitem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': fixture.sim.csrf },
      body: JSON.stringify({ new_name: 'Created in model app' }),
    }),
    201,
  );
  const recordId = created.row.new_runtimeitemid;
  assert.equal(
    (await connected.read(await connected.api('GET', `/new_runtimeitems(${recordId})`))).new_name,
    'Created in model app',
  );
  await connected.read(
    await connected.api('PATCH', `/new_runtimeitems(${recordId})`, { new_name: 'Changed through API' }),
    204,
  );
  assert.equal(
    (await connected.read(await fetch(`${fixture.sim.url}/_apps/api/tables/new_runtimeitem/${recordId}`))).row.new_name,
    'Changed through API',
  );
  await fixture.sim.close();
  const restarted = await fixture.start();
  const again = await client(restarted, connected.secret);
  assert.equal((await again.catalogue()).tables.new_runtimeitem.forms[0].id, formId);
  assert.equal(
    (await again.read(await again.api('GET', `/new_runtimeitems(${recordId})`))).new_name,
    'Changed through API',
  );
  const exported = await again.read(
    await again.api('POST', '/ExportSolution', { SolutionName: 'new_runtimeapp', Managed: false }),
  );
  assert.deepEqual(
    readSolutionAssetEntries(Buffer.from(exported.ExportSolutionFile, 'base64')).find(
      (entry) => entry.name === 'WebResources/new_opaque.js',
    ).data,
    files.at(-1).data,
  );
  const target = await modelDrivenFixture(t, { dataverse: { enabled: true } }),
    fresh = await client(target.sim);
  await fresh.read(await fresh.api('POST', '/ImportSolution', { CustomizationFile: exported.ExportSolutionFile }), 204);
  const imported = await fresh.catalogue();
  assert.deepEqual(imported.apps.find((app) => app.id === appId).navigation, app.navigation);
  assert.equal(imported.tables.new_runtimeitem.forms[0].id, formId);
  assert.equal(imported.tables.new_runtimeitem.views[0].id, viewId);
  assert.equal(await fs.readFile(sourceAppFile, 'utf8'), sourceBefore);
});
