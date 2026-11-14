// @test-kind security: Microsoft Learn "Tracing and logging" (access to sensitive columns): MessageBlock, Configuration and SecureConfiguration read null for callers that are not System Administrators
// Plug-in trace rows are readable by System Administrators and System Customizers only. The three columns that can hold step text
// or secrets read as null for everyone else, and a filter or order on them is refused. The stored trace row is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPluginTrace } from '../lib/plugin-trace.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { tdsLogin, tdsQuery, utf16 } from './support/tds-client.mjs';
import { APPS, startSecuredOrganization, str, retrieveMultiple, fetchExpression } from './support/secured-reads.mjs';

const testCertificate = createSelfSignedCertificate();

const TRACES = 'plugintracelogs';
const TEXT = 'INVENTED-TRACE-TEXT';
const CONFIG = 'INVENTED-TRACE-CONFIG';
const SECURE = 'INVENTED-TRACE-SECURE';
const SECRETS = [TEXT, CONFIG, SECURE];
const SENSITIVE = ['messageblock', 'configuration', 'secureconfiguration'];
const MASKED = '0x80041155';
// Plug-in trace reads are GET requests; the shared set-up takes the method as an argument.
async function startOrganization(options = {}) {
  const harness = await startSecuredOrganization({ envPrefix: 'PAQ_TRACE_ACCESS', apps: APPS, tls: options.tls });
  return { ...harness, call: (who, route) => harness.call(who, 'GET', route) };
}

const queryExpression = (columns, condition = '') =>
  `<b:value i:type="a:QueryExpression"><a:EntityName>plugintracelog</a:EntityName>` +
  `<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns>${columns.map((name) => `<f:string>${name}</f:string>`).join('')}</a:Columns></a:ColumnSet>` +
  `<a:Criteria><a:FilterOperator>And</a:FilterOperator><a:Conditions>${condition}</a:Conditions><a:Filters/></a:Criteria></b:value>`;
const equalCondition = (name, value) =>
  `<a:ConditionExpression><a:AttributeName>${name}</a:AttributeName><a:Operator>Equal</a:Operator><a:Values>${str(value)}</a:Values></a:ConditionExpression>`;
const entityRows = (text) => (text.match(/<a:Entity[ >]/g) ?? []).length;
// A SOAP fault stamps the time it was built; that stamp is the only part of two refusals that may differ.
const withoutTimestamp = (text) => text.replace(/<Timestamp>[^<]*<\/Timestamp>/g, '');
const traceFetch = (inner) => `<fetch><entity name="plugintracelog">${inner}</entity></fetch>`;
const traceUrl = (fetchXml) => `${TRACES}?fetchXml=${encodeURIComponent(fetchXml)}`;
const WRONG_GUESS = 'INVENTED-WRONG-GUESS';
const RIGHT_GUESS = `conn=${TEXT}`;

async function recordTrace(store) {
  await store.transact(() => {
    store.tableRows('organization')[0].plugintracelogsetting = 2;
    recordPluginTrace(store, {
      typeName: 'Invented.Traced',
      stepId: null,
      messageName: 'Create',
      entity: 'invented_item',
      depth: 1,
      traces: [`conn=${TEXT}`],
      started: 0,
      startedAt: new Date(0).toISOString(),
      configuration: CONFIG,
      secureConfiguration: SECURE,
    });
  });
}

const mentionsSecret = (text) => SECRETS.some((secret) => text.includes(secret));

