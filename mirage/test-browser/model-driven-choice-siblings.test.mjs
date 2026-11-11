// @test-kind observation: a source-configured standard choice and rendered PCF sibling share Xrm option readbacks in the recorded native draft context; the component here is an invented substitute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser();

test('standard choice option changes reach a rendered PCF sibling without changing source options', async (t) => {
  const source = await modelDrivenFixture(t, { defer: true });
  const entity = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  const options = [
    [198720000, 'Planned'],
    [198720001, 'In progress'],
    [198720002, 'Complete'],
  ];
  const optionsXml = options
    .map(
      ([value, text]) =>
        `<option value="${value}"><labels><label description="${text}" languagecode="1033"/></labels></option>`,
    )
    .join('');
  const originalEntity = await fs.readFile(entity, 'utf8');
  assert.ok(originalEntity.includes('</attributes>'));
  await fs.writeFile(
    entity,
    originalEntity.replace(
      '</attributes>',
      `<attribute PhysicalName="x_choice"><Name>x_choice</Name><LogicalName>x_choice</LogicalName><Type>picklist</Type><RequiredLevel>none</RequiredLevel><optionset><options>${optionsXml}</options></optionset></attribute></attributes>`,
    ),
  );

  const pcfDir = path.join(source.solutionDir, 'Controls', 'publisher.InventedChoice');
  await fs.mkdir(pcfDir, { recursive: true });
  await fs.writeFile(
    path.join(pcfDir, 'ControlManifest.xml'),
    '<manifest><control namespace="Invented" constructor="Choice" version="1.0.0" control-type="standard"><property name="controlValue" of-type="OptionSet" usage="bound" required="true"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
  );
  await fs.writeFile(
    path.join(pcfDir, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>publisher.InventedChoice</Name></CustomControl>',
  );
  await fs.writeFile(
    path.join(pcfDir, 'bundle.js'),
    `ComponentFramework.registerControl('Invented.Choice', class {
      init(context, notify, state, container) {
        this.output = document.createElement('span');
        this.output.setAttribute('data-testid', 'invented-choice-pcf');
        this.output.textContent = 'PCF initialized';
        container.append(this.output);
      }
      updateView(context) { this.output.textContent = 'PCF ready'; window.inventedChoicePcfReady = true; }
      getOutputs() { return {}; }
      destroy() { this.output.remove(); }
    });`,
  );

  const formPath = path.join(source.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const form = await fs.readFile(formPath, 'utf8');
  const placeholder = '<row><cell><control id="unimplemented"/></cell></row>';
  assert.ok(form.includes(placeholder));
  assert.ok(form.includes('</form>'));
  const row = (id, uniqueId, label) =>
    `<row><cell><labels><label description="${label}" languagecode="1033"/></labels><control id="${id}" uniqueid="${uniqueId}" classid="{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}" datafieldname="x_choice"/></cell></row>`;
  const description =
    '<controlDescriptions><controlDescription forControl="{77777777-7777-4777-8777-7777777777a2}"><customControl name="publisher.InventedChoice" formFactor="0"><parameters><controlValue type="OptionSet">x_choice</controlValue></parameters></customControl></controlDescription></controlDescriptions>';
  await fs.writeFile(
    formPath,
    form
      .replace(
        placeholder,
        row('choice', '{77777777-7777-4777-8777-7777777777a1}', 'Standard choice') +
          row('pcf_choice', '{77777777-7777-4777-8777-7777777777a2}', 'PCF choice'),
      )
      .replace('</form>', `${description}</form>`),
  );
  const sim = await source.start({ modelDriven: { trustedExtensions: true } });
  const page = await browser.page(t);
  await page.route('**/*', (route) => (route.request().url().startsWith(sim.url) ? route.continue() : route.abort()));
  await page.goto(`${sim.origin ?? sim.url}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item`);
  await page.getByRole('combobox', { name: 'Standard choice', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId('invented-choice-pcf').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.mirageAppState === 'ready' &&
      window.Xrm?.Page &&
      window.inventedChoicePcfReady === true,
  );

  const observed = await page.evaluate(() => {
    const form = window.Xrm.Page;
    const standard = form.getControl('choice');
    const pcf = form.getControl('pcf_choice');
    const attribute = form.getAttribute('x_choice');
    const snapshot = () => ({
      first: standard.getOptions(),
      sibling: pcf.getOptions(),
      source: attribute.getOptions(),
    });
    const identity = {
      distinct: standard !== pcf,
      standardField: standard.getAttribute().getName(),
      siblingField: pcf.getAttribute().getName(),
      requiredLevel: attribute.getRequiredLevel(),
    };
    const baseline = snapshot();
    const caller = { text: 'Zero', value: 0 };
    standard.addOption(caller, 0);
    caller.text = 'Caller mutation';
    const added = snapshot();
    standard.removeOption(198720000);
    const removed = snapshot();
    standard.clearOptions();
    const cleared = snapshot();
    return { identity, baseline, added, removed, cleared };
  });

  const sourceOptions = options.map(([value, text]) => ({ text, value }));
  const empty = { text: '', value: NaN };
  const states = [
    ['baseline', [empty, ...sourceOptions]],
    ['added', [empty, { text: 'Zero', value: 0 }, ...sourceOptions]],
    ['removed', [empty, { text: 'Zero', value: 0 }, ...sourceOptions.slice(1)]],
    ['cleared', [empty]],
  ];
  assert.deepEqual(observed.identity, {
    distinct: true,
    standardField: 'x_choice',
    siblingField: 'x_choice',
    requiredLevel: 'none',
  });
  for (const [phase, expected] of states) {
    assert.deepEqual(observed[phase].first, expected, `${phase}: standard control`);
    assert.deepEqual(observed[phase].sibling, expected, `${phase}: PCF sibling API`);
    assert.deepEqual(observed[phase].source, sourceOptions, `${phase}: source attribute options`);
  }
});
