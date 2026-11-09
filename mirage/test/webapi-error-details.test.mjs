// @test-kind contract: Synthetic reader-mode configuration, diagnostic defaults and local write atomicity; native case assertions are tagged separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createSimulator } from '../server.mjs';
import { DataError } from '../lib/data.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { webApiErrorResponse } from '../lib/webapi-handler.mjs';
import { attachODataReaderDetails, odataConversionDetails } from '../lib/webapi-error-details.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { parseExactJson } from '../lib/exact-numeric.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const prefix =
  "Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : ";
// Exact request inputs are authored here and independently checked against each protected capture.
// This keeps fixture data on the assertion side of the loopback HTTP boundary.
const nativeReaderRequests = [
  ['POST', '{"quantity":1.5}'],
  ['PATCH', '{"quantity":1.5}'],
  ['POST', '{"quantity":"invalid-A"}'],
  ['PATCH', '{"quantity":"invalid-A"}'],
  ['POST', '{"quantity":true}'],
  ['PATCH', '{"quantity":true}'],
  ['POST', '{"quantity":{}}'],
  ['PATCH', '{"quantity":{}}'],
  ['POST', '{"quantity":[]}'],
  ['PATCH', '{"quantity":[]}'],
  ['POST', '{"enabled":"invalid-A"}'],
  ['PATCH', '{"enabled":"invalid-A"}'],
  ['POST', '{"amount":"2.25"}'],
  ['PATCH', '{"amount":"2.25"}'],
  ['POST', '{"day":"invalid-date-A"}'],
  ['PATCH', '{"day":"invalid-date-A"}'],
  ['POST', '{"day":"invalid-date-A"}'],
  ['PATCH', '{"day":"invalid-date-A"}'],
  ['POST', '{"title":2}'],
  ['PATCH', '{"title":2}'],
  ['POST', '{"quantity":2.5}'],
  ['PATCH', '{"quantity":2.5}'],
  ['POST', '{"quantity":"invalid-B"}'],
  ['PATCH', '{"quantity":"invalid-B"}'],
  ['POST', '{"quantity":false}'],
  ['PATCH', '{"quantity":false}'],
  ['POST', '{"quantity":{}}'],
  ['PATCH', '{"quantity":{}}'],
  ['POST', '{"quantity":[]}'],
  ['PATCH', '{"quantity":[]}'],
  ['POST', '{"enabled":"invalid-B"}'],
  ['PATCH', '{"enabled":"invalid-B"}'],
  ['POST', '{"amount":"3.75"}'],
  ['PATCH', '{"amount":"3.75"}'],
  ['POST', '{"day":"invalid-date-B"}'],
  ['PATCH', '{"day":"invalid-date-B"}'],
  ['POST', '{"day":"invalid-date-B"}'],
  ['PATCH', '{"day":"invalid-date-B"}'],
  ['POST', '{"title":3}'],
  ['PATCH', '{"title":3}'],
];
const nativeGatewayRequests = [
  ['PATCH', '"textOne"'],
  ['PATCH', '"frobOne"'],
  ['PATCH', '"noneOne"'],
  ['PATCH', '"anotherOne"'],
  ['PATCH', '"true"'],
  ['PATCH', '"false"'],
  ['PATCH', '"null"'],
  ['PATCH', '"True"'],
  ['PATCH', '"False"'],
  ['PATCH', '"Null"'],
  ['PATCH', '"  text"'],
  ['PATCH', '"17"'],
  ['PATCH', '"-17"'],
  ['PATCH', '"1.5"'],
  ['PATCH', '"[]"'],
  ['PATCH', '"[1]"'],
  ['PATCH', '"{}"'],
  ['PATCH', '"{\\"invented_unknown_lexer\\":1}"'],
  ['PATCH', '"\\"nested\\""'],
  ['PATCH', '""'],
  ['PATCH', 'true'],
  ['PATCH', 'false'],
  ['PATCH', 'null'],
  ['PATCH', '17'],
  ['PATCH', '[]'],
  ['POST', '{"amount":[7]}'],
  ['PATCH', '{"amount":[7]}'],
  ['PATCH', '"textTwo"'],
  ['PATCH', '"frobTwo"'],
  ['PATCH', '"noneTwo"'],
  ['PATCH', '"anotherTwo"'],
  ['POST', '{"amount":[8]}'],
  ['PATCH', '{"amount":[8]}'],
  ['POST', '{"amount":{"title":"first-object"}}'],
  ['PATCH', '{"amount":{"title":"first-object"}}'],
  ['POST', '{"amount":{"title":"second-object"}}'],
  ['PATCH', '{"amount":{"title":"second-object"}}'],
];
const fixturePorts = new WeakMap();
async function fixture(t, mode, observed = {}, row = {}) {
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
    observed: { webApiErrorDetails: mode, evidence: 'Invented loopback reader fixture', ...observed },
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
            secret: { dataverseType: 'nvarchar' },
          },
        },
      },
      tables: { probe: [{ probeid: id, title: 'Original', quantity: 2, ...row }] },
      settings: { permissionMode: 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const origin = new URL(app.url);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(origin.pathname, '/');
  assert.equal(origin.search, '');
  assert.equal(origin.hash, '');
  assert.equal(origin.username, '');
  assert.equal(origin.password, '');
  const port = Number(origin.port);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  fixturePorts.set(app, port);
  return app;
}
async function send(app, raw, { method = 'PATCH', contentType = 'application/json' } = {}) {
  const port = fixturePorts.get(app);
  if (!port || !['POST', 'PATCH'].includes(method))
    throw new Error('Expected an owned loopback fixture and write method');
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/_api/probes' + (method === 'POST' ? '' : '(' + id + ')'),
        method,
        headers: {
          'content-type': contentType,
          'content-length': Buffer.byteLength(raw),
          __RequestVerificationToken: app.csrf,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode,
              body: response.statusCode === 204 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(raw);
  });
  return result;
}

