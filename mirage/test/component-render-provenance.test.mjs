// @test-kind contract: render provenance of platform component markup is Paqvilo's own design (lib/component-provenance.mjs): every element a form, list or code component renders names the exported configuration that produced it, and the markup itself is unchanged
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, parseFragment } from 'parse5';
import { PCF_HOST_SCRIPT } from '../lib/code-components.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { createWebFormSessions } from '../lib/form-service.mjs';
import { componentRenderResult, platformComponentIntervals } from '../lib/component-provenance.mjs';
import { buildPortalSourceIndex } from '../lib/portal-source-index.mjs';
import { finalizePortalProvenance } from '../lib/render-provenance.mjs';
import { emptyAnswerStore } from './support/form-fixtures.mjs';
import { exampleRuntime } from './support/example-runtime.mjs';

const ACCOUNT = 'a4300000-0000-4000-8000-000000001001';
const CONTACT = 'a4300000-0000-4000-8000-000000002001';
const NATIVE = '/approach/out-of-the-box/account/';

let shared;
const runtime = () => (shared ??= exampleRuntime());

async function renderTraced(url, extra = {}) {
  const { renderer } = await runtime();
  const rendered = await renderer.renderPage(url, extra);
  assert.equal(rendered.status, 200, `${url} renders`);
  return { rendered, ...renderer.provenanceFor(rendered) };
}

const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
function walkElements(node, visit) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) visit(child);
    walkElements(child, visit);
    if (child.content) walkElements(child.content, visit);
  }
}
/** Every element of the document with its binding, and the elements under the roots `isRoot` selects. */
function bound(html, provenance, isRoot) {
  const bindings = new Map(provenance.bindings.map((item) => [item.id, item]));
  const refs = new Map(provenance.sourceRefs.map((ref) => [ref.id, ref]));
  const all = [],
    inside = [];
  const visit = (node, within) => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      const entry = { node: child, binding: bindings.get(attr(child, 'data-paqvilo-source')) ?? null };
      all.push(entry);
      const here = within || isRoot(child);
      if (here) inside.push(entry);
      visit(child, here);
      if (child.content) visit(child.content, here);
    }
  };
  visit(parse(html), false);
  return { all, inside, refs };
}
const describe = (node) =>
  `<${node.tagName}${node.attrs.map((item) => ` ${item.name}="${item.value.slice(0, 40)}"`).join('')}>`;
const COMPONENT_KINDS = new Set([
  'basic-form',
  'advanced-form',
  'advanced-form-step',
  'form',
  'form-tab',
  'form-section',
  'form-control',
  'field',
  'subgrid',
  'lookup-view',
  'quick-view',
  'list',
  'list-view',
  'pcf',
]);
function assertComponentBound(inside, label) {
  assert.ok(inside.length > 0, `${label}: the component markup is present`);
  for (const { node, binding } of inside) {
    assert.equal(binding?.mapping, 'platform', `${label}: ${describe(node)} has a platform binding`);
    assert.ok(COMPONENT_KINDS.has(binding.component.kind), `${label}: ${describe(node)} names a component`);
  }
}
const refKeys = (binding, refs) => binding.sourceRefIds.map((id) => refs.get(id)?.componentKey ?? refs.get(id)?.kind);
const contextKey = (binding, refs) => refs.get(binding.contexts?.[0]?.sourceRefId)?.componentKey ?? null;

async function formPage(mode, formName) {
  const { portal, metadata } = await runtime();
  const definition = portal.forms.find((form) => form.name === formName);
  const formId = metadata.componentSchemas[definition.id].formId;
  const query = { create: '?mode=create', edit: `?id=${ACCOUNT}&mode=edit`, read: `?id=${ACCOUNT}` }[mode];
  const { html, provenance } = await renderTraced(NATIVE + query);
  const wrapper = `EntityFormControl_${definition.id.replaceAll('-', '')}`;
  const result = bound(html, provenance, (node) => attr(node, 'id') === wrapper);
  return { definition, formId, html, provenance, ...result };
}

