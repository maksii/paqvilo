// @test-kind contract: HTTP fixture setup, local diagnostic stack policy, SDK compatibility and nonmutation checks; native scalar assertions are tagged individually below.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webApiScalarReaderCases } from '../testing/webapi-contract.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { install, parseCustomApiFiles } from '../lib/dataverse-customapi.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';

const APP = '10000000-0000-4000-8000-000000000001',
  ID = '20000000-0000-4000-8000-000000000001';
const SECRET = 'PAQVILO_SCALAR_READER_TEST_SECRET';
const nativeCause = (literal, target, source) =>
  `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> Microsoft.OData.ODataException: Cannot convert a value of type '${source}' to the expected target type '${target}'.`;
const nativeFormat = (literal, target, cause) =>
  `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> System.FormatException: ${cause}`;

test('HTTP scalar errors retain native type/format causes and exact numeric tokens without inventing CLR stacks', async (t) => {
  const previous = process.env[SECRET];
  process.env[SECRET] = 'invented-loopback-secret';
  const state = emptyState();
  state.mappings.sample = {
    logicalName: 'sample',
    entitySet: 'samples',
    idColumn: 'sampleid',
    nameColumn: 'name',
    fields: {
      name: { dataverseType: 'nvarchar' },
      quantity: { dataverseType: 'int' },
      enabled: { dataverseType: 'bit' },
      amount: { dataverseType: 'decimal' },
      price: { dataverseType: 'money' },
      ratio: { dataverseType: 'float' },
      stamp: { dataverseType: 'datetime' },
      day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
      choice: { dataverseType: 'picklist' },
      tags: { dataverseType: 'multiselectpicklist' },
    },
  };
  state.tables.sample = [
    {
      sampleid: ID,
      name: 'Unchanged',
      quantity: 7,
      enabled: true,
      amount: 1.25,
      price: 2.5,
      ratio: 1.5,
      stamp: '2020-01-15T12:00:00Z',
      day: '2020-01-15',
      choice: 1,
      tags: '1',
    },
  ];
  const store = await new DataStore({ state }).init(),
    api = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: 'Invented reader client',
            secretEnvironmentVariable: SECRET,
            roles: ['System Administrator'],
          },
        ],
      }),
      log: () => {},
    });
  ownedFixture(t).add(async () => {
    await api.close();
    if (previous === undefined) delete process.env[SECRET];
    else process.env[SECRET] = previous;
  });
  const auth = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[SECRET],
      scope: `${api.origin}/.default`,
    }),
  });
  assert.equal(auth.status, 200);
  const token = (await auth.json()).access_token;
  const initial = JSON.stringify(store.state.tables.sample);
  const cases = webApiScalarReaderCases();
  const diagnostics = [];
  const encodedCases = cases.flatMap((entry, index) =>
    [
      ['plain', ''],
      ['UTF-8 BOM', '\uFEFF'],
    ].map(([encoding, prefix]) => [...entry, encoding, prefix, index]),
  );
  for (const [field, tokenText, cause, encoding, prefix, index] of encodedCases)
    for (const method of ['POST', 'PATCH'])
      // @test-kind observation: fixtures/webapi-native-scalar-reader.json records per case the status, code and first cause line plus two native raw-response hashes, with the request built by the shared producer in mirage/testing; no full native body is recorded, so not a replay case.
      await t.test(`${encoding} ${method} ${field} ${tokenText}`, async () => {
        const nativeBytes = fs.readFileSync(new URL('./fixtures/webapi-native-scalar-reader.json', import.meta.url));
        const nativeProof = JSON.parse(nativeBytes);
        const expected = nativeProof.cases.find(
          (entry) => entry.id === `reader.${index}.${prefix ? 'bom' : 'plain'}.${method}`,
        );
        assert.deepEqual(
          { field, token: tokenText, cause, encoding: prefix ? 'bom' : 'plain', method },
          {
            field: expected.field,
            token: expected.token,
            cause: expected.cause,
            encoding: expected.encoding,
            method: expected.method,
          },
        );
        const response = await fetch(
          api.origin + '/api/data/v9.2/' + (method === 'POST' ? 'samples' : `samples(${ID})`),
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: prefix + `{"${field}":${tokenText}}`,
          },
        );
        assert.equal(response.status, expected.status);
        const error = (await response.json()).error;
        assert.equal(error.code, expected.code);
        assert.ok(error.message.includes(expected.cause), error.message);
        assert.ok(error.message.includes(method === 'POST' ? "Entity :'samples'" : "Entity :''"));
        diagnostics.push(error.message);
      });
  // @test-kind observation: completeness of the 68-case native scalar universe recorded in fixtures/webapi-native-scalar-reader.json against the shared producer bytes; not a replay case.
  await t.test('all68 original native scalar cases execute', () => {
    assert.equal(diagnostics.length, 68);
  });
  assert.ok(
    diagnostics.every((message) => !message.includes('   at ')),
    'default local diagnostic mode does not fabricate CLR stack frames',
  );
  for (const prefix of ['', '\uFEFF']) {
    const response = await fetch(api.origin + '/api/data/v9.2/samples(20000000-0000-4000-8000-000000000099)', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'if-match': '*',
      },
      body: prefix + '{"quantity":1}',
    });
    assert.equal(response.status, 404, 'Valid JSON reaches the update-only missing-record check with or without a BOM');
  }
  assert.equal(JSON.stringify(store.state.tables.sample), initial, 'all failed HTTP conversions are nonmutating');
  assert.throws(
    () => store.coerceRecord(store.state.mappings.sample, { name: false }, { dataverseWebApi: true }),
    (e) =>
      e.message.includes("'false'") && !e.message.includes('InnerException') && !e.message.includes("Edm.Boolean' to"),
  );
  assert.throws(
    () => store.coerceRecord(store.state.mappings.sample, { quantity: 'bad' }, { coerce: true }),
    (e) => !e.message.includes('InnerException') && !e.message.includes('System.FormatException'),
  );
});

