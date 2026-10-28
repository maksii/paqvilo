import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { DataError } from '../lib/data.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { webApiErrorResponse } from '../lib/webapi-handler.mjs';
import { attachODataReaderDetails, odataConversionDetails } from '../lib/webapi-error-details.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const prefix =
  "Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : ";
async function fixture(t, mode) {
  const source = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-reader-error-'));
  ownedFixture(t).remove(() => fs.rm(source, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(source, 'website.yml'),
    'adx_websiteid: invented-reader-site\nadx_name: Reader fixture\n',
  );
  await fs.writeFile(
    path.join(source, 'sitesetting.yml'),
    '- adx_name: Webapi/probe/enabled\n  adx_value: "true"\n- adx_name: Webapi/probe/fields\n  adx_value: "probeid,title,quantity,amount,ratio,enabled,day,externalid"\n- adx_name: Webapi/error/innererror\n  adx_value: "true"\n',
  );
  const app = await createSimulator({
    sourceDir: source,
    watch: false,
    observed: { webApiErrorDetails: mode, evidence: 'Invented loopback reader fixture' },
    initial: {
      mappings: {
        probe: {
          entitySet: 'probes',
          idColumn: 'probeid',
          schemaComplete: true,
          fields: {
            probeid: { dataverseType: 'uniqueidentifier' },
            title: { dataverseType: 'nvarchar', maxLength: 30 },
            quantity: { dataverseType: 'int', minValue: 0, maxValue: 10 },
            amount: { dataverseType: 'decimal' },
            ratio: { dataverseType: 'float' },
            enabled: { dataverseType: 'bit' },
            day: { dataverseType: 'datetime' },
            externalid: { dataverseType: 'uniqueidentifier' },
          },
        },
      },
      tables: { probe: [{ probeid: id, title: 'Original', quantity: 2 }] },
      settings: { permissionMode: 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  // app.state() clones the whole state, so send() reads the token once per runtime.
  return app;
}
async function send(app, raw, { method = 'PATCH', contentType = 'application/json' } = {}) {
  const response = await fetch(app.url + '/_api/probes' + (method === 'POST' ? '' : '(' + id + ')'), {
    method,
    headers: { 'content-type': contentType, __RequestVerificationToken: app.csrf },
    body: raw,
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

test('observed reader messages preserve native classes and causes without changing rejected writes', async (t) => {
  const app = await fixture(t, 'odata-wrapper'),
    baseline = app.store.snapshot().tables;
  const cases = [
    [
      '{"quantity":1.5}',
      "Microsoft.OData.ODataException: Cannot convert the literal '1.5' to the expected type 'Edm.Int32'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Decimal' to the expected target type 'Edm.Int32'.",
    ],
    [
      '{"quantity":2147483648}',
      "Microsoft.OData.ODataException: Cannot convert the literal '2147483648' to the expected type 'Edm.Int32'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Decimal' to the expected target type 'Edm.Int32'.",
    ],
    [
      '{"quantity":"oops"}',
      "Microsoft.OData.ODataException: Cannot convert the literal 'oops' to the expected type 'Edm.Int32'. ---> System.FormatException: Input string was not in a correct format.",
    ],
    [
      '{"ratio":"oops"}',
      "Microsoft.OData.ODataException: Cannot convert the literal 'oops' to the expected type 'Edm.Double'. ---> System.FormatException: Input string was not in a correct format.",
    ],
    [
      '{"amount":"1.2"}',
      "Microsoft.OData.ODataException: Cannot convert a value to target type 'Edm.Decimal' because of conflict between input format string/number and parameter 'IEEE754Compatible' false/true.",
    ],
    [
      '{"amount":{}}',
      "Microsoft.OData.ODataException: An unexpected 'StartObject' node was found for property named 'amount' when reading from the JSON reader. A 'PrimitiveValue' node was expected.",
    ],
    [
      '{"enabled":1}',
      "Microsoft.OData.ODataException: Cannot convert the literal '1' to the expected type 'Edm.Boolean'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Int32' to the expected target type 'Edm.Boolean'.",
    ],
    [
      '{"title":42}',
      "Microsoft.OData.ODataException: Cannot convert the literal '42' to the expected type 'Edm.String'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Int32' to the expected target type 'Edm.String'.",
    ],
    [
      '{"day":"2026-02-30T00:00:00Z"}',
      "Microsoft.OData.ODataException: Cannot convert the literal '2026-02-30T00:00:00Z' to the expected type 'Edm.DateTimeOffset'. ---> System.FormatException: The string '2026-02-30T00:00:00Z' is not a valid AllXsd value.",
    ],
    [
      '{"externalid":"invalid"}',
      "Microsoft.OData.ODataException: Cannot convert the literal 'invalid' to the expected type 'Edm.Guid'. ---> System.FormatException: Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).",
    ],
  ];
  for (const [raw, message] of cases)
    for (const method of ['POST', 'PATCH']) {
      const result = await send(app, raw, { method });
      assert.equal(result.status, 400, raw);
      assert.equal(result.body.error.code, '9004010D');
      assert.equal(result.body.error.innererror.message, prefix + message, raw);
      assert.equal(result.body.error.innererror.code, '0x80048d19');
      assert.equal(Object.hasOwn(result.body.error.innererror, 'type'), false);
      assert.deepEqual(app.store.snapshot().tables, baseline);
    }
  const accepted = await send(
    app,
    '{"quantity":"3","ratio":"12.5","enabled":"false","title":"<script>synthetic</script>"}',
  );
  assert.equal(accepted.status, 204);
  const row = app.store.snapshot().tables.probe[0];
  assert.equal(row.quantity, 3);
  assert.equal(row.ratio, 12.5);
  assert.equal(row.enabled, false);
  assert.equal(row.title, '<script>synthetic</script>');
});

test('bounded observed raw-body errors do not widen unsupported JSON grammar or mutate data', async (t) => {
  const app = await fixture(t, 'odata-wrapper'),
    baseline = app.store.snapshot().tables;
  for (const [raw, message] of [
    ['{', 'System.ArgumentException: Stream was not readable.'],
    ['{"title":', 'System.ArgumentException: Stream was not readable.'],
    [
      'null',
      "Microsoft.OData.ODataException: An unexpected 'EndOfInput' node was found when reading from the JSON reader. A 'StartObject' node was expected.",
    ],
    [
      '[]',
      "Microsoft.OData.ODataException: An unexpected 'EndOfInput' node was found when reading from the JSON reader. A 'StartObject' node was expected.",
    ],
    [
      '42',
      "Microsoft.OData.ODataException: An unexpected 'PrimitiveValue' node was found when reading from the JSON reader. A 'StartObject' node was expected.",
    ],
    ['"text"', "Microsoft.OData.ODataException: Invalid JSON. Unexpected token 'text'."],
    ['true', 'Microsoft.OData.ODataException: Invalid JSON. A token was not recognized in the JSON content.'],
  ]) {
    const result = await send(app, raw);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.innererror.message, prefix + message);
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  for (const raw of ['false', '[1]', '{"title": invalid}']) {
    const result = await send(app, raw);
    assert.equal(result.status, 400);
    assert.doesNotMatch(result.body.error.innererror.message, /InnerException/);
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  for (const raw of [
    '{"enabled":1e2}',
    '{"quantity":9007199254740993}',
    '{"quantity":1e100}',
    '{"quantity":0.00000000000000000000000000001}',
    '{"amount":[]}',
    '{"title":true}',
    '{"enabled":"unrecognized"}',
  ]) {
    const result = await send(app, raw);
    assert.equal(result.status, 400);
    assert.doesNotMatch(
      result.body.error.innererror.message,
      /InnerException/,
      'unqualified numeric reader types remain diagnostic',
    );
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  assert.equal(odataConversionDetails(null, 'Edm.Int32', 'quantity'), null);
  assert.equal(odataConversionDetails(2, 'Edm.Int64', 'quantity', { numericLexeme: '2' }), null);
  const empty = await send(app, '');
  assert.equal(empty.body.error.innererror.message, 'Passed entity object cannot be null or empty.');
  const bounds = await send(app, '{"quantity":11}');
  assert.match(bounds.body.error.innererror.message, /outside the valid range/);
  assert.doesNotMatch(bounds.body.error.innererror.message, /InnerException/);
  const unsupportedHeader = await send(app, '{"amount":"1.2"}', {
    contentType: 'application/json; IEEE754Compatible=true',
  });
  assert.equal(unsupportedHeader.status, 400);
  assert.doesNotMatch(unsupportedHeader.body.error.innererror.message, /IEEE754Compatible/);
  assert.deepEqual(app.store.snapshot().tables, baseline);
});

test('default HTTP and direct data errors retain diagnostics without request-only metadata leakage', async (t) => {
  const app = await fixture(t, 'diagnostic');
  const result = await send(app, '{"quantity":"oops"}');
  assert.equal(
    result.body.error.innererror.message,
    "Cannot convert the literal 'oops' to the expected type 'Edm.Int32'.",
  );
  const error = attachODataReaderDetails(
    new DataError('Original', 400, 'InvalidValue', { innerCode: '0x80048d19' }),
    odataConversionDetails('oops', 'Edm.Int32', 'quantity'),
  );
  assert.equal(webApiErrorResponse(error, { innerError: true }).body.error.innererror.message, 'Original');
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    name: 'DataError',
    status: 400,
    statusCode: 400,
    code: 'InvalidValue',
    details: { innerCode: '0x80048d19' },
  });
  assert.equal(Object.keys(error).includes('readerDetails'), false);
  assert.throws(
    () => app.store.createRecord('probe', { quantity: 'oops' }, {}, { coerce: true }),
    (error) => {
      assert.equal(error.message, "Cannot convert the literal 'oops' to the expected type 'Edm.Int32'.");
      assert.equal(Object.getOwnPropertySymbols(error).length, 0);
      return true;
    },
  );
  const hidden = webApiErrorResponse(error, { errorDetails: 'odata-wrapper', innerError: false });
  assert.equal(
    Object.hasOwn(hidden.body.error, 'innererror'),
    false,
    'observed descriptors do not enable inner errors',
  );
});

test('observed reader contract requires an explicit valid mode and site evidence', () => {
  assert.equal(
    observedConfig({ webApiErrorDetails: 'odata-wrapper', evidence: 'Synthetic fixture' }).webApiErrorDetails,
    'odata-wrapper',
  );
  assert.throws(() => observedConfig({ webApiErrorDetails: 'odata-wrapper' }), /evidence/);
  assert.throws(
    () => observedConfig({ webApiErrorDetails: 'native-stacks', evidence: 'Synthetic fixture' }),
    /webApiErrorDetails/,
  );
});
