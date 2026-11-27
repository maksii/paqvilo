// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-02c (geo.json, runs a and b, 2026-11-26): a basic form with geolocation draws its hidden mapping fields in the section_map section (the neighbourhood field's platform default adx_location_neighorhood, the postal code as geolocation_portalcodefieldname), the page loads the Bing Maps control and /xrm-adx/js/bingmap.js, and a post saves the address without latitude and longitude; replayed on invented loopback fixtures
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '72000000-0000-4000-8000-000000000001';
const CONTACT = '72000000-0000-4000-8000-000000000002';
const FORM = '72000000-0000-4000-8000-000000000003';
const BASIC_FORM = '72000000-0000-4000-8000-000000000004';
const TEXT = '{4273EDBD-AC1D-40D3-9FB2-095C621B552D}';
const attribute = (name, type) =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type><displaynames><displayname description="${name.replace('x_', '')}" languagecode="1033"/></displaynames></attribute>`;
const cell = (name) =>
  `<row><cell><labels><label description="${name.replace('x_', '')}" languagecode="1033"/></labels><control id="${name}" classid="${TEXT}" datafieldname="${name}"/></cell></row>`;
const formXml = (mapSection) =>
  `<systemform><formid>{${FORM}}</formid><type>2</type><LocalizedNames><LocalizedName description="Place" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><columns><column><sections><section name="address" showlabel="true"><labels><label description="Address" languagecode="1033"/></labels><rows>${['x_name', 'x_street', 'x_city', 'x_postal'].map(cell).join('')}</rows></section><section name="${mapSection}" showlabel="true"><labels><label description="Map" languagecode="1033"/></labels><rows><row/></rows></section></sections></column></columns></tab></tabs></form></systemform>`;

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function launch(t, { mapSection = 'section_map', siteSettings = '' } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'form-geolocation-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented places`,
    ...(siteSettings ? { 'portal/sitesetting.yml': siteSettings } : {}),
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': "<html><body>{% entityform name: 'Place insert' %}</body></html>",
    'portal/Place.basicform.yml': [
      `adx_entityformid: ${BASIC_FORM}`,
      'adx_name: Place insert',
      'adx_entityname: x_place',
      'adx_formname: Place',
      'adx_mode: 100000000',
      'adx_onsuccess: 756150000',
      'adx_successmessage: Place saved',
      'adx_geolocation_enabled: true',
      'adx_geolocation_displaymap: true',
      'adx_geolocation_maptype: 756150000',
      'adx_geolocation_addresslinefieldname: x_street',
      'adx_geolocation_cityfieldname: x_city',
      'adx_geolocation_postalcodefieldname: x_postal',
      'adx_geolocation_latitudefieldname: x_latitude',
      'adx_geolocation_longitudefieldname: x_longitude',
    ].join('\n'),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedPlaces</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_place/Entity.xml': `<Entity><Name>x_place</Name><EntityInfo><entity Name="x_place"><EntitySetName>x_places</EntitySetName><attributes>${attribute('x_placeid', 'primarykey')}${['x_name', 'x_street', 'x_city', 'x_postal'].map((name) => attribute(name, 'nvarchar')).join('')}${attribute('x_latitude', 'float')}${attribute('x_longitude', 'float')}</attributes></entity></EntityInfo></Entity>`,
    [`solution/Entities/x_place/FormXml/main/${FORM}.xml`]: formXml(mapSection),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    initial: {
      version: 1,
      mappings: { x_place: { entitySet: 'x_places', idColumn: 'x_placeid', nameColumn: 'x_name' } },
      tables: { contact: [{ contactid: CONTACT, fullname: 'Invented Contact', statecode: 0 }], x_place: [] },
      settings: { permissionMode: 'permissive' },
    },
    watch: false,
    port: 0,
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

