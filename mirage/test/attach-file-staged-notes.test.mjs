// @test-kind observation: hosted session F2 (paqvilo2, basic forms with Attach File; the same at enhancedauthorization 3 and in the state-0 re-run, attach runs s0b–s0h, attachdel s0i–s0l, notes s0k/s0l; FORM-01b attach runs b/e, f/g, i/j and k/l, API-04f attachdel runs m/n and o/q, FORM-02e notes runs a and b): the attach-file count, its hint texts, the staged note of InitializeFileUpload and its permission answers, the staged delete and the notes listing, on an invented schema and a loopback fixture
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e70';
const CONTACT = 'c0000000-0000-4000-8000-000000000011';
const RECORD = 'b0000000-0000-4000-8000-000000000001';
const MULTIPLE = 'f0000000-0000-4000-8000-000000000001';
const SINGLE = 'f0000000-0000-4000-8000-000000000002';
const ADMIN_NOTE = 'e0000000-0000-4000-8000-000000000101';
const TEXT_NOTE = 'e0000000-0000-4000-8000-000000000102';

const annotationGrant = (operations) => ({
  id: 'persona-annotation',
  entity: 'annotation',
  scope: 'global',
  roles: ['Persona'],
  operations,
});

// A case table with two basic forms on one record: several files allowed (count 1, as the "max1" form) and one file
// (allow multiple off, as the "single" form). Both are required and accept 1 MB files.
async function fixture(
  t,
  { notes = [], annotation = ['create', 'append', 'update'], form = MULTIPLE, formExtra = '' } = {},
) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'attach-staged-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const attach = (multiple) =>
    `\nadx_attachfile: true\nadx_attachfilerequired: true\nadx_attachfilelabel: Case file\nadx_attachfilemaxsize: 1024${multiple ? '\nadx_attachfileallowmultiple: true\nadx_maximumnooffiles: 1' : ''}${formExtra}`;
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Attach`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `<!doctype html><html><body><form id="liquid_form">{% entityform name: "${form === MULTIPLE ? 'Multiple' : 'Single'}" %}</form></body></html>`,
    'Multiple.basicform.yml': `adx_entityformid: ${MULTIPLE}\nadx_name: Multiple\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_successmessage: Saved
adx_hideformonsuccess: false${attach(true)}`,
    'Single.basicform.yml': `adx_entityformid: ${SINGLE}\nadx_name: Single\nadx_entityname: sample\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_successmessage: Saved
