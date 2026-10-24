import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pluginFixture, pluginId, stepXml } from './plugin-fixture.mjs';
import { createSimulator } from '../server.mjs';

import { validateOperationOverrides } from '../lib/operation-catalogue.mjs';

test(
  'Admin preserves optional SDK result metadata through an actual original RetrieveMultiple caller',
  { skip: process.platform !== 'win32' || !process.env.PAQ_TEST_XRM_SDK },
  async (t) => {
    const fixture = await pluginFixture(t),
      initial = fixture.app.store.snapshot();
    await fixture.app.close();
    for (let n = 4; n <= 11; n++) {
      const file = path.join(fixture.solution, 'SdkMessageProcessingSteps', pluginId(n) + '.xml');
      await fs.writeFile(
        file,
        (await fs.readFile(file, 'utf8')).replace('<StateCode>0</StateCode>', '<StateCode>1</StateCode>'),
      );
    }
    await fs.writeFile(
      path.join(fixture.solution, 'SdkMessageProcessingSteps', pluginId(12) + '.xml'),
      stepXml(12, { message: 'RetrieveMultiple', stage: 40 }),
    );
    const sdk = path.resolve(process.env.PAQ_TEST_XRM_SDK),
      source = path.join(fixture.dir, 'Metadata.cs'),
      assembly = path.join(fixture.dir, 'Invented.WidgetRules.dll');
    await fs.writeFile(
      source,
      'using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var result=service.RetrieveMultiple(new QueryExpression("fx_widget"){ColumnSet=new ColumnSet("fx_title")});if(result.EntityName!="fx_widget"||result.MinActiveRowVersion!="12345678901234567890"||!result.TotalRecordCountLimitExceeded||result.Entities.Count!=1||result.Entities[0].GetAttributeValue<string>("fx_title")!="Configured read")throw new InvalidPluginExecutionException("Configured SDK metadata differs");((Entity)c.InputParameters["Target"])["fx_note"]="Original typed SDK metadata passed";}}}',
    );
    const build = spawnSync(
      path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/target:library',
        '/out:' + assembly,
        '/reference:' + sdk,
        '/reference:System.Runtime.Serialization.dll',
        source,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const user = '10000000-0000-0000-0000-000000000001',
      descriptor = {
        trust: 'execute-local-assembly',
        root: fixture.dir,
        assembly: path.basename(assembly),
        typeName: 'Invented.WidgetRules.Validate',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(fixture.dir, 'cache'),
        context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
        serviceProfile: {
          userId: user,
          evidence: 'Invented actual admin configured SDK metadata',
          grants: [{ entity: 'fx_widget', operations: ['read'] }],
        },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      },
      pack = path.join(fixture.dir, 'metadata-pack.mjs');
    await fs.writeFile(
      pack,
      'export default {id:"invented-plugin-metadata",name:"Invented metadata",description:"Owned SDK metadata admin fixture",matches:()=>true,presets:()=>({}),pluginRuntimes:' +
        JSON.stringify({ [pluginId(3)]: descriptor }) +
        '};',
    );
    const app = await createSimulator({
      sourceDir: fixture.portal,
      solutionRoots: [fixture.solution],
      initial,
      watch: false,
      dataPacks: [{ id: 'invented-plugin-metadata', module: pack }],
    });
    t.after(() => app.close());
    const admin = (number, body) =>
      fetch(app.url + '/__sim/api/operations/' + encodeURIComponent('plugin-step:' + pluginId(number)), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
        body: JSON.stringify(body),
      });
    const collection = {
      $type: 'EntityCollection',
      entities: [
        {
          $type: 'Entity',
          logicalName: 'fx_widget',
          id: '20000000-0000-0000-0000-000000000001',
          attributes: { fx_title: 'Configured read' },
        },
      ],
      moreRecords: false,
      totalRecordCount: -1,
      pagingCookie: null,
      entityName: 'fx_widget',
      minActiveRowVersion: '12345678901234567890',
      totalRecordCountLimitExceeded: true,
    };
    assert.equal((await admin(12, { mode: 'mock', body: { collection } })).status, 200);
    assert.equal((await admin(3, { mode: 'clr' })).status, 200);
    const before = app.store.snapshot();
    for (const patch of [
      { entityName: 1 },
      { minActiveRowVersion: true },
      { totalRecordCountLimitExceeded: null },
      { unsupportedMetadata: 'Wrong' },
    ]) {
      assert.equal((await admin(12, { mode: 'mock', body: { collection: { ...collection, ...patch } } })).status, 400);
      assert.deepEqual(app.store.snapshot(), before);
    }
    for (const optional of [
      { entityName: null, minActiveRowVersion: null, totalRecordCountLimitExceeded: false },
      { entityName: '', minActiveRowVersion: '', totalRecordCountLimitExceeded: false },
    ])
      assert.doesNotThrow(() =>
        validateOperationOverrides({
          ['plugin-step:' + pluginId(12)]: { mode: 'mock', body: { collection: { ...collection, ...optional } } },
        }),
      );
    const response = await fetch(app.url + '/_api/fx_widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ fx_title: 'Original caller' }),
    });
    assert.equal(
      response.status,
      204,
      JSON.stringify({ body: await response.text(), diagnostics: app.state().diagnostics }),
    );
    assert.equal(app.store.snapshot().tables.fx_widget.length, 1);
    assert.equal(app.store.snapshot().tables.fx_widget[0].fx_note, 'Original typed SDK metadata passed');
    const starts = app.state().diagnostics.filter((n) => n.code === 'PLUGIN_CLR_HOST_STARTED'),
      stops = app.state().diagnostics.filter((n) => n.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(starts.length, 1);
    assert.equal(stops.length, 1);
    assert.ok(stops.every((n) => n.absenceVerified));
  },
);
