import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createPrincipals, tokenKind } from '../lib/dataverse-security.mjs';
import { hashSecret } from '../lib/dataverse-auth.mjs';

const APP = '99999999-9999-4999-8999-999999999999';
const USER_OID = '77777777-7777-4777-8777-777777777771';
const GONE_OID = '77777777-7777-4777-8777-777777777779';

function storeWith(systemuser) {
  const tables = { systemuser };
  let revision = 1;
  return {
    store: { state: { tables, dataverse: {} }, tableRows: (t) => tables[t] ?? [], dataRevision: () => revision },
    bump: () => revision++,
  };
}
const delegated = (oid, upn) => ({ appid: APP, idtyp: 'user', oid, sub: oid, scp: 'user_impersonation', upn });

test('tokenKind separates delegated and application tokens', () => {
  assert.equal(tokenKind(delegated(USER_OID)), 'delegated');
  assert.equal(tokenKind({ appid: APP, idtyp: 'app', oid: GONE_OID }), 'application');
  assert.equal(tokenKind({ appid: APP, scp: 'user_impersonation' }), 'delegated');
  assert.equal(tokenKind({ azp: APP }), 'application');
});

test('a delegated token resolves its user by oid only and never falls back to the client application user', () => {
  const { store, bump } = storeWith([
    {
      systemuserid: '77777777-7777-4777-8777-7777777777a1',
      applicationid: APP,
      azureactivedirectoryobjectid: '77777777-7777-4777-8777-7777777777a2',
      fullname: 'Invented client',
    },
    {
      systemuserid: '77777777-7777-4777-8777-7777777777b1',
      azureactivedirectoryobjectid: USER_OID,
      domainname: 'alex@example.test',
      fullname: 'Alex',
    },
  ]);
  const principals = createPrincipals(store, {});
  assert.equal(principals.resolve(delegated(USER_OID, 'alex@example.test')).user.fullname, 'Alex');
  assert.deepEqual(principals.resolve(delegated(GONE_OID, 'gone@example.test')), { user: null, reason: 'unknown' });
  // The upn names another user: an unknown oid still does not resolve.
  assert.deepEqual(principals.resolve(delegated(GONE_OID, 'alex@example.test')), { user: null, reason: 'unknown' });
  assert.equal(principals.resolve({ appid: APP, idtyp: 'app', oid: GONE_OID }).user.fullname, 'Invented client');
  store.state.tables.systemuser.splice(1, 1);
  bump();
  assert.deepEqual(principals.resolve(delegated(USER_OID, 'alex@example.test')), { user: null, reason: 'unknown' });
});

test('the Web API refuses a delegated token whose user left the organization with 401 0x80072560, not the application user', async (t) => {
  const variable = `PAQ_PRINCIPAL_SECRET_${process.pid}`;
  process.env[variable] = 'invented-secret';
  t.after(() => {
    delete process.env[variable];
  });
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    tds: { enabled: false },
    applications: [
      {
        appId: APP,
        displayName: 'Invented client',
        secretEnvironmentVariable: variable,
        roles: ['System Administrator'],
      },
    ],
    users: [{ domainname: 'pat@example.test', objectId: USER_OID, fullname: 'Pat', roles: ['Basic User'] }],
  });
  const server = await startDataverseApi({ store, settings, log: () => {} });
  t.after(() => server.close());
  const user = store.state.tables.systemuser.find((row) => row.azureactivedirectoryobjectid === USER_OID);
  await store.transact(() => {
    (store.state.dataverse ??= {}).passwords = { [user.systemuserid]: hashSecret('invented-password') };
  });
  const token = async (form) =>
    (
      await (
        await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          body: new URLSearchParams({
            client_id: APP,
            client_secret: 'invented-secret',
            scope: `${server.origin}/.default`,
            ...form,
          }),
        })
      ).json()
    ).access_token;
  const whoAmI = async (access) => {
    const response = await fetch(`${server.origin}/api/data/v9.2/WhoAmI`, {
      headers: { authorization: `Bearer ${access}` },
    });
    return { status: response.status, body: await response.json() };
  };
  const userToken = await token({
    grant_type: 'password',
    username: 'pat@example.test',
    password: 'invented-password',
  });
  const appToken = await token({ grant_type: 'client_credentials' });
  assert.equal((await whoAmI(userToken)).body.UserId, user.systemuserid);
  const app = await whoAmI(appToken);
  assert.equal(app.status, 200);
  assert.notEqual(app.body.UserId, user.systemuserid);
  // The user's Entra object id changes while the delegated token is still valid.
  await store.transact(() => {
    user.azureactivedirectoryobjectid = GONE_OID;
  });
  const refused = await whoAmI(userToken);
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error.code, '0x80072560');
  assert.equal((await whoAmI(appToken)).body.UserId, app.body.UserId);
});
