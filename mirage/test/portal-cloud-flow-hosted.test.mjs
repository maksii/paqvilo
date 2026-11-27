// @test-kind observation: hosted session F8 (paqvilo-developer hosted-f8 evidence summary-F8.md, two agreeing runs a and b of synthetic "When Power Pages calls a flow" flows); each test names its capture group; the flows and site here are invented equivalents
// The Power Pages flow API end to end over an invented site and Solution: request shapes, the envelope, run outcomes, web
// roles and the workflow state, as the hosted captures answer them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { powerPagesFlowAnswer } from '../lib/exported-operations.mjs';

const g = (n) => `f8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = 'F8000000-0000-4000-8000-0000000000AA';
const CONTACT = g(90);
const AUTHENTICATED = g(91);
const ANONYMOUS = g(92);
const GATED = g(93);
const CONSUMER = g(94);
const reply = (body, inputs = {}, runAfter = {}) => ({
  type: 'Response',
  kind: 'powerpages',
  runAfter,
  inputs: { statusCode: 200, body, ...inputs },
});
const broken = (runAfter = {}) => ({ type: 'Compose', inputs: "@int('invented-not-a-number')", runAfter });
const FLOWS = {
  echo: { id: g(1), actions: { reply: reply({ kind: 'echo', body: '@triggerBody()' }) } },
  status: {
    id: g(2),
    actions: {
      reply: reply(
        { requested: "@triggerBody()?['status']" },
        { statusCode: "@int(triggerBody()?['status'])", headers: { 'x-invented-flow': 'status' } },
      ),
    },
  },
  failing: {
    id: g(3),
    actions: { broken: broken(), reply: reply({ kind: 'unreachable' }, {}, { broken: ['Succeeded'] }) },
  },
  terminate: {
    id: g(4),
    actions: {
      stop: {
        type: 'Terminate',
        inputs: { runStatus: "@triggerBody()?['runStatus']", runError: { code: 'Invented', message: 'invented stop' } },
      },
      reply: reply({ kind: 'unreachable' }, {}, { stop: ['Succeeded'] }),
    },
  },
  terminateOnly: {
    id: g(5),
    actions: {
      stop: { type: 'Terminate', inputs: { runStatus: 'Failed', runError: { code: 'Invented', message: 'invented' } } },
    },
  },
  silent: { id: g(6), actions: { done: { type: 'Compose', inputs: 'done' } } },
  text: { id: g(7), actions: { reply: reply("@concat('invented plain ', triggerBody()?['text'])") } },
  after: { id: g(8), actions: { reply: reply({ kind: 'answered' }), broken: broken({ reply: ['Succeeded'] }) } },
  gated: { id: g(9), roles: [GATED], actions: { reply: reply({ kind: 'gated' }) } },
  anonymous: { id: g(10), roles: [ANONYMOUS], actions: { reply: reply({ kind: 'anonymous' }) } },
  draft: { id: g(11), state: 0, actions: { reply: reply({ kind: 'draft' }) } },
  missing: { id: g(12), workflow: false },
  unlinked: { id: g(13), consumer: false, actions: { reply: reply({ kind: 'unlinked' }) } },
};

// The site records the hosted trigger-schema behaviour (observed.powerPagesFlowTriggerSchema not-enforced, hosted session F8
// envelope group) unless `triggerSchema` is null: Mirage's default then enforces the declared schema.
async function hostedSite(t, { observed = null, triggerSchema = 'not-enforced' } = {}) {
  const observations = {
    ...(triggerSchema ? { powerPagesFlowTriggerSchema: triggerSchema } : {}),
    ...observed,
  };
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-flow-f8-')));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented flow site`,
    'portal/webrole.yml': [
      `- adx_webroleid: ${AUTHENTICATED}\n  adx_name: Authenticated Users\n  adx_authenticatedusersrole: true`,
      `- adx_webroleid: ${ANONYMOUS}\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true`,
      `- adx_webroleid: ${GATED}\n  adx_name: Invented gate`,
    ].join('\n'),
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    // Server logic that triggers a flow through Server.Connector.CloudFlow.TriggerAsync and returns the envelope.
    'portal/invented-trigger.serverlogic.yml': `adx_serverlogicid: invented-trigger\nadx_name: invented-trigger\nadx_serverlogic_adx_webrole:\n- ${AUTHENTICATED}`,
    'portal/invented-trigger.js':
      'async function post(){ const input = JSON.parse(Server.Context.Body); return await Server.Connector.CloudFlow.TriggerAsync(input.flowId, JSON.stringify(input.payload)); }',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedFlows</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>',
  };
  const trigger = {
    type: 'Request',
    kind: 'powerpages',
    inputs: {
      schema: { type: 'object', properties: { text: { type: 'string' }, num: { type: 'number' } }, required: ['text'] },
    },
  };
  for (const [name, flow] of Object.entries(FLOWS)) {
    const roles = flow.roles ?? [AUTHENTICATED];
    if (flow.consumer !== false)
      files[`portal/${name}.cloudflowconsumer.yml`] =
        `adx_cloudflowconsumerid: ${name}-consumer\nadx_name: ${name}\nadx_processid: ${flow.id}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${flow.id}\nadx_cloudflowconsumer_adx_webrole:\n${roles.map((role) => `- ${role}`).join('\n')}`;
    if (flow.workflow === false) continue;
    files[`solution/Workflows/${name}.json`] = JSON.stringify({
      properties: { definition: { triggers: { manual: trigger }, actions: flow.actions } },
    });
    files[`solution/Workflows/${name}.json.data.xml`] =
      `<Workflow WorkflowId="{${flow.id}}" Name="${name}"><StateCode>${flow.state ?? 1}</StateCode></Workflow>`;
  }
  // The consumer whose own id is CONSUMER (not a process id) points at the echo flow.
  files['portal/consumer-id.cloudflowconsumer.yml'] =
    `adx_cloudflowconsumerid: ${CONSUMER}\nadx_name: consumer-id\nadx_processid: ${FLOWS.echo.id}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${FLOWS.echo.id}\nadx_cloudflowconsumer_adx_webrole:\n- ${AUTHENTICATED}`;
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await createSimulator({
    sourceDir: path.join(dir, 'portal'),
    solutionRoots: [path.join(dir, 'solution')],
    port: 0,
    watch: false,
    ...(Object.keys(observations).length
      ? { observed: { evidence: 'Invented site: hosted session F8 envelope group', ...observations } }
      : {}),
    initial: {
      version: 1,
      tables: { contact: [{ contactid: CONTACT, fullname: 'Invented Visitor', statecode: 0 }] },
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
      permissions: [],
      settings: { permissionMode: 'enforce' },
      plugins: [],
      simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
    },
  });
  ownedFixture(t).add(() => app.close());
  const signedIn = app.signIn(CONTACT).cookieHeader;
  const post = (
    id,
    body,
    {
      cookie = signedIn,
      token = app.csrf,
      ajax = true,
      type = 'application/json',
      method = 'POST',
      version = 'v1.0',
    } = {},
  ) =>
    fetch(`${app.url}/_api/cloudflow/${version}/trigger/${id}`, {
      method,
      headers: {
        'content-type': type,
        accept: '*/*',
        ...(cookie ? { cookie } : {}),
        ...(token ? { __RequestVerificationToken: token } : {}),
        ...(ajax ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      },
      ...(method === 'GET' ? {} : { body }),
    });
  const runs = (flow) =>
    app.store.tableRows('flowrun').filter((row) => String(row.workflowid).toLowerCase() === flow.id.toLowerCase());
  return { app, post, runs, signedIn };
}
const event = (value) => JSON.stringify({ eventData: JSON.stringify(value) });
const upstream = /^The server did not receive a response from an upstream server\. Request tracking id '([^']+)'\.$/;
async function flowError(response) {
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  return response.json();
}
async function upstreamRun(response, runs) {
  assert.equal(response.status, 400);
  const body = await flowError(response);
  assert.equal(body.ErrorCode, 'IncorrectPayload');
  const runId = upstream.exec(body.Message)?.[1];
  assert.ok(runId, body.Message);
  const run = runs.find((row) => row.flowrunid === runId);
  assert.ok(run, `the message names the run ${runId}`);
  return run;
}

