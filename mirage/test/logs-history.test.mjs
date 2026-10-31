// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// The runtime log stream history (D-M-4): a bounded server-side ring (mirage.logs.retain) with the startup lines and every
// later line, each naming its trace when it was emitted in one; GET /_sim/api/logs pages it; the `logs` SSE channel sends
// the same lines; a declarative plugin rule is one `rule` span event and one `plugin` line from the same hook, with no
// state snapshot per write.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_RETAIN_DEFAULT, logSettings, parseSetting } from '../lib/config-keys.mjs';
import { drainFixture } from '../testing/owned-fixture.mjs';
import { monitorPortal, monitorState, startMonitorRuntime } from './support/monitor-runtime.mjs';
import { endedTree } from './support/trace-scenario.mjs';

const closers = [];
after(() => drainFixture(closers));
const runtime = (options = {}) =>
  startMonitorRuntime(closers, {
    prefix: 'logs-history-',
    files: monitorPortal({ name: 'Invented log history', source: '<main>Home</main>', fields: 'x_name,x_code' }),
    // Two declarative plugin rules: one stamps a column, one refuses a row without a name.
    state: monitorState({
      plugins: [
        { id: 'stamp', entity: 'x_item', operations: ['create'], set: { x_code: 'STAMPED' } },
        {
          id: 'needs-name',
          entity: 'x_item',
          operations: ['create'],
          validate: [{ field: 'x_name', required: true, message: 'A name is required.' }],
        },
      ],
    }),
    ...options,
  });
let shared;
const sharedRuntime = () => (shared ??= runtime());
const create = (sim, body) =>
  fetch(sim.url + '/_api/x_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', __requestverificationtoken: sim.csrf },
    body: JSON.stringify(body),
  });

test('mirage.logs: retain defaults to 2000, accepts 0..50000 and refuses anything else', () => {
  assert.equal(LOG_RETAIN_DEFAULT, 2000);
  assert.deepEqual(logSettings(undefined), { retain: 2000 });
  assert.deepEqual(parseSetting('logs', { retain: 0 }), { retain: 0 });
  assert.deepEqual(parseSetting('logs', { retain: 50000 }), { retain: 50000 });
  for (const value of [{ retain: -1 }, { retain: 50001 }, { retain: 1.5 }, { retain: '10' }, { keep: 1 }, 'all'])
    assert.throws(() => logSettings(value), /logs/, JSON.stringify(value));
});

test('the history holds the startup lines, recorded before anyone subscribed', async () => {
  const { client, sim } = await sharedRuntime();
  const { items } = await client.logs({ type: 'startup', limit: 100 });
  const phases = items.map((line) => line.phase);
  assert.equal(phases[0], 'configuration');
  assert.equal(phases.at(-1), 'listener-ready');
  const ready = items.at(-1);
  assert.equal(ready.origin, sim.url);
  assert.match(ready.message, /Runtime ready at/);
  assert.ok(items.every((line) => line.traceId === null && line.spanId === null && line.level === 'info'));
  assert.ok(
    items.every((line, index) => index === 0 || line.sequence > items[index - 1].sequence),
    'oldest first',
  );
});

test('request lines name their trace; type, traceId, since and limit page the history', async () => {
  const { sim, client } = await sharedRuntime();
  const response = await fetch(sim.url + '/');
  await response.text();
  const traceId = response.headers.get('x-trace-id');
  await endedTree(sim.trace, traceId);
  const ofTrace = await client.logs({ traceId });
  assert.deepEqual(
    ofTrace.items.map((line) => [line.type, line.traceId, line.entry?.id]),
    [['request', traceId, response.headers.get('x-sim-trace-id')]],
  );
  assert.equal(ofTrace.items[0].spanId, response.headers.get('x-sim-span-id'));
  const all = await client.logs({ limit: 3 });
  assert.equal(all.items.length, 3);
  assert.equal(all.items.at(-1).sequence, all.latestSequence, 'without since: the newest lines');
  assert.equal(all.more, true);
  const after = await client.logs({ since: all.oldestSequence, limit: 2 });
  assert.deepEqual(
    after.items.map((line) => line.sequence),
    [all.oldestSequence + 1, all.oldestSequence + 2],
    'since: the oldest lines after it',
  );
  assert.equal(all.retain, 2000);
  for (const [query, parameter] of [
    ['since=-1', 'since'],
    ['limit=0', 'limit'],
    ['type=Not A Type', 'type'],
  ]) {
    const refused = await fetch(`${sim.url}/_sim/api/logs?${query}`);
    assert.equal(refused.status, 400, query);
    assert.deepEqual([(await refused.json()).error.code, parameter], ['InvalidLogFilter', parameter]);
  }
});

