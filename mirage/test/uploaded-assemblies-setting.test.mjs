// @test-kind contract: the uploadedAssemblies setting (catalogue or project) chooses the default mode of a Solution export's steps on assembly bytes; a /_sim/ choice still overrides it
// The consumer case: a Solution export whose plug-in assembly carries its compiled .dll and a Create step on a table.
// Invented schema, assembly and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { disableSteps, pluginFixture, pluginId } from './plugin-fixture.mjs';

const FOLDER = 'PluginAssemblies/Invented.WidgetRules';
const exportedAssemblyXml = `<PluginAssembly PluginAssemblyId="{${pluginId(1)}}"><Name>Invented.WidgetRules</Name><Version>1.0.0.0</Version><IsolationMode>2</IsolationMode><SourceType>0</SourceType><FileName>/${FOLDER}/Invented.WidgetRules.dll</FileName><PluginTypes><PluginType PluginTypeId="{${pluginId(2)}}"><TypeName>Invented.WidgetRules.Validate</TypeName></PluginType></PluginTypes></PluginAssembly>`;

const source = `using System; using Microsoft.Xrm.Sdk;
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
namespace Invented.WidgetRules {
  public sealed class Validate : IPlugin {
    public void Execute(IServiceProvider services) {
      var context = (IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));
      ((Entity)context.InputParameters["Target"])["fx_note"] = "exported bytes ran";
    }
  }
}`;

// Step 3 (Create, PreValidation, fx_widget) only, on the compiled assembly.
async function exportedSimulator(t, settings = {}) {
  const fixture = await pluginFixture(t),
    initial = fixture.app.store.snapshot();
  await fixture.app.close();
  await disableSteps(fixture.solution, 4, 11);
  const folder = path.join(fixture.solution, FOLDER);
  await fs.writeFile(path.join(folder, 'Invented.WidgetRules.xml'), exportedAssemblyXml);
  const file = path.join(fixture.dir, 'Validate.cs');
  await fs.writeFile(file, source);
  compileClr(file, path.join(folder, 'Invented.WidgetRules.dll'), {
    references: [clrSdk(), 'System.Runtime.Serialization.dll'],
  });
  const app = await createSimulator({
    sourceDir: fixture.portal,
    solutionRoots: [fixture.solution],
    initial,
    watch: false,
    ...settings,
  });
  ownedFixture(t).add(() => app.close());
  const admin = (url, init = {}) =>
    fetch(app.url + '/__sim/api' + url, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf, ...init.headers },
    });
  const step = async () =>
    (await (await admin('/operations')).json()).items.find((item) => item.key === `plugin-step:${pluginId(3)}`);
  const write = (title) =>
    fetch(app.url + '/_api/fx_widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ fx_title: title }),
    });
  return { app, admin, step, write };
}

test('without the setting a Solution step on assembly bytes defaults to clr', { skip: CLR_SKIP }, async (t) => {
  const { step } = await exportedSimulator(t);
  const item = await step();
  assert.equal(item.defaultMode, 'clr');
  assert.equal(item.mode, 'clr');
  assert.equal(item.defaultModeSource, undefined);
});

test(
  'uploadedAssemblies placeholder keeps a Solution step on assembly bytes a placeholder; a /_sim/ choice selects clr',
  { skip: CLR_SKIP },
  async (t) => {
    const { app, admin, step, write } = await exportedSimulator(t, { uploadedAssemblies: 'placeholder' });
    const item = await step();
    assert.deepEqual(
      { mode: item.mode, defaultMode: item.defaultMode, source: item.defaultModeSource },
      { mode: 'placeholder', defaultMode: 'placeholder', source: 'uploadedAssemblies' },
    );
    const response = await write('Placeholder');
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_title, 'Placeholder');
    assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note, undefined, 'the assembly bytes did not run');
    const chosen = await admin(`/operations/${encodeURIComponent(item.key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode: 'clr' }),
    });
    assert.equal(chosen.status, 200, await chosen.clone().text());
    assert.equal((await step()).mode, 'clr', 'the /_sim/ choice overrides the setting');
  },
);

test('uploadedAssemblies takes clr or placeholder only', async () => {
  await assert.rejects(createSimulator({ uploadedAssemblies: 'disabled', watch: false }), /uploadedAssemblies/);
});
