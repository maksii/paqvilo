// @test-kind unproven: local model of the Basic Form table-specific record actions (Learn power-pages/configure/basic-forms lists them; state, status reason, close activity and refusal texts follow the open-source legacy portal's EntityActionController and CoreDataAdapter); no hosted capture of these actions
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { renderComponent } from '../lib/platform.mjs';

const CASE = '00000000-0000-4000-8000-0000000000c1';
const DEAL = '00000000-0000-4000-8000-0000000000d1';
const state = (values) => ({
  dataverseType: 'state',
  states: values.map(([value, defaultStatus]) => ({ value, defaultStatus })),
});
const status = (values) => ({
  dataverseType: 'status',
  statuses: values.map(([value, owner]) => ({ value, state: owner })),
});
// The documented standard state and status values of the two tables (Learn incident and opportunity references).
const incidentFields = {
  title: { type: 'text' },
  statecode: state([
    [0, 1],
    [1, 5],
    [2, 6],
  ]),
  statuscode: status([
    [1, 0],
    [2, 0],
    [5, 1],
    [1000, 1],
    [6, 2],
  ]),
};
const opportunityFields = {
  name: { type: 'text' },
  statecode: state([
    [0, 1],
    [1, 3],
    [2, 4],
  ]),
  statuscode: status([
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 2],
    [5, 2],
  ]),
};
const label = (value) => [{ LCID: 1033, Value: value }];
// Task states (Learn task reference): Open 0 (Not Started 2), Completed 1 (5), Canceled 2 (6).
const taskFields = {
  subject: { type: 'text' },
  statecode: state([
    [0, 2],
    [1, 5],
    [2, 6],
  ]),
  statuscode: status([
    [2, 0],
    [3, 0],
    [5, 1],
    [6, 2],
  ]),
};
const TASK = {
  open: '00000000-0000-4000-8000-0000000000e1',
  done: '00000000-0000-4000-8000-0000000000e2',
  elsewhere: '00000000-0000-4000-8000-0000000000e3',
};
const task = (activityid, regarding, statecode, statuscode) => ({
  activityid,
  subject: 'Invented task',
  regardingobjectid: { id: regarding, logical_name: regarding === CASE ? 'incident' : 'opportunity' },
  statecode,
  statuscode,
});

async function fixture({ caseActions = [], dealActions = [], operations = ['read', 'update'] } = {}) {
  const store = await new DataStore({
    state: {
      mappings: {
        incident: {
          entitySet: 'incidents',
          idColumn: 'incidentid',
          nameColumn: 'title',
          fieldMetadata: incidentFields,
        },
        opportunity: {
          entitySet: 'opportunities',
          idColumn: 'opportunityid',
          nameColumn: 'name',
          fieldMetadata: opportunityFields,
        },
        incidentresolution: { entitySet: 'incidentresolutions', idColumn: 'activityid', nameColumn: 'subject' },
        task: { entitySet: 'tasks', idColumn: 'activityid', nameColumn: 'subject', fieldMetadata: taskFields },
        opportunityclose: { entitySet: 'opportunitycloses', idColumn: 'activityid', nameColumn: 'subject' },
      },
      tables: {
        incident: [{ incidentid: CASE, title: 'Invented case', statecode: 0, statuscode: 1 }],
        opportunity: [{ opportunityid: DEAL, name: 'Invented deal', statecode: 0, statuscode: 1 }],
        incidentresolution: [],
        task: [task(TASK.open, CASE, 0, 2), task(TASK.done, CASE, 1, 5), task(TASK.elsewhere, DEAL, 0, 2)],
        opportunityclose: [],
      },
      permissions: [
        { entity: 'incident', scope: 'global', roles: ['Editor'], operations },
        { entity: 'opportunity', scope: 'global', roles: ['Editor'], operations },
        { entity: 'incident', scope: 'global', roles: ['Reader'], operations: ['read'] },
      ],
      settings: { permissionMode: 'enforce' },
    },
  }).init();
  const form = (id, name, actions) => ({
    id,
    name,
    mode: 100000001,
    metadata: {
      adx_entitysourcetype: 756150001,
      adx_recordidquerystringparametername: 'row',
      adx_settings: JSON.stringify({ Actions: actions }),
    },
  });
  return {
    store,
    portal: { forms: [form('case-form', 'Case', caseActions), form('deal-form', 'Deal', dealActions)], pages: [] },
    schemas: {
      'case-form': { entity: 'incident', fields: [{ name: 'title', label: 'Title', type: 'text' }] },
      'deal-form': { entity: 'opportunity', fields: [{ name: 'name', label: 'Name', type: 'text' }] },
    },
    identity: { id: 'editor', roles: ['Editor'] },
    now: () => new Date(2026, 10, 26, 9, 5, 7),
  };
}
const submit = (options, form, recordId, action, extra = {}) =>
  submitPortalForm(
    'entityform',
    form,
    { action, recordId, values: {}, query: { row: recordId }, actionIndex: 0, ...extra },
    options,
  );
