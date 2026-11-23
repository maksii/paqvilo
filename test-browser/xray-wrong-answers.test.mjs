// @test-kind observation: form, list and grid shapes from client-side DOM snapshots of six Microsoft Power Pages template sites (replica batch 1 and 2 originals/dom: div.tab directly under the form view holding div.tab-column, table.section in a fieldset inside it, td.cell holding div.table-info and div.control[data-logical-name], the Select and Actions headers of entity grids with markup in data-th), 2026-11; every table, column, form, list and view name and every ID here is invented
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { observePortalNode } from '../lense/portal-node-observation.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const origin = 'http://127.0.0.1:11898';
const EMPTY = '00000000-0000-0000-0000-000000000000';
const FORM_ID = 'a1b2c3d4-0000-4000-8000-00000000f001';
const HEX = FORM_ID.replaceAll('-', '');
const FORMXML_ID = 'a1b2c3d4-0000-4000-8000-00000000f0f1';
const VIEW_ID = 'a1b2c3d4-0000-4000-8000-00000000b001';
const LIST_ID = 'a1b2c3d4-0000-4000-8000-00000000a001';
const OTHER_LIST_ID = 'a1b2c3d4-0000-4000-8000-00000000a002';
const scope = { documentId: 'wrong-answers', frameId: 'top', uiEpoch: 1, sourceRevision: 'wrong-answers-source' };
const layout = `<span data-form-layout='{"EntityName":"sample_entry","Id":"${EMPTY}"}'></span>`;
const viewLayouts = (columns) =>
  Buffer.from(
    JSON.stringify([
      {
        Configuration: { EntityName: 'sample_entry', ViewId: VIEW_ID },
        Columns: columns.map(([LogicalName, Name]) => ({ LogicalName, Name })),
        Id: VIEW_ID,
      },
    ]),
  ).toString('base64');
// A cell as the portal renders it: div.table-info with the label, div.control with the column's control.
const cell = (column, control = `<input type="text" id="${column}" class="text form-control">`) =>
  `<td class="clearfix cell text form-control-cell"><div class="table-info"><label for="${column}" id="${column}_label" class="field-label">L</label><div class="validators"></div></div><div class="control" data-logical-name="${column}">${control}</div></td>`;
// A basic form: wrapper, panel, form view with its layout span, a tab under the form view, its column, the fieldset and
// the section table with the given cells; `inside` is markup placed directly in the form view.
const basicForm = (cells, inside = '') =>
  `<div id="EntityFormControl_${HEX}"><div id="EntityFormPanel" class="crmEntityFormView"><div id="EntityFormControl_${HEX}_EntityFormView" class="entity-form">${layout}` +
  `<h2 class="tab-title">General</h2><div class="tab clearfix" data-name="general_tab"><div class="tab-column"><div><fieldset><legend class="section-title">Main</legend><table class="section" data-name="main_section" role="presentation"><tbody><tr>${cells}</tr></tbody></table></fieldset></div></div></div>` +
  `${inside}</div></div></div>`;
const form = {
  id: FORM_ID,
  kind: 'basic-form',
  entity: 'sample_entry',
  name: 'Invented entry form',
  formXml: {
    id: FORMXML_ID,
    name: 'Invented main form',
    layout: [{ name: 'general_tab', sections: ['main_section'] }],
  },
};
const columns = ['sample_title', 'sample_note', 'sample_other', 'sample_a', 'sample_c', 'sample_d'].map((name) => ({
  entity: 'sample_entry',
  name,
}));
const list = (id, pageReferenced) => ({
  id,
  recordId: id,
  kind: 'list',
  entity: 'sample_entry',
  name: 'Invented list ' + id.slice(-1),
  viewIds: [VIEW_ID],
  pageReferenced,
});
const bindingsOf = (extra = {}) => ({
  forms: [form],
  lists: [],
  views: [{ id: VIEW_ID, entity: 'sample_entry', name: 'Invented view' }],
  columns,
  codeComponents: [],
  ...extra,
});

async function pageOf(t, html) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.route(origin + '/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>' + html + '</body>' }),
  );
  await page.goto(origin + '/');
  return page;
}

