import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser();

test('a source-localized classic ribbon label reaches the model-driven command bar', async (t) => {
  const source = await modelDrivenFixture(t, { defer: true });
  await fs.writeFile(
    path.join(source.solutionDir, 'Entities/x_item/RibbonDiff.xml'),
    '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.HomePageGrid.Review" Command="x.Review" LabelText="$LocLabels:x.Label"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Review"><Actions><JavaScriptFunction Library="$webresource:x_/review.js" FunctionName="Invented.review"/></Actions></CommandDefinition></CommandDefinitions><LocLabels><LocLabel Id="x.Label"><Titles><Title languagecode="1033" description="Review invented item"/><Title languagecode="1036" description="Reviser element invente"/></Titles></LocLabel></LocLabels></RibbonDiffXml>',
  );
  const sim = await source.start({ dataverse: { localeId: 1036 } });
  const page = await browser.page(t, { viewport: { width: 1800, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(sim.url + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const command = page
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .getByRole('button', { name: 'Reviser element invente', exact: true });
  await command.waitFor();
  assert.equal(
    await command.isDisabled(),
    true,
    'source labels do not bypass the explicit trust requirement for scripts',
  );
  assert.equal(await page.getByRole('button', { name: 'Review invented item', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});