const row = (options, table, id) => options.store.tableRows(table).find((item) => item[`${table}id`] === id);
const render = (options, name, id) =>
  renderComponent('entityform', name, { identity: options.identity, request: { params: { row: id } } }, options);

test('case actions resolve, cancel and reopen with the documented state and a resolution activity', async () => {
  const options = await fixture({
    caseActions: [{ Type: 'ResolveCaseAction', SubjectLabel: label('Outcome') }],
  });
  const html = await render(options, 'Case', CASE);
  assert.match(
    html,
    /<button class="resolve-case-link btn btn-default btn" data-url="\/__sim\/forms\/entityform\/case-form\/submit"[^>]*data-pp-form-action="resolve-case" data-pp-action-index="0">Resolve Case<\/button>/,
  );
  assert.match(html, /class="modal fade modal-resolvecase"[^>]*data-pp-action-index="0"/);
  assert.match(html, /<label class="required" for="pp-resolve-0-subject">Outcome<\/label>/);
  // Both resolution texts are required, before any write.
  for (const [resolution, message] of [
    [{}, 'The Resolution and Description of Resolution fields are required.'],
    [{ subject: 'Fixed' }, 'The Description of Resolution field is required.'],
    [{ description: 'Replaced the part' }, 'The Resolution field is required.'],
  ])
    await assert.rejects(
      submit(options, 'case-form', CASE, 'resolve-case', { resolution }),
      (error) => error.status === 403 && error.message === message,
    );
  assert.equal(options.store.tableRows('incidentresolution').length, 0);
  const resolved = await submit(options, 'case-form', CASE, 'resolve-case', {
    resolution: { subject: 'Fixed', description: 'Replaced the part' },
  });
  assert.equal(resolved.outcome.message, 'The case has been resolved.');
  assert.deepEqual([row(options, 'incident', CASE).statecode, row(options, 'incident', CASE).statuscode], [1, 5]);
  const [resolution] = options.store.tableRows('incidentresolution');
  assert.equal(resolution.subject, 'Fixed');
  assert.equal(resolution.description, 'Replaced the part');
  assert.equal(String(resolution.incidentid?.id ?? resolution.incidentid).toLowerCase(), CASE);

  for (const [type, key, expected] of [
    ['ReopenCaseAction', 'reopen-case', [0, 1]],
    ['CloseIncidentAction', 'close-case', [1, 5]],
    ['ReopenCaseAction', 'reopen-case', [0, 1]],
    ['CancelCaseAction', 'cancel-case', [2, 6]],
  ]) {
    const config = JSON.parse(options.portal.forms[0].metadata.adx_settings);
    config.Actions = [{ Type: type }];
    options.portal.forms[0].metadata.adx_settings = JSON.stringify(config);
    await submit(options, 'case-form', CASE, key);
    const current = row(options, 'incident', CASE);
    assert.deepEqual([current.statecode, current.statuscode], expected, key);
  }
  // Close Case writes the default resolution texts.
  const closing = options.store.tableRows('incidentresolution').at(-1);
  assert.deepEqual([closing.subject, closing.description], ['Case Closed', 'Case Closed via Web Portal']);
});

