// @test-kind observation: hosted F2 session (paqvilo-developer hosted-f2, runs a and b agree, 2026-11-27; groups reject-v2 and choices): rejected basic-form posts on an Enhanced, Bootstrap 5 site with enhanced authorization enabled (enhancedauthorization 3) and Site/EnableCustomPluginError absent
// Invented schema and loopback fixtures only. A post refused by the server validators, by request validation or by
// Dataverse re-renders the form with HTTP 200 and saves nothing; a malformed choices value answers 500. The choices
// control posts its selection as a JSON array of option metadata: `[]` clears the column.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'parse5';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds, nativeFormPostbackDescriptor } from '../lib/native-postback.mjs';
import { nativeFormSubmissionContext } from '../lib/form-service.mjs';
import { submitNativePostback } from '../lib/native-form-submission.mjs';
import { fieldDefinition } from '../lib/solution-schema.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const OPTIONS = [
  { value: 100000000, label: 'Amber', labels: { 1031: 'Bernstein', 1033: 'Amber' } },
  { value: 100000001, label: 'Cobalt', labels: { 1031: 'Kobalt', 1033: 'Cobalt' } },
  { value: 100000002, label: 'Moss', labels: { 1031: 'Moos', 1033: 'Moss' } },
];
const STORED = { gadgetid: 'gadget-1', label: 'Stored', count: 5, hues: '100000001', remarks: null };
const REQUEST_VALIDATION =
  'Request validation has detected potentially dangerous input value(s) such as HTML, or script. Please review the input value(s) and try again.';

async function fixture(t, { settings = [] } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'form-rejected-post-'));
  const files = {
    'website.yml': 'adx_websiteid: fixture-site\nadx_name: Invented rejected posts',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '<form id="liquid_form">{% entityform name: "Gadget" %}</form>',
    'Gadget.basicform.yml':
      'adx_entityformid: gadget\nadx_name: Gadget\nadx_mode: 100000001\nadx_recordidquerystringparametername: id',
    'sitesetting.yml': [['Site/BootstrapV5Enabled', 'true'], ...settings]
      .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
      .join('\n'),
  };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      mappings: {
        gadget: {
          entitySet: 'gadgets',
          idColumn: 'gadgetid',
          fields: {
            label: { dataverseType: 'nvarchar', maxLength: 200 },
            count: { dataverseType: 'int', minValue: -100000, maxValue: 100000 },
            hues: { dataverseType: 'multiselectpicklist', options: OPTIONS },
            remarks: { dataverseType: 'memo', maxLength: 4000 },
          },
        },
      },
      tables: { gadget: [{ ...STORED }] },
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { roles: [] },
        live: {},
        endpoints: [],
        componentSchemas: {
          gadget: {
            entity: 'gadget',
            fields: [
              { name: 'label', type: 'text', label: 'Label', dataverseType: 'nvarchar', maxLength: 200 },
              {
                name: 'count',
                type: 'number',
                label: 'Count',
                dataverseType: 'int',
                minimum: -100000,
                maximum: 100000,
              },
              { name: 'hues', label: 'Hues', dataverseType: 'multiselectpicklist', options: OPTIONS },
              { name: 'remarks', type: 'textarea', label: 'Remarks', dataverseType: 'memo', maxLength: 4000 },
            ],
          },
        },
      },
    },
  });
  ownedFixture(t).add(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const controls = nativeFormControlIds('entityform', 'gadget');
  const post = async (values) => {
    const response = await fetch(app.url + '/?id=gadget-1', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__EVENTTARGET', controls.buttons + 'UpdateButton'],
        ['__EVENTARGUMENT', ''],
        ['__RequestVerificationToken', app.csrf],
        ...Object.entries({ label: 'Posted', count: '5', ...values }).map(([key, value]) => [
          controls.names + key,
          value,
        ]),
      ]),
    });
    return { status: response.status, html: await response.text() };
  };
  const stored = () => {
    const { gadgetid, label, count, hues, remarks } = app.store.tableRows('gadget')[0];
    return { gadgetid, label, count, hues, remarks: remarks ?? null };
  };
  return { app, post, stored };
}

// The rendered page read with an HTML parser: its elements in document order, an attribute and an element's text.
const elementsOf = (node, found = []) => {
  if (node.tagName) found.push(node);
  for (const child of node.childNodes ?? []) elementsOf(child, found);
  return found;
};
const attributeOf = (node, name) => node.attrs?.find((attribute) => attribute.name === name)?.value;
const textOf = (node) =>
  (node.childNodes ?? []).map((child) => (child.nodeName === '#text' ? child.value : textOf(child))).join('');
const divOf = (html, matches) =>
  elementsOf(parse(html)).find((node) => node.tagName === 'div' && matches(attributeOf(node, 'id') ?? ''));
