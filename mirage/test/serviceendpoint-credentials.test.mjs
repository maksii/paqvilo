// @test-kind security: Microsoft Learn ServiceEndpoint reference marks authvalue, saskey and sastoken IsValidForRead False; the is...set columns report whether each holds a value
// Service endpoint credentials are not readable through the Web API by any caller: a column whose definition says validForRead false
// is never returned, and naming it in $select, $filter or $orderby is the unknown-property refusal. The webhook dispatcher reads the
// stored key from the store, so a registered web hook still sends it. Invented names and loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { widgetApi, wireRegisteredSteps } from './support/service-endpoint-pipeline.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { APPS, startSecuredOrganization, str, retrieveMultiple, fetchExpression } from './support/secured-reads.mjs';
import { tdsLogin, tdsQuery, utf16 } from './support/tds-client.mjs';

const testCertificate = createSelfSignedCertificate();

const ENDPOINTS = 'serviceendpoints';
const WEBHOOK_KEY = 'INVENTED-WEBHOOK-KEY';
const SAS_KEY = 'INVENTED-SAS-KEY';
const SAS_TOKEN = 'INVENTED-SAS-TOKEN';
const SECRETS = [WEBHOOK_KEY, SAS_KEY, SAS_TOKEN];
const UNKNOWN_PROPERTY = '0x80060888';
// Registers the administrator and the Basic User only.
const startOrganization = (options = {}) =>
  startSecuredOrganization({
    envPrefix: 'PAQ_SERVICE_ENDPOINT',
    apps: { admin: APPS.admin, basic: APPS.basic },
    tls: options.tls,
  });

const mentionsSecret = (text) => SECRETS.some((secret) => text.includes(secret));
const WRONG_GUESS = 'INVENTED-WRONG-GUESS';
const CREDENTIALS = ['authvalue', 'saskey', 'sastoken'];

const queryExpression = (columns, condition = '') =>
  `<b:value i:type="a:QueryExpression"><a:EntityName>serviceendpoint</a:EntityName>` +
  `<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns>${columns.map((name) => `<f:string>${name}</f:string>`).join('')}</a:Columns></a:ColumnSet>` +
  `<a:Criteria><a:FilterOperator>And</a:FilterOperator><a:Conditions>${condition}</a:Conditions><a:Filters/></a:Criteria></b:value>`;
const equalCondition = (name, value) =>
  `<a:ConditionExpression><a:AttributeName>${name}</a:AttributeName><a:Operator>Equal</a:Operator><a:Values>${str(value)}</a:Values></a:ConditionExpression>`;
const entityRows = (text) => (text.match(/<a:Entity[ >]/g) ?? []).length;
// A SOAP fault stamps the time it was built; that stamp is the only part of two refusals that may differ.
const withoutTimestamp = (text) => text.replace(/<Timestamp>[^<]*<\/Timestamp>/g, '');
const endpointFetch = (inner) => `<fetch><entity name="serviceendpoint">${inner}</entity></fetch>`;
const endpointUrl = (fetchXml) => `${ENDPOINTS}?fetchXml=${encodeURIComponent(fetchXml)}`;
const condition = (name, value) => `<filter><condition attribute="${name}" operator="eq" value="${value}"/></filter>`;

// A webhook with an authorization value and a bus endpoint with a SAS key and token, created by the administrator.
async function seedEndpoints(call) {
  const hook = await call('admin', 'POST', ENDPOINTS, {
    name: 'Invented hook',
    contract: 8,
    authtype: 4,
    authvalue: WEBHOOK_KEY,
    url: 'https://example.invalid/hook',
  });
  assert.equal(hook.status, 201);
  const bus = await call('admin', 'POST', ENDPOINTS, {
    name: 'Invented bus',
    contract: 1,
    authtype: 2,
    saskeyname: 'invented-key-name',
    saskey: SAS_KEY,
    sastoken: SAS_TOKEN,
    namespaceaddress: 'invented.example.invalid',
    path: 'invented-queue',
    solutionnamespace: 'invented',
  });
  assert.equal(bus.status, 201);
}

