// @test-kind compatibility: Microsoft.Xrm.Sdk.Messages UpsertMultipleRequest/DeleteMultipleRequest contracts (Targets; UpsertMultipleResponse.Results of UpsertResponse); the Web API UpsertMultiple and DeleteMultiple semantics of this toolkit
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';

// Invented organization: a standard widget table, an elastic gizmo table and the caller.
const caller = '10000000-0000-4000-8000-0000000000b1',
  kept = '20000000-0000-4000-8000-0000000000b1',
  fresh = '20000000-0000-4000-8000-0000000000b2';
const messageIds = {
  CreateMultiple: '30000000-0000-4000-8000-0000000000b1',
  UpdateMultiple: '30000000-0000-4000-8000-0000000000b2',
  UpsertMultiple: '30000000-0000-4000-8000-0000000000b3',
  DeleteMultiple: '30000000-0000-4000-8000-0000000000b4',
};
// filters: the message names the widget table's sdkmessagefilter rows make available.
const storeOf = (filters = ['CreateMultiple', 'UpdateMultiple', 'UpsertMultiple']) =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid', fields: { title: { type: 'string' } } },
        gizmo: {
          entitySet: 'gizmos',
          idColumn: 'gizmoid',
          tableType: 'Elastic',
          fields: { title: { type: 'string' } },
        },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        widget: [{ widgetid: kept, title: 'Before', statecode: 0, statuscode: 1 }],
        gizmo: [
          { gizmoid: kept, title: 'Old' },
          { gizmoid: fresh, title: 'Older' },
        ],
        systemuser: [{ systemuserid: caller, fullname: 'Invented caller' }],
        sdkmessage: Object.entries(messageIds).map(([name, sdkmessageid]) => ({ sdkmessageid, name })),
        sdkmessagefilter: filters.map((name) => ({
          sdkmessagefilterid: messageIds[name],
          sdkmessageid: messageIds[name],
          primaryobjecttypecode: 'widget',
        })),
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const profile = {
  userId: caller,
  evidence: 'Invented SDK bulk caller',
  grants: [
    { entity: 'widget', operations: ['read', 'create', 'update', 'delete'] },
    { entity: 'gizmo', operations: ['read', 'create', 'update', 'delete'] },
  ],
};
const ref = (logicalName, id) => ({ $type: 'EntityReference', logicalName, id, name: null });
const entity = (logicalName, id, attributes) => ({ $type: 'Entity', logicalName, id, attributes });
const execute = (store, requestName, values) =>
  dispatchSdkCall({
    store,
    profile,
    message: {
      method: 'Execute',
      userId: caller,
      arguments: [
        {
          $type: 'OrganizationRequest',
          requestName,
          parameters: { $type: 'ParameterCollection', values },
        },
      ],
    },
  });

test('SDK UpsertMultiple creates the new rows through CreateMultiple, then updates the existing ones through UpdateMultiple', () => {
  const store = storeOf();
  const operations = [];
  store.setPluginPipeline(
    (context) => operations.push(context.operation),
    (context) => ['createmultiple', 'updatemultiple', 'upsertmultiple'].includes(context.operation),
  );
  const response = execute(store, 'UpsertMultiple', {
    Targets: {
      $type: 'EntityCollection',
      entities: [entity('widget', kept, { title: 'After' }), entity('widget', fresh, { title: 'New' })],
    },
  });
  const answers = response.results.Results.values;
  assert.deepEqual(
    answers.map((answer) => answer.results.RecordCreated),
    [false, true],
  );
  assert.deepEqual(
    answers.map((answer) => answer.results.Target.id),
    [kept, fresh],
  );
  assert.deepEqual(
    store.tableRows('widget').map((row) => [row.widgetid, row.title]),
    [
      [kept, 'After'],
      [fresh, 'New'],
    ],
  );
  // Creates run before updates, each through its own bulk message pipeline; UpsertMultiple has none of its own.
  assert.ok(operations.includes('createmultiple') && operations.includes('updatemultiple'));
  assert.ok(operations.lastIndexOf('createmultiple') < operations.indexOf('updatemultiple'));
  assert.ok(!operations.includes('upsertmultiple'));
});

test('SDK UpsertMultiple on a table whose filters lack UpsertMultiple is refused with 0x80040800', () => {
  const store = storeOf(['CreateMultiple', 'UpdateMultiple']);
  assert.throws(
    () =>
      execute(store, 'UpsertMultiple', {
        Targets: { $type: 'EntityCollection', entities: [entity('widget', fresh, { title: 'New' })] },
      }),
    { details: { innerCode: '0x80040800' } },
  );
  assert.equal(store.tableRows('widget').length, 1);
});

test('SDK DeleteMultiple on a standard table runs PreValidation, is refused with 0x8004023b and deletes nothing', () => {
  const store = storeOf();
  assert.throws(
    () =>
      execute(store, 'DeleteMultiple', {
        Targets: { $type: 'EntityReferenceCollection', values: [ref('widget', kept)] },
      }),
    { status: 405, details: { innerCode: '0x8004023b' } },
  );
  assert.deepEqual(
    store.tableRows('widget').map((row) => row.widgetid),
    [kept],
  );
});

test('SDK DeleteMultiple on an elastic table deletes each target', () => {
  const store = storeOf();
  const response = execute(store, 'DeleteMultiple', {
    Targets: { $type: 'EntityReferenceCollection', values: [ref('gizmo', kept), ref('gizmo', fresh)] },
  });
  assert.deepEqual(response.results, {});
  assert.deepEqual(store.tableRows('gizmo'), []);
});
