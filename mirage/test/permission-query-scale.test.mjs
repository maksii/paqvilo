import test from 'node:test';
import assert from 'node:assert/strict';
import {DataStore} from '../lib/data.mjs';
import {parseXmlDocument} from '../lib/fetchxml-engine.mjs';
import {compilePermissionFetchXml} from '../lib/permission-query.mjs';

function fixture() {
  const identity = {contactId: 'person', roles: ['A', 'B', 'C', 'D']};
  const principals = Array.from({length: 1000}, (_, index) => ({principalid: `principal-${index}`,
    ...Object.fromEntries(identity.roles.map((role, selected) => [role.toLowerCase() + 'contact', index === selected ? 'person' : 'other'])),
  }));
  const rules = identity.roles.flatMap(role => [
    {id: `principal-${role}`, entity: 'principal', scope: 'contact', field: role.toLowerCase() + 'contact', roles: [role], operations: ['read']},
    {id: `folder-${role}`, entity: 'folder', scope: 'parent', parentPermissionId: `principal-${role}`, roles: [role], operations: ['read'],
      relationship: {entity: 'principal', from: 'folderid', to: 'principalid', intersect: {entity: 'folder_principal', from: 'folderid', to: 'principalid'}}},
    {id: `item-${role}`, entity: 'item', scope: 'parent', parentPermissionId: `folder-${role}`, roles: [role], operations: ['read'],
      relationship: {entity: 'folder', from: 'folderid', to: 'folderid'}},
  ]);
  const store = new DataStore({state: {
    mappings: Object.fromEntries(['contact', 'principal', 'folder', 'folder_principal', 'item'].map(entity => [entity, {idColumn: entity + 'id', entitySet: entity + 's'}])),
    tables: {contact: [{contactid: 'person'}, {contactid: 'other'}], principal: principals,
      folder: [{folderid: 'folder'}], item: [{itemid: 'item', folderid: 'folder'}],
      folder_principal: principals.map(row => ({folder_principalid: 'edge-' + row.principalid, folderid: 'folder', principalid: row.principalid})),
    }, permissions: rules, settings: {permissionMode: 'enforce', fetchJoinRowLimit: 50},
  }});
  return {store, identity};
}

test('distinct permission unions prune private principal paths without changing observable XML or local safety bounds', () => {
  const {store, identity} = fixture();
  const result = store.fetchXml('<fetch><entity name="item"><attribute name="itemid"/></entity></fetch>', identity);
  assert.deepEqual(result.entities, [{itemid: 'item'}]);
  assert.equal(result.permissionQuery.permissionLinkCount, 12);
  assert.ok(result.stats.joinedRows <= 50);
  const tree = parseXmlDocument(result.xml, {root: 'fetch'});
  const links = [];
  const collect = node => {if (node.name === 'link-entity') links.push(node); for (const child of node.children) collect(child);};
  collect(tree);
  assert.equal(links.length, 12);
  assert.ok(links.every(link => link.children.every(child => child.name !== 'filter')), 'Optimization stays outside recorded query XML');
  assert.throws(() => store.fetchXml('<fetch distinct="false"><entity name="item"><attribute name="itemid"/></entity></fetch>', identity),
    error => error.code === 'UnsupportedQuery' && error.details.limit === 50,
    'Non-distinct authoring retains its multiplicity and intermediate row bound');
});

test('changed observer principal predicates cannot reuse stale candidate restrictions', () => {
  const {store, identity} = fixture();
  store.setPluginPipeline(context => {
    if (context.stage === 20) context.query.query = context.query.query.replaceAll('value="person"', 'value="other"');
  }, ({operation}) => operation === 'retrievemultiple');
  assert.throws(() => store.fetchXml('<fetch><entity name="item"><attribute name="itemid"/></entity></fetch>', identity),
    error => error.code === 'UnsupportedQuery' && error.details.limit === 50);
});

test('observer conditions on generated ancestors retain the full join evaluation', () => {
  const {store, identity} = fixture();
  store.setPluginPipeline(context => {
    if (context.stage === 20) context.query.query = context.query.query.replace('</entity>',
      '<filter><condition entityname="generated_alias_folder_0" attribute="folderid" operator="not-null"/></filter></entity>');
  }, ({operation}) => operation === 'retrievemultiple');
  assert.throws(() => store.fetchXml('<fetch><entity name="item"><attribute name="itemid"/></entity></fetch>', identity),
    error => error.code === 'UnsupportedQuery' && error.details.limit === 50);
});

