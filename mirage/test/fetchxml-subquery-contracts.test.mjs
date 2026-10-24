import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { observedConfig } from '../lib/project-config.mjs';

function fixture() {
  return new DataStore({
    state: {
      settings: { permissionMode: 'enforce' },
      mappings: { parent: { idColumn: 'parentid' }, child: { idColumn: 'childid' }, leaf: { idColumn: 'leafid' } },
      tables: {
        parent: [{ parentid: 'p' }],
        child: [
          { childid: 'a', parentid: 'p' },
          { childid: 'b', parentid: 'p' },
        ],
        leaf: [{ leafid: 'last', childid: 'b' }],
      },
    },
  });
}
const query = (link) => `<fetch><entity name="parent"><attribute name="parentid"/>${link}</entity></fetch>`;
const subquery = (type, inside = '') =>
  `<link-entity name="child" from="parentid" to="parentid" alias="c" link-type="${type}">${inside}</link-entity>`;

test('backend subquery joins reject unsupported projections and order clauses, including descendant selections', () => {
  const store = fixture();
  for (const type of ['exists', 'in', 'matchfirstrowusingcrossapply']) {
    const disallowed = [
      ...(['exists', 'in'].includes(type) ? ['<attribute name="childid"/>', '<all-attributes/>'] : []),
      '<order attribute="childid"/>',
      '<link-entity name="leaf" from="childid" to="childid"><attribute name="leafid"/></link-entity>',
      '<link-entity name="leaf" from="childid" to="childid"><order attribute="leafid"/></link-entity>',
    ];
    for (const selection of disallowed)
      assert.throws(
        () => store.fetchXml(query(subquery(type, selection)), { admin: true }),
        (error) => error.status === 400 && error.details?.innerCode === '0x80041121',
      );
    assert.equal(
      store.fetchXml(query(subquery(type, '<link-entity name="leaf" from="childid" to="childid"/>')), { admin: true })
        .entities.length,
      1,
    );
  }
  assert.throws(
    () =>
      store.fetchXml(
        query(
          subquery(
            'matchfirstrowusingcrossapply',
            '<attribute name="childid"/><link-entity name="leaf" from="childid" to="childid"/>',
          ),
        ),
        { admin: true },
      ),
    (error) => error.details?.innerCode === '0x80041121',
  );
});

test('crossapply chooses a candidate after its unprojected descendants qualify it', () => {
  const store = fixture();
  assert.deepEqual(
    store.fetchXml(
      query(subquery('matchfirstrowusingcrossapply', '<link-entity name="leaf" from="childid" to="childid"/>')),
      { admin: true },
    ).entities,
    [{ parentid: 'p' }],
  );
});

test('ALL existence retains descendant joins while ignoring only its own filter', () => {
  const store = fixture();
  store.state.tables.parent.push({ parentid: 'q' });
  store.state.tables.child.push({ childid: 'c', parentid: 'q' });
  const source = query(
    '<filter>' +
      subquery(
        'all',
        '<filter><condition attribute="childid" operator="eq" value="a"/></filter><link-entity name="leaf" from="childid" to="childid"/>',
      ) +
      '</filter>',
  );
  assert.deepEqual(store.fetchXml(source, { admin: true }).entities, [{ parentid: 'p' }]);
});

test('an evidenced unfiltered ALL failure remains separate from modeled and filtered quantifiers', () => {
  const store = fixture(),
    source = query('<filter>' + subquery('all') + '</filter>');
  assert.deepEqual(store.fetchXml(source, { admin: true }).entities, []);
  store.setObserved(
    observedConfig({
      fetchAllWithoutFilter: 'sql-error',
      evidence: 'Invented unfiltered ALL execution failure profile',
    }),
  );
  assert.throws(
    () => store.fetchXml(source, { admin: true }),
    (error) => error.status === 500 && error.details.innerCode === '0x80044150',
  );
  const filtered = query(
    '<filter>' +
      subquery('all', '<filter><condition attribute="childid" operator="eq" value="missing"/></filter>') +
      '</filter>',
  );
  assert.deepEqual(store.fetchXml(filtered, { admin: true }).entities, [{ parentid: 'p' }]);
  store.setObserved({
    tablePermissionQueryPipeline: 'native-classic',
    fetchAllWithoutFilter: 'sql-error',
    evidence: 'Invented denial-before-backend control',
  });
  const denied = store.fetchXml(source, { contactId: 'visitor', roles: [] }, { portalRequest: true });
  assert.equal(denied.backendAdmission, 'denied-before-dataverse');
  assert.deepEqual(denied.entities, []);
  assert.throws(() => observedConfig({ fetchAllWithoutFilter: 'sql-error' }), /evidence/);
});
