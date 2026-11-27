// @test-kind compatibility: Basic form and multistep form metadata (https://learn.microsoft.com/power-pages/configure/configure-basic-form-metadata, https://learn.microsoft.com/power-pages/configure/configure-multistep-form-metadata) and the mspp_entityformmetadata column and choice values (https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/mspp_entityformmetadata); invented schema
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DataStore } from '../lib/data.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { submitPortalForm, createWebFormSessions } from '../lib/form-service.mjs';
import { boundedMarkup } from './support/bounded-markup.mjs';

// Every writable column of mspp_entityformmetadata (the multistep metadata table has the same Attribute, Section and Tab
// columns) and where Mirage proves it: `render` and `submit` are asserted below, `diagnostic` names a hosted-only
// behaviour, `elsewhere` names the suite that owns the behaviour and `record` columns are bookkeeping with no form effect.
const MATRIX = {
  // Record bookkeeping: identity, audit, state and language provisioning of the metadata row itself.
  name: { record: 'display name of the metadata row' },
  createdby: { record: 'audit' },
  createdon: { record: 'audit' },
  modifiedby: { record: 'audit' },
  modifiedon: { record: 'audit' },
  entityformmetadataid: { record: 'row identity' },
  provisionedlanguages: { record: 'language provisioning of the metadata row' },
  statecode: { record: 'row state' },
  statuscode: { record: 'row status' },
  // Selection: which form, which kind of metadata, which column.
  entityform: { render: 'metadata rows of the rendered form apply' },
  type: { render: 'Attribute, Section and Tab rows apply to their own kind' },
  attributelogicalname: { render: 'attribute rows apply to their column' },
  label: { render: 'attribute, section and tab labels' },
  // Control style.
  controlstyle: { render: 'radio lists and survey styles', diagnostic: 'FORM_GEOLOCATION_VALIDATOR_HOSTED' },
  groupname: { submit: 'survey groups validate together' },
  minmultiplechoiceselectedcount: { submit: 'multiple choice count' },
  maxmultiplechoiceselectedcount: { submit: 'multiple choice count' },
  constantsumminimumtotal: { submit: 'constant sum total' },
  constantsummaximumtotal: { submit: 'constant sum total' },
  randomizeoptionsetvalues: { render: 'option order is shuffled' },
  cssclass: { render: 'control and description class' },
  // Prepopulate.
  ignoredefaultvalue: { elsewhere: ['picklist-null-default.test.mjs', 'ignoredefaultvalue'] },
  prepopulatetype: { render: 'value prepopulation' },
  prepopulatevalue: { render: 'value prepopulation' },
  prepopulatefromattribute: { render: 'current user prepopulation' },
  // Set Value On Save.
  setvalueonsave: { elsewhere: ['form-service.test.mjs', 'setvalueonsave'] },
  onsavetype: { elsewhere: ['form-service.test.mjs', 'onsavetype'] },
  onsavevalue: { elsewhere: ['form-service.test.mjs', 'onsavevalue'] },
  onsavefromattribute: { elsewhere: ['form-service.test.mjs', 'onsavefromattribute'] },
  // Lookup settings.
  entityformforcreate: { render: 'the lookup dialog offers New for an exported create form' },
  // Validation.
  validationerrormessage: { submit: 'format failure message' },
  validationregularexpression: { submit: 'regular expression' },
  validationregularexpressionerrormessage: { submit: 'regular expression message' },
  fieldisrequired: { submit: 'required field' },
  requiredfieldvalidationerrormessage: { submit: 'required message', render: 'required validator text' },
  rangevalidationerrormessage: { elsewhere: ['native-form-number-locale.test.mjs', 'rangevalidationerrormessage'] },
  geolocationvalidatorerrormessage: { diagnostic: 'FORM_GEOLOCATION_VALIDATOR_HOSTED' },
  constantsumvalidationerrormessage: { submit: 'constant sum message' },
  multiplechoicevalidationerrormessage: { submit: 'multiple choice message' },
  rankordernotiesvalidationerrormessage: { submit: 'rank order tie message' },
  // Description and instructions.
  adddescription: { render: 'description' },
  descriptionposition: { render: 'description position' },
  useattributedescriptionproperty: { render: 'column description' },
  description: { render: 'custom description' },
  // Section and Tab.
  sectionname: { render: 'section label' },
  tabname: { render: 'tab label' },
  // Subgrid, Notes and Timeline rows are configured by their own documents.
  subgrid_name: { elsewhere: ['platform.test.mjs', 'adx_subgrid_name'] },
  subgrid_settings: { elsewhere: ['subgrid-actions.test.mjs', 'subgrid_settings'] },
  notes_settings: { elsewhere: ['form-dialogs-notes.test.mjs', 'notes_settings'] },
  // Learn lists the Timeline settings by label only; the adx_timeline_settings shape is not documented.
  timeline_settings: { diagnostic: 'FORM_TIMELINE_METADATA_UNSUPPORTED' },
};
// The writable columns the Learn reference lists for mspp_entityformmetadata, without the mspp_ prefix.
const DOCUMENTED_COLUMNS = `adddescription attributelogicalname constantsummaximumtotal constantsumminimumtotal
constantsumvalidationerrormessage controlstyle createdby createdon cssclass description descriptionposition entityform
entityformforcreate entityformmetadataid fieldisrequired geolocationvalidatorerrormessage groupname ignoredefaultvalue
label maxmultiplechoiceselectedcount minmultiplechoiceselectedcount modifiedby modifiedon
multiplechoicevalidationerrormessage name notes_settings onsavefromattribute onsavetype onsavevalue
prepopulatefromattribute prepopulatetype prepopulatevalue provisionedlanguages randomizeoptionsetvalues
rangevalidationerrormessage rankordernotiesvalidationerrormessage requiredfieldvalidationerrormessage sectionname
setvalueonsave subgrid_name subgrid_settings tabname timeline_settings type useattributedescriptionproperty
validationerrormessage validationregularexpression validationregularexpressionerrormessage statecode statuscode`
  .split(/\s+/)
  .filter(Boolean);

