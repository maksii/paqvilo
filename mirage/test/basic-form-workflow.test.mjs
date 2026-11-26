// @test-kind security: local Basic Form workflows are bound to exact exported actions, workflows and authorized form rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { authCookieName } from '../lib/auth-session.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { sourceFixture } from './fixtures/source-site.mjs';
import { reloadDuringHandler } from './support/source-refresh-gate.mjs';

const id = (n) => `53200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1),
  FORM = id(2),
  CONTACT = id(3),
  ROW = id(4),
  OTHER = id(5);
const WORKFLOW = id(10),
  BACKGROUND = id(11),
  NAMED = id(12),
  UNEXPORTED = id(13);
const portalForm = 'portal/Workflow.basicform.yml';
const selectedPage = `/?row=${ROW}`;
const xpath =
  '<fetch><entity name="x_entry"><attribute name="x_entryid"/><filter><condition attribute="title" operator="eq" value="Eligible"/></filter></entity></fetch>';

const definitionXml = (workflowId, name, mode) =>
  `<Workflow WorkflowId="{${workflowId}}" UniqueName="${name}" Name="${name}" Type="1" Category="0" Mode="${mode}" OnDemand="1" PrimaryEntity="x_entry" StateCode="1"/>`;

async function fixture(t, clock = null) {
  const action = {
    Type: 'WorkflowAction',
    WorkflowId: WORKFLOW,
    ButtonLabel: 'Run local process',
    WorkflowDialogTitle: 'Confirm local process',
    SuccessMessage: 'Finished',
    FilterCriteria: xpath,
  };
  const formSettings = (actions) =>
    [
      `adx_entityformid: ${FORM}`,
      'adx_name: Workflow form',
      'adx_entityname: x_entry',
      'adx_mode: 100000001',
      'adx_entitysourcetype: 756150001',
      'adx_recordidquerystringparametername: row',
      'adx_settings: |-',
      `  ${JSON.stringify({ Actions: actions })}`,
    ].join('\n');
  const defaultActions = [action, ...[BACKGROUND, NAMED, UNEXPORTED].map((WorkflowId) => ({ ...action, WorkflowId }))];
  const { root } = await sourceFixture(t, {
    prefix: 'basic-form-workflow-',
    files: {
      'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented workflow`,
      'portal/Home.webpage.yml':
        'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
      'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
      'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
      'portal/Main.webtemplate.source.html': '{% entityform name: "Workflow form" %}',
      ...(clock
        ? {
            'portal/sitesetting.yml': [
              '- adx_sitesettingid: expiry\n  adx_name: Authentication/ApplicationCookie/ExpireTimeSpan\n  adx_value: "00:00:10"',
              '- adx_sitesettingid: sliding\n  adx_name: Authentication/ApplicationCookie/SlidingExpiration\n  adx_value: "true"',
            ].join('\n'),
          }
        : {}),
      [portalForm]: formSettings(defaultActions),
      'solution/Other/Solution.xml':
        '<ImportExportXml><SolutionManifest><UniqueName>InventedWorkflowForm</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
      'solution/Workflows/Primary.xaml.data.xml': definitionXml(WORKFLOW, 'Primary', 1),
      'solution/Workflows/Background.xaml.data.xml': definitionXml(BACKGROUND, 'Background', 0),
      'solution/Workflows/NameOnly.xaml.data.xml': definitionXml(NAMED, 'NameOnly', 1),
      'pack.mjs': `
        async function write({api, target}) {
          await api.store.updateRecordAsync('x_entry', target.id, {runs: target.row.runs + 1}, {admin: true});
          return {message: 'Workflow committed'};
        }
        export default {
          id: 'workflow-form-fixture', name: 'Invented workflow form', description: 'Loopback workflow handlers',
          matches: () => true, presets: () => ({}),
          workflows: { '${WORKFLOW}': write, '${BACKGROUND}': write, nameonly: write, '${UNEXPORTED}': write },
        };`,
    },
  });
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    projectRoot: root,
    solutionRoots: [path.join(root, 'solution')],
    watch: false,
    port: 0,
    ...(clock ? { clock, identityProvider: { pairedBrowserTokens: true } } : {}),
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    dataPacks: [{ module: path.join(root, 'pack.mjs') }],
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        x_entry: {
          entitySet: 'x_entries',
          idColumn: 'x_entryid',
          nameColumn: 'title',
          fields: {
            title: { dataverseType: 'nvarchar' },
            runs: { dataverseType: 'int' },
          },
        },
      },
      permissions: [
        { id: 'edit-entry', entity: 'x_entry', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] },
        { id: 'read-entry', entity: 'x_entry', scope: 'global', roles: ['Reader'], operations: ['read'] },
      ],
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Invented member' }],
        x_entry: [
          { x_entryid: ROW, title: 'Eligible', runs: 0 },
          { x_entryid: OTHER, title: 'Other', runs: 0 },
        ],
        workflow: [
          {
            workflowid: UNEXPORTED,
            type: 1,
            category: 0,
            mode: 1,
            ondemand: true,
            statecode: 1,
            primaryentity: 'x_entry',
          },
        ],
      },
      settings: { permissionMode: 'enforce' },
      simulator: {
        permissionSource: 'configured',
        componentSchemas: { [FORM]: { entity: 'x_entry', fields: [{ name: 'title', type: 'text', required: true }] } },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const editor = signInHeaders(app, CONTACT, { roles: ['Editor'] });
  const reader = signInHeaders(app, CONTACT, { roles: ['Reader'] });
  const page = async (location = selectedPage, headers = editor) =>
    (await fetch(app.url + location, { headers })).text();
  const url = `/__sim/forms/entityform/${FORM}/submit`;
  const post = (override = {}, session = editor, destination = url) =>
    fetch(app.url + destination, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.portalToken, ...session },
      body: JSON.stringify({
        action: 'workflow',
        actionIndex: 0,
        workflowId: WORKFLOW,
        recordId: ROW,
        values: {},
        query: { row: ROW },
        ...override,
      }),
    });
  const runs = (recordId) => app.store.tableRows('x_entry').find((row) => row.x_entryid === recordId).runs;
  return { app, root, page, post, runs, reader, url };
}

