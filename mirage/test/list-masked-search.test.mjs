// List quick search and sort over a view that shows a masked column. A masked column is left out of the search `like`
// set and is SortDisabled in the view layout, so a search or a sort request never sends an operand the portal read refuses
// with 0x80041155 (native-services.mjs gridMasked; portal-authorization.mjs maskedColumn, the assertOperands rule).
// The portal's own search/sort over a masked view column is not observed natively, so this is a guess. Both data models.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { executeGridQuery } from '../lib/native-services.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ITEM = '78787878-7878-4787-8787-787878787881',
  MEMBER = '78787878-7878-4787-8787-787878787801',
  RULE = '78787878-7878-4787-8787-787878787883';
const text = { dataverseType: 'nvarchar' },
  secured = { ...text, columnMetadata: { isSecured: true } };
const fields = { x_name: text, x_secret: secured, x_code: secured };
const identity = { id: 'alex', contactId: 'alex', roles: ['Member'] };
const model = {
  kind: 'list',
  entity: 'x_item',
  idColumn: 'x_itemid',
  primaryName: 'x_name',
  settings: {},
  pageSize: 10,
  search: { enabled: true },
  userFilters: {},
  filter: {},
  views: [
    {
      id: 'v',
      fetchXml:
        '<fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_secret"/><attribute name="x_code"/></entity></fetch>',
      fields: [{ name: 'x_name' }, { name: 'x_secret' }, { name: 'x_code' }],
    },
  ],
};

async function grid(t, enhanced) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'list-masked-search-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'website.yml'),
    `adx_websiteid: 78787878-7878-4787-8787-787878787878\nadx_name: Invented\nadx_enhancedauthorization: ${enhanced ? 3 : 0}`,
  );
  await fs.writeFile(
    path.join(dir, 'webrole.yml'),
    `- adx_webroleid: ${MEMBER}
  adx_name: Member`,
  );
  const sim = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 's.json'),
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name', fields },
      },
      tables: {
        contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
        x_item: [{ x_itemid: ITEM, x_name: 'Item', x_secret: 'XS-1234', x_code: 'C-77', statecode: 0 }],
        maskingrule: [{ maskingruleid: RULE, name: 'r', regularexpression: '.(?=.{4})', maskedcharacter: '*' }],
        attributemaskingrule: [
          {
            attributemaskingruleid: '78787878-7878-4787-8787-787878787884',
            entityname: 'x_item',
            attributelogicalname: 'x_secret',
            maskingruleid: { id: RULE, logical_name: 'maskingrule' },
          },
        ],
      },
      permissions: [{ id: 'i', name: 'I', entity: 'x_item', roles: ['Member'], operations: ['read'], scope: 'global' }],
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        live: {},
        endpoints: [],
        contactRoles: [{ contactId: 'alex', roleId: MEMBER }],
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  if (enhanced) {
    // The mapped user reads both secured columns (CanRead All); a portal read never sends UnMaskedData, so x_secret stays masked.
    await sim.store.portalAuthorization.prepare(identity);
    const user = sim.store.tableRows('systemuser').find((row) => row.systemmanagedusertype === 1);
    await sim.store.transact(() => {
      const tables = sim.store.state.tables,
        profile = { id: '78787878-7878-4787-8787-787878787820', logical_name: 'fieldsecurityprofile' };
      tables.fieldsecurityprofile.push({ fieldsecurityprofileid: profile.id, name: 'Invented readers' });
      for (const [index, column] of ['x_secret', 'x_code'].entries())
        tables.fieldpermission.push({
          fieldpermissionid: `78787878-7878-4787-8787-78787878783${index}`,
          fieldsecurityprofileid: profile,
          entityname: 'x_item',
          attributelogicalname: column,
          canread: 4,
          cancreate: 0,
          canupdate: 0,
          canreadunmasked: 3,
        });
      tables.systemuserprofiles.push({
        systemuserprofileid: '78787878-7878-4787-8787-787878787822',
        systemuserid: { id: user.systemuserid, logical_name: 'systemuser' },
        fieldsecurityprofileid: profile,
      });
    });
  }
  const context = {
    portal: { website: {} },
    store: sim.store,
    identity,
    metadata: { tables: { x_item: { fields } } },
    config: {},
    readProvider: { fetchXml: (x, i) => sim.store.fetchXml(x, i, { portalRequest: true }) },
  };
  return (request) => executeGridQuery(model, { page: 1, ...request }, context);
}

for (const [label, enhanced] of [
  ['standard', false],
  ['enhanced', true],
]) {
  test(`${label} model: list search and sort over a view showing a masked column never refuse; the masked column is SortDisabled`, async (t) => {
    const query = await grid(t, enhanced);
    const plain = await query({});
    assert.deepEqual(
      plain.layout.Columns.map((column) => [column.LogicalName, column.SortDisabled]),
      [
        ['x_name', false],
        ['x_secret', true],
        ['x_code', false],
      ],
      'the list UI offers no sort on the masked column',
    );
    assert.deepEqual(
      plain.rows.map((row) => [row.x_secret, row.x_code]),
      [['***1234', 'C-77']],
    );
    const values = async (request) => (await query(request)).rows.map((row) => row.x_secret);
    assert.deepEqual(await values({ search: 'Item' }), ['***1234'], 'a search returns the masked rows');
    assert.deepEqual(
      await values({ search: 'C-7' }),
      ['***1234'],
      'a readable secured column without a masking rule stays searchable',
    );
    assert.deepEqual(
      await values({ search: 'XS' }),
      [],
      'the masked column is not searched (no oracle on the clear value)',
    );
    assert.deepEqual(
      await values({ sortExpression: 'x_secret ASC' }),
      ['***1234'],
      'a sort request on the masked column is dropped, not answered 400',
    );
    assert.deepEqual(await values({ sortExpression: 'x_code DESC' }), ['***1234']);
  });
}
