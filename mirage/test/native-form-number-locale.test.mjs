// @test-kind observation: Power Pages Basic Form native number boxes and Dataverse postback readbacks from the external fixture runs e1/e2 (en-US) and k1/k2 (de-DE) in evidence summary E, repeated twice per locale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runInNewContext } from 'node:vm';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds, nativeFormPostbackDescriptor } from '../lib/native-postback.mjs';
import { nativeRangeBounds, nativeRangeMessage, renderComponent } from '../lib/platform.mjs';
import { submitNativePostback } from '../lib/native-form-submission.mjs';
import { DataStore } from '../lib/data.mjs';
import { client, formBody } from './support/external-sign-in.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const numericFields = [
  { name: 'quantity', label: 'Quantity', dataverseType: 'decimal', precision: 2 },
  { name: 'measurement', label: 'Measurement', dataverseType: 'float', precision: 3 },
  { name: 'charge', label: 'Charge', dataverseType: 'money', precision: 2 },
];
const fields = [
  ...numericFields.map((field) => ({ ...field, minimum: -1000000, maximum: 1000000 })),
  { name: 'count', dataverseType: 'int', minimum: -100000, maximum: 100000 },
];
const routes = {
  en: '/en-US/?id=sample-en',
  de: '/de-DE/?id=sample-de',
  fr: '/fr-FR/?id=sample-fr',
  ja: '/ja-JP/?id=sample-ja',
};
const controls = nativeFormControlIds('entityform', 'numbers');
const seed = { quantity: 1.5, measurement: 1.5, charge: 1.5, count: 1500 };
// Two auto-generated step tabs: the first tab's value travels in __VIEWSTATE to the second tab's Insert.
const stepTab = (name, field) => ({
  name,
  label: name,
  showLabel: true,
  columns: [{ width: '100%', sections: [{ name, label: name, rows: [[{ name: field }]] }] }],
});
const tabLayout = [stepTab('first', 'quantity'), stepTab('second', 'measurement')];
const FORM_MODE = { insert: 100000000, edit: 100000001, readOnly: 100000002 };

async function fixture(
  t,
  nativeFormTransport = 'postback',
  {
    customRangeMessage,
    mode = FORM_MODE.edit,
    fieldOverrides = {},
    wizard = false,
    autoSteps = false,
    numberCultures,
  } = {},
) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-form-number-locale-'));
  const owned = ownedFixture(t);
  owned.remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Number boxes\nadx_defaultlanguage: en\nadx_website_language: 1033',
    'websitelanguage.yml':
      '- adx_websitelanguageid: en\n  adx_languagecode: en-US\n  adx_lcid: 1033\n- adx_websitelanguageid: de\n  adx_languagecode: de-DE\n  adx_lcid: 1031' +
      '\n- adx_websitelanguageid: fr\n  adx_languagecode: fr-FR\n  adx_lcid: 1036\n- adx_websitelanguageid: ja\n  adx_languagecode: ja-JP\n  adx_lcid: 1041',
    'sitesetting.yml':
      'adx_sitesettingid: language-url\nadx_name: MultiLanguage/DisplayLanguageCodeInURL\nadx_value: "true"',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Home-en.webpage.yml':
      'adx_webpageid: home-en\nadx_name: Home\nadx_rootwebpageid: home\nadx_webpagelanguageid: en\nadx_isroot: false\nadx_pagetemplateid: template',
    'Home-de.webpage.yml':
      'adx_webpageid: home-de\nadx_name: Startseite\nadx_rootwebpageid: home\nadx_webpagelanguageid: de\nadx_isroot: false\nadx_pagetemplateid: template',
    'Home-fr.webpage.yml':
      'adx_webpageid: home-fr\nadx_name: Accueil\nadx_rootwebpageid: home\nadx_webpagelanguageid: fr\nadx_isroot: false\nadx_pagetemplateid: template',
    'Home-ja.webpage.yml':
      'adx_webpageid: home-ja\nadx_name: Home ja\nadx_rootwebpageid: home\nadx_webpagelanguageid: ja\nadx_isroot: false\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':
      '<!doctype html><html><body><form id="liquid_form">{% entityform name: "Numbers" %}</form></body></html>',
    'Numbers.basicform.yml':
      'adx_entityformid: numbers\nadx_name: Numbers\nadx_mode: ' +
      mode +
      '\nadx_recordidquerystringparametername: id\nadx_successmessage: Saved number boxes\nadx_hideformonsuccess: false',
  };
  if (wizard) {
    files['Main.webtemplate.source.html'] =
      '<!doctype html><html><body><form id="liquid_form">{% webform name: "Wizard" %}</form></body></html>';
    files['Wizard.advancedform.yml'] = 'adx_webformid: wizard\nadx_name: Wizard';
  }
  if (autoSteps) files['Numbers.basicform.yml'] += '\nadx_autogeneratesteps: true\nadx_nextbuttontext: Next tab';
  if (customRangeMessage)
    files['Quantity.basicformmetadata.yml'] =
      'adx_entityformmetadataid: quantity-range\nadx_entityform: numbers\nadx_type: 100000000\nadx_attributelogicalname: quantity\nadx_rangevalidationerrormessage: ' +
      JSON.stringify(customRangeMessage);
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const schemaFields = fields.map((field) => ({ ...field, ...fieldOverrides[field.name] }));
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          fields: Object.fromEntries(fields.map((field) => [field.name, field])),
        },
      },
      tables: { sample: ['en', 'de'].map((language) => ({ sampleid: 'sample-' + language, ...seed })) },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        observed: {
          nativeFormTransport,
          ...(numberCultures ? { nativeNumberCultures: numberCultures } : {}),
          evidence: 'Invented locale fixture',
        },
        componentSchemas: {
          numbers: { entity: 'sample', fields: schemaFields, ...(autoSteps ? { layout: tabLayout } : {}) },
          wizard: {
            initialStepId: 'numbers-step',
            steps: [{ stepId: 'numbers-step', entity: 'sample', mode: FORM_MODE.insert, fields: schemaFields }],
          },
        },
      },
    },
  });
  owned.add(() => app.close());
  return app;
}