test('custom API actions obtain scalar causes through the actual HTTP transport', async (t) => {
  const variable = 'PAQVILO_CUSTOM_SCALAR_READER_TEST_SECRET';
  process.env[variable] = 'Invented custom reader secret';
  t.after(() => delete process.env[variable]);
  const state = emptyState(),
    files = [
      {
        path: 'sample_Check/customapi.xml',
        text: '<customapi uniquename="sample_Check"><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>',
      },
      ...Object.entries({ Count: 7, Flag: 0, Name: 10, Labels: 11 }).map(([name, type]) => ({
        path: `sample_Check/customapirequestparameters/${name}/customapirequestparameter.xml`,
        text: `<customapirequestparameter uniquename="${name}"><type>${type}</type><isoptional>1</isoptional></customapirequestparameter>`,
      })),
    ];
  Object.assign(state.tables, parseCustomApiFiles(files));
  const store = await new DataStore({ state }).init();
  let calls = 0;
  const extensions = await sourceOrganizationExtensions({
    customApis: new Map([
      [
        'sample_check',
        {
          handler: async () => {
            calls++;
            return { outputs: {} };
          },
        },
      ],
    ]),
  });
  const organization = await createOrganizationRuntime({
    store,
    extensions,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP,
          displayName: 'Invented custom reader',
          secretEnvironmentVariable: variable,
          roles: ['System Administrator'],
        },
      ],
    }),
  });
  ownedFixture(t).add(() => organization.close());
  const transport = await startDataverseApi({ organization });
  ownedFixture(t).add(() => transport.close());
  const tokenResponse = await fetch(transport.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[variable],
      scope: transport.origin + '/.default',
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  for (const [body, cause, prefix] of [
    [{ Count: 'bad' }, nativeFormat('bad', 'Edm.Int32', 'Input string was not in a correct format.')],
    [{ Flag: 1 }, nativeCause('1', 'Edm.Boolean', 'Edm.Int32')],
    [{ Name: false }, nativeCause('False', 'Edm.String', 'Edm.Boolean')],
    [{ Labels: ['valid', 1] }, nativeCause('1', 'Edm.String', 'Edm.Int32')],
  ].flatMap((entry) => ['', '\uFEFF'].map((prefix) => [...entry, prefix]))) {
    const response = await fetch(transport.origin + '/api/data/v9.2/sample_Check', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: prefix + JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const message = (await response.json()).error.message;
    assert.ok(message.includes(cause), message);
  }
  assert.equal(calls, 0, 'invalid parameters never execute custom logic');
});

