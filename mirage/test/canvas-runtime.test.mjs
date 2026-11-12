// Headless canvas runtime (canvas-runtime.mjs) on the core Power Fx engine over a two-screen app: OnStart, a
// gallery bound to a Dataverse table filtered by a text input, Patch as the caller's principal (403 for a Basic User on
// an organization-owned table), Navigate/Back with OnVisible and context variables, an edit form submitted with
// SubmitForm, unsupported controls, the driver API and the source-graph rows. Delegation, display names, cycles and
// nested behaviour functions are in canvas-runtime-engine.test.mjs.
// @test-kind contract: Paqvilo's own headless Canvas runtime behaviour, including the form and session semantics it documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { stringify } from 'yaml';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { createCanvasApp, createCanvasRuntime, describeCanvasRuntime, splitTop } from '../lib/canvas-runtime.mjs';
import { createCanvasHandler } from '../lib/canvas-http.mjs';
import { buildSourceGraph, canvasRequirementRows } from '../lib/source-graph.mjs';
import { CANVAS_APP_FILES, fixtureApp, organization } from './canvas-runtime-fixture.mjs';

async function start(t, { principal = 'admin', app = null } = {}) {
  const org = await organization(t);
  const entry = app ?? (await fixtureApp());
  const instance = createCanvasApp({
    app: entry,
    evaluator: createPowerFxEvaluator(),
    principal: org[principal],
    api: org.api,
    caller: org.caller,
  });
  await instance.start();
  return { org, app: entry, instance };
}
const control = (snapshot, screen, name) =>
  snapshot.screens.find((entry) => entry.name === screen).controls.find((entry) => entry.name === name);

test('OnStart sets a global variable before the start screen shows and runs OnVisible; the app is never rendered', async (t) => {
  const { instance } = await start(t);
  const snapshot = instance.snapshot();
  assert.equal(snapshot.rendered, false);
  assert.equal(snapshot.currentScreen, 'HomeScreen');
  assert.deepEqual(snapshot.variables, { fxGreeting: 'Hello' });
  assert.deepEqual(snapshot.context, { HomeScreen: { fxVisits: 1 } });
  assert.equal(control(snapshot, 'HomeScreen', 'GreetingLabel').properties.Text, 'Hello');
  assert.deepEqual(snapshot.errors, []);
});

test('a gallery bound to a Dataverse table re-filters when the text input changes', async (t) => {
  const { instance } = await start(t);
  const titles = (snapshot) =>
    control(snapshot, 'HomeScreen', 'WidgetGallery').items.map((item) => item.controls.WidgetTitle.Text);
  assert.deepEqual(titles(instance.snapshot()), ['Alpha', 'Beta']);
  const { snapshot } = await instance.act({ action: 'input', control: 'SearchBox', value: 'B' });
  assert.equal(control(snapshot, 'HomeScreen', 'SearchBox').properties.Text, 'B');
  assert.deepEqual(titles(snapshot), ['Beta']);
  assert.deepEqual(titles((await instance.act({ action: 'input', control: 'SearchBox', value: '' })).snapshot), [
    'Alpha',
    'Beta',
  ]);
});

// @test-kind security: a Basic User without the create privilege is refused and nothing is written
test('a button Patch creates the row as the caller; a Basic User is refused with 403, nothing is written and the chain continues', async (t) => {
  const admin = await start(t);
  await admin.instance.act({ action: 'input', control: 'SearchBox', value: 'Gamma' });
  const created = await admin.instance.act({ action: 'select', control: 'AddButton' });
  assert.deepEqual(created.errors, []);
  const row = admin.org.store.state.tables.fx_widget.find((item) => item.fx_name === 'Gamma');
  assert.ok(row, 'row written');
  assert.match(JSON.stringify(row.createdby), new RegExp(admin.org.admin.principalId));
  // The fixture has no fixed clock, so the stamp is checked for shape: a string id and a finite creation time.
  const [saved] = created.snapshot.notifications;
  assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'id', 'message', 'timeout', 'type']);
  assert.deepEqual(
    { message: saved.message, type: saved.type, timeout: saved.timeout },
    {
      message: 'Saved',
      type: 'Success',
      timeout: 10000,
    },
  );
  assert.equal(typeof saved.id, 'string');
  assert.ok(Number.isFinite(saved.createdAt));
  assert.ok(Number.isFinite(created.snapshot.now));
  assert.equal(control(created.snapshot, 'HomeScreen', 'WidgetGallery').items.length, 1);

  const basic = await start(t, { principal: 'basic' });
  await basic.instance.act({ action: 'input', control: 'SearchBox', value: 'Delta' });
  const refused = await basic.instance.act({ action: 'select', control: 'AddButton' });
  assert.equal(refused.errors.length, 1);
  assert.equal(refused.errors[0].status, 403);
  assert.equal(refused.errors[0].kind, 'CreatePermission');
  assert.ok(!basic.org.store.state.tables.fx_widget.some((item) => item.fx_name === 'Delta'));
  // Actions in a chain do not stop after the first error.
  assert.deepEqual(
    refused.snapshot.notifications.map((item) => item.message),
    ['Saved'],
  );
});

