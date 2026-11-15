// @test-kind contract: the store's own record writes, lookup validation and read naming on invented tables
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DataStore,
  DataError,
  compileFilter,
  emptyState,
  formatMockRecord,
  normalizeMockLiquidFetchXml,
  normalizeMockLiquidRecord,
  parseEntityReference,
  parseFetchXml,
} from '../lib/data.mjs';
import { initialState } from '../lib/bootstrap.mjs';
import { FetchRenderCache } from '../lib/fetch-render-cache.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const user = { contactId: 'c1', accountId: 'a1', roles: ['Member'] };
// @test-kind security: a cached permission decision cannot grant access to a different row that shares an identifier
test('permission memoization cannot grant another row with a duplicate identifier', () => {
  for (const reversed of [false, true]) {
    const rows = [
      { id: 'duplicate', contactid: 'c1' },
      { id: 'duplicate', contactid: 'c2' },
    ];
    if (reversed) rows.reverse();
    const store = new DataStore({
      state: {
        mappings: { item: { idColumn: 'id' } },
        tables: { item: rows },
        permissions: [{ entity: 'item', roles: ['Member'], scope: 'contact' }],
      },
    });
    assert.deepEqual(
      store.rows('item', user).map((row) => row.contactid),
      ['c1'],
    );
    assert.equal(store.rowCount('item', user), 1);
  }
});
test('unconditional permission counts avoid reading record values and preserve authorization overrides', () => {
  const store = new DataStore({
    state: {
      mappings: { sample: { idColumn: 'id' } },
      tables: { sample: [{ id: 'one' }] },
    },
  });
  const subset = new Array(100000);
  Object.defineProperty(subset, 99999, {
    configurable: true,
    get() {
      throw Error('Record materialization');
    },
  });
  assert.equal(store.rowCount('sample', user, subset), 0);
  store.state.permissions = [{ entity: 'sample', scope: 'global' }];
  assert.equal(store.rowCount('sample', user, subset), 1);
  store.state.permissions.unshift({ entity: 'sample', scope: 'parent' });
  assert.throws(() => store.rowCount('sample', user), /Parent permission requires/);
  assert.equal(store.rowCount('sample', user, new Array(100)), 0);
  store.state.permissions = [{ entity: 'sample', scope: 'global' }];
  let calls = 0;
  store.allowed = () => {
    calls++;
    return false;
  };
  assert.equal(store.rowCount('sample', user), 0);
  assert.equal(calls, 1);
});
test('permission counts preserve row filtering, aliases, sparse subsets and errors without a visible-row array', () => {
  const store = new DataStore({
    state: {
      mappings: { sample: { idColumn: 'id', entitySet: 'samples' } },
      tables: {
        sample: [
          { id: 'one', owner: 'c1' },
          { id: 'two', owner: 'c2' },
        ],
      },
      permissions: [{ entity: 'sample', roles: ['Member'], operations: ['read'], scope: 'contact', field: 'owner' }],
    },
  });
  const rows = store.state.tables.sample;
  const subset = new Array(4);
  subset[1] = rows[0];
  subset[3] = rows[1];
  for (const identity of [user, {}, { admin: true }]) {
    const expected = store.rows('samples', identity).length;
    Object.defineProperty(rows, 'filter', {
      configurable: true,
      value() {
        throw Error('Visible row allocation');
      },
    });
    assert.equal(store.rowCount('samples', identity), expected);
    delete rows.filter;
    assert.equal(store.rowCount('sample', identity, subset), expected);
  }
  store.state.settings.permissionMode = 'permissive';
  delete subset[3];
  assert.equal(store.rowCount('sample', {}, subset), 1);
  assert.throws(() => store.rowCount('missing'), /No mapping or local table/);
});
test('enforced unknown navigation bindings reject create and plugin updates atomically', async () => {
  const initial = state();
  initial.settings = { ...initial.settings, associationPermissions: 'enforce' };
  const store = new DataStore({ state: initial });
  store.setPluginPipeline(({ record, stage }) => {
    if (stage === 20) record.firstname = 'Plugin changed';
  });
  for (const write of [
    () => store.create('contacts', { firstname: 'Synthetic', 'unknown@odata.bind': '/accounts(a1)' }, user),
    () => store.update('contacts', 'c1', { firstname: 'Synthetic', 'unknown@odata.bind': '/accounts(a1)' }, user),
  ]) {
    const before = store.snapshot();
    // OData undeclared navigation property (0x80048d19), refused at normalizeRecord before any write.
    await assert.rejects(
      write(),
      (error) => error.code === 'InvalidLookup' && error.details?.innerCode === '0x80048d19' && error.status === 400,
    );
    assert.deepEqual(store.snapshot(), before);
  }
});
test('Authored cache-refresh FetchXML parenthesized GUIDs identify the same permitted product without changing ordinary text comparisons', () => {
  const id = '33333333-3333-3333-3333-333333333333';
  const store = new DataStore({
    state: {
      mappings: { product: { idColumn: 'productid' } },
      tables: {
        product: [
          {
            productid: id,
            name: 'Medicinal Product',
            owner: 'c1',
            text: '(literal)',
          },
          {
            productid: '44444444-4444-4444-4444-444444444444',
            owner: 'c2',
            name: 'Other company',
          },
        ],
      },
      permissions: [
        {
          entity: 'product',
          roles: ['Member'],
          operations: ['read'],
          scope: 'contact',
          field: 'owner',
        },
      ],
      settings: { permissionMode: 'enforce' },
    },
  });
  for (const value of [id, '(' + id + ')', '{' + id + '}']) {
    // Scoped portal queries default to distinct; project a required identity
    // explicitly rather than depending on an implicit primary key.
    const xml = `<fetch><entity name="product"><attribute name="productid"/><attribute name="name"/><filter><condition attribute="productid" operator="in"><value>${value}</value></condition></filter></entity></fetch>`;
    assert.deepEqual(store.fetchXml(xml, user).entities, [{ productid: id, name: 'Medicinal Product' }]);
    assert.equal(store.get('product', value, user).name, 'Medicinal Product');
  }
  assert.equal(store.query('product', { $filter: "text eq 'literal'" }, user).value.length, 0);
  assert.equal(store.query('product', { $filter: "text eq '(literal)'" }, user).value.length, 1);
  assert.throws(
    () => store.get('product', '(44444444-4444-4444-4444-444444444444)', user),
    (error) => error.status === 403,
  );
});
// @test-kind security: a join exposes only rows the calling identity may read, including after permissions change
test('Query-local readable joins respect different identities and immediately changed permission/record state', async () => {
  const store = await new DataStore({
    state: {
      mappings: {
        item: {
          idColumn: 'itemid',
          entitySet: 'items',
          relationships: {
            group: {
              entity: 'group',
              from: 'groupid',
              to: 'groupid',
              many: false,
            },
          },
        },
        group: { idColumn: 'groupid', entitySet: 'groups' },
      },
      tables: {
        item: [
          { itemid: 'one', groupid: 'a' },
          { itemid: 'two', groupid: 'b' },
        ],
        group: [
          { groupid: 'a', contact: 'c1', name: 'Alpha' },
          { groupid: 'b', contact: 'c2', name: 'Beta' },
        ],
      },
      permissions: [
        { entity: 'item', roles: ['Member'], scope: 'global' },
        {
          entity: 'group',
          roles: ['Member'],
          scope: 'contact',
          field: 'contact',
        },
      ],
      settings: { permissionMode: 'enforce' },
    },
  }).init();
  const xml =
    '<fetch><entity name="item"><attribute name="itemid"/><link-entity name="group" from="groupid" to="groupid"><attribute name="name" alias="name"/></link-entity></entity></fetch>';
  assert.deepEqual(store.fetchXml(xml, user).entities, [{ itemid: 'one', name: 'Alpha' }]);
  assert.deepEqual(store.fetchXml(xml, { ...user, contactId: 'c2' }).entities, [{ itemid: 'two', name: 'Beta' }]);
  assert.deepEqual(
    store.query('item', { $filter: "group/name eq 'Alpha'", $expand: 'group' }, user).value.map((x) => x.itemid),
    ['one'],
  );
  assert.equal(store.query('item', { $filter: "group/name eq 'Alpha'" }, { ...user, contactId: 'c2' }).value.length, 0);
  const changed = store.snapshot();
  changed.tables.group[0].contact = 'c2';
  changed.tables.group[0].name = 'Changed';
  await store.replaceState(changed);
  assert.equal(store.fetchXml(xml, user).entities.length, 0);
  assert.equal(store.query('item', { $filter: "group/name eq 'Alpha'" }, user).value.length, 0);
  assert.deepEqual(store.fetchXml(xml, { ...user, contactId: 'c2' }).entities, [
    { itemid: 'one', name: 'Changed' },
    { itemid: 'two', name: 'Beta' },
  ]);
  assert.equal(
    store.query('item', { $filter: "group/name eq 'Changed'" }, { ...user, contactId: 'c2' }).value[0].itemid,
    'one',
  );
});
test('FetchXML preserves quoted greater-than delimiters and escaped native paging cookies', () => {
  const parsed = parseFetchXml(
    `<fetch paging-cookie="&lt;cookie page='1'>&lt;id last='1'/>&lt;/cookie>"><entity name="item"><filter><condition attribute="name" operator="eq" value="a > b"/></filter></entity></fetch>`,
  );
  assert.equal(parsed.attrs['paging-cookie'], "<cookie page='1'><id last='1'/></cookie>");
  assert.equal(parsed.children[0].children[0].children[0].attrs.value, 'a > b');
});
// @test-kind security: backend lookups copy only rows the caller may read and refuse unbounded expansion
test('Backend findMany copies only readable matching rows, rejects unbounded expansion and rolls back', async () => {
  const initial = {
    mappings: {
      request: { idColumn: 'requestid', entitySet: 'requests' },
      source: { idColumn: 'sourceid', entitySet: 'sources' },
      copy: { idColumn: 'copyid', entitySet: 'copies' },
    },
    tables: {
      request: [],
      source: [
        { sourceid: 'own', contact: 'c1', kind: 'selected' },
        { sourceid: 'foreign', contact: 'c2', kind: 'selected' },
      ],
      copy: [],
    },
    permissions: [
      {
        entity: 'request',
        roles: ['Member'],
        operations: ['create'],
        scope: 'global',
      },
      {
        entity: 'source',
        roles: ['Member'],
        operations: ['read'],
        scope: 'contact',
        field: 'contact',
      },
    ],
    plugins: [
      {
        entity: 'request',
        operations: ['create'],
        secondary: [
          {
            entity: 'copy',
            operation: 'create',
            foreach: {
              op: 'findMany',
              args: ['source', 'sourceid'],
              match: { kind: 'selected' },
            },
            set: { source: '$item' },
          },
        ],
      },
    ],
    settings: { permissionMode: 'enforce' },
  };
  const store = await new DataStore({ state: initial }).init();
  await store.create('request', {}, user);
  assert.deepEqual(
    store.snapshot().tables.copy.map((row) => row.source),
    ['own'],
  );
  const huge = store.snapshot();
  huge.tables.source = Array.from({ length: 1025 }, (_, index) => ({
    sourceid: `source${index}`,
    contact: 'c1',
    kind: 'selected',
  }));
  await store.replaceState(huge);
  const before = store.snapshot();
  await assert.rejects(store.create('request', {}, user), (error) => error.code === 'InvalidPlugin');
  assert.deepEqual(store.snapshot(), before);
});
// @test-kind security: a many-to-many traversal cannot reveal rows that permission trimming hides at either endpoint
test('FetchXML traverses only declared structural many-to-many edges while both endpoints remain trimmed', async () => {
  const state = {
    mappings: {
      item: {
        idColumn: 'itemid',
        entitySet: 'items',
        relationships: {
          groups: {
            entity: 'group',
            from: 'itemid',
            to: 'groupid',
            many: true,
            intersect: { entity: 'edge', from: 'itemid', to: 'groupid' },
          },
        },
      },
      group: { idColumn: 'groupid', entitySet: 'groups' },
      edge: { idColumn: 'edgeid', entitySet: 'edges' },
    },
    tables: {
      item: [
        { itemid: 'own', contact: 'c1' },
        { itemid: 'foreign', contact: 'c2' },
      ],
      group: [
        { groupid: 'allowed', contact: 'c1' },
        { groupid: 'denied', contact: 'c2' },
      ],
      edge: [
        { edgeid: '1', itemid: 'own', groupid: 'allowed', secret: 'hidden' },
        { edgeid: '2', itemid: 'own', groupid: 'denied', secret: 'hidden' },
        {
          edgeid: '3',
          itemid: 'foreign',
          groupid: 'allowed',
          secret: 'hidden',
        },
      ],
    },
    permissions: [
      { entity: 'item', roles: ['Member'], scope: 'contact', field: 'contact' },
      {
        entity: 'group',
        roles: ['Member'],
        scope: 'contact',
        field: 'contact',
      },
    ],
    settings: { permissionMode: 'enforce' },
  };
  const store = await new DataStore({ state }).init();
  const xml = `<fetch><entity name="item"><attribute name="itemid"/><link-entity name="edge" alias="membership" from="itemid" to="itemid" intersect="true"><link-entity name="group" from="groupid" to="groupid"><attribute name="groupid" alias="group"/></link-entity></link-entity></entity></fetch>`;
  assert.deepEqual(store.fetchXml(xml, user).entities, [{ itemid: 'own', group: 'allowed' }]);
  assert.equal(store.rows('edge', user).length, 0);
  assert.throws(
    () => store.get('edge', '1', user),
    (e) => e.code === 'PermissionDenied',
  );
  assert.throws(
    () => store.query('edge', {}, user),
    (e) => e.code === 'PermissionDenied',
  );
  assert.deepEqual(store.fetchXml(xml.replace('intersect="true"', ''), user).entities, [
    { itemid: 'own', group: 'allowed' },
  ]);
  const leaf = `<fetch><entity name="item"><attribute name="itemid"/><link-entity name="edge" alias="membership" from="itemid" to="itemid"><filter><condition attribute="groupid" operator="eq" value="allowed"/></filter></link-entity></entity></fetch>`;
  assert.deepEqual(store.fetchXml(leaf, user).entities, [{ itemid: 'own' }]);
  assert.deepEqual(store.fetchXml(leaf.replace('value="allowed"', 'value="denied"'), user).entities, []);
  assert.equal(
    store.fetchXml(
      xml.replace('<link-entity name="group"', '<attribute name="secret"/><link-entity name="group"'),
      user,
    ).entities.length,
    0,
  );
  assert.throws(
    () =>
      store.fetchXml(
        xml.replace(
          '<link-entity name="group"',
          '<filter><condition attribute="secret" operator="eq" value="hidden"/></filter><link-entity name="group"',
        ),
        user,
      ),
    (e) => e.code === 'InvalidIntersectionQuery',
  );
  assert.throws(
    () =>
      store.fetchXml(
        xml.replace(
          '<attribute name="itemid"/>',
          '<attribute name="itemid"/><filter><condition entityname="membership" attribute="secret" operator="eq" value="hidden"/></filter>',
        ),
        user,
      ),
    (e) => e.code === 'InvalidIntersectionQuery',
  );
  const denied = store.snapshot();
  denied.permissions = denied.permissions.filter((p) => p.entity !== 'group');
  await store.replaceState(denied);
  assert.equal(store.fetchXml(xml, user).entities.length, 0);
});
// @test-kind security: a create outside the caller's parent scope or permission gate is refused and rolled back
test('Parent-scoped create stages trusted backend links and rolls back gate, scope and lookup rejection atomically', async () => {
  const initial = {
    mappings: {
      app: {
        idColumn: 'appid',
        entitySet: 'apps',
        relationships: {
          customer: { entity: 'account', from: 'customer', to: 'accountid' },
        },
      },
      coauthor: { idColumn: 'coauthorid', entitySet: 'coauthors' },
      userrole: { idColumn: 'userroleid', entitySet: 'userroles' },
      account: { idColumn: 'accountid', entitySet: 'accounts' },
    },
    tables: {
      app: [],
      coauthor: [],
      userrole: [
        { userroleid: 'own', contact: 'c1' },
        { userroleid: 'foreign', contact: 'c2' },
      ],
      account: [
        { accountid: 'a1', contact: 'c1' },
        { accountid: 'a2', contact: 'c2' },
      ],
    },
    permissions: [
      {
        id: 'app',
        entity: 'app',
        roles: ['Member'],
        operations: ['create', 'read', 'append'],
        scope: 'parent',
        parentPermissionId: 'coauthor',
        relationship: {
          entity: 'coauthor',
          from: 'appid',
          to: 'application',
          many: true,
        },
      },
      {
        id: 'coauthor',
        entity: 'coauthor',
        roles: ['Member'],
        operations: ['read'],
        scope: 'parent',
        parentPermissionId: 'userrole',
        relationship: {
          entity: 'userrole',
          from: 'applicant',
          to: 'userroleid',
        },
      },
      {
        id: 'userrole',
        entity: 'userrole',
        roles: ['Member'],
        operations: ['read'],
        scope: 'contact',
        field: 'contact',
      },
      {
        id: 'account',
        entity: 'account',
        roles: ['Member'],
        operations: ['read', 'appendTo'],
        scope: 'contact',
        field: 'contact',
      },
    ],
    plugins: [
      {
        entity: 'app',
        operations: ['create'],
        secondary: [
          {
            entity: 'coauthor',
            operation: 'create',
            set: {
              application: { op: 'reference', args: ['app', '$record.appid'] },
              applicant: '$record.requestedrole',
            },
          },
        ],
      },
    ],
    settings: { permissionMode: 'enforce', associationPermissions: 'enforce' },
  };
  const store = await new DataStore({ state: initial }).init();
  const created = await store.create('app', { requestedrole: 'own', customer: 'a1' }, user);
  assert.equal(store.get('app', created.appid, user).customer, 'a1');
  assert.equal(store.snapshot().tables.coauthor[0].application.id, created.appid);
  const snapshot = store.snapshot();
  await assert.rejects(
    store.create('app', { requestedrole: 'foreign', customer: 'a1' }, user),
    (e) => e.code === 'PermissionDenied',
  );
  assert.deepEqual(store.snapshot(), snapshot);
  await assert.rejects(
    store.create('app', { requestedrole: 'own', customer: 'a2' }, user),
    (e) => e.code === 'PermissionDenied',
  );
  assert.deepEqual(store.snapshot(), snapshot);
  await assert.rejects(
    store.create('app', { requestedrole: 'own' }, { ...user, roles: [] }),
    (e) => e.code === 'PermissionDenied',
  );
  assert.deepEqual(store.snapshot(), snapshot);
});
test('Membership identities use resolved exported roles without granting implicit literal defaults', async () => {
  const store = await new DataStore({
    state: {
      mappings: { contact: { idColumn: 'contactid', entitySet: 'contacts' } },
      tables: { contact: [{ contactid: 'c1' }] },
      permissions: [
        {
          entity: 'contact',
          roles: ['Authenticated Users'],
          scope: 'self',
          operations: ['read'],
        },
      ],
      settings: { permissionMode: 'enforce' },
    },
  }).init();
  assert.equal(store.get('contact', 'c1', { contactId: 'c1', roles: [] }).contactid, 'c1');
  assert.throws(
    () =>
      store.get('contact', 'c1', {
        contactId: 'c1',
        roles: [],
        roleSource: 'memberships',
      }),
    (e) => e.code === 'PermissionDenied',
  );
  assert.equal(
    store.get('contact', 'c1', {
      contactId: 'c1',
      roles: ['Authenticated Users'],
      roleSource: 'memberships',
    }).contactid,
    'c1',
  );
  const imported = store.snapshot();
  imported.permissions[0].roleIds = ['actual-source-role'];
  await store.replaceState(imported);
  assert.throws(
    () =>
      store.get('contact', 'c1', {
        contactId: 'c1',
        roles: ['Authenticated Users'],
        roleIds: ['same-name-other-role'],
        roleSource: 'memberships',
      }),
    (e) => e.code === 'PermissionDenied',
  );
  assert.equal(
    store.get('contact', 'c1', {
      contactId: 'c1',
      roles: ['Authenticated Users'],
      roleIds: ['actual-source-role'],
      roleSource: 'memberships',
    }).contactid,
    'c1',
  );
  const unresolved = store.snapshot();
  unresolved.permissions[0].imported = true;
  unresolved.permissions[0].roleIds = [];
  await store.replaceState(unresolved);
  assert.throws(
    () =>
      store.get('contact', 'c1', {
        contactId: 'c1',
        roles: ['Authenticated Users'],
        roleSource: 'memberships',
      }),
    (e) => e.code === 'PermissionDenied',
  );
});
test('Parent grants may revisit a row through distinct source permissions while genuine grant cycles remain rejected', async () => {
  const source = {
    mappings: {
      app: { idColumn: 'appid', entitySet: 'apps' },
      coauthor: { idColumn: 'coauthorid', entitySet: 'coauthors' },
      role: { idColumn: 'roleid', entitySet: 'roles' },
    },
    tables: {
      app: [{ appid: 'app' }],
      coauthor: [{ coauthorid: 'author', application: 'app', applicant: 'own-role' }],
      role: [{ roleid: 'own-role', contact: 'c1' }],
    },
    permissions: [
      {
        id: 'coauthor-root',
        entity: 'coauthor',
        roles: ['Member'],
        scope: 'parent',
        parentPermissionId: 'app-scoped',
        relationship: { entity: 'app', from: 'application', to: 'appid' },
      },
      {
        id: 'app-scoped',
        entity: 'app',
        roles: ['Member'],
        scope: 'parent',
        parentPermissionId: 'coauthor-scoped',
        relationship: {
          entity: 'coauthor',
          from: 'appid',
          to: 'application',
          many: true,
        },
      },
      {
        id: 'coauthor-scoped',
        entity: 'coauthor',
        roles: ['Member'],
        scope: 'parent',
        parentPermissionId: 'role-scoped',
        relationship: { entity: 'role', from: 'applicant', to: 'roleid' },
      },
      {
        id: 'role-scoped',
        entity: 'role',
        roles: ['Member'],
        scope: 'contact',
        field: 'contact',
      },
    ],
    settings: { permissionMode: 'enforce' },
  };
  const store = await new DataStore({ state: source }).init();
  assert.equal(store.get('coauthor', 'author', user).coauthorid, 'author');
  const cyclic = store.snapshot();
  cyclic.permissions.find((p) => p.id === 'app-scoped').parentPermissionId = 'coauthor-root';
  await store.replaceState(cyclic);
  assert.throws(
    () => store.get('coauthor', 'author', user),
    (e) => e.code === 'InvalidPermission',
  );
});
const state = () => ({
  mappings: {
    contact: {
      entitySet: 'contacts',
      idColumn: 'contactid',
      relationships: {
        account: {
          entity: 'account',
          from: 'parentcustomerid',
          to: 'accountid',
          many: false,
        },
      },
    },
    account: { entitySet: 'accounts', idColumn: 'accountid' },
    audit: { entitySet: 'audits', idColumn: 'auditid' },
  },
  tables: {
    contact: [
      {
        contactid: 'c1',
        firstname: 'Ada',
        lastname: 'Lovelace',
        age: 36,
        parentcustomerid: 'a1',
      },
      {
        contactid: 'c2',
        firstname: 'Grace',
        lastname: 'Hopper',
        age: 85,
        parentcustomerid: 'a2',
      },
      {
        contactid: 'c3',
        firstname: 'Alan',
        lastname: 'Turing',
        age: 41,
        parentcustomerid: null,
      },
    ],
    account: [
      { accountid: 'a1', name: 'Analytical Engines' },
      { accountid: 'a2', name: 'Compilers' },
    ],
    audit: [],
  },
  permissions: [
    {
      entity: 'contact',
      operations: ['read', 'create', 'update', 'delete'],
      roles: ['Member'],
      scope: 'global',
    },
    {
      entity: 'account',
      operations: ['read'],
      roles: ['Member'],
      scope: 'global',
    },
  ],
});

