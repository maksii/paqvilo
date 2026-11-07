import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { advancedFormGraph } from '../lib/advanced-form-graph.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { approximateAdvancedFormSchema } from '../lib/form-schema-fallback.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { DataStore } from '../lib/data.mjs';
import { createWebFormSessions, submitPortalForm } from '../lib/form-service.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const form = {
  id: 'wizard',
  name: 'Wizard',
  metadata: { mspp_startstep: '{CREATE}', mspp_progressindicatorenabled: true },
};
const step = (id, metadata = {}) => ({
  kind: 'advancedformstep',
  id,
  name: id,
  mspp_webform: 'wizard',
  mspp_type: 100000001,
  mspp_targetentitylogicalname: 'sample',
  mspp_formname: 'Entry',
  ...metadata,
});
const rows = () => [
  step('create', {
    mspp_webform: 'other-owner',
    mspp_nextstep: 'condition',
    customJavascript: 'window.startupSeen = true;',
    childSettings: [{ language: 1033, text: 'Source detail' }],
    mspp_title: [{ LCID: 1033, Value: 'Details' }],
  }),
  step('condition', {
    mspp_type: 100000000,
    mspp_condition: 'title = Confirm',
    mspp_nextstep: 'yes',
    mspp_conditiondefaultnextstep: 'no',
  }),
  step('yes', {
    mspp_type: 100000003,
    mspp_redirecturl: '/confirmed/',
    mspp_redirecturlappendentityidquerystring: false,
  }),
  step('no', {
    mspp_type: 100000003,
    mspp_redirecturl: '/declined/',
    mspp_redirecturlappendentityidquerystring: false,
  }),
  step('unreachable', { mspp_type: 100000003, mspp_redirecturl: '/unused/' }),
];

async function metadataFixture(t, records = rows()) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'advanced-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Entities/sample');
  await fs.mkdir(path.join(folder, 'FormXml/main'), { recursive: true });
  await fs.writeFile(
    path.join(folder, 'Entity.xml'),
    '<Entity><Name>sample</Name><EntityInfo><entity><attributes><attribute PhysicalName="title"><LogicalName>title</LogicalName><Type>nvarchar</Type><MaxLength>120</MaxLength></attribute></attributes></entity></EntityInfo></Entity>',
  );
  await fs.writeFile(
    path.join(folder, 'FormXml/main/entry.xml'),
    '<forms type="main"><systemform><formid>entry</formid><type>2</type><form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control id="title" datafieldname="title"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Entry" languagecode="1033"/></LocalizedNames></systemform></forms>',
  );
  const portal = {
    forms: [],
    lists: [],
    pages: [],
    advancedForms: [structuredClone(form)],
    records,
    website: {},
    settings: {},
  };
  const before = JSON.stringify(portal);
  const metadata = await importSolutionMetadata(root, { portal });
  assert.equal(JSON.stringify(portal), before, 'source child settings, languages and relationships are not modified');
  return { portal, metadata };
}

test('graph preserves all owned children, explicit cross-owner references and missing active dependencies', () => {
  const records = rows();
  records.push(step('inactive', { mspp_statecode: 1 }));
  records[1].mspp_conditiondefaultnextstep = 'inactive';
  const before = JSON.stringify(records);
  const graph = advancedFormGraph(form, records);
  assert.equal(graph.initialStepId, 'create');
  assert.deepEqual(
    new Set(graph.steps.map((row) => row.id)),
    new Set(['create', 'condition', 'yes', 'no', 'unreachable']),
  );
  assert.ok(
    graph.diagnostics.some((row) => row.code === 'ADVANCEDFORM_SHARED_STEP_REFERENCE' && row.step === 'create'),
  );
  assert.ok(
    graph.diagnostics.some(
      (row) =>
        row.code === 'ADVANCEDFORM_STEP_REFERENCE_UNRESOLVED' &&
        row.referenceField === 'conditiondefaultnextstep' &&
        row.targetStepId === 'inactive',
    ),
  );
  assert.equal(JSON.stringify(records), before);
});

test('source import maps referenced Main layout, condition and both redirect branches without dropping settings', async (t) => {
  const { portal, metadata } = await metadataFixture(t);
  const schema = metadata.componentSchemas.wizard;
  assert.equal(schema.initialStepId, 'create');
  assert.equal(schema.stepId, 'create');
  assert.deepEqual(schema.steps.map((row) => [row.stepId, row.type ?? 'load']).sort(), [
    ['condition', 'condition'],
    ['create', 'load'],
    ['no', 'redirect'],
    ['unreachable', 'redirect'],
    ['yes', 'redirect'],
  ]);
  assert.deepEqual(
    schema.steps.find((row) => row.stepId === 'create').metadata.childSettings,
    portal.records[0].childSettings,
  );
  assert.deepEqual(
    schema.steps.find((row) => row.stepId === 'create').metadata.mspp_title,
    portal.records[0].mspp_title,
  );
  assert.equal(schema.steps.find((row) => row.stepId === 'yes').metadata.mspp_redirecturl, '/confirmed/');
  assert.equal(schema.steps.find((row) => row.stepId === 'condition').conditionDefaultNextStepId, 'no');
  assert.equal(metadata.componentSchemas.condition.type, 'condition');
});

