import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';

async function fixture(
  t,
  {
    transport = 'postback',
    redirect = false,
    readOnly = false,
    wizard = false,
    lookup = false,
    attachments = false,
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-postback-http-'));
  const files = {
    'website.yml': 'adx_websiteid: fixture-site\nadx_name: Invented native transport',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':
      '<!doctype html><html><body><form id="liquid_form">{% entityform name: "First" %}{% entityform name: "Second" %}</form></body></html>',
    'First.basicform.yml': `adx_entityformid: first\nadx_name: First\nadx_mode: ${readOnly ? 100000002 : 100000001}\nadx_recordidquerystringparametername: firstrow`,
    'Second.basicform.yml': `adx_entityformid: second\nadx_name: Second\nadx_mode: 100000001\nadx_recordidquerystringparametername: secondrow\nadx_successmessage: Saved source message\nadx_hideformonsuccess: false${redirect ? '\nadx_onsuccess: 756150001\nadx_redirecturl: /done/?source=owned\nadx_redirecturlappendentityidquerystring: true\nadx_redirecturlquerystringname: row' : ''}`,
  };
  if (wizard) {
    files['Main.webtemplate.source.html'] =
      '<!doctype html><html><body><form id="liquid_form">{% webform name: "Wizard" %}</form></body></html>';
    files['Wizard.advancedform.yml'] = 'adx_webformid: wizard\nadx_name: Wizard';
  }
  if (attachments) files['Second.basicform.yml'] += '\nadx_attachfile: true\nadx_attachfilemaxsize: 8';
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const fields = [
    { name: 'title', type: 'text', label: 'Title', required: true },
    { name: 'description', type: 'textarea' },
    { name: 'count', dataverseType: 'int', minimum: 0, maximum: 10 },
  ];
  if (lookup) fields.push({ name: 'customerid', type: 'lookup' });
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          fields: {
            title: { dataverseType: 'nvarchar' },
            description: { dataverseType: 'memo' },
            count: { dataverseType: 'int', minValue: 0, maxValue: 10 },
          },
          ...(lookup
            ? {
                relationships: {
                  customer_account: { entity: 'account', from: 'customerid', to: 'accountid', many: false },
                  customer_contact: { entity: 'contact', from: 'customerid', to: 'contactid', many: false },
                },
              }
            : {}),
        },
        account: { entitySet: 'accounts', idColumn: 'accountid' },
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
      },
      tables: {
        sample: [
          { sampleid: 'first-row', title: 'First' },
          { sampleid: 'second-row', title: 'Second' },
        ],
        account: [{ accountid: 'owned-account' }],
        contact: [{ contactid: 'owned-contact' }],
      },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        observed: { nativeFormTransport: transport, evidence: 'Invented loopback transport contract' },
        componentSchemas: {
          first: { entity: 'sample', fields },
          second: { entity: 'sample', fields },
          wizard: {
            initialStepId: 'create',
            steps: [
              {
                stepId: 'create',
                nextStepId: 'edit',
                entity: 'sample',
                mode: 100000000,
                fields: [{ name: 'title', required: true }],
              },
              { stepId: 'edit', entity: 'sample', mode: 100000001, fields: [{ name: 'title', required: true }] },
            ],
          },
        },
      },
    },
  });
  if (attachments) {
    app.store.state.mappings.annotation = { entitySet: 'annotations', idColumn: 'annotationid' };
    app.store.state.tables.annotation = [];
  }
  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const route = '/?firstrow=first-row&secondrow=second-row';
  const controls = nativeFormControlIds('entityform', 'second');
  const post = (values = {}, extra = [], target = controls.buttons + 'UpdateButton', headers = {}) =>
    fetch(app.url + route, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams([
        ['__EVENTTARGET', target],
        ['__EVENTARGUMENT', ''],
        ['__RequestVerificationToken', app.csrf],
        ...Object.entries(values).map(([key, value]) => [controls.names + key, value]),
        ...extra,
      ]),
    });
  return { app, post, route, controls };
}

async function initializeFile(app, headers) {
  const response = await fetch(app.url + '/_api/file/InitializeFileUpload/note', { method: 'POST', headers });
  const visitor = response.headers.get('set-cookie');
  if (visitor) headers.cookie = [headers.cookie, visitor.split(';', 1)[0]].filter(Boolean).join('; ');
  return response;
}

