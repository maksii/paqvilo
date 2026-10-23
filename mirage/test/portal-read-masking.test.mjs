// Every portal read path (store.get / store.query / store.fetchXml with portalRequest: forms, lists, the portal Web API with
// $expand, Liquid fetchxml) masks secured columns through one rule (portal-authorization.mjs maskRow): column security of the
// reading principal, which is the site's application user in the standard model and the visitor's mapped Dataverse user in the
// enhanced model (Learn power-pages/security/unify-pages-security-with-dataverse), with masking rules applied because a portal
// read never sends UnMaskedData (Learn power-platform/admin/create-manage-masking-rules). Invented site, tables and data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const SITE = '78787878-7878-4787-8787-787878787878', MEMBER = '78787878-7878-4787-8787-787878787801';
const ITEM = '78787878-7878-4787-8787-787878787881', PARENT = '78787878-7878-4787-8787-787878787882';
const RULE = '78787878-7878-4787-8787-787878787883', LINK = '78787878-7878-4787-8787-787878787884';
const text = { dataverseType: 'nvarchar' }, secured = { ...text, columnMetadata: { isSecured: true } };
const FETCH = '<fetch><entity name="x_item"><attribute name="x_name"/><attribute name="x_secret"/><attribute name="x_code"/>'
  + '<link-entity name="x_parent" from="x_parentid" to="x_parentid" alias="p"><attribute name="x_name"/></link-entity></entity></fetch>';
