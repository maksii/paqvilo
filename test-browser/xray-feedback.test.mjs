import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { inspectRenderedPage } from '../lense/source-inspection.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const forms = [
  { id: 'basic-a', name: 'First basic form', entity: 'x_first', formXml: { id: 'layout-a', name: 'First layout' } },
  { id: 'basic-b', name: 'Second basic form', entity: 'x_second', formXml: { id: 'layout-b', name: 'Second layout' } },
];
const columns = ['x_first', 'x_second'].flatMap((entity) =>
  ['x_title', 'x_notes', 'x_summary', 'editor'].map((name) => ({ entity, name })),
);
const sourceRefs = columns.map(({ entity, name }) => ({
  id: entity + ':' + name,
  key: entity + ':' + name,
  componentKey: 'column:' + entity + ':' + name,
  kind: 'column',
  ref: 'invented/' + entity + '.xml',
  sourceRevision: 'feedback-1',
  contentRevision: 'invented-current-bytes',
  relationship: 'definition',
}));
async function fixture(t, html) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('http://127.0.0.1:11942/**', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: 'text/html',
      body: url.pathname === '/' ? html : '<!doctype html><body></body>',
    });
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:11942/');
  const data = { origin: 'http://127.0.0.1:11942', token: 'invented-feedback', sourceRevision: 'feedback-1' };
  const report = { componentIndex: { forms }, columns, sourceRefs };
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, report }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, report);
      api.toggle(true);
    },
    { data, report },
  );
  const inspect = (locator) =>
    locator.evaluate(
      (node) => node.ownerDocument.defaultView.top.document.getElementById('paqvilo-xray').__px.identify(node).evidence,
    );
  return { page, inspect, data, report };
}
const exactColumn = (evidence, entity, name) => {
  assert.equal(evidence.owner.status, 'exact');
  assert.equal(evidence.owner.component.key, `column:${entity}:${name}`);
  assert.equal(evidence.source.status, 'exact');
  assert.equal(evidence.source.refs[0].ref, `invented/${entity}.xml`);
};

test('advanced-form editor hosts follow the rendered step table and layout across step replacement', async (t) => {
  const { page, inspect, data, report } = await fixture(
    t,
    '<div id="WebFormControl_wizard"><span data-form-layout></span><div id="x_notes_ControlView"><iframe id="advanced-editor" src="/advanced-editor"></iframe></div></div>',
  );
  const wizard = {
    id: 'wizard',
    kind: 'advanced-form',
    configuredEntities: ['x_first', 'x_second'],
    formLayouts: [
      { id: 'layout-a', entity: 'x_first', name: 'First layout' },
      { id: 'layout-b', entity: 'x_second', name: 'Second layout' },
    ],
  };
  await page.evaluate(
    ({ data, report, wizard }) =>
      document.getElementById('paqvilo-xray').__px.update(data, { ...report, componentIndex: { forms: [wizard] } }),
    { data, report, wizard },
  );
  const editor = page.frameLocator('#advanced-editor').locator('body');
  await editor.evaluate((node) => {
    node.contentEditable = 'true';
    Object.defineProperty(node, 'innerHTML', {
      get() {
        throw Error('No editor values');
      },
    });
  });
  for (const [id, entity] of [
    ['layout-a', 'x_first'],
    ['layout-b', 'x_second'],
    ['00000000-0000-0000-0000-000000000000', 'x_second'],
  ]) {
    await page
      .locator('[data-form-layout]')
      .evaluate((node, layout) => node.setAttribute('data-form-layout', JSON.stringify(layout)), {
        Id: id,
        EntityName: entity,
      });
    const evidence = await inspect(editor);
    exactColumn(evidence, entity, 'x_notes');
    assert.ok(
      evidence.enclosing.some((row) => row.component?.key === 'advanced-form:wizard' && row.status === 'exact'),
    );
    if (id === 'layout-b') assert.ok(evidence.enclosing.some((row) => row.component?.key === 'form:layout-b'));
    if (id.startsWith('0000'))
      assert.ok(
        !evidence.enclosing.some((row) => row.component?.kind === 'form'),
        'An empty ID cannot choose between configured step layouts',
      );
  }
  await page
    .locator('[data-form-layout]')
    .evaluate((node) =>
      node.setAttribute('data-form-layout', JSON.stringify({ Id: 'layout-a', EntityName: 'x_second' })),
    );
  assert.equal((await inspect(editor)).owner.status, 'conflicting');
});

