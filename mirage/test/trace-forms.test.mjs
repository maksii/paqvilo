// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Portal forms, native services and refused reads in the trace (docs/design/tracing.md, D-R3-10, D-R3-11, D-R3-14): a basic
// form submission is one `form` span above its Dataverse write; the list grid service names its table and view; a note
// attachment upload and download name the file column, name and size (never the bytes); a refused Web API collection read
// carries the permission deny event like a refused create. Invented schema, loopback only.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';

const id = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1),
  ROLE = id(2),
  MEMBER = id(31),
  ORDER = id(41),
  LIST = id(51);
const BYTES = 'invented attachment bytes';
const portalFiles = {
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented forms portal`,
  'webrole.yml': `- adx_webroleid: ${ROLE}\n  adx_name: Member\n- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true`,
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'Orders.webpage.yml':
    'adx_webpageid: orders\nadx_name: Orders\nadx_partialurl: orders\nadx_parentpageid: home\nadx_pagetemplateid: orders',
  'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main',
  'Orders.pagetemplate.yml': 'adx_pagetemplateid: orders\nadx_name: Orders\nadx_webtemplateid: orders',
  'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'Main.webtemplate.source.html': '<main>Home</main>',
  'Orders.webtemplate.yml': 'adx_webtemplateid: orders\nadx_name: Orders',
  'Orders.webtemplate.source.html': "<main>{% include 'entity_list' key: 'Orders list' %}</main>",
  'OrdersList.list.yml': `adx_entitylistid: ${LIST}\nadx_name: Orders list\nadx_entityname: x_order\nadx_pagesize: 5`,
  'NewOrder.basicform.yml':
    'adx_entityformid: neworder\nadx_name: New order form\nadx_entityname: x_order\nadx_mode: 100000000\nadx_successmessage: Order submitted',
  'sitesetting.yml': [
    ['Webapi/x_order/enabled', 'true'],
    ['Webapi/x_order/fields', 'x_name'],
  ]
    .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
    .join('\n'),
};

const closers = [],
  removers = [];
let sim, member;
before(async () => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-forms-'));
  removers.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, text] of Object.entries(portalFiles)) await fs.writeFile(path.join(root, name), text);
  sim = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
    trace: { level: 'full' },
    initial: {
      version: 1,
      mappings: {
        x_order: {
          entitySet: 'x_orders',
          idColumn: 'x_orderid',
          nameColumn: 'x_name',
          fields: { x_name: { dataverseType: 'nvarchar' } },
        },
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid', nameColumn: 'subject' },
      },
      tables: {
        x_order: [{ x_orderid: ORDER, x_name: 'Seed order' }],
        contact: [{ contactid: MEMBER, firstname: 'Ada', lastname: 'Member', statecode: 0 }],
        annotation: [],
      },
      permissions: [
        {
          id: 'orders',
          entity: 'x_order',
          scope: 'global',
          operations: ['create', 'read', 'update', 'append', 'appendTo'],
          roles: ['Member'],
        },
        {
          id: 'contacts',
          entity: 'contact',
          scope: 'global',
          operations: ['read', 'append', 'appendTo'],
          roles: ['Member'],
        },
        {
          id: 'notes',
          entity: 'annotation',
          scope: 'global',
          operations: ['read', 'create', 'append', 'appendTo'],
          roles: ['Member'],
        },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        live: { allowWrites: false },
        endpoints: [],
        contactRoles: [{ contactId: MEMBER, roleId: ROLE }],
        componentSchemas: {
          neworder: {
            entity: 'x_order',
            fields: [{ name: 'x_name', type: 'text', label: 'Name' }],
            layout: [
              {
                name: 'main',
                label: 'main',
                columns: [{ width: '100%', sections: [{ name: 'main', label: 'main', rows: [[{ name: 'x_name' }]] }] }],
              },
            ],
          },
        },
      },
    },
  });
  closers.push(() => sim.close());
  member = sim.signIn(MEMBER).cookieHeader;
});
after(async () => {
  await drainFixture(closers);
  await drainFixture(removers);
});
const treeOf = (response) => endedTree(sim.trace, response.headers.get('x-trace-id'));

test('a basic form submission is one form span above its Dataverse create, naming the form, mode, button and record', async () => {
  const response = await fetch(sim.url + '/__sim/forms/entityform/neworder/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: member, __requestverificationtoken: sim.csrf },
    body: JSON.stringify({ values: { x_name: 'Form order' } }),
  });
  assert.equal(response.status, 201, await response.text());
  const tree = await treeOf(response);
  const form = tree.spans.find((span) => span.kind === 'form');
  assert.ok(form, tree.spans.map((span) => `${span.kind} ${span.name}`).join(', '));
  assert.deepEqual(
    [form.name, form.module, form.operation, form.entity, form.parentSpanId, form.status],
    ['Basic form New order form', 'portal', 'submit', 'x_order', tree.root.spanId, 'ok'],
  );
  assert.deepEqual(
    [form.attributes.form, form.attributes.formKind, form.attributes.mode, form.attributes.button],
    ['New order form', 'entityform', 'insert', 'submit'],
  );
  const created = sim.store.tableRows('x_order').find((row) => row.x_name === 'Form order');
  assert.equal(form.recordId, created.x_orderid, 'the form span names the saved record');
  assert.deepEqual(form.input, { x_name: 'Form order' }, 'level full captures the submitted values');
  assert.deepEqual([form.output.operation, form.output.recordId], ['create', created.x_orderid]);
  const write = tree.spans.find((span) => span.kind === 'dataverse' && span.operation === 'create');
  assert.equal(write.parentSpanId, form.spanId, 'the Dataverse write runs inside the form span');
});

test('the list grid service names its table and view; a note attachment upload and download name the file, never its bytes', async () => {
  const page = await fetch(sim.url + '/orders/', { headers: { cookie: member } });
  const html = await page.text();
  const encoded = /data-view-layouts="([^"]*)"/.exec(html)?.[1];
  assert.ok(encoded, 'the list renders its view layouts');
  const [layout] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const service = (action, body) =>
    fetch(`${sim.url}/_services/${action}/${SITE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member, __requestverificationtoken: sim.csrf },
      body: JSON.stringify(body),
    });
  const grid = await service('entity-grid-data.json', {
    base64SecureConfiguration: layout.Base64SecureConfiguration,
    page: 1,
    pageSize: 5,
  });
  assert.equal(grid.status, 200, await grid.text());
  const gridSpan = (await treeOf(grid)).spans.find((span) => span.kind === 'native-service');
  assert.deepEqual(
    [gridSpan.entity, gridSpan.attributes.listId, gridSpan.attributes.grid, typeof gridSpan.attributes.view],
    ['x_order', LIST, 'list', 'string'],
  );
  assert.ok(gridSpan.attributes.savedquery, 'the grid names the view it read');
  assert.equal(gridSpan.attributes.rowCount, sim.store.tableRows('x_order').length);

  const note = await service('entity-form-addnote', {
    regardingEntityLogicalName: 'contact',
    regardingEntityId: MEMBER,
    text: 'Invented note',
    file: { name: 'evidence.txt', type: 'text/plain', content: Buffer.from(BYTES).toString('base64') },
  });
  assert.equal(note.status, 201, await note.clone().text());
  const { Id: noteId } = await note.json();
  const noteTree = await treeOf(note);
  const upload = noteTree.spans.find((span) => span.kind === 'native-service');
  assert.deepEqual(
    [
      upload.attributes.transfer,
      upload.attributes.fileColumn,
      upload.attributes.fileName,
      upload.attributes.fileSize,
      upload.attributes.mimetype,
    ],
    ['upload', 'documentbody', 'evidence.txt', BYTES.length, 'text/plain'],
  );
  const download = await fetch(`${sim.url}/_entity/annotation/${noteId}`, { headers: { cookie: member } });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), BYTES);
  const downloadRoot = (await treeOf(download)).root;
  assert.deepEqual(
    [
      downloadRoot.entity,
      downloadRoot.recordId,
      downloadRoot.attributes.transfer,
      downloadRoot.attributes.fileName,
      downloadRoot.attributes.fileSize,
    ],
    ['annotation', noteId, 'download', 'evidence.txt', BYTES.length],
  );
  const exported = JSON.stringify(sim.trace.export({}));
  assert.equal(exported.includes(Buffer.from(BYTES).toString('base64')), false, 'no attachment bytes in the trace');
});

test('a refused Web API collection read carries the permission deny event, like a refused create', async () => {
  const response = await fetch(sim.url + '/_api/x_orders?$select=x_name');
  assert.equal(response.status, 403);
  await response.text();
  const tree = await treeOf(response);
  const webapi = tree.spans.find((span) => span.kind === 'webapi');
  assert.equal(webapi.status, 'denied');
  const deny = webapi.events.find((event) => event.type === 'permission');
  assert.deepEqual(
    [deny?.attributes.table, deny?.attributes.operation, deny?.attributes.result, deny?.attributes.code],
    ['x_order', 'read', 'deny', 'TABLE_PERMISSION_DENIED'],
  );
  assert.equal(deny.message, 'Table permission denies read on x_order');
  assert.deepEqual([tree.root.status, tree.root.error.code], ['denied', 'PermissionDenied']);
});