test('a geolocation basic form draws its mapping fields, loads the map scripts and saves the address without coordinates', async (t) => {
  const app = await launch(t);
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, {});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The Bing Maps control is another site (blocked by the platform's Content Security Policy).
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.fallback() : route.abort()));
  await page.goto(`${app.url}/`);
  const map = page.locator('fieldset[aria-label="Map"]');
  assert.deepEqual(
    await map.evaluate((fieldset) =>
      [...fieldset.querySelectorAll(':scope > div > input[type=hidden]')].map((input) => [
        input.id,
        input.getAttribute('value'),
        input.name.endsWith('$' + input.id),
      ]),
    ),
    [
      ['geolocation_latitudefieldname', 'x_latitude', true],
      ['geolocation_longitudefieldname', 'x_longitude', true],
      ['geolocation_addresslinefieldname', 'x_street', true],
      ['geolocation_neighbourhoodfieldname', 'adx_location_neighorhood', true],
      ['geolocation_cityfieldname', 'x_city', true],
      ['geolocation_countyfieldname', null, true],
      ['geolocation_statefieldname', null, true],
      ['geolocation_countryfieldname', null, true],
      ['geolocation_portalcodefieldname', 'x_postal', true],
      ['geolocation_formattedlocationfieldname', null, true],
      ['bingmapsresturl', 'https://dev.virtualearth.net/REST/v1/Locations/', true],
      ['bingmapscredentials', null, true],
    ],
  );
  assert.equal(await map.locator(':scope > div + table[data-name="section_map"]').count(), 1);
  // The page's map scripts, as the capture lists them.
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.scripts].map((script) => script.src).filter((src) => /bing|virtualearth|map|geo/i.test(src)),
    ),
    ['https://www.bing.com/api/maps/mapcontrol', `${app.url}/xrm-adx/js/bingmap.js`],
  );
  const bingmap = await fetch(`${app.url}/xrm-adx/js/bingmap.js`);
  assert.deepEqual([bingmap.status, /javascript/.test(bingmap.headers.get('content-type'))], [200, true]);
  await page.fill('#x_name', 'Invented place');
  await page.fill('#x_street', '1 Invented Street');
  await page.fill('#x_city', 'Invented City');
  await Promise.all([page.waitForNavigation(), page.locator('input[name$="$InsertButton"]').click()]);
  assert.match(await page.locator('#MessagePanel').textContent(), /Place saved/);
  const [row] = app.store.tableRows('x_place');
  assert.deepEqual(
    [row.x_name, row.x_street, row.x_city, row.x_latitude ?? null, row.x_longitude ?? null],
    ['Invented place', '1 Invented Street', 'Invented City', null, null],
  );
  assert.deepEqual(errors, []);
});

// @test-kind compatibility: Learn "Add geolocation" (Form customization, Site settings): the form engine looks for a section named section_map or ending with section_map; the map uses the Bingmaps/restURL and Bingmaps/credentials site settings
test('a map section whose name ends with section_map holds the fields, with the Bing Maps site settings', async (t) => {
  const app = await launch(t, {
    mapSection: 'place_section_map',
    siteSettings: [
      '- adx_sitesettingid: 72000000-0000-4000-8000-000000000021',
      '  adx_name: Bingmaps/restURL',
      '  adx_value: https://maps.invalid/REST/v1/Locations',
      '- adx_sitesettingid: 72000000-0000-4000-8000-000000000022',
      '  adx_name: Bingmaps/credentials',
      '  adx_value: invented-map-key',
    ].join('\n'),
  });
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, {});
  const page = await context.newPage();
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.fallback() : route.abort()));
  await page.goto(`${app.url}/`);
  const values = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('table[data-name="place_section_map"]')].flatMap((table) =>
        [...table.previousElementSibling.querySelectorAll('input[type=hidden]')].map((input) => [
          input.id,
          input.getAttribute('value'),
        ]),
      ),
    ),
  );
  assert.equal(values.geolocation_latitudefieldname, 'x_latitude');
  assert.equal(values.bingmapsresturl, 'https://maps.invalid/REST/v1/Locations');
  assert.equal(values.bingmapscredentials, 'invented-map-key');
});
