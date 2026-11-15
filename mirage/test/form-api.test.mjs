// @test-kind contract: Paqvilo's native form submission HTTP contract (validation, bindings and grants)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

async function fixture(
  t,
  { mode = 'local', liveBridge, allowLiveWrites = false, fields = [{ name: 'fullname', required: true }] } = {},
) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-form-http-'));
  await fs.writeFile(
    path.join(directory, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
  );
  await fs.writeFile(
    path.join(directory, 'Create.basicform.yml'),
    'adx_entityformid: create\nadx_name: Create contact\nadx_entityname: contact\nadx_mode: 100000000\n',
  );
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
    tables: { contact: [] },
    permissions: [
      {
        id: 'editor',
        entity: 'contact',
        scope: 'global',
        roles: ['Editor'],
        operations: ['create', 'read', 'update'],
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode,
      pageMode: 'local',
      identity: { id: 'local-editor', roles: ['Editor'] },
      live: { origin: 'https://portal.example.test', allowWrites: false },
      endpoints: [],
      componentSchemas: {
        create: {
          entity: 'contact',
          fields,
        },
      },
    },
  };
  const app = await createSimulator({
    sourceDir: directory,
    initial,
    liveBridge,
    // Live saves need the runtime permission (cli --allow-live-writes).
    allowLiveWrites,
    watch: false,
  });
  ownedFixture(t).add(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Form posts are portal requests: signed in explicitly as the Editor persona.
  const persona = { session: signInHeaders(app, 'local-editor', { roles: ['Editor'] }) };
  const submit = (values, headers = { __RequestVerificationToken: app.csrf }) =>
    fetch(app.url + '/__sim/forms/entityform/create/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...persona.session, ...headers },
      body: JSON.stringify({ values }),
    });
  const signInAs = (contactId, roles) => {
    persona.session = signInHeaders(app, contactId, { roles });
  };
  return { app, submit, signInAs };
}

