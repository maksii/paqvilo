import { exactNumeric } from '../../lib/exact-numeric.mjs';
export function pluginValueCases() {
  const id = '11111111-1111-4111-8111-111111111111',
    other = '22222222-2222-4222-8222-222222222222';
  const entity = { $type: 'Entity', logicalName: 'widget', id, attributes: { title: 'Before' } },
    ref = {
      $type: 'EntityReference',
      logicalName: 'widget',
      id,
      name: 'Before',
      rowVersion: '17',
      keyAttributes: { code: 'Before' },
    },
    query = {
      $type: 'QueryExpression',
      entityName: 'widget',
      columnSet: { allColumns: false, columns: ['title'] },
      criteria: { operatorName: 'And', conditions: [], filters: [] },
      orders: [],
      linkEntities: [],
    };
  const list = [
    ...[0, 1, 2].map((value) => [
      'ConcurrencyBehavior/' + value,
      { $type: 'ConcurrencyBehavior', value },
      () => (value + 1) % 3,
    ]),
    ['Guid', { $type: 'Guid', value: id }, () => other],
    ['DateTime', { $type: 'DateTime', value: '2026-10-01T00:00:00Z' }, () => '2026-10-02T00:00:00Z'],
    ...['Money', 'Decimal', 'Int64'].map((type) => [
      type,
      { $type: type, value: type === 'Int64' ? '9007199254740993' : '9007199254740993.25' },
      () => exactNumeric(type === 'Int64' ? '9007199254740994' : '9007199254740994.25', type),
    ]),
    ['Double', { $type: 'Double', value: '1.5' }, () => 2.5],
    ['OptionSetValue', { $type: 'OptionSetValue', value: 1 }, () => 2],
    [
      'OptionSetValueCollection',
      { $type: 'OptionSetValueCollection', values: [{ $type: 'OptionSetValue', value: 1 }] },
      (v) => (v.push(2), v),
    ],
    ['EntityReference', ref, (v) => ((v.name = 'After'), v)],
    ['Entity', entity, (v) => ((v.title = 'After'), v)],
    [
      'EntityCollection',
      { $type: 'EntityCollection', entities: [entity], moreRecords: true, pagingCookie: 'cookie', totalRecordCount: 2 },
      (v) => ((v[0].title = 'After'), v),
    ],
    ...Object.entries({
      String: ['Before', 'After'],
      Int32: [1, 2],
      Boolean: [false, true],
      Int64: [{ $type: 'Int64', value: '9007199254740993' }, exactNumeric('9007199254740994', 'Int64')],
      Decimal: [{ $type: 'Decimal', value: '9007199254740993.25' }, exactNumeric('9007199254740994.25', 'Decimal')],
      Double: [{ $type: 'Double', value: '1.5' }, 2.5],
      DateTime: [{ $type: 'DateTime', value: '2026-10-01T00:00:00Z' }, '2026-10-02T00:00:00Z'],
    }).map(([type, [value, changed]]) => [
      'PrimitiveArray/' + type,
      { $type: 'PrimitiveArray', elementType: type, values: [value] },
      (v) => ((v[0] = changed), v),
    ]),
    ...Object.entries({
      Entity: entity,
      EntityReference: ref,
      OptionSetValue: { $type: 'OptionSetValue', value: 1 },
      Money: { $type: 'Money', value: '4.25' },
      EntityCollection: { $type: 'EntityCollection', entities: [entity], moreRecords: true, totalRecordCount: 2 },
      QueryExpression: query,
      'String[]': { $type: 'PrimitiveArray', elementType: 'String', values: ['Before'] },
    }).map(([type, value]) => [
      'SdkArray/' + type,
      { $type: 'SdkArray', elementType: type, values: [value] },
      (v) => {
        if (type === 'Entity') v[0].title = 'After';
        else if (type === 'EntityReference') v[0].name = 'After';
        else if (type === 'OptionSetValue') v[0] = 2;
        else if (type === 'Money') v[0] = 5.25;
        else if (type === 'EntityCollection') v[0][0].title = 'After';
        else if (type === 'QueryExpression') v[0].topCount = 2;
        else v[0][0] = 'After';
        return v;
      },
    ]),
    [
      'AliasedValue',
      { $type: 'AliasedValue', entityLogicalName: 'widget', attributeLogicalName: 'title', value: 'Before' },
      () => 'After',
    ],
    ['Bytes', { $type: 'Bytes', value: 'AQI=' }, (v) => ((v.value = 'AwQ='), v)],
    [
      'EntityReferenceCollection',
      { $type: 'EntityReferenceCollection', values: [ref] },
      (v) => ((v.values[0].name = 'After'), v),
    ],
    ['Relationship', { $type: 'Relationship', schemaName: 'before' }, (v) => ((v.schemaName = 'after'), v)],
    [
      'ParameterCollection',
      { $type: 'ParameterCollection', values: { Label: 'Before' } },
      (v) => ((v.values.Label = 'After'), v),
    ],
    [
      'OrganizationRequest',
      {
        $type: 'OrganizationRequest',
        requestName: 'x_Before',
        parameters: { $type: 'ParameterCollection', values: {} },
      },
      (v) => ((v.requestName = 'x_After'), v),
    ],
    ['ColumnSet', { $type: 'ColumnSet', allColumns: false, columns: ['title'] }, (v) => (v.columns.push('code'), v)],
    ['FetchExpression', { $type: 'FetchExpression', query: 'Before' }, (v) => ((v.query = 'After'), v)],
    ['QueryExpression', query, (v) => ((v.topCount = 2), v)],
    [
      'QueryByAttribute',
      { $type: 'QueryByAttribute', entityName: 'widget', attributes: ['title'], values: ['Before'] },
      (v) => ((v.values[0] = 'After'), v),
    ],
    [
      'LinkEntity',
      { $type: 'LinkEntity', linkToEntityName: 'widget', entityAlias: 'Before' },
      (v) => ((v.entityAlias = 'After'), v),
    ],
    [
      'EntityImageCollection',
      { $type: 'EntityImageCollection', values: { Before: entity } },
      (v) => ((v.values.Before.attributes.title = 'After'), v),
    ],
    [
      'EntityImageCollectionArray',
      { $type: 'EntityImageCollectionArray', values: [{ $type: 'EntityImageCollection', values: { Before: entity } }] },
      (v) => ((v.values[0].values.Before.attributes.title = 'After'), v),
    ],
    ['GuidArray', { $type: 'GuidArray', values: [id] }, (v) => ((v.values[0] = other), v)],
    [
      'ExecutionContext',
      {
        $type: 'ExecutionContext',
        values: { SharedVariables: { $type: 'ParameterCollection', values: { Label: 'Before' } } },
      },
      (v) => ((v.values.SharedVariables.values.Label = 'After'), v),
    ],
  ];
  list.push([
    'AliasedColumnSet',
    {
      $type: 'AliasedValue',
      entityLogicalName: 'widget',
      attributeLogicalName: 'title',
      value: { $type: 'ColumnSet', allColumns: false, columns: ['title'] },
    },
    (v) => (v.columns.push('code'), v),
  ]);
  list.push([
    'BooleanManagedProperty',
    { $type: 'BooleanManagedProperty', value: true, canBeChanged: false, managedPropertyLogicalName: 'InventedPolicy' },
    (v) => ((v.value = false), v),
  ]);
  list.push([
    'OrganizationResponse',
    {
      $type: 'OrganizationResponse',
      responseName: 'x_Before',
      custom: true,
      results: { cash: { $type: 'Money', value: '4.25' } },
    },
    (v) => ((v.responseName = 'x_After'), v),
  ]);
  list.push([
    'Dictionary',
    { Label: 'Before', cash: { $type: 'Money', value: '4.25' } },
    (v) => ((v.Label = 'After'), v),
  ]);
  list.push([
    'DictionaryDiscriminator',
    {
      $type: 'Dictionary',
      values: {
        $type: 'Money',
        value: 'Before',
        attributes: { id: 'literal-id', values: ['literal-values'] },
        cash: { $type: 'Money', value: '4.25' },
      },
    },
    (v) => ((v.values.value = 'After'), v),
  ]);
  list.push([
    'ObjectArrayDictionary',
    [{ $type: 'Dictionary', values: { $type: 'Money', value: 'Before' } }],
    (v) => ((v[0].values.value = 'After'), v),
  ]);
  list.push([
    'TypedOrganizationRequest',
    {
      $type: 'OrganizationRequest',
      typed: true,
      requestName: 'Create',
      parameters: { $type: 'ParameterCollection', values: { Target: entity } },
    },
    (v) => ((v.parameters.values.Target.attributes.title = 'After'), v),
  ]);
  list.push([
    'TypedOrganizationResponse',
    { $type: 'OrganizationResponse', custom: false, responseName: 'Retrieve', results: { Entity: entity } },
    (v) => ((v.results.Entity.attributes.title = 'After'), v),
  ]);
  return list;
}
