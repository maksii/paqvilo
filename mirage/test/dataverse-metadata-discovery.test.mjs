import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { parseSolutionXml } from '../lib/solution-xml.mjs';
const APP = '10000000-0000-4000-8000-000000000001',
  USER = '20000000-0000-4000-8000-000000000001',
  ACTIVITY = '30000000-0000-4000-8000-000000000001',
  FIRST = '40000000-0000-4000-8000-000000000001',
  SECOND = '40000000-0000-4000-8000-000000000002';
const SETS = {
  EntityDefinitions: 'EntityMetadata',
  RelationshipDefinitions: 'RelationshipMetadataBase',
  GlobalOptionSetDefinitions: 'OptionSetMetadataBase',
};
function descendants(root) {
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(root);
  return nodes;
}

test('metadata discovery declares the three implemented entity collections with closed type references and inherited keys', () => {
  const metadata = createMetadataService({
    organizationId: APP,
    mappings: {
      sample: {
        entitySet: 'samples',
        idColumn: 'sampleid',
        fields: { name: { dataverseType: 'nvarchar' } },
      },
    },
    schema: { tables: {}, relationships: {}, targets: {}, optionSets: {} },
  });
  const entries = metadata.serviceDocument('http://127.0.0.1', 'v9.2').value;
  const nodes = descendants(parseSolutionXml(metadata.csdl())),
    types = new Map(
      nodes
        .filter((node) => ['EntityType', 'ComplexType', 'EnumType'].includes(node.name))
        .map((node) => [node.attrs.Name, node]),
    );
  for (const [name, type] of Object.entries(SETS)) {
    assert.deepEqual(
      entries.find((entry) => entry.name === name),
      { name, kind: 'EntitySet', url: name },
    );
    const set = nodes.find((node) => node.name === 'EntitySet' && node.attrs.Name === name);
    assert.ok(set, name + ' has a typed CSDL entity set');
    assert.equal(set.attrs.EntityType.split('.').at(-1), type);
    assert.equal(types.get(type).attrs.BaseType, 'mscrm.MetadataBase');
  }
  const base = types.get('MetadataBase');
  assert.equal(base.children.find((node) => node.name === 'Key').children[0].attrs.Name, 'MetadataId');
  assert.equal(
    base.children.find((node) => node.name === 'Property' && node.attrs.Name === 'MetadataId').attrs.Nullable,
    'false',
  );
  for (const node of nodes)
    for (const [name, value] of Object.entries(node.attrs))
      if (['Type', 'BaseType', 'EntityType'].includes(name)) {
        const reference = /(?:mscrm\.|Microsoft\.Dynamics\.CRM\.)(\w+)/.exec(value)?.[1];
        if (reference) assert.ok(types.has(reference), 'resolved ' + reference);
      }
  assert.equal(
    entries.some((entry) => entry.name === 'ManagedPropertyDefinitions'),
    false,
    'unimplemented internal collection stays unadvertised',
  );
  assert.equal(
    metadata.entities().some((entity) => Object.values(SETS).includes(entity.LogicalName)),
    false,
    'metadata classes are not business data tables',
  );
});

test('CSDL response entity values use navigation properties while structured and primitive values retain their declared kind', () => {
  const registry = createOperationRegistry(),
    handle = () => ({
      status: 200,
      body: {
        Rows: [{ sampleid: FIRST }],
        One: { sampleid: SECOND },
        Label: { LocalizedLabels: [] },
        Count: 2,
      },
    });
  registry.register({
    name: 'sample_EntityResult',
    kind: 'action',
    binding: 'unbound',
    signature: {
      response: [
        ['Rows', 'Collection(mscrm.crmbaseentity)'],
        ['One', 'mscrm.crmbaseentity'],
        ['Label', 'mscrm.Label'],
        ['Count', 'Edm.Int32'],
      ],
    },
    handle,
  });
  const operation = registry.find({
      name: 'sample_EntityResult',
      kind: 'action',
      binding: 'unbound',
    }),
    nodes = descendants(parseSolutionXml('<Schema>' + operation.csdl + '</Schema>')),
    response = nodes.find((node) => node.name === 'ComplexType');
  assert.deepEqual(
    response.children.map((node) => [node.name, node.attrs.Name]),
    [
      ['NavigationProperty', 'Rows'],
      ['NavigationProperty', 'One'],
      ['Property', 'Label'],
      ['Property', 'Count'],
    ],
  );
  assert.deepEqual(operation.handle(), handle(), 'declaration does not alter operation JSON/results');
});