// @test-kind compatibility: Microsoft Learn Notify function, Timeout 0 keeps the notification until dismissed.
test('Notify with a Timeout of 0 keeps the notification until it is dismissed', async (t) => {
  const { instance } = await start(t);
  const { snapshot } = await instance.act({
    action: 'evaluate',
    formula: 'Notify("Saved", NotificationType.Success, 0)',
  });
  assert.equal(snapshot.notifications.at(-1).timeout, 0);
});

// @test-kind compatibility: Microsoft Learn Notify function, a missing Timeout is 10 seconds by default.
test('Notify without a Timeout is dismissed after 10 seconds', async (t) => {
  const { instance } = await start(t);
  const { snapshot } = await instance.act({ action: 'evaluate', formula: 'Notify("Saved")' });
  assert.equal(snapshot.notifications.at(-1).timeout, 10000);
});

// @test-kind unproven: no native evidence for negative Timeout values; the 10-second default is a local decision.
test('Notify with a negative Timeout gets the 10-second default', async (t) => {
  const { instance } = await start(t);
  const { snapshot } = await instance.act({
    action: 'evaluate',
    formula: 'Notify("Saved", NotificationType.Success, -5)',
  });
  assert.equal(snapshot.notifications.at(-1).timeout, 10000);
});

test('Notify with a text Timeout returns an error value and raises no notification', async (t) => {
  const { instance } = await start(t);
  const { snapshot, result } = await instance.act({
    action: 'evaluate',
    formula: 'Notify("Saved", NotificationType.Success, "abc")',
  });
  assert.ok(result?.error, 'the Timeout error is the formula result, as a bad Message is');
  assert.equal(
    snapshot.notifications.some((item) => item.message === 'Saved'),
    false,
  );
});

test('Navigate passes context, runs OnHidden/OnVisible and Back returns through the history', async (t) => {
  const { instance } = await start(t);
  let { snapshot } = await instance.act({ action: 'select', control: 'OpenButton', item: 1 });
  assert.equal(snapshot.currentScreen, 'DetailScreen');
  assert.deepEqual(snapshot.history, ['HomeScreen', 'DetailScreen']);
  assert.equal(snapshot.variables.fxDetailShown, true);
  assert.equal(snapshot.variables.fxHomeHidden, true);
  assert.equal(snapshot.context.DetailScreen.fxWidget.fx_name, 'Beta');
  assert.equal(control(snapshot, 'DetailScreen', 'TitleLabel').properties.Text, 'Beta');
  assert.equal(control(snapshot, 'HomeScreen', 'WidgetGallery').properties.Selected.fx_name, 'Beta');
  ({ snapshot } = await instance.act({ action: 'select', control: 'BackButton' }));
  assert.equal(snapshot.currentScreen, 'HomeScreen');
  assert.deepEqual(snapshot.history, ['HomeScreen']);
  assert.deepEqual(snapshot.context.HomeScreen, { fxVisits: 2 });
  assert.equal((await instance.act({ action: 'back' })).result, false); // Back answers false with nowhere to go back to
  await assert.rejects(instance.act({ action: 'navigate', screen: 'NoSuchScreen' }), {
    code: 'CanvasScreenNotFound',
    status: 404,
  });
});