test('native generic modal layouts join only their rendered list or subgrid action and reject stale hints', async (t) => {
  const modalPath = '/_portal/modal-form-template-path/invented';
  const modal = (kind, id) =>
    `<section class="modal-form modal-form-${kind}"><iframe id="${id}" data-page="${modalPath}" src="${modalPath}"></iframe></section>`;
  const { page, inspect, data, report } = await fixture(
    t,
    `<div data-listid="first"><div class="entity-grid" data-selected-view="view-one">${modal('insert', 'create')}${modal('edit', 'edit')}${modal('details', 'details')}</div></div>` +
      `<div data-listid="second"><div class="entity-grid" data-selected-view="view-two">${modal('edit', 'second')}</div></div>` +
      `<div data-formid="basic-a"><div id="ChildRows" class="subgrid"><div class="entity-grid">${modal('edit', 'subgrid')}</div></div></div>`,
  );
  const targets = ['create', 'edit', 'details', 'other'].map((id) => ({
    id,
    name: id,
    kind: 'basic-form',
    entity: 'x_first',
    formXml: { id: 'xml-' + id, name: id + ' layout' },
  }));
  const actions = ['Create', 'Edit', 'Details'].map((name) => ({
    name: name + 'Action',
    formId: name.toLowerCase(),
    targetType: 0,
  }));
  const updated = {
    ...report,
    componentIndex: {
      forms: [...forms, ...targets],
      lists: [
        { id: 'first', entity: 'x_first', viewIds: ['view-one'], actions },
        { id: 'second', entity: 'x_first', viewIds: ['view-two'], actions: [{ name: 'EditAction', formId: 'other' }] },
      ],
    },
    nativeComponents: [
      {
        kind: 'subgrid',
        id: 'ChildRows',
        formId: 'basic-a',
        entity: 'x_first',
        actions: [{ name: 'EditAction', formId: 'other' }],
      },
    ],
  };
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report: updated,
  });
  const populate = async (id, entity = 'x_first') =>
    page.locator('#' + id).evaluate((frame, entity) => {
      const doc = frame.contentDocument;
      doc.body.innerHTML =
        '<div id="EntityFormControl"><div id="EntityFormPanel"><div id="EntityFormControl_EntityFormView"><span data-form-layout></span><input id="x_title"></div></div></div>';
      doc
        .querySelector('[data-form-layout]')
        .setAttribute(
          'data-form-layout',
          JSON.stringify({ Id: '00000000-0000-0000-0000-000000000000', EntityName: entity }),
        );
      Object.defineProperty(doc.querySelector('input'), 'value', {
        get() {
          throw Error('Field values must not be read');
        },
      });
    }, entity);
  const field = (id) => page.frameLocator('#' + id).locator('#x_title');
  for (const [id, target] of [
    ['create', 'create'],
    ['edit', 'edit'],
    ['details', 'details'],
    ['second', 'other'],
    ['subgrid', 'other'],
  ]) {
    await populate(id);
    const evidence = await inspect(field(id));
    exactColumn(evidence, 'x_first', 'x_title');
    assert.ok(evidence.enclosing.some((row) => row.component?.id === target && row.status === 'exact'));
    assert.ok(evidence.enclosing.some((row) => row.component?.id === 'xml-' + target));
  }
  // Definition hints can only veto this structural join, including the basic/system-form alias.
  for (const query of ['?entityformid=edit&formid=xml-edit', '?entityformid=other', '?entityname=x_second']) {
    await page
      .locator('#edit')
      .evaluate((frame, url) => frame.contentWindow.history.replaceState(null, '', url), modalPath + query);
    const evidence = await inspect(field('edit'));
    assert.equal(evidence.owner.status, query.includes('xml-edit') ? 'exact' : 'conflicting');
  }
  const navigated = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame.url() === data.origin + modalPath,
  });
  await page.locator('#edit').evaluate((frame, path) => (frame.src = path), modalPath);
  await (await navigated).waitForLoadState('domcontentloaded');
  await populate('edit');
  exactColumn(await inspect(field('edit')), 'x_first', 'x_title');
  await page
    .locator('[data-listid=first] > .entity-grid')
    .evaluate((node) => node.setAttribute('data-selected-view', 'view-two'));
  assert.notEqual(
    (await inspect(field('edit'))).owner.status,
    'exact',
    'A rendered view contradicting its list cannot prove modal ownership',
  );
  await page
    .locator('[data-listid=first] > .entity-grid')
    .evaluate((node) => node.setAttribute('data-selected-view', 'view-one'));
  await page.locator('#ChildRows').evaluate((node) => {
    const grid = node.querySelector('.entity-grid');
    node.classList.add('entity-grid');
    node.replaceChildren(...grid.childNodes);
  });
  await page.locator('#subgrid').evaluate(
    (frame) =>
      new Promise((resolve) => {
        if (frame.contentDocument?.readyState === 'complete') resolve();
        else frame.addEventListener('load', resolve, { once: true });
      }),
  );
  await populate('subgrid');
  exactColumn(await inspect(field('subgrid')), 'x_first', 'x_title');
  await populate('edit', 'x_second');
  assert.equal((await inspect(field('edit'))).owner.status, 'conflicting');
  await populate('edit');
  for (const mode of ['missing', 'duplicate', 'ambiguous-list']) {
    const changed = structuredClone(updated);
    if (mode === 'missing')
      changed.componentIndex.forms = changed.componentIndex.forms.filter((form) => form.id !== 'edit');
    if (mode === 'duplicate') changed.componentIndex.lists[0].actions.push({ name: 'EditAction', formId: 'other' });
    if (mode === 'ambiguous-list') {
      await page.locator('[data-listid=first]').evaluate((node) => node.removeAttribute('data-listid'));
      changed.componentIndex.lists[1].viewIds = ['view-one'];
    }
    await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
      data,
      report: changed,
    });
    const evidence = await inspect(field('edit'));
    assert.notEqual(evidence.owner.status, 'exact', mode);
    assert.ok(
      evidence.enclosing.some((row) => row.component?.entity === 'x_first' && row.component.kind === 'table'),
      mode,
    );
    if (mode !== 'missing')
      assert.ok(
        evidence.enclosing.some((row) => row.component?.id === 'edit' && row.status === 'candidate'),
        mode,
      );
  }
  assert.doesNotMatch(JSON.stringify(await inspect(field('edit'))), /recordid|Field values must not/);
});

