import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

// On the Power Pages host the model-driven catalogue holds the portal provider's site tables; a dashboard list over one
// renders on the page, so its preflight row is satisfied as well (one table set for row and page).
test('a dashboard list over a portal site table is satisfied on the Power Pages host, as its page renders it', async (t) => {
  const initial = await modelDrivenFixture(t, {}, { started: false });
  const BOARD = '77777777-7777-4777-8777-7777777777c1';
  await fs.writeFile(
    path.join(initial.solutionDir, 'Other/Customizations.xml'),
    `<ImportExportXml><Dashboards><Dashboard><FormId>{${BOARD}}</FormId><LocalizedNames><LocalizedName description="Site board" languagecode="1033"/></LocalizedNames><FormXml><forms type="dashboard"><systemform><formid>{${BOARD}}</formid><form><tabs><tab><columns><column><sections><section><rows><row><cell><labels><label description="Pages" languagecode="1033"/></labels><control id="p" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"><parameters><TargetEntityType>adx_webpage</TargetEntityType></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml></Dashboard></Dashboards></ImportExportXml>`,
  );
  const siteMap = path.join(initial.solutionDir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
  await fs.writeFile(
    siteMap,
    (await fs.readFile(siteMap, 'utf8')).replace(
      '<SubArea Id="items"',
      `<SubArea Id="board" DefaultDashboard="{${BOARD}}"/><SubArea Id="items"`,
    ),
  );
  const sim = await initial.start();
  ownedFixture(t).add(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const report = await (await fetch(`${origin}/_sim/api/preflight`)).json();
  const row = report.requirements.find((entry) => entry.id === 'model-driven:dashboard/x_example/board');
  assert.deepEqual([row?.status, row?.reason ?? null], ['satisfied', null]);
  const page = await (await fetch(`${origin}/_apps/api/index`)).json();
  assert.equal(
    page.apps.find((app) => app.uniqueName === 'x_example').dashboards.find((entry) => entry.id === BOARD).components[0]
      .supported,
    true,
  );
});