test('custom API internal callers retain original diagnostics while the actual HTTP reader carries native causes', async () => {
  const files = [
    {
      path: 'sample_Action/customapi.xml',
      text: '<customapi uniquename="sample_Action"><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>',
    },
    ...Object.entries({ Count: 7, Flag: 0, Name: 10, Labels: 11 }).map(([name, type]) => ({
      path: `sample_Action/customapirequestparameters/${name}/customapirequestparameter.xml`,
      text: `<customapirequestparameter uniquename="${name}"><type>${type}</type><isoptional>1</isoptional></customapirequestparameter>`,
    })),
  ];
  const state = emptyState(),
    rows = parseCustomApiFiles(files);
  Object.assign(state.tables, rows);
  const store = new DataStore({ state }),
    ops = [];
  // Awaited: install also queues its seeding transaction, which must not outlive the test.
  await install({
    store,
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op), has: () => false },
    principals: { privileges: () => new Map() },
  }).ready;
  const op = ops.find((op) => op.name === 'sample_Action');
  assert.ok(op);
  for (const [body, fragment] of [
    [{ Count: 'bad' }, 'System.FormatException'],
    [{ Flag: 1 }, "type 'Edm.Int32'"],
    [{ Name: false }, "literal 'False'"],
    [{ Labels: ['valid', 1] }, "type 'Edm.Int32'"],
  ]) {
    const context = {
      method: 'POST',
      body,
      url: new URL('http://127.0.0.1/api/data/v9.2/sample_Action'),
      user: { systemuserid: ID },
      origin: 'http://127.0.0.1',
      version: 'v9.2',
    };
    await assert.rejects(
      () => op.handle(context),
      (e) => e.status === 400 && !e.message.includes('System.FormatException') && !e.message.includes(' ---> '),
    );
    // This marker is produced only by the real Dataverse HTTP transport. The
    // end-to-end record test above independently verifies that boundary.
    const source = JSON.stringify(body);
    context.dataverseHttpReader = {
      hasJsonBody: true,
      ieee754Compatible: false,
      numberLexemeFor: () => (source.includes(':1') || source.includes(',1') ? '1' : undefined),
    };
    await assert.rejects(
      () => op.handle(context),
      (e) => e.status === 400 && e.message.includes(fragment) && !e.message.includes('   at '),
    );
    for (const [method, hasJsonBody] of [
      ['POST', false],
      ['GET', false],
      ['GET', true],
    ]) {
      // A URI function or a non-JSON caller has no qualified JSON-reader cause,
      // even if an HTTP transport marker is present.
      store.state.tables.customapi[0].isfunction = method === 'GET';
      await assert.rejects(
        () =>
          op.handle({
            ...context,
            method,
            ...(method === 'GET' ? { body: undefined, params: body } : {}),
            dataverseHttpReader: { ...context.dataverseHttpReader, hasJsonBody },
          }),
        (error) =>
          error.status === 400 &&
          !error.message.includes('System.FormatException') &&
          !error.message.includes(' ---> '),
      );
      store.state.tables.customapi[0].isfunction = false;
    }
  }
});