test('two declared grids retain exact declared columns across clones, reordering and redraw without data access', async (t) => {
  const { page, inspect } = await fixture(
    t,
    '<table id="first" data-paqvilo-table="x_first"><thead><tr><th id="head">Title</th></tr></thead><tbody><tr><td id="cell"><b>Custom renderer</b></td></tr></tbody></table>' +
      '<table id="second" data-paqvilo-table="x_second"><tr><td id="other" data-paqvilo-column="x_title">Other</td></tr></table>' +
      '<table data-paqvilo-grid="first"><tr><th id="clone" data-dt-column="1">Clone</th></tr></table>' +
      '<form data-formid="basic-a"><table><tr><td id="unbound" data-paqvilo-column="x_title">Unbound</td></tr></table></form>',
  );
  await page.evaluate(() => {
    window.businessCalls = 0;
    const forbidden = () => {
      window.businessCalls++;
      throw Error('No business access');
    };
    const config = {
      nTable: document.getElementById('first'),
      aoColumns: [
        { sName: 'hidden', bVisible: false },
        { sName: 'x_title', nTh: document.getElementById('head') },
      ],
    };
    document.getElementById('cell')._DT_CellIndex = { column: 1 };
    for (const item of [config, ...config.aoColumns]) {
      Object.defineProperty(item, 'aoData', { get: forbidden });
      Object.defineProperty(item, 'mData', { get: forbidden });
      item.mRender = forbidden;
    }
    window.DataTable = { settings: [config] };
  });
  for (const selector of ['#head', '#cell b', '#clone'])
    exactColumn(await inspect(page.locator(selector)), 'x_first', 'x_title');
  exactColumn(await inspect(page.locator('#other')), 'x_second', 'x_title');
  assert.notEqual((await inspect(page.locator('#unbound'))).owner.status, 'exact');
  await page.locator('#cell').evaluate((node) => {
    window.DataTable.settings[0].aoColumns.reverse();
    node._DT_CellIndex.column = 0;
    document.getElementById('clone').setAttribute('data-dt-column', '0');
    node.innerHTML = '<span>Redrawn</span>';
  });
  for (const selector of ['#cell span', '#clone'])
    exactColumn(await inspect(page.locator(selector)), 'x_first', 'x_title');
  await page.locator('#other').evaluate((node) => node.setAttribute('data-entityname', 'x_first'));
  assert.equal((await inspect(page.locator('#other'))).owner.status, 'conflicting');
  assert.equal(await page.evaluate(() => window.businessCalls), 0);
});

