// End-to-end tracing on the real Power Pages host (docs/design/tracing.md, test/support/trace-scenario.mjs): one member's
// Web API create, its permission decisions, plug-in stages and steps, a plug-in to plug-in chain, a web hook whose receiver
// writes back with the forwarded headers, an asynchronous plug-in job, a row-triggered flow with a Key Vault secret, a
// fixture connector and a Dataverse update, the member's page GET and a stranger's refused read all form ONE trace with
// the expected parent at every hop. The same tree comes back from the store, the _sim route, connectRuntime and the CLI;
// filters and stats find it; level full captures redacted payloads and never a secret; level summary captures none.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectRuntime } from '../testing/runtime.mjs';
import {
  ACCESS_TOKEN,
  FLOW,
  HOOK_CODE,
  MEMBER,
  RECEIPT,
  SDK_USER,
  SECRET_VALUE,
  STEP,
  STRANGER,
  endedTree,
  runTraceScenario,
  skeleton,
} from './support/trace-scenario.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
let run;
before(async () => {
  run = await runTraceScenario({ level: 'full' });
});
after(() => run?.close());

const byKind = (spans, kind) => spans.filter((span) => span.kind === kind);
const named = (spans, kind, name) => {
  const found = spans.filter((span) => span.kind === kind && span.name === name);
  assert.equal(found.length, 1, `exactly one ${kind} ${name}`);
  return found[0];
};
const ancestors = (spans, span) => {
  const index = new Map(spans.map((record) => [record.spanId, record]));
  const chain = [];
  for (let at = index.get(span.parentSpanId); at; at = index.get(at.parentSpanId)) chain.push(at);
  return chain;
};

test('the scenario ran: plug-ins, web hook write-back, async job, flow, page render and refusal', () => {
  const { sim, handled, hook, page, denied, orderId } = run;
  assert.deepEqual(handled, ['pre-validation', 'pre-operation', 'post-operation', 'audit', 'async']);
  assert.equal(hook.deliveries.length, 1);
  assert.match(hook.deliveries[0].url, /^\/hooks\/receipt\?code=/, 'the receiver gets the WebhookKey code');
  assert.equal(sim.store.tableRows('x_receipt')[0].x_note, 'Delivered');
  assert.equal(sim.store.tableRows('x_audit')[0].x_name, 'Audit of Order one');
  const order = sim.store.tableRows('x_order').find((row) => row.x_orderid === orderId);
  assert.equal(order.x_status, 'quoted Order one', 'the flow wrote the connector answer back');
  assert.equal(page.status, 200);
  assert.match(page.html, /<p id="order">Order one\|quoted Order one<\/p>/);
  assert.equal(denied.status, 403);
});