async function pendingFileBlock(app, headers, annotationId, token) {
  let request, serverClosed;
  const reading = new Promise((resolve) =>
    app.server.once('request', (req) => {
      serverClosed = new Promise((closed) => req.once('close', closed));
      req.once('readable', resolve);
    }),
  );
  const response = new Promise((resolve, reject) => {
    request = http.request(
      app.url + `/_api/file/UploadFileBlock/note?noteId=${annotationId}&offset=0`,
      {
        method: 'PUT',
        headers: { ...headers, 'x-ms-file-continuation-token': token, 'content-length': '3' },
      },
      (value) => {
        value.resume();
        value.once('end', () => resolve(value.statusCode));
      },
    );
    request.on('error', reject);
    request.write('a');
  });
  await reading;
  return { response, serverClosed, end: () => request.end('bc'), destroy: () => request.destroy() };
}

test('URLencoded postback saves only the exact selected form and returns source-configured inline HTML', async (t) => {
  const { app, post } = await fixture(t);
  const first = nativeFormControlIds('entityform', 'first');
  const response = await post({ title: '<b>Owned</b>', description: 'A\r\nB', count: '3' }, [
    [first.names + 'title', 'Forged first'],
    ['recordId', 'first-row'],
  ]);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.match(html, /id="MessageLabel">Saved source message/);
  assert.match(html, /value="&lt;b&gt;Owned&lt;\/b&gt;"/);
  assert.deepEqual(
    app.store.snapshot().tables.sample.map((row) => [row.sampleid, row.title]),
    [
      ['first-row', 'First'],
      ['second-row', '<b>Owned</b>'],
    ],
  );
  assert.equal(app.store.snapshot().tables.sample[1].description, 'A\nB');
  assert.equal(app.store.snapshot().tables.sample[1].count, 3);
});

test('source redirect retains the exact service target and appended record key', async (t) => {
  const { post } = await fixture(t, { redirect: true });
  const response = await post({ title: 'Redirected' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/done/?source=owned&row=second-row');
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
});

test('lookup postbacks use only the declared target, preserve omission and clear an explicit empty control', async (t) => {
  const { app, post, controls } = await fixture(t, { lookup: true });
  const row = () => app.store.snapshot().tables.sample.find((item) => item.sampleid === 'second-row');
  assert.equal(
    (
      await post({ title: 'Account linked', customerid: 'owned-account' }, [
        [controls.names + 'customerid_entityname', 'account'],
      ])
    ).status,
    200,
  );
  assert.equal(row().customerid.id, 'owned-account');
  assert.equal(row().customerid.logical_name, 'account');
  assert.equal((await post({ title: 'Lookup omitted' })).status, 200);
  assert.equal(row().customerid.id, 'owned-account');
  assert.equal(
    (
      await post({ title: 'Contact linked', customerid: 'owned-contact' }, [
        [controls.names + 'customerid_entityname', 'contact'],
      ])
    ).status,
    200,
  );
  assert.equal(row().customerid.logical_name, 'contact');
  assert.equal((await post({ title: 'Lookup cleared', customerid: '' })).status, 200);
  assert.equal(row().customerid, null);
  assert.equal(
    (
      await post({ title: 'Unselected empty native lookup', customerid: '' }, [
        [controls.names + 'customerid_entityname', ''],
      ])
    ).status,
    200,
  );
  assert.equal(row().customerid, null);
});

test('unknown, ambiguous and repeated lookup targets cannot mutate the selected row', async (t) => {
  const { app, post, controls } = await fixture(t, { lookup: true });
  const before = app.store.snapshot().tables.sample;
  for (const targets of [[], ['unknown'], ['account', 'contact']]) {
    const response = await post(
      { title: 'Must not save', customerid: 'owned-account' },
      targets.map((value) => [controls.names + 'customerid_entityname', value]),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(app.store.snapshot().tables.sample, before);
  }
});

test('native field validation renders HTML200 with posted escaped values and no saved change', async (t) => {
  const { app, post } = await fixture(t);
  const response = await post({ title: '', description: '<script>unexecuted</script>', count: 'bad' });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Title is a required field/);
  assert.match(html, /must be a valid integer/);
  assert.match(html, /value="bad"[^>]*id="count"/);
  assert.match(html, /&lt;script&gt;unexecuted&lt;\/script&gt;/);
  assert.equal(app.store.snapshot().tables.sample[1].title, 'Second');
});

test('advanced URLencoded submission follows its own visitor session and previous-step action', async (t) => {
  const { app } = await fixture(t, { wizard: true });
  const ids = nativeFormControlIds('webform', 'wizard');
  const response = await fetch(app.url + '/', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['__EVENTTARGET', ids.buttons + 'NextButton'],
      ['__RequestVerificationToken', app.csrf],
      [ids.names + 'title', 'Visitor created'],
      ['stepId', 'forged'],
      ['sessionid', 'forged'],
    ]),
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /stepid=edit/);
  // ASP.NET Response.Redirect: page cache headers without Vary and the "Object moved" body.
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('expires'), '-1');
  assert.equal(response.headers.get('vary'), null);
  assert.ok(response.headers.get('x-frame-options'));
  assert.match(
    await response.text(),
    /^<html><head><title>Object moved<\/title><\/head><body>\r\n<h2>Object moved to <a href="[^"]*stepid=edit[^"]*">here<\/a>\.<\/h2>\r\n<\/body><\/html>\r\n$/,
  );
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const next = await fetch(app.url + response.headers.get('location'), { headers: { cookie } });
  const html = await next.text();
  assert.match(html, /value="Visitor created"/);
  const previous = await fetch(app.url + response.headers.get('location'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams([
      ['__EVENTTARGET', ids.buttons + 'PreviousButton'],
      ['__RequestVerificationToken', app.csrf],
      [ids.names + 'title', 'Ignored previous'],
    ]),
  });
  assert.equal(previous.status, 302);
  assert.match(previous.headers.get('location'), /stepid=create/);
  assert.equal(app.store.snapshot().tables.sample.filter((row) => row.title === 'Visitor created').length, 1);
  assert.equal(
    app.store.snapshot().tables.sample.some((row) => row.title === 'Ignored previous'),
    false,
  );
});