test('reader fixture requests reject unowned external and scheme-relative origins', async (t) => {
  let received = 0;
  const trap = http.createServer((_request, response) => {
    received++;
    response.end();
  });
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => trap.close((error) => (error ? reject(error) : resolve()))));
  const port = trap.address().port;
  for (const url of [`http://127.0.0.1:${port}`, `//127.0.0.1:${port}`, 'https://example.invalid']) {
    await assert.rejects(send({ url, csrf: 'test' }, '{'), /owned loopback fixture/);
  }
  assert.equal(received, 0);
});

// @test-kind parity: Both native323 cohorts reproduce successful ordinary POST/PATCH204, identifier headers and absent Content-Type; origin, set and owned IDs are parameters.
// @parity-evidence: webapi-native-portal-write-wire.json binds all230 successful native writes per cohort to original plan/journal/run hashes and exact empty-response hashes.
test('observed ordinary writes reproduce the native entity identifiers and204 content headers', async (t) => {
  const app = await fixture(t, 'odata-wrapper', {
    webApiWriteResponse: 'portal-classic',
    evidence: 'Paired native write-wire proof in webapi-native-portal-write-wire.json',
  });
  for (const method of ['POST', 'PATCH']) {
    // @test-kind parity: This method's entityid and OData-EntityId point to the same written record, with empty204 body and no Content-Type.
    // @parity-evidence: The protected capsule binds two complete native write cohorts, including both POST and PATCH across three source tables.
    await t.test(method, async () => {
      const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-write-wire.json', import.meta.url));
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        '9c0339c731e5b20f19f387c7499c3db0ed14189503e46d0dd905ae369d976ebe',
      );
      const proof = JSON.parse(bytes),
        writtenId = method === 'POST' ? '00000000-0000-4000-8000-000000000002' : id;
      assert.equal(proof.captures.length, 2);
      assert.ok(proof.captures.every((capture) => capture.methodCounts[method] > 0));
      const response = await fetch(app.url + '/_api/probes' + (method === 'POST' ? '' : '(' + id + ')'), {
        method,
        headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
        body: JSON.stringify({ ...(method === 'POST' ? { probeid: writtenId } : {}), title: 'Wire fixture' }),
      });
      assert.equal(response.status, proof.expected.status);
      assert.equal(await response.text(), proof.expected.body);
      assert.equal(response.headers.get('content-type'), proof.expected.contentType);
      assert.equal(response.headers.get('entityid'), proof.expected.entityId.replace('__OWNED_ID__', writtenId));
      assert.equal(
        response.headers.get('odata-entityid'),
        proof.expected.odataEntityId
          .replace('__ORIGIN__', app.url)
          .replace('__SET__', 'probes')
          .replace('__OWNED_ID__', writtenId),
      );
    });
  }
});

