// Copilot Studio (Pva*) bot and component messages and the shared workspace (lib/dataverse-addon-pva.mjs) over HTTP.
// @test-kind contract: Paqvilo's own designed Copilot Studio message behaviour over HTTP, not confirmed natively.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { tokenFor, webApiCall } from './support/dataverse-fixtures.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { idOf } from '../lib/dataverse-addon-common.mjs';

const APP_ID = '77777777-7777-7777-7777-777777777777';
const SECRET_VAR = 'PAQVILO_PVA_SECRET';
const VERSION = 'v9.2';
const id = (n) => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BOT = { seeded: id(1), empty: id(2), kill: id(3) };
const USER = { caller: id(10), other: id(11) };
const COLLECTION = id(20);

const SEED = {
  systemuser: [
    { systemuserid: USER.caller, fullname: 'Invented caller', isdisabled: false },
    { systemuserid: USER.other, fullname: 'Invented colleague', isdisabled: false },
  ],
  bot: [
    { botid: BOT.seeded, name: 'Invented bot', ownerid: USER.caller, statecode: 0, statuscode: 1 },
    { botid: BOT.empty, name: 'Invented empty bot', ownerid: USER.caller, statecode: 0, statuscode: 1 },
    { botid: BOT.kill, name: 'Invented bot to delete', ownerid: USER.caller, statecode: 0, statuscode: 1 },
  ],
  botcomponent: [
    {
      botcomponentid: id(30),
      name: 'Invented topic',
      parentbotid: BOT.kill,
      componenttype: 9,
      statecode: 0,
      statuscode: 1,
    },
    {
      botcomponentid: id(31),
      name: 'Invented action',
      parentbotid: BOT.kill,
      componenttype: 10,
      statecode: 0,
      statuscode: 1,
    },
    {
      botcomponentid: id(32),
      name: 'Invented collection member',
      parentbotid: BOT.seeded,
      parentbotcomponentcollectionid: COLLECTION,
      componenttype: 9,
    },
  ],
  botcomponentcollection: [
    { botcomponentcollectionid: COLLECTION, name: 'Invented collection', statecode: 0, statuscode: 1 },
  ],
};