test('a plugin rule is a rule event on its span and a plugin line from the same hook, without a subscriber', async () => {
  const { sim, client } = await sharedRuntime();
  const created = await create(sim, { x_name: 'Ruled' });
  assert.ok(created.status < 300, String(created.status));
  const tree = await endedTree(sim.trace, created.headers.get('x-trace-id'));
  const ruled = tree.spans.filter((span) => span.events.some((event) => event.type === 'rule'));
  const events = ruled.flatMap((span) => span.events.filter((event) => event.type === 'rule'));
  assert.deepEqual(
    events.map((event) => [event.attributes.rule, event.attributes.result, event.attributes.changes]),
    [
      ['stamp', 'applied', ['x_code']],
      ['needs-name', 'applied', []],
    ],
  );
  assert.ok(
    ruled.every((span) => span.kind === 'dataverse'),
    ruled.map((span) => span.kind).join(','),
  );
  const lines = (await client.logs({ type: 'plugin', traceId: tree.trace.traceId })).items;
  assert.deepEqual(
    lines.map((line) => [line.rule, line.result, line.outcome, line.entity, line.operation, line.spanId]),
    [
      ['stamp', 'applied', 'evaluated', 'x_item', 'create', ruled[0].spanId],
      ['needs-name', 'applied', 'evaluated', 'x_item', 'create', ruled.at(-1).spanId],
    ],
  );
  // A refused row: the rule event and the line say rejected with the rule's message.
  const refused = await create(sim, { x_code: 'nameless' });
  assert.equal(refused.status, 400);
  const failed = await endedTree(sim.trace, refused.headers.get('x-trace-id'));
  const rejection = failed.spans
    .flatMap((span) => span.events)
    .find((event) => event.type === 'rule' && event.attributes.result === 'rejected');
  assert.deepEqual([rejection.attributes.rule, rejection.attributes.message], ['needs-name', 'A name is required.']);
  const [line] = (await client.logs({ type: 'plugin', traceId: failed.trace.traceId })).items.filter(
    (item) => item.result === 'rejected',
  );
  assert.deepEqual([line.level, line.outcome, line.error.message], ['error', 'rejected', 'A name is required.']);
});

test('the logs channel sends the same lines live; its connected frame names the latest retained sequence', async () => {
  const { sim, client } = await sharedRuntime();
  const before = (await client.logs({ limit: 1 })).latestSequence;
  const controller = new AbortController();
  const response = await fetch(`${sim.url}/__sim/events?channels=logs`, { signal: controller.signal });
  const decoder = new TextDecoder();
  let buffer = '',
    connected = null,
    request = null,
    requested = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^event: log\ndata: (.*)$/m.exec(frame);
      if (!data) continue;
      const line = JSON.parse(data[1]);
      if (line.type === 'connected') {
        connected = line;
        // Requested once connected, so its line can only arrive on the stream after this frame.
        requested = fetch(sim.url + '/').then(async (page) => {
          await page.text();
          return page.headers.get('x-trace-id');
        });
      } else if (line.type === 'request') request = line;
    }
    if (request) break;
  }
  controller.abort();
  const history = await client.logs({ since: connected.sequence });
  assert.equal(connected.sequence, before, 'the connected frame names the latest retained line');
  assert.equal(request.sequence, before + 1, 'the connected frame consumes no sequence number');
  assert.equal(request.traceId, await requested);
  assert.deepEqual(
    history.items.find((line) => line.sequence === request.sequence),
    request,
    'the streamed line is the retained line',
  );
});

test('mirage.logs.retain bounds the history and counts what it dropped', async () => {
  const { sim, client } = await runtime({ logs: { retain: 3 } });
  const page = await fetch(sim.url + '/');
  await page.text();
  await endedTree(sim.trace, page.headers.get('x-trace-id'));
  const history = await client.logs({ limit: 50 });
  assert.equal(history.retain, 3);
  assert.equal(history.retained, 3);
  assert.equal(history.items.length, 3);
  assert.ok(history.dropped > 0);
  assert.equal(history.items.at(-1).sequence, history.latestSequence);
  assert.equal(history.oldestSequence, history.latestSequence - 2);
});
