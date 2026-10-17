import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePermissionFetchXml } from '../lib/permission-query.mjs';
import { DataStore } from '../lib/data.mjs';
import { parseXmlDocument, planFetch } from '../lib/fetchxml-engine.mjs';

const identity = { contactId: 'person', roles: ['member'] };
const mappings = Object.fromEntries(['contact', 'access', 'account', 'access_accounts', 'item'].map(entity =>
  [entity, { entitySet: `${entity}s`, idColumn: `${entity}id` }]));
const base = { id: 'access-root', entity: 'access', scope: 'contact', field: 'principal', roles: ['member'], operations: ['read'] };
const account = { id: 'account-grant', entity: 'account', scope: 'parent', parentPermissionId: base.id,
  relationship: { entity: 'access', from: 'accountid', to: 'accessid',
    intersect: { entity: 'access_accounts', from: 'accountid', to: 'accessid' } }, roles: ['member'], operations: ['read'] };
const item = { id: 'item-grant', entity: 'item', scope: 'parent', parentPermissionId: account.id,
  relationship: { entity: 'account', from: 'accountid', to: 'accountid' }, roles: ['member'], operations: ['read'] };
const xml = '<fetch distinct="true"><entity name="item"><attribute name="itemid"/></entity></fetch>';
const compile = (permissions, source = xml, options = {}) => compilePermissionFetchXml(source, { permissions, identity, mappings, ...options });

test('scoped joins use outer parent/intersect paths and alternative terminal identity filters', () => {
  const query = compile([base, account, item]);
  assert.equal(query.permissionGranted, true);
  assert.equal(query.qualification, 'modeled');
  assert.equal(query.authoredXml, xml);
  assert.equal(query.authoredLinkCount, 0);
  assert.equal(query.permissionLinkCount, 3);
  const root = parseXmlDocument(query.xml, { root: 'fetch' }).children[0];
  const filter = root.children.find(node => node.name === 'filter');
  assert.deepEqual(filter.children[0].attrs, Object.assign(Object.create(null), { type: 'or', hint: 'union' }));
  assert.deepEqual(filter.children[0].children[0].attrs, Object.assign(Object.create(null), {
    entityname: 'generated_alias_access_0', attribute: 'principal', operator: 'eq', value: 'person',
  }));
  const parent = root.children.find(node => node.name === 'link-entity');
  assert.equal(parent.attrs.name, 'account');
  const intersect = parent.children[0];
  assert.equal(intersect.attrs.alias, undefined);
  assert.equal(intersect.attrs.intersect, 'true');
  assert.equal(intersect.children[0].attrs.alias, 'generated_alias_access_0');
});

test('executable expanded XML returns the scoped row from raw backend rows without independent intersect grants', () => {
  const store = new DataStore({ state: { mappings, settings: { permissionMode: 'enforce' }, permissions: [base, account, item],
    tables: { contact: [{ contactid: 'person' }], access: [{ accessid: 'grant-a', principal: 'person' }, { accessid: 'grant-b', principal: 'other' }],
      access_accounts: [{ access_accountsid: 'a', accessid: 'grant-a', accountid: 'a' }, { access_accountsid: 'b', accessid: 'grant-b', accountid: 'b' }],
      account: [{ accountid: 'a' }, { accountid: 'b' }], item: [{ itemid: 'one', accountid: 'a' }, { itemid: 'two', accountid: 'b' }] } } });
  const query = compile(store.state.permissions);
  assert.deepEqual(store.fetchXmlCore(query.xml, { admin: true }).entities.map(row => row.itemid), ['one']);
  assert.deepEqual(store.rows('item', identity).map(row => row.itemid), ['one']);
});

