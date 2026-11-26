// @test-kind observation: Power Pages basic form field host captured on a live site (paqvilo-developer pcf-parity summary-B: capture r2 edit-full, edit-empty-ny, read-full-ny, notify-save-ny, submit-save-ny with its read-back, capture r4 edit-full), reproduced on an invented loopback table
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROW_ID,
  controlFiles,
  emit,
  metadataFiles,
  openNativePcfSite,
  portalFiles,
  probe,
  probesReady,
  solutionFiles,
  storedRow,
} from './native-pcf-fixture.mjs';

const basicForm = (mode) =>
  `adx_entityformid: row-form\nadx_name: Row form\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: ${mode}\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false`;
const site = (columns, mode = 100000001, extra = {}) => ({
  ...portalFiles('{% entityform name:"Row form" %}'),
  'portal/Row.basicform.yml': basicForm(mode),
  ...metadataFiles('basicformmetadata', 'row-form', columns),
  ...solutionFiles(columns),
  ...extra,
});
const UNIQUE_ID = '{9C7F0A11-0001-4000-8000-000185633789}';
const COLUMNS = [
  ['tst_text', 'text'],
  ['tst_memo', 'memo'],
  ['tst_count', 'whole', null, { uniqueid: UNIQUE_ID }],
  ['tst_decimal', 'decimal'],
  ['tst_float', 'float'],
  ['tst_money', 'money'],
  ['tst_flag', 'flag'],
  ['tst_choice', 'choice'],
  ['tst_choices', 'choices'],
  ['tst_day', 'dateonly'],
  ['tst_when', 'datetime'],
  ['tst_tzi', 'tzi'],
  ['statuscode', 'status'],
  ['statecode', 'state'],
];
const FULL = {
  tst_rowid: ROW_ID,
  tst_title: 'Row',
  tst_text: 'Alpha',
  tst_memo: 'Line one\nLine two',
  tst_count: 34567,
  tst_decimal: 1234.5,
  tst_float: 1.5,
  tst_money: 1234.56,
  tst_flag: true,
  tst_choice: 2,
  tst_choices: '1,3',
  tst_day: '2026-03-15',
  tst_when: '2026-03-15T14:05:09Z',
  tst_tzi: '2026-03-15T14:05:00',
  statuscode: 1,
  statecode: 0,
};
const EMPTY = { tst_rowid: ROW_ID, tst_title: 'Row', statuscode: 1, statecode: 0 };
const value = async (page, column) => (await probe(page, column)).parameters.value;
const hidden = (page, column) => page.locator(`input[type=hidden]#${column}`).inputValue();