for (const [mode, formName] of [
  ['create', 'Account Create'],
  ['edit', 'Account Edit'],
  ['read', 'Account Read'],
])
  test(`a basic form in ${mode} mode binds every element to its basic form, FormXml and columns`, async () => {
    const { definition, formId, inside, refs } = await formPage(mode, formName);
    assertComponentBound(inside, formName);
    const basicFormKey = `basic-form:${definition.id}`;
    const wrapper = inside[0].binding.component;
    assert.equal(wrapper.key, basicFormKey);
    assert.equal(wrapper.formId, formId);
    // The account name cell: its cell, label, validators, control wrapper and input name the column and the FormXml.
    const nameCell = inside.filter(({ binding }) => binding.component.key === 'column:account:name');
    assert.ok(nameCell.length >= 3, `${formName}: the name cell elements are bound to the column`);
    for (const { node, binding } of nameCell) {
      assert.equal(binding.component.kind, 'field', describe(node));
      assert.equal(binding.component.field, 'name');
      assert.equal(binding.component.entity, 'account');
      assert.equal(binding.component.formId, formId);
      assert.equal(binding.component.controlName, 'name');
      assert.ok(refKeys(binding, refs).includes('column:account:name'), 'the column definition is a source');
      assert.ok(refKeys(binding, refs).includes('form:' + formId), 'the FormXml is a source');
      assert.equal(contextKey(binding, refs), basicFormKey, 'the basic form record is the context');
    }
    assert.ok(nameCell.some(({ node }) => node.tagName === 'td'));
    assert.ok(nameCell.some(({ node }) => node.tagName === 'label'));
    // Every field element names a column of the form's table, and every tab and section the form's FormXml.
    for (const { binding } of inside) {
      const { component } = binding;
      if (component.kind === 'field') assert.match(component.key, /^column:account:[a-z0-9_]+$/);
      if (component.kind === 'form-tab' || component.kind === 'form-section') {
        assert.ok(component.key.startsWith(`form:${formId}:${component.kind.slice(5)}:`), component.key);
        assert.ok(refKeys(binding, refs).includes('form:' + formId));
      }
    }
    const sections = new Set(
      inside
        .filter(({ binding }) => binding.component.kind === 'form-section')
        .map(({ binding }) => binding.component.key),
    );
    assert.ok(sections.has(`form:${formId}:section:Organisation`));
    if (mode !== 'read') {
      const select = inside.find(({ node }) => attr(node, 'id') === 'industrycode');
      assert.equal(select.binding.component.key, 'column:account:industrycode');
      assert.ok(
        inside.some(
          ({ node, binding }) => node.tagName === 'option' && binding.component.key === 'column:account:industrycode',
        ),
        'choice options belong to their column',
      );
    }
    const parts = new Set(inside.map(({ binding }) => binding.component.key));
    if (mode !== 'read') assert.ok(parts.has(`${basicFormKey}#actions`), 'the action buttons are a part of the form');
    assert.ok(parts.has(`${basicFormKey}#validation-summary`));
  });

test('a basic form with custom JavaScript, a subgrid and lookups names each of them', async () => {
  const { definition, inside, refs, provenance } = await formPage('edit', 'Account Edit');
  const basicFormKey = `basic-form:${definition.id}`;
  const script = inside.find(
    ({ node, binding }) => node.tagName === 'script' && binding.component.key === `${basicFormKey}#custom-javascript`,
  );
  assert.ok(script, 'the custom JavaScript element is bound to the form');
  const javascript = provenance.sourceRefs.find(
    (ref) => ref.recordId === definition.id && /customjavascript/.test(String(ref.fieldPath ?? ref.key)),
  );
  assert.ok(
    javascript && script.binding.sourceRefIds.includes(javascript.id),
    'its source is the customjavascript field',
  );
  const proof = provenance.scriptProofs.find((item) => item.id === attr(script.node, 'data-paqvilo-script'));
  assert.ok(
    proof?.mappings.some((mapping) => mapping.sourceRefId === javascript.id),
    'the script body has a proof',
  );
  const subgrid = inside.find(({ node }) => attr(node, 'id') === 'Contacts');
  assert.equal(subgrid.binding.component.kind, 'subgrid');
  assert.match(subgrid.binding.component.key, /^view:[0-9a-f-]{36}$/);
  assert.equal(subgrid.binding.component.controlName, 'Contacts');
  const insertDialog = inside.find(
    ({ node }) => node.tagName === 'section' && /modal-form-insert/.test(attr(node, 'class') ?? ''),
  );
  assert.equal(insertDialog.binding.component.key, `${subgrid.binding.component.key}#action:create`);
  assert.ok(
    refKeys(insertDialog.binding, refs).some((key) => key?.startsWith('basic-form:')),
    'the target form',
  );
  const lookup = inside.filter(({ binding }) => binding.component.kind === 'lookup-view');
  assert.ok(lookup.length > 0, 'lookup dialogs are bound to their lookup view');
  for (const { binding } of lookup) assert.ok(binding.component.field, 'a lookup view names its field');
});

test('a list rendered by the entity_list include binds its container, view, messages and every action dialog', async () => {
  const { portal } = await runtime();
  const list = portal.lists[0];
  const { html, provenance } = await renderTraced('/approach/out-of-the-box/');
  const { inside } = bound(html, provenance, (node) => (attr(node, 'class') ?? '').split(' ').includes('entitylist'));
  assertComponentBound(inside, list.name);
  const keys = inside.map(({ binding }) => binding.component.key);
  assert.equal(keys[0], `list:${list.id}`);
  const grid = inside.find(({ node }) => (attr(node, 'class') ?? '').includes('entity-grid'));
  assert.equal(grid.binding.component.key, `view:${attr(grid.node, 'data-selected-view')}`);
  for (const part of ['empty', 'access-denied', 'error', 'loading', 'pagination', 'action:create', 'action:delete'])
    assert.ok(keys.includes(`list:${list.id}#${part}`), `list part ${part}`);
  for (const { binding } of inside) assert.match(binding.component.key, /^(?:list|view):/);
});

test('an authored entitylist and entityview block page leaves no element of either list unbound', async () => {
  const user = { id: CONTACT, contactId: CONTACT, fullname: 'Alex Example 01', roles: [] };
  const { html, provenance } = await renderTraced('/liquid/views/', { user });
  const { inside } = bound(html, provenance, (node) => attr(node, 'data-liquid-page') === 'views');
  for (const { node, binding } of inside) assert.ok(binding, `${describe(node)} is bound`);
  const native = inside.filter(
    ({ binding }) => binding.mapping === 'platform' && binding.component.kind !== 'platform-shell',
  );
  assert.ok(
    native.some(({ binding }) => binding.component.kind === 'list'),
    'the native list is bound to its list',
  );
});

