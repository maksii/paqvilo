import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { zipOf, solutionImportJob } from '../lib/dataverse-solutions.mjs';
import { readSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import {
  solutionDocumentComponents,
  mergeSolutionCustomizationEntries,
} from '../lib/dataverse-solution-components.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { parseSchemaDocument } from '../lib/solution-schema.mjs';

const appId = '31a58b8c-793c-4bf0-9fb3-8270309b21b1';
const formId = '31a58b8c-793c-4bf0-9fb3-8270309b21b2';
const viewId = '31a58b8c-793c-4bf0-9fb3-8270309b21b3';
const workflowId = '31a58b8c-793c-4bf0-9fb3-8270309b21b4';
const label = (text) => `<LocalizedNames><LocalizedName languagecode="1033" description="${text}" /></LocalizedNames>`;
function archive({
  uniqueName = 'new_assetfixture',
  version = '1.0.0.0',
  managed = true,
  broken = false,
  formName = 'Fixture form',
} = {}) {
  const xml = `<ImportExportXml><Entities><Entity><Name>new_assetrecord</Name><EntityInfo><entity Name="new_assetrecord">${label('Fixture record')}<attributes>
    <attribute PhysicalName="new_Name"><Type>nvarchar</Type><Name>new_Name</Name><LogicalName>new_name</LogicalName><DisplayMask>ValidForForm|ValidForRead|PrimaryName</DisplayMask><MaxLength>100</MaxLength><IsCustomField>1</IsCustomField><OpaqueColumnSetting>retained</OpaqueColumnSetting></attribute>
    <attribute PhysicalName="new_Code"><Type>nvarchar</Type><Name>new_Code</Name><LogicalName>new_code</LogicalName><MaxLength>20</MaxLength><IsCustomField>1</IsCustomField></attribute>
    </attributes><EntityKeys><EntityKey><Name>new_CodeKey</Name><LogicalName>new_codekey</LogicalName><EntityKeyAttributes><AttributeName>${broken ? 'new_missing' : 'new_code'}</AttributeName></EntityKeyAttributes></EntityKey></EntityKeys></entity></EntityInfo>
    <FormXml><forms type="main"><systemform><formid>{${formId}}</formid><type>2</type>${label(formName)}<form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control id="name" datafieldname="new_name" /></cell></row></rows></section></sections></column></columns></tab></tabs><formLibraries><Library name="new_script" /></formLibraries></form></systemform></forms></FormXml>
    <SavedQueries><savedqueries><savedquery><savedqueryid>{${viewId}}</savedqueryid>${label('Fixture records')}<querytype>0</querytype><isdefault>1</isdefault><fetchxml><fetch><entity name="new_assetrecord"><attribute name="new_name" /></entity></fetch></fetchxml><layoutxml><grid><row><cell name="new_name" width="240" /></row></grid></layoutxml></savedquery></savedqueries></SavedQueries>
    </Entity></Entities><AppModules><AppModule><AppModuleId>{${appId}}</AppModuleId><UniqueName>new_fixtureapp</UniqueName>${label('Fixture app')}<AppModuleComponents><AppModuleComponent type="1" schemaName="new_assetrecord" /></AppModuleComponents><SiteMap><Area Id="main"><Group Id="records"><SubArea Id="records" Entity="new_assetrecord" /></Group></Area></SiteMap></AppModule></AppModules>
    <Workflows><Workflow WorkflowId="{${workflowId}}" Name="Fixture workflow"><PrimaryEntity>new_assetrecord</PrimaryEntity><Xaml>opaque workflow</Xaml></Workflow></Workflows></ImportExportXml>`;
  const manifest = `<ImportExportXml><SolutionManifest><UniqueName>${uniqueName}</UniqueName><Version>${version}</Version><Managed>${managed ? 1 : 0}</Managed><Publisher><UniqueName>new_fixturepublisher</UniqueName><CustomizationPrefix>new</CustomizationPrefix></Publisher></SolutionManifest></ImportExportXml>`;
  return zipOf([
    { name: 'solution.xml', data: Buffer.from(manifest) },
    { name: 'customizations.xml', data: Buffer.from(xml) },
    { name: '[Content_Types].xml', data: Buffer.from('<Types />') },
    { name: 'WebResources/new_script.js', data: Buffer.from('throw new Error("must never execute");\n') },
    { name: 'PluginAssemblies/opaque.dll', data: Buffer.from([0, 255, 13, 10, 42]) },
  ]);
}
async function server(state = emptyState()) {
  const secretVariable = `PAQVILO_ASSET_TEST_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  process.env[secretVariable] = 'fixture-secret';
  const store = await new DataStore({ state }).init();
  let api;
  const host = await startDataverseApi({
    store,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId,
          displayName: 'Solution asset test',
          secretEnvironmentVariable: secretVariable,
          roles: ['System Administrator'],
        },
      ],
    }),
    extensions: [
      ...EXTENSIONS,
      {
        name: 'capture-assets',
        install(value) {
          api = value;
        },
      },
    ],
    log() {},
  });
  const token = await fetch(`${host.origin}/${host.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: 'fixture-secret',
      scope: `${host.origin}/.default`,
    }),
  }).then((r) => r.json());
  const request = async (method, path, body) => {
    const response = await fetch(`${host.origin}/api/data/v9.2${path}`, {
      method,
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return {
    store,
    api,
    request,
    async close() {
      delete process.env[secretVariable];
      await host.close();
    },
  };
}
async function importInto(host, bytes, extra = {}) {
  const result = await host.request('POST', '/ImportSolution', {
    CustomizationFile: bytes.toString('base64'),
    ImportJobId: randomUUID(),
    ...extra,
  });
  assert.equal(result.status, 204, JSON.stringify(result.json));
}

test('solution API retains app/form/view/workflow and opaque assets across restart, export and fresh import', async (t) => {
  const source = await server();
  t.after(() => source.close());
  const bytes = archive();
  await importInto(source, bytes);
  assert.equal(
    source.store.state.tables.appmodule.find((row) => row.appmoduleid === appId)?.uniquename,
    'new_fixtureapp',
  );
  assert.equal(source.store.state.tables.systemform.find((row) => row.formid === formId)?.name, 'Fixture form');
  assert.equal(
    source.store.state.tables.savedquery.find((row) => row.savedqueryid === viewId)?.returnedtypecode,
    'new_assetrecord',
  );
  assert.equal(
    source.store.state.tables.workflow.find((row) => row.workflowid === workflowId)?.xaml,
    'opaque workflow',
  );
  assert.equal(source.store.state.mappings.new_assetrecord.alternateKeys[0].name, 'new_codekey');
  const edited = await source.request('PATCH', `/systemforms(${formId})`, { name: 'Edited form' });
  assert.equal(edited.status, 204, JSON.stringify(edited.json));
  const restarted = await server(JSON.parse(JSON.stringify(source.store.state)));
  t.after(() => restarted.close());
  const exported = await restarted.request('POST', '/ExportSolution', {
    SolutionName: 'new_assetfixture',
    Managed: true,
  });
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  const entries = readSolutionAssetEntries(Buffer.from(exported.json.ExportSolutionFile, 'base64'));
  for (const original of readSolutionAssetEntries(bytes).filter((entry) => !entry.name.endsWith('.xml')))
    assert.deepEqual(entries.find((entry) => entry.name === original.name)?.data, original.data);
  const customizations = entries.find((entry) => entry.name === 'customizations.xml').data.toString('utf8');
  assert.match(customizations, /OpaqueColumnSetting>retained/);
  assert.match(customizations, /new_CodeKey/);
  assert.equal(solutionDocumentComponents(customizations).filter((component) => component.id === formId).length, 1);
  assert.equal(
    solutionDocumentComponents(customizations).find((component) => component.id === formId).row.name,
    'Edited form',
  );
  const target = await server();
  t.after(() => target.close());
  await importInto(target, Buffer.from(exported.json.ExportSolutionFile, 'base64'));
  assert.equal(
    target.store.state.tables.systemform.find((row) => row.formid === formId)?.formxml,
    source.store.state.tables.systemform.find((row) => row.formid === formId)?.formxml,
  );
  // Each organization runs its own index job, so the job id differs; the definition does not.
  const definition = (keys) => keys.map(({ asyncJob, ...key }) => key);
  assert.deepEqual(
    definition(target.store.state.mappings.new_assetrecord.alternateKeys),
    definition(source.store.state.mappings.new_assetrecord.alternateKeys),
  );
});

test('failed import rolls back metadata, component rows and retained payload bytes', async (t) => {
  const host = await server();
  t.after(() => host.close());
  const before = JSON.stringify(host.store.state.dataverse.solutionAssets ?? null);
  const result = await host.request('POST', '/ImportSolution', {
    CustomizationFile: archive({ broken: true }).toString('base64'),
    ImportJobId: randomUUID(),
  });
  assert.equal(result.status, 400, JSON.stringify(result.json));
  assert.equal(host.store.state.mappings.new_assetrecord, undefined);
  assert.equal(host.store.state.tables.appmodule?.some((row) => row.appmoduleid === appId) ?? false, false);
  assert.equal(JSON.stringify(host.store.state.dataverse.solutionAssets ?? null), before);
});

test('app membership action edits export and reimport while preserving unresolved declarations and XML siblings', async (t) => {
  const host = await server();
  t.after(() => host.close());
  const unresolved = '31a58b8c-793c-4bf0-9fb3-8270309b21ff';
  const bytes = zipOf(
    readSolutionAssetEntries(archive()).map((entry) =>
      entry.name === 'customizations.xml'
        ? {
            ...entry,
            data: Buffer.from(
              entry.data
                .toString()
                .replace(
                  '</AppModuleComponents>',
                  `<AppModuleComponent type="99" id="${unresolved}"/><FutureSetting value="retained"/></AppModuleComponents>`,
                ),
            ),
          }
        : entry,
    ),
  );
  await importInto(host, bytes);
  const members = await host.request('GET', `/RetrieveAppComponents(AppModuleId=${appId})`);
  assert.equal(members.status, 200, JSON.stringify(members.json));
  assert.equal(members.json.value.length, 1);
  const objectId = members.json.value[0].objectid;
  const removed = await host.request('POST', '/RemoveAppComponents', {
    AppId: appId,
    Components: [{ objectid: objectId }],
  });
  assert.equal(removed.status, 204, JSON.stringify(removed.json));
  const without = await host.request('POST', '/ExportSolution', { SolutionName: 'new_assetfixture', Managed: true });
  assert.equal(without.status, 200, JSON.stringify(without.json));
  const xml = readSolutionAssetEntries(Buffer.from(without.json.ExportSolutionFile, 'base64'))
    .find((entry) => entry.name === 'customizations.xml')
    .data.toString();
  assert.match(xml, /FutureSetting value="retained"/);
  assert.match(xml, new RegExp(unresolved));
  const target = await server();
  t.after(() => target.close());
  await importInto(target, Buffer.from(without.json.ExportSolutionFile, 'base64'));
  assert.equal((await target.request('GET', `/RetrieveAppComponents(AppModuleId=${appId})`)).json.value.length, 0);
  const added = await host.request('POST', '/AddAppComponents', {
    AppId: appId,
    Components: [{ '@odata.type': 'Microsoft.Dynamics.CRM.entity', objectid: objectId }],
  });
  assert.equal(added.status, 204, JSON.stringify(added.json));
  const restored = await host.request('POST', '/ExportSolution', { SolutionName: 'new_assetfixture', Managed: true });
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  const fresh = await server();
  t.after(() => fresh.close());
  await importInto(fresh, Buffer.from(restored.json.ExportSolutionFile, 'base64'));
  const restoredMembers = await fresh.request('GET', `/RetrieveAppComponents(AppModuleId=${appId})`);
  assert.equal(restoredMembers.json.value.length, 1);
  assert.equal(restoredMembers.json.value[0].objectid, objectId);
});

test('managed upgrade and uninstall target owned assets and transfer retained component origins', async (t) => {
  const host = await server();
  t.after(() => host.close());
  await importInto(host, archive());
  const unrelated = archive({ uniqueName: 'new_unrelated', version: '1.0.0.0' });
  // An independent solution without shared records must retain its payload.
  const unrelatedEntries = readSolutionAssetEntries(unrelated).map((entry) => ({
    ...entry,
    data: entry.name === 'customizations.xml' ? Buffer.from('<ImportExportXml />') : entry.data,
  }));
  await importInto(host, zipOf(unrelatedEntries));
  const upgrade = await host.request('POST', '/StageAndUpgrade', {
    CustomizationFile: archive({ version: '2.0.0.0', formName: 'Upgraded form' }).toString('base64'),
    ImportJobId: randomUUID(),
    OverwriteUnmanagedCustomizations: true,
  });
  assert.equal(upgrade.status, 200, JSON.stringify(upgrade.json));
  assert.equal(host.store.state.tables.systemform.find((row) => row.formid === formId)?.name, 'Upgraded form');
  const promoted = await host.request('POST', '/DeleteAndPromote', { UniqueName: 'new_assetfixture' });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
  assert.equal(host.store.state.mappings.new_assetrecord.alternateKeys[0].name, 'new_codekey');
  const started = await host.request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: 'new_assetfixture' });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const job = await solutionImportJob(host.api, started.json.AsyncOperationId);
  assert.equal(job.statuscode, 30, job.message);
  assert.equal(
    host.store.state.tables.systemform.some((row) => row.formid === formId),
    false,
  );
  assert.equal(host.store.state.mappings.new_assetrecord, undefined);
  const owner = host.store.state.tables.solution.find((row) => row.uniquename === 'new_unrelated').solutionid;
  assert.deepEqual(
    host.store.state.dataverse.solutionAssets.layers.map((layer) => layer.ownerSolutionId),
    [owner],
  );
});

