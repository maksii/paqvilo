import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DataStore } from '../lib/data.mjs';
import { createSimulator } from '../server.mjs';
import { localOrganizationService, sdkValueToRecord } from '../lib/local-organization-service.mjs';
import { prepareClrRuntime, recordToSdkEntity } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { resolveFlowValue, executeFlowDefinition } from '../lib/flow-runtime.mjs';
import {
  parseExactJson,
  stringifyExactJson,
  exactNumeric,
  compareNumeric,
  roundNumeric,
  averageNumeric,
} from '../lib/exact-numeric.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const id = '20000000-0000-0000-0000-000000000001',
  user = '10000000-0000-0000-0000-000000000001';
const fields = {
  precisionrowid: { dataverseType: 'uniqueidentifier' },
  counter: { dataverseType: 'bigint', minValue: '-9223372036854775808', maxValue: '9223372036854775807' },
  quantity: { dataverseType: 'decimal', precision: 10, minValue: '-100000000000', maxValue: '100000000000' },
  price: { dataverseType: 'money', precision: 4, minValue: '-100000000000', maxValue: '100000000000' },
};
const initial = {
  version: 1,
  mappings: {
    widget: { entitySet: 'widgets', idColumn: 'widgetid' },
    precisionrow: { entitySet: 'precisionrows', idColumn: 'precisionrowid', schemaComplete: true, fields },
  },
  tables: { widget: [], precisionrow: [] },
  plugins: [],
  settings: { permissionMode: 'permissive' },
};
const profile = {
  userId: user,
  evidence: 'Invented exact numeric column source',
  grants: [{ entity: 'precisionrow', operations: ['read', 'create', 'update', 'delete'] }],
};
// A hang guard for the one-file csc.exe build of the invented plug-in; a normal build finishes in about a second.
const COMPILE_TIMEOUT_MS = 150_000;
const text = (value) => (typeof value === 'object' ? value.value : String(value));
const typed = (type, value) => ({ $type: type, value });

test('Exact numeric arithmetic bounds precision and never accepts forged JSON scalar objects', () => {
  assert.equal(compareNumeric(exactNumeric('9007199254740993', 'Int64'), '9007199254740992'), 1);
  assert.equal(text(roundNumeric(exactNumeric('-99999999999.12345678995'), 10)), '-99999999999.12345679');
  assert.equal(
    text(
      averageNumeric([exactNumeric('9007199254740993', 'Int64'), exactNumeric('9007199254740995', 'Int64')], {
        integer: true,
      }),
    ),
    '9007199254740994',
  );
  assert.equal(
    stringifyExactJson(parseExactJson('{"value":9007199254740993,"decimal":99999999999.1234567891}')),
    '{"value":9007199254740993,"decimal":99999999999.1234567891}',
  );
  assert.throws(
    () => parseExactJson('{"value":{"$type":"DataverseNumeric","numericType":"Int64","value":"9"}}'),
    /Internal numeric/,
  );
  assert.throws(() => exactNumeric('1e1000000'), /bounded/);
  assert.throws(() => averageNumeric([exactNumeric('0.0000000000000000000000000001'), 0, 0]), /Recurring exact/);
});