test('write-header observations leave default and unrelated204 routes unchanged', async (t) => {
  const app = await fixture(t, 'diagnostic');
  const response = await fetch(app.url + '/_api/probes(' + id + ')', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    body: '{"title":"Default"}',
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('entityid'), null);
  assert.equal(response.headers.get('odata-entityid'), app.url + '/_api/probes(' + id + ')');
  const observed = await fixture(t, 'odata-wrapper', { webApiWriteResponse: 'portal-classic' });
  const removed = await fetch(observed.url + '/_api/probes(' + id + ')', {
    method: 'DELETE',
    headers: { __RequestVerificationToken: observed.csrf },
  });
  assert.equal(removed.status, 204);
  assert.equal(removed.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.throws(
    () => observedConfig({ webApiWriteResponse: 'unknown', evidence: 'Invented invalid profile' }),
    /webApiWriteResponse/,
  );
  assert.throws(() => observedConfig({ webApiWriteResponse: 'portal-classic' }), /evidence/);
});

// @test-kind parity: Paired native collection reads reproduce exact JSON bytes after explicit request/source parameter binding; hidden lookup failures omit both innererror and cdscode.
// @parity-evidence: webapi-native-portal-read-wire.json binds all seven native successful reads per323 capture plus the identical redacted lookup response, without discarding JSON order or whitespace.
test('observed record reads reproduce exact native JSON formatting and hidden lookup redaction', async (t) => {
  const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-read-wire.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '8d321522efccbc41fcf99c63ef7524a1b72052245ee16894a3c76f4b6e504c8f',
  );
  const proof = JSON.parse(bytes),
    title = JSON.parse(proof.reads.nonempty).value[0].title;
  const app = await fixture(
    t,
    'odata-wrapper',
    {
      webApiReadResponse: 'jsonnet-indented',
      webApiGlobalMetadataVersion: '123456',
      evidence: 'Paired native record JSON capsule; metadata version is explicitly configured source data',
    },
    { title, versionnumber: 17 },
  );
  for (const variant of ['nonempty', 'empty']) {
    // @test-kind parity: Exact selected collection JSON has native CRLF/two-space layout, property order and source-bound version/identity parameters.
    // @parity-evidence: The paired read-wire capsule separately retains nonempty and empty native responses and their raw body hashes.
    await t.test(variant, async () => {
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        '8d321522efccbc41fcf99c63ef7524a1b72052245ee16894a3c76f4b6e504c8f',
      );
      const query = new URLSearchParams({
        $select: 'title',
        ...(variant === 'empty' ? { $filter: "title eq 'missing invented fixture'" } : {}),
      });
      const expected = proof.reads[variant]
        .replaceAll('__ORIGIN__', app.url)
        .replaceAll('__OWNED_ID__', id)
        .replaceAll('__ROW_VERSION__', '17')
        .replaceAll('__METADATA_VERSION__', '123456');
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await fetch(app.url + '/_api/probes?' + query, {
          headers: { __RequestVerificationToken: app.csrf },
        });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), expected, 'all JSON bytes and the unmodified row version remain exact');
      }
    });
  }
  // @test-kind parity: Native hidden lookup envelopes do not reveal the backend status code even with the site's cdscode profile enabled.
  // @parity-evidence: Both original323 cohorts reproduce the same complete hidden lookup JSON, bound in the read-wire capsule.
  await t.test('hidden lookup', () => {
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '8d321522efccbc41fcf99c63ef7524a1b72052245ee16894a3c76f4b6e504c8f',
    );
    const result = webApiErrorResponse(
      new DataError('The referenced record does not exist.', 404, 'InvalidLookup', {
        innerCode: '0x80040217',
        hideInner: true,
      }),
      {
        innerError: true,
        innerErrorScope: 'all-errors',
        cdsErrorCode: 'cdscode',
        cdsErrorMessage: 'Common Data Service error occurred.',
      },
    );
    assert.deepEqual({ status: result.status, body: result.body }, proof.hiddenLookup);
  });
});