test('a linked grid clone preserves conflicting declarations on its original table', async (t) => {
  const { page, inspect } = await fixture(
    t,
    '<table id="original" data-paqvilo-table="x_first"><tr><th id="direct" data-paqvilo-column="x_title">Direct</th></tr></table>' +
      '<table data-paqvilo-grid="original"><tr><th id="clone" data-paqvilo-column="x_title">Clone</th></tr></table>',
  );
  for (const attribute of ['data-entityname', 'data-entity']) {
    await page.locator('#original').evaluate((node, attribute) => node.setAttribute(attribute, 'x_second'), attribute);
    for (const id of ['direct', 'clone'])
      assert.equal(
        (await inspect(page.locator('#' + id))).owner.status,
        'conflicting',
        `${id} must retain the original grid's ${attribute} contradiction`,
      );
    await page.locator('#original').evaluate((node, attribute) => node.removeAttribute(attribute), attribute);
    for (const id of ['direct', 'clone']) exactColumn(await inspect(page.locator('#' + id)), 'x_first', 'x_title');
  }
  await page.locator('#clone').evaluate((node) => node.closest('table').setAttribute('data-entityname', 'x_second'));
  assert.equal((await inspect(page.locator('#clone'))).owner.status, 'conflicting');
  exactColumn(await inspect(page.locator('#direct')), 'x_first', 'x_title');
});

