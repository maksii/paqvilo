import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { nativeFormActionApplies } from '../lib/native-form-actions.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const fields = {
  title: { type: 'text', required: true },
  statecode: {
    dataverseType: 'state',
    states: [
      { value: 0, defaultStatus: 10 },
      { value: 1, defaultStatus: 30 },
    ],
  },
  statuscode: {
    dataverseType: 'status',
    statuses: [
      { value: 10, state: 0 },
      { value: 30, state: 1 },
      { value: 31, state: 1 },
    ],
  },
};
async function fixture() {
  const store = await new DataStore({
    state: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid', nameColumn: 'title', fieldMetadata: fields } },
      tables: {
        sample: [
          { sampleid: id, title: 'Original', statecode: 0, statuscode: 10 },
          { sampleid: other, title: 'Other', statecode: 0, statuscode: 10 },
        ],
      },
      permissions: [
        { entity: 'sample', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] },
        { entity: 'sample', scope: 'global', roles: ['Reader'], operations: ['read'] },
      ],
      settings: { permissionMode: 'enforce', 'Webapi/sample/enabled': false },
    },
  }).init();
  const metadata = {
    adx_entitysourcetype: 756150001,
    adx_recordidquerystringparametername: 'row',
    adx_settings: JSON.stringify({
      Actions: [
        {
          Type: 'DeactivateAction',
          ButtonLabel: [{ LCID: 1033, Value: 'Close entry' }],
          SuccessMessage: [{ LCID: 1033, Value: 'Entry closed.' }],
        },
        { Type: 'ActivateAction', ButtonLabel: [{ LCID: 1033, Value: 'Reopen entry' }] },
      ],
    }),
  };
  return {
    store,
    portal: { forms: [{ id: 'entry-form', name: 'Entry', mode: 100000001, metadata }], pages: [] },
    schemas: {
      'entry-form': { entity: 'sample', fields: [{ name: 'title', label: 'Title', type: 'text', required: true }] },
    },
    identity: { id: 'editor', roles: ['Editor'] },
  };
}
const body = (action, overrides = {}) => ({ action, recordId: id, values: {}, query: { row: id }, ...overrides });
const submit = (options, input) => submitPortalForm('entityform', 'entry-form', input, options);

// @test-kind contract: local native actions apply metadata-derived state without writing unrelated fields.
test('native actions derive default status, skip field validation and keep unrelated values untouched', async () => {
  const options = await fixture();
  const closed = await submit(options, body('deactivate'));
  assert.equal(closed.operation, 'deactivate');
  assert.equal(closed.record.statecode, 1);
  assert.equal(closed.record.statuscode, 30);
  assert.equal(closed.record.title, 'Original');
  assert.deepEqual(closed.outcome, { type: 'message', message: 'Entry closed.', hideForm: false });
  const reopened = await submit(options, body('activate'));
  assert.equal(reopened.record.statecode, 0);
  assert.equal(reopened.record.statuscode, 10);
  assert.equal(reopened.record.title, 'Original');
  options.portal.forms[0].mode = 100000002;
  assert.equal(
    (await submit(options, body('deactivate'))).record.statuscode,
    30,
    'an explicit action on a read-only form still uses table update permissions',
  );
});

// @test-kind security: native action requests cannot bypass resolved configuration, record source or permissions.
test('native action requests re-resolve configured actions, record source, metadata and permissions', async () => {
  const options = await fixture();
  for (const [input, code] of [
    [body('submit', { values: { title: 'Forged submit' } }), 'FormSubmitNotEnabled'],
    [body('deactivate', { values: { title: 'Forged action' } }), 'FormActionInvalid'],
    [body('deactivate', { attachments: [{ name: 'injected.txt' }] }), 'FormActionInvalid'],
    [body('deactivate', { actionIndex: 1 }), 'FormActionNotEnabled'],
    [body('deactivate', { recordId: other }), 'FormRecordMismatch'],
    [body('deactivate', { query: {} }), 'FormRecordMismatch'],
  ])
    await assert.rejects(submit(options, input), (error) => error.code === code);
  await assert.rejects(
    submit({ ...options, identity: { id: 'reader', roles: ['Reader'] } }, body('deactivate')),
    (error) => error.status === 403,
  );
  const config = JSON.parse(options.portal.forms[0].metadata.adx_settings);
  config.Actions[0].FilterCriteria = '<filter><condition attribute="title" operator="eq" value="Allowed"/></filter>';
  options.portal.forms[0].metadata.adx_settings = JSON.stringify(config);
  await assert.rejects(submit(options, body('deactivate')), (error) => error.code === 'FormActionFilterUnsupported');
  delete config.Actions[0].FilterCriteria;
  options.portal.forms[0].metadata.adx_settings = JSON.stringify(config);
  options.store.state.mappings.sample.fieldMetadata.statecode.states[1].defaultStatus = 999;
  await assert.rejects(submit(options, body('deactivate')), (error) => error.code === 'FormActionStateUnresolved');
  assert.equal((await options.store.get('sample', id, options.identity)).statecode, 0);
  assert.equal((await options.store.get('sample', other, options.identity)).statecode, 0);
});

