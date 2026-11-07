// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Code app tracing (docs/design/tracing.md, DV-A-2/-3/-5/-13, DV-B1-1/-2): /_apps/code roots name the code-app host,
// the app and the selected staff user; the client library joins every call to the trace of its getContext() answer;
// error answers (a denied write, a failed or unsupported connector, no staff user) name their code on the root; the dev
// server probe is an http-out span that forwards the trace.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { configure, dataClient, getContext } from '../lib/code-apps-client.js';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';
import { staffSimulator, writeFiles } from './support/trace-staff-hosts.mjs';

const ADMIN = 'c3b00000-0000-4000-8000-0000000000a1',
  BASIC = 'c3b00000-0000-4000-8000-0000000000a2';
const ASSEMBLY = 'c3b10000-0000-4000-8000-000000000061',
  TYPE = 'c3b10000-0000-4000-8000-000000000062',
  STEP = 'c3b10000-0000-4000-8000-000000000063';
const entity =
  '<Entity><Name>fx_widget</Name><EntityInfo><entity Name="fx_widget"><LocalizedNames><LocalizedName description="Widget" languagecode="1033"/></LocalizedNames><EntitySetName>fx_widgets</EntitySetName><PrimaryIdAttribute>fx_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>fx_name</PrimaryNameAttribute><attributes><attribute PhysicalName="fx_widgetid"><Name>fx_widgetid</Name><LogicalName>fx_widgetid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="fx_name"><Name>fx_name</Name><LogicalName>fx_name</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Widget Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>';
const pack = {
  id: 'code-trace',
  name: 'Invented code app connectors',
  description: 'Invented connectors for the code app trace tests',
  matches: () => true,
  presets: () => ({}),
  pluginSteps: {
    [STEP]: ({ target }) => {
      if (target.fx_name === 'Bad item')
        throw Object.assign(new Error('Bad items are refused.'), { code: 'InventedBadItem' });
    },
  },
  connectors: {
    x_codetrace: {
      operations: {
        Lookup: (request) => ({ statusCode: 200, body: { found: request.parameters?.query ?? null } }),
        Explode: () => {
          throw Object.assign(new Error('Connector exploded'), { code: 'InventedExplode' });
        },
      },
    },
  },
};

const closers = [],
  removers = [];
after(async () => {
  await drainFixture(closers);
  await drainFixture(removers);
});
let shared;
const runtime = () =>
  (shared ??= (async () => {
    // The developer's dev server: the probe's HEAD lands here with its trace headers.
    const probes = [];
    const devServer = http.createServer((req, res) => {
      probes.push({ method: req.method, headers: req.headers });
      res.end();
    });
    await new Promise((resolve) => devServer.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => devServer.close(resolve)));
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-code-apps-'));
    removers.push(() => fs.rm(root, { recursive: true, force: true }));
    const files = {
      'solution/Other/Solution.xml':
        '<ImportExportXml><SolutionManifest><UniqueName>InventedCodeTrace</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
      'solution/Entities/fx_widget/Entity.xml': entity,
      'solution/PluginAssemblies/Invented.Widgets/Invented.Widgets.xml': `<PluginAssembly PluginAssemblyId="{${ASSEMBLY}}"><Name>Invented.Widgets</Name><Version>1.0.0.0</Version><IsolationMode>2</IsolationMode><SourceType>0</SourceType><PluginTypes><PluginType PluginTypeId="{${TYPE}}"><TypeName>Invented.Widgets.Rules</TypeName></PluginType></PluginTypes></PluginAssembly>`,
      [`solution/SdkMessageProcessingSteps/${STEP}.xml`]: `<SdkMessageProcessingStep SdkMessageProcessingStepId="{${STEP}}"><Name>Invented widget pre-operation</Name><PluginTypeId>${TYPE}</PluginTypeId><SdkMessageName>Create</SdkMessageName><PrimaryEntity>fx_widget</PrimaryEntity><Stage>20</Stage><Rank>1</Rank><Mode>0</Mode><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode><FilteringAttributes></FilteringAttributes></SdkMessageProcessingStep>`,
      'apps/code-trace/power.config.json': JSON.stringify({
        appId: 'c3b00000-0000-4000-8000-0000000000ff',
        environmentId: 'invented-env',
        localAppUrl: `http://127.0.0.1:${devServer.address().port}/`,
        connectionReferences: {
          ref: { id: '/providers/Microsoft.PowerApps/apis/x_codetrace', displayName: 'Invented', dataSources: ['Svc'] },
        },
        databaseReferences: {
          'default.cds': { dataSources: { widgets: { entitySetName: 'fx_widgets', logicalName: 'fx_widget' } } },
        },
      }),
    };
    await writeFiles(root, files);
    const hosted = await staffSimulator({
      root,
      admin: ADMIN,
      basic: BASIC,
      closers,
      runtime: { kind: 'dataverse-api' },
      packs: [pack],
      codeApps: [{ name: 'code-trace', dir: 'apps/code-trace' }],
      connections: { ref: { connector: 'x_codetrace', provider: 'pack:code-trace' } },
    });
    return { ...hosted, probes };
  })());

