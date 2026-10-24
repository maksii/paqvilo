import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSiteMap } from '../lib/model-driven/solution.mjs';
import { appCatalogue, MODEL_DRIVEN_CAPABILITY_RECORDS } from '../lib/model-driven/catalogue.mjs';
import { createFormClientRuntime, pageRequest } from '../lib/model-driven/client-runtime.mjs';

const siteMap = `<SiteMap><Area Id="main"><Group Id="pages">
  <SubArea Id="table" Entity="x_item"/>
  <SubArea Id="page" Url="$webresource:x_/pages/summary.html"/>
  <SubArea Id="missing" Url="$webresource:x_/pages/missing.html"/>
  <SubArea Id="custom" Url="/main.aspx?pagetype=custom&amp;name=x_invented_page"/>
  <SubArea Id="dashboard" DefaultDashboard="{77777777-7777-4777-8777-777777777777}"/>
  <SubArea Id="external" Url="https://example.test/"/>
</Group></Area></SiteMap>`;

test("SiteMap destinations get distinct codes; custom pages wait for the app's components, unresolved dashboards and external URLs are not hosted", () => {
  const items = Object.fromEntries(parseSiteMap(siteMap)[0].groups[0].items.map((item) => [item.id, item]));
  assert.equal(items.table.entity, 'x_item');
  assert.equal(items.table.supported, true);
  assert.deepEqual(
    [items.page.kind, items.page.code, items.page.webresource, items.page.supported],
    ['webresource', 'MD_NAV_WEBRESOURCE', 'x_/pages/summary.html', true],
  );
  assert.deepEqual(
    [items.custom.kind, items.custom.code, items.custom.page, items.custom.supported, items.custom.reason],
    [
      'custom',
      'MD_NAV_CUSTOM_PAGE',
      'x_invented_page',
      false,
      'Custom page x_invented_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).',
    ],
  );
  assert.deepEqual([items.dashboard.code, items.dashboard.supported], ['MD_NAV_DASHBOARD', false]);
  assert.deepEqual([items.external.code, items.external.supported], ['MD_NAV_URL', false]);
});

test('the catalogue opens imported trusted HTML web resources and lists inventory-only capabilities', () => {
  const app = { id: '77777777-7777-4777-8777-777777777777', uniqueName: 'x_app', navigation: parseSiteMap(siteMap) };
  const catalogue = appCatalogue({
    metadata: { modelDrivenApps: [app], entities: {} },
    mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' } },
    clientExtensions: {
      trusted: true,
      resources: [{ name: 'x_/pages/summary.html', type: 'page', url: '/_apps/resources/summary' }],
    },
  });
  const items = Object.fromEntries(catalogue.apps[0].navigation[0].groups[0].items.map((item) => [item.id, item]));
  assert.equal(items.page.url, '/_apps/resources/summary');
  assert.equal(items.page.supported, true);
  assert.equal(items.missing.supported, false);
  assert.match(items.missing.reason, /not imported/);
  // Mobile offline is hosted per staff session (model-driven/offline.mjs, model-driven-offline.test.mjs).
  assert.deepEqual(
    catalogue.capabilityRecords.map((record) => [record.name, record.level]),
    [
      ['model-driven:offline', 'behaviour'],
      ['model-driven:custom-page', 'behaviour'],
      ['model-driven:dashboard', 'behaviour'],
    ],
  );
  assert.equal(MODEL_DRIVEN_CAPABILITY_RECORDS[0].code, 'MD_OFFLINE');
  assert.equal(catalogue.capabilities.offline, true);
  assert.equal(catalogue.capabilities.customPages, false);
});

test("a custom page resolves only against the app's own canvas app components and the canvas host", () => {
  const app = (components) => ({
    id: '77777777-7777-4777-8777-777777777777',
    uniqueName: 'x_app',
    navigation: parseSiteMap(siteMap),
    components,
  });
  const custom = (components, canvasApps) => {
    const catalogue = appCatalogue({
      metadata: { modelDrivenApps: [app(components)], entities: {} },
      mappings: {},
      canvasApps,
    });
    const item = catalogue.apps[0].navigation[0].groups[0].items.find((entry) => entry.id === 'custom');
    return [item.supported, item.reason, catalogue.capabilities.customPages, catalogue.apps[0].customPages];
  };
  const own = [{ type: 300, entity: 'x_invented_page' }];
  assert.deepEqual(custom(own, ['X_Invented_Page']), [true, undefined, true, { x_invented_page: { supported: true } }]);
  assert.deepEqual(custom([{ type: 1, entity: 'x_invented_page' }], ['x_invented_page']).slice(0, 3), [
    false,
    'Custom page x_invented_page is not a canvas app component of this app (MD_NAV_CUSTOM_PAGE).',
    true,
  ]);
  assert.deepEqual(custom(own, ['x_other']).slice(0, 2), [
    false,
    'Custom page x_invented_page has no canvas app in the canvas sources (MD_NAV_CUSTOM_PAGE).',
  ]);
  assert.deepEqual(custom(own, null).slice(0, 3), [
    false,
    'Custom page x_invented_page needs the canvas host, which is not enabled in this runtime (MD_NAV_CUSTOM_PAGE).',
    false,
  ]);
});

