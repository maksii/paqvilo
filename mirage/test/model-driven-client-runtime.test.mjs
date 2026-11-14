// @test-kind contract: trusted local form events, source compilation and unsupported APIs follow the toolkit client design.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureModelDrivenContract } from '../testing/model-driven-contract.mjs';
import { captureModelDrivenDirtyContract } from '../testing/model-driven-dirty.mjs';
import {
  createFormClientRuntime,
  evaluateRibbonRules,
  parseHandlerParameters,
  resolveClientFunction,
  loadClientLibrary,
} from '../lib/model-driven/client-runtime.mjs';
import { compileForm, parseRibbonCommands, parseAppActionCommand } from '../lib/model-driven/solution.mjs';

function runtimeFixture(overrides = {}) {
  const record = { x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Copper', x_quantity: 2 },
    writes = [],
    requests = [],
    notices = [],
    state = new Map();
  const host = {
    record,
    table: {
      entity: 'x_item',
      idColumn: 'x_itemid',
      nameColumn: 'x_name',
      fields: { x_name: { name: 'x_name', type: 'text' }, x_quantity: { name: 'x_quantity', type: 'number' } },
    },
    tables: { x_item: { idColumn: 'x_itemid' } },
    form: { clientEvents: [] },
    extensions: { trusted: false },
    read: (name) => record[name],
    write: (name, value) => {
      record[name] = value;
      writes.push({ name, value });
    },
    isDirty: (name) => (name ? writes.some((write) => write.name === name) : writes.length > 0),
    controlNames: (name) => (name ? [name] : ['x_name', 'x_quantity']),
    controlField: (name) => name,
    controlState: (name, key, value) => (value === undefined ? state.get(name + key) : state.set(name + key, value)),
    notification: (...args) => notices.push(args),
    request: async (entity, id, options = {}) => {
      requests.push({ entity, id, options });
      return options.query?.scope === 'odata'
        ? id
          ? record
          : { entities: [record] }
        : { row: record, rows: [record], etag: 'W/"1"', more: false };
    },
    save: async (close) => writes.push({ save: close }),
    refresh() {},
    close() {},
    openForm() {},
    alert: async () => {},
    confirm: async () => true,
    environment: { location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' } },
    ...overrides,
  };
  return { runtime: createFormClientRuntime(host), record, writes, requests, notices, state, host };
}

test('FormXml numeric booleans preserve source visibility, labels and disabled controls', () => {
  const compile = (yes, no) =>
    compileForm(
      {
        id: 'invented-form',
        xml: `<form><tabs><tab name="visible" visible="${yes}"><columns><column><sections><section name="shown" visible="${yes}" showlabel="${no}"><rows><row><cell showlabel="${no}" visible="${yes}"><control id="locked" datafieldname="x_name" disabled="${yes}"/></cell><cell visible="${no}"><control id="hidden" datafieldname="x_name" disabled="${no}"/></cell><cell visible="${no}"/></row></rows></section><section name="hidden-section" visible="${no}"/></sections></column></columns></tab><tab name="hidden-tab" visible="${no}"/></tabs></form>`,
      },
      { x_name: { name: 'x_name', type: 'text' } },
    );
  const summary = (form) => [
    form.tabs.map((tab) => tab.visible),
    form.tabs[0].sections.map((section) => [section.visible, section.showLabel]),
    form.tabs[0].sections[0].fields.map((field) => [field.visible, field.disabled, field.showLabel]),
  ];
  assert.deepEqual(summary(compile('1', '0')), summary(compile('true', 'false')));
  assert.deepEqual(summary(compile('1', '0')), [
    [true, false],
    [
      [true, false],
      [false, true],
    ],
    [
      [true, true, false],
      [false, false, true],
      [false, undefined, true],
    ],
  ]);
});

test('form client APIs dispatch async events, track edits and cancel OnSave without executing expressions', async (t) => {
  const { runtime, record, writes, notices } = runtimeFixture();
  let changes = 0;
  const attribute = runtime.formContext.getAttribute('x_name');
  attribute.addOnChange(async (context) => {
    await Promise.resolve();
    changes++;
    // @test-kind observation: native UCI text.fireOnChange source identity was recorded on 2026-11-08 and two fresh UCI runs on 2026-11-09 reproduced the same ordered 121 cases in fixtures/model-driven-contract-expected.json (SHA256 99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8); the event-context and producer-source assertions are typed in this test, so it is not a replay case.
    await t.test('native change context exposes its source attribute', () => {
      assert.equal(
        createHash('sha256')
          .update(readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url)))
          .digest('hex'),
        '99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8',
      );
      assert.equal(
        createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
        'e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3',
      );
      assert.equal(context.getEventSource(), attribute);
    });
    context.getFormContext().getAttribute('x_quantity').setValue(3);
  });
  attribute.setValue('Silver');
  // @test-kind observation: native UCI text.setValue.eventCount recorded on 2026-11-08 in the 121-case fixtures/model-driven-contract-expected.json (SHA256 99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8); the OnChange dormancy and producer-source assertions are typed in this test, so it is not a replay case.
  await t.test('native setValue leaves OnChange dormant', () => {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url)))
        .digest('hex'),
      '99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8',
    );
    assert.equal(
      createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
      'e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3',
    );
    assert.equal(changes, 0, 'setValue does not implicitly fire OnChange');
  });
  await attribute.fireOnChange();
  assert.equal(changes, 1);
  assert.equal(record.x_quantity, 3);
  // @test-kind observation: native UCI dirty text edit and getIsDirty recorded on 2026-11-08 in the 82-result fixtures/model-driven-dirty-expected.json; the attribute and form setup is typed in this test, so it is not a replay case.
  await t.test('native changed text attribute is dirty', () => {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/model-driven-dirty-expected.json', import.meta.url)))
        .digest('hex'),
      'a82c85e6df0f66ea9c0297b2ef87fdb1a83d32f51b9e7851e8a1252b219b7c93',
    );
    assert.equal(
      createHash('sha256').update(captureModelDrivenDirtyContract.toString()).digest('hex'),
      '62c403234c10bd3e1c8ec4dd15ea3496f672fc76d3324f1b5a2fcce1d7420177',
    );
    assert.equal(attribute.getIsDirty(), true);
  });
  runtime.formContext.data.entity.addOnSave((context) => {
    assert.equal(context.getEventArgs().getSaveMode(), 2);
    context.getEventArgs().preventDefault();
    context.getFormContext().ui.setFormNotification('Explain why', 'ERROR', 'validation');
  });
  assert.equal((await runtime.dispatch('onsave', undefined, 2)).prevented, true);
  assert.equal(
    writes.some((write) => Object.hasOwn(write, 'save')),
    false,
  );
  assert.deepEqual(notices[0], ['Explain why', 'ERROR', 'validation']);
  assert.throws(() => runtime.Xrm.Utility.getGlobalContext().organizationSettings, /does not support/);
  runtime.formContext.getAttribute('x_name').setSubmitMode('always');
  // @test-kind observation: native UCI text.submit.always was accepted on 2026-11-08 in two draft-form captures (fixtures/frontend-parity-evidence.md) and the 121-case fixtures/model-driven-contract-expected.json; the submit assertions are typed in this test, so it is not a replay case.
  await t.test('native submit mode always is accepted and retained', () => {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url)))
        .digest('hex'),
      '99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8',
    );
    assert.equal(
      createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
      'e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3',
    );
    assert.equal(runtime.formContext.getAttribute('x_name').getSubmitMode(), 'always');
  });
  runtime.destroy();
  assert.throws(() => attribute.getValue(), /disposed/);
  assert.deepEqual(notices.at(-1), [null, null, 'validation']);
  await assert.rejects(runtime.Xrm.WebApi.updateRecord('x_item', 'id', { x_name: 'stale' }), /disposed/);
});

