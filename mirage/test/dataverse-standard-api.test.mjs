// Standard tables through the Dataverse Web API: the seeded account stand-in (reads, creates with the standard defaults,
// unknown columns), a Solution-mapped account that keeps its own mapping while standard columns still resolve, and the
// standard navigations of a polymorphic lookup (email.acceptingentityid).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { fieldsWithStandard, standardFields, standardNavigation } from '../lib/dataverse-standard.mjs';

const APP_ID = '22222222-2222-2222-2222-222222222222';
const SECRET_VAR = 'PAQVILO_STANDARD_API_TEST_SECRET';
const MISSING = '00000000-0000-0000-0000-000000000000';
const API = '/api/data/v9.2/';

async function start(state) {
  process.env[SECRET_VAR] = 'standard-api-test-secret';
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Standard client',
        secretEnvironmentVariable: SECRET_VAR,
        roles: ['System Administrator'],
      },
    ],
  });
  const api = await startDataverseApi({ store, change: (fn) => fn(), settings, log: () => {} });
  const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: process.env[SECRET_VAR],
      scope: `${api.origin}/.default`,
    }),
  });
  const headers = { authorization: `Bearer ${(await response.json()).access_token}` };
  const call = (path, init = {}) =>
    fetch(`${api.origin}${API}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return {
    store,
    call,
    async close() {
      delete process.env[SECRET_VAR];
      await api.close();
    },
  };
}

const entityIdOf = (response) => /\(([0-9a-f-]{36})\)/i.exec(response.headers.get('OData-EntityId') ?? '')?.[1];

describe('standard tables through the Dataverse Web API', () => {
  let dv;
  before(async () => {
    dv = await start({ ...emptyState(), mappings: {}, tables: {} });
  });
  after(() => dv?.close());

  it('answers the standard $top rule and an empty filter as the real service does', async () => {
    let response = await dv.call('accounts?$top=0&$select=accountid');
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /0x80060888/);
    response = await dv.call(`accounts?$select=accountid&$filter=accountid eq ${MISSING}&$top=1`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).value, []);
  });

  it('names the entity set with its case and refuses a column the table does not have', async () => {
    const response = await dv.call('Accounts');
    assert.equal(response.status, 404);
    assert.match(JSON.stringify(await response.json()), /Resource not found for the segment 'Accounts'/);
    const unknown = await dv.call('accounts', { method: 'POST', body: { name: 'Unknown column', no_such_column: 1 } });
    assert.equal(unknown.status, 400);
    assert.match(JSON.stringify(await unknown.json()), /no_such_column/);
  });

  it('creates an account with the standard defaults', async () => {
    const created = await dv.call('accounts', { method: 'POST', body: { name: 'Invented account' } });
    assert.equal(created.status, 204);
    const id = entityIdOf(created);
    assert.ok(id);
    const row = await (await dv.call(`accounts(${id})?$select=name,donotemail,statecode,statuscode`)).json();
    assert.equal(row.name, 'Invented account');
    assert.equal(row.donotemail, false);
    assert.equal(row.statecode, 0);
    assert.equal(row.statuscode, 1);
  });
});

describe('a Solution-mapped account keeps its mapping', () => {
  let dv;
  let pristine;
  const solutionAccount = () => ({
    logicalName: 'account',
    entitySet: 'invented_accounts',
    idColumn: 'accountid',
    nameColumn: 'name',
    fields: { x_tier: { dataverseType: 'nvarchar' } },
    relationships: {},
    schemaComplete: true,
  });
  before(async () => {
    const state = { ...emptyState(), mappings: { account: solutionAccount() }, tables: { account: [] } };
    dv = await start(state);
    pristine = structuredClone(dv.store.state.mappings.account);
  });
  after(() => dv?.close());

  it('accepts its own column and a standard column, and leaves the mapping as it was', async () => {
    const created = await dv.call('invented_accounts', {
      method: 'POST',
      body: { name: 'Tiered', x_tier: 'gold', telephone1: '555-0100' },
    });
    assert.equal(created.status, 204);
    const id = entityIdOf(created);
    const row = await (await dv.call(`invented_accounts(${id})?$select=x_tier,telephone1,donotemail,statecode`)).json();
    assert.equal(row.x_tier, 'gold');
    assert.equal(row.telephone1, '555-0100');
    assert.equal(row.donotemail, false);
    assert.equal(row.statecode, 0);
    assert.deepEqual(dv.store.state.mappings.account, pristine);
  });
});

describe('a shared polymorphic lookup keeps one navigation per target', () => {
  it('email.acceptingentityid gives queue and systemuser their own navigations', () => {
    const store = { state: { mappings: { email: {}, queue: {}, systemuser: {} } } };
    const toQueue = standardNavigation(store, 'email', 'acceptingentityid_queue');
    const toUser = standardNavigation(store, 'email', 'acceptingentityid_systemuser');
    assert.equal(toQueue?.entity, 'queue');
    assert.equal(toUser?.entity, 'systemuser');
    assert.equal(toQueue.partner, 'email_acceptingentity_queue');
    assert.equal(toUser.partner, 'email_acceptingentity_systemuser');
    assert.equal(standardNavigation(store, 'email', 'acceptingentityid'), null);
  });

  it('a navigation waits for its other table to exist', () => {
    const store = { state: { mappings: { email: {} } } };
    assert.equal(standardNavigation(store, 'email', 'acceptingentityid_queue'), null);
  });
});

describe('the field merge', () => {
  const seeded = (fields) => ({
    state: { mappings: { account: { logicalName: 'account', standardTable: true, fields } } },
  });
  it('a seeded stand-in keeps the standard definitions over its thin dataverseType fields', () => {
    const thin = { name: { dataverseType: 'nvarchar' } };
    const merged = fieldsWithStandard(seeded(thin), 'account', thin);
    assert.deepEqual(merged.name, standardFields('account').name);
    assert.deepEqual(merged.telephone1, standardFields('account').telephone1);
  });
  it("a Solution's own definition wins and the standard columns fill the rest", () => {
    const own = { name: { dataverseType: 'nvarchar', displayName: 'Solution name' } };
    const store = { state: { mappings: { account: { logicalName: 'account', fields: own } } } };
    const merged = fieldsWithStandard(store, 'account', own);
    assert.equal(merged.name.displayName, 'Solution name');
    assert.deepEqual(merged.telephone1, standardFields('account').telephone1);
  });
  it('a table the standard file does not list is returned unchanged', () => {
    const own = { x_tier: { dataverseType: 'nvarchar' } };
    assert.equal(fieldsWithStandard({ state: { mappings: {} } }, 'invented_thing', own), own);
  });
});