test('CSRF, duplicate scalar, unknown targets and read-only controls retain failure status and never save', async (t) => {
  const { app, post, controls } = await fixture(t, { readOnly: true });
  const noToken = await fetch(app.url + '/?secondrow=second-row', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '__EVENTTARGET=forged',
  });
  assert.equal(noToken.status, 403);
  assert.equal((await post({ title: 'Unknown' }, [], 'unknown')).status, 400);
  assert.equal((await post({ title: 'Duplicated' }, [[controls.names + 'title', 'second']])).status, 400);
  assert.equal((await post({}, [], nativeFormControlIds('entityform', 'first').buttons + 'UpdateButton')).status, 400);
  assert.deepEqual(
    app.store.snapshot().tables.sample.map((row) => row.title),
    ['First', 'Second'],
  );
});

test('default JSON route and JSON profile remain unchanged', async (t) => {
  const { app, post, route } = await fixture(t, { transport: 'json' });
  assert.equal((await post({ title: 'Unaccepted transport' })).status, 405);
  const response = await fetch(app.url + '/__sim/forms/entityform/second/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    body: JSON.stringify({ recordId: 'second-row', values: { title: 'JSON saved' }, pageUrl: route }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome.message, 'Saved source message');
});

test('the attach-file API stages a file under an annotation id only with the token and in order', async (t) => {
  const { app } = await fixture(t);
  const headers = {
    __RequestVerificationToken: app.csrf,
    'x-ms-file-name': 'a.txt',
    'x-ms-file-size': '3',
    'x-ms-file-type': 'text/plain',
    'content-type': 'text/plain',
  };
  assert.equal(
    (
      await fetch(app.url + '/_api/file/InitializeFileUpload/note?formId=f&formType=basic&regardingId=', {
        method: 'POST',
        headers: { ...headers, __RequestVerificationToken: 'wrong' },
      })
    ).status,
    403,
  );
  const started = await initializeFile(app, headers);
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(started.headers.get('vary'), 'Accept-Encoding');
  assert.ok(started.headers.get('x-frame-options'));
  const { AnnotationId, FileContinuationToken } = await started.json();
  assert.match(AnnotationId, /^[0-9a-f-]{36}$/);
  const block = (offset, token = FileContinuationToken) =>
    fetch(
      app.url +
        `/_api/file/UploadFileBlock/note?chunkSize=3&fileSize=3&formId=f&formType=basic&noteId=${AnnotationId}&offset=${offset}`,
      { method: 'PUT', headers: { ...headers, 'x-ms-file-continuation-token': token }, body: 'abc' },
    );
  assert.equal((await block(0, 'forged')).status, 404);
  assert.equal((await block(1)).status, 400);
  assert.equal((await block(0)).status, 204);
});

test('overlapping file blocks cannot both commit the same offset', { timeout: 5000 }, async (t) => {
  const { app } = await fixture(t);
  const headers = { __RequestVerificationToken: app.csrf, 'x-ms-file-name': 'parallel.txt', 'x-ms-file-size': '6' };
  const { AnnotationId, FileContinuationToken } = await initializeFile(app, headers).then((response) =>
    response.json(),
  );
  const first = await pendingFileBlock(app, headers, AnnotationId, FileContinuationToken);
  const second = await pendingFileBlock(app, headers, AnnotationId, FileContinuationToken);
  try {
    first.end();
    assert.equal(await first.response, 204);
    second.end();
    assert.equal(await second.response, 400);
  } finally {
    first.destroy();
    second.destroy();
  }
  const next = await fetch(app.url + `/_api/file/UploadFileBlock/note?noteId=${AnnotationId}&offset=3`, {
    method: 'PUT',
    headers: { ...headers, 'x-ms-file-continuation-token': FileContinuationToken },
    body: 'def',
  });
  assert.equal(next.status, 204, 'A rejected duplicate preserves the valid next offset');
});

test('aborted or expired slow upload bodies never commit a partial block', { timeout: 5000 }, async (t) => {
  const { app } = await fixture(t);
  const headers = { __RequestVerificationToken: app.csrf, 'x-ms-file-name': 'slow.txt', 'x-ms-file-size': '3' };
  const initialize = () => initializeFile(app, headers).then((response) => response.json());
  const first = await initialize();
  const aborted = await pendingFileBlock(app, headers, first.AnnotationId, first.FileContinuationToken);
  const rejection = assert.rejects(aborted.response, /socket hang up/);
  aborted.destroy();
  await rejection;
  await aborted.serverClosed;
  assert.equal(
    (
      await fetch(app.url + `/_api/file/UploadFileBlock/note?noteId=${first.AnnotationId}&offset=0`, {
        method: 'PUT',
        headers: { ...headers, 'x-ms-file-continuation-token': first.FileContinuationToken },
        body: 'abc',
      })
    ).status,
    204,
  );
  const second = await initialize();
  const expired = await pendingFileBlock(app, headers, second.AnnotationId, second.FileContinuationToken);
  const now = Date.now;
  try {
    const future = now() + 3600001;
    Date.now = () => future;
    expired.end();
    assert.equal(await expired.response, 404);
  } finally {
    Date.now = now;
    expired.destroy();
  }
});

test('staging capacity rejects a new upload without evicting an existing visitor file', async (t) => {
  const { app } = await fixture(t);
  const headers = { __RequestVerificationToken: app.csrf, 'x-ms-file-name': 'bounded.txt', 'x-ms-file-size': '1' };
  const initialize = () => initializeFile(app, headers);
  assert.equal(
    (
      await fetch(app.url + '/_api/file/InitializeFileUpload/note', {
        method: 'POST',
        headers: { ...headers, 'x-ms-file-size': '1.5' },
      })
    ).status,
    400,
  );
  const first = await initialize().then((response) => response.json());
  for (let index = 1; index < 50; index++) {
    const response = await initialize();
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const rejected = await initialize();
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'StagedUploadLimit');
  assert.equal(
    (
      await fetch(app.url + `/_api/file/UploadFileBlock/note?noteId=${first.AnnotationId}&offset=0`, {
        method: 'PUT',
        headers: { ...headers, 'x-ms-file-continuation-token': first.FileContinuationToken },
        body: 'a',
      })
    ).status,
    204,
  );
});

test('staged attachments survive failed validation and are consumed only once by a committed postback', async (t) => {
  const { app, post: postForm, controls } = await fixture(t, { attachments: true });
  const headers = {
    __RequestVerificationToken: app.csrf,
    'x-ms-file-name': '<draft>.txt',
    'x-ms-file-size': '3',
    'x-ms-file-type': 'text/plain',
  };
  const staged = await initializeFile(app, headers).then((response) => response.json());
  const post = (values, extra) => postForm(values, extra, undefined, { cookie: headers.cookie });
  assert.equal(
    (
      await fetch(app.url + `/_api/file/UploadFileBlock/note?noteId=${staged.AnnotationId}&offset=0`, {
        method: 'PUT',
        headers: { ...headers, 'x-ms-file-continuation-token': staged.FileContinuationToken },
        body: 'abc',
      })
    ).status,
    204,
  );
  const fileControls = [
    [controls.names + 'AttachFile_HiddenField_AnnotationIds', JSON.stringify([staged.AnnotationId])],
  ];
  const invalid = await post({ title: '' }, fileControls);
  assert.equal(invalid.status, 200);
  const invalidHtml = await invalid.text();
  assert.match(invalidHtml, /Title is a required field/);
  assert.match(
    invalidHtml,
    new RegExp(`id="AttachFile_HiddenField_AnnotationIds" value="\\[&quot;${staged.AnnotationId}&quot;\\]"`),
  );
  assert.match(invalidHtml, /&lt;draft&gt;\.txt \(3 bytes\)/);
  assert.equal(app.store.state.tables.annotation.length, 0);
  const original = app.store.state.tables.sample[1].title;
  let rejectedNote = false;
  app.store.setPluginPipeline(({ entity, stage }) => {
    if (entity === 'annotation' && stage === 20) {
      rejectedNote = true;
      throw new Error('Synthetic annotation write rejected');
    }
  });
  const denied = await post({ title: 'Failed note' }, fileControls);
  // A provider failure after field validation must preserve both state and staging.
  assert.equal(denied.status, 200);
  await denied.arrayBuffer();
  assert.equal(rejectedNote, true);
  assert.equal(app.store.state.tables.sample[1].title, original);
  assert.equal(app.store.state.tables.annotation.length, 0);
  app.store.setPluginPipeline(
    () => {},
    () => false,
  );
  assert.equal((await post({ title: 'Saved note' }, fileControls)).status, 200);
  assert.equal(app.store.state.tables.annotation.length, 1);
  // The body is read through the portal's note read path: storage routing may hold it outside the row (__blobkey).
  const savedNote = await fetch(app.url + `/_entity/annotation/${app.store.state.tables.annotation[0].annotationid}`);
  assert.equal(savedNote.status, 200);
  assert.equal(Buffer.from(await savedNote.arrayBuffer()).toString('base64'), 'YWJj');
  const repeated = await post({ title: 'Must not duplicate note' }, fileControls);
  assert.equal(repeated.status, 400);
  assert.equal(app.store.state.tables.annotation.length, 1);
  assert.equal(app.store.state.tables.sample[1].title, 'Saved note');
  const next = await initializeFile(app, headers).then((response) => response.json());
  assert.equal(
    (
      await fetch(app.url + `/_api/file/UploadFileBlock/note?noteId=${next.AnnotationId}&offset=0`, {
        method: 'PUT',
        headers: { ...headers, 'x-ms-file-continuation-token': next.FileContinuationToken },
        body: 'abc',
      })
    ).status,
    204,
  );
  const nextControls = [[controls.names + 'AttachFile_HiddenField_AnnotationIds', JSON.stringify([next.AnnotationId])]];
  const raced = await Promise.all(['Concurrent one', 'Concurrent two'].map((title) => post({ title }, nextControls)));
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 400]);
  await Promise.all(raced.map((response) => response.arrayBuffer()));
  assert.equal(
    app.store.state.tables.annotation.length,
    2,
    'Concurrent postbacks cannot save the same staged file twice',
  );
});