test('a mounted field renders the platform host markup and its hidden JSON input instead of the native control', async (t) => {
  const { app, page, errors } = await openNativePcfSite(t, site(COLUMNS), {
    rows: [FULL],
    timezoneId: 'America/New_York',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, COLUMNS.length);
  const cell = page.locator('.control[data-logical-name="tst_count"]');
  assert.equal(await cell.locator('input:not([type=hidden]), select, textarea').count(), 0);
  const host = cell.locator('> div#PcfControl_9c7f0a11000140008000000185633789');
  assert.equal(await host.getAttribute('onchange'), 'setIsDirty(this.id);');
  assert.equal(await host.locator('> span#tst_count_Container.flexbox > span#PcfControlConfig_tst_count').count(), 1);
  assert.equal(await host.locator('#tst_count_Container > div#tst_count_ControlView.flexbox').count(), 1);
  const context = JSON.parse(await page.locator('#PcfControlConfig_tst_count').getAttribute('pcf-controlcontext'));
  assert.deepEqual(context, {
    UniqueId: 'tst_count_ControlView',
    ControlId: 'tst_count',
    GridDataControlId: null,
    ControlName: 'tst_Synthetic.P_Whole_None',
    ControlProperties: { value: 34567 },
    IsDisabled: false,
    PcfControlHiddenValueId: 'tst_count',
    PcfDynamicProperyName: 'value',
  });
  const input = cell.locator('> input[type=hidden]#tst_count');
  assert.match(await input.getAttribute('name'), /\$tst_count$/);
  // Hidden values: strings quoted, numbers bare (decimal and money with the stored scale), booleans, a choice as an
  // option object, choices as an array of them, wall-clock dates without a zone and user-local dates in UTC.
  assert.deepEqual(
    {
      text: await hidden(page, 'tst_text'),
      memo: await hidden(page, 'tst_memo'),
      count: await hidden(page, 'tst_count'),
      decimal: await hidden(page, 'tst_decimal'),
      money: await hidden(page, 'tst_money'),
      flag: await hidden(page, 'tst_flag'),
      choice: await hidden(page, 'tst_choice'),
      choices: await hidden(page, 'tst_choices'),
      day: await hidden(page, 'tst_day'),
      when: await hidden(page, 'tst_when'),
      tzi: await hidden(page, 'tst_tzi'),
      status: await hidden(page, 'statuscode'),
    },
    {
      text: '"Alpha"',
      memo: '"Line one\\nLine two"',
      count: '34567',
      decimal: '1234.5000000000',
      money: '1234.5600000000',
      flag: 'true',
      choice: '{"Value":2}',
      choices: '[{"Value":1},{"Value":3}]',
      day: '"2026-03-15T00:00:00"',
      when: '"2026-03-15T14:05:09Z"',
      tzi: '"2026-03-15T14:05:00"',
      status: '{"Value":1}',
    },
  );
  assert.deepEqual(errors, []);
});

test('field host parameters carry the captured raw, formatted, attributes and security per type', async (t) => {
  const { app, page, errors } = await openNativePcfSite(t, site(COLUMNS), {
    rows: [FULL],
    timezoneId: 'America/New_York',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, COLUMNS.length);
  const shape = async (column) => {
    const item = await value(page, column);
    return [item.type, item.raw, item.formatted];
  };
  assert.deepEqual(await shape('tst_text'), ['SingleLine.Text', 'Alpha', 'Alpha']);
  assert.deepEqual(await shape('tst_memo'), ['Multiple', 'Line one\nLine two', 'Line one\nLine two']);
  assert.deepEqual(await shape('tst_count'), ['Whole.None', 34567, '34567']);
  assert.deepEqual(await shape('tst_decimal'), ['Decimal', 1234.5, '1234.5']);
  assert.deepEqual(await shape('tst_float'), ['FP', 1.5, '1.5']);
  // Currency formatted is the number itself.
  assert.deepEqual(await shape('tst_money'), ['Currency', 1234.56, 1234.56]);
  assert.deepEqual(await shape('tst_flag'), ['TwoOptions', true, 'Yes']);
  assert.deepEqual(await shape('tst_choice'), ['OptionSet', 2, 'Green']);
  assert.deepEqual(await shape('tst_choices'), ['MultiSelectOptionSet', [1, 3], 'Red;Blue;']);
  // Dates: local midnight, the instant, and the local wall clock of a time-zone-independent value, shown
  // dd/MM/yyyy[ HH:mm:ss] in the browser's zone.
  assert.deepEqual(await shape('tst_day'), [
    'DateAndTime.DateOnly',
    { date: '2026-03-15T04:00:00.000Z' },
    '15/03/2026',
  ]);
  assert.deepEqual(await shape('tst_when'), [
    'DateAndTime.DateAndTime',
    { date: '2026-03-15T14:05:09.000Z' },
    '15/03/2026 10:05:09',
  ]);
  assert.deepEqual(await shape('tst_tzi'), [
    'DateAndTime.DateAndTime',
    { date: '2026-03-15T18:05:00.000Z' },
    '15/03/2026 14:05:00',
  ]);
  assert.deepEqual(await shape('statuscode'), ['OptionSet', 1, 'Active']);
  const state = await value(page, 'statecode');
  assert.deepEqual([state.raw, state.formatted, state.attributes.Options], [null, null, []]);

  const count = await value(page, 'tst_count');
  assert.deepEqual(
    Object.fromEntries(
      ['DisplayName', 'LogicalName', 'Type', 'RequiredLevel', 'MinValue', 'MaxValue', 'MaxLength', 'Precision'].map(
        (key) => [key, count.attributes[key]],
      ),
    ),
    {
      DisplayName: 'value',
      LogicalName: 'tst_count',
      Type: 'integer',
      RequiredLevel: 0,
      MinValue: -2147483648,
      MaxValue: 2147483647,
      MaxLength: 100,
      Precision: 0,
    },
  );
  assert.deepEqual(count.security, { secured: false, editable: true, readable: true });
  assert.equal((await value(page, 'tst_memo')).attributes.MaxLength, 2000);
  assert.equal((await value(page, 'tst_memo')).attributes.Type, 'memo');
  assert.equal((await value(page, 'tst_money')).attributes.MaxValue, 922337203685477);
  assert.equal((await value(page, 'tst_float')).attributes.MinValue, 0);
  assert.equal((await value(page, 'tst_choice')).attributes.Type, 'string');
  assert.deepEqual(
    (await value(page, 'tst_choice')).attributes.Options.map((option) => [option.Label, option.Value]),
    [
      ['Red', 1],
      ['Green', 2],
      ['Blue', 3],
    ],
  );
  assert.equal((await value(page, 'tst_day')).attributes.Behavior, 2);
  assert.equal((await value(page, 'tst_day')).attributes.Format, 'date');
  assert.equal((await value(page, 'tst_tzi')).attributes.Behavior, 3);
  assert.equal((await value(page, 'tst_tzi')).attributes.Format, 'datetime');
  assert.equal((await value(page, 'tst_text')).attributes.Format, 'Text');

  // Unset static inputs: the manifest default-value is not applied.
  const parameters = (await probe(page, 'tst_text')).parameters;
  assert.deepEqual(parameters.caption, {
    raw: null,
    formatted: null,
    type: 'SingleLine.Text',
    attributes: {},
    security: {},
    error: false,
    errorMessage: null,
  });
  assert.deepEqual(
    [parameters.count.raw, parameters.count.error, parameters.count.errorMessage],
    ['NaN', true, 'Value is not a valid number'],
  );
  assert.equal(parameters.toggle.raw, null);
  // A status reason column is always disabled; the others are enabled; updatedProperties is [] at init and at the
  // first updateView.
  assert.equal((await probe(page, 'statuscode')).disabled, true);
  assert.equal((await probe(page, 'tst_text')).disabled, false);
  const events = (await probe(page, 'tst_text')).events;
  assert.deepEqual((await probe(page, 'tst_text')).updatedPropertiesAtInit, []);
  assert.deepEqual(
    events.slice(0, 2).map((event) => [event.kind, event.updatedProperties]),
    [
      ['init', undefined],
      ['updateView', []],
    ],
  );
  assert.deepEqual(errors, []);
});

test('empty columns are "", 0, false, null or undefined and their hidden inputs are empty', async (t) => {
  const { app, page, errors } = await openNativePcfSite(t, site(COLUMNS), {
    rows: [EMPTY],
    timezoneId: 'America/New_York',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, COLUMNS.length);
  const shape = async (column) => {
    const item = await value(page, column);
    return [item.raw, item.formatted];
  };
  assert.deepEqual(await shape('tst_text'), ['', '']);
  assert.deepEqual(await shape('tst_count'), [0, '0']);
  assert.deepEqual(await shape('tst_money'), [0, 0]);
  assert.deepEqual(await shape('tst_flag'), [false, 'No']);
  assert.deepEqual(await shape('tst_choice'), [null, null]);
  assert.deepEqual(await shape('tst_choices'), [null, null]);
  assert.deepEqual(await shape('tst_day'), [undefined, null]);
  assert.equal(await hidden(page, 'tst_text'), '');
  assert.equal(await hidden(page, 'tst_count'), '');
  assert.equal(await hidden(page, 'tst_day'), '');
  assert.deepEqual(errors, []);
});

test('notifyOutputChanged returns at once; getOutputs and an updateView with [] follow in a later task', async (t) => {
  const columns = [
    ['tst_count', 'whole'],
    ['tst_choice', 'choice'],
    ['tst_day', 'dateonly'],
    ['statuscode', 'status'],
  ];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [FULL],
    timezoneId: 'America/New_York',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, columns.length);
  // Synchronous view of one notify: no getOutputs before notifyOutputChanged returned.
  const order = await page.evaluate(() => {
    const probe = window.nativePcf.tst_count;
    probe.emit(4321);
    return probe.events.slice(-2).map((event) => event.kind);
  });
  assert.deepEqual(order, ['notify-before', 'notify-after']);
  await page.waitForFunction(() => window.nativePcf.tst_count.events.at(-1).kind === 'updateView');
  const count = await probe(page, 'tst_count');
  assert.deepEqual(
    count.events.slice(-4).map((event) => [event.kind, event.updatedProperties]),
    [
      ['notify-before', undefined],
      ['notify-after', undefined],
      ['getOutputs', undefined],
      ['updateView', []],
    ],
  );
  assert.equal(count.events.at(-3).returned, 'undefined');
  assert.equal(count.raw, 4321);
  assert.equal(await hidden(page, 'tst_count'), '4321');
  // A choice output writes the option object, a date its ISO instant.
  await emit(page, 'tst_choice', 3);
  assert.equal(JSON.parse(await hidden(page, 'tst_choice')).Value, 3);
  await page.evaluate(() => window.nativePcf.tst_day.emit(new Date(2026, 3, 20)));
  assert.equal(await hidden(page, 'tst_day'), '"2026-04-20T04:00:00.000Z"');
  // A disabled status reason control takes its output and stays disabled.
  await emit(page, 'statuscode', 1);
  assert.equal((await probe(page, 'statuscode')).disabled, true);
  assert.equal(JSON.parse(await hidden(page, 'statuscode')).Value, 1);
  assert.deepEqual(errors, []);
});

test('only a value change with a change event reaches the control; disabling, hiding and silent writes do not', async (t) => {
  const columns = [['tst_float', 'float']];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), { rows: [FULL] });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  const before = (await probe(page, 'tst_float')).events.length;
  await page.evaluate(() => {
    const field = document.getElementById('tst_float');
    field.disabled = true;
    field.disabled = false;
    field.readOnly = true;
    field.value = '7';
    field.closest('td').style.display = 'none';
    field.closest('td').style.display = '';
    // The page's jQuery: a value with a change event (runs jQuery handlers only).
    window.jQuery(field).val('8.5').trigger('change');
  });
  const float = await probe(page, 'tst_float');
  const after = float.events.slice(before);
  assert.deepEqual(
    after.map((event) => [event.kind, event.updatedProperties]),
    [['updateView', []]],
  );
  assert.equal(float.raw, 8.5);
  assert.equal(float.disabled, false);
  assert.equal(float.visible, true);
  assert.equal((await value(page, 'tst_float')).error, false);
  assert.deepEqual(errors, []);
});

