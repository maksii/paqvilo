// @test-kind observation: the request the Power Pages PCF host sends for utils.getEntityMetadata and the portal's answers, captured on a Power Pages site 2026-11-26 (paqvilo-developer pcf-parity summary-A2 Q4, summary-A3 Q-R1, metadata-raw-admin2-1795684424035.json, capture na1 metadata)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { handleWebApi } from '../lib/webapi-handler.mjs';
import {
  isPortalEntityDefinitionsPath,
  portalEntityDefinition,
  portalEntityDefinitionColumns,
} from '../lib/portal-entity-definitions.mjs';

const ORIGIN = 'http://127.0.0.1:5000';
const CSRF = 'fixture-token';
const field = (dataverseType) => ({ dataverseType });
const metadata = createMetadataService({
  organizationId: '00000000-0000-4000-8000-000000000001',
  schema: null,
  mappings: {
    tst_row: {
      entitySet: 'tst_rows',
      idColumn: 'tst_rowid',
      nameColumn: 'tst_title',
      fields: { tst_title: field('nvarchar'), tst_choice: field('picklist') },
    },
    tst_local: { entitySet: 'tst_locals', idColumn: 'tst_localid', fields: { tst_name: field('nvarchar') } },
  },
});
// tst_row is in the exported Solution metadata; tst_local only in the local mappings. No Webapi site setting is needed.
const PORTAL = { settings: {}, webApiEntities: { tst_row: { fields: {} } } };
const contact = { id: 'c0000000-0000-4000-8000-000000000001', contactId: 'c0000000-0000-4000-8000-000000000001' };
const administrator = { ...contact, roles: ['Administrators'] };
const member = { ...contact, roles: ['Authenticated Users'] };
// The headers the host sends with its metadata request (no anti-forgery token).
const hostHeaders = (table = 'tst_row') => ({
  'pcf-entity-logical-name': table,
  'x-requested-with': 'XMLHttpRequest',
  'content-type': 'application/json',
  accept: '*/*',
});
const NO_ENTITY_METADATA = {
  status: 404,
  body: { error: { code: '9004010C', message: 'Resource not found for the segment EntityMetadata.' } },
};
const captured = (columns, table = 'tst_row') =>
  `/_api/EntityDefinitions(LogicalName='${table}')?$expand=Attributes($filter=${columns
    .map((name) => `LogicalName%20eq%20%27${name}%27`)
    .join('%20or%20')})`;
const read = (path, identity = contact, method = 'GET') =>
  portalEntityDefinition({
    method,
    url: new URL(path, ORIGIN),
    origin: ORIGIN,
    identity,
    metadata,
    portal: PORTAL,
    headers: hostHeaders(),
  });

/** The portal envelope the Web API handler writes for a request, and the diagnostics it reports. */
async function viaHandler(
  path,
  { identity = contact, method = 'GET', headers = hostHeaders(), entityMetadata = () => metadata } = {},
) {
  let written;
  const diagnostics = [];
  await handleWebApi({ method, headers }, {}, new URL(path, ORIGIN), {
    store: {},
    portal: PORTAL,
    identity,
    csrf: CSRF,
    origin: ORIGIN,
    entityMetadata,
    json: (_res, status, body) => {
      written = { status, body };
    },
    onError: (cause) => diagnostics.push(cause.details?.permissionDiagnostic?.code ?? cause.code),
  });
  return { ...written, diagnostics };
}