adx_hideformonsuccess: false${attach(false)}`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const schema = { entity: 'sample', mode: 100000001, fields: [{ name: 'title', label: 'Title' }] };
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    watch: false,
    initial: {
      version: 1,
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          nameColumn: 'title',
          fields: { title: { dataverseType: 'nvarchar' } },
        },
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        annotation: { entitySet: 'annotations', idColumn: 'annotationid', nameColumn: 'subject' },
      },
      tables: {
        sample: [{ sampleid: RECORD, title: 'Invented case' }],
        contact: [{ contactid: CONTACT, fullname: 'Ada Persona' }],
        annotation: notes,
      },
      permissions: [
        { id: 'persona-sample', entity: 'sample', scope: 'global', roles: ['Persona'], operations: ['read', 'update'] },
        ...(annotation ? [annotationGrant(annotation)] : []),
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: { origin: null },
        endpoints: [],
        observed: { nativeFormTransport: 'postback', evidence: 'Invented loopback attach-file fixture' },
        componentSchemas: { [MULTIPLE]: schema, [SINGLE]: schema },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const session = signInHeaders(app, CONTACT, { roles: ['Persona'] });
  const headers = { ...session };
  const remember = (response) => {
    const visitor = response.headers.get('set-cookie');
    if (visitor) headers.cookie = [headers.cookie, visitor.split(';', 1)[0]].filter(Boolean).join('; ');
    return response;
  };
  const page = async () => {
    const response = remember(await fetch(`${app.url}/?id=${RECORD}`, { headers }));
    assert.equal(response.status, 200);
    return response.text();
  };
  const initialize = async (name = 'invented.txt', size = 3) =>
    remember(
      await fetch(
        `${app.url}/_api/file/InitializeFileUpload/note?${new URLSearchParams({ formType: 'basic', formId: form, regardingId: RECORD })}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            __RequestVerificationToken: app.csrf,
            'content-type': 'text/plain',
            'x-ms-file-name': name,
            'x-ms-file-size': String(size),
            'x-ms-file-type': 'text/plain',
            'x-ms-form-session-id': '',
          },
        },
      ),
    );
  const block = (staged, body = 'abc') =>
    fetch(
      `${app.url}/_api/file/UploadFileBlock/note?${new URLSearchParams({ offset: '0', fileSize: String(body.length), chunkSize: '4194304', noteId: staged.AnnotationId, formType: 'basic', formId: form })}`,
      {
        method: 'PUT',
        headers: {
          ...headers,
          __RequestVerificationToken: app.csrf,
          'content-type': 'text/plain',
          'x-ms-file-continuation-token': staged.FileContinuationToken,
          'x-ms-file-type': 'text/plain',
          'x-ms-form-session-id': '',
        },
        body,
      },
    );
  const remove = (noteId) =>
    fetch(`${app.url}/_api/file/delete/note?noteId=${noteId}`, {
      method: 'DELETE',
      headers: { ...headers, __RequestVerificationToken: app.csrf, 'x-ms-form-session-id': '' },
    });
  const controls = nativeFormControlIds('entityform', form);
  const post = (annotationIds = [], maxFile = null) =>
    fetch(`${app.url}/?id=${RECORD}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__EVENTTARGET', controls.buttons + 'UpdateButton'],
        ['__EVENTARGUMENT', ''],
        ['__RequestVerificationToken', app.csrf],
        [controls.names + 'title', 'Invented case'],
        [
          controls.names + 'AttachFile_HiddenField_AnnotationIds',
          annotationIds.length ? JSON.stringify(annotationIds) : '',
        ],
        ...(maxFile === null ? [] : [[controls.names + 'AttachFile_HiddenField_MaxFile', maxFile]]),
      ]),
    });
  const recordNotes = () =>
    app.store.tableRows('annotation').filter((row) => (row.objectid?.id ?? row.objectid) === RECORD);
  return { app, page, initialize, block, remove, post, notes: recordNotes };
}

const control = (html) => ({
  maxFile: /id="AttachFile_HiddenField_MaxFile" value="(\d+)"/.exec(html)?.[1] ?? null,
  hint: /<label for="AttachFile" id="NewAttachFileLabel">Case file<\/label>([^<]*)/.exec(html)?.[1] ?? null,
  required: /id="AttachFile"[^>]*aria-required="true"/.test(html),
  instanceId:
    /<input type="hidden" name="[^"]*AttachFile_HiddenField_InstanceId" id="AttachFile_HiddenField_InstanceId"(?: value="([^"]*)")?>/.exec(
      html,
    ),
});

const adminNote = {
  annotationid: ADMIN_NOTE,
  subject: 'Invented admin note',
  notetext: '*WEB* invented admin note',
  objecttypecode: 'sample',
  objectid: { id: RECORD, logical_name: 'sample' },
  filename: 'admin.txt',
  mimetype: 'text/plain',
  documentbody: Buffer.from('admin').toString('base64'),
  isdocument: true,
};
const textNote = {
  annotationid: TEXT_NOTE,
  subject: 'Invented text note',
  notetext: '*WEB* invented text only',
  objecttypecode: 'sample',
  objectid: { id: RECORD, logical_name: 'sample' },
  isdocument: false,
};

test('a note the visitor cannot read and a text-only note each take a slot; the hint and Required stay as captured', async (t) => {
  // Runs k and l, max1-admin and single-textnote (annotation Create+Append+Write without Read).
  const multiple = await fixture(t, { notes: [adminNote] });
  assert.deepEqual(
    (
      await multiple.app.store.fetchXml(
        '<fetch><entity name="annotation"><attribute name="subject"/></entity></fetch>',
        {
          id: CONTACT,
          contactId: CONTACT,
          roles: ['Persona'],
        },
      )
    ).entities ?? [],
    [],
    'the persona cannot read the admin note',
  );
  const counted = control(await multiple.page());
  assert.deepEqual(
    { maxFile: counted.maxFile, hint: counted.hint, required: counted.required },
    { maxFile: '0', hint: 'You can upload a maximum of 0 files, each up to 1MB.', required: true },
  );
  // A basic form renders the instance id without a value, and the platform script sends it as x-ms-form-session-id.
  assert.equal(counted.instanceId?.[1], undefined);

  const single = await fixture(t, { notes: [textNote], form: SINGLE });
  const one = control(await single.page());
  assert.deepEqual(
    { maxFile: one.maxFile, hint: one.hint, required: one.required },
    { maxFile: '0', hint: 'You can upload a maximum of 1 file, up to 1MB.', required: true },
  );

  const empty = await fixture(t);
  const free = control(await empty.page());
  assert.deepEqual(
    { maxFile: free.maxFile, hint: free.hint },
    { maxFile: '1', hint: 'You can upload a maximum of 1 files, each up to 1MB.' },
  );
});

test('InitializeFileUpload refuses a file beyond the count with 400 AU00039, also with MaxFile raised in the browser', async (t) => {
  // Runs b/e, f/g, i/j and k/l, one-file-client-cap-lifted.
  for (const [label, notes, form] of [
    ['admin note, several files', [adminNote], MULTIPLE],
    ['admin note, one file', [adminNote], SINGLE],
    ['text-only note, one file', [textNote], SINGLE],
  ]) {
    const { initialize, notes: rows } = await fixture(t, { notes, form });
    const refused = await initialize();
    assert.equal(refused.status, 400, label);
    assert.deepEqual(await refused.json(), { ErrorCode: 'AU00039', ErrorMessage: null }, label);
    assert.equal(refused.headers.get('content-type'), 'application/json; charset=utf-8', label);
    assert.equal(refused.headers.get('cache-control'), 'no-cache, no-store, must-revalidate', label);
    assert.equal(refused.headers.get('vary'), null, label);
    assert.equal(rows().length, 1, `${label}: no staged note`);
  }
});

test('InitializeFileUpload creates the staged note; without annotation Write the block answers 403 AU0005 and the orphan takes the slot', async (t) => {
  // Runs b/e and i/j (Create+Append), f/g (Read+Create+Append), max1-none.
  for (const annotation of [
    ['create', 'append'],
    ['read', 'create', 'append'],
  ]) {
    const label = annotation.join('+');
    const { page, initialize, block, post, notes } = await fixture(t, { annotation });
    const started = await initialize('invented-1.txt', 3);
    assert.equal(started.status, 200, label);
    assert.equal(started.headers.get('vary'), 'Accept-Encoding', label);
    const staged = await started.json();
    const [note] = notes();
    assert.equal(note.annotationid, staged.AnnotationId, label);
    assert.match(
      note.subject,
      /^Note created on \d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M UTC by Ada Persona \[contact:c0000000-0000-4000-8000-000000000011\]$/,
      label,
    );
    assert.deepEqual(
      [note.notetext, note.objecttypecode, note.isprivate, note.isdocument, note.filename ?? null],
      ['*WEB*', 'sample', false, false, null],
      label,
    );
    const denied = await block(staged);
    assert.equal(denied.status, 403, label);
    assert.equal(
      await denied.text(),
      '{"ErrorCode":"AU0005","ErrorMessage":"User does not have required permissions to {0} attachments."}',
      label,
    );
    assert.equal(denied.headers.get('content-type'), 'UPLOAD; charset=utf-8', label);
    assert.equal(denied.headers.get('cache-control'), 'private', label);
    // The staged note stays without a file and takes the form's only slot.
    assert.equal(notes().length, 1, label);
    assert.equal(notes()[0].filename ?? null, null, label);
    const after = control(await page());
    assert.deepEqual([after.maxFile, after.hint], ['0', 'You can upload a maximum of 0 files, each up to 1MB.'], label);
    const lifted = await initialize('invented-2.txt', 3);
    assert.equal(lifted.status, 400, label);
    assert.deepEqual(await lifted.json(), { ErrorCode: 'AU00039', ErrorMessage: null }, label);
    // The record's notes, the orphan included, do not satisfy Required.
    const required = await post();
    assert.equal(required.status, 200, label);
    assert.match(await required.text(), /Case file is a required field\./, label);
  }
});

test('with annotation Create, Append and Write the block writes the file into the staged note and the post saves', async (t) => {
  // Runs k and l, max1-none:one-file: 204 (Update annotation during the upload), the post saves, the note carries the
  // file, and the re-rendered page keeps the posted MaxFile 1 while the hint states 0 files.
  const { initialize, block, post, notes, page } = await fixture(t);
  const staged = await initialize('invented-k.txt', 3).then((response) => response.json());
  const accepted = await block(staged);
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get('content-type'), null);
  assert.deepEqual(
    [notes()[0].filename, notes()[0].mimetype, notes()[0].isdocument, notes()[0].filesize],
    ['invented-k.txt', 'text/plain', true, 3],
    'the upload wrote its file before the form was saved',
  );
  const saved = await post([staged.AnnotationId], '1');
  assert.equal(saved.status, 200);
  const savedHtml = await saved.text();
  assert.match(savedHtml, /Saved/);
  assert.deepEqual(
    [control(savedHtml).maxFile, control(savedHtml).hint],
    ['1', 'You can upload a maximum of 0 files, each up to 1MB.'],
  );
  const rows = notes();
  assert.equal(rows.length, 1, 'the staged note is the saved note');
  assert.deepEqual(
    [rows[0].annotationid, rows[0].filename, rows[0].mimetype, rows[0].isdocument, rows[0].notetext],
    [staged.AnnotationId, 'invented-k.txt', 'text/plain', true, '*WEB*'],
  );
  assert.equal(control(await page()).maxFile, '0');
});

test('a successful upload that is never submitted leaves its note with the file on the record', async (t) => {
  // Runs k and l: the upload's Update annotation precedes the postback, so the file is on the record without a save.
  const { app, initialize, block, notes, page } = await fixture(t, {
    annotation: ['read', 'create', 'append', 'update'],
  });
  const staged = await initialize('invented-unsaved.txt', 3).then((response) => response.json());
  assert.equal((await block(staged, 'xyz')).status, 204);
  const [note] = notes();
  assert.deepEqual(
    [note.annotationid, note.filename, note.isdocument],
    [staged.AnnotationId, 'invented-unsaved.txt', true],
  );
  const download = await fetch(`${app.url}/_entity/annotation/${staged.AnnotationId}`, {
    headers: signInHeaders(app, CONTACT, { roles: ['Persona'] }),
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'xyz');
  assert.equal(control(await page()).maxFile, '0');
});

test('DELETE /_api/file/delete/note needs annotation Delete; with it the staged note is removed', async (t) => {
  // Runs m/n (Read+Create+Append+Write) and o/q (… +Delete).
  const kept = await fixture(t, { annotation: ['read', 'create', 'append', 'update'] });
  const first = await kept.initialize('invented-m.txt', 3).then((response) => response.json());
  assert.equal((await kept.block(first)).status, 204);
  const denied = await kept.remove(first.AnnotationId);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    ErrorCode: 'AU0005',
    ErrorMessage: 'User does not have required permissions to DELETE attachments.',
  });
  assert.equal(denied.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(kept.notes().length, 1);

  const removed = await fixture(t, { annotation: ['read', 'create', 'append', 'update', 'delete'] });
  const second = await removed.initialize('invented-o.txt', 3).then((response) => response.json());
  assert.equal((await removed.block(second)).status, 204);
  const deleted = await removed.remove(second.AnnotationId);
  assert.equal(deleted.status, 204);
  assert.equal(deleted.headers.get('content-type'), null);
  assert.equal(removed.notes().length, 0);
  // The removed upload is no longer available to a save.
  assert.equal((await removed.post([second.AnnotationId])).status, 400);
  assert.equal(removed.notes().length, 0);
});

// @test-kind observation: hosted session F2 state-0 re-run (attach runs s0g and s0h, annotation permission Read only, the same records and forms as runs k and l): the edit form renders no attach-file control, Required is not applied and the form saves with no file
test('without annotation Create the form renders no attach-file control and saves without a file', async (t) => {
  for (const notes of [[adminNote], []]) {
    const { page, post, notes: rows } = await fixture(t, { notes, annotation: ['read'] });
    const html = await page();
    assert.doesNotMatch(html, /id="AttachFile"/);
    assert.doesNotMatch(html, /RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds/);
    const saved = await post();
    assert.equal(saved.status, 200);
    const savedHtml = await saved.text();
    assert.match(savedHtml, /Saved/);
    assert.doesNotMatch(savedHtml, /Case file is a required field./);
    assert.equal(rows().length, notes.length);
  }
});

// @test-kind security: the staged note is created only with annotation Create on the record (the hosted visitors whose uploads created it held Read, Create and Append: attachdel runs a2/b2 and h/p2); an upload request sent without the control by a visitor with Read only creates no note and its block is refused
test('an upload request by a visitor without annotation Create creates no note', async (t) => {
  const { initialize, block, notes } = await fixture(t, { annotation: ['read'] });
  const started = await initialize();
  assert.equal(started.status, 200);
  const staged = await started.json();
  assert.equal(notes().length, 0);
  const denied = await block(staged);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).ErrorCode, 'AU0005');
  assert.equal(notes().length, 0);
});

test("the notes service lists only *WEB* notes, not its author's own note without the prefix", async (t) => {
  // Notes runs a, b, s0k and s0l (hosted-f2 runs/<run>/notes.json, notes:list and notes:add-*): the plain note and the
  // *PRIVATE* admin note are hidden; the notes the persona adds through the control (`*WEB*<text>`, subject "Note created
  // on … by <name> [contact:<id>]", created by the site's application user) are listed after the seeded *WEB* notes with
  // the persona's name, the text without the prefix and Edit/Delete; a seeded note shows its creator and no toolbar.
  const note = (id, subject, notetext, createdon, extra = {}) => ({
    annotationid: id,
    subject,
    notetext,
    objecttypecode: 'sample',
    objectid: { id: RECORD, logical_name: 'sample' },
    createdon,
    ...extra,
  });
  const { app } = await fixture(t, {
    annotation: ['read', 'create', 'append'],
    notes: [
      note('e0000000-0000-4000-8000-000000000201', 'Invented web note', '*WEB* web note', '2026-01-01T00:00:01Z', {
        createdby: { id: 'e0000000-0000-4000-8000-000000000301', logical_name: 'systemuser', name: 'Invented Admin' },
      }),
      note('e0000000-0000-4000-8000-000000000202', 'Invented plain note', 'plain note', '2026-01-01T00:00:02Z'),
      note('e0000000-0000-4000-8000-000000000203', 'Invented note *PRIVATE*', '*WEB* private', '2026-01-01T00:00:03Z'),
      note(
        'e0000000-0000-4000-8000-000000000204',
        `Note created on 1/1/2026 12:00:04 AM UTC by Ada Persona [contact:${CONTACT}]`,
        'own note without the prefix',
        '2026-01-01T00:00:04Z',
      ),
      note(
        'e0000000-0000-4000-8000-000000000205',
        `Note created on 1/1/2026 12:00:05 AM UTC by Ada Persona [contact:${CONTACT}]`,
        '*WEB*own portal note',
        '2026-01-01T00:00:05Z',
      ),
    ],
  });
  const response = await fetch(`${app.url}/_services/entity-notes/${SITE}`, {
    method: 'POST',
    headers: {
      ...signInHeaders(app, CONTACT, { roles: ['Persona'] }),
      'content-type': 'application/json',
      __RequestVerificationToken: app.csrf,
    },
    body: JSON.stringify({
      regarding: { Id: RECORD, LogicalName: 'sample' },
      orders: [{ Attribute: 'createdon', Alias: null, Direction: null }],
      page: 1,
      pageSize: 5,
    }),
  });
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(
    listed.Records.map((record) => record.Subject),
    ['Invented web note', `Note created on 1/1/2026 12:00:05 AM UTC by Ada Persona [contact:${CONTACT}]`],
  );
  assert.equal(listed.ItemCount, 2);
  assert.deepEqual(
    listed.Records.map(({ PostedByName, UnformattedText, DisplayToolbar, CanWrite, CanDelete, IsPrivate }) => [
      PostedByName,
      UnformattedText,
      DisplayToolbar,
      CanWrite,
      CanDelete,
      IsPrivate,
    ]),
    [
      ['Invented Admin', ' web note', false, false, false, false],
      ['Ada Persona', 'own portal note', true, true, true, false],
    ],
  );
});

// @test-kind security: only the runtime's own upload staging may name a staged note; a JSON submission that names an existing note's id saves a new note and leaves that note unchanged
test('a JSON form submission cannot write its file into an existing note by naming its id', async (t) => {
  const { app, notes } = await fixture(t, { notes: [textNote], annotation: ['read', 'create', 'append', 'update'] });
  const response = await fetch(`${app.url}/__sim/forms/entityform/${MULTIPLE}/submit`, {
    method: 'POST',
    headers: {
      ...signInHeaders(app, CONTACT, { roles: ['Persona'] }),
      'content-type': 'application/json',
      __RequestVerificationToken: app.csrf,
    },
    body: JSON.stringify({
      recordId: RECORD,
      values: { title: 'Invented case' },
      attachments: [
        {
          name: 'forged.txt',
          type: 'text/plain',
          content: Buffer.from('forged').toString('base64'),
          noteId: TEXT_NOTE,
          regarding: { entity: 'sample', id: RECORD },
        },
      ],
    }),
  });
  await response.arrayBuffer();
  const stored = notes().find((row) => row.annotationid === TEXT_NOTE);
  assert.equal(stored.filename ?? null, null);
  assert.equal(stored.documentbody ?? null, null);
  assert.equal(notes().filter((row) => row.filename === 'forged.txt' && row.annotationid === TEXT_NOTE).length, 0);
});

// @test-kind security: the form's Attach File Maximum Size and, with Restrict Files To Accept, its accepted types are enforced on the declared file at InitializeFileUpload, before any note is created or any byte is staged, so no file outside them is stored; hosted refuses such files in the browser and its server answer was not captured, so the 400 takes the hosted AU shape with the form service's own code and message (inferred)
test('InitializeFileUpload refuses a file over the form size or outside its accepted types and stores nothing', async (t) => {
  const sized = await fixture(t);
  const big = await sized.initialize('big.html', 2 * 1024 * 1024);
  assert.equal(big.status, 400);
  assert.deepEqual(await big.json(), {
    ErrorCode: 'FormAttachmentTooLarge',
    ErrorMessage: 'big.html exceeds the maximum file size.',
  });
  assert.equal(sized.notes().length, 0);
  assert.equal((await sized.initialize('small.txt', 3)).status, 200, 'a file within the limit is staged');

  const typed = await fixture(t, {
    formExtra:
      '\nadx_attachfileaccept: image/*\nadx_attachfileacceptextensions: .png\nadx_attachfilerestrictaccept: true',
  });
  const page = await typed.initialize('page.html', 3);
  assert.equal(page.status, 400);
  assert.equal((await page.json()).ErrorCode, 'FormAttachmentType');
  assert.equal(typed.notes().length, 0);
});