// @test-kind contract: the coverage matrix is complete over the documented columns, and every elsewhere entry names a suite that exercises the column
test('every documented form metadata column has a coverage entry', () => {
  assert.deepEqual(Object.keys(MATRIX).toSorted(), DOCUMENTED_COLUMNS.toSorted());
  for (const [column, entry] of Object.entries(MATRIX)) {
    assert.ok(Object.keys(entry).length, column);
    if (!entry.elsewhere) continue;
    const [file, marker] = entry.elsewhere;
    const path = new URL(`./${file}`, import.meta.url);
    assert.ok(existsSync(path), `${column}: ${file}`);
    assert.ok(readFileSync(path, 'utf8').includes(marker), `${column}: ${file} names ${marker}`);
  }
});

// ---- Rendering

const RECORD_ID = 'c0e00000-0000-4000-8000-000000000001';
const choice = (name, label) => ({
  name,
  label,
  dataverseType: 'picklist',
  options: [
    { value: 1, label: 'First' },
    { value: 2, label: 'Second' },
  ],
});
const RENDERED = [
  { name: 'title', label: 'Title', dataverseType: 'nvarchar', description: 'Unused column help' },
  { name: 'summary', label: 'Summary', dataverseType: 'nvarchar', description: 'Column help' },
  choice('vertical', 'Vertical'),
  choice('horizontal', 'Horizontal'),
  choice('shuffled', 'Shuffled'),
  { name: 'note', label: 'Note', dataverseType: 'nvarchar' },
  { name: 'mail', label: 'Mail', dataverseType: 'nvarchar' },
  { name: 'place', label: 'Place', dataverseType: 'nvarchar' },
  { name: 'ownerref', label: 'Owner', dataverseType: 'lookup', lookupTargets: ['owner'] },
];
const attribute = (name, extra) => ({
  kind: 'basicformmetadata',
  adx_entityform: 'form',
  adx_type: 100000000,
  adx_attributelogicalname: name,
  ...extra,
});