test('a code component page binds the host element and both of its scripts to the PCF control', async () => {
  const { html, provenance } = await renderTraced('/approach/pcf/account/');
  const { all } = bound(html, provenance, () => false);
  const host = all.findIndex(({ node }) => attr(node, 'data-pcf-schema'));
  assert.ok(host > 0, 'the code component host renders');
  const schema = attr(all[host].node, 'data-pcf-schema');
  for (const { node, binding } of all.slice(host - 1, host + 2)) {
    assert.equal(binding?.mapping, 'platform', describe(node));
    assert.equal(binding.component.key, 'pcf:' + schema.toLowerCase());
  }
  assert.equal(all[host - 1].node.tagName, 'script');
  assert.equal(all[host + 1].node.tagName, 'script');
});

test('every platform interval of a rendered component binds its element (no silent fallback)', async () => {
  const { portal, renderer } = await runtime();
  const page = portal.pages.find((item) => item.url === NATIVE);
  for (const [source, url] of [
    ["{% entityform name: 'Account Edit' %}", `${NATIVE}?id=${ACCOUNT}&mode=edit`],
    ["{% entityform name: 'Account Create' %}", `${NATIVE}?mode=create`],
    ["{% include 'entity_list' key: 'b4700000-0000-4000-8000-7194d58d3aa1' %}", '/approach/out-of-the-box/'],
  ]) {
    const context = renderer.contextForPage(page, url, {});
    const result = await renderer.renderStringWithProvenance(source, context);
    const platform = result.fragment.intervals.filter((span) => span.mapping === 'platform');
    const elements = [];
    walkElements(parseFragment(result.fragment.text, { sourceCodeLocationInfo: true }), (node) => elements.push(node));
    assert.equal(platform.length, elements.length, `${source}: one platform interval per element`);
    const platformBindings = result.provenance.bindings.filter((item) => item.mapping === 'platform');
    assert.equal(platformBindings.length, platform.length, `${source}: every platform interval binds its element`);
    assert.equal(result.html.replaceAll(/ data-paqvilo-(?:source|script)="[^"]*"/g, ''), result.fragment.text);
  }
});

test('component markup is unchanged by render provenance', async () => {
  const { portal, metadata } = await runtime();
  const store = { resolveMapping: () => ({ idColumn: 'accountid', nameColumn: 'name' }), get: async () => null };
  const options = { portal, store, metadata, schemas: metadata.componentSchemas, args: { name: 'Account Create' } };
  const plain = await renderComponent('entityform', 'Account Create', { request: { params: {} } }, options);
  const components = [];
  const reported = await renderComponent(
    'entityform',
    'Account Create',
    { request: { params: {} } },
    { ...options, onComponentRendered: (item) => components.push(item) },
  );
  assert.equal(reported, plain);
  assert.equal(components.length, 1);
  assert.equal(componentRenderResult(reported, { components, tag: 'entityform' }).html, plain);
});

// D1: the server form moves data-pp-viewstate into __VIEWSTATE; the intervals after it are re-based on that removal.
test('a form whose state moves into the server form keeps the bindings of the snippet and page copy after it', async () => {
  const wrapper = 'EntityFormControl_state';
  const { renderer, portal } = await exampleRuntime({
    editPortal: (portal) => {
      const page = portal.pages.find((item) => item.url === NATIVE);
      const copy = `<div class="demo">{% entityform name: 'Account Create' %}{{ snippets['Demo/Access guidance'] }}<p class="after-form">After the form</p></div>`;
      page.html = copy;
      for (const translation of Object.values(page.translations ?? {})) translation.html = copy;
    },
    renderOverride: {
      entityform: ({ provenance, components }) => {
        components.push({
          type: 'basic-form',
          id: portal.forms.find((form) => form.name === 'Account Create').id,
          name: 'Account Create',
          entity: 'account',
          formId: null,
          ids: { wrapper, panel: 'panel', view: 'view' },
          layout: { tabs: [], sections: [], cells: [] },
        });
        return provenance(
          `<!--pp-native-form--><div id="${wrapper}" data-pp-viewstate="moved/state"><input type="text" name="field" id="field"></div>`,
        );
      },
    },
  });
  const rendered = await renderer.renderPage(NATIVE + '?mode=create');
  const { html, provenance } = renderer.provenanceFor(rendered);
  assert.doesNotMatch(html, /data-pp-viewstate/);
  assert.match(html, /id="__VIEWSTATE" value="moved\/state"/);
  const { all, refs } = bound(html, provenance, () => false);
  const find = (predicate) => all.find(({ node }) => predicate(node));
  const form = find((node) => attr(node, 'id') === wrapper);
  assert.equal(form.binding?.mapping, 'platform');
  assert.match(form.binding.component.key, /^basic-form:/);
  assert.equal(find((node) => attr(node, 'id') === 'field').binding?.component.key, form.binding.component.key);
  const snippet = find((node) => node.attrs.some((item) => item.name === 'data-demo-access'));
  assert.equal(snippet.binding?.mapping, 'literal', 'the snippet after the form stays literal');
  assert.equal(refs.get(snippet.binding.sourceRefId)?.name, 'Demo/Access guidance');
  const after = find((node) => attr(node, 'class') === 'after-form');
  assert.equal(after.binding?.mapping, 'literal', 'the page copy after the form stays literal');
  assert.match(
    String(refs.get(after.binding.sourceRefId)?.fieldPath ?? refs.get(after.binding.sourceRefId)?.key),
    /copy/,
  );
});

// ---- Multistep forms (invented fixture): wrapper, step, fields and every progress indicator type.
const multistep = (indicator) => ({
  website: { id: 'site' },
  forms: [],
  lists: [],
  pages: [],
  settings: {},
  websiteLanguages: [{ lcid: 1033, isDefault: true }],
  advancedForms: [
    { id: 'survey', name: 'Survey Wizard', metadata: { adx_progressindicatorenabled: true, ...indicator } },
  ],
  records: [],
});
const stepSchema = (stepId, extra) => ({
  stepId,
  entity: 'answer',
  mode: 100000000,
  formName: 'Answer Compact',
  formId: 'f0000000-0000-4000-8000-0000000000aa',
  metadata: { id: stepId, name: `Step ${stepId}`, adx_entitypermissionsenabled: true },
  fields: [{ name: 'note', label: 'Note', dataverseType: 'nvarchar', maxLength: 50 }],
  layout: [{ name: 'tab', columns: [{ sections: [{ name: 's', rows: [[{ name: 'note' }]] }] }] }],
  ...extra,
});
const ONE = 'a0000000-0000-4000-8000-000000000001',
  TWO = 'a0000000-0000-4000-8000-000000000002';
const surveySchemas = {
  survey: {
    initialStepId: ONE,
    steps: [stepSchema(ONE, { nextStepId: TWO, title: 'One' }), stepSchema(TWO, { title: 'Two' })],
  },
};

for (const [label, indicator] of [
  ['title', {}],
  ['numeric', { adx_progressindicatortype: 756150001 }],
  ['progress bar', { adx_progressindicatortype: 756150002 }],
  ['left title', { adx_progressindicatorposition: 756150002 }],
])
  test(`a multistep form with a ${label} progress indicator binds every element (D5, D17)`, async () => {
    const components = [],
      explicit = [];
    const html = await renderComponent(
      'webform',
      'Survey Wizard',
      { request: { params: {} } },
      {
        portal: multistep(indicator),
        store: emptyAnswerStore(),
        schemas: surveySchemas,
        renderLiquid: async (source) => source,
        webFormSessions: createWebFormSessions(),
        webFormOwner: () => 'visitor:a',
        onComponentRendered: (item) => components.push(item),
        onProgressRendered: (item) => explicit.push(item),
      },
    );
    const spans = platformComponentIntervals({ html, components, explicit, tag: 'webform' });
    const elements = [];
    walkElements(parseFragment(html, { sourceCodeLocationInfo: true }), (node) => elements.push(node));
    const byStart = new Map(spans.map((span) => [span.start, span]));
    assert.equal(byStart.size, spans.length, 'one interval per start tag');
    for (const node of elements) {
      const span = byStart.get(node.sourceCodeLocation.startTag.startOffset);
      assert.ok(span, `${describe(node)} has a platform interval`);
      assert.equal(span.end, node.sourceCodeLocation.startTag.endOffset);
      assert.equal(span.tag, node.tagName);
    }
    const keyOf = (predicate) =>
      byStart.get(elements.find(predicate).sourceCodeLocation.startTag.startOffset).component.key;
    assert.equal(
      keyOf((node) => attr(node, 'id') === 'WebFormControl_survey'),
      'advanced-form:survey',
    );
    assert.equal(
      keyOf((node) => attr(node, 'id') === 'WebFormControl_survey_ProgressIndicator'),
      'advanced-form:survey#progress',
    );
    assert.equal(
      keyOf((node) => attr(node, 'id') === 'WebFormPanel'),
      `advanced-form-step:${ONE}`,
    );
    assert.equal(
      keyOf((node) => attr(node, 'id') === 'note'),
      'column:answer:note',
    );
    assert.equal(
      keyOf((node) => (attr(node, 'class') ?? '') === 'actions'),
      `advanced-form-step:${ONE}#actions`,
    );
    const progress = elements.filter((node) => {
      for (let current = node; current; current = current.parentNode)
        if (attr(current, 'id') === 'WebFormControl_survey_ProgressIndicator') return true;
      return false;
    });
    assert.ok(progress.length > 1, 'the indicator has inner elements');
    for (const node of progress) {
      const key = byStart.get(node.sourceCodeLocation.startTag.startOffset).component.key;
      if (node.tagName === 'li') assert.match(key, /^advanced-form-step:a0000000-/, 'a step item names its step');
      else if (node.parentNode?.tagName !== 'li') assert.equal(key, 'advanced-form:survey#progress', describe(node));
    }
  });

test("a multistep step's custom JavaScript is bound to the step and proved against its exported source (D15)", () => {
  const javascript = 'window.stepSeen = true;';
  const portal = {
    ...multistep({}),
    records: [{ kind: 'advancedformstep', id: ONE, name: 'Step one', customJavascript: javascript }],
  };
  const schemas = {
    survey: {
      ...surveySchemas.survey,
      steps: [stepSchema(ONE, { nextStepId: TWO, js: javascript }), stepSchema(TWO)],
    },
  };
  return (async () => {
    const components = [];
    const html = await renderComponent(
      'webform',
      'Survey Wizard',
      { request: { params: {} } },
      {
        portal,
        store: emptyAnswerStore(),
        schemas,
        renderLiquid: async (source) => source,
        webFormSessions: createWebFormSessions(),
        webFormOwner: () => 'visitor:a',
        onComponentRendered: (item) => components.push(item),
      },
    );
    const index = buildPortalSourceIndex({ portal });
    const source = index.source({ id: ONE }, 'customjavascript');
    const spans = platformComponentIntervals({ html, components, index, tag: 'webform' });
    const literal = spans.find((span) => span.mapping === 'literal');
    assert.equal(literal?.sourceRefId, source.id, 'the script body is the exported step JavaScript');
    assert.equal(html.slice(literal.start, literal.end), javascript);
    const script = spans.find((span) => span.tag === 'script' && span.component?.key.endsWith('#custom-javascript'));
    assert.equal(script.component.key, `advanced-form-step:${ONE}#custom-javascript`);
    assert.ok(script.sourceRefIds.includes(source.id));
    const intervals = spans.map((span) => (span.mapping === 'literal' ? span : { ...span, mapping: 'platform' }));
    const { provenance } = finalizePortalProvenance({ fragment: { text: html, intervals }, index });
    assert.ok(provenance.scriptProofs.some((proof) => proof.mappings.some((item) => item.sourceRefId === source.id)));
  })();
});

test("a list's custom JavaScript is bound to the list and proved against its exported source (D15)", async () => {
  const javascript = "document.documentElement.dataset.listSeen = 'yes';";
  const { renderer, portal } = await exampleRuntime({
    editPortal: (portal) => {
      portal.lists[0].js = javascript;
    },
  });
  const rendered = await renderer.renderPage('/approach/out-of-the-box/');
  const { html, provenance } = renderer.provenanceFor(rendered);
  const list = portal.lists[0];
  const { inside } = bound(html, provenance, (node) => (attr(node, 'class') ?? '').split(' ').includes('entitylist'));
  const script = inside.find(({ node }) => node.tagName === 'script');
  assert.equal(script.binding.component.key, `list:${list.id}#custom-javascript`);
  const source = provenance.sourceRefs.find(
    (ref) =>
      ref.recordId === list.id &&
      script.binding.sourceRefIds.includes(ref.id) &&
      ref.componentKey !== `list:${list.id}`,
  );
  assert.ok(source, 'the customjavascript field is a source of the script element');
  const proof = provenance.scriptProofs.find((item) => item.id === attr(script.node, 'data-paqvilo-script'));
  assert.ok(
    proof?.mappings.some((mapping) => mapping.sourceRefId === source.id),
    'the list script body has a proof',
  );
});

test('a code component bound to a form field names the PCF control and the FormXml control of the field (D16)', async () => {
  const schema = 'exa_Synthetic.AmountControl';
  const field = {
    name: 'amount',
    label: 'Amount',
    dataverseType: 'decimal',
    type: 'number',
    controlStyle: 756150001,
    codeComponent: {
      name: schema,
      boundAttributes: ['amount'],
      parameters: { value: { kind: 'binding', column: 'amount', type: 'Decimal' } },
    },
  };
  const components = [];
  const html = await renderComponent(
    'entityform',
    'create',
    {},
    {
      portal: {
        forms: [{ id: 'create', name: 'Create synthetic row', mode: 100000000 }],
        records: [
          {
            kind: 'basicformmetadata',
            adx_entityform: 'create',
            adx_attributelogicalname: 'amount',
            adx_type: 100000000,
            adx_controlstyle: 756150001,
          },
        ],
        pages: [],
        website: { id: 'site' },
      },
      schemas: {
        create: {
          entity: 'synthetic',
          formId: 'f0000000-0000-4000-8000-0000000000bb',
          fields: [field],
          layout: [{ name: 'tab', columns: [{ sections: [{ name: 'main', rows: [[{ name: 'amount' }]] }] }] }],
        },
      },
      store: {
        resolveMapping: () => ({ entitySet: 'synthetics', idColumn: 'syntheticid' }),
        query: () => ({ value: [] }),
      },
      codeComponent: async (spec) =>
        spec.onNativeBinding?.({ properties: ['value'] }, {}) ??
        `<script src="${PCF_HOST_SCRIPT}"></script><div data-mirage-component="codecomponent" data-pcf-schema="${schema}" aria-busy="true"></div><script>window.mounted = true;</script>`,
      onComponentRendered: (item) => components.push(item),
    },
  );
  const spans = platformComponentIntervals({ html, components, tag: 'entityform' });
  const pcf = spans.filter((span) => span.component.kind === 'pcf');
  assert.deepEqual(
    pcf.map((span) => span.tag),
    ['script', 'div', 'script'],
  );
  for (const span of pcf) {
    assert.equal(span.component.key, 'pcf:' + schema.toLowerCase());
    assert.equal(span.component.field, 'amount');
    assert.equal(span.component.controlName, 'amount');
    assert.equal(span.component.formId, 'f0000000-0000-4000-8000-0000000000bb');
  }
  // The field host markup of the column (lib/pcf-field-host.mjs) belongs to the column.
  const wrapper = spans.find((span) => html.slice(span.start, span.end).includes('id="PcfControl_'));
  assert.equal(wrapper.component.key, 'column:synthetic:amount');
});

test('component tags without a configuration name the tag and its arguments', () => {
  const spans = platformComponentIntervals({
    html: '<div class="paqvilo-powerbi-placeholder" data-mirage-component="powerbi">Power BI report is not rendered locally.</div>',
    tag: 'powerbi',
    args: { path: 'https://example.invalid/report?token=secret#page=1', authentication_type: 'AAD' },
  });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].component.kind, 'liquid-tag');
  assert.equal(spans[0].component.key, 'liquid-tag:powerbi');
  assert.deepEqual(spans[0].component.arguments, {
    path: 'https://example.invalid/report?token=…#page=…',
    authentication_type: 'AAD',
  });
});