// The portal observation as X-ray runs it, for the page's own document.
async function observer(t, html) {
  const page = await pageOf(t, html);
  const read = new Function(
    'data',
    `const node=document.querySelector(data.selector);return (${observePortalNode.toString()})(node,{...data.options,bindings:{...data.options.bindings,pageDocument:document}});`,
  );
  return async (selector, bindings = bindingsOf()) => {
    const packet = await page.evaluate(read, { selector, options: { scope, bindings } });
    return resolveInspectionEvidence({ ...packet, mode: 'live', node: { connected: true } });
  };
}

const summary = (evidence) => ({
  owner: [evidence.owner.status, evidence.owner.component?.key ?? null],
  enclosing: evidence.enclosing.map((row) => row.status + ' ' + row.component?.key),
});

async function xrayPage(t, html, report, extra = {}, initScript) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await page.route(origin + '/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>' + html + '</body>' }),
  );
  await page.goto(origin + '/');
  const data = { origin, token: 'invented-wrong-answers', ...extra };
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, report }) => {
      const api = Document.prototype.getElementById.call(document, 'paqvilo-xray').__px;
      api.update(data, report);
      api.toggle(true);
    },
    { data, report },
  );
  return page;
}
const identified = (page, selectors) =>
  page.evaluate((selectors) => {
    const api = document.getElementById('paqvilo-xray').__px;
    return selectors.map((selector) => {
      const found = api.identify(document.querySelector(selector));
      return {
        title: found.title,
        kind: found.kind,
        owner: [found.evidence.owner.status, found.evidence.owner.component?.key ?? null],
        enclosing: found.evidence.enclosing.map((row) => row.status + ' ' + row.component?.key),
        candidates: found.evidence.candidates.map((row) => row.status + ' ' + row.component?.key),
      };
    });
  }, selectors);
const report = (extra = {}) => ({
  page: { id: 'invented-page', name: 'Invented page' },
  forms: [form],
  columns,
  lists: [],
  views: [],
  codeComponents: [],
  ...extra,
});

test('the one page-referenced list showing a view is only Likely while another exported list shows that view too', async (t) => {
  const grid = `<div class="entitylist"><div class="entity-grid entitylist" id="grid" data-view-layouts="${viewLayouts([['sample_a', 'A']])}" data-selected-view="${VIEW_ID}"><div class="view-grid"><table><tbody><tr data-entity="sample_entry"><td data-attribute="sample_a" data-th="A" id="value"></td></tr></tbody></table></div></div></div>`;
  const observe = await observer(t, grid);
  const listKey = 'list:' + LIST_ID;
  const alone = bindingsOf({ lists: [list(LIST_ID, true)] });
  assert.ok(summary(await observe('#grid', alone)).enclosing.includes('exact ' + listKey));
  assert.deepEqual(summary(await observe('.entitylist:not(.entity-grid)', alone)).owner, ['exact', listKey]);
  // A list the page does not reference shows the same view: it may be the one rendering this grid.
  const shared = bindingsOf({ lists: [list(LIST_ID, true), list(OTHER_LIST_ID, false)] });
  for (const selector of ['#grid', '#value']) {
    const { enclosing } = summary(await observe(selector, shared));
    assert.ok(!enclosing.includes('exact ' + listKey), selector);
    assert.ok(enclosing.includes('candidate ' + listKey), selector);
    assert.ok(!enclosing.some((row) => row.endsWith(OTHER_LIST_ID)), selector);
  }
  const wrapper = await observe('.entitylist:not(.entity-grid)', shared);
  assert.deepEqual(summary(wrapper).owner, ['candidate', null]);
  assert.equal(wrapper.candidates[0].component.key, listKey);
  assert.equal(wrapper.candidates[0].reason, 'view-shown-by-several-lists');
  // The view and the column stay exact: the grid renders the view's ID.
  assert.deepEqual(summary(await observe('#value', shared)).owner, ['exact', 'column:sample_entry:sample_a']);
});

