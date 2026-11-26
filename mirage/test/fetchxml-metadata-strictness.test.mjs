// Incomplete metadata in the FetchXML and relationship path: for each metadata diagnostic, the strict mode refuses and the
// default mode reports the diagnostic and continues, as lib/fetchxml-engine.mjs and lib/data.mjs document it.
//   FETCHXML_COLUMN_UNKNOWN     complete metadata lacks the column: portal reports and runs; settings.fetchColumnValidation
//                               "strict" and a Dataverse caller refuse (400, 0x80041103)
//   FETCHXML_COLUMN_UNVERIFIED  the table's metadata is incomplete and no row has the column: the portal reports and runs,
//                               under strict too; a Dataverse caller refuses
//   FETCHXML_ATTRIBUTE_IGNORED  an undeclared FetchXML attribute: the portal profile reports and runs; the webapi and sdk
//                               profiles (strict) refuse (400 InvalidFetchXml)
//   unknown link-entity table   has no lenient mode: every caller is refused (404 UnknownEntity)
//   CASCADE_DELETE_DEFAULTED    has no strict mode: RemoveLink is applied and recorded, whatever the column validation
// @test-kind contract: the strict and default metadata modes are Paqvilo's designed behaviour (fetchxml-engine.mjs assertColumn and validateNodeSchema, data.mjs querySettings and noteCascadeDefault)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function store({ complete = true, settings = {}, cascade } = {}) {
  const metadata = (fields) => (complete ? { schemaComplete: true, fieldMetadata: fields } : {});
  const relationship = cascade === undefined ? {} : { cascade };
  return new DataStore({
    state: {
      mappings: {
        x_account: {
          entitySet: 'x_accounts',
          idColumn: 'x_accountid',
          nameColumn: 'x_name',
          ...metadata({ x_accountid: { dataverseType: 'uniqueidentifier' }, x_name: { dataverseType: 'nvarchar' } }),
          relationships: {
            x_contact_account: {
              entity: 'x_contact',
              from: 'x_accountid',
              to: 'x_accountref',
              many: true,
              schemaName: 'x_contact_account',
              ...relationship,
            },
          },
        },
        x_contact: {
          entitySet: 'x_contacts',
          idColumn: 'x_contactid',
          nameColumn: 'x_fullname',
          ...metadata({
            x_contactid: { dataverseType: 'uniqueidentifier' },
            x_fullname: { dataverseType: 'nvarchar' },
            x_accountref: { dataverseType: 'lookup', targets: ['x_account'] },
          }),
          relationships: {
            x_accountref: {
              entity: 'x_account',
              from: 'x_accountref',
              to: 'x_accountid',
              many: false,
              schemaName: 'x_contact_account',
              ...relationship,
            },
          },
        },
      },
      tables: {
        x_account: [{ x_accountid: G(1), x_name: 'Invented account' }],
        x_contact: [
          { x_contactid: G(11), x_fullname: 'Invented contact', x_accountref: { id: G(1), logical_name: 'x_account' } },
        ],
      },
      settings: { permissionMode: 'permissive', ...settings },
    },
  });
}

const PORTAL = { admin: true };
const DATAVERSE = { admin: true, dataverse: true };
const codes = (result) => (result.diagnostics ?? []).map((entry) => entry.code);
const refusedWith = (status, code, innerCode) => (error) => {
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  if (innerCode) assert.equal(error.details?.innerCode, innerCode);
  return true;
};
const account = (inner) => `<fetch><entity name="x_account"><attribute name="x_name"/>${inner}</entity></fetch>`;
// The unknown column in each position the engine checks.
const UNKNOWN_COLUMN = {
  attribute: account('<attribute name="x_nosuch"/>'),
  condition: account('<filter><condition attribute="x_nosuch" operator="null"/></filter>'),
  order: account('<order attribute="x_nosuch"/>'),
  join: account('<link-entity name="x_contact" from="x_nosuch" to="x_accountid" link-type="outer"/>'),
};