test('SubmitForm updates the item, runs OnSuccess, refuses a missing required value and creates after NewForm', async (t) => {
  const { org, instance } = await start(t);
  await instance.act({ action: 'select', control: 'OpenButton', item: 0 });
  let { snapshot } = await instance.act({ action: 'input', control: 'NameInput', value: 'Alpha 2' });
  assert.deepEqual(control(snapshot, 'DetailScreen', 'EditForm1').properties.Updates, { fx_name: 'Alpha 2' });
  assert.equal(control(snapshot, 'DetailScreen', 'EditForm1').properties.Unsaved, true);
  ({ snapshot } = await instance.act({ action: 'select', control: 'SaveButton' }));
  assert.deepEqual(snapshot.errors, []);
  assert.equal(
    org.store.state.tables.fx_widget.find((row) => row.fx_widgetid === '77777777-7777-4777-8777-777777777701').fx_name,
    'Alpha 2',
  );
  assert.equal(snapshot.notifications.at(-1).message, 'Form saved');
  assert.equal(control(snapshot, 'DetailScreen', 'EditForm1').properties.LastSubmit.fx_name, 'Alpha 2');

  await instance.act({ action: 'input', control: 'NameInput', value: '' });
  ({ snapshot } = await instance.act({ action: 'select', control: 'SaveButton' }));
  assert.deepEqual(snapshot.forms.EditForm1, {
    mode: 'Edit',
    error: 'A required value is missing.',
    errorKind: 'Validation',
  });
  assert.equal(snapshot.notifications.at(-1).type, 'Error');

  await instance.act({ action: 'select', control: 'NewButton' });
  ({ snapshot } = await instance.act({ action: 'input', control: 'NameInput', value: 'Epsilon' }));
  assert.equal(snapshot.forms.EditForm1.mode, 'New');
  ({ snapshot } = await instance.act({ action: 'select', control: 'SaveButton' }));
  assert.ok(org.store.state.tables.fx_widget.some((row) => row.fx_name === 'Epsilon'));
  assert.equal(snapshot.forms.EditForm1.mode, 'Edit'); // a successful submit in New returns the form to Edit
});

test('an unsupported control is listed, refused when driven and reported by the canvas:app requirement row', async (t) => {
  const { app, instance } = await start(t);
  const snapshot = instance.snapshot();
  assert.deepEqual(snapshot.unsupported, [{ screen: 'HomeScreen', name: 'Chart1', control: 'PieChart@1.0.0' }]);
  assert.equal(control(snapshot, 'HomeScreen', 'Chart1').supported, false);
  await assert.rejects(instance.act({ action: 'select', control: 'Chart1' }), {
    code: 'CanvasControlUnsupported',
    status: 501,
  });
  const graph = buildSourceGraph({ scan: { layers: [], inventory: [{ ...app.record, solution: null, layer: null }] } });
  const rows = Object.fromEntries(
    graph
      .requirements()
      .filter((row) => row.kind === 'canvas')
      .map((row) => [row.id, row]),
  );
  assert.equal(rows['canvas:app/fx_inventedcanvas'].status, 'unsupported');
  assert.equal(rows['canvas:app/fx_inventedcanvas'].reason, 'CANVAS_CONTROL_UNSUPPORTED');
  assert.match(rows['canvas:app/fx_inventedcanvas'].message, /HomeScreen\.Chart1 \(PieChart@1\.0\.0\)/);
  assert.equal(rows['canvas:rendering'].status, 'unsupported');
  assert.equal(rows['canvas:rendering'].surface, 'canvas');
  assert.ok(
    !graph.requirements().some((row) => row.id === 'canvasapp:fx_inventedcanvas'),
    'a hosted app has no placeholder row',
  );
  // Project canvas.sources records produce the same rows (organization-host.mjs preflight).
  assert.deepEqual(
    canvasRequirementRows([app.record]).map((row) => [row.id, row.status]),
    [
      ['canvas:app/fx_inventedcanvas', 'unsupported'],
      ['canvas:rendering', 'unsupported'],
    ],
  );
});

test('the canvas-apps capability record describes the bounded player', () => {
  const record = describeCanvasRuntime({ evaluatorLevel: 'behaviour' });
  assert.equal(record.level, 'behaviour');
  assert.ok(record.operations.length > 0);
  assert.ok(record.operations.every((operation) => operation.level === 'behaviour'));
  assert.match(record.fidelity.notes[0], /bounded local HTML player/);
  const contract = describeCanvasRuntime().operations;
  assert.equal(contract.length, record.operations.length);
  assert.ok(contract.every((operation) => operation.level === 'contract'));
});

test('behaviour chains split at top-level semicolons only', () => {
  assert.deepEqual(splitTop('Set(a, "x;y"); Notify(Concat(T, b; c)); /* ; */ Back()', ';'), [
    'Set(a, "x;y")',
    'Notify(Concat(T, b; c))',
    '/* ; */ Back()',
  ]);
});