async function render(records, { random } = {}) {
  const diagnostics = [];
  const store = {
    resolveMapping: (entity) =>
      entity === 'owner'
        ? { entitySet: 'owners', idColumn: 'ownerid', nameColumn: 'name' }
        : {
            entitySet: 'samples',
            idColumn: 'sampleid',
            relationships: { sample_owner: { from: 'ownerref', entity: 'owner', many: false } },
          },
    get: async () => ({ sampleid: RECORD_ID }),
    query: async () => ({ value: [] }),
    fetchXml: async () => ({ entities: [] }),
  };
  const portal = {
    forms: [
      { id: 'form', name: 'Sample', mode: 100000000 },
      { id: 'ownercreate', name: 'Owner create', mode: 100000000 },
    ],
    records,
    website: { id: 'site' },
    pages: [],
    settings: { 'Site/BootstrapV5Enabled': 'true' },
  };
  const layout = [
    {
      name: 'main',
      label: 'Main',
      showLabel: true,
      columns: [
        {
          sections: [
            {
              name: 'details',
              label: 'Details',
              showLabel: true,
              rows: RENDERED.map((field) => [{ name: field.name, label: field.label }]),
            },
          ],
        },
      ],
    },
  ];
  const views = [
    {
      entity: 'owner',
      id: 'owner-lookup',
      queryType: 64,
      isDefault: true,
      fetchXml: '<fetch><entity name="owner"><attribute name="name"/></entity></fetch>',
      fields: [{ name: 'name' }],
    },
  ];
  const original = Math.random;
  if (random) Math.random = random;
  try {
    const html = await renderComponent(
      'entityform',
      'form',
      { user: { id: 'current', contactId: 'current', emailaddress1: 'visitor@example.test' }, request: { params: {} } },
      {
        portal,
        store,
        schemas: { form: { entity: 'sample', title: 'Sample', fields: RENDERED, layout } },
        metadata: { views },
        diagnostic: (entry) => diagnostics.push(entry),
      },
    );
    return { html, diagnostics };
  } finally {
    Math.random = original;
  }
}

test('attribute, section and tab metadata change the rendered form', async () => {
  const { html, diagnostics } = await render([
    attribute('title', {
      adx_label: 'Custom title',
      adx_cssclass: 'sample-css',
      adx_fieldisrequired: true,
      adx_requiredfieldvalidationerrormessage: 'Enter the title',
      adx_adddescription: true,
      adx_descriptionposition: 100000001,
      adx_useattributedescriptionproperty: false,
      adx_description: 'Custom help',
    }),
    attribute('summary', {
      adx_adddescription: true,
      adx_descriptionposition: 100000000,
      adx_useattributedescriptionproperty: true,
    }),
    attribute('vertical', { adx_controlstyle: 100000000 }),
    attribute('horizontal', { adx_controlstyle: 100000001 }),
    attribute('note', { adx_prepopulatetype: 100000000, adx_prepopulatevalue: 'Prefilled' }),
    attribute('mail', { adx_prepopulatetype: 100000002, adx_prepopulatefromattribute: 'emailaddress1' }),
    attribute('ownerref', { adx_entityformforcreate: 'ownercreate' }),
    {
      kind: 'basicformmetadata',
      adx_entityform: 'form',
      adx_type: 100000001,
      adx_sectionname: 'details',
      adx_label: 'Custom section',
    },
    {
      kind: 'basicformmetadata',
      adx_entityform: 'form',
      adx_type: 100000002,
      adx_tabname: 'main',
      adx_label: 'Custom tab',
    },
  ]);
  // Label, CSS class, Field is Required with its message (the required validator text) and a custom description below.
  assert.match(html, /<label for="title" id="title_label" class="field-label">Custom title<\/label>/);
  assert.match(
    html,
    /id="title" class="text form-control sample-css"[^>]*aria-required="true" title="Enter the title"/,
  );
  assert.match(html, /<div class="description below sample-css">Custom help<\/div>/);
  // Use Attribute's Description Property: the column description above the field.
  assert.match(html, /<div class="description above">Column help<\/div>/);
  // Option Set as Vertical / Horizontal Radio Button List.
  assert.match(html, /<span id="vertical" class="picklist vertical "[^>]*><input id="vertical_0" type="radio"/);
  assert.match(html, /<span id="horizontal" class="picklist horizontal "[^>]*><input id="horizontal_0" type="radio"/);
  // Prepopulate Type Value.
  assert.match(html, /type="text" value="Prefilled" id="note"/);
  // Prepopulate Type Current User's Contact with a From Attribute.
  assert.match(html, /type="text" value="visitor@example\.test" id="mail"/);
  assert.doesNotMatch(html, /Unused column help/);
  // Basic Form for Create: the lookup dialog offers New.
  assert.match(html, /title="New">New<\/button>/);
  // Section and Tab labels.
  assert.match(html, /<h3>Custom section<\/h3>/);
  assert.match(html, /<h2 class="tab-title">Custom tab<\/h2>/);
  assert.deepEqual(diagnostics, []);
});