test('no caller reads service endpoint credentials; the is...set columns report whether each holds a value', async () => {
  const harness = await startOrganization();
  try {
    const { call } = harness;
    const webhook = await call('admin', 'POST', ENDPOINTS, {
      name: 'Invented hook',
      contract: 8,
      authtype: 4,
      authvalue: WEBHOOK_KEY,
      url: 'https://example.invalid/hook',
    });
    assert.equal(webhook.status, 201);
    assert.equal(mentionsSecret(webhook.text), false, 'the create answer omits the secrets');
    const sas = await call('admin', 'POST', ENDPOINTS, {
      name: 'Invented bus',
      contract: 1,
      authtype: 2,
      saskeyname: 'invented-key-name',
      saskey: SAS_KEY,
      sastoken: SAS_TOKEN,
      namespaceaddress: 'invented.example.invalid',
      path: 'invented-queue',
      solutionnamespace: 'invented',
    });
    assert.equal(sas.status, 201);
    assert.equal(mentionsSecret(sas.text), false, 'the SAS create answer omits the secrets');

    const admin = await call('admin', 'GET', ENDPOINTS);
    assert.equal(admin.status, 200);
    assert.equal(mentionsSecret(admin.text), false, 'an administrator reads no secret');
    const hook = admin.body.value.find((row) => row.name === 'Invented hook');
    assert.equal(hook.isauthvalueset, true);
    assert.equal(hook.issaskeyset, false);
    assert.equal(admin.body.value.find((row) => row.name === 'Invented bus').issaskeyset, true);
    assert.equal(admin.body.value.find((row) => row.name === 'Invented bus').issastokenset, true);
    const selected = await call('admin', 'GET', `${ENDPOINTS}?$select=name,isauthvalueset`);
    assert.equal(selected.status, 200);
    assert.equal(selected.body.value.find((row) => row.name === 'Invented hook').isauthvalueset, true);
    assert.equal(mentionsSecret(selected.text), false);

    const hookId = hook.serviceendpointid;
    const byId = await call('admin', 'GET', `${ENDPOINTS}(${hookId})`);
    assert.equal(byId.status, 200);
    assert.equal(mentionsSecret(byId.text), false, 'a single row read omits the secret');
    assert.equal(byId.body.isauthvalueset, true);
    assert.equal(byId.body.authvalue, undefined, 'the authvalue column is not returned');
  } finally {
    await harness.close();
  }
});

test('naming a credential column is the unknown-property refusal, for every caller', async () => {
  const harness = await startOrganization();
  try {
    const { call } = harness;
    await call('admin', 'POST', ENDPOINTS, { name: 'Invented hook', contract: 8, authtype: 4, authvalue: WEBHOOK_KEY });
    for (const query of [
      `${ENDPOINTS}?$select=authvalue`,
      `${ENDPOINTS}?$select=name,saskey`,
      `${ENDPOINTS}?$filter=authvalue eq '${WEBHOOK_KEY}'`,
      `${ENDPOINTS}?$orderby=sastoken`,
    ]) {
      const refused = await call('admin', 'GET', query);
      assert.equal(refused.status, 400, query);
      assert.equal(refused.text.includes(UNKNOWN_PROPERTY), true, `${query} names the unknown property`);
      assert.equal(mentionsSecret(refused.text), false, `${query} gives no oracle on the secret`);
    }
  } finally {
    await harness.close();
  }
});

test('a Basic User cannot read service endpoints at all', async () => {
  const harness = await startOrganization();
  try {
    const { call } = harness;
    await call('admin', 'POST', ENDPOINTS, { name: 'Invented hook', contract: 8, authtype: 4, authvalue: WEBHOOK_KEY });
    const list = await call('basic', 'GET', ENDPOINTS);
    assert.equal(list.status, 403);
    assert.equal(mentionsSecret(list.text), false);
  } finally {
    await harness.close();
  }
});

