import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createSimulator } from '../server.mjs';
import { readStateFile } from '../lib/state-storage.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function fixture(t, { wizard = false, attachments = false, ...options } = {}) {
  const root = await makeTemporaryDirectory(path.join(tmpdir(), 'mirage-form-journal-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented feedback',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `<html><body><form id="liquid_form">{% ${wizard ? 'webform name: "Wizard"' : 'entityform name: "Edit"'} %}</form></body></html>`,
    'Edit.basicform.yml':
      'adx_entityformid: edit\nadx_name: Edit\nadx_entityname: item\nadx_mode: 100000001\nadx_recordidquerystringparametername: id',
    'Create.basicform.yml':
      'adx_entityformid: create\nadx_name: Create\nadx_entityname: item\nadx_mode: 100000000' +
      (attachments ? '\nadx_attachfile: true' : ''),
    'Wizard.advancedform.yml': 'adx_webformid: wizard\nadx_name: Wizard',
  };
  for (const [file, body] of Object.entries(files)) await fs.writeFile(path.join(root, file), body);
  const stateFile = path.join(root, 'state.json'),
    settings = { sourceDir: root, stateFile, watch: false, persistence: { journalThresholdBytes: 0 }, ...options };
  const initial = {
    settings: { permissionMode: 'permissive' },
    mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
    tables: { item: [{ itemid: 'one', title: 'Before' }] },
    simulator: {
      componentSchemas: {
        edit: { entity: 'item', fields: [{ name: 'title' }] },
        create: { entity: 'item', fields: [{ name: 'title' }] },
        wizard: {
          initialStepId: 'first',
          steps: [{ stepId: 'first', entity: 'item', mode: 100000000, fields: [{ name: 'title' }] }],
        },
      },
    },
  };
  if (attachments) {
    initial.mappings.annotation = { entitySet: 'annotations', idColumn: 'annotationid' };
    initial.tables.annotation = [];
  }
  const app = await createSimulator({ ...settings, initial });
  ownedFixture(t).add(() => app.close());
  const submit = (route, body, type = 'application/json') =>
    fetch(app.url + route, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': type, __RequestVerificationToken: app.state().csrf },
      body: type === 'application/json' ? JSON.stringify(body) : body,
    });
  return { app, root, stateFile, settings, submit };
}

test('native edit, JSON insert and multistep writes use the journal and survive restart', async (t) => {
  const { app, stateFile, settings, submit } = await fixture(t);
  const ids = nativeFormControlIds('entityform', 'edit');
  const response = await submit(
    '/?id=one',
    new URLSearchParams([
      ['__EVENTTARGET', ids.buttons + 'UpdateButton'],
      ['__RequestVerificationToken', app.state().csrf],
      [ids.names + 'title', 'Edited'],
    ]),
    'application/x-www-form-urlencoded',
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal((await submit('/__sim/forms/entityform/create/submit', { values: { title: 'Inserted' } })).status, 201);
  const audit = await (await fetch(app.url + '/__sim/api/audit?method=POST')).json();
  assert.deepEqual(
    audit.items.filter((row) => row.saveMode).map(({ path, saveMode }) => [path, saveMode]),
    [
      ['/__sim/forms/entityform/create/submit', 'journal'],
      ['/', 'journal'],
    ],
  );
  await app.close();
  const restarted = await createSimulator(settings);
  // Owned like the fixture's own app: closed before its state directory is removed.
  ownedFixture(t).add(() => restarted.close());
  assert.deepEqual(
    restarted.store.state.tables.item.map((row) => row.title),
    ['Edited', 'Inserted'],
  );
  assert.equal((await readStateFile(stateFile)).tables.item.length, 2);
  const wizard = await fixture(t, { wizard: true });
  const controls = nativeFormControlIds('webform', 'wizard');
  const next = await wizard.submit(
    '/',
    new URLSearchParams([
      ['__EVENTTARGET', controls.buttons + 'NextButton'],
      ['__RequestVerificationToken', wizard.app.state().csrf],
      [controls.names + 'title', 'Step saved'],
    ]),
    'application/x-www-form-urlencoded',
  );
  assert.equal(next.status, 302);
  await next.text();
  assert.equal(wizard.app.store.lastSave.mode, 'journal');
});

test('a failing second form operation rolls back every journal row on disk and in memory', async (t) => {
  const { app, stateFile, submit } = await fixture(t);
  app.store.state.simulator.componentSchemas.create.fields.push({ name: 'description' });
  app.store.state.plugins = [
    {
      entity: 'item',
      operations: ['create'],
      secondary: [
        {
          entity: 'item',
          operation: 'update',
          match: { itemid: 'absent' },
          requireMatch: true,
          set: { title: 'No match' },
        },
      ],
    },
  ];
  await app.store.compact();
  const before = app.store.snapshot();
  const response = await submit('/__sim/forms/entityform/create/submit', { values: { title: 'Must rollback' } });
  assert.deepEqual((await response.json()).error, {
    code: 'InvalidPlugin',
    message: 'The backend action cannot find a matching related record',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(app.store.state.tables, before.tables);
  assert.deepEqual((await readStateFile(stateFile)).tables, before.tables);
});

test('attachment rejection after the primary form row rolls back the entire unit, with journal and trusted-handler promotion', async (t) => {
  for (const trusted of [false, true]) {
    const { app, stateFile, settings, submit } = await fixture(t, { attachments: true });
    const payload = {
      values: { title: 'With note' },
      attachments: [{ name: 'invented.txt', content: Buffer.from('Invented').toString('base64') }],
    };
    let handlerCalls = 0;
    if (trusted)
      app.store.setPluginPipeline(
        (event) => {
          if (event.stage === 20 && event.entity === 'item') {
            handlerCalls++;
            app.store.state.simulator.handlerMutation = handlerCalls;
          }
        },
        (event) => event.entity === 'item',
        (event) => event.stage === 20,
      );
    const saved = await submit('/__sim/forms/entityform/create/submit', payload);
    assert.equal(saved.status, 201, await saved.text());
    assert.equal(app.store.lastSave.mode, trusted ? 'checkpoint' : 'journal');
    app.store.state.plugins = [
      {
        entity: 'annotation',
        operations: ['create'],
        validate: [{ assert: "filename eq 'allowed.txt'", message: 'Reject attachment' }],
      },
    ];
    await app.store.compact();
    const before = app.store.snapshot();
    const rejected = await submit('/__sim/forms/entityform/create/submit', payload);
    assert.equal(rejected.status, 400);
    assert.deepEqual((await rejected.json()).error, { code: 'PluginValidation', message: 'Reject attachment' });
    assert.deepEqual(app.store.state, before);
    assert.deepEqual((await readStateFile(stateFile)).tables, before.tables);
    if (trusted) assert.equal(handlerCalls, 2, 'the rejecting attachment follows the primary row and trusted handler');
    await app.close();
    const restarted = await createSimulator(settings);
    ownedFixture(t).add(() => restarted.close());
    // A restart moves the inline note body to the annotations storage route (dataverse-storage-routing.mjs migration);
    // the rows are otherwise unchanged.
    const rows = (tables) => ({
      ...tables,
      annotation: tables.annotation?.map(({ documentbody, __blobkey, ...row }) => row),
    });
    assert.deepEqual(rows(restarted.store.state.tables), rows(before.tables));
  }
});
