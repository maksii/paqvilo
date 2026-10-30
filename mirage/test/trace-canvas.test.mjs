// @test-kind contract+security: Paqvilo's tracing and activity design (docs/design/tracing.md); redaction keeps secrets, tokens and keys out of traces
// Canvas app tracing (docs/design/tracing.md, DV-B1-4/-5, DV-A-2/-3/-13/-14): the /_apps/api/canvas root names the
// canvas host, the app and the staff user it runs as; every driver action is one `canvas` span (start, select
// <control>.<property>, run <formula>) with the formula text at level full, its error outcome and the Dataverse and
// connector work it caused below it, all as that user; error answers name their code on the root; the player page names
// its root and the player sends it on every driver call.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';
import { staffSimulator, writeFiles } from './support/trace-staff-hosts.mjs';

const ADMIN = 'c3a00000-0000-4000-8000-0000000000a1',
  BASIC = 'c3a00000-0000-4000-8000-0000000000a2';
const KEY = 'canvas-connector-key-5d1e';
const ASSEMBLY = 'c3a10000-0000-4000-8000-000000000061',
  TYPE = 'c3a10000-0000-4000-8000-000000000062',
  STEP = 'c3a10000-0000-4000-8000-000000000063';
const entity =
  '<Entity><Name>fx_widget</Name><EntityInfo><entity Name="fx_widget"><LocalizedNames><LocalizedName description="Widget" languagecode="1033"/></LocalizedNames><EntitySetName>fx_widgets</EntitySetName><PrimaryIdAttribute>fx_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>fx_name</PrimaryNameAttribute><attributes><attribute PhysicalName="fx_widgetid"><Name>fx_widgetid</Name><LogicalName>fx_widgetid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="fx_name"><Name>fx_name</Name><LogicalName>fx_name</LogicalName><Type>nvarchar</Type><displaynames><displayname description="Widget Name" languagecode="1033"/></displaynames></attribute><attribute PhysicalName="fx_count"><Name>fx_count</Name><LogicalName>fx_count</LogicalName><Type>int</Type><displaynames><displayname description="Count" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>';
const SAVE =
  '=Patch(Widgets, Defaults(Widgets), {fx_name: "From canvas", fx_count: 3}); Set(reply, Svc.Echo({text: "hi"}).text)';