test('persistent CRUD with atomic rollback and declarative plugin secondary effects', async () => {
  const dir = await makeTemporaryDirectory(join(tmpdir(), 'pp-mirage-data-'));
  try {
    const initial = state();
    initial.plugins = [
      {
        id: 'contact-compute',
        entity: 'contact',
        operations: ['create', 'update'],
        defaults: { statuscode: 1 },
        set: {
          fullname: {
            op: 'concat',
            args: ['$record.firstname', ' ', '$record.lastname'],
          },
        },
        validate: [
          { field: 'lastname', required: true },
          { field: 'firstname', unique: true },
        ],
        secondary: [
          {
            entity: 'audit',
            operation: 'create',
            set: { subject: '$record.fullname' },
          },
        ],
      },
    ];
    const store = await new DataStore({
      file: join(dir, 'state.json'),
      state: initial,
    }).init();
    await assert.rejects(store.create('contacts', { firstname: 'New' }, user), (e) => e.code === 'PluginValidation');
    assert.equal(store.snapshot().tables.audit.length, 0);
    const row = await store.create('contacts', { firstname: 'Katherine', lastname: 'Johnson' }, user);
    assert.equal(row.fullname, 'Katherine Johnson');
    assert.equal(row.statuscode, 1);
    assert.equal(store.snapshot().tables.audit[0].subject, row.fullname);
    const restored = await new DataStore({
      file: join(dir, 'state.json'),
    }).init();
    assert.equal(restored.get('contacts', row.contactid, user).fullname, row.fullname);
    await assert.rejects(
      store.update('contacts', row.contactid, { firstname: 'Ada' }, user),
      (e) => e.code === 'PluginValidation',
    );
    assert.equal(store.get('contacts', row.contactid, user).firstname, 'Katherine');
    await store.update('contacts', row.contactid, { lastname: 'J' }, user);
    await store.remove('contacts', row.contactid, user);
    assert.equal(store.get('contacts', row.contactid, user), null);
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).tables.contact.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('OData nested filters, projection, ordering, count, paging and mapped expand', () => {
  const store = new DataStore({ state: state() });
  const result = store.query(
    'contacts',
    new URLSearchParams({
      $filter: "(age ge 40 and startswith(tolower(firstname),'g')) or firstname eq 'Ada'",
      $orderby: 'age desc',
      $select: 'firstname,age',
      $expand: 'account($select=name)',
      $top: '1',
      $count: 'true',
    }),
    user,
  );
  assert.equal(result['@odata.count'], 2);
  assert.deepEqual(result.value, [{ firstname: 'Grace', age: 85, account: { name: 'Compilers' } }]);
  assert.equal(
    store.query('contacts', { $filter: "firstname in ('Ada','Alan')", $skip: '1', $top: '1' }, user).value[0].firstname,
    'Alan',
  );
  assert.throws(
    () => store.query('contacts', { $apply: 'aggregate(age with sum)' }, user),
    (e) => e.code === 'UnsupportedQuery',
  );
  assert.throws(() => compileFilter('name eq eval(1)'), DataError);
  assert.equal(
    compileFilter('contactid eq 11111111-1111-1111-1111-111111111111')({
      contactid: '11111111-1111-1111-1111-111111111111',
    }),
    true,
  );
  assert.equal(
    compileFilter('createdon ge 2026-01-01T00:00:00Z')({
      createdon: '2026-02-01T00:00:00Z',
    }),
    true,
  );
});

// @test-kind security: permission trimming applies to every query dialect and a caller cannot reassign
// ownership beyond their access
test('permission trimming applies equally to FetchXML and OData and prevents ownership reassignment', async () => {
  const initial = state();
  initial.permissions = [
    {
      entity: 'contact',
      operations: ['read', 'update', 'create'],
      roles: ['Member'],
      scope: 'self',
    },
    {
      entity: 'account',
      operations: ['read'],
      roles: ['Member'],
      scope: 'account',
      field: 'accountid',
    },
  ];
  const store = new DataStore({ state: initial });
  assert.equal(store.query('contacts', {}, user).value.length, 1);
  assert.equal(
    store.fetchXml('<fetch><entity name="contact"><all-attributes /></entity></fetch>', user).entities.length,
    1,
  );
  assert.throws(
    () => store.get('contact', 'c2', user),
    (e) => e.status === 403,
  );
  await assert.rejects(store.remove('contact', 'c1', user), (e) => e.status === 403);
  assert.throws(
    () => store.query('audit', {}, user),
    (e) => e.status === 403,
  );
  assert.deepEqual(store.fetchXml('<fetch><entity name="audit" /></fetch>', user).entities, []);
  assert.equal(store.query('contacts', {}, { admin: true }).value.length, 3);
});

test('FetchXML inner and outer joins, alias filters, distinct, paging and aggregates', () => {
  const store = new DataStore({ state: state() });
  const result = store.fetchXml(
    `<fetch count="1" page="1" returntotalrecordcount="true"><entity name="contact"><attribute name="firstname"/><link-entity name="account" from="accountid" to="parentcustomerid" alias="org" link-type="outer"><attribute name="name"/></link-entity><filter type="or"><condition entityname="org" attribute="name" operator="like" value="%Engine%"/><condition attribute="parentcustomerid" operator="null"/></filter><order attribute="firstname"/></entity></fetch>`,
    user,
  );
  assert.equal(result.total_record_count, 2);
  assert.equal(result.more_records, true);
  assert.equal(result.entities[0].firstname, 'Ada');
  assert.equal(result.entities[0]['org.name'], 'Analytical Engines');
  const aggregate = store.fetchXml(
    '<fetch aggregate="true"><entity name="contact"><attribute name="age" alias="sum" aggregate="sum"/><attribute name="contactid" alias="count" aggregate="count"/><attribute name="age" alias="avg" aggregate="avg"/></entity></fetch>',
    user,
  );
  assert.deepEqual(aggregate.entities, [{ sum: 162, count: 3, avg: 54 }]);
  const grouped = store.fetchXml(
    '<fetch aggregate="true"><entity name="contact"><attribute name="parentcustomerid" alias="org" groupby="true"/><attribute name="age" alias="total" aggregate="sum"/></entity></fetch>',
    user,
  );
  assert.deepEqual(grouped.entities, [{ org: 'a1', total: 36 }, { org: 'a2', total: 85 }, { total: 41 }]);
});

test('a repeated FetchXML text does not inherit the total or the diagnostics of an earlier execution', () => {
  const xml =
    '<fetch count="1"><entity name="contact"><attribute name="firstname"/><attribute name="nosuch"/></entity></fetch>';
  const webApi = { profile: 'webapi' };
  const fresh = new DataStore({ state: state() }).fetchXml(xml, user, webApi);
  const plain = new DataStore({ state: state() });
  assert.equal(plain.fetchXml(xml, user, { ...webApi, returnTotal: true }).total_record_count, 3);
  const withoutTotal = plain.fetchXml(xml, user, webApi);
  assert.equal(withoutTotal.total_record_count, -1);
  assert.deepEqual(withoutTotal.diagnostics, fresh.diagnostics);
  const cached = new DataStore({ state: state() });
  const fetchCache = new FetchRenderCache();
  assert.equal(cached.fetchXml(xml, user, { ...webApi, returnTotal: true, fetchCache }).total_record_count, 3);
  const cachedWithoutTotal = cached.fetchXml(xml, user, { ...webApi, fetchCache });
  assert.equal(cachedWithoutTotal.total_record_count, -1);
  assert.deepEqual(cachedWithoutTotal.diagnostics, fresh.diagnostics);
  assert.deepEqual(
    cachedWithoutTotal.diagnostics.map((item) => item.code),
    ['FETCHXML_COLUMN_UNVERIFIED'],
  );
});

test('an absolute entity reference with a malformed percent escape is not a reference', () => {
  assert.equal(parseEntityReference('http://127.0.0.1/_api/accounts(%E0%A4%A)'), null);
});

test('an alternate-key reference whose quoted value contains parentheses is a reference', () => {
  const reference = parseEntityReference("/accounts(name='a(b)')");
  assert.ok(reference, 'a quoted alternate-key value may contain parentheses');
  assert.equal(reference.set, 'accounts');
  assert.equal(reference.id, "name='a(b)'");
  assert.equal(parseEntityReference("/accounts(name='a(b)'"), null);
  assert.equal(parseEntityReference('/accounts(a(b))'), null);
});

// Plugin fixtures use one invented table with a money column and a text column.
const pluginFixtureState = (plugins) => ({
  mappings: {
    contact: {
      entitySet: 'contacts',
      idColumn: 'contactid',
      fields: { revenue: { dataverseType: 'money', precision: 2 }, firstname: { dataverseType: 'nvarchar' } },
    },
  },
  tables: { contact: [] },
  permissions: [
    { entity: 'contact', operations: ['read', 'create', 'update', 'delete'], roles: ['Member'], scope: 'global' },
  ],
  plugins,
});
const pluginAdmin = { admin: true };
const exactNumeric = (value) => ({ $type: 'DataverseNumeric', numericType: 'Literal', value });

test('plugin min and max compare exact numerics, and an absent value passes the bound', async () => {
  const store = new DataStore({
    state: pluginFixtureState([{ id: 'm', entity: 'contact', validate: [{ field: 'revenue', min: 0, max: 100 }] }]),
  });
  await store.create('contacts', { revenue: exactNumeric('10.50') }, pluginAdmin);
  await assert.rejects(
    store.create('contacts', { revenue: exactNumeric('-1') }, pluginAdmin),
    (error) => error.code === 'PluginValidation',
  );
  await store.create('contacts', { firstname: 'No revenue' }, pluginAdmin);
  assert.equal(store.snapshot().tables.contact.length, 2);
});

test('plugin unique skips empty values and checks non-empty values through the entity-set name', async () => {
  const store = new DataStore({
    state: pluginFixtureState([{ id: 'u', entity: 'contact', validate: [{ field: 'firstname', unique: true }] }]),
  });
  await store.create('contacts', { lastname: 'x' }, pluginAdmin);
  await store.create('contacts', { lastname: 'y' }, pluginAdmin);
  await store.create('contacts', { firstname: 'Ada' }, pluginAdmin);
  await assert.rejects(
    store.create('contacts', { firstname: 'ada' }, pluginAdmin),
    (error) => error.code === 'PluginValidation',
  );
  assert.equal(store.snapshot().tables.contact.length, 3);
});

test('plugin rule definitions the write path cannot evaluate are refused when the state loads', () => {
  const load = (plugin) => () =>
    new DataStore({ state: pluginFixtureState([{ id: 'd', entity: 'contact', ...plugin }]) });
  assert.throws(load({ validate: [{ field: 'firstname', oneOf: 'x' }] }), DataError);
  assert.throws(load({ validate: [{ field: 'revenue', min: 'abc' }] }), DataError);
  assert.throws(load({ set: { q: '$toString' } }), DataError);
  assert.throws(load({ set: { p: '$record.constructor.name' } }), DataError);
  assert.throws(load({ set: { p: '$record.__defineGetter__' } }), DataError);
  assert.throws(load({ set: { p: '$record.bad-segment' } }), DataError);
});

test('an unknown root loads and evaluates to undefined', async () => {
  const store = new DataStore({
    state: pluginFixtureState([{ id: 'd', entity: 'contact', set: { p: '$unknownroot.firstname' } }]),
  });
  assert.equal(store.evaluate('$unknownroot.firstname', { record: { firstname: 'Ada' } }), undefined);
  await store.create('contacts', { firstname: 'Ada' }, pluginAdmin);
  assert.equal(store.snapshot().tables.contact.length, 1);
});

test('a plugin path reads own members of its context only', () => {
  const store = new DataStore({ state: pluginFixtureState([]) });
  assert.equal(store.evaluate('$record.firstname', { record: { firstname: 'Ada' } }), 'Ada');
  assert.equal(store.evaluate('$record.constructor', { record: {} }), undefined);
  assert.equal(store.evaluate('$toString', { record: {} }), undefined);
});

test('FetchXML nested links and existential link types preserve multiplicity correctly', () => {
  const initial = state();
  initial.mappings.audit = { entitySet: 'audits', idColumn: 'auditid' };
  initial.tables.audit = [
    { auditid: 'l1', contactid: 'c1', subject: 'A' },
    { auditid: 'l2', contactid: 'c1', subject: 'B' },
  ];
  initial.permissions.push({
    entity: 'audit',
    operations: ['read'],
    roles: ['Member'],
    scope: 'global',
  });
  const store = new DataStore({ state: initial });
  const link = (type) =>
    `<fetch><entity name="contact"><attribute name="firstname"/><link-entity name="audit" from="contactid" to="contactid" link-type="${type}" alias="log">${type === 'inner' ? '<attribute name="subject"/>' : ''}</link-entity></entity></fetch>`;
  assert.equal(store.fetchXml(link('inner'), user).entities.length, 2);
  assert.equal(store.fetchXml(link('exists'), user).entities.length, 1);
  assert.equal(store.fetchXml(link('not any'), user).entities.length, 2);
  initial.tables.audit.push({ auditid: 'l3', contactid: null });
  initial.tables.contact.push({
    contactid: 'c4',
    firstname: 'Nobody',
    parentcustomerid: null,
  });
  const nulls = new DataStore({ state: initial });
  assert.equal(
    nulls.fetchXml(
      '<fetch><entity name="contact"><attribute name="firstname"/><link-entity name="audit" from="contactid" to="parentcustomerid" link-type="inner"/></entity></fetch>',
      user,
    ).entities.length,
    0,
  );
});

test('malformed and unsupported queries fail without arbitrary evaluation or entity resolution', () => {
  const store = new DataStore({ state: state() });
  assert.throws(() => parseFetchXml('<!DOCTYPE fetch SYSTEM "file:///secret"><fetch/>'), DataError);
  assert.throws(() => parseFetchXml('<fetch><entity></fetch>'), DataError);
  assert.throws(
    () =>
      store.fetchXml(
        '<fetch><entity name="contact"><filter><condition attribute="age" operator="nonsense"/></filter></entity></fetch>',
        user,
      ),
    (e) => e.code === 'UnsupportedQuery',
  );
  assert.throws(() => store.query('__proto__', {}, user), DataError);
  assert.throws(() => store.query('contacts', { $top: '-1' }, user), DataError);
});

test('lookup bindings resolve explicit entity mappings and presets switch the permission mode', async () => {
  const store = new DataStore({ state: state() });
  const created = await store.create(
    'contacts',
    {
      firstname: 'X',
      lastname: 'Y',
      // The declared navigation (the column name is not a navigation once a relationship covers it).
      'account@odata.bind': '/accounts(a1)',
    },
    user,
  );
  assert.deepEqual(created.parentcustomerid, {
    id: 'a1',
    logical_name: 'account',
    name: 'Analytical Engines',
  });
  assert.equal(store.query('contacts', { $filter: "_parentcustomerid_value eq 'a1'" }, user).value.length, 2);
  await store.applyPreset('strict-permissions');
  assert.equal(store.snapshot().settings.permissionMode, 'enforce');
  assert.throws(
    () => store.query('audits'),
    (e) => e.code === 'PermissionDenied',
  );
  await store.applyPreset('open-sandbox');
  assert.equal(store.snapshot().settings.permissionMode, 'permissive');
  assert.deepEqual(store.query('audits').value, []);
});

test('native navigation bindings populate physical lookup columns, validate targets and clear with null', async () => {
  const data = state();
  data.mappings.contact.relationships.customer = {
    entity: 'account',
    from: 'parentcustomerid',
    to: 'accountid',
    many: false,
  };
  const store = new DataStore({ state: data });
  const created = await store.create(
    'contacts',
    { firstname: 'Synthetic', 'customer@odata.bind': '/accounts(a1)' },
    user,
  );
  assert.deepEqual(created.parentcustomerid, {
    id: 'a1',
    logical_name: 'account',
    name: 'Analytical Engines',
  });
  assert.equal(Object.hasOwn(created, 'customer'), false);
  assert.equal(Object.hasOwn(created, 'customer@odata.bind'), false);
  await store.update('contacts', created.contactid, { 'customer@odata.bind': null }, user);
  assert.equal(store.get('contact', created.contactid, user).parentcustomerid, null);
  await assert.rejects(
    store.update('contacts', created.contactid, { 'customer@odata.bind': '/contacts(c1)' }, user),
    (e) => e.code === 'InvalidLookup',
  );
  await assert.rejects(
    store.update(
      'contacts',
      created.contactid,
      { parentcustomerid: 'a1', 'customer@odata.bind': '/accounts(a2)' },
      user,
    ),
    (e) => e.code === 'InvalidLookup',
  );
  assert.equal(store.get('contact', created.contactid, user).parentcustomerid, null);
});

test('invalid config rejected atomically and unsupported FetchXML fails on empty table', async () => {
  const store = new DataStore({ state: state() });
  const before = store.snapshot();
  await assert.rejects(
    store.replaceState({
      ...state(),
      plugins: [{ entity: 'contact', set: { x: { op: 'eval' } } }],
    }),
    DataError,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.throws(
    () =>
      store.fetchXml(
        '<fetch><entity name="audit"><filter><condition attribute="x" operator="unknown"/></filter></entity></fetch>',
        { admin: true },
      ),
    (e) => e.code === 'UnsupportedQuery',
  );
});

test('imported unresolved permissions stay disabled with actionable diagnostics and simulator config survives persistence', async () => {
  const portal = {
    records: [
      { kind: 'webrole', id: 'role1', name: 'Member' },
      {
        kind: 'tablepermission',
        id: 'global',
        adx_entitylogicalname: 'account',
        adx_scope: 756150000,
        adx_read: true,
        adx_entitypermission_webrole: ['role1'],
      },
      {
        kind: 'tablepermission',
        id: 'contact',
        adx_entitylogicalname: 'contact',
        adx_scope: 756150001,
        adx_read: true,
        adx_contactrelationship: 'account_primary_contact',
        adx_entitypermission_webrole: ['role1'],
      },
      {
        kind: 'tablepermission',
        id: 'parent',
        adx_entitylogicalname: 'child',
        adx_scope: 756150003,
        adx_read: true,
        adx_entitypermission_webrole: ['role1'],
      },
      {
        kind: 'tablepermission',
        id: 'unknown',
        adx_entitylogicalname: 'unknown',
        adx_scope: 999,
        adx_read: true,
        adx_entitypermission_webrole: ['role1'],
      },
      {
        kind: 'tablepermission',
        id: 'no-role',
        adx_entitylogicalname: 'norole',
        adx_scope: 756150000,
        adx_read: true,
      },
    ],
    templates: {},
    forms: [],
    lists: [],
  };
  const imported = initialState(portal, {
    origin: 'https://example.powerappsportals.com',
  });
  const store = await new DataStore({ state: imported }).init();
  assert.equal(imported.permissions.find((p) => p.id === 'global').enabled, true);
  assert.equal(imported.permissions.filter((p) => p.enabled === false).length, 4);
  assert.equal(imported.simulator.importDiagnostics.length, 4);
  assert.equal(store.snapshot().simulator.live.origin, 'https://example.powerappsportals.com');
  assert.deepEqual(store.query('accounts', {}, { roles: ['Member'] }).value, []);
  assert.throws(
    () => store.query('contacts', {}, { roles: ['Member'] }),
    (e) => e.status === 403,
  );
  const broken = store.snapshot();
  broken.permissions.find((p) => p.id === 'parent').enabled = true;
  await assert.rejects(store.replaceState(broken), DataError);
});

test('rows the portal creates carry the observed portal application user as createdby', () => {
  const store = new DataStore({
    state: {
      mappings: { task: { entitySet: 'tasks', idColumn: 'taskid' } },
      tables: { task: [] },
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  });
  assert.equal(store.createRecord('task', { title: 'Before' }, { admin: true }).createdby, undefined);
  store.setObserved({ portalApplicationUser: '# Portals-Sample' });
  assert.deepEqual(store.createRecord('task', { title: 'Portal' }, { admin: true }).createdby, {
    id: null,
    logical_name: 'systemuser',
    name: '# Portals-Sample',
  });
  assert.equal(store.createRecord('task', { title: 'Explicit', createdby: null }, { admin: true }).createdby, null);
});

// One polymorphic lookup (ownerid) with a relationship per target table; 'shared' is held by both targets.
const polymorphicStore = () => {
  const state = emptyState();
  state.mappings = {
    item: {
      entitySet: 'items',
      idColumn: 'itemid',
      relationships: {
        owner_account: { entity: 'account', from: 'ownerid', to: 'accountid', many: false },
        owner_team: { entity: 'team', from: 'ownerid', to: 'teamid', many: false },
      },
    },
    account: { entitySet: 'accounts', idColumn: 'accountid' },
    team: { entitySet: 'teams', idColumn: 'teamid' },
  };
  state.tables = {
    item: [],
    account: [{ accountid: 'a1' }, { accountid: 'shared' }],
    team: [{ teamid: 't1' }, { teamid: 'shared' }],
  };
  return new DataStore({ state });
};
test('a bare id in a polymorphic lookup is checked against the target table that holds it', async () => {
  const store = polymorphicStore();
  const admin = { admin: true };
  await store.create('items', { ownerid: 'a1' }, admin);
  await store.create('items', { ownerid: 't1' }, admin);
  const [byAccount, byTeam] = store.state.tables.item;
  assert.equal(byTeam.ownerid, 't1');
  assert.equal(store.namedReferences(store.resolveMapping('item'), byTeam).ownerid.logical_name, 'team');
  assert.equal(store.namedReferences(store.resolveMapping('item'), byAccount).ownerid.logical_name, 'account');
  await assert.rejects(store.create('items', { ownerid: 'nobody' }, admin), { code: 'InvalidLookup', status: 400 });
  await assert.rejects(store.create('items', { ownerid: 'shared' }, admin), { code: 'InvalidLookup', status: 400 });
  assert.equal(store.state.tables.item.length, 2);
});

// Record data names the logical table of a lookup. A name an object inherits is not a mapped table: each formatter path reads
// it as the unmapped name does and never reads an inherited member of the mappings or tables.
const INHERITED_TABLE_NAMES = ['constructor', 'toString', '__proto__'];
const UNMAPPED_TABLE_NAME = 'invented_unmapped_table';
const LOOKUP_ID = 'a2000000-0000-4000-8000-000000000001';

// A lookup source that records each read of a name it inherits.
function recordInheritedReads(source, reads) {
  return new Proxy(source, {
    get(target, key, receiver) {
      if (typeof key === 'string' && !Object.hasOwn(target, key) && key in target) reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

// The unmapped result with its table name replaced by `name`: the result a table that is not mapped gives, under `name`.
function unmappedResultAs(name, format) {
  const unmapped = format(UNMAPPED_TABLE_NAME);
  return Object.fromEntries(
    Object.entries(unmapped).map(([key, value]) => [key, value === UNMAPPED_TABLE_NAME ? name : value]),
  );
}

test('formatMockRecord reads an inherited table name as an unmapped relationship target', () => {
  for (const name of INHERITED_TABLE_NAMES) {
    const reads = [];
    const mappings = recordInheritedReads({}, reads);
    const tables = recordInheritedReads({}, reads);
    const format = (table) =>
      formatMockRecord(
        { child: { name: 'Invented child' } },
        { relationships: { child: { entity: table, from: 'child', to: 'childid', many: false } } },
        mappings,
        tables,
      );
    assert.deepEqual(format(name), unmappedResultAs(name, format), name);
    assert.deepEqual(reads, [], name);
  }
});

test('normalizeMockLiquidRecord reads an inherited table name as an unmapped relationship target', () => {
  for (const name of INHERITED_TABLE_NAMES) {
    const reads = [];
    const mappings = recordInheritedReads({}, reads);
    const normalize = (table) =>
      normalizeMockLiquidRecord(
        { child: { name: 'Invented child' } },
        { relationships: { child: { entity: table, from: 'child', to: 'childid', many: false } } },
        { mappings },
      );
    assert.deepEqual(normalize(name), normalize(UNMAPPED_TABLE_NAME), name);
    assert.deepEqual(reads, [], name);
  }
});

test('formatMockRecord reads an inherited table name of a lookup value as an unmapped table', () => {
  for (const name of INHERITED_TABLE_NAMES) {
    const reads = [];
    const mappings = recordInheritedReads({}, reads);
    const tables = recordInheritedReads({}, reads);
    const format = (table) => formatMockRecord({ owner: { id: LOOKUP_ID, logical_name: table } }, {}, mappings, tables);
    assert.deepEqual(format(name), unmappedResultAs(name, format), name);
    assert.deepEqual(reads, [], name);
  }
});

test('formatMockRecord reads an inherited table name of a single-valued relationship as an unmapped table', () => {
  for (const name of INHERITED_TABLE_NAMES) {
    const reads = [];
    const mappings = recordInheritedReads({}, reads);
    const tables = recordInheritedReads({}, reads);
    const format = (table) =>
      formatMockRecord(
        { owner: LOOKUP_ID },
        { relationships: { owner: { entity: table, from: 'owner', to: 'ownerid', many: false } } },
        mappings,
        tables,
      );
    assert.deepEqual(format(name), unmappedResultAs(name, format), name);
    assert.deepEqual(reads, [], name);
  }
});

test('normalizeMockLiquidFetchXml reads an inherited FetchXML entity name as an unmapped entity', () => {
  for (const name of INHERITED_TABLE_NAMES) {
    const reads = [];
    const mappings = recordInheritedReads({}, reads);
    const normalize = (entity) =>
      normalizeMockLiquidFetchXml(
        { entities: [{ name: 'Invented row' }] },
        `<fetch><entity name="${entity}"><attribute name="name" /></entity></fetch>`,
        mappings,
      );
    assert.deepEqual(normalize(name), normalize(UNMAPPED_TABLE_NAME), name);
    assert.deepEqual(reads, [], name);
  }
});

// A record column named by an inherited member is a column without metadata: the same result as a column with no metadata
// at all, and no read of the metadata or the alias fields reaches the inherited member.
test('a record column named by an inherited member has no metadata', () => {
  for (const name of INHERITED_TABLE_NAMES) {
    const reads = [];
    const fields = recordInheritedReads({}, reads);
    const aliasFields = recordInheritedReads({}, reads);
    const record = { [name]: 'Invented value' };
    const withoutMetadata = { fields: {} };
    assert.deepEqual(formatMockRecord(record, { fields }), formatMockRecord(record, withoutMetadata), name);
    assert.deepEqual(
      normalizeMockLiquidRecord(record, { fields }, { aliasFields }),
      normalizeMockLiquidRecord(record, withoutMetadata),
      name,
    );
    assert.deepEqual(reads, [], name);
  }
});
