// @test-kind parity: native-trial and native-trial-r2 n3-solution: the steps of an imported unmanaged Solution's plug-in assembly run its code (secure configuration null)
// @parity-evidence: native-trial/n3-solution.json and native-trial-r2/n3-solution.json (imported Solution assembly and five steps run)
// A Solution export's plug-in assembly bytes (PluginAssemblies/<name>/<name>.dll beside its registration) run its steps
// without a trusted descriptor, like uploaded content. Invented schema, assembly and identities only.
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

// Step 3 (Create, PreValidation, fx_widget) only; the exported registration names the .dll by FileName.
async function exportedSimulator(t, { withDll }) {
  const fixture = await pluginFixture(t),
    initial = fixture.app.store.snapshot();
  await fixture.app.close();
  await disableSteps(fixture.solution, 4, 11);
  const folder = path.join(fixture.solution, FOLDER);
  await fs.writeFile(path.join(folder, 'Invented.WidgetRules.xml'), exportedAssemblyXml);
  if (withDll) {
    const file = path.join(fixture.dir, 'Validate.cs');
    await fs.writeFile(file, source);
    compileClr(file, path.join(folder, 'Invented.WidgetRules.dll'), {
      references: [clrSdk(), 'System.Runtime.Serialization.dll'],
    });
  }
  const app = await createSimulator({
    sourceDir: fixture.portal,
    solutionRoots: [fixture.solution],
    initial,
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  const write = (title) =>
    fetch(app.url + '/_api/fx_widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ fx_title: title }),
    });
  return { app, write };
}

test('a Solution step runs the exported assembly bytes without a trusted descriptor', { skip: CLR_SKIP }, async (t) => {
  const { app, write } = await exportedSimulator(t, { withDll: true });
  assert.equal((await write('Exported bytes')).status, 204);
  assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note, 'exported bytes ran');
  const assembly = app.store.tableRows('pluginassembly').find((row) => row.pluginassemblyid === pluginId(1));
  assert.ok(typeof assembly.content === 'string' && assembly.content.length > 0);
});

// @test-kind contract: an export without the .dll (a Power Pages export carries none) reports a diagnostic and its steps stay placeholders
test('an exported assembly without its file reports a diagnostic and its step stays a placeholder', async (t) => {
  const { app, write } = await exportedSimulator(t, { withDll: false });
  const { diagnostics } = await (await fetch(app.url + '/__sim/api/diagnostics')).json();
  assert.ok(
    diagnostics.some((note) => note.code === 'PLUGIN_ASSEMBLY_CONTENT_MISSING'),
    'missing assembly file diagnostic',
  );
  assert.equal((await write('No bytes')).status, 204);
  assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_note, undefined);
});