function attributeTypesFixture() {
  return runtimeFixture({
    table: {
      entity: 'x_item',
      idColumn: 'x_itemid',
      fields: {
        x_amount: { name: 'x_amount', type: 'number', dataverseType: 'money' },
        x_decimal: { name: 'x_decimal', type: 'number', dataverseType: 'decimal' },
        x_choice: { name: 'x_choice', type: 'number', options: [{ value: 1, label: 'One' }] },
      },
    },
    form: { clientEvents: [], attributes: ['x_amount', 'x_decimal', 'x_choice'] },
  });
}

// @test-kind observation: native money, decimal and single-choice getAttributeType results recorded in both 121-case captures on 2026-11-08 (fixtures/model-driven-contract-expected.json); the metadata is typed in this test and option-by-label lookup is a separate toolkit contract, so it is not a replay case.
test('client attribute types derive from exported metadata', () => {
  const { runtime } = attributeTypesFixture();
  assert.equal(runtime.formContext.getAttribute('x_amount').getAttributeType(), 'money');
  assert.equal(runtime.formContext.getAttribute('x_decimal').getAttributeType(), 'decimal');
  assert.equal(runtime.formContext.getAttribute('x_choice').getAttributeType(), 'optionset');
});

// @test-kind contract: source option labels drive the local getOption-by-label lookup; that exact lookup is not part of the native probe.
test('choice option lookup uses exported labels', () => {
  const { runtime } = attributeTypesFixture();
  assert.deepEqual(runtime.formContext.getAttribute('x_choice').getOption('One'), { text: 'One', value: 1 });
});