// F8 request and envelope groups: shell.ajaxSafePost's form body and a JSON eventData string; the flow receives siteId,
// siteUrl and userId first, the schema is not enforced, and a 200 Response passes through as text/html.
test('an eventData string runs the flow with siteId, siteUrl and userId, unvalidated, and its 200 body passes through', async (t) => {
  const { app, post } = await hostedSite(t);
  const identity = { siteId: SITE.toLowerCase(), siteUrl: new URL(app.url).origin, userId: CONTACT };
  const form = await post(
    FLOWS.echo.id,
    new URLSearchParams({ eventData: JSON.stringify({ text: 'invented form', num: 4 }) }).toString(),
    { type: 'application/x-www-form-urlencoded; charset=UTF-8' },
  );
  assert.equal(form.status, 200);
  assert.equal(form.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(form.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(form.headers.get('pragma'), 'no-cache');
  assert.equal(form.headers.get('expires'), '-1');
  const text = await form.text();
  assert.deepEqual(JSON.parse(text), { kind: 'echo', body: { ...identity, text: 'invented form', num: 4 } });
  assert.deepEqual(Object.keys(JSON.parse(text).body), ['siteId', 'siteUrl', 'userId', 'text', 'num']);
  for (const sent of [{ num: 1 }, { text: 'invented type', num: 'abc' }, { text: 'invented extra', extra: true }, {}]) {
    const response = await post(FLOWS.echo.id, event(sent));
    assert.equal(response.status, 200, JSON.stringify(sent));
    assert.deepEqual(JSON.parse(await response.text()).body, { ...identity, ...sent });
  }
  // Injected values win over same-named event data.
  const spoofed = await post(FLOWS.echo.id, event({ text: 'invented', userId: 'invented-other' }));
  assert.equal(JSON.parse(await spoofed.text()).body.userId, CONTACT);
  // A string body is sent raw; the id matches in any case, with a trailing slash, under any version segment.
  const plain = await post(FLOWS.text.id, event({ text: 'x' }));
  assert.deepEqual([plain.status, await plain.text()], [200, 'invented plain x']);
  for (const [id, version] of [
    [FLOWS.echo.id.toUpperCase(), 'v1.0'],
    [`${FLOWS.echo.id}/`, 'v1.0'],
    [FLOWS.echo.id, 'v2.0'],
  ])
    assert.equal((await post(id, event({ text: 'invented' }), { version })).status, 200, `${version} ${id}`);
});

// @test-kind contract: Mirage's default (Paqvilo design, kept fail-closed) refuses a Power Pages trigger input that its declared schema refuses and reports FLOW_TRIGGER_SCHEMA_ENFORCED, naming the hosted behaviour (hosted session F8 envelope group, paqvilo-developer hosted-f8 summary-F8.md section 3: the flow runs with what was sent) and observed.powerPagesFlowTriggerSchema, which reproduces it
test('by default a Power Pages trigger input the declared schema refuses fails the run before any action and is reported', async (t) => {
  const { app, post, runs } = await hostedSite(t, { triggerSchema: null });
  for (const sent of [{ num: 1 }, { text: 'invented type', num: 'abc' }, {}]) {
    const response = await post(FLOWS.echo.id, event(sent));
    assert.equal(response.status, 400, JSON.stringify(sent));
    assert.equal((await flowError(response)).ErrorCode, 'IncorrectPayload', JSON.stringify(sent));
  }
  // Each refused run fails before its first action (no Response answered it).
  assert.deepEqual(
    runs(FLOWS.echo).map((run) => [run.status, run.errorcode]),
    [
      ['Failed', 'InvalidRequest'],
      ['Failed', 'InvalidRequest'],
      ['Failed', 'InvalidRequest'],
    ],
  );
  const accepted = await post(FLOWS.echo.id, event({ text: 'invented', num: 2 }));
  assert.equal(accepted.status, 200);
  const diagnostics = await (
    await fetch(`${app.url}/__sim/api/diagnostics`, { headers: { 'x-sim-csrf': app.csrf } })
  ).json();
  const entries = (Array.isArray(diagnostics) ? diagnostics : (diagnostics.diagnostics ?? [])).filter(
    (entry) => entry.code === 'FLOW_TRIGGER_SCHEMA_ENFORCED',
  );
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.severity, 'warning');
    assert.match(entry.message, /observed\.powerPagesFlowTriggerSchema/);
  }
});