test("a list's edit dialog names its form only when the list itself is exact", async (t) => {
  const EDIT_FORM = 'a1b2c3d4-0000-4000-8000-00000000f002';
  const framePath = '/_portal/modal-form-template-path/invented';
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  const top =
    `<div class="entitylist"><div class="entity-grid entitylist" data-view-layouts="${viewLayouts([['sample_a', 'A']])}" data-selected-view="${VIEW_ID}">` +
    `<div class="modal fade modal-form modal-form-edit"><div class="modal-body"><iframe data-page="${framePath}" src="${framePath}"></iframe></div></div></div></div>`;
  const dialog = `<div id="EntityFormControl"><div id="EntityFormPanel" class="crmEntityFormView"><div id="EntityFormControl_EntityFormView">${layout}<input type="text" id="in-dialog"></div></div></div>`;
  await page.route(origin + '/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><body>' + (new URL(route.request().url()).pathname === framePath ? dialog : top) + '</body>',
    }),
  );
  await page.goto(origin + '/');
  const frame = page.frames().find((item) => item.url().endsWith(framePath));
  await frame.locator('#in-dialog').waitFor();
  const read = new Function(
    'data',
    `const node=document.querySelector(data.selector);return (${observePortalNode.toString()})(node,{...data.options,bindings:{...data.options.bindings,pageDocument:window.parent.document}});`,
  );
  const withActions = (item) => ({ ...item, actions: [{ name: 'EditAction', formId: EDIT_FORM }] });
  const editForm = { id: EDIT_FORM, kind: 'basic-form', entity: 'sample_entry', name: 'Invented edit form' };
  const dialogForm = async (lists) => {
    const packet = await frame.evaluate(read, {
      selector: '#in-dialog',
      options: { scope, bindings: bindingsOf({ forms: [form, editForm], lists }) },
    });
    return resolveInspectionEvidence({ ...packet, mode: 'live', node: { connected: true } }).enclosing.find(
      (row) => row.component?.key === 'basic-form:' + EDIT_FORM,
    )?.status;
  };
  assert.equal(await dialogForm([withActions(list(LIST_ID, true))]), 'exact');
  // Another exported list shows the same view: its edit form could be the one, so the dialog's form is only Likely.
  assert.equal(
    await dialogForm([withActions(list(LIST_ID, true)), withActions(list(OTHER_LIST_ID, false))]),
    'candidate',
  );
});

test("a list cell is named by its column's position among the row's layout cells, never when two layout columns share its name", async (t) => {
  const layouts = viewLayouts([
    ['sample_a', 'Name'],
    ['sample_c', 'Name'],
    ['sample_d', 'Date'],
  ]);
  // The portal's Select header: sort-disabled, aria-label "Select", its markup repeated in data-th.
  const select = `<th scope="col" class="sort-disabled" aria-label="Select" data-th="<span class='fa fa-check' aria-hidden='true'></span> <span class='visually-hidden'>Select</span>"><span class="fa fa-check" aria-hidden="true"></span></th>`;
  const head = (name, id) =>
    `<th scope="col" class="sort-enabled" id="${id}"><a href="#" role="button" aria-label="${name}">${name}</a></th>`;
  const html =
    `<div class="entitylist"><div class="entity-grid entitylist" data-view-layouts="${layouts}" data-selected-view="${VIEW_ID}"><div class="view-grid"><table><thead><tr>` +
    select +
    head('Name', 'h0') +
    head('Name', 'h1') +
    head('Date', 'h2') +
    '</tr></thead><tbody><tr data-entity="sample_entry"><td class="multi-select" id="check"></td><td data-th="Name" id="v0"></td><td data-th="Name" id="v1"></td><td data-th="Date" id="v2"></td></tr></tbody></table></div></div></div>';
  const observe = await observer(t, html);
  const bindings = bindingsOf({ lists: [list(LIST_ID, true)] });
  const column = (name) => ['exact', 'column:sample_entry:' + name];
  // The Date column is the third layout column; the selection cell before it does not shift it.
  assert.deepEqual(summary(await observe('#v2', bindings)).owner, column('sample_d'));
  assert.deepEqual(summary(await observe('#h2', bindings)).owner, column('sample_d'));
  // Two layout columns called "Name": neither cell nor header is named as a column.
  for (const selector of ['#v0', '#v1', '#h0', '#h1', '#check']) {
    const { owner } = summary(await observe(selector, bindings));
    assert.ok(!String(owner[1]).startsWith('column:'), selector + ' ' + owner);
  }
});

