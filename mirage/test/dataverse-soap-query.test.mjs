// QueryExpression, QueryByAttribute and BulkDelete QuerySet to FetchXML. The output
// is run through DataStore.fetchXml as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { DataError } from '../lib/data-error.mjs';
import { fromBulkDeleteJson, fromQueryByAttribute, toFetchXml, toSdkQuery } from '../lib/dataverse-soap-query.mjs';
import { modelOf } from '../lib/dataverse-misc-messages.mjs';

const text = { dataverseType: 'nvarchar' };

test('SOAP query adapters retain collection predicates, filter hints, alias orders and typed values', () => {
  const model = {
    entityName: 'widget',
    columnSet: { allColumns: true },
    orders: [{ entityName: 'g', attributeName: 'name', orderType: 1 }],
    criteria: {
      filterOperator: 'Or',
      filterHint: 'union',
      isQuickFindFilter: true,
      conditions: [
        {
          attributeName: 'widgetid',
          operator: 0,
          values: [{ type: 'guid', value: '00000000-0000-0000-0000-000000000001' }],
        },
      ],
      anyAllFilterLinkEntity: {
        linkFromEntityName: 'widget',
        linkFromAttributeName: 'widgetid',
        linkToEntityName: 'gadget',
        linkToAttributeName: 'widgetid',
        joinOperator: 7,
        linkCriteria: {
          conditions: [{ attributeName: 'name', operator: 'Equal', values: [{ type: 'string', value: 'x' }] }],
        },
      },
    },
  };
  const xml = toFetchXml(model);
  assert.match(xml, /<filter type="or" hint="union" isquickfindfields="true">/);
  assert.match(xml, /link-type="not any"/);
  assert.match(xml, /<order attribute="name" entityname="g" descending="true"/);
  const sdk = toSdkQuery(model);
  assert.equal(sdk.criteria.operatorName, 'Or');
  assert.equal(sdk.criteria.conditions[0].operatorName, 'Equal');
  assert.equal(sdk.criteria.conditions[0].values[0].$type, 'Guid');
  assert.equal(sdk.criteria.anyAllFilterLinkEntity.joinOperator, 'NotAny');
  assert.equal(sdk.criteria.anyAllFilterLinkEntity.linkCriteria.conditions[0].values[0], 'x');
  assert.equal(sdk.orders[0].entityName, 'g');
});

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    fields: { name: text, code: text, price: { dataverseType: 'money' }, status: { dataverseType: 'int' } },
  };
  state.mappings.gadget = {
    logicalName: 'gadget',
    entitySet: 'gadgets',
    idColumn: 'gadgetid',
    nameColumn: 'name',
    fields: { name: text, widgetid: { dataverseType: 'lookup' } },
  };
  state.tables.widget = [
    { widgetid: 'w-1', name: 'Redmond', code: 'R-1', price: 10, status: 1 },
    { widgetid: 'w-2', name: 'Seattle', code: 'S-1', price: 3, status: 2 },
    { widgetid: 'w-3', name: 'Old Bellevue', code: 'B-1', price: 7, status: 1 },
    { widgetid: 'w-4', name: 'Redmond East', code: 'R-2', price: 20, status: null },
  ];
  state.tables.gadget = [
    { gadgetid: 'g-1', name: 'G-red', widgetid: 'w-1' },
    { gadgetid: 'g-2', name: 'G-seattle', widgetid: 'w-2' },
  ];
  return state;
}

const condition = (operator, values = [], attributeName = 'name') => ({ attributeName, operator, values });
const where = (...conditions) => ({ entityName: 'widget', criteria: { filterOperator: 'And', conditions } });
const conditionXml = (operator, values = [], attributeName = 'name') =>
  toFetchXml(where(condition(operator, values, attributeName)));

test('numeric ConditionOperator values resolve to the documented FetchXML operators', () => {
  const expected = [
    [0, 'eq'],
    [8, 'in'],
    [25, 'on'],
    [33, 'last-x-days'],
    [41, 'eq-userid'],
    [75, 'under'],
    [87, 'contain-values'],
  ];
  for (const [value, op] of expected) assert.match(conditionXml(value, ['x']), new RegExp(`operator="${op}"`));
  assert.throws(
    () => conditionXml(49, ['x']),
    (error) => error.code === 'LocalPluginQueryUnsupported',
  );
  assert.match(conditionXml('EqualUserId'), /operator="eq-userid"\/>/);
  assert.match(conditionXml('LastXDays', ['3']), /operator="last-x-days" value="3"\/>/);
});

