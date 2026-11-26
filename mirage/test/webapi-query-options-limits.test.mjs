// Portal /_api: query options the portal does not serve are refused, never ignored, and a JSON body over the host's
// limit answers through the Web API error envelope.
// @test-kind unproven: the portal's answer to savedQuery and userQuery is not captured; Power Pages read operations list neither
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '77777777-7777-4777-8777-777777777771';
const CONTACT = '77777777-7777-4777-8777-777777777774';

async function portal(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-query-options-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'web-pages'));
  await fs.writeFile(path.join(dir, 'website.yml'), `adx_websiteid: ${SITE}\nadx_name: Example`);
  await fs.writeFile(
    path.join(dir, 'web-pages', 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  await fs.writeFile(
    path.join(dir, 'sitesetting.yml'),
    [
      ['Webapi/x_item/enabled', 'true'],
      ['Webapi/x_item/fields', 'x_name,x_note'],
    ]
      .map(
        ([name, value], i) =>
          `- adx_sitesettingid: 77777777-7777-4777-8777-77777777778${i}\n  adx_name: ${name}\n  adx_value: "${value}"`,
      )
      .join('\n'),
  );
  const initial = {
    version: 1,
    mappings: {
      x_item: {
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_note: { dataverseType: 'memo' } },
      },
      contact: {
        entitySet: 'contacts',
        idColumn: 'contactid',
        nameColumn: 'fullname',
        fields: { fullname: { dataverseType: 'nvarchar' } },
      },
    },
    tables: {
      x_item: ['alpha', 'alpha', 'beta'].map((x_name, i) => ({
        x_itemid: `77777777-7777-4777-8777-00000000000${i}`,
        x_name,
      })),
      contact: [{ contactid: CONTACT, fullname: 'Invented Visitor' }],
    },
    permissions: [{ id: 'all', entity: 'x_item', scope: 'global', roles: ['Member'], operations: ['read', 'create'] }],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] },
  };
  const app = ownedClose(
    t,
    await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false }),
  );
  const cookie = signInHeaders(app, CONTACT, { roles: ['Member'] }).cookie;
  const token = /value="([^"]+)"/.exec(
    await (await fetch(`${app.url}/_layout/tokenhtml`, { headers: { cookie } })).text(),
  )[1];
  return async (method, route, body) => {
    const response = await fetch(`${app.url}/_api/${route}`, {
      method,
      headers: {
        cookie,
        __RequestVerificationToken: token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
    });
    return { status: response.status, json: await response.json() };
  };
}

test('savedQuery and userQuery are refused with 400 9004010A instead of answering unfiltered rows', async (t) => {
  const call = await portal(t);
  for (const query of [
    'savedQuery=11111111-1111-4111-8111-111111111111',
    'userQuery=11111111-1111-4111-8111-111111111111',
    'savedQuery=not-a-guid',
  ]) {
    for (const route of [
      `x_items?${query}`,
      `x_items/$count?${query}`,
      `x_items?${query}&fetchXml=${encodeURIComponent('<fetch><entity name="x_item"/></fetch>')}`,
      `x_items(77777777-7777-4777-8777-000000000000)/x_name?${query}`,
      `x_items(77777777-7777-4777-8777-000000000000)/x_name/$value?${query}`,
    ]) {
      const answer = await call('GET', route);
      assert.deepEqual([answer.status, answer.json.error.code], [400, '9004010A'], route);
    }
  }
});

// @test-kind contract: the local portal publishes no organization metadata, multipart batch or management operations
test('portal rejects organization metadata, batch, functions, actions and configuration tables', async (t) => {
  const call = await portal(t);
  for (const [method, route, status, code] of [
    ['GET', '$metadata', 404, '9004010C'],
    ['GET', 'EntityDefinitions', 400, '9004010A'],
    ['POST', '$batch', 404, '9004010C'],
    ['GET', 'WhoAmI()', 400, '9004010A'],
    ['POST', 'x_items(77777777-7777-4777-8777-000000000000)/Microsoft.Dynamics.CRM.Assign', 404, '9004010C'],
    ['GET', 'adx_contentsnippets', 404, '9004010E'],
  ]) {
    const answer = await call(method, route);
    assert.deepEqual([answer.status, answer.json.error.code], [status, code], `${method} ${route}`);
  }
});

// @test-kind contract: Paqvilo's portal $apply runs its transformations (Power Pages read operations document $apply)
test('$apply groups and aggregates the rows rather than being ignored', async (t) => {
  const call = await portal(t);
  const grouped = await call('GET', 'x_items?$apply=groupby((x_name))');
  assert.equal(grouped.status, 200);
  assert.deepEqual(
    grouped.json.value.map((row) => row.x_name),
    ['alpha', 'beta'],
  );
  const filtered = await call('GET', "x_items?$apply=filter(x_name eq 'beta')/groupby((x_name))");
  assert.deepEqual(filtered.json.value, [{ x_name: 'beta' }]);
});

// @test-kind contract: the host's JSON body limit answers as the Web API request limit does (413 0x8004418a)
test('a JSON body over 8 MiB answers 413 0x8004418a through the Web API error envelope', async (t) => {
  const call = await portal(t);
  const answer = await call(
    'POST',
    'x_items',
    JSON.stringify({ x_name: 'big', x_note: 'x'.repeat(8 * 1024 * 1024 + 1) }),
  );
  assert.equal(answer.status, 413);
  assert.deepEqual(answer.json.error, { code: '0x8004418a', message: 'Request message length is too large.' });
});