test('Source decimal aggregation stays decimal for safe values and local flow read outputs keep numeric semantics', () => {
  const state = structuredClone(initial);
  state.tables.precisionrow = [1, 2, 3].map((n) => ({
    precisionrowid: '20000000-0000-0000-0000-' + String(n).padStart(12, '0'),
    quantity: 0.1,
    counter: n,
  }));
  const store = new DataStore({ state }),
    backend = localOrganizationService(store, profile);
  assert.equal(backend.query('precisionrow', { $apply: 'aggregate(quantity with sum as total)' }).value[0].total, 0.3);
  assert.equal(
    backend.fetch(
      '<fetch aggregate="true"><entity name="precisionrow"><attribute name="quantity" alias="total" aggregate="sum"/></entity></fetch>',
    ).entities[0].total,
    0.3,
  );
  const context = {
    input: {
      counter: exactNumeric('9007199254740993', 'Int64'),
      quantity: exactNumeric('99999999999.1234567891', 'Decimal'),
    },
    variables: {},
    parameters: {},
    results: {},
    items: [],
  };
  assert.equal(text(resolveFlowValue("@add(triggerBody()['counter'],1)", context)), '9007199254740994');
  assert.equal(resolveFlowValue("@equals(triggerBody()['counter'],9007199254740992)", context), false);
  assert.equal(resolveFlowValue("@greater(triggerBody()['counter'],9007199254740992)", context), true);
  assert.equal(resolveFlowValue("@string(triggerBody()['quantity'])", context), '99999999999.1234567891');
  assert.equal(text(resolveFlowValue("@int('9223372036854775807')", context)), '9223372036854775807');
  assert.equal(text(resolveFlowValue("@div(triggerBody()['counter'],3)", context)), '3002399751580331');
  assert.throws(() => resolveFlowValue("@int('9223372036854775808')", context), /exceeds Int64/);
  const definition = {
    triggers: { request: { type: 'Request', kind: 'powerpages' } },
    actions: {
      initialize: {
        type: 'InitializeVariable',
        inputs: { variables: [{ name: 'counter', type: 'integer', value: "@triggerBody()['counter']" }] },
      },
      increment: {
        type: 'IncrementVariable',
        runAfter: { initialize: ['Succeeded'] },
        inputs: { name: 'counter', value: 1 },
      },
      reply: {
        type: 'Response',
        runAfter: { increment: ['Succeeded'] },
        inputs: { body: { counter: "@variables('counter')" } },
      },
    },
  };
  const answer = executeFlowDefinition({ definition, input: context.input });
  assert.equal(text(answer.body.counter), '9007199254740994');
});

test('Typed SDK numeric columns survive persisted reload, exact bounds, OData and Fetch ordering/aggregation', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-exact-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DataStore({ state: initial, file: path.join(root, 'state.json') }),
    service = localOrganizationService(store, profile);
  await store.transact(() =>
    service.create('precisionrow', {
      precisionrowid: id,
      counter: sdkValueToRecord(typed('Int64', '9223372036854775807')),
      quantity: sdkValueToRecord(typed('Decimal', '99999999999.1234567891')),
      price: sdkValueToRecord(typed('Money', '99999999999.1234')),
    }),
  );
  const saved = JSON.parse(await fs.readFile(store.file, 'utf8')),
    reload = new DataStore({ state: saved }),
    row = reload.get('precisionrow', id, { admin: true });
  assert.equal(text(row.counter), '9223372036854775807');
  assert.equal(text(row.quantity), '99999999999.1234567891');
  assert.equal(text(row.price), '99999999999.1234');
  const sdk = recordToSdkEntity(reload, 'precisionrow', row);
  assert.deepEqual(sdk.attributes.counter, typed('Int64', '9223372036854775807'));
  assert.deepEqual(sdk.attributes.quantity, typed('Decimal', '99999999999.1234567891'));
  assert.deepEqual(sdk.attributes.price, typed('Money', '99999999999.1234'));
  const backend = localOrganizationService(reload, profile);
  assert.equal(
    backend.query('precisionrow', { $filter: 'counter eq 9223372036854775806', $select: 'counter' }).value.length,
    0,
  );
  assert.equal(
    backend.query('precisionrow', { $filter: 'quantity gt 99999999999.1234567890', $select: 'counter' }).value.length,
    1,
  );
  assert.equal(
    backend.query('precisionrow', { $filter: 'quantity eq 99999999999.1234567892', $select: 'counter' }).value.length,
    0,
  );
  const before = reload.snapshot();
  assert.throws(
    () => backend.update('precisionrow', id, { counter: exactNumeric('9223372036854775808', 'Int64') }),
    /Edm.Int64/,
  );
  assert.deepEqual(reload.snapshot(), before);
  assert.throws(
    () => backend.update('precisionrow', id, { quantity: exactNumeric('9223372036854775807', 'Int64') }),
    /Edm.Decimal/,
  );
  assert.throws(
    () => backend.update('precisionrow', id, { unknown: exactNumeric('9007199254740993', 'Int64') }),
    /numeric column metadata/,
  );
  assert.deepEqual(reload.snapshot(), before);
  assert.throws(
    () => backend.update('precisionrow', id, { quantity: exactNumeric('100000000000.0000000001', 'Decimal') }),
    /outside the valid range/,
  );
  assert.deepEqual(reload.snapshot(), before);
  const next = '20000000-0000-0000-0000-000000000002';
  await reload.transact(() =>
    backend.create('precisionrow', {
      precisionrowid: next,
      counter: exactNumeric('9223372036854775806', 'Int64'),
      quantity: exactNumeric('99999999999.1234567890', 'Decimal'),
    }),
  );
  assert.deepEqual(
    backend.query('precisionrow', { $select: 'counter', $orderby: 'counter asc' }).value.map((r) => text(r.counter)),
    ['9223372036854775806', '9223372036854775807'],
  );
  const fetch = backend.fetch(
    '<fetch><entity name="precisionrow"><attribute name="counter"/><filter><condition attribute="counter" operator="eq" value="9223372036854775806"/></filter></entity></fetch>',
  );
  assert.equal(fetch.entities.length, 1);
  assert.equal(text(fetch.entities[0].counter), '9223372036854775806');
  const page1 = backend.fetch(
    '<fetch count="1" page="1"><entity name="precisionrow"><attribute name="counter"/><order attribute="counter"/></entity></fetch>',
  );
  assert.equal(text(page1.entities[0].counter), '9223372036854775806');
  assert.ok(page1.more_records);
  const cookie = page1.paging_cookie.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const page2 = backend.fetch(
    '<fetch count="1" page="2" paging-cookie="' +
      cookie +
      '"><entity name="precisionrow"><attribute name="counter"/><order attribute="counter"/></entity></fetch>',
  );
  assert.equal(text(page2.entities[0].counter), '9223372036854775807');
  const aggregate = backend.fetch(
    '<fetch aggregate="true"><entity name="precisionrow"><attribute name="counter" alias="total" aggregate="sum"/></entity></fetch>',
  );
  assert.equal(text(aggregate.entities[0].total), '18446744073709551613');
  const apply = backend.query('precisionrow', { $apply: 'aggregate(counter with sum as total)' });
  assert.equal(text(apply.value[0].total), '18446744073709551613');
});