test('private path pruning preserves distinct results for every overlapping role subset', () => {
  const {store, identity} = fixture();
  // Keep the independent full join evaluation bounded while including matches,
  // unrelated principals, disjoint folders and overlapping projection edges.
  store.state.tables.principal = store.state.tables.principal.slice(0, 7);
  store.state.tables.folder = [{folderid: 'one'}, {folderid: 'two'}, {folderid: 'three'}];
  store.state.tables.item = store.state.tables.folder.flatMap(folder =>
    [0, 1].map(index => ({itemid: folder.folderid + index, folderid: folder.folderid})));
  store.state.tables.folder_principal = store.state.tables.folder.flatMap((folder, index) =>
    store.state.tables.principal.filter((_, position) => position >= index).map(row =>
      ({folder_principalid: folder.folderid + row.principalid, folderid: folder.folderid, principalid: row.principalid})));
  store.state.settings.fetchJoinRowLimit = 100000;
  const source = '<fetch><entity name="item"><attribute name="itemid"/><order attribute="itemid"/></entity></fetch>';
  for (let mask = 1; mask < 16; mask++) {
    const visitor = {...identity, roles: identity.roles.filter((_, index) => mask & (1 << index))};
    const compiled = compilePermissionFetchXml(source, {permissions: store.state.permissions,
      mappings: store.state.mappings, identity: visitor, rules: store.rules.bind(store)});
    const optimized = store.fetchXml(source, visitor);
    const full = store.fetchXmlCore(compiled.xml, visitor, {permissionQuery: {...compiled, generatedTerminalConditions: []}});
    assert.deepEqual(optimized.entities, full.entities, `Role subset ${mask}`);
    assert.equal(optimized.xml, compiled.xml);
    assert.ok(optimized.stats.joinedRows <= full.stats.joinedRows);
  }
});

test('distinct queries retain an explicitly ordered primary key in the SDK paging cookie', () => {
  const first = '10000000-0000-0000-0000-000000000001';
  const second = '10000000-0000-0000-0000-000000000002';
  const store = new DataStore({state: {
    mappings: {widget: {idColumn: 'widgetid', entitySet: 'widgets'}},
    tables: {widget: [{widgetid: first, owner: 'person'}, {widgetid: second, owner: 'person'}]},
    permissions: [{id: 'own', entity: 'widget', scope: 'contact', field: 'owner', roles: ['Reader'], operations: ['read']}],
    settings: {permissionMode: 'enforce'},
  }});
  const result = store.fetchXml('<fetch count="1" distinct="true"><entity name="widget"><attribute name="widgetid"/><order attribute="widgetid"/></entity></fetch>',
    {contactId: 'person', roles: ['Reader']});
  assert.equal(result.paging_cookie, `<cookie page="1"><widgetid last="{${first}}" first="{${first}}" /></cookie>`);
  assert.equal(result.more_records, true);
});

test('observer references to unaliased permission intersections keep full path semantics', () => {
  const {store, identity} = fixture();
  store.state.tables.principal = store.state.tables.principal.slice(0, 3);
  store.state.tables.folder_principal = store.state.tables.folder_principal.slice(0, 3);
  store.state.settings.fetchJoinRowLimit = 10000;
  const visitor = {...identity, roles: ['A', 'B']};
  const source = '<fetch><entity name="item"><attribute name="itemid"/></entity></fetch>';
  const extra = '<filter><condition entityname="folder_principal" attribute="principalid" operator="eq" value="principal-2"/></filter>';
  const compiled = compilePermissionFetchXml(source, {permissions: store.state.permissions,
    mappings: store.state.mappings, identity: visitor, rules: store.rules.bind(store)});
  const changed = compiled.xml.replace('</entity>', extra + '</entity>');
  const full = store.fetchXmlCore(changed, visitor, {permissionQuery: {...compiled, generatedTerminalConditions: []}});
  assert.deepEqual(full.entities, [{itemid: 'item'}], 'A different role path grants the root while the first intersection condition matches');
  store.setPluginPipeline(event => {
    if (event.stage === 20) event.query.query = event.query.query.replace('</entity>', extra + '</entity>');
  }, ({operation}) => operation === 'retrievemultiple');
  assert.deepEqual(store.fetchXml(source, visitor).entities, full.entities);
});