test('operators without a FetchXML equivalent fail with the invalid-operator inner code', () => {
  for (const operator of [45, 46, 47, 48, 52, 89, 'Bogus']) {
    assert.throws(
      () => conditionXml(operator, ['x']),
      (error) => {
        assert.ok(error instanceof DataError);
        assert.equal(error.status, 400);
        assert.equal(error.details.innerCode, '0x80040203');
        return true;
      },
    );
  }
});

test('single values use the value attribute, lists and pairs use value elements, no-value operators have none', () => {
  assert.equal(
    conditionXml('Equal', ['Redmond']),
    '<fetch><entity name="widget"><filter type="and"><condition attribute="name" operator="eq" value="Redmond"/></filter></entity></fetch>',
  );
  assert.match(
    conditionXml('In', ['a', 'b']),
    /<condition attribute="name" operator="in"><value>a<\/value><value>b<\/value><\/condition>/,
  );
  assert.match(conditionXml('Between', [6, 20]), /operator="between"><value>6<\/value><value>20<\/value>/);
  assert.match(conditionXml('Null'), /<condition attribute="name" operator="null"\/>/);
  assert.match(conditionXml('Today'), /<condition attribute="name" operator="today"\/>/);
  assert.match(conditionXml('EqualUserId', [], 'ownerid'), /<condition attribute="ownerid" operator="eq-userid"\/>/);
  assert.match(
    toFetchXml(where({ attributeName: 'price', operator: 'GreaterThan', compareColumns: true, values: ['status'] })),
    /<condition attribute="price" operator="gt" valueof="status"\/>/,
  );
});

test('text operators retain semantics and unsupported full-text conditions fail explicitly', () => {
  assert.match(conditionXml('BeginsWith', ['Old']), /operator="begins-with" value="Old"/);
  assert.match(conditionXml('DoesNotEndWith', ['ing']), /operator="not-end-with" value="ing"/);
  assert.match(conditionXml('Like', ['R%']), /operator="like" value="R%"/);
  assert.throws(
    () => conditionXml('Contains', ['a%_[b']),
    (error) => error.code === 'LocalPluginQueryUnsupported',
  );
  assert.throws(
    () => conditionXml('DoesNotContain', ['x']),
    (error) => error.code === 'LocalPluginQueryUnsupported',
  );
});

test('nested filters keep their And/Or types and order', () => {
  const xml = toFetchXml({
    entityName: 'widget',
    criteria: {
      filterOperator: 'And',
      conditions: [condition('Equal', ['Redmond'])],
      filters: [
        {
          filterOperator: 1,
          conditions: [condition('GreaterThan', [5], 'price'), condition('Null', [], 'status')],
          filters: [],
        },
      ],
    },
  });
  assert.equal(
    xml,
    '<fetch><entity name="widget"><filter type="and"><condition attribute="name" operator="eq" value="Redmond"/><filter type="or"><condition attribute="price" operator="gt" value="5"/><condition attribute="status" operator="null"/></filter></filter></entity></fetch>',
  );
});