const input = (html, name) => {
  const tag = html.match(new RegExp('<input[^>]*\\bid="' + name + '"[^>]*>'))?.[0];
  assert.ok(tag, 'native input for ' + name);
  return tag;
};
const boxAttr = (html, name, attribute) => input(html, name).match(new RegExp('\\s' + attribute + '="([^"]*)"'))?.[1];
const boxValues = (html) => fields.map(({ name }) => boxAttr(html, name, 'value'));

async function getPage(app, locale) {
  const response = await fetch(app.url + routes[locale]);
  assert.equal(response.status, 200);
  return response.text();
}

async function nativePost(app, locale, value) {
  const browser = client(app);
  const page = await browser.request(routes[locale]);
  assert.equal(page.status, 200);
  const rendered = await page.text();
  const viewState = boxAttr(rendered, '__VIEWSTATE', 'value');
  assert.ok(viewState);
  const tokenResponse = await browser.request('/_layout/tokenhtml');
  assert.equal(tokenResponse.status, 200);
  const token = /value="([^"]+)"/.exec(await tokenResponse.text())?.[1];
  assert.ok(token);
  const response = await browser.request(
    routes[locale],
    formBody({
      __EVENTTARGET: controls.buttons + 'UpdateButton',
      __EVENTARGUMENT: '',
      __VIEWSTATE: viewState,
      __RequestVerificationToken: token,
      ...Object.fromEntries(numericFields.map(({ name }) => [controls.names + name, value])),
    }),
  );
  assert.equal(response.status, 200);
  return response.text();
}

async function readStoredFields(app, locale) {
  const row = await app.store.readOperation(() => app.store.get('sample', 'sample-' + locale, { roles: [] }));
  return fields.map(({ name }) => row[name]);
}

// The number boxes of the page culture: as rendered from the seed, their separator attribute, and grouped thousands.
async function assertNumberBoxes(app, locale, { fixed, grouped, separator }) {
  const initial = await getPage(app, locale);
  assert.deepEqual(boxValues(initial), fixed);
  assert.deepEqual(
    fields.map(({ name }) => boxAttr(initial, name, 'data-numberdecimalseparator')),
    [undefined, separator, undefined, undefined],
  );
  await app.store.update(
    'sample',
    'sample-' + locale,
    { quantity: 12345, measurement: 12345, charge: 12345 },
    { roles: [] },
  );
  assert.deepEqual(boxValues(await getPage(app, locale)), grouped);
}