test('a read-only form disables mounted controls and renders status columns natively', async (t) => {
  const columns = [
    ['tst_count', 'whole'],
    ['statuscode', 'status'],
  ];
  const { app, page, errors } = await openNativePcfSite(t, site(columns, 100000002), { rows: [FULL] });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  assert.equal((await probe(page, 'tst_count')).disabled, true);
  assert.deepEqual((await value(page, 'tst_count')).security, { secured: false, editable: true, readable: true });
  const host = page.locator('.control[data-logical-name="tst_count"] > div[id^=PcfControl_]');
  assert.equal(await host.getAttribute('onchange'), null);
  assert.equal(await page.locator('#tst_count_Container').getAttribute('readonly'), 'readonly');
  assert.equal(
    JSON.parse(await page.locator('#PcfControlConfig_tst_count').getAttribute('pcf-controlcontext')).IsDisabled,
    true,
  );
  assert.equal(await page.locator('#statuscode_ControlView').count(), 0);
  assert.equal(await probe(page, 'statuscode'), undefined);
  // An output still reaches the hidden input; the form has no Update or Submit button (captured,
  // capture f1|f2 readonly-actions).
  await emit(page, 'tst_count', 4321);
  assert.equal(await hidden(page, 'tst_count'), '4321');
  assert.equal(await page.locator('#UpdateButton, #InsertButton, input[type=submit]').count(), 0);
  assert.deepEqual(errors, []);
});

