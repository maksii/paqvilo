// @test-kind security: the code-app bridge acts as the selected staff user, so it must refuse what the Web API refuses that user and must not open the batch endpoint or the plug-in bypass headers
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { parseCustomApiFiles } from '../lib/dataverse-customapi.mjs';
import { codeAppDataverse } from '../lib/organization-host.mjs';
import { createCodeAppsHandler } from '../lib/code-apps-http.mjs';
import { serveOrganization } from './support/web-api.mjs';

const APP = '33333333-3333-4333-8333-333333333333';
const ROW = '22222222-2222-4222-8222-222222222222';
const GUARDED =
  '<customapi uniquename="x_Guarded"><bindingtype>0</bindingtype><boundentitylogicalname></boundentitylogicalname><displayname default="x_Guarded"><label description="x_Guarded" languagecode="1033" /></displayname><executeprivilegename>prvInventedRun</executeprivilegename><isfunction>0</isfunction><isprivate>0</isprivate><name>x_Guarded</name></customapi>';

async function fixture(t) {
  const state = emptyState();
  state.mappings.x_item = {
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    ownership: 'UserOwned',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: ROW, x_name: 'Invented' }];
  Object.assign(state.tables, parseCustomApiFiles([{ path: 'x_Guarded/customapi.xml', text: GUARDED }]));
  const variable = `PAQ_BRIDGE_APP_SECRET_${process.pid}`;
  process.env[variable] = 'invented-secret';
  ownedFixture(t).add(() => delete process.env[variable]);
  const store = await new DataStore({ state }).init();
  // An application user without a role: the Web API refuses it the table and the privileged action.
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: true,
      tds: { enabled: false },
      applications: [{ appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: [] }],
    }),
    extensions: await sourceOrganizationExtensions(),
  });
  const { transport, token } = await serveOrganization(t, organization, APP, 'invented-secret');
  const user = store.tableRows('systemuser').find((row) => String(row.applicationid).toLowerCase() === APP);
  const forwarded = [];
  const bridge = codeAppDataverse({ organization, change: (fn) => fn(), origin: () => 'http://localhost' });
  const handler = createCodeAppsHandler({
    apps: () => [{ name: 'invented', connectionReferences: [] }],
    sessions: { resolve: () => ({ principalId: user.systemuserid, kind: 'staff' }) },
    user: () => user,
    csrf: () => 'test-csrf',
    organization: { environmentId: 'invented', organizationId: 'invented', tenantId: 'invented' },
    dataverse: (request) => {
      forwarded.push(request);
      return bridge(request);
    },
  });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const answer = async (response) => {
    const text = await response.text();
    let code = null;
    try {
      code = JSON.parse(text).error?.code ?? null;
    } catch {
      /* not JSON */
    }
    return { status: response.status, code };
  };
  const send = (base, suffix, { method = 'GET', body, headers = {} }) =>
    fetch(`${base}/${suffix}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(answer);
  return {
    store,
    forwarded,
    webApi: (suffix, options = {}) =>
      send(`${transport.origin}/api/data/v9.2`, suffix, {
        ...options,
        headers: { authorization: `Bearer ${token}`, ...options.headers },
      }),
    viaBridge: (suffix, options = {}) =>
      send(`http://127.0.0.1:${server.address().port}/_apps/code/invented/dataverse`, suffix, {
        ...options,
        headers: { 'x-sim-csrf': 'test-csrf', ...options.headers },
      }),
  };
}

test('the bridge refuses a table and an action the staff user lacks privilege for exactly as the Web API does', async (t) => {
  const { webApi, viaBridge } = await fixture(t);
  for (const [suffix, options] of [
    ['x_items', {}],
    [`x_items(${ROW})`, {}],
    ['x_Guarded', { method: 'POST', body: {} }],
  ]) {
    const native = await webApi(suffix, options);
    assert.ok(native.status >= 400, `${suffix}: the Web API refuses this user (${native.status})`);
    assert.deepEqual(await viaBridge(suffix, options), native, suffix);
  }
});

test('the bridge never reaches $batch and never forwards the plug-in bypass headers', async (t) => {
  const { viaBridge, forwarded, store } = await fixture(t);
  const before = JSON.stringify(store.state.tables.x_item);
  const batch = await viaBridge('$batch', {
    method: 'POST',
    body: { requests: [{ id: '1', method: 'DELETE', url: `x_items(${ROW})` }] },
  });
  assert.ok(batch.status >= 400, `$batch is refused (${batch.status})`);
  assert.equal(JSON.stringify(store.state.tables.x_item), before, 'nothing in the batch ran');
  forwarded.length = 0;
  await viaBridge(`x_items(${ROW})`, {
    method: 'PATCH',
    body: { x_name: 'Changed' },
    headers: {
      'MSCRM.BypassCustomPluginExecution': 'true',
      'MSCRM.BypassBusinessLogicExecution': 'CustomSync,CustomAsync',
      'MSCRM.SuppressCallbackRegistrationExpanderJob': 'true',
    },
  });
  assert.equal(forwarded.length, 1);
  assert.deepEqual(
    Object.keys(forwarded[0].headers).filter((name) => name.startsWith('mscrm.')),
    [],
    'no bypass header reaches the organization',
  );
});
