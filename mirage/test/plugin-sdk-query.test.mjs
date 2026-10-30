import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { dispatchSdkCall, recordToSdkEntity, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const user = '10000000-0000-0000-0000-000000000001',
  rootId = '20000000-0000-0000-0000-000000000001',
  childId = '30000000-0000-0000-0000-000000000001',
  leafId = '40000000-0000-0000-0000-000000000001';
const profile = {
  userId: user,
  evidence: 'Invented linked-query backend',
  grants: ['root', 'child', 'leaf'].map((entity) => ({ entity, operations: ['read'] })),
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        root: { entitySet: 'roots', idColumn: 'rootid', fields: { title: { type: 'string' } } },
        child: {
          entitySet: 'children',
          idColumn: 'childid',
          fields: { rootid: { type: 'uniqueidentifier' }, amount: { type: 'money' } },
        },
        leaf: {
          entitySet: 'leaves',
          idColumn: 'leafid',
          fields: { childid: { type: 'uniqueidentifier' }, flag: { type: 'choice' } },
        },
      },
      tables: {
        root: [{ rootid: rootId, title: 'Parent' }],
        child: [{ childid: childId, rootid: rootId, amount: 12.5 }],
        leaf: [{ leafid: leafId, childid: childId, flag: 2 }],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const query = () => ({
  $type: 'QueryExpression',
  entityName: 'root',
  columnSet: { allColumns: false, columns: ['title'] },
  criteria: { operatorName: 'And', conditions: [] },
  linkEntities: [
    {
      $type: 'LinkEntity',
      linkFromEntityName: 'root',
      linkToEntityName: 'child',
      linkFromAttributeName: 'rootid',
      linkToAttributeName: 'rootid',
      entityAlias: 'joined',
      joinOperator: 'Inner',
      columns: { columns: ['amount'] },
      linkCriteria: {
        operatorName: 'And',
        conditions: [
          { attributeName: 'amount', operatorName: 'GreaterThan', values: [{ $type: 'Decimal', value: '10.0' }] },
        ],
      },
      linkEntities: [
        {
          $type: 'LinkEntity',
          linkFromEntityName: 'child',
          linkToEntityName: 'leaf',
          linkFromAttributeName: 'childid',
          linkToAttributeName: 'childid',
          entityAlias: 'nested',
          joinOperator: 'LeftOuter',
          columns: { columns: ['flag'] },
        },
      ],
    },
  ],
});
const run = (store, q, p = profile) =>
  dispatchSdkCall({ store, profile: p, message: { method: 'RetrieveMultiple', userId: user, arguments: [q] } });
test(
  'Original CLR QueryExpression count controls survive both SDK codec directions and provider metadata',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-sdk-count-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Count.cs'),
      assembly = path.join(root, 'Count.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented {
 public sealed class Caller:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.OperationCreatedOn.Ticks!=DateTime.Parse("2026-10-13T10:11:12.1234567Z",System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.RoundtripKind).Ticks)throw new Exception("Framework clock precision lost");var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);for(int i=0;i<3;i++){var q=new QueryExpression("sample"){ColumnSet=new ColumnSet("title"),PageInfo=new PagingInfo{Count=5,PageNumber=1}};if(i<2)q.PageInfo.ReturnTotalRecordCount=i==0;var a=s.RetrieveMultiple(q);if(a.Entities.Count!=5||!a.MoreRecords||a.TotalRecordCount!=(i==0?5000:-1)||a.TotalRecordCountLimitExceeded!=(i==0)||a.EntityName!="sample"||a.MinActiveRowVersion!="-1")throw new Exception("Count/provider codec mismatch "+i);}((Entity)c.InputParameters["Target"])["verified"]=true;}}
 public sealed class Observer:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var q=(QueryExpression)c.InputParameters["Query"];if(q.PageInfo.Count!=5||q.PageInfo.PageNumber!=1||q.ColumnSet.Columns.Count!=1||q.ColumnSet.Columns[0]!="title")throw new Exception("Query codec changed authored projection/page");if(c.Stage==40){var a=(EntityCollection)c.OutputParameters["BusinessEntityCollection"];if(a.TotalRecordCount!=(q.PageInfo.ReturnTotalRecordCount?5000:-1))throw new Exception("Incoming query count flag was lost");}}}
 }`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const serviceProfile = {
        userId: user,
        evidence: 'Invented real CLR count codec source',
        grants: [{ entity: 'sample', operations: ['read'] }],
      },
      descriptor = {
        trust: 'execute-local-assembly',
        root,
        assembly: 'Count.dll',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        serviceProfile,
        context: {
          initiatingUserId: user,
          organizationId: user,
          businessUnitId: user,
          operationCreatedOn: '2026-10-13T10:11:12.1234567Z',
          operationCreatedOnEvidence: 'Invented explicit framework timestamp fixture',
        },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      };
    const caller = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Caller' }),
      observer = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Observer' }),
      steps = [
        { id: rootId, entity: 'trigger', message: 'Create', stage: 20, typeName: 'Invented.Caller' },
        { id: childId, entity: 'sample', message: 'RetrieveMultiple', stage: 40, typeName: 'Invented.Observer' },
      ].map((step) => ({
        ...step,
        enabled: true,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        assemblyId: 'invented',
      })),
      runtimes = new Map([
        [rootId, caller],
        [childId, observer],
      ]),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      });
    const store = new DataStore({
      state: {
        mappings: {
          trigger: { idColumn: 'triggerid' },
          sample: { idColumn: 'sampleid', fields: { title: { type: 'string' } } },
        },
        tables: {
          trigger: [],
          sample: Array.from({ length: 5010 }, (_, index) => ({
            sampleid: `50000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
            title: 'Fixture',
          })),
        },
        permissions: [],
        plugins: [],
        settings: { permissionMode: 'permissive' },
      },
    });
    store.setPluginPipeline((event) => runPluginPhase({ ...event, store, items, runtimes }));
    const answer = await store.create('trigger', {}, { admin: true });
    assert.equal(answer.verified, true);
  },
);
test('Unlinked SDK QueryExpression and QueryByAttribute reach observers without reconstruction or extra identity columns', () => {
  for (const source of [
    {
      $type: 'QueryExpression',
      entityName: 'root',
      columnSet: { allColumns: false, columns: ['title'] },
      criteria: {
        operatorName: 'And',
        conditions: [{ attributeName: 'rootid', operatorName: 'Equal', values: [{ $type: 'Guid', value: rootId }] }],
      },
    },
    {
      $type: 'QueryByAttribute',
      entityName: 'root',
      columnSet: { allColumns: false, columns: ['title'] },
      attributes: ['rootid'],
      values: [{ $type: 'Guid', value: rootId }],
    },
  ]) {
    const store = data(),
      seen = [];
    store.setPluginPipeline(
      (c) => seen.push(structuredClone(c.query)),
      (c) => c.operation === 'retrievemultiple',
    );
    const result = run(store, source);
    assert.deepEqual(seen, [source, source, source]);
    assert.equal(result.entities[0].id, rootId);
    assert.deepEqual(result.entities[0].attributes, { title: 'Parent' });
  }
});
test('Nested SDK QueryExpression joins retain identity, projected columns and typed AliasedValue results', () => {
  const store = data(),
    q = query(),
    before = structuredClone(q),
    answer = run(store, q),
    entity = answer.entities[0];
  assert.deepEqual(q, before);
  assert.equal(entity.id, rootId);
  assert.deepEqual(entity.attributes.title, 'Parent');
  assert.ok(!Object.hasOwn(entity.attributes, 'rootid'));
  assert.deepEqual(entity.attributes['joined.amount'], {
    $type: 'AliasedValue',
    entityLogicalName: 'child',
    attributeLogicalName: 'amount',
    value: { $type: 'Money', value: '12.5' },
  });
  assert.deepEqual(entity.attributes['nested.flag'], {
    $type: 'AliasedValue',
    entityLogicalName: 'leaf',
    attributeLogicalName: 'flag',
    value: { $type: 'OptionSetValue', value: 2 },
  });
});
test('Original FetchExpression aliases and aggregate aliases use typed SDK projection, with hidden primary identity', () => {
  const store = data(),
    fetch = {
      $type: 'FetchExpression',
      query:
        '<fetch><entity name="root"><attribute name="title" alias="label"/><link-entity name="child" from="rootid" to="rootid" alias="c"><attribute name="amount"/></link-entity></entity></fetch>',
    },
    answer = run(store, fetch);
  assert.equal(answer.entities[0].id, rootId);
  assert.deepEqual(answer.entities[0].attributes.label, {
    $type: 'AliasedValue',
    entityLogicalName: 'root',
    attributeLogicalName: 'title',
    value: 'Parent',
  });
  assert.ok(!Object.hasOwn(answer.entities[0].attributes, 'rootid'));
  const aggregate = run(store, {
    $type: 'FetchExpression',
    query:
      '<fetch aggregate="true"><entity name="child"><attribute name="amount" alias="total" aggregate="sum"/></entity></fetch>',
  });
  assert.equal(aggregate.entities[0].id, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(aggregate.entities[0].attributes.total, {
    $type: 'AliasedValue',
    entityLogicalName: 'child',
    attributeLogicalName: 'amount',
    value: { $type: 'Money', value: '12.5' },
  });
});
test('SDK linked table grants and predicates filter original root and child rows before projection', () => {
  const store = data(),
    q = query();
  assert.throws(
    () => run(store, q, { ...profile, grants: profile.grants.filter((g) => g.entity !== 'leaf') }),
    /denied read on leaf/,
  );
  const restricted = {
    ...profile,
    grants: profile.grants.map((g) => (g.entity === 'child' ? { ...g, predicate: (row) => row.amount < 10 } : g)),
  };
  assert.deepEqual(run(store, q, restricted).entities, []);
  q.linkEntities[0].joinOperator = 'LeftOuter';
  const outer = run(store, q, restricted).entities[0];
  assert.equal(outer.id, rootId);
  assert.ok(!Object.hasOwn(outer.attributes, 'joined.amount'));
});
test('SDK aggregate counts have Int32 values independently of GUID, money or option source types', () => {
  const store = data();
  for (const [entity, column, aggregate] of [
    ['root', 'rootid', 'count'],
    ['child', 'amount', 'countcolumn'],
    ['leaf', 'flag', 'countcolumn'],
  ]) {
    const result = run(store, {
      $type: 'FetchExpression',
      query: `<fetch aggregate="true"><entity name="${entity}"><attribute name="${column}" alias="records" aggregate="${aggregate}"/></entity></fetch>`,
    });
    assert.equal(result.entities[0].id, '00000000-0000-0000-0000-000000000000');
    assert.deepEqual(result.entities[0].attributes.records, {
      $type: 'AliasedValue',
      entityLogicalName: entity,
      attributeLogicalName: column,
      value: 1,
    });
    assert.deepEqual(result.entities[0].formattedValues, { records: '1' });
  }
});

test('SDK Fetch collection preserves the count-limit flag when matching rows exceed 5000', () => {
  const store = data();
  store.state.tables.root = Array.from({ length: 5010 }, (_, index) => ({
    rootid: `20000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    title: 'Count-limit fixture',
  }));
  const answer = run(store, {
    $type: 'FetchExpression',
    query:
      '<fetch count="5" page="1" returntotalrecordcount="true"><entity name="root"><attribute name="rootid"/><order attribute="rootid"/></entity></fetch>',
  });
  assert.equal(answer.entities.length, 5);
  assert.equal(answer.moreRecords, true);
  assert.equal(answer.totalRecordCount, 5000);
  assert.equal(answer.totalRecordCountLimitExceeded, true);
  const uncounted = run(store, {
    $type: 'FetchExpression',
    query:
      '<fetch count="5" page="1" returntotalrecordcount="false"><entity name="root"><attribute name="rootid"/></entity></fetch>',
  });
  assert.equal(uncounted.totalRecordCount, -1);
  assert.notEqual(uncounted.totalRecordCountLimitExceeded, true);
  const implicit = run(store, {
    $type: 'FetchExpression',
    query: '<fetch count="5" page="1"><entity name="root"><attribute name="rootid"/></entity></fetch>',
  });
  assert.equal(implicit.totalRecordCount, -1);
  assert.notEqual(implicit.totalRecordCountLimitExceeded, true);
});
test('SDK QueryExpression preserves caller count controls and provider metadata without portal defaults', () => {
  const store = data();
  store.state.tables.root = Array.from({ length: 5010 }, (_, index) => ({
    rootid: `20000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    title: 'Count fixture',
  }));
  for (const counted of [true, false, undefined]) {
    const source = {
      $type: 'QueryExpression',
      entityName: 'root',
      columnSet: { columns: ['title'] },
      criteria: { conditions: [] },
      pageInfo: { count: 5, pageNumber: 1, ...(counted === undefined ? {} : { returnTotalRecordCount: counted }) },
    };
    const seen = [];
    store.setPluginPipeline(
      (event) => seen.push(structuredClone(event.query)),
      (event) => event.operation === 'retrievemultiple',
    );
    const answer = run(store, source);
    assert.equal(answer.entities.length, 5);
    assert.equal(answer.moreRecords, true);
    assert.equal(answer.entityName, 'root');
    assert.equal(answer.minActiveRowVersion, '-1');
    assert.equal(answer.totalRecordCount, counted === true ? 5000 : -1);
    assert.equal(answer.totalRecordCountLimitExceeded === true, counted === true);
    assert.deepEqual(seen, [source, source, source]);
  }
  assert.throws(
    () =>
      run(store, {
        $type: 'QueryExpression',
        entityName: 'root',
        topCount: 1,
        pageInfo: { returnTotalRecordCount: true },
      }),
    /TopCount cannot be combined/,
  );
  assert.throws(
    () =>
      run(store, {
        $type: 'FetchExpression',
        query: '<fetch min-active-row-version="true"><entity name="root"><attribute name="rootid"/></entity></fetch>',
      }),
    (error) => error.code === 'LocalPluginQueryUnsupported' && /source-qualified/.test(error.message),
  );
  const unpaged = run(store, {
    $type: 'QueryExpression',
    entityName: 'child',
    columnSet: { columns: ['amount'] },
    criteria: { conditions: [] },
  });
  assert.equal(unpaged.entityName, 'child');
  assert.equal(unpaged.minActiveRowVersion, '-1');
  assert.equal(unpaged.totalRecordCount, -1);
  assert.throws(
    () =>
      run(store, {
        $type: 'QueryByAttribute',
        entityName: 'root',
        attributes: [],
        values: [],
        pageInfo: { returnTotalRecordCount: true },
      }),
    (error) => error.code === 'LocalPluginSdkUnsupported' && /total counts/.test(error.message),
  );
});
test('SDK grouped lookup names and choice labels come from declared metadata and source rows', () => {
  const store = data();
  store.state.mappings.root.nameColumn = 'title';
  store.state.mappings.child.fields.rootid = { type: 'lookup', targets: ['root'] };
  store.state.mappings.leaf.fields.flag.options = [{ value: 2, label: 'Ready' }];
  const result = run(store, {
    $type: 'FetchExpression',
    query:
      '<fetch aggregate="true"><entity name="child"><attribute name="rootid" alias="group" groupby="true"/><attribute name="childid" alias="records" aggregate="count"/></entity></fetch>',
  }).entities[0];
  assert.deepEqual(result.attributes.group, {
    $type: 'AliasedValue',
    entityLogicalName: 'child',
    attributeLogicalName: 'rootid',
    value: { $type: 'EntityReference', logicalName: 'root', id: rootId, name: 'Parent' },
  });
  assert.deepEqual(result.attributes.group_rootidname, {
    $type: 'AliasedValue',
    entityLogicalName: 'child',
    attributeLogicalName: 'rootidname',
    value: 'Parent',
  });
  assert.deepEqual(result.formattedValues, { group: 'Parent', records: '1' });
  const choices = run(store, {
    $type: 'FetchExpression',
    query:
      '<fetch aggregate="true"><entity name="leaf"><attribute name="flag" alias="kind" groupby="true"/><attribute name="leafid" alias="records" aggregate="count"/></entity></fetch>',
  }).entities[0];
  assert.deepEqual(choices.formattedValues, { kind: 'Ready', records: '1' });
  delete store.state.mappings.root.nameColumn;
  const withoutName = run(store, {
    $type: 'FetchExpression',
    query:
      '<fetch aggregate="true"><entity name="child"><attribute name="rootid" alias="group" groupby="true"/><attribute name="childid" alias="records" aggregate="count"/></entity></fetch>',
  }).entities[0];
  assert.equal(withoutName.attributes.group.value.name, null);
  assert.ok(!Object.hasOwn(withoutName.attributes, 'group_rootidname'));
});
test('SDK reference transport retains source-provided identities when the target table is unavailable locally', () => {
  const result = recordToSdkEntity(data(), 'root', {
    rootid: rootId,
    creator: { id: user, logical_name: 'systemuser' },
  });
  assert.deepEqual(result.attributes.creator, {
    $type: 'EntityReference',
    logicalName: 'systemuser',
    id: user,
    name: null,
  });
  assert.equal(result.formattedValues, undefined);
});
test('Original linked QueryBase reaches source observers and collection metadata changes survive', () => {
  const store = data(),
    seen = [];
  store.setPluginPipeline(
    (context) => {
      seen.push(structuredClone(context.query));
      if (context.stage === 40) {
        assert.equal(context.collection.entities[0].attributes['joined.amount'].$type, 'AliasedValue');
        context.collection.moreRecords = true;
        context.collection.pagingCookie = '<cookie page="2"/>';
        context.collection.totalRecordCount = 9;
      }
    },
    ({ operation }) => operation === 'retrievemultiple',
  );
  const q = query(),
    answer = run(store, q);
  assert.deepEqual(seen, [q, q, q]);
  assert.equal(answer.entities[0].id, rootId);
  assert.equal(answer.moreRecords, true);
  assert.equal(answer.totalRecordCount, 9);
  assert.equal(answer.pagingCookie, '<cookie page="2"/>');
});

test('Full-text SDK Contains cannot be silently executed as substring LIKE', () => {
  const store = data(),
    q = query();
  for (const operatorName of ['Contains', 'DoesNotContain']) {
    q.linkEntities[0].linkCriteria.conditions = [{ attributeName: 'amount', operatorName, values: ['12'] }];
    assert.throws(
      () => run(store, q),
      (error) =>
        error.code === 'LocalPluginQueryUnsupported' && error.status === 501 && /full-text/.test(error.message),
    );
  }
  q.linkEntities[0].linkCriteria.conditions = [{ attributeName: 'amount', operatorName: 'GreaterThan', values: [10] }];
  q.criteria = { conditions: [{ attributeName: 'title', operatorName: 'Like', values: ['%aren%'] }] };
  assert.equal(run(store, q).entities.length, 1);
});

test('FetchExpression observer binding uses the structural root while preserving authored and changed query text', () => {
  const store = data(),
    readOnlyBefore = store.pluginReadOnly,
    seen = [],
    original =
      '<fetch><!-- source documentation: <entity name="child"/> --><entity\n name = "root"><attribute name="title"/></entity></fetch>';
  store.setPluginPipeline(
    (context) => {
      seen.push({ stage: context.stage, entity: context.entity, query: structuredClone(context.query) });
    },
    ({ operation }) => operation === 'retrievemultiple',
  );
  assert.equal(store.fetchXml(original, { admin: true }).entities[0].title, 'Parent');
  assert.deepEqual(
    seen.map((x) => x.entity),
    ['root', 'root', 'root'],
  );
  assert.deepEqual(
    seen.map((x) => x.query),
    [
      { $type: 'FetchExpression', query: original },
      { $type: 'FetchExpression', query: original },
      { $type: 'FetchExpression', query: original },
    ],
  );
  seen.length = 0;
  const changed =
    '<fetch><entity name="root"><attribute name="title"/><filter><condition attribute="title" operator="eq" value="Parent"/></filter></entity></fetch>';
  store.setPluginPipeline(
    (context) => {
      if (context.stage === 20) context.query.query = changed;
      seen.push({ stage: context.stage, query: structuredClone(context.query) });
      if (context.stage === 40) context.collection.entities[0].attributes.title = 'Post observer';
    },
    ({ operation }) => operation === 'retrievemultiple',
  );
  const result = store.fetchXml(original, { admin: true });
  assert.equal(result.entities[0].title, 'Post observer');
  assert.deepEqual(
    seen.map((x) => x.query),
    [
      { $type: 'FetchExpression', query: original },
      { $type: 'FetchExpression', query: changed },
      { $type: 'FetchExpression', query: changed },
    ],
  );
  assert.equal(store.snapshot().tables.root[0].title, 'Parent');
  assert.equal(store.pluginReadOnly, readOnlyBefore);
});

test('FetchExpression structural binding rejects malformed original or changed XML and a changed root table', () => {
  const store = data(),
    readOnlyBefore = store.pluginReadOnly,
    seen = [],
    valid = '<fetch><entity name="root"><attribute name="title"/></entity></fetch>',
    malformed = '<fetch><entity name="root"></fetch>';
  store.setPluginPipeline(
    (context) => seen.push(context.stage),
    ({ operation }) => operation === 'retrievemultiple',
  );
  assert.throws(
    () => store.fetchXml(malformed, { admin: true }),
    (error) => error.code === 'InvalidRequest',
  );
  assert.deepEqual(seen, []);
  for (const [source, code] of [
    [malformed, 'InvalidRequest'],
    ['<fetch><entity name="child"/></fetch>', 'LocalPluginQueryUnsupported'],
  ]) {
    seen.length = 0;
    store.setPluginPipeline(
      (context) => {
        seen.push(context.stage);
        if (context.stage === 20) context.query.query = source;
      },
      ({ operation }) => operation === 'retrievemultiple',
    );
    assert.throws(
      () => store.fetchXml(valid, { admin: true }),
      (error) => error.code === code,
    );
    assert.deepEqual(seen, [10, 20]);
    assert.equal(store.pluginReadOnly, readOnlyBefore);
    assert.equal(store.snapshot().tables.root[0].title, 'Parent');
  }
});