const summaryItems = (html) => {
  const summary = divOf(html, (id) => id.startsWith('ValidationSummary'));
  if (!summary) return [];
  return elementsOf(summary)
    .filter((node) => node.tagName === 'li')
    .map((item) => textOf(item).trim());
};
const panel = (html) => {
  const markup = divOf(html, (id) => id === 'MessagePanel');
  return markup ? { className: attributeOf(markup, 'class'), text: textOf(markup).trim() } : null;
};

test('range, format and length refusals re-render the form with the validator copy and save nothing', async (t) => {
  const { post, stored } = await fixture(t);
  for (const [values, expected] of [
    [{ count: '999999999' }, ['Count must have a value between -100000 and 100000.']],
    [
      { count: '12x5' },
      ['Count must be a valid integer value.', 'Count must have a value between -100000 and 100000.'],
    ],
    [
      { count: '12.5' },
      ['Count must be a valid integer value.', 'Count must have a value between -100000 and 100000.'],
    ],
    [{ label: 'R ' + 'x'.repeat(250) }, ['Label exceeds the maximum length of 200 characters.']],
  ]) {
    const { status, html } = await post(values);
    assert.equal(status, 200);
    assert.deepEqual(summaryItems(html), expected);
    assert.equal(panel(html), null);
    assert.deepEqual(stored(), STORED);
  }
});

test('a choice outside the column options shows the Dataverse message as it is and saves nothing', async (t) => {
  const { post, stored } = await fixture(t);
  const { status, html } = await post({ hues: '[{"Value":100000000},{"Value":999}]' });
  assert.equal(status, 200);
  assert.deepEqual(summaryItems(html), []);
  assert.deepEqual(panel(html), {
    className: 'message alert alert-danger',
    text: "A validation error occurred. The value 999 of 'hues' on record of type 'gadget' is outside the valid range. Accepted Values: 100000000,100000001,100000002",
  });
  assert.deepEqual(stored(), STORED);
});

// @test-kind unproven: the hosted runs posted the invalid choice with valid other fields only; that the validators answer before Dataverse (summary only, no Dataverse message) is the local order of the form save, not captured
test('with a validator refusal on the same post the form shows the validation summary only', async (t) => {
  const { post } = await fixture(t);
  const both = await post({ count: '12x5', hues: '[{"Value":999}]' });
  assert.equal(both.status, 200);
  assert.equal(panel(both.html), null);
  assert.equal(summaryItems(both.html).length, 2);
});

test('the choices value is the posted JSON selection: it saves, [] clears and text that is not a list answers 500', async (t) => {
  const { post, stored } = await fixture(t);
  const malformed = await post({ hues: 'not-json' });
  assert.equal(malformed.status, 500);
  assert.deepEqual(stored(), STORED);
  const saved = await post({ hues: '[{"Value":100000000,"Label":{}},{"Value":100000002}]' });
  assert.equal(saved.status, 200);
  assert.equal(stored().hues, '100000000,100000002');
  const cleared = await post({ hues: '[]' });
  assert.equal(cleared.status, 200);
  assert.equal(stored().hues, null);
});