// F8 envelope group: raw JSON without eventData, eventData as an object and an empty body run the flow, whose Response
// action fails (run Failed); the caller gets 400 with the upstream message and the run id.
test('a body without an eventData string runs the flow, which fails at its Response', async (t) => {
  const { post, runs } = await hostedSite(t);
  for (const body of [JSON.stringify({ text: 'invented raw' }), JSON.stringify({ eventData: { text: 'x' } }), '']) {
    const run = await upstreamRun(await post(FLOWS.echo.id, body), runs(FLOWS.echo));
    assert.deepEqual([run.status, run.errorcode], ['Failed', 'ActionFailed'], body);
  }
  // A flow without a Response still answers 202 Default.
  const silent = await post(FLOWS.silent.id, '');
  assert.equal(silent.status, 202);
  assert.deepEqual(await flowError(silent), { ErrorCode: '0000000B', Message: 'Default' });
});

// @test-kind observation+security: hosted session F8 envelope group (two runs): the request filters refuse before any run, with the platform's 500 error page; an eventData string that is not JSON answers an empty 500; the refusal keeps the flow from running
test('requests without the anti-forgery token or X-Requested-With, or with a body that does not parse, do not run the flow', async (t) => {
  const { post, runs } = await hostedSite(t);
  const body = event({ text: 'invented refused' });
  for (const [label, response] of [
    ['no token', await post(FLOWS.echo.id, body, { token: null })],
    ['invalid token', await post(FLOWS.echo.id, body, { token: 'invented-token' })],
    ['no X-Requested-With', await post(FLOWS.echo.id, body, { ajax: false })],
    ['body not JSON', await post(FLOWS.echo.id, '{not json')],
  ]) {
    assert.equal(response.status, 500, label);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label);
    assert.match(await response.text(), /<title>We&#39;re sorry, but something went wrong \(500\)<\/title>/, label);
  }
  const invalid = await post(FLOWS.echo.id, JSON.stringify({ eventData: '{not json' }));
  assert.deepEqual([invalid.status, invalid.headers.get('content-type'), await invalid.text()], [500, null, '']);
  assert.equal(runs(FLOWS.echo).length, 0, 'no refused request started a run');
  for (const method of ['GET', 'PUT']) {
    const other = await post(FLOWS.echo.id, body, { method });
    assert.deepEqual([other.status, await other.text()], [404, ''], method);
  }
});