// ---- Exact FormXml placements (item A): a field names its FormXml control, a tab or section its FormXml element.
const sourceLine = (file, pattern) =>
  fs
    .readFileSync(file, 'utf8')
    .split(/\r\n|\r|\n/)
    .findIndex((line) => pattern.test(line)) + 1;

test('a field, tab and section name their FormXml element with its region, and the region opens at that line', async () => {
  const { renderer, portal } = await runtime();
  const { formId, inside, refs } = await formPage('edit', 'Account Edit');
  // The index of the page's website language (the one its render was finalized with).
  const page = portal.pages.find((item) => item.url === NATIVE);
  const index = renderer.sourceIndex(renderer.contextForPage(page, NATIVE).__language?.id);
  const cell = inside.find(({ binding }) => binding.component.key === 'column:account:name');
  const [controlId, columnId, formRefId] = cell.binding.sourceRefIds;
  const control = refs.get(controlId);
  assert.equal(control.componentKey, `control:${formId}:name:body`, 'the FormXml control is the first source');
  assert.equal(refs.get(columnId).componentKey, 'column:account:name', 'then the column definition');
  assert.equal(refs.get(formRefId).componentKey, `form:${formId}`, 'then the FormXml');
  // The control's own region: the control element's line in the FormXml file.
  const file = control.ref;
  assert.equal(control.region.line, sourceLine(file, /<control id="name"/));
  for (const field of ['ref', 'key', 'sourceRevision', 'contentRevision'])
    assert.ok(control[field], `the control ref carries ${field} (lense/inspection-evidence.mjs)`);
  const opened = index.metadataIndex.resolveOpen({
    sourceKey: control.id,
    componentKey: control.componentKey,
    sourceRevision: control.sourceRevision,
    contentRevision: control.contentRevision,
  });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.equal(opened.line, control.region.line, 'Open source goes to the control line');
  // A section names its <section> element, a subgrid its control and the form metadata row that configures it.
  const section = inside.find(({ binding }) => binding.component.key === `form:${formId}:section:Organisation`);
  const sectionRef = refs.get(section.binding.sourceRefIds[0]);
  assert.match(sectionRef.componentKey, new RegExp(`^section:${formId}:`));
  assert.equal(sectionRef.region.line, sourceLine(file, /<section name="Organisation"/));
  const subgrid = inside.find(({ node }) => attr(node, 'id') === 'Contacts');
  const subgridKeys = refKeys(subgrid.binding, refs);
  assert.equal(subgridKeys[0], `control:${formId}:contacts:body`);
  assert.ok(
    subgridKeys.some((key) => key?.startsWith('basic-form-metadata:')),
    'the basic form metadata row that configures the subgrid is a source',
  );
  // Every field and section of the form names its FormXml element first; the context is the basic form record.
  for (const { binding } of inside) {
    const first = refs.get(binding.sourceRefIds[0])?.componentKey ?? '';
    if (binding.component.kind === 'field' && binding.component.controlName)
      assert.match(first, new RegExp(`^control:${formId}:`), binding.component.key);
    if (binding.component.kind === 'form-section') assert.match(first, new RegExp(`^section:${formId}:`));
  }
});