test('Loopback API reads and writes numeric JSON literals without rounding their digits or quoting them', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-exact-http-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: invented-precision\nadx_name: Precision\n');
  await fs.writeFile(
    path.join(root, 'sitesetting.yml'),
    "- adx_name: Webapi/precisionrow/enabled\n  adx_value: 'true'\n- adx_name: Webapi/precisionrow/fields\n  adx_value: 'precisionrowid,counter,quantity,price'\n",
  );
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      ...initial,
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identityScope: 'configured',
        identity: { id: 'precision-persona', roles: [] },
        live: {},
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const response = await fetch(app.url + '/_api/precisionrows', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      __RequestVerificationToken: app.csrf,
      Prefer: 'return=representation',
    },
    body:
      '{"precisionrowid":"' +
      id +
      '","counter":9223372036854775807,"quantity":99999999999.1234567891,"price":99999999999.1234}',
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  assert.match(body, /"counter":9223372036854775807/);
  assert.match(body, /"quantity":99999999999\.1234567891/);
  assert.match(body, /"price":99999999999\.1234/);
  assert.doesNotMatch(body, /DataverseNumeric/);
  const read = await fetch(app.url + '/_api/precisionrows(' + id + ')?$select=counter,quantity,price');
  assert.equal(read.status, 200);
  assert.match(await read.text(), /"counter":9223372036854775807/);
  const raw = await fetch(app.url + '/_api/precisionrows(' + id + ')/counter/$value');
  assert.equal(await raw.text(), '9223372036854775807');
  const rejected = await fetch(app.url + '/_api/precisionrows(' + id + ')', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    body: '{"counter":9223372036854775808}',
  });
  assert.equal(rejected.status, 400);
});