// F8 envelope and roles groups: unknown, malformed, braced, consumer and other site's ids, and no id.
test('an id that is not a consumer process id of this site answers IncorrectFlowId; no id answers 9004010A', async (t) => {
  const { post } = await hostedSite(t);
  for (const id of [g(999), 'not-a-guid', `{${FLOWS.echo.id}}`, CONSUMER, FLOWS.unlinked.id]) {
    const response = await post(id, event({ text: 'invented' }));
    assert.equal(response.status, 404, id);
    assert.deepEqual(await flowError(response), { ErrorCode: '00000005', Message: 'IncorrectFlowId' }, id);
  }
  const none = await post('', event({ text: 'invented' }));
  assert.equal(none.status, 400);
  assert.deepEqual(await flowError(none), {
    error: { code: '9004010A', message: 'An unexpected error occurred while processing the request' },
  });
});

// F8 status group: the Response status table; custom Response headers are dropped.
test('a Response status maps to the flow API answer and its headers are dropped', async (t) => {
  const { post, runs } = await hostedSite(t);
  const ok = await post(FLOWS.status.id, event({ status: 200 }));
  assert.deepEqual(
    [ok.status, ok.headers.get('x-invented-flow'), JSON.parse(await ok.text())],
    [200, null, { requested: 200 }],
  );
  const expected = {
    201: [201, { ErrorCode: '0000000B', Message: 'Default' }],
    202: [202, { ErrorCode: '0000000B', Message: 'Default' }],
    400: [400, { ErrorCode: '00000006', Message: 'IncorrectPayload' }],
    404: [404, { ErrorCode: '00000008', Message: 'FlowNotFound' }],
    409: [409, { ErrorCode: '00000006', Message: 'IncorrectPayload' }],
    500: [400, { ErrorCode: 'IncorrectPayload', Message: 'BadGateway' }],
    503: [400, { ErrorCode: 'IncorrectPayload', Message: 'BadGateway' }],
  };
  for (const [status, [answered, body]] of Object.entries(expected)) {
    const response = await post(FLOWS.status.id, event({ status: Number(status) }));
    assert.equal(response.status, answered, status);
    assert.equal(response.headers.get('x-invented-flow'), null, status);
    assert.deepEqual(await flowError(response), body, status);
  }
  const empty = await post(FLOWS.status.id, event({ status: 204 }));
  assert.deepEqual([empty.status, await empty.text()], [204, '']);
  // A computed 302 cannot answer: the Response action fails and the run with it.
  const redirect = await upstreamRun(await post(FLOWS.status.id, event({ status: 302 })), runs(FLOWS.status));
  assert.equal(redirect.status, 'Failed');
});