test('read JSON observations preserve defaults, unrelated responses and exact numeric tokens', async (t) => {
  const app = await fixture(t, 'diagnostic');
  const response = await fetch(app.url + '/_api/probes?$select=title', {
    headers: { __RequestVerificationToken: app.csrf },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes('\n'), false);
  const observed = await fixture(t, 'odata-wrapper', { webApiReadResponse: 'jsonnet-indented' });
  const failure = await send(observed, '{');
  assert.equal(failure.status, 400);
  assert.throws(
    () => observedConfig({ webApiReadResponse: 'unknown', evidence: 'Invented invalid profile' }),
    /webApiReadResponse/,
  );
  assert.throws(() => observedConfig({ webApiReadResponse: 'jsonnet-indented' }), /evidence/);
  const exact = await fixture(
    t,
    'odata-wrapper',
    { webApiReadResponse: 'jsonnet-indented' },
    parseExactJson('{"amount":9007199254740993.125}'),
  );
  const numeric = await fetch(exact.url + '/_api/probes?$select=amount', {
    headers: { __RequestVerificationToken: exact.csrf },
  });
  assert.equal(numeric.status, 200);
  const numericText = await numeric.text();
  assert.ok(numericText.includes('"amount": 9007199254740993.125'));
  assert.doesNotMatch(numericText, /\$type/);
});

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
  const nativeTypedCases = [];
  for (const [index, [raw, message]] of cases.entries())
    for (const method of ['POST', 'PATCH']) {
      if ([0, 2, 4, 7].includes(index)) {
        // @test-kind parity: These existing Int32 decimal/invalid-string, Decimal IEEE conflict and String integer cases reuse two native changed-input reader cohorts; authored literals are parameters of the proven cause families.
        // @parity-evidence: webapi-native-portal-reader.json records both POST/PATCH for all four families, exact error heads/codes and changed literals A/B,2.25/3.75,2/3; this region protects the original selected input/message universe and proof bytes.
        await t.test('native existing typed cause ' + method + ' ' + raw, async () => {
          assert.equal(
            createHash('sha256')
              .update(await fs.readFile(new URL('./fixtures/webapi-native-portal-reader.json', import.meta.url)))
              .digest('hex'),
            '5256a83e1629b5da9f40cd29fa9827e4086d41218accb9f23f4719be639f8590',
          );
          assert.equal(
            createHash('sha256')
              .update(JSON.stringify([0, 2, 4, 7].map((index) => cases[index])))
              .digest('hex'),
            'cc27588cdaecc5a813a2919a9c5a87e84f3c4745933ce2d530b540aa3d62fd9c',
          );
          assert.equal(
            createHash('sha256').update(prefix).digest('hex'),
            '3810dd3287ba340cb0b23d8039e13f536267249dcf85dda22106a9a9b2c53de1',
          );
          nativeTypedCases.push([raw, method]);
          const result = await send(app, raw, { method });
          assert.equal(result.status, 400, raw);
          assert.equal(result.body.error.code, '9004010D');
          // @parity-evidence: Paired fresh native2026-11-08 object-payload POST errors name the resolved entity set; PATCH keeps the empty entity slot. Only the private entity-set name is aliased to probes.
          assert.equal(
            result.body.error.innererror.message,
            (method === 'POST' ? prefix.replace("Entity :''", "Entity :'probes'") : prefix) + message,
            raw,
          );
          assert.equal(result.body.error.innererror.code, '0x80048d19');
          assert.equal(Object.hasOwn(result.body.error.innererror, 'type'), false);
        });
      } else {
        const result = await send(app, raw, { method });
        assert.equal(result.status, 400, raw);
        assert.equal(result.body.error.code, '9004010D');
        // @parity-evidence: Paired fresh native2026-11-08 object-payload POST errors name the resolved entity set; PATCH keeps the empty entity slot. Only the private entity-set name is aliased to probes.
        assert.equal(
          result.body.error.innererror.message,
          (method === 'POST' ? prefix.replace("Entity :''", "Entity :'probes'") : prefix) + message,
          raw,
        );
        assert.equal(result.body.error.innererror.code, '0x80048d19');
        assert.equal(Object.hasOwn(result.body.error.innererror, 'type'), false);
      }
      assert.deepEqual(app.store.snapshot().tables, baseline);
    }
  // @test-kind parity: All eight qualified original typed-reader cases must execute; branch/loop edits cannot silently skip the protected guarantee universe.
  // @parity-evidence: Paired changed-input portal reader captures bind all four cause families; exact baseline raw inputs and methods are protected by this execution ledger.
  await t.test('qualified original typed-reader universe executes completely', () => {
    assert.deepEqual(nativeTypedCases, [
      ['{"quantity":1.5}', 'POST'],
      ['{"quantity":1.5}', 'PATCH'],
      ['{"quantity":"oops"}', 'POST'],
      ['{"quantity":"oops"}', 'PATCH'],
      ['{"amount":"1.2"}', 'POST'],
      ['{"amount":"1.2"}', 'PATCH'],
      ['{"title":42}', 'POST'],
      ['{"title":42}', 'PATCH'],
    ]);
  });
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

test('authenticated native portal reader cohorts reproduce selected HTTP error facets', async (t) => {
  const app = await fixture(t, 'odata-wrapper', {
    webApiCdsErrorMessage: 'Common Data Service error occurred.',
    webApiCdsErrorCode: 'cdscode',
    webApiInnerError: 'all-errors',
    webApiRequestBody: 'portal-classic',
    webApiInvalidDate: 'crm-minimum',
    evidence:
      'Two authenticated native2026-11-08 captures; protected webapi-native-portal-reader.json records the exact selected guarantees.',
  });
  const baseline = app.store.snapshot().tables;
  for (let index = 0; index < 40; index++)
    // @test-kind parity: Each authored typed POST/PATCH case reproduces native status, error fields, inner cause and property order; CLR suffix bytes are explicitly outside this public projection.
    // @parity-evidence: webapi-native-portal-reader.json binds both source-derived authenticated native captures, immutable collector/plan hashes and each raw response hash; schema aliases preserve primitive EDM types.
    await t.test('native portal reader case ' + index, async () => {
      const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-reader.json', import.meta.url));
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        '5256a83e1629b5da9f40cd29fa9827e4086d41218accb9f23f4719be639f8590',
      );
      const expected = JSON.parse(bytes).cases[index];
      // @parity-evidence: The exact literal method and body are checked against the unchanged paired native reader capsule before dispatch.
      const [method, raw] = nativeReaderRequests[index];
      assert.equal(method, expected.method);
      assert.equal(raw, expected.raw);
      const result = await send(app, raw, { method });
      assert.equal(result.status, expected.expected.status, expected.id);
      assert.deepEqual(result.body.error, expected.expected.error, expected.id);
      assert.deepEqual(Object.keys(result.body.error), Object.keys(expected.expected.error), expected.id);
    });
  assert.deepEqual(
    app.store.snapshot().tables,
    baseline,
    'local failed-write atomicity remains a separate contract assertion',
  );
});

