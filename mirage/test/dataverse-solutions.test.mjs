// Solution export and import over the Dataverse Web API.
// Round trip: a solution built from metadata writes that name it in MSCRM.SolutionUniqueName is exported, then imported into a
// fresh simulator, where the table, columns, option set and relationship exist and the Web API creates a row in the table.
// @test-kind contract: Paqvilo's own solution import, upgrade and job behaviour; no recorded platform capture backs these assertions
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { readSolutionZip } from '../lib/solution-schema.mjs';
import { zipOf, solutionImportJob, stampImportedRow } from '../lib/dataverse-solutions.mjs';
import { resyncMessageFilters } from '../lib/dataverse-plugin-registration.mjs';
import { applySolutionPayloads } from '../lib/dataverse-solution-components.mjs';
import { standardTableDef } from '../lib/dataverse-standard.mjs';
import { reset as resetAsyncJobs } from '../lib/dataverse-async.mjs';
import { createScheduler, fixedClock, storeScheduler } from '../lib/runtime-clock.mjs';
import { componentObjectId } from '../lib/dataverse-metadata-relationships.mjs';
import { dataverseOrganizationId } from '../lib/dataverse-organization.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { signedInRequester } from './support/web-api.mjs';

const APP_ID = '55555555-5555-4555-8555-555555555555';
const CLERK_APP_ID = '66666666-6666-4666-8666-666666666666';
const SOLUTION = 'new_samplesolution';
// The organization every default-settings server runs as; a metadata component id is its MetadataId in it.
const ORG = dataverseOrganizationId(dataverseSettings({ enabled: true }));
const PUBLISHER = 'new_samplepublisher';
const SOLUTION_HEADER = { 'MSCRM.SolutionUniqueName': SOLUTION };
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const column = (type, schema, extra = {}) => ({
  '@odata.type': `#Microsoft.Dynamics.CRM.${type}AttributeMetadata`,
  SchemaName: schema,
  DisplayName: label(schema),
  ...extra,
});
const primaryName = () =>
  column('String', 'new_Name', { IsPrimaryName: true, MaxLength: 100, FormatName: { Value: 'Text' } });
const tableBody = (schema, extra = {}) => ({
  '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: schema,
  DisplayName: label(schema.replace('new_', 'Sample ')),
  DisplayCollectionName: label(`${schema} records`),
  Description: label(''),
  OwnershipType: 'OrganizationOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [primaryName()],
  ...extra,
});

let counter = 0;
// One loopback server with an application user holding the given role. capture receives the api object.
async function startServer({
  roles = ['System Administrator'],
  appId = APP_ID,
  state = emptyState(),
  scheduler = null,
  change,
} = {}) {
  const secretVariable = `PAQVILO_SOLUTIONS_TEST_SECRET_${++counter}`;
  process.env[secretVariable] = 'test-secret-value';
  const store = await new DataStore({ state }).init();
  if (scheduler) storeScheduler(store, scheduler);
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId, displayName: 'Solutions test app', secretEnvironmentVariable: secretVariable, roles }],
  });
  const captured = {};
  const capture = {
    name: 'dataverse-solutions-test-capture',
    install(api) {
      captured.api = api;
    },
  };
  const server = await startDataverseApi({
    store,
    settings,
    change,
    extensions: [...EXTENSIONS, capture],
    log: () => {},
  });
  const request = await signedInRequester(server, appId, process.env[secretVariable]);
  const secret = process.env[secretVariable];
  return {
    server,
    store,
    api: captured.api,
    request,
    batch: (requests) => postBatch(server, appId, secret, requests),
    close: async () => {
      delete process.env[secretVariable];
      await server.close();
    },
  };
}