// F8 outcomes group, with the run statuses of flowruns-final.
test('a run that ends without answering its Response answers 400 with its run id; without a Response 202 Default', async (t) => {
  const { post, runs } = await hostedSite(t);
  const failed = await upstreamRun(await post(FLOWS.failing.id, event({ text: 'x' })), runs(FLOWS.failing));
  assert.equal(failed.status, 'Failed');
  for (const [runStatus, ended] of [
    ['Failed', 'Failed'],
    ['Succeeded', 'Succeeded'],
    ['Cancelled', 'Cancelled'],
  ]) {
    const run = await upstreamRun(await post(FLOWS.terminate.id, event({ runStatus })), runs(FLOWS.terminate));
    assert.equal(run.status, ended, runStatus);
  }
  for (const flow of [FLOWS.silent, FLOWS.terminateOnly]) {
    const response = await post(flow.id, event({ text: 'x' }));
    assert.equal(response.status, 202);
    assert.deepEqual(await flowError(response), { ErrorCode: '0000000B', Message: 'Default' });
  }
  assert.equal(runs(FLOWS.terminateOnly)[0].status, 'Failed');
  const after = await post(FLOWS.after.id, event({ text: 'x' }));
  assert.deepEqual([after.status, JSON.parse(await after.text())], [200, { kind: 'answered' }]);
  assert.equal(runs(FLOWS.after)[0].status, 'Failed', 'a failure after the Response still fails the run');
});