async function runConfirmedButton(app, button, post, destination) {
  const script = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url), 'utf8');
  const begin = script.indexOf('  function confirmFormWorkflow(');
  const end = script.indexOf("  document.addEventListener('click'", begin);
  const handler = new Function(
    'location',
    'post',
    'showModal',
    'hideModal',
    'notify',
    script.slice(begin, end) + '\nreturn formActionClick;',
  );
  const location = new URL(selectedPage, app.url);
  let reloaded = false;
  location.reload = () => {
    reloaded = true;
  };
  let shown = false,
    posted = false;
  const primary = { disabled: false };
  const modal = { querySelector: () => primary };
  const click = handler(
    location,
    async (url, body) => {
      assert.equal(url, destination);
      posted = true;
      const response = await post(body);
      assert.equal(response.status, 200);
      return response.json();
    },
    () => {
      shown = true;
    },
    () => {
      shown = false;
    },
    (row, message) => assert.fail(message),
  );
  const control = { querySelector: (selector) => ({ value: selector.includes('EntityName') ? 'x_entry' : ROW }) };
  const row = { closest: () => control, querySelector: () => modal };
  const attr = (name) => button.match(new RegExp(`data-${name}="([^"]+)"`))?.[1];
  const rendered = {
    closest: () => row,
    dataset: {
      url: attr('url'),
      ppFormAction: attr('pp-form-action'),
      ppActionIndex: attr('pp-action-index'),
      ppWorkflowId: attr('pp-workflow-id'),
    },
  };
  click({ target: { closest: () => rendered }, preventDefault() {} });
  assert.equal(shown, true);
  assert.equal(posted, false);
  await primary.onclick();
  assert.equal(posted, true);
  assert.equal(shown, false);
  assert.equal(reloaded, true);
}

