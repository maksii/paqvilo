import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { DataStore } from '../lib/data.mjs';
import { importPortal } from '../lib/importer.mjs';
import { configurationPresetDiagnostics, defineLazyPreset } from '../packs.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-runtime-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-runtime-diagnostics-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: Invented diagnostics',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
    'Create.basicform.yml': 'adx_entityformid: create\nadx_name: Create\nadx_entityname: item\nadx_mode: 100000000',
    'Api.sitesetting.yml': 'adx_name: Webapi/item/enabled\nadx_value: True',
    'Fields.sitesetting.yml': 'adx_name: Webapi/item/fields\nadx_value: title,parentid',
  };
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(root, file), body);
  const initial = {
    settings: { permissionMode: 'enforce' },
    mappings: { item: { entitySet: 'items', idColumn: 'itemid' }, note: { entitySet: 'notes', idColumn: 'noteid' } },
    tables: { item: [], note: [{ noteid: 'foreign', contactid: 'another' }] },
    permissions: [
      {
        id: 'scoped',
        name: 'Children through membership',
        entity: 'item',
        scope: 'parent',
        roles: ['Member'],
        operations: ['create'],
        parentPermissionId: 'parent',
        relationship: { entity: 'note', from: 'parentid', to: 'noteid' },
      },
      { id: 'parent', entity: 'note', scope: 'contact', field: 'contactid', roles: ['Member'], operations: ['read'] },
    ],
    simulator: { componentSchemas: { create: { entity: 'item', fields: [{ name: 'title' }, { name: 'parentid' }] } } },
  };
  const app = await createSimulator({ sourceDir: root, initial, watch: false, ...options });
  ownedFixture(t).add(() => app.close());
  return { app, root };
}

test('a denied scoped API create has a readable relationship, link value and one detailed diagnostic per request', async (t) => {
  const { app } = await fixture(t),
    headers = {
      ...signInHeaders(app, 'person', { roles: ['Member'] }),
      'content-type': 'application/json',
      __RequestVerificationToken: app.state().csrf,
    };
  for (const parentid of [undefined, 'foreign']) {
    const response = await fetch(app.url + '/_api/items', {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Denied', ...(parentid ? { parentid } : {}) }),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.message, "You don't have permission to create item entity.");
  }
  const diagnostics = await (await fetch(app.url + '/_sim/api/diagnostics')).json(),
    requests = diagnostics.diagnostics.filter((item) => item.path === '/_api/items');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.code === 'TABLE_PERMISSION_DENIED'));
  assert.ok(
    requests.every((item) => !item.message.includes('{') && /item\.parentid → note\.noteid/.test(item.message)),
  );
  assert.deepEqual(
    requests.map((item) => item.permissions[0].parentLink.value),
    [null, 'foreign'],
  );
  assert.equal(requests[0].permissions[0].parentLink.childColumn, 'parentid');
  assert.equal(requests[0].permissions[0].parentLink.parentTable, 'note');
  app.store.state.permissions[0].relationshipName = 'invented_item_note';
  assert.throws(
    () => app.store.assertAllowed('item', 'create', {}, { contactId: 'person', roles: ['Member'] }),
    (error) => /relationship invented_item_note/.test(error.message) && !error.message.includes('{'),
  );
});

test('a denied JSON native form request also records only its detailed permission diagnostic', async (t) => {
  const { app } = await fixture(t),
    response = await fetch(app.url + '/__sim/forms/entityform/create/submit', {
      method: 'POST',
      headers: {
        ...signInHeaders(app, 'person', { roles: ['Member'] }),
        'content-type': 'application/json',
        __RequestVerificationToken: app.state().csrf,
      },
      body: JSON.stringify({ values: { title: 'Denied' } }),
    });
  assert.equal(response.status, 403, await response.text());
  const diagnostics = await (await fetch(app.url + '/_sim/api/diagnostics')).json();
  assert.deepEqual(
    diagnostics.diagnostics
      .filter((item) => item.path === '/__sim/forms/entityform/create/submit')
      .map((item) => item.code),
    ['TABLE_PERMISSION_DENIED'],
  );
});

