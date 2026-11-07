import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';

const chrome = sharedBrowser();
// Both tests only read the dashboard, so they share one simulator.
const scope = fileScope();
let sharedOrigin;

const BOARD = '77777777-7777-4777-8777-77777777777d';
const GRID = '{E7A81278-8635-4D9E-8D4D-59480B391C5B}';
const cell = (label, control) =>
  `<row><cell><labels><label description="${label}" languagecode="1033"/></labels>${control}</cell></row>`;
// An exported Customizations.xml dashboard: a list, a chart and a web resource.
const CUSTOMIZATIONS = `<ImportExportXml><Dashboards><Dashboard><FormId>{${BOARD}}</FormId><LocalizedNames><LocalizedName description="Invented board" languagecode="1033"/></LocalizedNames>
<FormXml><forms type="dashboard"><systemform><formid>{${BOARD}}</formid><form><tabs><tab><columns><column><sections><section><rows>
${cell('Stocked list', `<control id="list" classid="${GRID}"><parameters><TargetEntityType>x_item</TargetEntityType><ViewId>{items-view}</ViewId><RecordsPerPage>5</RecordsPerPage><ChartGridMode>Grid</ChartGridMode></parameters></control>`)}
${cell('Stock chart', `<control id="chart" classid="${GRID}"><parameters><TargetEntityType>x_item</TargetEntityType><ViewId>{items-view}</ViewId><VisualizationId>{77777777-7777-4777-8777-77777777777e}</VisualizationId><ChartGridMode>Chart</ChartGridMode></parameters></control>`)}
${cell('Banner', '<control id="WebResource_banner" classid="{9FDF5F91-88B1-47f4-AD53-C11EFC01A01D}"><parameters><Url>x_/banner.html</Url></parameters></control>')}
</rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml></Dashboard></Dashboards></ImportExportXml>`;

async function startDashboardApp() {
  const initial = await modelDrivenFixture(scope, { defer: true });
  const dir = initial.solutionDir;
  await fs.writeFile(path.join(dir, 'Other/Customizations.xml'), CUSTOMIZATIONS);
  const siteMap = path.join(dir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
  await fs.writeFile(
    siteMap,
    (await fs.readFile(siteMap, 'utf8')).replace(
      '<SubArea Id="items"',
      `<SubArea Id="board" DefaultDashboard="{${BOARD}}"><Titles><Title LCID="1033" Title="Overview"/></Titles></SubArea><SubArea Id="items"`,
    ),
  );
  const sim = await initial.start();
  return sim.origin ?? sim.url;
}

async function fixture(t) {
  const origin = await (sharedOrigin ??= startDashboardApp());
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, origin, errors };
}

test('a SiteMap dashboard renders its list over the view query and names the components it does not render', async (t) => {
  const { page, origin, errors } = await fixture(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('heading', { name: 'Invented board', exact: true }).waitFor();
  assert.match(page.url(), new RegExp(`pagetype=dashboard&id=${BOARD}`));
  const list = page.getByRole('table', { name: 'Stocked list' });
  await list.getByText('Silver', { exact: true }).waitFor();
  // The saved query keeps quantity >= 1: Empty (0) is filtered out by the view, as on the table grid.
  assert.equal(await list.getByText('Empty', { exact: true }).count(), 0);
  const gaps = await page
    .getByRole('region', { name: 'Components not rendered locally' })
    .getByRole('listitem')
    .allTextContents();
  assert.deepEqual(gaps, [
    'Stock chart: Charts are not rendered on local dashboards.',
    'Banner: web resource components are not rendered on local dashboards.',
  ]);
  assert.deepEqual(errors, []);
});

test('navigateTo with pageType dashboard opens the dashboard inline; an unknown dashboard rejects', async (t) => {
  const { page, origin, errors } = await fixture(t);
  await page.goto(
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm);
  assert.equal(
    await page.evaluate(() =>
      window.Xrm.Navigation.navigateTo({
        pageType: 'dashboard',
        dashboardId: '77777777-7777-4777-8777-000000000000',
      }).catch((error) => error.code),
    ),
    'DashboardPageUnsupported',
  );
  await page.evaluate((id) => {
    window.Xrm.Navigation.navigateTo({ pageType: 'dashboard', dashboardId: id });
  }, BOARD);
  await page.getByRole('heading', { name: 'Invented board', exact: true }).waitFor();
  await page.getByRole('table', { name: 'Stocked list' }).getByText('Copper', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
