// @test-kind security: only system administrators can read the secure configuration table (Learn: Write a plug-in)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConstructorSettings } from '../lib/plugin-constructor-configuration.mjs';
import { APPS, startSecuredOrganization } from './support/secured-reads.mjs';

const SECURE = 'sdkmessageprocessingstepsecureconfigs';
const STEP = 'a1000000-0000-4000-8000-0000000000c1';
const SECRET = 'INVENTED-SECURE-TEXT';
const FORBIDDEN = '0x80040220';

const startOrganization = () => startSecuredOrganization({ envPrefix: 'PAQ_SECURE_CONFIG', apps: APPS });

const secureRows = (store) => store.tableRows('sdkmessageprocessingstepsecureconfig');
const secureTextOf = (store, id) =>
  secureRows(store).find((row) => row.sdkmessageprocessingstepsecureconfigid === id)?.secureconfig;

async function assertDenied(harness, who, { secureId, removableId }) {
  const { store, call } = harness;
  const list = await call(who, 'GET', SECURE);
  assert.equal(list.status, 403, `${who} collection read`);
  assert.equal(list.text.includes(FORBIDDEN), true, `${who} collection read is refused with ${FORBIDDEN}`);
  const row = await call(who, 'GET', `${SECURE}(${secureId})`);
  assert.equal(row.status, 403, `${who} row read`);
  assert.equal(row.text.includes(SECRET), false, `${who} row read does not return the text`);
  const expanded = await call(
    who,
    'GET',
    `sdkmessageprocessingsteps(${STEP})?$expand=sdkmessageprocessingstepsecureconfigid`,
  );
  assert.equal(expanded.text.includes(SECRET), false, `${who} step expansion does not return the text`);
  const before = secureRows(store).length;
  const created = await call(who, 'POST', SECURE, { secureconfig: 'INVENTED-NEW' });
  assert.equal(created.status, 403, `${who} create`);
  assert.equal(secureRows(store).length, before, `${who} create inserts nothing`);
  const updated = await call(who, 'PATCH', `${SECURE}(${secureId})`, { secureconfig: 'INVENTED-CHANGED' });
  assert.equal(updated.status, 403, `${who} update`);
  assert.equal(secureTextOf(store, secureId), SECRET, `${who} update leaves the text`);
  const deleted = await call(who, 'DELETE', `${SECURE}(${removableId})`);
  assert.equal(deleted.status, 403, `${who} delete`);
  assert.notEqual(secureTextOf(store, removableId), undefined, `${who} delete keeps the row`);
}

test('only system administrators read and write secure configuration; the step constructor still receives the text', async () => {
  const harness = await startOrganization();
  try {
    const { store, call } = harness;
    const created = await call('admin', 'POST', SECURE, { secureconfig: SECRET });
    assert.equal(created.status, 201);
    const secureId = JSON.parse(created.text).sdkmessageprocessingstepsecureconfigid;
    const removable = await call('admin', 'POST', SECURE, { secureconfig: 'INVENTED-REMOVABLE' });
    const removableId = JSON.parse(removable.text).sdkmessageprocessingstepsecureconfigid;
    (store.state.tables.sdkmessageprocessingstep ??= []).push({
      sdkmessageprocessingstepid: STEP,
      configuration: 'INVENTED-UNSECURE',
      sdkmessageprocessingstepsecureconfigid: secureId,
    });
    assert.equal(runtimeConstructorSettings(store, STEP, {}, {}).secureConfiguration, SECRET);

    for (const who of ['basic', 'customizer']) await assertDenied(harness, who, { secureId, removableId });

    const list = await call('admin', 'GET', SECURE);
    assert.equal(list.status, 200);
    assert.equal(list.text.includes(SECRET), true);
    assert.equal((await call('admin', 'GET', `${SECURE}(${secureId})`)).status, 200);
    const expanded = await call(
      'admin',
      'GET',
      `sdkmessageprocessingsteps(${STEP})?$expand=sdkmessageprocessingstepsecureconfigid`,
    );
    assert.equal(expanded.status, 200);
    assert.equal(expanded.text.includes(SECRET), true, 'an administrator sees the expanded text');
    assert.equal(
      (await call('admin', 'PATCH', `${SECURE}(${secureId})`, { secureconfig: 'INVENTED-ADMIN' })).status,
      200,
    );
    assert.equal(secureTextOf(store, secureId), 'INVENTED-ADMIN');
    assert.equal((await call('admin', 'DELETE', `${SECURE}(${removableId})`)).status, 204);
    assert.equal(secureTextOf(store, removableId), undefined);
  } finally {
    await harness.close();
  }
});