for (const [locale, fixed, grouped, separator] of [
  ['en', ['1.50', '1.500', '1.50', '1500'], ['12,345.00', '12,345.000', '12,345.00', '1500'], '.'],
  ['de', ['1,50', '1,500', '1,50', '1500'], ['12.345,00', '12.345,000', '12.345,00', '1500'], ','],
]) {
  test('native Basic Form initial and grouped number boxes in ' + locale, async (t) => {
    await assertNumberBoxes(await fixture(t), locale, { fixed, grouped, separator });
  });

  test('native Basic Form posts decimal/grouping marks in ' + locale, async (t) => {
    const app = await fixture(t);
    for (const [text, expected] of [
      ['1234,5', locale === 'de' ? 1234.5 : 12345],
      ['1234.5', locale === 'de' ? 12345 : 1234.5],
    ]) {
      const html = await nativePost(app, locale, text);
      assert.deepEqual(await readStoredFields(app, locale), [expected, expected, expected, 1500]);
      assert.deepEqual(boxValues(html), [text, text, text, '1500']);
    }
  });
}

// @test-kind contract: selecting Mirage's JSON transport keeps the existing invariant markup and comma-aware manifest.
test('JSON transport retains the German Basic Form defaults and field manifest', async (t) => {
  const app = await fixture(t, 'json');
  const html = await getPage(app, 'de');
  assert.deepEqual(boxValues(html), ['1.50', '1.500', '1.50', '1500']);
  const formConfig = JSON.parse(html.match(/data-paqvilo-mirage-form-config>([^<]+)</)?.[1]);
  assert.equal(formConfig.transport, undefined);
  assert.deepEqual(
    formConfig.fields.map(({ name, decimalSeparator }) => [name, decimalSeparator]),
    [
      ['quantity', ','],
      ['measurement', undefined],
      ['charge', ','],
      ['count', undefined],
    ],
  );
});

// The validator expandos of the page's startup script, by validator id.
function pageValidators(html) {
  const [, script] = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)].find(([, text]) =>
    text.includes('var Page_ValidationSummaries = (window.Page_ValidationSummaries'),
  );
  const nodes = new Map();
  runInNewContext(script, {
    window: {},
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, {});
        return nodes.get(id);
      },
    },
  });
  return nodes;
}

function rangeValidators(html) {
  const nodes = pageValidators(html);
  return fields.map(({ name }) => nodes.get('RangeValidator' + name));
}

const rangeCopy = {
  en: [
    'Quantity must have a value between -1,000,000.00 and 1,000,000.00.',
    'Measurement must have a value between -1,000,000.000 and 1,000,000.000.',
    'Charge must have a value between -1,000,000.00 and 1,000,000.00.',
  ],
  de: [
    'Quantity muss einen Wert zwischen -1.000.000,00 und 1.000.000,00 haben.',
    'Measurement muss einen Wert zwischen -1.000.000,000 und 1.000.000,000 haben.',
    'Charge muss einen Wert zwischen -1.000.000,00 und 1.000.000,00 haben.',
  ],
};

for (const [locale, expected] of Object.entries(rangeCopy)) {
  test('native Basic Form range validator copy uses the source precision in ' + locale, async (t) => {
    const app = await fixture(t);
    const [decimal, floating, money] = rangeValidators(await getPage(app, locale));
    for (const [index, validator] of [decimal, floating, money].entries()) {
      assert.equal(validator.evaluationfunction, 'CustomValidatorEvaluateIsValid');
      assert.ok(validator.errormessage.includes(expected[index]), validator.errormessage);
    }
  });
}