test('form placements are loaded once per form into the source index, on first use', async () => {
  const { metadata } = await runtime();
  const { renderer } = await exampleRuntime();
  const index = renderer.sourceIndex();
  const formId = metadata.componentSchemas['b4700000-0000-4000-8000-9abf530078c2'].formId;
  const before = index.sources.size;
  const placements = index.formSources(formId);
  assert.ok(placements.controls.length > 0 && placements.structure.length > 0);
  assert.ok(index.sources.size > before, 'the FormXml controls, tabs and sections become sources');
  for (const id of placements.refs.values()) assert.ok(index.sources.get(id).region, 'each placement has a region');
  assert.equal(index.formSources(formId), placements, 'one load per form');
  assert.equal(index.formSources('f0000000-0000-4000-8000-00000000dead').refs.size, 0);
});

// ---- Coverage of form and list variants (item F).
const ACCOUNT_LIST = 'b4700000-0000-4000-8000-7194d58d3aa1';

test('the Bootstrap 5 form and list markup binds every element to its form, columns, list and view', async () => {
  const { renderer, portal } = await exampleRuntime({
    editPortal: (portal) => {
      portal.settings = { ...portal.settings, 'Site/BootstrapV5Enabled': 'true' };
    },
  });
  const definition = portal.forms.find((form) => form.name === 'Account Edit');
  for (const [url, isRoot] of [
    [
      `${NATIVE}?id=${ACCOUNT}&mode=edit`,
      (node) => attr(node, 'id') === `EntityFormControl_${definition.id.replaceAll('-', '')}`,
    ],
    ['/approach/out-of-the-box/', (node) => (attr(node, 'class') ?? '').split(' ').includes('entitylist')],
  ]) {
    const rendered = await renderer.renderPage(url);
    const { html, provenance } = renderer.provenanceFor(rendered);
    assert.match(html, /BootstrapV5/, 'the Bootstrap 5 build renders');
    assert.equal(provenance.unbound, 0, url);
    const { inside } = bound(html, provenance, isRoot);
    assertComponentBound(inside, url);
    const keys = new Set(inside.map(({ binding }) => binding.component.key));
    if (url.includes('mode=edit')) {
      assert.ok(keys.has('column:account:name'));
      assert.ok(keys.has(`basic-form:${definition.id}#actions`));
    } else assert.ok(keys.has(`list:${ACCOUNT_LIST}`) && [...keys].some((key) => key.startsWith('view:')));
  }
});