// @test-kind security: the driver API refuses callers that are not loopback, have no principal or lack the CSRF token
test('the driver API needs loopback, a principal and the CSRF token; JSON answers the write status, forms redirect', async (t) => {
  const org = await organization(t);
  const app = await fixtureApp();
  let caller = null;
  const runtime = createCanvasRuntime({
    apps: () => [app],
    evaluator: createPowerFxEvaluator(),
    api: org.api,
    caller: org.caller,
  });
  const handler = createCanvasHandler({
    apps: () => [app],
    runtime,
    principal: async () => caller,
    csrf: () => 'fx-token',
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { 'content-type': 'application/json', 'x-sim-csrf': 'fx-token' }) =>
    fetch(`${base}/_apps/api/canvas/fx_inventedcanvas`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });

  assert.equal(
    (await (await post({ action: 'select', control: 'AddButton' })).json()).error.code,
    'CanvasPrincipalRequired',
  );
  caller = org.basic;
  const noCsrf = await post({ action: 'select', control: 'AddButton' }, { 'content-type': 'application/json' });
  assert.deepEqual([noCsrf.status, (await noCsrf.json()).error.code], [403, 'CsrfRequired']);
  await post({ action: 'input', control: 'SearchBox', value: 'Zeta' });
  const refused = await post({ action: 'select', control: 'AddButton' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).errors[0].kind, 'CreatePermission');
  const unknown = await post({ action: 'fly' });
  assert.deepEqual([unknown.status, (await unknown.json()).error.code], [400, 'CanvasActionInvalid']);

  caller = org.admin;
  // A GET never starts the app or runs OnStart: the API answers started false, the page offers a Start form (a POST).
  assert.deepEqual(await (await fetch(`${base}/_apps/api/canvas/fx_inventedcanvas`)).json(), {
    app: 'fx_inventedcanvas',
    started: false,
    rendered: false,
  });
  const idle = await (await fetch(`${base}/_apps/canvas/fx_inventedcanvas?view=inspect`)).text();
  assert.match(idle, /name="action" value="start"/);
  assert.doesNotMatch(idle, /Current screen/);
  assert.equal(runtime.existing('fx_inventedcanvas', org.admin), null);
  const started = await post({ action: 'start' });
  assert.equal((await started.json()).snapshot.variables.fxGreeting, 'Hello');
  const form = await post(
    new URLSearchParams({ _csrf: 'fx-token', action: 'select', control: 'OpenButton', item: '0' }).toString(),
    { 'content-type': 'application/x-www-form-urlencoded' },
  );
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), '/_apps/canvas/fx_inventedcanvas?view=inspect');
  const snapshot = await (await fetch(`${base}/_apps/api/canvas/fx_inventedcanvas`)).json();
  assert.equal(snapshot.currentScreen, 'DetailScreen');
  const page = await (await fetch(`${base}/_apps/canvas/fx_inventedcanvas?view=inspect`)).text();
  assert.match(page, /Canvas apps are not rendered/);
  assert.match(page, /Current screen: <strong>DetailScreen<\/strong>/);
  assert.match(page, /name="_csrf" value="fx-token"/);
  assert.match(page, /Chart1: PieChart@1\.0\.0/);
  assert.doesNotMatch(page, /<script/i);
  // One instance per principal: the Basic User's app is still on HomeScreen.
  caller = org.basic;
  assert.equal((await (await fetch(`${base}/_apps/api/canvas/fx_inventedcanvas`)).json()).currentScreen, 'HomeScreen');
});