test('effective solution metadata caches payload parsing across ordinary CRUD and preserves base metadata', async (t) => {
  const host = await server();
  t.after(() => host.close());
  await importInto(host, archive());
  let reads = 0;
  const overlay = createSolutionMetadataOverlay({
    parseDocument(xml, info) {
      reads++;
      return parseSchemaDocument(xml, info);
    },
  });
  const base = { lcid: 1033, entities: {}, forms: [], views: [], modelDrivenApps: [] };
  const before = JSON.stringify(base);
  const first = overlay(base, host.store.state),
    parsed = reads;
  assert.equal(first.entities.new_assetrecord.fields.new_code.maxLength, 20);
  assert.equal(first.entities.new_assetrecord.label, 'Fixture record');
  assert.equal(first.entities.new_assetrecord.fields.new_name.type, 'text');
  host.store.state.tables.new_assetrecord.push({ new_assetrecordid: randomUUID(), new_name: 'Ordinary row' });
  assert.equal(overlay(base, host.store.state), first);
  assert.equal(reads, parsed);
  host.store.state.mappings.new_assetrecord.fields.new_code.columnMetadata.maxLength = 35;
  host.store.state.dataverse.metadataLog.push({ seq: 1000 });
  assert.equal(overlay(base, host.store.state).entities.new_assetrecord.fields.new_code.maxLength, 35);
  assert.equal(JSON.stringify(base), before);
  const restarted = JSON.parse(JSON.stringify(host.store.state));
  assert.equal(overlay(base, restarted), overlay(base, host.store.state));
  restarted.dataverse.solutionAssets.layers = [];
  assert.equal(overlay(base, restarted), base);
});