test('a form, a list and the poll and ad placements of a Page.aspx rewrite page bind to their configuration', async () => {
  const id = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const { renderer, portal } = await exampleRuntime({
    editPortal: (portal) => {
      portal.pageTemplates.push({
        id: id(1),
        name: 'Invented rewrite',
        webTemplateId: null,
        useHeaderFooter: true,
        rewriteUrl: '~/Pages/Page.aspx',
        metadata: { id: id(1), kind: 'pagetemplate', name: 'Invented rewrite', rewriteurl: '~/Pages/Page.aspx' },
      });
      portal.records.push(
        { kind: 'pagetemplate', id: id(1), name: 'Invented rewrite', rewriteurl: '~/Pages/Page.aspx' },
        { kind: 'pollplacement', id: id(10), name: 'Sidebar', adx_pollplacement_poll: [id(11)] },
        { kind: 'poll', id: id(11), name: 'Invented poll', adx_question: 'Invented question?' },
        { kind: 'polloption', id: id(12), name: 'Yes', adx_pollid: id(11), adx_answer: 'Yes' },
        { kind: 'adplacement', id: id(20), name: 'Sidebar Bottom', adx_adplacement_ad: [id(21)] },
        { kind: 'ad', id: id(21), name: 'Invented ad', adx_title: 'Invented ad', adx_copy: '<p>Ad</p>' },
      );
      const formId = portal.forms.find((form) => form.name === 'Account Create').id;
      const page = portal.pages.find((item) => item.url === '/extended/');
      for (const variant of [page, ...Object.values(page.translations ?? {})])
        Object.assign(variant, { pageTemplateId: id(1), formId, listId: ACCOUNT_LIST });
    },
  });
  const rendered = await renderer.renderPage('/extended/');
  assert.equal(rendered.status, 200);
  const { html, provenance } = renderer.provenanceFor(rendered);
  assert.equal(provenance.unbound, 0);
  assert.equal(provenance.omitted, 0);
  const form = portal.forms.find((item) => item.name === 'Account Create');
  const { all, refs } = bound(html, provenance, () => false);
  const keys = new Set(all.map(({ binding }) => binding?.component?.key).filter(Boolean));
  assert.ok(keys.has(`basic-form:${form.id}`), 'the page form');
  assert.ok(keys.has(`list:${ACCOUNT_LIST}`), 'the page list');
  assert.ok(keys.has('page-template:' + id(1)), 'the rewrite layout');
  // The poll and ad placement placeholders name their placement records.
  for (const [kind, record] of [
    ['polls', 'poll-placement:' + id(10)],
    ['ads', 'ad-placement:' + id(20)],
  ]) {
    const found = all.find(({ node }) => (attr(node, 'data-url') ?? '').startsWith(`/_services/${kind}/`));
    assert.ok(found, `${kind} placement placeholder`);
    const contexts = (found.binding.contexts ?? []).map((context) => refs.get(context.sourceRefId)?.componentKey);
    assert.ok(contexts.includes(record), `${kind}: ${JSON.stringify(contexts)}`);
  }
});