test('opportunity actions win, lose and hold with a close activity in the same write', async () => {
  const options = await fixture({ dealActions: [{ Type: 'WinOpportunityAction' }] });
  assert.match(
    await render(options, 'Deal', DEAL),
    /data-pp-form-action="win-opportunity"[^>]*>Close as Won<\/button>/,
  );
  const won = await submit(options, 'deal-form', DEAL, 'win-opportunity');
  assert.equal(won.outcome.message, 'The opportunity has been closed as won.');
  assert.deepEqual([row(options, 'opportunity', DEAL).statecode, row(options, 'opportunity', DEAL).statuscode], [1, 3]);
  assert.equal(
    options.store.tableRows('opportunityclose')[0].subject,
    'Opportunity won via Web Portal11/26/2026 09:05:07',
  );
  for (const [type, key, expected] of [
    ['LoseOpportunityAction', 'lose-opportunity', [2, 4]],
    ['SetOpportunityOnHoldAction', 'hold-opportunity', [0, 2]],
  ]) {
    options.portal.forms[1].metadata.adx_settings = JSON.stringify({ Actions: [{ Type: type }] });
    // Each action starts from an open opportunity.
    Object.assign(row(options, 'opportunity', DEAL), { statecode: 0, statuscode: 1 });
    await submit(options, 'deal-form', DEAL, key);
    const current = row(options, 'opportunity', DEAL);
    assert.deepEqual([current.statecode, current.statuscode], expected, key);
  }
  assert.equal(options.store.tableRows('opportunityclose').length, 2);
});

// @test-kind security: a table-specific action runs only as the exported action, on its own table, for a visitor with update rights, and a refused action writes nothing
test('table actions re-resolve the exported action, its table and the update privilege', async () => {
  const options = await fixture({
    caseActions: [{ Type: 'CancelCaseAction' }],
    dealActions: [{ Type: 'CloseIncidentAction' }],
  });
  // The action is not offered on another table and its request is refused.
  const html = await render(options, 'Deal', DEAL);
  assert.doesNotMatch(html, /close-case-link/);
  await assert.rejects(
    submit(options, 'deal-form', DEAL, 'close-case'),
    (error) => error.code === 'FormActionNotEnabled' && error.status === 403,
  );
  // An action the form does not export, and a reader without update rights, are refused.
  await assert.rejects(
    submit(options, 'case-form', CASE, 'reopen-case'),
    (error) => error.code === 'FormActionNotEnabled',
  );
  await assert.rejects(
    submit({ ...options, identity: { id: 'reader', roles: ['Reader'] } }, 'case-form', CASE, 'cancel-case'),
    (error) => error.status === 403,
  );
  assert.doesNotMatch(
    await renderComponent(
      'entityform',
      'Case',
      { identity: { id: 'reader', roles: ['Reader'] }, request: { params: { row: CASE } } },
      options,
    ),
    /cancel-case-link/,
  );
  assert.deepEqual([row(options, 'incident', CASE).statecode, row(options, 'opportunity', DEAL).statecode], [0, 0]);
  assert.equal(options.store.tableRows('incidentresolution').length, 0);
});

test('the Resolve Case button asks for the resolution in its dialog and posts it with the bound action', async () => {
  const options = await fixture({ caseActions: [{ Type: 'ResolveCaseAction' }] });
  const html = await render(options, 'Case', CASE);
  const button = /<button[^>]*data-pp-form-action="resolve-case"[^>]*>/.exec(html)[0];
  const script = await readFile(new URL('../lib/entity-grid-compat.js', import.meta.url), 'utf8');
  const begin = script.indexOf('  function confirmFormWorkflow(');
  const end = script.indexOf("  document.addEventListener('click'", begin);
  const posts = [];
  let shown = false;
  const formActionClick = new Function(
    'location',
    'post',
    'showModal',
    'hideModal',
    'notify',
    script.slice(begin, end) + '\nreturn formActionClick;',
  )(
    { search: `?row=${CASE}`, pathname: '/case', reload() {} },
    async (url, body) => {
      posts.push([url, body]);
      return submit(options, 'case-form', body.recordId, body.action, body);
    },
    () => (shown = true),
    () => (shown = false),
    (_row, message) => assert.fail(message),
  );
  const primary = { disabled: false };
  const inputs = { '.resolution-input': { value: 'Fixed' }, '.resolution-description-input': { value: 'Replaced' } };
  const modal = { querySelector: (selector) => (selector.includes('primary') ? primary : inputs[selector]) };
  const control = {
    querySelector: (selector) => ({ value: selector.includes('EntityName') ? 'incident' : CASE }),
  };
  const actionRow = {
    closest: () => control,
    querySelector: (selector) => (selector === '.modal-resolvecase[data-pp-action-index="0"]' ? modal : null),
  };
  const attr = (name) => button.match(new RegExp(`data-${name}="([^"]+)"`))?.[1];
  const rendered = {
    closest: () => actionRow,
    classList: { contains: () => false },
    getAttribute: () => attr('url'),
    dataset: { url: attr('url'), ppFormAction: attr('pp-form-action'), ppActionIndex: attr('pp-action-index') },
  };
  formActionClick({ target: { closest: () => rendered }, preventDefault() {} });
  assert.equal(shown, true);
  assert.equal(posts.length, 0, 'nothing is posted before the dialog is confirmed');
  await primary.onclick();
  assert.equal(shown, false);
  assert.deepEqual(posts[0][0], '/__sim/forms/entityform/case-form/submit');
  assert.deepEqual(posts[0][1].resolution, { subject: 'Fixed', description: 'Replaced' });
  const current = row(options, 'incident', CASE);
  assert.deepEqual([current.statecode, current.statuscode], [1, 5]);
});

