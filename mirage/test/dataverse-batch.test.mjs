import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseBatch, executeBatch, reasonPhrase } from '../lib/dataverse-batch.mjs';

const ORIGIN = 'http://127.0.0.1:8080';
const B = 'batch_80dd1615-2a10-428a-bb6f-0e559792721f';
const CRLF = '\r\n';

// The request sample from webapi-contract.md section 7, with CRLF framing.
const SAMPLE = [
  `--${B}`,
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  '',
  'POST /api/data/v9.2/tasks HTTP/1.1',
  'Content-Type: application/json; type=entry',
  '',
  '{"subject": "Task 1 in batch","regardingobjectid_account_task@odata.bind": "accounts(00000000-0000-0000-0000-000000000001)"}',
  `--${B}`,
  'Content-Type: application/http',
  'Content-Transfer-Encoding: binary',
  '',
  'GET /api/data/v9.2/accounts(00000000-0000-0000-0000-000000000001)/Account_Tasks?$select=subject HTTP/1.1',
  '',
  `--${B}--`,
  '',
].join(CRLF);

const httpReq = (method, url, body) =>
  [`${method} ${url} HTTP/1.1`, ...(body === undefined ? [] : ['Content-Type: application/json', '', body])].join(CRLF);
const part = (boundary, contentId, request) =>
  [`--${boundary}`, 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', ...(contentId ? [`Content-ID: ${contentId}`] : []), '', request].join(CRLF);
const changeset = (cs, items) =>
  [`--${B}`, `Content-Type: multipart/mixed; boundary=${cs}`, '', ...items.map((i) => part(cs, i.cid, i.request)), `--${cs}--`].join(CRLF);
const batchOf = (sections) => [...sections, `--${B}--`, ''].join(CRLF);
const ct = `multipart/mixed; boundary="${B}"`;

function fakeDispatch() {
  const calls = [];
  const created = [];
  const dispatch = async (req) => {
    calls.push(req);
    if (req.url.includes('fail')) return { status: 400, headers: { REQ_ID: randomUUID() }, body: { error: { code: '0x80044331', message: 'boom' } } };
    if (req.method === 'POST') {
      const id = randomUUID();
      created.push(id);
      return { status: 204, headers: { 'OData-EntityId': `${ORIGIN}/api/data/v9.2/widgets(${id})` } };
    }
    if (req.method === 'GET') return { status: 200, body: { value: [] } };
    return { status: 204 };
  };
  return { dispatch, calls, created };
}

const run = (parsed, dispatch, options = {}) => executeBatch(parsed, { dispatch, origin: ORIGIN, ...options });
const count = (text, pattern) => text.match(pattern)?.length ?? 0;

test('parses the documented sample with quoted and bare boundaries', () => {
  for (const type of [ct, `multipart/mixed;boundary=${B}`]) {
    const { boundary, parts } = parseBatch(type, SAMPLE);
    assert.equal(boundary, B);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[0], {
      kind: 'request',
      method: 'POST',
      url: '/api/data/v9.2/tasks',
      headers: { 'content-type': 'application/json; type=entry' },
      body: '{"subject": "Task 1 in batch","regardingobjectid_account_task@odata.bind": "accounts(00000000-0000-0000-0000-000000000001)"}',
    });
    assert.equal(parts[1].method, 'GET');
    assert.equal(parts[1].url, '/api/data/v9.2/accounts(00000000-0000-0000-0000-000000000001)/Account_Tasks?$select=subject');
    assert.equal(parts[1].body, undefined);
  }
});

test('tolerates a part without Content-Type, absolute URLs and LF-only bodies', () => {
  const body = batchOf([
    `--${B}`,
    'POST https://crm.example.test/api/data/v9.2/leads HTTP/1.1',
    'Content-Type: application/json',
    '',
    '{\n"name": "A"\n}',
  ]);
  const { parts } = parseBatch(ct, body);
  assert.equal(parts[0].url, 'https://crm.example.test/api/data/v9.2/leads');
  assert.equal(parts[0].body, '{\n"name": "A"\n}');
});