test('FETCHXML_COLUMN_UNKNOWN: the default portal mode reports and runs; strict and a Dataverse caller refuse', () => {
  const lenient = store();
  const strict = store({ settings: { fetchColumnValidation: 'strict' } });
  for (const [use, xml] of Object.entries(UNKNOWN_COLUMN)) {
    const result = lenient.fetchXml(xml, PORTAL);
    assert.equal(result.entities.length, 1, use);
    assert.deepEqual(
      result.diagnostics.map(({ code, attribute, use: at }) => [code, attribute, at]),
      [['FETCHXML_COLUMN_UNKNOWN', 'x_nosuch', use]],
    );
    assert.throws(() => strict.fetchXml(xml, PORTAL), refusedWith(400, 'InvalidFetchXml', '0x80041103'), use);
    assert.throws(() => lenient.fetchXml(xml, DATAVERSE), refusedWith(400, 'InvalidFetchXml', '0x80041103'), use);
  }
});

test('FETCHXML_COLUMN_UNVERIFIED: incomplete metadata reports and runs for the portal, strict included; a Dataverse caller refuses', () => {
  const xml = UNKNOWN_COLUMN.condition;
  for (const settings of [{}, { fetchColumnValidation: 'strict' }]) {
    const result = store({ complete: false, settings }).fetchXml(xml, PORTAL);
    assert.equal(result.entities.length, 1);
    assert.deepEqual(codes(result), ['FETCHXML_COLUMN_UNVERIFIED']);
  }
  assert.throws(
    () => store({ complete: false }).fetchXml(xml, DATAVERSE),
    refusedWith(400, 'InvalidFetchXml', '0x80041103'),
  );
  // A column a stored row holds is known without metadata.
  assert.deepEqual(codes(store({ complete: false }).fetchXml(account(''), PORTAL)), []);
});

test('FETCHXML_ATTRIBUTE_IGNORED: the portal profile reports and runs; the strict webapi and sdk profiles refuse', () => {
  const xml = '<fetch><entity name="x_account"><attribute name="x_name" x_invented="1"/></entity></fetch>';
  const lenient = store().fetchXml(xml, PORTAL);
  assert.equal(lenient.entities.length, 1);
  assert.deepEqual(
    lenient.diagnostics.map(({ code, element, attribute }) => [code, element, attribute]),
    [['FETCHXML_ATTRIBUTE_IGNORED', 'attribute', 'x_invented']],
  );
  for (const options of [{ profile: 'webapi' }, { sdkResult: true }])
    assert.throws(
      () => store().fetchXml(xml, PORTAL, options),
      (error) => refusedWith(400, 'InvalidFetchXml')(error) && /x_invented/.test(error.message),
      JSON.stringify(options),
    );
});

test('an unknown link-entity table has no lenient mode: every caller and setting refuses it', () => {
  const xml = account('<link-entity name="x_nosuchtable" from="x_accountid" to="x_accountid"/>');
  for (const settings of [{}, { fetchColumnValidation: 'strict' }])
    for (const identity of [PORTAL, DATAVERSE])
      assert.throws(() => store({ settings }).fetchXml(xml, identity), refusedWith(404, 'UnknownEntity'));
});

test('CASCADE_DELETE_DEFAULTED has no strict mode: RemoveLink applies and is recorded under either column validation', async () => {
  for (const settings of [{}, { fetchColumnValidation: 'strict' }]) {
    const defaulted = store({ settings });
    await defaulted.remove('x_account', G(1), { admin: true });
    assert.equal(defaulted.state.tables.x_contact[0].x_accountref, null, 'the lookup is cleared (RemoveLink)');
    assert.deepEqual(
      defaulted.cascadeDiagnostics().map(({ code, table, referencing, column }) => [code, table, referencing, column]),
      [['CASCADE_DELETE_DEFAULTED', 'x_account', 'x_contact', 'x_accountref']],
    );
  }
  // An imported CascadeDelete is applied without the diagnostic.
  const configured = store({ cascade: { delete: 'Restrict' } });
  await assert.rejects(configured.remove('x_account', G(1), { admin: true }), (error) => error.status === 405);
  assert.deepEqual(configured.cascadeDiagnostics(), []);
});