test('an observed chart placeholder names the chart and the view it shows', async () => {
  const { renderer, portal } = await exampleRuntime({
    editPortal: (portal) => {
      portal.observed = { ...portal.observed, liquidServiceTags: 'observed' };
    },
  });
  const page = portal.pages.find((item) => item.url === '/extended/');
  const view = 'a4200000-0000-4000-8000-000000000504';
  const result = await renderer.renderStringWithProvenance(
    `{% chart id:'c0de0000-0000-4000-8000-0000000000c1' viewid:'${view}' %}`,
    renderer.contextForPage(page, '/extended/', {}),
  );
  const chart = result.provenance.bindings.find((binding) => binding.tag === 'div');
  assert.equal(chart.component.kind, 'chart');
  assert.equal(chart.component.key, 'chart:c0de0000-0000-4000-8000-0000000000c1');
  assert.equal(chart.component.viewId, view);
  const refs = new Map(result.provenance.sourceRefs.map((ref) => [ref.id, ref]));
  assert.ok(refKeys(chart, refs).includes('view:' + view), 'the view definition is a source');
  assert.equal(result.provenance.unbound, 0);
});

test('every element of a subgrid with actions and of a lookup dialog names its view and the action it serves', async () => {
  const { inside, refs } = await formPage('edit', 'Account Edit');
  const grid = inside.find(({ node }) => attr(node, 'id') === 'Contacts');
  const viewKey = grid.binding.component.key;
  const within = (root) => {
    const rows = [];
    const visit = (node) => {
      for (const child of node.childNodes ?? []) {
        if (!child.tagName) continue;
        const row = inside.find((entry) => entry.node === child);
        if (row) rows.push(row);
        visit(child);
      }
    };
    visit(root);
    return rows;
  };
  const cell = grid.node.parentNode?.tagName === 'td' ? grid.node.parentNode : grid.node;
  const cellRows = within(cell).filter(({ binding }) => binding.component.kind !== 'lookup-view');
  assert.ok(cellRows.length > 20, 'the subgrid has its grid, messages and action dialogs');
  for (const { node, binding } of cellRows)
    assert.ok(
      binding.component.key === viewKey || binding.component.key.startsWith(viewKey + '#'),
      `${describe(node)} names the subgrid view (${binding.component.key})`,
    );
  const actions = new Set(cellRows.map(({ binding }) => binding.component.key));
  for (const action of ['create', 'edit', 'details', 'delete'])
    assert.ok(actions.has(`${viewKey}#action:${action}`), action);
  // A dialog that opens a basic form names that basic form.
  const create = cellRows.find(({ binding }) => binding.component.key === `${viewKey}#action:create`);
  assert.ok(refKeys(create.binding, refs).some((key) => key?.startsWith('basic-form:')));
  // The lookup dialogs: every element is the lookup view of its field.
  const lookups = inside.filter(
    ({ node }) => node.tagName === 'section' && /modal-lookup/.test(attr(node, 'class') ?? ''),
  );
  assert.ok(lookups.length > 0);
  for (const lookup of lookups)
    for (const { node, binding } of [lookup, ...within(lookup.node)]) {
      assert.equal(binding.component.kind, 'lookup-view', describe(node));
      assert.ok(binding.component.field, 'the lookup view names its field');
    }
});

