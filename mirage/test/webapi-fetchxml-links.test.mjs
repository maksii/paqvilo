import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { handleWebApi } from '../lib/webapi-handler.mjs';

const visitor = { contactId: 'person', roles: ['reader'] };
const api = { portalRequest: true, profile: 'webapi' };
function fixture(observed) {
  const store = new DataStore({
    state: {
      settings: { permissionMode: 'enforce' },
      mappings: {
        parent: { entitySet: 'parents', idColumn: 'parentid' },
        child: { entitySet: 'children', idColumn: 'childid' },
      },
      tables: {
        parent: [{ parentid: 'one' }, { parentid: 'two' }],
        child: [
          { childid: 'a', parentid: 'one' },
          { childid: 'b', parentid: 'one' },
        ],
      },
      permissions: ['parent', 'child'].map((entity) => ({
        id: entity,
        entity,
        scope: 'global',
        roles: ['reader'],
        operations: ['read'],
      })),
    },
  });
  store.setObserved(observed);
  return store;
}
const query = (type, distinct = '', projection = '') =>
  `<fetch ${distinct}><entity name="parent"><attribute name="parentid"/><link-entity name="child" from="parentid" to="parentid" alias="c" link-type="${type}">${projection}</link-entity></entity></fetch>`;
const profile = observedConfig({
  webApiFetchXmlLinkTypes: 'portal-classic',
  evidence: 'Synthetic portal transport contract; fixture contains no native rows',
});

test('Web API preserves omitted DISTINCT, explicit values, and complete projected join tuples', () => {
  const store = fixture();
  for (const distinct of ['', 'distinct="false"', 'distinct="0"'])
    assert.equal(store.fetchXml(query('inner', distinct), visitor, api).entities.length, 2);
  assert.equal(store.fetchXml(query('inner', 'distinct="true"'), visitor, api).entities.length, 1);
  assert.equal(store.fetchXml(query('outer'), visitor, api).entities.length, 3);
  assert.deepEqual(
    store.fetchXml(query('inner', 'distinct="true"', '<attribute name="childid"/>'), visitor, api).entities,
    [
      { parentid: 'one', 'c.childid': 'a' },
      { parentid: 'one', 'c.childid': 'b' },
    ],
  );
  assert.equal(
    store.fetchXml(query('inner'), visitor, { portalRequest: true }).entities.length,
    1,
    'Liquid retains its separately modeled default',
  );
});

test('qualified portal link conversion retains ordinary multiplicity and aliases without changing SDK execution', () => {
  const store = fixture(profile);
  for (const type of ['exists', 'in', 'matchfirstrowusingcrossapply']) {
    assert.equal(store.fetchXml(query(type), visitor, api).entities.length, 2, type);
    assert.equal(store.fetchXml(query(type, 'distinct="true"'), visitor, api).entities.length, 1, type);
    assert.equal(store.fetchXml(query(type, 'distinct="false"'), { admin: true }).entities.length, 1, 'SDK ' + type);
  }
  assert.deepEqual(
    store.fetchXml(query('matchfirstrowusingcrossapply', '', '<attribute name="childid"/>'), visitor, api).entities,
    [
      { parentid: 'one', 'c.childid': 'a' },
      { parentid: 'one', 'c.childid': 'b' },
    ],
  );
  assert.equal(
    fixture().fetchXml(query('exists', 'distinct="false"'), visitor, api).entities.length,
    1,
    'unqualified sites retain Dataverse semantics',
  );
});

