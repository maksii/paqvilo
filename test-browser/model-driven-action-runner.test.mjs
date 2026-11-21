// @test-kind unproven: the checks in this file exercise model driven action runner with local fixtures; no native capture establishes the behaviour they assert.
import { ownedFixture, drainFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { MODEL_DRIVEN_ACTIONS, validateModelDrivenAction } from '../lense/model-driven-actions.mjs';
import {
  runModelDrivenAction,
  modelDrivenActionAvailability,
  disposeModelDrivenActions,
} from '../lense/model-driven-action-runner.mjs';

const recordId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  formId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  environmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  solutionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const html = `<!doctype html><title>Invented native app</title><div data-id="x_name"><input value="PRIVATE_FORM_VALUE"></div><script>
window.nativeFixture={id:'${recordId}',entity:'x_person',dirty:true,idReads:0,valueReads:0,opened:[],saveHandlers:[],gridRefreshes:0,closedPanes:0,privileges:{},refreshes:[],required:'required',visible:false,disabled:true,tabVisible:false,sectionVisible:false};
const f=nativeFixture, collection=items=>({get:()=>items,forEach:callback=>items.forEach(callback)});
const values={x_name:'PRIVATE_FORM_VALUE',x_zero:0,x_false:false,x_empty:'',x_parent:[{id:'{${recordId}}',name:'Parent',entityType:'x_person'}],x_due:new Date('2026-10-21T13:25:00.000Z'),x_choices:[1,3],x_readonly:'DO_NOT_CLONE'};
const attributes=Object.entries(values).map(([name,value])=>({getName:()=>name,getValue:()=>{f.valueReads++;return value},getAttributeType:()=>name==='x_parent'?'lookup':name==='x_due'?'datetime':typeof value,getIsDirty:()=>name==='x_name',getRequiredLevel:()=>f.required,setRequiredLevel:value=>f.required=value,...(name==='x_choices'?{getOptions:()=>[{text:'Planned',value:1},{text:'Complete',value:3}]}:{})}));
const control={getName:()=> 'x_name',getVisible:()=>f.visible,setVisible:value=>f.visible=value,getDisabled:()=>f.disabled,setDisabled:value=>f.disabled=value};
const section={getVisible:()=>f.sectionVisible,setVisible:value=>f.sectionVisible=value};const tab={getVisible:()=>f.tabVisible,setVisible:value=>f.tabVisible=value,sections:collection([section])};
window.Xrm={Utility:{getGlobalContext:()=>({getClientUrl:()=>location.origin,getVersion:()=> '9.2.1234.5',organizationSettings:{bapEnvironmentId:'${environmentId}',organizationId:'${environmentId}',uniqueName:'invented'},userSettings:{userId:'${recordId}',userName:'PRIVATE_USER_NAME',getSecurityRolePrivilegesInfo:async()=>f.privileges,roles:collection([{name:'Invented role'}])}}),getPageContext:()=>({input:{pageType:'entityrecord',entityName:f.entity,entityId:f.id}})},Page:{data:{entity:{getEntityName:()=>f.entity,getId:()=>{f.idReads++;return f.id},getIsDirty:()=>f.dirty,attributes:collection(attributes),addOnSave:handler=>f.saveHandlers.push(handler),removeOnSave:handler=>f.saveHandlers=f.saveHandlers.filter(item=>item!==handler)},refresh:async save=>{f.refreshes.push(save);if(f.answer==='discard'||f.answer==='save')f.dirty=false;if(f.answer==='save')await fetch('/fixture-saved')}},ui:{getFormType:()=>2,formSelector:{getCurrentItem:()=>({getId:()=> '${formId}'})},controls:collection([control,{getControlType:()=> 'subgrid',refresh:()=>f.gridRefreshes++}]),tabs:collection([tab])}},Navigation:{openUrl:async url=>f.opened.push({url}),openForm:async(options,params)=>f.opened.push({options,params})},App:{sidePanes:{createPane:async options=>({navigate:async page=>f.opened.push({pane:options,page}),close:()=>f.closedPanes++})}}};
const host=document.createElement('div');host.id='paqvilo-model-inspector';document.body.append(host);host.__paqModelActions={token:'invented-owned-session',results:[],receive(requestId,result){this.results.push({requestId,result})}};
</script>`;

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions());
});
after(() => browser?.close());