// @test-kind contract: Mirage's rejected native response and configured stock-range validator preserve authored messaging and reuse the same localized default.
test('German rejected native post displays localized range defaults and preserves the authored override', async (t) => {
  const customRangeMessage = 'Author-supplied quantity range';
  const app = await fixture(t, 'postback', { customRangeMessage });
  const expected = [customRangeMessage, ...rangeCopy.de.slice(1)];
  const initial = rangeValidators(await getPage(app, 'de'));
  const rejected = await nativePost(app, 'de', '2000000');
  const summary = rejected.match(/id="ValidationSummary[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(summary);
  const validators = rangeValidators(rejected);
  for (const [index, message] of expected.entries()) {
    assert.ok(summary.includes(message), summary);
    assert.equal(validators[index].isvalid, 'False');
    assert.ok(initial[index].errormessage.includes(message), initial[index].errormessage);
  }
  assert.deepEqual(await readStoredFields(app, 'de'), Object.values(seed));
});

// Posts the rendered form's own control names (a modal form uses its own naming container).
async function postRendered(app, route, values, status = 200) {
  const browser = client(app);
  const page = await browser.request(route);
  assert.equal(page.status, 200);
  const rendered = await page.text();
  const button = /name="([^"]*\$(?:UpdateButton|InsertButton|NextButton))"/.exec(rendered)?.[1];
  assert.ok(button, 'native save button');
  const tokenResponse = await browser.request('/_layout/tokenhtml');
  assert.equal(tokenResponse.status, 200);
  const response = await browser.request(
    route,
    formBody({
      __EVENTTARGET: button,
      __EVENTARGUMENT: '',
      __VIEWSTATE: boxAttr(rendered, '__VIEWSTATE', 'value'),
      __RequestVerificationToken: /value="([^"]+)"/.exec(await tokenResponse.text())?.[1],
      ...Object.fromEntries(Object.entries(values).map(([name, text]) => [boxAttr(rendered, name, 'name'), text])),
    }),
  );
  assert.equal(response.status, status);
  return { rendered, html: await response.text() };
}
const typed = (text) => Object.fromEntries(numericFields.map(({ name }) => [name, text]));
const germanFixed = ['1,50', '1,500', '1,50', '1500'];

// @test-kind unproven: the e1/e2 and k1/k2 captures are edit forms; an insert form is assumed to use the same stock number box culture parse (one control template for every form mode)
test('native insert Basic Forms parse the page culture decimal and grouping marks', async (t) => {
  for (const [route, expected] of [
    ['/de-DE/', 1234.5],
    ['/en-US/', 12345],
  ])
    await t.test(route, async (t) => {
      const app = await fixture(t, 'postback', { mode: FORM_MODE.insert });
      const { html } = await postRendered(app, route, typed('1234,5'));
      assert.match(html, /Saved number boxes/);
      const rows = app.store.tableRows('sample');
      assert.equal(rows.length, 3);
      assert.deepEqual(
        numericFields.map(({ name }) => rows.at(-1)[name]),
        [expected, expected, expected],
      );
    });
});

// @test-kind unproven: the captures are writable edit forms; read-only forms and read-only fields are assumed to show the same culture-formatted value (one control template, read-only markup only)
test('read-only Basic Forms and read-only fields show the page culture number format', async (t) => {
  const readOnlyForm = await fixture(t, 'postback', { mode: FORM_MODE.readOnly });
  assert.deepEqual(boxValues(await getPage(readOnlyForm, 'de')), germanFixed);
  assert.deepEqual(boxValues(await getPage(readOnlyForm, 'en')), ['1.50', '1.500', '1.50', '1500']);
  const readOnlyField = await fixture(t, 'postback', { fieldOverrides: { quantity: { readOnly: true } } });
  const page = await getPage(readOnlyField, 'de');
  assert.match(input(page, 'quantity'), /readonly="readonly"/);
  assert.deepEqual(boxValues(page), germanFixed);
});

// @test-kind unproven: list create/edit dialogs host the same Basic Form; their number boxes are assumed to follow the captured page-culture format and parse
test('modal Basic Forms format and parse numbers in the page culture', async (t) => {
  const app = await fixture(t);
  const route = '/de-DE/_portal/modal-form-template-path/site?entityformid=numbers&id=sample-de';
  const { rendered } = await postRendered(app, route, typed('1234,5'));
  assert.deepEqual(boxValues(rendered), germanFixed);
  assert.deepEqual(await readStoredFields(app, 'de'), [1234.5, 1234.5, 1234.5, 1500]);
});