const mismatchedPack = {
  id: 'invented-links',
  name: 'Invented links',
  description: 'Synthetic lazy link mismatch',
  matches: () => true,
  configurationPresets: [
    { id: 'declared', name: 'Declared' },
    { id: 'loaded', name: 'Loaded' },
  ],
  presets: () => ({
    mismatch: {
      name: 'Mismatch',
      configurationPreset: 'declared',
      load: () => ({ configurationPreset: 'loaded', tables: { item: [] } }),
    },
  }),
};
test('repeated lazy preset failures retain one identified diagnostic with both configuration links', async (t) => {
  const { app } = await fixture(t, { packs: [mismatchedPack] }),
    before = app.store.snapshot();
  for (let index = 0; index < 2; index++) {
    const response = await fetch(app.url + '/_sim/api/presets/mismatch/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.state().csrf },
      body: '{"applyConfiguration":true}',
    });
    assert.equal(response.status, 400, await response.text());
  }
  const diagnostics = (await (await fetch(app.url + '/_sim/api/diagnostics')).json()).diagnostics.filter(
    (item) => item.code === 'PACK_CONFIGURATION_PRESET_LINK_INVALID',
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].preset, 'mismatch');
  assert.equal(diagnostics[0].pack, 'invented-links');
  assert.equal(diagnostics[0].descriptorConfigurationPreset, 'declared');
  assert.equal(diagnostics[0].bodyConfigurationPreset, 'loaded');
  assert.deepEqual(app.store.state, before);
});

test('missing and blank persona parameters have a parameter-specific 400 while unknown keys keep 404', async (t) => {
  const { app } = await fixture(t);
  for (const suffix of ['', '?persona=', '?persona=%20']) {
    const response = await fetch(app.url + '/_sim/sign-in' + suffix),
      body = await response.text();
    assert.equal(response.status, 400);
    assert.match(body, /<title>Invalid persona parameter/);
    assert.match(body, /The persona parameter is required/);
    assert.doesNotMatch(body, /Unknown persona/);
  }
  const unknown = await fetch(app.url + '/_sim/sign-in?persona=absent'),
    unknownBody = await unknown.text();
  assert.equal(unknown.status, 404);
  assert.match(unknownBody, /<title>Invalid persona parameter/);
  assert.match(unknownBody, /Unknown persona/);
  assert.doesNotMatch(await (await fetch(app.url + '/_sim/sign-in?persona=absent')).text(), /Closest keys:\s*</);
});

test('an API create without a Create grant retains the detailed table permission diagnostic', async (t) => {
  const { app } = await fixture(t),
    headers = {
      ...signInHeaders(app, 'person', { roles: ['NoCreate'] }),
      'content-type': 'application/json',
      __RequestVerificationToken: app.state().csrf,
    };
  const response = await fetch(app.url + '/_api/items', { method: 'POST', headers, body: '{"title":"Denied"}' });
  assert.equal(response.status, 403);
  const diagnostics = (await (await fetch(app.url + '/_sim/api/diagnostics')).json()).diagnostics.filter(
    (item) => item.path === '/_api/items',
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'TABLE_PERMISSION_DENIED');
  assert.equal(diagnostics[0].operation, 'create');
  assert.equal(diagnostics[0].table, 'item');
  assert.deepEqual(diagnostics[0].permissions, []);
});

