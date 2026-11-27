// @test-kind observation: hosted F2 session (paqvilo-developer hosted-f2, two agreeing runs per path: runs a/b choices, visit, reject-v2 and runs e/f steps): a portal form's Dataverse writes are portal calls of the signed-in contact (IsPortalsClientCall true, PortalsContactId the contact) at stage 10 in the recorded order, and a signed-in contact's multistep session is an adx_webformsession row of the recorded shape
// Invented schema and loopback fixtures only. The pipeline recorder observes the messages Mirage sends for each form path
// (message, table, stage and the portal facts the plug-in contexts are built from).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CONTACT = 'c0000000-0000-4000-8000-000000000001';
const ITEM = 'a0000000-0000-4000-8000-000000000001';
const WIZARD = 'b0000000-0000-4000-8000-000000000010';
const STEP_ONE = 'b0000000-0000-4000-8000-000000000011';
const STEP_TWO = 'b0000000-0000-4000-8000-000000000012';
const ZERO = '00000000-0000-0000-0000-000000000000';

const wizardSchema = {
  initialStepId: STEP_ONE,
  steps: [
    {
      stepId: STEP_ONE,
      nextStepId: STEP_TWO,
      entity: 'x_item',
      title: 'Step one',
      mode: 100000000,
      fields: [{ name: 'x_name', label: 'Name', required: true }],
    },
    {
      stepId: STEP_TWO,
      entity: 'x_item',
      title: 'Step two',
      mode: 100000001,
      fields: [{ name: 'x_amount', label: 'Amount', type: 'number' }],
    },
  ],
};

async function fixture(t, { dataModel = 'enhanced', permissionMode = 'permissive', permissions = [], observed } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'form-plugin-messages-'));
  const files = {
    'website.yml': 'adx_websiteid: website\nadx_name: Invented form messages',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: insert',
    'Edit.webpage.yml':
      'adx_webpageid: edit\nadx_name: Edit\nadx_partialurl: edit\nadx_parentpageid: home\nadx_pagetemplateid: edit',
    'Wizard.webpage.yml':
      'adx_webpageid: wizard\nadx_name: Wizard\nadx_partialurl: wizard\nadx_parentpageid: home\nadx_pagetemplateid: wizard',
    'Insert.pagetemplate.yml': 'adx_pagetemplateid: insert\nadx_webtemplateid: insert',
    'Edit.pagetemplate.yml': 'adx_pagetemplateid: edit\nadx_webtemplateid: edit',
    'Wizard.pagetemplate.yml': 'adx_pagetemplateid: wizard\nadx_webtemplateid: wizard',
    'Insert.webtemplate.yml': 'adx_webtemplateid: insert\nadx_name: Insert',
    'Insert.webtemplate.source.html': '{% entityform name: "Item insert" %}',
    'Edit.webtemplate.yml': 'adx_webtemplateid: edit\nadx_name: Edit',
    'Edit.webtemplate.source.html': '{% entityform name: "Item edit" %}',
    'Wizard.webtemplate.yml': 'adx_webtemplateid: wizard\nadx_name: Wizard',
    'Wizard.webtemplate.source.html': '{% webform name: "Item wizard" %}',
    'Insert.basicform.yml':
      'adx_entityformid: insert\nadx_name: Item insert\nadx_entityname: x_item\nadx_mode: 100000000\nadx_successmessage: Saved',
    'Edit.basicform.yml':
      'adx_entityformid: edit\nadx_name: Item edit\nadx_entityname: x_item\nadx_mode: 100000001\nadx_recordidquerystringparametername: id\nadx_successmessage: Saved',
    'Wizard.advancedform.yml': `adx_webformid: ${WIZARD}\nadx_name: Item wizard`,
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const app = await createSimulator({
    sourceDir: root,
    dataModel,
    watch: false,
    ...(observed ? { observed } : {}),
    initial: {
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        x_item: {
          entitySet: 'x_items',
          idColumn: 'x_itemid',
          nameColumn: 'x_name',
          fields: { x_name: { dataverseType: 'nvarchar', maxLength: 20 }, x_amount: { dataverseType: 'int' } },
        },
      },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Invented Visitor', statecode: 0 }],
        x_item: [{ x_itemid: ITEM, x_name: 'Stored', x_amount: 1 }],
      },
      permissions,
      settings: { permissionMode },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: {
          insert: { entity: 'x_item', fields: [{ name: 'x_name', type: 'text', label: 'Name', maxLength: 20 }] },
          edit: { entity: 'x_item', fields: [{ name: 'x_name', type: 'text', label: 'Name', maxLength: 20 }] },
          [WIZARD]: wizardSchema,
        },
      },
    },
  });
  ownedFixture(t).add(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return app;
}