test('navigateTo validates page input; custom pages pass name, entityName and recordId to the shell; offline APIs fail explicitly', async () => {
  const table = {
    entity: 'x_item',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    entitySet: 'x_items',
    fields: { x_name: { name: 'x_name', type: 'text' } },
  };
  const opened = [];
  const { Xrm } = createFormClientRuntime({
    table,
    tables: { x_item: table },
    form: { clientEvents: [], attributes: ['x_name'] },
    record: {},
    read: () => null,
    write() {},
    isDirty: () => false,
    controlNames: (name) => (name ? [name] : ['x_name']),
    controlField: (name) => name,
    controlState() {},
    notification() {},
    request: async () => ({}),
    openPage: async (input, options) => {
      opened.push([input, options]);
      return { closed: true };
    },
    sidePanes: { createPane: async () => ({ paneId: 'p' }) },
  });
  assert.deepEqual(
    await Xrm.Navigation.navigateTo(
      { pageType: 'webresource', webresourceName: 'x_/pages/summary.html', data: 'a=1' },
      { target: 2, position: 2, width: 400 },
    ),
    { closed: true },
  );
  assert.deepEqual(opened[0], [
    { pageType: 'webresource', webresourceName: 'x_/pages/summary.html', data: 'a=1' },
    { target: 2, position: 2, width: 400 },
  ]);
  await Xrm.Navigation.navigateTo({
    pageType: 'entityrecord',
    entityName: 'x_item',
    entityId: '{77777777-7777-4777-8777-77777777777A}',
  });
  assert.deepEqual(opened[1][0], {
    pageType: 'entityrecord',
    entityName: 'x_item',
    entityId: '77777777-7777-4777-8777-77777777777a',
  });
  await Xrm.Navigation.navigateTo(
    {
      pageType: 'custom',
      name: 'x_invented_page',
      entityName: 'x_item',
      recordId: '{77777777-7777-4777-8777-77777777777A}',
    },
    { target: 2 },
  );
  assert.deepEqual(opened[2], [
    {
      pageType: 'custom',
      name: 'x_invented_page',
      entityName: 'x_item',
      recordId: '77777777-7777-4777-8777-77777777777a',
    },
    { target: 2, position: 1 },
  ]);
  // The recordId must be a GUID.
  await assert.rejects(
    Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'x_invented_page', recordId: 'invented' }),
    /GUID/,
  );
  await assert.rejects(Xrm.Navigation.navigateTo({ pageType: 'custom' }), /logical name/);
  await assert.rejects(
    Xrm.Navigation.navigateTo({ pageType: 'dashboard' }),
    (error) => error.code === 'DashboardPageUnsupported',
  );
  await assert.rejects(Xrm.Navigation.navigateTo({ pageType: 'entitylist', entityName: 'x_unknown' }), /not imported/);
  await assert.rejects(
    Xrm.Navigation.navigateTo({ pageType: 'entitylist', entityName: 'x_item' }, { target: 3 }),
    /target/,
  );
  assert.equal((await Xrm.App.sidePanes.createPane()).paneId, 'p');
  // Without a host offline store (an app with no offline profile) the offline members reject explicitly.
  await assert.rejects(
    Xrm.WebApi.offline.retrieveRecord('x_item', '77777777-7777-4777-8777-77777777777a'),
    (error) => error.code === 'OfflineSyncUnavailable',
  );
  assert.equal(Xrm.WebApi.offline.isAvailableOffline('x_item'), false);
  assert.equal(Xrm.Utility.getGlobalContext().client.getClientState(), 'Online');
  assert.throws(() => pageRequest({ pageType: 'webresource' }), /webresourceName/);
});
