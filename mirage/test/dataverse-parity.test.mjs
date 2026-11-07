import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  runSuite,
  validatePlan,
  sealResponse,
  compareRuns,
  inspectCsdl,
  inspectMultipart,
  coverageReport,
  createFetchTransport,
  createRunWriter,
  prepareRequest,
  evaluateAssertions,
} from '../dataverse-parity.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const response = (json, status = 200, headers = {}) => ({
  status,
  headers,
  bodyBase64: Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)).toString('base64'),
});
const plan = (cases) => ({ schemaVersion: 1, id: 'synthetic', cases });
const readCase = (id = 'read') => ({ id, family: 'read', request: { path: 'test_widgets' } });

test('lowercase header overrides are sent once with their requested values', async (t) => {
  let received;
  const server = http.createServer((req, res) => {
    received = req.headers;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const input = plan([
    {
      ...readCase(),
      request: {
        path: 'test_widgets',
        headers: { accept: 'text/plain', 'odata-version': '3.0', 'odata-maxversion': '3.0' },
      },
    },
  ]);
  await runSuite(input, {
    transport: createFetchTransport({ baseUrl: `http://127.0.0.1:${server.address().port}/api/data/v9.2/` }),
  });
  assert.equal(received.accept, 'text/plain');
  assert.equal(received['odata-version'], '3.0');
  assert.equal(received['odata-maxversion'], '3.0');
});

test('loopback record and replay preserve bytes, errors, stateful captures and exact diff', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Date', 'Mon, 19 Oct 2026 00:00:00 GMT');
    if (req.url.endsWith('/missing')) {
      res.writeHead(404);
      res.end('{"error":{"code":"0xTEST","message":"missing"}}');
    } else {
      res.setHeader('ETag', 'W/"1"');
      res.end('{"value":[{"id":"invented","amount":1.0000}]}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const transport = createFetchTransport({ baseUrl: `http://127.0.0.1:${server.address().port}/api/data/v9.2/` });
  const input = plan([
    { ...readCase(), capture: { tag: '/headers/etag' } },
    {
      id: 'missing',
      family: 'errors',
      dependsOn: ['read'],
      request: { path: 'missing', headers: { 'If-Match': '{{tag}}' } },
      acceptStatus: [404],
    },
  ]);
  const a = await runSuite(input, { transport }),
    b = await runSuite(input, { transport });
  assert.equal(a.results[1].request.headers['If-Match'], 'W/"1"');
  assert.equal(a.results[1].response.json.error.code, '0xTEST');
  assert.equal(compareRuns(a, b).exactMatch, true);
});

test('intent is persisted before writes; transport failure is unknown, never retried or matched', async () => {
  const events = [];
  let calls = 0;
  const input = plan([
    { id: 'create', family: 'crud', request: { method: 'POST', path: 'test_widgets', body: { name: 'owned' } } },
    { ...readCase(), dependsOn: ['create'] },
  ]);
  await assert.rejects(runSuite(input, { transport: async () => response({}) }), /allowWrites/);
  const run = await runSuite(input, {
    allowWrites: true,
    sink: async (event) => events.push(event.type),
    transport: async () => {
      assert.equal(events.at(-1), 'intent');
      calls++;
      throw Error('private detail');
    },
  });
  assert.equal(calls, 1);
  assert.equal(run.results[0].outcome, 'unknown');
  assert.equal(run.results[1].outcome, 'blocked');
  assert.equal(compareRuns(run, run).exactMatch, false);
  assert.doesNotMatch(JSON.stringify(run), /private detail/);
});

test('missing captures retain response evidence and block dependent requests', async () => {
  const run = await runSuite(
    plan([
      { ...readCase(), capture: { key: '/json/not-there' } },
      { ...readCase('next'), dependsOn: ['read'] },
    ]),
    { transport: async () => response({ id: 1 }) },
  );
  assert.equal(run.results[0].outcome, 'missing-capture');
  assert.equal(run.results[0].response.json.id, 1);
  assert.equal(run.results[1].outcome, 'blocked');
});

test('diff catches raw numeric representation, null versus missing, order, types, headers and omissions', async () => {
  const input = plan([readCase()]);
  const a = await runSuite(input, {
    transport: async () => response('{"n":1.0000,"empty":null,"list":[1,2]}', 200, { ETag: 'W/"1"' }),
  });
  const b = await runSuite(input, {
    transport: async () => response('{"n":"1","list":[2,1]}', 200, { ETag: 'W/"2"', Added: 'x' }),
  });
  const diff = compareRuns(a, b);
  for (const location of ['/bodyBytes', '/json/n', '/json/empty', '/json/list/0', '/headers/etag', '/headers/added'])
    assert.ok(
      diff.deltas.some((item) => item.path === location),
      location,
    );
  const decimal = await runSuite(input, {
    transport: async () => response('{"n":1,"empty":null,"list":[1,2]}', 200, { ETag: 'W/"1"' }),
  });
  assert.deepEqual(
    compareRuns(a, decimal).deltas.map((item) => item.path),
    ['/bodyBytes'],
  );
  assert.equal(compareRuns(a, { ...a, results: [] }).exactMatch, false);
  assert.equal(compareRuns({ ...a, complete: false }, { ...a, complete: false }).exactMatch, false);
});

test('reviewed deltas require exact observed values and never turn a raw mismatch into exact match', async () => {
  const input = plan([readCase()]);
  const a = await runSuite(input, { transport: async () => response({}, 200, { Date: 'one' }) });
  const b = await runSuite(input, { transport: async () => response({}, 200, { Date: 'two' }) });
  const diff = compareRuns(a, b, {
    rules: [
      {
        caseId: 'read',
        path: '/headers/date',
        reference: 'one',
        actual: 'two',
        reason: 'Independent server clocks; retained as a difference',
      },
    ],
  });
  assert.equal(diff.exactMatch, false);
  assert.equal(diff.reviewedDeltas, 1);
  assert.equal(diff.unexplainedDeltas, 0);
  assert.throws(() => compareRuns(a, b, { rules: [{ path: '/headers/date' }] }), /Reviewed/);
});

test('truncated reports retain total mismatch counts', async () => {
  const input = plan([readCase()]);
  const a = await runSuite(input, { transport: async () => response({ a: 1, b: 1, c: 1 }) });
  const b = await runSuite(input, { transport: async () => response({ a: 2, b: 2, c: 2 }) });
  const diff = compareRuns(a, b, { maxDeltas: 1 });
  assert.equal(diff.totalDeltas, 4);
  assert.equal(diff.deltas.length, 1);
  assert.equal(diff.truncated, true);
});

test('inconsistent or withheld evidence and changed HTTP methods cannot establish exact parity', async () => {
  const input = plan([readCase()]),
    run = await runSuite(input, { transport: async () => response({ n: 1 }) });
  for (const mutation of [
    (r) => {
      r.results[0].response.evidenceWithheld = true;
    },
    (r) => {
      r.results[0].response.bodySha256 = 'wrong';
    },
    (r) => {
      r.results[0].response.bytes++;
    },
    (r) => {
      r.results[0].response.json.n = 2;
    },
    (r) => {
      r.results[0].response = {};
    },
  ]) {
    const changed = structuredClone(run);
    mutation(changed);
    assert.equal(compareRuns(changed, changed).exactMatch, false);
    assert.equal(coverageReport(input, changed).complete, false);
    assert.equal(
      evaluateAssertions(changed, [
        {
          id: 'doc.read',
          caseId: 'read',
          source: { kind: 'documentation', url: 'https://example.invalid/doc' },
          assertions: [{ path: '/status', op: 'equals', expected: 200 }],
        },
      ]).unrecorded,
      1,
    );
  }
  const changed = structuredClone(run);
  changed.results[0].request.method = 'DELETE';
  assert.ok(compareRuns(run, changed).deltas.some((item) => item.path === '/request/method'));
  const wrongPath = structuredClone(run);
  wrongPath.results[0].request.path = 'another_resource';
  assert.equal(compareRuns(run, wrongPath).requestsVerified, false);
  assert.equal(compareRuns(run, wrongPath).exactMatch, false);
  const legacy = structuredClone(run);
  delete legacy.plan;
  assert.equal(compareRuns(legacy, legacy).exactMatch, false);
  assert.equal(compareRuns(legacy, legacy, { plan: input }).exactMatch, true);
  const omitted = structuredClone(run);
  omitted.results = [];
  assert.equal(compareRuns(omitted, omitted).requestsVerified, false);
  assert.equal(compareRuns(omitted, omitted).exactMatch, false);
  const added = structuredClone(run);
  added.results.push({ ...added.results[0], id: 'unplanned' });
  assert.equal(compareRuns(added, added).requestsVerified, false);
  assert.equal(compareRuns(added, added).exactMatch, false);
  assert.equal(coverageReport(input, { ...run, planSha256: 'another-plan' }).planVerified, false);
  assert.equal(coverageReport(input, { ...run, results: [...run.results, run.results[0]] }).complete, false);
});

test('credentials cannot enter plans, requests, captures or response headers', async () => {
  assert.throws(
    () => validatePlan(plan([{ ...readCase(), request: { path: 'widgets', headers: { Authorization: 'anything' } } }])),
    /Credential|credential/,
  );
  assert.throws(
    () =>
      prepareRequest({ path: 'widgets', bodyBase64: Buffer.from('{"access_token":"secret"}').toString('base64') }, {}),
    /Credential/,
  );
  const sealed = sealResponse(response({}, 200, { 'Set-Cookie': 'secret', ETag: 'ok' }));
  assert.equal(sealed.headers['set-cookie'], undefined);
  assert.deepEqual(sealed.withheldHeaders, ['set-cookie']);
  assert.doesNotMatch(JSON.stringify(sealed), /secret/);
  const run = await runSuite(plan([readCase()]), { transport: async () => response({ access_token: 'sensitive' }) });
  assert.equal(run.results[0].outcome, 'invalid-evidence');
  assert.doesNotMatch(JSON.stringify(run), /sensitive/);
  assert.equal(run.results[0].response.status, 200);
  const challenge = sealResponse(
    response({ error: { code: 'Unauthorized' } }, 401, {
      'WWW-Authenticate':
        'Bearer authorization_uri="https://example.invalid/authorize", resource_id="https://example.invalid"',
    }),
  );
  assert.equal(challenge.status, 401);
  assert.equal(
    challenge.headers['www-authenticate'],
    'Bearer authorization_uri="https://example.invalid/authorize", resource_id="https://example.invalid"',
  );
});

test('encoded request credentials are rejected before any plan or variables reach the journal', async () => {
  const encoded = Buffer.from('{"access_token":"invented-private-value"}').toString('base64');
  const bodies = [
    { bodyBase64: encoded },
    { bodyText: '{"password":"invented-private-value"}' },
    { bodyText: '--broken\r\n Cookie: invented-private-value' },
  ];
  for (const body of bodies) {
    const events = [];
    await assert.rejects(
      runSuite(plan([{ ...readCase(), request: { method: 'POST', path: 'widgets', ...body } }]), {
        allowWrites: true,
        sink: async (event) => events.push(event),
        transport: async () => response({}),
      }),
      /Credential/,
    );
    assert.equal(events.length, 0);
  }
  const events = [],
    input = {
      ...plan([{ ...readCase(), request: { method: 'POST', path: 'widgets', bodyBase64: '{{payload}}' } }]),
      variables: { payload: encoded },
    };
  await assert.rejects(
    runSuite(input, {
      allowWrites: true,
      sink: async (event) => events.push(event),
      transport: async () => response({}),
    }),
    /Credential/,
  );
  assert.equal(events.length, 0);
  const unknown = await runSuite(plan([readCase()]), {
    transport: async () => ({ transportError: 'Bearer invented-private-value-that-must-not-be-saved' }),
  });
  assert.equal(unknown.results[0].response.transportError, 'transport-failed');
  assert.doesNotMatch(JSON.stringify(unknown), /invented-private/);
});

test('origin confinement prevents token leakage through redirects or continuation URLs', async () => {
  let calls = 0;
  const transport = createFetchTransport({
    baseUrl: 'http://127.0.0.1:1/api/data/v9.2/',
    token: async () => 'invented',
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return new Response('{}');
    },
  });
  for (const p of [
    'https://outside.invalid/api/data/v9.2/widgets',
    '/elsewhere',
    '../v9.1/widgets',
    'http://user:pass@127.0.0.1:1/api/data/v9.2/widgets',
  ])
    await assert.rejects(transport({ path: p, headers: {} }), /escaped/);
  assert.equal(calls, 0);
  assert.throws(() => createFetchTransport({ baseUrl: 'https://example.invalid/api/data/v9.2/' }), /allowRemote/);
  assert.throws(
    () => createFetchTransport({ baseUrl: 'http://example.invalid/api/data/v9.2/', allowRemote: true }),
    /HTTPS/,
  );
  await transport({ path: 'widgets', method: 'GET', headers: {} });
  assert.equal(calls, 1);
});

test('immutable writer retains durable start/intent/results and rejects reused directories', async (t) => {
  const temp = await makeTemporaryDirectory(path.join(os.tmpdir(), 'dataverse-parity-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dir = path.join(temp, 'run'),
    writer = await createRunWriter(dir);
  const run = await runSuite(plan([readCase()]), { transport: async () => response({ value: [] }), sink: writer.sink });
  await writer.close();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8')), run);
  const events = (await fs.readFile(path.join(dir, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.type),
    ['start', 'intent', 'result', 'finish'],
  );
  await assert.rejects(createRunWriter(dir), { code: 'EEXIST' });
});

test('metadata signatures preserve overloads/binding; unrecorded inventory and families fail coverage', async () => {
  const xml = `<edmx:Edmx><edmx:DataServices><Schema Namespace="Test"><EntityType Name="widget"/><ComplexType Name="Reply"/><Function Name="Count" IsBound="true"><Parameter Name="Target" Type="Collection(Test.widget)"/><ReturnType Type="Edm.Int32"/></Function><Function Name="Count"><Parameter Name="Name" Type="Edm.String"/><ReturnType Type="Edm.Int32"/></Function><Action Name="Do"><Parameter Name="Input" Type="Edm.String"/></Action><EntityContainer Name="Default"><EntitySet Name="widgets" EntityType="Test.widget"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
  const catalogue = inspectCsdl(xml);
  assert.equal(catalogue.operations.length, 3);
  assert.equal(catalogue.entitySets.length, 1);
  assert.equal(catalogue.operations[0].bound, true);
  assert.notEqual(catalogue.operations[0].id, catalogue.operations[1].id);
  const input = plan([{ ...readCase(), covers: ['entitySet:widgets'] }]),
    run = await runSuite(input, { transport: async () => response({}) });
  const coverage = coverageReport(input, run, catalogue, ['plugins']);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.metadata.observed, 1);
  assert.equal(coverage.metadata.unrecorded.length, 3);
  assert.equal(coverage.families.plugins.planned, 0);
});

test('self-closing operations never consume adjacent operation parameters', () => {
  const xml =
    '<edmx:Edmx><Schema Namespace="Test"><Action Name="Empty"/><Action Name="Full"><Parameter Name="x" Type="Edm.String"/></Action><Function Name="NoArgs"/><Function Name="Reply"><ReturnType Type="Edm.String"/></Function></Schema></edmx:Edmx>';
  const inventory = inspectCsdl(xml);
  assert.deepEqual(
    inventory.operations.map((item) => [item.name, item.parameters.length, item.returnType]),
    [
      ['Empty', 0, null],
      ['Full', 1, null],
      ['NoArgs', 0, null],
      ['Reply', 0, 'Edm.String'],
    ],
  );
});

test('malformed multipart retains raw bytes while credential-bearing malformed MIME is withheld', async () => {
  const text =
    '--broken\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":{"code":"TEST"}}';
  const input = plan([readCase()]);
  const run = await runSuite(input, {
    transport: async () => response(text, 200, { 'Content-Type': 'multipart/mixed; boundary=broken' }),
  });
  assert.equal(run.results[0].outcome, 'observed');
  assert.equal(run.results[0].response.multipartParseError, 'malformed-multipart');
  assert.equal(Buffer.from(run.results[0].response.bodyBase64, 'base64').toString(), text);
  assert.equal(compareRuns(run, run).exactMatch, true);
  for (const secret of [
    'Set-Cookie: secret',
    ' Set-Cookie: secret',
    'Authorization: Basic short',
    '"access_token":"secret"',
    '"access\\u005ftoken":"secret"',
  ]) {
    const withheld = await runSuite(input, {
      transport: async () =>
        response(text + '\r\n' + secret, 200, { 'Content-Type': 'multipart/mixed; boundary=broken' }),
    });
    assert.equal(withheld.results[0].outcome, 'invalid-evidence');
    assert.doesNotMatch(JSON.stringify(withheld), /secret|Basic short/);
  }
});

test('nested batch faults are diffed by inner status/code/message and raw bytes', async () => {
  const batch = (status, code) =>
    `--batch_test\r\nContent-Type: multipart/mixed; boundary="changeset_test"\r\n\r\n--changeset_test\r\nContent-Type: application/http\r\nContent-ID: 1\r\n\r\nHTTP/1.1 ${status} Failure\r\nContent-Type: application/json\r\n\r\n{"error":{"code":"${code}","message":"controlled"}}\r\n--changeset_test--\r\n\r\n--batch_test--\r\n`;
  const input = plan([readCase()]);
  const a = await runSuite(input, {
    transport: async () => response(batch(400, 'one'), 200, { 'Content-Type': 'multipart/mixed;boundary=batch_test' }),
  });
  const b = await runSuite(input, {
    transport: async () => response(batch(412, 'two'), 200, { 'Content-Type': 'multipart/mixed;boundary=batch_test' }),
  });
  assert.equal(a.results[0].outcome, 'observed');
  const deltas = compareRuns(a, b).deltas;
  assert.ok(deltas.some((item) => item.path === '/multipart/parts/0/multipart/parts/0/status'));
  assert.ok(deltas.some((item) => item.path.endsWith('/json/error/code')));
  assert.throws(
    () =>
      inspectMultipart(
        Buffer.from(batch(400, 'one').replace('Content-ID: 1', 'Set-Cookie: sensitive')),
        'multipart/mixed;boundary=batch_test',
      ),
    /Credential/,
  );
});

test('nonstandard error envelopes and JSON-looking strings are preserved without rewriting', async () => {
  const input = plan([readCase()]),
    native = { Message: 'Controlled header error', ErrorCode: '0xTEST', Detail: '{"error":{"code":"0xNESTED"}}' };
  const run = await runSuite(input, { transport: async () => response(native, 400) });
  assert.deepEqual(run.results[0].response.json, native);
  assert.equal(run.results[0].response.json.error, undefined);
});

test('documented and SDK facets are evaluated separately from native exact parity', async () => {
  const run = await runSuite(plan([readCase()]), { transport: async () => response({ value: [1], empty: null }) });
  const report = evaluateAssertions(run, [
    {
      id: 'doc.read',
      caseId: 'read',
      source: { kind: 'documentation', url: 'https://example.invalid/document' },
      assertions: [
        { path: '/status', op: 'equals', expected: 200 },
        { path: '/json/value', op: 'type', expected: 'array' },
        { path: '/json/missing', op: 'absent' },
        { path: '/json/empty', op: 'type', expected: 'null' },
      ],
      untested: ['Identity precondition remains separately evidenced'],
    },
    {
      id: 'sdk.read',
      caseId: 'read',
      source: { kind: 'sdk-fixture', url: 'https://example.invalid/fixture' },
      assertions: [{ path: '/status', op: 'equals', expected: 404 }],
    },
    {
      id: 'doc.pending',
      caseId: 'absent',
      source: { kind: 'documentation', url: 'https://example.invalid/document' },
      assertions: [{ path: '/status', op: 'equals', expected: 200 }],
    },
  ]);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.unrecorded, 1);
  assert.equal(report.results[0].untested.length, 1);
});