test('role union preserves alternatives and deduplicates one identical grant path', () => {
  const alternate = { ...base, id: 'alternate', field: 'reviewer' };
  const alternateAccount = { ...account, id: 'alternate-account', parentPermissionId: alternate.id };
  const alternateItem = { ...item, id: 'alternate-item', parentPermissionId: alternateAccount.id };
  const duplicate = { ...item, id: 'duplicate-item' };
  const query = compile([base, account, item, alternate, alternateAccount, alternateItem, duplicate]);
  assert.equal(query.permissionLinkCount, 6);
  assert.deepEqual(query.grantIds, ['item-grant', 'alternate-item']);
  assert.match(query.xml, /entityname="generated_alias_access_0" attribute="principal"/);
  assert.match(query.xml, /entityname="generated_alias_access_1" attribute="reviewer"/);
});

test('authored alias collision does not overwrite author bindings and budgets include permission paths', () => {
  const authored = '<fetch><entity name="item"><link-entity name="account" from="accountid" to="accountid" alias="generated_alias_account_0"/></entity></fetch>';
  const query = compile([base, account, item], authored);
  assert.equal(query.totalLinkCount, 4);
  assert.deepEqual(parseXmlDocument(query.xml, { root: 'fetch' }).children[0].children.map(element => element.name),
    ['filter', 'link-entity', 'link-entity']);
  assert.match(query.xml, /alias="generated_alias_account_1"/);
  assert.throws(() => planFetch(parseXmlDocument(query.xml, { root: 'fetch' }), { limits: { links: 3 } }), error => error.details?.innerCode === '0x8004430d');
  assert.doesNotThrow(() => planFetch(parseXmlDocument(query.xml, { root: 'fetch' }), { limits: { links: 4 } }));
});

test('direct Self and Account scopes add a filter without inventing a relationship', () => {
  for (const [scope, attribute, expected, visitor] of [
    ['self', 'itemid', 'person', identity], ['account', 'accountid', 'branch', { ...identity, accountId: 'branch' }],
  ]) {
    const query = compile([{ ...base, entity: 'item', scope, field: scope === 'account' ? attribute : undefined }], xml, { identity: visitor });
    assert.equal(query.permissionLinkCount, 0);
    assert.match(query.xml, new RegExp(`attribute="${attribute}" operator="eq" value="${expected}"`));
  }
});

test('global roots and admin bypass do not append restrictive grants', () => {
  const global = { ...item, scope: 'global' };
  assert.equal(compile([base, account, item, global]).permissionLinkCount, 0);
  assert.ok(!compile([base, account, item, global]).xml.includes('<filter'));
  assert.equal(compile([base, account, item, global]).globalPermissionGranted, true);
  assert.equal(compile([base, account, item], xml, { identity: { admin: true } }).xml, xml);
});

test('inactive, missing, nonreadable or cyclic ancestors are not silently granted', () => {
  for (const permissions of [[base, item], [{ ...base, enabled: false }, account, item], [{ ...base, operations: ['update'] }, account, item]]) {
    const query = compile(permissions);
    assert.equal(query.permissionGranted, false);
    assert.equal(query.diagnostics[0].code, 'PERMISSION_QUERY_PATH_UNRESOLVED');
  }
  const cyclic = { ...account, parentPermissionId: item.id, relationship: { entity: 'item', from: 'accountid', to: 'accountid' } };
  assert.throws(() => compile([cyclic, item]), error => error.code === 'InvalidPermission');
});

test('deep alternative grant paths count every generated link and enforce the configured budget', () => {
  const permissions = [base];
  let previous = base;
  for (let depth = 1; depth <= 8; depth++) {
    const child = { id: `node-${depth}`, entity: `level${depth}`, scope: 'parent', roles: ['member'], operations: ['read'],
      parentPermissionId: previous.id, relationship: { entity: previous.entity, from: 'parentid', to: `${previous.entity}id` } };
    permissions.push(child); previous = child;
  }
  const source = '<fetch><entity name="level8"><attribute name="level8id"/></entity></fetch>';
  const query = compile(permissions, source);
  assert.equal(query.permissionLinkCount, 8);
  assert.match(query.xml, /entityname="generated_alias_access_0" attribute="principal"/);
  assert.doesNotThrow(() => planFetch(parseXmlDocument(query.xml, { root: 'fetch' })));
  assert.throws(() => compile(permissions, source, { maxPathDepth: 4 }), error => error.code === 'InvalidPermission');
});