test('XML component merge retains distinct table components and accumulates packed patch forms', () => {
  const entries = [
    {
      name: 'customizations.xml',
      data: Buffer.from(
        '<ImportExportXml><Entities><Entity><Name>a</Name><EntityInfo><entity Name="a"><attributes><attribute><LogicalName>a_name</LogicalName></attribute></attributes></entity></EntityInfo><FormXml><systemform><formid>a</formid></systemform></FormXml></Entity><Entity><Name>b</Name><EntityInfo><entity Name="b" /></EntityInfo></Entity></Entities></ImportExportXml>',
      ),
    },
    {
      name: 'customizations.xml',
      data: Buffer.from(
        '<ImportExportXml><Entities><Entity><Name>a</Name><EntityInfo><entity Name="a" /></EntityInfo><FormXml><systemform><formid>b</formid></systemform></FormXml></Entity></Entities></ImportExportXml>',
      ),
    },
  ];
  const result = mergeSolutionCustomizationEntries(entries, '<ImportExportXml><Entities /></ImportExportXml>', {
    mappings: { a: { fields: { a_name: {} } }, b: { fields: {} } },
  });
  const xml = result[0].data.toString();
  assert.equal((xml.match(/<Entity>/g) ?? []).length, 2);
  assert.match(xml, /<formid>a<\/formid>/);
  assert.match(xml, /<formid>b<\/formid>/);
});

