import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { observePortalNode } from '../lense/portal-node-observation.mjs';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';

test('actual portal node joins use rendered component scope and never navigation defaults, page forms or values', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html =
    '<form id="form" data-formid="form-a" data-entityname="sample_entry"><label id="caption" for="title">Title</label><input id="title" name="title" value="PRIVATE_VALUE"><button id="submit">Save</button><div id="child" data-formid="form-b" data-entityname="sample_child"><input id="other" name="title"></div></form><input id="outside" name="title"><iframe id="frame"></iframe>';
  await page.route('http://127.0.0.1:11888/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1:11888/');
  await page.evaluate(() =>
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      get() {
        throw Error('Business value access is forbidden');
      },
    }),
  );
  const scope = { documentId: 'document-a', frameId: 'top', uiEpoch: 1, sourceRevision: 'source-a' };
  const sourceRef = {
    id: 'column-source',
    key: 'column-source',
    componentKey: 'column:sample_entry:title',
    kind: 'column',
    sourceRevision: 'source-a',
    contentRevision: 'content-a',
    ref: 'solutions/Entry/Entity.xml',
    relationship: 'definition',
  };
  const bindings = {
    fields: [{ name: 'title', entity: 'sample_entry', label: 'Title' }],
    forms: [
      { id: 'form-a', entity: 'sample_entry', name: 'Entry form', formXml: { id: 'form-a-xml' } },
      { id: 'form-b', entity: 'sample_child', name: 'Child form' },
    ],
    views: [],
    lists: [],
  };
  const read = new Function(
    'data',
    `return (${observePortalNode.toString()})(document.querySelector(data.selector),data.options);`,
  );
  const inspect = async (selector, change = {}) => {
    const packet = await page.evaluate(read, {
      selector,
      options: { scope, bindings: { ...bindings, ...change }, sourceRefs: [sourceRef] },
    });
    assert.equal(JSON.stringify(packet).includes('PRIVATE_VALUE'), false);
    return resolveInspectionEvidence({ ...packet, mode: 'live', node: { connected: true } });
  };
  for (const selector of ['#title', '#caption']) {
    const result = await inspect(selector);
    assert.equal(result.owner.status, 'exact', selector);
    assert.equal(result.owner.component.key, sourceRef.componentKey);
    assert.equal(result.source.status, 'exact');
    assert.ok(result.enclosing.some((item) => item.component.id === 'form-a'));
  }
  const outside = await inspect('#outside');
  assert.equal(
    (await inspect('#title', { conflict: true })).owner.status,
    'exact',
    'a conflicting navigation hint cannot invalidate an independently observed current form',
  );
  assert.equal(outside.owner.status, 'unavailable', "a page-wide exported form is not this input's owner");
  const submit = await inspect('#submit');
  assert.equal(
    submit.owner.status,
    'unavailable',
    'the form encloses generated chrome without becoming its selected owner',
  );
  assert.ok(submit.enclosing.some((item) => item.component.id === 'form-a'));
  const child = await inspect('#other', { fields: [{ name: 'title', entity: 'sample_child' }] });
  assert.equal(child.owner.component.entity, 'sample_child');
  assert.ok(child.enclosing.some((item) => item.component.id === 'form-b'));
  await page.evaluate(() => {
    const native = document.createElement('div');
    native.id = 'EntityFormControl_forma_EntityFormView';
    native.innerHTML =
      '<span data-form-layout=\'{"Id":"form-a","EntityName":"sample_entry"}\'></span><input id="native-title" name="title">';
    document.body.append(native);
  });
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'exact',
    'native wrapper IDs and direct child layout resolve nonhex export IDs',
  );
  await page
    .locator('#EntityFormControl_forma_EntityFormView > [data-form-layout]')
    .evaluate((node) =>
      node.setAttribute(
        'data-form-layout',
        JSON.stringify({ Id: '00000000-0000-0000-0000-000000000000', EntityName: 'sample_entry' }),
      ),
    );
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'exact',
    'a native empty layout ID cannot erase the independently observed basic-form wrapper',
  );
  await page
    .locator('#EntityFormControl_forma_EntityFormView')
    .evaluate((node) => node.setAttribute('data-formid', '00000000-0000-0000-0000-000000000000'));
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'unavailable',
    'an explicit unknown component ID remains a boundary',
  );
  await page.locator('#EntityFormControl_forma_EntityFormView').evaluate((node) => {
    node.removeAttribute('data-formid');
    node.id = 'EntityFormControl_EntityFormView';
  });
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'unavailable',
    'a generic wrapper and empty layout ID cannot invent a basic-form identity',
  );
  await page.locator('#EntityFormControl_EntityFormView').evaluate((node) => {
    node.id = 'EntityFormControl_forma_EntityFormView';
  });
  await page
    .locator('#EntityFormControl_forma_EntityFormView > [data-form-layout]')
    .evaluate((node) => node.setAttribute('data-form-layout', JSON.stringify({ Id: 'form-b' })));
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'conflicting',
    'a known native wrapper and different known layout cannot silently choose one',
  );
  await page
    .locator('#EntityFormControl_forma_EntityFormView > [data-form-layout]')
    .evaluate((node) => node.setAttribute('data-form-layout', JSON.stringify({ Id: 'form-a-xml' })));
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'exact',
    'native wrapper and its FormXml layout alias agree',
  );
  await page
    .locator('#EntityFormControl_forma_EntityFormView')
    .evaluate((node) => node.setAttribute('data-form-layout', JSON.stringify({ Id: 'form-b' })));
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'conflicting',
    'a wrapper layout cannot hide its different child layout',
  );
  await page
    .locator('#EntityFormControl_forma_EntityFormView')
    .evaluate((node) => node.removeAttribute('data-form-layout'));
  await page
    .locator('#EntityFormControl_forma_EntityFormView')
    .evaluate((node) => (node.id = 'EntityFormControl_unexported_EntityFormView'));
  assert.equal(
    (await inspect('#native-title')).owner.status,
    'unavailable',
    'a known child layout cannot conceal an unknown enclosing native instance',
  );
  await page.locator('#form').evaluate((form) => {
    const inner = document.createElement('div');
    inner.setAttribute('data-formid', 'not-exported');
    inner.innerHTML = '<input id="unknown-inner" name="title">';
    form.append(inner);
  });
  const unknownInner = await inspect('#unknown-inner');
  assert.equal(
    unknownInner.owner.status,
    'unavailable',
    'an unexported inner component cannot borrow the known outer form',
  );
  assert.equal(unknownInner.enclosing.length, 0);
  await page.locator('#form').evaluate((form) => form.setAttribute('data-viewid', 'not-exported'));
  assert.equal(
    (await inspect('#title')).owner.status,
    'unavailable',
    'a partial known identity does not erase another unrecognized component declaration',
  );
  await page.locator('#form').evaluate((form) => form.removeAttribute('data-viewid'));
  await page
    .locator('#form')
    .evaluate((form) => form.setAttribute('data-form-layout', JSON.stringify({ Id: 'form-b' })));
  assert.equal(
    (await inspect('#title')).owner.status,
    'conflicting',
    'two known structural form IDs on the same element cannot choose one',
  );
  await page
    .locator('#form')
    .evaluate((form) => form.setAttribute('data-form-layout', JSON.stringify({ Id: 'form-a-xml' })));
  assert.equal(
    (await inspect('#title')).owner.status,
    'exact',
    'basic-form and its FormXml alias identify the same definition',
  );
  await page
    .locator('#form')
    .evaluate((form) => form.setAttribute('data-form-layout', JSON.stringify({ Id: 'not-exported' })));
  assert.equal(
    (await inspect('#title')).owner.status,
    'unavailable',
    'a known explicit ID cannot hide an unknown layout ID',
  );
  await page.locator('#form').evaluate((form) => form.setAttribute('data-form-layout', '{invalid'));
  assert.equal(
    (await inspect('#title')).owner.status,
    'unavailable',
    'malformed explicit structural layout cannot borrow another identifier',
  );
  await page.locator('#form').evaluate((form) => form.removeAttribute('data-form-layout'));
  const conflicting = await inspect('#title', { forms: [{ ...bindings.forms[0], entity: 'sample_wrong' }] });
  assert.equal(conflicting.owner.status, 'conflicting');
  await page.locator('#form').evaluate((form) => form.removeAttribute('data-formid'));
  const noCurrentComponent = await inspect('#title');
  assert.equal(
    noCurrentComponent.owner.status,
    'unavailable',
    'table/name alone cannot assert a native component binding',
  );
});

