// @test-kind contract+security: step constructor configuration reaches handlers while configuration text stays out of public catalogue and cache JSON
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parsePluginDocument,
  importSolutionPlugins,
  resolvePluginSourceFiles,
  pluginCatalogue,
} from '../lib/exported-plugins.mjs';
import {
  solutionPluginRows,
  solutionPluginExtension,
  overlayRegisteredSteps,
} from '../lib/dataverse-plugin-registration.mjs';
import { runtimeConstructorSettings, stepConstructorSettings } from '../lib/plugin-constructor-configuration.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { SolutionFileCache, shareSolutionParses } from '../lib/solution-cache.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';
import { settleFileTimes } from './support/file-times.mjs';

const id = (n) => '10000000-0000-4000-8000-' + String(n).padStart(12, '0');
const xml = `<ImportExportXml><PluginAssembly PluginAssemblyId="${id(1)}" Name="Config"><PluginType PluginTypeId="${id(2)}" Name="Invented.Two"/><PluginType PluginTypeId="${id(3)}" Name="Invented.One"/><PluginType PluginTypeId="${id(4)}" Name="Invented.Zero"/></PluginAssembly>${[
  'Two',
  'One',
  'Zero',
]
  .map(
    (name, index) =>
      `<SdkMessageProcessingStep SdkMessageProcessingStepId="${id(5 + index)}"><PluginTypeId>${id(2 + index)}</PluginTypeId><PluginTypeName>Invented.${name}</PluginTypeName><MessageName>Create</MessageName><PrimaryEntity>widget</PrimaryEntity><Stage>20</Stage><Rank>${index + 1}</Rank><Mode>0</Mode><SupportedDeployment>0</SupportedDeployment><Configuration>Source ${name}</Configuration></SdkMessageProcessingStep>`,
  )
  .join('')}</ImportExportXml>`;
async function sourcePlugins() {
  const facts = parsePluginDocument(xml);
  const plugins = importSolutionPlugins([
    { documents: [{ file: 'Invented.xml', hash: 'invented', facts: { plugins: facts } }] },
  ]);
  return resolvePluginSourceFiles(plugins);
}

test('source constructor configuration survives source processing and seeding without entering public catalogue JSON', async () => {
  const plugins = await sourcePlugins();
  assert.equal(stepConstructorSettings(plugins.steps[0]).unsecureConfiguration, 'Source Two');
  assert.equal(
    solutionPluginRows(plugins, { organizationId: id(9) }).sdkmessageprocessingstep[0].configuration,
    'Source Two',
  );
  assert.equal(JSON.stringify(plugins).includes('Source Two'), false);
  const items = pluginCatalogue({ plugins });
  assert.equal(JSON.stringify(items).includes('Source Two'), false);
  assert.equal(stepConstructorSettings(items[0]).unsecureConfiguration, 'Source Two');
});