const files = {
  'solution/Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedCanvasTrace</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'solution/Entities/fx_widget/Entity.xml': entity,
  'solution/PluginAssemblies/Invented.Widgets/Invented.Widgets.xml': `<PluginAssembly PluginAssemblyId="{${ASSEMBLY}}"><Name>Invented.Widgets</Name><Version>1.0.0.0</Version><IsolationMode>2</IsolationMode><SourceType>0</SourceType><PluginTypes><PluginType PluginTypeId="{${TYPE}}"><TypeName>Invented.Widgets.Rules</TypeName></PluginType></PluginTypes></PluginAssembly>`,
  [`solution/SdkMessageProcessingSteps/${STEP}.xml`]: `<SdkMessageProcessingStep SdkMessageProcessingStepId="{${STEP}}"><Name>Invented widget pre-operation</Name><PluginTypeId>${TYPE}</PluginTypeId><SdkMessageName>Create</SdkMessageName><PrimaryEntity>fx_widget</PrimaryEntity><Stage>20</Stage><Rank>1</Rank><Mode>0</Mode><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode><FilteringAttributes></FilteringAttributes></SdkMessageProcessingStep>`,
  'apps/fx_trace/Src/App.pa.yaml': JSON.stringify({
    App: { Properties: {} },
    DataSources: {
      Widgets: { Type: 'Table', Parameters: { TableLogicalName: 'fx_widget' } },
      Svc: { Type: 'Actions', ConnectorId: 'shared_fxtrace' },
    },
  }),
  'apps/fx_trace/Src/HomeScreen.pa.yaml': JSON.stringify({
    Screens: {
      HomeScreen: {
        Children: [
          { SaveButton: { Control: 'Classic/Button@2.2.0', Properties: { OnSelect: SAVE } } },
          {
            BadButton: {
              Control: 'Classic/Button@2.2.0',
              Properties: { OnSelect: '=Patch(Widgets, Defaults(Widgets), {fx_name: "Bad item"})' },
            },
          },
          {
            FailButton: {
              Control: 'Classic/Button@2.2.0',
              Properties: { OnSelect: '=Set(bad, Svc.Fail({text: "x"}).text)' },
            },
          },
        ],
      },
    },
  }),
};
const pack = {
  id: 'canvas-trace',
  name: 'Invented canvas connectors',
  description: 'Invented connectors for the canvas trace tests',
  matches: () => true,
  presets: () => ({}),
  pluginSteps: {
    [STEP]: ({ target }) => {
      if (target.fx_name === 'Bad item')
        throw Object.assign(new Error('Bad items are refused.'), { code: 'InventedBadItem' });
    },
  },
  connectors: {
    shared_fxtrace: {
      operations: {
        Echo: (request) => ({ statusCode: 200, body: { text: 'echo ' + request.parameters?.text, apiKey: KEY } }),
        Fail: () => ({
          statusCode: 502,
          body: { error: { code: 'InventedUpstream', message: 'Upstream refused the call' } },
        }),
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
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-canvas-'));
    removers.push(() => fs.rm(root, { recursive: true, force: true }));
    await writeFiles(root, files);
    return staffSimulator({
      root,
      admin: ADMIN,
      basic: BASIC,
      closers,
      runtime: { kind: 'dataverse-api' },
      packs: [pack],
      canvas: { sources: ['apps/fx_trace'] },
      connections: { Svc: { connector: 'shared_fxtrace', provider: 'pack:canvas-trace' } },
    });
  })());

// One driver call: the answer, its root span id and the ended trace.
async function drive(body, { cookie, headers = {} } = {}) {
  const { sim } = await runtime();
  const response = await fetch(sim.url + '/_apps/api/canvas/fx_trace', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf, ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const answer = await response.json();
  const traceId = response.headers.get('x-trace-id');
  assert.ok(traceId, 'the canvas answer names its trace');
  const tree = await endedTree(sim.trace, traceId);
  const root = tree.spans.find((span) => span.spanId === response.headers.get('x-sim-span-id'));
  return { response, answer, tree, root };
}
const below = (tree, ancestor) => {
  const ids = new Set([ancestor.spanId]);
  const found = [];
  for (const span of tree.spans)
    if (ids.has(span.parentSpanId)) {
      ids.add(span.spanId);
      found.push(span);
    }
  return found;
};

test('start: the root names the canvas host, the app and the staff user; one canvas span runs App.OnStart', async () => {
  const { admin } = await runtime();
  const { response, root, tree } = await drive({ action: 'reset' }, { cookie: admin.cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(
    [root.kind, root.module, root.origin.host, root.attributes.app, root.actor.kind, root.actor.id, root.actor.name],
    ['http', 'canvas', 'canvas', 'fx_trace', 'staff', admin.id, 'Invented Admin'],
  );
  const action = tree.spans.find((span) => span.kind === 'canvas');
  assert.deepEqual(
    [
      action.name,
      action.module,
      action.operation,
      action.parentSpanId,
      action.attributes.control,
      action.attributes.property,
    ],
    ['reset', 'canvas', 'reset', root.spanId, 'App', 'OnStart'],
  );
  assert.ok(
    tree.spans.every((span) => span.actor.kind === 'staff' && span.actor.id === admin.id),
    'every span of the start runs as the staff user',
  );
});

test('select: the canvas span names control and property, carries the formula at full and holds the Dataverse and connector work as that user', async () => {
  const { admin } = await runtime();
  await drive({ action: 'start' }, { cookie: admin.cookie });
  const { response, tree, root } = await drive({ action: 'select', control: 'SaveButton' }, { cookie: admin.cookie });
  assert.equal(response.status, 200);
  const action = tree.spans.find((span) => span.kind === 'canvas');
  assert.deepEqual(
    [action.name, action.parentSpanId, action.status, action.attributes.control, action.attributes.property],
    ['select SaveButton.OnSelect', root.spanId, 'ok', 'SaveButton', 'OnSelect'],
  );
  assert.equal(action.input.formula, SAVE.slice(1));
  const work = below(tree, action);
  const create = work.find((span) => span.kind === 'dataverse' && span.operation === 'create');
  const connector = work.find((span) => span.kind === 'connector');
  assert.ok(create, 'the Patch create runs under the canvas span');
  assert.deepEqual([connector?.name, connector?.attributes.caller], ['shared_fxtrace/Echo', 'canvas']);
  assert.ok(
    tree.spans.every(
      (span) => span.kind === 'plugin-step' || (span.actor.kind === 'staff' && span.actor.id === admin.id),
    ),
    'no span of the action is anonymous: store reads, the create and the connector run as the staff user (a plug-in step as its plug-in)',
  );
  assert.equal(JSON.stringify(tree).includes(KEY), false, 'a credential-named connector output key is redacted');
});

test('a failed formula ends its canvas span with the failure and the error answer names its code on the root', async () => {
  const { admin } = await runtime();
  await drive({ action: 'start' }, { cookie: admin.cookie });
  const { response, answer, tree, root } = await drive(
    { action: 'select', control: 'FailButton' },
    { cookie: admin.cookie },
  );
  assert.equal(response.status, 502);
  const action = tree.spans.find((span) => span.kind === 'canvas');
  const failure = answer.errors[0];
  assert.deepEqual(
    [action.name, action.status, action.error.code, action.error.message],
    ['select FailButton.OnSelect', 'error', failure.code, failure.message],
  );
  assert.deepEqual(
    [root.status, root.error.code, root.error.message, root.error.status],
    ['error', failure.code, failure.message, 502],
  );
});

test('run: the canvas span is named by its formula, keeps it as input and holds the read it caused', async () => {
  const { admin } = await runtime();
  await drive({ action: 'start' }, { cookie: admin.cookie });
  const formula = 'CountRows(Filter(Widgets, fx_name = "From canvas"))';
  const { tree } = await drive({ action: 'run', formula }, { cookie: admin.cookie });
  const action = tree.spans.find((span) => span.kind === 'canvas');
  assert.deepEqual([action.name, action.operation, action.input.formula], [`run ${formula}`, 'run', formula]);
  assert.ok(
    below(tree, action).some((span) => span.entity === 'fx_widget'),
    'the formula read of fx_widget is a descendant of the run span',
  );
});

test('a refused write ends the canvas span denied and names the refusal on the root, as the Basic user', async () => {
  const { basic } = await runtime();
  await drive({ action: 'reset' }, { cookie: basic.cookie });
  const { response, answer, tree, root } = await drive(
    { action: 'select', control: 'SaveButton' },
    { cookie: basic.cookie },
  );
  assert.equal(response.status, 403);
  const action = tree.spans.find((span) => span.kind === 'canvas');
  const failure = answer.errors.find((item) => item.status === 403);
  assert.deepEqual([action.status, action.error.code], ['denied', failure.code]);
  assert.deepEqual([root.status, root.error.code, root.actor.id], ['denied', failure.code, basic.id]);
});

test('a canvas call without a staff user is a denied root with its code and an anonymous actor', async () => {
  const { response, answer, root, tree } = await drive({ action: 'start' });
  assert.equal(response.status, 401);
  assert.equal(answer.error.code, 'CanvasPrincipalRequired');
  assert.deepEqual(
    [root.status, root.error.code, root.error.message, root.actor.kind],
    ['denied', 'CanvasPrincipalRequired', answer.error.message, 'anonymous'],
  );
  assert.equal(tree.spans.filter((span) => span.kind === 'canvas').length, 0, 'no action ran');
});

test('driver calls carrying the page headers join the player page trace', async () => {
  const { sim, admin } = await runtime();
  const page = await fetch(sim.url + '/_apps/canvas/fx_trace', { headers: { cookie: admin.cookie } });
  const html = await page.text();
  const traceId = page.headers.get('x-trace-id'),
    spanId = page.headers.get('x-sim-span-id');
  assert.ok(html.includes(`data-trace-id="${traceId}"`) && html.includes(`data-trace-parent="${spanId}"`));
  const { root } = await drive(
    { action: 'start' },
    { cookie: admin.cookie, headers: { 'x-trace-id': traceId, 'x-sim-parent-trace': spanId } },
  );
  assert.deepEqual([root.traceId, root.parentSpanId], [traceId, spanId]);
});

test('the player sends the page root on its driver calls and leaves the source watch polls out of it', async () => {
  const code = await fs.readFile(new URL('../lib/canvas-player.js', import.meta.url), 'utf8');
  const calls = [];
  // A stand-in for every element and API the player touches while it boots: each property is the stand-in again.
  const stub = new Proxy(function () {}, {
    get: (target, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub,
  });
  const body = Object.assign(Object.create(stub), {
    dataset: { app: 'fx_trace', csrf: 'token', traceId: 'trace-id-of-page', traceParent: 'span-id-of-page' },
  });
  const context = new Proxy(
    {
      document: new Proxy({ body }, { get: (target, key) => (key in target ? target[key] : stub) }),
      fetch: (url, init) => {
        calls.push({ url: String(url), headers: { ...init?.headers } });
        return new Promise(() => {});
      },
      Promise,
      JSON,
      Object,
      Array,
      Map,
      Set,
      encodeURIComponent,
    },
    { get: (target, key) => (key in target ? target[key] : stub), has: () => true },
  );
  vm.runInNewContext(code, context);
  assert.ok(calls.length >= 1, 'the player starts by reading the app');
  for (const call of calls)
    assert.deepEqual(
      [call.headers['X-Trace-Id'], call.headers['X-Sim-Parent-Trace']],
      ['trace-id-of-page', 'span-id-of-page'],
      call.url,
    );
  assert.match(code, /\?revision=1`, \{\s+signal: controller\.signal,\s+untraced: true,/);
});

test('a write a plug-in refuses names the fault identity of its Dataverse spans on the canvas span; the answer keeps its code', async () => {
  const { admin } = await runtime();
  await drive({ action: 'start' }, { cookie: admin.cookie });
  const { response, answer, tree, root } = await drive(
    { action: 'select', control: 'BadButton' },
    { cookie: admin.cookie },
  );
  // The answer is unchanged: a formula failure without an HTTP status answers 200 with the entry's own code.
  assert.deepEqual([response.status, root.status, answer.errors[0].code], [200, 'ok', 'InventedBadItem']);
  const action = tree.spans.find((span) => span.kind === 'canvas');

  const step = tree.spans.find((span) => span.kind === 'plugin-step' && span.error);
  assert.ok(step?.error.pluginType, 'the step names the plug-in fault');
  const { type, code, pluginType, step: stepName, stage, depth, message } = step.error;
  assert.match(code, /^0x8004/);
  for (const span of [action])
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