test('the captured EntityDefinitions shape returns the table metadata with the requested attributes only', async () => {
  const { status, body } = await read(captured(['tst_title', 'tst_choice']));
  assert.equal(status, 200);
  assert.equal(body['@odata.context'], `${ORIGIN}/api/data/v9.1/$metadata#EntityDefinitions(Attributes())/$entity`);
  assert.equal(body.LogicalName, 'tst_row');
  assert.equal(body.EntitySetName, 'tst_rows');
  assert.equal(body.PrimaryIdAttribute, 'tst_rowid');
  assert.equal(body.PrimaryNameAttribute, 'tst_title');
  assert.ok(body.MetadataId && body.DisplayName?.UserLocalizedLabel);
  assert.ok(Array.isArray(body.Privileges) && body.Privileges.some((item) => /^prvRead/.test(item.Name)));
  assert.deepEqual(
    body.Attributes.map((attribute) => [attribute['@odata.type'], attribute.LogicalName, attribute.AttributeType]),
    [
      ['#Microsoft.Dynamics.CRM.PicklistAttributeMetadata', 'tst_choice', 'Picklist'],
      ['#Microsoft.Dynamics.CRM.StringAttributeMetadata', 'tst_title', 'String'],
    ],
  );
  assert.ok(body.Attributes.every((attribute) => attribute.MetadataId));
  assert.ok(body.Attributes[0].OptionSet);
  assert.deepEqual(
    (await read(captured(['tst_title']))).body.Attributes.map((attribute) => attribute.LogicalName),
    ['tst_title'],
  );
  assert.deepEqual(portalEntityDefinitionColumns(new URL(captured(['a', 'b']), ORIGIN).searchParams), ['a', 'b']);
});

test('without the pcf-entity-logical-name header every contact gets 404 EntityMetadata; with it a non-administrator reads', async () => {
  for (const identity of [administrator, member]) {
    for (const headers of [
      { accept: 'application/json' },
      { accept: 'application/json', __requestverificationtoken: CSRF },
    ])
      assert.deepEqual(
        (({ status, body }) => ({ status, body }))(await viaHandler(captured(['tst_title']), { identity, headers })),
        NO_ENTITY_METADATA,
      );
    assert.equal((await viaHandler(captured(['tst_title']), { identity })).status, 200);
  }
});

const UNSUPPORTED = {
  status: 400,
  body: { error: { code: '9004010A', message: 'An unexpected error occurred while processing the request' } },
};

// @test-kind unproven+contract: Paqvilo answers only the captured EntityDefinitions shape and keeps every other metadata path refused with the portal envelope; the native answers for these other paths are not captured
test('only the captured EntityDefinitions shape is answered; other metadata paths stay refused', async () => {
  assert.equal(isPortalEntityDefinitionsPath('/_api/EntityDefinitions'), true);
  assert.equal(isPortalEntityDefinitionsPath("/_api/entitydefinitions(LogicalName='tst_row')"), true);
  assert.equal(isPortalEntityDefinitionsPath('/_api/tst_rows'), false);
  // The quote encoded as %27 is the same request.
  assert.equal((await viaHandler('/_api/EntityDefinitions(LogicalName=%27tst_row%27)')).status, 200);
  for (const path of [
    '/_api/EntityDefinitions',
    "/_api/EntityDefinitions(LogicalName='tst_row')/Attributes",
    '/_api/EntityDefinitions(00000000-0000-0000-0000-000000000001)',
    "/_api/entitydefinitions(LogicalName='tst_row')",
    "/_api/EntityDefinitions(logicalname='tst_row')",
    "/_api/EntityDefinitions(LogicalName='TST_ROW')",
    "/_api/EntityDefinitions(LogicalName='tst_row')?$select=LogicalName",
    "/_api/EntityDefinitions(LogicalName='tst_row')?$expand=Attributes",
    "/_api/EntityDefinitions(LogicalName='tst_row')?$expand=Keys",
    "/_api/EntityDefinitions(LogicalName='tst_row')?$expand=Attributes($select=LogicalName)",
    "/_api/EntityDefinitions(LogicalName='tst_row')?$expand=attributes($filter=logicalname%20eq%20%27tst_title%27)",
    "/_api/EntityDefinitions(LogicalName='tst_row')?$expand=Attributes($filter=LogicalName%20eq%20%27TST_TITLE%27)",
    `${captured(['tst_title'])}&$select=LogicalName`,
    `${captured(['tst_title'])}&$expand=Attributes`,
  ])
    assert.deepEqual((await viaHandler(path)).status, UNSUPPORTED.status, path);
  assert.deepEqual(
    (({ status, body }) => ({ status, body }))(await viaHandler(`${captured(['tst_title'])}&$select=LogicalName`)),
    UNSUPPORTED,
  );
  // A write with a valid token is refused, as is a write without one.
  assert.equal(
    (
      await viaHandler(captured(['tst_title']), {
        method: 'POST',
        headers: { ...hostHeaders(), __requestverificationtoken: CSRF },
      })
    ).status,
    405,
  );
  assert.equal((await viaHandler(captured(['tst_title']), { method: 'DELETE' })).status, 401);
  await assert.rejects(read(captured(['tst_title']), contact, 'DELETE'), { status: 405 });
});