test('ONE trace holds every hop with exactly the expected parent at each', () => {
  const { tree, traceId, rootSpanId, orderId, sim } = run;
  // Every span of the scenario, and nothing else, is in the one trace.
  assert.equal(tree.trace.traceId, traceId);
  assert.ok(tree.spans.every((span) => span.traceId === traceId));
  assert.equal(tree.children.length, 1, 'one root');
  assert.equal(tree.root.spanId, rootSpanId);
  assert.equal(tree.root.parentSpanId, null);
  assert.equal(sim.trace.spans({ traceId, pageSize: 200 }).total, tree.spans.length);
  const stage = (entity, name) => `plugin-stage Create ${entity} · ${name}`;
  const leaf = (label) => [label, []];
  assert.deepEqual(skeleton(tree.children), [
    [
      'http POST /_api/x_orders',
      [
        [`http GET /_api/x_orders(${orderId})`, [['webapi GET x_orders', [leaf('store Retrieve x_order')]]]],
        [
          'http GET /order/',
          [
            [
              'render /order/',
              [
                // The empty Head/Bottom and Browser Title Suffix snippets render without a source reference: their
                // slot names them.
                leaf('render-template snippet Browser Title Suffix'),
                leaf('render-template snippet Head/Bottom'),
                [
                  'render-template webtemplate Order',
                  [['render-template webtemplate Order detail', [leaf('read liquid-fetchxml x_order')]]],
                ],
              ],
            ],
          ],
        ],
        [
          'webapi POST x_orders',
          [
            [
              'dataverse Create x_order',
              [
                [
                  'job Flow When an order is created',
                  [
                    [
                      'flow-run When an order is created',
                      [
                        [
                          'flow-action GetSecret',
                          [
                            [
                              'connector shared_commondataserviceforapps/PerformUnboundAction',
                              [['dataverse PerformUnboundAction', [leaf('secret Secret inventedvault/x-api-key')]]],
                            ],
                          ],
                        ],
                        [
                          'flow-action Mark',
                          [
                            [
                              'connector shared_commondataserviceforapps/UpdateRecord',
                              [leaf('dataverse UpdateRecord x_order')],
                            ],
                          ],
                        ],
                        ['flow-action Quote', [leaf('connector x_quotes/Quote')]],
                      ],
                    ],
                  ],
                ],
                [
                  'job Order async follow-up',
                  [[stage('x_order', 'PostOperation'), [leaf('plugin-step Order async follow-up')]]],
                ],
                [
                  stage('x_order', 'PostOperation'),
                  [
                    [
                      'plugin-step Order post-operation',
                      [
                        [
                          'dataverse Create x_audit',
                          [[stage('x_audit', 'PreOperation'), [leaf('plugin-step Audit pre-operation')]]],
                        ],
                      ],
                    ],
                    [
                      'plugin-step Order receipt web hook',
                      [
                        [
                          'http-out POST /hooks/receipt',
                          [
                            [
                              `http PATCH /_api/x_receipts(${RECEIPT})`,
                              [['webapi PATCH x_receipts', [leaf('dataverse Update x_receipt')]]],
                            ],
                          ],
                        ],
                      ],
                    ],
                  ],
                ],
                [stage('x_order', 'PreOperation'), [leaf('plugin-step Order pre-operation')]],
                [stage('x_order', 'PreValidation'), [leaf('plugin-step Order pre-validation')]],
              ],
            ],
          ],
        ],
      ],
    ],
  ]);

  const spans = tree.spans;
  // The web hook receiver's request is a new http root segment parented by the delivery's http-out span through the
  // headers it forwarded.
  const delivery = byKind(spans, 'http-out')[0];
  const hookHeaders = run.hook.deliveries[0].headers;
  assert.deepEqual(
    [hookHeaders['x-sim-parent-trace'], hookHeaders['x-trace-id'], hookHeaders['x-sim-trace-id']],
    [delivery.spanId, traceId, traceId],
  );
  const writeBack = sim.trace.span(run.writeBack.spanId);
  assert.deepEqual([writeBack.kind, writeBack.parentSpanId], ['http', delivery.spanId]);
  // Jobs are async segments parented (and linked staged-by) by the span that staged them: the Create x_order span.
  const create = named(spans, 'dataverse', 'Create x_order');
  for (const job of byKind(spans, 'job')) {
    assert.equal(job.async, true);
    assert.equal(job.parentSpanId, create.spanId);
    assert.deepEqual(job.links, [{ traceId, spanId: create.spanId, relation: 'staged-by' }]);
  }
  // The staging event lands on the span each job names as its parent.
  const staged = create.events.filter((event) => event.type === 'job-staged').map((event) => event.attributes.kind);
  assert.deepEqual(staged.sort(), ['flow', 'plugin'], 'the commit records both staged jobs');
  assert.deepEqual(
    byKind(spans, 'job')
      .map((job) => job.attributes.kind)
      .sort(),
    ['flow', 'plugin'],
  );
  // The browser follow-ups join under the create's root.
  assert.equal(sim.trace.span(run.page.spanId).parentSpanId, rootSpanId);
  assert.equal(sim.trace.span(run.denied.spanId).parentSpanId, rootSpanId);
});

