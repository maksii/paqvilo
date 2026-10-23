// The portal read path (store.get with portalRequest, which basic forms, advanced form steps and list row merges use)
// answers what a Dataverse read by the reading principal answers: secured columns through column security and masking
// rules (Learn create-manage-masking-rules; the standard model reads as the site's application user, Learn
// unify-pages-security-with-dataverse; the enhanced model as the visitor's mapped user), calculated and formula columns
// computed, and lookups as references named by the target's primary name. Invented site, tables and data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const SITE = '77777777-7777-4777-8777-777777777777', MEMBER = '77777777-7777-4777-8777-777777777701';
const ITEM = '77777777-7777-4777-8777-777777777781', PARENT = '77777777-7777-4777-8777-777777777782';
const RULE = '77777777-7777-4777-8777-777777777783', LINK = '77777777-7777-4777-8777-777777777784';
const text = { dataverseType: 'nvarchar' };
const files = (state) => ({
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented\nadx_enhancedauthorization: ${state}`,
  'webrole.yml': `- adx_webroleid: ${MEMBER}\n  adx_name: Member`,
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': 'home',
});
const initial = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    x_parent: { entitySet: 'x_parents', idColumn: 'x_parentid', nameColumn: 'x_name', fields: { x_name: text } },
    x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name',
      relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } },
      fields: {
        x_name: text, x_status: text, x_amount: { dataverseType: 'decimal' }, x_spent: { dataverseType: 'decimal' }, x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
        x_secret: { ...text, columnMetadata: { isSecured: true } },
        x_left: { dataverseType: 'decimal', columnMetadata: { sourceType: 1, formulaDefinition: '<Subtract><Field Name="x_amount"/><Field Name="x_spent"/></Subtract>' } },
        x_label: { ...text, columnMetadata: { sourceType: 3, formulaDefinition: 'x_name & " - " & x_status' } },
      } },
  },
  tables: {
    contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
    x_parent: [{ x_parentid: PARENT, x_name: 'North parent' }],
    // A stored bare lookup id and a stored stale calculated value.
    x_item: [{ x_itemid: ITEM, x_name: 'Item', x_status: 'Open', x_amount: 100, x_spent: 40, x_left: 999, x_parentid: PARENT, x_secret: 'XS-1234', statecode: 0, statuscode: 1 }],
    maskingrule: [{ maskingruleid: RULE, name: 'x_LastFour', regularexpression: '.(?=.{4})', maskedcharacter: '*' }],
    attributemaskingrule: [{ attributemaskingruleid: LINK, entityname: 'x_item', attributelogicalname: 'x_secret', maskingruleid: { id: RULE, logical_name: 'maskingrule' } }],
  },
  permissions: [{ id: 'items', name: 'Items', entity: 'x_item', roles: ['Member'], operations: ['read'], scope: 'global' }],
  simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [], contactRoles: [{ contactId: 'alex', roleId: MEMBER }] },
});

async function site(t, state) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-form-read-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files(state))) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const sim = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), port: 0, watch: false, initial: initial() });
  ownedFixture(t).add(() => sim.close());
  // One portal request prepares the reading principal (application user or mapped user).
  assert.equal((await fetch(sim.url + '/', { headers: signInHeaders(sim, 'alex') })).status, 200);
  return sim;
}
const identity = { id: 'alex', contactId: 'alex', roles: ['Member'] };
const fields = [
  { name: 'x_secret', label: 'Secret', dataverseType: 'nvarchar', isSecured: true },
  { name: 'x_left', label: 'Left', dataverseType: 'decimal', validForCreate: false, validForUpdate: false },
  { name: 'x_label', label: 'Label', dataverseType: 'nvarchar', validForCreate: false, validForUpdate: false },
  { name: 'x_parentid', label: 'Parent', dataverseType: 'lookup', type: 'lookup', targets: ['x_parent'] },
];
async function readForm(sim) {
  const portal = { forms: [{ id: 'form', name: 'Item', mode: 100000002 }], records: [], website: { id: SITE }, pages: [], settings: {} };
  const schemas = { form: { entity: 'x_item', title: 'Item', fields, layout: [{ name: 't', columns: [{ sections: [{ name: 's', rows: fields.map(({ name }) => [{ name }]) }] }] }] } };
  const readProvider = { get: async (entity, id, who) => sim.store.get(entity, id, who, { portalRequest: true }), query: async () => ({ value: [] }) };
  return renderComponent('entityform', 'form', { user: identity, request: { params: { id: ITEM } } }, { portal, store: sim.store, readProvider, schemas });
}
const valueOf = (html, id) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0].match(/value="([^"]*)"/)?.[1] ?? null;

test('standard model: the read form masks a secured column as the application user and renders computed columns and lookup names', async (t) => {
  const sim = await site(t, 0);
  const row = sim.store.get('x_item', ITEM, identity, { portalRequest: true });
  assert.equal(row.x_secret, '***1234', 'the masking rule applies to the application user (never the clear value)');
  assert.equal(row.x_left, 60, 'calculated column computed, not the stale stored 999');
  assert.equal(row.x_label, 'Item - Open', 'formula column computed');
  assert.deepEqual(row.x_parentid, { id: PARENT, logical_name: 'x_parent', name: 'North parent' });
  assert.equal(sim.store.tableRows('x_item')[0].x_secret, 'XS-1234', 'the stored row is untouched');
  const html = await readForm(sim);
  assert.doesNotMatch(html, /XS-1234/);
  assert.equal(valueOf(html, 'x_secret'), '***1234');
  assert.equal(valueOf(html, 'x_left'), '60');
  assert.equal(valueOf(html, 'x_label'), 'Item - Open');
  assert.match(html, /North parent/);
  assert.ok(!sim.store.tableRows('systemuser').some((user) => /^# Portals-/.test(user.fullname ?? '')), 'a read never creates the application user');
});

test('enhanced model: the read form masks through the mapped user, which no column security profile grants read', async (t) => {
  const sim = await site(t, 3);
  const row = sim.store.get('x_item', ITEM, identity, { portalRequest: true });
  assert.equal(row.x_secret, null);
  assert.equal(row.x_left, 60);
  assert.doesNotMatch(await readForm(sim), /XS-1234|1234/);
});

test('a secured value the form read masked and posts back unchanged is not written over the stored value', async () => {
  const store = await new DataStore({ state: {
    mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: text, x_secret: { ...text, isSecured: true } } } },
    tables: { x_item: [{ x_itemid: 'owned', x_name: 'Item', x_secret: 'XS-1234' }] },
    permissions: [{ entity: 'x_item', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] }],
    settings: { permissionMode: 'enforce' },
  } }).init();
  const who = { roles: ['Editor'] };
  const options = { store, identity: who, requestUrl: 'http://localhost/?id=owned',
    readProvider: { get: async (entity, id, caller) => ({ ...store.get(entity, id, caller), x_secret: '***1234' }), query: async () => ({ value: [] }) },
    portal: { forms: [{ id: 'entry', name: 'Entry', mode: 100000001, metadata: {} }], records: [] },
    schemas: { entry: { entity: 'x_item', fields: [{ name: 'x_name', type: 'text' }, { name: 'x_secret', type: 'text' }], layout: [{ columns: [{ sections: [{ rows: [[{ name: 'x_name' }], [{ name: 'x_secret' }]] }] }] }] } } };
  await submitPortalForm('entityform', 'entry', { recordId: 'owned', values: { x_name: 'Renamed', x_secret: '***1234' } }, options);
  assert.deepEqual([store.state.tables.x_item[0].x_name, store.state.tables.x_item[0].x_secret], ['Renamed', 'XS-1234']);
  await submitPortalForm('entityform', 'entry', { recordId: 'owned', values: { x_secret: 'XS-9999' } }, options);
  assert.equal(store.state.tables.x_item[0].x_secret, 'XS-9999', 'a changed value is still written');
});