// @test-kind unproven: Mirage's local parts of the access rule (a signed-in contact, the header naming the requested table, a table in the exported Solution metadata); an anonymous visitor cannot be tested on the private capture sites
test('anonymous visitors, a header naming another table and unknown or unexported tables are refused', async () => {
  const anonymous = await viaHandler(captured(['tst_title']), { identity: { id: null, roles: [] } });
  assert.equal(anonymous.status, 403);
  assert.deepEqual(anonymous.diagnostics, ['PCF_ENTITY_DEFINITIONS_LOCAL_ACCESS']);
  const refusal = { ...NO_ENTITY_METADATA, diagnostics: ['PCF_ENTITY_DEFINITIONS_LOCAL_ACCESS'] };
  assert.deepEqual(await viaHandler(captured(['tst_title']), { headers: hostHeaders('tst_local') }), refusal);
  // Unknown and not exported tables get the same answer as a missing header.
  for (const table of ['tst_missing', 'tst_local'])
    assert.deepEqual(await viaHandler(captured(['tst_name'], table), { headers: hostHeaders(table) }), refusal, table);
  assert.deepEqual(await viaHandler(captured(['tst_title']), { entityMetadata: () => null }), refusal);
});

// @test-kind contract: on a running local portal the organization metadata family stays refused and only the EntityDefinitions read reaches the new route (a table outside the exported Solution metadata is refused like any other)
test('a running portal keeps RelationshipDefinitions, GlobalOptionSetDefinitions and $metadata refused', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-entity-definitions-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), ['adx_websiteid: site', 'adx_name: Example'].join('\n'));
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    ['adx_webpageid: home', 'adx_name: Home', 'adx_partialurl: /'].join('\n'),
  );
  const contactId = '77777777-7777-4777-8777-777777777774';
  const app = ownedClose(
    t,
    await createSimulator({
      sourceDir: dir,
      stateFile: path.join(dir, 'state.json'),
      watch: false,
      initial: {
        version: 1,
        mappings: {
          x_item: { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: { dataverseType: 'nvarchar' } } },
          contact: { entitySet: 'contacts', idColumn: 'contactid', fields: {} },
        },
        tables: { x_item: [], contact: [{ contactid: contactId }] },
        permissions: [],
        settings: { permissionMode: 'enforce' },
        simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] },
      },
    }),
  );
  const cookie = signInHeaders(app, contactId, { roles: ['Member'] }).cookie;
  const token = /value="([^"]+)"/.exec(
    await (await fetch(`${app.url}/_layout/tokenhtml`, { headers: { cookie } })).text(),
  )[1];
  const call = async (method, route) => {
    const response = await fetch(`${app.url}/_api/${route}`, {
      method,
      headers: { cookie, __RequestVerificationToken: token, 'pcf-entity-logical-name': 'x_item' },
    });
    return [response.status, (await response.json()).error?.code];
  };
  assert.deepEqual(await call('GET', 'RelationshipDefinitions'), [400, '9004010A']);
  assert.deepEqual(await call('GET', 'GlobalOptionSetDefinitions'), [400, '9004010A']);
  assert.deepEqual(await call('GET', '$metadata'), [404, '9004010C']);
  // x_item is not in the exported Solution metadata: the shared refusal.
  assert.deepEqual(
    await call(
      'GET',
      "EntityDefinitions(LogicalName='x_item')?$expand=Attributes($filter=LogicalName%20eq%20%27x_name%27)",
    ),
    [404, '9004010C'],
  );
  assert.deepEqual(await call('POST', "EntityDefinitions(LogicalName='x_item')"), [405, 'InvalidOperation']);
});