test('refused column types and an unconvertible static keep the native control and are listed in the summary', async (t) => {
  const columns = [
    ['tst_text', 'text'],
    ['tst_customer', 'customer'],
    ['tst_file', 'file'],
    [
      'tst_float',
      'float',
      null,
      { parameters: '<value type="FP">tst_float</value><toggle static="true" type="TwoOptions">1</toggle>' },
    ],
    [
      'tst_money',
      'money',
      null,
      {
        parameters:
          '<value type="Currency">tst_money</value><toggle static="true" type="TwoOptions">true</toggle><count static="true" type="Whole.None">12</count>',
      },
    ],
  ];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [FULL],
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 2);
  const summary = page.locator('[id^=FailePcfControlsSummary_] li');
  assert.deepEqual(await summary.allInnerTexts(), [
    'Customer data type used by tst_customer (tst_customer) is not supported for use with code components in portals. Learn more',
    'Virtual data type used by tst_file (tst_file) is not supported for use with code components in portals. Learn more',
    "Couldn't load code component for tst_float (tst_float) because of an unknown problem.",
  ]);
  // The float keeps its native box; the converted statics of the money control stand next to its value.
  assert.equal(await page.locator('input#tst_float:not([type=hidden])').count(), 1);
  const money = (await probe(page, 'tst_money')).parameters;
  assert.deepEqual([money.toggle.raw, money.toggle.formatted, money.toggle.error], [true, null, false]);
  assert.equal(money.count.raw, 12);
  const properties = JSON.parse(
    await page.locator('#PcfControlConfig_tst_money').getAttribute('pcf-controlcontext'),
  ).ControlProperties;
  assert.deepEqual([properties.toggle, properties.count, properties.value], [true, 12, 1234.56]);
  assert.deepEqual(errors, []);
});