// @test-kind unproven: a desktop custom control the portal does not enable leaves the stock native box; its culture format is assumed to match the captured stock boxes
test('a field whose exported desktop control is not enabled for the portal keeps the localized native box', async (t) => {
  const codeComponent = (name) => ({
    name: 'contoso.Slider',
    sourceFile: 'form.xml',
    boundAttributes: [name],
    parameters: { value: { kind: 'binding', column: name, type: 'Decimal' } },
  });
  const app = await fixture(t, 'postback', {
    fieldOverrides: Object.fromEntries(numericFields.map(({ name }) => [name, { codeComponent: codeComponent(name) }])),
  });
  const page = await getPage(app, 'de');
  assert.doesNotMatch(page, /<div id="PcfControl_/);
  for (const { name } of numericFields) assert.match(input(page, name), /type="text"/);
  assert.deepEqual(boxValues(page), germanFixed);
  const [quantity] = rangeValidators(page);
  assert.ok(quantity.errormessage.includes(rangeCopy.de[0]), quantity.errormessage);
  await nativePost(app, 'de', '1234,5');
  assert.deepEqual(await readStoredFields(app, 'de'), [1234.5, 1234.5, 1234.5, 1500]);
});

// @test-kind contract: Mirage's field host posts a mounted component's value as JSON in its hidden input (lib/pcf-field-host.mjs); the decoder never applies page-culture number rules to it
test('a mounted code component value is decoded as JSON beside a German native number box', async () => {
  const identity = { roles: ['Editor'] };
  const store = await new DataStore({
    state: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
      tables: { sample: [{ sampleid: 'owned', amount: 5, native: 5 }] },
      permissions: [{ entity: 'sample', scope: 'global', roles: identity.roles, operations: ['read', 'update'] }],
      settings: { permissionMode: 'enforce' },
    },
  }).init();
  const bounds = { dataverseType: 'decimal', type: 'number', precision: 2, minimum: -1000000, maximum: 1000000 };
  const schemaFields = [
    {
      name: 'amount',
      label: 'Amount',
      ...bounds,
      codeComponent: {
        name: 'tst_Synthetic.Probe',
        sourceFile: 'row-form.xml',
        boundAttributes: ['amount'],
        parameters: { value: { kind: 'binding', column: 'amount', type: 'Decimal' } },
      },
    },
    { name: 'native', label: 'Native', ...bounds },
  ];
  const options = {
    store,
    identity,
    portal: {
      forms: [{ id: 'entry', name: 'Entry', mode: FORM_MODE.edit, metadata: {} }],
      records: [
        {
          kind: 'basicformmetadata',
          adx_entityform: 'entry',
          adx_attributelogicalname: 'amount',
          adx_type: 100000000,
          adx_controlstyle: 756150001,
        },
      ],
    },
    schemas: {
      entry: {
        entity: 'sample',
        fields: schemaFields,
        layout: [{ columns: [{ sections: [{ rows: [[{ name: 'amount' }], [{ name: 'native' }]] }] }] }],
      },
    },
    requestUrl: 'http://localhost/de-DE/?id=owned',
  };
  const rendered = [];
  const html = String(
    await renderComponent(
      'entityform',
      'Entry',
      { user: identity, request: { params: { id: 'owned' } }, __language: { lcid: 1031 } },
      {
        ...options,
        observed: { nativeFormTransport: 'postback' },
        onNativePostbackDescriptor: (item) => rendered.push(item),
        codeComponent: async (spec) => {
          spec.onNativeBinding?.({ properties: ['value'] }, {});
          return '<script src="/__sim-static/pcf-host.js"></script><div></div>';
        },
      },
    ).then((result) => result?.html ?? result),
  );
  assert.match(html, /<input type="hidden" name="[^"]*\$amount" id="amount"/);
  assert.equal(boxAttr(html, 'native', 'value'), '5,00');
  const [{ descriptor }] = rendered;
  const posted = Object.fromEntries(descriptor.fields.map((field) => [field.name, field]));
  assert.equal(posted.amount.pcf, true);
  assert.equal(posted.amount.numberLocale, undefined);
  assert.equal(posted.native.numberLocale, 'de-DE');
  // Under de-DE rules "1234.5" would read as 12345; the hidden input is JSON.
  await submitNativePostback(
    [
      ['__EVENTTARGET', descriptor.actions.find((action) => action.action === 'submit').target],
      [posted.amount.wireName, '1234.5'],
      [posted.native.wireName, '1234,5'],
    ],
    rendered,
    options,
  );
  const [row] = store.tableRows('sample');
  assert.deepEqual([row.amount, row.native], [1234.5, 1234.5]);
});

