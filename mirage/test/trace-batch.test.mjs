// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of Web API $batch (docs/design/tracing.md): one `batch` span under the listener root, one `part` span per request
// and one `changeset` span per changeset with its parts under it; a rolled-back changeset ends `error` with `rolledBack: true`
// (on it and on the parts that ran before the failure), the failing part carries its own error, and the batch and the root
// name it. Invented schema.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { MISSING_ID, childrenOf, spanOf, startListener } from './support/trace-listener.mjs';

const CRLF = '\r\n';
const API = '/api/data/v9.2/';
const multipart = (boundary, parts) =>
  `${parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF)}${CRLF}--${boundary}--`;
const httpPart = ({ contentId, method, path, json, headers = [] }) =>
  [
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    ...(contentId ? [`Content-ID: ${contentId}`] : []),
    '',
    `${method} ${path} HTTP/1.1`,
    ...headers,
    ...(json !== undefined ? ['Content-Type: application/json', '', JSON.stringify(json)] : []),
  ].join(CRLF);
const changesetPart = (boundary, requests) =>
  ['Content-Type: multipart/mixed; boundary=' + boundary, '', multipart(boundary, requests)].join(CRLF);

let listener;
before(async () => {
  listener = await startListener();
});
after(() => listener?.close());

const batch = (boundary, parts) =>
  listener.request('POST', `${API}$batch`, {
    body: `${multipart(boundary, parts)}${CRLF}`,
    headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
  });
const rootOf = (tree) => tree.spans.find((span) => span.parentSpanId === null);

test('a batch is a batch span with one part span per request and a changeset span holding its parts', async () => {
  const answer = await batch('batch_trace_ok', [
    httpPart({ method: 'GET', path: `${API}WhoAmI` }),
    changesetPart('cs_trace_ok', [
      httpPart({ contentId: '1', method: 'POST', path: `${API}fx_widgets`, json: { fx_name: 'Batch one' } }),
      httpPart({ contentId: '2', method: 'POST', path: `${API}fx_widgets`, json: { fx_name: 'Batch two' } }),
    ]),
  ]);
  assert.equal(answer.status, 200, answer.text);
  const tree = await listener.tree(answer.traceId);
  const root = rootOf(tree);
  const [span] = childrenOf(tree, root);
  assert.deepEqual(
    [span.kind, span.name, span.status, span.attributes.parts, span.attributes.changesets, span.attributes.requests],
    ['batch', '$batch', 'ok', 2, 1, 3],
  );
  const [whoAmI, changeset] = childrenOf(tree, span);
  assert.deepEqual(
    [whoAmI.kind, whoAmI.name, whoAmI.status, whoAmI.attributes.statusCode],
    ['part', 'GET /api/data/v9.2/WhoAmI', 'ok', 200],
  );
  assert.ok(
    spanOf(tree, { kind: 'function', name: 'WhoAmI', parentSpanId: whoAmI.spanId }),
    'the part runs its request',
  );
  assert.deepEqual([changeset.kind, changeset.status, changeset.attributes.requests], ['changeset', 'ok', 2]);
  assert.equal(changeset.attributes.rolledBack, undefined);
  const parts = childrenOf(tree, changeset);
  assert.deepEqual(
    parts.map((part) => [part.kind, part.name, part.attributes.contentId, part.status]),
    [
      ['part', 'POST /api/data/v9.2/fx_widgets', '1', 'ok'],
      ['part', 'POST /api/data/v9.2/fx_widgets', '2', 'ok'],
    ],
  );
  assert.deepEqual(parts[0].input.body, JSON.stringify({ fx_name: 'Batch one' }));
  for (const part of parts)
    assert.ok(
      childrenOf(tree, part).some((child) => child.kind === 'dataverse' && child.operation === 'create'),
      'each create runs under its part',
    );
});

test('a failed changeset ends error and rolledBack; the failing part carries its error; the batch and root name it', async () => {
  const before = listener.store.tableRows('fx_widget').length;
  const answer = await batch('batch_trace_bad', [
    changesetPart('cs_trace_bad', [
      httpPart({ contentId: '1', method: 'POST', path: `${API}fx_widgets`, json: { fx_name: 'Rolled back' } }),
      httpPart({
        contentId: '2',
        method: 'PATCH',
        path: `${API}fx_widgets(${MISSING_ID})`,
        headers: ['If-Match: *'],
        json: { fx_name: 'x' },
      }),
    ]),
  ]);
  assert.equal(answer.status, 404, answer.text);
  assert.equal(listener.store.tableRows('fx_widget').length, before, 'the changeset rolled back');
  const tree = await listener.tree(answer.traceId);
  const changeset = spanOf(tree, { kind: 'changeset' });
  assert.deepEqual([changeset.status, changeset.attributes.rolledBack], ['error', true]);
  assert.equal(changeset.attributes.failedContentId, '2');
  assert.match(changeset.error.message, /Does Not Exist/);
  const [created, failed] = childrenOf(tree, changeset);
  assert.deepEqual([created.status, created.attributes.rolledBack], ['ok', true], 'the earlier write was rolled back');
  assert.deepEqual(
    [failed.status, failed.attributes.statusCode, failed.error.status, failed.attributes.rolledBack],
    ['error', 404, 404, undefined],
  );
  assert.match(failed.error.message, /Does Not Exist/);
  const span = spanOf(tree, { kind: 'batch' });
  assert.deepEqual([span.status, span.error.message], ['error', failed.error.message]);
  const root = rootOf(tree);
  assert.deepEqual([root.status, root.error.message, root.error.status], ['error', failed.error.message, 404]);
});
