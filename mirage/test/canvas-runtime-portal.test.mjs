// A signed-in portal visitor drives a canvas app on the Power Pages host as the Dataverse user enhanced authorization maps
// the contact to (portal-authorization.mjs), never SYSTEM; an anonymous visitor, or a visitor the standard model does not
// map, is refused with 401 CanvasPrincipalRequired.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const MEMBER = '77777777-7777-4777-8777-777777777701';
const files = (state) => ({
  'portal/website.yml': `adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: ${state}`,
  'portal/webrole.yml': `- adx_webroleid: ${MEMBER}\n  adx_name: Member`,
  'portal/web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
  'apps/fx_portalapp/Src/App.pa.yaml': stringify({
    App: { Properties: { OnStart: '=Set(fxReady, true)' } },
    DataSources: { Items: { Type: 'Table', Parameters: { TableLogicalName: 'x_item' } } },
  }),
  'apps/fx_portalapp/Src/HomeScreen.pa.yaml': stringify({
    Screens: {
      HomeScreen: {
        Children: [
          { CountLabel: { Control: 'Label@2.5.1', Properties: { Text: '=CountRows(Items)' } } },
          {
            AddButton: {
              Control: 'Classic/Button@2.2.0',
              Properties: { OnSelect: '=Patch(Items, Defaults(Items), {x_name: "From canvas"})' },
            },
          },
        ],
      },
    },
  }),
});
const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    // logicalName: power-fx-dataverse.mjs dataSource builds its adapter from mapping.logicalName.
    x_item: {
      logicalName: 'x_item',
      entitySet: 'x_items',
      idColumn: 'x_itemid',
      fields: { x_name: { dataverseType: 'nvarchar' } },
    },
  },
  tables: {
    contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
    x_item: [{ x_itemid: 'i1', x_name: 'Own' }],
  },
  permissions: [
    {
      id: 'items',
      name: 'Items',
      entity: 'x_item',
      roles: ['Member'],
      operations: ['read', 'create'],
      scope: 'global',
    },
  ],
  simulator: {
    mode: 'local',
    pageMode: 'local',
    permissionSource: 'configured',
    live: { allowWrites: false },
    endpoints: [],
    contactRoles: [{ contactId: 'alex', roleId: MEMBER }],
  },
});

async function site(t, state) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-portal-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files(state))) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    stateFile: path.join(root, 'state.json'),
    projectRoot: root,
    port: 0,
    watch: false,
    initial: initial(),
    canvas: { sources: ['apps/fx_portalapp'] },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}
const api = (sim, headers = {}, body) =>
  fetch(
    `${sim.url}/_apps/api/canvas/fx_portalapp`,
    body
      ? {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
          body: JSON.stringify(body),
        }
      : { headers },
  );

test('a signed-in portal visitor runs the app as the mapped Dataverse user (enhanced authorization)', async (t) => {
  const sim = await site(t, 1);
  const alex = signInHeaders(sim, 'alex');
  assert.equal((await (await api(sim, alex)).json()).started, false); // a GET never starts the app
  const { snapshot } = await (await api(sim, alex, { action: 'start' })).json();
  assert.equal(snapshot.currentScreen, 'HomeScreen', JSON.stringify(snapshot.errors ?? snapshot));
  assert.deepEqual(snapshot.variables, { fxReady: true });
  assert.equal(
    snapshot.screens[0].controls.find((control) => control.name === 'CountLabel').properties.Text,
    1,
    JSON.stringify(snapshot.errors),
  );
  const created = await api(sim, alex, { action: 'select', control: 'AddButton' });
  const outcome = await created.json();
  assert.equal(created.status, 200, JSON.stringify(outcome.errors));
  const row = sim.store.tableRows('x_item').find((item) => item.x_name === 'From canvas');
  const mapped = sim.store
    .tableRows('systemuser')
    .find((user) => user.fullname === 'Alex Local' && user.systemmanagedusertype === 1);
  assert.ok(row && mapped);
  assert.match(JSON.stringify(row.createdby ?? row.createdonbehalfby), new RegExp(mapped.systemuserid));
  // Anonymous visitors have no Dataverse user to run as.
  const anonymous = await api(sim);
  assert.deepEqual([anonymous.status, (await anonymous.json()).error.code], [401, 'CanvasPrincipalRequired']);
});

test('the standard model maps no Dataverse user, so a signed-in visitor is refused rather than run as SYSTEM', async (t) => {
  const sim = await site(t, 0);
  const response = await api(sim, signInHeaders(sim, 'alex'));
  assert.deepEqual([response.status, (await response.json()).error.code], [401, 'CanvasPrincipalRequired']);
});