// @test-kind compatibility: Microsoft.Xrm.Sdk.Metadata Integer/Decimal/Double/MoneyAttributeMetadata MinSupportedValue and MaxSupportedValue (Microsoft Learn) supply a bound the exported metadata omits
test('a range bound the metadata omits is the column type supported limit', () => {
  const field = (dataverseType, precision, bounds) => ({
    name: 'quantity',
    label: 'Quantity',
    dataverseType,
    ...(precision == null ? {} : { precision }),
    ...bounds,
  });
  for (const [column, locale, expected] of [
    [
      field('decimal', 2, { minimum: 1000 }),
      undefined,
      'Quantity must have a value between 1000.00 and 100000000000.00.',
    ],
    [
      field('decimal', 2, { minimum: 1000 }),
      'en-US',
      'Quantity must have a value between 1,000.00 and 100,000,000,000.00.',
    ],
    [
      field('decimal', 2, { minimum: 1000 }),
      'de-DE',
      'Quantity muss einen Wert zwischen 1.000,00 und 100.000.000.000,00 haben.',
    ],
    [
      field('decimal', 2, { maximum: 1000000 }),
      'de-DE',
      'Quantity muss einen Wert zwischen -100.000.000.000,00 und 1.000.000,00 haben.',
    ],
    [field('float', 3, { minimum: 0 }), 'en-US', 'Quantity must have a value between 0.000 and 100,000,000,000.000.'],
    [
      field('money', 2, { maximum: 5 }),
      'en-US',
      'Quantity must have a value between -922,337,203,685,477.00 and 5.00.',
    ],
    [field('int', null, { minimum: 0 }), undefined, 'Quantity must have a value between 0 and 2147483647.'],
    [field('int', null, { maximum: 10 }), 'de-DE', 'Quantity muss einen Wert zwischen -2147483648 und 10 haben.'],
    [
      field('decimal', 2, { minimum: -1, maximum: 1 }),
      'de-DE',
      'Quantity muss einen Wert zwischen -1,00 und 1,00 haben.',
    ],
  ])
    assert.equal(nativeRangeMessage(column, locale), expected);
  // A column without any configured bound keeps no range.
  assert.deepEqual(nativeRangeBounds(field('decimal', 2, {})), [null, null]);
  assert.deepEqual(nativeRangeBounds(field('int', null, { minValue: 5 })), [5, 2147483647]);
});

// @test-kind compatibility: Microsoft.Xrm.Sdk.Metadata DecimalAttributeMetadata.MaxSupportedValue (Microsoft Learn) bounds a column whose exported metadata states only its minimum
test('a single-bound field validates and reports the supported limit in the page language', async (t) => {
  const app = await fixture(t, 'postback', { fieldOverrides: { quantity: { minimum: 0, maximum: undefined } } });
  const expected = {
    de: 'Quantity muss einen Wert zwischen 0,00 und 100.000.000.000,00 haben.',
    en: 'Quantity must have a value between 0.00 and 100,000,000,000.00.',
  };
  for (const locale of ['de', 'en']) {
    const [initial] = rangeValidators(await getPage(app, locale));
    assert.ok(initial.errormessage.includes(expected[locale]), initial.errormessage);
    assert.equal(initial.maximumvalue, '100000000000');
  }
  const below = await nativePost(app, 'de', '-5');
  assert.ok(validationSummary(below).includes(expected.de), validationSummary(below));
  const above = await postRendered(app, routes.en, { quantity: '200000000000' });
  assert.ok(validationSummary(above.html).includes(expected.en), validationSummary(above.html));
  assert.deepEqual(await readStoredFields(app, 'de'), Object.values(seed));
  assert.deepEqual(await readStoredFields(app, 'en'), Object.values(seed));
});