test('rejects a missing boundary with 0x80048d19', () => {
  const check = (error) => error.status === 400 && error.code === 'InvalidBatch' && error.details.innerCode === '0x80048d19';
  assert.throws(() => parseBatch('multipart/mixed', SAMPLE), check);
});

test('a JSON batch whose body is not a requests document is rejected with 0x80048d19 and the payload message', () => {
  const check = { status: 400, code: 'InvalidBatch', details: { innerCode: '0x80048d19' }, message: /^Error identified in Payload provided by the user for Entity :''/ };
  assert.throws(() => parseBatch('application/json', SAMPLE), check);
  assert.throws(() => parseBatch('application/json', '{"requests":"WhoAmI"}'), check);
  assert.throws(() => parseBatch('application/json', '{"requests":[{"method":"GET"}]}'), check);
});

// JSON batch: {"requests":[...]} runs through the same dispatch as multipart; the answer keeps the multipart form.
const jsonBatch = (requests) => JSON.stringify({ requests });
const ODATA = '/api/data/v9.2';

test('a JSON batch runs its item through dispatch and answers in the multipart form, with no Content-ID', async () => {
  const { dispatch, calls } = fakeDispatch();
  const res = await run(parseBatch('application/json; charset=utf-8', jsonBatch([{ id: '1', method: 'GET', url: 'WhoAmI' }])), dispatch, { base: `${ORIGIN}${ODATA}/` });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^multipart\/mixed; boundary=batchresponse_/);
  assert.deepEqual(calls.map((c) => c.url), [`${ORIGIN}${ODATA}/WhoAmI`]);
  assert.equal(count(res.body, /^HTTP\/1\.1 200 OK/gm), 1);
  assert.equal(count(res.body, /Content-ID/g), 0);
});

test('a JSON batch orders by dependsOn, resolves $id references and runs an atomicityGroup as one changeset', async () => {
  const { dispatch, calls } = fakeDispatch();
  const body = jsonBatch([
    { id: 'child', method: 'POST', url: `${ODATA}/widgets`, body: { name: 'B', 'parent@odata.bind': '$root' }, atomicityGroup: 'g', dependsOn: ['root'] },
    { id: 'root', method: 'POST', url: `${ODATA}/widgets`, body: { name: 'A' }, atomicityGroup: 'g' },
  ]);
  const res = await run(parseBatch('application/json', body), dispatch);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => (c.body.includes('"name":"A"') ? 'root' : 'child')), ['root', 'child']);
  assert.match(calls[1].body, new RegExp(`"parent@odata.bind":"${ODATA}/widgets\\(`));
  assert.equal(count(res.body, /^HTTP\/1\.1 204/gm), 2);
  assert.equal(count(res.body, /boundary=changesetresponse_/g), 1);
});

test('a failing item of a JSON atomicityGroup rolls the group back and the batch answers that status', async () => {
  const { dispatch, calls } = fakeDispatch();
  const body = jsonBatch([
    { id: 'a', method: 'POST', url: `${ODATA}/widgets`, body: { name: 'A' }, atomicityGroup: 'g' },
    { id: 'b', method: 'POST', url: `${ODATA}/fail`, body: { name: 'B' }, atomicityGroup: 'g' },
  ]);
  const res = await run(parseBatch('application/json', body), dispatch);
  assert.equal(res.status, 400);
  assert.match(res.body, /0x80044331/);
  assert.equal(calls.length, 2);
});