// A page whose web template hosts the invented multistep form: the whole document, finalized.
for (const [label, indicator] of [
  ['numeric', { adx_progressindicatortype: 756150001 }],
  ['progress bar', { adx_progressindicatortype: 756150002 }],
])
  test(`a page hosting a multistep form with a ${label} progress indicator leaves no element unbound`, async () => {
    const page = {
      id: 'c0de0000-0000-4000-8000-0000000000d1',
      name: 'Wizard',
      title: 'Wizard',
      url: '/',
      parentId: null,
      pageTemplateId: 'c0de0000-0000-4000-8000-0000000000d2',
      html: '',
      css: '',
      js: '',
      summary: '',
      metadata: { id: 'c0de0000-0000-4000-8000-0000000000d1', kind: 'webpage', name: 'Wizard', title: 'Wizard' },
    };
    const layout = {
      id: 'c0de0000-0000-4000-8000-0000000000d3',
      name: 'Wizard layout',
      source: `<section class="wizard">{% webform name: 'Survey Wizard' %}</section>`,
      metadata: { id: 'c0de0000-0000-4000-8000-0000000000d3', kind: 'webtemplate', name: 'Wizard layout' },
    };
    const portal = {
      ...multistep(indicator),
      sourceDir: null,
      pages: [page],
      pageTemplates: [
        {
          id: page.pageTemplateId,
          name: 'Wizard template',
          webTemplateId: layout.id,
          useHeaderFooter: true,
          rewriteUrl: null,
          metadata: { id: page.pageTemplateId, kind: 'pagetemplate', name: 'Wizard template' },
        },
      ],
      templates: { [layout.id]: layout },
      snippets: {},
      webFiles: [],
      shortcuts: [],
      records: [page.metadata, layout.metadata, { kind: 'advancedform', id: 'survey', name: 'Survey Wizard' }],
    };
    const renderer = createPortalRenderer(portal, {
      renderComponent: async (kind, args, context) => {
        const components = [],
          explicit = [];
        const html = await renderComponent(kind, args?.name ?? args, context, {
          portal,
          store: emptyAnswerStore(),
          schemas: surveySchemas,
          renderLiquid: async (source) => source,
          webFormSessions: createWebFormSessions(),
          webFormOwner: () => 'visitor:a',
          onComponentRendered: (item) => components.push(item),
          onProgressRendered: (item) => explicit.push(item),
        });
        return componentRenderResult(html, { components, explicit, index: renderer.sourceIndex(), tag: kind, args });
      },
    });
    const rendered = await renderer.renderPage('/');
    assert.equal(rendered.status, 200);
    const { html, provenance } = renderer.provenanceFor(rendered);
    assert.equal(provenance.unbound, 0);
    assert.equal(provenance.omitted, 0);
    const { inside } = bound(html, provenance, (node) => attr(node, 'id') === 'WebFormControl_survey');
    assertComponentBound(inside, label);
    const progress = inside.filter(({ binding }) => binding.component.key.startsWith('advanced-form:survey#progress'));
    assert.ok(progress.length > 0, 'the progress indicator is a part of the advanced form');
    assert.ok(
      inside.some(({ binding }) => binding.component.key === `advanced-form-step:${ONE}`),
      'the rendered step names itself',
    );
  });
