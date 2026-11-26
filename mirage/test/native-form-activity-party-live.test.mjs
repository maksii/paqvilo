// @test-kind compatibility: through the live bridge, Associate Current Portal User with Is Activity Party sends the party inside the activity create as a Web API deep insert (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/create-table-row#create-related-table-rows-in-one-operation, https://learn.microsoft.com/power-pages/configure/write-update-delete-operations#create-a-record-in-a-table) over the collection-valued activityparty navigation and partyid_contact (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/activityparty#many-to-one-relationships); invented schema, stub live forwarder
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CONTACT = 'c0a00000-0000-4000-8000-000000000001';

async function fixture(t, { relationships = true, requiredParty = false } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-activity-party-live-'));
  const files = {
    'website.yml': 'adx_websiteid: website\nadx_name: Test',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Visit\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Visit" %}',
    'Visit.basicform.yml': [
      'adx_entityformid: visit',
      'adx_name: Visit',
      'adx_entityname: new_visit',
      'adx_mode: 100000000',
      'adx_associatecurrentportaluser: true',
      'adx_portaluserlookupattribute: to',
      'adx_portaluserlookupattributeisactivityparty: true',
    ].join('\n'),
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const requests = [];
  const liveBridge = {
    origin: 'https://portal.example.test',
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(url, options = {}) {
      const method = options.method ?? 'GET';
      requests.push({ method, url, body: options.body ? JSON.parse(String(options.body)) : undefined });
      if (method === 'POST' && url === '/_api/new_visits')
        return {
          status: 201,
          headers: {},
          body: Buffer.from(JSON.stringify({ activityid: 'online-visit', subject: 'Visit' })),
        };
      return { status: 404, headers: {}, body: Buffer.from('{}') };
    },
  };
  const app = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, 'state.json'),
    initial: {
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
        new_visit: {
          entitySet: 'new_visits',
          idColumn: 'activityid',
          ...(relationships
            ? {
                relationships: {
                  new_visit_activity_parties: {
                    entity: 'activityparty',
                    from: 'activityid',
                    to: 'activityid',
                    many: true,
                  },
                },
              }
            : {}),
        },
        activityparty: {
          entitySet: 'activityparties',
          idColumn: 'activitypartyid',
          relationships: {
            partyid_contact: { entity: 'contact', from: 'partyid', to: 'contactid', many: false },
          },
        },
      },
      tables: { contact: [{ contactid: CONTACT, fullname: 'Signed in contact', statecode: 0 }], new_visit: [] },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      presets: {},
      simulator: {
        mode: 'live',
        pageMode: 'local',
        // A live runtime acts as its configured identity (server.mjs currentIdentity).
        identity: { id: CONTACT, contactId: CONTACT, roles: [] },
        live: { origin: 'https://portal.example.test', allowWrites: true },
        endpoints: [],
        componentSchemas: {
          visit: {
            entity: 'new_visit',
            fields: [
              { name: 'subject', label: 'Subject' },
              ...(requiredParty ? [{ name: 'to', label: 'To', type: 'lookup', required: true }] : []),
            ],
            currentUserAssociationField: { name: 'to', dataverseType: 'partylist' },
          },
        },
      },
    },
    liveBridge,
    // Live submissions need the runtime's live-write permission (cli --allow-live-writes).
    allowLiveWrites: true,
    watch: false,
  });
  ownedFixture(t).add(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const submit = () =>
    fetch(`${app.url}/__sim/forms/entityform/visit/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        __RequestVerificationToken: app.csrf,
      },
      body: JSON.stringify({ values: { subject: 'Visit' }, pageUrl: '/' }),
    });
  return { app, submit, requests };
}

test('a live insert sends the activity and its party in one deep-insert request', async (t) => {
  const { submit, requests } = await fixture(t);
  const response = await submit();
  assert.equal(response.status, 201, await response.clone().text());
  const writes = requests.filter((request) => request.method !== 'GET');
  assert.deepEqual(writes, [
    {
      method: 'POST',
      url: '/_api/new_visits',
      body: {
        subject: 'Visit',
        new_visit_activity_parties: [
          { 'partyid_contact@odata.bind': `/contacts(${CONTACT})`, participationtypemask: 2 },
        ],
      },
    },
  ]);
});

test('a required party list column on the form is satisfied by the live deep insert', async (t) => {
  const { submit, requests } = await fixture(t, { requiredParty: true });
  const response = await submit();
  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(
    requests.filter((request) => request.method !== 'GET').map((request) => [request.url, request.body]),
    [
      [
        '/_api/new_visits',
        {
          subject: 'Visit',
          new_visit_activity_parties: [
            { 'partyid_contact@odata.bind': `/contacts(${CONTACT})`, participationtypemask: 2 },
          ],
        },
      ],
    ],
  );
});

// @test-kind contract: an activity without a mapped activityparty navigation is refused before any live write
test('a live insert without a mapped activityparty navigation writes nothing', async (t) => {
  const { submit, requests } = await fixture(t, { relationships: false });
  const response = await submit();
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, 'FormUserAssociationUnresolved');
  assert.deepEqual(
    requests.filter((request) => request.method !== 'GET'),
    [],
  );
});