test("author markup in a form is not a column, tab or section; what loads a file stays the file's", async (t) => {
  const html = basicForm(
    cell('sample_title', '<input type="text" id="sample_title"><span class="hint" id="hint">Help</span>') +
      cell(
        'sample_note',
        '<input type="text" id="sample_note"><input type="search" id="search-in-control"><input type="button" id="button-in-control" value="Go">' +
          '<script id="loaded-script" src="/invented.js"></script><link id="loaded-style" rel="stylesheet" href="/invented.css">' +
          '<svg id="icon"><use id="icon-use" href="/icons.svg#a"></use><image id="icon-image" href="/icon.png"></image></svg>',
      ),
    // Author markup directly in the form view: a bare input, a search box and button named like columns, and an author
    // "tab" and "section" with names of the form's layout.
    '<div><input id="sample_other" type="text"><input id="sample_a" type="search"><input id="sample_c" type="button" value="Go"></div>' +
      '<div class="tab" data-name="general_tab"><p id="author-tab-text">Text</p></div>' +
      '<table class="section" data-name="main_section"><tbody><tr><td id="author-section-cell">Text</td></tr></tbody></table>',
  );
  const observe = await observer(t, html);
  const column = (name) => 'column:sample_entry:' + name;
  // The platform's own parts stay the column's.
  assert.deepEqual(summary(await observe('#sample_title')).owner, ['exact', column('sample_title')]);
  assert.deepEqual(summary(await observe('#sample_title_label')).owner, ['exact', column('sample_title')]);
  // The real tab and section are still named.
  assert.deepEqual(summary(await observe('.tab-column')).owner, ['exact', 'form:' + FORMXML_ID + ':tab:general_tab']);
  assert.deepEqual(summary(await observe('fieldset')).owner, ['exact', 'form:' + FORMXML_ID + ':section:main_section']);
  // Inputs outside any cell are not columns because their ID matches one.
  for (const selector of ['#sample_other', '#sample_a', '#sample_c'])
    assert.equal(summary(await observe(selector)).owner[0], 'unavailable', selector);
  // An author's element in a column's cell: the column is only the cell it stands in.
  for (const selector of ['#hint', '#search-in-control', '#button-in-control']) {
    const result = summary(await observe(selector));
    const name = selector === '#hint' ? 'sample_title' : 'sample_note';
    assert.equal(result.owner[0], 'unavailable', selector);
    assert.ok(result.enclosing.includes('exact ' + column(name)), selector);
  }
  // An element that loads a file is that file; its column encloses it, without a conflict.
  for (const selector of ['#loaded-script', '#loaded-style', '#icon-use', '#icon-image']) {
    const evidence = await observe(selector);
    assert.notEqual(evidence.owner.status, 'conflicting', selector);
    assert.notEqual(evidence.owner.component?.key, column('sample_note'), selector);
    assert.ok(summary(evidence).enclosing.includes('exact ' + column('sample_note')), selector);
  }
  // A "tab" or "section" outside the platform's own structure is neither.
  for (const selector of ['#author-tab-text', '#author-section-cell']) {
    const { owner } = summary(await observe(selector));
    assert.ok(!/:(?:tab|section):/.test(String(owner[1])), selector + ' ' + owner);
  }
});