for (const [title, target] of [
  ['Confirm', '/confirmed/'],
  ['Other', '/declined/'],
])
  test(`imported condition evaluates the saved ordinary value ${title} and redirects`, async (t) => {
    const { portal, metadata } = await metadataFixture(t);
    const store = await new DataStore({
      state: {
        mappings: {
          sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' } } },
        },
        tables: { sample: [] },
        settings: { permissionMode: 'permissive' },
      },
    }).init();
    const sessions = createWebFormSessions();
    const result = await submitPortalForm(
      'webform',
      'wizard',
      { values: { title } },
      {
        portal,
        metadata,
        schemas: metadata.componentSchemas,
        store,
        sessions,
        owner: 'visitor',
        requestUrl: 'http://localhost/form/',
      },
    );
    assert.equal(result.outcome.type, 'redirect');
    assert.equal(result.outcome.url, target);
    assert.equal(store.snapshot().tables.sample.length, 1);
    assert.equal(store.snapshot().tables.sample[0].title, title);
    assert.equal(sessions.list('wizard', 'visitor')[0].completed, true);
  });

test('missing declared start never adopts another mapped redirect or approximated load step', async (t) => {
  const records = rows().filter((row) => row.id !== 'create');
  const { portal, metadata } = await metadataFixture(t, records);
  assert.equal(metadata.componentSchemas.wizard, undefined);
  assert.ok(
    metadata.diagnostics.some((row) => row.code === 'ADVANCEDFORM_UNRESOLVED' && row.initialStepId === 'create'),
  );
  assert.equal(approximateAdvancedFormSchema({ definition: portal.advancedForms[0], portal, metadata }), null);
  await assert.rejects(
    renderComponent(
      'webform',
      'Wizard',
      { request: { url: 'http://localhost/form/', params: {} } },
      {
        portal: { ...portal, records: [] },
        store: {},
        schemas: {
          wizard: { initialStepId: 'create', steps: [{ stepId: 'unrelated', entity: 'sample', fields: [] }] },
        },
      },
    ),
    (error) => error.code === 'ADVANCEDFORM_STEP_UNRESOLVED',
  );
});

test('a declared redirect start is usable without an unrelated load layout', async () => {
  const definition = { id: 'wizard', name: 'Wizard', metadata: { adx_startstep: 'finish' } };
  const portal = {
    advancedForms: [definition],
    pages: [],
    records: [step('finish', { mspp_type: 100000003, mspp_redirecturl: '/complete/' })],
  };
  assert.equal(
    await renderComponent(
      'webform',
      'Wizard',
      { request: { url: 'http://localhost/form/', params: {} } },
      { portal, schemas: {}, store: {} },
    ),
    '<script>location.replace("/complete/");</script>',
  );
});

test('the documented unsupported Condition start is explicit rather than a guessed load form', async () => {
  const definition = { id: 'wizard', name: 'Wizard', metadata: { adx_startstep: 'check' } };
  const portal = {
    advancedForms: [definition],
    pages: [],
    records: [step('check', { mspp_type: 100000000, mspp_condition: 'title = Confirm' })],
  };
  await assert.rejects(
    renderComponent(
      'webform',
      'Wizard',
      { request: { url: 'http://localhost/form/', params: {} } },
      { portal, schemas: {}, store: {} },
    ),
    (error) => error.code === 'ADVANCEDFORM_INITIAL_CONDITION',
  );
});

test('retired or unknown step types cannot be approximated as editable load controls', () => {
  const portal = { pages: [], records: [step('create', { mspp_type: 100000004 })] };
  const diagnostics = [];
  assert.equal(
    approximateAdvancedFormSchema({
      definition: form,
      portal,
      metadata: {},
      diagnostic: (row) => diagnostics.push(row),
    }),
    null,
  );
  assert.ok(diagnostics.some((row) => row.code === 'ADVANCEDFORM_STEP_UNSUPPORTED' && row.stepType === 100000004));
});

for (const failure of ['missing-direct', 'missing-branch', 'condition-cycle'])
  test(`incomplete graph ${failure} does not become a successful local submission`, async (t) => {
    const records = rows();
    if (failure === 'missing-direct') records[0].mspp_nextstep = 'missing';
    if (failure === 'missing-branch') records[1].mspp_nextstep = 'missing';
    if (failure === 'condition-cycle') records[1].mspp_nextstep = 'condition';
    const { portal, metadata } = await metadataFixture(t, records);
    const store = await new DataStore({
      state: {
        mappings: {
          sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { title: { dataverseType: 'nvarchar' } } },
        },
        tables: { sample: [] },
        settings: { permissionMode: 'permissive' },
      },
    }).init();
    const sessions = createWebFormSessions();
    const prior = sessions.create('wizard', 'visitor');
    prior.current = 'create';
    const before = structuredClone(prior);
    const counter = { create: 0 };
    const provider = {
      transaction: (callback) =>
        store.transact(() =>
          callback({
            create: async (...args) => {
              counter.create++;
              return store.createRecord(...args);
            },
          }),
        ),
    };
    await assert.rejects(
      submitPortalForm(
        'webform',
        'wizard',
        { values: { title: 'Confirm' } },
        {
          portal,
          metadata,
          schemas: metadata.componentSchemas,
          store,
          writeProvider: provider,
          sessions,
          owner: 'visitor',
          requestUrl: 'http://localhost/form/',
        },
      ),
      (error) => error.code === (failure === 'condition-cycle' ? 'FormConditionCycle' : 'FormStepUnresolved'),
    );
    assert.equal(
      counter.create,
      failure === 'missing-direct' ? 0 : 1,
      'direct absent pointer is rejected before writes; selected branch uses the saved row within the write unit',
    );
    assert.equal(store.snapshot().tables.sample.length, 0, 'local provider transaction rolls back the failed branch');
    assert.deepEqual(prior, before, 'failed navigation does not mark completion or change history');
  });