test('solution import and export retain source relationship menus/cascades and global choice facts', async (t) => {
  const source = await server();
  t.after(() => source.close());
  const facts = `<EntityRelationships><EntityRelationship Name="new_assetrecord_parent"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencedEntityName>new_assetrecord</ReferencedEntityName><ReferencingEntityName>new_assetrecord</ReferencingEntityName><ReferencedAttributeName>new_assetrecordid</ReferencedAttributeName><ReferencingAttributeName>new_parentid</ReferencingAttributeName><IntroducedVersion>3.2.1.0</IntroducedVersion><IsCustomizable>0</IsCustomizable><RelationshipBehavior>1</RelationshipBehavior><SecurityTypes>Append</SecurityTypes><CascadeDelete>Restrict</CascadeDelete><CascadeArchive>RemoveLink</CascadeArchive><EntityRelationshipRoles><EntityRelationshipRole><RelationshipRoleType>1</RelationshipRoleType><NavigationPropertyName>new_parent</NavigationPropertyName><NavPaneDisplayOption>DoNotDisplay</NavPaneDisplayOption><NavPaneArea>Details</NavPaneArea><NavPaneOrder>0</NavPaneOrder><CustomLabels><CustomLabel languagecode="1033" description="Parent records" /></CustomLabels></EntityRelationshipRole><EntityRelationshipRole><RelationshipRoleType>0</RelationshipRoleType><NavigationPropertyName>new_children</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship></EntityRelationships><optionsets><optionset Name="new_assetchoice"><OptionSetType>picklist</OptionSetType><IsGlobal>1</IsGlobal><IntroducedVersion>3.2.1.0</IntroducedVersion><IsCustomizable>0</IsCustomizable><options><option value="100000000" ExternalValue="" IsHidden="1"><labels><label description="First" languagecode="1033" /></labels></option></options></optionset></optionsets>`;
  const entries = readSolutionAssetEntries(archive()).map((entry) => ({
    ...entry,
    data:
      entry.name === 'customizations.xml'
        ? Buffer.from(entry.data.toString().replace('</ImportExportXml>', `${facts}</ImportExportXml>`))
        : entry.data,
  }));
  await importInto(source, zipOf(entries));
  const check = async (host) => {
    const relation = await host.request(
      'GET',
      "/RelationshipDefinitions(SchemaName='new_assetrecord_parent')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    );
    assert.equal(relation.status, 200, JSON.stringify(relation.json));
    assert.equal(relation.json.CascadeConfiguration.Delete, 'Restrict');
    assert.equal(relation.json.CascadeConfiguration.Archive, 'RemoveLink');
    assert.equal(relation.json.AssociatedMenuConfiguration.Order, 0);
    assert.equal(relation.json.AssociatedMenuConfiguration.Label.UserLocalizedLabel.Label, 'Parent records');
    assert.equal(relation.json.IsCustomizable.Value, false);
    assert.equal(relation.json.IntroducedVersion, '3.2.1.0');
    assert.equal(relation.json.SecurityTypes, 'Append');
    const choice = await host.request('GET', "/GlobalOptionSetDefinitions(Name='new_assetchoice')");
    assert.equal(choice.status, 200, JSON.stringify(choice.json));
    assert.equal(choice.json.IntroducedVersion, '3.2.1.0');
    assert.equal(choice.json.IsCustomizable.Value, false);
    assert.equal(choice.json.Options[0].ExternalValue, '');
    assert.equal(choice.json.Options[0].IsHidden, true);
  };
  await check(source);
  const exported = await source.request('POST', '/ExportSolution', { SolutionName: 'new_assetfixture', Managed: true });
  assert.equal(exported.status, 200, JSON.stringify(exported.json));
  const target = await server();
  t.after(() => target.close());
  await importInto(target, Buffer.from(exported.json.ExportSolutionFile, 'base64'));
  await check(target);
});
