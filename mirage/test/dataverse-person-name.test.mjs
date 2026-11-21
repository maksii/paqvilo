import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION as SHAREPOINT } from '../lib/sharepoint-documents.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createStorageRouter, storageSettings } from '../lib/storage-provider.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const EVIDENCE = JSON.parse(
  await fs.readFile(new URL('./fixtures/dataverse-native-contact-fullname.json', import.meta.url), 'utf8'),
);
const NAMES = '$select=fullname,yomifullname';
const site = {
  sharepointsiteid: '66666666-6666-4666-8666-666666666666',
  name: 'Default Site',
  absoluteurl: 'https://site.example.test/sites/invented',
  isdefault: true,
  isgridpresent: true,
  statecode: 0,
  statuscode: 1,
};

async function setup(t, mappings = {}) {
  const owner = ownedFixture(t);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'person-name-'));
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const local = createLocalDiskStorage({ root });
  const storage = createStorageRouter({ config: storageSettings({}), providers: { local } });
  const fixture = await contractModuleFixture(
    { after: (callback) => owner.add(callback) },
    { mappings, tables: { sharepointsite: [site] }, extension: SHAREPOINT, options: { storage } },
  );
  owner.add(() => local.close());
  const names = async (set, id) => fixture.json(await fixture.request('GET', `/${set}(${id})?${NAMES}`), 200);
  const create = async (set, body) => fixture.json(await fixture.request('POST', `/${set}?${NAMES}`, body), 201);
  const update = async (set, id, body) =>
    fixture.json(await fixture.request('PATCH', `/${set}(${id})?${NAMES}`, body), 200);
  return { ...fixture, names, create, update };
}

const step = (label) => EVIDENCE.steps.find((entry) => entry.label === label);

// @test-kind observation: one native Web API capture on a developer environment (2026-11-18, fullnameconventioncode 1) in fixtures/dataverse-native-contact-fullname.json; the requests are replayed from the fixture by hand, so it is not a replay case.
test('a contact create and later part updates compose fullname and yomifullname as the platform does', async (t) => {
  const { store, create, update, names } = await setup(t);
  assert.equal(step('organization convention').body.value[0].fullnameconventioncode, 1);
  const created = await create('contacts', step('create contact lastname only').request);
  const id = created.contactid;
  for (const label of [
    'create contact lastname only',
    'patch firstname',
    'patch middlename',
    'patch fullname directly',
    'patch yomilastname only',
  ]) {
    const native = step(label);
    if (native.method === 'PATCH') await update('contacts', id, native.request);
    const local = await names('contacts', id);
    assert.deepEqual(
      { fullname: local.fullname, yomifullname: local.yomifullname },
      { fullname: native.body.fullname, yomifullname: native.body.yomifullname },
      label,
    );
  }
  const second = step('create contact first+last+supplied fullname+yomi');
  const other = await create('contacts', second.request);
  assert.deepEqual(
    { fullname: other.fullname, yomifullname: other.yomifullname },
    { fullname: second.body.fullname, yomifullname: second.body.yomifullname },
  );
  // The stored row holds the composed value, so SDK, FetchXML and Liquid readers see it too.
  assert.equal(store.state.tables.contact.find((row) => row.contactid === other.contactid).fullname, 'Ana Pqfn Omega');
});

// @test-kind observation: the same capture (fixtures/dataverse-native-contact-fullname.json) composes a lastname-only contact as its lastname, which the documented SharePoint folder name <record name>_<record id> then uses.
test('a contact created with only a lastname names its SharePoint folder after that name', async (t) => {
  const { api, create } = await setup(t);
  const contact = await create('contacts', { lastname: 'Case: one*' });
  const location = await api.sharepoint.ensureLocation(
    { logicalName: 'contact', id: contact.contactid },
    {},
    { admin: true },
  );
  assert.equal(location.relativeurl, `Case one_${contact.contactid.replaceAll('-', '').toUpperCase()}`);
});

// @test-kind observation: the organization row reads fullnameconventioncode 1 as the captured environment did (fixtures/dataverse-native-contact-fullname.json, 2026-11-18); a state saved without the column composes with that default.
test('a fresh organization reads convention 1 and a state without the column composes with it', async (t) => {
  const { store, request, json, create } = await setup(t);
  const read = await json(await request('GET', '/organizations?$select=fullnameconventioncode'), 200);
  assert.equal(read.value[0].fullnameconventioncode, 1);
  delete store.state.tables.organization[0].fullnameconventioncode;
  const contact = await create('contacts', { firstname: 'Ivo', middlename: 'Quill', lastname: 'Zeta' });
  assert.equal(contact.fullname, 'Ivo Zeta');
});

// @test-kind unproven: a contact with no name part at all was not captured; Mirage keeps the fullname it is given or holds.
test('a contact without any name part keeps the fullname it is given', async (t) => {
  const { create, update } = await setup(t);
  const contact = await create('contacts', { fullname: 'Only Full' });
  assert.deepEqual([contact.fullname, contact.yomifullname], ['Only Full', 'Only Full']);
  const edited = await update('contacts', contact.contactid, { fullname: 'Edited Full' });
  assert.equal(edited.fullname, 'Edited Full');
});

// @test-kind unproven: the convention codes other than 1 follow the option labels of organization.fullnameconventioncode on Microsoft Learn (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/organization); only code 1 was captured.
test('each full name convention orders the parts as its option label names', async (t) => {
  const { store, create } = await setup(t);
  const organization = store.state.tables.organization[0];
  const composed = [];
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7]) {
    organization.fullnameconventioncode = code;
    composed.push((await create('contacts', { firstname: 'Ivo', middlename: 'Quill', lastname: 'Zeta' })).fullname);
  }
  assert.deepEqual(composed, [
    'Zeta, Ivo',
    'Ivo Zeta',
    'Zeta, Ivo Q.',
    'Ivo Q. Zeta',
    'Zeta, Ivo Quill',
    'Ivo Quill Zeta',
    'Zeta Ivo',
    'ZetaIvo',
  ]);
  organization.fullnameconventioncode = 0;
  assert.equal((await create('contacts', { lastname: 'Zeta' })).fullname, 'Zeta');
});

// @test-kind unproven: the organization row's fullnameconventioncode drives the composition, and lead follows the documented contact rule; neither a non-default convention nor a lead was captured (the environment has no lead table).
test('the organization convention applies to contact and lead writes', async (t) => {
  const text = { dataverseType: 'nvarchar' };
  const { store, request, create } = await setup(t, {
    lead: {
      logicalName: 'lead',
      entitySet: 'leads',
      idColumn: 'leadid',
      nameColumn: 'fullname',
      fields: { firstname: text, middlename: text, lastname: text, fullname: text, yomifullname: text },
    },
  });
  const organization = store.state.tables.organization[0];
  await request('PATCH', `/organizations(${organization.organizationid})`, { fullnameconventioncode: 0 }).then(
    async (response) => assert.equal(response.status, 200, await response.text()),
  );
  const contact = await create('contacts', { firstname: 'Ivo', lastname: 'Zeta' });
  assert.equal(contact.fullname, 'Zeta, Ivo');
  const lead = await create('leads', { firstname: 'Lia', lastname: 'Pqfn', fullname: 'Ignored' });
  assert.equal(lead.fullname, 'Pqfn, Lia');
});