test('every span is ended with a duration, the expected actor, session and origin host', () => {
  const { tree, traceId } = run;
  const spans = tree.spans;
  const kinds = new Map();
  for (const span of spans) {
    assert.equal(typeof span.durationMs, 'number', `${span.kind} ${span.name} has a duration`);
    assert.notEqual(span.status, 'running');
    kinds.set(span.kind, (kinds.get(span.kind) ?? 0) + 1);
  }
  const contact = (span, contactId = MEMBER) =>
    assert.deepEqual([span.actor.kind, span.actor.id], ['contact', contactId], `${span.kind} ${span.name} actor`);
  const flowJob = named(spans, 'job', 'Flow When an order is created'),
    pluginJob = named(spans, 'job', 'Order async follow-up'),
    deniedRoot = run.sim.trace.span(run.denied.spanId);
  for (const span of spans) {
    const chain = ancestors(spans, span),
      under = (record) => chain.some((ancestor) => ancestor.spanId === record.spanId);
    const inJob = span.kind === 'job' || under(flowJob) || under(pluginJob);
    assert.equal(span.origin.host, inJob ? 'job' : 'power-pages', `${span.kind} ${span.name} origin`);
    assert.equal(span.origin.portal, 'Invented end-to-end portal', `${span.kind} ${span.name} portal`);
    // Every span carries the session of the request it descends from (the stranger's refused read has its own).
    const visitor = span.spanId === deniedRoot.spanId || under(deniedRoot) ? STRANGER : MEMBER;
    assert.equal(span.session.sessionKey, `contact:${visitor}`, `${span.kind} ${span.name} session`);
    if (span.kind === 'plugin-step')
      assert.deepEqual(
        [span.actor.kind, span.actor.id, span.module],
        ['plugin', span.attributes.stepId, 'plugins'],
        span.name,
      );
    else if (under(flowJob))
      assert.deepEqual([span.actor.kind, span.actor.id], ['flow', FLOW], `${span.kind} ${span.name} actor`);
    else if (span.name.endsWith('x_audit') || chain.some((record) => record.name === 'Create x_audit'))
      // The plug-in's SDK write runs as its service profile user.
      assert.deepEqual([span.actor.kind, span.actor.id], ['staff', SDK_USER], `${span.kind} ${span.name} actor`);
    else if (span.kind === 'http-out') assert.deepEqual([span.actor.kind, span.actor.id], ['plugin', STEP.webhook]);
    else contact(span, span.spanId === deniedRoot.spanId || under(deniedRoot) ? STRANGER : MEMBER);
  }
  for (const span of byKind(spans, 'http'))
    assert.deepEqual(span.origin, { host: 'power-pages', portal: 'Invented end-to-end portal', preset: null });
  // Plug-in trace lines are events on their step span; permission decisions are events, never spans, when allowed.
  assert.deepEqual(
    named(spans, 'plugin-step', 'Order pre-validation').events.map((event) => [event.type, event.message]),
    [['trace', 'Pre-validation checked Order one']],
  );
  const decision = named(spans, 'dataverse', 'Create x_order').events.find((event) => event.type === 'permission');
  assert.deepEqual(
    [decision.attributes.table, decision.attributes.operation, decision.attributes.result],
    ['x_order', 'create', 'allow'],
  );
  assert.deepEqual(byKind(spans, 'permission'), []);
  // The stranger's read is denied at every level of its segment, with the refused decision as an event.
  const refused = ancestors(spans, named(spans, 'store', 'Retrieve x_order'));
  assert.deepEqual(
    [named(spans, 'store', 'Retrieve x_order'), ...refused.slice(0, 2)].map((span) => [span.kind, span.status]),
    [
      ['store', 'denied'],
      ['webapi', 'denied'],
      ['http', 'denied'],
    ],
  );
  assert.equal(deniedRoot.attributes.statusCode, 403);
  assert.ok(
    named(spans, 'store', 'Retrieve x_order').events.some(
      (event) => event.type === 'permission' && event.attributes.result === 'deny',
    ),
  );
  assert.deepEqual(
    [run.tree.trace.status, run.tree.trace.errorCount, run.tree.trace.deniedCount, run.tree.trace.spanCount],
    ['ok', 0, 3, spans.length],
  );
  assert.equal(traceId, run.tree.trace.traceId);
  assert.deepEqual(run.tree.trace.kinds, Object.fromEntries(kinds));
});

test('level full captures redacted payloads; no secret, token or web hook key appears anywhere in the export', () => {
  const { tree, sim } = run;
  const spans = tree.spans;
  const webapi = named(spans, 'webapi', 'POST x_orders');
  assert.deepEqual(webapi.input, { x_name: 'Order one', x_accesstoken: '[redacted]' });
  assert.equal(webapi.output.status, 204);
  const preOperation = named(spans, 'plugin-step', 'Order pre-operation');
  assert.equal(preOperation.input.target.x_name, 'Order one');
  assert.equal(preOperation.input.target.x_accesstoken, '[redacted]');
  assert.deepEqual(preOperation.output.output, { target: { x_status: 'new' } });
  const quote = named(spans, 'flow-action', 'Quote');
  assert.equal(quote.input.parameters.name, 'Order one');
  assert.equal(quote.output.body.quote, 'quoted Order one');
  const connector = named(spans, 'connector', 'x_quotes/Quote');
  assert.deepEqual(connector.input, { name: 'Order one' });
  assert.equal(connector.output.body.quote, 'quoted Order one');
  const mark = named(spans, 'flow-action', 'Mark');
  assert.equal(mark.input.parameters['item/x_status'], 'quoted Order one');
  const getSecret = named(spans, 'flow-action', 'GetSecret');
  assert.equal(getSecret.output.body.EnvironmentVariableSecretValue, '[redacted]');
  const secret = byKind(spans, 'secret')[0];
  assert.deepEqual(
    [secret.status, secret.attributes.key, secret.attributes.status, 'input' in secret, 'output' in secret],
    ['ok', 'inventedvault/x-api-key', 'resolved', false, false],
  );
  // The whole export (every retained trace) holds none of the secret material.
  const exported = JSON.stringify(sim.trace.export({}));
  for (const needle of [SECRET_VALUE, ACCESS_TOKEN, HOOK_CODE, 'Bearer', 'bearer '])
    assert.equal(exported.includes(needle), false, `the export never contains ${needle}`);
});