// @test-kind contract: local basic form state actions re-evaluate the selected record against the exported FetchXML criterion.
test('basic form state-action filters gate rendering and are rechecked before the update', async () => {
  const options = await fixture();
  const definition = options.portal.forms[0];
  const authored = JSON.parse(definition.metadata.adx_settings);
  const filter =
    '<fetch><entity name="sample"><attribute name="sampleid"/><filter><condition attribute="title" operator="eq" value="Original"/></filter></entity></fetch>';
  authored.Actions[0].FilterCriteria = filter;
  definition.metadata.adx_settings = JSON.stringify(authored);
  const render = (row = id, renderOptions = {}) =>
    renderComponent(
      'entityform',
      'Entry',
      {
        identity: options.identity,
        request: { params: { row } },
      },
      { ...options, ...renderOptions },
    );

  const admitted = await render();
  assert.match(
    admitted,
    /data-url="\/__sim\/forms\/entityform\/entry-form\/submit"[^>]*data-pp-form-action="deactivate" data-pp-action-index="0"/,
  );
  assert.doesNotMatch(await render(other), /deactivate-link/);
  assert.match(await render(other), /activate-link/);
  assert.doesNotMatch(await render(id, { config: { mode: 'live' } }), /deactivate-link/);

  await options.store.update('sample', id, { title: 'No longer eligible' }, options.identity);
  await assert.rejects(
    submit(options, body('deactivate', { actionIndex: 0 })),
    (error) => error.code === 'FormActionNotEnabled' && error.status === 403,
  );
  assert.equal((await options.store.get('sample', id, options.identity)).statecode, 0);
  await options.store.update('sample', id, { title: 'Original' }, options.identity);
  await assert.rejects(
    submit({ ...options, actionFiltersAvailable: false }, body('deactivate', { actionIndex: 0 })),
    (error) => error.code === 'FormActionFilterUnsupported',
  );
  authored.Actions[0].FilterCriteria = filter.replace('name="sample"', 'name="account"');
  definition.metadata.adx_settings = JSON.stringify(authored);
  await assert.rejects(
    submit(options, body('deactivate', { actionIndex: 0 })),
    (error) => error.code === 'FormActionFilterUnsupported',
  );
  assert.equal((await options.store.get('sample', id, options.identity)).statecode, 0);
  authored.Actions[0].FilterCriteria = filter;
  definition.metadata.adx_settings = JSON.stringify(authored);
  const done = await submit(options, body('deactivate', { actionIndex: 0 }));
  assert.equal(done.record.statuscode, 30);
  assert.equal(done.record.title, 'Original');
});

// @test-kind contract: a filtered state action binds the record before applying a distinct authored projection.
test('distinct form-action projections can omit the primary key and still filter the selected record', async () => {
  const options = await fixture();
  const definition = options.portal.forms[0];
  const authored = JSON.parse(definition.metadata.adx_settings);
  const filter =
    '<fetch distinct="true"><entity name="sample"><attribute name="title"/><filter><condition attribute="title" operator="eq" value="Original"/></filter></entity></fetch>';
  authored.Actions[0].FilterCriteria = filter;
  definition.metadata.adx_settings = JSON.stringify(authored);
  const render = (row) =>
    renderComponent('entityform', 'Entry', { identity: options.identity, request: { params: { row } } }, options);
  assert.equal((await render(id)).includes('data-pp-form-action="deactivate"'), true);
  assert.equal((await render(other)).includes('data-pp-form-action="deactivate"'), false);
  await assert.rejects(
    submit(options, body('deactivate', { recordId: other, query: { row: other } })),
    (error) => error.code === 'FormActionNotEnabled',
  );
  const saved = await submit(options, body('deactivate'));
  assert.equal(saved.recordId, id);
  assert.equal(saved.record.statecode, 1);
  assert.equal((await options.store.get('sample', other, options.identity)).statecode, 0);
});

