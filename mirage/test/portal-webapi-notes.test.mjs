// @test-kind observation: hosted session F2 FORM-02f (paqvilo2 runs a and b at enhancedauthorization 3, s0k and s0l at 0; runs/<run>/notes.json webapi:*, summary-F2 "FORM-02f notes through /_api"): the portal Web API applies no notes filter, so $expand and a single read return the plain and *PRIVATE*-subject notes, and a filter on _objectid_value answers 403 90040101 when Webapi/annotation/fields lists objectid but not _objectid_value (the hosted fields value); on an invented schema and a loopback fixture
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatorFixture } from './fixtures/source-site.mjs';
import { signInHeaders } from '../testing.mjs';

const id = (n) => `43000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1),
  MEMBER = id(2),
  CONTACT = id(3),
  CASE = id(10);
const text = { dataverseType: 'nvarchar' };
const setting = (n, name, value) => `- adx_sitesettingid: ${id(100 + n)}\n  adx_name: ${name}\n  adx_value: ${value}`;
const note = (n, subject, notetext) => ({
  annotationid: id(n),
  subject,
  notetext,
  objectid: { id: CASE, logical_name: 'tst_case' },
  objecttypecode: 'tst_case',
  createdon: `2026-01-01T00:00:0${n - 20}Z`,
});
// The hosted Webapi/annotation/fields value (objectid listed, _objectid_value not).
const FIELDS =
  'annotationid,subject,notetext,filename,mimetype,isdocument,documentbody,filesize,objectid,objecttypecode,createdon,stepid';
// The four seeded notes of the hosted runs: a *WEB* note, a note without the prefix, a *WEB* note with a *PRIVATE*
// subject and a portal-created note.
const NOTES = [
  note(21, 'Invented web note', '*WEB* web note'),
  note(22, 'Invented plain note', 'note without the prefix'),
  note(23, 'Invented note *PRIVATE*', '*WEB* private-subject note'),
  note(24, `Note created on 1/1/2026 12:00:04 AM UTC by Ada Persona [contact:${CONTACT}]`, '*WEB*portal note'),
];

async function site(t, annotationFields) {
  const sim = await simulatorFixture(t, {
    prefix: 'portal-webapi-notes-',
    files: {
      'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented`,
      'webrole.yml': `- adx_webroleid: ${MEMBER}\n  adx_name: Member`,
      'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
      'sitesetting.yml': [
        setting(1, 'Webapi/tst_case/enabled', true),
        setting(2, 'Webapi/tst_case/fields', 'tst_name,tst_case_Annotations'),
        setting(3, 'Webapi/annotation/enabled', true),
        setting(4, 'Webapi/annotation/fields', annotationFields),
        setting(5, 'Webapi/error/innererror', true),
      ].join('\n'),
    },
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        tst_case: {
          entitySet: 'tst_cases',
          idColumn: 'tst_caseid',
          nameColumn: 'tst_name',
          fields: { tst_name: text },
          relationships: {
            tst_case_Annotations: {
              entity: 'annotation',
              from: 'tst_caseid',
              to: 'objectid',
              many: true,
              polymorphic: true,
            },
          },
        },
        annotation: {
          entitySet: 'annotations',
          idColumn: 'annotationid',
          nameColumn: 'subject',
          fields: {
            subject: text,
            notetext: { dataverseType: 'memo' },
            objectid: { dataverseType: 'lookup', targets: ['tst_case'] },
          },
        },
      },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Ada Persona', statecode: 0 }],
        tst_case: [{ tst_caseid: CASE, tst_name: 'Invented case', statecode: 0, statuscode: 1 }],
        annotation: NOTES,
      },
      permissions: [
        { id: 'cases', entity: 'tst_case', roles: ['Member'], operations: ['read'], scope: 'global' },
        { id: 'notes', entity: 'annotation', roles: ['Member'], operations: ['read'], scope: 'global' },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        contactRoles: [{ contactId: CONTACT, roleId: MEMBER }],
      },
    },
  });
  const headers = signInHeaders(sim, CONTACT);
  const api = async (route) => {
    const response = await fetch(sim.url + route, { headers });
    return { status: response.status, body: await response.json() };
  };
  return api;
}

test('the portal Web API returns every note of a record, plain and *PRIVATE* subjects included', async (t) => {
  const api = await site(t, FIELDS);
  const expanded = await api(
    `/_api/tst_cases(${CASE})?$select=tst_name&$expand=tst_case_Annotations($select=subject,notetext)`,
  );
  assert.equal(expanded.status, 200);
  assert.deepEqual(
    expanded.body.tst_case_Annotations.map(({ annotationid, subject, notetext }) => [annotationid, subject, notetext]),
    NOTES.map(({ annotationid, subject, notetext }) => [annotationid, subject, notetext]),
  );
  for (const n of [22, 23]) {
    const single = await api(`/_api/annotations(${id(n)})?$select=subject,notetext`);
    assert.equal(single.status, 200);
    const seeded = NOTES.find((row) => row.annotationid === id(n));
    assert.deepEqual([single.body.subject, single.body.notetext], [seeded.subject, seeded.notetext]);
  }
});

test('a filter on _objectid_value is refused when Webapi/annotation/fields lists objectid but not _objectid_value', async (t) => {
  const route = `/_api/annotations?$select=annotationid,subject,notetext&$filter=_objectid_value eq ${CASE}&$orderby=createdon asc`;
  const refused = await (await site(t, FIELDS))(route);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, '90040101');
  assert.equal(refused.body.error.message, 'Attribute _objectid_value in table annotation is not enabled for Web Api.');
});