const validationSummary = (html) =>
  (html.match(/id="ValidationSummary[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '').replaceAll(/<[^>]+>/g, ' ');

const formatCopy = {
  de: [
    ['FloatValidatorquantity', 'Quantity muss ein gültiger Dezimalwert sein.'],
    ['FloatValidatormeasurement', 'Measurement muss ein gültiger Gleitkommawert sein.'],
    ['IntegerValidatorcount', 'count muss ein gültiger ganzzahliger Wert sein.'],
    ['RangeValidatorcount', 'count muss einen Wert zwischen -100000 und 100000 haben.'],
  ],
  en: [
    ['FloatValidatorquantity', 'Quantity must be a valid decimal value.'],
    ['FloatValidatormeasurement', 'Measurement must be a valid floating-point value.'],
    ['IntegerValidatorcount', 'count must be a valid integer value.'],
    ['RangeValidatorcount', 'count must have a value between -100000 and 100000.'],
  ],
};

for (const [locale, expected] of Object.entries(formatCopy)) {
  test('native number format and whole-number range validators speak the page language in ' + locale, async (t) => {
    const app = await fixture(t);
    const validators = pageValidators(await getPage(app, locale));
    for (const [id, message] of expected) assert.ok(validators.get(id)?.errormessage?.includes(message), id);
    // The stock money box has no format validator (captured).
    assert.equal(validators.get('FloatValidatorcharge')?.errormessage, undefined);
  });

  // @test-kind observation: the server-side native validators share the de-DE client validator copy of the k1/k2 native-values and edit-full captures (FloatValidator money copy from edit-full); en-US copy from the e1/e2 forms
  test('a rejected native post reports number format errors in the page language in ' + locale, async (t) => {
    const app = await fixture(t);
    const { html } = await postRendered(app, routes[locale], {
      quantity: 'abc',
      measurement: 'abc',
      charge: 'abc',
      count: 'abc',
    });
    const summary = validationSummary(html);
    const charge =
      locale === 'de' ? 'Charge muss ein gültiger Dezimalwert sein.' : 'Charge must be a valid decimal value.';
    for (const message of [...expected.map(([, text]) => text), charge]) assert.ok(summary.includes(message), summary);
    assert.deepEqual(await readStoredFields(app, locale), Object.values(seed));
  });
}

// @test-kind unproven: the captures are Basic Forms; a multistep form step renders the same native number boxes and validators and posts them over the same WebForms postback
test('multistep form steps format, parse and validate numbers in the page culture', async (t) => {
  for (const [route, expected, copy] of [
    ['/de-DE/', 1234.5, 'Quantity muss einen Wert zwischen -1.000.000,00 und 1.000.000,00 haben.'],
    ['/en-US/', 12345, 'Quantity must have a value between -1,000,000.00 and 1,000,000.00.'],
  ])
    await t.test(route, async (t) => {
      const app = await fixture(t, 'postback', { wizard: true });
      // A saved step redirects to the next step (ASP.NET Response.Redirect).
      const { rendered, html } = await postRendered(app, route, typed('1234,5'), 302);
      assert.match(boxAttr(rendered, 'quantity', 'name'), /WebFormControl/);
      assert.ok(pageValidators(rendered).get('RangeValidatorquantity').errormessage.includes(copy));
      assert.equal(validationSummary(html).trim(), '');
      const rows = app.store.tableRows('sample');
      assert.equal(rows.length, 3);
      assert.deepEqual(
        numericFields.map(({ name }) => rows.at(-1)[name]),
        [expected, expected, expected],
      );
    });
});

// @test-kind unproven: auto-generated step tabs carry earlier tabs' values in __VIEWSTATE (Mirage's WebForms model); they are assumed to be parsed with the page culture like the final tab's boxes
test('auto-generated step tabs parse a carried number in the page culture on Insert', async (t) => {
  for (const [route, expected] of [
    ['/de-DE/', 1234.5],
    ['/en-US/', 12345],
  ])
    await t.test(route, async (t) => {
      const app = await fixture(t, 'postback', { mode: FORM_MODE.insert, autoSteps: true });
      const browser = client(app);
      const ids = nativeFormControlIds('entityform', 'numbers');
      const token = async () => /value="([^"]+)"/.exec(await (await browser.request('/_layout/tokenhtml')).text())?.[1];
      const first = await (await browser.request(route)).text();
      assert.equal(first.includes('id="measurement"'), false);
      const second = await (
        await browser.request(
          route,
          formBody({
            __EVENTTARGET: '',
            __EVENTARGUMENT: '',
            __VIEWSTATE: boxAttr(first, '__VIEWSTATE', 'value'),
            __RequestVerificationToken: await token(),
            [ids.names + 'quantity']: '1234,5',
            [ids.names + 'NextButton']: 'Next tab',
          }),
        )
      ).text();
      assert.equal(second.includes('id="quantity"'), false);
      const saved = await browser.request(
        route,
        formBody({
          __EVENTTARGET: ids.buttons + 'InsertButton',
          __EVENTARGUMENT: '',
          __VIEWSTATE: boxAttr(second, '__VIEWSTATE', 'value'),
          __RequestVerificationToken: await token(),
          [ids.names + 'measurement']: '1234,5',
        }),
      );
      assert.equal(saved.status, 200);
      assert.equal(validationSummary(await saved.text()).trim(), '');
      const row = app.store.tableRows('sample').at(-1);
      assert.deepEqual([row.quantity, row.measurement], [expected, expected]);
    });
});