// Runs the real client library as the browser would: same-origin calls carry the staff cookie; every answer is kept.
async function asUser(cookie, fn) {
  const { sim } = await runtime();
  const realFetch = globalThis.fetch,
    answers = [];
  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (cookie) headers.set('cookie', cookie);
    const response = await realFetch(input, { ...init, headers });
    answers.push({ path: new URL(String(input)).pathname, request: headers, response, copy: response.clone() });
    return response;
  };
  try {
    configure({ app: 'code-trace', origin: sim.url });
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return answers;
}
const rootOf = async (sim, answer) => {
  const tree = await endedTree(sim.trace, answer.response.headers.get('x-trace-id'));
  return { tree, root: tree.spans.find((span) => span.spanId === answer.response.headers.get('x-sim-span-id')) };
};

test('getContext is a code-app root naming the app and the staff user; later calls join its trace as that user', async () => {
  const { sim, admin } = await runtime();
  const answers = await asUser(admin.cookie, async () => {
    await getContext();
    await dataClient.create('fx_widgets', { fx_name: 'Alpha' });
  });
  const [context, create] = answers;
  assert.match(context.path, /\/context$/);
  const contextSpan = sim.trace.span(context.response.headers.get('x-sim-span-id'));
  assert.deepEqual(
    [contextSpan.module, contextSpan.origin.host, contextSpan.attributes.app, contextSpan.actor.kind],
    ['code-apps', 'code-app', 'code-trace', 'staff'],
  );
  assert.deepEqual([contextSpan.actor.id, contextSpan.actor.name], [admin.id, 'Invented Admin']);
  // The client sends the context answer's trace on the next call, so the create nests under the context root.
  assert.deepEqual(
    [create.request.get('x-trace-id'), create.request.get('x-sim-parent-trace')],
    [contextSpan.traceId, contextSpan.spanId],
  );
  const { tree, root } = await rootOf(sim, create);
  assert.deepEqual([root.traceId, root.parentSpanId, root.status], [contextSpan.traceId, contextSpan.spanId, 'ok']);
  const ids = new Set([root.spanId]);
  const below = tree.spans.filter((span) => ids.has(span.parentSpanId) && ids.add(span.spanId));
  assert.ok(below.some((span) => span.kind === 'dataverse' && span.operation === 'create'));
  assert.ok(
    below.every((span) => span.kind === 'plugin-step' || (span.actor.kind === 'staff' && span.actor.id === admin.id)),
    'no span under the create is anonymous',
  );
});

test('a denied write names its code and message on its root, as the Basic user', async () => {
  const { sim, basic } = await runtime();
  const answers = await asUser(basic.cookie, async () => {
    await getContext();
    await dataClient.create('fx_widgets', { fx_name: 'Basic widget' }).catch(() => {});
  });
  const create = answers.at(-1);
  assert.equal(create.response.status, 403);
  const body = await create.copy.json();
  const { root } = await rootOf(sim, create);
  assert.deepEqual(
    [root.status, root.error.code, root.error.message, root.error.status, root.actor.id],
    ['denied', body.error.code, body.error.message, 403, basic.id],
  );
});