// The exact query the notes control and the attachment count run (native-services.mjs annotationRows, platform.mjs).
const NOTES = `<fetch><entity name="annotation"><all-attributes/><filter type="and"><condition attribute="objectid" operator="eq" value="${ITEM}"/></filter><order attribute="createdon"/></entity></fetch>`;
const CONDITION = '<fetch><entity name="x_item"><attribute name="x_name"/><filter><condition attribute="x_secret" operator="eq" value="XS-1234"/></filter></entity></fetch>';
const setting = (id, name, value) => `- adx_sitesettingid: 78787878-7878-4787-8787-7878787878${id}\n  adx_name: ${name}\n  adx_value: ${value}`;
const files = (state) => ({
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented\nadx_enhancedauthorization: ${state}`,
  'webrole.yml': `- adx_webroleid: ${MEMBER}\n  adx_name: Member`,
  'sitesetting.yml': [setting(10, 'Webapi/x_item/enabled', true), setting(11, 'Webapi/x_item/fields', 'x_name,x_secret,x_code,x_parentid,_x_parentid_value'),
    setting(20, 'Webapi/x_parent/enabled', true), setting(21, 'Webapi/x_parent/fields', 'x_name,x_parent_items'),
    setting(30, 'Webapi/error/innererror', true)].join('\n'),
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': `{% fetchxml rows %}${FETCH}{% endfetchxml %}{% for row in rows.results.entities %}<li>{{ row.x_secret }}|{{ row.x_code }}</li>{% endfor %}`,
});
const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    x_parent: { entitySet: 'x_parents', idColumn: 'x_parentid', nameColumn: 'x_name', fields: { x_name: text },
      relationships: { x_parent_items: { entity: 'x_item', from: 'x_parentid', to: 'x_parentid', many: true } } },
    x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name',
      relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } },
      fields: { x_name: text, x_secret: secured, x_code: secured, x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] } } },
    annotation: { entitySet: 'annotations', idColumn: 'annotationid', nameColumn: 'subject', fields: { subject: text, notetext: secured, objectid: { dataverseType: 'lookup', targets: ['x_item'] } } },
  },
  tables: {
    contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
    x_parent: [{ x_parentid: PARENT, x_name: 'North parent' }],
    x_item: [{ x_itemid: ITEM, x_name: 'Item', x_parentid: PARENT, x_secret: 'XS-1234', x_code: 'C-77', statecode: 0, statuscode: 1 }],
    annotation: [{ annotationid: '78787878-7878-4787-8787-787878787891', subject: 'Note', notetext: 'NT-5678', objectid: { id: ITEM, logical_name: 'x_item' }, createdon: '2026-01-01T00:00:00Z' }],
    maskingrule: [{ maskingruleid: RULE, name: 'x_LastFour', regularexpression: '.(?=.{4})', maskedcharacter: '*' }],
    attributemaskingrule: [{ attributemaskingruleid: LINK, entityname: 'x_item', attributelogicalname: 'x_secret', maskingruleid: { id: RULE, logical_name: 'maskingrule' } },
      { attributemaskingruleid: '78787878-7878-4787-8787-787878787885', entityname: 'annotation', attributelogicalname: 'notetext', maskingruleid: { id: RULE, logical_name: 'maskingrule' } }],
  },
  permissions: [
    { id: 'items', name: 'Items', entity: 'x_item', roles: ['Member'], operations: ['read'], scope: 'global' },
    { id: 'parents', name: 'Parents', entity: 'x_parent', roles: ['Member'], operations: ['read'], scope: 'global' },
    { id: 'notes', name: 'Notes', entity: 'annotation', roles: ['Member'], operations: ['read'], scope: 'global' },
  ],
  simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [], contactRoles: [{ contactId: 'alex', roleId: MEMBER }] },
});

async function site(t, state) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-read-masking-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files(state))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), port: 0, watch: false, initial: initial() });
  ownedFixture(t).add(() => sim.close());
  const headers = signInHeaders(sim, 'alex');
  const page = async () => (await (await fetch(sim.url + '/', { headers })).text()).match(/<li>.*?<\/li>/g);
  const api = async (route) => { const response = await fetch(sim.url + route, { headers }); assert.equal(response.status, 200, route); return response.json(); };
  // What each portal read path answers for [x_secret (masking rule), x_code (no rule)]; FetchXML omits null attributes.
  const reads = async () => {
    const identity = { id: 'alex', contactId: 'alex', roles: ['Member'] };
    const list = sim.store.fetchXml(FETCH, identity, { portalRequest: true }).entities[0];
    const query = sim.store.query('x_item', { $select: 'x_secret,x_code' }, identity, undefined, { portalRequest: true }).value[0];
    const one = await api(`/_api/x_items(${ITEM})?$select=x_secret,x_code`);
    const many = (await api('/_api/x_items?$select=x_secret,x_code')).value[0];
    const expanded = (await api(`/_api/x_parents(${PARENT})?$select=x_name&$expand=x_parent_items($select=x_secret,x_code)`)).x_parent_items[0];
    const fetched = (await api(`/_api/x_items?fetchXml=${encodeURIComponent(FETCH)}`)).value[0];
    const note = sim.store.fetchXml(NOTES, identity, { portalRequest: true }).entities[0];
    return {
      list: [list.x_secret ?? null, list.x_code ?? null], query: [query.x_secret, query.x_code], one: [one.x_secret, one.x_code], many: [many.x_secret, many.x_code],
      expanded: [expanded.x_secret, expanded.x_code], fetched: [fetched.x_secret ?? null, fetched.x_code ?? null], liquid: await page(), notes: note.notetext ?? null,
    };
  };
  // Each read with an operand over a secured column: "status code innercode" of the answer. The portal Web API wraps a Dataverse
  // error as 9004010D CDSError with the Dataverse code in innererror (Learn power-pages/configure/web-api-overview error codes);
  // 0x80041155 is the masked-operand refusal (Learn web-service-error-codes CannotFilterOnMaskedAttribute).
  const operands = async () => {
    const status = async (route) => { const response = await fetch(sim.url + route, { headers }); const body = await response.json(); return [response.status, body.error?.code, body.error?.innererror?.code].filter(Boolean).join(' '); };
    let liquid = '200';
    try { sim.store.fetchXml(CONDITION, { id: 'alex', contactId: 'alex', roles: ['Member'] }, { portalRequest: true }); } catch (error) { liquid = `${error.status} ${error.details?.innerCode}`; }
    return {
      filter: await status("/_api/x_items?$select=x_name&$filter=x_secret eq 'XS-1234'"),
      orderby: await status('/_api/x_items?$select=x_name&$orderby=x_secret'),
      fetchCondition: await status(`/_api/x_items?fetchXml=${encodeURIComponent(CONDITION)}`),
      expandFilter: await status(`/_api/x_parents(${PARENT})?$select=x_name&$expand=x_parent_items($select=x_name;$filter=x_secret eq 'XS-1234')`),
      liquid,
      clearColumn: await status("/_api/x_items?$select=x_name&$filter=x_code eq 'C-77'"),
    };
  };
  assert.equal((await fetch(sim.url + '/', { headers })).status, 200);
  return { sim, reads, operands };
}
const REFUSED = '400 9004010D 0x80041155';
const refused = { filter: REFUSED, orderby: REFUSED, fetchCondition: REFUSED, expandFilter: REFUSED, liquid: '400 0x80041155', clearColumn: '200' };
const every = (pair, liquid, notes) => ({ list: pair, query: pair, one: pair, many: pair, expanded: pair, fetched: pair, liquid: [liquid], notes });

test('standard model: every portal read path masks through the application user, which reads the clear unmasked column', async (t) => {
  const { sim, reads, operands } = await site(t, 0);
  assert.deepEqual(await reads(), every(['***1234', 'C-77'], '<li>***1234|C-77</li>', '***5678'));
  assert.deepEqual(await operands(), refused, 'a filter, order or condition on the masked column is refused; the unmasked secured column filters');
  assert.equal(sim.store.tableRows('x_item')[0].x_secret, 'XS-1234', 'the stored row is untouched');
  assert.equal(sim.store.query('x_item', { $select: 'x_secret' }, { admin: true }).value[0].x_secret, 'XS-1234', 'a non-portal read is not a portal read');
});

test('enhanced model: every portal read path masks through the mapped user; a column security profile reads masked and clear values', async (t) => {
  const { sim, reads, operands } = await site(t, 3);
  assert.deepEqual(await reads(), every([null, null], '<li>|</li>', null), 'no profile: secured columns read null');
  assert.deepEqual(Object.values(await operands()), Array(6).fill('200'), 'no profile: an unreadable column evaluates as null, never refused (the Dataverse API rule)');
  const user = sim.store.tableRows('systemuser').find((row) => row.fullname === 'Alex Local' && row.systemmanagedusertype === 1);
  await sim.store.transact(() => {
    const tables = sim.store.state.tables, profile = { id: '78787878-7878-4787-8787-787878787820', logical_name: 'fieldsecurityprofile' };
    tables.fieldsecurityprofile.push({ fieldsecurityprofileid: profile.id, name: 'Invented readers' });
    for (const [index, column] of ['x_secret', 'x_code'].entries())
      tables.fieldpermission.push({ fieldpermissionid: `78787878-7878-4787-8787-78787878783${index}`, fieldsecurityprofileid: profile, entityname: 'x_item', attributelogicalname: column, canread: 4, cancreate: 0, canupdate: 0, canreadunmasked: 3 });
    tables.systemuserprofiles.push({ systemuserprofileid: '78787878-7878-4787-8787-787878787822', systemuserid: { id: user.systemuserid, logical_name: 'systemuser' }, fieldsecurityprofileid: profile });
  });
  // CanReadUnmasked (All Records) does not unmask a read that does not ask UnMaskedData, which a portal read never does, so the
  // masked column stays refused as an operand; the profile's clear secured column filters.
  assert.deepEqual(await reads(), every(['***1234', 'C-77'], '<li>***1234|C-77</li>', null));
  assert.deepEqual(await operands(), refused);
});
