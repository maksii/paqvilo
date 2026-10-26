import test from 'node:test';
import { CLR_SKIP } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { disableSteps, originalStepSimulator, pluginFixture, pluginId, stepXml } from './plugin-fixture.mjs';

import { validateOperationOverrides } from '../lib/operation-catalogue.mjs';

test(
  'Admin preserves optional SDK result metadata through an actual original RetrieveMultiple caller',
  { skip: CLR_SKIP },
  async (t) => {
    const fixture = await pluginFixture(t),
      initial = fixture.app.store.snapshot();
    await fixture.app.close();
    await disableSteps(fixture.solution, 4, 11);
    await fs.writeFile(
      path.join(fixture.solution, 'SdkMessageProcessingSteps', pluginId(12) + '.xml'),
      stepXml(12, { message: 'RetrieveMultiple', stage: 40 }),
    );
    const app = await originalStepSimulator(t, fixture, initial, {
      source:
        'using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented.WidgetRules {public sealed class Validate:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var result=service.RetrieveMultiple(new QueryExpression("fx_widget"){ColumnSet=new ColumnSet("fx_title")});if(result.EntityName!="fx_widget"||result.MinActiveRowVersion!="12345678901234567890"||!result.TotalRecordCountLimitExceeded||result.Entities.Count!=1||result.Entities[0].GetAttributeValue<string>("fx_title")!="Configured read")throw new InvalidPluginExecutionException("Configured SDK metadata differs");((Entity)c.InputParameters["Target"])["fx_note"]="Original typed SDK metadata passed";}}}',
      evidence: 'Invented actual admin configured SDK metadata',
      grants: [{ entity: 'fx_widget', operations: ['read'] }],
    });
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
    assert.equal(stops[0].absenceVerified, true);
  },
);