// @test-kind contract: this same-table action subset refuses group and aggregate projections and other operation kinds.
test('native state filters fail closed before evaluating unqualified query or action types', async () => {
  const fetchXml = () => assert.fail('unsupported filters must not call the provider');
  const scope = { entity: 'sample', idColumn: 'sampleid', recordId: id, readProvider: { fetchXml } };
  for (const action of [
    {
      Type: 'DeactivateAction',
      FilterCriteria:
        '<fetch aggregate="true"><entity name="sample"><attribute name="title" alias="count" aggregate="count"/></entity></fetch>',
    },
    { Type: 'DeleteAction', FilterCriteria: '<fetch><entity name="sample" /></fetch>' },
  ])
    await assert.rejects(
      nativeFormActionApplies(action, scope),
      (error) => error.code === 'FormActionFilterUnsupported',
    );
});

// @test-kind security: a current-user action cannot replace its target with a different contact.
test('native current-user actions cannot select another contact even with broad table grants', async () => {
  const options = await fixture();
  options.portal.forms[0].metadata.adx_entitysourcetype = 756150002;
  options.identity.contactId = id;
  await assert.rejects(
    submit(options, body('deactivate', { recordId: other, query: { row: other } })),
    (error) => error.code === 'FormRecordMismatch',
  );
  assert.equal((await submit(options, body('deactivate'))).recordId, id);
});

// @test-kind contract: invalid native action configuration gives explicit local render and write errors.
test('malformed exported native action settings fail explicitly before rendering or writing', async () => {
  const options = await fixture();
  for (const settings of [null, [], { Actions: null }, { Actions: {} }, { Actions: [null] }, { Actions: [{}] }]) {
    options.portal.forms[0].metadata.adx_settings = JSON.stringify(settings);
    await assert.rejects(
      submit(options, body('deactivate')),
      (error) => error.code === 'FormActionConfigurationInvalid',
    );
    await assert.rejects(
      renderComponent('entityform', 'Entry', { identity: options.identity, request: { params: { row: id } } }, options),
      (error) => error.code === 'FormActionConfigurationInvalid',
    );
  }
  assert.equal((await options.store.get('sample', id, options.identity)).statecode, 0);
});

// @test-kind compatibility: the rendered state action buttons retain the platform client markup.
test('native rendering keeps state action-only forms and does not invent unresolved action controls', async () => {
  const options = await fixture(),
    diagnostics = [];
  const render = () =>
    renderComponent(
      'entityform',
      'Entry',
      { identity: options.identity, request: { url: `http://localhost/form/?row=${id}`, params: { row: id } } },
      { ...options, diagnostic: (item) => diagnostics.push(item) },
    );
  // The platform's action bar (entityform.js): both state buttons render as button.*-link with
  // the inapplicable one hidden by the app bundle (lib/platform-app-compat.js); no postback inputs
  // and no invented submit button.
  const active = await render();
  assert.match(
    active,
    /<button class="deactivate-link btn btn-default btn" data-url="\/_services\/action-deactivate\/[^"]*"[^>]*>Close entry<\/button>/,
  );
  assert.match(
    active,
    /<button class="activate-link btn btn-default btn" data-url="\/_services\/action-activate\/[^"]*" href="[^"]*" type="button">Reopen entry<\/button>/,
  );
  assert.doesNotMatch(active, /id="(?:ActivateButton|DeactivateButton|UpdateButton)"/);
  await submit(options, body('deactivate'));
  const inactive = await render();
  assert.match(
    inactive,
    /<button class="activate-link btn btn-default btn" data-url="\/_services\/action-activate\/[^"]*"[^>]*>Reopen entry<\/button>/,
  );
  assert.match(
    inactive,
    /<button class="deactivate-link btn btn-default btn" data-url="\/_services\/action-deactivate\/[^"]*" href="[^"]*" type="button">Close entry<\/button>/,
  );
  assert.doesNotMatch(inactive, /id="(?:ActivateButton|DeactivateButton|UpdateButton)"/);
  assert.deepEqual(
    diagnostics.filter((item) => item.code === 'FORM_ACTION_UNSUPPORTED'),
    [],
  );
});
