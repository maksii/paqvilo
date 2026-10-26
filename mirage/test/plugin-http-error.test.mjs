import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pluginFixture, pluginId } from './plugin-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { createSimulator } from '../server.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import {
  pluginCatalogue,
  runPluginPhase,
  importSolutionPlugins,
  parsePluginDocument,
} from '../lib/exported-plugins.mjs';

test(
  'Original default plugin abort has the Dataverse platform code in actual Power Pages HTTP errors',
  { skip: CLR_SKIP },
  async (t) => {
    const fixture = await pluginFixture(t),
      initial = fixture.app.store.snapshot();
    await fixture.app.close();
    await fs.writeFile(
      path.join(fixture.portal, 'InnerError.sitesetting.yml'),
      'adx_sitesettingid: plugin-http-inner\nadx_name: Webapi/error/innererror\nadx_value: true\n',
    );
    const app = await createSimulator({
      sourceDir: fixture.portal,
      solutionRoots: [fixture.solution],
      initial,
      watch: false,
    });
    ownedFixture(t).add(() => app.close());
    const source = path.join(fixture.dir, 'Abort.cs'),
      assembly = path.join(fixture.dir, 'Invented.WidgetRules.dll'),
      sdk = clrSdk();
    await fs.writeFile(
      source,
      `using System;using System.ServiceModel;using Microsoft.Xrm.Sdk;
namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var mode=target.GetAttributeValue<string>("fx_title");((ITracingService)services.GetService(typeof(ITracingService))).Trace("Invented HTTP abort {0}",mode);if(mode=="nested"){var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var child=new Entity("fx_widget");child["fx_title"]="default";try{service.Create(child);throw new Exception("Nested fault absent");}catch(FaultException<OrganizationServiceFault> fault){if(fault.Detail.ErrorCode!=unchecked((int)0x80040265)||fault.Detail.Message!="Invented default abort")throw new Exception("Nested platform fault differs");target["fx_note"]="Nested platform fault passed";return;}}if(mode=="custom")throw new InvalidPluginExecutionException(OperationStatus.Failed,unchecked((int)0x8004f001),"Invented explicit custom abort");if(mode=="unrelated")throw new Exception("Invented unrelated exception");throw new InvalidPluginExecutionException("Invented default abort");}}}`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll', 'System.ServiceModel.dll'] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root: fixture.dir,
      assembly: path.basename(assembly),
      typeName: 'Invented.WidgetRules.Validate',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(fixture.dir, 'cache'),
      context: {
        initiatingUserId: '10000000-0000-0000-0000-000000000001',
        organizationId: '10000000-0000-0000-0000-000000000002',
        businessUnitId: '10000000-0000-0000-0000-000000000003',
      },
      serviceProfile: {
        userId: '10000000-0000-0000-0000-000000000001',
        evidence: 'Invented HTTP error original DLL',
        grants: [{ entity: 'fx_widget', operations: ['read', 'create'] }],
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const assemblyFile = path.join(
        fixture.solution,
        'PluginAssemblies',
        'Invented.WidgetRules',
        'Invented.WidgetRules.xml',
      ),
      stepFile = path.join(fixture.solution, 'SdkMessageProcessingSteps', pluginId(3) + '.xml');
    const documents = await Promise.all(
      [assemblyFile, stepFile].map(async (file) => ({
        file,
        facts: { plugins: parsePluginDocument(await fs.readFile(file, 'utf8')) },
      })),
    );
    const exported = importSolutionPlugins([{ documents }]).steps[0],
      runtimes = new Map([[exported.id, runtime]]),
      items = pluginCatalogue({
        plugins: { steps: [exported] },
        runtimes,
        overrides: { ['plugin-step:' + exported.id]: { mode: 'clr' } },
      }),
      notes = [],
      failures = [];
    app.store.setPluginPipeline((context) => {
      try {
        return runPluginPhase({
          ...context,
          store: app.store,
          items,
          runtimes,
          handlers: new Map(),
          diagnostic: (note) => notes.push(note),
        });
      } catch (error) {
        failures.push(error);
        throw error;
      }
    });
    const before = app.store.snapshot();
    for (const [mode, expectedCode, message] of [
      ['default', '0x80040265', 'Invented default abort'],
      ['custom', '0x8004f001', 'Invented explicit custom abort'],
      ['unrelated', '0x80040265', 'Invented unrelated exception'],
    ]) {
      const response = await fetch(app.url + '/_api/fx_widgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
        body: JSON.stringify({ fx_title: mode }),
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('x-sim-error-code'), 'PluginValidation');
      const body = await response.json();
      assert.deepEqual(body, {
        error: { code: '9004010D', message: 'CDS error occurred.', innererror: { code: expectedCode, message } },
      });
      assert.deepEqual(app.store.snapshot(), before);
    }
    assert.equal(failures[0].details.sourceException.type, 'Microsoft.Xrm.Sdk.InvalidPluginExecutionException');
    assert.equal(
      (failures[0].details.sourceException.errorCode >>> 0).toString(16),
      '80131500',
      'Original CLR source exception code is preserved separately from the platform fault',
    );
    assert.equal((failures[1].details.sourceException.errorCode >>> 0).toString(16), '8004f001');
    assert.equal(failures[2].details.sourceException.type, 'System.Exception');
    assert.equal(failures[2].details.sourceException.errorCode, null);
    assert.equal(
      failures[2].details.innerCode,
      undefined,
      'Unrelated exception mapping is unchanged by the default SDK-code correction',
    );
    const nested = await fetch(app.url + '/_api/fx_widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ fx_title: 'nested' }),
    });
    assert.equal(nested.status, 204);
    const rows = app.store.snapshot().tables.fx_widget;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fx_note, 'Nested platform fault passed');
    assert.equal(rows[0].fx_title, 'nested');
    const starts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED'),
      stops = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(starts.length, 5);
    assert.equal(stops.length, 5);
    assert.ok(stops.every((note) => note.absenceVerified));
  },
);
