// Notes rich text (Timeline/RTEEnabled) and the activity timeline (CustomerSupport/DisplayAllUserActivitiesOnTimeline)
// through the native services and the form renderer, over an invented schema on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { handleNativeService } from '../lib/native-services.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { PORTAL_TIMELINE_VIEW_ID, sanitizeNoteHtml } from '../lib/portal-timeline.mjs';
import { serveRoutes } from './support/route-server.mjs';

const id = (n) => `02000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const website = id(100);
const reader = id(101);
const author = id(102);
const caseId = id(1);
const otherCase = id(2);
const gadget = id(3);
const XSS =
  '<p>Hello <b>team</b></p><script>window.__xss=1</script><img src="x" onerror="window.__xss=2"><a href="javascript:window.__xss=3">go</a><iframe src="https://example.invalid"></iframe><p onclick="window.__xss=4" style="color:red">done</p>';
const lookup = (recordId, logicalName) => ({ id: recordId, logical_name: logicalName });
const activity = (n, table, overrides = {}) => ({
  activityid: id(n),
  subject: `${table} ${n}`,
  regardingobjectid: lookup(caseId, 'incident'),
  createdon: `2026-02-${String(n).padStart(2, '0')}T00:00:00Z`,
  ...overrides,
});
const timelineView = (fetchXml) => ({
  id: PORTAL_TIMELINE_VIEW_ID,
  entity: 'activitypointer',
  name: 'Portal Timeline View',
  fetchXml,
});
const typeView = (...codes) =>
  timelineView(
    `<fetch><entity name="activitypointer"><attribute name="subject"/><order attribute="createdon" descending="true"/><filter type="and"><filter type="or"><condition attribute="activitytypecode" operator="in">${codes.map((code) => `<value>${code}</value>`).join('')}</condition></filter></filter></entity></fetch>`,
  );

async function fixture(
  t,
  { settings = {}, views = [], permissions, notes = [], activities = {}, namedMappings = true } = {},
) {
  const state = emptyState();
  // Simulator state keys a mapping by its table and need not name it inside (namedMappings: false).
  const activityMapping = (logicalName, entitySet) => ({
    ...(namedMappings ? { logicalName } : {}),
    entitySet,
    idColumn: 'activityid',
    nameColumn: 'subject',
  });
  state.mappings = {
    incident: { logicalName: 'incident', entitySet: 'incidents', idColumn: 'incidentid', nameColumn: 'title' },
    pqx_gadget: {
      logicalName: 'pqx_gadget',
      entitySet: 'pqx_gadgets',
      idColumn: 'pqx_gadgetid',
      nameColumn: 'pqx_name',
    },
    contact: { logicalName: 'contact', entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    annotation: {
      logicalName: 'annotation',
      entitySet: 'annotations',
      idColumn: 'annotationid',
      nameColumn: 'subject',
    },
    phonecall: activityMapping('phonecall', 'phonecalls'),
    email: activityMapping('email', 'emails'),
    appointment: activityMapping('appointment', 'appointments'),
    adx_portalcomment: activityMapping('adx_portalcomment', 'adx_portalcomments'),
  };
  state.tables.incident = [
    { incidentid: caseId, title: 'Case' },
    { incidentid: otherCase, title: 'Other case' },
  ];
  state.tables.pqx_gadget = [{ pqx_gadgetid: gadget, pqx_name: 'Gadget' }];
  state.tables.contact = [
    { contactid: reader, fullname: 'Reader' },
    { contactid: author, fullname: 'Author' },
  ];
  state.tables.annotation = notes;
  for (const [table, rows] of Object.entries(activities)) state.tables[table] = rows;
  state.permissions = permissions ?? [
    { entity: 'incident', scope: 'global', roles: ['Reader'], operations: ['read', 'appendTo'] },
    { entity: 'pqx_gadget', scope: 'global', roles: ['Reader'], operations: ['read', 'appendTo'] },
    { entity: 'annotation', scope: 'global', roles: ['Reader'], operations: ['read', 'create', 'update', 'append'] },
    ...['phonecall', 'email', 'appointment', 'adx_portalcomment'].map((entity) => ({
      entity,
      scope: 'global',
      roles: ['Reader'],
      operations: ['read'],
    })),
  ];
  state.settings.permissionMode = 'enforce';
  const store = await new DataStore({ state }).init();
  const identity = { contactId: reader, id: reader, fullname: 'Reader', roles: ['Reader'] };
  const diagnostics = [];
  const context = {
    store,
    identity,
    csrf: 'page-token',
    portal: { website: { id: website }, settings },
    metadata: { views },
    recordDiagnostic: (entry) => diagnostics.push(entry),
    change: (write) => write(),
    readProvider: {
      get: (entity, recordId, caller) => store.get(entity, recordId, caller, { portalRequest: true }),
      fetchXml: (xml, caller) => store.fetchXml(xml, caller, { portalRequest: true }),
    },
  };
  const origin = await serveRoutes(t, (req, res, url) => handleNativeService(req, res, url, context));
  const post = (path, body) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: context.csrf },
      body: JSON.stringify(body),
    });
  const notesPage = async (regarding = { LogicalName: 'incident', Id: caseId }) => {
    const response = await post(`/_services/entity-notes/${website}`, { regarding, page: 1, pageSize: 10 });
    assert.equal(response.status, 200);
    return response.json();
  };
  const timeline = (body) =>
    post(`/_portal/${website}/EntityActivity/GetActivities`, {
      regarding: { LogicalName: 'incident', Id: caseId },
      page: 1,
      ...body,
    });
  const activityIds = async (body = {}) => {
    const response = await timeline(body);
    assert.equal(response.status, 200);
    return (await response.json()).Records.map((record) => record.Id);
  };
  return { store, context, diagnostics, post, notesPage, timeline, activityIds };
}

const note = (n, notetext, subject = `Note created by Author [contact:${author}]`) => ({
  annotationid: id(n),
  notetext,
  subject,
  objectid: lookup(caseId, 'incident'),
  objecttypecode: 'incident',
  createdon: '2026-01-01T00:00:00Z',
});
const addNote = (post, text) =>
  post(`/_services/entity-form-addnote/${website}`, {
    regardingEntityLogicalName: 'incident',
    regardingEntityId: caseId,
    text,
  });
const storedNotes = (store) => store.tableRows('annotation').map((row) => row.notetext);

// @test-kind compatibility: Learn configure-notes "Enable rich text editor" (https://learn.microsoft.com/power-pages/configure/configure-notes#enable-rich-text-editor): the site setting Timeline/RTEEnabled = True makes notes added and edited with the rich text editor; without it notes stay plain text.
test('Timeline/RTEEnabled switches note create and edit between plain text and sanitized rich text', async (t) => {
  const plain = await fixture(t);
  assert.equal((await addNote(plain.post, '  <b>bold</b> & more  ')).status, 201);
  assert.deepEqual(storedNotes(plain.store), ['*WEB*<b>bold</b> & more']);
  const [plainRecord] = (await plain.notesPage()).Records;
  assert.equal(plainRecord.UnformattedText, '<b>bold</b> & more');
  assert.equal(plainRecord.Text, '<p>&lt;b&gt;bold&lt;/b&gt; &amp; more</p>');

  const rich = await fixture(t, { settings: { 'Timeline/RTEEnabled': ' TRUE ' } });
  assert.equal((await addNote(rich.post, '<p><b>bold</b> &amp; <em>more</em></p>')).status, 201);
  assert.deepEqual(storedNotes(rich.store), ['*WEB*<p><b>bold</b> &amp; <em>more</em></p>']);
  const [richRecord] = (await rich.notesPage()).Records;
  assert.equal(richRecord.Text, '<p><b>bold</b> &amp; <em>more</em></p>');
  assert.equal(richRecord.UnformattedText, richRecord.Text);
  const update = await rich.post(`/_services/entity-form-updatenote/${website}`, {
    id: richRecord.Id,
    text: '<ul><li>first</li></ul>',
  });
  assert.equal(update.status, 200);
  assert.deepEqual(storedNotes(rich.store), ['*WEB*<ul><li>first</li></ul>']);

  const off = await fixture(t, { settings: { 'Timeline/RTEEnabled': 'false' } });
  assert.equal((await addNote(off.post, '<i>kept</i>')).status, 201);
  assert.deepEqual(storedNotes(off.store), ['*WEB*<i>kept</i>']);
});

// @test-kind security: with rich text notes enabled, markup from any author is sanitized before it is stored and on every read, so no script, event handler, javascript: URL or frame reaches the page.
test('rich text notes strip script, handlers, javascript: links and frames on write and on read', async (t) => {
  const { post, store, notesPage } = await fixture(t, {
    settings: { 'Timeline/RTEEnabled': 'true' },
    // Stored by another author outside the portal (for example the model-driven app), never sanitized on write.
    notes: [note(10, `*WEB*${XSS}`)],
  });
  const [foreign] = (await notesPage()).Records;
  for (const field of [foreign.Text, foreign.UnformattedText]) {
    assert.doesNotMatch(field, /<script|onerror|onclick|javascript:|<iframe|style=/i);
    assert.match(field, /<p>Hello <b>team<\/b><\/p>/);
    assert.match(field, /<img src="x" \/>/);
  }
  assert.equal(foreign.IsPostedByCurrentUser, false);
  assert.equal((await addNote(post, XSS)).status, 201);
  const written = storedNotes(store).at(-1);
  assert.equal(written, `*WEB*${sanitizeNoteHtml(XSS)}`);
  assert.doesNotMatch(written, /<script|onerror|onclick|javascript:|<iframe|style=/i);
  // Markup without visible text is an empty note.
  const empty = await addNote(post, '<p><br></p><script>window.__xss=5</script>');
  assert.equal(empty.status, 417);
  assert.equal(store.tableRows('annotation').length, 2);
});

// @test-kind compatibility+unproven: Learn view-all-activities-in-portal-timeline (https://learn.microsoft.com/power-pages/configure/view-all-activities-in-portal-timeline) documents CustomerSupport/DisplayAllUserActivitiesOnTimeline = true showing the activity types of the Portal Timeline View; that a case timeline otherwise lists only portal comments is modelled on the open-sourced portal code (ViewDataAdapter.ApplyTimelineFilterToFetch), not a capture.
test('DisplayAllUserActivitiesOnTimeline shows the Portal Timeline View activities; otherwise only portal comments', async (t) => {
  const activities = {
    phonecall: [activity(1, 'phonecall')],
    email: [activity(2, 'email')],
    appointment: [activity(3, 'appointment')],
    adx_portalcomment: [activity(4, 'adx_portalcomment')],
  };
  // The view admits appointments, emails, phone calls and portal comments (by type code and by name).
  const views = [typeView(4201, 4202, 4210, 'adx_portalcomment')];
  const off = await fixture(t, { views, activities });
  assert.deepEqual(await off.activityIds(), [id(4)]);
  assert.ok(off.diagnostics.some((entry) => entry.code === 'PORTAL_TIMELINE_PORTAL_COMMENTS_ONLY'));
  const on = await fixture(t, {
    views,
    activities,
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'True' },
  });
  assert.deepEqual(await on.activityIds(), [id(4), id(3), id(2), id(1)]);
  // A view admitting only phone calls keeps the other types off the timeline.
  const phone = await fixture(t, {
    views: [typeView(4210)],
    activities,
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
  });
  assert.deepEqual(await phone.activityIds(), [id(1)]);
});

// @test-kind security: timeline activities are read through the visitor's table permissions on each activity table and only for the regarding record; a record the visitor cannot read is refused with no activity.
test('timeline activities respect each activity table permission and never include another record', async (t) => {
  const permissions = [
    { entity: 'incident', scope: 'global', roles: ['Reader'], operations: ['read'] },
    { entity: 'phonecall', scope: 'global', roles: ['Reader'], operations: ['read'] },
    { entity: 'appointment', scope: 'global', roles: ['Writer'], operations: ['read'] },
  ];
  const { activityIds, timeline, store } = await fixture(t, {
    permissions,
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
    activities: {
      phonecall: [
        activity(1, 'phonecall'),
        activity(5, 'phonecall', { regardingobjectid: lookup(otherCase, 'incident') }),
      ],
      email: [activity(2, 'email', { description: 'secret mail' })],
      appointment: [activity(3, 'appointment')],
    },
  });
  assert.deepEqual(await activityIds(), [id(1)]);
  const body = await (await timeline({})).json();
  assert.doesNotMatch(JSON.stringify(body), /secret mail|email 2|appointment 3|phonecall 5/);
  // Without read on the regarding record the service refuses the request.
  store.state.permissions = permissions.filter((permission) => permission.entity !== 'incident');
  const denied = await timeline({});
  assert.ok([403, 404].includes(denied.status), `unexpected ${denied.status}`);
  assert.doesNotMatch(await denied.text(), /phonecall 1/);
  // The service needs the page's anti-forgery token.
  const forged = await fetch(denied.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regarding: { LogicalName: 'incident', Id: caseId } }),
  });
  assert.equal(forged.status, 403);
});

// @test-kind unproven: timeline paging is modelled on the open-sourced EntityActivityController/ActivityDataAdapter (10 per page by default, at most 25, view order newest first); no native capture of the activity service.
test('timeline pages activities in view order with the documented page size bounds', async (t) => {
  const phonecalls = Array.from({ length: 30 }, (_, index) =>
    activity(index + 1, 'phonecall', { createdon: `2026-03-01T00:${String(index).padStart(2, '0')}:00Z` }),
  );
  const { timeline } = await fixture(t, {
    views: [typeView(4210)],
    activities: { phonecall: phonecalls },
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
  });
  const page = async (body) => (await timeline(body)).json();
  const second = await page({ page: 2, pageSize: 4 });
  assert.deepEqual(
    second.Records.map((record) => record.Id),
    [id(26), id(25), id(24), id(23)],
  );
  assert.deepEqual([second.ItemCount, second.PageCount, second.PageNumber, second.MoreRecords], [30, 8, 2, true]);
  const capped = await page({ pageSize: 500 });
  assert.equal(capped.PageSize, 25);
  assert.equal(capped.Records.length, 25);
  const defaulted = await page({});
  assert.equal(defaulted.PageSize, 10);
  const last = await page({ page: 3 });
  assert.deepEqual([last.Records.length, last.MoreRecords], [10, false]);
});

// @test-kind compatibility: Learn view-all-activities-in-portal-timeline (https://learn.microsoft.com/power-pages/configure/view-all-activities-in-portal-timeline): the website timeline doesn't show inline images, for example images embedded within emails.
test('timeline activity descriptions are sanitized and shown without inline images', async (t) => {
  const { timeline } = await fixture(t, {
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
    views: [typeView(4202, 4210)],
    activities: {
      email: [
        activity(1, 'email', {
          description: '<p>Hi <img src="https://example.invalid/logo.png"></p><script>window.__xss=1</script>',
        }),
      ],
      phonecall: [activity(2, 'phonecall', { description: 'line one\nline 2 & more' })],
    },
  });
  const { Records } = await (await timeline({})).json();
  assert.deepEqual(
    Records.map((record) => [record.EntityName, record.Description]),
    [
      ['phonecall', 'line one<br />line 2 &amp; more'],
      ['email', '<p>Hi </p>'],
    ],
  );
});

// @test-kind contract: Mirage's timeline diagnostics: an absent Portal Timeline View admits every activity table and says so once; view conditions it cannot apply are reported.
test('timeline diagnostics name an absent view and view conditions the local timeline does not apply', async (t) => {
  const absent = await fixture(t, {
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
    activities: { phonecall: [activity(1, 'phonecall')], appointment: [activity(2, 'appointment')] },
  });
  assert.deepEqual(await absent.activityIds(), [id(2), id(1)]);
  await absent.activityIds();
  assert.equal(absent.diagnostics.filter((entry) => entry.code === 'PORTAL_TIMELINE_VIEW_ABSENT').length, 1);
  const partial = await fixture(t, {
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
    views: [
      timelineView(
        '<fetch><entity name="activitypointer"><filter><condition attribute="statecode" operator="eq" value="1"/></filter></entity></fetch>',
      ),
    ],
    activities: { phonecall: [activity(1, 'phonecall')] },
  });
  await partial.activityIds();
  const [entry] = partial.diagnostics.filter((item) => item.code === 'PORTAL_TIMELINE_VIEW_FILTER_PARTIAL');
  assert.equal(entry.severity, 'warning');
  assert.match(entry.message, /statecode/);
});

const FORM = 'f2000000-0000-4000-8000-000000000001';
async function renderNotesForm({ entity = 'incident', recordId = caseId, cell, settings = {}, bootstrap5 = true }) {
  const diagnostics = [];
  const portal = {
    forms: [{ id: FORM, name: 'Record', mode: 100000001, metadata: { adx_entityformid: FORM } }],
    records: [
      {
        kind: 'basicformmetadata',
        adx_entityform: FORM,
        adx_type: 100000005,
        adx_notes_settings: JSON.stringify({ CreateEnabled: true, EditEnabled: true, DeleteEnabled: true }),
      },
    ],
    website: { id: 'site' },
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    pages: [],
    settings: { ...(bootstrap5 ? { 'Site/BootstrapV5Enabled': 'true' } : {}), ...settings },
  };
  const fields = [{ name: 'name', label: 'Name', dataverseType: 'nvarchar', maxLength: 100 }];
  const schemas = {
    [FORM]: {
      entity,
      title: 'Record',
      fields,
      layout: [
        {
          name: 'main',
          label: 'Main',
          columns: [{ width: '100%', sections: [{ name: 's', label: 'S', rows: [[{ name: 'name' }, cell]] }] }],
        },
      ],
    },
  };
  const store = {
    resolveMapping: () => ({ entitySet: `${entity}s`, idColumn: `${entity}id`, nameColumn: 'name' }),
    get: async () => ({ [`${entity}id`]: recordId, name: 'Record' }),
    query: async () => ({ value: [] }),
    allowed: () => true,
  };
  const html = await renderComponent(
    'entityform',
    'Record',
    { user: { id: reader, contactId: reader }, request: { params: { id: recordId } } },
    { portal, store, schemas, richTextCompatibility: true, diagnostic: (entry) => diagnostics.push(entry) },
  );
  return { html: html.slice(html.indexOf('<div id="notescontrol">')), diagnostics };
}

// @test-kind compatibility: Learn configure-notes "Enable rich text editor" (https://learn.microsoft.com/power-pages/configure/configure-notes#enable-rich-text-editor): with Timeline/RTEEnabled the add and edit note dialogs use the rich text editor; the editor markup itself is the local rich text runtime.
test('Timeline/RTEEnabled renders the note dialogs with the rich text editor in both Bootstrap versions', async () => {
  for (const bootstrap5 of [true, false]) {
    const plain = await renderNotesForm({ cell: { type: 'notes', id: 'notescontrol' }, bootstrap5 });
    assert.doesNotMatch(plain.html, /data-sim-richtext-editor|data-rte-enabled="True"/);
    const { html } = await renderNotesForm({
      cell: { type: 'notes', id: 'notescontrol' },
      settings: { 'Timeline/RTEEnabled': 'true' },
      bootstrap5,
    });
    assert.match(html, /data-rte-enabled="True"/);
    for (const kind of ['add', 'edit'])
      assert.match(
        html,
        new RegExp(
          `data-sim-richtext-editor data-sim-note-editor data-field="notescontrol_${kind}note_text"><textarea id="notescontrol_${kind}note_text_editor" name="text"`,
        ),
      );
    // The form's rich text runtime mounts both dialog editors, in compatibility mode here.
    assert.match(
      html,
      /<script>\(async function mountRichTextEditors\(settings, purifier\)[\s\S]*\)\(\{"notescontrol_addnote_text":\{"configuration":\{\},"configUrl":null,"compatibility":true\},"notescontrol_editnote_text":\{"configuration":\{\},"configUrl":null,"compatibility":true\}\},/,
    );
  }
});

// @test-kind compatibility+unproven: Learn (https://learn.microsoft.com/power-pages/configure/configure-notes and view-all-activities-in-portal-timeline): showing both notes and activities on the same form for a custom table is not supported with configuration; that a notescontrol whose DefaultTabId is ActivitiesTab is the activity timeline served by EntityActivity/GetActivities follows the open-sourced portal code (FormXmlCellMetadata, NotesControlTemplate).
test('a timeline control lists activities and reports the custom table notes limitation', async () => {
  const cell = { type: 'notes', id: 'notescontrol', defaultTab: 'ActivitiesTab' };
  const custom = await renderNotesForm({ entity: 'pqx_gadget', recordId: gadget, cell });
  assert.match(custom.html, /data-is-timeline="True"/);
  assert.match(custom.html, /data-url-get="\/_portal\/site\/EntityActivity\/GetActivities"/);
  assert.match(custom.html, /data-add-enabled="False"[^>]*data-delete-enabled="False" data-edit-enabled="False"/);
  assert.doesNotMatch(custom.html, /notes-template|modal-addnote|modal-editnote/);
  assert.deepEqual(
    custom.diagnostics
      .filter((entry) => /^PORTAL_TIMELINE/.test(entry.code))
      .map((entry) => [entry.code, entry.severity]),
    [['PORTAL_TIMELINE_CUSTOM_TABLE_NOTES', 'warning']],
  );
  assert.match(
    custom.diagnostics.find((entry) => entry.code === 'PORTAL_TIMELINE_CUSTOM_TABLE_NOTES').message,
    /not supported/,
  );
  const standard = await renderNotesForm({ cell, bootstrap5: false });
  assert.match(
    standard.html,
    /data-url-get="\/_portal\/site\/EntityActivity\/GetActivities"[^>]*data-is-timeline="True"/,
  );
  assert.deepEqual(
    standard.diagnostics.filter((entry) => /^PORTAL_TIMELINE/.test(entry.code)).map((entry) => entry.code),
    ['PORTAL_TIMELINE_ACTIVITIES'],
  );
  // Without the ActivitiesTab default the control stays the notes list.
  const notes = await renderNotesForm({ cell: { type: 'notes', id: 'notescontrol' } });
  assert.match(notes.html, /data-is-timeline="False"[^>]*data-url-get="\/_services\/entity-notes\/site"/);
});

// @test-kind contract: the timeline finds activity tables from the simulator state's mappings, which are keyed by table and need not name it (a full simulator once answered "FetchXML entity is required").
test('timeline activity tables are found from mappings keyed by table without a logical name', async (t) => {
  const { activityIds } = await fixture(t, {
    namedMappings: false,
    settings: { 'CustomerSupport/DisplayAllUserActivitiesOnTimeline': 'true' },
    views: [typeView(4202, 4210)],
    activities: { phonecall: [activity(1, 'phonecall')], email: [activity(2, 'email')] },
  });
  assert.deepEqual(await activityIds(), [id(2), id(1)]);
});