test('a hidden field with a component renders no cell and no input, so the save leaves it as it is', async (t) => {
  const columns = [
    ['tst_text', 'text'],
    ['tst_hidden', 'text', null, { hidden: true }],
  ];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [{ ...FULL, tst_hidden: 'Kept' }],
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  assert.equal(await page.locator('[data-logical-name="tst_hidden"], #tst_hidden').count(), 0);
  await emit(page, 'tst_text', 'Changed');
  await page.locator('#UpdateButton').click();
  await page.locator('#MessageLabel').waitFor();
  assert.deepEqual([storedRow(app).tst_text, storedRow(app).tst_hidden], ['Changed', 'Kept']);
  assert.ok(app.state().diagnostics.some((entry) => entry.reason === 'PCF_NATIVE_HIDDEN_FIELD'));
  assert.deepEqual(errors, []);
});

test('a type-group property takes the first type of its group on any column', async (t) => {
  const columns = [['tst_text', 'text', null, { group: true }]];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), { rows: [FULL] });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  const item = await value(page, 'tst_text');
  assert.deepEqual(
    [item.type, item.attributes.Type, item.raw, item.formatted, item.error, item.errorMessage],
    ['Currency', 'money', 'NaN', 'NaN', true, 'Value is not a valid number'],
  );
  assert.ok(
    app.state().diagnostics.some((entry) => entry.code === 'PCF_NATIVE_TYPE_MISMATCH' && entry.severity === 'warning'),
  );
  assert.deepEqual(errors, []);
});

test('a binding to an input property or to another column mounts without a value for it', async (t) => {
  const columns = [
    [
      'tst_text',
      'text',
      null,
      { control: 'tst_Synthetic.Inputs', parameters: '<textValue type="SingleLine.Text">tst_text</textValue>' },
    ],
    [
      'tst_memo',
      'memo',
      null,
      { parameters: '<value type="Multiple">tst_memo</value><caption type="SingleLine.Text">tst_text</caption>' },
    ],
  ];
  const files = site(columns, 100000001, {
    ...controlFiles(
      'tst_Synthetic.Inputs',
      '<property name="boundText" of-type="SingleLine.Text" usage="bound"/><property name="textValue" of-type="SingleLine.Text" usage="input"/>',
    ),
  });
  const { app, page, errors } = await openNativePcfSite(t, files, { rows: [FULL] });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 2);
  const inputs = (await probe(page, 'tst_text')).parameters;
  assert.deepEqual([inputs.textValue.raw, inputs.textValue.attributes], [null, {}]);
  assert.deepEqual([inputs.boundText.raw, inputs.boundText.attributes.LogicalName], [null, 'tst_text']);
  const context = JSON.parse(await page.locator('#PcfControlConfig_tst_text').getAttribute('pcf-controlcontext'));
  assert.deepEqual([context.ControlProperties, context.PcfDynamicProperyName], [{}, null]);
  assert.equal(await hidden(page, 'tst_text'), '');
  const memo = (await probe(page, 'tst_memo')).parameters;
  assert.equal(memo.value.raw, 'Line one\nLine two');
  assert.equal(memo.caption.raw, null);
  assert.deepEqual(errors, []);
});