test('staged files stay private to the browser visitor and persona that initialized them', async (t) => {
  const { app, post, controls } = await fixture(t, { attachments: true });
  app.store.state.tables.contact.push({ contactid: 'other-contact' });
  const signed = app.signIn('owned-contact').cookieHeader;
  const first = {
    cookie: signed,
    __RequestVerificationToken: app.csrf,
    'x-ms-file-name': 'private.txt',
    'x-ms-file-size': '3',
  };
  const second = { ...first };
  const staged = await initializeFile(app, first).then((response) => response.json());
  await initializeFile(app, second).then((response) => response.arrayBuffer());
  const block = (headers) =>
    fetch(app.url + `/_api/file/UploadFileBlock/note?noteId=${staged.AnnotationId}&offset=0`, {
      method: 'PUT',
      headers: { ...headers, 'x-ms-file-continuation-token': staged.FileContinuationToken },
      body: 'abc',
    });
  assert.equal(
    (await block(second)).status,
    404,
    'Another browser with the same contact and stolen token cannot upload',
  );
  assert.equal(
    (await block({ ...first, cookie: first.cookie.replace(signed, app.signIn('other-contact').cookieHeader) })).status,
    404,
    'Changing persona does not inherit an earlier upload',
  );
  assert.equal((await block(first)).status, 204);
  const field = controls.names + 'AttachFile_HiddenField_AnnotationIds';
  const values = [[field, JSON.stringify([staged.AnnotationId])]];
  assert.equal((await post({ title: 'Other browser' }, values, undefined, { cookie: second.cookie })).status, 400);
  assert.equal(
    (
      await post(
        { title: 'Duplicate' },
        [[field, JSON.stringify([staged.AnnotationId, staged.AnnotationId.toUpperCase()])]],
        undefined,
        { cookie: first.cookie },
      )
    ).status,
    400,
  );
  assert.equal(app.store.state.tables.annotation.length, 0);
  assert.equal((await post({ title: 'Own browser' }, values, undefined, { cookie: first.cookie })).status, 200);
  assert.equal(app.store.state.tables.annotation.length, 1);
  assert.equal(app.store.state.tables.sample[1].title, 'Own browser');
});
