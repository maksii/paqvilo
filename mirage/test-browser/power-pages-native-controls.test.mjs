// @test-kind observation: two native portal runs (2026-11-08) and a producer refresh (2026-11-09) recorded as hashes in fixtures/frontend-parity-evidence.json and fixtures/power-pages-controls-producer-refresh-2026-11-09.json; raw captures are not committed and the field and group input is typed in the fixture module, so it is not a replay case
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { capturePowerPagesControlContract } from '../testing/power-pages-controls.mjs';
import { capturePowerPagesClientContract } from '../testing/power-pages-client.mjs';
import { powerPagesControlsFixture } from '../test/fixtures/power-pages-controls.mjs';
import { sharedBrowser } from './shared-browser.mjs';
const browser = sharedBrowser();
const read = (name, checksum) => {
  const bytes = fs.readFileSync(new URL('../test/fixtures/' + name, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
  return JSON.parse(bytes);
};

let controls, client, properties;

test.before(() => {
  assert.equal(
    createHash('sha256').update(capturePowerPagesControlContract.toString()).digest('hex'),
    '3c2c3fb1447e7ac650005f4db0cf5b503717f2c9a12ef49ec39729978260814b',
  );
  // The client probe source is the one recorded in fixtures/power-pages-client-native-refresh-2026-11-12.json.
  assert.equal(
    createHash('sha256').update(capturePowerPagesClientContract.toString()).digest('hex'),
    '7a77facc295d5313ec4ec7e1338d95b5d5574901bcf3a99e48b469683e727150',
  );
  controls = read(
    'power-pages-controls-expected.json',
    '6497bea4d8e3307073c5dacfeb6d74ee679bf4b3799153bd83afd2cfc2271d78',
  );
  client = read('power-pages-client-expected.json', '7c380709e7abaee657543aeb4815a6bcd8eec7eeb478e6c7354d5c3e7dcc1779');
  properties = read(
    'power-pages-client-properties-expected.json',
    'ccec9eaec7c1083f9b3a2aee8f65021880d369593040a226d29c9c1b76589e73',
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../test/fixtures/frontend-parity-evidence.json', import.meta.url)),
  );
  assert.equal(
    manifest.suites.find((suite) => suite.id === 'power-pages-rendered-controls').propertiesProbeFunctionSha256,
    '0470b713c237c14997d9b2623a052a708a9fd8f63d76eb3edc0de0168e8431dd',
  );
});

test('rendered Power Pages controls, authored input feedback and client context reproduce native results', async (t) => {
  const fixture = await powerPagesControlsFixture(t),
    page = await browser.page(t);
  await page.goto(fixture.simulator.url);
  await page.locator('#InsertButton').waitFor();
  assert.deepEqual(await page.evaluate(capturePowerPagesControlContract, fixture.input), controls);
  assert.deepEqual(await page.evaluate(capturePowerPagesClientContract, fixture.input), client);
  const actual = await page.evaluate(async (input) => {
    const pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
    const form = pages.currentPage.forms.getAll().find((form) => form.getControlByLogicalName(input.fields[0].name));
    const absent = (value) => (value === undefined ? { undefined: true } : value);
    return [...input.fields, ...input.groups].map((spec) => {
      const control = form.getControlByLogicalName(spec.name),
        node = document.getElementById(spec.name);
      const label = document.getElementById(spec.name + '_label');
      return {
        role: spec.role,
        type: control.getType(),
        nameMatchesHtml: control.getName() === node.getAttribute('name'),
        nameMatchesLabel: control.getName() === label?.textContent.trim(),
        properties: Object.fromEntries(
          ['isReadOnly', 'isReadonly', 'readOnly'].map((key) => [key, absent(control[key])]),
        ),
        ...(control.getType() === 'AddressComposite'
          ? { editable: node.getAttribute('data-editable'), domReadOnly: node.readOnly }
          : {}),
      };
    });
  }, fixture.input);
  assert.deepEqual(
    actual,
    properties,
    'getName must positively equal each rendered source label, with native type-specific properties',
  );
});