test('a host without the runtime answers 501 CanvasRuntimeUnavailable on the driver API', async (t) => {
  const app = await fixtureApp();
  const handler = createCanvasHandler({ apps: () => [app] });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/_apps/api/canvas/fx_inventedcanvas`, {
    method: 'POST',
    body: '{}',
  });
  assert.deepEqual([response.status, (await response.json()).error.code], [501, 'CanvasRuntimeUnavailable']);
});

test('an fx.yaml app runs its OnStart and screens the same way', async (_t) => {
  const files = {
    'Src/App.fx.yaml': 'App As appinfo:\n    OnStart: =Set(fxGreeting, "Hello")\n',
    'Src/HomeScreen.fx.yaml': 'HomeScreen As screen:\n\n    GreetingLabel As label:\n        Text: =fxGreeting\n',
  };
  const instance = createCanvasApp({ app: await fixtureApp(files), evaluator: createPowerFxEvaluator() });
  await instance.start();
  assert.equal(control(instance.snapshot(), 'HomeScreen', 'GreetingLabel').properties.Text, 'Hello');
});

const ctl = (name, type, properties = {}, children = [], extra = {}) => ({
  [name]: { Control: type, ...extra, Properties: properties, ...(children.length ? { Children: children } : {}) },
});

test('Form.Unsaved follows user input into a card: false after NewForm, true after typing, false after SubmitForm', async (t) => {
  const { instance } = await start(t);
  await instance.act({ action: 'select', control: 'OpenButton', item: 0 });
  const unsaved = (snapshot) => control(snapshot, 'DetailScreen', 'EditForm1').properties.Unsaved;
  let { snapshot } = await instance.act({ action: 'select', control: 'NewButton' });
  assert.equal(unsaved(snapshot), false);
  ({ snapshot } = await instance.act({ action: 'input', control: 'NameInput', value: 'Epsilon' }));
  assert.equal(unsaved(snapshot), true);
  ({ snapshot } = await instance.act({ action: 'select', control: 'SaveButton' }));
  assert.deepEqual(snapshot.errors, []);
  assert.equal(unsaved(snapshot), false);
});

test('Form.Unsaved is false on an untouched edit form whose card Update builds a record', async (t) => {
  const files = {
    ...CANVAS_APP_FILES,
    'Src/DetailScreen.pa.yaml': stringify({
      Screens: {
        DetailScreen: {
          Children: [
            ctl('EditForm1', 'Form@2.4.4', { DataSource: '=Widgets', Item: '=First(Widgets)' }, [
              ctl(
                'RecordCard',
                'TypedDataCard@1.0.7',
                { DataField: '="fx_name"', Default: '={v: 1}', Update: '={v: 1}' },
                [],
                { Variant: 'ClassicTextualEdit' },
              ),
            ]),
          ],
        },
      },
    }),
  };
  const { instance } = await start(t, { app: await fixtureApp(files) });
  const { snapshot } = await instance.act({ action: 'navigate', screen: 'DetailScreen' });
  assert.equal(control(snapshot, 'DetailScreen', 'EditForm1').properties.Unsaved, false);
});

const gatedApp = (onStart) => ({
  uniqueName: 'invented',
  source: {
    revision: 'one',
    tree: { screens: [{ name: 'Home', controls: [] }] },
    dataSources: [{ name: 'Svc', connectorId: 'invented' }],
    formulas: [{ owner: 'App', property: 'OnStart', text: onStart }],
  },
});
const gatedConnector = () => {
  let enter, open;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const connectors = async () => {
    enter();
    await gate;
    return { statusCode: 200, body: {} };
  };
  return { entered, connectors, open };
};

test('concurrent session calls share one start: both resolve after OnStart finishes and see its variables', async () => {
  const { entered, connectors, open } = gatedConnector();
  const runtime = createCanvasRuntime({
    apps: () => [gatedApp('=Set(reply, Svc.Wait({})); Set(fxReady, true)')],
    evaluator: createPowerFxEvaluator(),
    connectors,
  });
  const principal = { kind: 'staff', principalId: 'invented' };
  const readyAtResolution = (promise) => promise.then((instance) => instance.snapshot().variables.fxReady ?? null);
  const first = readyAtResolution(runtime.session('invented', principal));
  await entered;
  const second = readyAtResolution(runtime.session('invented', principal));
  await new Promise((resolve) => setImmediate(resolve)); // settles any call that returns early while the gate is closed
  open();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('a start that rejects rejects every waiting session call, and a later call starts fresh', async () => {
  const { entered, connectors, open } = gatedConnector();
  let launches = 0;
  const runtime = createCanvasRuntime({
    apps: () => [gatedApp('=Set(reply, Svc.Wait({})); Launch("https://example.test"); Set(fxReady, true)')],
    evaluator: createPowerFxEvaluator(),
    connectors,
    launch: () => {
      launches += 1;
      if (launches === 1) throw new Error('controlled start failure');
    },
  });
  const principal = { kind: 'staff', principalId: 'invented' };
  const first = runtime.session('invented', principal);
  await entered;
  const second = runtime.session('invented', principal);
  open();
  const settled = await Promise.allSettled([first, second]);
  assert.deepEqual(
    settled.map((item) => item.status),
    ['rejected', 'rejected'],
  );
  assert.match(settled[1].reason.message, /controlled start failure/);
  assert.equal(runtime.size, 0);
  const later = await runtime.session('invented', principal);
  assert.equal(later.snapshot().variables.fxReady, true);
  assert.equal(launches, 2);
});