test('typed advanced wrappers and modal form hierarchy preserve exact configuration while progress chrome stays enclosing', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://127.0.0.1:11889/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="WebFormControl_wizarda"><div id="WebFormControl_wizarda_ProgressIndicator"><ol class="progress"><li id="step" class="active">Escaped label</li></ol></div><div id="WebFormPanel"><div id="EntityFormView"><span data-form-layout=\'{"Id":"wizard-a","EntityName":"sample_child"}\'></span><input id="title" name="title"></div></div></div><iframe id="modal"></iframe>',
    }),
  );
  await page.goto('http://127.0.0.1:11889/');
  const scope = { documentId: 'typed-document', frameId: 'top', uiEpoch: 1, sourceRevision: 'typed-source' };
  const forms = [
    {
      id: 'wizard-a',
      kind: 'advanced-form',
      entity: 'sample_entry',
      configuredEntities: ['sample_entry', 'sample_child'],
    },
    { id: 'wizard-a', kind: 'basic-form', entity: 'sample_child' },
    {
      id: 'modal-a',
      kind: 'basic-form',
      entity: 'sample_child',
      formXml: { id: 'solution-form-a', name: 'Actual configured Solution form' },
    },
  ];
  const source = (id, componentKey, relationship = 'definition') => ({
    id,
    key: id,
    componentKey,
    kind: componentKey.split(':')[0],
    ref: 'invented/' + id + '.xml',
    sourceRevision: scope.sourceRevision,
    contentRevision: 'invented-current-hash',
    relationship,
  });
  const sourceRefs = [
    source('advanced-config', 'advanced-form:wizard-a'),
    source('basic-config', 'basic-form:modal-a'),
    source('solution-form', 'form:solution-form-a'),
    source('table-definition', 'table:sample_child'),
    source('column-definition', 'column:sample_child:title'),
  ];
  const options = { scope, bindings: { forms, columns: [{ name: 'title', entity: 'sample_child' }] }, sourceRefs };
  const read = new Function(
    'data',
    `return (${observePortalNode.toString()})(document.querySelector(data.selector),data.options);`,
  );
  const configuration = await page.evaluate(read, { selector: '#EntityFormView', options });
  const configured = resolveInspectionEvidence({ ...configuration, mode: 'live', node: { connected: true } });
  assert.equal(configured.owner.status, 'exact');
  assert.equal(configured.owner.component.key, 'advanced-form:wizard-a');
  assert.equal(configured.source.status, 'exact');
  assert.ok(configured.source.refs.some((ref) => ref.id === 'advanced-config'));
  const progress = await page.evaluate(read, { selector: '#step', options });
  assert.equal(
    resolveInspectionEvidence({ ...progress, mode: 'live', node: { connected: true } }).owner.status,
    'unavailable',
    'a progress child does not inherit its ancestor as selected owner',
  );
  assert.ok(
    progress.facts.some((fact) => fact.dimension === 'enclosing' && fact.binding.key === 'advanced-form:wizard-a'),
  );
  assert.ok(
    !progress.facts.some((fact) => fact.binding.key === 'basic-form:wizard-a'),
    'the known native WebForm prefix disambiguates equal IDs in different component tables',
  );
  await page.locator('#modal').evaluate((node) => {
    node.src = '/modal';
  });
  const frame = await (await page.locator('#modal').elementHandle()).contentFrame();
  await frame.waitForURL('http://127.0.0.1:11889/modal');
  await frame.locator('body').waitFor();
  await frame.evaluate(() => {
    document.body.innerHTML =
      '<div id="EntityFormControl"><div id="EntityFormPanel"><div id="EntityFormControl_EntityFormView"><span data-form-layout=\'{"Id":"modal-a","EntityName":"sample_child"}\'></span><input id="title" name="title"></div></div></div>';
  });
  const childOptions = { ...options, scope: { ...scope, documentId: 'modal-document', frameId: 'modal-frame' } };
  const packet = await frame.evaluate(read, { selector: '#title', options: childOptions });
  const hierarchy = packet.facts.filter((fact) => fact.dimension === 'enclosing');
  assert.deepEqual(
    hierarchy.map((fact) => fact.binding.key),
    ['form:solution-form-a', 'table:sample_child', 'basic-form:modal-a'],
  );
  assert.equal(hierarchy[0].origin, 'configured');
  assert.equal(hierarchy[0].predicate, 'uses-definition');
  assert.equal(
    resolveInspectionEvidence({ ...packet, mode: 'live', node: { connected: true } }).owner.component.key,
    'column:sample_child:title',
  );
  assert.deepEqual(
    packet.componentAnchors.find((anchor) => anchor.componentKey === 'form:solution-form-a'),
    {
      componentKey: 'form:solution-form-a',
      relationship: 'uses-definition',
      ancestorDepth: 1,
      localName: 'div',
      id: 'EntityFormControl_EntityFormView',
    },
  );
  await frame.locator('#EntityFormControl').evaluate((node) => {
    node.id = 'EntityFormControl_unknown';
  });
  assert.equal(
    resolveInspectionEvidence({
      ...(await frame.evaluate(read, { selector: '#title', options: childOptions })),
      mode: 'live',
      node: { connected: true },
    }).owner.status,
    'unavailable',
    'a typed child layout cannot conceal an unknown nearest native instance',
  );
  await page
    .locator('#EntityFormView')
    .evaluate((node) => node.append(node.querySelector('[data-form-layout]').cloneNode()));
  const ambiguous = await page.evaluate(read, { selector: '#title', options });
  assert.ok(ambiguous.availability.some((item) => item.reason === 'ambiguous-native-layout'));
  assert.equal(ambiguous.facts.length, 0);
});