test('bounded observed raw-body errors do not widen unsupported JSON grammar or mutate data', async (t) => {
  const app = await fixture(t, 'odata-wrapper'),
    baseline = app.store.snapshot().tables;
  const provenInputs = [];
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
    // @parity-evidence: Two fresh authenticated lexer cohorts reproduce false with the same unrecognized-token cause; this branch is no longer an unqualified diagnostic.
    ['false', 'Microsoft.OData.ODataException: Invalid JSON. A token was not recognized in the JSON content.'],
  ]) {
    // @test-kind parity: Existing raw-root assertions reproduce both authenticated323 captures; false is separately reproduced in the gateway pair.
    // @parity-evidence: webapi-native-portal-gateway.json binds exact original raw inputs, error heads/codes and raw native hashes to the capture pairs and durable recovery receipt.
    await t.test('native existing raw root ' + raw, async () => {
      const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-gateway.json', import.meta.url));
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        'f108c8385ff517834e9a7ae97d3bae41195a5facb69bf5cf3f25f8b9322d3a69',
      );
      const proof = JSON.parse(bytes),
        native = [...proof.originalRoots, ...proof.cases].find((entry) => entry.raw === raw);
      assert.ok(native, 'input is bound to an authored native case');
      const result = await send(app, raw);
      assert.equal(result.status, 400);
      assert.equal(result.status, native.expected.status);
      assert.equal(result.body.error.innererror.message, prefix + message);
      assert.equal(result.body.error.innererror.message, native.expected.body.error.innererror.message);
      assert.equal(result.body.error.innererror.code, '0x80048d19');
      provenInputs.push(raw);
    });
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  // @test-kind parity: Enumeration completeness protects all eight reproduced native root guarantees from being skipped outside their nested proof regions.
  // @parity-evidence: The protected fixture contains seven exact original roots plus the independently paired false root; each must execute above.
  await t.test('native raw-root proof bindings cover every original guarantee', async () => {
    const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-gateway.json', import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'f108c8385ff517834e9a7ae97d3bae41195a5facb69bf5cf3f25f8b9322d3a69',
    );
    const proof = JSON.parse(bytes);
    assert.equal(proof.originalRoots.length, 7);
    assert.deepEqual(provenInputs.toSorted(), [...proof.originalRoots.map((entry) => entry.raw), 'false'].toSorted());
  });
  for (const raw of ['[1]', '{"title": invalid}']) {
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
    '{"title":true}',
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
  const provenPrimitiveCases = [
    [
      '{"amount":[]}',
      "An unexpected 'StartArray' node was found when reading from the JSON reader. A 'PrimitiveValue' node was expected.",
    ],
    ['{"enabled":"unrecognized"}', 'String was not recognized as a valid Boolean.'],
  ];
  const provenPrimitiveExecutions = [];
  for (const [raw, fragment] of provenPrimitiveCases) {
    // @test-kind parity: Existing primitive-array and invalid-Boolean-string assertions reuse repeated native changed-input cause families; rejected-write atomicity remains local contract below.
    // @parity-evidence: webapi-native-portal-reader.json proves invalid Boolean strings in POST/PATCH with A/B literals; webapi-native-portal-gateway.json proves the primitive StartArray cause with two nonempty-array holdouts. Exact first cause fragment is independent of array contents.
    await t.test('native existing primitive fragment ' + raw, async () => {
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(new URL('./fixtures/webapi-native-portal-reader.json', import.meta.url)))
          .digest('hex'),
        '5256a83e1629b5da9f40cd29fa9827e4086d41218accb9f23f4719be639f8590',
      );
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(new URL('./fixtures/webapi-native-portal-gateway.json', import.meta.url)))
          .digest('hex'),
        'f108c8385ff517834e9a7ae97d3bae41195a5facb69bf5cf3f25f8b9322d3a69',
      );
      assert.equal(
        createHash('sha256').update(JSON.stringify(provenPrimitiveCases)).digest('hex'),
        '8c46331bd500b894a25098310825c9fb9aff893b84ff1a2e3304122c38cab2c1',
      );
      const result = await send(app, raw);
      assert.equal(result.status, 400);
      assert.match(result.body.error.innererror.message, /InnerException/);
      assert.ok(result.body.error.innererror.message.includes(fragment));
      provenPrimitiveExecutions.push([raw, fragment]);
    });
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  // @test-kind parity: Both qualified existing primitive-fragment cases must execute, with their exact original raw input and expected-fragment universe.
  // @parity-evidence: The two protected repeated native capsules bind the StartArray and invalid Boolean-string guarantees; this checksum is over actual completed cases.
  await t.test('both original primitive fragments execute', () => {
    assert.equal(
      createHash('sha256').update(JSON.stringify(provenPrimitiveExecutions)).digest('hex'),
      '8c46331bd500b894a25098310825c9fb9aff893b84ff1a2e3304122c38cab2c1',
    );
  });
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

