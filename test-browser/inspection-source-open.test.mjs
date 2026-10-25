import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { selectionEvidenceCurrent } from '../lense/inspection-source-open.mjs';

test('guarded opening reads a retained control before paint instead of trusting its cached old field', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const origin = 'http://127.0.0.1:11884';
  await page.route(origin + '/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<form data-formid="invented-form" data-entityname="sample_entry"><input id="selected" data-field="title" value="PRIVATE_VALUE"></form>',
    }),
  );
  await page.goto(origin);
  // No paint can silently refresh the cached identity between mutation and the
  // backend guard. Geometry and lifecycle notifications still execute normally.
  await page.evaluate(() => {
    let sequence = 0;
    const callbacks = new Map();
    window.requestAnimationFrame = (callback) => {
      callbacks.set(++sequence, callback);
      return sequence;
    };
    window.cancelAnimationFrame = (id) => callbacks.delete(id);
  });
  const sourceRevision = 'invented-source-revision';
  const refs = ['title', 'other'].map((field) => ({
    id: 'source-' + field,
    key: 'column:sample_entry:' + field + ':definition',
    componentKey: 'column:sample_entry:' + field,
    name: field + ' definition',
    kind: 'column',
    recordId: 'sample_entry',
    fieldPath: ['attributes', field],
    ref: 'solutions/Entry/Entity.xml',
    sourceRevision,
    contentRevision: 'invented-content-' + field,
    relationship: 'definition',
    region: { start: field === 'title' ? 10 : 40, end: field === 'title' ? 30 : 60 },
  }));
  const data = { origin, token: 'invented-selection-open', sourceRevision, inspection: { active: true } };
  await page.evaluate(xrayUi, data);
  await page.evaluate(
    ({ data, refs }) => {
      const tools = document.getElementById('paqvilo-xray').__px;
      tools.update(data, {
        sourceRevision: data.sourceRevision,
        forms: [{ id: 'invented-form', entity: 'sample_entry', name: 'Invented form' }],
        columns: ['title', 'other'].map((name) => ({ name, entity: 'sample_entry' })),
        sourceRefs: refs,
      });
      tools.toggle(true);
      tools.select(document.getElementById('selected'));
    },
    { data, refs },
  );
  const captured = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  const requestFor = (ref) => ({
    scope: captured.scope,
    anchorGeneration: captured.anchorGeneration,
    sourceKey: ref.key,
    sourceRevision: ref.sourceRevision,
    contentRevision: ref.contentRevision,
    region: ref.region,
  });
  const old = requestFor(refs[0]);
  assert.equal(captured.identity.evidence.owner.component.field, 'title');
  assert.equal(captured.identity.evidence.source.status, 'exact');
  assert.equal(await selectionEvidenceCurrent(page, old), true);

  await page.locator('#selected').evaluate((node) => node.setAttribute('data-field', 'other'));
  const retained = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  assert.equal(retained.anchorGeneration, captured.anchorGeneration);
  assert.deepEqual(retained.scope, captured.scope);
  assert.equal(
    retained.identity.evidence.owner.component.field,
    'title',
    'the deliberately frozen paint still has the old cached identity',
  );
  assert.equal(
    await selectionEvidenceCurrent(page, old),
    false,
    'old semantic source cannot open for a repurposed node',
  );
  const current = requestFor(refs[1]);
  assert.equal(
    await selectionEvidenceCurrent(page, current),
    true,
    'fresh source membership is read from this actual retained node',
  );

  for (const change of [
    { anchorGeneration: undefined },
    { anchorGeneration: -1 },
    { anchorGeneration: captured.anchorGeneration + 1 },
    { sourceRevision: 'obsolete-source' },
    { contentRevision: 'obsolete-content' },
    { sourceKey: refs[0].key },
    { region: { start: 10, end: 30 } },
    { scope: { ...current.scope, documentId: 'obsolete-document' } },
  ])
    assert.equal(await selectionEvidenceCurrent(page, { ...current, ...change }), false, JSON.stringify(change));

  await page.locator('#selected').evaluate((node) => node.replaceWith(node.cloneNode(true)));
  assert.equal(
    await selectionEvidenceCurrent(page, current),
    false,
    'same-id replacement is not the retained anchor, even before a paint',
  );
  assert.equal(
    await selectionEvidenceCurrent(null, { sourceKey: refs[1].key }),
    true,
    'explicit generic definition browsing makes no selected-node assertion',
  );
});