// @test-kind security: a native form post is refused without the CSRF token, a bound field or a table grant
test('HTTP native forms require CSRF, bound fields and table grants independently of disabled Web API', async (t) => {
  const { app, submit, signInAs } = await fixture(t);
  assert.equal((await fetch(app.url + '/_api/contacts')).status, 404);
  assert.equal((await submit({ fullname: 'No token' }, {})).status, 403);
  let response = await submit({
    fullname: 'Injected',
    privatecolumn: 'forbidden',
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FormFieldNotBound');
  assert.equal(app.store.snapshot().tables.contact.length, 0);
  response = await submit({ fullname: 'Native form contact' });
  assert.equal(response.status, 201);
  const row = await response.json();
  assert.equal(response.headers.get('entityid'), row.recordId);
  assert.equal(row.recordId, app.store.snapshot().tables.contact[0].contactid);
  // Default basic form success: display the native success message and hide the form.
  assert.deepEqual(row.outcome, {
    type: 'message',
    message: 'Submission completed successfully.',
    hideForm: true,
  });
  assert.equal(app.store.snapshot().tables.contact[0].fullname, 'Native form contact');
  // A persona without the granting web role is denied.
  signInAs('no-role', []);
  response = await submit({ fullname: 'Forbidden role' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'PermissionDenied');
  assert.equal(app.store.snapshot().tables.contact.length, 1);
});

test('HTTP native forms use the selected live provider and never silently save live-mode forms locally', async (t) => {
  const calls = [];
  let allow = false;
  const liveBridge = {
    origin: 'https://portal.example.test',
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(url, options) {
      calls.push({ url, options });
      if (!allow)
        throw Object.assign(new Error('Live writes are disabled'), {
          status: 403,
          code: 'LIVE_WRITE_DISABLED',
        });
      return {
        status: 201,
        headers: { entityid: 'online-contact' },
        body: Buffer.from(
          JSON.stringify({
            contactid: 'online-contact',
            fullname: 'Forwarded contact',
          }),
        ),
      };
    },
  };
  const { app, submit } = await fixture(t, { mode: 'live', liveBridge, allowLiveWrites: true });
  let response = await submit({ fullname: 'Forwarded contact' });
  assert.equal(response.status, 403);
  assert.equal(app.store.snapshot().tables.contact.length, 0);
  allow = true;
  response = await submit({ fullname: 'Forwarded contact' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).recordId, 'online-contact');
  assert.equal(calls.at(-1).url, '/_api/contacts');
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(app.store.snapshot().tables.contact.length, 0);
});

test('a lookup binding with malformed percent-encoding answers 400 InvalidLookup and writes nothing', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-form-lookup-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
  );
  await fs.writeFile(
    path.join(directory, 'Create.basicform.yml'),
    'adx_entityformid: create\nadx_name: Create contact\nadx_entityname: contact\nadx_mode: 100000000\n',
  );
  const initial = {
    version: 1,
    mappings: {
      contact: {
        entitySet: 'contacts',
        idColumn: 'contactid',
        relationships: {
          parentcustomerid_account: { entity: 'account', from: 'parentcustomerid', to: 'accountid', many: false },
        },
      },
      account: { entitySet: 'accounts', idColumn: 'accountid' },
    },
    tables: {
      contact: [],
      account: [{ accountid: '11111111-1111-1111-1111-111111111111', name: 'A' }],
    },
    permissions: [
      {
        id: 'editor',
        entity: 'contact',
        scope: 'global',
        roles: ['Editor'],
        operations: ['create', 'read', 'update', 'append', 'appendTo'],
      },
      {
        id: 'account-reader',
        entity: 'account',
        scope: 'global',
        roles: ['Editor'],
        operations: ['read', 'append', 'appendTo'],
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: 'local-editor', roles: ['Editor'] },
      endpoints: [],
      componentSchemas: {
        create: {
          entity: 'contact',
          fields: [{ name: 'fullname' }, { name: 'parentcustomerid', type: 'lookup' }],
        },
      },
    },
  };
  const app = await createSimulator({ sourceDir: directory, initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const session = signInHeaders(app, 'local-editor', { roles: ['Editor'] });
  const response = await fetch(app.url + '/__sim/forms/entityform/create/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...session, __RequestVerificationToken: app.csrf },
    body: JSON.stringify({
      values: { fullname: 'y', 'parentcustomerid_account@odata.bind': '/accounts(%E0%A4%A)' },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'InvalidLookup');
  assert.equal(app.store.snapshot().tables.contact.length, 0);
});

const ME = 'aaaaaaaa-0000-0000-0000-00000000000a';
const OTHER = 'bbbbbbbb-0000-0000-0000-00000000000b';
const PROFILE_FORM =
  'adx_entityformid: profile\nadx_name: Profile\nadx_entityname: contact\nadx_mode: 100000001\nadx_entitysourcetype: 756150002\n';
const WIZARD_SCHEMA = {
  initialStepId: 'create',
  steps: [
    {
      stepId: 'create',
      nextStepId: 'edit',
      entity: 'contact',
      title: 'Create contact',
      mode: 100000000,
      fields: [{ name: 'fullname', label: 'Name', required: true }],
    },
    {
      stepId: 'edit',
      entity: 'contact',
      title: 'Edit contact',
      mode: 100000001,
      fields: [{ name: 'fullname', label: 'Name', required: true }],
    },
  ],
};

async function recordOwnershipFixture(t, { files, componentSchemas }) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-form-owner-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
  );
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(directory, name), content);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
    tables: {
      contact: [
        { contactid: ME, fullname: 'Me' },
        { contactid: OTHER, fullname: 'Other' },
      ],
    },
    permissions: [
      {
        id: 'editor',
        entity: 'contact',
        scope: 'global',
        roles: ['Editor'],
        operations: ['create', 'read', 'update'],
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', endpoints: [], componentSchemas },
  };
  const app = await createSimulator({ sourceDir: directory, initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const session = signInHeaders(app, ME, { roles: ['Editor'] });
  const post = (kind, id, body) =>
    fetch(`${app.url}/__sim/forms/${kind}/${id}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...session, __RequestVerificationToken: app.csrf },
      body: JSON.stringify(body),
    });
  return { app, post };
}

function contactNames(app) {
  return Object.fromEntries(app.store.snapshot().tables.contact.map((row) => [row.contactid, row.fullname]));
}

// @test-kind security: a posted recordId must not replace the record that the form's own record source names
test('a current-user profile form refuses a recordId that names another contact and changes no row', async (t) => {
  const { app, post } = await recordOwnershipFixture(t, {
    files: { 'Profile.basicform.yml': PROFILE_FORM },
    componentSchemas: { profile: { entity: 'contact', fields: [{ name: 'fullname', type: 'text' }] } },
  });
  const response = await post('entityform', 'profile', { recordId: OTHER, values: { fullname: 'Overwritten' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FormRecordMismatch');
  assert.deepEqual(contactNames(app), { [ME]: 'Me', [OTHER]: 'Other' });
});

// @test-kind security: the signed-in contact's own record stays editable with or without a posted recordId
test('a current-user profile form saves the signed-in contact record with its own recordId or none', async (t) => {
  const { app, post } = await recordOwnershipFixture(t, {
    files: { 'Profile.basicform.yml': PROFILE_FORM },
    componentSchemas: { profile: { entity: 'contact', fields: [{ name: 'fullname', type: 'text' }] } },
  });
  let response = await post('entityform', 'profile', { recordId: ME, values: { fullname: 'Me edited' } });
  assert.equal(response.status, 200);
  assert.deepEqual(contactNames(app), { [ME]: 'Me edited', [OTHER]: 'Other' });
  response = await post('entityform', 'profile', { values: { fullname: 'Me again' } });
  assert.equal(response.status, 200);
  assert.deepEqual(contactNames(app), { [ME]: 'Me again', [OTHER]: 'Other' });
});

// @test-kind security: a query-string record source names the only record that a save of the form may update
test('a query-string form refuses a recordId that differs from the record named in its query', async (t) => {
  const { app, post } = await recordOwnershipFixture(t, {
    files: {
      'Query.basicform.yml': 'adx_entityformid: query\nadx_name: Query\nadx_entityname: contact\nadx_mode: 100000001\n',
    },
    componentSchemas: { query: { entity: 'contact', fields: [{ name: 'fullname', type: 'text' }] } },
  });
  let response = await post('entityform', 'query', {
    query: { id: ME },
    recordId: OTHER,
    values: { fullname: 'Overwritten' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FormRecordMismatch');
  assert.deepEqual(contactNames(app), { [ME]: 'Me', [OTHER]: 'Other' });
  response = await post('entityform', 'query', { query: { id: ME }, values: { fullname: 'Query edited' } });
  assert.equal(response.status, 200);
  assert.deepEqual(contactNames(app), { [ME]: 'Query edited', [OTHER]: 'Other' });
});

// @test-kind security: a multistep edit step saves only the record its session holds, never a posted foreign record
test('a multistep edit step refuses a foreign recordId and leaves the foreign row unchanged', async (t) => {
  const { app, post } = await recordOwnershipFixture(t, {
    files: { 'Wizard.advancedform.yml': 'adx_webformid: wizard\nadx_name: Contact wizard\n' },
    componentSchemas: { wizard: WIZARD_SCHEMA },
  });
  const created = await post('webform', 'wizard', { stepId: 'create', values: { fullname: 'Mine' }, pageUrl: '/' });
  assert.equal(created.status, 201);
  const { recordId } = await created.json();
  const foreign = await post('webform', 'wizard', {
    stepId: 'edit',
    recordId: OTHER,
    values: { fullname: 'Overwritten' },
    pageUrl: '/',
  });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error.code, 'FormRecordMismatch');
  assert.equal(contactNames(app)[OTHER], 'Other');
  assert.equal(contactNames(app)[recordId], 'Mine');
  const own = await post('webform', 'wizard', {
    stepId: 'edit',
    recordId,
    values: { fullname: 'Mine edited' },
    pageUrl: '/',
  });
  assert.equal(own.status, 200);
  assert.equal(contactNames(app)[recordId], 'Mine edited');
  assert.equal(contactNames(app)[OTHER], 'Other');
});

test('a text field refuses an object or a number and writes no row', async (t) => {
  const { app, submit } = await fixture(t);
  for (const fullname of [{ x: 1 }, 12]) {
    const response = await submit({ fullname });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'FormFieldInvalid');
  }
  assert.equal(app.store.snapshot().tables.contact.length, 0);
});

test('a number posts to a numeric field and a boolean to a Boolean field', async (t) => {
  const { app, submit } = await fixture(t, {
    fields: [
      { name: 'fullname', required: true },
      { name: 'age', type: 'number' },
      { name: 'optin', type: 'boolean' },
    ],
  });
  const response = await submit({ fullname: 'Typed', age: 12, optin: true });
  assert.equal(response.status, 201);
  const [row] = app.store.snapshot().tables.contact;
  assert.equal(row.fullname, 'Typed');
  assert.equal(row.age, 12);
  assert.equal(row.optin, true);
});