test('a Basic User cannot read plug-in trace logs; a System Customizer reads them with the sensitive columns null', async () => {
  const harness = await startOrganization();
  try {
    const { store, call } = harness;
    await store.transact(() => {
      store.tableRows('organization')[0].plugintracelogsetting = 2;
      recordPluginTrace(store, {
        typeName: 'Invented.Traced',
        stepId: null,
        messageName: 'Create',
        entity: 'invented_item',
        depth: 1,
        traces: [`conn=${TEXT}`],
        started: 0,
        startedAt: new Date(0).toISOString(),
        configuration: CONFIG,
        secureConfiguration: SECURE,
      });
    });
    const stored = store.tableRows('plugintracelog')[0];
    assert.equal(stored.messageblock, `conn=${TEXT}`, 'the trace row keeps its message block');
    assert.equal(stored.secureconfiguration, SECURE, 'the trace row keeps its secure configuration');

    const basic = await call('basic', TRACES);
    assert.equal(basic.status, 403);
    assert.equal(mentionsSecret(basic.text), false);

    const selected = `${TRACES}?$select=typename,messageblock,configuration,secureconfiguration`;
    const customizer = await call('customizer', selected);
    assert.equal(customizer.status, 200);
    const [row] = customizer.body.value;
    assert.equal(row.typename, 'Invented.Traced');
    for (const column of SENSITIVE) assert.equal(row[column], null, `${column} reads null`);
    assert.equal(mentionsSecret(customizer.text), false, 'the customizer read carries no step text or secret');
    const full = await call('customizer', TRACES);
    assert.equal(full.status, 200);
    assert.equal(mentionsSecret(full.text), false);
    for (const column of SENSITIVE) assert.equal(full.body.value[0][column], null, `full read ${column}`);

    for (const query of [
      `${TRACES}?$filter=messageblock eq 'x'`,
      `${TRACES}?$orderby=configuration`,
      `${TRACES}?$filter=secureconfiguration ne null`,
    ]) {
      const refused = await call('customizer', query);
      assert.equal(refused.status, 400, query);
      assert.equal(refused.text.includes(MASKED), true, `${query} is refused as a masked operand`);
    }

    const admin = await call('admin', selected);
    assert.equal(admin.status, 200);
    const [adminRow] = admin.body.value;
    assert.equal(adminRow.messageblock, `conn=${TEXT}`);
    assert.equal(adminRow.configuration, CONFIG);
    assert.equal(adminRow.secureconfiguration, SECURE);
    const adminFilter = await call('admin', `${TRACES}?$filter=messageblock eq 'conn=${TEXT}'`);
    assert.equal(adminFilter.status, 200);
    assert.equal(adminFilter.body.value.length, 1);
  } finally {
    await harness.close();
  }
});

test('a System Customizer reads no sensitive trace column through a FetchXML projection; an administrator still reads it', async () => {
  const harness = await startOrganization();
  try {
    const { store, call } = harness;
    await recordTrace(store);
    for (const inner of [
      '<attribute name="messageblock"/><attribute name="configuration"/><attribute name="secureconfiguration"/>',
      '<all-attributes/>',
    ]) {
      const read = await call('customizer', traceUrl(traceFetch(inner)));
      assert.equal(read.status, 200, inner);
      assert.equal(mentionsSecret(read.text), false, `${inner} carries no step text or secret`);
      for (const column of SENSITIVE) assert.equal(read.body.value[0][column] ?? null, null, `${inner} ${column}`);
    }
    const admin = await call(
      'admin',
      traceUrl(
        traceFetch(
          `<attribute name="messageblock"/><attribute name="configuration"/><filter><condition attribute="messageblock" operator="eq" value="${RIGHT_GUESS}"/></filter>`,
        ),
      ),
    );
    assert.equal(admin.status, 200);
    assert.equal(admin.body.value.length, 1, 'an administrator matches the row on the column');
    assert.equal(admin.body.value[0].configuration, CONFIG, 'an administrator reads the configuration');
  } finally {
    await harness.close();
  }
});