test('link entities map names, aliases, nested link criteria and every JoinOperator', () => {
  const xml = toFetchXml({
    entityName: 'widget',
    columnSet: { allColumns: false, columns: ['name'] },
    linkEntities: [
      {
        linkFromEntityName: 'widget',
        linkFromAttributeName: 'widgetid',
        linkToEntityName: 'gadget',
        linkToAttributeName: 'widgetid',
        joinOperator: 'LeftOuter',
        entityAlias: 'g',
        columns: { allColumns: false, columns: ['name'] },
        linkCriteria: {
          filterOperator: 'And',
          conditions: [{ entityName: 'g', attributeName: 'name', operator: 'Like', values: ['G%'] }],
          filters: [],
        },
        linkEntities: [],
      },
    ],
  });
  assert.equal(
    xml,
    '<fetch><entity name="widget"><attribute name="name"/><link-entity name="gadget" from="widgetid" to="widgetid" link-type="outer" alias="g"><attribute name="name"/><filter type="and"><condition entityname="g" attribute="name" operator="like" value="G%"/></filter></link-entity></entity></fetch>',
  );

  const linkType = (joinOperator) =>
    toFetchXml({
      entityName: 'widget',
      linkEntities: [
        {
          linkToEntityName: 'gadget',
          linkToAttributeName: 'widgetid',
          linkFromAttributeName: 'widgetid',
          joinOperator,
        },
      ],
    });
  const expected = [
    ['Inner', 'inner'],
    ['Any', 'any'],
    ['NotAny', 'not any'],
    ['All', 'all'],
    ['NotAll', 'not all'],
    ['Exists', 'exists'],
    ['In', 'in'],
    ['MatchFirstRowUsingCrossApply', 'matchfirstrowusingcrossapply'],
  ];
  for (const [name, linkTypeValue] of expected)
    assert.match(linkType(name), new RegExp(`link-type="${linkTypeValue}"`));
  assert.match(linkType(6), /link-type="any"/);
  assert.match(linkType(undefined), /link-type="inner"/);
  assert.throws(
    () => linkType('Sideways'),
    (error) => error.details.innerCode === '0x80040203',
  );
});

test('paging, top, distinct, no-lock and order attributes escape the paging cookie', () => {
  const cookie = '<cookie page="3"><name last="a&b"/></cookie>';
  assert.equal(
    toFetchXml({
      entityName: 'widget',
      distinct: true,
      noLock: true,
      orders: [{ attributeName: 'name', orderType: 'Descending' }],
      pageInfo: { count: 2, pageNumber: 3, pagingCookie: cookie, returnTotalRecordCount: true },
    }),
    '<fetch distinct="true" no-lock="true" page="3" count="2" paging-cookie="&lt;cookie page=&quot;3&quot;&gt;&lt;name last=&quot;a&amp;b&quot;/&gt;&lt;/cookie&gt;" returntotalrecordcount="true"><entity name="widget"><order attribute="name" descending="true"/></entity></fetch>',
  );
  assert.equal(
    toFetchXml({ entityName: 'widget', topCount: 5, columnSet: { allColumns: true } }),
    '<fetch top="5"><entity name="widget"><all-attributes/></entity></fetch>',
  );
});

test('QueryByAttribute becomes Equal conditions joined with And', () => {
  const model = fromQueryByAttribute({
    entityName: 'widget',
    attributes: ['name', 'status'],
    values: ['Redmond', 2],
    columnSet: { allColumns: true },
  });
  assert.equal(
    toFetchXml(model),
    '<fetch><entity name="widget"><all-attributes/><filter type="and"><condition attribute="name" operator="eq" value="Redmond"/><condition attribute="status" operator="eq" value="2"/></filter></entity></fetch>',
  );
  assert.throws(
    () => fromQueryByAttribute({ entityName: 'widget', attributes: ['name'], values: [] }),
    (error) => error.status === 400,
  );
});

test('BulkDelete JSON QuerySet maps conditions, values and nested filters', () => {
  const model = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: {
      FilterOperator: 'And',
      Conditions: [{ AttributeName: 'status', Operator: 'Equal', Values: [{ Type: 'System.Int32', Value: 2 }] }],
      Filters: [
        {
          FilterOperator: 'Or',
          Conditions: [
            { AttributeName: 'name', Operator: 'BeginsWith', Values: [{ Type: 'System.String', Value: 'Old' }] },
          ],
          Filters: [],
        },
      ],
    },
  });
  assert.equal(
    toFetchXml(model),
    '<fetch><entity name="widget"><filter type="and"><condition attribute="status" operator="eq" value="2"/><filter type="or"><condition attribute="name" operator="begins-with" value="Old"/></filter></filter></entity></fetch>',
  );
});