test('JSON batch dependencies are checked: unknown ids, cycles and a GET in a group answer 400 InvalidBatch', () => {
  const check = { status: 400, code: 'InvalidBatch' };
  assert.throws(() => parseBatch('application/json', jsonBatch([{ id: 'a', method: 'GET', url: 'WhoAmI', dependsOn: ['zz'] }])), check);
  assert.throws(() => parseBatch('application/json', jsonBatch([
    { id: 'a', method: 'GET', url: 'WhoAmI', dependsOn: ['b'] },
    { id: 'b', method: 'GET', url: 'WhoAmI', dependsOn: ['a'] },
  ])), check);
  assert.throws(() => parseBatch('application/json', jsonBatch([{ id: 'a', method: 'GET', url: 'WhoAmI', atomicityGroup: 'g' }])), { ...check, message: 'GET requests are not allowed inside change sets.' });
});

test('parts for an unmatched boundary are skipped and the batch answers 200 with nothing run', async () => {
  const { dispatch, calls } = fakeDispatch();
  const parsed = parseBatch('multipart/mixed; boundary=other', SAMPLE);
  assert.deepEqual(parsed.parts, []);
  const res = await run(parsed, dispatch);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test('an inner URL over 65,536 characters answers 400 0x80060888 for that part and runs nothing', async () => {
  const { dispatch, calls } = fakeDispatch();
  const prefix = '/api/data/v9.2/widgets?$filter=';
  const exact = prefix + 'a'.repeat(65536 - prefix.length);
  const tooLong = prefix + 'a'.repeat(65537 - prefix.length);
  assert.equal(exact.length, 65536);
  const res = await run(parseBatch(ct, batchOf([part(B, undefined, httpReq('GET', tooLong))])), dispatch);
  assert.equal(res.status, 400);
  assert.match(res.body, /0x80060888/);
  assert.match(res.body, /Invalid URI: The Uri string is too long\./);
  assert.equal(calls.length, 0);
  const ok = await run(parseBatch(ct, batchOf([part(B, undefined, httpReq('GET', exact))])), dispatch);
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

test('a $batch URL inside a batch is parsed and left to the router, which answers the part with 400', () => {
  for (const url of ['/api/data/v9.2/$batch', '/api/data/v9.2/$batch/', '/api/data/v9.2/%24batch']) {
    const { parts } = parseBatch(ct, batchOf([part(B, undefined, httpReq('POST', url, '{}'))]));
    assert.equal(parts[0].url, url);
  }
  assert.equal(parseBatch(ct, batchOf([part(B, undefined, httpReq('GET', '/api/data/v9.2/widgets?$filter=x/$batch'))])).parts[0].method, 'GET');
});

test('parts for a foreign boundary between declared parts are not executed and do not alter the part before them', async () => {
  const { dispatch, calls } = fakeDispatch();
  const foreign = ['--other', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', '', httpReq('POST', '/api/data/v9.2/fail', '{"name":"evil"}'), '--other--'].join(CRLF);
  const body = batchOf([
    part(B, undefined, httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}')),
    foreign,
    part(B, undefined, httpReq('GET', '/api/data/v9.2/widgets')),
  ]);
  const res = await run(parseBatch(ct, body), dispatch);
  assert.equal(res.status, 200);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ['POST', `${ORIGIN}/api/data/v9.2/widgets`, '{"name":"A"}'],
      ['GET', `${ORIGIN}/api/data/v9.2/widgets`, undefined],
    ],
  );
});

test('a foreign-boundary part inside a change set is not executed and the change set ends at its own close', async () => {
  const { dispatch, calls } = fakeDispatch();
  const foreign = ['--other', 'Content-Type: application/http', '', httpReq('POST', '/api/data/v9.2/fail', '{}'), '--other--'].join(CRLF);
  const cs = [`--${B}`, 'Content-Type: multipart/mixed; boundary=changeset_f', '', part('changeset_f', undefined, httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}')), foreign, '--changeset_f--'].join(CRLF);
  const res = await run(parseBatch(ct, batchOf([cs])), dispatch);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, '{"name":"A"}');
});

test('a change set boundary that starts with the batch boundary is a separate delimiter, not a malformed batch', async () => {
  const { dispatch, calls } = fakeDispatch();
  const res = await run(parseBatch(ct, batchOf([changeset(`${B}_cs`, [{ cid: '1', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}') }])])), dispatch);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('rejects LF-only framing as an unreadable stream', () => {
  assert.throws(() => parseBatch(ct, SAMPLE.replace(/\r\n/g, '\n')), { status: 400, message: 'Stream was not readable.' });
});

test('rejects nested change sets', () => {
  const nested = [
    `--${B}`,
    'Content-Type: multipart/mixed; boundary=cs1',
    '',
    '--cs1',
    'Content-Type: multipart/mixed; boundary=cs2',
    '',
    '--cs2',
    'Content-Type: application/http',
    '',
    httpReq('POST', '/api/data/v9.2/widgets', '{}'),
    '--cs2--',
    '--cs1--',
  ].join(CRLF);
  assert.throws(() => parseBatch(ct, batchOf([nested])), { status: 400, message: 'Nested change sets are not allowed.' });
});

test('rejects GET inside a change set', () => {
  const cs = changeset('cs1', [{ cid: '1', request: httpReq('GET', '/api/data/v9.2/widgets') }]);
  assert.throws(() => parseBatch(ct, batchOf([cs])), { status: 400, message: 'GET requests are not allowed inside change sets.' });
});

test('rejects more than 1000 requests and accepts exactly 1000', () => {
  const one = part(B, undefined, httpReq('POST', '/api/data/v9.2/widgets', '{}'));
  const sections = (n) => batchOf(Array.from({ length: n }, () => one));
  assert.equal(parseBatch(ct, sections(1000)).parts.length, 1000);
  assert.throws(() => parseBatch(ct, sections(1001)), { status: 400, code: 'InvalidBatch' });
});

test('single POST response uses batchresponse framing with 204, OData-EntityId and Location', async () => {
  const { dispatch } = fakeDispatch();
  const parsed = parseBatch(ct, batchOf([part(B, undefined, httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}'))]));
  const res = await run(parsed, dispatch);
  const id = /boundary=(batchresponse_\S+)/.exec(res.headers['content-type'])[1];
  assert.equal(res.status, 200);
  assert.equal(res.headers['OData-Version'], '4.0');
  assert.ok(res.body.startsWith(`--${id}${CRLF}Content-Type: application/http${CRLF}Content-Transfer-Encoding: binary${CRLF}${CRLF}HTTP/1.1 204 No Content${CRLF}`));
  assert.match(res.body, /OData-EntityId: http:\/\/127\.0\.0\.1:8080\/api\/data\/v9\.2\/widgets\([0-9a-f-]{36}\)/);
  assert.match(res.body, /Location: http:\/\/127\.0\.0\.1:8080\/api\/data\/v9\.2\/widgets\(/);
  assert.ok(res.body.endsWith(`--${id}--${CRLF}`));
  assert.equal(res.body.replace(/\r\n/g, '').includes('\n'), false);
});

test('changeset response nests a changesetresponse part that echoes Content-ID', async () => {
  const { dispatch } = fakeDispatch();
  const cs = changeset('changeset_1', [
    { cid: '1', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}') },
    { cid: '2', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"B"}') },
  ]);
  const res = await run(parseBatch(ct, batchOf([cs])), dispatch);
  assert.equal(res.status, 200);
  assert.match(res.body, /Content-Type: multipart\/mixed; boundary=changesetresponse_/);
  assert.equal(count(res.body, /Content-ID: 1\r\n/g), 1);
  assert.equal(count(res.body, /Content-ID: 2\r\n/g), 1);
  assert.equal(count(res.body, /HTTP\/1\.1 204 No Content/g), 2);
});

test('a top-level part answers without Content-ID, while a change set part keeps its echo', async () => {
  const { dispatch } = fakeDispatch();
  const cs = changeset('changeset_5', [{ cid: '3', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"C"}') }]);
  const res = await run(parseBatch(ct, batchOf([part(B, '1', httpReq('GET', '/api/data/v9.2/widgets')), cs])), dispatch);
  assert.equal(res.status, 200);
  assert.equal(count(res.body, /Content-ID: 1\r\n/g), 0);
  assert.equal(count(res.body, /Content-ID: 3\r\n/g), 1);
});

test('$1 references resolve in an @odata.bind body value and in a URL', async () => {
  const { dispatch, calls, created } = fakeDispatch();
  const cs = changeset('changeset_2', [
    { cid: '1', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}') },
    { cid: '2', request: httpReq('POST', '/api/data/v9.2/gadgets', '{"widgetid@odata.bind": "$1"}') },
    { cid: '3', request: httpReq('PATCH', '$1', '{"name":"B"}') },
  ]);
  const res = await run(parseBatch(ct, batchOf([cs])), dispatch);
  assert.equal(res.status, 200);
  assert.equal(calls[1].body, `{"widgetid@odata.bind": "/api/data/v9.2/widgets(${created[0]})"}`);
  assert.equal(calls[2].url, `${ORIGIN}/api/data/v9.2/widgets(${created[0]})`);
});

test('forward reference returns 400 with the batch-context message', async () => {
  const { dispatch, calls } = fakeDispatch();
  const cs = changeset('changeset_3', [
    { cid: '1', request: httpReq('POST', '/api/data/v9.2/gadgets', '{"widgetid@odata.bind": "$2"}') },
    { cid: '2', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"B"}') },
  ]);
  const res = await run(parseBatch(ct, batchOf([cs])), dispatch);
  assert.equal(res.status, 400);
  assert.match(res.body, /Content-ID Reference: '\$2' does not exist in the batch context\./);
  assert.equal(calls.length, 0);
});

test('without continue-on-error the batch stops at the failing part and keeps the parts that ran, with REQ_ID', async () => {
  const { dispatch, calls } = fakeDispatch();
  const parsed = parseBatch(ct, batchOf([
    part(B, undefined, httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}')),
    part(B, undefined, httpReq('POST', '/api/data/v9.2/fail', '{"name":"B"}')),
    part(B, undefined, httpReq('GET', '/api/data/v9.2/widgets')),
  ]));
  const res = await run(parsed, dispatch);
  assert.equal(res.status, 400);
  assert.equal(count(res.body, /HTTP\/1\.1 /g), 2);
  assert.match(res.body, /HTTP\/1\.1 204 No Content[\s\S]*HTTP\/1\.1 400 Bad Request/);
  assert.match(res.body, /REQ_ID: [0-9a-f-]{36}/);
  assert.match(res.body, /boom/);
  assert.equal(calls.length, 2);
  // The failed batch answers nosniff on the outer response as well (native batch.stop-on-error).
  assert.equal(res.headers["x-content-type-options"], "nosniff");
});

test('a part carries its own headers: no service envelope, and no REQ_ID or nosniff on a route failure', async () => {
  const envelope = { 'x-ms-service-request-id': 'r1', 'x-ms-dop-hint': '4', Allow: 'OPTIONS,GET,HEAD,POST', expires: '-1', 'Strict-Transport-Security': 'max-age=1' };
  // The route failure comes without REQ_ID, as the batch dispatch leaves it (dataverse-api.mjs).
  const dispatch = async (req) => {
    if (req.url.includes('route')) return { status: 404, headers: { ...envelope, 'cache-control': 'no-cache' }, body: { error: { code: '0x80060888', message: 'segment' } } };
    return { status: 200, headers: { ...envelope, ETag: 'W/"7"' }, body: { ok: true } };
  };
  const parsed = parseBatch(ct, batchOf([
    part(B, undefined, httpReq('GET', '/api/data/v9.2/widgets(1)')),
    part(B, undefined, httpReq('GET', '/api/data/v9.2/route')),
  ]));
  const res = await run(parsed, dispatch, { continueOnError: true });
  for (const name of ['x-ms-service-request-id', 'x-ms-dop-hint', 'Allow:', 'expires:', 'Strict-Transport-Security']) assert.equal(res.body.includes(name), false, name);
  // The success part: nosniff, the no-cache pair for an ETag, and the multipart JSON type (no streaming parameter).
  assert.match(res.body, /X-Content-Type-Options: nosniff\r\nCache-Control: no-cache\r\nPragma: no-cache\r\n/);
  assert.match(res.body, /Content-Type: application\/json; odata\.metadata=minimal\r\n/);
  assert.equal(res.body.includes('odata.streaming'), false);
  // The route failure carries no REQ_ID and no nosniff (native batch.continue-on-error).
  const routePart = res.body.slice(res.body.indexOf('HTTP/1.1 404'));
  assert.equal(routePart.includes('REQ_ID'), false);
  assert.equal(routePart.includes('x-content-type-options'), false);
  assert.equal(routePart.includes('Cache-Control'), false);
});

test('a JSON batch answers its parts with the streaming JSON type; a multipart batch does not', async () => {
  const { dispatch } = fakeDispatch();
  const json = await run(parseBatch('application/json; charset=utf-8', JSON.stringify({ requests: [{ id: '1', method: 'GET', url: 'WhoAmI' }] })), dispatch);
  assert.match(json.body, /Content-Type: application\/json; odata\.metadata=minimal; odata\.streaming=true/);
  const multipart = await run(parseBatch(ct, batchOf([part(B, undefined, httpReq('GET', '/api/data/v9.2/WhoAmI'))])), dispatch);
  assert.equal(multipart.body.includes('odata.streaming'), false);
});

test('with continue-on-error every part runs and the batch answers 200', async () => {
  const { dispatch, calls } = fakeDispatch();
  const parsed = parseBatch(ct, batchOf([
    part(B, undefined, httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}')),
    part(B, undefined, httpReq('POST', '/api/data/v9.2/fail', '{"name":"B"}')),
    part(B, undefined, httpReq('GET', '/api/data/v9.2/widgets')),
  ]));
  const res = await run(parsed, dispatch, { continueOnError: true });
  assert.equal(res.status, 200);
  assert.equal(count(res.body, /HTTP\/1\.1 /g), 3);
  assert.equal(calls.length, 3);
});

test('a failing change set runs through the transaction hook and rolls back', async () => {
  const { dispatch: base } = fakeDispatch();
  const log = [];
  const dispatch = Object.assign(base, {
    transaction: async (fn) => {
      log.push('begin');
      try {
        const out = await fn();
        log.push('commit');
        return out;
      } catch (error) {
        log.push('rollback');
        throw error;
      }
    },
  });
  const cs = changeset('changeset_4', [
    { cid: '1', request: httpReq('POST', '/api/data/v9.2/widgets', '{"name":"A"}') },
    { cid: '2', request: httpReq('POST', '/api/data/v9.2/fail', '{"name":"B"}') },
  ]);
  const res = await run(parseBatch(ct, batchOf([cs])), dispatch);
  assert.deepEqual(log, ['begin', 'rollback']);
  assert.equal(res.status, 400);
  // Native answers a failed change set with its changesetresponse part holding only the failing response, Content-ID kept.
  assert.match(res.body, /Content-Type: multipart\/mixed; boundary=changesetresponse_/);
  assert.equal(count(res.body, /Content-ID: 2\r\n/g), 1);
  assert.equal(count(res.body, /Content-ID: 1\r\n/g), 0);
  assert.equal(count(res.body, /HTTP\/1\.1 /g), 1);
});

test('reasonPhrase returns standard HTTP reason phrases', () => {
  assert.equal(reasonPhrase(200), 'OK');
  assert.equal(reasonPhrase(201), 'Created');
  assert.equal(reasonPhrase(204), 'No Content');
  assert.equal(reasonPhrase(400), 'Bad Request');
});