test('authenticated gateway lexer and actual changed-input reader holdouts reproduce native selected facets', async (t) => {
  const app = await fixture(t, 'odata-wrapper', {
    webApiCdsErrorMessage: 'Common Data Service error occurred.',
    webApiCdsErrorCode: 'cdscode',
    webApiInnerError: 'all-errors',
    webApiRequestBody: 'portal-classic',
    evidence:
      'Two gateway lexer rounds plus two corrected enabled-object rounds; protected webapi-native-portal-gateway.json binds native source and response hashes.',
  });
  const proven = [];
  for (let index = 0; index < 37; index++) {
    // @test-kind parity: Every selected gateway input reproduces native status and the complete error JSON before CLR suffix; an empty encoded object reproduces the native204.
    // @parity-evidence: webapi-native-portal-gateway.json contains the paired authenticated lexer/changed-input captures, exact native response hashes and source hashes; field aliases preserve source policy membership.
    await t.test('native gateway case ' + index, async () => {
      const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-gateway.json', import.meta.url));
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        'f108c8385ff517834e9a7ae97d3bae41195a5facb69bf5cf3f25f8b9322d3a69',
      );
      const entry = JSON.parse(bytes).cases[index];
      // @parity-evidence: The exact literal method and body are checked against the unchanged paired native gateway capsule before dispatch.
      const [method, raw] = nativeGatewayRequests[index];
      assert.equal(method, entry.method);
      assert.equal(raw, entry.raw);
      const result = await send(app, raw, { method });
      assert.equal(result.status, entry.expected.status, entry.id);
      assert.deepEqual(result.body, entry.expected.body, entry.id);
      if (result.body?.error)
        assert.deepEqual(Object.keys(result.body.error), Object.keys(entry.expected.body.error), entry.id);
      proven.push(entry.id);
    });
    const row = app.store.snapshot().tables.probe[0];
    assert.equal(row.title, 'Original', 'local authored-field atomicity is independently retained');
    assert.equal(row.quantity, 2);
  }
  // @test-kind parity: Completeness and literal source checksums protect all case definitions and expected bytes, including the loop's enumeration outside nested parity bodies.
  // @parity-evidence: The fixture binds37 distinct authored inputs across reproduced native reader families; all37 exact case identities must execute.
  await t.test('native gateway proof bindings cover every case', async () => {
    const bytes = await fs.readFile(new URL('./fixtures/webapi-native-portal-gateway.json', import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      'f108c8385ff517834e9a7ae97d3bae41195a5facb69bf5cf3f25f8b9322d3a69',
    );
    const cases = JSON.parse(bytes).cases;
    assert.equal(cases.length, 37);
    assert.deepEqual(
      proven,
      cases.map((entry) => entry.id),
    );
  });
});

