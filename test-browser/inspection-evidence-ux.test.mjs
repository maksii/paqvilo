import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { createFixture, SITE } from '../test/fixture.mjs';
import { fakeBrowser } from '../test/fake-browser.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { enablePanel } from '../lense/panel.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const origin = 'http://127.0.0.1:11111';
const report = {
  page: null,
  forms: [],
  views: [],
  lists: [],
  tables: [],
  columns: [],
  components: [],
  unresolved: [],
  webTemplates: [],
  elementSources: [],
};
async function fixture(t, withPanel = false) {
  const context = await browser.newContext({ viewport: { width: 1420, height: 1050 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [],
    opened = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/__paqvilo/api/')) {
      if (url.pathname.endsWith('/open')) opened.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, version: 1, report } });
    }
    const child = url.pathname.startsWith('/frame');
    return route.fulfill({
      contentType: 'text/html',
      body: child
        ? '<!doctype html><button id="inner">Inner control</button><script>document.addEventListener("click",()=>parent.activations++)</script>'
        : '<!doctype html><style>body{font:16px Segoe UI;padding:120px 60px;background:#f3f5f7}button,input{padding:15px;margin:12px}iframe{display:block;width:450px;height:130px;margin:20px}h1{font-weight:500}</style><h1>Invented provenance workspace</h1><form id="sample"><button id="picked">Invented action</button><input id="value" value="PRIVATE_VALUE"></form><div id="shadow"></div><iframe id="frame" src="/frame-a"></iframe><script>window.activations=0;document.addEventListener("click",()=>activations++);document.getElementById("sample").addEventListener("submit",e=>{e.preventDefault();activations++});document.getElementById("shadow").attachShadow({mode:"open"}).innerHTML="<button id=inside>Shadow control</button>";</script>',
    });
  });
  await page.goto(origin);
  let state = { origin, token: 'invented-evidence-ui', inspection: { active: true, version: 1 }, ui: { open: false } };
  if (withPanel) {
    const source = createFixture(),
      fake = fakeBrowser(),
      tab = fake.openTab(origin);
    const session = new OverlaySession({
      origin,
      sourceDir: source.dir,
      site: structuredClone(SITE),
      siteName: 'Invented',
      envName: 'loopback',
      stateDir: source.dir,
    });
    const controller = enablePanel(fake.context, session);
    state = { ...controller.stateFor(tab.page), inspection: state.inspection, ui: state.ui };
    t.after(async () => {
      await controller.dispose();
      source.cleanup();
    });
  }
  await page.evaluate(xrayUi, state);
  if (withPanel) await page.evaluate(panelUi, state);
  await page.evaluate(
    ({ state, report }) => {
      window.lifecycle = [];
      document.addEventListener('paqvilo-xray', (event) => {
        if (['selected', 'updated', 'cleared', 'detached', 'stale'].includes(event.detail.action))
          window.lifecycle.push(event.detail);
      });
      document.getElementById('paqvilo-xray').__px.update(state, report);
    },
    { state, report },
  );
  return { page, state, errors, opened };
}
const select = (page, oneShot = false, target = 'picked') =>
  page.evaluate(
    ({ oneShot, target }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      if (oneShot) api.pickOnce();
      else api.toggle(true);
      api.select(document.getElementById(target));
    },
    { oneShot, target },
  );

test('one-shot retains node identity while hidden, updates and detaches without selector replacement rebinding', async (t) => {
  const { page, state, errors } = await fixture(t);
  await page.locator('#picked').evaluate((node) => {
    node.id = 'private-row-7e6a';
    node.setAttribute('name', 'private-user-123');
    node.className = 'private-account-789';
  });
  await select(page, true, 'private-row-7e6a');
  const before = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.refreshSelection('provider-hydrated'));
  const hydrated = await page.evaluate(() => ({
    state: document.getElementById('paqvilo-xray').__px.selectionState(),
    enabled: document.getElementById('paqvilo-xray').__px.enabled,
    event: window.lifecycle.at(-1),
  }));
  assert.equal(hydrated.state.anchorGeneration, before.anchorGeneration);
  assert.equal(hydrated.state.anchorId, before.anchorId);
  assert.equal(hydrated.enabled, false);
  assert.equal(hydrated.event.action, 'updated');
  assert.equal(hydrated.event.reason, 'provider-hydrated');
  assert.ok(before.anchorId);
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-xray').__px.enabled), false);
  await page.locator('#private-row-7e6a').evaluate((node) => node.setAttribute('data-formid', 'invented-new-form'));
  await page.waitForFunction(() => window.lifecycle.some((event) => event.action === 'updated'));
  await page.evaluate(
    (state) => document.getElementById('paqvilo-xray').__px.update({ ...state, sourceRevision: 'source-next' }, null),
    state,
  );
  await page.waitForFunction(() => window.lifecycle.some((event) => event.action === 'stale'));
  await page.locator('#private-row-7e6a').evaluate((node) => node.replaceWith(node.cloneNode(true)));
  await page.waitForFunction(() => window.lifecycle.some((event) => event.action === 'detached'));
  const snapshot = await page.evaluate(() => ({
    events: window.lifecycle,
    selection: document.getElementById('paqvilo-xray').__px.selection(),
    activations: window.activations,
  }));
  assert.equal(snapshot.selection, null);
  assert.equal(snapshot.activations, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-row-7e6a|private-user-123|private-account-789|PRIVATE_VALUE/);
  assert.equal(snapshot.events.at(-1).action, 'cleared');
  for (const event of snapshot.events) {
    assert.ok(event.reason && Number.isSafeInteger(event.selectionGeneration));
    assert.ok(event.scope.documentId && event.scope.frameId && event.scope.uiEpoch && event.scope.sourceRevision);
    assert.equal('origin' in event.scope, false);
  }
  await select(page, true, 'private-row-7e6a');
  assert.notEqual(
    (await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState())).anchorId,
    before.anchorId,
  );
  assert.deepEqual(errors, []);
});