// A JSON $batch posted as the application. Its answer is multipart, so it comes back as text.
async function postBatch(server, appId, secret, requests) {
  const token = await (
    await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: secret,
        scope: `${server.origin}/.default`,
      }),
    })
  ).json();
  const response = await fetch(`${server.origin}/api/data/v9.2/$batch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  return { status: response.status, text: await response.text() };
}

// Records the unhandled promise rejections raised while run() and the turn after it take place.
async function unhandledDuring(run) {
  const seen = [];
  const listener = (error) => seen.push(error);
  process.on('unhandledRejection', listener);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

const idOf = (response) => /\(([0-9a-f-]{36})\)/i.exec(response.headers.get('odata-entityid') ?? '')?.[1];
const rowsOf = (store, table) => store.state.tables[table] ?? [];

// Builds the source solution through the metadata API: a table, a text and a picklist column, a global option set and a lookup.
async function buildSourceSolution(source) {
  const { request } = source;
  const publisher = await request('POST', '/publishers', {
    uniquename: PUBLISHER,
    friendlyname: 'Sample Publisher',
    customizationprefix: 'new',
    customizationoptionvalueprefix: 10000,
  });
  assert.equal(publisher.status, 204, JSON.stringify(publisher.json));
  const publisherId =
    idOf(publisher) ??
    (await request('GET', `/publishers?$select=publisherid&$filter=uniquename eq '${PUBLISHER}'`)).json.value[0]
      .publisherid;
  const created = await request('POST', '/solutions', {
    uniquename: SOLUTION,
    friendlyname: 'Sample Solution',
    version: '1.0.0.0',
    'publisherid@odata.bind': `/publishers(${publisherId})`,
  });
  assert.equal(created.status, 204, JSON.stringify(created.json));

  const set = await request(
    'POST',
    '/GlobalOptionSetDefinitions',
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.OptionSetMetadata',
      Name: 'new_tier',
      DisplayName: label('Tier'),
      Options: [
        { Value: 100000000, Label: label('Gold') },
        { Value: 100000001, Label: label('Silver') },
      ],
    },
    SOLUTION_HEADER,
  );
  assert.equal(set.status, 204, JSON.stringify(set.json));

  const widget = await request('POST', '/EntityDefinitions', tableBody('new_widget'), SOLUTION_HEADER);
  assert.equal(widget.status, 204, JSON.stringify(widget.json));
  const code = await request(
    'POST',
    "/EntityDefinitions(LogicalName='new_widget')/Attributes",
    column('String', 'new_Code', { MaxLength: 20, FormatName: { Value: 'Text' } }),
    SOLUTION_HEADER,
  );
  assert.equal(code.status, 204, JSON.stringify(code.json));
  const tier = await request(
    'POST',
    "/EntityDefinitions(LogicalName='new_widget')/Attributes",
    {
      ...column('Picklist', 'new_Tier'),
      'GlobalOptionSet@odata.bind': "GlobalOptionSetDefinitions(Name='new_tier')",
    },
    SOLUTION_HEADER,
  );
  assert.equal(tier.status, 204, JSON.stringify(tier.json));

  const category = await request('POST', '/EntityDefinitions', tableBody('new_category'), SOLUTION_HEADER);
  assert.equal(category.status, 204, JSON.stringify(category.json));
  const relationship = await request(
    'POST',
    '/RelationshipDefinitions',
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
      SchemaName: 'new_widget_category',
      ReferencedEntity: 'new_category',
      ReferencingEntity: 'new_widget',
      ReferencedAttribute: 'new_categoryid',
      ReferencedEntityNavigationPropertyName: 'new_widget_category_ref',
      ReferencingEntityNavigationPropertyName: 'new_category',
      Lookup: column('Lookup', 'new_CategoryId', { Description: label('') }),
    },
    SOLUTION_HEADER,
  );
  assert.equal(relationship.status, 204, JSON.stringify(relationship.json));

  // A table created without the header is not part of the solution.
  const loose = await request('POST', '/EntityDefinitions', tableBody('new_loose'));
  assert.equal(loose.status, 204, JSON.stringify(loose.json));
}

function exportedArchive(json) {
  return Buffer.from(json.ExportSolutionFile, 'base64');
}

// One table of a hand-written solution zip: a name column, and an optional PrimaryIdAttribute. Names are invented.
const tableXml = (logical, primaryId = '') =>
  `<Entity><Name LocalizedName="${logical}" OriginalName="${logical}">${logical}</Name><EntityInfo><entity Name="${logical}">${primaryId ? `<PrimaryIdAttribute>${primaryId}</PrimaryIdAttribute>` : ''}<LocalizedNames><LocalizedName description="${logical}" languagecode="1033" /></LocalizedNames><attributes><attribute PhysicalName="${logical}_Name"><Type>nvarchar</Type><Name>${logical}_name</Name><LogicalName>${logical}_name</LogicalName><IsCustomField>1</IsCustomField><DisplayMask>PrimaryName|ValidForAdvancedFind|ValidForForm|ValidForGrid|RequiredForForm</DisplayMask><MaxLength>100</MaxLength></attribute></attributes></entity></EntityInfo></Entity>`;
// A base64 solution zip with the given tables, built the way the Solution reader expects. Managed is 1 or 0 in solution.xml.
function solutionArchive({ name = SOLUTION, version = '1.0.0.0', managed = false, entities = [] } = {}) {
  const manifest = `<?xml version="1.0" encoding="utf-8"?><ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><LocalizedNames><LocalizedName description="${name}" languagecode="1033" /></LocalizedNames><Version>${version}</Version><Managed>${managed ? 1 : 0}</Managed><Publisher><UniqueName>${PUBLISHER}</UniqueName><CustomizationPrefix>new</CustomizationPrefix><CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix></Publisher></SolutionManifest></ImportExportXml>`;
  const customizations = `<?xml version="1.0" encoding="utf-8"?><ImportExportXml><Entities>${entities.join('')}</Entities><EntityRelationships></EntityRelationships><optionsets /></ImportExportXml>`;
  return zipOf([
    { name: '[Content_Types].xml', data: Buffer.from('<Types />') },
    { name: 'solution.xml', data: Buffer.from(manifest) },
    { name: 'customizations.xml', data: Buffer.from(customizations) },
  ]).toString('base64');
}

describe('Solution export and import', { concurrency: false }, () => {
  let source, target, fresh;
  let archive;

  before(async () => {
    source = await startServer();
    await buildSourceSolution(source);
    const exported = await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION, Managed: false });
    assert.equal(exported.status, 200, JSON.stringify(exported.json));
    archive = exportedArchive(exported.json);
  });

  after(async () => {
    for (const s of [source, target, fresh]) await s?.close();
  });

  it("exports a zip of the solution's components only", () => {
    const docs = readSolutionZip(archive);
    const names = docs.map((doc) => doc.name).sort();
    assert.deepEqual(names, ['customizations.xml', 'solution.xml']);
    const customizations = docs.find((doc) => doc.name === 'customizations.xml').xml;
    assert.match(customizations, /<entity Name="new_widget">/);
    assert.match(customizations, /<entity Name="new_category">/);
    assert.match(customizations, /PhysicalName="new_Code"/);
    assert.match(customizations, /<OptionSetName>new_tier<\/OptionSetName>/);
    assert.match(customizations, /<EntityRelationship Name="new_widget_category">/);
    assert.doesNotMatch(customizations, /new_loose/, 'a table created without the solution header is not exported');
    const manifest = docs.find((doc) => doc.name === 'solution.xml').xml;
    assert.match(manifest, /<UniqueName>new_samplesolution<\/UniqueName>/);
    assert.match(manifest, /<CustomizationPrefix>new<\/CustomizationPrefix>/);
    assert.match(manifest, /<Managed>0<\/Managed>/);
  });

  it('imports into a fresh simulator: table, columns, option set, relationship, and a row can be created', async () => {
    target = await startServer();
    const imported = await target.request('POST', '/ImportSolution', {
      CustomizationFile: archive.toString('base64'),
      OverwriteUnmanagedCustomizations: false,
      PublishWorkflows: true,
    });
    assert.equal(imported.status, 204, JSON.stringify(imported.json));

    const mappings = target.store.state.mappings;
    assert.ok(mappings.new_widget, 'table new_widget exists');
    assert.ok(mappings.new_widget.fields.new_code, 'text column exists');
    assert.equal(mappings.new_widget.nameColumn, 'new_name');
    assert.equal(target.store.state.dataverse.globalOptionSets.new_tier.options.length, 2);
    assert.equal(mappings.new_widget.fields.new_tier.globalOptionSet, 'new_tier');
    assert.ok(
      Object.values(mappings.new_widget.relationships).some((rel) => rel.schemaName === 'new_widget_category'),
      'relationship exists',
    );
    assert.equal(rowsOf(target.store, 'solution').find((row) => row.uniquename === SOLUTION)?.version, '1.0.0.0');
    assert.equal(
      rowsOf(target.store, 'publisher').find((row) => row.uniquename === PUBLISHER)?.customizationprefix,
      'new',
    );
    const job = rowsOf(target.store, 'importjob').at(-1);
    assert.equal(job.progress, 100);
    assert.match(job.data, /result="succeeded"/);

    const category = await target.request('POST', '/new_categories', { new_name: 'Hardware' });
    assert.equal(category.status, 204, JSON.stringify(category.json));
    const categoryId = idOf(category) ?? rowsOf(target.store, 'new_category')[0].new_categoryid;
    const widget = await target.request('POST', '/new_widgets', {
      new_name: 'Alpha',
      new_code: 'A-1',
      'new_category@odata.bind': `/new_categories(${categoryId})`,
    });
    assert.equal(widget.status, 204, JSON.stringify(widget.json));
    const read = await target.request('GET', `/new_widgets(${idOf(widget)})?$select=new_name,new_code`);
    assert.equal(read.json.new_name, 'Alpha');
    assert.equal(read.json.new_code, 'A-1');
  });

  it('rolls back a failed import completely', async () => {
    fresh = await startServer();
    // The same customizations with a table that has no text primary name appended last: the earlier components must not survive.
    const docs = readSolutionZip(archive);
    const broken = docs
      .find((doc) => doc.name === 'customizations.xml')
      .xml.replace(
        '</Entities>',
        '<Entity><EntityInfo><entity Name="new_broken"><attributes><attribute PhysicalName="new_Code"><LogicalName>new_code</LogicalName><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity></Entities>',
      );
    const zip = zipOf([
      { name: 'solution.xml', data: Buffer.from(docs.find((doc) => doc.name === 'solution.xml').xml, 'utf8') },
      { name: 'customizations.xml', data: Buffer.from(broken, 'utf8') },
    ]);
    const failed = await fresh.request('POST', '/ImportSolution', { CustomizationFile: zip.toString('base64') });
    assert.equal(failed.status, 400, JSON.stringify(failed.json));
    assert.equal(fresh.store.state.mappings.new_widget, undefined);
    assert.equal(fresh.store.state.mappings.new_category, undefined);
    assert.equal(fresh.store.state.mappings.new_broken, undefined);
    assert.equal(fresh.store.state.dataverse?.globalOptionSets?.new_tier, undefined);
    assert.equal(rowsOf(fresh.store, 'solution').length, 0, 'no solution row for a failed import');
    assert.match(rowsOf(fresh.store, 'importjob').at(-1).data, /result="failed"/);
  });

  it('ImportSolutionAsync returns an AsyncOperationId and completes the job', async () => {
    const asyncTarget = await startServer();
    try {
      const started = await asyncTarget.request('POST', '/ImportSolutionAsync', {
        CustomizationFile: archive.toString('base64'),
      });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      const { AsyncOperationId, ImportJobKey } = started.json;
      assert.match(AsyncOperationId, /^[0-9a-f-]{36}$/);
      await solutionImportJob(asyncTarget.api, AsyncOperationId);
      const operation = rowsOf(asyncTarget.store, 'asyncoperation').find(
        (row) => row.asyncoperationid === AsyncOperationId,
      );
      assert.equal(operation.statecode, 3);
      assert.equal(operation.statuscode, 30);
      assert.ok(asyncTarget.store.state.mappings.new_widget, 'the asynchronous import created the table');
      const job = rowsOf(asyncTarget.store, 'importjob').find((row) => row.importjobid === ImportJobKey);
      assert.equal(job.progress, 100);
    } finally {
      await asyncTarget.close();
    }
  });

  it('solutionImportJob keeps waiting for a held job however far the clock advances, and resolves once it completes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const target = await startServer();
    try {
      let arrive;
      const reached = new Promise((resolve) => {
        arrive = resolve;
      });
      let open;
      const released = new Promise((resolve) => {
        open = resolve;
      });
      const caller = target.store.state.tables.systemuser[0];
      const asyncId = await target.api.systemJob(
        { name: 'Held import probe', operationtype: 203, callerId: caller.systemuserid },
        async () => {
          arrive();
          await released;
          return 'done';
        },
      );
      let outcome = null;
      const waiting = solutionImportJob(target.api, asyncId).then(
        (row) => {
          outcome = { row };
        },
        (error) => {
          outcome = { error };
        },
      );
      // Several timer turns with the gate closed: each advances the clock by far more than 10 s.
      for (let turn = 0; turn < 3; turn += 1) {
        t.mock.timers.tick(60000);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await reached;
      assert.equal(outcome, null, 'a job that is still running is awaited, not refused by a deadline');
      open();
      await waiting;
      assert.equal(outcome.row.statecode, 3);
      assert.equal(outcome.row.statuscode, 30);
    } finally {
      t.mock.timers.reset();
      await target.close();
    }
  });

  it('requires prvImportCustomization and prvExportCustomization', async () => {
    const clerk = await startServer({ roles: ['Basic User'], appId: CLERK_APP_ID });
    try {
      const imported = await clerk.request('POST', '/ImportSolution', {
        CustomizationFile: archive.toString('base64'),
      });
      assert.equal(imported.status, 403, JSON.stringify(imported.json));
      const exported = await clerk.request('POST', '/ExportSolution', { SolutionName: SOLUTION });
      assert.equal(exported.status, 403, JSON.stringify(exported.json));
    } finally {
      await clerk.close();
    }
  });

  // @test-kind security: a Basic User is refused before a solution archive is parsed
  it('RetrieveMissingComponents refuses a Basic User before the archive is read', async () => {
    const clerk = await startServer({ roles: ['Basic User'], appId: CLERK_APP_ID });
    try {
      const missing = await clerk.request(
        'GET',
        `/RetrieveMissingComponents(CustomizationFile=@zip)?@zip=${encodeURIComponent(archive.toString('base64'))}`,
      );
      assert.equal(missing.status, 403, JSON.stringify(missing.json));
    } finally {
      await clerk.close();
    }
  });

  // @test-kind security: the preferred-solution user list needs the solution read privilege, which a principal without roles lacks
  it('PreferredSolutionUsedBy refuses a principal without the solution read privilege', async () => {
    const roleless = await startServer({ roles: [], appId: CLERK_APP_ID });
    try {
      const used = await roleless.request(
        'GET',
        '/PreferredSolutionUsedBy(SolutionId=00000000-0000-4000-8000-00000000000b)',
      );
      assert.equal(used.status, 403, JSON.stringify(used.json));
    } finally {
      await roleless.close();
    }
  });

  it('refuses to export an unknown solution', async () => {
    const response = await source.request('POST', '/ExportSolution', { SolutionName: 'new_nosuchsolution' });
    assert.equal(response.status, 404, JSON.stringify(response.json));
  });

  it('zipOf output reads back through the Solution reader', () => {
    const zip = zipOf([{ name: 'solution.xml', data: Buffer.from('<ImportExportXml />', 'utf8') }]);
    const docs = readSolutionZip(zip);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].xml, '<ImportExportXml />');
  });
});

// Solution component messages and dependency functions, on the same source solution.
describe('Solution component messages', { concurrency: false }, () => {
  let source;
  const componentId = (kind, logical, name = null) => componentObjectId({ kind, logical, name }, ORG);
  const dependencyRows = (json) => json.value;

  before(async () => {
    source = await startServer();
    await buildSourceSolution(source);
  });
  after(async () => {
    await source?.close();
  });

  it('AddSolutionComponent adds a table to the solution, and RemoveSolutionComponent takes it out again', async () => {
    const id = componentId('entity', 'new_loose');
    const added = await source.request('POST', '/AddSolutionComponent', {
      ComponentId: id,
      ComponentType: 1,
      SolutionUniqueName: SOLUTION,
      AddRequiredComponents: false,
    });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.match(added.json.id ?? '', /^[0-9a-f-]{36}$/);
    const solution = rowsOf(source.store, 'solution').find((row) => row.uniquename === SOLUTION);
    const member = rowsOf(source.store, 'solutioncomponent').find(
      (row) => row.solutionid === solution.solutionid && row.objectid === id,
    );
    assert.equal(member?.componenttype, 1, 'a solutioncomponent row of type Entity');
    assert.equal(
      rowsOf(source.store, 'solutioncomponent').some(
        (row) =>
          row.objectid === id &&
          row.solutionid === rowsOf(source.store, 'solution').find((s) => s.uniquename === 'Default')?.solutionid,
      ),
      false,
      'AddSolutionComponent does not add the Default solution',
    );
    const exported = readSolutionZip(
      exportedArchive((await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION })).json),
    );
    assert.match(exported.find((doc) => doc.name === 'customizations.xml').xml, /<entity Name="new_loose">/);

    const removed = await source.request('POST', '/RemoveSolutionComponent', {
      SolutionComponent: { solutioncomponentid: member.solutioncomponentid },
      ComponentType: 1,
      SolutionUniqueName: SOLUTION,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(
      rowsOf(source.store, 'solutioncomponent').some((row) => row.solutioncomponentid === member.solutioncomponentid),
      false,
    );
    const again = await source.request('POST', '/RemoveSolutionComponent', {
      SolutionComponent: { solutioncomponentid: member.solutioncomponentid },
      ComponentType: 1,
      SolutionUniqueName: SOLUTION,
    });
    assert.equal(again.status, 404, 'removing a component twice is refused');
  });

  it('AddSolutionComponent refuses an unknown component and an unknown solution', async () => {
    const unknown = await source.request('POST', '/AddSolutionComponent', {
      ComponentId: '00000000-0000-4000-8000-000000000001',
      ComponentType: 1,
      SolutionUniqueName: SOLUTION,
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    const noSolution = await source.request('POST', '/AddSolutionComponent', {
      ComponentId: componentId('entity', 'new_widget'),
      ComponentType: 1,
      SolutionUniqueName: 'new_nosuchsolution',
    });
    assert.equal(noSolution.status, 404, JSON.stringify(noSolution.json));
  });

  // AddSolutionComponentRequest.ComponentId: for MetadataBase components the component id is the MetadataId.
  it('AddSolutionComponent takes the MetadataId the table definition returns and refuses the old generated component id', async () => {
    const metadataId = (await source.request('GET', "/EntityDefinitions(LogicalName='new_loose')?$select=MetadataId"))
      .json.MetadataId;
    const publisherId = (
      await source.request('GET', `/publishers?$select=publisherid&$filter=uniquename eq '${PUBLISHER}'`)
    ).json.value[0].publisherid;
    await source.request('POST', '/solutions', {
      uniquename: 'new_idsolution',
      friendlyname: 'Id solution',
      version: '1.0.0.0',
      'publisherid@odata.bind': `/publishers(${publisherId})`,
    });
    const added = await source.request('POST', '/AddSolutionComponent', {
      ComponentId: metadataId,
      ComponentType: 1,
      SolutionUniqueName: 'new_idsolution',
      AddRequiredComponents: false,
    });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const solution = rowsOf(source.store, 'solution').find((row) => row.uniquename === 'new_idsolution');
    assert.ok(
      rowsOf(source.store, 'solutioncomponent').some(
        (row) => row.solutionid === solution.solutionid && row.objectid === metadataId,
      ),
      'membership is keyed by the MetadataId',
    );
    const dependents = await source.request(
      'GET',
      `/RetrieveDependentComponents(ObjectId=${metadataId},ComponentType=1)`,
    );
    assert.equal(dependents.status, 200, JSON.stringify(dependents.json));
    // The id the simulator generated before MetadataId became the component id (namespace-derived, not a MetadataId).
    const generated = uuidV5('3f0a9c4e-7b21-4d6e-9a58-1c2e8f0b7d13', 'entity|new_loose|');
    assert.notEqual(generated, metadataId);
    const legacy = await source.request('POST', '/AddSolutionComponent', {
      ComponentId: generated,
      ComponentType: 1,
      SolutionUniqueName: 'new_idsolution',
    });
    assert.equal(legacy.status, 404, JSON.stringify(legacy.json));
  });

  it('UpdateSolutionComponent persists selected settings for an existing unmanaged membership only', async () => {
    const objectId = componentObjectId({ kind: 'entity', logical: 'new_widget', name: null }, ORG);
    const payload = {
      ComponentId: objectId,
      ComponentType: 1,
      SolutionUniqueName: SOLUTION,
      IncludedComponentSettingsValues: ['IncludeMetadata'],
    };
    const updated = await source.request('POST', '/UpdateSolutionComponent', payload);
    assert.equal(updated.status, 204, JSON.stringify(updated.json));
    const solution = rowsOf(source.store, 'solution').find((row) => row.uniquename === SOLUTION);
    const member = rowsOf(source.store, 'solutioncomponent').find(
      (row) => row.solutionid === solution.solutionid && row.objectid === objectId,
    );
    assert.deepEqual(source.store.state.dataverse.solutionComponentSettings[member.solutioncomponentid], [
      'IncludeMetadata',
    ]);
    const missing = await source.request('POST', '/UpdateSolutionComponent', {
      ...payload,
      ComponentId: '00000000-0000-4000-8000-00000000000b',
    });
    assert.equal(missing.status, 404);
    const invalid = await source.request('POST', '/UpdateSolutionComponent', {
      ...payload,
      IncludedComponentSettingsValues: [1],
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(source.store.state.dataverse.solutionComponentSettings[member.solutioncomponentid], [
      'IncludeMetadata',
    ]);
  });

  it('RetrieveDependentComponents lists what depends on a table: its columns, its relationship and the lookup to it', async () => {
    const response = await source.request(
      'GET',
      `/RetrieveDependentComponents(ObjectId=${componentId('entity', 'new_category')},ComponentType=1)`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const rows = dependencyRows(response.json);
    const types = rows.map((row) => row.dependentcomponenttype).sort((a, b) => a - b);
    assert.ok(types.includes(10), 'the relationship depends on the table');
    assert.ok(types.includes(2), 'the lookup column depends on its target table');
    assert.ok(
      rows.every(
        (row) => row.requiredcomponentobjectid === componentId('entity', 'new_category') && row.dependencytype === 1,
      ),
    );
    const unknown = await source.request(
      'GET',
      '/RetrieveDependentComponents(ObjectId=00000000-0000-4000-8000-000000000002,ComponentType=1)',
    );
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
  });

  it('RetrieveRequiredComponents lists what a relationship needs: both tables and its lookup column', async () => {
    const relationship = componentId('relationship', 'new_widget', 'new_widget_category');
    const response = await source.request(
      'GET',
      `/RetrieveRequiredComponents(ObjectId=${relationship},ComponentType=10)`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const required = dependencyRows(response.json).map((row) => row.requiredcomponenttype);
    assert.ok(required.filter((type) => type === 1).length >= 2, 'both tables are required');
    assert.ok(required.includes(2), 'the lookup column is required');
  });

  it('RetrieveMissingDependencies and RetrieveDependenciesForUninstall report what a solution needs from outside it', async () => {
    const complete = await source.request('GET', `/RetrieveMissingDependencies(SolutionUniqueName='${SOLUTION}')`);
    assert.equal(complete.status, 200, JSON.stringify(complete.json));
    assert.deepEqual(dependencyRows(complete.json), [], 'every required component of the solution is in it');
    const category = componentId('entity', 'new_category');
    const removed = await source.request('POST', '/RemoveSolutionComponent', {
      SolutionComponent: { objectid: category },
      ComponentType: 1,
      SolutionUniqueName: SOLUTION,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const missing = await source.request('GET', `/RetrieveMissingDependencies(SolutionUniqueName='${SOLUTION}')`);
    assert.ok(
      dependencyRows(missing.json).some((row) => row.requiredcomponentobjectid === category),
      'the table is now missing',
    );
    const uninstallRows = async () => {
      const uninstall = await source.request(
        'GET',
        `/RetrieveDependenciesForUninstall(SolutionUniqueName='${SOLUTION}')`,
      );
      assert.equal(uninstall.status, 200, JSON.stringify(uninstall.json));
      return dependencyRows(uninstall.json);
    };
    assert.deepEqual(await uninstallRows(), [], 'nothing outside the solution depends on it yet');
    // A relationship created outside the solution, from the loose table to the solution's widget, blocks its uninstall.
    const outside = await source.request('POST', '/RelationshipDefinitions', {
      '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
      SchemaName: 'new_loose_widget',
      ReferencedEntity: 'new_widget',
      ReferencingEntity: 'new_loose',
      ReferencedAttribute: 'new_widgetid',
      ReferencedEntityNavigationPropertyName: 'new_loose_widget_ref',
      ReferencingEntityNavigationPropertyName: 'new_widget_loose',
      Lookup: column('Lookup', 'new_WidgetLoose', { Description: label('') }),
    });
    assert.equal(outside.status, 204, JSON.stringify(outside.json));
    assert.ok(
      (await uninstallRows()).some((row) => row.requiredcomponentobjectid === componentId('entity', 'new_widget')),
      'the outside relationship is reported',
    );
  });
});

// Solution lifecycle messages: patches and their roll-up, a staged upgrade and its promotion, async export and download,
// uninstall, the preferred solution and AddComponentsToSolutionAsync, on the same schema.
// Patch export lock and roll-up: https://learn.microsoft.com/en-us/power-platform/alm/create-patches-simplify-solution-updates
// Missing upgrade code: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes
// Supported uninstall: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/uninstallsolutionasync
describe('Solution lifecycle messages', { concurrency: false }, () => {
  const PATCH_NAME = 'Sample patch';
  const componentId = (kind, logical, name = null) => componentObjectId({ kind, logical, name }, ORG);
  const LOOSE = componentId('entity', 'new_loose');
  const opened = [];
  const open = async (options) => {
    const server = await startServer(options);
    opened.push(server);
    return server;
  };
  const base64 = (buffer) => buffer.toString('base64');
  const baseRow = (store) =>
    rowsOf(store, 'solution').find((s) => s.uniquename === SOLUTION && s.parentsolutionid == null);
  const operationOf = (store, asyncId) => rowsOf(store, 'asyncoperation').find((r) => r.asyncoperationid === asyncId);
  let source, v1, managedV1, v2, managedV2, patchId;

  before(async () => {
    source = await open();
    await buildSourceSolution(source);
    v1 = exportedArchive(
      (await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION, Managed: false })).json,
    );
    managedV1 = exportedArchive(
      (await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION, Managed: true })).json,
    );
  });
  after(async () => {
    for (const server of opened) await server.close();
  });

  it("CloneAsPatch creates a child solution: parent's unique name, parentsolutionid, the requested version", async () => {
    const response = await source.request('POST', '/CloneAsPatch', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: PATCH_NAME,
      VersionNumber: '1.0.1.0',
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    patchId = response.json.SolutionId;
    const row = rowsOf(source.store, 'solution').find((s) => s.solutionid === patchId);
    assert.equal(row.uniquename, SOLUTION);
    assert.equal(row.parentsolutionid, baseRow(source.store).solutionid);
    assert.equal(row.version, '1.0.1.0');
    assert.equal(row.friendlyname, PATCH_NAME);
    assert.equal(row.ismanaged, false);
  });

  it('CloneAsPatch refuses a version that is not a higher patch of the parent (documented rules; codes unverified)', async () => {
    const otherLine = await source.request('POST', '/CloneAsPatch', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: 'x',
      VersionNumber: '1.1.0.0',
    });
    assert.equal(otherLine.status, 400, JSON.stringify(otherLine.json));
    const notHigher = await source.request('POST', '/CloneAsPatch', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: 'x',
      VersionNumber: '1.0.0.0',
    });
    assert.equal(notHigher.status, 400, JSON.stringify(notHigher.json));
    const belowPatch = await source.request('POST', '/CloneAsPatch', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: 'x',
      VersionNumber: '1.0.0.5',
    });
    assert.equal(belowPatch.status, 400, 'a patch must be higher than every existing patch');
    const unknown = await source.request('POST', '/CloneAsPatch', {
      ParentSolutionUniqueName: 'new_nosuchsolution',
      DisplayName: 'x',
      VersionNumber: '1.0.2.0',
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    const clerk = await open({ roles: ['Basic User'], appId: CLERK_APP_ID });
    const denied = await clerk.request('POST', '/CloneAsPatch', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: 'x',
      VersionNumber: '1.0.2.0',
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
    assert.equal(
      rowsOf(source.store, 'solution').filter((s) => s.parentsolutionid != null).length,
      1,
      'refused patches are not created',
    );
  });

  it('a component added to a patch belongs to the patch; CloneAsSolution rolls the patch into the base solution', async () => {
    const added = await source.request('POST', '/AddComponentToSolutionAsync', {
      LogicalName: 'new_loose',
      Id: LOOSE,
      SolutionId: patchId,
      AddRequiredComponents: false,
    });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.match(added.json.AsyncOperationId, /^[0-9a-f-]{36}$/);
    await solutionImportJob(source.api, added.json.AsyncOperationId);
    assert.equal(operationOf(source.store, added.json.AsyncOperationId).statuscode, 30);
    assert.ok(
      rowsOf(source.store, 'solutioncomponent').some((r) => r.solutionid === patchId && r.objectid === LOOSE),
      'the patch holds the table',
    );
    const blockedExport = await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION });
    assert.equal(blockedExport.status, 400, JSON.stringify(blockedExport.json));
    assert.equal(blockedExport.json.error.code, '0x80048538', 'a base solution cannot be exported while patches exist');
    const beforeRollUp = readSolutionZip(v1);
    assert.doesNotMatch(
      beforeRollUp.find((d) => d.name === 'customizations.xml').xml,
      /<entity Name="new_loose">/,
      "a patch's table is not in the base solution",
    );

    const lower = await source.request('POST', '/CloneAsSolution', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: 'Sample solution',
      VersionNumber: '1.0.5.0',
    });
    assert.equal(lower.status, 400, 'the version must have a higher major.minor (unverified code)');
    const cloned = await source.request('POST', '/CloneAsSolution', {
      ParentSolutionUniqueName: SOLUTION,
      DisplayName: 'Sample solution',
      VersionNumber: '1.1.0.0',
    });
    assert.equal(cloned.status, 200, JSON.stringify(cloned.json));
    assert.equal(cloned.json.SolutionId, baseRow(source.store).solutionid, 'the base solution becomes the new version');
    assert.equal(baseRow(source.store).version, '1.1.0.0');
    assert.equal(
      rowsOf(source.store, 'solution').some((s) => s.solutionid === patchId),
      false,
      'the patch is rolled up and deleted',
    );
    assert.ok(
      rowsOf(source.store, 'solutioncomponent').some(
        (r) => r.solutionid === baseRow(source.store).solutionid && r.objectid === LOOSE,
      ),
      'the base holds the table now',
    );
    const afterRollUp = readSolutionZip(
      exportedArchive((await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION })).json),
    );
    assert.match(afterRollUp.find((d) => d.name === 'customizations.xml').xml, /<entity Name="new_loose">/);
    assert.match(afterRollUp.find((d) => d.name === 'solution.xml').xml, /<Version>1\.1\.0\.0<\/Version>/);
    v2 = exportedArchive(
      (await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION, Managed: false })).json,
    );
    managedV2 = exportedArchive(
      (await source.request('POST', '/ExportSolution', { SolutionName: SOLUTION, Managed: true })).json,
    );
  });

  it("StageSolution reports the zip's solution and writes nothing; an invalid zip is refused", async () => {
    const target = await open();
    const staged = await target.request('POST', '/StageSolution', { CustomizationFile: base64(v2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const results = staged.json.StageSolutionResults;
    assert.equal(results.SolutionDetails.SolutionUniqueName, SOLUTION);
    assert.equal(results.SolutionDetails.SolutionVersion, '1.1.0.0');
    assert.equal(results.SolutionDetails.IsManaged, false);
    assert.equal(results.SolutionDetails.IsPatchSolution, false);
    assert.match(results.StageSolutionUploadId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(results.MissingDependencies, [], 'every table the relationship needs is in the zip');
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.uniquename === SOLUTION),
      false,
      'staging does not import',
    );
    assert.equal(target.store.state.mappings.new_widget, undefined, 'staging creates no table');
    const invalid = await target.request('POST', '/StageSolution', {
      CustomizationFile: Buffer.from('not a zip').toString('base64'),
    });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  });

  it('RetrieveMissingComponents lists a relationship whose tables neither the zip nor the store has', async () => {
    const docs = readSolutionZip(v2);
    const emptied = docs
      .find((doc) => doc.name === 'customizations.xml')
      .xml.replace(/<Entities>[\s\S]*<\/Entities>/, '<Entities />');
    const zip = zipOf([
      { name: 'solution.xml', data: Buffer.from(docs.find((doc) => doc.name === 'solution.xml').xml, 'utf8') },
      { name: 'customizations.xml', data: Buffer.from(emptied, 'utf8') },
    ]);
    const target = await open();
    const missing = await target.request(
      'GET',
      `/RetrieveMissingComponents(CustomizationFile=@zip)?@zip=${encodeURIComponent(base64(zip))}`,
    );
    assert.equal(missing.status, 200, JSON.stringify(missing.json));
    const schemas = missing.json.MissingComponents.map((m) => m.RequiredComponent.SchemaName).sort();
    assert.deepEqual(schemas, ['new_category', 'new_widget']);
    assert.equal(missing.json.MissingComponents[0].DependentComponent.SchemaName, 'new_widget_category');
    const complete = await target.request(
      'GET',
      `/RetrieveMissingComponents(CustomizationFile=@zip)?@zip=${encodeURIComponent(base64(v2))}`,
    );
    assert.deepEqual(complete.json.MissingComponents, [], 'a zip that brings its tables is complete');
  });

  it('StageAndUpgrade stages a holding solution beside the base; DeleteAndPromote applies it and removes the base', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgrade', {
      CustomizationFile: base64(managedV2),
      OverwriteUnmanagedCustomizations: false,
      PublishWorkflows: true,
    });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const holding = rowsOf(target.store, 'solution').find((s) => s.uniquename === `${SOLUTION}_Upgrade`);
    assert.equal(holding.solutionid, staged.json.SolutionId);
    assert.equal(holding.version, '1.1.0.0');
    assert.equal(baseRow(target.store).version, '1.0.0.0', 'the base solution stays until the upgrade is applied');
    assert.ok(target.store.state.mappings.new_loose, "the holding solution's table exists");

    const promoted = await target.request('POST', '/DeleteAndPromote', { UniqueName: SOLUTION });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    assert.equal(promoted.json.SolutionId, holding.solutionid, 'the holding solution is promoted');
    const named = rowsOf(target.store, 'solution').filter((s) => s.uniquename === SOLUTION);
    assert.equal(named.length, 1);
    assert.equal(named[0].version, '1.1.0.0');
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.uniquename === `${SOLUTION}_Upgrade`),
      false,
    );
    const solutionIds = new Set(rowsOf(target.store, 'solution').map((s) => s.solutionid));
    assert.ok(
      rowsOf(target.store, 'solutioncomponent').every((r) => solutionIds.has(r.solutionid)),
      'no membership row points at a removed solution',
    );
    const again = await target.request('POST', '/DeleteAndPromote', { UniqueName: SOLUTION });
    assert.equal(again.status, 400, 'there is no holding solution left to promote');
    assert.equal(again.json.error.code, '0x8004853b');
  });

  it('StageAndUpgradeAsync and DeleteAndPromoteAsync return an AsyncOperationId and complete', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const early = await target.request('POST', '/DeleteAndPromoteAsync', { UniqueName: SOLUTION });
    assert.equal(early.status, 400, 'no holding solution to promote');
    assert.equal(early.json.error.code, '0x8004853b');
    const staged = await target.request('POST', '/StageAndUpgradeAsync', {
      CustomizationFile: base64(managedV2),
      OverwriteUnmanagedCustomizations: false,
      PublishWorkflows: true,
    });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    await solutionImportJob(target.api, staged.json.AsyncOperationId);
    assert.equal(operationOf(target.store, staged.json.AsyncOperationId).statuscode, 30);
    const promoted = await target.request('POST', '/DeleteAndPromoteAsync', { UniqueName: SOLUTION });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    await solutionImportJob(target.api, promoted.json.AsyncOperationId);
    assert.equal(
      operationOf(target.store, promoted.json.AsyncOperationId).statuscode,
      30,
      operationOf(target.store, promoted.json.AsyncOperationId).message,
    );
    assert.equal(rowsOf(target.store, 'solution').find((s) => s.uniquename === SOLUTION).version, '1.1.0.0');
  });

  it('StageAndUpgrade refuses an unmanaged base, so DeleteAndPromote cannot remove its tables or their rows', async () => {
    const target = await open();
    const base = solutionArchive({ version: '1.0.0.0', entities: [tableXml('new_alpha'), tableXml('new_beta')] });
    const next = solutionArchive({ version: '2.0.0.0', entities: [tableXml('new_beta')] });
    assert.equal((await target.request('POST', '/ImportSolution', { CustomizationFile: base })).status, 204);
    const row = await target.request('POST', `/${target.store.state.mappings.new_alpha.entitySet}`, {
      new_alpha_name: 'precious row',
    });
    assert.ok(row.status < 300, JSON.stringify(row.json));
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: next });
    assert.equal(staged.status, 400, JSON.stringify(staged.json));
    assert.equal(
      staged.json.error.message,
      'The imported solution and the existing solution must both be managed for upgrade',
    );
    const promoted = await target.request('POST', '/DeleteAndPromote', { UniqueName: SOLUTION });
    assert.equal(promoted.status, 400, JSON.stringify(promoted.json));
    assert.ok(target.store.state.mappings.new_alpha, 'the table the new version leaves out is kept');
    assert.equal(rowsOf(target.store, 'new_alpha').length, 1, 'and so is its row');
  });

  it('StageAndUpgradeAsync refuses an unmanaged archive over a managed base', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgradeAsync', { CustomizationFile: base64(v2) });
    assert.equal(staged.status, 400, JSON.stringify(staged.json));
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.uniquename === `${SOLUTION}_Upgrade`),
      false,
    );
  });

  it('a managed upgrade still removes the tables the new version drops', async () => {
    const target = await open();
    const base = solutionArchive({ managed: true, entities: [tableXml('new_alpha'), tableXml('new_beta')] });
    const next = solutionArchive({ managed: true, version: '2.0.0.0', entities: [tableXml('new_beta')] });
    assert.equal((await target.request('POST', '/ImportSolution', { CustomizationFile: base })).status, 204);
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: next });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const promoted = await target.request('POST', '/DeleteAndPromote', { UniqueName: SOLUTION });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    assert.equal(target.store.state.mappings.new_alpha, undefined, 'the dropped table is removed');
    assert.ok(target.store.state.mappings.new_beta, 'the table the new version keeps stays');
  });

  // Imports the managed base solution, then an ordinary solution named like the holding solution of that base.
  const importBaseWithOrdinaryUpgrade = async (target) => {
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const publisherId = rowsOf(target.store, 'publisher').find((p) => p.uniquename === PUBLISHER).publisherid;
    const ordinary = await target.request('POST', '/solutions', {
      uniquename: `${SOLUTION}_Upgrade`,
      friendlyname: 'Ordinary solution',
      version: '1.0.0.0',
      'publisherid@odata.bind': `/publishers(${publisherId})`,
    });
    assert.equal(ordinary.status, 204, JSON.stringify(ordinary.json));
  };

  it('DeleteAndPromote refuses an ordinary solution named like a holding solution, and renames and deletes nothing', async () => {
    const target = await open();
    await importBaseWithOrdinaryUpgrade(target);
    const promoted = await target.request('POST', '/DeleteAndPromote', { UniqueName: SOLUTION });
    assert.equal(promoted.status, 400, JSON.stringify(promoted.json));
    assert.equal(promoted.json.error.code, '0x8004853b');
    assert.ok(baseRow(target.store), 'the base solution stays');
    assert.ok(
      rowsOf(target.store, 'solution').some((s) => s.uniquename === `${SOLUTION}_Upgrade`),
      'the ordinary solution keeps its name',
    );
    assert.ok(target.store.state.mappings.new_widget, 'the base tables stay');
  });

  it('StageAndUpgrade refuses an ordinary solution already named like its holding solution, and changes nothing', async () => {
    const target = await open();
    await importBaseWithOrdinaryUpgrade(target);
    const snapshot = () =>
      JSON.stringify([
        rowsOf(target.store, 'solution'),
        rowsOf(target.store, 'solutioncomponent'),
        target.store.state.dataverse?.holdingSolutions ?? null,
      ]);
    const before = snapshot();
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 400, JSON.stringify(staged.json));
    assert.ok(staged.json.error.message.includes(`${SOLUTION}_Upgrade`), JSON.stringify(staged.json));
    assert.equal(snapshot(), before, 'the ordinary solution, its components and the base solution are unchanged');
  });

  it('a state saved before the holding marker existed still promotes its staged upgrade once it is loaded', async () => {
    const saving = await open();
    assert.equal(
      (await saving.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await saving.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const saved = structuredClone(saving.store.state);
    delete saved.dataverse.holdingSolutions;
    delete saved.dataverse.holdingMarkersMigrated;
    const loaded = await open({ state: saved });
    assert.equal(
      loaded.store.state.dataverse.holdingSolutions[staged.json.SolutionId],
      baseRow(loaded.store).solutionid,
      'loading records the marker',
    );
    const promoted = await loaded.request('POST', '/DeleteAndPromote', { UniqueName: SOLUTION });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
    assert.equal(promoted.json.SolutionId, staged.json.SolutionId);
  });

  it('an ordinary solution with the holding name stays ordinary after a restart and after a reset', async () => {
    const first = await open();
    await importBaseWithOrdinaryUpgrade(first);
    assert.deepEqual(first.store.state.dataverse?.holdingSolutions ?? {}, {}, 'before the restart');
    const loaded = await open({ state: structuredClone(first.store.state) });
    assert.deepEqual(loaded.store.state.dataverse?.holdingSolutions ?? {}, {}, 'after the restart');
    await loaded.server.reseed();
    assert.deepEqual(loaded.store.state.dataverse?.holdingSolutions ?? {}, {}, 'after the reset');
  });

  it('a staged upgrade whose base is removed before its job runs fails with the missing-base error, not a TypeError', async () => {
    const scheduler = createScheduler({ clock: fixedClock(), manual: true });
    const target = await open({ scheduler });
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgradeAsync', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const solutions = rowsOf(target.store, 'solution');
    solutions.splice(solutions.indexOf(baseRow(target.store)), 1);
    await scheduler.runDue();
    const operation = operationOf(target.store, staged.json.AsyncOperationId);
    assert.equal(operation.statuscode, 31, operation.message);
    assert.equal(operation.errorcode, Number.parseInt('0x8004F083', 16) | 0, 'the DataError innerCode');
    assert.equal(
      operation.message,
      `Cannot find the data for the previous version of the holding solution: [${SOLUTION}].`,
    );
  });

  it('uninstalling a staged holding solution removes its marker, and a new StageAndUpgrade stages again', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const holdingId = staged.json.SolutionId;
    const removed = await target.request('POST', '/UninstallSolutionAsync', {
      SolutionUniqueName: `${SOLUTION}_Upgrade`,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    await solutionImportJob(target.api, removed.json.AsyncOperationId);
    assert.equal(operationOf(target.store, removed.json.AsyncOperationId).statuscode, 30);
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.solutionid === holdingId),
      false,
    );
    assert.equal(
      Object.hasOwn(target.store.state.dataverse?.holdingSolutions ?? {}, holdingId),
      false,
      'the marker goes with the holding solution',
    );
    const again = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(
      target.store.state.dataverse.holdingSolutions[again.json.SolutionId],
      baseRow(target.store).solutionid,
    );
  });

  // @test-kind contract: a solution row removed through the Web API takes the holding marker that names it (or is named by it) with it
  it('a generic DELETE of the holding solution drops its marker, and a new StageAndUpgrade for the same base stages again', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const holdingId = staged.json.SolutionId;
    const deleted = await target.request('DELETE', `/solutions(${holdingId})`);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.json));
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.solutionid === holdingId),
      false,
    );
    assert.equal(
      Object.hasOwn(target.store.state.dataverse?.holdingSolutions ?? {}, holdingId),
      false,
      'the marker goes',
    );
    const again = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(
      target.store.state.dataverse.holdingSolutions[again.json.SolutionId],
      baseRow(target.store).solutionid,
    );
  });

  // @test-kind contract: a solution row removed through the Web API takes the holding marker that names it (or is named by it) with it
  it('a generic DELETE of the base while a holding solution is pending drops the marker and keeps the holding row', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const holdingId = staged.json.SolutionId;
    const baseId = baseRow(target.store).solutionid;
    const deleted = await target.request('DELETE', `/solutions(${baseId})`);
    assert.equal(deleted.status, 204, JSON.stringify(deleted.json));
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.solutionid === holdingId),
      true,
      'the holding row stays',
    );
    assert.equal(
      Object.hasOwn(target.store.state.dataverse?.holdingSolutions ?? {}, holdingId),
      false,
      'the marker goes',
    );
  });

  // @test-kind contract: a solution row removed through the Web API takes the holding marker that names it (or is named by it) with it
  it('a generic DELETE inside a changeset that commits drops the marker, and one inside a failing changeset keeps it', async () => {
    const target = await open();
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const staged = await target.request('POST', '/StageAndUpgrade', { CustomizationFile: base64(managedV2) });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    const holdingId = staged.json.SolutionId;
    const drop = { id: 'drop', method: 'DELETE', url: `/api/data/v9.2/solutions(${holdingId})`, atomicityGroup: 'g' };
    const failing = await target.batch([
      drop,
      {
        id: 'fail',
        method: 'POST',
        url: '/api/data/v9.2/nosuchentities',
        body: {},
        atomicityGroup: 'g',
        dependsOn: ['drop'],
      },
    ]);
    assert.match(failing.text, /^HTTP\/1\.1 404/m, failing.text);
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.solutionid === holdingId),
      true,
      'the rolled-back delete keeps the row',
    );
    assert.equal(
      target.store.state.dataverse.holdingSolutions[holdingId],
      baseRow(target.store).solutionid,
      'and its marker',
    );
    const committed = await target.batch([drop]);
    assert.match(committed.text, /^HTTP\/1\.1 204/m, committed.text);
    assert.equal(
      Object.hasOwn(target.store.state.dataverse?.holdingSolutions ?? {}, holdingId),
      false,
      'the committed delete drops the marker',
    );
  });

  // @test-kind contract: an asynchronous import releases its job id when its job settles, whatever path settles it
  it('an async import cancelled while Ready releases its job id: a later import with that id is accepted', async () => {
    const scheduler = createScheduler({ clock: fixedClock(), manual: true });
    const target = await open({ scheduler });
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const jobId = '4d2e1f00-7a6b-4c5d-8e9f-0a1b2c3d4e5f';
    const unhandled = await unhandledDuring(async () => {
      const staged = await target.request('POST', '/StageAndUpgradeAsync', {
        CustomizationFile: base64(managedV2),
        ImportJobId: jobId,
      });
      assert.equal(staged.status, 200, JSON.stringify(staged.json));
      const cancelled = await target.request('PATCH', `/asyncoperations(${staged.json.AsyncOperationId})`, {
        statecode: 3,
      });
      assert.equal(cancelled.status, 204, JSON.stringify(cancelled.json));
      assert.equal(operationOf(target.store, staged.json.AsyncOperationId).statuscode, 32, 'the job is Canceled');
      const later = await target.request('POST', '/StageAndUpgradeAsync', {
        CustomizationFile: base64(managedV2),
        ImportJobId: jobId,
      });
      assert.equal(later.status, 200, JSON.stringify(later.json));
    });
    assert.deepEqual(unhandled, []);
  });

  // @test-kind contract: an asynchronous import releases its job id when its job settles, whatever path settles it
  it('an async import whose job fails, or completes, keeps its job id taken by the import job row', async () => {
    const scheduler = createScheduler({ clock: fixedClock(), manual: true });
    const target = await open({ scheduler });
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const failedId = '5e3f2a11-8b7c-4d6e-9f0a-1b2c3d4e5f60';
    const completedId = '6f4a3b22-9c8d-4e7f-8a1b-2c3d4e5f6a71';
    const unhandled = await unhandledDuring(async () => {
      const failing = await target.request('POST', '/StageAndUpgradeAsync', {
        CustomizationFile: base64(managedV2),
        ImportJobId: failedId,
      });
      assert.equal(failing.status, 200, JSON.stringify(failing.json));
      // The base goes before the job runs, so the job fails in recordSolution.
      const solutions = rowsOf(target.store, 'solution');
      solutions.splice(solutions.indexOf(baseRow(target.store)), 1);
      await scheduler.runDue();
      assert.equal(operationOf(target.store, failing.json.AsyncOperationId).statuscode, 31, 'the job failed');
      const refusedAfterFailure = await target.request('POST', '/ImportSolution', {
        CustomizationFile: base64(managedV1),
        ImportJobId: failedId,
      });
      assert.equal(refusedAfterFailure.status, 400, JSON.stringify(refusedAfterFailure.json));
      assert.match(refusedAfterFailure.json.error.message, /already used by an import job/);
      const completing = await target.request('POST', '/ImportSolutionAsync', {
        CustomizationFile: base64(managedV1),
        ImportJobId: completedId,
      });
      assert.equal(completing.status, 200, JSON.stringify(completing.json));
      await scheduler.runDue();
      assert.equal(operationOf(target.store, completing.json.AsyncOperationId).statuscode, 30, 'the job completed');
      const refusedAfterCompletion = await target.request('POST', '/ImportSolution', {
        CustomizationFile: base64(managedV1),
        ImportJobId: completedId,
      });
      assert.equal(refusedAfterCompletion.status, 400, JSON.stringify(refusedAfterCompletion.json));
      assert.match(refusedAfterCompletion.json.error.message, /already used by an import job/);
    });
    assert.deepEqual(unhandled, []);
  });

  it('a reset that removes a Ready staged upgrade releases its job id: a later ImportSolution with that id is accepted', async () => {
    const scheduler = createScheduler({ clock: fixedClock(), manual: true });
    const target = await open({ scheduler });
    assert.equal(
      (await target.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const jobId = '7a5b4c33-0d9e-4f80-9b2c-3d4e5f6a7b82';
    const unhandled = await unhandledDuring(async () => {
      const held = await target.request('POST', '/StageAndUpgradeAsync', {
        CustomizationFile: base64(managedV2),
        ImportJobId: jobId,
      });
      assert.equal(held.status, 200, JSON.stringify(held.json));
      assert.equal(
        operationOf(target.store, held.json.AsyncOperationId).statecode,
        0,
        'the job is Ready and has not run',
      );
      // A /_sim/ reset replaces the rows without a write that settles the job, so the reset itself must release the id.
      delete target.store.state.mappings.asyncoperation;
      delete target.store.state.tables.asyncoperation;
      await resetAsyncJobs(target.api);
      const later = await target.request('POST', '/ImportSolution', {
        CustomizationFile: base64(managedV2),
        ImportJobId: jobId,
      });
      assert.equal(later.status, 204, JSON.stringify(later.json));
    });
    assert.deepEqual(unhandled, []);
  });

  it('two ImportSolution requests with one new ImportJobId: one imports and the other is refused as a duplicate', async () => {
    const release = Promise.withResolvers();
    const gate = { armed: false, held: 0 };
    // Holds the store's writes of the requests under test; the second write to arrive releases them.
    const change = (work) => {
      if (!gate.armed) return work();
      gate.held += 1;
      if (gate.held === 2) release.resolve();
      return release.promise.then(work);
    };
    const target = await open({ change });
    gate.armed = true;
    const body = { CustomizationFile: base64(v1), ImportJobId: '3c9e1f2a-5b7d-4e8f-9a0b-1c2d3e4f5a6b' };
    const runs = [target.request('POST', '/ImportSolution', body), target.request('POST', '/ImportSolution', body)];
    // The refused duplicate answers while the admitted request still waits for the store.
    await Promise.race(runs);
    release.resolve();
    const responses = await Promise.all(runs);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [204, 400],
      JSON.stringify(responses.map((response) => response.json)),
    );
    const refused = responses.find((response) => response.status === 400);
    // The duplicate is a plain InvalidRequest, so it carries the default innerCode.
    assert.equal(refused.json.error.code, '0x80060888');
    assert.match(refused.json.error.message, /already used by an import job/);
  });

  it('a failed import keeps its job id taken; once its job row is gone the id is free again', async () => {
    const target = await open();
    const job = '6b1d2c3e-4f50-4a61-8b72-9c83d4e5f601';
    const docs = readSolutionZip(v1);
    const broken = docs
      .find((doc) => doc.name === 'customizations.xml')
      .xml.replace(
        '</Entities>',
        '<Entity><EntityInfo><entity Name="new_broken"><attributes><attribute PhysicalName="new_Code"><LogicalName>new_code</LogicalName><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity></Entities>',
      );
    const failing = zipOf([
      { name: 'solution.xml', data: Buffer.from(docs.find((doc) => doc.name === 'solution.xml').xml, 'utf8') },
      { name: 'customizations.xml', data: Buffer.from(broken, 'utf8') },
    ]);
    const failed = await target.request('POST', '/ImportSolution', {
      CustomizationFile: failing.toString('base64'),
      ImportJobId: job,
    });
    assert.equal(failed.status, 400, JSON.stringify(failed.json));
    assert.match(rowsOf(target.store, 'importjob').find((r) => r.importjobid === job).data, /result="failed"/);
    const reused = await target.request('POST', '/ImportSolution', { CustomizationFile: base64(v1), ImportJobId: job });
    assert.equal(reused.status, 400, JSON.stringify(reused.json));
    assert.match(reused.json.error.message, /already used by an import job/);
    // The failed request released its reservation: only the job row keeps the id taken.
    const jobs = target.store.state.tables.importjob;
    jobs.splice(
      jobs.findIndex((r) => r.importjobid === job),
      1,
    );
    const retry = await target.request('POST', '/ImportSolution', { CustomizationFile: base64(v1), ImportJobId: job });
    assert.equal(retry.status, 204, JSON.stringify(retry.json));
  });

  it('ImportSolution and ImportSolutionAsync refuse a mode change over an installed solution, both ways, with 0x80048041', async () => {
    const unmanaged = await open();
    assert.equal((await unmanaged.request('POST', '/ImportSolution', { CustomizationFile: base64(v1) })).status, 204);
    const flipped = await unmanaged.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) });
    assert.equal(flipped.status, 400, JSON.stringify(flipped.json));
    assert.equal(flipped.json.error.code, '0x80048041');
    assert.equal(
      flipped.json.error.message,
      'Import can only update solutions when the modes match. Uninstall the current solution and try again.',
    );
    const asyncFlipped = await unmanaged.request('POST', '/ImportSolutionAsync', {
      CustomizationFile: base64(managedV1),
    });
    assert.equal(asyncFlipped.status, 400, JSON.stringify(asyncFlipped.json));
    assert.equal(baseRow(unmanaged.store).ismanaged, false, 'the installed solution stays unmanaged');

    const managed = await open();
    assert.equal(
      (await managed.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const reversed = await managed.request('POST', '/ImportSolution', { CustomizationFile: base64(v1) });
    assert.equal(reversed.status, 400, JSON.stringify(reversed.json));
    assert.equal(reversed.json.error.code, '0x80048041');
    assert.equal(baseRow(managed.store).ismanaged, true, 'the installed solution stays managed');
  });

  it('ImportSolution refuses an ImportJobId that is not a GUID or names an existing import job, and keeps the first job log', async () => {
    const target = await open();
    const job = '7f0c0a4e-3d5b-4c2a-9e1f-2b6d8a9c0e11';
    const notGuid = await target.request('POST', '/ImportSolution', {
      CustomizationFile: base64(v1),
      ImportJobId: 'not-a-guid',
    });
    assert.equal(notGuid.status, 400, JSON.stringify(notGuid.json));
    assert.equal(
      rowsOf(target.store, 'importjob').some((r) => r.importjobid === 'not-a-guid'),
      false,
    );
    const first = await target.request('POST', '/ImportSolution', { CustomizationFile: base64(v1), ImportJobId: job });
    assert.equal(first.status, 204, JSON.stringify(first.json));
    const logBefore = rowsOf(target.store, 'importjob').find((r) => r.importjobid === job).data;
    const reused = await target.request('POST', '/ImportSolution', { CustomizationFile: base64(v2), ImportJobId: job });
    assert.equal(reused.status, 400, JSON.stringify(reused.json));
    assert.equal(rowsOf(target.store, 'importjob').find((r) => r.importjobid === job).data, logBefore);
  });

  // @test-kind security: the archive's PrimaryIdAttribute becomes the id column and a $metadata key, so a hostile name must not reach either
  it('an archive whose PrimaryIdAttribute is not an identifier fails the import and leaves no table behind', async () => {
    const target = await open();
    const hostile = await target.request('POST', '/ImportSolution', {
      CustomizationFile: solutionArchive({ entities: [tableXml('new_evil', 'new_evilid"x')] }),
    });
    assert.equal(hostile.status, 400, JSON.stringify(hostile.json));
    assert.equal(target.store.state.mappings.new_evil, undefined, 'no table is left behind');
    assert.equal(
      rowsOf(target.store, 'solution').some((s) => s.uniquename === SOLUTION),
      false,
      'and no solution row',
    );
    const valid = await target.request('POST', '/ImportSolution', {
      CustomizationFile: solutionArchive({ entities: [tableXml('new_other', 'new_otherkeyid')] }),
    });
    assert.equal(valid.status, 204, JSON.stringify(valid.json));
    assert.equal(
      target.store.state.mappings.new_other.idColumn,
      'new_otherkeyid',
      'a valid custom primary id still names the key',
    );
  });

  it('ExportSolutionAsync returns both ids and DownloadSolutionExportData returns the finished zip', async () => {
    const exported = await source.request('POST', '/ExportSolutionAsync', { SolutionName: SOLUTION, Managed: false });
    assert.equal(exported.status, 200, JSON.stringify(exported.json));
    assert.match(exported.json.ExportJobId, /^[0-9a-f-]{36}$/);
    await solutionImportJob(source.api, exported.json.AsyncOperationId);
    assert.equal(operationOf(source.store, exported.json.AsyncOperationId).statuscode, 30);
    const downloaded = await source.request('POST', '/DownloadSolutionExportData', {
      ExportJobId: exported.json.ExportJobId,
    });
    assert.equal(downloaded.status, 200, JSON.stringify(downloaded.json));
    const docs = readSolutionZip(exportedArchive(downloaded.json));
    assert.deepEqual(docs.map((doc) => doc.name).sort(), ['customizations.xml', 'solution.xml']);
    assert.match(docs.find((doc) => doc.name === 'solution.xml').xml, /<UniqueName>new_samplesolution<\/UniqueName>/);
    const unknownJob = await source.request('POST', '/DownloadSolutionExportData', {
      ExportJobId: '00000000-0000-4000-8000-000000000009',
    });
    assert.equal(unknownJob.status, 404, 'an export job that does not exist (unverified code)');
    const unknownSolution = await source.request('POST', '/ExportSolutionAsync', {
      SolutionName: 'new_nosuchsolution',
    });
    assert.equal(unknownSolution.status, 404, JSON.stringify(unknownSolution.json));
  });

  it('AddComponentsToSolutionAsync refuses an unknown component unless ContinueOnError skips it', async () => {
    const missingId = '00000000-0000-4000-8000-00000000000a';
    const refused = await source.request('POST', '/AddComponentsToSolutionAsync', {
      SolutionUniqueName: SOLUTION,
      ContinueOnError: false,
      SolutionComponentParameters: {
        ParameterCollection: [
          { LogicalName: 'new_loose', Id: LOOSE },
          { LogicalName: 'new_nothing', Id: missingId },
        ],
      },
    });
    assert.equal(refused.status, 404, JSON.stringify(refused.json));
    const skipped = await source.request('POST', '/AddComponentsToSolutionAsync', {
      SolutionUniqueName: SOLUTION,
      ContinueOnError: true,
      SolutionComponentParameters: {
        ParameterCollection: [
          { LogicalName: 'new_loose', Id: LOOSE },
          { LogicalName: 'new_nothing', Id: missingId },
        ],
      },
    });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.json));
    await solutionImportJob(source.api, skipped.json.AsyncOperationId);
    assert.equal(operationOf(source.store, skipped.json.AsyncOperationId).statuscode, 30);
  });

  it('UninstallSolutionAsync: refuses an unmanaged solution, is blocked by a dependent outside it, and removes a managed one', async () => {
    const unavailable = await source.request('POST', '/UninstallSolution', { SolutionUniqueName: SOLUTION });
    assert.equal(
      unavailable.status,
      501,
      'the internal-only synchronous operation follows the documented project override policy',
    );
    assert.match(unavailable.json.error.message, /internal use only/);
    assert.match(
      source.api.metadata.csdl(),
      /<Action Name="UninstallSolution">[\s\S]*?<Parameter Name="SolutionUniqueName" Type="Edm.String"/,
    );
    const unmanaged = await source.request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: SOLUTION });
    assert.equal(unmanaged.status, 400, JSON.stringify(unmanaged.json));

    const blocked = await open();
    assert.equal(
      (await blocked.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    assert.equal(baseRow(blocked.store).ismanaged, true);
    const { request } = blocked;
    assert.equal((await request('POST', '/EntityDefinitions', tableBody('new_loose'))).status, 204);
    const outside = await request('POST', '/RelationshipDefinitions', {
      '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
      SchemaName: 'new_loose_category',
      ReferencedEntity: 'new_category',
      ReferencingEntity: 'new_loose',
      ReferencedAttribute: 'new_categoryid',
      ReferencedEntityNavigationPropertyName: 'new_loose_category_ref',
      ReferencingEntityNavigationPropertyName: 'new_category_loose',
      Lookup: column('Lookup', 'new_CategoryLoose', { Description: label('') }),
    });
    assert.equal(outside.status, 204, JSON.stringify(outside.json));
    const before = rowsOf(blocked.store, 'solution').length;
    const refused = await request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: SOLUTION });
    assert.equal(refused.status, 400, JSON.stringify(refused.json));
    assert.equal(rowsOf(blocked.store, 'solution').length, before, 'a blocked uninstall writes nothing');

    const removable = await open();
    assert.equal(
      (await removable.request('POST', '/ImportSolution', { CustomizationFile: base64(managedV1) })).status,
      204,
    );
    const solutionId = baseRow(removable.store).solutionid;
    assert.equal(
      (await removable.request('POST', '/SetPreferredSolution', { SolutionId: solutionId })).status,
      400,
      'a managed solution cannot be preferred (unverified code)',
    );
    const uninstalled = await removable.request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: SOLUTION });
    assert.equal(uninstalled.status, 200, JSON.stringify(uninstalled.json));
    await solutionImportJob(removable.api, uninstalled.json.AsyncOperationId);
    assert.equal(operationOf(removable.store, uninstalled.json.AsyncOperationId).statuscode, 30);
    assert.equal(baseRow(removable.store), undefined);
    assert.equal(
      rowsOf(removable.store, 'solutioncomponent').some((r) => r.solutionid === solutionId),
      false,
    );
  });

  it('the preferred solution: the Default solution until one is set; it is per user and counted by PreferredSolutionUsedBy', async () => {
    const initial = await source.request('GET', '/GetPreferredSolution()');
    assert.equal(initial.status, 200, JSON.stringify(initial.json));
    assert.equal(initial.json.uniquename, 'Default');
    const set = await source.request('POST', '/SetPreferredSolution', { SolutionId: baseRow(source.store).solutionid });
    assert.equal(set.status, 204, JSON.stringify(set.json));
    const current = await source.request('GET', '/GetPreferredSolution()');
    assert.equal(current.json.uniquename, SOLUTION);
    const used = await source.request(
      'GET',
      `/PreferredSolutionUsedBy(SolutionId=${baseRow(source.store).solutionid})`,
    );
    assert.equal(used.status, 200, JSON.stringify(used.json));
    assert.equal(used.json.NumberOfAssociatedUsers, 1);
    const unknown = await source.request('POST', '/SetPreferredSolution', {
      SolutionId: '00000000-0000-4000-8000-00000000000b',
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
  });
});

describe('Imported row stamps', () => {
  const IMPORT_TIME = Date.parse('2026-03-01T12:00:00.000Z');
  const STAMPED = '2026-03-01T12:00:00Z';
  const PAYLOAD_TIME = '2020-01-02T03:04:05Z';
  const mapping = { logicalName: 'new_widget', ownership: 'OrganizationOwned' };
  const storeAtImportTime = () => new DataStore({ state: emptyState(), clock: fixedClock(IMPORT_TIME) }).init();
  const payload = () => ({ new_name: 'row', modifiedon: PAYLOAD_TIME, versionnumber: 99 });

  it('a new row keeps the modifiedon its payload sets, takes the import time as createdon, and no payload versionnumber', async () => {
    const store = await storeAtImportTime();
    const row = stampImportedRow(store, null, payload(), mapping, { existing: false });
    assert.equal(row.modifiedon, PAYLOAD_TIME);
    assert.equal(row.createdon, STAMPED);
    assert.equal(row.versionnumber, 1, 'the store assigns the version');
  });

  it('an existing row takes the import time as modifiedon, not the payload value, and no payload versionnumber', async () => {
    const store = await storeAtImportTime();
    const row = stampImportedRow(store, null, payload(), mapping, { existing: true });
    assert.equal(row.modifiedon, STAMPED);
    assert.equal(row.versionnumber, 1, 'the store assigns the version');
  });
});

// Uninstall of a managed solution that holds a custom API. Solution import carries no custom APIs in Mirage, so the API and
// its step are seeded as solution payload layers (applySolutionPayloads), the way a source layer records them.
describe('Uninstall of a solution that holds a custom API', { concurrency: false }, () => {
  const API = 'new_Ping';
  const API_ID = '41000000-0000-4000-8000-0000000000c1';
  const STEP_ID = '99999999-0000-4000-8000-0000000000c1';
  const opened = [];
  const messageOf = (store) => rowsOf(store, 'sdkmessage').find((row) => row.name === API);
  const filtersOf = (store, message) =>
    rowsOf(store, 'sdkmessagefilter').filter((row) => message && row.sdkmessageid === message.sdkmessageid);
  const stepRow = (store, message) => ({
    name: 'Invented step on new_Ping',
    sdkmessageid: message.sdkmessageid,
    sdkmessagefilterid: filtersOf(store, message)[0].sdkmessagefilterid,
    stage: 40,
    mode: 0,
    rank: 1,
    statecode: 0,
    statuscode: 1,
  });

  after(async () => {
    for (const server of opened) await server.close();
  });

  // A server holding the managed solution: its API (and, when inSolution, the step on the API's message) are solution
  // components; outsideStep adds a step that no solution holds, on the same message.
  async function holding({ inSolution = false, outsideStep = false } = {}) {
    const target = await startServer();
    opened.push(target);
    const { store, api } = target;
    await store.transact(() => {
      (store.state.tables.solution ??= []).push({
        solutionid: '42000000-0000-4000-8000-0000000000c1',
        uniquename: SOLUTION,
        friendlyname: 'Invented solution',
        version: '1.0.0.0',
        ismanaged: true,
        isvisible: true,
        parentsolutionid: null,
      });
    });
    const solutionId = '42000000-0000-4000-8000-0000000000c1';
    const components = [
      {
        kind: 'customapi',
        id: API_ID,
        logical: 'customapi',
        name: API,
        // custom API components carry an environment-assigned type number (10000 and above)
        type: 10052,
        row: {
          customapiid: API_ID,
          uniquename: API,
          name: API,
          description: 'Invented ping API',
          bindingtype: 0,
          isfunction: false,
          isprivate: false,
          allowedcustomprocessingsteptype: 2,
        },
      },
    ];
    await store.transact(() =>
      applySolutionPayloads(store.state, solutionId, components, { definitionOf: standardTableDef }),
    );
    await store.transact(() => resyncMessageFilters(api));
    const message = messageOf(store);
    if (inSolution)
      await store.transact(() =>
        applySolutionPayloads(
          store.state,
          solutionId,
          [
            {
              kind: 'sdkmessageprocessingstep',
              id: STEP_ID,
              logical: 'sdkmessageprocessingstep',
              name: 'Invented step on new_Ping',
              type: 92,
              row: stepRow(store, message),
            },
          ],
          { definitionOf: standardTableDef },
        ),
      );
    if (outsideStep)
      await store.transact(() => {
        (store.state.tables.sdkmessageprocessingstep ??= []).push({
          sdkmessageprocessingstepid: '99999999-0000-4000-8000-0000000000c2',
          ...stepRow(store, message),
        });
      });
    return target;
  }
  const uninstall = async (target) => {
    const started = await target.request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: SOLUTION });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    await solutionImportJob(target.api, started.json.AsyncOperationId);
    assert.equal(
      rowsOf(target.store, 'asyncoperation').find((r) => r.asyncoperationid === started.json.AsyncOperationId)
        .statuscode,
      30,
    );
  };

  // @test-kind unproven: end state derived from NP-9 N3 (API delete removes its message and filter); the uninstall path itself has no capture. Solution import carries no custom APIs in Mirage, so the solution component is seeded
  it('uninstall with no step removes the API, its message and its filters', async () => {
    const target = await holding();
    const message = messageOf(target.store);
    assert.ok(message, 'the API has its message before the uninstall');
    assert.ok(filtersOf(target.store, message).length > 0, 'and its filters');
    await uninstall(target);
    assert.equal(
      rowsOf(target.store, 'customapi').some((row) => row.uniquename === API),
      false,
      'the API is removed',
    );
    assert.equal(messageOf(target.store), undefined, 'the message is removed');
    assert.equal(filtersOf(target.store, message).length, 0, 'and its filters');
  });

  // @test-kind unproven: end state derived from NP-9 N3 (API delete removes its message and filter); the uninstall path itself has no capture. Solution import carries no custom APIs in Mirage, so the solution component is seeded
  it('uninstall with a step of the same solution removes the step, the API, its message and its filters', async () => {
    const target = await holding({ inSolution: true });
    const message = messageOf(target.store);
    assert.ok(
      rowsOf(target.store, 'sdkmessageprocessingstep').some((row) => row.sdkmessageprocessingstepid === STEP_ID),
    );
    await uninstall(target);
    assert.equal(
      rowsOf(target.store, 'sdkmessageprocessingstep').some((row) => row.sdkmessageprocessingstepid === STEP_ID),
      false,
      'the step is removed',
    );
    assert.equal(
      rowsOf(target.store, 'customapi').some((row) => row.uniquename === API),
      false,
      'the API is removed',
    );
    assert.equal(messageOf(target.store), undefined, 'the message is removed');
    assert.equal(filtersOf(target.store, message).length, 0, 'and its filters');
  });

  // @test-kind unproven: no capture of uninstalling a solution whose custom API has a step outside the solution
  it('uninstall with a step outside the solution removes the API, and keeps the message and filters for that step', async () => {
    const target = await holding({ outsideStep: true });
    const message = messageOf(target.store);
    const filters = filtersOf(target.store, message).length;
    await uninstall(target);
    assert.equal(
      rowsOf(target.store, 'customapi').some((row) => row.uniquename === API),
      false,
      'the API is removed',
    );
    assert.ok(messageOf(target.store), 'the message stays for the step that uses it');
    assert.equal(filtersOf(target.store, message).length, filters, 'and its filters stay');
  });
});