for (const format of ['xml', 'zip'])
  test(`${format} constructor inputs survive persistent and process-shared scan caches without entering cache JSON`, async (t) => {
    settleFileTimes(t);
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-config-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, format === 'xml' ? 'customizations.xml' : 'Invented.zip');
    await fs.writeFile(
      source,
      format === 'xml' ? xml : zipOf([{ name: 'customizations.xml', data: Buffer.from(xml) }]),
    );
    const cacheFile = path.join(root, 'scan.cache');
    const assertSettings = (scan) => {
      const plugins = importSolutionPlugins(scan.layers);
      assert.equal(stepConstructorSettings(plugins.steps[0]).unsecureConfiguration, 'Source Two');
      assert.equal(
        solutionPluginRows(plugins, { organizationId: id(9) }).sdkmessageprocessingstep[0].configuration,
        'Source Two',
      );
      assert.equal(JSON.stringify(scan).includes('Source Two'), false, 'source execution text is not public scan data');
    };
    const fresh = await scanSolutionSources([source], { cacheFile });
    assertSettings(fresh);
    assert.equal(await fresh.cache.save(), true);
    assert.equal((await fs.readFile(cacheFile, 'utf8')).includes('Source Two'), false);
    const warm = await scanSolutionSources([source], { cacheFile });
    assert.equal(warm.cache.stats.hits, 1, 'the persisted metadata really was reused');
    assertSettings(warm);
    const share = shareSolutionParses();
    try {
      const first = await scanSolutionSources([source], { cache: new SolutionFileCache() });
      const copied = await scanSolutionSources([source], { cache: new SolutionFileCache() });
      assert.equal(copied.cache.processHits, 1, 'the shared structuredClone result really was reused');
      assertSettings(first);
      assertSettings(copied);
    } finally {
      share.close();
    }
    const racedCache = new SolutionFileCache();
    const parse = racedCache.parse.bind(racedCache);
    t.mock.method(racedCache, 'parse', async (...args) => {
      const result = await parse(...args);
      await fs.appendFile(source, '\n');
      return { ...result, value: structuredClone(result.value) };
    });
    const changed = await scanSolutionSources([source], { cache: racedCache });
    assert.equal(
      importSolutionPlugins(changed.layers).steps.length,
      0,
      'changed source cannot supply another registration version',
    );
    assert.equal(
      changed.diagnostics.some((item) => /source changed while restoring/.test(item.message)),
      true,
    );
  });

// @test-kind contract: Paqvilo resolution of absent, cleared and unavailable secure configuration references
test('constructor settings distinguish absent registration, explicit clearing and unavailable secure references', () => {
  const tables = { sdkmessageprocessingstep: [], sdkmessageprocessingstepsecureconfig: [] };
  const store = { tableRows: (name) => tables[name] ?? [] };
  const descriptor = { unsecureConfiguration: 'Descriptor U', secureConfiguration: 'Descriptor S' };
  assert.deepEqual(runtimeConstructorSettings(store, id(5), {}, descriptor), descriptor);
  tables.sdkmessageprocessingstep.push({
    sdkmessageprocessingstepid: id(5),
    configuration: null,
    sdkmessageprocessingstepsecureconfigid: null,
  });
  assert.deepEqual(runtimeConstructorSettings(store, id(5), {}, descriptor), {
    unsecureConfiguration: null,
    secureConfiguration: null,
  });
  tables.sdkmessageprocessingstep[0].sdkmessageprocessingstepsecureconfigid = id(8);
  assert.equal(runtimeConstructorSettings(store, id(5), {}, descriptor).secureConfiguration, 'Descriptor S');
  assert.throws(() => runtimeConstructorSettings(store, id(5), {}, {}), {
    code: 'LocalPluginConfigurationUnavailable',
  });
  tables.sdkmessageprocessingstepsecureconfig.push({
    sdkmessageprocessingstepsecureconfigid: id(8),
  });
  assert.equal(runtimeConstructorSettings(store, id(5), {}, descriptor).secureConfiguration, 'Descriptor S');
  assert.throws(() => runtimeConstructorSettings(store, id(5), {}, {}), {
    code: 'LocalPluginConfigurationUnavailable',
  });
  tables.sdkmessageprocessingstepsecureconfig[0].secureconfig = null;
  assert.equal(runtimeConstructorSettings(store, id(5), {}, descriptor).secureConfiguration, null);
  tables.sdkmessageprocessingstepsecureconfig[0].secureconfig = 'API S';
  assert.equal(runtimeConstructorSettings(store, id(5), {}, descriptor).secureConfiguration, 'API S');
  tables.sdkmessageprocessingstep[0].configuration = { unlisted: 'not constructor text' };
  assert.throws(() => runtimeConstructorSettings(store, id(5), {}, descriptor), {
    code: 'LocalPluginConfigurationUnsupported',
  });
});