// @test-kind contract: X-ray and the portal observation read a page node's members through the platform's own prototype, so a form's named controls (Power Pages wraps the page in form#content_form) neither crash nor redirect identification
test("named controls of the page's outer form change no answer and crash nothing", async (t) => {
  const inner = basicForm(cell('sample_title')) + '<p id="plain">Text</p>';
  const names = [
    'matches',
    'getAttribute',
    'hasAttribute',
    'parentElement',
    'parentNode',
    'assignedSlot',
    'closest',
    'querySelector',
    'querySelectorAll',
    'attributes',
    'id',
    'children',
    'localName',
    'ownerDocument',
    'getRootNode',
    'classList',
    'contains',
    'isConnected',
    'nodeType',
    'shadowRoot',
    'firstElementChild',
    'nextElementSibling',
    'getBoundingClientRect',
    'getElementById',
    'documentElement',
    'body',
    'defaultView',
    'baseURI',
  ];
  // The name on a control of the outer form shadows the form's member; on an image it shadows the document's.
  const wrapped = (name) =>
    `<img name="${name}" src="data:," alt=""><form id="content_form" method="post"><input type="hidden" name="${name}" value="invented">${inner}</form>`;
  const baselinePage = await xrayPage(t, wrapped('invented_harmless'), report());
  const read = (page) =>
    page.evaluate(() => {
      // The page's own members may be shadowed: the test reads the document through its prototype too.
      const find = (selector) => Document.prototype.querySelector.call(document, selector);
      const api = find('#paqvilo-xray').__px;
      const answers = ['#sample_title', '#sample_title_label', '.tab-column', '#plain', '#content_form'].map(
        (selector) => {
          const found = api.identify(find(selector));
          return [selector, found.title, found.evidence.owner.status, found.evidence.owner.component?.key ?? null];
        },
      );
      api.select(find('#content_form'));
      const outer = api.selection()?.title;
      api.select(find('#sample_title'));
      return { answers, outer, selection: api.selection()?.title, counts: api.coverage().counts };
    });
  const baseline = await read(baselinePage);
  assert.deepEqual(baseline.answers[0].slice(2), ['exact', 'column:sample_entry:sample_title']);
  assert.equal(baseline.counts.failed ?? 0, 0);
  const observe = new Function(
    'data',
    `const node=Document.prototype.querySelector.call(document,data.selector);return (${observePortalNode.toString()})(node,{...data.options,bindings:{...data.options.bindings,pageDocument:document}});`,
  );
  const observed = async (page) =>
    resolveInspectionEvidence({
      ...(await page.evaluate(observe, { selector: '#sample_title', options: { scope, bindings: bindingsOf() } })),
      mode: 'live',
      node: { connected: true },
    }).owner.component?.key;
  assert.equal(await observed(baselinePage), 'column:sample_entry:sample_title');
  for (const name of names) {
    const page = await xrayPage(t, wrapped(name), report());
    assert.deepEqual(await read(page), baseline, name);
    assert.equal(await observed(page), 'column:sample_entry:sample_title', name);
    await page.context().close();
  }
});

// @test-kind contract: coverage reports an element whose identification threw as its own count instead of an unidentified one
test('coverage counts an element whose identification threw as failed', async (t) => {
  const page = await xrayPage(t, '<p id="plain">Text</p><span id="breaks">Text</span>', report(), {}, () => {
    // Stands in for any failure inside identification: reading this one element throws.
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (selector) {
      if (this.id === 'breaks') throw new Error('invented failure');
      return matches.call(this, selector);
    };
  });
  const coverage = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.coverage());
  assert.equal(coverage.counts.failed, 1);
  assert.deepEqual(
    coverage.unidentified.filter((sample) => sample.state === 'failed').map((sample) => sample.tag),
    ['span'],
  );
});