test('generated FetchXML runs through DataStore.fetchXml', async () => {
  const store = await new DataStore({ state: fixtureState() }).init();
  const admin = { admin: true };
  const names = (result) => result.entities.map((row) => row.name).sort();

  const filtered = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: {
      FilterOperator: 'And',
      Conditions: [{ AttributeName: 'status', Operator: 'Equal', Values: [{ Value: 1 }] }],
      Filters: [],
    },
  });
  assert.deepEqual(names(store.fetchXml(toFetchXml(filtered), admin)), ['Old Bellevue', 'Redmond']);

  const contains = where(condition('Contains', ['Redmond']));
  assert.throws(
    () => store.fetchXml(toFetchXml(contains), admin),
    (error) => error.code === 'LocalPluginQueryUnsupported',
  );

  const linked = toFetchXml({
    entityName: 'widget',
    columnSet: { allColumns: false, columns: ['name'] },
    linkEntities: [
      {
        linkToEntityName: 'gadget',
        linkToAttributeName: 'widgetid',
        linkFromAttributeName: 'widgetid',
        joinOperator: 'Inner',
        entityAlias: 'g',
        columns: { allColumns: false, columns: ['name'] },
      },
    ],
  });
  assert.deepEqual(names(store.fetchXml(linked, admin)), ['Redmond', 'Seattle']);

  const page = store.fetchXml(
    toFetchXml({
      entityName: 'widget',
      columnSet: { allColumns: true },
      orders: [{ attributeName: 'name', orderType: 'Ascending' }],
      pageInfo: { count: 2, pageNumber: 1, returnTotalRecordCount: true },
    }),
    admin,
  );
  assert.equal(page.entities.length, 2);
  assert.equal(page.total_record_count, 4);
  assert.equal(page.more_records, true);
});

test('BulkDelete LinkEntities restrict the delete to rows that link to a matching record', async () => {
  const store = await new DataStore({ state: fixtureState() }).init();
  const model = fromBulkDeleteJson({
    EntityName: 'widget',
    LinkEntities: [
      {
        LinkFromEntityName: 'widget',
        LinkFromAttributeName: 'widgetid',
        LinkToEntityName: 'gadget',
        LinkToAttributeName: 'widgetid',
        JoinOperator: 'Inner',
        LinkCriteria: {
          FilterOperator: 'And',
          Conditions: [{ AttributeName: 'name', Operator: 'Equal', Values: [{ Value: 'G-red' }] }],
        },
      },
    ],
  });
  assert.equal(
    toFetchXml(model),
    '<fetch><entity name="widget"><link-entity name="gadget" from="widgetid" to="widgetid" link-type="inner"><filter type="and"><condition attribute="name" operator="eq" value="G-red"/></filter></link-entity></entity></fetch>',
  );
  assert.deepEqual(
    store.fetchXml(toFetchXml(model), { admin: true }).entities.map((row) => row.name),
    ['Redmond'],
  );
});

test('BulkDelete TopCount limits the delete and PageInfo with TopCount is refused', async () => {
  const store = await new DataStore({ state: fixtureState() }).init();
  const limited = fromBulkDeleteJson({ EntityName: 'widget', TopCount: 2, Criteria: {} });
  assert.match(toFetchXml(limited), /<fetch top="2">/);
  assert.equal(store.fetchXml(toFetchXml(limited), { admin: true }).entities.length, 2);
  const paged = fromBulkDeleteJson({ EntityName: 'widget', TopCount: 2, PageInfo: { Count: 2, PageNumber: 1 } });
  assert.throws(
    () => toFetchXml(paged),
    (error) => error instanceof DataError && error.status === 400,
  );
});

test('BulkDelete QuerySet keys outside the supported set are refused, not dropped', () => {
  assert.throws(
    () => fromBulkDeleteJson({ EntityName: 'widget', Criteria: {}, Surprise: 1 }),
    (error) => error instanceof DataError && error.status === 400,
  );
});

test('DataSource renders the datasource attribute', () => {
  assert.equal(
    toFetchXml(fromBulkDeleteJson({ EntityName: 'widget', DataSource: 'default' })),
    '<fetch datasource="default"><entity name="widget"></entity></fetch>',
  );
  assert.equal(
    toFetchXml(fromBulkDeleteJson({ EntityName: 'widget', DataSource: 'bin' })),
    '<fetch datasource="bin"><entity name="widget"></entity></fetch>',
  );
  assert.equal(
    toFetchXml(
      fromQueryByAttribute({
        entityName: 'widget',
        attributes: ['name'],
        values: ['x'],
        columnSet: { allColumns: true },
        dataSource: 'retained',
      }),
    ),
    '<fetch datasource="retained"><entity name="widget"><all-attributes/><filter type="and"><condition attribute="name" operator="eq" value="x"/></filter></entity></fetch>',
  );
});