for (const transport of ['postback', 'json'])
  test(`a save decodes the hidden inputs as the platform stored them (${transport} transport)`, async (t) => {
    const columns = [
      ['tst_text', 'text'],
      ['tst_count', 'whole'],
      ['tst_flag', 'flag'],
      ['tst_choice', 'choice'],
      ['tst_choices', 'choices'],
      ['tst_when', 'datetime'],
      ['tst_tzi', 'tzi'],
    ];
    const { app, page, errors } = await openNativePcfSite(t, site(columns), {
      rows: [FULL],
      timezoneId: 'America/New_York',
      ...(transport === 'json'
        ? { observed: { nativeFormTransport: 'json', evidence: 'invented loopback transport' } }
        : {}),
    });
    await page.goto(`${app.url}/?id=${ROW_ID}`);
    await probesReady(page, app, columns.length);
    await emit(page, 'tst_text', 'Beta');
    await emit(page, 'tst_count', 4321);
    await emit(page, 'tst_flag', false);
    await emit(page, 'tst_choice', 3);
    await emit(page, 'tst_choices', [2]);
    // A time-zone-independent column stores the UTC clock of the output.
    await page.evaluate(() => window.nativePcf.tst_when.emit(new Date('2026-04-20T09:15:00Z')));
    await page.evaluate(() => window.nativePcf.tst_tzi.emit(new Date('2026-04-20T09:15:00Z')));
    await page.locator('#UpdateButton').click();
    await page.locator('#MessageLabel').waitFor();
    const row = storedRow(app);
    assert.deepEqual(
      {
        text: row.tst_text,
        count: Number(row.tst_count),
        flag: row.tst_flag,
        choice: Number(row.tst_choice),
        choices: String(row.tst_choices),
        when: new Date(row.tst_when).toISOString(),
      },
      { text: 'Beta', count: 4321, flag: false, choice: 3, choices: '2', when: '2026-04-20T09:15:00.000Z' },
    );
    assert.match(String(row.tst_tzi), /^2026-04-20T09:15:00/);
    assert.deepEqual(errors, []);
  });

// @test-kind observation: the platform posts toISOString() and stores the UTC date part of a date-only output, so east of UTC local midnight saves the previous day (paqvilo-developer pcf-parity capture r2 submit-save for New York, capture f1|f2 kyiv-save for Kyiv, identical)
for (const [timezoneId, day, saved] of [
  ['America/New_York', [2026, 3, 20], '2026-04-20'],
  ['Europe/Kyiv', [2026, 4, 10], '2026-05-09'],
])
  test(`a date-only output of local midnight saves the UTC calendar date (${timezoneId})`, async (t) => {
    const columns = [['tst_day', 'dateonly']];
    const { app, page, errors } = await openNativePcfSite(t, site(columns), { rows: [FULL], timezoneId });
    await page.goto(`${app.url}/?id=${ROW_ID}`);
    await probesReady(page, app, 1);
    await page.evaluate(([year, month, date]) => window.nativePcf.tst_day.emit(new Date(year, month, date)), day);
    await page.locator('#UpdateButton').click();
    await page.locator('#MessageLabel').waitFor();
    assert.match(String(storedRow(app).tst_day), new RegExp('^' + saved));
    assert.deepEqual(errors, []);
  });

// @test-kind observation: a FormXml binding of an input property posts "" and the save keeps the column (paqvilo-developer pcf-parity readback-r2-after-submit and the f1/f2 save read-backs: pqpcf_ticker kept "ALPH")
for (const transport of ['postback', 'json'])
  test(`a field bound to an input property posts nothing and the save keeps the column (${transport} transport)`, async (t) => {
    const columns = [
      [
        'tst_text',
        'text',
        null,
        { control: 'tst_Synthetic.Inputs', parameters: '<textValue type="SingleLine.Text">tst_text</textValue>' },
      ],
      ['tst_memo', 'memo'],
    ];
    const files = site(columns, 100000001, {
      ...controlFiles(
        'tst_Synthetic.Inputs',
        '<property name="boundText" of-type="SingleLine.Text" usage="bound"/><property name="textValue" of-type="SingleLine.Text" usage="input"/>',
      ),
    });
    const { app, page, errors } = await openNativePcfSite(t, files, {
      rows: [FULL],
      ...(transport === 'json'
        ? { observed: { nativeFormTransport: 'json', evidence: 'invented loopback transport' } }
        : {}),
    });
    await page.goto(`${app.url}/?id=${ROW_ID}`);
    await probesReady(page, app, 2);
    assert.equal(await hidden(page, 'tst_text'), '');
    await emit(page, 'tst_memo', 'Changed memo');
    await page.locator('#UpdateButton').click();
    await page.locator('#MessageLabel').waitFor();
    assert.deepEqual([storedRow(app).tst_text, storedRow(app).tst_memo], ['Alpha', 'Changed memo']);
    assert.deepEqual(errors, []);
  });

