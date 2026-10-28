import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { createSimulator } from '../server.mjs';
import { runPluginPhase, pluginPhaseRequiresCheckpoint } from '../lib/exported-plugins.mjs';
import { pluginFixture, pluginId } from './plugin-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { signInHeaders } from '../testing/session.mjs';

const member = { contactId: 'own-contact', roles: ['Member'] };
const scopedState = () => ({
  settings: { permissionMode: 'enforce' },
  mappings: {
    project: { idColumn: 'projectid', entitySet: 'projects' },
    membership: { idColumn: 'membershipid', entitySet: 'memberships' },
  },
  tables: { project: [], membership: [] },
  permissions: [
    {
      id: 'project-create',
      entity: 'project',
      operations: ['create', 'read'],
      roles: ['Member'],
      scope: 'parent',
      parentPermissionId: 'own-membership',
      relationship: { entity: 'membership', from: 'projectid', to: 'project', many: true },
    },
    {
      id: 'own-membership',
      entity: 'membership',
      operations: ['read'],
      roles: ['Member'],
      scope: 'contact',
      field: 'contact',
    },
    { id: 'global-create', entity: 'project', operations: ['create'], roles: ['Global'], scope: 'global' },
  ],
  plugins: [
    {
      entity: 'project',
      operations: ['create'],
      secondary: [
        {
          entity: 'membership',
          operation: 'create',
          set: {
            project: { op: 'reference', args: ['project', '$record.projectid'] },
            contact: '$record.requestedcontact',
          },
        },
      ],
    },
  ],
});

// What each step mode leaves behind on an allowed create: handler calls, the step diagnostic and the mocked target.
const MODES = {
  placeholder: { calls: [], code: 'PLUGIN_STEP_PLACEHOLDER', note: undefined },
  disabled: { calls: [], code: 'PLUGIN_STEP_DISABLED', note: undefined },
  handler: { calls: ['handler'], code: null, note: undefined },
  mock: { calls: [], code: null, note: 'mocked' },
};
for (const [mode, expected] of Object.entries(MODES)) {
  test(`scoped Create with ${mode} retains the table grant gate and final membership check`, async () => {
    const state = scopedState(),
      store = await new DataStore({ state }).init(),
      calls = [],
      diagnostics = [];
    const item = {
      id: pluginId(3),
      enabled: true,
      entity: 'project',
      message: 'Create',
      stage: 20,
      rank: 1,
      mode,
      filteringAttributes: [],
      unsupported: null,
      configuration: mode === 'mock' ? { body: { target: { note: 'mocked' } } } : null,
    };
    const handlers = new Map([
      [
        item.id,
        () => {
          calls.push('handler');
        },
      ],
    ]);
    store.setPluginPipeline((event) =>
      runPluginPhase({ ...event, store, items: [item], handlers, diagnostic: (note) => diagnostics.push(note) }),
    );
    await assert.rejects(store.create('projects', { requestedcontact: member.contactId }, { ...member, roles: [] }), {
      code: 'PermissionDenied',
    });
    assert.deepEqual(calls, [], 'an identity without a Create grant never invokes trusted code');
    const row = await store.create('projects', { requestedcontact: member.contactId }, member);
    assert.equal(store.state.tables.membership[0].project.id, row.projectid);
    assert.equal(store.get('projects', row.projectid, member).projectid, row.projectid);
    assert.deepEqual(calls, expected.calls);
    if (expected.code)
      assert.ok(
        diagnostics.some((note) => note.code === expected.code),
        JSON.stringify(diagnostics),
      );
    assert.equal(store.state.tables.project[0].note, expected.note);
    const before = store.snapshot();
    await assert.rejects(store.create('projects', { requestedcontact: 'foreign-contact' }, member), {
      code: 'PermissionDenied',
    });
    assert.deepEqual(store.snapshot(), before, 'a trusted secondary effect cannot grant a foreign membership');
    store.state.plugins = [];
    const noEffect = store.snapshot();
    await assert.rejects(store.create('projects', {}, member), { code: 'PermissionDenied' });
    assert.deepEqual(store.snapshot(), noEffect, 'without a matching membership the scoped create still rolls back');
    await store.create('projects', {}, { roles: ['Global'] });
  });
}