test('Randomize Option Set Values shuffles the rendered options', async () => {
  const plain = await render([attribute('shuffled', { adx_controlstyle: 100000000 })]);
  const shuffled = await render(
    [attribute('shuffled', { adx_controlstyle: 100000000, adx_randomizeoptionsetvalues: true })],
    { random: () => 0 },
  );
  const order = (html) =>
    [...boundedMarkup(html).matchAll(/<input id="shuffled_\d" type="radio"[^>]*value="(\d)"/g)].map(
      (match) => match[1],
    );
  assert.deepEqual(order(plain.html), ['1', '2']);
  assert.deepEqual(order(shuffled.html), ['2', '1']);
});

test('Timeline metadata, whose settings shape is undocumented, is reported when the export has it', async () => {
  const { diagnostics } = await render([
    { kind: 'basicformmetadata', adx_entityform: 'form', adx_type: 756150000, adx_timeline_settings: '{}' },
  ]);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['FORM_TIMELINE_METADATA_UNSUPPORTED'],
  );
});

test('Geolocation Lookup Validator is reported as hosted-only when the export uses it', async () => {
  const { diagnostics } = await render([
    attribute('place', { adx_controlstyle: 100000002, adx_geolocationvalidatorerrormessage: 'Not a place' }),
  ]);
  assert.deepEqual(
    diagnostics.map((entry) => [entry.code, entry.form]),
    [['FORM_GEOLOCATION_VALIDATOR_HOSTED', 'Sample']],
  );
});

// ---- Submission

const SUBMITTED = [
  { name: 'title', label: 'Title', dataverseType: 'nvarchar' },
  { name: 'code', label: 'Code', dataverseType: 'nvarchar' },
  { name: 'email', label: 'Email', dataverseType: 'nvarchar', format: 'email' },
  { name: 'place', label: 'Place', dataverseType: 'nvarchar' },
  ...['sum1', 'sum2', 'sum3'].map((name) => ({ name, label: name, dataverseType: 'int' })),
  ...['rank1', 'rank2', 'rank3'].map((name) => ({ name, label: name, dataverseType: 'int' })),
  ...['pick1', 'pick2', 'pick3'].map((name) => ({ name, label: name, dataverseType: 'bit' })),
];