test('Basic Form WorkflowAction renders and runs only its admitted exact Solution definition and trusted handler', async (t) => {
  const { app, page, post, runs, reader, url } = await fixture(t);
  const html = await page();
  const buttons = [...html.matchAll(/<button[^>]*data-pp-form-action="workflow"[^>]*>/g)];
  assert.equal(
    buttons.length,
    1,
    JSON.stringify(app.state().diagnostics.filter((entry) => /workflow|form/i.test(entry.code ?? ''))),
  );
  assert.match(html, /Confirm local process/);
  assert.doesNotMatch(await page(`/?row=${OTHER}`), /data-pp-form-action="workflow"/);
  assert.doesNotMatch(await page(selectedPage, reader), /data-pp-form-action="workflow"/);
  for (const [override, status] of [
    [{ workflowId: NAMED }, 403],
    [{ actionIndex: undefined }, 403],
    [{ values: { title: 'Other' } }, 400],
    [{ recordId: OTHER }, 403],
    [{ recordId: OTHER, query: { row: OTHER } }, 403],
    [{ actionIndex: 1, workflowId: BACKGROUND }, 501],
    [{ actionIndex: 2, workflowId: NAMED }, 501],
    [{ actionIndex: 3, workflowId: UNEXPORTED }, 501],
  ]) {
    const response = await post(override);
    assert.equal(response.status, status, JSON.stringify(override));
  }
  assert.equal((await post({}, reader)).status, 403);
  assert.equal(runs(ROW), 0);
  assert.equal(runs(OTHER), 0);
  assert.equal(app.store.tableRows('workflowlog').length, 0);

  await runConfirmedButton(app, buttons[0][0], post, url);
  assert.equal(runs(ROW), 1);
  assert.equal(runs(OTHER), 0);
  assert.deepEqual(
    app.store.tableRows('workflowlog').map((row) => row.message),
    ['Workflow committed'],
  );
});

test('Basic Form workflow with a renewed browser session rolls back if source publication overlaps execution', async (t) => {
  const clock = fixedClock();
  const { app, root, post, runs } = await fixture(t, clock);
  const name = authCookieName(new URL(app.url).port);
  const applicationCookie = (response) =>
    response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(name + '='))
      ?.split(';')[0];
  const signedIn = await fetch(app.adminOrigin + '/__sim/api/session/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ contactId: CONTACT, roles: ['Editor'] }),
  });
  assert.equal(signedIn.status, 200);
  const original = applicationCookie(signedIn);
  assert.ok(original);
  await signedIn.arrayBuffer();
  const browser = { 'sec-fetch-site': 'same-origin' };
  const tokenHtml = (cookie) => fetch(app.url + '/_layout/tokenhtml', { headers: { ...browser, cookie } });
  const first = await tokenHtml(original);
  assert.equal(first.status, 200);
  const binding = first.headers
    .getSetCookie()
    .find((cookie) => cookie.includes('-request-binding-'))
    ?.split(';')[0];
  const requestToken = async (response) => /value="([0-9a-f]{64})"/.exec(await response.text())?.[1];
  const token = await requestToken(first);
  assert.ok(binding && token);
  clock.advance(5001);
  const renewal = await tokenHtml(`${original}; ${binding}`);
  assert.equal(renewal.status, 200);
  const renewed = applicationCookie(renewal);
  assert.ok(renewed && renewed !== original);
  assert.ok((await requestToken(renewal)) === token);
  const session = (cookie) => ({ ...browser, cookie: `${cookie}; ${binding}`, __RequestVerificationToken: token });
  clock.advance(4999);
  const expired = await post({}, session(original));
  assert.equal(expired.status, 403);
  assert.equal(applicationCookie(expired), undefined);
  await expired.arrayBuffer();
  assert.equal(runs(ROW), 0);
  // A failed real-time run of this workflow also records a process session; the refused run must not.
  await app.store.transact(() => {
    const definition = app.store.tableRows('workflow').find((row) => row.workflowid === WORKFLOW);
    assert.ok(definition, 'the exported workflow is seeded');
    definition.syncworkflowlogonfailure = true;
  });

  const refused = await reloadDuringHandler(t, {
    app,
    sourcePath: path.join(root, portalForm),
    start: () => post({}, session(renewed)),
    label: 'form',
  });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, 'SourceRefreshConflict');
  assert.equal(runs(ROW), 0);
  // The refused run leaves no trace: no failed log and no process session outside its rollback.
  assert.deepEqual(app.store.tableRows('workflowlog'), []);
  assert.deepEqual(app.store.tableRows('processsession'), []);
  clock.advance(2);
  const retried = await post({}, session(renewed));
  assert.equal(retried.status, 200);
  assert.equal(applicationCookie(retried), undefined);
  await retried.arrayBuffer();
  assert.equal(runs(ROW), 1);
  assert.deepEqual(
    app.store.tableRows('workflowlog').map((row) => [row.status, row.message]),
    [[2, 'Workflow committed']],
  );
});
