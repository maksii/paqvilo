// Feature-control, mobile-offline clone, card, NPS and default-error messages (lib/dataverse-addon-featurecontrol.mjs) over HTTP.
// @test-kind contract: Paqvilo's own designed feature-control and default message behaviour over HTTP, not confirmed natively.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { tokenFor, webApiCall } from './support/dataverse-fixtures.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { addonHandlerExtension, addonHandlers } from '../lib/dataverse-addon-common.mjs';

const APP_ID = '66666666-6666-6666-6666-666666666666';
const SECRET_VAR = 'PAQVILO_FEATURECONTROL_SECRET';
const VERSION = 'v9.2';
const PROFILE = 'a1000000-0000-4000-8000-000000000001';
const OTHER_PROFILE = 'a1000000-0000-4000-8000-000000000002';
const ITEM = 'a2000000-0000-4000-8000-000000000001';
const OTHER_ITEM = 'a2000000-0000-4000-8000-000000000002';
const CARD = 'a3000000-0000-4000-8000-000000000001';
const REPORT = 'a4000000-0000-4000-8000-000000000001';
const LONG = 'x'.repeat(196);

const SEED = {
  featurecontrolsetting: [
    {
      featurecontrolsettingid: 'a5000000-0000-4000-8000-000000000001',
      uniquename: 'contoso_ns',
      name: 'Contoso',
      statecode: 0,
      content: JSON.stringify({ Enabled: true, Limit: 5, Label: 'Invented' }),
    },
    {
      featurecontrolsettingid: 'a5000000-0000-4000-8000-000000000002',
      uniquename: 'contoso_off',
      name: 'Off',
      statecode: 1,
      content: '{"Enabled":true}',
    },
  ],
  mobileofflineprofile: [
    { mobileofflineprofileid: PROFILE, name: 'Contoso profile', statecode: 0 },
    { mobileofflineprofileid: OTHER_PROFILE, name: 'Other profile', statecode: 0 },
  ],
  mobileofflineprofileitem: [
    { mobileofflineprofileitemid: ITEM, regardingobjectid: PROFILE, name: 'Item one' },
    { mobileofflineprofileitemid: OTHER_ITEM, regardingobjectid: OTHER_PROFILE, name: 'Item two' },
  ],
  mobileofflineprofileitemassociation: [
    {
      mobileofflineprofileitemassociationid: 'a6000000-0000-4000-8000-000000000001',
      mobileofflineprofileitemid: ITEM,
      name: 'Association',
    },
  ],
  mobileofflineprofileitemfilter: [
    {
      mobileofflineprofileitemfilterid: 'a7000000-0000-4000-8000-000000000001',
      mobileofflineprofileitemid: ITEM,
      mobileofflineprofileid: PROFILE,
      name: 'Filter',
    },
  ],
  card: [{ cardid: CARD, name: 'Contoso card', appdefinition: '{"type":"card"}' }],
};