test('reverse and many-to-many identity relationships use the related identity primary key', () => {
  for (const relationship of [
    { entity: 'contact', from: 'itemid', to: 'favoriteitem' },
    { entity: 'contact', from: 'itemid', to: 'contactid', intersect: { entity: 'item_contacts', from: 'itemid', to: 'contactid' } },
  ]) {
    const query = compile([{ ...base, entity: 'item', field: undefined, identityRelationship: relationship }]);
    assert.match(query.xml, /entityname="generated_alias_contact_0" attribute="contactid" operator="eq" value="person"/);
    assert.equal(query.permissionLinkCount, relationship.intersect ? 2 : 1);
  }
});

test('every combination of eight roles matches an independent deep-path CRUD grant oracle', () => {
  const tables = { access: Array.from({ length: 8 }, (_, index) => ({ accessid: `branch-${index}`, [`principal${index}`]: 'person' })) };
  const modelMappings = { access: { entitySet: 'accesses', idColumn: 'accessid' } };
  for (let depth = 1; depth <= 8; depth++) {
    tables[`level${depth}`] = Array.from({ length: 8 }, (_, index) => ({ [`level${depth}id`]: `branch-${index}`, parentid: `branch-${index}` }));
    modelMappings[`level${depth}`] = { entitySet: `levels${depth}`, idColumn: `level${depth}id` };
  }
  const rights = ['read', 'create', 'update', 'delete', 'append', 'appendTo'];
  // The oracle is a bitmask/operation matrix, independent of permission traversal.
  const flags = Array.from({ length: 8 }, (_, index) => rights.filter((_, right) => right === 0 || ((index + 1) & (1 << ((right - 1) % 3)))));
  const permissions = [];
  for (let index = 0; index < 8; index++) {
    let parent = { id: `root-${index}`, entity: 'access', scope: 'contact', field: `principal${index}`, roles: [`role${index}`], operations: ['read'] };
    permissions.push(parent);
    for (let depth = 1; depth <= 8; depth++) {
      const child = { id: `grant-${index}-${depth}`, entity: `level${depth}`, scope: 'parent', roles: [`role${index}`],
        operations: depth === 8 ? flags[index] : ['read'], parentPermissionId: parent.id,
        relationship: { entity: parent.entity, from: 'parentid', to: `${parent.entity}id` } };
      permissions.push(child); parent = child;
    }
  }
  const store = new DataStore({ state: { tables, mappings: modelMappings, permissions, settings: { permissionMode: 'enforce' },
    simulator: { platformOverrides: { QueryLinkEntityLimit: 128,FetchLinkAndFilterLimit:128 } } } });
  const source = '<fetch distinct="true"><entity name="level8"><attribute name="level8id"/></entity></fetch>';
  for (let mask = 0; mask < 256; mask++) {
    const visitor = { contactId: 'person', roles: Array.from({ length: 8 }, (_, index) => index).filter(index => mask & (1 << index)).map(index => `role${index}`) };
    for (const right of rights) {
      const expected = Array.from({ length: 8 }, (_, index) => index).filter(index => mask & (1 << index) && flags[index].includes(right)).map(index => `branch-${index}`).sort();
      const actual = store.tableRows('level8').filter(row => store.allowed('level8', right, row, visitor)).map(row => row.level8id).sort();
      assert.deepEqual(actual, expected, `mask=${mask}, operation=${right}`);
    }
    const query = compilePermissionFetchXml(source, { permissions: store.state.permissions, mappings: store.state.mappings,
      identity: visitor, rules: store.rules.bind(store) });
    assert.equal(query.permissionGranted, Boolean(mask));
    if (mask) {
      const expected = Array.from({ length: 8 }, (_, index) => index).filter(index => mask & (1 << index)).map(index => `branch-${index}`).sort();
      assert.equal(query.permissionLinkCount, visitor.roles.length * 8);
      assert.deepEqual(store.fetchXmlCore(query.xml, { admin: true }).entities.map(row => row.level8id).sort(), expected, `compiled mask=${mask}`);
    }
  }
});

