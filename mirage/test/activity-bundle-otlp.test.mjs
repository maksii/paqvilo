// @test-kind contract: the otlp bundle keeps its bytes and writes the spans of each trace as one batch (ADM-6)
// The activity bundle (lib/sim-activity.mjs, traces=otlp) over fixed span records: no clock is read, so the bytes of the
// otlp line are the same on every run, and the pinned digest is the canonical JSON of that document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeActivityBundle } from '../lib/sim-activity.mjs';

const ONE = 'aaaaaaaa-0000-4000-8000-000000000001';
const TWO = 'aaaaaaaa-0000-4000-8000-000000000002';
const span = (traceId, spanId, parentSpanId, name, minute) => ({
  traceId,
  spanId,
  parentSpanId,
  name,
  kind: 'http',
  module: 'http',
  operation: 'GET',
  status: 'ok',
  level: 'summary',
  startedAt: `2026-11-01T10:${minute}:00.000Z`,
  durationMs: 12.5,
  attributes: { url: 'http://127.0.0.1/x' },
});
const trees = {
  [ONE]: {
    trace: { traceId: ONE, name: 'GET /one', startedAt: '2026-11-01T10:01:00.000Z' },
    spans: [
      span(ONE, '11111111-0000-4000-8000-000000000001', null, 'GET /one', '01'),
      span(ONE, '11111111-0000-4000-8000-000000000002', '11111111-0000-4000-8000-000000000001', 'child', '01'),
    ],
  },
  [TWO]: {
    trace: { traceId: TWO, name: 'GET /two', startedAt: '2026-11-01T10:02:00.000Z' },
    spans: [span(TWO, '22222222-0000-4000-8000-000000000001', null, 'GET /two', '02')],
  },
};

/** The bundle's writes (each a string) and its lines, for the otlp format over the two fixed traces. */
async function exportOtlp() {
  const writes = [];
  const res = new EventEmitter();
  res.destroyed = false;
  res.writeHead = () => {};
  res.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) writes.push(String(chunk));
  };
  const traces = {
    query: () => ({ items: [{ traceId: ONE }, { traceId: TWO }], total: 2, page: 1, pageSize: 200, pageCount: 1 }),
    tree: (traceId) => trees[traceId] ?? null,
  };
  await writeActivityBundle(res, new URLSearchParams({ format: 'bundle', traces: 'otlp' }), {
    traces,
    audit: { entries: [] },
    logs: () => [],
    diagnostics: () => [],
    evidence: async () => null,
    runtime: () => ({ host: 'invented' }),
  });
  const lines = writes.join('').split('\n').filter(Boolean);
  return { writes, otlpLine: lines.find((line) => line.startsWith('{"kind":"otlp"')) };
}

test('the otlp line of a small bundle keeps its pinned bytes and span order', async () => {
  const { otlpLine } = await exportOtlp();
  const digest = createHash('sha256').update(`${otlpLine}\n`).digest('hex');
  assert.equal(digest, '219fe5acd184817863e44359f3205b1f6a04c6c3701713aae4b55c2c14bb620c');
  assert.equal(Buffer.byteLength(`${otlpLine}\n`), 2485);
  const document = JSON.parse(otlpLine);
  assert.deepEqual(
    document.resourceSpans[0].scopeSpans[0].spans.map((item) => item.name),
    ['GET /one', 'child', 'GET /two'],
  );
});

test('the spans of each trace are written in their own batch, never in one write with another trace', async () => {
  const { writes } = await exportOtlp();
  const batchOf = (name) => writes.find((chunk) => chunk.includes(`"name":"${name}"`));
  assert.ok(batchOf('GET /one'), 'the first trace has a batch');
  assert.ok(batchOf('GET /two'), 'the second trace has a batch');
  assert.notEqual(batchOf('GET /one'), batchOf('GET /two'), 'the two traces are written in separate batches');
});
