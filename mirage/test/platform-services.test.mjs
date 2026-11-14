// @test-kind contract: Paqvilo's portal services (sign-in tokens, ads, polls) are designed simulator runtime behaviour; the per-test kinds below override it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { DataStore } from '../lib/data.mjs';
import { handleODataFeed, odataFeeds } from '../lib/odata-feeds.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '8c3d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f';
const CONTACT = 'c3000000-0000-4000-8000-000000000001';
const AD = 'ad000000-0000-4000-8000-000000000001';
const AD_PLACEMENT = 'ad000000-0000-4000-8000-000000000002';
const POLL = 'b0000000-0000-4000-8000-000000000001';
const POLL_PLACEMENT = 'b0000000-0000-4000-8000-000000000002';

async function servicesFixture(t, settings = []) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'platform-services-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Services`,
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    'sitesetting.yml':
      settings
        .map(
          ([name, value], index) =>
            `- adx_sitesettingid: 5e000000-0000-4000-8000-00000000000${index}\n  adx_name: ${name}\n  adx_value: "${value}"`,
        )
        .join('\n') || '[]',
    'ad.yml': `- adx_adid: ${AD}\n  adx_name: Banner\n  adx_copy: <p>Local ad copy</p>\n  adx_url: ~/news/`,
    'adplacement.yml': `- adx_adplacementid: ${AD_PLACEMENT}\n  adx_name: Sidebar\n  adx_adplacement_ad:\n  - ${AD}`,
    'polls/sample/Sample.poll.yml': `adx_pollid: ${POLL}\nadx_name: Sample\nadx_question: Which option?\nadx_active: true\nadx_submitbuttonlabel: Vote`,
    'polls/sample/Sample.poll.polloption.yml': `- adx_polloptionid: b0000000-0000-4000-8000-000000000003\n  adx_name: First\n  adx_answer: First\n  adx_pollid: ${POLL}`,
    'poll-placements/Sidebar.pollplacement.yml': `adx_pollplacementid: ${POLL_PLACEMENT}\nadx_name: Sidebar\nadx_pollplacement_poll:\n- ${POLL}`,
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
    tables: {
      contact: [
        {
          contactid: CONTACT,
          fullname: 'Ada Lovelace',
          firstname: 'Ada',
          lastname: 'Lovelace',
          emailaddress1: 'ada@example.test',
        },
      ],
    },
    permissions: [],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: { origin: null }, endpoints: [] },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  return { app, session: signInHeaders(app, CONTACT, { roles: ['Authenticated Users'] }) };
}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