test('a failed and an unsupported connector call name their codes on their roots', async () => {
  const { sim, admin } = await runtime();
  const answers = await asUser(admin.cookie, async () => {
    await getContext();
    await dataClient.execute('Svc', 'Explode', {}).catch(() => {});
    await dataClient.execute('Svc', 'Nope', {}).catch(() => {});
  });
  const [explode, nope] = answers.slice(-2);
  for (const [answer, status] of [
    [explode, explode.response.status],
    [nope, 501],
  ]) {
    assert.equal(answer.response.status, status);
    const body = await answer.copy.clone().json();
    const { root } = await rootOf(sim, answer);
    assert.deepEqual(
      [root.status, root.error.code, root.error.message],
      ['error', body.error.code, body.error.message],
    );
  }
  assert.equal((await nope.copy.clone().json()).error.code, 'ConnectorNotSimulated');
});

test('a code app call without a staff user is a denied root with its code and an anonymous actor', async () => {
  const { sim } = await runtime();
  const response = await fetch(sim.url + '/_apps/code/code-trace/context');
  assert.equal(response.status, 401);
  const body = await response.json();
  const tree = await endedTree(sim.trace, response.headers.get('x-trace-id'));
  assert.deepEqual(
    [tree.root.status, tree.root.error.code, tree.root.error.message, tree.root.actor.kind],
    ['denied', 'StaffSessionRequired', body.error.message, 'anonymous'],
  );
});

test('the dev server probe is an http-out span of its root that forwards the trace', async () => {
  const { sim, probes, admin } = await runtime();
  const response = await fetch(sim.url + '/_apps/code/_api/apps?probe=1', { headers: { cookie: admin.cookie } });
  assert.equal((await response.json()).apps[0].server.state, 'reachable');
  const tree = await endedTree(sim.trace, response.headers.get('x-trace-id'));
  const probe = tree.spans.find((span) => span.kind === 'http-out');
  assert.deepEqual(
    [probe.parentSpanId, probe.module, probe.operation, probe.attributes.method, probe.status],
    [tree.root.spanId, 'code-apps', 'probe', 'HEAD', 'ok'],
  );
  const received = probes.at(-1);
  assert.deepEqual(
    [received.method, received.headers['x-trace-id'], received.headers['x-sim-parent-trace']],
    ['HEAD', tree.root.traceId, probe.spanId],
  );
});

test('the in-process WhoAmI of a code app opens its function span under the call root', async () => {
  const { sim, admin } = await runtime();
  const answers = await asUser(admin.cookie, async () => {
    await getContext();
    await dataClient.executeDataverseAction('WhoAmI');
  });
  const whoAmI = answers.at(-1);
  assert.equal(whoAmI.response.status, 200);
  const { tree, root } = await rootOf(sim, whoAmI);
  const span = tree.spans.find((item) => item.parentSpanId === root.spanId && item.kind === 'function');
  assert.equal(span?.name, 'WhoAmI');
});

test('a create a plug-in refuses names the fault identity of its spans on the root; the answer keeps its own code', async () => {
  const { sim, admin } = await runtime();
  const answers = await asUser(admin.cookie, async () => {
    await getContext();
    await dataClient.create('fx_widgets', { fx_name: 'Bad item' }).catch(() => {});
  });
  const create = answers.at(-1);
  assert.ok(create.response.status >= 400);
  const { tree, root } = await rootOf(sim, create);

  const step = tree.spans.find((span) => span.kind === 'plugin-step' && span.error);
  assert.ok(step?.error.pluginType, 'the step names the plug-in fault');
  const { type, code, pluginType, step: stepName, stage, depth, message } = step.error;
  assert.match(code, /^0x8004/);
  for (const span of [root])
    assert.deepEqual(
      [
        span.error?.type,
        span.error?.code,
        span.error?.pluginType,
        span.error?.step,
        span.error?.stage,
        span.error?.depth,
        span.error?.message,
      ],
      [type, code, pluginType, stepName, stage, depth, message],
      span.name,
    );
});