test('scoped Create denial names the grant and relationship and revokes independent PreValidation SDK writes', async (t) => {
  const stateFile = path.join(await tempDir(t), 'state.json');
  const store = await new DataStore({
    file: stateFile + '-scoped',
    persistence: { journalThresholdBytes: 0 },
    state: {
      settings: { permissionMode: 'enforce' },
      mappings: { item: { idColumn: 'itemid', entitySet: 'items' }, note: { idColumn: 'noteid', entitySet: 'notes' } },
      tables: { item: [], note: [] },
      permissions: [
        {
          id: 'scoped',
          name: 'Owned children',
          entity: 'item',
          scope: 'parent',
          roles: ['Member'],
          operations: ['create'],
          parentPermissionId: 'parent',
          relationship: { entity: 'note', from: 'parentid', to: 'noteid' },
        },
        { id: 'parent', entity: 'note', scope: 'contact', field: 'contactid', roles: ['Member'], operations: ['read'] },
      ],
    },
  }).init();
  store.setPluginPipeline(
    (event) => {
      if (event.entity === 'item' && event.stage === 10)
        store.sdkMutation(() => store.createRecord('note', { text: 'Independent' }, { admin: true }));
    },
    () => true,
    () => true,
  );
  await assert.rejects(store.create('items', {}, { contactId: 'person', roles: ['Member'] }), (error) => {
    assert.equal(error.code, 'PermissionDenied', error.stack);
    assert.match(error.message, /Owned children.*parent.*parentid/);
    assert.equal(error.details.permissionDiagnostic.permissions[0].name, 'Owned children');
    return true;
  });
  assert.deepEqual(store.state.tables, { item: [], note: [] });
  assert.deepEqual((await new DataStore({ file: stateFile + '-scoped' }).init()).state.tables, { item: [], note: [] });
});

test('configuration-only packs have no phantom link errors and lazy mismatches are request errors', () => {
  assert.deepEqual(configurationPresetDiagnostics({ id: 'configuration-only', configurationPresets: [] }), []);
  const library = {};
  defineLazyPreset(library, 'sample', { configurationPreset: 'one', load: () => ({ configurationPreset: 'two' }) });
  assert.throws(
    () => library.sample,
    (error) => error.status === 400 && error.code === 'PACK_CONFIGURATION_PRESET_LINK_INVALID',
  );
});

test('a configuration-only pack loads into a runtime and can apply its configuration', async (t) => {
  const pack = {
    id: 'configuration-only',
    name: 'Configurations',
    description: 'Invented configuration pack',
    matches: () => true,
    configurationPresets: [
      { id: 'invented-budget', name: 'Invented budget', platformOverrides: { QueryLinkEntityLimit: 30 } },
    ],
  };
  const { app } = await fixture(t, { packs: [pack] });
  const diagnostics = await (await fetch(app.url + '/__sim/api/diagnostics')).json();
  assert.ok(!diagnostics.diagnostics.some((row) => row.code.startsWith('PACK_CONFIGURATION_PRESET_')));
  const response = await fetch(app.url + '/__sim/api/experiments/invented-budget/apply', {
    method: 'POST',
    headers: { 'x-sim-csrf': app.state().csrf, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(
    (await (await fetch(app.url + '/__sim/api/status')).json()).activeConfigurationPreset.id,
    'invented-budget',
  );
});

test('runtime configuration link diagnostics are visible without hydrating a preset', async (t) => {
  const pack = {
    id: 'invented',
    name: 'Invented',
    description: 'Synthetic links',
    matches: () => true,
    configurationPresets: [],
    presets: () => ({
      broken: {
        name: 'Broken',
        configurationPreset: 'missing',
        load() {
          throw new Error('Keep lazy');
        },
      },
    }),
  };
  const { app } = await fixture(t, { packs: [pack] });
  const diagnostics = await (await fetch(app.url + '/__sim/api/diagnostics')).json();
  assert.equal(JSON.stringify(diagnostics).match(/PACK_CONFIGURATION_PRESET_LINK_UNKNOWN/g)?.length, 1);
  assert.ok(app.state().diagnostics.some((row) => row.code === 'PACK_CONFIGURATION_PRESET_LINK_UNKNOWN'));
});

test('duplicate YAML reports every overwritten setting and its lines', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: invented\nadx_name: Invented');
  await fs.writeFile(
    path.join(root, 'sitesetting.yml'),
    '- adx_name: Webapi/a/fields\n  adx_value: a\n  adx_name: Webapi/b/fields\n  adx_value: b\n  adx_name: Webapi/c/fields\n  adx_value: c\n',
  );
  const portal = await importPortal(root),
    errors = portal.diagnostics.filter((row) => row.code === 'duplicate-yaml-key');
  assert.equal(errors.length, 2);
  assert.deepEqual(
    errors.map((row) => row.line),
    [3, 5],
  );
  assert.match(errors[0].message, /Webapi\/a\/fields.*line 1.*Webapi\/b\/fields.*line 3/);
});