/** Records every write phase of the runtime's plug-in pipeline: message, table, stage and the portal facts it carries. */
function recordWrites(app) {
  const store = app.store,
    pipeline = store.pluginPipeline,
    checkpoint = store.pluginPipelineRequiresCheckpoint,
    seen = [];
  const recorder = (context) => {
    if (['create', 'update', 'delete'].includes(context.operation))
      seen.push({
        message: context.operation,
        entity: context.entity,
        stage: context.stage,
        portalRequest: context.portalRequest === true,
        contactId: context.identity?.contactId ?? null,
      });
    return pipeline(context);
  };
  Object.assign(recorder, { steps: pipeline.steps, diagnostic: pipeline.diagnostic, clrUploads: pipeline.clrUploads });
  store.setPluginPipeline(
    recorder,
    () => true,
    (context) => checkpoint(context),
  );
  return {
    take() {
      const entries = seen.splice(0);
      for (const entry of entries) {
        assert.equal(entry.portalRequest, true, `${entry.message} ${entry.entity} is a portal call`);
        assert.equal(entry.contactId, CONTACT, `${entry.message} ${entry.entity} carries the signed-in contact`);
      }
      return entries;
    },
  };
}
const stage10 = (entries) =>
  entries.filter((entry) => entry.stage === 10).map((entry) => `${entry.message} ${entry.entity}`);

test('basic form posts send Create or Update as portal calls of the contact, and a refused post sends nothing', async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const writes = recordWrites(app);
  const post = (route, form, button, values) => nativePost(app, headers, 'entityform', form, route, button, values);
  const inserted = await post('/', 'insert', 'InsertButton', { x_name: 'New' });
  assert.equal(inserted.status, 200);
  assert.match(await inserted.text(), /id="MessageLabel">Saved</);
  assert.deepEqual(stage10(writes.take()), ['create x_item']);

  const refused = await post('/', 'insert', 'InsertButton', { x_name: 'x'.repeat(30) });
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /Name exceeds the maximum length of 20 characters\./);
  assert.deepEqual(writes.take(), []);

  const updated = await post(`/edit/?id=${ITEM}`, 'edit', 'UpdateButton', { x_name: 'Changed' });
  assert.equal(updated.status, 200);
  assert.deepEqual(stage10(writes.take()), ['update x_item']);
});