test('disposing a form during lazy metadata preparation prevents its pending Xrm write', async () => {
  let release;
  const { runtime, requests } = runtimeFixture({
    metadata: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = runtime.Xrm.WebApi.createRecord('x_item', { x_name: 'Must not write' });
  runtime.destroy();
  release();
  await assert.rejects(pending, /disposed/);
  assert.equal(requests.length, 0);
});

test('global context reports the selected local staff without inventing security role identifiers', () => {
  const { runtime } = runtimeFixture({
    user: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Invented staff', roles: ['Basic User'] },
  });
  const settings = runtime.Xrm.Utility.getGlobalContext().userSettings;
  assert.equal(settings.userId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(settings.userName, 'Invented staff');
  // Without a server-built staff context the host answers the documented anonymous roles (none), never invented ids.
  assert.deepEqual(settings.securityRoles, []);
});

test('WebApi sends query options unchanged to the canonical local staff query engine', async () => {
  const { runtime, requests } = runtimeFixture();
  const result = await runtime.Xrm.WebApi.retrieveMultipleRecords(
    'x_item',
    "?$select=x_name,x_quantity&$filter=x_quantity ge 2 and x_name ne 'Gold'&$orderby=x_quantity desc&$top=5",
  );
  assert.equal(result.entities.length, 1);
  assert.deepEqual(requests[0].options.query, {
    scope: 'odata',
    options: "?$select=x_name,x_quantity&$filter=x_quantity ge 2 and x_name ne 'Gold'&$orderby=x_quantity desc&$top=5",
  });
  await runtime.Xrm.WebApi.updateRecord('x_item', 'id', { x_name: 'Gold' });
  assert.equal(requests.at(-1).options.etag, 'W/"1"');
  assert.equal(requests.at(-1).options.method, 'PATCH');
  await runtime.Xrm.WebApi.retrieveMultipleRecords('x_item', "?$filter=contains(x_name,'A')", 25);
  assert.deepEqual(requests.at(-1).options.query, {
    scope: 'odata',
    options: "?$filter=contains(x_name,'A')",
    pageSize: 25,
  });
  await assert.rejects(
    runtime.Xrm.WebApi.retrieveMultipleRecords(
      'x_item',
      'https://example.invalid/api/data/v9.2/x_items?$skiptoken=ignored',
    ),
    /local imported table/,
  );
  await assert.rejects(runtime.Xrm.WebApi.retrieveMultipleRecords('x_item', '', 5001), /maxPageSize/);
  assert.equal((await runtime.Xrm.WebApi.online.retrieveRecord('x_item', 'id', '?$select=x_name')).x_name, 'Copper');
  const online = runtime.Xrm.WebApi.online;
  runtime.destroy();
  await assert.rejects(online.retrieveRecord('x_item', 'id'), /disposed/);
});

test('exported script load settles on its load event however long the browser takes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const appended = [];
  let removed = false;
  const environment = {
    location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' },
    document: {
      createElement: () => ({
        remove() {
          removed = true;
        },
      }),
      head: { append: (script) => appended.push(script) },
    },
  };
  const outcomes = [];
  const loading = loadClientLibrary(
    'slow-load.js',
    { trusted: true, resources: [{ name: 'slow-load.js', type: 'script', url: '/_apps/slow-load.js' }] },
    environment,
  ).then(
    () => outcomes.push('loaded'),
    (error) => outcomes.push(error.message),
  );
  try {
    const [script] = appended;
    t.mock.timers.tick(20000);
    assert.equal(removed, false, 'a pending exported script is not removed by a timer');
    script.onload();
    await loading;
    assert.deepEqual(outcomes, ['loaded']);
  } finally {
    t.mock.timers.reset();
  }
});

test('exported script loading requires explicit trust and local resource admission', async () => {
  const environment = {
    location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' },
    document: {
      createElement() {
        throw new Error('must not create a script');
      },
    },
  };
  await assert.rejects(loadClientLibrary('x.js', { trusted: false }, environment), /disabled/);
  await assert.rejects(
    loadClientLibrary(
      'x.js',
      { trusted: true, resources: [{ name: 'x.js', type: 'script', url: 'https://example.invalid/x.js' }] },
      environment,
    ),
    /local imported/,
  );
  await assert.rejects(
    loadClientLibrary(
      'x.js',
      { trusted: true, resources: [{ name: 'x.js', type: 'script', url: '/_sim/api' }] },
      environment,
    ),
    /local imported/,
  );
  assert.throws(() => resolveClientFunction({ Sample: {} }, 'Sample.constructor'), /invalid/);
  assert.throws(() => resolveClientFunction({}, 'fetch("https://example.invalid")'), /invalid/);
  const fn = () => {};
  assert.equal(resolveClientFunction({ Sample: { Sample: fn } }, 'Sample.Sample').fn, fn);
  assert.deepEqual(parseHandlerParameters('\'hello\', 2, true, null, "quoted"'), ['hello', 2, true, null, 'quoted']);
  assert.throws(() => parseHandlerParameters('window.location'), /primitive constants/);
  assert.throws(() => parseHandlerParameters('{"a":1}'), /primitive constants/);
});

test('unsupported WebApi lookup bindings fail before any record request or partial mutation', async () => {
  const { runtime, requests, record } = runtimeFixture();
  const before = structuredClone(record);
  await assert.rejects(
    runtime.Xrm.WebApi.updateRecord('x_item', record.x_itemid, {
      x_name: 'Must not write',
      'x_parentid@odata.bind': '/x_items(aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)',
    }),
    /does not support Xrm.WebApi lookup binding/,
  );
  await assert.rejects(
    runtime.Xrm.WebApi.createRecord('x_item', { x_name: 'Must not create', 'x_parentid@odata.bind': null }),
    /lookup binding/,
  );
  assert.deepEqual(requests, []);
  assert.deepEqual(record, before);
});

test('WebApi binds imported single-valued relationships without guessing entity sets or navigation names', async () => {
  const table = {
    entity: 'x_child',
    idColumn: 'x_childid',
    fields: { x_parentid: { type: 'lookup', targets: ['x_item', 'x_other'] } },
    relationships: { x_Parent: { many: false, from: 'x_parentid', entity: 'x_item' } },
  };
  const { runtime, requests } = runtimeFixture({
    tables: { x_child: table, x_item: { entitySet: 'x_inventory' }, x_other: { entitySet: 'x_others' } },
  });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await runtime.Xrm.WebApi.updateRecord('x_child', id, { 'x_Parent@odata.bind': `/x_inventory(${id})` });
  assert.deepEqual(requests.at(-1).options, {
    method: 'PATCH',
    data: { x_parentid: { id, entity: 'x_item' } },
    etag: 'W/"1"',
  });
  await runtime.Xrm.WebApi.updateRecord('x_child', id, { 'x_Parent@odata.bind': null });
  assert.deepEqual(requests.at(-1).options.data, { x_parentid: null });
  const count = requests.length;
  for (const value of [
    `https://example.invalid/x_inventory(${id})`,
    `/x_others(${id})`,
    `/x_inventory(${id})?secret=value`,
  ]) {
    await assert.rejects(
      runtime.Xrm.WebApi.updateRecord('x_child', id, { 'x_Parent@odata.bind': value }),
      /local entity-set|imported target/,
    );
  }
  await assert.rejects(
    runtime.Xrm.WebApi.updateRecord('x_child', id, { x_parentid: null, 'x_Parent@odata.bind': `/x_inventory(${id})` }),
    /conflicting/,
  );
  await assert.rejects(
    runtime.Xrm.WebApi.updateRecord('x_child', id, { 'x_parentid@odata.bind': `/x_inventory(${id})` }),
    /exported navigation-property/,
  );
  assert.equal(requests.length, count, 'invalid bindings fail before even reading the target record');
});

test('multiselect form values expose numeric arrays and Xrm writes translate native choice strings', async (t) => {
  const field = {
    name: 'x_choices',
    type: 'multiselect',
    options: [
      { value: 1, label: 'One' },
      { value: 2, label: 'Two' },
    ],
  };
  const table = { entity: 'x_item', idColumn: 'x_itemid', fields: { x_choices: field } };
  const { runtime, record, requests } = runtimeFixture({
    table,
    tables: { x_item: table },
    form: { clientEvents: [], attributes: ['x_choices'] },
  });
  record.x_choices = '1,2';
  const attribute = runtime.formContext.getAttribute('x_choices');
  // @test-kind observation: native UCI multi.getAttributeType=multiselectoptionset recorded in both 121-result captures on 2026-11-08 (fixtures/model-driven-contract-expected.json); the multiselect setup is typed in this test, so it is not a replay case.
  await t.test('native multiselect attribute retains its declared type', () => {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url)))
        .digest('hex'),
      '99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8',
    );
    assert.equal(
      createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
      'e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3',
    );
    assert.equal(attribute.getAttributeType(), 'multiselectoptionset');
  });
  assert.deepEqual(attribute.getValue(), [1, 2]);
  assert.deepEqual(attribute.getText(), ['One', 'Two']);
  attribute.getValue().push(3);
  assert.equal(record.x_choices, '1,2', 'read values cannot mutate the form draft');
  attribute.setValue([2]);
  assert.deepEqual(attribute.getText(), ['Two']);
  await runtime.Xrm.WebApi.updateRecord('x_item', record.x_itemid, { x_choices: '2, 1' });
  assert.deepEqual(requests.at(-1).options.data, { x_choices: [2, 1] });
  await assert.rejects(
    runtime.Xrm.WebApi.updateRecord('x_item', record.x_itemid, { x_choices: '2,,1' }),
    /comma-separated/,
  );
});