// @test-kind unproven+observation: LOCAL MODEL for a de-DE site (comma decimal separator): the hidden JSON stays invariant and saves use the posted digits; the field parameters equal the en-US ones (paqvilo-developer pcf-parity summary-E de-DE k1/k2 edit-full-de: DateOnly 15/03/2026, formatted values as on en-US)
for (const transport of ['postback', 'json'])
  test(`a comma-decimal site keeps invariant hidden numbers and dates (${transport} transport)`, async (t) => {
    const columns = [
      ['tst_float', 'float'],
      ['tst_money', 'money'],
      ['tst_day', 'dateonly'],
    ];
    const files = {
      ...site(columns),
      ...portalFiles('{% entityform name:"Row form" %}', { german: true }),
    };
    const { app, page, errors } = await openNativePcfSite(t, files, {
      rows: [FULL],
      timezoneId: 'Europe/Berlin',
      ...(transport === 'json'
        ? { observed: { nativeFormTransport: 'json', evidence: 'invented loopback transport' } }
        : {}),
    });
    await page.goto(`${app.url}/?id=${ROW_ID}`);
    await probesReady(page, app, columns.length);
    assert.equal(await hidden(page, 'tst_float'), '1.5');
    assert.equal(await hidden(page, 'tst_money'), '1234.5600000000');
    assert.deepEqual(
      [(await value(page, 'tst_float')).formatted, (await value(page, 'tst_day')).formatted],
      ['1.5', '15/03/2026'],
    );
    // Currency formatted is the number itself, as on an en-US page.
    assert.equal((await value(page, 'tst_money')).formatted, 1234.56);
    await emit(page, 'tst_float', 2.25);
    await emit(page, 'tst_money', 3456.78);
    await page.locator('#UpdateButton').click();
    await page.locator('#MessageLabel').waitFor();
    assert.deepEqual([Number(storedRow(app).tst_float), Number(storedRow(app).tst_money)], [2.25, 3456.78]);
    assert.deepEqual(errors, []);
  });

// @test-kind unproven: an east-of-UTC zone beyond the captured Kyiv case (Pacific/Auckland) follows the same captured rule; no Auckland capture exists
test('a date-only output of local midnight in Auckland saves the previous UTC day', async (t) => {
  const columns = [['tst_day', 'dateonly']];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [FULL],
    timezoneId: 'Pacific/Auckland',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  await page.evaluate(() => window.nativePcf.tst_day.emit(new Date(2026, 3, 20)));
  await page.locator('#UpdateButton').click();
  await page.locator('#MessageLabel').waitFor();
  assert.match(String(storedRow(app).tst_day), /^2026-04-19/);
  assert.deepEqual(errors, []);
});