test("a signed-in contact's multistep session is an adx_webformsession row written after each step's record", async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const writes = recordWrites(app);
  const submit = (body) =>
    fetch(`${app.url}/__sim/forms/webform/${WIZARD}/submit`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ pageUrl: '/wizard/', ...body }),
    });
  const row = () => {
    const rows = app.store.tableRows('adx_webformsession');
    assert.equal(rows.length, 1);
    return rows[0];
  };

  const first = await submit({ values: { x_name: 'Wizard item' } });
  assert.equal(first.status, 201, await first.clone().text());
  const { recordId } = await first.json();
  // Step 1: the record, then the session row created at the saved step and moved to the next one.
  assert.deepEqual(stage10(writes.take()), ['create x_item', 'create adx_webformsession', 'update adx_webformsession']);
  const history = (secondId) => [
    {
      ID: STEP_ONE,
      Index: 0,
      IsActive: true,
      PaymentTableEntity: null,
      PreviousStepID: ZERO,
      ReferenceEntity: { ID: recordId, LogicalName: 'x_item', PrimaryKeyLogicalName: 'x_itemid' },
    },
    {
      ID: STEP_TWO,
      Index: 1,
      IsActive: true,
      PaymentTableEntity: null,
      PreviousStepID: STEP_ONE,
      ReferenceEntity: { ID: secondId, LogicalName: 'x_item', PrimaryKeyLogicalName: 'x_itemid' },
    },
  ];
  let session = row();
  assert.equal(session.adx_contact.id, CONTACT);
  assert.equal(session.adx_contact.logical_name, 'contact');
  // The user identity name is the portal user's name (portal-client-object.mjs userName: the contact id here).
  assert.equal(session.adx_useridentityname, CONTACT);
  assert.match(session.adx_userhostaddress, /^(?:::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
  assert.equal(session.adx_currentstepindex, 1);
  assert.deepEqual(JSON.parse(session.adx_stephistory), history(ZERO));
  assert.equal(session.adx_primaryrecordid, recordId);
  assert.equal(session.adx_primaryrecordentitylogicalname, 'x_item');
  // The hosted Create and Update Targets carry the key name column (runs e/f).
  assert.equal(session.adx_primaryrecordentitykeyname, 'x_itemid');
  assert.deepEqual([session.mspp_webformid.id, session.mspp_webformid.logical_name], [WIZARD, 'powerpagecomponent']);
  assert.deepEqual(
    [session.mspp_webformstepid.id, session.mspp_webformstepid.logical_name],
    [STEP_TWO, 'powerpagecomponent'],
  );
  assert.equal(Number(session.statecode?.value ?? session.statecode), 0);
  assert.equal(session.adx_name ?? null, null);
  assert.equal(session.adx_anonymousidentification ?? null, null);

  // The same contact resumes at step 2 with its record.
  const resumed = await (await fetch(`${app.url}/wizard/`, { headers })).text();
  assert.match(resumed, /id="x_amount"/);
  assert.doesNotMatch(resumed, /id="x_name"/);

  const second = await submit({ stepId: STEP_TWO, recordId, values: { x_amount: 42 } });
  assert.equal(second.status, 200, await second.clone().text());
  // Step 2: the record update, then the session's, then the deactivation without a PreValidation stage.
  const completed = writes.take();
  assert.deepEqual(stage10(completed), ['update x_item', 'update adx_webformsession']);
  const sessionUpdates = completed.filter((entry) => entry.entity === 'adx_webformsession');
  assert.deepEqual(
    sessionUpdates.map((entry) => entry.stage),
    [10, 20, 40, 20, 40],
  );
  session = row();
  assert.equal(Number(session.statecode?.value ?? session.statecode), 1);
  assert.equal(session.adx_currentstepindex, 1);
  assert.equal(session.mspp_webformstepid.id, STEP_TWO);
  assert.deepEqual(JSON.parse(session.adx_stephistory), history(recordId));
});