// @test-kind contract: an owner that conflicts, is only likely or is outdated is shown as itself, never as the answer of the element around it
test('an element whose owner conflicts or is only likely is not shown as inside its container', async (t) => {
  const html =
    '<div id="wrap">' +
    basicForm(
      cell(
        'sample_title',
        '<input type="text" id="sample_title"><span data-entity="sample_other" id="other-table">x</span>',
      ) + cell('sample_missing'),
    ) +
    '</div>';
  // The container's own proof: the template that served #wrap.
  const page = await xrayPage(t, html, report(), { provenanceSlot: '__inventedProvenance' }, () => {
    window.__inventedProvenance = {
      query(node, { scope, anchorGeneration }) {
        const base = { version: 1, scope, anchorGeneration, mode: 'live', sourceRefs: [], facts: [] };
        if (node.id !== 'wrap') return base;
        return {
          ...base,
          sourceRefs: [
            {
              id: 'main',
              ref: 'web-templates/Main.html',
              key: 'main',
              sourceKey: 'main',
              sourceRevision: scope.sourceRevision,
              contentRevision: 'c',
              name: 'Main template',
            },
          ],
          facts: [
            {
              id: 'served',
              scope,
              dimension: 'source',
              proof: 'served-literal',
              kind: 'served-literal',
              subject: 'selection',
              predicate: 'definition',
              sourceRefIds: ['main'],
            },
          ],
        };
      },
    };
  });
  const [conflicting, likely] = await identified(page, ['#other-table', '#sample_missing']);
  // A row of another table inside the form: the owner conflicts.
  assert.equal(conflicting.owner[0], 'conflicting');
  assert.equal(conflicting.kind, 'Several matches');
  assert.doesNotMatch(conflicting.title, /^Inside /);
  // A column the sources do not define: only named by the page, Likely.
  assert.equal(likely.owner[0], 'candidate');
  assert.equal(likely.kind, 'Likely match');
  assert.doesNotMatch(likely.title, /^Inside /);
  // Coverage counts them by their own status, not as inside an identified element.
  const counts = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.coverage().counts);
  assert.ok(counts.conflict >= 1, JSON.stringify(counts));
  assert.ok(counts.likely >= 1, JSON.stringify(counts));
});

// @test-kind contract: on Mirage pages the render registry's owner demotes only a container the structure names; a different column it contradicts is a conflict
test('a render-registry owner does not turn a contradicting column into one that encloses it', async (t) => {
  const html = basicForm(cell('sample_title'));
  const page = await xrayPage(t, html, report(), { provenanceSlot: '__inventedProvenance', mirageMode: true }, () => {
    window.__inventedProvenance = {
      query(node, { scope, anchorGeneration }) {
        const base = { version: 1, scope, anchorGeneration, mode: 'local', sourceRefs: [], facts: [] };
        if (node.id !== 'sample_title') return base;
        return {
          ...base,
          facts: [
            {
              id: 'rendered',
              scope,
              dimension: 'owner',
              proof: 'render-platform',
              kind: 'render-platform',
              subject: 'selection',
              predicate: 'identity',
              binding: {
                kind: 'field',
                key: 'column:sample_entry:sample_note',
                entity: 'sample_entry',
                name: 'sample_note',
                field: 'sample_note',
              },
            },
          ],
        };
      },
    };
  });
  const [found] = await identified(page, ['#sample_title']);
  assert.equal(found.owner[0], 'conflicting');
  assert.ok(!found.enclosing.some((row) => row.endsWith('column:sample_entry:sample_title')));
  assert.ok(!found.enclosing.some((row) => row.endsWith('column:sample_entry:sample_note')));
  // The form and table the structure names around it are still where it stands.
  assert.ok(found.enclosing.includes('exact basic-form:' + FORM_ID));
});

// @test-kind contract: markers only Mirage's renderers write (data-field, data-fieldname, data-pcf-native-field, data-entityname, data-pcf-schema) are read on Mirage pages only; on a live page they are an author's attributes
test('markers no live portal writes name no candidate and break no table context on a live page', async (t) => {
  const html = basicForm(
    cell('sample_title'),
    '<div data-field="sample_note"><span id="field">a</span></div>' +
      '<div data-fieldname="sample_note"><span id="fieldname">b</span></div>' +
      '<div data-pcf-native-field="sample_note"><span id="native-field">c</span></div>' +
      '<div data-entityname="sample_other"><span id="entityname">d</span></div>',
  );
  const selectors = ['#field', '#fieldname', '#native-field', '#entityname'];
  const live = await identified(await xrayPage(t, html, report()), selectors);
  for (const [index, found] of live.entries()) {
    assert.equal(found.owner[0], 'unavailable', selectors[index]);
    assert.deepEqual(found.candidates, [], selectors[index]);
    assert.ok(found.enclosing.includes('exact basic-form:' + FORM_ID), selectors[index]);
  }
  // On a Mirage page the same markers are Mirage's own and still read.
  const mirage = await identified(await xrayPage(t, html, report(), { mirageMode: true }), selectors);
  assert.ok(mirage[0].candidates.includes('candidate column:sample_entry:sample_note'));
  assert.equal(mirage[3].owner[0], 'conflicting');
});
