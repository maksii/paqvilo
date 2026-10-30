// @test-kind contract: Paqvilo admin plug-in mocks: typed saved configurations, shape and stage validation, no side effects on refusal
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { disableSteps, pluginFixture, pluginId, stepXml } from './plugin-fixture.mjs';
import { validateOperationOverrides } from '../lib/operation-catalogue.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const recordId = '20000000-0000-0000-0000-000000000001';
const sdkEntity = (title, id = recordId) => ({
  $type: 'Entity',
  logicalName: 'fx_widget',
  id,
  attributes: { fx_title: title },
});
async function fixture(t, { unsupported = false, enhanced = false } = {}) {
  const first = await pluginFixture(t),
    initial = first.app.store.snapshot();
  await first.app.close();
  await disableSteps(first.solution, 3, 11);
  for (const [number, options] of [
    [20, { message: 'RetrieveMultiple', stage: 40 }],
    [21, { message: 'RetrieveMultiple', stage: 20 }],
    [22, { message: 'CreateMultiple', stage: 20 }],
    [23, { message: 'Retrieve', stage: 40 }],
    [24, { message: 'CreateMultiple', stage: 40 }],
  ])
    await fs.writeFile(
      path.join(first.solution, 'SdkMessageProcessingSteps', pluginId(number) + '.xml'),
      stepXml(number, options),
    );
  // An image without an image adapter is unsupported for original execution. (Impersonation no longer is: native runs an
  // impersonating step with the impersonated user as UserId, and every local handler implements that.)
  if (unsupported)
    await fs.writeFile(
      path.join(first.solution, 'SdkMessageProcessingSteps', pluginId(25) + '.xml'),
      stepXml(25, { stage: 20 }).replace(
        '</SdkMessageProcessingStep>',
        '<SdkMessageProcessingStepImages><SdkMessageProcessingStepImage><Name>Before</Name><EntityAlias>Before</EntityAlias><ImageType>0</ImageType></SdkMessageProcessingStepImage></SdkMessageProcessingStepImages></SdkMessageProcessingStep>',
      ),
    );
  // An enhanced-authorization site maps visitors to Dataverse users and provisions the site's application user on portal requests.
  if (enhanced)
    await fs.writeFile(
      path.join(first.portal, 'website.yml'),
      'adx_websiteid: fixture\nadx_name: Widget plugin fixture\nadx_enhancedauthorization: 3',
    );
  initial.tables.fx_widget = [{ fx_widgetid: recordId, fx_title: 'Stored original' }];
  const app = await createSimulator({
    sourceDir: first.portal,
    solutionRoots: [first.solution],
    initial,
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  const admin = (number, body) =>
    fetch(app.url + '/__sim/api/operations/' + encodeURIComponent('plugin-step:' + pluginId(number)), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
      body: JSON.stringify({ mode: 'mock', body }),
    });
  return { app, admin };
}

test('Admin saves typed read and bulk mocks and those exact configurations affect local execution', async (t) => {
  const { app, admin } = await fixture(t);
  const collection = {
    $type: 'EntityCollection',
    entities: [sdkEntity('Mock read result')],
    moreRecords: false,
    totalRecordCount: -1,
    pagingCookie: null,
  };
  assert.equal((await admin(20, { collection })).status, 200);
  const read = await fetch(app.url + '/_api/fx_widgets?$select=fx_title');
  assert.equal(read.status, 200);
  assert.equal((await read.json()).value[0].fx_title, 'Mock read result');
  assert.equal(app.store.snapshot().tables.fx_widget[0].fx_title, 'Stored original');
  assert.equal((await admin(20, {})).status, 200);
  const query = {
    $type: 'QueryExpression',
    entityName: 'fx_widget',
    columnSet: { allColumns: false, columns: ['fx_title'] },
    criteria: {
      operatorName: 'And',
      conditions: [{ attributeName: 'fx_title', operatorName: 'Equal', values: ['Absent ordinary value'] }],
      filters: [],
    },
    orders: [],
    topCount: null,
    distinct: false,
    pageInfo: { count: 0, pageNumber: 0, pagingCookie: null },
  };
  assert.equal((await admin(21, { query })).status, 200);
  const filtered = await fetch(app.url + '/_api/fx_widgets?$select=fx_title');
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).value, []);
  assert.equal((await admin(23, { entityResult: sdkEntity('Mock single result') })).status, 200);
  assert.equal(app.store.get('fx_widget', recordId, { admin: true }).fx_title, 'Mock single result');
  assert.equal(
    (await admin(22, { targets: [sdkEntity('Mock bulk result', '00000000-0000-0000-0000-000000000000')] })).status,
    200,
  );
  assert.equal((await admin(24, { targets: [sdkEntity('PostOperation context value')] })).status, 200);
  const user = '10000000-0000-0000-0000-000000000001',
    profile = {
      userId: user,
      evidence: 'Invented standard-table SDK/admin fixture',
      grants: [{ entity: 'fx_widget', operations: ['read', 'create'] }],
      bulkTables: [
        {
          entity: 'fx_widget',
          tableType: 'standard',
          evidence: 'Invented standard table',
          messages: ['CreateMultiple'],
        },
      ],
    };
  dispatchSdkCall({
    store: app.store,
    profile,
    message: {
      method: 'Execute',
      userId: user,
      arguments: [
        {
          $type: 'OrganizationRequest',
          requestName: 'CreateMultiple',
          parameters: {
            $type: 'ParameterCollection',
            values: {
              Targets: {
                $type: 'EntityCollection',
                entities: [sdkEntity('Submitted bulk value', '00000000-0000-0000-0000-000000000000')],
              },
            },
          },
        },
      ],
    },
  });
  assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_title, 'Mock bulk result');
});