test('a guess of a sensitive trace column through FetchXML or $apply is refused alike, with no oracle', async () => {
  const harness = await startOrganization();
  try {
    const { store, call } = harness;
    await recordTrace(store);
    const control = await call(
      'customizer',
      traceUrl(
        traceFetch(
          '<attribute name="typename"/><filter><condition attribute="typename" operator="eq" value="Invented.Traced"/></filter>',
        ),
      ),
    );
    assert.equal(control.status, 200);
    assert.equal(control.body.value.length, 1, 'a condition on a readable column matches the row');

    const conditioned = (guess) =>
      traceUrl(
        traceFetch(
          `<attribute name="typename"/><filter><condition attribute="messageblock" operator="eq" value="${guess}"/></filter>`,
        ),
      );
    const applied = (guess) => `${TRACES}?$apply=filter(messageblock eq '${guess}')/groupby((typename))`;
    for (const query of [conditioned, applied]) {
      const right = await call('customizer', query(RIGHT_GUESS));
      const wrong = await call('customizer', query(WRONG_GUESS));
      assert.equal(right.status, 400, query(RIGHT_GUESS));
      assert.equal(right.text.includes(MASKED), true, 'a masked operand is refused');
      assert.equal(right.text, wrong.text, 'a right and a wrong guess answer alike');
    }
    for (const query of [
      traceUrl(traceFetch('<attribute name="typename"/><order attribute="configuration"/>')),
      traceUrl(
        '<fetch aggregate="true"><entity name="plugintracelog"><attribute name="messageblock" groupby="true" alias="g"/>' +
          '<attribute name="typename" aggregate="count" alias="n"/></entity></fetch>',
      ),
      `${TRACES}?$apply=groupby((messageblock))`,
    ]) {
      const refused = await call('customizer', query);
      assert.equal(refused.status, 400, query);
      assert.equal(refused.text.includes(MASKED), true, `${query} is refused as a masked operand`);
    }
  } finally {
    await harness.close();
  }
});

test('a System Customizer reads no sensitive trace column through SOAP RetrieveMultiple; a guess is no oracle', async () => {
  const harness = await startOrganization();
  try {
    const { store, soap } = harness;
    await recordTrace(store);
    const sensitive = ['messageblock', 'configuration', 'secureconfiguration'];
    const control = await soap(
      'customizer',
      retrieveMultiple(queryExpression(['typename'], equalCondition('typename', 'Invented.Traced'))),
    );
    assert.equal(control.status, 200);
    assert.equal(entityRows(control.text), 1, 'a condition on a readable column matches the row');

    const columns = await soap('customizer', retrieveMultiple(queryExpression(sensitive)));
    assert.equal(mentionsSecret(columns.text), false, 'the ColumnSet answer carries no step text or secret');
    const fetched = traceFetch(sensitive.map((name) => `<attribute name="${name}"/>`).join(''));
    const projected = await soap('customizer', retrieveMultiple(fetchExpression(fetched)));
    assert.equal(mentionsSecret(projected.text), false, 'the FetchExpression answer carries no step text or secret');

    const byQuery = (guess) => retrieveMultiple(queryExpression(['typename'], equalCondition('messageblock', guess)));
    const byFetch = (guess) =>
      retrieveMultiple(
        fetchExpression(
          traceFetch(
            `<attribute name="typename"/><filter><condition attribute="messageblock" operator="eq" value="${guess}"/></filter>`,
          ),
        ),
      );
    for (const build of [byQuery, byFetch]) {
      const right = await soap('customizer', build(RIGHT_GUESS));
      const wrong = await soap('customizer', build(WRONG_GUESS));
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

test('a System Customizer reads no sensitive trace column through TDS; a guess of one matches no row', async () => {
  const harness = await startOrganization({ tls: testCertificate });
  try {
    const { store, transport, tokens } = harness;
    await recordTrace(store);
    const login = await tdsLogin(transport.tdsPort, tokens.customizer, testCertificate.cert);
    try {
      const { client } = login;
      const columns = await tdsQuery(
        client,
        'SELECT typename, messageblock, configuration, secureconfiguration FROM plugintracelog',
      );
      for (const secret of SECRETS) assert.equal(columns.indexOf(utf16(secret)), -1, 'the answer carries no secret');
      const control = await tdsQuery(client, "SELECT typename FROM plugintracelog WHERE typename = 'Invented.Traced'");
      assert.notEqual(
        control.indexOf(utf16('Invented.Traced')),
        -1,
        'a condition on a readable column matches the row',
      );
      const right = await tdsQuery(client, `SELECT typename FROM plugintracelog WHERE messageblock = '${RIGHT_GUESS}'`);
      const wrong = await tdsQuery(client, `SELECT typename FROM plugintracelog WHERE messageblock = '${WRONG_GUESS}'`);
      assert.equal(right.indexOf(utf16('Invented.Traced')), -1, 'a hidden operand matches no row');
      assert.equal(right.equals(wrong), true, 'a right and a wrong guess answer alike');
    } finally {
      login.client.close();
    }
  } finally {
    await harness.close();
  }
});
