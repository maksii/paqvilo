// Runtime table changes take their sdkmessagefilter rows with them: a table created through the Web API gets its native
// filter set, a table deleted through it loses its filters. Invented tables (new_gadget) on a loopback Dataverse API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const ASSEMBLY = '40000000-0000-4000-8000-0000000000b1';
const TYPE = '50000000-0000-4000-8000-0000000000b1';
const TYPE_NAME = 'Invented.Runtime.Recorder';

const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const gadgetBody = () => ({
  '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: 'new_gadget',
  DisplayName: label('Gadget'),
  DisplayCollectionName: label('Gadgets'),
  Description: label('Invented gadgets'),
  OwnershipType: 'UserOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: 'new_Name',
      DisplayName: label('Name'),
      IsPrimaryName: true,
      MaxLength: 100,
      FormatName: { Value: 'Text' },
    },
  ],
});

async function fixture(t, mappings = {}) {
  const f = await contractModuleFixture(t, {
    mappings,
    tables: {
      pluginassembly: [{ pluginassemblyid: ASSEMBLY, name: 'Invented.Runtime', version: '1.0.0.0' }],
      plugintype: [{ plugintypeid: TYPE, typename: TYPE_NAME, pluginassemblyid: ASSEMBLY }],
    },
    extension: { name: 'runtime-table-filters-probe', install: () => {} },
  });
  const messageName = (row) => f.store.tableRows('sdkmessage').find((m) => m.sdkmessageid === row.sdkmessageid).name;
  const filtersOf = (table) =>
    f.store.tableRows('sdkmessagefilter').filter((row) => row.primaryobjecttypecode === table);
  return { ...f, messageName, filtersOf };
}

// @test-kind parity: native-filters.json custom user-owned table filter template (created with the table)
// @parity-evidence: native-filters.json pqwp_probe (user-owned custom table) filter set
test('a user-owned table created through the Web API takes the custom user-owned filter set and takes a step', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/EntityDefinitions', gadgetBody())).status, 204);
  const filters = f.filtersOf('new_gadget');
  assert.deepEqual(filters.map(f.messageName).sort(), [
    'Archive',
    'Assign',
    'BulkArchive',
    'BulkRetain',
    'Create',
    'CreateMultiple',
    'CreateMultipleLegacy',
    'Delete',
    'DeleteMultiple',
    'GrantAccess',
    'IsValidStateTransition',
    'ModifyAccess',
    'PurgeArchivedContent',
    'PurgeRetainedContent',
    'Retain',
    'Retrieve',
    'RetrieveMultiple',
    'RetrievePrincipalAccess',
    'RetrieveSharedPrincipalsAndAccess',
    'RevokeAccess',
    'RollbackRetain',
    'SetState',
    'SetStateDynamicEntity',
    'Update',
    'UpdateMultiple',
    'UpdateMultipleLegacy',
    'ValidateArchiveConfig',
    'ValidateRetentionConfig',
  ]);
  const update = f.store.tableRows('sdkmessage').find((row) => row.name === 'Update');
  const gadgetUpdate = filters.find((row) => row.sdkmessageid === update.sdkmessageid);
  const step = await f.request('POST', '/sdkmessageprocessingsteps', {
    name: 'Probe: gadget update',
    stage: 20,
    mode: 0,
    'sdkmessageid@odata.bind': `/sdkmessages(${update.sdkmessageid})`,
    'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${gadgetUpdate.sdkmessagefilterid})`,
    'eventhandler_plugintype@odata.bind': `/plugintypes(${TYPE})`,
  });
  assert.ok(step.status >= 200 && step.status < 300, await step.clone().text());
});

// @test-kind unproven: Dataverse removes a deleted table's sdkmessagefilter rows with the table; the removal is not captured natively
test('a table deleted through the Web API loses its sdkmessagefilter rows', async (t) => {
  const f = await fixture(t, {
    new_gadget: {
      logicalName: 'new_gadget',
      entitySet: 'new_gadgets',
      idColumn: 'new_gadgetid',
      nameColumn: 'new_name',
      ownership: 'UserOwned',
      fields: { new_name: { dataverseType: 'nvarchar' }, ownerid: { dataverseType: 'owner' } },
      userConfigured: true,
      dataverseOnly: true,
      dataverseMetadata: { schemaName: 'new_gadget', createdByMetadataApi: true },
    },
  });
  assert.ok(f.filtersOf('new_gadget').length > 0, 'the table has filters before the delete');
  assert.equal((await f.request('DELETE', "/EntityDefinitions(LogicalName='new_gadget')")).status, 204);
  assert.deepEqual(f.filtersOf('new_gadget'), []);
});