// @test-kind compatibility+security: Learn plug-in constructor (unsecure, secure) overload selection; secure text stays out of catalogue JSON
test(
  'actual original constructors use source and current HTTP registration strings without mutating a reused runtime descriptor',
  { skip: CLR_SKIP, timeout: 120000 },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-constructor-config-'));
    let backend;
    t.after(async () => {
      await backend?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Config.cs'),
      assembly = path.join(root, 'Config.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {
public sealed class Two:IPlugin {readonly string u,s;public Two(){throw new Exception("Wrong zero constructor");}public Two(string x){throw new Exception("Wrong one constructor");}public Two(string unsecure,string secure){u=unsecure;s=secure;}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"])["seen_two"]=(u??"<null>")+"|"+(s??"<null>");}}
public sealed class One:IPlugin {readonly string u;public One(){throw new Exception("Wrong zero constructor");}public One(string unsecure){u=unsecure;}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"])["seen_one"]=u??"<null>";}}
public sealed class Zero:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"])["seen_zero"]="Zero";}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const plugins = await sourcePlugins(),
      runtimes = new Map(),
      descriptors = new Map();
    for (const step of plugins.steps) {
      const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: 'Config.dll',
        typeName: step.typeName,
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
        persistentHost: true,
        unsecureConfiguration: 'Descriptor U',
        secureConfiguration: 'Descriptor S',
        serviceProfile: { userId: id(9), evidence: 'Invented constructor configuration', grants: [] },
        context: { executionUserId: id(9), initiatingUserId: id(9), organizationId: id(9), businessUnitId: id(9) },
      });
      runtimes.set(step.id, runtime);
      descriptors.set(step.id, runtime.descriptor);
    }
    const f = await contractModuleFixture(t, {
      mappings: {
        widget: {
          logicalName: 'widget',
          entitySet: 'widgets',
          idColumn: 'widgetid',
          fields: Object.fromEntries(
            ['seen_two', 'seen_one', 'seen_zero'].map((name) => [name, { dataverseType: 'nvarchar' }]),
          ),
        },
      },
      tables: { widget: [] },
      extension: solutionPluginExtension(plugins),
    });
    const items = () =>
      pluginCatalogue({
        plugins: overlayRegisteredSteps(plugins, f.store),
        runtimes,
        descriptors,
        overrides: Object.fromEntries(plugins.steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      });
    backend = await createOrganizationBackend({ store: f.store, items, runtimes, descriptors });
    const create = async () => f.json(await f.request('POST', '/widgets', {}), 201);
    let row = await create();
    assert.equal(row.seen_two, 'Source Two|Descriptor S');
    assert.equal(row.seen_one, 'Source One');
    assert.equal(row.seen_zero, 'Zero');
    const secure = await f.json(
      await f.request('POST', '/sdkmessageprocessingstepsecureconfigs', { secureconfig: 'API S' }),
      201,
    );
    assert.equal(
      (
        await f.request('PATCH', `/sdkmessageprocessingsteps(${id(5)})`, {
          configuration: 'source two',
          'sdkmessageprocessingstepsecureconfigid@odata.bind': `/sdkmessageprocessingstepsecureconfigs(${secure.sdkmessageprocessingstepsecureconfigid})`,
        })
      ).status,
      200,
    );
    row = await create();
    assert.equal(row.seen_two, 'source two|API S');
    assert.equal(
      (
        await f.request(
          'PATCH',
          `/sdkmessageprocessingstepsecureconfigs(${secure.sdkmessageprocessingstepsecureconfigid})`,
          { secureconfig: 'Changed S' },
        )
      ).status,
      200,
    );
    row = await create();
    assert.equal(row.seen_two, 'source two|Changed S');
    assert.equal(
      (
        await f.request('PATCH', `/sdkmessageprocessingsteps(${id(5)})`, {
          configuration: null,
          'sdkmessageprocessingstepsecureconfigid@odata.bind': null,
        })
      ).status,
      200,
    );
    row = await create();
    assert.equal(row.seen_two, '<null>|<null>');
    assert.equal(row.seen_one, 'Source One', 'another step keeps its own constructor text');
    assert.equal(runtimes.get(id(5)).descriptor.unsecureConfiguration, 'Descriptor U');
    assert.equal(runtimes.get(id(5)).descriptor.secureConfiguration, 'Descriptor S');
    assert.equal(JSON.stringify(items()).includes('Changed S'), false, 'secure text is not public catalogue data');
  },
);