test('the implicit grant token endpoint issues a signed ID token for the signed-in contact', async (t) => {
  const { app, session } = await servicesFixture(t, [
    ['ImplicitGrantFlow/RegisteredClientId', 'local-api;other-client'],
    ['ImplicitGrantFlow/TokenExpirationTime', '30'],
  ]);
  const key = await (await fetch(`${app.url}/_services/auth/publickey`)).text();
  assert.match(key, /^-----BEGIN PUBLIC KEY-----/);
  const response = await fetch(`${app.url}/_services/auth/token?client_id=local-api&nonce=n-1&state=s-1`, {
    method: 'POST',
    headers: session,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('state'), 's-1');
  assert.equal(response.headers.get('expires_in'), '60', '30 seconds is clamped to the 1 minute minimum');
  const token = await response.text();
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(decode(header), { typ: 'JWT', alg: 'RS256' });
  assert.equal(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(key, signature, 'base64url'), true);
  const claims = decode(payload);
  assert.deepEqual(
    [
      claims.sub,
      claims.given_name,
      claims.family_name,
      claims.email,
      claims.nonce,
      claims.aud,
      claims.appid,
      claims.exp - claims.iat,
      claims.iss,
    ],
    [CONTACT, 'Ada', 'Lovelace', 'ada@example.test', 'n-1', 'local-api', 'local-api', 60, new URL(app.url).host],
  );
  // Unregistered client ids are refused with the documented error document.
  const refused = await fetch(`${app.url}/_services/auth/token?client_id=unknown`, {
    method: 'POST',
    headers: session,
  });
  assert.equal(refused.status, 400);
  const error = await refused.json();
  assert.equal(error.ErrorId, 'PortalSTS0001');
  assert.deepEqual(Object.keys(error), ['ErrorId', 'ErrorMessage', 'Timestamp', 'CorrelationId']);
  // Anonymous AJAX calls get the cookie-authentication 401 envelope; navigations go to sign-in.
  const anonymous = await fetch(`${app.url}/_services/auth/token`, {
    method: 'POST',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  });
  assert.equal(anonymous.status, 200);
  const responded = JSON.parse(anonymous.headers.get('x-responded-json'));
  assert.equal(responded.status, 401);
  assert.match(responded.headers.location, /\/SignIn\?ReturnUrl=%2F_services%2Fauth%2Ftoken$/);
  const redirect = await fetch(`${app.url}/_services/auth/token`, { method: 'POST', redirect: 'manual' });
  assert.equal(redirect.status, 302);
});

test('the implicit grant flow can be turned off by site setting', async (t) => {
  const { app, session } = await servicesFixture(t, [['Connector/ImplicitGrantFlowEnabled', 'False']]);
  const response = await fetch(`${app.url}/_services/auth/token`, { method: 'POST', headers: session });
  assert.equal(response.status, 405, 'the token route falls through to page routing, which refuses the POST');
  assert.equal((await fetch(`${app.url}/_services/auth/publickey`)).status, 404);
});

// @test-kind security: a state that is not a valid header value gets Mirage's own error document, and the form body read is bounded.
test('the implicit grant token refuses a state that is not a header value and bounds the form body', async (t) => {
  const { app, session } = await servicesFixture(t, [['ImplicitGrantFlow/RegisteredClientId', 'local-api']]);
  const post = (query) => fetch(`${app.url}/_services/auth/token?${query}`, { method: 'POST', headers: session });
  const refused = await post('client_id=local-api&state=a%0D%0Ab');
  assert.equal(refused.status, 400);
  assert.match(refused.headers.get('content-type'), /^application\/json/);
  assert.equal(refused.headers.get('state'), null);
  assert.equal((await refused.json()).ErrorId, 'PortalSTS0002');
  const echoed = await post('client_id=local-api&state=abc');
  assert.equal(echoed.status, 200);
  assert.equal(echoed.headers.get('state'), 'abc');
  await echoed.text();
  const oversized = await fetch(`${app.url}/_services/auth/token`, {
    method: 'POST',
    headers: { ...session, 'content-type': 'application/x-www-form-urlencoded' },
    body: `client_id=local-api&pad=${'x'.repeat(70 * 1024)}`,
  });
  assert.equal(oversized.status, 413);
  await oversized.text();
});

test("ad and poll placement services render the portal's ad and poll markup", async (t) => {
  const { app, session } = await servicesFixture(t);
  const ad = await fetch(`${app.url}/_services/ads/${SITE}/placements/${AD_PLACEMENT}/random`, { headers: session });
  assert.equal(ad.status, 200);
  assert.equal(ad.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(
    await ad.text(),
    /<a class="ad-link" href="\/news\/" title="">[\s\S]*<div class="ad-copy"><p>Local ad copy<\/p><\/div>/,
  );
  assert.match(
    await (await fetch(`${app.url}/_services/ads/${SITE}/${AD}`, { headers: session })).text(),
    /Local ad copy/,
  );
  const poll = await (
    await fetch(`${app.url}/_services/polls/${SITE}/placements/${POLL_PLACEMENT}/random`, { headers: session })
  ).text();
  assert.match(poll, new RegExp(`<div class="poll-questionpanel" data-id="${POLL}" data-name="Sample">`));
  assert.match(poll, /Which option\?/);
  assert.equal(
    (
      await fetch(`${app.url}/_services/ads/00000000-0000-4000-8000-000000000000/placements/${AD_PLACEMENT}/random`, {
        headers: session,
      })
    ).status,
    404,
  );
});

function fakeResponse() {
  const response = { status: null, headers: {}, body: '' };
  return {
    response,
    writeHead(status, headers) {
      response.status = status;
      response.headers = headers;
    },
    end(body) {
      response.body = body ?? '';
    },
    json: () => JSON.parse(response.body),
  };
}

test('entity list OData feeds publish the list view with the legacy property model and query options', async () => {
  const ORG = ['0a000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-000000000002'];
  const store = await new DataStore({
    state: {
      mappings: {
        orgcontact: { entitySet: 'orgcontacts', idColumn: 'orgcontactid', nameColumn: 'name' },
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        organisation: { entitySet: 'organisations', idColumn: 'organisationid', nameColumn: 'name' },
      },
      tables: {
        orgcontact: [
          {
            orgcontactid: '0c000000-0000-4000-8000-000000000001',
            name: 'Link A',
            role: 1,
            organisationid: { id: ORG[0], logical_name: 'organisation', name: 'Alpha' },
            contactid: { id: CONTACT, logical_name: 'contact', name: 'Ada' },
          },
          {
            orgcontactid: '0c000000-0000-4000-8000-000000000002',
            name: 'Link B',
            role: 2,
            organisationid: { id: ORG[1], logical_name: 'organisation', name: 'Beta' },
            contactid: { id: CONTACT, logical_name: 'contact', name: 'Ada' },
          },
          {
            orgcontactid: '0c000000-0000-4000-8000-000000000003',
            name: 'Link C',
            role: 1,
            organisationid: { id: ORG[1], logical_name: 'organisation', name: 'Beta' },
            contactid: null,
          },
        ],
      },
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const list = {
    id: '1d000000-0000-4000-8000-000000000001',
    name: 'Organisation Contacts',
    entityName: 'orgcontact',
    metadata: {
      adx_odata_enabled: true,
      adx_odata_entitysetname: 'OrgContactSet',
      adx_odata_entitytypename: 'orgcontact',
      adx_odata_view: '{2E000000-0000-4000-8000-000000000001}',
    },
  };
  // A site whose platform still serves list OData feeds (observed); by default they are removed.
  const portal = {
    lists: [
      list,
      {
        id: 'x',
        name: 'Hidden',
        entityName: 'orgcontact',
        metadata: { adx_odata_enabled: false, adx_odata_entitysetname: 'HiddenSet' },
      },
    ],
    website: { id: SITE },
    observed: { listODataFeeds: 'served' },
  };
  const metadata = {
    views: [
      {
        id: '2e000000-0000-4000-8000-000000000001',
        entity: 'orgcontact',
        fetchXml:
          '<fetch><entity name="orgcontact"><attribute name="orgcontactid"/><attribute name="name"/><attribute name="role"/><attribute name="organisationid"/><attribute name="contactid"/></entity></fetch>',
        fields: [{ name: 'name' }, { name: 'role' }, { name: 'organisationid' }, { name: 'contactid' }],
      },
    ],
    entities: {
      orgcontact: {
        fields: {
          name: { dataverseType: 'nvarchar' },
          role: {
            dataverseType: 'picklist',
            options: [
              { value: 1, label: 'Primary' },
              { value: 2, label: 'Deputy' },
            ],
          },
          organisationid: { dataverseType: 'lookup' },
          contactid: { dataverseType: 'lookup' },
        },
      },
    },
  };
  assert.deepEqual([...odataFeeds(portal).keys()], ['orgcontactset']);
  const context = { portal, metadata, store, readProvider: store, identity: {}, origin: 'http://localhost:3000' };
  const call = async (pathAndQuery, headers = { accept: 'application/json' }) => {
    const res = fakeResponse();
    const handled = await handleODataFeed(
      { method: 'GET', headers },
      res,
      new URL(pathAndQuery, 'http://localhost:3000'),
      context,
    );
    return { handled, ...res.response, json: () => JSON.parse(res.response.body) };
  };
  const service = await call('/_odata');
  assert.deepEqual(service.json(), {
    'odata.metadata': 'http://localhost:3000/_odata/$metadata',
    value: [{ name: 'OrgContactSet', url: 'OrgContactSet' }],
  });
  const edmx = await call('/_odata/$metadata');
  assert.match(edmx.headers['content-type'], /application\/xml/);
  assert.match(
    edmx.body,
    /<EntityType Name="orgcontact"><Key><PropertyRef Name="orgcontactid"\/><\/Key><Property Name="orgcontactid" Type="Edm.Guid" Nullable="false"\/><Property Name="name" Type="Edm.String"\/><Property Name="role" Type="Xrm.OptionSet"\/><Property Name="organisationid" Type="Xrm.EntityReference"\/>/,
  );
  // The authored query shape: filter on a lookup's Id with a parenthesised guid literal.
  const filtered = await call(
    `/_odata/OrgContactSet/?$filter=organisationid/Id eq (guid'${ORG[1]}')&$orderby=name desc`,
  );
  assert.equal(filtered.status, 200);
  assert.match(filtered.headers['content-type'], /^application\/json; odata=minimalmetadata/);
  const body = filtered.json();
  assert.equal(body['odata.metadata'], 'http://localhost:3000/_odata/$metadata#OrgContactSet');
  assert.deepEqual(
    body.value.map((entry) => entry.name),
    ['Link C', 'Link B'],
  );
  assert.deepEqual(body.value[1], {
    orgcontactid: '0c000000-0000-4000-8000-000000000002',
    name: 'Link B',
    role: { Name: 'Deputy', Value: 2 },
    organisationid: { Id: ORG[1], Name: 'Beta' },
    contactid: { Id: CONTACT, Name: 'Ada' },
    'list-id': list.id,
    'view-id': '2e000000-0000-4000-8000-000000000001',
    'entity-permissions-enabled': 'False',
  });
  const paged = (
    await call('/_odata/OrgContactSet?$orderby=name&$skip=1&$top=1&$select=name,role&$inlinecount=allpages')
  ).json();
  assert.deepEqual(paged, {
    'odata.metadata': 'http://localhost:3000/_odata/$metadata#OrgContactSet',
    'odata.count': '3',
    value: [{ name: 'Link B', role: { Name: 'Deputy', Value: 2 } }],
  });
  const logical = (
    await call("/_odata/OrgContactSet?$filter=role/Value eq 1 and (contactid eq null or startswith(name,'Link A'))")
  ).json();
  assert.deepEqual(logical.value.map((entry) => entry.name).sort(), ['Link A', 'Link C']);
  const single = (await call("/_odata/OrgContactSet(guid'0c000000-0000-4000-8000-000000000001')")).json();
  assert.equal(single['odata.metadata'], 'http://localhost:3000/_odata/$metadata#OrgContactSet/@Element');
  assert.equal(single.name, 'Link A');
  assert.equal((await call('/_odata/HiddenSet')).status, 404);
  assert.equal((await call("/_odata/OrgContactSet?$filter=name eq 'x' or")).status, 400);
  for (const filter of [
    'role/Value eq ' + '0'.repeat(100000) + 'x',
    'role/Value eq -' + '0'.repeat(100000) + '.',
    ' '.repeat(100000) + '!',
  ])
    assert.equal((await call('/_odata/OrgContactSet?$filter=' + encodeURIComponent(filter))).status, 400);
  // Parentheses or `not` nested beyond 100 levels are refused as a bad $filter, not a stack exhaustion.
  const nestedParentheses = '('.repeat(1000) + "name eq 'x'" + ')'.repeat(1000);
  assert.equal((await call('/_odata/OrgContactSet?$filter=' + encodeURIComponent(nestedParentheses))).status, 400);
  const deepParentheses = '('.repeat(10000) + "name eq 'x'" + ')'.repeat(10000);
  assert.equal((await call('/_odata/OrgContactSet?$filter=' + encodeURIComponent(deepParentheses))).status, 400);
  const nestedNot = 'not '.repeat(1000) + "name eq 'x'";
  assert.equal((await call('/_odata/OrgContactSet?$filter=' + encodeURIComponent(nestedNot))).status, 400);
  assert.equal((await call('/_odata/OrgContactSet', { accept: 'application/atom+xml' })).status, 406);
  assert.equal((await call('/other')).handled, false);
});

test('OData feeds keep the exact digits of decimal values and $filter literals beyond double precision', async () => {
  const exact = (value) => ({ $type: 'DataverseNumeric', numericType: 'Decimal', value });
  const store = await new DataStore({
    state: {
      mappings: { priceitem: { entitySet: 'priceitems', idColumn: 'priceitemid', nameColumn: 'name' } },
      tables: {
        priceitem: [
          {
            priceitemid: '0d000000-0000-4000-8000-000000000001',
            name: 'Exact A',
            amount: exact('12345678901234567890.1'),
          },
          {
            priceitemid: '0d000000-0000-4000-8000-000000000002',
            name: 'Exact B',
            amount: exact('12345678901234567890.2'),
          },
          { priceitemid: '0d000000-0000-4000-8000-000000000003', name: 'Ordinary', amount: 12.5 },
        ],
      },
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const portal = {
    lists: [
      {
        id: '1d000000-0000-4000-8000-000000000002',
        name: 'Price Items',
        entityName: 'priceitem',
        metadata: {
          adx_odata_enabled: true,
          adx_odata_entitysetname: 'PriceItemSet',
          adx_odata_entitytypename: 'priceitem',
          adx_odata_view: '{2E000000-0000-4000-8000-000000000002}',
        },
      },
    ],
    website: { id: SITE },
    observed: { listODataFeeds: 'served' },
  };
  const metadata = {
    views: [
      {
        id: '2e000000-0000-4000-8000-000000000002',
        entity: 'priceitem',
        fetchXml:
          '<fetch><entity name="priceitem"><attribute name="priceitemid"/><attribute name="name"/><attribute name="amount"/></entity></fetch>',
        fields: [{ name: 'name' }, { name: 'amount' }],
      },
    ],
    entities: { priceitem: { fields: { name: { dataverseType: 'nvarchar' }, amount: { dataverseType: 'money' } } } },
  };
  const context = { portal, metadata, store, readProvider: store, identity: {}, origin: 'http://localhost:3000' };
  const call = async (pathAndQuery) => {
    const res = fakeResponse();
    await handleODataFeed(
      { method: 'GET', headers: { accept: 'application/json' } },
      res,
      new URL(pathAndQuery, 'http://localhost:3000'),
      context,
    );
    return res.response;
  };
  const names = async (filter) => {
    const response = await call(`/_odata/PriceItemSet?$filter=${encodeURIComponent(filter)}&$orderby=name`);
    assert.equal(response.status, 200, response.body);
    return JSON.parse(response.body).value.map((entry) => entry.name);
  };
  const all = await call('/_odata/PriceItemSet?$orderby=name');
  // Ordinary decimals keep the JSON number form.
  assert.match(all.body, /"name":"Ordinary","amount":12\.5[,}]/);
  assert.match(all.body, /"name":"Exact A","amount":12345678901234567890\.1[,}]/);
  assert.match(all.body, /"name":"Exact B","amount":12345678901234567890\.2[,}]/);
  assert.deepEqual(await names('amount eq 12345678901234567890.1'), ['Exact A']);
  assert.deepEqual(await names('amount eq 12345678901234567890.2'), ['Exact B']);
  assert.deepEqual(await names('amount gt 12345678901234567890.15'), ['Exact B']);
  assert.deepEqual(await names('amount eq 12.5'), ['Ordinary']);
  const ordered = JSON.parse((await call('/_odata/PriceItemSet?$orderby=amount desc')).body).value.map(
    (entry) => entry.name,
  );
  assert.deepEqual(ordered, ['Exact B', 'Exact A', 'Ordinary']);
});

// @test-kind security: a long flat $filter chain must not exhaust the stack, and nesting past the limit must stay a 400 feed error.
test('OData $filter evaluates 20,000-term flat chains, allows nesting at the limit and refuses deeper nesting as odata.error', async () => {
  const store = await new DataStore({
    state: {
      mappings: { orgcontact: { entitySet: 'orgcontacts', idColumn: 'orgcontactid', nameColumn: 'name' } },
      tables: {
        orgcontact: [
          { orgcontactid: '0c000000-0000-4000-8000-000000000001', name: 'Link A', role: 1 },
          { orgcontactid: '0c000000-0000-4000-8000-000000000002', name: 'Link B', role: 2 },
        ],
      },
      permissions: [],
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const portal = {
    lists: [
      {
        id: '1d000000-0000-4000-8000-000000000001',
        name: 'Organisation Contacts',
        entityName: 'orgcontact',
        metadata: {
          adx_odata_enabled: true,
          adx_odata_entitysetname: 'OrgContactSet',
          adx_odata_entitytypename: 'orgcontact',
          adx_odata_view: '{2E000000-0000-4000-8000-000000000001}',
        },
      },
    ],
    website: { id: '5e000000-0000-4000-8000-000000000001' },
    observed: { listODataFeeds: 'served' },
  };
  const metadata = {
    views: [
      {
        id: '2e000000-0000-4000-8000-000000000001',
        entity: 'orgcontact',
        name: 'Organisation Contacts',
        fetchXml:
          '<fetch><entity name="orgcontact"><attribute name="orgcontactid"/><attribute name="name"/><attribute name="role"/></entity></fetch>',
        fields: [{ name: 'name' }, { name: 'role' }],
      },
    ],
    entities: {
      orgcontact: {
        fields: {
          name: { dataverseType: 'nvarchar' },
          role: {
            dataverseType: 'picklist',
            options: [
              { value: 1, label: 'Primary' },
              { value: 2, label: 'Deputy' },
            ],
          },
        },
      },
    },
  };
  const context = { portal, metadata, store, readProvider: store, identity: {}, origin: 'http://localhost:3000' };
  const call = async (filter) => {
    const res = fakeResponse();
    await handleODataFeed(
      { method: 'GET', headers: { accept: 'application/json' } },
      res,
      new URL(`/_odata/OrgContactSet?$filter=${encodeURIComponent(filter)}`, 'http://localhost:3000'),
      context,
    );
    return { status: res.response.status, json: () => JSON.parse(res.response.body) };
  };
  const names = async (filter) => (await call(filter)).json().value.map((entry) => entry.name);
  const absent = Array.from({ length: 19999 }, (_, i) => `name eq 'absent ${i}'`);
  assert.deepEqual(await names([...absent, "name eq 'Link B'"].join(' or ')), ['Link B']);
  assert.deepEqual(await names(Array.from({ length: 20000 }, () => "name ne 'absent'").join(' and ')), [
    'Link A',
    'Link B',
  ]);
  const atLimit = `${'('.repeat(100)}name eq 'Link A'${')'.repeat(100)}`;
  assert.deepEqual(await names(atLimit), ['Link A']);
  const beyondLimit = await call(`${'('.repeat(101)}name eq 'Link A'${')'.repeat(101)}`);
  assert.equal(beyondLimit.status, 400);
  assert.equal(beyondLimit.json()['odata.error'].message.value, 'The $filter expression is nested too deeply.');
});

test('native grid actions activate, deactivate, associate, disassociate and download the view as CSV', async (t) => {
  const { simulatorFixture, parentId, otherParentId, acceptedId, pendingId } = await import('./fixtures/subgrid.mjs');
  const app = await simulatorFixture(t);
  const session = signInHeaders(app, 'editor', { roles: ['Editor'] });
  const page = await (await fetch(`${app.url}/?id=${parentId}`, { headers: session })).text();
  const start = page.indexOf('class="entity-grid subgrid');
  const layouts = JSON.parse(
    Buffer.from(/data-view-layouts="([^"]*)"/.exec(page.slice(start))[1], 'base64').toString('utf8'),
  );
  const secure = layouts[0].Base64SecureConfiguration;
  const call = (action, body) =>
    fetch(`${app.url}/_services/${action}/site`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...session },
      body: JSON.stringify(body),
    });
  const child = (id) => app.store.snapshot().tables.child.find((row) => row.childkey === id);
  const stateOf = (row) => Number(typeof row.statecode === 'object' ? row.statecode?.value : row.statecode);

  assert.equal((await call('action-deactivate', { LogicalName: 'child', Id: pendingId })).status, 204);
  assert.equal(stateOf(child(pendingId)), 1);
  assert.equal((await call('action-activate', { LogicalName: 'child', Id: pendingId })).status, 204);
  assert.equal(stateOf(child(pendingId)), 0);
  assert.equal((await call('action-activate', { LogicalName: 'child', Id: 'not-a-guid' })).status, 400);

  const relationship = { SchemaName: 'children' };
  const moved = {
    Target: { LogicalName: 'parent', Id: otherParentId },
    Relationship: relationship,
    RelatedEntities: [{ LogicalName: 'child', Id: acceptedId }],
  };
  // One-to-many: associating sets the related row's lookup, disassociating clears it.
  assert.equal((await call('entity-lookup-associate', moved)).status, 204);
  assert.deepEqual(child(acceptedId).parentlookup, { id: otherParentId, logical_name: 'parent', name: 'Other parent' });
  assert.equal((await call('entity-grid-disassociate', moved)).status, 204);
  assert.equal(child(acceptedId).parentlookup, null);
  assert.equal(
    (await call('entity-lookup-associate', { ...moved, Relationship: { SchemaName: 'unknown' } })).status,
    403,
  );

  const columns = [{ LogicalName: 'name', Name: 'Child name', Type: 0 }];
  {
    const action = 'download-as-csv';
    const format = null;
    const response = await call(action, { base64SecureConfiguration: secure, columns, viewName: 'Children' });
    assert.equal(response.status, 200, action);
    assert.equal(response.headers.get('x-sim-download-format'), format);
    const { success, sessionKey } = await response.json();
    assert.equal(success, true);
    const file = await fetch(`${app.url}/_services/${action}/site?key=${encodeURIComponent(sessionKey)}`, {
      headers: session,
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(
      file.headers.get('content-disposition'),
      'attachment; filename="Children.csv"; filename*=UTF-8\'\'Children.csv',
    );
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the CSV starts with a UTF-8 byte order mark');
    const lines = bytes.subarray(3).toString('utf8').split('\r\n');
    assert.equal(lines[0], 'Child name');
    assert.ok(lines.includes('Pending child'), lines.join('|'));
    // A download key is served once.
    assert.equal(
      (await fetch(`${app.url}/_services/${action}/site?key=${encodeURIComponent(sessionKey)}`, { headers: session }))
        .status,
      204,
    );
  }
});

test("list OData feeds are removed by default: /_odata falls through to the site's page-not-found handling", async () => {
  // Power Pages removed list OData feeds by June 2026 (the feed URL answers the 404 page).
  const list = {
    id: '1d000000-0000-4000-8000-000000000002',
    name: 'Feed',
    entityName: 'orgcontact',
    metadata: { adx_odata_enabled: true, adx_odata_entitysetname: 'FeedSet' },
  };
  const res = fakeResponse();
  assert.equal(
    await handleODataFeed({ method: 'GET', headers: {} }, res, new URL('http://localhost:3000/_odata/FeedSet'), {
      portal: { lists: [list], website: { id: SITE } },
    }),
    false,
  );
  assert.equal(
    await handleODataFeed({ method: 'GET', headers: {} }, res, new URL('http://localhost:3000/_odata'), {
      portal: { lists: [list], website: { id: SITE } },
    }),
    false,
  );
});
