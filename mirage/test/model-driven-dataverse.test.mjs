// The organization API and the model-driven shell must use one transactional store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from './model-driven-fixture.mjs';

const APP_ID = '99999999-9999-4999-8999-999999999991';
const WEBSITE = '11111111-1111-4111-8111-111111111111';
const SNIPPET = '55555555-5555-4555-8555-555555555555';
const SETTING = '66666666-6666-4666-8666-666666666666';
const BASE = '/api/data/v9.2';

async function json(response, expected = 200) {
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : null;
}

async function connect(sim, existingSecret) {
  const csrf = sim.csrf;
  const secret =
    existingSecret ??
    (
      await json(
        await fetch(`${sim.url}/_sim/api/dataverse/applications`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
          body: JSON.stringify({
            appId: APP_ID,
            displayName: 'Invented model app client',
            roles: ['System Administrator'],
          }),
          signal: AbortSignal.timeout(10000),
        }),
        201,
      )
    ).secret;
  const issued = await json(
    await fetch(`${sim.dataverse.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: secret,
        scope: `${sim.dataverse.origin}/.default`,
      }),
      signal: AbortSignal.timeout(10000),
    }),
  );
  const org = (method, suffix, body, headers = {}) =>
    fetch(`${sim.dataverse.origin}${BASE}${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  const ui = (method, entity, id, body, etag) =>
    fetch(`${sim.url}/_apps/api/tables/${entity}${id ? `/${id}` : ''}`, {
      method,
      headers: {
        'x-sim-csrf': csrf,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(etag ? { 'if-match': etag } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
  const entityPath = (entity, id) => `/${sim.store.resolveMapping(entity).entitySet}${id ? `(${id})` : ''}`;
  const portal = async () => {
    const response = await fetch(sim.url + '/', { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    return response.text();
  };
  return { secret, org, ui, entityPath, portal };
}

async function sourceSnapshot(directory) {
  const files = {};
  const visit = async (relative) => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else files[name] = await fs.readFile(path.join(directory, name), 'utf8');
    }
  };
  await visit('');
  return files;
}

test('organization and shell ordinary CRUD share rows, audit values and optimistic concurrency', async (t) => {
  const { sim } = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  const { org, ui } = await connect(sim);
  const created = await json(
    await org('POST', '/x_items', { x_name: 'API item', x_quantity: 3 }, { prefer: 'return=representation' }),
    201,
  );
  const id = created.x_itemid;
  const first = await json(await ui('GET', 'x_item', id));
  assert.equal(first.row.x_quantity, 3);
  assert.equal(first.etag, created['@odata.etag']);
  const updated = await json(await ui('PATCH', 'x_item', id, { x_quantity: 5 }, first.etag));
  const afterUi = await json(await org('GET', `/x_items(${id})`));
  assert.equal(afterUi.x_quantity, 5);
  assert.equal(afterUi['@odata.etag'], updated.etag);
  const system = sim.store.state.tables.systemuser.find((row) => row.fullname === 'SYSTEM');
  assert.ok(system, 'the local administrative principal exists');
  assert.equal(afterUi._modifiedby_value, system.systemuserid);
  await json(await org('PATCH', `/x_items(${id})`, { x_quantity: 9 }, { 'if-match': first.etag }), 412);
  await json(await org('PATCH', `/x_items(${id})`, { x_quantity: 6 }, { 'if-match': updated.etag }), 204);
  await json(await ui('PATCH', 'x_item', id, { x_quantity: 7 }, updated.etag), 412);
  const latest = await json(await ui('GET', 'x_item', id));
  await json(await ui('DELETE', 'x_item', id, undefined, latest.etag));
  await json(await org('GET', `/x_items(${id})`), 404);
  const fromUi = await json(await ui('POST', 'x_item', null, { x_name: 'Shell item', x_quantity: 4 }), 201);
  const apiRead = await json(await org('GET', `/x_items(${fromUi.row.x_itemid})`));
  assert.equal(apiRead.x_name, 'Shell item');
  await json(await org('DELETE', `/x_items(${fromUi.row.x_itemid})`), 204);
  await json(await ui('GET', 'x_item', fromUi.row.x_itemid), 404);
});

test('enhanced source tables retain transactional management reads and writes with virtual metadata', async (t) => {
  const { sim } = await modelDrivenFixture(t, { dataModel: 'enhanced', dataverse: { enabled: true } });
  const { org, ui, entityPath, portal } = await connect(sim);
  const website = sim.store.resolveMapping('mspp_website');
  assert.equal(website.tableType, 'Virtual');
  assert.equal(website.modelDrivenSource, true);
  const grid = await json(await ui('GET', 'mspp_website'));
  assert.equal(grid.rows.length, 1);
  assert.equal(grid.rows[0].mspp_websiteid, WEBSITE);
  await json(await org('GET', entityPath('mspp_website', WEBSITE)));
  const snippet = await json(await ui('GET', 'mspp_contentsnippet', SNIPPET));
  await json(await ui('PATCH', 'mspp_contentsnippet', SNIPPET, { mspp_value: 'Enhanced source edit' }, snippet.etag));
  assert.match(await portal(), /Enhanced source edit/);
  const edited = await json(await org('GET', entityPath('mspp_contentsnippet', SNIPPET)));
  assert.equal(edited.mspp_value, 'Enhanced source edit');
  const created = await json(
    await org(
      'POST',
      entityPath('mspp_sitesetting'),
      { mspp_name: 'Invented/New', mspp_value: 'Value' },
      { prefer: 'return=representation' },
    ),
    201,
  );
  const id = created.mspp_sitesettingid;
  const setting = await json(await ui('GET', 'mspp_sitesetting', id));
  assert.equal(setting.row.mspp_value, 'Value');
  await json(await ui('DELETE', 'mspp_sitesetting', id, undefined, setting.etag));
  await json(await org('GET', entityPath('mspp_sitesetting', id)), 404);
  await json(await org('DELETE', entityPath('mspp_website', WEBSITE)), 501);
  // An ordinary virtual table still needs its declared provider.
  sim.store.state.mappings.x_item.tableType = 'Virtual';
  const missing = await json(await org('GET', '/x_items'), 501);
  assert.match(missing.error.message, /Virtual table 'x_item' has no data provider/);
});

test('source customization writes cross API, shell and rendered portal, persist on restart and never modify exports', async (t) => {
  const fixture = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  const before = await sourceSnapshot(fixture.sourceDir);
  const client = await connect(fixture.sim);
  const snippet = client.entityPath('adx_contentsnippet', SNIPPET);
  await json(await client.org('PATCH', snippet, { adx_value: 'Organization customization' }), 204);
  const current = await json(await client.ui('GET', 'adx_contentsnippet', SNIPPET));
  assert.equal(current.row.adx_value, 'Organization customization');
  assert.match(await client.portal(), /Organization customization/);
  const orgRow = await json(await client.org('GET', snippet));
  assert.equal(orgRow['@odata.etag'], current.etag);
  const edited = await json(
    await client.ui('PATCH', 'adx_contentsnippet', SNIPPET, { adx_value: 'Shell customization' }, current.etag),
  );
  const latest = await json(await client.org('GET', snippet));
  assert.equal(latest.adx_value, 'Shell customization');
  assert.equal(latest['@odata.etag'], edited.etag);
  assert.match(await client.portal(), /Shell customization/);
  assert.deepEqual(await sourceSnapshot(fixture.sourceDir), before);
  await fixture.sim.close();
  const restarted = await fixture.start();
  t.after(() => restarted.close());
  const again = await connect(restarted, client.secret);
  assert.equal(
    (await json(await again.org('GET', again.entityPath('adx_contentsnippet', SNIPPET)))).adx_value,
    'Shell customization',
  );
  assert.equal((await json(await again.ui('GET', 'adx_contentsnippet', SNIPPET))).row.adx_value, 'Shell customization');
  assert.match(await again.portal(), /Shell customization/);
  assert.deepEqual(await sourceSnapshot(fixture.sourceDir), before);
});

test('projected record creates and deletes are shared, with primary website protection on the organization API', async (t) => {
  const { sim } = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  const { org, ui, entityPath } = await connect(sim);
  const made = await json(
    await org(
      'POST',
      entityPath('adx_sitesetting'),
      { adx_name: 'Example/Shared', adx_value: 'From API' },
      { prefer: 'return=representation' },
    ),
    201,
  );
  const id = made.adx_sitesettingid;
  const current = await json(await ui('GET', 'adx_sitesetting', id));
  assert.equal(current.row.adx_value, 'From API');
  assert.equal(current.row.adx_websiteid?.id ?? current.row.adx_websiteid, WEBSITE);
  await json(await ui('DELETE', 'adx_sitesetting', id, undefined, current.etag));
  await json(await org('GET', entityPath('adx_sitesetting', id)), 404);
  assert.equal(sim.store.state.simulator.modelDriven.records[`sitesetting/${id}`], null);
  const before = await json(await org('GET', entityPath('adx_website', WEBSITE)));
  await json(await org('DELETE', entityPath('adx_website', WEBSITE)), 501);
  const after = await json(await org('GET', entityPath('adx_website', WEBSITE)));
  assert.equal(after['@odata.etag'], before['@odata.etag']);
  assert.notEqual(sim.store.state.simulator.modelDriven.records[`website/${WEBSITE}`], null);
});

test('a failed organization changeset rolls back source rows, overlays, portal output and committed events', async (t) => {
  const { sim } = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  const { org, ui, entityPath, portal } = await connect(sim);
  const original = await json(await ui('GET', 'adx_contentsnippet', SNIPPET));
  const overlay = structuredClone(sim.store.state.simulator.modelDriven?.records ?? {});
  const html = await portal();
  await sim.store.flushCommittedEvents();
  const events = [];
  const unsubscribe = sim.store.addCommittedEvents((batch) =>
    events.push(...batch.filter((event) => event.entity === 'adx_contentsnippet')),
  );
  t.after(unsubscribe);
  const response = await org('POST', '/$batch', {
    requests: [
      {
        id: 'change',
        atomicityGroup: 'source-change',
        method: 'PATCH',
        url: BASE + entityPath('adx_contentsnippet', SNIPPET),
        body: { adx_value: 'Must roll back' },
      },
      {
        id: 'fail',
        atomicityGroup: 'source-change',
        dependsOn: ['change'],
        method: 'POST',
        url: BASE + '/x_items',
        body: { nonexistentcolumn: 'invalid' },
      },
    ],
  });
  const responseText = await response.text();
  // Without continue-on-error, native batch propagation returns the failing changeset status on the envelope.
  assert.equal(response.status, 400, responseText);
  assert.match(responseText, /HTTP\/1\.1 400/);
  const after = await json(await ui('GET', 'adx_contentsnippet', SNIPPET));
  assert.equal(after.row.adx_value, original.row.adx_value);
  assert.equal(after.etag, original.etag);
  assert.deepEqual(sim.store.state.simulator.modelDriven?.records ?? {}, overlay);
  // Runtime tracing assigns fresh parent/correlation ids per render; compare all remaining markup.
  const withoutRequestTrace = (markup) =>
    markup
      .replace(/const parentTrace="[^"]*";/g, 'const parentTrace="[request]";')
      .replace(/"correlationId":"[^"]*"/g, '"correlationId":"[request]"');
  assert.equal(withoutRequestTrace(await portal()), withoutRequestTrace(html));
  await sim.store.flushCommittedEvents();
  assert.deepEqual(events, []);
});

test('concurrent source updates merge overlay siblings and remain visible across both clients', async (t) => {
  const { sim } = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  const { org, ui, entityPath } = await connect(sim);
  const endpoint = entityPath('adx_sitesetting', SETTING);
  const responses = await Promise.all([
    org('PATCH', endpoint, { adx_name: 'Example/Concurrent' }),
    org('PATCH', endpoint, { adx_value: 'Concurrent value' }),
  ]);
  for (const response of responses) await json(response, 204);
  const shell = await json(await ui('GET', 'adx_sitesetting', SETTING));
  const api = await json(await org('GET', endpoint));
  assert.equal(shell.row.adx_name, 'Example/Concurrent');
  assert.equal(shell.row.adx_value, 'Concurrent value');
  assert.equal(api.adx_name, shell.row.adx_name);
  assert.equal(api.adx_value, shell.row.adx_value);
  assert.equal(api['@odata.etag'], shell.etag);
  const overlay = sim.store.state.simulator.modelDriven.records[`sitesetting/${SETTING}`];
  assert.equal(overlay.name, 'Example/Concurrent');
  assert.equal(overlay.value, 'Concurrent value');
});

test('an API sparse overlay preserves untouched sibling source changes after restart', async (t) => {
  const fixture = await modelDrivenFixture(t, { dataverse: { enabled: true } });
  const client = await connect(fixture.sim);
  await json(
    await client.org('PATCH', client.entityPath('adx_sitesetting', SETTING), { adx_value: 'API override' }),
    204,
  );
  const previous = await json(await client.ui('GET', 'adx_sitesetting', SETTING));
  await fixture.sim.close();
  await fs.writeFile(
    path.join(fixture.sourceDir, 'site-settings/Mode.sitesetting.yml'),
    `adx_sitesettingid: ${SETTING}\nadx_name: Example/ChangedInSource\nadx_value: New export value`,
  );
  const restarted = await fixture.start();
  t.after(() => restarted.close());
  const again = await connect(restarted, client.secret);
  const current = await json(await again.ui('GET', 'adx_sitesetting', SETTING));
  assert.equal(current.row.adx_name, 'Example/ChangedInSource');
  assert.equal(current.row.adx_value, 'API override');
  assert.notEqual(current.etag, previous.etag, 'changed source content invalidates a stale form');
  await json(
    await again.org(
      'PATCH',
      again.entityPath('adx_sitesetting', SETTING),
      { adx_value: 'Stale write' },
      { 'if-match': previous.etag },
    ),
    412,
  );
});
