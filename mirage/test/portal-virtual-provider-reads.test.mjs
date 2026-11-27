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
const PARENT = 'af000000-0000-4000-8000-000000000011';
const FETCH = '<fetch><entity name="test_external"><attribute name="title"/></entity></fetch>';

async function fixture(t, { parent = false, custom = false, intersect = null } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-virtual-provider-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const sourceDir = path.join(directory, 'site');
  const providerPath = path.join(directory, 'provider.mjs');
  const dataPath = path.join(directory, 'external.json');
  const linkPath = path.join(directory, 'link.json');
  const requestsPath = path.join(directory, 'requests.jsonl');
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
      // The lookup's _x_value is listed with it, as a hosted list needs (hosted session F1 summary-F1 API-02c).
      '- adx_name: Webapi/test_container/fields\n  adx_value: "external,_external_value,title,externals,children,parentRow,_parent_value"\n',
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => fs.writeFile(path.join(sourceDir, name), contents)),
  );
  await fs.writeFile(
    providerPath,
    `import fs from 'node:fs/promises';
const read = async (file = ${JSON.stringify(dataPath)}) => {
  const rows = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Invented provider unavailable');
  return rows;
};
const links = () => read(${JSON.stringify(linkPath)});
export default { id: 'external-fixture', name: 'External fixture', description: 'Invented provider', matches: () => true,
  presets: () => ({}), virtualTableProviders: { test_external: {
    retrieve: async (id) => (await read()).find(row => row.test_externalid === id) ?? null,
    retrieveMultiple: async (request) => {
      await fs.appendFile(${JSON.stringify(requestsPath)}, JSON.stringify(request ?? null) + '\\n');
      return read();
    },
  }, test_link: {
    retrieve: async (id) => (await links()).find(row => row.test_linkid === id) ?? null,
    retrieveMultiple: links,
  } }
};
`,
  );
  const writeProviderRows = (title, person = CONTACT, visible = {}, extra = []) =>
    fs.writeFile(
      dataPath,
      JSON.stringify(
        title === null
          ? {}
          : [
              { test_externalid: VISIBLE, person, title, ...visible },
              { test_externalid: HIDDEN, person: OTHER, title: 'Outside scope' },
              ...extra,
            ],
      ),
    );
  await writeProviderRows('Provider first');
  // Edges of the provider-backed intersect table: [container, external, person] triples.
  const writeLinkRows = (edges) =>
    fs.writeFile(
      linkPath,
      JSON.stringify(
        edges === null
          ? {}
          : edges.map(([container, external, person], index) => ({
              test_linkid: `af000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
              container,
              external,
              person,
            })),
      ),
    );
  await writeLinkRows([]);
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
          fields: {
            title: { dataverseType: 'nvarchar' },
            person: { dataverseType: 'lookup' },
            container: { dataverseType: 'lookup' },
          },
        },
        test_link: {
          entitySet: 'test_links',
          idColumn: 'test_linkid',
          isVirtual: true,
          fields: {
            container: { dataverseType: 'lookup' },
            external: { dataverseType: 'lookup' },
            person: { dataverseType: 'lookup' },
          },
        },
        test_container: {
          entitySet: 'test_containers',
          idColumn: 'test_containerid',
          nameColumn: 'title',
          fields: {
            title: { dataverseType: 'nvarchar' },
            external: { dataverseType: 'lookup' },
            parent: { dataverseType: 'lookup' },
          },
          relationships: {
            external: { entity: 'test_external', from: 'external', to: 'test_externalid', many: false },
            externals: { entity: 'test_external', from: 'test_containerid', to: 'container', many: true },
            children: { entity: 'test_container', from: 'test_containerid', to: 'parent', many: true },
            parentRow: { entity: 'test_container', from: 'parent', to: 'test_containerid', many: false },
          },
        },
      },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Visitor' }],
        test_external: [],
        test_container: [{ test_containerid: CONTAINER, title: 'Container', external: VISIBLE }],
        test_link: [],
      },
      permissions: [
        {
          id: 'container',
          entity: 'test_container',
          roles: ['Reader'],
          operations: ['read'],
          ...(intersect === 'parent' && {
            scope: 'parent',
            parentPermissionId: 'mine',
            relationship: {
              entity: 'test_external',
              from: 'test_containerid',
              to: 'test_externalid',
              intersect: { entity: 'test_link', from: 'container', to: 'external' },
            },
          }),
          ...(intersect === 'identity' && {
            scope: 'contact',
            identityRelationship: {
              entity: 'contact',
              from: 'test_containerid',
              to: 'contactid',
              intersect: { entity: 'test_link', from: 'container', to: 'person' },
            },
          }),
          ...(!intersect && parent
            ? {
                scope: 'parent',
                parentPermissionId: 'mine',
                relationship: { entity: 'test_external', from: 'external', to: 'test_externalid' },
              }
            : {}),
          ...(!intersect && !parent && { scope: 'global' }),
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
  // The requests the provider's retrieveMultiple received, in order.
  const providerRequests = async () =>
    (await fs.readFile(requestsPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { app, session, get, writeProviderRows, writeLinkRows, providerRequests };
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
  // A lookup $expand into a provider-backed table reads null and reads no provider (hosted session F1 follow-up 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup and nav-followup-throw: expand-lookup).
  const linked = await get(`/_api/test_containers(${CONTAINER})?$expand=external($select=title)`);
  assert.equal(linked.status, 200, await linked.clone().text());
  assert.equal((await linked.json()).external, null);
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

// @test-kind security+observation: a $filter path into a provider-backed table is refused after the column check and before any provider or stale-mirror read: 500 9004010D cdscode 0x80044150 (hosted session F1 follow-up 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup and nav-followup-throw: lookup-filter)
test('portal OData filters through a navigation into a provider-backed table are refused before any provider read', async (t) => {
  const { app, get, writeProviderRows } = await fixture(t);
  const blockedContainer = 'af000000-0000-4000-8000-000000000010';
  const mirror = [{ test_externalid: VISIBLE, person: CONTACT, title: 'Stale mirror row' }];
  await app.store.transact(() => {
    app.store.state.tables.test_external = mirror;
    app.store.state.tables.test_container.push({
      test_containerid: blockedContainer,
      title: 'Blocked relationship',
      external: HIDDEN,
    });
    app.store.state.mappings.test_external.fields.private_title = { dataverseType: 'nvarchar' };
  });
  const filtered = (predicate, aliases = {}) =>
    get(`/_api/test_containers?${new URLSearchParams({ $select: 'title', $filter: predicate, ...aliases })}`);
  const predicates = [
    ['external/title eq @title', { '@title': "'Provider updated'" }],
    ["external/title eq 'Stale mirror row'", {}],
    ["external/title eq 'Outside scope'", {}],
  ];
  // A throwing provider answers the same refusal: the provider is never called.
  for (const rows of [['Provider updated'], ['Provider updated', OTHER], [null]])
    for (const pipeline of ['modeled', 'native-classic']) {
      await writeProviderRows(...rows);
      await withObserved(app, { odataPermissionQueryPipeline: pipeline }, async () => {
        for (const [predicate, aliases] of predicates)
          await assertProviderJoinRefused(await filtered(predicate, aliases));
        await assertRefused(
          await filtered("external/private_title eq 'Provider updated'"),
          403,
          'WebApiFieldNotEnabled',
        );
      });
    }
  assert.deepEqual(app.store.tableRows('test_external'), mirror);
  // A path that ends at the lookup (no column of the virtual table) is no join: it keeps the earlier model.
  await writeProviderRows('Provider updated');
  assert.equal((await filtered('external eq null')).status, 200);
  await app.store.transact(() => {
    app.store.state.permissions = app.store.state.permissions.filter(({ id }) => id !== 'mine');
  });
  await assertProviderJoinRefused(await filtered("external/title eq 'Provider updated'"));
  // A visitor without read on the queried table gets the table refusal, never the join answer that would reveal the
  // virtual table behind the lookup: the collection read and its /$count alike.
  await app.store.transact(() => {
    app.store.state.permissions = app.store.state.permissions.filter(({ id }) => id !== 'container');
  });
  const query = new URLSearchParams({ $filter: "external/title eq 'x'" });
  for (const response of [
    await filtered("external/title eq 'x'"),
    await get(`/_api/test_containers/$count?${query}`),
  ]) {
    assert.equal(response.status, 403, await response.clone().text());
    assert.deepEqual((await response.json()).error, {
      code: '90040120',
      message: "You don't have permission to read the test_container table.",
    });
  }
});

const assertProviderJoinRefused = async (response) => {
  assert.equal(response.status, 500, await response.clone().text());
  assert.equal(response.headers.get('x-sim-error-code'), 'VirtualTableJoinUnsupported');
  assert.deepEqual((await response.json()).error, {
    code: '9004010D',
    message: 'Common Data Service error occurred.',
    cdscode: '0x80044150',
  });
};

const titlesOf = async (response, pick = (body) => body.value) => {
  assert.equal(response.status, 200, await response.clone().text());
  return pick(await response.json()).map(({ title }) => title);
};
const assertRefused = async (response, status, code) => {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('x-sim-error-code'), code);
};
const withObserved = async (app, observed, fn) => {
  const previous = app.store.observed;
  app.store.observed = { ...previous, ...observed };
  try {
    return await fn();
  } finally {
    app.store.observed = previous;
  }
};
const staleProviderMirror = async (app, changes = () => {}) => {
  const mirror = [{ test_externalid: VISIBLE, person: CONTACT, title: 'Stale mirror row', container: CONTAINER }];
  await app.store.transact(() => {
    app.store.state.tables.test_external = mirror;
    app.store.state.mappings.test_external.fields.private_title = { dataverseType: 'nvarchar' };
    changes(app.store.state);
  });
  return mirror;
};

// @test-kind security+observation: an any/all lambda over a provider-backed collection is refused after the column check and before any provider or stale-mirror read: 500 9004010D cdscode 0x80044150 (hosted session F1 follow-up 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup and nav-followup-throw: collection-any, collection-all)
test('portal OData any and all lambdas over a provider-backed collection are refused before any provider read', async (t) => {
  const { app, get, writeProviderRows } = await fixture(t);
  const mirror = await staleProviderMirror(app);
  const filtered = (predicate) =>
    get(`/_api/test_containers?${new URLSearchParams({ $select: 'title', $filter: predicate })}`);
  for (const rows of [['Provider updated', CONTACT, { container: CONTAINER }], [null]])
    for (const pipeline of ['modeled', 'native-classic']) {
      await writeProviderRows(...rows);
      await withObserved(app, { odataPermissionQueryPipeline: pipeline }, async () => {
        for (const predicate of [
          "externals/any(e: e/title eq 'Provider updated')",
          "externals/all(e: e/title eq 'Provider updated')",
          "externals/any(e: e/title eq 'Stale mirror row')",
        ])
          await assertProviderJoinRefused(await filtered(predicate));
        await assertRefused(await filtered("externals/any(e: e/private_title eq 'x')"), 403, 'WebApiFieldNotEnabled');
      });
    }
  assert.deepEqual(app.store.tableRows('test_external'), mirror);
});

// @test-kind security+observation: a provider-backed table's own /$count counts fresh provider rows and refuses a disabled column before the provider read; a navigation /$count answers 400 9004010A and a filter path into the provider-backed table 500 9004010D, both before any provider read (hosted session F1 follow-up 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup and nav-followup-throw: navcount-*, lookup-filter)
test('portal OData count routes count the current provider rows', async (t) => {
  const { app, get, writeProviderRows } = await fixture(t);
  await staleProviderMirror(app);
  const query = (options) => new URLSearchParams(options).toString();
  const counted = async (suffix) => {
    const response = await get(suffix);
    assert.equal(response.status, 200, await response.clone().text());
    return response.text();
  };
  const nested = `/_api/test_containers(${CONTAINER})/externals`;

  await writeProviderRows('Provider updated', CONTACT, { container: CONTAINER });
  for (const title of ['Provider updated', 'Stale mirror row']) {
    const expected = title === 'Provider updated' ? '1' : '0';
    assert.equal(await counted(`/_api/test_externals/$count?${query({ $filter: `title eq '${title}'` })}`), expected);
  }
  const navigationCount = async (suffix) => {
    const response = await get(suffix);
    assert.equal(response.status, 400, await response.clone().text());
    assert.deepEqual((await response.json()).error, {
      code: '9004010A',
      message: 'An unexpected error occurred while processing the request',
    });
  };
  // A collection navigation to another table is refused before any read, the provider's included (hosted session F1
  // summary-F1 API-02c, runs/a and runs/b odata-shapes navigation-collection: 403 with no backend query in either run).
  const related = await get(`${nested}?${query({ $select: 'title', $count: 'true' })}`);
  assert.equal(related.status, 403, await related.clone().text());
  assert.deepEqual((await related.json()).error, {
    code: '90040101',
    message: 'Attribute All Columns in table test_container is not enabled for Web Api.',
  });

  for (const rows of [['Provider updated', CONTACT, { container: CONTAINER }], [null]]) {
    await writeProviderRows(...rows);
    for (const filter of ["external/title eq 'x'", "externals/any(e: e/title eq 'x')"]) {
      await assertProviderJoinRefused(await get(`/_api/test_containers/$count?${query({ $filter: filter })}`));
      await assertProviderJoinRefused(
        await get(`/_api/test_containers?${query({ $select: 'title', $count: 'true', $filter: filter })}`),
      );
    }
    for (const suffix of [`${nested}/$count`, `${nested}/$count?${query({ $filter: "title eq 'x'" })}`])
      await navigationCount(suffix);
  }
  for (const suffix of [
    `/_api/test_externals/$count?${query({ $filter: "private_title eq 'x'" })}`,
    `/_api/test_containers/$count?${query({ $filter: "external/private_title eq 'x'" })}`,
    `${nested}?${query({ $select: 'private_title', $count: 'true' })}`,
    `/_api/test_containers?${query({ $select: 'title', $count: 'true', $filter: "external/private_title eq 'x'" })}`,
  ])
    await assertRefused(await get(suffix), 403, 'WebApiFieldNotEnabled');
  await assertRefused(
    await get(`/_api/test_externals/$count?${query({ $filter: "title eq 'x'" })}`),
    400,
    'VirtualProviderFailed',
  );
});

// @test-kind security: options nested in $expand read fresh provider rows and refuse a disabled column before the provider read
test('portal OData options nested in $expand read the current provider rows', async (t) => {
  const { app, get, writeProviderRows } = await fixture(t);
  await staleProviderMirror(app, (state) => {
    state.tables.test_container.push({ test_containerid: PARENT, title: 'Parent' });
    state.tables.test_container.find((row) => row.test_containerid === CONTAINER).parent = PARENT;
  });
  const options = (filter) => `children($select=title;$filter=${filter})`;
  const entity = (expand) =>
    get(`/_api/test_containers(${PARENT})?${new URLSearchParams({ $select: 'title', $expand: expand })}`);
  const collection = (expand) =>
    get(
      `/_api/test_containers?${new URLSearchParams({ $select: 'title', $filter: "title eq 'Parent'", $expand: expand })}`,
    );
  const children = (body) => body.children;
  const listed = (body) => body.value[0].children;

  await writeProviderRows('Provider updated', CONTACT, { container: CONTAINER });
  for (const title of ['Provider updated', 'Stale mirror row']) {
    const expected = title === 'Provider updated' ? ['Container'] : [];
    for (const filter of [`external/title eq '${title}'`, `externals/any(e: e/title eq '${title}')`]) {
      assert.deepEqual(await titlesOf(await entity(options(filter)), children), expected, filter);
      assert.deepEqual(await titlesOf(await collection(options(filter)), listed), expected, filter);
    }
  }
  const own = await get(
    `/_api/test_containers(${CONTAINER})?${new URLSearchParams({
      $select: 'title',
      $expand: "externals($select=title;$filter=title ne 'Stale mirror row';$orderby=title desc)",
    })}`,
  );
  assert.deepEqual(await titlesOf(own, (body) => body.externals), ['Provider updated']);

  await writeProviderRows(null);
  await assertRefused(await entity(options("external/private_title eq 'x'")), 403, 'WebApiFieldNotEnabled');
  await assertRefused(await collection(options("external/private_title eq 'x'")), 403, 'WebApiFieldNotEnabled');
  await assertRefused(await entity(options("external/title eq 'x'")), 400, 'VirtualProviderFailed');
  await assertRefused(await collection(options("external/title eq 'x'")), 400, 'VirtualProviderFailed');
});

// @test-kind security: an $orderby through a navigation path is refused before any provider read
test('portal OData orderings through a navigation path are refused before the provider is read', async (t) => {
  const { get, writeProviderRows } = await fixture(t);
  await writeProviderRows(null);
  for (const route of ['/_api/test_containers', `/_api/test_containers(${CONTAINER})`])
    for (const options of [
      { $select: 'title', $orderby: 'external/title' },
      { $select: 'title', $expand: 'children($select=title;$orderby=external/title)' },
    ]) {
      const response = await get(`${route}?${new URLSearchParams(options)}`);
      assert.equal(response.status, 400, await response.clone().text());
      assert.equal(response.headers.get('x-sim-error-code'), 'UnsupportedQuery');
    }
});

// Each generated permission path over the provider-backed intersect test_link, read through every portal read lane.
for (const [kind, label] of [
  ['parent', 'a Parent grant through a many-to-many relationship'],
  ['identity', 'a Contact grant through a many-to-many identity relationship'],
]) {
  // @test-kind security: generated permission joins read the current provider intersect edges, never a stale mirror that still connects the row
  test(`${label} reads its intersect edges from the current provider rows`, async (t) => {
    const { app, get, writeProviderRows, writeLinkRows } = await fixture(t, { intersect: kind });
    const mirror = [
      { test_linkid: 'af000000-0000-4000-8000-000000000199', container: CONTAINER, external: VISIBLE, person: CONTACT },
    ];
    await app.store.transact(() => {
      app.store.state.tables.test_link = mirror;
    });
    const xml = '<fetch><entity name="test_container"><attribute name="title"/></entity></fetch>';
    const lanes = ['$select=title', `fetchXml=${encodeURIComponent(xml)}`];
    const visible = async () => {
      const titles = [];
      for (const query of lanes) titles.push(await titlesOf(await get(`/_api/test_containers?${query}`)));
      const single = await get(`/_api/test_containers(${CONTAINER})?$select=title`);
      titles.push(single.status === 200 ? [(await single.json()).title] : single.status);
      return titles;
    };

    await writeProviderRows('Provider updated');
    await writeLinkRows([[CONTAINER, VISIBLE, CONTACT]]);
    assert.deepEqual(await visible(), [['Container'], ['Container'], ['Container']]);
    await writeLinkRows([[CONTAINER, HIDDEN, OTHER]]);
    assert.deepEqual(await visible(), [[], [], 403]);
    assert.deepEqual(
      app.store.tableRows('test_link'),
      mirror,
      'portal reads leave the local intersect mirror untouched',
    );

    await writeLinkRows(null);
    for (const query of lanes)
      await assertRefused(await get(`/_api/test_containers?${query}`), 400, 'VirtualProviderFailed');
    await assertRefused(await get('/_api/test_containers?$select=title', {}), 403, 'PermissionDenied');
  });
}

// @test-kind security+observation: an $apply path into a provider-backed table is refused after the column and table-permission checks and before any provider or stale-mirror read: 500 9004010D cdscode 0x80044150 with a healthy and a throwing provider (hosted session F1 follow-up (2) 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup-nested: apply-lookup-filter-count, apply-collection-any, apply-collection-any-count); a groupby path into it was not captured and is refused alike (fail closed)
test('portal OData $apply paths into a provider-backed table are refused before any provider read', async (t) => {
  const { app, get, writeProviderRows, providerRequests } = await fixture(t);
  const mirror = await staleProviderMirror(app);
  const applied = (apply) => get(`/_api/test_containers?${new URLSearchParams({ $apply: apply })}`);
  const joins = [
    "filter(external/title eq 'Provider updated')/aggregate($count as total)",
    "filter(external/title eq 'Stale mirror row')/aggregate($count as total)",
    "filter(externals/any(e: e/title eq 'Provider updated'))",
    "filter(externals/any(e: e/title eq 'Provider updated'))/aggregate($count as total)",
    'groupby((external/title))',
  ];
  for (const rows of [['Provider updated', CONTACT, { container: CONTAINER }], [null]]) {
    await writeProviderRows(...rows);
    for (const apply of joins) await assertProviderJoinRefused(await applied(apply));
    // The column check still comes first.
    await assertRefused(
      await applied("filter(external/private_title eq 'x')/aggregate($count as total)"),
      403,
      'WebApiFieldNotEnabled',
    );
  }
  assert.deepEqual(await providerRequests(), [], 'no $apply read reached the provider');
  assert.deepEqual(app.store.tableRows('test_external'), mirror);
  // Without read on the related table the join is refused alike; without read on the queried table the visitor gets the
  // table refusal and never learns that the path reaches a provider-backed table.
  await app.store.transact(() => {
    app.store.state.permissions = app.store.state.permissions.filter(({ id }) => id !== 'mine');
  });
  await assertProviderJoinRefused(await applied("filter(external/title eq 'x')/aggregate($count as total)"));
  await app.store.transact(() => {
    app.store.state.permissions = app.store.state.permissions.filter(({ id }) => id !== 'container');
  });
  const denied = await applied("filter(external/title eq 'x')/aggregate($count as total)");
  assert.equal(denied.status, 403, await denied.clone().text());
  assert.equal((await denied.json()).error.code, '90040120');
});

// @test-kind observation: hosted session F1 follow-up (2) 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup-nested (control:apply-lookup-filter-count, control:apply-collection-any-count): filter(<navigation path>)/aggregate($count as c) on standard tables answers one empty object per matching row
test('portal OData $apply count after a navigation filter answers one empty object per matching row', async (t) => {
  const { app, get } = await fixture(t);
  await app.store.transact(() => {
    app.store.state.tables.test_container.push(
      { test_containerid: PARENT, title: 'Parent' },
      { test_containerid: 'af000000-0000-4000-8000-000000000012', title: 'Second', parent: PARENT },
    );
    app.store.state.tables.test_container.find((row) => row.test_containerid === CONTAINER).parent = PARENT;
  });
  const applied = async (apply) => {
    const response = await get(`/_api/test_containers?${new URLSearchParams({ $apply: apply })}`);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).value.map(({ '@odata.id': _id, ...row }) => row);
  };
  // A collection lambda: only Parent has children.
  assert.deepEqual(await applied("filter(children/any(e: e/title ne 'x'))/aggregate($count as total)"), [{}]);
  // A lookup path: both children of Parent match.
  assert.deepEqual(await applied("filter(parentRow/title eq 'Parent')/aggregate($count as total)"), [{}, {}]);
  // Without a navigation path the count is the local aggregate.
  assert.deepEqual(await applied("filter(title eq 'Parent')/aggregate($count as total)"), [{ total: 1 }]);
});

// @test-kind security+observation: a collection $expand into a provider-backed table hands the nested $select, $filter, $orderby and $top to the provider and applies none of them to its rows, which still pass the table permissions and the Web API column settings; a lookup $expand into it reads null on every row (hosted session F1 follow-up (2) 2026-11-27, paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup-nested: expand-collection-filter, expand-collection-filter-orderby-top, expand-lookup-select)
test('portal OData options nested in a $expand into a provider-backed table go to the provider and are not applied', async (t) => {
  const { app, get, writeProviderRows, providerRequests } = await fixture(t);
  await staleProviderMirror(app);
  const SECOND = 'af000000-0000-4000-8000-000000000013';
  await writeProviderRows('Provider updated', CONTACT, { container: CONTAINER, private_title: 'secret' }, [
    { test_externalid: SECOND, person: CONTACT, title: 'Another', container: CONTAINER },
    { test_externalid: 'af000000-0000-4000-8000-000000000014', person: OTHER, title: 'Other', container: CONTAINER },
  ]);
  const nested = "externals($select=title;$filter=title eq 'x';$orderby=title desc;$top=1)";
  const response = await get(
    `/_api/test_containers?${new URLSearchParams({ $select: 'title', $filter: "title eq 'Container'", $expand: nested })}`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const [container] = (await response.json()).value;
  // Every row the provider returned for the parent, in its order; the other contact's row stays out (table permission)
  // and the column outside Webapi/test_external/fields stays out (column settings).
  assert.deepEqual(
    container.externals.map(({ title, private_title: hidden }) => [title, hidden]),
    [
      ['Provider updated', undefined],
      ['Another', undefined],
    ],
  );
  const requests = await providerRequests();
  assert.equal(requests.length, 1);
  assert.deepEqual(
    [requests[0].select, requests[0].filter, requests[0].orderby, requests[0].top],
    ['title', "title eq 'x'", 'title desc', 1],
  );
  // A lookup $expand into the provider-backed table reads null on every row of a collection read; no provider read.
  const lookup = await get(
    `/_api/test_containers?${new URLSearchParams({ $select: 'title', $expand: 'external($select=title)' })}`,
  );
  assert.equal(lookup.status, 200, await lookup.clone().text());
  assert.deepEqual(
    (await lookup.json()).value.map((row) => row.external),
    [null],
  );
  assert.equal((await providerRequests()).length, 1);
});