test("Cancel Case cancels the case's open activities with their Canceled default status in the same write", async () => {
  const options = await fixture({ caseActions: [{ Type: 'CancelCaseAction' }] });
  await submit(options, 'case-form', CASE, 'cancel-case');
  const taskState = (id) => {
    const current = options.store.tableRows('task').find((item) => item.activityid === id);
    return [current.statecode, current.statuscode];
  };
  assert.deepEqual([row(options, 'incident', CASE).statecode, row(options, 'incident', CASE).statuscode], [2, 6]);
  assert.deepEqual(taskState(TASK.open), [2, 6]);
  assert.deepEqual(taskState(TASK.done), [1, 5], 'a completed activity is left as it is');
  assert.deepEqual(taskState(TASK.elsewhere), [0, 2], 'an activity of another record is left as it is');
});

// @test-kind security: a table action refuses a record in a state its message does not accept, before the close activity or any other write
test('form table actions refuse a record in the wrong state and write nothing', async () => {
  const options = await fixture({
    caseActions: [{ Type: 'ResolveCaseAction' }],
    dealActions: [{ Type: 'WinOpportunityAction' }],
  });
  const setActions = (index, type) =>
    (options.portal.forms[index].metadata.adx_settings = JSON.stringify({ Actions: [{ Type: type }] }));
  const refused = (form, key, extra) =>
    assert.rejects(
      submit(options, form, form === 'case-form' ? CASE : DEAL, key, extra),
      (error) =>
        error.status === 400 && error.code === 'InvalidStateTransition' && error.details?.innerCode === '0x8004F00E',
      key,
    );
  const resolution = { resolution: { subject: 'Fixed', description: 'Replaced the part' } };
  // Reopen needs a closed case.
  setActions(0, 'ReopenCaseAction');
  await refused('case-form', 'reopen-case');
  setActions(0, 'ResolveCaseAction');
  await submit(options, 'case-form', CASE, 'resolve-case', resolution);
  // A resolved case is not resolved, closed or canceled again.
  await refused('case-form', 'resolve-case', resolution);
  for (const [type, key] of [
    ['CloseIncidentAction', 'close-case'],
    ['CancelCaseAction', 'cancel-case'],
  ]) {
    setActions(0, type);
    await refused('case-form', key);
  }
  assert.equal(options.store.tableRows('incidentresolution').length, 1);
  assert.deepEqual([row(options, 'incident', CASE).statecode, row(options, 'incident', CASE).statuscode], [1, 5]);
  assert.deepEqual(
    options.store.tableRows('task').map((task) => task.statecode),
    [0, 1, 0],
    'no activity is canceled',
  );
  // A won opportunity is not won, lost or put on hold; an opportunity on hold is not put on hold again.
  await submit(options, 'deal-form', DEAL, 'win-opportunity');
  for (const [type, key] of [
    ['WinOpportunityAction', 'win-opportunity'],
    ['LoseOpportunityAction', 'lose-opportunity'],
    ['SetOpportunityOnHoldAction', 'hold-opportunity'],
  ]) {
    setActions(1, type);
    await refused('deal-form', key);
  }
  assert.equal(options.store.tableRows('opportunityclose').length, 1);
  Object.assign(row(options, 'opportunity', DEAL), { statecode: 0, statuscode: 2 });
  await refused('deal-form', 'hold-opportunity');
  assert.deepEqual([row(options, 'opportunity', DEAL).statecode, row(options, 'opportunity', DEAL).statuscode], [0, 2]);
});
