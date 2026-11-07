// @test-kind compatibility: Microsoft Learn MergeRequest (Target, SubordinateId, UpdateContent, PerformParentingChecks): the target takes the subordinate's missing values and UpdateContent, the subordinate is deactivated and its child records move to the target; availability follows the table's Merge sdkmessagefilter
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';

const caller = '10000000-0000-4000-8000-0000000000e1',
  master = '20000000-0000-4000-8000-0000000000e1',
  duplicate = '20000000-0000-4000-8000-0000000000e2',
  part = '20000000-0000-4000-8000-0000000000e3',
  merge = '30000000-0000-4000-8000-0000000000e1';
const storeOf = (filters, fields = {}) =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        gadget: {
          entitySet: 'gadgets',
          idColumn: 'gadgetid',
          fields: { title: { type: 'string' }, color: { type: 'string' }, size: { type: 'string' }, ...fields },
          relationships: { gadget_parts: { entity: 'part', many: true, from: 'gadgetid', to: 'gadgetid' } },
        },
        part: { entitySet: 'parts', idColumn: 'partid', fields: { gadgetid: { dataverseType: 'lookup' } } },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        gadget: [
          { gadgetid: master, title: 'Master', statecode: 0, statuscode: 1 },
          { gadgetid: duplicate, title: 'Duplicate', color: 'red', statecode: 0, statuscode: 1 },
        ],
        part: [{ partid: part, gadgetid: { id: duplicate, logical_name: 'gadget' } }],
        systemuser: [{ systemuserid: caller, fullname: 'Invented caller' }],
        sdkmessage: [{ sdkmessageid: merge, name: 'Merge' }],
        sdkmessagefilter: filters
          ? [{ sdkmessagefilterid: merge, sdkmessageid: merge, primaryobjecttypecode: 'gadget' }]
          : [],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const profile = {
  userId: caller,
  evidence: 'Invented SDK Merge caller',
  grants: [
    { entity: 'gadget', operations: ['read', 'update'] },
    { entity: 'part', operations: ['read', 'update'] },
  ],
};
const execute = (store) =>
  dispatchSdkCall({
    store,
    profile,
    message: {
      method: 'Execute',
      userId: caller,
      arguments: [
        {
          $type: 'OrganizationRequest',
          requestName: 'Merge',
          parameters: {
            $type: 'ParameterCollection',
            values: {
              Target: { $type: 'EntityReference', logicalName: 'gadget', id: master, name: null },
              SubordinateId: { $type: 'Guid', value: duplicate },
              UpdateContent: { $type: 'Entity', logicalName: 'gadget', id: master, attributes: { size: 'large' } },
              PerformParentingChecks: false,
            },
          },
        },
      ],
    },
  });

test('SDK Merge on a table with a Merge filter runs the Merge pipeline around the merge writes', () => {
  const store = storeOf(true);
  const seen = [];
  store.setPluginPipeline(
    (context) => {
      const main = store.pluginMainOperation?.context?.values;
      seen.push(
        `${context.customApi?.name ?? context.operation}/${context.stage}${main ? ' < ' + main.MessageName : ''}`,
      );
    },
    (context) => ['merge', 'update'].includes(context.operation),
  );
  execute(store);
  const row = (id) => store.tableRows('gadget').find((entry) => entry.gadgetid === id);
  assert.equal(row(master).color, 'red', 'the target takes the value it lacked');
  assert.equal(row(master).size, 'large', 'the target takes UpdateContent');
  assert.equal(row(master).title, 'Master', 'the target keeps its own values');
  assert.equal(row(duplicate).statecode, 1, 'the subordinate is deactivated');
  assert.equal(store.tableRows('part')[0].gadgetid.id, master, 'the child moves to the target');
  assert.deepEqual(
    seen.filter((entry) => entry.startsWith('Merge/')),
    ['Merge/10', 'Merge/20', 'Merge/40'],
  );
  assert.ok(
    seen.some((entry) => entry === 'update/20 < Merge'),
    'the main operation Updates run under Merge',
  );
});

test('SDK Merge availability follows the sdkmessagefilter rows, not a table list', () => {
  const store = storeOf(false);
  // The catalogue lists another message for the table, but no Merge filter.
  store.state.tables.sdkmessagefilter.push({
    sdkmessagefilterid: part,
    sdkmessageid: caller,
    primaryobjecttypecode: 'gadget',
  });
  assert.throws(
    () => execute(store),
    (error) => error.details?.innerCode === '0x80040800',
  );
  assert.equal(store.tableRows('gadget').find((entry) => entry.gadgetid === duplicate).statecode, 0);
});

// @test-kind compatibility: the SDK Merge shares the Web API Merge main operation recorded by native mergeAccount (native and native-r2): two subordinate Updates, {statecode 1} then {masterid, merged true}, with the internal Update/50 reads of the action cards and the subordinate between them; SDK Merge itself has no native capture yet (NATIVE sdk-soap-customapi-coverage)
test('SDK Merge writes the subordinate in two Updates with the internal stage-50 reads between them', () => {
  const store = storeOf(true, { masterid: { dataverseType: 'lookup' }, merged: { type: 'boolean' } });
  const seen = [];
  store.setPluginPipeline(
    (context) => {
      if (context.stage !== 40) return;
      const main = store.pluginMainOperation?.context?.values;
      const columns =
        context.operation === 'update' ? Object.keys(context.target).filter((name) => name !== 'modifiedon') : [];
      seen.push(`${context.operation} ${context.entity} [${columns.join(',')}] < ${main?.MessageName}/${main?.Stage}`);
    },
    () => true,
  );
  execute(store);
  assert.deepEqual(seen, [
    'update gadget [color,size] < Merge/30',
    'update gadget [statecode] < Merge/30',
    'retrievemultiple actioncard [] < Update/50',
    'retrieve gadget [] < Update/50',
    'update gadget [masterid,merged] < Merge/30',
    'update part [gadgetid] < Merge/30',
    'merge gadget [] < undefined/undefined',
  ]);
  const subordinate = store.tableRows('gadget').find((entry) => entry.gadgetid === duplicate);
  assert.equal(subordinate.merged, true);
  assert.equal(subordinate.masterid.id, master);
});
