// @test-kind security: Local masked-column confidentiality: TDS applies the Web API operand rule (0x80041155); no native parity claim.
// A column the caller reads masked (column security with a masking rule, no CanReadUnmasked) is never a filter, join,
// grouping, distinct, order or aggregate operand on either endpoint, so a right and a wrong guess of the clear value answer
// alike. COUNT only counts presence; the select list shows the masked value. Invented schema, loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { tdsLogin, tdsQuery, utf16 } from './support/tds-client.mjs';
import { APPS, startSecuredOrganization } from './support/secured-reads.mjs';

const MESSAGE = 'Filtering on masked attributes without the read unmasked column permission is not allowed.';
const SECRET = 'TOP-SECRET-123';
const ITEM = '77777777-7777-4777-8777-000000000001';
const ERROR = 0xaa;

// The operand forms the rule covers, each with the clear value as the guess where it takes one.
const REFUSED = [
  `SELECT x_name FROM x_item WHERE x_secret = '${SECRET}'`,
  `SELECT x_name FROM x_item WHERE x_secret LIKE 'TOP%'`,
  `SELECT x_name FROM x_item WHERE LEFT(x_secret, 3) = 'TOP'`,
  'SELECT x_name FROM x_item WHERE x_secret IS NOT NULL',
  'SELECT x_name FROM x_item ORDER BY x_secret',
  'SELECT x_secret FROM x_item ORDER BY 1',
  'SELECT MAX(x_secret) AS m FROM x_item',
  'SELECT COUNT(DISTINCT x_secret) AS n FROM x_item',
  'SELECT x_secret, COUNT(*) AS n FROM x_item GROUP BY x_secret',
  "SELECT COUNT(*) AS n FROM x_item HAVING MIN(x_secret) > ''",
  'SELECT DISTINCT x_secret FROM x_item',
  'SELECT x_secret FROM x_item UNION SELECT x_secret FROM x_item',
  'SELECT a.x_name FROM x_item a JOIN x_item b ON a.x_secret = b.x_secret',
  `SELECT d.s FROM (SELECT x_secret AS s FROM x_item) d WHERE d.s = '${SECRET}'`,
  `SELECT a.x_name FROM x_item a WHERE EXISTS (SELECT 1 AS one FROM x_item b WHERE b.x_name = a.x_secret)`,
];
const ALLOWED = [
  'SELECT x_name, x_secret FROM x_item',
  'SELECT COUNT(x_secret) AS n FROM x_item',
  'SELECT UPPER(x_secret) AS u FROM x_item',
  'SELECT x_secret FROM x_item UNION ALL SELECT x_name FROM x_item',
  "SELECT x_name FROM x_item WHERE x_name = 'Invented' ORDER BY x_name",
];

const col = (name, sqlType) => ({ name, sqlType, length: 100, precision: null, scale: null, nullable: true });
const catalog = {
  tables: new Map([
    [
      'x_item',
      {
        logicalName: 'x_item',
        columns: [col('x_itemid', 'uniqueidentifier'), col('x_name', 'nvarchar'), col('x_secret', 'nvarchar')],
      },
    ],
  ]),
};
const run = (sql, masked) =>
  executeBatch(sql, {
    catalog,
    scan: async () => [{ x_itemid: ITEM, x_name: 'Invented', x_secret: '***********123' }],
    maskedColumns: () => masked,
  });

test('the evaluator refuses every operand form of a masked column and keeps the projection forms', async () => {
  for (const sql of REFUSED) {
    await assert.rejects(run(sql, new Set(['x_secret'])), { message: MESSAGE }, sql);
    await run(sql, null); // the same statement runs when the column is not masked
  }
  for (const sql of ALLOWED) await run(sql, new Set(['x_secret']));
});