// @test-kind security: Decoding an observed gateway object string preserves field guards and prevents forbidden or private writes.
test('encoded object strings retain ordinary field and private-column denial before any mutation', async (t) => {
  // Native accepted and persisted this forbidden-column transport twice; the local security boundary deliberately remains stricter.
  const nativeBytes = await fs.readFile(
    new URL('./fixtures/webapi-native-portal-security-divergence.json', import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(nativeBytes).digest('hex'),
    '0204166be7f21f1de3256556c56e1889cf37d2631fc2b2aff23787d5461d0dc4',
  );
  const nativeProof = JSON.parse(nativeBytes);
  assert.equal(nativeProof.source.knownStringColumn, true);
  assert.equal(nativeProof.source.webApiEnabledColumn, false);
  assert.equal(nativeProof.captures.length, 2);
  assert.ok(
    nativeProof.captures.every(
      (capture) => capture.nativeStatus === 204 && capture.independentlyVerifiedStoredValueEqualsSubmitted,
    ),
  );
  const app = await fixture(t, 'odata-wrapper', { webApiRequestBody: 'portal-classic' }),
    baseline = app.store.snapshot().tables;
  for (const value of [
    { secret: 'forbidden' },
    { __sim_private: 'forbidden' },
    { title: 'would-write', secret: 'forbidden' },
  ]) {
    const result = await send(app, JSON.stringify(JSON.stringify(value)));
    assert.equal(result.status, 403);
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
});

test('gateway object decoding is explicit and an allowed empty update preserves authored fields', async (t) => {
  const app = await fixture(t, 'odata-wrapper', { webApiRequestBody: 'portal-classic' });
  const defaultApp = await fixture(t, 'diagnostic');
  assert.equal((await send(defaultApp, JSON.stringify('{}'))).status, 400);
  const diagnosticsOnly = await fixture(t, 'odata-wrapper');
  const diagnosticsBaseline = diagnosticsOnly.store.snapshot().tables;
  assert.equal((await send(diagnosticsOnly, JSON.stringify('{}'))).status, 400);
  assert.equal((await send(diagnosticsOnly, JSON.stringify('{"title":"must not write"}'))).status, 400);
  assert.deepEqual(diagnosticsOnly.store.snapshot().tables, diagnosticsBaseline);
  assert.throws(
    () => observedConfig({ webApiRequestBody: 'unknown', evidence: 'Invented invalid request profile' }),
    /webApiRequestBody/,
  );
  assert.throws(() => observedConfig({ webApiRequestBody: 'portal-classic' }), /evidence/);
  assert.equal((await send(app, JSON.stringify('{}'))).status, 204);
  const row = app.store.snapshot().tables.probe[0];
  assert.equal(row.probeid, id);
  assert.equal(row.title, 'Original');
  assert.equal(row.quantity, 2);
});

// @test-kind security: Formatting a denied encoded unknown-schema property performs no record query or mutation and preserves known forbidden-field403 and ordinary unknown-field403.
test('encoded unknown-schema formatting rejects before row access while normal write guards keep precedence', async (t) => {
  const app = await fixture(t, 'odata-wrapper', { webApiRequestBody: 'portal-classic' });
  const baseline = app.store.snapshot().tables;
  assert.equal((await send(app, '{"unknown":1}')).status, 403);
  const calls = [];
  for (const method of [
    'get',
    'query',
    'queryCore',
    'tableRows',
    'createRecord',
    'updateRecord',
    'upsertRecord',
    'createRecordAsync',
    'upsertRecordAsync',
    'removeRecord',
    'removeRecordAsync',
  ]) {
    const original = app.store[method];
    if (typeof original !== 'function') continue;
    app.store[method] = function (...args) {
      if (args[0] === 'probe') calls.push(method);
      return original.apply(this, args);
    };
  }
  const encoded = await send(app, JSON.stringify(JSON.stringify({ unknown: 1 })));
  assert.equal(encoded.status, 400);
  assert.equal(encoded.body.error.innererror.code, '0x80048d19');
  assert.ok(encoded.body.error.innererror.message.includes("Invalid property 'unknown'"));
  assert.deepEqual(calls, []);
  assert.deepEqual(app.store.snapshot().tables, baseline);
  assert.equal((await send(app, JSON.stringify(JSON.stringify({ unknown: 1, secret: 'forbidden' })))).status, 403);
  assert.deepEqual(calls, []);
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