test('a native {Type, Value} and a plain scalar in Values render the same condition', () => {
  const typed = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: {
      Conditions: [{ AttributeName: 'status', Operator: 'Equal', Values: [{ Type: 'System.Int32', Value: 2 }] }],
    },
  });
  const plain = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: { Conditions: [{ AttributeName: 'status', Operator: 'Equal', Values: [2] }] },
  });
  assert.equal(toFetchXml(typed), toFetchXml(plain));
  assert.equal(
    toFetchXml(typed),
    '<fetch><entity name="widget"><filter type="and"><condition attribute="status" operator="eq" value="2"/></filter></entity></fetch>',
  );
  const inList = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: {
      Conditions: [{ AttributeName: 'name', Operator: 'In', Values: [{ Type: 'System.String', Value: 'a' }, 'b'] }],
    },
  });
  assert.equal(
    toFetchXml(inList),
    '<fetch><entity name="widget"><filter type="and"><condition attribute="name" operator="in"><value>a</value><value>b</value></condition></filter></entity></fetch>',
  );
});

test('CompareColumns in a BulkDelete condition renders valueof and matches the column pair', async () => {
  const model = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: {
      Conditions: [
        {
          AttributeName: 'price',
          Operator: 'GreaterThan',
          CompareColumns: true,
          Values: [{ Type: 'System.String', Value: 'status' }],
        },
      ],
    },
  });
  assert.equal(
    toFetchXml(model),
    '<fetch><entity name="widget"><filter type="and"><condition attribute="price" operator="gt" valueof="status"/></filter></entity></fetch>',
  );
  const store = await new DataStore({ state: fixtureState() }).init();
  // price > status: Redmond (10 > 1), Old Bellevue (7 > 1) and Seattle (3 > 2) match; Redmond East has a null status and does not.
  assert.deepEqual(
    store
      .fetchXml(toFetchXml(model), { admin: true })
      .entities.map((row) => row.name)
      .sort(),
    ['Old Bellevue', 'Redmond', 'Seattle'],
  );
});

test('BulkDelete retains QueryHints but refuses configured internal SDK-only facets', async () => {
  const store = await new DataStore({ state: fixtureState() }).init();
  const model = fromBulkDeleteJson({ EntityName: 'widget', QueryHints: 'FAST', ForceSeek: '', Criteria: {} });
  for (const ForceSeek of [true, 'configured', 'false'])
    assert.throws(() => fromBulkDeleteJson({ EntityName: 'widget', ForceSeek }), {
      code: 'LocalPluginQueryUnsupported',
    });
  assert.equal(toFetchXml(model), '<fetch options="FAST"><entity name="widget"></entity></fetch>');
  assert.equal(store.fetchXml(toFetchXml(model), { admin: true }).entities.length, 4);
});

test('AnyAllFilterLinkEntity is refused, not dropped; FilterHint and IsQuickFindFilter are accepted', () => {
  const refused = (criteria) =>
    assert.throws(
      () => fromBulkDeleteJson({ EntityName: 'widget', Criteria: criteria }),
      (error) => error instanceof DataError && error.status === 400 && error.details.innerCode === '0x80040203',
    );
  refused({ AnyAllFilterLinkEntity: { EntityName: 'gadget' }, Conditions: [] });
  refused({ Filters: [{ AnyAllFilterLinkEntity: {}, Conditions: [] }] });
  assert.throws(
    () =>
      fromBulkDeleteJson({
        EntityName: 'widget',
        LinkEntities: [{ LinkToEntityName: 'gadget', LinkCriteria: { AnyAllFilterLinkEntity: {} } }],
      }),
    (error) => error instanceof DataError && error.status === 400,
  );
  assert.equal(
    toFetchXml(
      fromBulkDeleteJson({
        EntityName: 'widget',
        Criteria: { FilterHint: 'x', IsQuickFindFilter: false, AnyAllFilterLinkEntity: null, Conditions: [] },
      }),
    ),
    '<fetch><entity name="widget"></entity></fetch>',
  );
});