test('a masked column is refused as an operand alike on the Web API and TDS; a right and a wrong guess answer alike', async () => {
  const certificate = createSelfSignedCertificate();
  const harness = await startSecuredOrganization({
    envPrefix: 'PAQ_TDS_MASKED',
    apps: APPS,
    tls: certificate,
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_secret: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } },
        },
      },
    },
  });
  try {
    const { store, call, transport, tokens } = harness;
    await store.transact(() => {
      store.state.tables.x_item = [
        { x_itemid: ITEM, x_name: 'Invented', x_secret: SECRET, statecode: 0, statuscode: 1 },
      ];
      const user = store.state.tables.systemuser.find(
        (row) => String(row.applicationid ?? '').toLowerCase() === APPS.customizer.appId,
      );
      const id = (n) => `77777777-7777-4777-8777-0000000000${n}`;
      (store.state.tables.fieldsecurityprofile ??= []).push({ fieldsecurityprofileid: id('a1'), name: 'Invented' });
      (store.state.tables.systemuserprofiles ??= []).push({
        systemuserprofileid: id('a2'),
        systemuserid: { id: user.systemuserid },
        fieldsecurityprofileid: { id: id('a1') },
      });
      (store.state.tables.fieldpermission ??= []).push({
        fieldpermissionid: id('a3'),
        fieldsecurityprofileid: { id: id('a1') },
        entityname: 'x_item',
        attributelogicalname: 'x_secret',
        cancreate: 0,
        canread: 4,
        canupdate: 0,
        canreadunmasked: 0,
      });
      (store.state.tables.maskingrule ??= []).push({
        maskingruleid: id('b1'),
        name: 'x_InventedLastThree',
        regularexpression: '.(?=.{3})',
        maskedcharacter: '*',
      });
      (store.state.tables.attributemaskingrule ??= []).push({
        attributemaskingruleid: id('b2'),
        entityname: 'x_item',
        attributelogicalname: 'x_secret',
        maskingruleid: { id: id('b1'), logical_name: 'maskingrule' },
      });
    });

    // Web API: the read is masked, and the operand forms answer 400 0x80041155 for a right and a wrong guess alike.
    const read = await call('customizer', 'GET', 'x_items?$select=x_secret');
    assert.equal(read.body.value[0].x_secret, '***********123');
    for (const query of [
      (guess) => `x_items?$filter=x_secret eq '${guess}'`,
      (guess) => `x_items?$filter=startswith(x_secret,'${guess.slice(0, 3)}')`,
      () => 'x_items?$orderby=x_secret',
      () => 'x_items?$apply=groupby((x_secret))',
    ]) {
      const right = await call('customizer', 'GET', query(SECRET));
      const wrong = await call('customizer', 'GET', query('WRONG-GUESS-00'));
      assert.equal(right.status, 400, query(SECRET));
      assert.equal(right.body.error.code, '0x80041155', query(SECRET));
      assert.equal(right.text, wrong.text, 'a right and a wrong guess answer alike');
    }

    // TDS: the same rule, reported as error 50000 with the Web API message, and never the clear value.
    const login = await tdsLogin(transport.tdsPort, tokens.customizer, certificate.cert);
    try {
      const { client } = login;
      const projected = await tdsQuery(client, 'SELECT x_name, x_secret FROM x_item');
      assert.notEqual(projected.indexOf(utf16('***********123')), -1, 'the select list shows the masked value');
      assert.equal(projected.indexOf(utf16(SECRET)), -1, 'the clear value never leaves the endpoint');
      for (const sql of REFUSED) {
        const reply = await tdsQuery(client, sql);
        assert.equal(reply[0], ERROR, sql);
        assert.equal(reply.readUInt32LE(3), 50000, sql);
        assert.notEqual(reply.indexOf(utf16(MESSAGE)), -1, sql);
      }
      const right = await tdsQuery(client, `SELECT x_name FROM x_item WHERE x_secret = '${SECRET}'`);
      const wrong = await tdsQuery(client, `SELECT x_name FROM x_item WHERE x_secret = 'WRONG-GUESS-00'`);
      assert.equal(right.equals(wrong), true, 'a right and a wrong guess answer alike');
      for (const sql of ALLOWED) assert.notEqual((await tdsQuery(client, sql))[0], ERROR, sql);
    } finally {
      login.client.close();
    }
  } finally {
    await harness.close();
  }
});