async function fixture(t) {
  const requests = [],
    waits = new Map();
  let saves = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const send = (body) => {
      if (!response.destroyed)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (url.pathname === '/fixture-saved') {
      saves++;
      return send({});
    }
    if (url.pathname === '/main.aspx') return response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (url.pathname.includes('/Attributes'))
      return send({
        value: ['x_name', 'x_zero', 'x_false', 'x_empty', 'x_parent', 'x_due', 'x_choices', 'x_readonly'].map(
          (LogicalName) => ({
            LogicalName,
            IsValidForCreate: LogicalName !== 'x_readonly',
            AttributeType:
              LogicalName === 'x_parent'
                ? 'Lookup'
                : LogicalName === 'x_due'
                  ? 'DateTime'
                  : LogicalName === 'x_choices'
                    ? 'Virtual'
                    : 'String',
          }),
        ),
      });
    if (url.pathname.includes('x_missing')) return response.writeHead(404).end('{}');
    if (url.pathname.includes('/EntityDefinitions('))
      return send({
        LogicalName: 'x_person',
        EntitySetName: 'x_people',
        PrimaryIdAttribute: 'x_personid',
        PrimaryNameAttribute: 'x_name',
      });
    if (url.pathname.endsWith('/GetPreferredSolution()')) return send({ solutionid: solutionId });
    if (url.pathname.endsWith('/systemusers'))
      return send({
        value: [
          {
            systemuserid: recordId,
            fullname: 'Invented active user',
            domainname: 'invented@example.invalid',
            azureactivedirectoryobjectid: environmentId,
          },
          {
            systemuserid: formId,
            fullname: 'No directory identity',
            domainname: '',
            azureactivedirectoryobjectid: null,
          },
        ],
      });
    if (url.pathname.endsWith('/workflows'))
      return send({ value: [{ workflowid: formId, name: '<unsafe process name>', category: 2 }] });
    if (url.pathname.endsWith('/customapis'))
      return send({ value: [{ customapiid: environmentId, displayname: 'Invented bound API' }] });
    if (url.pathname.includes('/x_people(')) {
      const body = {
        x_name: 'PRIVATE_SERVER_VALUE',
        x_zero: 0,
        x_false: false,
        x_null: null,
        modifiedon: `2026-01-01T00:00:0${saves}Z`,
        'x_name@OData.Community.Display.V1.FormattedValue': 'PRIVATE_FORMATTED_VALUE',
      };
      const blocked = waits.get('record');
      if (blocked) {
        blocked.release = () => send(body);
        blocked.requested?.();
        return;
      }
      return send(body);
    }
    response.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`,
    context = await browser.newContext();
  ownedFixture(t).add(async () => {
    await drainFixture(
      [...waits.values()].map((wait) => async () => {
        wait.release?.();
      }),
    );
  });
  ownedFixture(t).add(async () => {
    await context.close();
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
  });
  ownedFixture(t).add(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await context.newPage();
  await page.goto(origin + '/main.aspx?appid=invented-app&pagetype=entityrecord&etn=x_person&id=' + recordId);
  let sequence = 0;
  const run = async (action, params = {}, extra = {}) => {
    const input = validateModelDrivenAction(action, params),
      requestId = `request-${++sequence}`;
    const ack = await page.evaluate(runModelDrivenAction, {
      origin,
      token: 'invented-owned-session',
      ...input,
      requestId,
      cloud: { maker: 'https://maker.example.invalid', admin: 'https://admin.example.invalid' },
      ...extra,
    });
    assert.deepEqual(ack, { accepted: true, requestId });
    assert.doesNotMatch(JSON.stringify(ack), /PRIVATE_|aaaaaaaa|bbbbbbbb/);
    return page.evaluate(
      (id) =>
        document
          .getElementById('paqvilo-model-inspector')
          .__paqModelActions.results.find((item) => item.requestId === id)?.result,
      requestId,
    );
  };
  return { page, origin, requests, waits, run };
}

test('passive action availability never reads record identity or form values; explicit results remain outside acknowledgements', async (t) => {
  const { page, origin, run, requests } = await fixture(t);
  const availability = await page.evaluate(modelDrivenActionAvailability, { origin, actions: MODEL_DRIVEN_ACTIONS });
  assert.equal(availability.find((item) => item.id === 'form:record-id').available, true);
  assert.deepEqual(await page.evaluate(() => [window.nativeFixture.idReads, window.nativeFixture.valueReads]), [0, 0]);
  const id = await run('form:record-id');
  assert.equal(id.copyText, recordId);
  const dirty = await run('form:changed-fields');
  assert.deepEqual(dirty.rows, [['x_name', 'string', 'PRIVATE_FORM_VALUE']]);
  const saved = await run('form:all-fields');
  assert.equal(saved.hideEmpty, true, 'empty saved values fold behind Show empty');
  assert.ok(saved.rows.some((row) => row[0] === 'x_false' && row[1] === 'false'));
  assert.ok(saved.rows.some((row) => row[1] === 'PRIVATE_SERVER_VALUE'));
  assert.match(saved.message, /Values saved on the server/);
  assert.ok(requests.some((request) => request.path.includes('/x_people(')));
  assert.equal(
    requests.some((request) => request.path.includes('/x_persons(')),
    false,
  );
  assert.equal(
    requests.some((request) => request.method !== 'GET'),
    false,
  );
});

test('native reads, copy links, choices, source-safe table processes and navigation use actual app metadata', async (t) => {
  const { page, origin, run, requests } = await fixture(t);
  const copied = await run('form:record-url');
  assert.equal(new URL(copied.copyText).searchParams.get('appid'), 'invented-app');
  assert.equal(new URL(copied.copyText).searchParams.get('formid'), formId);
  assert.deepEqual((await run('form:show-optionset-values')).rows, [
    ['x_choices', 'Planned', '1'],
    ['x_choices', 'Complete', '3'],
  ]);
  const processes = await run('form:table-processes');
  assert.equal(processes.rows[0][1], '<unsafe process name>', 'runner returns data; UI must render it as text');
  assert.deepEqual(
    processes.links.map((link) => {
      const url = new URL(link.url);
      assert.equal(url.origin, origin);
      assert.equal(url.searchParams.get('pagetype'), 'entityrecord');
      return [url.searchParams.get('etn'), url.searchParams.get('id')];
    }),
    [
      ['workflow', formId],
      ['customapi', environmentId],
    ],
  );
  assert.equal((await run('form:open-editor')).status, 'ok');
  // An opened address carries record and environment IDs: the visible result does not repeat it.
  assert.equal((await run('form:open-web-api')).message, 'Opened in a new tab.');
  await run('navigation:open-record-by-id', { entity: 'x_person', id: recordId });
  await run('navigation:new-record', { entity: 'x_person' });
  const plainNavigation = MODEL_DRIVEN_ACTIONS.filter(
    (action) =>
      action.id.startsWith('navigation:') &&
      ![
        'navigation:open-record-by-id',
        'navigation:new-record',
        'navigation:pin-to-side-panel',
        'navigation:open-mobile-client',
      ].includes(action.id),
  );
  assert.ok(plainNavigation.length > 0);
  for (const action of plainNavigation) {
    const outcome = await run(action.id, action.inputs.length ? { entity: 'x_person' } : {});
    assert.equal(outcome.status, 'ok', action.id);
    assert.doesNotMatch(outcome.message, /cccccccc|https?:/, action.id);
  }
  await run('navigation:open-mobile-client');
  await run('navigation:pin-to-side-panel');
  const opened = await page.evaluate(() => window.nativeFixture.opened);
  assert.ok(opened.some((item) => item.url?.includes('/s/' + solutionId + '/entity/x_person/form/edit/' + formId)));
  assert.ok(opened.some((item) => item.url?.includes('/x_people(')));
  assert.ok(opened.some((item) => item.pane?.canClose));
  assert.equal(
    requests.some((request) => request.method !== 'GET'),
    false,
  );
});

test('clone preparation preserves typed zero, false, empty, lookup and date values and performs no writes', async (t) => {
  const { page, run, requests } = await fixture(t);
  const outcome = await run('form:clone-record');
  assert.equal(outcome.status, 'ok');
  const clone = await page.evaluate(() => window.nativeFixture.opened.at(-1));
  assert.equal(clone.options.entityName, 'x_person');
  assert.equal(clone.options.entityId, undefined);
  assert.equal(clone.params.x_zero, 0);
  assert.equal(clone.params.x_false, false);
  assert.equal(clone.params.x_empty, '');
  assert.equal(clone.params.x_parent, recordId);
  assert.equal(clone.params.x_parenttype, 'x_person');
  assert.equal(clone.params.x_due, '2026-10-21T13:25:00.000Z');
  assert.equal(clone.params.x_readonly, undefined);
  assert.equal(clone.params.x_choices, '1,3');
  assert.equal(
    requests.some((request) => request.method !== 'GET'),
    false,
  );
});

test('client overrides restore exact states and autosave guard blocks only 70 with owned cleanup', async (t) => {
  const { page, origin, run } = await fixture(t);
  assert.equal((await run('form:god-mode')).status, 'ok');
  assert.deepEqual(
    await page.evaluate(() => [
      window.nativeFixture.required,
      window.nativeFixture.disabled,
      window.nativeFixture.visible,
      window.nativeFixture.tabVisible,
      window.nativeFixture.sectionVisible,
    ]),
    ['none', false, true, true, true],
  );
  await run('form:restore-overrides');
  assert.deepEqual(
    await page.evaluate(() => [
      window.nativeFixture.required,
      window.nativeFixture.disabled,
      window.nativeFixture.visible,
      window.nativeFixture.tabVisible,
      window.nativeFixture.sectionVisible,
    ]),
    ['required', true, false, false, false],
  );
  await run('form:toggle-autosave', { enabled: true });
  assert.deepEqual(
    await page.evaluate(() =>
      [70, 1, 2].map((mode) => {
        let blocked = false;
        for (const handler of window.nativeFixture.saveHandlers)
          handler({ getEventArgs: () => ({ getSaveMode: () => mode, preventDefault: () => (blocked = true) }) });
        return blocked;
      }),
    ),
    [true, false, false],
  );
  await run('form:refresh-subgrids');
  assert.equal(await page.evaluate(() => window.nativeFixture.gridRefreshes), 1);
  // The native app asks about a dirty draft itself (Unsaved changes); Lense raises no second browser dialog and reports
  // the answer from the form state and the saved record's modifiedon.
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  const discard = async (answer) => {
    await page.evaluate((answer) => {
      window.nativeFixture.dirty = true;
      window.nativeFixture.answer = answer;
    }, answer);
    return run('form:refresh-autosave-off');
  };
  const closed = await discard('close');
  assert.equal(closed.status, 'cancelled');
  assert.match(closed.message, /draft was kept/);
  assert.match((await discard('discard')).message, /^Refreshed without saving; the draft was discarded\./);
  assert.match((await discard('save')).message, /saved the draft \(Save and continue\)/);
  assert.deepEqual(await page.evaluate(() => window.nativeFixture.refreshes), [false, false, false]);
  assert.deepEqual(dialogs, []);
  await run('form:show-logical-names');
  assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 1);
  await page.evaluate(disposeModelDrivenActions, { origin, token: 'invented-owned-session' });
  assert.equal(await page.evaluate(() => window.nativeFixture.saveHandlers.length), 0);
  assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 0);
});

// @test-kind contract: Form overrides skip a control the app refuses and a failed action reverts its own partial changes; Paqvilo's own action design.
test('Form overrides skip and name a control the app refuses, and a failing action reverts the states it changed', async (t) => {
  const { page, run } = await fixture(t);
  const states = () =>
    page.evaluate(() => [
      window.nativeFixture.required,
      window.nativeFixture.disabled,
      window.nativeFixture.visible,
      window.nativeFixture.tabVisible,
      window.nativeFixture.sectionVisible,
    ]);
  const original = ['required', true, false, false, false];
  // Mirage renders no header controls and refuses to change them; the getters still answer.
  await page.evaluate(() =>
    window.Xrm.Page.ui.controls.get().push({
      getName: () => 'header_x_status',
      getLabel: () => 'Status',
      getVisible: () => true,
      setVisible: () => {
        throw new Error('Invented refusal: header controls are not rendered.');
      },
      getDisabled: () => true,
      setDisabled: () => {
        throw new Error('Invented refusal: header controls are not rendered.');
      },
    }),
  );
  const applied = await run('form:god-mode');
  assert.equal(applied.status, 'ok');
  assert.match(
    applied.message,
    /^5 changes on this form: 1 hidden control shown, 1 hidden tab shown, 1 hidden section shown, 1 locked control enabled, 1 required field made optional\. /,
  );
  // The refused control is named by its display name and where it sits; the app's own error text stays out.
  assert.match(applied.message, /\n1 header field can't be changed here: Status\.$/);
  assert.doesNotMatch(applied.message, /Invented refusal|header_x_status/);
  assert.deepEqual(await states(), ['none', false, true, true, true]);
  assert.equal(
    (await run('form:restore-overrides')).message,
    'Reset: 5 form settings restored to their state before the run.',
  );
  assert.deepEqual(await states(), original);
  // Only the kinds that changed are named: here one hidden section.
  await page.evaluate(() =>
    Object.assign(window.nativeFixture, { required: 'none', disabled: false, visible: true, tabVisible: true }),
  );
  assert.match((await run('form:god-mode')).message, /^1 change on this form: 1 hidden section shown\. Server/);
  await run('form:restore-overrides');
  await page.evaluate(() =>
    Object.assign(window.nativeFixture, { required: 'required', disabled: true, visible: false, tabVisible: false }),
  );
  assert.deepEqual(await states(), original);
  // A failure after some states changed: the tab collection cannot be read.
  await page.evaluate(() => {
    const broken = () => {
      throw new Error('Invented tab failure');
    };
    window.Xrm.Page.ui.tabs = { get: broken, forEach: broken };
  });
  const failed = await run('form:god-mode');
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /Invented tab failure/);
  assert.deepEqual(
    await states(),
    original,
    'the required level and control states changed before the failure are back',
  );
  assert.match(
    (await run('form:god-mode')).message,
    /Invented tab failure/,
    'the failed run kept nothing to restore, so the next run is not refused',
  );
});

// @test-kind contract: a failed Pin to side pane or Logical names run removes the pane and badges it added; Paqvilo's own action design.
test('a failed Pin to side pane or Logical names run removes the side pane and the badges it added', async (t) => {
  const { page, run } = await fixture(t);
  const owned = () =>
    page.evaluate(() => {
      const state = document.getElementById('paqvilo-model-inspector').__paqModelActionState;
      return {
        panes: state.panes.length,
        labels: state.labels.length,
        badges: document.querySelectorAll('[data-paq-model-logical-name]').length,
        closed: window.nativeFixture.closedPanes,
      };
    });
  // The app opens the pane, then refuses to show the page in it.
  await page.evaluate(() => {
    window.Xrm.App.sidePanes.createPane = async () => ({
      navigate: async () => {
        throw new Error('Invented pane failure');
      },
      close: () => window.nativeFixture.closedPanes++,
    });
  });
  const pinned = await run('navigation:pin-to-side-panel');
  assert.equal(pinned.status, 'error');
  assert.match(pinned.message, /Invented pane failure/);
  assert.deepEqual(await owned(), { panes: 0, labels: 0, badges: 0, closed: 1 }, 'the blank pane is closed');
  assert.equal((await run('navigation:close-side-panes')).message, 'This session has no open side pane.');
  // The second field's label refuses the badge after the first field got one.
  const field = () => page.evaluate(() => document.querySelector('[data-id="x_name"]').outerHTML);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', '<div data-id="x_zero"><label>Zero</label><input></div>');
    document.querySelector('[data-id="x_zero"] label').prepend = () => {
      throw new Error('Invented label failure');
    };
  });
  const before = await field();
  const named = await run('form:show-logical-names');
  assert.equal(named.status, 'error');
  assert.match(named.message, /Invented label failure/);
  assert.deepEqual(await owned(), { panes: 0, labels: 0, badges: 0, closed: 1 }, 'no badge stays on the form');
  assert.equal(await field(), before, 'the first field is restored exactly');
});

// @test-kind contract: a table the environment does not have is named in the failure; Paqvilo's own action message.
test('an unknown table logical name fails with the name to check, not only an HTTP status', async (t) => {
  const { run } = await fixture(t);
  const missing = await run('navigation:open-list', { entity: 'x_missing' });
  assert.equal(missing.status, 'error');
  assert.equal(missing.message, 'This environment has no table named x_missing. Check the logical name.');
});

// @test-kind contract: action availability names what the page lacks before a run can fail; Paqvilo's own action design.
test('availability marks a form without refreshable subgrids and a clone in local simulation; local forms open in this tab', async (t) => {
  const { page, origin, run } = await fixture(t);
  const check = (extra = {}) =>
    page
      .evaluate(modelDrivenActionAvailability, { origin, actions: MODEL_DRIVEN_ACTIONS, ...extra })
      .then((items) => Object.fromEntries(items.map((item) => [item.id, item])));
  const live = await check();
  assert.equal(live['form:refresh-subgrids'].available, true);
  assert.equal(live['form:clone-record'].available, true);
  const local = await check({ localSimulation: true });
  assert.equal(local['form:clone-record'].available, false);
  assert.equal(
    local['form:clone-record'].reason,
    'Mirage cannot open a new form with prefilled values, so it cannot prepare a clone.',
  );
  for (const id of ['navigation:open-record-by-id', 'navigation:new-record'])
    assert.equal(local[id].available, true, id);
  // Mirage opens a form only in this tab; a separate window is refused.
  await page.evaluate(() => {
    window.Xrm.Navigation.openForm = async (options) => {
      if (options.openInNewWindow) throw new Error('Invented refusal: separate windows are not supported.');
      window.nativeFixture.opened.push({ options });
    };
  });
  const opened = await run(
    'navigation:open-record-by-id',
    { entity: 'x_person', id: recordId },
    { localSimulation: true },
  );
  assert.equal(opened.status, 'ok');
  assert.match(opened.message, /opens the x_person record in this tab/);
  assert.equal(await page.evaluate(() => window.nativeFixture.opened.at(-1).options.openInNewWindow), false);
  // The form has no subgrid control a script can refresh (Mirage exposes none).
  await page.evaluate(() => window.Xrm.Page.ui.controls.get().splice(1, 1));
  const none = await check();
  assert.equal(none['form:refresh-subgrids'].available, false);
  assert.match(none['form:refresh-subgrids'].reason, /^No subgrid on this form can be refreshed from a script/);
});

// @test-kind contract: an action that changes the page declares the undo its result offers; Paqvilo's own action design.
test('every action that changes the page declares an undo that puts the page back', async (t) => {
  const { page, run } = await fixture(t);
  // Client state an action can change in place. Refreshes and native reads reload data and change none of it; reload
  // actions leave the page, so no result survives on it to offer an undo.
  const snapshot = () =>
    page.evaluate(() => {
      const f = window.nativeFixture;
      return JSON.stringify({
        required: f.required,
        visible: f.visible,
        disabled: f.disabled,
        tabVisible: f.tabVisible,
        sectionVisible: f.sectionVisible,
        saveHandlers: f.saveHandlers.length,
        openPanes: f.opened.filter((item) => item.pane).length - f.closedPanes,
        badges: document.querySelectorAll('[data-paq-model-logical-name]').length,
        field: document.querySelector('[data-id="x_name"]').outerHTML,
      });
    });
  const inputs = { entity: 'x_person', id: recordId };
  const changing = [];
  for (const action of MODEL_DRIVEN_ACTIONS.filter((item) => !['reload', 'client-reload'].includes(item.effect))) {
    const before = await snapshot(),
      params = Object.fromEntries(
        action.inputs.filter((input) => input.required).map((input) => [input.name, inputs[input.name]]),
      );
    await run(action.id, params);
    if ((await snapshot()) === before) continue;
    changing.push(action.id);
    assert.ok(action.undo, `${action.id} changes the page and declares an undo`);
    // The runner reports the change as in place, so the panel row offers Reset; after the undo it no longer does.
    const inPlace = () =>
      page.evaluate(
        (id) => document.getElementById('paqvilo-model-inspector').__paqModelActionState.active()[id],
        action.id,
      );
    assert.equal(await inPlace(), true, `${action.id} is reported in place`);
    const undo = await run(action.undo.id, { ...action.undo.params });
    assert.equal(undo.status, 'ok', `${action.undo.id} undoes ${action.id}`);
    assert.equal(await snapshot(), before, `${action.undo.id} puts back what ${action.id} changed`);
    assert.equal(await inPlace(), false, `${action.undo.id} leaves nothing of ${action.id} in place`);
  }
  assert.deepEqual(changing, [
    'form:show-logical-names',
    'form:god-mode',
    'form:toggle-autosave',
    'navigation:pin-to-side-panel',
  ]);
});

// @test-kind contract: late server results cancel after record navigation and retired, foreign or unowned sessions cannot execute
test('late server results cancel after record navigation and retired, foreign or unowned sessions cannot execute', async (t) => {
  const { page, origin, waits } = await fixture(t);
  const blocked = {};
  const requested = new Promise((resolve) => {
    blocked.requested = resolve;
  });
  waits.set('record', blocked);
  const pending = page.evaluate(runModelDrivenAction, {
    origin,
    token: 'invented-owned-session',
    action: 'form:all-fields',
    params: {},
    requestId: 'slow',
  });
  await page.waitForFunction(() => window.nativeFixture.idReads > 1);
  await requested;
  await page.evaluate(() => (window.nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
  blocked.release();
  assert.deepEqual(await pending, { accepted: true, requestId: 'slow' });
  const outcome = await page.evaluate(
    () => document.getElementById('paqvilo-model-inspector').__paqModelActions.results.at(-1).result,
  );
  assert.equal(outcome.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_/);
  for (const extra of [{ token: 'foreign' }, { origin: 'https://foreign.invalid' }])
    assert.equal(
      (
        await page.evaluate(runModelDrivenAction, {
          origin,
          token: 'invented-owned-session',
          action: 'form:record-id',
          params: {},
          requestId: 'denied',
          ...extra,
        })
      ).accepted,
      false,
    );
  await page.evaluate(() => (window.__paqviloRetiredModelInspectors = ['invented-owned-session']));
  assert.equal(
    (
      await page.evaluate(runModelDrivenAction, {
        origin,
        token: 'invented-owned-session',
        action: 'form:record-id',
        params: {},
        requestId: 'retired',
      })
    ).accepted,
    false,
  );
});

test('native identity reads use exact privilege names and bounded active-user queries with browser-only choices', async (t) => {
  const { page, run, requests } = await fixture(t);
  await page.evaluate(() => (window.nativeFixture.privileges = { role: { name: 'System Administrator' } }));
  assert.equal((await run('identity:status')).identity.canImpersonate, false);
  await page.evaluate(() => (window.nativeFixture.privileges = { role: { name: 'prvActOnBehalfOfAnotherUser' } }));
  assert.equal(
    (await run('identity:status')).identity.canImpersonate,
    false,
    'a name field is not the native privilegeName contract',
  );
  await page.evaluate(
    () => (window.nativeFixture.privileges = { privilege: { privilegeName: 'prvActOnBehalfOfAnotherUser', depth: 1 } }),
  );
  assert.equal((await run('identity:status')).identity.canImpersonate, true);
  const users = await run('identity:users', { query: "O'Neal" });
  assert.equal(users.users.length, 1);
  assert.equal(users.users[0].objectId, environmentId);
  assert.equal(users.users[0].label, 'Invented active user');
  const read = requests.find((request) => request.path.endsWith('/systemusers'));
  assert.equal(read.query.$top, '100');
  assert.match(read.query.$filter, /isdisabled eq false and azureactivedirectoryobjectid ne null/);
  assert.match(read.query.$filter, /O''Neal/);
  assert.equal(
    requests.some((request) => request.method !== 'GET'),
    false,
  );
});

test('owned target lifetime restores fields and guards after SPA navigation while native panes persist until session cleanup', async (t) => {
  const { page, origin, run } = await fixture(t);
  await run('form:god-mode');
  await run('form:toggle-autosave', { enabled: true });
  await run('form:show-logical-names');
  await run('navigation:pin-to-side-panel');
  await page.evaluate(() => {
    window.nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    history.replaceState({}, '', '?pagetype=entityrecord&etn=x_person&id=' + window.nativeFixture.id);
  });
  await page.waitForFunction(
    () =>
      window.nativeFixture.required === 'required' &&
      window.nativeFixture.saveHandlers.length === 0 &&
      !document.querySelector('[data-paq-model-logical-name]'),
  );
  assert.equal(
    await page.evaluate(() => window.nativeFixture.closedPanes),
    0,
    'pinning retains the earlier record while navigating the main app',
  );
  assert.equal(
    (await run('form:record-id')).copyText,
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'a new action can target the new record after automatic cleanup',
  );
  await page.evaluate(disposeModelDrivenActions, { origin, token: 'invented-owned-session' });
  assert.equal(await page.evaluate(() => window.nativeFixture.closedPanes), 1);
});

// @test-kind contract: explicit stop waiting cancels pending SDK work without discarding owned form adjustments
test('explicit stop waiting cancels pending SDK work without discarding owned form adjustments', async (t) => {
  const { page, run } = await fixture(t);
  await run('form:god-mode');
  await run('form:toggle-autosave', { enabled: true });
  await run('form:show-logical-names');
  await page.evaluate(() => {
    window.nativeFixture.dirty = false;
    window.Xrm.Page.data.refresh = () =>
      new Promise((resolve) => {
        window.releaseNativeRefresh = resolve;
      });
  });
  const pending = run('form:refresh-autosave-off');
  await page.waitForFunction(() => Boolean(window.releaseNativeRefresh));
  await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelActionState.cancelPending());
  assert.equal(await page.evaluate(() => window.nativeFixture.required), 'none');
  assert.equal(await page.evaluate(() => window.nativeFixture.saveHandlers.length), 1);
  assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 1);
  assert.equal((await run('form:record-id')).copyText, recordId);
  await page.evaluate(() => window.releaseNativeRefresh());
  assert.equal((await pending).status, 'cancelled');
});

// @test-kind contract: explicit action lifetime clears displayed values after a same-URL record change without cancelling a fresh dispatch
test('explicit action lifetime clears displayed values after a same-URL record change without cancelling a fresh dispatch', async (t) => {
  const { page, run } = await fixture(t);
  const originalUrl = page.url();
  await run('form:changed-fields');
  await page.evaluate(() => {
    const actions = document.getElementById('paqvilo-model-inspector').__paqModelActions;
    actions.contextChanged = () => {
      actions.results = [];
      window.privateContextChanges = (window.privateContextChanges ?? 0) + 1;
    };
    window.nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  });
  await page.waitForFunction(() => window.privateContextChanges === 1);
  assert.equal(page.url(), originalUrl, 'record identity can change without a route change');
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelActions.results.length),
    0,
  );
  assert.equal((await run('form:record-id')).copyText, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  // Exercise a new dispatch before the interval can see the next target. Its
  // own request must survive the synchronous target-state transition.
  await page.evaluate(() => {
    clearInterval(document.getElementById('paqvilo-model-inspector').__paqModelActionState.timer);
    window.nativeFixture.id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  });
  assert.equal((await run('form:record-id')).copyText, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.equal(await page.evaluate(() => window.privateContextChanges), 1);
});

test('native main-form requests acknowledge dispatch without waiting for quick-create-only success and keep late errors private', async (t) => {
  const { page, run } = await fixture(t);
  await page.evaluate(() => {
    window.nativeFormRejects = [];
    window.nativeFormFollowups = [];
    window.Xrm.Navigation.openForm = () => new Promise((_resolve, reject) => window.nativeFormRejects.push(reject));
    document.getElementById('paqvilo-model-inspector').__paqModelActions.followup = (requestId, result) =>
      window.nativeFormFollowups.push({ requestId, result });
  });
  const record = await run('navigation:open-record-by-id', { entity: 'x_person', id: recordId });
  assert.equal(record.status, 'ok');
  assert.match(record.message, /opens the x_person record in a new window/);
  const clone = await run('form:clone-record');
  assert.equal(clone.status, 'ok');
  assert.match(clone.message, /No record is created until you save/);
  assert.equal(await page.evaluate(() => window.nativeFormRejects.length), 2);
  await page.evaluate(() => window.nativeFormRejects[1](Error('PRIVATE_NATIVE_ERROR')));
  await page.waitForFunction(() => window.nativeFormFollowups.length === 1);
  assert.equal(await page.evaluate(() => window.nativeFormFollowups[0].result.message), 'PRIVATE_NATIVE_ERROR');
  await page.evaluate(() => {
    window.nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    window.nativeFormRejects[0](Error('STALE_NATIVE_ERROR'));
  });
  // The runner reports late native errors from a promise-microtask chain. This later evaluation
  // is a separate task, so the stale rejection has been fully handled before it reads the count.
  assert.equal(await page.evaluate(() => window.nativeFormFollowups.length), 1);
});

test('maker and admin navigation preserve an actual Default-prefixed environment identity without guessing an organization ID', async (t) => {
  const { page, run } = await fixture(t),
    nativeId = 'Default-AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.evaluate((id) => {
    const context = window.Xrm.Utility.getGlobalContext();
    context.organizationSettings.bapEnvironmentId = id;
    window.Xrm.Utility.getGlobalContext = () => context;
  }, nativeId);
  assert.equal((await run('navigation:open-power-platform-admin')).status, 'ok');
  assert.equal((await run('form:open-editor')).status, 'ok');
  const urls = await page.evaluate(() => window.nativeFixture.opened.map((item) => item.url));
  assert.ok(urls.some((url) => url.includes(`/environments/environment/${nativeId}/hub`)));
  assert.ok(urls.some((url) => url.includes(`/e/${nativeId}/s/`)));
  await page.evaluate(() => {
    window.Xrm.Utility.getGlobalContext().organizationSettings.bapEnvironmentId = '../untrusted';
  });
  assert.equal((await run('navigation:open-power-platform-admin')).status, 'unsupported');
  assert.equal(await page.evaluate(() => window.nativeFixture.opened.length), 2);
});

// @test-kind contract: native action reads cancel bounded decoded streams before unbounded text allocation
test('native action reads cancel bounded decoded streams before unbounded text allocation', async (t) => {
  const { page, run } = await fixture(t);
  await page.evaluate(() => {
    const original = window.fetch;
    window.readChunks = 0;
    window.readCancelled = false;
    window.fetch = (url, options) =>
      String(url).includes('/x_people(')
        ? Promise.resolve(
            new Response(
              new ReadableStream(
                {
                  pull(controller) {
                    window.readChunks++;
                    controller.enqueue(new Uint8Array(512 * 1024));
                  },
                  cancel() {
                    window.readCancelled = true;
                  },
                },
                { highWaterMark: 0 },
              ),
              { headers: { 'content-type': 'application/json' } },
            ),
          )
        : original(url, options);
  });
  const result = await run('form:all-fields');
  assert.equal(result.status, 'error');
  assert.match(result.message, /larger than 2 MiB/);
  assert.deepEqual(await page.evaluate(() => [window.readChunks, window.readCancelled]), [5, true]);
});

// @test-kind contract: Paqvilo's own action result design: unreported values are left out and every Reset says what it undid in one pattern.
test('Environment and user leaves out values the app does not report, and every Reset names what it undid', async (t) => {
  const { page, run } = await fixture(t);
  // A local simulator reports no version and no environment unique name.
  await page.evaluate(() => {
    const context = window.Xrm.Utility.getGlobalContext();
    delete context.getVersion;
    delete context.organizationSettings.uniqueName;
    window.Xrm.Utility.getGlobalContext = () => context;
  });
  const environment = await run('admin:environment-context');
  const properties = environment.rows.map((row) => row[0]);
  assert.ok(properties.includes('Client URL'));
  assert.equal(properties.includes('Version'), false);
  assert.equal(properties.includes('Unique name'), false);
  assert.equal(JSON.stringify(environment.rows).includes('not reported'), false);
  await run('form:toggle-autosave', { enabled: true });
  assert.equal((await run('form:toggle-autosave', { enabled: false })).message, 'Reset: autosave works again.');
  await page.evaluate(() =>
    document.body.insertAdjacentHTML('afterbegin', '<div data-id="x_zero"><label>Zero</label><input></div>'),
  );
  const shown = Number((await run('form:show-logical-names')).message.match(/^(\d+) field labels/)[1]);
  assert.ok(shown >= 1);
  assert.equal(
    (await run('form:clear-logical-names')).message,
    `Reset: ${shown} logical-name ${shown === 1 ? 'label' : 'labels'} removed.`,
  );
  assert.equal((await run('navigation:pin-to-side-panel')).status, 'ok');
  assert.equal((await run('navigation:close-side-panes')).message, 'Reset: 1 side pane closed.');
});