// @test-kind observation: hosted session F4 (paqvilo-developer hosted-f4 multistep-private runs a and b, an admitted but anonymous browser): step 1 creates one adx_webformsession with a 36-character GUID in adx_anonymousidentification, the host address, the step index, the step history and the record, without a contact or user identity name; the same browser resumes, another browser starts at step 1 and creates no row, completion sets statecode 1 and creating the session sets no cookie.
test("an anonymous visitor's multistep session is an adx_webformsession row of its browser", async (t) => {
  // The principal the hosted runtime writes as (observed.portalApplicationUser), an invented name here.
  const runtimeUser = '# Invented Data Runtime';
  const app = await fixture(t, {
    observed: { portalApplicationUser: runtimeUser, evidence: 'Invented fixture of the runtime user' },
  });
  const visit = async (cookie) => {
    const response = await fetch(`${app.url}/wizard/`, cookie ? { headers: { cookie } } : {});
    const visitor = response.headers.get('set-cookie')?.split(';')[0];
    return { html: await response.text(), cookie: cookie ?? visitor };
  };
  const submit = (cookie, body) =>
    fetch(`${app.url}/__sim/forms/webform/${WIZARD}/submit`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ pageUrl: '/wizard/', ...body }),
    });
  const rows = () => app.store.tableRows('adx_webformsession');

  const first = await visit();
  assert.match(
    first.cookie,
    /^paqvilo-mirage-visitor-\d+=[0-9a-f-]{36}$/,
    'the first page load identifies the browser',
  );
  assert.match(first.html, /id="x_name"/);
  assert.equal(rows().length, 0);
  const saved = await submit(first.cookie, { values: { x_name: 'Anonymous item' } });
  assert.equal(saved.status, 201, await saved.clone().text());
  assert.equal(saved.headers.get('set-cookie'), null, 'creating the session sets no cookie');
  const { recordId } = await saved.json();
  assert.equal(rows().length, 1);
  let session = rows()[0];
  assert.match(
    session.adx_anonymousidentification,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(session.adx_anonymousidentification, first.cookie.split('=')[1], 'the row never holds the cookie');
  assert.equal(session.adx_contact ?? null, null);
  assert.equal(session.adx_useridentityname ?? null, null);
  assert.match(session.adx_userhostaddress, /^(?:::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
  assert.equal(session.adx_currentstepindex, 1);
  assert.deepEqual(
    JSON.parse(session.adx_stephistory).map((entry) => [entry.ID, entry.Index, entry.ReferenceEntity.ID]),
    [
      [STEP_ONE, 0, recordId],
      [STEP_TWO, 1, ZERO],
    ],
  );
  assert.equal(session.adx_primaryrecordid, recordId);
  assert.equal(Number(session.statecode?.value ?? session.statecode), 0);
  assert.equal(session.createdby?.name, runtimeUser, 'created by the runtime user');

  // The same browser resumes at step 2; another browser starts at step 1 and creates nothing by opening the form.
  assert.match((await visit(first.cookie)).html, /id="x_amount"/);
  const other = await visit();
  assert.notEqual(other.cookie, first.cookie);
  assert.match(other.html, /id="x_name"/);
  assert.doesNotMatch(other.html, /id="x_amount"/);
  assert.equal(rows().length, 1);

  const completed = await submit(first.cookie, { stepId: STEP_TWO, recordId, values: { x_amount: 7 } });
  assert.equal(completed.status, 200, await completed.clone().text());
  session = rows()[0];
  assert.equal(Number(session.statecode?.value ?? session.statecode), 1);
  assert.equal(rows().length, 1);

  // A submission without the visitor cookie starts a visitor of its own and writes no row.
  const cookieless = await fetch(`${app.url}/__sim/forms/webform/${WIZARD}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    body: JSON.stringify({ pageUrl: '/wizard/', values: { x_name: 'Cookieless item' } }),
  });
  assert.equal(cookieless.status, 201, await cookieless.clone().text());
  assert.match(cookieless.headers.get('set-cookie') ?? '', /^paqvilo-mirage-visitor-\d+=/);
  await cookieless.arrayBuffer();
  assert.equal(rows().length, 1, 'a cookieless visitor writes no adx_webformsession row');
});

/** Records the PreValidation (stage 10) begin of every message, reads included, with the portal facts it carries. */
function recordMessages(app) {
  const store = app.store,
    pipeline = store.pluginPipeline,
    checkpoint = store.pluginPipelineRequiresCheckpoint,
    seen = [];
  const recorder = (context) => {
    if (context.stage === 10)
      seen.push({
        message: `${context.operation} ${context.entity}`,
        portalRequest: context.portalRequest === true,
        contactId: context.identity?.contactId ?? null,
      });
    return pipeline(context);
  };
  Object.assign(recorder, { steps: pipeline.steps, diagnostic: pipeline.diagnostic, clrUploads: pipeline.clrUploads });
  store.setPluginPipeline(
    recorder,
    () => true,
    (context) => checkpoint(context),
  );
  return {
    take() {
      // The nested SetStateDynamicEntity of an Update that sets the state is no step the hosted recorder registered.
      const entries = seen.splice(0).filter((entry) => !entry.message.startsWith('setstatedynamicentity '));
      for (const entry of entries) {
        assert.equal(entry.portalRequest, true, `${entry.message} is a portal call`);
        assert.equal(entry.contactId, CONTACT, `${entry.message} carries the signed-in contact`);
      }
      return entries.map((entry) => entry.message);
    },
  };
}

const nativePost = (app, headers, kind, form, route, button, values) => {
  const controls = nativeFormControlIds(kind, form);
  return fetch(app.url + route, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['__EVENTTARGET', controls.buttons + button],
      ['__EVENTARGUMENT', ''],
      ['__RequestVerificationToken', app.csrf],
      ...Object.entries(values).map(([key, value]) => [controls.names + key, value]),
    ]),
  });
};

// @test-kind observation: hosted F2 runs a and b (choices-rte choices:render-edit and choices choices:post-valid-red-blue, paqvilo-developer hosted-f2 digest-messages-a-b.json): a basic form edit page sends Retrieve, then a FetchXML RetrieveMultiple of every attribute and a one-row RetrieveMultiple; the update post sends a RetrieveMultiple naming the record id, the Update, then the re-render's Retrieve and FetchXML RetrieveMultiple; each a portal call of the contact
test('a basic form edit page and its update post read the record as the hosted form does', async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const messages = recordMessages(app);
  const page = await fetch(`${app.url}/edit/?id=${ITEM}`, { headers });
  assert.equal(page.status, 200);
  await page.text();
  assert.deepEqual(messages.take(), ['retrieve x_item', 'retrievemultiple x_item', 'retrievemultiple x_item']);
  const saved = await nativePost(app, headers, 'entityform', 'edit', `/edit/?id=${ITEM}`, 'UpdateButton', {
    x_name: 'Read again',
  });
  assert.equal(saved.status, 200);
  assert.match(await saved.text(), /id="MessageLabel">Saved</);
  assert.deepEqual(messages.take(), [
    'retrievemultiple x_item',
    'update x_item',
    'retrieve x_item',
    'retrievemultiple x_item',
  ]);
  const insertPage = await fetch(`${app.url}/`, { headers });
  await insertPage.text();
  assert.deepEqual(messages.take(), []);
  const inserted = await nativePost(app, headers, 'entityform', 'insert', '/', 'InsertButton', { x_name: 'Inserted' });
  await inserted.text();
  assert.deepEqual(messages.take(), ['create x_item']);
});

// @test-kind observation: hosted F2 runs e and f (steps anon:landing, anon:step1, anon:step2-submit, paqvilo-developer hosted-f2 digest-messages-e-f.json): a signed-in contact's multistep page reads the contact's active session; step 1 creates the record and the session, reads the session and updates it; the step 2 page reads the session and the record three times without a Retrieve; step 2 reads the record by id, Retrieves it and updates it, then reads and updates the session
test('a native multistep form reads its record and session as the hosted form does', async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const messages = recordMessages(app);
  await (await fetch(`${app.url}/wizard/`, { headers })).text();
  // The first visit of a fresh runtime: the session table is not in the data until the first session row adds it.
  assert.deepEqual(messages.take(), []);
  const first = await nativePost(app, headers, 'webform', WIZARD, '/wizard/', 'NextButton', { x_name: 'Wizard item' });
  assert.equal(first.status, 302);
  await first.text();
  assert.deepEqual(messages.take(), [
    'create x_item',
    'create adx_webformsession',
    'retrievemultiple adx_webformsession',
    'update adx_webformsession',
  ]);
  const stepTwo = first.headers.get('location');
  await (await fetch(new URL(stepTwo, app.url), { headers })).text();
  assert.deepEqual(messages.take(), [
    'retrievemultiple adx_webformsession',
    'retrievemultiple x_item',
    'retrievemultiple x_item',
    'retrievemultiple x_item',
  ]);
  const second = await nativePost(app, headers, 'webform', WIZARD, stepTwo, 'NextButton', { x_amount: '42' });
  assert.equal(second.status, 302);
  await second.text();
  assert.deepEqual(messages.take(), [
    'retrievemultiple x_item',
    'retrieve x_item',
    'update x_item',
    'retrievemultiple adx_webformsession',
    'update adx_webformsession',
  ]);
});

// @test-kind security: the multistep session reads and writes are the platform's system reads and writes: with table permissions enforced, a visitor without any permission on adx_webformsession still saves and resumes its own session, and still cannot read the session table itself
test('a visitor without adx_webformsession permission keeps its own session and cannot read the table', async (t) => {
  const app = await fixture(t, {
    permissionMode: 'enforce',
    permissions: [
      { entity: 'x_item', scope: 'global', roles: ['Wizard users'], operations: ['create', 'read', 'update'] },
    ],
  });
  const headers = signInHeaders(app, CONTACT, { roles: ['Wizard users'] });
  const first = await nativePost(app, headers, 'webform', WIZARD, '/wizard/', 'NextButton', {
    x_name: 'Enforced item',
  });
  assert.equal(first.status, 302, await first.clone().text());
  await first.text();
  assert.equal(app.store.tableRows('adx_webformsession').length, 1);
  // A later visit of the form resumes at the saved step: the session read is the platform's.
  const resumed = await fetch(`${app.url}/wizard/`, { headers });
  assert.equal(resumed.status, 200);
  assert.match(await resumed.text(), /id="x_amount"/);
  // The visitor's own reads of the table stay refused.
  const row = app.store.tableRows('adx_webformsession')[0];
  const identity = { id: CONTACT, contactId: CONTACT, roles: ['Wizard users'] };
  assert.equal(app.store.allowed('adx_webformsession', 'read', row, identity), false);
  const listed = await fetch(`${app.url}/_api/adx_webformsessions`, { headers });
  // The portal Web API does not serve the platform's session table at all (webapi-policy.mjs).
  assert.notEqual(listed.status, 200);
  assert.doesNotMatch(await listed.text(), new RegExp(row.adx_webformsessionid));
});