test('exported inert Create steps leave Parent-scoped basic form and Web API inserts equivalent', async (t) => {
  const fixture = await pluginFixture(t);
  await fixture.app.close();
  const steps = path.join(fixture.solution, 'SdkMessageProcessingSteps');
  for (const file of await fs.readdir(steps)) {
    const fullPath = path.join(steps, file);
    await fs.writeFile(fullPath, (await fs.readFile(fullPath, 'utf8')).replaceAll('fx_widget', 'project'));
  }
  await fs.writeFile(
    path.join(fixture.portal, 'Webapi-enabled.sitesetting.yml'),
    'adx_sitesettingid: api-enabled\nadx_name: Webapi/project/enabled\nadx_value: true',
  );
  await fs.writeFile(
    path.join(fixture.portal, 'Webapi-fields.sitesetting.yml'),
    'adx_sitesettingid: api-fields\nadx_name: Webapi/project/fields\nadx_value: projectid,requestedcontact',
  );
  await fs.writeFile(
    path.join(fixture.portal, 'Create.basicform.yml'),
    'adx_entityformid: create\nadx_name: Create project\nadx_entityname: project\nadx_mode: 100000000',
  );
  await fs.writeFile(path.join(fixture.portal, 'Home.webpage.copy.html'), '{% entityform name: "Create project" %}');
  const initial = scopedState();
  initial.simulator = {
    mode: 'local',
    pageMode: 'local',
    identityScope: 'configured',
    identity: { id: member.contactId, roles: member.roles },
    live: {},
    endpoints: [],
    componentSchemas: { create: { entity: 'project', fields: [{ name: 'requestedcontact' }] } },
  };
  const app = await createSimulator({
    sourceDir: fixture.portal,
    solutionRoots: [fixture.solution],
    initial,
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  const csrf = app.csrf,
    headers = {
      ...signInHeaders(app, member.contactId, { roles: member.roles }),
      __RequestVerificationToken: csrf,
      'content-type': 'application/json',
    };
  for (const mode of ['placeholder', 'disabled']) {
    if (mode === 'disabled')
      for (const id of [3, 4, 5, 6]) {
        const response = await fetch(
          app.url + '/__sim/api/operations/' + encodeURIComponent(`plugin-step:${pluginId(id)}`),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
            body: JSON.stringify({ mode }),
          },
        );
        assert.equal(response.status, 200, await response.text());
      }
    const page = await fetch(app.url, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /requestedcontact/);
    for (const route of ['/_api/projects', '/__sim/forms/entityform/create/submit']) {
      const values = { requestedcontact: member.contactId };
      const response = await fetch(app.url + route, {
        method: 'POST',
        headers,
        body: JSON.stringify(route.includes('/forms/') ? { values } : values),
      });
      assert.equal(response.status, route.includes('/forms/') ? 201 : 204, await response.text());
    }
  }
  assert.equal(app.store.state.tables.project.length, 4);
  assert.equal(app.store.state.tables.membership.length, 4);
  app.store.state.plugins = [];
  const before = app.store.snapshot();
  const denied = await fetch(app.url + '/_api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestedcontact: member.contactId }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(app.store.snapshot(), before);
});

test('placeholder, disabled and target-only mock steps keep HTTP row writes journaled across restart', async (t) => {
  const { app: fixtureApp, dir, portal, solution } = await pluginFixture(t);
  const options = {
    sourceDir: portal,
    solutionRoots: [solution],
    stateFile: path.join(dir, 'journal.json'),
    persistence: { journalThresholdBytes: 0 },
    watch: false,
  };
  let app = await createSimulator({ ...options, initial: fixtureApp.store.snapshot() });
  ownedFixture(t).add(() => app.close());
  const csrf = app.csrf,
    rowId = pluginId(80);
  const admin = (route, body) =>
    fetch(app.url + '/__sim/api' + route, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
      body: JSON.stringify(body),
    });
  const write = async (method, route, body) => {
    const response = await fetch(app.url + '/_api/' + route, {
      method,
      headers: { 'content-type': 'application/json', __RequestVerificationToken: csrf },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 204, await response.text());
  };
  await write('POST', 'fx_widgets', { fx_widgetid: rowId, fx_title: 'initial' });
  for (const mode of ['placeholder', 'disabled', 'mock']) {
    if (mode !== 'placeholder')
      for (const id of [7, 8])
        assert.equal(
          (
            await admin('/operations/' + encodeURIComponent(`plugin-step:${pluginId(id)}`), {
              mode,
              ...(mode === 'mock' ? { body: { target: { fx_note: 'mock note' } } } : {}),
            })
          ).status,
          200,
        );
    await write('PATCH', `fx_widgets(${rowId})`, { fx_title: mode });
    assert.equal(app.store.lastSave.mode, 'journal', mode);
  }
  const audit = await (await fetch(app.url + '/__sim/api/audit?method=PATCH')).json();
  assert.deepEqual(
    audit.items.map((entry) => [entry.path, entry.saveMode]),
    Array(3).fill([`/_api/fx_widgets(${rowId})`, 'journal']),
  );
  assert.ok(audit.items.every((entry) => entry.saveMs >= 0));
  const expected = structuredClone(app.store.state.tables.fx_widget);
  await app.close();
  app = await createSimulator(options);
  assert.deepEqual(app.store.state.tables.fx_widget, expected);
  assert.equal(expected[0].fx_title, 'mock');
  assert.equal(expected[0].fx_note, 'mock note');
});

test('only matching executable phases promote a row transaction, and arbitrary handler writes roll back', async (t) => {
  const root = await makeTemporaryDirectory(path.join(tmpdir(), 'paqvilo-plugin-checkpoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const store = await new DataStore({
    file,
    persistence: { journalThresholdBytes: 0 },
    state: {
      settings: { permissionMode: 'permissive' },
      mappings: {
        project: { idColumn: 'projectid', entitySet: 'projects' },
        unrelated: { idColumn: 'unrelatedid', entitySet: 'unrelateds' },
      },
      tables: { project: [{ projectid: 'p1', title: 'before' }], unrelated: [{ unrelatedid: 'u1', note: 'before' }] },
    },
  }).init();
  const item = {
    id: pluginId(3),
    enabled: true,
    entity: 'project',
    message: 'Update',
    stage: 20,
    rank: 1,
    mode: 'handler',
    filteringAttributes: ['title'],
    unsupported: null,
  };
  const handlers = new Map([
    [
      item.id,
      ({ target, reject }) => {
        store.state.tables.unrelated[0].note = target.title;
        if (target.title === 'reject') reject('Rollback both tables');
      },
    ],
  ]);
  store.setPluginPipeline(
    (event) => runPluginPhase({ ...event, store, items: [item], handlers }),
    () => true,
    (context) => pluginPhaseRequiresCheckpoint([item], context),
  );
  await store.update('projects', 'p1', { note: 'unfiltered write' });
  assert.equal(store.lastSave.mode, 'journal', 'a filtered-out trusted handler does not copy the state');
  await store.update('projects', 'p1', { title: 'committed' });
  assert.equal(store.lastSave.mode, 'checkpoint');
  assert.equal(store.state.tables.unrelated[0].note, 'committed');
  const before = store.snapshot(),
    digest = store.persistedDigest;
  await assert.rejects(store.update('projects', 'p1', { title: 'reject' }), /Rollback both tables/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.persistedDigest, digest);
  const restarted = await new DataStore({ file }).init();
  assert.deepEqual(restarted.state.tables, before.tables);
  assert.equal(
    pluginPhaseRequiresCheckpoint([item], {
      entity: 'project',
      operation: 'update',
      stage: 10,
      changedAttributes: ['title'],
    }),
    false,
  );
  assert.equal(
    pluginPhaseRequiresCheckpoint([{ ...item, contract: { mode: 1 } }], {
      entity: 'project',
      operation: 'update',
      stage: 20,
      changedAttributes: ['title'],
    }),
    false,
  );
});