test('Admin rejects mock result shape or stage mismatches before changing saved configuration', async (t) => {
  const { app, admin } = await fixture(t),
    before = app.store.snapshot();
  for (const [number, body] of [
    [20, { target: { fx_title: 'Wrong read output' } }],
    [21, { collection: { $type: 'EntityCollection', entities: [] } }],
    [22, { targets: [{ fx_title: 'Untyped' }] }],
    [22, { targets: [{ ...sdkEntity('Wrong table'), logicalName: 'other' }] }],
    [20, { collection: { $type: 'EntityCollection', entities: 'Invalid' } }],
    [20, { collection: { $type: 'EntityCollection', entities: [] } }],
    [20, { collection: { $type: 'EntityCollection', entities: [{ ...sdkEntity('Unknown field'), unexpected: 1 }] } }],
    [23, { entityResult: { logicalName: 'fx_widget', attributes: {} } }],
    [21, { query: { $type: 'UnsupportedQuery' } }],
    [21, { query: { $type: 'QueryExpression', entityName: 'other' } }],
    [21, { query: { $type: 'FetchExpression', query: '<fetch><entity name="other"/></fetch>' } }],
  ]) {
    const response = await admin(number, body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(app.store.snapshot(), before);
});

test('On an enhanced-authorization site a refused admin mock leaves no side effect: no application user or role is provisioned', async (t) => {
  const { app, admin } = await fixture(t, { enhanced: true }),
    before = app.store.snapshot();
  assert.equal(app.store.portalAuthorization.describe().model, 'enhanced');
  assert.equal((await admin(20, { target: { fx_title: 'Wrong read output' } })).status, 400);
  assert.equal((await fetch(app.url + '/__sim/api/operations')).status, 200);
  assert.deepEqual(app.store.snapshot(), before);
  assert.ok(!app.store.tableRows('systemuser').some((row) => /^# Portals-/.test(row.fullname ?? '')));
});

test('Plugin mock Double values admit invariant finite wire text and reject invalid values', () => {
  const key = 'plugin-step:' + pluginId(22),
    configure = (value) =>
      validateOperationOverrides({
        [key]: {
          mode: 'mock',
          body: {
            targets: [
              {
                $type: 'Entity',
                logicalName: 'fx_widget',
                id: recordId,
                attributes: { amount: { $type: 'Double', value } },
              },
            ],
          },
        },
      });
  for (const value of ['2', '0.1', '-0.5', '1E-100', 2, 0.1]) assert.doesNotThrow(() => configure(value));
  for (const value of ['NaN', 'Infinity', '-Infinity', '', '1e999', true, {}, null, Infinity, NaN])
    assert.throws(() => configure(value), /finite invariant/);
});

test('Explicit admin mock applies an eligible source-known patch without executing unsupported original image logic', async (t) => {
  const { app, admin } = await fixture(t, { unsupported: true });
  const catalogue = await (await fetch(app.url + '/__sim/api/operations')).json(),
    step = catalogue.items.find((item) => item.id === pluginId(25));
  assert.match(step.unsupported, /image adapter/);
  assert.equal((await admin(25, { target: { fx_title: 'Configured mock title' } })).status, 200);
  const write = (title) =>
    fetch(app.url + '/_api/fx_widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ fx_title: title }),
    });
  assert.equal((await write('Submitted ordinary title')).status, 204);
  assert.equal(app.store.snapshot().tables.fx_widget.at(-1).fx_title, 'Configured mock title');
  assert.ok(
    app
      .state()
      .diagnostics.some(
        (item) =>
          item.code === 'PLUGIN_STEP_SIMULATED' &&
          item.stepId === pluginId(25) &&
          /original logic was not executed/.test(item.message),
      ),
  );
  assert.equal((await admin(25, { error: { message: 'Configured mock rejects' } })).status, 200);
  const before = app.store.snapshot();
  assert.equal((await write('Rejected ordinary title')).status, 400);
  assert.deepEqual(app.store.snapshot(), before);
});