async function submission(records) {
  const store = await new DataStore({
    state: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
      tables: { sample: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const diagnostics = [];
  const options = {
    store,
    portal: { forms: [{ id: 'form', name: 'Sample', mode: 100000000 }], records },
    schemas: { form: { entity: 'sample', fields: SUBMITTED } },
    identity: { id: 'visitor', roles: [] },
    sessions: createWebFormSessions(),
    diagnostic: (entry) => diagnostics.push(entry),
  };
  const submit = (values) =>
    submitPortalForm('entityform', 'form', { values: { title: 'Sample', ...values } }, options);
  const failure = async (values) => {
    try {
      await submit(values);
    } catch (error) {
      return error.details?.validationErrors ?? [{ code: error.code, message: error.message }];
    }
    return [];
  };
  return { store, submit, failure, diagnostics };
}
const group = (names, style, name, extra = {}) =>
  names.map((column, index) =>
    attribute(column, { adx_controlstyle: style, adx_groupname: name, ...(index ? {} : extra) }),
  );

test('Field is Required uses its Required Field Validation Error Message on the server', async () => {
  const { failure } = await submission([
    attribute('code', { adx_fieldisrequired: true, adx_requiredfieldvalidationerrormessage: 'Code is needed' }),
    attribute('place', { adx_fieldisrequired: true }),
  ]);
  assert.deepEqual(
    (await failure({})).map((error) => [error.field, error.code, error.message]),
    [
      ['code', 'FormFieldRequired', 'Code is needed'],
      ['place', 'FormFieldRequired', 'Place is a required field.'],
    ],
  );
});

test('Regular Expression and Validation Error Message apply on the server', async () => {
  const { failure } = await submission([
    attribute('code', {
      adx_validationregularexpression: '[A-Z]{3}',
      adx_validationregularexpressionerrormessage: 'Three capitals',
    }),
    attribute('email', { adx_validationerrormessage: 'Mail address please' }),
  ]);
  assert.deepEqual(
    (await failure({ code: 'abc', email: 'not mail' })).map((error) => [error.field, error.message]),
    [
      ['code', 'Three capitals'],
      ['email', 'Mail address please'],
    ],
  );
  assert.deepEqual(await failure({ code: 'ABC', email: 'a@b.example' }), []);
});

test('a constant sum group totals within its minimum and maximum', async () => {
  const { failure, store } = await submission(
    group(['sum1', 'sum2', 'sum3'], 100000003, 'budget', {
      adx_constantsumminimumtotal: 10,
      adx_constantsummaximumtotal: 10,
      adx_constantsumvalidationerrormessage: 'The budget must total 10',
    }),
  );
  assert.deepEqual(
    (await failure({ sum1: 3, sum2: 3, sum3: 3 })).map((error) => [error.field, error.code, error.message]),
    [['sum3', 'FormConstantSumInvalid', 'The budget must total 10']],
  );
  assert.deepEqual(store.snapshot().tables.sample, []);
  assert.deepEqual(await failure({ sum1: 3, sum2: 3, sum3: 4 }), []);
});

test('a multiple choice group chooses between its minimum and maximum count', async () => {
  const { failure } = await submission(
    group(['pick1', 'pick2', 'pick3'], 100000007, 'choices', {
      adx_minmultiplechoiceselectedcount: 1,
      adx_maxmultiplechoiceselectedcount: 2,
      adx_multiplechoicevalidationerrormessage: 'Choose one or two',
    }),
  );
  for (const values of [
    { pick1: false, pick2: false, pick3: false },
    { pick1: true, pick2: true, pick3: true },
  ])
    assert.deepEqual(
      (await failure(values)).map((error) => [error.field, error.code, error.message]),
      [['pick3', 'FormMultipleChoiceInvalid', 'Choose one or two']],
    );
  assert.deepEqual(await failure({ pick1: true, pick2: false, pick3: true }), []);
});

test('a rank order scale without ties refuses a repeated rank, and allowing ties accepts it', async () => {
  const { failure } = await submission(
    group(['rank1', 'rank2', 'rank3'], 100000004, 'ranks', {
      adx_rankordernotiesvalidationerrormessage: 'Each rank once',
    }),
  );
  assert.deepEqual(
    (await failure({ rank1: 1, rank2: 2, rank3: 1 })).map((error) => [error.field, error.code, error.message]),
    [['rank3', 'FormRankOrderTie', 'Each rank once']],
  );
  assert.deepEqual(await failure({ rank1: 1, rank2: 2, rank3: 3 }), []);
  const ties = await submission(group(['rank1', 'rank2', 'rank3'], 100000005, 'ranks'));
  assert.deepEqual(await ties.failure({ rank1: 1, rank2: 1, rank3: 1 }), []);
});

// @test-kind unproven: the default copy of the survey group validators and the choice of the first member's bounds are not captured from a hosted site
test('survey groups without a configured message use a default message', async () => {
  const sum = await submission(group(['sum1', 'sum2'], 100000003, 'budget', { adx_constantsumminimumtotal: 5 }));
  assert.equal((await sum.failure({ sum1: 1, sum2: 1 }))[0].message, 'The total of budget must be at least 5.');
  const picks = await submission(
    group(['pick1', 'pick2'], 100000007, 'choices', { adx_maxmultiplechoiceselectedcount: 1 }),
  );
  assert.equal((await picks.failure({ pick1: true, pick2: true }))[0].message, 'Select at most 1 options for choices.');
  const ranks = await submission(group(['rank1', 'rank2'], 100000004, 'ranks'));
  assert.equal((await ranks.failure({ rank1: 2, rank2: 2 }))[0].message, 'rank1 and rank2 have the same rank.');
});

test('a Geolocation Lookup Validator field saves unvalidated with a hosted-only diagnostic', async () => {
  const { submit, diagnostics } = await submission([attribute('place', { adx_controlstyle: 100000002 })]);
  assert.equal((await submit({ place: 'Anywhere' })).operation, 'create');
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['FORM_GEOLOCATION_VALIDATOR_HOSTED'],
  );
});
