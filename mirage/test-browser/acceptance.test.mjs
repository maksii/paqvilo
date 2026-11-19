// @test-kind contract: Paqvilo's own _sim, Lense and setup user interface behaviour
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { runAcceptance as runAcceptanceImpl } from '../acceptance.mjs';
import { fileURLToPath } from 'node:url';
import {
  registerFixtureDiagnostics,
  finalizeFixtureDiagnostics,
} from '../../test-browser/helpers/fixture-diagnostics.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { ACCEPTANCE_HANG_GUARD_MS, loopbackServer } from './shared-browser.mjs';
import { PROCESS_SLOTS } from '../test/process-slots.mjs';

// Each test launches its own browser. Respect the lane's process budget as well as the outer file concurrency.
const TESTS_IN_PARALLEL = Math.min(4, PROCESS_SLOTS);
// The runner's action budget for every flow here. Steps that are meant to fail set their own shorter budget; the
// rest keep this one, so a loaded host never ends a step by elapsed time.
const ACTION_BUDGET_MS = ACCEPTANCE_HANG_GUARD_MS;
const diagnosticFixtures = new WeakMap();
function ownAcceptanceFixture(t, root) {
  const fixture = { root, registration: null, completedReports: 0 };
  diagnosticFixtures.set(t, fixture);
  ownedFixture(t).remove(async () => {
    const published = fixture.registration && finalizeFixtureDiagnostics(fixture.registration, t.signal);
    if (published && !published.canRemove) return;
    await fs.rm(root, { recursive: true, force: true });
    if (published) {
      assert.ok(
        published.reports >= fixture.completedReports,
        'every completed acceptance report survives fixture teardown',
      );
      for (const file of published.files)
        assert.ok((await fs.stat(file)).isFile(), 'published diagnostics remain after the private fixture is removed');
    }
  });
}
async function runAcceptance(t, options) {
  const fixture = diagnosticFixtures.get(t);
  assert.ok(fixture, 'acceptance diagnostics are owned before the producer starts');
  assert.ok(['evidence', 'failed-evidence'].includes(path.relative(fixture.root, options.outputDir)));
  assert.equal(options.liveOrigin == null, true, 'synthetic diagnostics cannot capture a live comparison');
  assert.ok(
    options.flows.every((flow) => flow.mode !== 'live'),
    'only local acceptance fixtures publish diagnostics',
  );
  fixture.registration = registerFixtureDiagnostics({
    fixtureRoot: fixture.root,
    kind: 'acceptance',
    reportRoots: ['evidence', 'failed-evidence'],
    origin: options.localUrl,
    outputRoot: fileURLToPath(new URL('../../.paqvilo/', import.meta.url)),
  });
  const result = await runAcceptanceImpl(options);
  if (result.report) fixture.completedReports++;
  return result;
}
describe('acceptance runner', { concurrency: TESTS_IN_PARALLEL }, () => {
  test('acceptance settles abandoned frame writes and records navigation cancellations', async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-detached-flow-'));
    ownAcceptanceFixture(t, root);
    const state = {
      config: { mode: 'local', pageMode: 'local', endpoints: [] },
      status: { sourceFingerprint: 'synthetic', implementationFingerprint: 'synthetic' },
    };
    const observed = new Set(),
      requestsObserved = Promise.withResolvers();
    const { origin } = await loopbackServer(t, (req, res) => {
      const route = new URL(req.url, 'http://fixture').pathname;
      if (route === '/__sim/api/state' || route === '/__sim/api/audit/export') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(route.endsWith('/state') ? state : { events: [] }));
      }
      if (route === '/slow-one' || route === '/slow-two') {
        req.resume();
        observed.add(route);
        if (observed.size === 2) requestsObserved.resolve();
        return;
      }
      if (route === '/requests-observed') {
        void requestsObserved.promise.then(() => res.end('ready'));
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (route === '/frame')
        return res.end(
          `<button id="save" onclick="fetch('/slow-one',{method:'PATCH'}).catch(()=>{});fetch('/slow-two',{method:'POST'}).catch(()=>{});fetch('/requests-observed').then(response=>response.text()).then(()=>{parent.document.querySelector('#done').hidden=false;parent.document.querySelector('iframe').remove()})">Save</button>`,
        );
      res.end('<iframe id="child" src="/frame"></iframe><p id="done" hidden>Saved</p>');
    });
    const result = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: origin,
      outputDir: path.join(root, 'evidence'),
      flows: [
        {
          name: 'Detached form frame',
          steps: [
            { action: 'navigate', path: '/' },
            { action: 'visible', frame: '#child', selector: '#save' },
            { action: 'click', frame: '#child', selector: '#save' },
            { action: 'settle' },
            { action: 'visible', selector: '#done' },
          ],
        },
      ],
    });
    assert.equal(result.passed, true, JSON.stringify(result.flows[0]));
    const cancelled = result.flows[0].navigationCancelledRequests;
    assert.equal(cancelled.length, 2);
    assert.deepEqual(cancelled.map((row) => row.method).sort(), ['PATCH', 'POST']);
    assert.ok(cancelled.every((row) => row.reason === 'frame-detached' && Number.isFinite(Date.parse(row.at))));
  });

  test('acceptance records old main-document reads as cancelled after navigation commits', async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-replaced-flow-'));
    ownAcceptanceFixture(t, root);
    const observed = new Set(),
      requestsObserved = Promise.withResolvers();
    const { origin } = await loopbackServer(t, (req, res) => {
      const route = new URL(req.url, 'http://fixture').pathname;
      if (route.startsWith('/__sim/api/')) {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify(
            route.endsWith('/state')
              ? {
                  config: { mode: 'local', pageMode: 'local', endpoints: [] },
                  status: { sourceFingerprint: 'synthetic', implementationFingerprint: 'synthetic' },
                }
              : { events: [] },
          ),
        );
      }
      if (route.startsWith('/slow-')) {
        req.resume();
        observed.add(route);
        if (observed.size === 2) requestsObserved.resolve();
        return;
      }
      if (route === '/requests-observed') {
        void requestsObserved.promise.then(() => res.end('ready'));
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        route === '/done'
          ? '<p id="done">Saved</p>'
          : `<button id="save" onclick="fetch('/slow-one').catch(()=>{});fetch('/slow-two').catch(()=>{});fetch('/requests-observed').then(response=>response.text()).then(()=>location.href='/done')">Save</button>`,
      );
    });
    const result = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: origin,
      outputDir: path.join(root, 'evidence'),
      flows: [
        {
          name: 'Replaced page',
          steps: [
            { action: 'navigate', path: '/' },
            { action: 'click', selector: '#save' },
            { action: 'visible', selector: '#done' },
            { action: 'settle' },
          ],
        },
      ],
    });
    assert.equal(result.passed, true, JSON.stringify(result.flows[0]));
    assert.equal(result.flows[0].navigationCancelledRequests.length, 2);
    assert.ok(result.flows[0].navigationCancelledRequests.every((row) => row.reason === 'document-replaced'));
  });

  for (const step of [
    { action: 'identity', roles: ['Reviewer'] },
    { action: 'preset', id: 'demo' },
  ])
    test(`acceptance settles queued page work before the ${step.action} step leaves the page`, async (t) => {
      const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-step-settle-'));
      ownAcceptanceFixture(t, root);
      // The page queues its read as a task after the click. The fixture answers it only when the runner asks for its
      // audit proof, which the runner does only inside its settle loop while a request is open: a step that reloads
      // or leaves the page without settling cancels the read instead.
      let heldRead = null;
      const { origin } = await loopbackServer(t, (req, res) => {
        req.resume();
        const route = new URL(req.url, 'http://fixture').pathname;
        res.setHeader('content-type', route.startsWith('/__sim/api/') ? 'application/json' : 'text/html');
        if (route === '/__sim/api/state')
          return res.end(
            JSON.stringify({
              csrf: 'invented',
              config: { mode: 'local', pageMode: 'local', endpoints: [] },
              status: { sourceFingerprint: 'synthetic', implementationFingerprint: 'synthetic' },
            }),
          );
        if (route === '/__sim/api/session') return res.end(JSON.stringify({ contactId: 'tester' }));
        if (route === '/__sim/api/session/sign-in') return res.end(JSON.stringify({ roles: ['Reviewer'] }));
        if (route === '/__sim/api/audit/export') {
          heldRead?.end('refreshed');
          heldRead = null;
          return res.end(JSON.stringify({ events: [] }));
        }
        if (route === '/refresh') {
          heldRead = res;
          return;
        }
        if (route === '/__sim/')
          return res.end(
            `<label for="preset">Available preset</label><select id="preset"><option value="demo">Demo</option></select><button id="apply" type="button">Apply selected preset</button><div id="confirm" hidden><button id="confirmed" type="button">Apply preset</button></div><script>document.getElementById('apply').onclick=()=>document.getElementById('confirm').hidden=false;document.getElementById('confirmed').onclick=()=>document.getElementById('confirm').hidden=true</script>`,
          );
        res.end(
          `<button id="refresh" type="button" onclick="setTimeout(()=>fetch('/refresh').then(response=>response.text()),0)">Refresh</button>`,
        );
      });
      const result = await runAcceptance(t, {
        timeout: ACTION_BUDGET_MS,
        localUrl: origin,
        outputDir: path.join(root, 'evidence'),
        flows: [
          {
            name: `Queued work before ${step.action}`,
            steps: [{ action: 'navigate', path: '/' }, { action: 'click', selector: '#refresh' }, step],
          },
        ],
      });
      assert.equal(result.passed, true, JSON.stringify(result.flows[0]));
      assert.equal(
        result.flows[0].resources.filter((resource) => resource.url === origin + '/refresh' && resource.finished)
          .length,
        1,
        `the queued read finishes before the ${step.action} step leaves the page`,
      );
      assert.equal(result.flows[0].navigationCancelledRequests?.length ?? 0, 0);
    });

  for (const [beforeNavigation, lateNavigation] of [
    [false, false],
    [true, false],
    [true, true],
  ])
    test(`acceptance settles writes that straddle a delayed document replacement (hold=${beforeNavigation}, late=${lateNavigation})`, async (t) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-navigation-boundary-')));
      ownAcceptanceFixture(t, root);
      const documentRequested = Promise.withResolvers();
      const beforeWriteObserved = Promise.withResolvers();
      const lateWritesObserved = Promise.withResolvers();
      const settlementStarted = Promise.withResolvers();
      const writes = new Set();
      const server = http.createServer((req, res) => {
        const route = new URL(req.url, 'http://fixture').pathname;
        req.resume();
        if (route.startsWith('/__sim/api/')) {
          // The runner asks for audit proof only after entering its settle loop. Start the late navigation
          // there, after the initial navigation-hold snapshot, instead of guessing with a 1200 ms timer.
          if (route.endsWith('/audit/export') && writes.has('/slow-before')) settlementStarted.resolve();
          res.setHeader('content-type', 'application/json');
          return res.end(
            JSON.stringify(
              route.endsWith('/state')
                ? {
                    config: { mode: 'local', pageMode: 'local', endpoints: [] },
                    status: { sourceFingerprint: 'synthetic', implementationFingerprint: 'synthetic' },
                  }
                : { events: [] },
            ),
          );
        }
        if (route.startsWith('/slow-')) {
          writes.add(route);
          if (route === '/slow-before') beforeWriteObserved.resolve();
          if (writes.has('/slow-one') && writes.has('/slow-two')) lateWritesObserved.resolve();
          return;
        }
        if (route === '/start-navigation') {
          void Promise.all([beforeWriteObserved.promise, ...(lateNavigation ? [settlementStarted.promise] : [])]).then(
            () => res.end('navigate'),
          );
          return;
        }
        if (route === '/late-writes-ready') {
          void documentRequested.promise.then(() => res.end('write'));
          return;
        }
        res.setHeader('content-type', 'text/html');
        if (route === '/done') {
          void lateWritesObserved.promise.then(() => res.end('<p id="done">Saved</p>'));
          return;
        }
        res.end(
          `<form action="/done"><button id="save">Save</button></form><script>document.querySelector('form').addEventListener('submit',event=>{${beforeNavigation ? `event.preventDefault();fetch('/slow-before',{method:'PATCH'}).catch(()=>{});fetch('/start-navigation').then(response=>response.text()).then(()=>location.href='/done');` : ''}fetch('/late-writes-ready').then(response=>response.text()).then(()=>{fetch('/slow-one',{method:'PATCH'}).catch(()=>{});fetch('/slow-two',{method:'POST'}).catch(()=>{})})})</script>`,
        );
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      ownedFixture(t).add(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      });
      const result = await runAcceptance(t, {
        timeout: ACTION_BUDGET_MS,
        localUrl: `http://127.0.0.1:${server.address().port}`,
        outputDir: path.join(root, 'evidence'),
        prepareContext: async (context) => {
          context.on('request', (request) => {
            if (request.isNavigationRequest() && new URL(request.url()).pathname === '/done')
              documentRequested.resolve();
          });
        },
        flows: [
          {
            name: 'Late document writes',
            steps: [
              { action: 'navigate', path: '/' },
              // With hold, the held writes end at the navigation's reserve deadline, which the navigation waits
              // report. Without hold, the click waits for the /done navigation the server releases only after both
              // late writes arrive. Both keep the runner's action budget: a slow host must not fail them.
              { action: 'click', selector: '#save' },
              { action: 'settle' },
              { action: 'visible', selector: '#done' },
            ],
          },
        ],
      });
      if (!result.passed)
        t.diagnostic(
          JSON.stringify({
            error: result.flows[0].error,
            navigationWaits: result.flows[0].navigationWaits,
            failedRequests: result.flows[0].failedRequests.length,
            cancelledRequests: result.flows[0].navigationCancelledRequests.length,
          }),
        );
      assert.equal(result.passed, true, JSON.stringify(result.flows[0]));
      assert.equal(writes.size, beforeNavigation ? 3 : 2);
      const cancelled = result.flows[0].navigationCancelledRequests;
      assert.equal(cancelled.length, beforeNavigation ? 3 : 2);
      assert.ok(cancelled.every((row) => row.reason === 'document-replaced'));
      if (beforeNavigation) assert.ok(result.flows[0].navigationWaits.some((wait) => wait.settled === false));
    });

  test('acceptance opens and settles a modal without counting frame lifecycle requests as portal failures', async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-modal-acceptance-'));
    ownAcceptanceFixture(t, root);
    await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: site\nadx_name: Modal fixture');
    await fs.writeFile(path.join(root, 'Home.webpage.yml'), 'adx_webpageid: home\nadx_name: Host\nadx_partialurl: /\n');
    await fs.writeFile(
      path.join(root, 'Home.webpage.copy.html'),
      '<button id="open" onclick="document.getElementById(\'holder\').innerHTML=\'<iframe id=modal src=/_portal/modal-form-template-path/site?entityformid=create></iframe>\'">Open</button><div id="holder"></div>',
    );
    await fs.writeFile(
      path.join(root, 'Create.basicform.yml'),
      'adx_entityformid: create\nadx_name: Create\nadx_entityname: sample\nadx_mode: 100000000',
    );
    const app = await createSimulator({
      sourceDir: root,
      stateFile: path.join(root, 'state.json'),
      watch: false,
      initial: {
        settings: { permissionMode: 'permissive' },
        mappings: { sample: { idColumn: 'sampleid' } },
        tables: { sample: [] },
        simulator: {
          mode: 'local',
          pageMode: 'local',
          live: { allowWrites: false },
          endpoints: [],
          componentSchemas: { create: { entity: 'sample', fields: [{ name: 'name', type: 'text' }] } },
        },
      },
    });
    ownedFixture(t).add(() => app.close());
    const report = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: app.url,
      outputDir: path.join(root, 'evidence'),
      flows: [
        {
          name: 'Modal',
          steps: [
            { action: 'navigate', path: '/' },
            { action: 'click', selector: '#open' },
            { action: 'visible', frame: '#modal', selector: '#name' },
            { action: 'settle' },
          ],
        },
      ],
    });
    assert.equal(
      report.passed,
      true,
      JSON.stringify({
        sourceChanged: report.sourceChanged,
        implementationChanged: report.implementationChanged,
        flows: report.flows.map((flow) => ({
          passed: flow.passed,
          error: flow.error,
          failedResponses: flow.failedResponses,
          pageErrors: flow.pageErrors,
          failedRequests: flow.failedRequests,
        })),
      }),
    );
    assert.equal(report.flows[0].failedRequests.length, 0);
  });

  test('acceptance retains Chromium script SyntaxErrors even when their stack is empty', async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-syntax-flow-'));
    ownAcceptanceFixture(t, directory);
    await fs.writeFile(
      path.join(directory, 'Home.webpage.yml'),
      'adx_webpageid: home\nadx_name: Syntax fixture\nadx_partialurl: /\n',
    );
    await fs.writeFile(
      path.join(directory, 'Home.webpage.copy.html'),
      '<h1>Syntax fixture</h1><script>const duplicatedFixture = 1;</script><script>const duplicatedFixture = 2;</script>',
    );
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, 'state.json'),
      watch: false,
    });
    ownedFixture(t).add(() => app.close());
    const report = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: app.url,
      flows: [{ name: 'Syntax fixture', steps: [{ action: 'navigate', path: '/' }] }],
      outputDir: path.join(directory, 'evidence'),
    });
    assert.equal(report.passed, false);
    assert.match(report.flows[0].pageErrors[0], /Identifier 'duplicatedFixture' has already been declared/);
    assert.equal(report.flows[0].pageErrorDetails[0].name, 'SyntaxError');
    assert.match(report.flows[0].pageErrorDetails[0].message, /already been declared/);
    assert.equal(typeof report.flows[0].pageErrorDetails[0].stack, 'string');
  });

  test('acceptance records actual role refresh, create/edit persistence, screenshots and failed assertions', async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-flow-'));
    ownAcceptanceFixture(t, directory);
    await fs.writeFile(
      path.join(directory, 'Home.webpage.yml'),
      'adx_webpageid: home\nadx_name: Flows\nadx_partialurl: /\n',
    );
    // The script reads user.roles; after a native save postback (success message shown)
    // it schedules a refresh request that the runner must record as finished. The refresh is a task queued when the
    // document is ready, as the native success postMessage queues the parent's subgrid refresh, so it runs before
    // any page turn the runner queues later. A refresh delayed by wall-clock time is not queued page work: whether it ran
    // before the next step would depend on the host's speed.
    await fs.writeFile(
      path.join(directory, 'Home.webpage.copy.html'),
      '<h1>Portal flows</h1><input id="async-default"><button id="initialize-default" type="button" onclick="setTimeout(() => document.getElementById(&quot;async-default&quot;).value = &quot;Initialized&quot;, 200)">Initialize default</button><input id="userroles" type="hidden" value="{{user.roles | join: \'|\'}}"><div id="script-roles"></div><script>document.getElementById("script-roles").textContent=document.getElementById("userroles").value;document.addEventListener("DOMContentLoaded",()=>setTimeout(()=>{if(document.getElementById("MessageLabel"))fetch("/save-followup").then(r=>r.json());},0));</script>{% if request.params.id %}{% entityform name: "Contact edit form" %}{% else %}{% entityform name: "Contact form" %}{% endif %}',
    );
    await fs.writeFile(
      path.join(directory, 'Contact.basicform.yml'),
      'adx_entityformid: contact-form\nadx_name: Contact form\nadx_entityname: contact\nadx_mode: 100000000\nadx_submitbuttontext: Save\nadx_successmessage: Saved\nadx_hideformonsuccess: false\n',
    );
    // Native basic forms: Insert mode creates; Edit mode takes the record ID from the query
    // string (Allow Create If Null applies to Record Associated to Current Portal User only).
    await fs.writeFile(
      path.join(directory, 'ContactEdit.basicform.yml'),
      'adx_entityformid: contact-edit-form\nadx_name: Contact edit form\nadx_entityname: contact\nadx_mode: 100000001\nadx_submitbuttontext: Save\nadx_successmessage: Saved\nadx_hideformonsuccess: false\n',
    );
    const app = await createSimulator({
      sourceDir: directory,
      stateFile: path.join(directory, 'state.json'),
      watch: false,
      initial: {
        version: 1,
        mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
        tables: { contact: [] },
        settings: { permissionMode: 'permissive' },
        simulator: {
          mode: 'local',
          pageMode: 'local',
          identity: { id: 'tester', roles: [] },
          live: { allowWrites: false },
          // This suite asserts the JSON form endpoint; the core default is the WebForms postback.
          observed: { nativeFormTransport: 'json', evidence: 'Invented loopback JSON transport fixture' },
          endpoints: [
            {
              id: 'save-followup',
              path: '/save-followup',
              method: 'GET',
              mode: 'local',
              body: { complete: true },
            },
          ],
          componentSchemas: {
            'Contact form': {
              entity: 'contact',
              mode: 100000000,
              fields: [{ name: 'fullname', label: 'Name', required: true }],
              submitLabel: 'Save',
            },
            'Contact edit form': {
              entity: 'contact',
              mode: 100000001,
              fields: [{ name: 'fullname', label: 'Name', required: true }],
              submitLabel: 'Save',
            },
          },
        },
      },
    });
    ownedFixture(t).add(() => app.close());
    const flows = [
      {
        name: 'Role switching reaches portal scripts without manual reload',
        steps: [
          { action: 'navigate', path: '/' },
          { action: 'click', selector: '#initialize-default' },
          { action: 'value', selector: '#async-default', value: 'Initialized' },
          { action: 'identity', roles: ['Reviewer'] },
          { action: 'text', selector: '#script-roles', value: 'Reviewer' },
          { action: 'value', selector: '#userroles', value: 'Reviewer' },
        ],
      },
      {
        name: 'Create and edit through exported form',
        steps: [
          { action: 'navigate', path: '/' },
          { action: 'fill', selector: '#fullname', value: 'Flow record' },
          { action: 'click', role: 'button', name: 'Save', mutation: true },
          { action: 'text', selector: '#MessageLabel', value: 'Saved' },
          {
            action: 'rememberRecord',
            entity: 'contact',
            fields: { fullname: 'Flow record' },
            variable: 'contactId',
          },
          { action: 'navigate', path: '/?id={{contactId}}' },
          { action: 'value', selector: '#fullname', value: 'Flow record' },
          {
            action: 'fill',
            selector: '#fullname',
            value: 'Edited flow record',
          },
          { action: 'click', role: 'button', name: 'Save', mutation: true },
          { action: 'text', selector: '#MessageLabel', value: 'Saved' },
          {
            action: 'record',
            entity: 'contact',
            fields: { fullname: 'Edited flow record' },
            count: 1,
          },
        ],
      },
    ];
    // Portal routes take their identity from the paqvilo-mirage-auth session only, so the runner's
    // browser context signs in as the "tester" contact with no web roles before the flows.
    const prepareContext = (context) => signInContext(context, app, 'tester', { roles: [] });
    const result = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: app.url,
      prepareContext,
      flows,
      outputDir: path.join(directory, 'evidence'),
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.flows.length, 2);
    assert.equal(
      result.flows[1].resources.filter((resource) => resource.url === app.url + '/save-followup' && resource.finished)
        .length,
      2,
      'Scheduled post-save refreshes finish before navigation and final evidence',
    );
    assert.equal(app.state().data.contact.length, 1);
    assert.equal(app.state().data.contact[0].fullname, 'Edited flow record');
    assert.equal(
      result.flows[1].writes.filter(
        (request) =>
          request.method === 'POST' &&
          ['contact-form', 'contact-edit-form'].some((id) =>
            request.url.includes(`/__sim/forms/entityform/${id}/submit`),
          ),
      ).length,
      2,
    );
    for (const flow of result.flows) {
      assert.ok(flow.screenshots.length > 0, `${flow.name} records final screenshot evidence`);
      for (const image of flow.screenshots) assert.ok((await fs.stat(image)).size > 0);
    }
    // The budget each screenshot runs under: its own timeout, else the page default when it was taken.
    const screenshotBudgets = [];
    const failed = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: app.url,
      prepareContext: async (context, origin) => {
        context.on('page', (page) => {
          let defaultTimeout;
          const setDefaultTimeout = page.setDefaultTimeout.bind(page),
            screenshot = page.screenshot.bind(page);
          page.setDefaultTimeout = (ms) => {
            defaultTimeout = ms;
            setDefaultTimeout(ms);
          };
          page.screenshot = (options = {}) => {
            screenshotBudgets.push({ file: path.basename(options.path), timeout: options.timeout ?? defaultTimeout });
            return screenshot(options);
          };
        });
        await prepareContext(context, origin);
      },
      flows: [
        {
          name: 'Incorrect control expectation',
          steps: [
            { action: 'navigate', path: '/' },
            // The mismatch fails at this step's own deadline; the page load keeps the default.
            { action: 'value', selector: '#userroles', value: 'Wrong role', timeout: 2000 },
          ],
        },
      ],
      outputDir: path.join(directory, 'failed-evidence'),
    });
    assert.equal(failed.passed, false);
    assert.match(failed.flows[0].error, /expected field value/i);
    assert.ok(failed.flows[0].screenshots.length, JSON.stringify(failed.flows[0].screenshotError));
    // The failed step spent its own 2000 ms; its failure screenshot is not cut to that deadline.
    assert.deepEqual(screenshotBudgets, [
      { file: '1-Incorrect-control-expectation-failure.png', timeout: ACTION_BUDGET_MS },
    ]);
    assert.equal(app.state().data.contact.length, 1);
  });

  test('default navigation proceeds at DOM readiness and retains a slow request failure', async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-ready-'));
    ownAcceptanceFixture(t, directory);
    const state = {
      config: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
      status: { sourceFingerprint: 'fixture-source', implementationFingerprint: 'fixture-implementation' },
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/__sim/api/state') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(state));
      }
      if (url.pathname === '/__sim/api/audit/export') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ events: [] }));
      }
      if (url.pathname === '/never-finishes.png') {
        res.setHeader('content-type', 'image/png');
        // The response stays open until the fixture closes its connections.
        return res.write(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'));
      }
      res.setHeader('content-type', 'text/html');
      res.end('<h1 id="ready">DOM is ready</h1><img src="/never-finishes.png">');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ownedFixture(t).add(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    // One runner session: every owned Edge session costs seconds on a loaded host, while each flow
    // has its own page and observation. The second flow checks step deadline validation.
    const result = await runAcceptance(t, {
      timeout: ACTION_BUDGET_MS,
      localUrl: `http://127.0.0.1:${server.address().port}`,
      flows: [
        {
          name: 'DOM ready with outstanding image request',
          // The never-finishing image fails only the settlement, at its own deadline. Navigation keeps the
          // default deadline, which it would exhaust if it waited for the load event; its bounded
          // post-load quiet wait spends that deadline and records the open image.
          steps: [
            { action: 'navigate', path: '/' },
            { action: 'visible', selector: '#ready' },
            { action: 'settle', timeout: 1000 },
          ],
        },
        { name: 'Invalid step deadline', steps: [{ action: 'navigate', path: '/', timeout: 0 }] },
      ],
      outputDir: path.join(directory, 'evidence'),
    });
    assert.equal(result.flows[0].steps[0].passed, true, JSON.stringify(result.flows[0]));
    assert.equal(result.flows[0].steps[1].passed, true);
    assert.deepEqual(
      result.flows[0].loadWaits.map(({ settled, pending }) => ({ settled, pending })),
      [{ settled: false, pending: ['GET /never-finishes.png'] }],
    );
    assert.equal(result.flows[0].passed, false);
    assert.match(result.flows[0].error, /Portal requests did not settle/);
    assert.ok(result.flows[0].pendingRequests.some((request) => request.url.endsWith('/never-finishes.png')));
    assert.ok(
      result.flows[0].resources.some((resource) => resource.url.endsWith('/never-finishes.png')),
      'the slow image remains visible in the request report',
    );
    // A step deadline applies to its own step only, is recorded with it, and is validated like the flow's.
    assert.deepEqual(
      result.flows[0].steps.map((step) => step.timeout),
      [undefined, undefined, 1000],
    );
    assert.equal(result.flows[1].passed, false);
    assert.match(result.flows[1].error, /step timeout must be a positive finite number/);
  });
});