describe('Copilot Studio and Teams messages over HTTP', () => {
  let api;
  let store;
  let token;

  before(async () => {
    process.env[SECRET_VAR] = 'pva-secret';
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Pva app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
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
    token = (await response.json()).access_token;
    await store.transact(() => {
      for (const [logical, rows] of Object.entries(SEED)) {
        store.state.tables[logical] ??= [];
        store.state.tables[logical].push(...rows);
      }
    });
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  // A bound call (POST <entitySet>(<id>)/Microsoft.Dynamics.CRM.<name>) or an unbound one (no key), with its status and body.
  async function call(path, body = {}) {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : null };
  }
  const rowOf = (logical, pk, value) => store.state.tables[logical].find((row) => row[pk] === value);

  it('every Pva and Teams message is declared in $metadata', async () => {
    const metadata = await (
      await fetch(`${api.origin}/api/data/${VERSION}/$metadata`, { headers: { authorization: `Bearer ${token}` } })
    ).text();
    for (const name of [
      'PvaAuthorize',
      'PvaCreateBotComponents',
      'PvaDeleteBot',
      'PvaPublish',
      'GetOrCreateSharedWorkspace',
      'SyncCopresenceState',
    ]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
  });

  it('create components parents them to the bot', async () => {
    const result = await call(`bots(${BOT.empty})/Microsoft.Dynamics.CRM.PvaCreateBotComponents`, {
      BotComponents: [
        { '@odata.type': '#Microsoft.Dynamics.CRM.botcomponent', name: 'Invented greeting', componenttype: 9 },
      ],
    });
    assert.equal(result.status, 204);
    const created = store.state.tables.botcomponent.filter((row) => row.parentbotid === BOT.empty);
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'Invented greeting');
    assert.equal(created[0]['@odata.type'], undefined);
    assert.match(created[0].botcomponentid, /^[0-9a-f-]{36}$/);
  });

  // @test-kind contract: one message writes its components as one unit, so a refused later entry leaves no earlier component.
  it('a component list whose second entry is refused creates no component', async () => {
    const before = store.state.tables.botcomponent.length;
    const result = await call(`bots(${BOT.empty})/Microsoft.Dynamics.CRM.PvaCreateBotComponents`, {
      BotComponents: [
        { name: 'Invented first of two', componenttype: 9 },
        { name: 'Invented second of two', componenttype: 999 },
      ],
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(store.state.tables.botcomponent.length, before);
    assert.equal(
      store.state.tables.botcomponent.some((row) => row.name === 'Invented first of two'),
      false,
    );
  });

  it('a component with a bind on its bot is refused with a 400 that names the annotation, and creates no component', async () => {
    const before = store.state.tables.botcomponent.length;
    const result = await call(`bots(${BOT.empty})/Microsoft.Dynamics.CRM.PvaCreateBotComponents`, {
      BotComponents: [
        { 'parentbotid@odata.bind': `/bots(${BOT.seeded})`, name: 'Invented bound component', componenttype: 9 },
      ],
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error.message, /'parentbotid@odata\.bind' is not supported on PvaCreateBotComponents/);
    assert.doesNotMatch(result.body.error.message, /is not a column/);
    assert.equal(store.state.tables.botcomponent.length, before);
  });

  it('delete bot removes components', async () => {
    const result = await call(`bots(${BOT.kill})/Microsoft.Dynamics.CRM.PvaDeleteBot`);
    assert.equal(result.status, 204);
    assert.equal(rowOf('bot', 'botid', BOT.kill), undefined);
    assert.equal(store.state.tables.botcomponent.filter((row) => row.parentbotid === BOT.kill).length, 0);
    assert.ok(rowOf('bot', 'botid', BOT.seeded), 'other bots stay');
  });

  it('delete bot component collection removes its members', async () => {
    const result = await call(
      `botcomponentcollections(${COLLECTION})/Microsoft.Dynamics.CRM.PvaDeleteBotComponentCollection`,
    );
    assert.equal(result.status, 204);
    assert.equal(rowOf('botcomponentcollection', 'botcomponentcollectionid', COLLECTION), undefined);
    assert.equal(
      store.state.tables.botcomponent.filter((row) => row.parentbotcomponentcollectionid === COLLECTION).length,
      0,
    );
  });

  it('authorize shares through principalobjectaccess', async () => {
    const share = await call(`bots(${BOT.seeded})/Microsoft.Dynamics.CRM.PvaAuthorize`, {
      Users: [{ systemuserid: USER.other }],
      SharingRoleType: 1,
      ShareOrUnshare: true,
    });
    assert.equal(share.status, 204);
    const row = store.state.tables.principalobjectaccess.find(
      (item) => item.objectid === BOT.seeded && item.objecttypecode === 'bot',
    );
    assert.ok(row, 'a share row for the bot exists');
    assert.equal(Number(row.accessrightsmask), 1 | 2 | 262144);
    const unshare = await call(`bots(${BOT.seeded})/Microsoft.Dynamics.CRM.PvaAuthorize`, {
      Users: [{ systemuserid: USER.other }],
      SharingRoleType: 1,
      ShareOrUnshare: false,
    });
    assert.equal(unshare.status, 204);
    assert.equal(
      store.state.tables.principalobjectaccess.filter(
        (item) => item.objectid === BOT.seeded && item.objecttypecode === 'bot',
      ).length,
      0,
    );
  });

  it('an unknown user is refused before any share is written', async () => {
    const before = store.state.tables.principalobjectaccess.length;
    const result = await call(`bots(${BOT.seeded})/Microsoft.Dynamics.CRM.PvaAuthorize`, {
      Users: [{ systemuserid: USER.other }, { systemuserid: id(99) }],
      SharingRoleType: 0,
      ShareOrUnshare: true,
    });
    assert.equal(result.status, 400);
    assert.equal(store.state.tables.principalobjectaccess.length, before);
  });

  it('shared workspace is reused by name', async () => {
    const first = await call('Microsoft.Dynamics.CRM.GetOrCreateSharedWorkspace', {
      target: { name: 'Invented workspace' },
    });
    const second = await call('Microsoft.Dynamics.CRM.GetOrCreateSharedWorkspace', {
      target: { name: 'invented workspace' },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.sharedworkspaceid, first.body.sharedworkspaceid);
    assert.equal(store.state.tables.sharedworkspace.filter((row) => row.name === 'Invented workspace').length, 1);
    assert.match(first.body['@odata.context'], /#sharedworkspaces\/\$entity$/);
  });

  it("the bot list is the caller's bots as JSON", async () => {
    const created = await fetch(`${api.origin}/api/data/${VERSION}/bots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ botid: id(4), name: 'Invented own bot' }),
    });
    assert.equal(created.status, 204, await created.text());
    const result = await call('Microsoft.Dynamics.CRM.PvaGetUserBots', { RoleType: 0 });
    assert.equal(result.status, 200);
    // The seeded bots belong to another user, so only the bot the caller created (its ownerid a stored reference) is listed.
    assert.deepEqual(JSON.parse(result.body.Bots), [{ botid: id(4), name: 'Invented own bot' }]);
  });

  it('publish is not simulated (internal-only, GC policy)', async () => {
    const result = await call(`bots(${BOT.seeded})/Microsoft.Dynamics.CRM.PvaPublish`);
    assert.equal(result.status, 501);
    assert.equal(result.body.error.code, '0x80040216');
    assert.equal(result.body.error.message, 'PvaPublish is for internal use only and is not simulated.');
  });
});

describe('Copilot Studio messages check the caller against the row they touch', () => {
  const BASIC_APP_ID = '88888888-8888-8888-8888-888888888888';
  const BASIC_SECRET_VAR = 'PAQVILO_PVA_BASIC_SECRET';
  const ADMIN_BOT = id(50);
  const EMPTY_BOT = id(51);
  const COLLECTION = id(52);
  const EMPTY_COLLECTION = id(53);
  let api;
  let store;
  let admin;
  let basic;

  // A Web API call or bound message as the bearer's application user, with its status and body.
  async function request(token, method, path, body) {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const result = await webApiCall(api.origin, VERSION, method, path, headers, body);
    return { status: result.status, body: result.json };
  }
  const guarded = () =>
    JSON.stringify({
      bot: store.state.tables.bot,
      botcomponent: store.state.tables.botcomponent,
      botcomponentcollection: store.state.tables.botcomponentcollection,
      sharedworkspace: store.state.tables.sharedworkspace,
    });

  before(async () => {
    process.env[SECRET_VAR] = 'pva-secret';
    process.env[BASIC_SECRET_VAR] = 'pva-basic-secret';
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Pva app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
        {
          appId: BASIC_APP_ID,
          displayName: 'Pva basic app',
          secretEnvironmentVariable: BASIC_SECRET_VAR,
          roles: ['Basic User'],
        },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
    admin = await tokenFor(api, APP_ID, SECRET_VAR);
    basic = await tokenFor(api, BASIC_APP_ID, BASIC_SECRET_VAR);
    // The rows are created as the System Administrator, so the store stamps the administrator as their owner.
    for (const [path, body] of [
      ['bots', { botid: ADMIN_BOT, name: 'Invented admin bot' }],
      ['bots', { botid: EMPTY_BOT, name: 'Invented empty bot' }],
      ['botcomponentcollections', { botcomponentcollectionid: COLLECTION, name: 'Invented admin collection' }],
      ['botcomponentcollections', { botcomponentcollectionid: EMPTY_COLLECTION, name: 'Invented empty collection' }],
    ]) {
      assert.equal((await request(admin, 'POST', path, body)).status, 204, path);
    }
    const seeded = await request(admin, 'POST', `bots(${ADMIN_BOT})/Microsoft.Dynamics.CRM.PvaCreateBotComponents`, {
      BotComponents: [{ name: 'Invented admin topic', componenttype: 9 }],
    });
    assert.equal(seeded.status, 204);
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    delete process.env[BASIC_SECRET_VAR];
    await api?.close();
  });

  // The Web API refusal of the same row for the Basic User, to compare against the message refusal.
  async function directRefusal(method, path, body) {
    const result = await request(basic, method, path, body);
    assert.equal(result.status, 403, `${method} ${path}`);
    return result.body.error.code;
  }

  // @test-kind security: a Basic User must not delete a bot the administrator owns, the same refusal as a direct delete.
  it('a Basic User cannot delete an admin-owned bot through PvaDeleteBot, and nothing is removed', async () => {
    const code = await directRefusal('DELETE', `bots(${ADMIN_BOT})`);
    const before = guarded();
    const result = await request(basic, 'POST', `bots(${ADMIN_BOT})/Microsoft.Dynamics.CRM.PvaDeleteBot`, {});
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, code);
    assert.equal(guarded(), before);
  });

  // @test-kind security: the System Administrator keeps the bot delete, which removes the bot and its components.
  it('the System Administrator still deletes a bot and its components through PvaDeleteBot', async () => {
    const result = await request(admin, 'POST', `bots(${EMPTY_BOT})/Microsoft.Dynamics.CRM.PvaDeleteBot`, {});
    assert.equal(result.status, 204);
    assert.equal(
      store.state.tables.bot.some((row) => row.botid === EMPTY_BOT),
      false,
    );
  });

  // @test-kind security: a Basic User must not delete an admin-owned component collection, the same refusal as a direct delete.
  it('a Basic User cannot delete an admin-owned component collection, and nothing is removed', async () => {
    const code = await directRefusal('DELETE', `botcomponentcollections(${COLLECTION})`);
    const before = guarded();
    const result = await request(
      basic,
      'POST',
      `botcomponentcollections(${COLLECTION})/Microsoft.Dynamics.CRM.PvaDeleteBotComponentCollection`,
      {},
    );
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, code);
    assert.equal(guarded(), before);
  });

  // @test-kind security: the System Administrator keeps the collection delete, which removes the collection.
  it('the System Administrator still deletes a component collection through PvaDeleteBotComponentCollection', async () => {
    const result = await request(
      admin,
      'POST',
      `botcomponentcollections(${EMPTY_COLLECTION})/Microsoft.Dynamics.CRM.PvaDeleteBotComponentCollection`,
      {},
    );
    assert.equal(result.status, 204);
    assert.equal(
      store.state.tables.botcomponentcollection.some((row) => row.botcomponentcollectionid === EMPTY_COLLECTION),
      false,
    );
  });

  // @test-kind security: a Basic User must not add components to an admin bot, the same refusal as a direct create.
  it('a Basic User cannot add components to an admin-owned bot, and no component is written', async () => {
    const code = await directRefusal('GET', `bots(${ADMIN_BOT})`);
    const before = guarded();
    const result = await request(basic, 'POST', `bots(${ADMIN_BOT})/Microsoft.Dynamics.CRM.PvaCreateBotComponents`, {
      BotComponents: [{ name: 'Invented intruder' }],
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, code);
    assert.equal(guarded(), before);
  });

  // @test-kind security: a component is stamped with the caller as owner, and a column the table does not have is refused.
  it('a component the System Administrator adds is owned by the caller, and an unknown column is refused', async () => {
    const path = `bots(${ADMIN_BOT})/Microsoft.Dynamics.CRM.PvaCreateBotComponents`;
    const unknown = await request(admin, 'POST', path, {
      BotComponents: [{ name: 'Invented bogus', bogus_column: 'x' }],
    });
    assert.equal(unknown.status, 400);
    assert.equal(
      store.state.tables.botcomponent.some((row) => row.name === 'Invented bogus'),
      false,
    );
    const result = await request(admin, 'POST', path, {
      BotComponents: [{ name: 'Invented owned', componenttype: 9, ownerid: 'nobody' }],
    });
    assert.equal(result.status, 204);
    const created = store.state.tables.botcomponent.find((row) => row.name === 'Invented owned');
    const bot = store.state.tables.bot.find((row) => row.botid === ADMIN_BOT);
    assert.equal(idOf(created.ownerid), idOf(bot.ownerid));
    assert.notEqual(idOf(created.ownerid), 'nobody');
  });

  // @test-kind security: a Basic User without the create privilege on sharedworkspace is refused, and no workspace row is written.
  it('a Basic User cannot create a shared workspace, and no row is written', async () => {
    const before = guarded();
    const result = await request(basic, 'POST', 'Microsoft.Dynamics.CRM.GetOrCreateSharedWorkspace', {
      target: { name: 'Invented denied workspace' },
    });
    assert.equal(result.status, 403);
    assert.equal(guarded(), before);
  });
});
