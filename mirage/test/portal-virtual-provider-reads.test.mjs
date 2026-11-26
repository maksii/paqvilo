// @test-kind contract: fresh virtual-table provider snapshots feed portal reads without replacing the local mirror
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { signInHeaders } from '../testing/session.mjs';

const SITE = 'af000000-0000-4000-8000-000000000001';
const LIST = 'af000000-0000-4000-8000-000000000002';
const CONTACT = 'af000000-0000-4000-8000-000000000003';
const OTHER = 'af000000-0000-4000-8000-000000000004';
const VISIBLE = 'af000000-0000-4000-8000-000000000005';
const HIDDEN = 'af000000-0000-4000-8000-000000000006';
const CONTAINER = 'af000000-0000-4000-8000-000000000007';
const READER = 'af000000-0000-4000-8000-000000000008';
const FETCH = '<fetch><entity name="test_external"><attribute name="title"/></entity></fetch>';

async function fixture(t, { parent = false, custom = false } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-virtual-provider-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'site');
  const providerPath = path.join(directory, 'provider.mjs');
  const dataPath = path.join(directory, 'external.json');
  await fs.mkdir(sourceDir);
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Test virtual provider\nadx_enhancedauthorization: ${custom ? 3 : 0}`,
    'webrole.yml': `adx_webroleid: ${READER}\nadx_name: Reader`,
    'home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: page',
    'home.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: template',
    'home.webtemplate.yml': 'adx_webtemplateid: template\nadx_name: Home',
    'home.webtemplate.source.html':
      `{% fetchxml fetched %}${FETCH}{% endfetchxml %}<section id="fetch">{% for row in fetched.results.entities %}{{ row.title }}{% endfor %}</section>` +
      `<section id="entity">{{ entities.test_external["${VISIBLE}"].title }}</section>{% include 'entity_list' key: 'External rows' %}`,
    'external.list.yml': `adx_entitylistid: ${LIST}\nadx_name: External rows\nadx_entityname: test_external`,
    ...(custom
      ? {
          'External.tablepermission.yml': [
            'adx_entitypermissionid: af000000-0000-4000-8000-000000000009',
            'adx_name: Filtered provider rows',
            'adx_entitylogicalname: test_external',
            'adx_scope: 756150005',
            'adx_read: true',
            'adx_entitypermission_webrole:',
            `- ${READER}`,
            'mspp_permissionfetchxml: >-',
            '  <fetch><entity name="test_external"><filter><condition attribute="title" operator="eq" value="Provider first"/></filter></entity></fetch>',
          ].join('\n'),
        }
      : {}),
    'sitesetting.yml':
      '- adx_name: Webapi/test_external/enabled\n  adx_value: "true"\n' +
      '- adx_name: Webapi/test_external/fields\n  adx_value: "title"\n' +
      '- adx_name: Webapi/test_container/enabled\n  adx_value: "true"\n' +
      '- adx_name: Webapi/test_container/fields\n  adx_value: "external,title"\n',
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => fs.writeFile(path.join(sourceDir, name), contents)),
  );
  await fs.writeFile(
    providerPath,
    `import fs from 'node:fs/promises';
