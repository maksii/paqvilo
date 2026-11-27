// @test-kind observation: hosted F3 Customer Self-Service site (paqvilo-developer hosted-f3, runs a and b agree, 2026-11-27; summary-F3 "F2 backlog", runs/{a,b}/cs-cases.json and cs-edit-save.json): every portal call of the case pages is a portal call of the signed-in contact at stage 10; the list's chart and AI summary services answer 400; the Create Case insert sends one Create whose customer is the contact and redirects as the form's on-success settings say; the case timeline reads its portal comments without a Retrieve of the case; the Edit Case save with a read-only column sends the Update
// Invented schema (x_ticket stands in for the case table) and loopback fixtures only. The recorder of the hosted runs saw
// only the case, portal comment and note tables, so each assertion compares the messages of those tables.
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
const TICKET = 'a0000000-0000-4000-8000-000000000001';
const SITE = 'f0000000-0000-4000-8000-000000000001';

async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'cs-form-messages-'));
  const page = (name, partial, template, parent) =>
    `adx_webpageid: ${name}\nadx_name: ${name}\nadx_partialurl: ${partial}\n${parent ? `adx_parentpageid: ${parent}\n` : 'adx_isroot: true\n'}adx_pagetemplateid: ${template}`;
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented support`,
    'Home.webpage.yml': page('home', '/', 'list'),
    'Create.webpage.yml': page('create', 'create-ticket', 'create', 'home'),
    'Edit.webpage.yml': page('edit', 'edit-ticket', 'edit', 'home'),
    'List.pagetemplate.yml': 'adx_pagetemplateid: list\nadx_webtemplateid: list',
    'Create.pagetemplate.yml': 'adx_pagetemplateid: create\nadx_webtemplateid: create',
    'Edit.pagetemplate.yml': 'adx_pagetemplateid: edit\nadx_webtemplateid: edit',
    'List.webtemplate.yml': 'adx_webtemplateid: list\nadx_name: List',
    'List.webtemplate.source.html': '{% include "entity_list" key: "Tickets" %}',
    'Create.webtemplate.yml': 'adx_webtemplateid: create\nadx_name: Create',
    'Create.webtemplate.source.html': '{% entityform name: "Create ticket" %}',
    'Edit.webtemplate.yml': 'adx_webtemplateid: edit\nadx_name: Edit',
    'Edit.webtemplate.source.html': '{% entityform name: "Edit ticket" %}',
    'Tickets.list.yml': 'adx_entitylistid: tickets\nadx_name: Tickets\nadx_entityname: x_ticket\nadx_pagesize: 10',
    'Create.basicform.yml': [
      'adx_entityformid: create',
      'adx_name: Create ticket',
      'adx_entityname: x_ticket',
      'adx_mode: 100000000',
      'adx_associatecurrentportaluser: true',
      'adx_targetentityportaluserlookupattribute: x_customer',
      'adx_onsuccess: 756150001',
      'adx_redirectwebpage: home',
      'adx_redirecturlquerystringattributeparamname: created',
      'adx_redirecturlquerystringattribute: x_number',
    ].join('\n'),
    'Edit.basicform.yml':
      'adx_entityformid: edit\nadx_name: Edit ticket\nadx_entityname: x_ticket\nadx_mode: 100000001\nadx_recordidquerystringparametername: id\nadx_successmessage: Saved',
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        x_ticket: {
          entitySet: 'x_tickets',
          idColumn: 'x_ticketid',
          nameColumn: 'x_title',
          fields: {
            x_title: { dataverseType: 'nvarchar', maxLength: 100 },
            x_details: { dataverseType: 'memo' },
            x_number: { dataverseType: 'nvarchar', autoNumberFormat: 'T-{SEQNUM:5}-{RANDSTRING:6}' },
            x_customer: { dataverseType: 'lookup', targets: ['contact'] },
          },
          relationships: {
            x_customer_contact: { entity: 'contact', from: 'x_customer', to: 'contactid', many: false },
          },
        },
        adx_portalcomment: {
          entitySet: 'adx_portalcomments',
          idColumn: 'activityid',
          nameColumn: 'subject',
          fields: { description: { dataverseType: 'memo' }, regardingobjectid: { dataverseType: 'lookup' } },
        },
      },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Invented Visitor', statecode: 0 }],
        x_ticket: [
          {
            x_ticketid: TICKET,
            x_title: 'Stored',
            x_details: 'Read only',
            x_number: 'T-1',
            x_customer: { id: CONTACT, logical_name: 'contact' },
          },
        ],
        adx_portalcomment: [],
      },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: {
          create: {
            entity: 'x_ticket',
            currentUserAssociationField: { name: 'x_customer', type: 'lookup' },
            fields: [
              { name: 'x_title', type: 'text', label: 'Title' },
              { name: 'x_details', type: 'textarea', label: 'Details' },
            ],
          },
          edit: {
            entity: 'x_ticket',
            fields: [
              { name: 'x_title', type: 'text', label: 'Title' },
              { name: 'x_details', type: 'textarea', label: 'Details', readOnly: true },
            ],
          },
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

/** The stage-10 begin of every message of the recorded tables, with the portal facts it carries. */
function recordMessages(app) {
  const store = app.store,
    pipeline = store.pluginPipeline,
    checkpoint = store.pluginPipelineRequiresCheckpoint,
    seen = [];
  const recorder = (context) => {
    if (context.stage === 10 && ['x_ticket', 'adx_portalcomment', 'annotation'].includes(context.entity))
      seen.push({ message: `${context.operation} ${context.entity}`, context });
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
      for (const { message, context } of entries) {
        assert.equal(context.portalRequest, true, `${message} is a portal call`);
        assert.equal(context.identity?.contactId, CONTACT, `${message} carries the signed-in contact`);
      }
      return entries;
    },
  };
}
const names = (entries) => entries.map((entry) => entry.message);
const json = (headers) => ({ ...headers, 'content-type': 'application/json' });

test("the case list's chart and AI summary services answer 400 with no body", async (t) => {
  const app = await fixture(t);
  const headers = { ...signInHeaders(app, CONTACT), __RequestVerificationToken: app.portalToken };
  for (const service of ['entity-grid-chart-data.json', 'entity-grid-ai-summary-stream.json']) {
    const response = await fetch(`${app.url}/_services/${service}/${SITE}`, {
      method: 'POST',
      headers: json(headers),
      body: '{}',
    });
    assert.equal(response.status, 400, service);
    assert.equal(await response.text(), '', service);
  }
});

// @test-kind observation: hosted F3 Customer Self-Service runs a and b (runs/a/cs-cases-attempt1.json and runs/b/cs-cases.json, step "list /support/": two RetrieveMultiple on the case table through entity-grid-data.json, no Retrieve; the recorder windows of runs/a/cs-cases.json and runs/b/cs-cases-attempt1.json lag and show the list's messages in the next step) and hosted F2 classic list load (digest-messages-a-b.json run a: RetrieveMultiple only): a list read sends only RetrieveMultiple on its table (one on F2, two on F3), as portal calls of the contact
test('the case list page and its grid read send only RetrieveMultiple on the table', async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const messages = recordMessages(app);
  const html = await (await fetch(app.url + '/', { headers })).text();
  const encoded = /data-view-layouts="([^"]*)"/.exec(html)?.[1];
  assert.ok(encoded, 'the list renders its view layouts');
  const [layout] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const grid = await fetch(`${app.url}/_services/entity-grid-data.json/${SITE}`, {
    method: 'POST',
    headers: json({ ...headers, __RequestVerificationToken: app.portalToken }),
    body: JSON.stringify({ base64SecureConfiguration: layout.Base64SecureConfiguration, page: 1, pageSize: 10 }),
  });
  assert.equal(grid.status, 200);
  assert.equal((await grid.json()).Records.length, 1);
  const read = names(messages.take());
  // Hosted F2 sent one RetrieveMultiple for its classic list, hosted F3 two for the case list (cause not recorded): the
  // asserted rule is the message kind and table, not the count.
  assert.ok(read.length > 0, 'the grid read sends a RetrieveMultiple');
  assert.deepEqual([...new Set(read)], ['retrievemultiple x_ticket']);
});

test('the Create Case insert creates the record for the contact and redirects as its on-success settings say', async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const messages = recordMessages(app);
  await (await fetch(app.url + '/create-ticket/', { headers })).text();
  assert.deepEqual(names(messages.take()), []);
  const controls = nativeFormControlIds('entityform', 'create');
  const created = await fetch(app.url + '/create-ticket/', {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['__EVENTTARGET', controls.buttons + 'InsertButton'],
      ['__EVENTARGUMENT', ''],
      ['__RequestVerificationToken', app.csrf],
      [controls.names + 'x_title', 'New ticket'],
      [controls.names + 'x_details', 'What happened'],
    ]),
  });
  await created.arrayBuffer();
  const writes = messages.take();
  assert.deepEqual(names(writes), ['create x_ticket']);
  // The customer is the signed-in contact (Associate Current Portal User), not a posted value.
  const row = app.store.tableRows('x_ticket').find((item) => item.x_title === 'New ticket');
  assert.equal(row.x_customer.id, CONTACT);
  // The exported redirect: the list page with the created record's number appended (created=<number>).
  assert.equal(created.status, 302);
  assert.equal(created.headers.get('location'), `/?created=${row.x_number}`);
});

test('the case timeline reads its portal comments without a Retrieve of the case', async (t) => {
  const app = await fixture(t);
  const headers = { ...signInHeaders(app, CONTACT), __RequestVerificationToken: app.portalToken };
  const messages = recordMessages(app);
  const response = await fetch(`${app.url}/_portal/${SITE}/EntityActivity/GetActivities`, {
    method: 'POST',
    headers: json(headers),
    body: JSON.stringify({ regarding: { Id: TICKET, LogicalName: 'x_ticket' }, page: 1, pageSize: 10 }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.deepEqual(names(messages.take()), ['retrievemultiple adx_portalcomment']);
});

test('the Edit Case save with a read-only column updates the record without that column', async (t) => {
  const app = await fixture(t);
  const headers = signInHeaders(app, CONTACT);
  const messages = recordMessages(app);
  await (await fetch(`${app.url}/edit-ticket/?id=${TICKET}`, { headers })).text();
  messages.take();
  const controls = nativeFormControlIds('entityform', 'edit');
  const saved = await fetch(`${app.url}/edit-ticket/?id=${TICKET}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['__EVENTTARGET', controls.buttons + 'UpdateButton'],
      ['__EVENTARGUMENT', ''],
      ['__RequestVerificationToken', app.csrf],
      [controls.names + 'x_title', 'Changed'],
    ]),
  });
  assert.equal(saved.status, 200);
  await saved.text();
  const entries = messages.take();
  const writes = entries.filter((entry) => !entry.message.startsWith('retrieve'));
  assert.deepEqual(names(writes), ['update x_ticket']);
  assert.equal(Object.hasOwn(writes[0].context.target ?? {}, 'x_details'), false);
  assert.equal(app.store.tableRows('x_ticket').find((item) => item.x_ticketid === TICKET).x_details, 'Read only');
});