test('summary roles persist across tabs, preserve focus and forward only guarded source actions', async (t) => {
  const { page, state, errors, opened } = await fixture(t, true);
  await select(page, true);
  await page.waitForFunction(
    () =>
      document.getElementById('paqvilo-panel').shadowRoot.querySelector('.body')?.getAttribute('aria-busy') === 'false',
  );
  // Test the panel's admitted event contract independently of the resolver.
  // Actual retained-node/observer behavior is exercised by the adjacent cases.
  await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    window.fixtureSelection = api.selectionState();
    api.dispose();
    window.fixtureSelection.selectionGeneration += 2;
    window.fixtureSelectionFirst = true;
  });
  const inject = (certainty = 'candidate', label = 'Invented form') =>
    page.evaluate(
      ({ certainty, label }) => {
        const context = window.fixtureSelection;
        const evidence = {
          version: 1,
          scope: context.scope,
          owner: { status: 'exact', component: { name: label, kind: 'form' }, evidence: [] },
          source: {
            status: certainty,
            refs: [
              {
                key: 'invented-key',
                sourceRevision: 'source-1',
                contentRevision: 'content-1',
                ref: 'synthetic/form.xml',
                region: { start: 5, end: 10 },
                kind: 'script',
                observations: { served: 'observed', executed: 'unavailable' },
              },
            ],
          },
          enclosing: [],
          facts: [],
          candidates: [],
          conflicts: [],
          unavailable: [],
          limits: { truncated: true },
        };
        document.dispatchEvent(
          new CustomEvent('paqvilo-xray', {
            detail: {
              action: window.fixtureSelectionFirst ? 'selected' : 'updated',
              reason: 'synthetic-admitted-evidence',
              scope: context.scope,
              anchorId: context.anchorId,
              selectionGeneration: context.selectionGeneration,
              element: { tag: 'button' },
              identity: { title: label, evidence },
              oneShot: true,
            },
          }),
        );
        window.fixtureSelectionFirst = false;
      },
      { certainty, label },
    );
  await inject();
  const panel = page.locator('#paqvilo-panel'),
    summary = panel.locator('[data-selected-identity]');
  await summary.waitFor();
  assert.equal(await summary.locator('[data-evidence-role]').count(), 6);
  assert.equal(await summary.locator('[data-owner-status="exact"][data-source-status="candidate"]').count(), 1);
  await panel.getByRole('tab', { name: /Issues/ }).click();
  assert.equal(await summary.count(), 1);
  await summary.getByRole('button', { name: 'Open candidate', exact: true }).click();
  await page.waitForFunction(() =>
    document.getElementById('paqvilo-panel').shadowRoot.querySelector('.toast')?.textContent.includes('Opened'),
  );
  assert.deepEqual(opened.at(-1).region, { start: 5, end: 10 });
  assert.equal(opened.at(-1).sourceKey, 'invented-key');
  assert.equal(opened.at(-1).sourceRevision, 'source-1');
  assert.equal(opened.at(-1).contentRevision, 'content-1');
  const contextSummary = summary.locator('[data-focus-key="evidence-context-summary"]');
  await contextSummary.focus();
  await contextSummary.press('Enter');
  await inject('stale', 'Updated invented form');
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-panel').shadowRoot.activeElement?.dataset.focusKey),
    'evidence-context-summary',
  );
  assert.equal(await summary.getByRole('button', { name: 'Open source', exact: true }).isDisabled(), true);
  assert.equal(await summary.locator('[data-owner-status="exact"][data-source-status="stale"]').count(), 1);
  const sourceContext = summary.locator('summary [data-evidence-source-context]');
  assert.equal(await sourceContext.textContent(), 'synthetic/form.xml');
  await summary.locator('.selection-evidence-body').evaluate((body) => (body.scrollTop = body.scrollHeight));
  assert.equal(await sourceContext.isVisible(), true, 'the selected file remains visible above scrolled evidence');
  await summary.locator(':scope > summary').click();
  assert.equal(await sourceContext.isVisible(), true, 'the selected file remains visible with details collapsed');
  await summary.locator(':scope > summary').click();
  if (process.env.PAQVILO_EVIDENCE_DIR) {
    await fs.mkdir(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, 'selected-independent-facets.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(process.env.PAQVILO_EVIDENCE_DIR, 'selected-independent-facets-narrow.png'),
    });
  }
  await summary.getByRole('button', { name: 'Clear selection' }).click();
  assert.equal(await summary.count(), 0);
  assert.equal(await page.evaluate(() => window.activations), 0);
  assert.deepEqual(errors, []);
  await page.evaluate(panelUi, state);
});