test('advertised metadata paths and exact source navigation names work over HTTP, including activity inheritance and both self N:N directions', async (t) => {
  const secret = 'PAQVILO_METADATA_DISCOVERY_TEST_SECRET';
  process.env[secret] = 'Invented metadata discovery secret';
  t.after(() => delete process.env[secret]);
  const state = emptyState();
  state.mappings.sample_activity = {
    logicalName: 'sample_activity',
    entitySet: 'sample_activities',
    idColumn: 'activityid',
    nameColumn: 'subject',
    dataverseMetadata: { IsActivity: true },
    fields: {
      subject: { dataverseType: 'nvarchar' },
      createdby: { dataverseType: 'lookup', targets: ['systemuser'] },
    },
    relationships: {
      createdby_sample: {
        entity: 'systemuser',
        from: 'createdby',
        to: 'systemuserid',
        many: false,
        schemaName: 'sample_activity_createdby',
        partner: 'sample_created_activities',
      },
    },
  };
  state.mappings.systemuser = {
    logicalName: 'systemuser',
    entitySet: 'systemusers',
    idColumn: 'systemuserid',
    nameColumn: 'fullname',
    fields: { fullname: { dataverseType: 'nvarchar' } },
    relationships: {
      sample_created_activities: {
        entity: 'sample_activity',
        from: 'systemuserid',
        to: 'createdby',
        many: true,
        schemaName: 'sample_activity_createdby',
        partner: 'createdby_sample',
      },
    },
  };
  state.mappings.sample_node = {
    logicalName: 'sample_node',
    entitySet: 'sample_nodes',
    idColumn: 'sample_nodeid',
    nameColumn: 'name',
    fields: { name: { dataverseType: 'nvarchar' } },
    relationships: {
      followers: {
        entity: 'sample_node',
        from: 'sample_nodeid',
        to: 'sample_nodeid',
        many: true,
        schemaName: 'sample_node_links',
        partner: 'following',
        intersect: { entity: 'sample_link', from: 'sourceid', to: 'targetid' },
      },
      following: {
        entity: 'sample_node',
        from: 'sample_nodeid',
        to: 'sample_nodeid',
        many: true,
        schemaName: 'sample_node_links',
        partner: 'followers',
        intersect: { entity: 'sample_link', from: 'targetid', to: 'sourceid' },
      },
    },
  };
  state.mappings.sample_link = {
    logicalName: 'sample_link',
    entitySet: 'sample_links',
    idColumn: 'sample_linkid',
    fields: {
      sourceid: { dataverseType: 'lookup', targets: ['sample_node'] },
      targetid: { dataverseType: 'lookup', targets: ['sample_node'] },
    },
  };
  state.tables.systemuser = [
    {
      systemuserid: USER,
      fullname: 'Invented fixture user',
      isdisabled: false,
    },
  ];
  state.tables.sample_activity = [{ activityid: ACTIVITY, subject: 'Invented activity', createdby: USER }];
  state.tables.sample_node = [
    { sample_nodeid: FIRST, name: 'First' },
    { sample_nodeid: SECOND, name: 'Second' },
  ];
  state.tables.sample_link = [
    {
      sample_linkid: '50000000-0000-4000-8000-000000000001',
      sourceid: FIRST,
      targetid: SECOND,
    },
  ];
  const store = await new DataStore({ state }).init(),
    server = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: 'Invented discovery client',
            secretEnvironmentVariable: secret,
            roles: ['System Administrator'],
          },
        ],
      }),
      log() {},
    });
  t.after(() => server.close());
  const auth = await fetch(server.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[secret],
      scope: server.origin + '/.default',
    }),
  });
  assert.equal(auth.status, 200);
  const token = (await auth.json()).access_token;
  const get = (path) =>
      fetch(server.origin + '/api/data/v9.2/' + path, {
        headers: { authorization: `Bearer ${token}` },
      }),
    read = async (path) => {
      const response = await get(path),
        text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
  const document = await read(''),
    xmlResponse = await get('$metadata');
  assert.equal(xmlResponse.status, 200);
  const nodes = descendants(parseSolutionXml(await xmlResponse.text()));
  for (const [name, select, expected] of [
    ['EntityDefinitions', 'LogicalName', 'sample_node'],
    ['RelationshipDefinitions', 'SchemaName', 'sample_node_links'],
    ['GlobalOptionSetDefinitions', 'Name', null],
  ]) {
    assert.ok(document.value.some((entry) => entry.name === name));
    const values = (await read(name + '?$select=' + select)).value.map((row) => row[select]);
    assert.ok(Array.isArray(values));
    if (expected) assert.ok(values.includes(expected), `${name} lists ${expected}: ${values.join(',')}`);
  }
  const activity = nodes.find((node) => node.name === 'EntityType' && node.attrs.Name === 'sample_activity');
  assert.equal(activity.attrs.BaseType, 'mscrm.activitypointer');
  assert.ok(
    activity.children.some((node) => node.name === 'NavigationProperty' && node.attrs.Name === 'createdby_sample'),
  );
  assert.equal(
    activity.children.some((node) => node.name === 'NavigationProperty' && node.attrs.Name === 'createdby'),
    false,
    'inherited base navigation is not redeclared',
  );
  const own = await read(`sample_activities(${ACTIVITY})/createdby_sample?$select=systemuserid`);
  assert.equal(own.systemuserid, USER);
  const reverse = await read(`systemusers(${USER})/sample_created_activities?$select=activityid`);
  assert.ok(reverse.value.some((row) => row.activityid === ACTIVITY));
  const nodeType = nodes.find((node) => node.name === 'EntityType' && node.attrs.Name === 'sample_node'),
    navs = nodeType.children.filter((node) => node.name === 'NavigationProperty');
  for (const [name, partner] of [
    ['followers', 'following'],
    ['following', 'followers'],
  ])
    assert.ok(navs.some((nav) => nav.attrs.Name === name && nav.attrs.Partner === partner));
  assert.equal((await read(`sample_nodes(${FIRST})/followers?$select=sample_nodeid`)).value[0].sample_nodeid, SECOND);
  assert.equal((await read(`sample_nodes(${SECOND})/following?$select=sample_nodeid`)).value[0].sample_nodeid, FIRST);
  for (const set of nodes.filter((node) => node.name === 'EntitySet')) {
    const bindings = set.children.filter((node) => node.name === 'NavigationPropertyBinding'),
      paths = bindings.map((node) => node.attrs.Path);
    assert.equal(
      new Set(paths).size,
      paths.length,
      'no duplicate source binding paths in ' +
        set.attrs.Name +
        ' ' +
        JSON.stringify(
          bindings
            .filter((node) => paths.filter((path) => path === node.attrs.Path).length > 1)
            .map((node) => node.attrs),
        ),
    );
  }
  const entityTypes = new Map(
    nodes.filter((node) => node.name === 'EntityType').map((node) => [node.attrs.Name, node]),
  );
  function inheritedProperties(type, seen = new Set()) {
    if (!type || seen.has(type)) return [];
    seen.add(type);
    return [
      ...inheritedProperties(entityTypes.get(type.attrs.BaseType?.split('.').at(-1)), seen),
      ...type.children
        .filter((node) => ['Property', 'NavigationProperty'].includes(node.name))
        .map((node) => node.attrs.Name),
    ];
  }
  for (const type of entityTypes.values()) {
    const properties = inheritedProperties(type);
    assert.equal(
      new Set(properties).size,
      properties.length,
      'typed clients must not see ambiguous inherited properties on ' + type.attrs.Name,
    );
  }
  for (const node of nodes) {
    if (node.name === 'NavigationProperty' && node.attrs.Type.startsWith('Collection('))
      assert.equal(node.attrs.Nullable, undefined, 'collection navigations have no scalar Nullable facet');
    if (node.name === 'Property') {
      const entity = /^Collection\((?:mscrm\.|Microsoft\.Dynamics\.CRM\.)(\w+)\)$/.exec(node.attrs.Type)?.[1];
      assert.equal(
        entityTypes.has(entity),
        false,
        'entity collections are navigation properties, including response members',
      );
    }
  }
});