// @test-kind contract: the postback descriptor carries only declared number locales that are language tags the locale data supports, on a null prototype, and omits an empty map
test('the native postback descriptor validates its number locales', () => {
  const declare = (numberLocales) =>
    nativeFormPostbackDescriptor({ kind: 'entityform', formId: 'numbers', numberLocales });
  assert.equal(Object.hasOwn(declare({}), 'numberLocales'), false);
  const { numberLocales } = declare({ quantity: { parse: 'de-DE', messages: 'de-DE' }, count: { messages: 'en-US' } });
  assert.equal(Object.getPrototypeOf(numberLocales), null);
  assert.deepEqual(
    { ...numberLocales },
    {
      quantity: { parse: 'de-DE', messages: 'de-DE' },
      count: { messages: 'en-US' },
    },
  );
  assert.deepEqual(
    { ...declare({ quantity: { parse: 'fr-FR', messages: 'ja-JP' } }).numberLocales },
    { quantity: { parse: 'fr-FR', messages: 'ja-JP' } },
  );
  for (const invalid of [
    [],
    { quantity: { messages: 'not a locale' } },
    { quantity: { parse: 'de-DE-x-!', messages: 'de-DE' } },
    { quantity: { messages: 'toString' } },
    { quantity: 'de-DE' },
    JSON.parse('{"__proto__": {"messages": "de-DE"}}'),
  ])
    assert.throws(() => declare(invalid), /Invalid native number locale/);
});

const NARROW_SPACE = '\u202f';
for (const [locale, fixed, grouped, separator, posts] of [
  [
    'fr',
    ['1,50', '1,500', '1,50', '1500'],
    [`12${NARROW_SPACE}345,00`, `12${NARROW_SPACE}345,000`, `12${NARROW_SPACE}345,00`, '1500'],
    ',',
    [
      ['1234,5', 1234.5],
      // Every space a visitor can type or paste is the same group mark; each post stores a new value.
      [`2${NARROW_SPACE}345,5`, 2345.5],
      ['3 456,5', 3456.5],
      ['4\u00a0567,5', 4567.5],
    ],
  ],
  [
    'ja',
    ['1.50', '1.500', '1.50', '1500'],
    ['12,345.00', '12,345.000', '12,345.00', '1500'],
    '.',
    [
      ['1234.5', 1234.5],
      ['1,234.5', 1234.5],
    ],
  ],
]) {
  // @test-kind unproven: fr-FR and ja-JP number boxes are not captured (summary E covers en-US and de-DE); with observed.nativeNumberCultures: locale-data Mirage derives their marks from the locale data.
  test('with observed locale-data, native Basic Form number boxes follow the locale data in ' + locale, async (t) => {
    const app = await fixture(t, 'postback', { numberCultures: 'locale-data' });
    await app.store.create('sample', { sampleid: 'sample-' + locale, ...seed }, { roles: [] });
    await assertNumberBoxes(app, locale, { fixed, grouped, separator });
    for (const [text, expected] of posts) {
      const html = await nativePost(app, locale, text);
      assert.deepEqual(await readStoredFields(app, locale), [expected, expected, expected, 1500], text);
      assert.deepEqual(boxValues(html), [text, text, text, '1500']);
    }
  });
}

// @test-kind unproven: without a capture or the observed opt-in, an uncaptured page culture keeps invariant number boxes and is reported (fail closed); hosted fr-FR forms are not captured.
test('without the observed opt-in an uncaptured page culture keeps invariant number boxes and is reported', async (t) => {
  const app = await fixture(t);
  await app.store.create('sample', { sampleid: 'sample-fr', ...seed }, { roles: [] });
  const initial = await getPage(app, 'fr');
  assert.deepEqual(boxValues(initial), ['1.50', '1.500', '1.50', '1500']);
  const reported = app.state().diagnostics.filter((entry) => entry.code === 'FORM_NUMBER_CULTURE_UNCAPTURED');
  assert.ok(reported.length > 0);
  assert.equal(reported[0].language, 'fr-FR');
  assert.match(reported[0].message, /observed\.nativeNumberCultures: locale-data/);
  const html = await nativePost(app, 'fr', '1234.5');
  assert.deepEqual(await readStoredFields(app, 'fr'), [1234.5, 1234.5, 1234.5, 1500]);
  // Invariant boxes show the stored value at the column precision, as before.
  assert.deepEqual(boxValues(html), ['1234.50', '1234.500', '1234.50', '1500']);
  // The captured cultures report nothing.
  const before = app.state().diagnostics.length;
  await getPage(app, 'de');
  assert.ok(
    !app
      .state()
      .diagnostics.slice(before)
      .some((entry) => entry.code === 'FORM_NUMBER_CULTURE_UNCAPTURED'),
  );
});