for (const count of [4, 900]) {
  test(`verified attribute hosts carry two empty/disabled editors through nested frames (${count} candidates)`, async (t) => {
    const { page, inspect, data, report } = await fixture(
      t,
      '<input>'.repeat(count) +
        '<div id="EntityFormControl_basica"><div id="x_notes_ControlView"><iframe id="notes" src="/editor-notes"></iframe></div>' +
        '<div id="x_summary_Container"><iframe id="summary" src="/editor-summary"></iframe></div><div id="x_notes_Container"><button id="chrome">Toolbar</button></div></div>' +
        '<div id="x_notes_Container"><iframe id="unknown" src="/editor-unknown"></iframe></div>',
    );
    const editors = [];
    for (const id of ['notes', 'summary', 'unknown']) {
      const outer = await page.locator('#' + id).elementHandle();
      const frame = await outer.contentFrame();
      await frame.setContent('<iframe id="nested" src="/nested-' + id + '"></iframe>');
      const editor = frame.frameLocator('#nested').locator('body');
      await editor.evaluate((node) => {
        node.id = 'editor';
        node.contentEditable = 'true';
        Object.defineProperty(node, 'textContent', {
          get() {
            throw Error('Editor content must not be read');
          },
        });
      });
      editors.push(editor);
    }
    exactColumn(await inspect(page.locator('#x_notes_ControlView')), 'x_first', 'x_notes');
    exactColumn(await inspect(editors[0]), 'x_first', 'x_notes');
    exactColumn(await inspect(editors[1]), 'x_first', 'x_summary');
    assert.notEqual((await inspect(editors[2])).owner.status, 'exact');
    assert.notEqual((await inspect(page.locator('#chrome'))).owner.status, 'exact');
    const notes = await inspect(editors[0]);
    assert.ok(notes.enclosing.some((item) => item.component.key === 'form:layout-a'));
    assert.ok(notes.enclosing.some((item) => item.component.key === 'basic-form:basic-a'));
    await editors[0].evaluate((node) => {
      node.innerHTML = '<textarea id="editor" disabled></textarea>';
      node.removeAttribute('contenteditable');
    });
    const replacement = editors[0].locator('textarea');
    exactColumn(await inspect(replacement), 'x_first', 'x_notes');
    for (const [attribute, value] of [
      ['data-fieldname', 'x_summary'],
      ['data-entityname', 'x_second'],
    ]) {
      await page
        .frameLocator('#notes')
        .locator('#nested')
        .evaluate((node, declaration) => node.setAttribute(...declaration), [attribute, value]);
      assert.equal(
        (await inspect(replacement)).owner.status,
        'conflicting',
        'an intervening editor frame cannot discard its own ' + attribute + ' declaration',
      );
      await page
        .frameLocator('#notes')
        .locator('#nested')
        .evaluate((node, attribute) => node.removeAttribute(attribute), attribute);
      exactColumn(await inspect(replacement), 'x_first', 'x_notes');
    }
    await replacement.evaluate((node) => node.setAttribute('data-fieldname', 'editor'));
    assert.equal((await inspect(replacement)).owner.status, 'conflicting');
    await page.evaluate(
      ({ data, report }) =>
        document.getElementById('paqvilo-xray').__px.update(data, {
          ...report,
          componentIndex: { forms: [] },
          columns: [],
          sourceRefs: [],
        }),
      { data, report },
    );
    assert.notEqual((await inspect(editors[1])).owner.status, 'exact', 'source removal expires host ownership');
  });
}

test('rendered modal/quick-view identities survive replacement and source changes while URL-only fixtures remain candidates', async (t) => {
  const { page, inspect, data, report } = await fixture(
    t,
    '<div id="EntityFormControl_basica"><input id="x_title"></div><iframe id="first" src="/quick?formid=basic-a"></iframe><iframe id="second" src="/quick?formid=basic-b"></iframe>',
  );
  for (const [id, form, entity] of [
    ['first', 'basic-a', 'x_first'],
    ['second', 'basic-b', 'x_second'],
  ]) {
    const frame = page.frameLocator('#' + id);
    await frame
      .locator('body')
      .evaluate((body) => (body.innerHTML = '<div id="EntityFormControl"><input id="x_title"></div>'));
    assert.equal((await inspect(frame.locator('input'))).owner.status, 'candidate');
    await frame
      .locator('#EntityFormControl')
      .evaluate((node, form) => node.setAttribute('data-form-layout', JSON.stringify({ Id: form })), form);
    exactColumn(await inspect(frame.locator('input')), entity, 'x_title');
  }
  exactColumn(await inspect(page.locator('#x_title')), 'x_first', 'x_title');
  await page.locator('#first').evaluate((node) => (node.src = '/replacement?entityformid=basic-a'));
  const first = page.frameLocator('#first');
  await first
    .locator('body')
    .evaluate(
      (body) => (body.innerHTML = '<div id="EntityFormControl" data-formid="basic-b"><input id="x_title"></div>'),
    );
  exactColumn(await inspect(first.locator('input')), 'x_second', 'x_title');
  await first
    .locator('#EntityFormControl')
    .evaluate((node) => node.setAttribute('data-form-layout', JSON.stringify({ Id: 'layout-b' })));
  exactColumn(await inspect(first.locator('input')), 'x_second', 'x_title');
  await first
    .locator('#EntityFormControl')
    .evaluate((node) => node.setAttribute('data-form-layout', JSON.stringify({ Id: 'basic-a' })));
  assert.equal((await inspect(first.locator('input'))).owner.status, 'conflicting');
  await page.evaluate(
    ({ data, report, forms }) =>
      document.getElementById('paqvilo-xray').__px.update(data, {
        ...report,
        componentIndex: { forms: forms.filter((form) => form.id !== 'basic-b') },
      }),
    { data, report, forms },
  );
  assert.notEqual((await inspect(page.frameLocator('#second').locator('input'))).owner.status, 'exact');
});