test('inspection keyboard includes native summaries, blocks activation and tracks shadow/frame node lifetimes', async (t) => {
  const { page, errors } = await fixture(t);
  await select(page);
  const xray = page.locator('#paqvilo-xray');
  await xray.locator('summary').first().focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-xray').shadowRoot.activeElement?.getRootNode().host.id),
    'paqvilo-xray',
  );
  await page.keyboard.press('Shift+Tab');
  assert.equal(
    await page.evaluate(() => document.getElementById('paqvilo-xray').shadowRoot.activeElement?.localName),
    'summary',
  );
  await page.evaluate(() => document.getElementById('picked').focus());
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.activations), 0);
  await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.pickOnce();
    api.select(document.getElementById('shadow').shadowRoot.getElementById('inside'));
    document.getElementById('shadow').remove();
  });
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selection() === null);
  const first = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.pickOnce();
    api.select(document.getElementById('frame').contentDocument.getElementById('inner'));
    return api.selectionState();
  });
  await page.locator('#frame').evaluate((node) => {
    node.src = '/frame-b';
  });
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selection() === null);
  const second = await page.evaluate(() => {
    const api = document.getElementById('paqvilo-xray').__px;
    api.pickOnce();
    api.select(document.getElementById('frame').contentDocument.getElementById('inner'));
    return api.selectionState();
  });
  assert.equal(first.scope.frameId, second.scope.frameId);
  assert.notEqual(first.scope.documentId, second.scope.documentId);
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.dispose());
  assert.equal(await page.evaluate(() => window.lifecycle.at(-1).reason), 'disposed');
  assert.deepEqual(errors, []);
});

test('recreated UI epochs admit the new selection and reject older or mismatched evidence after clear', async (t) => {
  const { page, state, errors } = await fixture(t, true);
  await select(page, true);
  const prior = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.dispose());
  await page.evaluate(xrayUi, state);
  await select(page, true);
  const current = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  assert.ok(current.scope.uiEpoch > prior.scope.uiEpoch);
  const summary = page.locator('#paqvilo-panel [data-selected-identity]');
  await summary.waitFor();
  await page.evaluate(
    ({ prior, current }) => {
      const emit = (scope, identity) =>
        document.dispatchEvent(
          new CustomEvent('paqvilo-xray', {
            detail: {
              action: 'updated',
              reason: 'invented-late-reply',
              scope,
              anchorId: current.anchorId,
              selectionGeneration: 9999,
              element: { tag: 'button' },
              identity,
            },
          }),
        );
      emit(prior.scope, { title: 'OBSOLETE_EPOCH', evidence: { version: 1, scope: prior.scope } });
      emit(current.scope, { title: 'MISMATCHED_SCOPE', evidence: { version: 1, scope: prior.scope } });
    },
    { prior, current },
  );
  assert.doesNotMatch(await summary.innerText(), /OBSOLETE|MISMATCHED/);
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.clearSelection('user-clear'));
  await page.evaluate(
    (current) =>
      document.dispatchEvent(
        new CustomEvent('paqvilo-xray', {
          detail: {
            action: 'updated',
            reason: 'invented-late-reply',
            scope: current.scope,
            anchorId: current.anchorId,
            selectionGeneration: current.selectionGeneration,
            element: { tag: 'button' },
            identity: current.identity,
          },
        }),
      ),
    current,
  );
  assert.equal(await summary.count(), 0);
  assert.deepEqual(errors, []);
});

test('Tab brings overflowing source controls into view without scrolling or activating the portal', async (t) => {
  const { page, state, errors } = await fixture(t);
  await page.evaluate(
    ({ state, report }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(state, {
        ...report,
        elementSources: Array.from({ length: 30 }, (_, index) => ({
          selector: '#picked',
          matchKind: 'id',
          kind: 'template',
          name: 'Candidate ' + index,
          ref: 'synthetic/' + index + '.html',
        })),
      });
    },
    { state, report },
  );
  await select(page);
  const xray = page.locator('#paqvilo-xray');
  await xray.locator('[data-evidence-source] [data-action=copy]').first().focus();
  const portalScroll = await page.evaluate(() => window.scrollY);
  for (let index = 0; index < 20; index++) await page.keyboard.press('Tab');
  assert.ok(await xray.locator('.content').evaluate((node) => node.scrollTop > 0));
  assert.equal(await page.evaluate(() => window.scrollY), portalScroll);
  assert.equal(await page.evaluate(() => window.activations), 0);
  assert.deepEqual(errors, []);
});