const read = async () => {
  const rows = JSON.parse(await fs.readFile(${JSON.stringify(dataPath)}, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Invented provider unavailable');
  return rows;
};
export default { id: 'external-fixture', name: 'External fixture', description: 'Invented provider', matches: () => true,
  presets: () => ({}), virtualTableProviders: { test_external: {
    retrieve: async (id) => (await read()).find(row => row.test_externalid === id) ?? null,
    retrieveMultiple: read,
  } }
};
`,
  );
  const writeProviderRows = (title, person = CONTACT) =>
    fs.writeFile(
      dataPath,
      JSON.stringify(
        title === null
          ? {}
          : [
              { test_externalid: VISIBLE, person, title },
              { test_externalid: HIDDEN, person: OTHER, title: 'Outside scope' },
            ],
      ),
    );
  await writeProviderRows('Provider first');
  const app = await createSimulator({
    sourceDir,
    watch: false,
    projectRoot: directory,
    dataPacks: [{ module: providerPath }],
    initial: {
      mappings: {
        test_external: {
          entitySet: 'test_externals',
          idColumn: 'test_externalid',
          nameColumn: 'title',
          isVirtual: true,
          fields: { title: { dataverseType: 'nvarchar' }, person: { dataverseType: 'lookup' } },
        },
        test_container: {
          entitySet: 'test_containers',
          idColumn: 'test_containerid',
          nameColumn: 'title',
          fields: { title: { dataverseType: 'nvarchar' }, external: { dataverseType: 'lookup' } },
          relationships: {
            external: { entity: 'test_external', from: 'external', to: 'test_externalid', many: false },
          },
        },
      },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Visitor' }],
        test_external: [],
        test_container: [{ test_containerid: CONTAINER, title: 'Container', external: VISIBLE }],
      },
      permissions: [
        {
          id: 'container',
          entity: 'test_container',
          roles: ['Reader'],
          operations: ['read'],
          ...(parent
            ? {
                scope: 'parent',
                parentPermissionId: 'mine',
                relationship: { entity: 'test_external', from: 'external', to: 'test_externalid' },
              }
            : { scope: 'global' }),
        },
        {
          id: 'mine',
          entity: 'test_external',
          scope: 'contact',
          field: 'person',
          roles: ['Reader'],
          operations: ['read'],
        },
      ],
      simulator: {
        componentSchemas: { 'External rows': { entity: 'test_external', fields: [{ name: 'title', label: 'Title' }] } },
        contactRoles: [{ contactId: CONTACT, roleId: READER }],
        permissionSource: custom ? 'exported' : 'configured',
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const session = signInHeaders(app, CONTACT, custom ? {} : { roles: ['Reader'] });
  const get = (suffix, headers = session) => fetch(app.url + suffix, { headers });
  return { app, session, get, writeProviderRows };
}

test('Liquid, lists and the portal Web API read current provider rows through the same portal restrictions', async (t) => {
  const { app, session, get, writeProviderRows } = await fixture(t);
  const first = await (await get('/')).text();
  assert.match(first, /<section id="fetch">Provider first<\/section>/);
  assert.match(first, /<section id="entity">Provider first<\/section>/);
  assert.doesNotMatch(first, /Outside scope/);
  const encoded = /data-view-layouts="([^"]+)"/.exec(first)?.[1];
  assert.ok(encoded, 'the portal list registered its protected grid view');
  const [view] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

  const stale = [{ test_externalid: VISIBLE, person: CONTACT, title: 'Stale mirror row' }];
  await app.store.transact(() => {
    app.store.state.tables.test_external = stale;
  });
  await writeProviderRows('Provider updated');
  const list = await fetch(`${app.url}/_services/entity-grid-data.json/${SITE}`, {
    method: 'POST',
    headers: {
      ...session,
      'content-type': 'application/json',
      __RequestVerificationToken: app.portalToken,
    },
    body: JSON.stringify({ base64SecureConfiguration: view.Base64SecureConfiguration, page: 1, pageSize: 10 }),
  });
  assert.equal(list.status, 200, await list.clone().text());
  const grid = await list.json();
  assert.deepEqual(
    grid.Records.map((row) => row.Attributes.find(({ Name }) => Name === 'title')?.Value),
    ['Provider updated'],
  );

  for (const query of [`fetchXml=${encodeURIComponent(FETCH)}`, '$select=title']) {
    const response = await get(`/_api/test_externals?${query}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
      (await response.json()).value.map(({ title }) => title),
      ['Provider updated'],
    );
  }
  const single = await get(`/_api/test_externals(${VISIBLE})?$select=title`);
  assert.equal(single.status, 200, await single.clone().text());
  assert.equal((await single.json()).title, 'Provider updated');
  assert.equal((await get(`/_api/test_externals(${HIDDEN})?$select=title`)).status, 403);
  const linked = await get(`/_api/test_containers(${CONTAINER})?$expand=external($select=title)`);
  assert.equal(linked.status, 200, await linked.clone().text());
  assert.equal((await linked.json()).external.title, 'Provider updated');
  assert.deepEqual(app.store.tableRows('test_external'), stale, 'direct portal reads leave the local mirror untouched');
});

// @test-kind security: a denied portal request must undergo permission checking without reaching the provider
test('a provider failure is returned to an allowed visitor and does not mask a table-permission refusal', async (t) => {
  const { get, writeProviderRows } = await fixture(t);
  await writeProviderRows(null);
  const allowed = await get('/_api/test_externals?$select=title');
  assert.equal(allowed.status, 400, await allowed.clone().text());
  assert.equal(allowed.headers.get('x-sim-error-code'), 'VirtualProviderFailed');
  const denied = await get('/_api/test_externals?$select=title', {});
  assert.equal(denied.status, 403, await denied.clone().text());
  assert.equal(denied.headers.get('x-sim-error-code'), 'PermissionDenied');
});

// @test-kind security: a stale provider mirror cannot keep a parent permission after its current scope changes
test('portal Parent grants read their relationship predicate from the current provider rows', async (t) => {
  const { app, get, writeProviderRows } = await fixture(t, { parent: true });
  const stale = [{ test_externalid: VISIBLE, person: CONTACT, title: 'Old allowed provider row' }];
  await app.store.transact(() => {
    app.store.state.tables.test_external = stale;
  });
  const xml = '<fetch><entity name="test_container"><attribute name="title"/></entity></fetch>';
  const collection = async (query) => {
    const response = await get(`/_api/test_containers?${query}`);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).value;
  };
  const odata = '$select=title';
  const fetchxml = `fetchXml=${encodeURIComponent(xml)}`;
  assert.equal((await collection(odata))[0].title, 'Container');
  assert.equal((await collection(fetchxml))[0].title, 'Container');

  await writeProviderRows('Provider moved away', OTHER);
  assert.deepEqual(await collection(odata), []);
  assert.deepEqual(await collection(fetchxml), []);
  assert.equal((await get(`/_api/test_containers(${CONTAINER})?${odata}`)).status, 403);
  assert.deepEqual(app.store.tableRows('test_external'), stale);
});

// @test-kind security: enabled enhanced Custom Access filters fresh provider rows rather than a formerly admitted mirror
test('portal Custom Access predicates use fresh provider rows on Liquid and the portal Web API', async (t) => {
  const { app, get, writeProviderRows } = await fixture(t, { custom: true });
  const stale = [{ test_externalid: VISIBLE, person: CONTACT, title: 'Provider first' }];
  await app.store.transact(() => {
    app.store.state.tables.test_external = stale;
  });
  const api = async () => {
    const response = await get('/_api/test_externals?$select=title');
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).value;
  };
  assert.equal((await api())[0].title, 'Provider first');
  assert.match(await (await get('/')).text(), /<section id="fetch">Provider first<\/section>/);
  await writeProviderRows('Provider updated');
  assert.deepEqual(await api(), []);
  assert.match(await (await get('/')).text(), /<section id="fetch"><\/section>/);
  assert.equal((await get(`/_api/test_externals(${VISIBLE})?$select=title`)).status, 403);
  assert.deepEqual(app.store.tableRows('test_external'), stale);
});