// F8 roles and anonymous groups: a signed-in visitor holds Authenticated Users but not Anonymous Users.
test('web roles: MissingPermissions for a role not held; Anonymous Users applies only to anonymous visitors', async (t) => {
  const { post } = await hostedSite(t);
  const missing = { ErrorCode: '00000003', Message: 'MissingPermissions' };
  for (const flow of [FLOWS.gated, FLOWS.anonymous]) {
    const response = await post(flow.id, event({ text: 'invented' }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.deepEqual(await flowError(response), missing);
  }
  for (const [flow, version] of [
    [FLOWS.echo, 'v1.0'],
    [FLOWS.gated, 'v1.0'],
    [FLOWS.echo, 'v2.0'],
  ]) {
    const response = await post(flow.id, event({ text: 'invented' }), { cookie: null, version });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private');
    assert.deepEqual(await flowError(response), missing);
  }
  const anonymous = await post(FLOWS.anonymous.id, event({ text: 'invented' }), { cookie: null });
  assert.deepEqual([anonymous.status, JSON.parse(await anonymous.text())], [200, { kind: 'anonymous' }]);
  const unknown = await post(g(999), event({ text: 'invented' }), { cookie: null });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('cache-control'), 'private');
});

// @test-kind observation+contract: hosted session F8 disabled-off and disabled-deleted groups (paqvilo-developer hosted-f8 summary-F8.md, both runs): an inactive workflow and a consumer whose workflow is gone; explicit local activation (Paqvilo design, mirage/docs/operations.md Activation) runs the Draft export
test('an inactive workflow answers FlowDisabled; a consumer without its workflow answers FlowNotFound', async (t) => {
  const { app, post, runs } = await hostedSite(t);
  const disabled = await post(FLOWS.draft.id, event({ text: 'invented' }));
  assert.equal(disabled.status, 400);
  assert.deepEqual(await flowError(disabled), { ErrorCode: '00000002', Message: 'FlowDisabled' });
  assert.equal(runs(FLOWS.draft).length, 0);
  const operation = (body) =>
    fetch(app.url + '/__sim/api/operations/' + encodeURIComponent('cloud-flow:draft-consumer'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
      body: JSON.stringify(body),
    });
  // A local mock answers for the flow without reading its definition: the export's Draft state does not apply.
  assert.equal((await operation({ mode: 'mock', status: 200, body: { kind: 'mocked' } })).status, 200);
  const mocked = await post(FLOWS.draft.id, event({ text: 'invented' }));
  assert.deepEqual([mocked.status, JSON.parse(await mocked.text())], [200, { kind: 'mocked' }]);
  const activated = await fetch(`${app.url}/__sim/api/operations/${encodeURIComponent('cloud-flow:draft-consumer')}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ mode: 'exported', activation: 'local-enabled' }),
  });
  assert.equal(activated.status, 200, await activated.text());
  const local = await post(FLOWS.draft.id, event({ text: 'invented' }));
  assert.deepEqual([local.status, JSON.parse(await local.text())], [200, { kind: 'draft' }]);
  const deleted = await post(FLOWS.missing.id, event({ text: 'invented' }));
  assert.equal(deleted.status, 404);
  assert.deepEqual(await flowError(deleted), { ErrorCode: '00000008', Message: 'FlowNotFound' });
});

// @test-kind observation+contract: hosted session F8 request group (paqvilo-developer hosted-f8 summary-F8.md, two runs): the flow's siteId is the site's portal id (Microsoft.Dynamic365.Portal.id, the admin-center id), not the website record id; a site records it as observed.portalId (mirage/docs/configuration.md), and without it Mirage uses the website id
test('observed.portalId is the page Portal.id and the flow siteId; without it both are the website id', async (t) => {
  const PORTAL = 'F8000000-0000-4000-8000-0000000000BB';
  const { app, post } = await hostedSite(t, {
    observed: { portalId: PORTAL, evidence: 'Invented site: hosted session F8 request group' },
  });
  const flow = await post(FLOWS.echo.id, event({ text: 'invented' }));
  assert.equal(JSON.parse(await flow.text()).body.siteId, PORTAL.toLowerCase());
  const page = await (await fetch(app.url + '/')).text();
  assert.ok(page.includes(`"id":"${PORTAL.toLowerCase()}"`), 'the page client object carries the observed portal id');
  const plain = await hostedSite(t);
  const home = await (await fetch(plain.app.url + '/')).text();
  assert.ok(home.includes(`"id":"${SITE.toLowerCase()}"`), 'without it, the website id');
  assert.equal(
    JSON.parse(await (await plain.post(FLOWS.echo.id, event({ text: 'x' }))).text()).body.siteId,
    SITE.toLowerCase(),
  );
});

// @test-kind contract: observed.portalId is validated as a GUID and needs evidence, as every observation does (mirage/lib/project-config.mjs, docs/configuration.md)
test('observed.portalId takes a GUID with evidence', async () => {
  const { observedConfig } = await import('../lib/project-config.mjs');
  assert.deepEqual(
    observedConfig({ portalId: 'F8000000-0000-4000-8000-0000000000BB', evidence: 'Invented evidence' }),
    {
      portalId: 'f8000000-0000-4000-8000-0000000000bb',
      evidence: 'Invented evidence',
    },
  );
  for (const portalId of ['not-a-guid', '{f8000000-0000-4000-8000-0000000000bb}', 42])
    assert.throws(() => observedConfig({ portalId, evidence: 'Invented evidence' }), /portalId must be a GUID/);
  assert.throws(() => observedConfig({ portalId: 'f8000000-0000-4000-8000-0000000000bb' }), /evidence/);
});

// @test-kind observation: hosted session F8 outcomes and envelope groups (paqvilo-developer hosted-f8 summary-F8.md, two runs) through Server.Connector.CloudFlow.TriggerAsync: the envelope carries the flow API's answer, so a Terminate Succeeded before the Response is a 400, not a success; the server-logic route and envelope are Paqvilo's local bridge
test('CloudFlow.TriggerAsync answers what the flow API answers, including a run that ended without its Response', async (t) => {
  const { app, signedIn } = await hostedSite(t);
  const exported = await fetch(
    app.url + '/__sim/api/operations/' + encodeURIComponent('server-logic:invented-trigger'),
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
      body: JSON.stringify({ mode: 'exported' }),
    },
  );
  assert.equal(exported.status, 200, await exported.text());
  const trigger = async (flowId, payload) => {
    const response = await fetch(app.url + '/_api/serverlogics/invented-trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: signedIn, __RequestVerificationToken: app.csrf },
      body: JSON.stringify({ flowId, payload }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const envelope = JSON.parse((await response.json()).data);
    return typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  };
  const unanswered = await trigger(FLOWS.terminate.id, { runStatus: 'Succeeded' });
  assert.deepEqual([unanswered.StatusCode, unanswered.IsSuccessStatusCode], [400, false]);
  assert.equal(JSON.parse(unanswered.Body).ErrorCode, 'IncorrectPayload');
  assert.match(JSON.parse(unanswered.Body).Message, upstream);
  const echoed = await trigger(FLOWS.echo.id, { text: 'invented bridge' });
  assert.equal(echoed.StatusCode, 200);
  assert.deepEqual(JSON.parse(echoed.Body).body, {
    siteId: SITE.toLowerCase(),
    siteUrl: new URL(app.url).origin,
    userId: CONTACT,
    text: 'invented bridge',
  });
  const silent = await trigger(FLOWS.silent.id, {});
  assert.deepEqual([silent.StatusCode, silent.IsSuccessStatusCode, silent.Body], [202, true, '']);
});

// @test-kind unproven: inferred, not captured: F8 captured Response statuses 200, 201, 202, 204, 302, 400, 404, 409, 500 and 503; other statuses are assumed to follow their class, and a data pack's cloud-flow handler that does not answer within its 120 s is assumed to answer as a flow past the limit
test('uncaptured Response statuses follow their class; a pack handler past its limit answers BadGateway', () => {
  const answered = (status) => powerPagesFlowAnswer({ answer: { status, body: { invented: true } }, runId: 'run' });
  assert.deepEqual(answered(206), { status: 206, error: { ErrorCode: '0000000B', Message: 'Default' } });
  assert.deepEqual(answered(401), { status: 401, error: { ErrorCode: '00000006', Message: 'IncorrectPayload' } });
  assert.deepEqual(answered(422), { status: 422, error: { ErrorCode: '00000006', Message: 'IncorrectPayload' } });
  assert.deepEqual(answered(502), { status: 400, error: { ErrorCode: 'IncorrectPayload', Message: 'BadGateway' } });
  assert.deepEqual(
    powerPagesFlowAnswer({ error: Object.assign(new Error('late'), { status: 504, code: 'PackHandlerTimeout' }) }),
    {
      status: 400,
      error: { ErrorCode: 'IncorrectPayload', Message: 'BadGateway' },
    },
  );
});