test('observed surviving orphan path ends in its parent lookup not-null and retains preceding outer joins', () => {
  const orphan = { ...account, observedOrphanParent: { field: 'orphanparentid', parentPermissionId: 'inactive' } };
  const query = compile([orphan, item]);
  assert.equal(query.permissionGranted, true);
  assert.equal(query.permissionLinkCount, 1);
  assert.match(query.xml, /entityname="generated_alias_account_0" attribute="orphanparentid" operator="not-null"/);
  assert.ok(query.diagnostics.some(diagnostic => diagnostic.code === 'PERMISSION_OBSERVED_ORPHAN_UNRESTRICTED'));
});

test('an authored linked orphan terminates at its observed lookup instead of reviving the inactive principal path', () => {
  const orphan = { ...account, observedOrphanParent: { field:'orphanparentid',parentPermissionId:base.id } };
  const source='<fetch><entity name="access"><attribute name="accessid"/><link-entity name="item" from="itemid" to="accessid" alias="authored"><attribute name="itemid"/></link-entity></entity></fetch>';
  const query=compile([{...base,enabled:false},{...base,id:'visible-root'},orphan,item],source,{linkedPermissionOrdinals:[0]});
  assert.equal(query.permissionGranted,true);
  assert.equal(query.permissionLinkCount,1);
  assert.match(query.xml,/<link-entity name="account" from="accountid" to="accountid" link-type="any">/);
  assert.match(query.xml,/<condition attribute="orphanparentid" operator="not-null" \/>/);
  assert.ok(!query.xml.includes('<link-entity name="contact"'));
  assert.ok(!query.xml.includes('<link-entity name="access_accounts"'));
});

test('permission serialization preserves authored space-only values and quoted XML text', () => {
  const source = '<fetch><entity name="item"><filter><condition attribute="name" operator="in"><value> </value><value>&lt;&amp;&quot;</value></condition></filter></entity></fetch>';
  const query = compile([base, account, item], source);
  assert.match(query.xml, /<value> <\/value>/);
  const values = parseXmlDocument(query.xml, { root: 'fetch' }).children[0].children[0].children[0].children;
  assert.deepEqual(values.map(element => element.text), [' ', '<&"']);
});

test('scoped query serialization supplies native defaults and orders before filters while preserving explicit distinct', () => {
  const source = '<fetch><entity name="item"><attribute name="itemid"/><filter><condition attribute="name" operator="eq" value="match"/></filter><order attribute="itemid"/></entity></fetch>';
  const query = compile([base, account, item], source);
  const tree = parseXmlDocument(query.xml, { root: 'fetch' });
  assert.equal(tree.attrs.mapping, 'logical');
  assert.equal(tree.attrs.distinct, 'true');
  assert.deepEqual(tree.children[0].children.slice(0, 3).map(element => element.name), ['attribute', 'order', 'filter']);
  const authored = compile([base, account, item], source.replace('<fetch>', '<fetch distinct="false">'));
  assert.equal(parseXmlDocument(authored.xml, { root: 'fetch' }).attrs.distinct, 'false');
  assert.ok(authored.diagnostics.some(diagnostic => diagnostic.code === 'PERMISSION_QUERY_DISTINCT_FALSE_UNQUALIFIED'));
});

test('the permission filter precedes authored links without changing compiler-owned traversal indices', () => {
  const source = '<fetch><entity name="item"><attribute name="itemid"/><link-entity name="tag" from="tagid" to="tagid" alias="authored"/></entity></fetch>';
  const query = compile([base, account, item], source);
  const root = parseXmlDocument(query.xml, {root: 'fetch'}).children[0];
  assert.deepEqual(root.children.map(child => child.name), ['attribute', 'filter', 'link-entity', 'link-entity']);
  assert.equal(root.children[2].attrs.alias, 'authored');
  assert.equal(query.authoredLinkCount, 1);
  assert.deepEqual(query.generatedLinkOrdinals, [1, 2, 3]);
});