describe('feature-control and default messages over HTTP', () => {
  let api;
  let store;
  let send;
  let close;
  let bearer;

  // A started API with the feature-control module and the given extra extensions; its own client secret.
  async function start(extra = []) {
    process.env[SECRET_VAR] = 'featurecontrol-secret';
    const dataStore = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Feature app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    const started = await startDataverseApi({
      store: dataStore,
      settings,
      log: () => {},
      extensions: [...EXTENSIONS, ...extra],
    });
    const response = await fetch(`${started.origin}/${started.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${started.origin}/.default`,
      }),
    });
    const bearer = (await response.json()).access_token;
    await dataStore.transact(() => {
      for (const [logical, rows] of Object.entries(SEED)) {
        dataStore.state.tables[logical] ??= [];
        dataStore.state.tables[logical].push(...rows);
      }
    });
    const send = async (method, path, body) => {
      const result = await fetch(`${started.origin}/api/data/${VERSION}/${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      });
      const text = await result.text();
      return { status: result.status, body: text ? JSON.parse(text) : null };
    };
    return { api: started, store: dataStore, send, bearer, close: () => started.close() };
  }

  before(async () => {
    const started = await start();
    api = started.api;
    store = started.store;
    send = started.send;
    bearer = started.bearer;
    close = started.close;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await close?.();
  });

  const act = (name, body) => send('POST', name, body);
  const bound = (set, id, name, body) => send('POST', `${set}(${id})/Microsoft.Dynamics.CRM.${name}`, body);
  const rows = (logical) => store.state.tables[logical];

  it('every feature-control and default message is declared in $metadata', async () => {
    const metadata = await (
      await fetch(`${api.origin}/api/data/${VERSION}/$metadata`, { headers: { authorization: `Bearer ${bearer}` } })
    ).text();
    for (const name of [
      'RetrieveFeatureControlSetting',
      'RetrieveBoolFeatureControlSetting',
      'RetrieveFeatureControlSettingsByNamespace',
      'GetFeatureControlStringSettingsForNamespaceWithUserContext',
      'UpdateFeatureConfig',
      'CloneMobileOfflineProfile',
      'CardCreateClone',
      'ImportCardTypeSchema',
      'GetPBIReportRefreshStatus',
      'RetrieveAnalyticsStoreDetails',
      'RetrieveFinanceAndOperationsIntegrationDetails',
    ]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
    assert.match(metadata, /Name="FeatureControlSettingData"/);
  });

  it('a bool setting reads the seeded row; a missing or inactive one is false', async () => {
    const enabled = await act('Microsoft.Dynamics.CRM.RetrieveBoolFeatureControlSetting', {
      NamespaceValue: 'contoso_ns',
      FeatureControlName: 'Enabled',
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.IsEnabled, true);
    const missing = await act('Microsoft.Dynamics.CRM.RetrieveBoolFeatureControlSetting', {
      NamespaceValue: 'contoso_ns',
      FeatureControlName: 'Nope',
    });
    assert.equal(missing.body.IsEnabled, false);
    const inactive = await act('Microsoft.Dynamics.CRM.RetrieveBoolFeatureControlSetting', {
      NamespaceValue: 'contoso_off',
      FeatureControlName: 'Enabled',
    });
    assert.equal(inactive.body.IsEnabled, false);
  });

  it('a namespace returns all its active settings with their types and string values', async () => {
    const result = await act('Microsoft.Dynamics.CRM.RetrieveFeatureControlSettingsByNamespace', {
      NamespaceName: 'contoso_ns',
    });
    assert.equal(result.status, 200);
    const byName = Object.fromEntries(result.body.FeatureControlSettingCollection.map((s) => [s.Name, s]));
    assert.deepEqual(Object.keys(byName).sort(), ['Enabled', 'Label', 'Limit']);
    assert.deepEqual(byName.Limit, { Type: 'Integer', Value: '5', Name: 'Limit', NamespaceValue: 'contoso_ns' });
    assert.equal(byName.Enabled.Type, 'Boolean');
    const strings = await act('Microsoft.Dynamics.CRM.GetFeatureControlStringSettingsForNamespaceWithUserContext', {
      NamespaceName: 'contoso_ns',
      FeatureControlSettingNames: [],
      AdditionalFilterNames: [],
      AdditionalFilterValues: [],
    });
    assert.equal(strings.body.FeatureControlStringSettingCollection.length, 3);
    assert.equal(strings.body.FeatureControlStringSettingCollection.find((s) => s.Name === 'Enabled').Value, 'true');
  });

  it('a single setting that is missing answers null', async () => {
    const result = await act('Microsoft.Dynamics.CRM.RetrieveFeatureControlSetting', {
      NamespaceValue: 'contoso_ns',
      FeatureControlName: 'Nope',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.FeatureControlSetting, null);
    const found = await act('Microsoft.Dynamics.CRM.RetrieveFeatureControlSetting', {
      NamespaceValue: 'contoso_ns',
      FeatureControlName: 'Label',
    });
    assert.deepEqual(found.body.FeatureControlSetting, {
      Type: 'String',
      Value: 'Invented',
      Name: 'Label',
      NamespaceValue: 'contoso_ns',
    });
  });

  it('clone copies the profile, its item, the association and the filter under new ids', async () => {
    const result = await bound('mobileofflineprofiles', PROFILE, 'CloneMobileOfflineProfile', {});
    assert.equal(result.status, 200);
    assert.equal(result.body.name, 'Contoso profile (Copy)');
    const newId = result.body.mobileofflineprofileid;
    assert.notEqual(newId, PROFILE);
    const items = rows('mobileofflineprofileitem').filter((row) => row.regardingobjectid === newId);
    assert.equal(items.length, 1);
    assert.notEqual(items[0].mobileofflineprofileitemid, ITEM);
    assert.equal(items[0].name, 'Item one');
    const association = rows('mobileofflineprofileitemassociation').find(
      (row) => row.mobileofflineprofileitemid === items[0].mobileofflineprofileitemid,
    );
    assert.ok(association);
    const filter = rows('mobileofflineprofileitemfilter').find(
      (row) => row.mobileofflineprofileitemid === items[0].mobileofflineprofileitemid,
    );
    assert.equal(filter.mobileofflineprofileid, newId);
    // The source is untouched.
    assert.equal(
      rows('mobileofflineprofileitem').find((row) => row.mobileofflineprofileitemid === ITEM).regardingobjectid,
      PROFILE,
    );
  });

  it('a clone whose name would exceed 200 characters is refused', async () => {
    store.state.tables.mobileofflineprofile.push({
      mobileofflineprofileid: 'a1000000-0000-4000-8000-0000000000ff',
      name: LONG,
      statecode: 0,
    });
    const result = await bound(
      'mobileofflineprofiles',
      'a1000000-0000-4000-8000-0000000000ff',
      'CloneMobileOfflineProfile',
      {},
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, '0x80071112');
    assert.match(result.body.error.message, /maximum allowed length of 200/);
  });

  it('card clone returns a new id and copies the definition; an unknown card is 404', async () => {
    const cloned = await act('Microsoft.Dynamics.CRM.CardCreateClone', { CardName: 'Clone', CardId: CARD });
    assert.equal(cloned.status, 200);
    assert.match(cloned.body.CardIdClone, /^[0-9a-f-]{36}$/);
    const row = rows('card').find((r) => r.cardid === cloned.body.CardIdClone);
    assert.equal(row.name, 'Clone');
    const json = await act('Microsoft.Dynamics.CRM.CardGetFullJson', { CardId: cloned.body.CardIdClone });
    assert.equal(json.body.CardFullJson, '{"type":"card"}');
    const unknown = await act('Microsoft.Dynamics.CRM.CardGetFullJson', {
      CardId: 'a3000000-0000-4000-8000-0000000000ee',
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, '0x80040217');
  });

  it('an NPS score outside 0 to 10 is refused; a valid one answers 204', async () => {
    const base = { AppModuleId: 'app', Browser: 'Edge', Device: 'Desktop' };
    assert.equal((await act('Microsoft.Dynamics.CRM.CreateNPSUserRating', { ...base, Score: 7 })).status, 204);
    const high = await act('Microsoft.Dynamics.CRM.CreateNPSUserRating', { ...base, Score: 11 });
    assert.equal(high.status, 400);
    assert.equal(high.body.error.code, '0x80040203');
  });

  it('UpdateFeatureConfig stores the config and answers 204', async () => {
    const result = await act('Microsoft.Dynamics.CRM.UpdateFeatureConfig', {
      FeatureType: 3,
      ConfigData: '{"on":true}',
    });
    assert.equal(result.status, 204);
    assert.equal(store.state.dataverse.featureConfig[3], '{"on":true}');
  });

  it('a Power BI message with no pack handler answers FeatureNotEnabled', async () => {
    const result = await act('Microsoft.Dynamics.CRM.GetPBIReportRefreshStatus', { ReportId: REPORT });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, '0x80061113');
    assert.match(result.body.error.message, /isn’t enabled for your organization/);
    assert.equal(
      (await act('Microsoft.Dynamics.CRM.ImportCardTypeSchema', { ImportCardTypeSchema: '{}' })).body.error.code,
      '0x80061113',
    );
  });

  it('a trusted pack handler replaces the Power BI default', async () => {
    const pack = addonHandlerExtension(
      addonHandlers([
        {
          id: 'contoso-pack',
          dataverseMessages: {
            GetPBIReportRefreshStatus: async (ctx) => ({
              ReportRefreshStatusState: 'Succeeded',
              ReportRefreshStatusStartTime: ctx.args.ReportId,
              ReportRefreshStatusEndTime: null,
            }),
          },
        },
      ]),
    );
    const replaced = await start([pack]);
    try {
      const result = await replaced.send('POST', 'Microsoft.Dynamics.CRM.GetPBIReportRefreshStatus', {
        ReportId: REPORT,
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.ReportRefreshStatusState, 'Succeeded');
      assert.equal(result.body.ReportRefreshStatusStartTime, REPORT);
    } finally {
      await replaced.close();
    }
  });

  it('analytics and Finance and Operations probes answer their documented defaults', async () => {
    const analytics = await send('GET', 'Microsoft.Dynamics.CRM.RetrieveAnalyticsStoreDetails()');
    assert.equal(analytics.status, 200);
    assert.deepEqual(analytics.body.AnalyticsStoreDetails, { Endpoint: null });
    const fo = await send('GET', 'Microsoft.Dynamics.CRM.RetrieveFinanceAndOperationsIntegrationDetails()');
    assert.equal(fo.body.IsUnifiedDatabase, false);
  });
});

describe('card, profile and feature-control messages refuse a Basic User on rows the caller cannot reach', () => {
  const ADMIN_APP_ID = APP_ID;
  const BASIC_APP_ID = '99999999-9999-9999-9999-999999999999';
  const BASIC_SECRET_VAR = 'PAQVILO_FEATURECONTROL_BASIC_SECRET';
  const ADMIN_CARD = 'a3100000-0000-4000-8000-000000000001';
  const ADMIN_PROFILE = 'a1100000-0000-4000-8000-000000000001';
  const ADMIN_ITEM = 'a2100000-0000-4000-8000-000000000001';
  const ATOMIC_PROFILE = 'a1100000-0000-4000-8000-000000000002';
  const ATOMIC_ITEM = 'a2100000-0000-4000-8000-000000000002';
  const ATOMIC_ASSOCIATION = 'a6100000-0000-4000-8000-000000000001';
  const DEFINITION = '{"secret":"CARD-DEF"}';
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
  // The Web API refusal of the same row for the Basic User, to compare against the message refusal.
  async function directRefusal(method, path, body) {
    const result = await request(basic, method, path, body);
    assert.equal(result.status, 403, path);
    return result.body.error.code;
  }
  const guarded = () =>
    JSON.stringify({
      card: store.state.tables.card,
      mobileofflineprofile: store.state.tables.mobileofflineprofile,
      mobileofflineprofileitem: store.state.tables.mobileofflineprofileitem,
      featureConfig: store.state.dataverse?.featureConfig ?? null,
    });

  before(async () => {
    process.env[SECRET_VAR] = 'featurecontrol-secret';
    process.env[BASIC_SECRET_VAR] = 'featurecontrol-basic-secret';
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: ADMIN_APP_ID,
          displayName: 'Feature app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
        {
          appId: BASIC_APP_ID,
          displayName: 'Feature basic app',
          secretEnvironmentVariable: BASIC_SECRET_VAR,
          roles: ['Basic User'],
        },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: EXTENSIONS });
    admin = await tokenFor(api, ADMIN_APP_ID, SECRET_VAR);
    basic = await tokenFor(api, BASIC_APP_ID, BASIC_SECRET_VAR);
    // The administrator's rows, created through the Web API so the store stamps the administrator as their owner.
    const card = await request(admin, 'POST', 'cards', {
      cardid: ADMIN_CARD,
      name: 'Invented admin card',
      appdefinition: DEFINITION,
    });
    assert.equal(card.status, 204);
    const profile = await request(admin, 'POST', 'mobileofflineprofiles', {
      mobileofflineprofileid: ADMIN_PROFILE,
      name: 'Invented admin profile',
    });
    assert.equal(profile.status, 204);
    await store.transact(() => {
      store.state.tables.mobileofflineprofileitem.push({
        mobileofflineprofileitemid: ADMIN_ITEM,
        regardingobjectid: ADMIN_PROFILE,
        name: 'Invented admin item',
      });
    });
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    delete process.env[BASIC_SECRET_VAR];
    await api?.close();
  });

  // @test-kind security: a Basic User must not read a card definition the administrator owns, the same refusal as a direct read.
  it('a Basic User cannot read an admin card definition through CardGetFullJson', async () => {
    const code = await directRefusal('GET', `cards(${ADMIN_CARD})`);
    const result = await request(basic, 'POST', 'Microsoft.Dynamics.CRM.CardGetFullJson', { CardId: ADMIN_CARD });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, code);
    assert.equal(JSON.stringify(result.body).includes('CARD-DEF'), false);
  });

  // @test-kind security: the System Administrator still reads the card definition through CardGetFullJson.
  it('the System Administrator still reads the card definition through CardGetFullJson', async () => {
    const result = await request(admin, 'POST', 'Microsoft.Dynamics.CRM.CardGetFullJson', { CardId: ADMIN_CARD });
    assert.equal(result.status, 200);
    assert.equal(result.body.CardFullJson, DEFINITION);
  });

  // @test-kind security: a Basic User must not copy an admin card, the same refusal as a direct read, and no card is written.
  it('a Basic User cannot copy an admin card through CardCreateClone, and no card is written', async () => {
    const code = await directRefusal('GET', `cards(${ADMIN_CARD})`);
    const before = guarded();
    const result = await request(basic, 'POST', 'Microsoft.Dynamics.CRM.CardCreateClone', {
      CardName: 'Invented intruder card',
      CardId: ADMIN_CARD,
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, code);
    assert.equal(guarded(), before);
  });

  // @test-kind security: the System Administrator still copies a card, and the copy holds the same definition.
  it('the System Administrator still copies a card through CardCreateClone', async () => {
    const result = await request(admin, 'POST', 'Microsoft.Dynamics.CRM.CardCreateClone', {
      CardName: 'Invented admin copy',
      CardId: ADMIN_CARD,
    });
    assert.equal(result.status, 200);
    const copy = store.state.tables.card.find((row) => row.cardid === result.body.CardIdClone);
    assert.equal(copy.appdefinition, DEFINITION);
  });

  // @test-kind security: a Basic User must not clone an admin profile, the same refusal as a direct read, and nothing is written.
  it('a Basic User cannot clone an admin mobile offline profile, and nothing is written', async () => {
    // Basic User reads the profile but may not create one, so the copy is refused on the create privilege, as a direct create is.
    const code = await directRefusal('POST', 'mobileofflineprofiles', { name: 'Invented direct profile' });
    const before = guarded();
    const result = await request(
      basic,
      'POST',
      `mobileofflineprofiles(${ADMIN_PROFILE})/Microsoft.Dynamics.CRM.CloneMobileOfflineProfile`,
      {},
    );
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, code);
    assert.equal(guarded(), before);
  });

  // @test-kind security: the System Administrator still clones a profile with its item under a new id.
  it('the System Administrator still clones a mobile offline profile with its item', async () => {
    const result = await request(
      admin,
      'POST',
      `mobileofflineprofiles(${ADMIN_PROFILE})/Microsoft.Dynamics.CRM.CloneMobileOfflineProfile`,
      {},
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.name, 'Invented admin profile (Copy)');
    const items = store.state.tables.mobileofflineprofileitem.filter(
      (row) => row.regardingobjectid === result.body.mobileofflineprofileid,
    );
    assert.equal(items.length, 1);
  });

  // @test-kind contract: a clone is one unit, so a copy refused on a later association leaves no profile or item copy behind.
  it('a clone refused on a later association leaves no profile or item copy behind', async () => {
    store.state.tables.mobileofflineprofile.push({
      mobileofflineprofileid: ATOMIC_PROFILE,
      name: 'Invented atomic profile',
      statecode: 0,
    });
    store.state.tables.mobileofflineprofileitem.push({
      mobileofflineprofileitemid: ATOMIC_ITEM,
      regardingobjectid: ATOMIC_PROFILE,
      name: 'Invented atomic item',
    });
    store.state.tables.mobileofflineprofileitemassociation.push({
      mobileofflineprofileitemassociationid: ATOMIC_ASSOCIATION,
      mobileofflineprofileitemid: ATOMIC_ITEM,
      name: 'x'.repeat(201),
    });
    const profiles = store.state.tables.mobileofflineprofile.length;
    const items = store.state.tables.mobileofflineprofileitem.length;
    const result = await request(
      admin,
      'POST',
      `mobileofflineprofiles(${ATOMIC_PROFILE})/Microsoft.Dynamics.CRM.CloneMobileOfflineProfile`,
      {},
    );
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(store.state.tables.mobileofflineprofile.length, profiles);
    assert.equal(store.state.tables.mobileofflineprofileitem.length, items);
  });

  // @test-kind security: a Basic User must not store the organization feature configuration, which only the administrator may.
  it('a Basic User cannot update the feature configuration, and the stored one is unchanged', async () => {
    const before = guarded();
    const result = await request(basic, 'POST', 'Microsoft.Dynamics.CRM.UpdateFeatureConfig', {
      FeatureType: 3,
      ConfigData: '{"on":false}',
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, '0x80040220');
    assert.equal(guarded(), before);
  });

  // @test-kind security: the System Administrator still stores the feature configuration.
  it('the System Administrator still updates the feature configuration', async () => {
    const result = await request(admin, 'POST', 'Microsoft.Dynamics.CRM.UpdateFeatureConfig', {
      FeatureType: 3,
      ConfigData: '{"on":true}',
    });
    assert.equal(result.status, 204);
    assert.equal(store.state.dataverse.featureConfig[3], '{"on":true}');
  });
});

describe('a card clone refused by its after-write hook writes no card', () => {
  const HOOK_APP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const HOOK_SECRET = 'PAQVILO_FEATURECONTROL_HOOK_SECRET';
  const SOURCE_CARD = 'a3200000-0000-4000-8000-000000000001';
  const REFUSED_NAME = 'Invented refused clone';
  // Refuses the copy after its row is written, the stage a plug-in or a later module can fail at.
  const refusingHook = {
    name: 'featurecontrol-test-after-write',
    install(api) {
      api.recordHooks.add('afterWrite', (c, mapping, info) => {
        if (mapping.logicalName !== 'card') return;
        const row = api.store.state.tables.card.find((item) => item.cardid === info.id);
        if (row?.name === REFUSED_NAME) throw new Error('the test hook refuses this copy');
      });
    },
  };

  // @test-kind contract: a card clone is one unit, so a copy refused after its write leaves no card row behind.
  it('a copy refused by the after-write hook leaves no card row behind', async () => {
    process.env[HOOK_SECRET] = 'featurecontrol-hook-secret';
    const store = await new DataStore({ state: emptyState() }).init();
    const started = await startDataverseApi({
      store,
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: HOOK_APP,
            displayName: 'Feature hook app',
            secretEnvironmentVariable: HOOK_SECRET,
            roles: ['System Administrator'],
          },
        ],
      }),
      log: () => {},
      extensions: [...EXTENSIONS, refusingHook],
    });
    try {
      const response = await fetch(`${started.origin}/${started.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: HOOK_APP,
          client_secret: process.env[HOOK_SECRET],
          scope: `${started.origin}/.default`,
        }),
      });
      const token = (await response.json()).access_token;
      store.state.tables.card = [
        { cardid: SOURCE_CARD, name: 'Invented source card', appdefinition: '{"type":"card"}' },
      ];
      const before = store.state.tables.card.length;
      const result = await fetch(`${started.origin}/api/data/${VERSION}/Microsoft.Dynamics.CRM.CardCreateClone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ CardName: REFUSED_NAME, CardId: SOURCE_CARD }),
      });
      assert.notEqual(result.status, 200, await result.text());
      assert.equal(store.state.tables.card.length, before);
      assert.equal(
        store.state.tables.card.some((row) => row.name === REFUSED_NAME),
        false,
      );
    } finally {
      delete process.env[HOOK_SECRET];
      await started.close();
    }
  });
});