// @test-kind observation: a script-tampered hidden input: "" clears the column, the text "null" and text that is not JSON fail the save with HTTP 500 and save nothing (paqvilo-developer pcf-parity capture g1 tamper saves, a single load per case)
for (const transport of ['postback', 'json'])
  test(`a tampered hidden input clears the column on "" and fails the save on null or text that is not JSON (${transport} transport)`, async (t) => {
    const columns = [
      ['tst_text', 'text'],
      ['tst_memo', 'memo'],
    ];
    const { app, page } = await openNativePcfSite(t, site(columns), {
      rows: [FULL],
      ...(transport === 'json'
        ? { observed: { nativeFormTransport: 'json', evidence: 'invented loopback transport' } }
        : {}),
    });
    const responses = [];
    page.on('response', (response) => {
      if (response.request().method() === 'POST') responses.push(response.status());
    });
    for (const [text, status] of [
      ['null', 500],
      ['not json', 500],
    ]) {
      await page.goto(`${app.url}/?id=${ROW_ID}`);
      await probesReady(page, app, 2);
      await page.evaluate((value) => {
        document.getElementById('tst_text').value = value;
      }, text);
      const response = page.waitForResponse((item) => item.request().method() === 'POST');
      await page.locator('#UpdateButton').click();
      assert.equal((await response).status(), status, text);
      assert.deepEqual([storedRow(app).tst_text, storedRow(app).tst_memo], ['Alpha', 'Line one\nLine two'], text);
    }
    await page.goto(`${app.url}/?id=${ROW_ID}`);
    await probesReady(page, app, 2);
    await page.evaluate(() => {
      document.getElementById('tst_text').value = '';
    });
    await page.locator('#UpdateButton').click();
    await page.locator('#MessageLabel').waitFor();
    assert.equal(storedRow(app).tst_text ?? null, null);
    assert.equal(responses.at(-1), 200);
  });

// @test-kind observation: an output of the wrong type is JSON-encoded into the hidden input and the column's native validators refuse the save with the captured messages; nothing is saved (paqvilo-developer pcf-parity capture g1 save-wrongtype, one load). Mirage's number validators are server-side, so the refusal comes back from the postback instead of stopping it in the browser
for (const transport of ['postback', 'json'])
  test(`a wrong-type output is posted as it is and refused by the column validators (${transport} transport)`, async (t) => {
    const columns = [['tst_count', 'ranged']];
    const { app, page, errors } = await openNativePcfSite(t, site(columns), {
      rows: [{ ...FULL, tst_count: 5 }],
      ...(transport === 'json'
        ? { observed: { nativeFormTransport: 'json', evidence: 'invented loopback transport' } }
        : {}),
    });
    await page.goto(`${app.url}/?id=${ROW_ID}`);
    await probesReady(page, app, 1);
    await emit(page, 'tst_count', 'abc');
    assert.equal(await hidden(page, 'tst_count'), '"abc"');
    assert.equal((await probe(page, 'tst_count')).raw, 'abc');
    await page.locator('#UpdateButton').click();
    const summary = page.locator('.validation-summary').first();
    await summary.locator('li').first().waitFor();
    assert.match(await summary.innerText(), /The form could not be submitted for the following reasons:/);
    assert.deepEqual(
      (await summary.locator('li').allInnerTexts()).map((item) => item.trim()),
      ['tst_count must be a valid integer value.', 'tst_count must have a value between -100000 and 100000.'],
    );
    assert.equal(storedRow(app).tst_count, 5);
    assert.deepEqual(errors, []);
  });

// @test-kind observation: attribute values of further text and whole number formats and of a required column (paqvilo-developer pcf-parity capture f1|f2 edit-full, FormXml v5)
test('phone, ticker, long text, duration and required columns report the captured attributes', async (t) => {
  const columns = [
    ['tst_phone', 'phone'],
    ['tst_ticker', 'ticker'],
    ['tst_long', 'longtext'],
    ['tst_minutes', 'duration'],
    ['tst_required', 'required'],
  ];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [
      { ...FULL, tst_phone: '+1 555 0100', tst_ticker: 'ALPH', tst_long: 'Long', tst_minutes: 90, tst_required: 'Set' },
    ],
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, columns.length);
  const attributes = async (column) => {
    const item = await value(page, column);
    return [item.attributes.Format, item.attributes.MaxLength, item.attributes.RequiredLevel];
  };
  assert.deepEqual(await attributes('tst_phone'), ['Phone', 50, 0]);
  assert.deepEqual(await attributes('tst_ticker'), ['TickerSymbol', 10, 0]);
  assert.deepEqual(await attributes('tst_long'), ['Text', 100, 0]);
  assert.deepEqual(await attributes('tst_required'), ['Text', 100, 0]);
  const minutes = await value(page, 'tst_minutes');
  assert.deepEqual(
    [
      minutes.type,
      minutes.raw,
      minutes.formatted,
      minutes.attributes.Format,
      minutes.attributes.MinValue,
      minutes.attributes.MaxValue,
    ],
    ['Whole.Duration', 90, '90', '0', -2147483648, 2147483647],
  );
  assert.deepEqual(errors, []);
});