test('query filters find the trace by entity, actor, session, kind, module, errors and duration; stats match', () => {
  const { sim, traceId, tree } = run;
  const ids = (filters) => sim.trace.query({ ...filters, pageSize: 200 }).items.map((item) => item.traceId);
  const total = tree.trace.totalDurationMs;
  for (const filters of [
    { entity: 'x_order' },
    { entity: 'x_receipt' },
    { actorId: `{${MEMBER.toUpperCase()}}` },
    { actorKind: 'flow', actorId: FLOW },
    { sessionKey: `contact:${MEMBER}` },
    { kind: 'plugin-step' },
    { module: 'flows' },
    { kind: 'secret', status: 'ok' },
    { hasErrors: 'false' },
    { status: 'denied' },
    { host: 'job' },
    { minDurationMs: String(total) },
  ])
    assert.ok(ids(filters).includes(traceId), JSON.stringify(filters));
  for (const filters of [{ hasErrors: 'true' }, { minDurationMs: String(total + 60000) }, { entity: 'x_absent' }])
    assert.equal(ids(filters).includes(traceId), false, JSON.stringify(filters));
  assert.equal(sim.trace.spans({ traceId, kind: 'plugin-step', pageSize: 200 }).total, 6);
  assert.equal(sim.trace.spans({ traceId, actorKind: 'flow', pageSize: 200 }).total, 10);

  const stats = sim.trace.stats({ traceId });
  assert.equal(stats.count, tree.spans.length);
  assert.deepEqual(
    Object.fromEntries(Object.entries(stats.byKind).map(([kind, figures]) => [kind, figures.count])),
    tree.trace.kinds,
  );
  assert.equal(stats.byStatus.denied.count, 3);
  assert.equal(stats.roots.count, 1);
  assert.deepEqual(tree.trace.kinds, {
    http: 4,
    webapi: 3,
    dataverse: 5,
    'plugin-stage': 5,
    'plugin-step': 6,
    'http-out': 1,
    job: 2,
    'flow-run': 1,
    'flow-action': 3,
    connector: 3,
    secret: 1,
    render: 1,
    'render-template': 4,
    read: 1,
    store: 1,
  });
});

test('the _sim route, connectRuntime().trace and the CLI return the same tree', async () => {
  const { sim, traceId } = run;
  const expected = sim.trace.tree(traceId);
  const route = await fetch(`${sim.url}/_sim/api/trace/${traceId}`);
  assert.equal(route.status, 200);
  assert.deepEqual(await route.json(), expected);
  const client = await connectRuntime({ origin: sim.url });
  assert.deepEqual(await client.trace.tree(traceId), expected);
  const stdout = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [path.join(repo, 'bin/paqvilo.mjs'), 'mirage', 'trace', 'show', traceId, '--origin', sim.url, '--json'],
      { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, out, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(out)),
    ),
  );
  const shown = JSON.parse(stdout);
  assert.deepEqual([shown.schemaVersion, shown.ok, shown.command], [1, true, 'show']);
  assert.deepEqual(shown.result, expected);
});

test('level summary records the same causal shape without any input or output', async () => {
  const { sim } = run;
  await sim.trace.configure({ level: 'summary' });
  try {
    const second = await run.create({ x_name: 'Order two', x_accesstoken: ACCESS_TOKEN });
    const tree = await endedTree(sim.trace, second.traceId);
    assert.notEqual(second.traceId, run.traceId);
    const kinds = tree.trace.kinds;
    for (const kind of ['webapi', 'plugin-step', 'job', 'flow-run', 'flow-action', 'connector', 'secret', 'http-out'])
      assert.ok(kinds[kind] > 0, kind);
    for (const span of tree.spans)
      assert.deepEqual(
        [Object.hasOwn(span, 'input'), Object.hasOwn(span, 'output')],
        [false, false],
        `${span.kind} ${span.name}`,
      );
    assert.equal(JSON.stringify(tree).includes(ACCESS_TOKEN), false);
  } finally {
    await sim.trace.configure({ level: 'full' });
  }
});