test('modeled permission query serialization retains the captured XmlWriter bytes', () => {
  const expected = [
    '<fetch mapping="logical" distinct="true">',
    '  <entity name="item">',
    '    <attribute name="itemid" />',
    '    <filter type="and">',
    '      <filter type="or" hint="union">',
    '        <condition entityname="generated_alias_access_0" attribute="principal" operator="eq" value="person" />',
    '      </filter>',
    '    </filter>',
    '    <link-entity name="account" from="accountid" to="accountid" alias="generated_alias_account_0" link-type="outer">',
    '      <link-entity name="access_accounts" from="accountid" to="accountid" link-type="outer" visible="false" intersect="true">',
    '        <link-entity name="access" from="accessid" to="accessid" alias="generated_alias_access_0" link-type="outer" />',
    '      </link-entity>',
    '    </link-entity>',
    '  </entity>',
    '</fetch>',
  ].join('\r\n');
  assert.equal(compile([base, account, item]).xml, expected);
});

test('default distinct removes repeated rows from multiple qualifying parent and membership paths', () => {
  const store = new DataStore({ state: { mappings, permissions: [base, account, item], tables: {
    access: [{ accessid: 'first', principal: 'person' }, { accessid: 'second', principal: 'person' }],
    access_accounts: [{ access_accountsid: 'a', accountid: 'a', accessid: 'first' }, { access_accountsid: 'b', accountid: 'a', accessid: 'second' }],
    account: [{ accountid: 'a' }], item: [{ itemid: 'one', accountid: 'a' }],
  }, settings: { permissionMode: 'enforce' } } });
  const source = '<fetch><entity name="item"><attribute name="itemid"/></entity></fetch>';
  const query = compile(store.state.permissions, source);
  assert.deepEqual(store.fetchXmlCore(query.xml, { admin: true }).entities.map(row => row.itemid), ['one']);
});

test('the parentId compatibility field keeps row authorization bound to its named parent grant', () => {
  const parent = { id: 'owned', entity: 'account', scope: 'contact', field: 'owner', roles: ['member'], operations: ['read'] };
  const child = { id: 'child', entity: 'item', scope: 'parent', parentId: parent.id,
    relationship: { entity: 'account', from: 'accountid', to: 'accountid' }, roles: ['member'], operations: ['read'] };
  const store = new DataStore({ state: { mappings, settings: { permissionMode: 'enforce' },
    permissions: [parent, child, { ...parent, id: 'independent-global', scope: 'global' }],
    tables: { account: [{ accountid: 'own', owner: 'person' }, { accountid: 'other', owner: 'other' }],
      item: [{ itemid: 'one', accountid: 'own' }, { itemid: 'two', accountid: 'other' }] } } });
  assert.deepEqual(store.rows('item', identity).map(row => row.itemid), ['one']);
  assert.equal(store.allowed('item', 'read', store.tableRows('item')[1], identity), false);
  assert.deepEqual(store.fetchXml(xml, identity).entities, [{ itemid: 'one' }]);
  const query = compilePermissionFetchXml(xml, { permissions: store.state.permissions, mappings, identity });
  assert.deepEqual(store.fetchXmlCore(query.xml, { admin: true }).entities, [{ itemid: 'one' }]);
});

test('permission-expanded execution retains string whitespace in value elements', () => {
  const store = new DataStore({ state: { mappings, settings: { permissionMode: 'enforce' },
    permissions: [{ ...base, entity: 'item', field: 'owner' }],
    tables: { item: [{itemid: 'leading', owner: 'person', name: ' leading'},
      {itemid: 'plain', owner: 'person', name: 'leading'}, {itemid: 'space', owner: 'person', name: ' '}] } } });
  const source = '<fetch><entity name="item"><attribute name="itemid"/><filter><condition attribute="name" operator="in"><value> leading</value><value> </value></condition></filter></entity></fetch>';
  assert.deepEqual(store.fetchXml(source, identity).entities.map(row => row.itemid).sort(), ['leading', 'space']);
});