test('a registered web hook still sends its key header from the stored endpoint row', async () => {
  const received = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const world = await widgetApi('invented');
  const { store, messageId, filterId } = world;
  const runner = wireRegisteredSteps(store, webhookDelivery(store), () => {});
  try {
    const setting = '<settings><setting name="x-invented-key" value="INVENTED-HEADER-KEY" /></settings>';
    await store.create(
      'serviceendpoint',
      {
        serviceendpointid: 'cccccccc-0000-4000-8000-000000000031',
        name: 'Invented hook',
        url: `http://127.0.0.1:${server.address().port}/hook`,
        authtype: 5,
        contract: 8,
        authvalue: setting,
      },
      { admin: true },
    );
    await store.create(
      'sdkmessageprocessingstep',
      {
        sdkmessageprocessingstepid: 'dddddddd-0000-4000-8000-000000000031',
        name: 'Invented webhook step',
        sdkmessageid: messageId,
        sdkmessagefilterid: filterId,
        eventhandler: { id: 'cccccccc-0000-4000-8000-000000000031', logical_name: 'serviceendpoint' },
        stage: 40,
        mode: 0,
        rank: 1,
        statecode: 0,
        supporteddeployment: 0,
      },
      { admin: true },
    );
    await store.create(
      'invented_widget',
      { invented_widgetid: 'bbbbbbbb-0000-4000-8000-000000000031', invented_name: 'alpha' },
      { admin: true },
    );
    assert.equal(received.length, 1, 'the create posted to the hook');
    assert.equal(received[0].headers['x-invented-key'], 'INVENTED-HEADER-KEY');
    assert.equal(store.tableRows('serviceendpoint')[0].authvalue, setting, 'the store keeps the stored value');
  } finally {
    await runner.close();
    await world.api.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an administrator reads no service endpoint credential through a FetchXML projection', async () => {
  const harness = await startOrganization();
  try {
    await seedEndpoints(harness.call);
    const attributes = CREDENTIALS.map((name) => `<attribute name="${name}"/>`).join('');
    for (const inner of [`<attribute name="name"/>${attributes}`, '<all-attributes/>']) {
      const read = await harness.call('admin', 'GET', endpointUrl(endpointFetch(inner)));
      assert.equal(read.status, 200, inner);
      assert.equal(mentionsSecret(read.text), false, `${inner} carries no credential`);
      for (const row of read.body.value)
        for (const column of CREDENTIALS) assert.equal(row[column] ?? null, null, `${inner} ${column}`);
    }
  } finally {
    await harness.close();
  }
});

test('a guess of a credential through FetchXML or $apply is refused as the unknown property, alike, for an administrator', async () => {
  const harness = await startOrganization();
  try {
    const { call } = harness;
    await seedEndpoints(call);
    const control = await call(
      'admin',
      'GET',
      endpointUrl(endpointFetch(`<attribute name="name"/>${condition('name', 'Invented hook')}`)),
    );
    assert.equal(control.status, 200);
    assert.equal(control.body.value.length, 1, 'a condition on a readable column matches the row');

    const conditioned = (guess) =>
      endpointUrl(endpointFetch(`<attribute name="name"/>${condition('authvalue', guess)}`));
    const applied = (guess) => `${ENDPOINTS}?$apply=filter(authvalue eq '${guess}')/groupby((name))`;
    for (const query of [conditioned, applied]) {
      const right = await call('admin', 'GET', query(WEBHOOK_KEY));
      const wrong = await call('admin', 'GET', query(WRONG_GUESS));
      assert.equal(right.status, 400, query(WEBHOOK_KEY));
      assert.equal(right.text.includes(UNKNOWN_PROPERTY), true, 'the unknown-property refusal');
      assert.equal(mentionsSecret(right.text), false, 'the refusal gives no oracle on the secret');
      assert.equal(right.text, wrong.text, 'a right and a wrong guess answer alike');
    }
    for (const query of [
      endpointUrl(endpointFetch('<attribute name="name"/><order attribute="saskey"/>')),
      endpointUrl(
        '<fetch aggregate="true"><entity name="serviceendpoint"><attribute name="authvalue" groupby="true" alias="g"/>' +
          '<attribute name="name" aggregate="count" alias="n"/></entity></fetch>',
      ),
      `${ENDPOINTS}?$apply=groupby((sastoken))`,
    ]) {
      const refused = await call('admin', 'GET', query);
      assert.equal(refused.status, 400, query);
      assert.equal(refused.text.includes(UNKNOWN_PROPERTY), true, `${query} names the unknown property`);
    }
  } finally {
    await harness.close();
  }
});

test('an administrator reads no service endpoint credential through SOAP RetrieveMultiple; a guess is no oracle', async () => {
  const harness = await startOrganization();
  try {
    const { call, soap } = harness;
    await seedEndpoints(call);
    const control = await soap(
      'admin',
      retrieveMultiple(queryExpression(['name'], equalCondition('name', 'Invented hook'))),
    );
    assert.equal(control.status, 200);
    assert.equal(entityRows(control.text), 1, 'a condition on a readable column matches the row');

    const columns = await soap('admin', retrieveMultiple(queryExpression(['name', ...CREDENTIALS])));
    assert.equal(mentionsSecret(columns.text), false, 'the ColumnSet answer carries no credential');
    const fetched = endpointFetch(
      `<attribute name="name"/>${CREDENTIALS.map((name) => `<attribute name="${name}"/>`).join('')}`,
    );
    const projected = await soap('admin', retrieveMultiple(fetchExpression(fetched)));
    assert.equal(mentionsSecret(projected.text), false, 'the FetchExpression answer carries no credential');

    const byQuery = (guess) => retrieveMultiple(queryExpression(['name'], equalCondition('authvalue', guess)));
    const byFetch = (guess) =>
      retrieveMultiple(fetchExpression(endpointFetch(`<attribute name="name"/>${condition('authvalue', guess)}`)));
    for (const build of [byQuery, byFetch]) {
      const right = await soap('admin', build(WEBHOOK_KEY));
      const wrong = await soap('admin', build(WRONG_GUESS));
      assert.equal(entityRows(right.text), 0, 'a hidden operand matches no row');
      assert.match(right.text, /<faultstring/, 'the guess is refused as a fault');
      assert.equal(
        withoutTimestamp(right.text),
        withoutTimestamp(wrong.text),
        'a right and a wrong guess answer alike',
      );
    }
  } finally {
    await harness.close();
  }
});

test('a Basic User reads no service endpoint credential through FetchXML or SOAP', async () => {
  const harness = await startOrganization();
  try {
    const { call, soap } = harness;
    await seedEndpoints(call);
    const attributes = CREDENTIALS.map((name) => `<attribute name="${name}"/>`).join('');
    const fetched = await call('basic', 'GET', endpointUrl(endpointFetch(`<attribute name="name"/>${attributes}`)));
    assert.equal(fetched.status, 403);
    assert.equal(mentionsSecret(fetched.text), false);
    const soapRead = await soap('basic', retrieveMultiple(queryExpression(['name', ...CREDENTIALS])));
    assert.equal(mentionsSecret(soapRead.text), false, 'the SOAP answer carries no credential');
    assert.equal(entityRows(soapRead.text), 0);
  } finally {
    await harness.close();
  }
});

test('an administrator reads no service endpoint credential through TDS; a guess of one matches no row', async () => {
  const harness = await startOrganization({ tls: testCertificate });
  try {
    const { call, transport, tokens } = harness;
    await seedEndpoints(call);
    const login = await tdsLogin(transport.tdsPort, tokens.admin, testCertificate.cert);
    try {
      const { client } = login;
      const columns = await tdsQuery(client, 'SELECT name, authvalue, saskey, sastoken FROM serviceendpoint');
      assert.equal(columns.indexOf(utf16(WEBHOOK_KEY)), -1, 'the answer carries no webhook key');
      for (const secret of [SAS_KEY, SAS_TOKEN]) assert.equal(columns.indexOf(utf16(secret)), -1, 'no SAS credential');
      const control = await tdsQuery(client, "SELECT name FROM serviceendpoint WHERE name = 'Invented hook'");
      assert.notEqual(control.indexOf(utf16('Invented hook')), -1, 'a condition on a readable column matches the row');
      const right = await tdsQuery(client, `SELECT name FROM serviceendpoint WHERE authvalue = '${WEBHOOK_KEY}'`);
      const wrong = await tdsQuery(client, `SELECT name FROM serviceendpoint WHERE authvalue = '${WRONG_GUESS}'`);
      assert.equal(right.indexOf(utf16('Invented hook')), -1, 'a hidden operand matches no row');
      assert.equal(right.equals(wrong), true, 'a right and a wrong guess answer alike');
    } finally {
      login.client.close();
    }
  } finally {
    await harness.close();
  }
});