test('HTML in a textarea is refused by request validation and saves nothing', async (t) => {
  const { post, stored } = await fixture(t);
  const { status, html } = await post({
    label: 'Changed',
    remarks: '<p>posted <em>rich</em></p><script>alert(1)</script><img src="x" onerror="alert(2)">',
  });
  assert.equal(status, 200);
  assert.deepEqual(summaryItems(html), []);
  assert.deepEqual(panel(html), { className: 'message alert error alert alert-danger', text: REQUEST_VALIDATION });
  assert.deepEqual(stored(), STORED);
  // The re-rendered form keeps the posted text, escaped.
  assert.match(
    html,
    /<textarea [^>]*id="remarks"[^>]*>&lt;p&gt;posted &lt;em&gt;rich&lt;\/em&gt;&lt;\/p&gt;&lt;script&gt;/,
  );
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

// @test-kind observation: hosted F2 state-0 runs s0g, s0h and s0r (paqvilo-developer hosted-f2 reqval.json, default settings): on a basic form's plain multiline field a script block alone is refused with this message, and other markup, event handlers, script links and frames included, is accepted and stored as posted
test('by default only a script block is refused; other markup is stored as posted', async (t) => {
  const { post, stored } = await fixture(t);
  const refused = await post({ remarks: '<script>alert(1)</script>' });
  assert.equal(refused.status, 200);
  assert.equal(panel(refused.html)?.text, REQUEST_VALIDATION);
  assert.deepEqual(stored(), STORED);
  for (const remarks of [
    '<img src=x onerror=alert(2)>',
    '<svg onload=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="//example.invalid"></iframe>',
    '<p><strong>ok</strong></p>',
    '<b onclick=x>y</b>',
  ]) {
    const saved = await post({ remarks });
    assert.equal(saved.status, 200, remarks);
    assert.equal(panel(saved.html)?.className.includes('alert-success'), true, remarks);
    assert.equal(stored().remarks, remarks);
  }
});

// @test-kind security: request validation answers long posted text with many unclosed `<` (each one a start the earlier
// `<[^>]*…` patterns rescanned to the end) by the same rule: with the safe-HTML rule a token inside a tag is refused, the
// same token after the tag's `>` is not; only the outcome is asserted, not the time it takes
test('long text with many unclosed tags is checked by the same in-tag rule', async (t) => {
  const { post, stored } = await fixture(t, { settings: [['Site/DisableFormDataSafeHtmlValidation', 'false']] });
  const opens = '<'.repeat(60_000);
  for (const remarks of [
    opens + ' onclick=x',
    opens + ' href="javascript:x"',
    opens + 'data :text/html',
    opens + '&' + '&'.repeat(60_000) + '#',
    opens + ' script',
  ]) {
    const refused = await post({ remarks });
    assert.equal(refused.status, 200, remarks.slice(-24));
    assert.equal(panel(refused.html)?.text, REQUEST_VALIDATION, remarks.slice(-24));
    assert.deepEqual(stored(), STORED, remarks.slice(-24));
  }
  // Past the validation the form's own validators answer: the text is longer than the column allows.
  for (const remarks of [
    opens + ' x',
    opens + '> onclick=x',
    opens + '>javascript:x',
    '<a>'.repeat(30_000) + 'data:text/html &#',
  ]) {
    const passed = await post({ remarks });
    assert.equal(passed.status, 200, remarks.slice(-24));
    assert.equal(panel(passed.html), null, remarks.slice(-24));
    assert.deepEqual(summaryItems(passed.html), ['Remarks exceeds the maximum length of 4000 characters.']);
    assert.deepEqual(stored(), STORED, remarks.slice(-24));
  }
});

const submission = (kind, formId, values) => [
  {
    descriptor: nativeFormPostbackDescriptor({
      kind,
      formId,
      fields: Object.entries(values).map(([name, value]) => ({ name, multiple: Array.isArray(value) })),
      actions: [{ button: 'NextButton', action: 'submit' }],
    }),
    context: nativeFormSubmissionContext({ kind, formId, entity: 'gadget', mode: 100000000 }),
  },
];
const postedEntries = ([item], values) => [
  ['__EVENTTARGET', item.descriptor.actions[0].target],
  ...item.descriptor.fields.flatMap((field) => [values[field.name]].flat().map((value) => [field.wireName, value])),
];

// @test-kind security+observation: request validation reads every posted text before any form handles the post: a multistep step refuses a script block (hosted F2 state-0 s0g/s0h/s0r: same message as a basic form), and so do a form missing from the sources and repeated (array) values
test('request validation applies to multistep steps, unknown forms and repeated values', async () => {
  const options = {
    portal: { forms: [], advancedForms: [{ id: 'wizard', metadata: {} }], records: [] },
    requestUrl: 'http://localhost/wizard/',
  };
  for (const [kind, formId, values] of [
    ['webform', 'wizard', { remarks: '<script>alert(1)</script>' }],
    ['entityform', 'absent', { remarks: '<script>alert(1)</script>' }],
    ['entityform', 'absent', { remarks: ['plain', '<SCRIPT >alert(1)</SCRIPT>'] }],
  ]) {
    const rendered = submission(kind, formId, values);
    await assert.rejects(
      submitNativePostback(postedEntries(rendered, values), rendered, options),
      (error) => error.code === 'FormRequestValidation',
      `${kind} ${formId}`,
    );
  }
  // A multistep step accepts an event handler by default (s0g/s0h/s0r: onerror accepted on the step).
  const values = { remarks: '<img src=x onerror=alert(2)>' };
  const rendered = submission('webform', 'wizard', values);
  await assert.rejects(
    submitNativePostback(postedEntries(rendered, values), rendered, options),
    (error) => error.code !== 'FormRequestValidation',
  );
});

// @test-kind observation: hosted F2 state-0 runs s0i and s0j (paqvilo-developer hosted-f2 reqval-safehtml.json): with Site/DisableFormDataSafeHtmlValidation false an onerror handler is refused with the same message and `<p><strong>` is accepted
test('with the safe-HTML rule an event handler is refused and benign markup saves', async (t) => {
  const { post, stored } = await fixture(t, { settings: [['Site/DisableFormDataSafeHtmlValidation', 'false']] });
  const refused = await post({ remarks: '<img src=x onerror=alert(2)>' });
  assert.equal(refused.status, 200);
  assert.deepEqual(panel(refused.html), {
    className: 'message alert error alert alert-danger',
    text: REQUEST_VALIDATION,
  });
  assert.deepEqual(stored(), STORED);
  const saved = await post({ remarks: '<p><strong>ok</strong></p>' });
  assert.equal(saved.status, 200);
  assert.equal(stored().remarks, '<p><strong>ok</strong></p>');
});

// @test-kind unproven: the safe-HTML rule's other refusals are inferred from Learn's "prevent any malicious code execution" (only onerror was captured, s0i/s0j)
test('the safe-HTML rule also refuses script URLs, entities inside a tag and embedding elements', async (t) => {
  const { post, stored } = await fixture(t, { settings: [['Site/DisableFormDataSafeHtmlValidation', 'false']] });
  for (const remarks of [
    '<script>alert(1)</script>',
    '<svg/onload=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<iframe src="https://example.invalid"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<a href="data:text/html,<p>x</p>">x</a>',
    'javascript:alert(1)',
  ]) {
    const refused = await post({ remarks });
    assert.equal(panel(refused.html)?.text, REQUEST_VALIDATION, remarks);
    assert.deepEqual(stored(), STORED, remarks);
  }
  assert.equal((await post({ remarks: 'a < b and 3 <4' })).status, 200);
  assert.equal(stored().remarks, 'a < b and 3 <4');
});

// @test-kind compatibility: Microsoft Learn basic forms, Request validation: DisableValidationWebTemplate true turns request validation off; not captured on the hosted site
test('DisableValidationWebTemplate true turns request validation off', async (t) => {
  const off = await fixture(t, { settings: [['DisableValidationWebTemplate', 'true']] });
  const saved = await off.post({ remarks: '<script>posted()</script>' });
  assert.equal(saved.status, 200);
  assert.equal(panel(saved.html)?.className.includes('alert-success'), true);
  assert.equal(off.stored().remarks, '<script>posted()</script>');
});

test('the choices control lists every exported language label of an option, the base language first', async (t) => {
  // An exported choice with labels in two languages keeps both on its schema option.
  const definition = fieldDefinition({ tables: { gadget: {} }, optionSets: {}, targets: {} }, 'gadget', {
    name: 'hues',
    type: 'multiselectpicklist',
    optionSet: { options: [{ value: 100000000, labels: { 1033: 'Amber', 1031: 'Bernstein' } }] },
  });
  assert.deepEqual(definition.options, [
    { value: 100000000, label: 'Amber', labels: { 1031: 'Bernstein', 1033: 'Amber' } },
  ]);
  const { app } = await fixture(t);
  const html = (await (await fetch(app.url + '/?id=gadget-1')).text()).replaceAll('&quot;', '"');
  const options = JSON.parse(html.match(/"value_Options":(\[.*?\]),"value_DefaultValue"/)?.[1] ?? 'null');
  const option = options.find((item) => item.Value === 100000001);
  assert.deepEqual(
    option.Label.LocalizedLabels.map((label) => [label.LanguageCode, label.Label]),
    [
      [1033, 'Cobalt'],
      [1031, 'Kobalt'],
    ],
  );
  assert.deepEqual(
    [option.Label.UserLocalizedLabel.LanguageCode, option.Label.UserLocalizedLabel.Label],
    [1033, 'Cobalt'],
  );
});

// @test-kind contract: the local runtime also accepts a comma list of option values for a choices control, stored once per option as the JSON selection is
test('a posted comma list of choices is stored once per option', async (t) => {
  const { post, stored } = await fixture(t);
  const saved = await post({ hues: '100000000, 100000000,100000002' });
  assert.equal(saved.status, 200);
  assert.equal(stored().hues, '100000000,100000002');
});

// @test-kind contract: observed.formSubmissionErrorMarkup is the documented per-site shape of the error panel (mirage/docs/forms-lists-parity.md); it also shapes the Dataverse message of a refused choice
test('an observed error panel markup keeps its shape for a refused choice', async () => {
  const { formWriteError, formErrorPanel } = await import('../lib/form-error-presentation.mjs');
  const refusal = Object.assign(new Error('A validation error occurred. The value 999 is outside the valid range.'), {
    code: 'PicklistValueOutOfRange',
    nativeFormWriteFailure: true,
    details: { innerCode: '0x8004431a' },
  });
  const outcome = formWriteError(refusal, { formSubmissionErrorMarkup: 'paragraph' });
  assert.deepEqual(outcome, { type: 'error', markup: 'paragraph', message: refusal.message });
  assert.match(formErrorPanel(outcome, { v5: true }), /<span id="MessageLabel"><p>A validation error occurred\./);
});
