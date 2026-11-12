// @test-kind contract: the inline handlers and summary-link markup of the web form controls are Paqvilo's own rendering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderComponent, summaryLink, validationSummaryMarkup } from '../lib/platform.mjs';
import { createWebFormSessions } from '../lib/form-service.mjs';
import { emptyAnswerStore, surveySchemas } from './support/form-fixtures.mjs';

// Submit and Next buttons, and constant-sum boxes, carry form metadata inside inline
// JavaScript. The browser decodes the attribute before it runs the handler, so each test
// decodes the attribute the same way, compiles it and runs it against recording stubs.

const ENTITY_TEXT = { '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const decodeAttribute = (value) => value.replace(/&(?:quot|#39|lt|gt|amp);/g, (entity) => ENTITY_TEXT[entity]);

// One attribute of a start tag: its name, then an optional double-quoted, single-quoted or bare value.
const ATTRIBUTE = /([^\s=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s'"]+))?/g;

function attributeOf(html, pattern) {
  const match = pattern.exec(html);
  assert.ok(match, `no element matched ${pattern}`);
  return match[1];
}

function runHandler(source, { self, stubs }) {
  const names = Object.keys(stubs);
  const handler = new Function(...names, source.replace(/^javascript:/, ''));
  return handler.call(self, ...names.map((name) => stubs[name]));
}

function formStubs(calls) {
  return {
    alert: (message) => calls.alerts.push(message),
    entityFormClientValidate: () => true,
    webFormClientValidate: () => true,
    clearIsDirty: () => {},
    disableButtons: () => {},
    Page_ClientValidate: (group) => {
      calls.validated.push(group);
      return true;
    },
    WebForm_PostBackOptions: function postBackOptions(...args) {
      return args;
    },
    WebForm_DoPostBackWithOptions: (options) => calls.postBacks.push(options),
  };
}

const newCalls = () => ({ alerts: [], validated: [], postBacks: [] });

async function renderBasicInsert(busy) {
  const store = {
    resolveMapping: () => ({ entitySet: 'samples', idColumn: 'sampleid' }),
    get: async () => null,
    query: async () => ({ value: [] }),
  };
  const portal = {
    forms: [{ id: 'form', name: 'Entry', mode: 100000000, metadata: { adx_submitbuttonbusytext: busy } }],
    records: [],
    website: { id: 'site' },
    pages: [],
    settings: { 'Site/BootstrapV5Enabled': 'true' },
  };
  const schemas = {
    form: {
      entity: 'sample',
      title: 'Entry',
      fields: [{ name: 'title', label: 'Title', dataverseType: 'nvarchar', maxLength: 50 }],
      layout: [{ name: 't', columns: [{ sections: [{ name: 's', rows: [[{ name: 'title' }]] }] }] }],
    },
  };
  return renderComponent(
    'entityform',
    'form',
    { user: { id: 'current' }, request: { params: {} } },
    {
      portal,
      store,
      schemas,
    },
  );
}

async function renderMultistep(group) {
  const portal = {
    website: { id: 'site' },
    forms: [],
    lists: [],
    pages: [],
    settings: { 'Site/BootstrapV5Enabled': 'true' },
    websiteLanguages: [{ lcid: 1033, isDefault: true }],
    advancedForms: [{ id: 'survey', name: 'Survey Wizard', metadata: {} }],
    records: [],
  };
  const step = (stepId, extra) => ({
    stepId,
    entity: 'answer',
    mode: 100000000,
    formName: 'Answer Compact',
    metadata: { adx_entitypermissionsenabled: true, adx_validationgroup: group },
    fields: [{ name: 'note', label: 'Note', dataverseType: 'nvarchar', maxLength: 50 }],
    layout: [{ name: 'tab', columns: [{ sections: [{ name: 's', rows: [[{ name: 'note' }]] }] }] }],
    ...extra,
  });
  const schemas = surveySchemas(step);
  const store = emptyAnswerStore();
  return renderComponent(
    'webform',
    'Survey Wizard',
    { request: { params: {} } },
    {
      portal,
      store,
      schemas,
      renderLiquid: async (source) => source,
      webFormSessions: createWebFormSessions(),
      webFormOwner: () => 'visitor:a',
    },
  );
}

const SURVEY_ID = 'd0000000-0000-4000-8000-000000000001';

async function renderSurvey(groupName) {
  const meta = (name) => ({
    kind: 'basicformmetadata',
    adx_entityform: 'form',
    adx_type: 100000000,
    adx_attributelogicalname: name,
    adx_controlstyle: 100000003,
    adx_groupname: groupName,
  });
  const fields = [
    { name: 'first', label: 'First', dataverseType: 'int' },
    { name: 'second', label: 'Second', dataverseType: 'int' },
  ];
  const layout = [
    {
      name: 'tab',
      columns: [
        {
          sections: [
            {
              name: 'survey',
              label: 'Survey',
              showLabel: true,
              rows: [[{ name: 'first', label: 'First' }], [{ name: 'second', label: 'Second' }]],
            },
          ],
        },
      ],
    },
  ];
  const store = {
    resolveMapping: () => ({ entitySet: 'widgets', idColumn: 'widgetid' }),
    get: async () => ({ widgetid: SURVEY_ID, first: 1, second: 2 }),
    query: async () => ({ value: [] }),
  };
  const portal = {
    forms: [{ id: 'form', name: 'Survey', mode: 100000001 }],
    records: [meta('first'), meta('second')],
    website: { id: 'site' },
    pages: [],
    settings: { 'Site/BootstrapV5Enabled': 'true' },
  };
  const schemas = { form: { entity: 'widget', title: 'Survey', fields, layout } };
  return renderComponent(
    'entityform',
    'form',
    { user: { id: 'current' }, request: { params: { id: SURVEY_ID } } },
    {
      portal,
      store,
      schemas,
    },
  );
}

const SUBMIT_HANDLER = /name="[^"]*InsertButton" value="[^"]*" onclick="([^"]*)"/;
const NEXT_HANDLER = /name="[^"]*NextButton" value="[^"]*" onclick="([^"]*)"/;
const CONSTANT_SUM_HANDLER = /id="first" class="[^"]*" onchange="([^"]*)"/;

// @test-kind contract: the submit handler is inline JavaScript built from the busy text, and it must compile for any text.
test('basic insert submit: a busy text with an apostrophe compiles and sets the exact text', async () => {
  const html = await renderBasicInsert("We're saving");
  const handler = attributeOf(html, SUBMIT_HANDLER);
  const self = { value: 'Save' };
  const calls = newCalls();
  runHandler(decodeAttribute(handler), { self, stubs: formStubs(calls) });
  assert.equal(self.value, "We're saving");
  assert.deepEqual(calls.validated, ['']);
});

// @test-kind contract: the multistep Next handler carries the validation group into the validator and the postback options.
test('multistep Next: a validation group with an apostrophe reaches the validator and the postback unchanged', async () => {
  const html = await renderMultistep("a'b");
  const handler = attributeOf(html, NEXT_HANDLER);
  const self = { value: 'Next' };
  const calls = newCalls();
  runHandler(decodeAttribute(handler), { self, stubs: formStubs(calls) });
  assert.deepEqual(calls.validated, ["a'b"]);
  assert.equal(calls.postBacks[0][3], "a'b");
});

// @test-kind security: U+2028 and U+2029 in a busy text must reach the handler as six-character escapes and still set the exact text.
test('basic insert submit: U+2028 and U+2029 in the busy text are escaped and set the exact text', async () => {
  const separators = String.fromCharCode(0x2028, 0x2029);
  const busy = `a${separators[0]}b${separators[1]}c`;
  const html = await renderBasicInsert(busy);
  const handler = attributeOf(html, SUBMIT_HANDLER);
  const backslash = String.fromCharCode(92);
  assert.ok(handler.includes(`a${backslash}u2028b${backslash}u2029c`));
  assert.equal(
    [...handler].some((ch) => separators.includes(ch)),
    false,
  );
  const self = { value: 'Save' };
  runHandler(decodeAttribute(handler), { self, stubs: formStubs(newCalls()) });
  assert.equal(self.value, busy);
});

// @test-kind security: the escape table must spell U+2028 and U+2029 as escape sequences, so the source holds no raw line separator for an editor or formatter to alter.
test('platform.mjs source holds no raw U+2028 or U+2029 characters', () => {
  const source = readFileSync(new URL('../lib/platform.mjs', import.meta.url), 'utf8');
  const separators = String.fromCharCode(0x2028, 0x2029);
  assert.equal(
    [...source].some((ch) => separators.includes(ch)),
    false,
  );
});

// @test-kind contract: payload text is inline JavaScript data, so it must stay one string value and never end the handler or the page.
test('submit busy text payloads stay one string and cannot end the handler or the page script', async () => {
  for (const payload of ['</script><img src=x onerror=1>', "');alert(1);('"]) {
    const html = await renderBasicInsert(payload);
    const handler = attributeOf(html, SUBMIT_HANDLER);
    assert.doesNotMatch(handler, /[<>]/);
    assert.doesNotMatch(html, /<img src=x onerror=1>/);
    const self = { value: 'Save' };
    const calls = newCalls();
    runHandler(decodeAttribute(handler), { self, stubs: formStubs(calls) });
    assert.equal(self.value, payload);
    assert.deepEqual(calls.alerts, []);
  }
});

// @test-kind security: the constant-sum group name is maker-authored inline JavaScript, so it must reach updateConstantSum as the exact name.
test('constant-sum group name with an apostrophe calls updateConstantSum with the exact name', async () => {
  const html = await renderSurvey("a'b");
  const handler = attributeOf(html, CONSTANT_SUM_HANDLER);
  const calls = [];
  const stubs = {
    setIsDirty: () => {},
    setPrecision: () => {},
    updateConstantSum: (group) => calls.push(group),
    alert: () => assert.fail('the group name ran as script'),
  };
  runHandler(decodeAttribute(handler), { self: { id: 'first' }, stubs });
  assert.deepEqual(calls, ["a'b"]);
});

// @test-kind security: a crafted constant-sum group name must not end the attribute, the handler or the page script.
test('constant-sum group name payloads stay one string and cannot run as script', async () => {
  for (const payload of ["x');alert(1);('", '</script><img src=x onerror=1>']) {
    const html = await renderSurvey(payload);
    const handler = attributeOf(html, CONSTANT_SUM_HANDLER);
    assert.doesNotMatch(handler, /[<>]/);
    assert.doesNotMatch(html, /<img src=x onerror=1>/);
    const calls = [];
    const alerts = [];
    const stubs = {
      setIsDirty: () => {},
      setPrecision: () => {},
      updateConstantSum: (group) => calls.push(group),
      alert: (message) => alerts.push(message),
    };
    runHandler(decodeAttribute(handler), { self: { id: 'first' }, stubs });
    assert.deepEqual(calls, [payload]);
    assert.deepEqual(alerts, []);
  }
});

// Renders the summary link for one field id and asserts its anchor: one start tag with href, onclick and referenceControlId,
// no injected image, and a handler that scrolls to the label and focuses the original id.
function assertSummaryLinkKeepsId(id) {
  const html = summaryLink(id, 'Required', true);
  const anchor = /^<a ([^>]*)>/.exec(html);
  assert.ok(anchor, 'the summary link renders one anchor start tag');
  const attributes = [...anchor[1].matchAll(ATTRIBUTE)].map((match) => match[1]);
  assert.deepEqual(attributes, ['href', 'onclick', 'referenceControlId']);
  assert.doesNotMatch(html, /<img/);
  const calls = [];
  const handler = decodeAttribute(attributeOf(html, /onclick='([^']*)'/));
  runHandler(handler, { self: {}, stubs: { scrollToAndFocus: (label, focus) => calls.push([label, focus]) } });
  assert.deepEqual(calls, [[`${id}_label`, id]]);
}

// @test-kind security: a field id outside the platform's plain names must stay one attribute value in the summary link, and the handler still gets the id.
test('validation summary links keep one attribute and pass the original field id for any id', async () => {
  assertSummaryLinkKeepsId('a b onmouseover=alert(1)');
});

// @test-kind security: a field id with quotes and markup must not end the summary link's attributes or inject an element.
test('validation summary links escape a hostile field id in the href, the handler and referenceControlId', async () => {
  assertSummaryLinkKeepsId("x'><img src=x onerror=1>");
});

// @test-kind contract: the summary link markup for the field ids the platform generates is Paqvilo's own rendering and must not change.
test('an ordinary field id renders the plain summary link markup', () => {
  assert.equal(
    summaryLink('first_name.v-2:x', 'Required', true),
    `<a href='#first_name.v-2:x_label' onclick='javascript:scrollToAndFocus("first_name.v-2:x_label","first_name.v-2:x");return false;' referenceControlId=first_name.v-2:x>Required </a>`,
  );
  assert.equal(summaryLink('first_name', 'Required', false), 'Required');
});

// @test-kind observation: native basic form probed on 2026-11-12 (two reads per state after cache clears): a required-field message with
// markup, `<b>bold</b> & <i>x</i>`, is served unencoded inside the summary link anchor and unencoded without links.
test('a validation message is inserted without HTML encoding, with summary links on and off', () => {
  const message = '<b>bold</b> & <i>x</i>';
  assert.equal(
    summaryLink('lastname', message, true),
    `<a href='#lastname_label' onclick='javascript:scrollToAndFocus("lastname_label","lastname");return false;' referenceControlId=lastname><b>bold</b> & <i>x</i> </a>`,
  );
  assert.equal(summaryLink('lastname', message, false), message);
});

// @test-kind security: a configured validation message cannot end the inline script that carries it or leave its string literal.
test('a configured validation message cannot end the inline script that carries it or leave its string literal', async () => {
  const message = 'a</script><img src=x onerror=1>"\\\'\nb';
  const fields = [{ name: 'lastname', label: 'Last name', dataverseType: 'nvarchar', maxLength: 50, required: true }];
  const store = {
    resolveMapping: () => ({ entitySet: 'contacts', idColumn: 'contactid' }),
    get: async () => null,
    query: async () => ({ value: [] }),
  };
  const portal = {
    forms: [{ id: 'form', name: 'Contact', mode: 100000000 }],
    records: [
      {
        kind: 'basicformmetadata',
        adx_entityform: 'form',
        adx_type: 100000000,
        adx_attributelogicalname: 'lastname',
        adx_requiredfieldvalidationerrormessage: message,
      },
    ],
    website: { id: 'site' },
    pages: [],
    settings: {},
  };
  const schemas = {
    form: {
      entity: 'contact',
      title: 'Contact',
      fields,
      layout: [{ name: 't', columns: [{ sections: [{ name: 's', rows: [[{ name: 'lastname' }]] }] }] }],
    },
  };
  const html = await renderComponent(
    'entityform',
    'form',
    { user: { id: 'current' }, request: { params: {} } },
    { portal, store, schemas },
  );
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const validatorScript = scripts.find((text) => text.includes('Page_Validators'));
  assert.ok(validatorScript, 'the page carries a script that sets the validators');
  assert.ok(validatorScript.includes('a\\u003c/script>'), 'the configured message is carried in the script, escaped');
  assert.match(validatorScript, /v\.evaluationfunction=/, 'the assignments after the message stay in the same script');
  assert.doesNotThrow(() => new vm.Script(validatorScript));
});

// @test-kind security: a field id with an ampersand and quotes in the validation summary must be escaped once, stay one attribute value and reach the handler unchanged.
test('the validation summary escapes a field id with an ampersand and quotes once and passes the raw id to the handler', () => {
  const id = 'a&"b';
  const html = validationSummaryMarkup({ validationErrors: [{ field: id, message: 'Required' }] }, '', true);
  assert.doesNotMatch(html, /&amp;amp;|&amp;quot;/);
  const anchor = /<a ([^>]*)>/.exec(html);
  assert.ok(anchor, 'the summary item renders one anchor start tag');
  const attributes = [...anchor[1].matchAll(ATTRIBUTE)].map((match) => match[1]);
  assert.deepEqual(attributes, ['href', 'onclick', 'referenceControlId']);
  assert.equal(decodeAttribute(attributeOf(html, /href='([^']*)'/)), '#a&"b_label');
  const calls = [];
  const handler = decodeAttribute(attributeOf(html, /onclick='([^']*)'/));
  runHandler(handler, { self: {}, stubs: { scrollToAndFocus: (label, focus) => calls.push([label, focus]) } });
  assert.deepEqual(calls, [['a&"b_label', id]]);
});

// @test-kind contract: an ordinary field id in the validation summary renders the plain markup.
test('the validation summary renders an ordinary field id byte-identically', () => {
  assert.equal(
    validationSummaryMarkup(
      { validationErrors: [{ field: 'first_name', message: 'Required' }] },
      '<h2>Errors</h2>',
      true,
    ),
    `<h2>Errors</h2><ul><li><a href='#first_name_label' onclick='javascript:scrollToAndFocus("first_name_label","first_name");return false;' referenceControlId=first_name>Required </a></li></ul>`,
  );
});