test(
  'Original DLL retains Int64/Decimal/Money through service writes and actual SDK query/retrieval casts',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-exact-clr-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'PrecisionOriginal.cs'),
      assembly = path.join(root, 'PrecisionOriginal.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class PrecisionOriginal:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var row=new Entity("precisionrow",new Guid("${id}"));row["counter"]=9223372036854775807L;row["quantity"]=99999999999.1234567891m;row["price"]=new Money(99999999999.1234m);s.Create(row);
var received=s.Retrieve("precisionrow",row.Id,new ColumnSet("counter","quantity","price"));if(received.GetAttributeValue<long>("counter")!=9223372036854775807L||received.GetAttributeValue<decimal>("quantity")!=99999999999.1234567891m||received.GetAttributeValue<Money>("price").Value!=99999999999.1234m)throw new Exception("Numeric SDK value or type lost");
var q=new QueryExpression("precisionrow"){ColumnSet=new ColumnSet("counter","quantity")};q.Criteria.AddCondition("counter",ConditionOperator.Equal,9223372036854775806L);if(s.RetrieveMultiple(q).Entities.Count!=0)throw new Exception("Adjacent Int64 values conflated");q.Criteria.Conditions.Clear();q.Criteria.AddCondition("quantity",ConditionOperator.Equal,99999999999.1234567891m);if(s.RetrieveMultiple(q).Entities.Count!=1)throw new Exception("Exact decimal query lost");
var link=q.AddLink("precisionrow","precisionrowid","precisionrowid");link.EntityAlias="precise";link.Columns=new ColumnSet("quantity");link.LinkCriteria.AddCondition("quantity",ConditionOperator.GreaterThan,99999999999.1234567890m);var joined=s.RetrieveMultiple(q);if(joined.Entities.Count!=1||(decimal)((AliasedValue)joined.Entities[0]["precise.quantity"]).Value!=99999999999.1234567891m)throw new Exception("Typed linked decimal or predicate lost");
((Entity)c.InputParameters["Target"])["title"]="Precision original passed";((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original exact numeric casts and queries passed");}}}`,
    );
    const build = spawnSync(
      path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:library', '/out:' + assembly, '/reference:' + sdk, source],
      { shell: false, windowsHide: true, encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.PrecisionOriginal',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: {
        initiatingUserId: user,
        organizationId: '50000000-0000-0000-0000-000000000001',
        businessUnitId: '60000000-0000-0000-0000-000000000001',
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const step = {
        id: '30000000-0000-0000-0000-000000000001',
        name: 'Invented precision',
        assemblyId: 'invented-precision',
        enabled: true,
        entity: 'widget',
        message: 'Create',
        stage: 20,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.PrecisionOriginal',
      },
      runtimes = new Map([[step.id, runtime]]),
      store = new DataStore({ state: initial, file: path.join(root, 'state.json') }),
      notes = [];
    store.setPluginPipeline((context) =>
      runPluginPhase({
        ...context,
        store,
        runtimes,
        items: pluginCatalogue({
          plugins: { steps: [step] },
          runtimes,
          overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
        }),
        diagnostic: (note) => notes.push(note),
      }),
    );
    await store.create('widget', { title: 'Before' }, { admin: true });
    assert.equal(store.snapshot().tables.widget[0].title, 'Precision original passed');
    const reloaded = new DataStore({ state: JSON.parse(await fs.readFile(store.file, 'utf8')) });
    assert.equal(
      recordToSdkEntity(reloaded, 'precisionrow', reloaded.get('precisionrow', id, { admin: true })).attributes.quantity
        .value,
      '99999999999.1234567891',
    );
    const hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].absenceVerified, true, 'the owned CLR host is verified gone');
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (file) =>
        createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.precision.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            scope: 'Actual compiled invented original DLL; native numeric wire not yet qualified',
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: hosts.length, allAbsenceVerified: true },
            assertionScopes: [
              'Exact typed Int64/Decimal/Money SDK storage and casts',
              'Adjacent large integer and high precision decimal query predicates',
              'Saved-state reload retains exact numeric value',
            ],
            nativeQualified: false,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    }
  },
);