test('disposing a form during WebApi preflight prevents follow-up mutations and stale read results', async () => {
  for (const operation of ['updateRecord', 'deleteRecord', 'retrieveRecord', 'retrieveMultipleRecords']) {
    let release;
    const requests = [];
    const { runtime } = runtimeFixture({
      request: (...args) => {
        requests.push(args);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = runtime.Xrm.WebApi[operation](
      'x_item',
      operation === 'retrieveMultipleRecords' ? undefined : 'id',
      operation === 'updateRecord' ? { x_name: 'Stale' } : undefined,
    );
    const rejected = assert.rejects(pending, /disposed/);
    runtime.destroy();
    release({ row: { x_name: 'Copper' }, rows: [], etag: 'W/"1"' });
    await rejected;
    assert.equal(requests.length, 1, `${operation} must not dispatch after its form is revoked`);
  }
});

test('form XML compiles native handler metadata and ribbon preserves unsupported commands visibly', () => {
  const form = compileForm(
    {
      id: 'events',
      xml: '<form><formLibraries><Library name="x_/sample.js" /></formLibraries><events><event name="onload"><Handlers><Handler functionName="Sample.load" libraryName="x_/sample.js" enabled="true" passExecutionContext="true" parameters="2"/></Handlers></event><event name="onchange" attribute="x_name"><Handlers><Handler functionName="Sample.change" libraryName="x_/sample.js" enabled="false"/></Handlers></event></events></form>',
    },
    {},
  );
  assert.deepEqual(form.libraries, ['x_/sample.js']);
  assert.equal(form.clientEvents[0].handlers[0].passExecutionContext, true);
  assert.equal(form.clientEvents[1].attribute, 'x_name');
  assert.equal(form.clientEvents[1].handlers[0].enabled, false);
  const commands = parseRibbonCommands(
    '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Do" Command="x.Do" LabelText="$LocLabels:x.Label"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.HomePageGrid.Unsupported" Command="x.Unsupported" LabelText="Unsupported"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Do"><EnableRules><EnableRule Id="x.Existing"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:x_/sample.js" FunctionName="Sample.command"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Unsupported"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="x.Existing"><FormStateRule State="Existing"/></EnableRule></EnableRules></RuleDefinitions><LocLabels><LocLabel Id="x.Label"><Titles><Title languagecode="1033" description="Do something"/></Titles></LocLabel></LocLabels></RibbonDiffXml>',
  );
  assert.equal(commands[0].label, 'Do something');
  assert.equal(commands[0].supported, true);
  assert.deepEqual(commands[0].locations, ['form']);
  assert.equal(evaluateRibbonRules(commands[0].enableRules, { existing: false }), false);
  assert.equal(evaluateRibbonRules(commands[0].enableRules, { existing: true }), true);
  assert.equal(
    evaluateRibbonRules(commands[0].enableRules, { existing: true, formType: 4 }),
    false,
    'a disabled persisted form is distinct from an editable existing form',
  );
  for (const [formType, State] of [
    [1, 'Create'],
    [2, 'Existing'],
    [3, 'ReadOnly'],
    [4, 'Disabled'],
    [6, 'BulkEdit'],
  ])
    assert.equal(evaluateRibbonRules([{ clauses: [{ type: 'FormStateRule', State }] }], { formType }), true);
  assert.equal(commands[1].supported, false);
  assert.deepEqual(commands[1].locations, ['grid']);
});

test('trusted source events honor XML Boolean words and numeric spellings without activating invalid flags', async () => {
  const handler = (name, flags = '') =>
    `<Handler libraryName="x_boolean_flags.js" functionName="Invented.${name}" ${flags}/>`;
  const event = (body, flags = '') => `<event name="onload" ${flags}><Handlers>${body}</Handlers></event>`;
  const form = compileForm(
    {
      id: 'boolean-events',
      xml: `<form><formLibraries><Library name="x_boolean_flags.js"/></formLibraries><events>${
        event(handler('inactive'), 'active="0"') +
        event(handler('canonicalInactive'), 'active="false"') +
        event(handler('invalidEvent'), 'active="TRUE"') +
        event(
          handler('disabled', 'enabled="0"') +
            handler('canonicalDisabled', 'enabled="false"') +
            handler('invalidHandler', 'enabled="yes"') +
            handler('numeric', 'enabled="1" passExecutionContext="1" parameters="7"') +
            handler('canonical', 'enabled="true" passExecutionContext="true"') +
            handler('defaults') +
            handler('withoutContext', 'passExecutionContext="0"') +
            handler('invalidContext', 'passExecutionContext="yes"'),
          'active="1"',
        )
      }</events></form>`,
    },
    {},
  );
  const calls = [],
    scope = {
      Invented: Object.fromEntries(
        [
          'inactive',
          'canonicalInactive',
          'invalidEvent',
          'disabled',
          'canonicalDisabled',
          'invalidHandler',
          'numeric',
          'canonical',
          'defaults',
          'withoutContext',
          'invalidContext',
        ].map((name) => [name, (...args) => calls.push({ name, args })]),
      ),
    };
  const { runtime } = runtimeFixture({
    form,
    scope,
    extensions: {
      trusted: true,
      resources: [{ name: 'x_boolean_flags.js', type: 'script', url: '/_apps/resources/boolean-flags.js' }],
    },
    environment: {
      location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' },
      document: { createElement: () => ({ remove() {} }), head: { append: (script) => script.onload() } },
    },
  });
  await runtime.dispatch('onload');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['numeric', 'canonical', 'defaults', 'withoutContext', 'invalidContext'],
  );
  assert.equal(calls[0].args[0].getFormContext(), runtime.formContext);
  assert.equal(calls[0].args[1], 7);
  assert.equal(calls[1].args[0].getFormContext(), runtime.formContext);
  assert.ok(calls.slice(2).every((call) => call.args.length === 0));
  runtime.destroy();
});

test('save reentrancy is rejected during lifecycle events but allowed from ribbon-style form API calls', async () => {
  const { runtime, writes } = runtimeFixture();
  let refused = false;
  runtime.formContext.data.entity.addOnSave(async (context) => {
    await assert.rejects(async () => context.getFormContext().data.save(), /active onsave/);
    refused = true;
  });
  await runtime.dispatch('onsave');
  assert.equal(refused, true);
  await runtime.formContext.data.save();
  assert.deepEqual(writes, [{ save: false }]);
});

test('overlapping async form events release their save guard even when they finish out of order', async () => {
  const { runtime, writes } = runtimeFixture();
  let release, changing;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const attribute = runtime.formContext.getAttribute('x_name');
  attribute.addOnChange(() => held);
  runtime.formContext.data.addOnLoad(() => {
    changing = attribute.fireOnChange();
  });
  await runtime.dispatch('onload');
  await assert.rejects(runtime.formContext.data.save(), /active onchange/);
  release();
  await changing;
  await runtime.formContext.data.save();
  assert.deepEqual(writes, [{ save: false }]);
});

test('modern AppAction compiles its exported WebResource ID and PrimaryControl without evaluating parameter text', () => {
  const xml =
    '<appaction uniquename="x_modern"><buttonlabeltext default="Modern reviewed"><label description="Modern reviewed" languagecode="1033"/></buttonlabeltext><context>1</context><contextentity><logicalname>x_item</logicalname></contextentity><contextvalue>x_item</contextvalue><hidden>0</hidden><isdisabled>0</isdisabled><location>0</location><name>modern</name><onclickeventjavascriptfunctionname>Sample.mark</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[{"type":5,"value":null}]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>';
  const command = parseAppActionCommand(xml, {
    webresourcesById: new Map([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x_/sample.js']]),
  });
  assert.equal(command.entity, 'x_item');
  assert.equal(command.supported, true);
  assert.deepEqual(command.actions[0].parameters, [{ kind: 'crm', value: 'PrimaryControl' }]);
  assert.equal(command.id, 'x_modern');
  assert.deepEqual(command.nativeControlIds, ['x_item|NoRelationship|Form|modern']);
  assert.equal(command.sequence, undefined, 'omitted sequence must not invent a first-position action');
  assert.equal(
    parseAppActionCommand(xml.replace('</appaction>', '<sequence>0.0000000000</sequence></appaction>')).sequence,
    0,
  );
  assert.equal(
    parseAppActionCommand(xml.replace('</appaction>', '<sequence>invalid</sequence></appaction>')).sequence,
    undefined,
  );
  assert.deepEqual(
    parseAppActionCommand(xml.replace('<location>0</location>', '<location>1</location>')).nativeControlIds,
    [],
    'Grid aliases require their own observed contract',
  );
  assert.deepEqual(
    parseAppActionCommand(xml.replace('<context>1</context>', '<context>2</context>')).nativeControlIds,
    [],
    'Other contexts cannot impersonate a table form command',
  );
  assert.deepEqual(
    parseAppActionCommand(xml.replace('<name>modern</name>', '<name>foreign|identifier</name>')).nativeControlIds,
    [],
    'An exported name cannot add native shell path segments',
  );
  assert.equal(parseAppActionCommand(xml).supported, false, 'missing resource keeps command disabled');
  assert.equal(
    parseAppActionCommand(xml.replace('<context>1</context>', '<context>2</context>'), {
      webresourcesById: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'x_/sample.js' },
    }).supported,
    false,
  );
  assert.equal(
    parseAppActionCommand(xml.replace('<hidden>0</hidden>', '<statecode>1</statecode>'), {
      webresourcesById: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'x_/sample.js' },
    }).supported,
    false,
  );
  assert.equal(
    parseAppActionCommand(xml.replace('[{"type":5,"value":null}]', 'window.alert(1)'), {
      webresourcesById: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'x_/sample.js' },
    }).supported,
    false,
  );
});

test('page context, version, openUrl, form selector and tab visibility follow Learn and the shell route', () => {
  const opened = [],
    visibility = [];
  const tab = {
    id: 'general',
    label: 'General',
    visible: true,
    sections: [{ name: 'details', label: 'Details', visible: true }],
  };
  const { runtime } = runtimeFixture({
    form: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Invented form', clientEvents: [], tabs: [tab] },
    pageContext: () => ({ pageType: 'entitylist', entityName: 'x_item', viewId: 'view-1', viewType: 'savedquery' }),
    setLayoutVisible: (item, visible) => visibility.push([item.id ?? item.name, visible]),
    environment: {
      location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' },
      open: (...args) => opened.push(args),
    },
  });
  assert.deepEqual(runtime.Xrm.Utility.getPageContext().input, {
    pageType: 'entitylist',
    entityName: 'x_item',
    viewId: 'view-1',
    viewType: 'savedquery',
  });
  assert.equal(runtime.Xrm.Utility.getGlobalContext().getVersion(), '9.2.0.0');
  runtime.Xrm.Navigation.openUrl('/api/data/v9.2/x_items');
  assert.deepEqual(opened, [['http://127.0.0.1:1234/api/data/v9.2/x_items', '_blank', 'noopener']]);
  assert.throws(() => runtime.Xrm.Navigation.openUrl('javascript:alert(1)'), /http\(s\) addresses only/);
  const selector = runtime.formContext.ui.formSelector;
  const formIdProofBytes = readFileSync(
    new URL('./fixtures/model-driven-single-form-lookup-native-facts.json', import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(formIdProofBytes).digest('hex'),
    '399620eaebfa933d1d851b29feb4050618a61884ad7ede46b9a77dd4a7ee4eff',
  );
  const formIdProof = JSON.parse(formIdProofBytes);
  assert.equal(formIdProof.captures.length, 2);
  for (const capture of formIdProof.captures)
    assert.deepEqual(capture.cases.find((entry) => entry.id === 'current-id').facts.result, {
      type: 'string',
      equalsSourceFormId: true,
      shape: 'lowercase-bare-guid',
    });
  assert.equal(selector.getCurrentItem().getId(), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(selector.getCurrentItem().getLabel(), 'Invented form');
  assert.equal(selector.items.getLength(), 1);
  const general = runtime.formContext.ui.tabs.get('general');
  assert.equal(general.getLabel(), 'General');
  assert.equal(general.getVisible(), true);
  general.setVisible(false);
  general.sections.get('details').setVisible(false);
  assert.deepEqual(visibility, [
    ['general', false],
    ['details', false],
  ]);
});

test('without a shell route the page context describes the open record', () => {
  const { runtime } = runtimeFixture({ form: { id: 'form-1', clientEvents: [] } });
  assert.deepEqual(runtime.Xrm.Utility.getPageContext().input, {
    pageType: 'entityrecord',
    entityName: 'x_item',
    entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    formId: 'form-1',
  });
});

// @test-kind compatibility: OnLoad exposes only getDataLoadState and OnChange exposes no save members, as the documented getEventArgs reference lists (learn.microsoft.com executioncontext/geteventargs).
test('OnLoad exposes its data load state and OnChange exposes no save arguments', async () => {
  const { runtime } = runtimeFixture();
  const loadStates = [];
  runtime.formContext.data.addOnLoad((context) => {
    loadStates.push(context.getEventArgs().getDataLoadState());
    assert.throws(() => context.getEventArgs().getSaveMode(), /does not support eventArgs\.getSaveMode\./);
  });
  await runtime.dispatch('onload');
  await runtime.dispatch('onload', undefined, 2);
  assert.deepEqual(loadStates, [1, 2]);
  let changeRefused = false;
  runtime.formContext.getAttribute('x_name').addOnChange((context) => {
    assert.equal(context.getEventArgs(), undefined);
    changeRefused = true;
  });
  await runtime.dispatch('onchange', 'x_name');
  assert.equal(changeRefused, true);
});

// @test-kind compatibility: formContext.data.save(saveOptions) delivers saveMode to OnSave and does not change the action (learn.microsoft.com formcontext-data/save).
test('data.save and entity.save pass the save mode to the host and refuse saveandnew', async () => {
  const saves = [];
  const { runtime } = runtimeFixture({
    save: async (close, mode) => {
      saves.push({ close, mode });
    },
  });
  await runtime.formContext.data.save({ saveMode: 70 });
  await runtime.formContext.data.save();
  await runtime.formContext.data.entity.save('saveandclose');
  await assert.rejects(runtime.formContext.data.save({ saveMode: 1.5 }), /saveMode/);
  assert.throws(
    () => runtime.formContext.data.entity.save('saveandnew'),
    /does not support formContext\.data\.entity\.save saveandnew\./,
  );
  assert.deepEqual(saves, [
    { close: false, mode: 70 },
    { close: false, mode: undefined },
    { close: true, mode: 2 },
  ]);
});

// @test-kind contract: formContext.data.save reports invalid saveOptions as a rejection, as the other promise-returning members do
test('a data.save call with invalid saveOptions rejects, so a script catch receives it', async () => {
  const saves = [];
  const { runtime } = runtimeFixture({
    save: async (close, mode) => {
      saves.push({ close, mode });
    },
  });
  const message = await runtime.formContext.data.save({ saveMode: 1.5 }).then(
    () => 'saved',
    (error) => error.message,
  );
  assert.match(message, /saveMode/);
  assert.deepEqual(saves, []);
});

// @test-kind contract: a saveandnew that fails for a reason other than a refusal reports it through the form notification and leaves no unhandled rejection
test('saveandnew reports a failed create through the form notification, without an unhandled rejection', async () => {
  let notified;
  const notice = new Promise((resolve) => {
    notified = resolve;
  });
  const { runtime, notices } = runtimeFixture({
    save: async () => {
      throw Object.assign(new Error('Invented server failure'), { status: 500 });
    },
    openNewRecord() {},
    notification: (...args) => {
      notices.push(args);
      notified();
    },
  });
  assert.equal(runtime.formContext.data.entity.save('saveandnew'), undefined);
  await notice;
  await runtime.settled();
  assert.deepEqual(notices, [['Invented server failure', 'ERROR', 'save']]);
});

// A runtime whose save fails and whose notification throws; notice settles on the first notification call.
function throwingNotificationFixture() {
  let notified;
  const notice = new Promise((resolve) => {
    notified = resolve;
  });
  const { runtime } = runtimeFixture({
    save: async () => {
      throw Object.assign(new Error('Invented server failure'), { status: 500 });
    },
    openNewRecord() {},
    notification: () => {
      notified();
      throw new Error('Invented notification failure');
    },
  });
  return { runtime, notice };
}

test('settled rejects when a saveandnew chain fails after the module catch has reported its error', async () => {
  const { runtime, notice } = throwingNotificationFixture();
  assert.equal(runtime.formContext.data.entity.save('saveandnew'), undefined);
  await notice;
  await assert.rejects(runtime.settled(), /Invented notification failure/);
});

test('a saveandnew chain that fails after the module catch is reported to the page as an error', async (t) => {
  const previous = globalThis.reportError;
  const reported = t.mock.fn();
  globalThis.reportError = reported;
  t.after(() => {
    if (previous === undefined) delete globalThis.reportError;
    else globalThis.reportError = previous;
  });
  const { runtime, notice } = throwingNotificationFixture();
  assert.equal(runtime.formContext.data.entity.save('saveandnew'), undefined);
  await notice;
  await assert.rejects(runtime.settled(), /Invented notification failure/);
  assert.equal(reported.mock.callCount(), 1);
  assert.match(reported.mock.calls[0].arguments[0].message, /Invented notification failure/);
});

// @test-kind contract: a saveandnew whose new record fails to open reports the error through the notification captured before the context was detached, without an unhandled rejection
test('saveandnew reports a failed open of the new record without an unhandled rejection', async () => {
  let notified;
  const notice = new Promise((resolve) => {
    notified = resolve;
  });
  const { runtime, notices } = runtimeFixture({
    save: async () => undefined,
    openNewRecord: () => Promise.reject(new Error('Invented open failure')),
    notification: (...args) => {
      notices.push(args);
      notified();
    },
  });
  assert.equal(runtime.formContext.data.entity.save('saveandnew'), undefined);
  await notice;
  await runtime.settled();
  assert.deepEqual(notices, [['Invented open failure', 'ERROR', 'save']]);
});

test('destroy clears the save notification of a failed saveandnew open', async () => {
  let notified;
  const notice = new Promise((resolve) => {
    notified = resolve;
  });
  const { runtime, notices } = runtimeFixture({
    save: async () => undefined,
    openNewRecord: () => Promise.reject(new Error('Invented open failure')),
    notification: (...args) => {
      notices.push(args);
      notified();
    },
  });
  runtime.formContext.data.entity.save('saveandnew');
  await notice;
  await runtime.settled();
  assert.deepEqual(notices.at(-1), ['Invented open failure', 'ERROR', 'save']);
  assert.doesNotThrow(() => runtime.destroy());
  assert.deepEqual(notices.at(-1), [null, null, 'save']);
});

test('saveandnew of a destroyed runtime opens no record when its save answers after the destroy', async (t) => {
  let answer;
  const pending = new Promise((resolve) => {
    answer = resolve;
  });
  const openNewRecord = t.mock.fn();
  const { runtime } = runtimeFixture({
    save: () => pending,
    openNewRecord,
  });
  assert.equal(runtime.formContext.data.entity.save('saveandnew'), undefined);
  runtime.destroy();
  answer(undefined);
  await runtime.settled();
  assert.equal(openNewRecord.mock.callCount(), 0);
});

// @test-kind contract: a completed save makes a copy of the saved values the baseline, so the object the host hands over afterwards cannot change dirty state
test('a completed save rebases dirty state on a copy of the saved values, not on the object the host handed over', async () => {
  let handedOver;
  const { runtime, host } = runtimeFixture({
    save: async () => {
      handedOver = { x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Draft', x_quantity: 2 };
      Object.defineProperty(host, 'initialRecord', { get: () => handedOver, configurable: true });
    },
  });
  const name = runtime.formContext.getAttribute('x_name');
  name.setValue('Draft');
  assert.equal(name.getIsDirty(), true);
  await runtime.formContext.data.save();
  assert.equal(name.getIsDirty(), false, 'the saved values are the baseline');
  handedOver.x_name = 'Changed after the save';
  assert.equal(name.getIsDirty(), false, 'changing the handed-over object does not change dirty state');
  name.setValue('Changed after the save');
  assert.equal(name.getIsDirty(), true, 'a value that differs from the saved values is dirty');
});

test('promise-returning form APIs reject after a refused save and after destroy instead of throwing', async () => {
  const { runtime } = runtimeFixture();
  const refusals = [];
  runtime.formContext.data.entity.addOnSave((context) => {
    refusals.push(
      assert.rejects(
        context.getFormContext().data.save(),
        /Saving from an active onsave handler is not supported\. Finish the event before saving\./,
      ),
    );
  });
  await runtime.dispatch('onsave');
  await Promise.all(refusals);
  runtime.destroy();
  await assert.rejects(runtime.Xrm.WebApi.retrieveRecord('x_item', 'id'), /disposed/);
  await assert.rejects(runtime.formContext.data.save(), /disposed/);
  assert.throws(() => runtime.formContext.data.getIsDirty(), /disposed/);
});

test('OnSave keeps its save mode and prevention members', async () => {
  const { runtime } = runtimeFixture();
  const seen = [];
  runtime.formContext.data.entity.addOnSave((context) => {
    const args = context.getEventArgs();
    seen.push(args.getSaveMode());
    args.preventDefault();
    seen.push(args.isDefaultPrevented());
  });
  assert.equal((await runtime.dispatch('onsave', undefined, 2)).prevented, true);
  assert.deepEqual(seen, [2, true]);
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): data.save() rejections are plain objects with errorCode, code, message and title for an OnSave preventDefault, a business-required column, and a save started while another is in flight; the first of two concurrent saves resolves.
test('script saves reject with the observed plain objects and the first of two concurrent saves resolves', async () => {
  const outcomes = ['cancelled', 'invalid'];
  const { runtime } = runtimeFixture({ save: async () => outcomes.shift() });
  await assert.rejects(runtime.formContext.data.save(), (error) => {
    assert.deepEqual(error, {
      errorCode: 2200000005,
      code: 2200000005,
      message: 'This form can’t be saved due to a custom setting.',
      title: 'Unable to save',
    });
    return true;
  });
  await assert.rejects(runtime.formContext.data.save(), (error) => {
    assert.deepEqual(error, {
      errorCode: 2200000007,
      code: 2200000007,
      message: 'Please make sure all the field requirements are met.',
      title: 'Unable to save changes',
    });
    return true;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { runtime: concurrent } = runtimeFixture({ save: () => (calls++ === 0 ? held : 'busy') });
  const first = concurrent.formContext.data.save(),
    second = concurrent.formContext.data.save();
  await assert.rejects(second, (error) => {
    assert.deepEqual(error, {
      errorCode: 2200000003,
      code: 2200000003,
      message: 'Please wait while saving is completed',
      title: 'Saving in Progress',
    });
    return true;
  });
  release('saved');
  assert.deepEqual(await first, {
    savedEntityReference: { entityType: 'x_item', id: '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}', name: 'Copper' },
  });
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): a successful data.save() resolves with savedEntityReference holding entityType, id and name.
test('a successful script save resolves with the saved entity reference', async () => {
  const { runtime } = runtimeFixture({ save: async () => 'saved' });
  assert.deepEqual(await runtime.formContext.data.save(), {
    savedEntityReference: { entityType: 'x_item', id: '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}', name: 'Copper' },
  });
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): OnSave arguments expose getSaveMode, preventDefault, isDefaultPrevented, preventDefaultOnError, shouldPreventDefaultOnError, disableAsyncTimeout and shouldDisableAsyncTimeout.
test('OnSave arguments expose the observed prevention and timeout members', async () => {
  const { runtime } = runtimeFixture();
  const seen = [];
  runtime.formContext.data.entity.addOnSave((context) => {
    const args = context.getEventArgs();
    seen.push(args.getSaveMode(), args.isDefaultPrevented(), args.shouldPreventDefaultOnError());
    args.preventDefaultOnError();
    args.disableAsyncTimeout();
    seen.push(args.shouldPreventDefaultOnError(), args.shouldDisableAsyncTimeout());
    args.preventDefault();
    seen.push(args.isDefaultPrevented());
  });
  await runtime.dispatch('onsave', undefined, 70);
  assert.deepEqual(seen, [70, false, false, true, true, true]);
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): entity.save('saveandnew') returns undefined, runs OnSave with save mode 59, saves, and then the form is a blank create form while the saved context still answers with the old id and form type 2.
test('entity.save saveandnew saves with mode 59 and leaves the saved context readable after the host opens a new record', async () => {
  const calls = [];
  let opened;
  const openedNew = new Promise((resolve) => {
    opened = resolve;
  });
  const { runtime } = runtimeFixture({
    save: async (close, mode) => {
      await runtime.dispatch('onsave', undefined, mode);
      calls.push(['save', close, mode]);
    },
    openNewRecord: async () => {
      calls.push(['openNewRecord']);
      opened();
    },
  });
  runtime.formContext.data.entity.addOnSave((context) => calls.push(['onsave', context.getEventArgs().getSaveMode()]));
  const saved = runtime.formContext;
  assert.equal(runtime.formContext.data.entity.save('saveandnew'), undefined);
  await openedNew;
  assert.deepEqual(calls, [['onsave', 59], ['save', false, 59], ['openNewRecord']]);
  assert.equal(saved.data.entity.getId(), '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}');
  assert.equal(saved.ui.getFormType(), 2);
  assert.equal(saved.getAttribute('x_name').getValue(), 'Copper');
  await assert.rejects(saved.data.save(), /replaced by a new record form/);
});

// @test-kind contract: the runtime reads the host record and baseline at each call, so a context keeps its dirty state after its form reloads in place.
test('a runtime context reads the host record and baseline current at each call', () => {
  const { runtime, host } = runtimeFixture();
  const saved = { x_itemid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', x_name: 'Saved', x_quantity: 3 };
  let current = host.record;
  let baseline;
  Object.defineProperty(host, 'record', { get: () => current, configurable: true });
  Object.defineProperty(host, 'initialRecord', { get: () => baseline, configurable: true });
  Object.defineProperty(host, 'read', { value: (name) => current[name], configurable: true });
  current = saved;
  baseline = saved;
  assert.equal(runtime.formContext.data.entity.getId(), '{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}');
  assert.equal(runtime.formContext.getAttribute('x_name').getValue(), 'Saved');
  assert.equal(runtime.formContext.getAttribute('x_name').getIsDirty(), false);
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): in an OnChange handler executionContext.getEventArgs() is undefined, getEventSource().getName() is the changed attribute name, and getDepth() is 0 for a direct fireOnChange.
test('OnChange has no event arguments and names its changed attribute as the source', async () => {
  const { runtime } = runtimeFixture();
  const seen = [];
  runtime.formContext
    .getAttribute('x_name')
    .addOnChange((context) =>
      seen.push([context.getEventArgs(), context.getEventSource().getName(), context.getDepth()]),
    );
  await runtime.formContext.getAttribute('x_name').fireOnChange();
  assert.deepEqual(seen, [[undefined, 'x_name', 0]]);
});

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): after data.refresh(false) a script OnLoad handler sees getDataLoadState() 3, and the form-registered OnLoad does not run again.
test('data.refresh reloads with load state 3 and does not run the form-registered OnLoad again', async () => {
  const form = compileForm(
    {
      id: 'refresh-form',
      xml: '<form><formLibraries><Library name="x_refresh.js"/></formLibraries><events><event name="onload"><Handlers><Handler libraryName="x_refresh.js" functionName="Invented.formLoad" enabled="true" passExecutionContext="true"/></Handlers></event></events></form>',
    },
    {},
  );
  const formRuns = [],
    scriptStates = [];
  const { runtime } = runtimeFixture({
    form,
    scope: { Invented: { formLoad: () => formRuns.push('form') } },
    extensions: {
      trusted: true,
      resources: [{ name: 'x_refresh.js', type: 'script', url: '/_apps/resources/refresh.js' }],
    },
    environment: {
      location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' },
      document: { createElement: () => ({ remove() {} }), head: { append: (script) => script.onload() } },
    },
    refresh: () => runtime.dispatch('onload', undefined, 3, { formHandlers: false }),
  });
  runtime.formContext.data.addOnLoad((context) => scriptStates.push(context.getEventArgs().getDataLoadState()));
  await runtime.dispatch('onload');
  await runtime.formContext.data.refresh(false);
  assert.deepEqual(scriptStates, [1, 3]);
  assert.deepEqual(formRuns, ['form']);
});

// @test-kind contract: a context replaced by saveandnew refuses every form-changing host call with the same error, keeps its reads, and leaves the open form's state unchanged.
test('a context replaced by saveandnew refuses each form-changing call and keeps answering reads', async () => {
  const detachedMessage = 'This form context was replaced by a new record form.';
  const tab = {
    id: 'general',
    label: 'General',
    visible: true,
    sections: [{ name: 'details', label: 'Details', visible: true }],
  };
  const shown = [],
    labels = [],
    requirements = [];
  let opened;
  const openedNew = new Promise((resolve) => {
    opened = resolve;
  });
  const { runtime, state, notices, writes } = runtimeFixture({
    form: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Invented form', clientEvents: [], tabs: [tab] },
    setLayoutVisible: (item, visible) => shown.push([item.name, visible]),
    setLayoutLabel: (item, label) => labels.push(label),
    required: (name, value) => {
      if (value !== undefined) requirements.push(value);
      return 'none';
    },
    save: async (close, mode) => {
      await runtime.dispatch('onsave', undefined, mode);
    },
    openNewRecord: async () => opened(),
  });
  const old = runtime.formContext;
  old.data.entity.save('saveandnew');
  await openedNew;
  const attempts = [
    () => old.getAttribute('x_name').setValue('Changed'),
    () => old.getControl('x_name').setDisabled(true),
    () => old.getControl('x_name').setVisible(false),
    () => old.getAttribute('x_name').setRequiredLevel('required'),
    () => old.ui.setFormNotification('Stale', 'INFO', 'stale'),
    () => old.ui.clearFormNotification('stale'),
    () => old.ui.tabs.get('general').setVisible(false),
    () => old.ui.tabs.get('general').setLabel('Stale'),
    () => old.ui.close(),
    () => old.data.save(),
    () => old.data.refresh(false),
  ];
  for (const attempt of attempts)
    assert.equal(
      await Promise.resolve()
        .then(attempt)
        .then(
          () => 'accepted',
          (error) => error.message,
        ),
      detachedMessage,
    );
  assert.equal(old.getAttribute('x_name').getValue(), 'Copper');
  assert.equal(old.data.entity.getId(), '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}');
  assert.equal(old.ui.getFormType(), 2);
  assert.deepEqual([state.size, notices.length, writes.length, shown, labels, requirements], [0, 0, 0, [], [], []]);
});