test('native quick-view placements join their observed parent and exported target without URL or record-value proof', async (t) => {
  const { page, inspect, data, report } = await fixture(
    t,
    '<div id="EntityFormControl_basica"><input id="x_title">' +
      '<iframe class="quickform" id="one" data-path="/quick-one" data-controlid="one" data-lookup-element="first_lookup" data-formname="First layout" src="/quick-one?entityid=PRIVATE_ROW_SENTINEL&amp;access_token=PRIVATE_TOKEN_SENTINEL"></iframe>' +
      '<iframe class="quickform" id="two" data-path="/quick-two" data-controlid="two" data-lookup-element="second_lookup" data-formname="Second layout" src="/quick-two"></iframe></div>',
  );
  const targets = forms.map((form) => ({
    id: form.formXml.id,
    name: form.formXml.name,
    entity: form.entity,
    kind: 'FormXml',
  }));
  const placements = targets.map((target, index) => ({
    kind: 'quickform',
    formId: 'basic-a',
    ownerFormXmlId: 'layout-a',
    id: index ? 'two' : 'one',
    lookup: index ? 'second_lookup' : 'first_lookup',
    targetFormId: target.id,
    entity: target.entity,
    formName: target.name,
  }));
  await page.evaluate(() => {
    window.forbiddenDefinitionReads = 0;
    const allowed = ['entityformid', 'formid', 'entityname', 'tablename', 'etn', 'typename', 'formname'];
    const getAll = URLSearchParams.prototype.getAll;
    URLSearchParams.prototype.getAll = function (key) {
      if (!allowed.includes(key.toLowerCase())) {
        window.forbiddenDefinitionReads++;
        throw Error('No unrelated query values');
      }
      return getAll.call(this, key);
    };
    URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries = function () {
      window.forbiddenDefinitionReads++;
      throw Error('No enumeration of query values');
    };
  });
  const rendered = await page.evaluate(inspectRenderedPage);
  assert.doesNotMatch(JSON.stringify(rendered), /PRIVATE_(ROW|TOKEN)_SENTINEL/);
  const fresh = { ...report, componentIndex: { forms: [...forms, ...targets] }, nativeComponents: placements };
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report: fresh,
  });
  for (const [id, entity, formId] of [
    ['one', 'x_first', 'layout-a'],
    ['two', 'x_second', 'layout-b'],
  ]) {
    const frame = page.frameLocator('#' + id);
    await frame.locator('body').evaluate((body) => {
      body.innerHTML = '<div><input id="x_title"></div>';
      Object.defineProperty(HTMLInputElement.prototype, 'value', {
        get() {
          throw Error('No record values');
        },
      });
    });
    const evidence = await inspect(frame.locator('input'));
    exactColumn(evidence, entity, 'x_title');
    assert.ok(evidence.enclosing.some((row) => row.component.key === 'form:' + formId));
  }
  await page.locator('#two').evaluate((node) => node.setAttribute('data-entityname', 'x_second'));
  exactColumn(await inspect(page.frameLocator('#two').locator('input')), 'x_second', 'x_title');
  await page.locator('#two').evaluate((node) => node.setAttribute('data-entityname', 'x_first'));
  assert.equal(
    (await inspect(page.frameLocator('#two').locator('input'))).owner.status,
    'conflicting',
    'the frame target declaration must agree with its exported quick-view target, not its parent table',
  );
  await page.locator('#two').evaluate((node) => {
    node.setAttribute('data-entityname', 'x_second');
    node.setAttribute('data-formid', 'basic-b');
    node.setAttribute('data-form-layout', JSON.stringify({ Id: 'layout-b', EntityName: 'x_second' }));
  });
  exactColumn(await inspect(page.frameLocator('#two').locator('input')), 'x_second', 'x_title');
  await page.locator('#two').evaluate((node) => node.setAttribute('data-formid', 'unknown'));
  assert.notEqual((await inspect(page.frameLocator('#two').locator('input'))).owner.status, 'exact');
  await page.locator('#two').evaluate((node) => {
    node.removeAttribute('data-formid');
    node.setAttribute('data-form-layout', 'invalid');
  });
  assert.notEqual((await inspect(page.frameLocator('#two').locator('input'))).owner.status, 'exact');
  await page.locator('#two').evaluate((node) => {
    node.removeAttribute('data-form-layout');
    node.removeAttribute('data-entityname');
  });
  await page.locator('#one').evaluate((node) => (node.src = '/quick-one?navigation=next'));
  await page
    .frameLocator('#one')
    .locator('body')
    .evaluate((body) => (body.innerHTML = '<input id="x_title">'));
  exactColumn(await inspect(page.frameLocator('#one').locator('input')), 'x_first', 'x_title');
  await page.locator('#two').evaluate((node) => (node.src = '/quick-two?entityname=x_first'));
  await page
    .frameLocator('#two')
    .locator('body')
    .evaluate((body) => (body.innerHTML = '<input id="x_title">'));
  assert.equal(
    (await inspect(page.frameLocator('#two').locator('input'))).owner.status,
    'conflicting',
    'a navigated document can contradict the rendered placement',
  );
  await page.locator('#two').evaluate((node) => (node.src = '/quick-two'));
  await page
    .frameLocator('#two')
    .locator('body')
    .evaluate((body) => (body.innerHTML = '<input id="x_title">'));
  await page.locator('#two').evaluate((node) => node.setAttribute('sandbox', 'allow-scripts allow-same-origin'));
  assert.notEqual(
    (await inspect(page.frameLocator('#two').locator('input'))).owner.status,
    'exact',
    'sandboxed quick views remain boundaries',
  );
  await page.locator('#two').evaluate((node) => node.removeAttribute('sandbox'));
  await page
    .frameLocator('#one')
    .locator('input')
    .evaluate((node) => node.setAttribute('data-entityname', 'x_second'));
  assert.equal((await inspect(page.frameLocator('#one').locator('input'))).owner.status, 'conflicting');
  await page
    .frameLocator('#one')
    .locator('input')
    .evaluate((node) => {
      node.removeAttribute('data-entityname');
      node.parentElement.setAttribute('data-formid', 'unknown');
    });
  assert.notEqual((await inspect(page.frameLocator('#one').locator('input'))).owner.status, 'exact');
  await page.locator('#two').evaluate((node) => node.setAttribute('data-lookup-element', 'wrong_lookup'));
  assert.notEqual((await inspect(page.frameLocator('#two').locator('input'))).owner.status, 'exact');
  await page.locator('#two').evaluate((node) => node.setAttribute('data-lookup-element', 'second_lookup'));
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report: { ...fresh, nativeComponents: [...placements, { ...placements[1], targetFormId: 'layout-a' }] },
  });
  assert.notEqual(
    (await inspect(page.frameLocator('#two').locator('input'))).owner.status,
    'exact',
    'conflicting exported placements cannot resolve first-match',
  );
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report: { ...fresh, componentIndex: { forms } },
  });
  assert.notEqual(
    (await inspect(page.frameLocator('#two').locator('input'))).owner.status,
    'exact',
    'missing target FormXml is a boundary',
  );
  await page.evaluate(({ data, report }) => document.getElementById('paqvilo-xray').__px.update(data, report), {
    data,
    report: fresh,
  });
  await page.locator('#EntityFormControl_basica').evaluate((node) => (node.id = 'unknown-parent'));
  assert.notEqual(
    (await inspect(page.frameLocator('#two').locator('input'))).owner.status,
    'exact',
    'matching iframe declarations cannot replace parent proof',
  );
  assert.equal(await page.evaluate(() => window.forbiddenDefinitionReads), 0);
});