test('qualified portal filter rejection is distinct from backend quantifier semantics', () => {
  const store = fixture(profile);
  for (const type of ['not any', 'all', 'not all']) {
    const source = `<fetch><entity name="parent"><attribute name="parentid"/><filter><link-entity name="child" from="parentid" to="parentid" link-type="${type}"/></filter></entity></fetch>`;
    assert.throws(
      () => store.fetchXml(source, visitor, api),
      (error) => error.status === 400 && error.details.innerCode === '0x8004111c',
    );
    assert.doesNotThrow(() => store.fetchXml(source, { admin: true }));
  }
  const any =
    '<fetch><entity name="parent"><attribute name="parentid"/><filter><link-entity name="child" from="parentid" to="parentid" link-type="any"/></filter></entity></fetch>';
  assert.deepEqual(store.fetchXml(any, visitor, api).entities, [{ parentid: 'one' }]);
  assert.throws(() => observedConfig({ webApiFetchXmlLinkTypes: 'portal-classic' }), /evidence/);
});

test('Liquid has an independently qualified subquery fallback that retains projections and links', () => {
  const store = fixture(
    observedConfig({
      liquidFetchXmlLinkTypes: 'portal-classic',
      evidence: 'Invented Liquid authoring conversion fixture',
    }),
  );
  for (const type of ['exists', 'in', 'matchfirstrowusingcrossapply']) {
    const source = query(type, 'distinct="false"', '<attribute name="childid"/>');
    const result = store.fetchXml(source, visitor, { portalRequest: true });
    assert.deepEqual(result.entities, [
      { parentid: 'one', 'c.childid': 'a' },
      { parentid: 'one', 'c.childid': 'b' },
    ]);
    assert.equal(result.permissionQuery.authoredLinkCount, 1);
    assert.ok(
      !result.xml.includes('link-type='),
      'The native writer represents its fallback as an implicit inner join',
    );
    if (type !== 'matchfirstrowusingcrossapply')
      assert.throws(
        () => store.fetchXml(source, { admin: true }),
        (error) => error.details?.innerCode === '0x80041121',
      );
  }
  assert.throws(() => observedConfig({ liquidFetchXmlLinkTypes: 'portal-classic' }), /evidence/);
});

test('Web API handler keeps FetchXML tuples while OData expansion retains root collection cardinality', async () => {
  const store = fixture(profile);
  store.state.mappings.parent.relationships = {
    children: { entity: 'child', from: 'parentid', to: 'parentid', many: true },
  };
  const read = async (params) => {
    let status, body;
    const response = {
      headersSent: false,
      writeHead(code) {
        status = code;
        this.headersSent = true;
      },
      end(text) {
        body = JSON.parse(text);
      },
    };
    const url = new URL('http://127.0.0.1/_api/parents');
    url.search = new URLSearchParams(params).toString();
    await handleWebApi({ method: 'GET', headers: {} }, response, url, {
      store,
      identity: visitor,
      portal: {
        settings: {
          'Webapi/parent/enabled': 'true',
          'Webapi/parent/fields': 'parentid',
          'Webapi/child/enabled': 'true',
          'Webapi/child/fields': 'childid,parentid',
        },
      },
      origin: url.origin,
      origins: [url.origin],
      csrf: 'synthetic-cursor',
      json(res, code, value) {
        res.writeHead(code);
        res.end(JSON.stringify(value));
      },
    });
    assert.equal(status, 200, JSON.stringify(body));
    return body.value;
  };
  assert.equal((await read({ fetchXml: query('inner') })).length, 2);
  const tuples = await read({ fetchXml: query('inner', 'distinct="true"', '<attribute name="childid"/>') });
  assert.deepEqual(
    tuples.map((row) => row['c.childid']),
    ['a', 'b'],
  );
  assert.equal(
    (await read({ fetchXml: query('exists', '', '<attribute name="childid"/>') })).length,
    2,
    'portal conversion precedes backend validation',
  );
  assert.equal(
    (await read({ fetchXml: query('matchfirstrowusingcrossapply', '', '<attribute name="childid"/>') })).length,
    2,
  );
  const roots = await read({ $select: 'parentid', $expand: 'children($select=childid)' });
  assert.equal(roots.length, 2);
  assert.deepEqual(
    roots.map((row) => row.children.length),
    [2, 0],
  );
});