test('the QueryExpression JSON modelOf keeps a {Type, Value} condition value', () => {
  const json = {
    EntityName: 'widget',
    Criteria: {
      FilterOperator: 'And',
      Conditions: [{ AttributeName: 'status', Operator: 'Equal', Values: [{ Type: 'System.Int32', Value: 2 }] }],
      Filters: [],
    },
  };
  assert.equal(
    toFetchXml(modelOf(json)),
    '<fetch><entity name="widget"><filter type="and"><condition attribute="status" operator="eq" value="2"/></filter></entity></fetch>',
  );
});

test('BulkDelete condition EntityName is kept on the FetchXML condition', () => {
  const model = fromBulkDeleteJson({
    EntityName: 'widget',
    Criteria: {
      Conditions: [{ EntityName: 'gadget', AttributeName: 'name', Operator: 'Equal', Values: [{ Value: 'G-red' }] }],
    },
  });
  assert.match(toFetchXml(model), /<condition entityname="gadget" attribute="name" operator="eq" value="G-red"\/>/);
});

test('typed codec values and Date objects render as their scalar text', () => {
  const equal = (values, attributeName = 'a') => toFetchXml(where(condition('Equal', values, attributeName)));
  assert.match(equal([{ type: 'dateTime', value: '2026-01-01T00:00:00Z' }]), /value="2026-01-01T00:00:00Z"/);
  assert.match(
    equal([{ type: 'guid', value: '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f' }]),
    /value="6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f"/,
  );
  assert.match(equal([{ type: 'EntityReference', logicalName: 'gadget', id: 'g-1' }]), /value="g-1"/);
  assert.match(equal([{ type: 'OptionSetValue', value: 2 }]), /value="2"/);
  assert.match(equal([new Date('2026-01-01T00:00:00Z')]), /value="2026-01-01T00:00:00\.000Z"/);
  // A guess: a boolean renders as "true"; the service's FetchXML text form of booleans is not documented.
  assert.match(equal([true]), /value="true"/);
  assert.throws(
    () => toFetchXml(where(condition('Contains', [{ type: 'string', value: 'Red' }]))),
    (error) => error.code === 'LocalPluginQueryUnsupported',
  );
});

test('an empty ColumnSet on the root returns only the primary key, as QueryExpression does', async () => {
  const model = { entityName: 'widget', columnSet: { allColumns: false, columns: [] } };
  assert.equal(
    toFetchXml(model, { primaryIdOf: () => 'widgetid' }),
    '<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>',
  );
  assert.throws(
    () => toFetchXml(model),
    (error) => error instanceof DataError && error.status === 400,
  );
  const store = await new DataStore({ state: fixtureState() }).init();
  const rows = store.fetchXml(toFetchXml(model, { primaryIdOf: () => 'widgetid' }), { admin: true }).entities;
  assert.equal(rows.length, 4);
  for (const row of rows)
    assert.deepEqual(
      Object.keys(row).filter((key) => key !== 'widgetid' && !key.startsWith('@')),
      [],
    );
});

test('TopCount with paging in a QueryExpression is refused', () => {
  // The SDK documents that a query containing both PageInfo and TopCount throws; the message text is a guess.
  assert.throws(
    () => toFetchXml({ entityName: 'widget', topCount: 3, pageInfo: { count: 2, pageNumber: 1 } }),
    (error) => error instanceof DataError && error.status === 400,
  );
  assert.throws(
    () => toFetchXml({ entityName: 'widget', topCount: 3, pageInfo: { returnTotalRecordCount: true } }),
    (error) => error instanceof DataError && error.status === 400,
  );
  assert.equal(
    toFetchXml({ entityName: 'widget', topCount: 3, pageInfo: {} }),
    '<fetch top="3"><entity name="widget"></entity></fetch>',
  );
});

test('JoinOperator Natural refuses a false Inner approximation', () => {
  // Refuse before returning rows with incorrect duplicate-column projection semantics.
  assert.throws(
    () =>
      toFetchXml({
        entityName: 'widget',
        linkEntities: [
          {
            linkToEntityName: 'gadget',
            linkToAttributeName: 'widgetid',
            linkFromAttributeName: 'widgetid',
            joinOperator: 'Natural',
          },
        ],
      }),
    (error) => error.code === 'LocalPluginQueryUnsupported',
  );
});
