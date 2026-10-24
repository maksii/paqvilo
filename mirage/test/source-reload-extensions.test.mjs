// Source reload refresh (source-organization-extensions.mjs refresh): a reload re-registers custom APIs, duplicate rules,
// classic workflow definitions and activations and plug-in registrations exactly as a restart does, additions and deletions,
// in one transaction. Native reference: a Solution upgrade removes components absent from the new version
// (https://learn.microsoft.com/power-platform/alm/solution-concepts-alm).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { assemblyXml, stepXml, pluginId } from './plugin-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const CLASSIC = '77777777-7777-4777-8777-777777777771';
const BASE = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedReload</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Entities/fx_widget/Entity.xml':
    '<Entity><Name>fx_widget</Name><EntityInfo><entity Name="fx_widget"><EntitySetName>fx_widgets</EntitySetName><PrimaryIdAttribute>fx_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>fx_title</PrimaryNameAttribute><attributes><attribute PhysicalName="fx_widgetid"><Name>fx_widgetid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="fx_title"><Name>fx_title</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="fx_code"><Name>fx_code</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
};
const EXTRA = {
  'customapis/x_Echo/customapi.xml':
    '<customapi uniquename="x_Echo"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Echo</name></customapi>',
  'duplicaterules/x_rule/duplicaterule.xml':
    '<duplicaterule uniquename="x_rule"><baseentityname>fx_widget</baseentityname><matchingentityname>fx_widget</matchingentityname><name>Invented widget rule</name><duplicaterulecondition><baseattributename>fx_code</baseattributename><matchingattributename>fx_code</matchingattributename><operatorcode>0</operatorcode></duplicaterulecondition></duplicaterule>',
  'Workflows/Invented-classic.xaml': '<Activity />',
  'Workflows/Invented-classic.xaml.data.xml': `<Workflow WorkflowId="{${CLASSIC}}" Name="Invented classic" Category="0" OnDemand="1" PrimaryEntity="fx_widget" StateCode="1" XamlFileName="/Workflows/Invented-classic.xaml" />`,
  'PluginAssemblies/Invented.WidgetRules/Invented.WidgetRules.xml': assemblyXml,
  [`SdkMessageProcessingSteps/${pluginId(3)}.xml`]: stepXml(3),
};

const write = async (dir, entries) => {
  for (const [name, body] of Object.entries(entries)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
};
const remove = async (dir) => {
  for (const folder of ['customapis', 'duplicaterules', 'Workflows', 'PluginAssemblies', 'SdkMessageProcessingSteps'])
    await fs.rm(path.join(dir, folder), { recursive: true, force: true });
};
const seen = (sim) => {
  const rows = (table) => sim.store.state.tables[table] ?? [];
  return {
    customapi: rows('customapi')
      .map((row) => row.uniquename)
      .sort(),
    duplicaterule: rows('duplicaterule')
      .map((row) => row.name)
      .sort(),
    workflow: rows('workflow')
      .filter((row) => row.name === 'Invented classic')
      .map(
        (row) =>
          `${row.type}:${Number(row.type) === 2 ? (row.parentworkflowid?.id ?? row.parentworkflowid) : row.workflowid}`,
      )
      .sort(),
    steps: rows('sdkmessageprocessingstep')
      .map((row) => String(row.sdkmessageprocessingstepid).toLowerCase())
      .filter((id) => id === pluginId(3)),
  };
};

async function fixture(t, initial) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-reload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  await write(solution, initial);
  const options = {
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  };
  return {
    solution,
    start: async () => {
      const sim = await createSimulator(options);
      t.after(() => sim.close());
      return sim;
    },
  };
}

test('reload adds custom APIs, duplicate rules, workflow activations and plug-in steps exactly as a restart does', async (t) => {
  const { solution, start } = await fixture(t, BASE);
  const sim = await start();
  assert.deepEqual(seen(sim), { customapi: [], duplicaterule: [], workflow: [], steps: [] });
  await write(solution, EXTRA);
  await sim.reload();
  const reloaded = seen(sim);
  assert.deepEqual(reloaded, {
    customapi: ['x_Echo'],
    duplicaterule: ['Invented widget rule'],
    workflow: [`1:${CLASSIC}`, `2:${CLASSIC}`],
    steps: [pluginId(3)],
  });
  assert.ok(
    sim
      .state()
      .diagnostics.some(
        (entry) => entry.code === 'SOURCE_EXTENSIONS_REFRESHED' && entry.changes.customapi?.added === 1,
      ),
  );
  await sim.close();
  assert.deepEqual(seen(await start()), reloaded);
});

test('reload removes them (definition and activation) exactly as a restart does', async (t) => {
  const { solution, start } = await fixture(t, { ...BASE, ...EXTRA });
  const sim = await start();
  assert.equal(seen(sim).workflow.length, 2);
  await remove(solution);
  await sim.reload();
  const reloaded = seen(sim);
  assert.deepEqual(reloaded, { customapi: [], duplicaterule: [], workflow: [], steps: [] });
  const refreshed = sim.state().diagnostics.find((entry) => entry.code === 'SOURCE_EXTENSIONS_REFRESHED');
  assert.equal(refreshed.changes.workflow.removed, 1);
  assert.equal(refreshed.changes.customapi.removed, 1);
  await sim.close();
  assert.deepEqual(seen(await start()), reloaded);
});

test('a failed reload leaves the previous registrations', async (t) => {
  const { solution, start } = await fixture(t, { ...BASE, ...EXTRA });
  const sim = await start();
  const before = seen(sim);
  await write(solution, {
    'customapis/x_New/customapi.xml':
      '<customapi uniquename="x_New"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_New</name></customapi>',
    'duplicaterules/x_broken/duplicaterule.xml': '<duplicaterule',
  });
  await assert.rejects(sim.reload(), /Malformed XML/);
  assert.deepEqual(seen(sim), before);
});

test('the Power Pages host reload refreshes source modules too', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-reload-pp-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await write(path.join(root, 'solution'), BASE);
  await write(path.join(root, 'portal'), {
    'website.yml': 'adx_websiteid: fixture\nadx_name: Invented site',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  });
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  await write(path.join(root, 'solution'), {
    'customapis/x_Echo/customapi.xml': EXTRA['customapis/x_Echo/customapi.xml'],
  });
  await sim.reload();
  assert.deepEqual(seen(sim).customapi, ['x_Echo']);
  await fs.rm(path.join(root, 'solution', 'customapis'), { recursive: true });
  await sim.reload();
  assert.deepEqual(seen(sim).customapi, []);
});
