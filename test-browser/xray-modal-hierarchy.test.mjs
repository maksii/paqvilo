import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createSimulator } from '../mirage/server.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { selectionEvidenceCurrent } from '../lense/inspection-source-open.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('opening, replacing and reopening an actual modal form keeps field context and highlights inside its own frame', async (t) => {
  const fx = inspectionFixture();
  let app, context, panel, detach, openGate, openEntered;
  const opened = [];
  t.after(async () => {
    await panel?.dispose();
    await detach?.();
    await context?.close();
    await app?.close();
    fx.cleanup();
  });
  const form = path.join(fx.portal, 'basic-forms/Widget.basicform.yml');
  fs.writeFileSync(
    form,
    fs.readFileSync(form, 'utf8').replace('100000001', '100000000') + '\nadx_entitypermissionsenabled: false\n',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'basic-forms/Other.basicform.yml'),
    'adx_entityformid: other-editor\nadx_name: Other editor\nadx_entityname: fx_other\nadx_formname: Other form\nadx_mode: 100000000\n',
  );
  const other = path.join(fx.solution, 'Entities/fx_other');
  fs.mkdirSync(path.join(other, 'FormXml/main'), { recursive: true });
  fs.writeFileSync(
    path.join(other, 'Entity.xml'),
    '<Entity><Name>fx_other</Name><EntityInfo><entity Name="fx_other"><EntitySetName>fx_others</EntitySetName><attributes><attribute PhysicalName="fx_title"><Type>nvarchar</Type><LogicalName>fx_title</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
  );
  fs.writeFileSync(
    path.join(other, 'FormXml/main/other.xml'),
    '<systemform><formid>other-form</formid><FormActivationState>1</FormActivationState><form><tabs><tab><columns><column><sections><section><rows><row><cell><control id="fx_title" datafieldname="fx_title"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Other form" languagecode="1033"/></LocalizedNames></systemform>',
  );
  fs.writeFileSync(
    path.join(fx.portal, 'web-templates/Main.webtemplate.source.html'),
    `<!doctype html><html><head><meta charset="utf-8"></head><body><input id="fx_title" data-entityname="unrelated_parent" value="PRIVATE_PARENT_VALUE"><button id="open-modal" onclick="document.getElementById('modal-host').innerHTML='<section role=dialog><iframe title=Editor src=/_portal/modal-form-template-path/site?entityformid=widget-edit></iframe></section>'">Open editor</button><div id="modal-host"></div></body></html>`,
  );
  const template = path.join(fx.portal, 'web-templates/Main.webtemplate.source.html');
  fs.writeFileSync(
    template,
    fs
      .readFileSync(template, 'utf8')
      .replace(
        '<body>',
        '<body><div style="display:none">' +
          Array.from({ length: 320 }, (_, index) => `<input id="unrelated-${index}" name="unrelated-${index}">`).join(
            '',
          ) +
          '</div>',
      ),
  );
  app = await createSimulator({
    sourceDir: fx.portal,
    solutionRoots: [fx.solution],
    watch: false,
    stateFile: path.join(fx.work, 'state.json'),
    initial: {
      settings: { permissionMode: 'permissive' },
      mappings: { fx_widget: { idColumn: 'fx_widgetid' }, fx_other: { idColumn: 'fx_otherid' } },
      tables: { fx_widget: [], fx_other: [] },
    },
  });
  context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const session = new OverlaySession({
    sourceDir: fx.portal,
    origin: app.url,
    site: structuredClone(SITE),
    sourceMaps: false,
    siteName: 'Invented modal',
    envName: 'loopback',
    stateDir: fx.work,
    browser: { headless: true },
    mirage: true,
    mirageSourceRoots: [fx.portal, fx.solution],
    mirageConfig: { project: fx.project },
  });
  detach = await attachSession(context, session);
  panel = enablePanel(context, session, {
    open: async (...args) => {
      opened.push(args);
      openEntered?.();
      await openGate;
      return null;
    },
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  const input = page.frameLocator('iframe[title=Editor]').locator('#fx_title');
  try {
    await input.waitFor();
  } catch (error) {
    throw new Error((await page.frameLocator('iframe[title=Editor]').locator('body').innerText()).slice(0, 1000), {
      cause: error,
    });
  }
  const pill = page.locator('#paqvilo-panel .pill');
  // Decide on a drawn state (collapsed pill or open panel), not on a panel still being drawn.
  await page.locator('#paqvilo-panel').locator('.pill:visible, .wrap.open').first().waitFor();
  if (await pill.isVisible()) await pill.click();
  await page.locator('#paqvilo-panel .tabs [data-act=tab][data-v=runtime]').click();
  await page.locator('#paqvilo-panel [data-act=xray]').click();
  const select = () =>
    page.evaluate(() => {
      const tools = document.getElementById('paqvilo-xray').__px,
        node = document.querySelector('iframe').contentDocument.getElementById('fx_title');
      tools.select(node);
      return tools.selection();
    });
  await select();
  await page.waitForFunction(() => {
    const identity = document.getElementById('paqvilo-xray').__px.selection();
    return identity?.evidence.owner.status === 'exact' && identity.evidence.owner.component.entity === 'fx_widget';
  });
  const selected = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selection());
  assert.equal(selected.evidence.owner.status, 'exact');
  assert.equal(selected.evidence.owner.component.entity, 'fx_widget');
  assert.equal(selected.evidence.owner.component.name, 'fx_title');
  assert.deepEqual(selected.evidence.enclosing.map((row) => row.component.kind).slice(0, 4), [
    'form',
    'table',
    'basic-form',
    'webpage',
  ]);
  assert.equal(selected.evidence.enclosing.find((row) => row.component.kind === 'form').component.id, 'widget-form');
  assert.equal(
    selected.evidence.enclosing.find((row) => row.component.kind === 'basic-form').component.id,
    'widget-edit',
  );
  assert.equal(selected.evidence.enclosing.find((row) => row.component.kind === 'webpage').component.id, 'home');
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE_PARENT_VALUE|unrelated_parent/);
  const card = page.locator('#paqvilo-xray');
  assert.deepEqual(
    await card
      .locator('[data-hierarchy-kind]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.hierarchyKind))
      .then((kinds) => kinds.slice(0, 5)),
    ['column', 'form', 'table', 'basic-form', 'webpage'],
  );
  const mark = await page.evaluate(() => {
    const root = document.getElementById('paqvilo-xray').shadowRoot;
    const mark = root.querySelector('.mark.selected');
    return mark
      ? {
          left: mark.getBoundingClientRect().left,
          top: mark.getBoundingClientRect().top,
          width: mark.getBoundingClientRect().width,
        }
      : null;
  });
  assert.ok(mark?.width > 0, 'selected field has a visible overlay in the parent viewport');
  await page.waitForFunction(
    () =>
      document.getElementById('paqvilo-xray').shadowRoot.querySelector('.enclosing-form')?.dataset.componentKey ===
      'basic-form:widget-edit',
  );
  await page.evaluate(() => document.getElementById('modal-host').replaceChildren());
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selection() === null);
  await page.keyboard.down('Control');
  await page.getByRole('button', { name: 'Open editor', exact: true }).click();
  await page.keyboard.up('Control');
  await input.waitFor();
  const reopened = await select();
  assert.notEqual(reopened.evidence.scope.documentId, selected.evidence.scope.documentId);
  assert.equal(reopened.evidence.owner.component.entity, 'fx_widget');
  assert.equal(
    reopened.evidence.enclosing.find((row) => row.component.kind === 'basic-form').component.id,
    'widget-edit',
  );
  const oldScope = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
  await page.evaluate(
    () => (document.querySelector('iframe').src = '/_portal/modal-form-template-path/site?entityformid=other-editor'),
  );
  await page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selection() === null);
  await page.waitForFunction(() =>
    document
      .querySelector('iframe')
      .contentDocument?.querySelector('[data-form-layout]')
      ?.getAttribute('data-form-layout')
      ?.includes('other-editor'),
  );
  await input.waitFor();
  await select();
  await page.waitForFunction(() => {
    const identity = document.getElementById('paqvilo-xray').__px.selection();
    return identity?.evidence.owner.status === 'exact' && identity.evidence.owner.component.entity === 'fx_other';
  });
  const hydrated = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selection());
  assert.equal(hydrated.evidence.owner.status, 'exact');
  assert.equal(hydrated.evidence.owner.component.entity, 'fx_other');
  assert.equal(hydrated.evidence.enclosing.find((row) => row.component.kind === 'form').component.id, 'other-form');
  assert.equal(
    hydrated.evidence.enclosing.find((row) => row.component.kind === 'basic-form').component.id,
    'other-editor',
  );
  assert.equal(hydrated.evidence.source.status, 'exact');
  assert.ok(hydrated.evidence.source.refs.some((ref) => ref.componentKey === 'column:fx_other:fx_title'));
  await page.waitForFunction(
    () =>
      document.getElementById('paqvilo-xray').shadowRoot.querySelector('.enclosing-form')?.dataset.componentKey ===
      'basic-form:other-editor',
  );
  // Gate a late evidence refresh on the actual editor response. A refreshed
  // card must retain that response for the same selected field and document.
  await page.evaluate(() => {
    const tools = document.getElementById('paqvilo-xray').__px,
      status = tools.status;
    window.editorResponseRefreshes = 0;
    tools.status = (message, expected) => {
      status(message, expected);
      if (message.startsWith('Opened ')) {
        window.editorResponseRefreshes++;
        tools.refreshSelection('controlled-editor-response-refresh');
      }
    };
  });
  await card
    .locator('[data-evidence-role=source]')
    .getByRole('button', { name: 'Open source', exact: true })
    .first()
    .click();
  await page.waitForFunction(() =>
    document.getElementById('paqvilo-xray').shadowRoot.querySelector('.status')?.textContent.includes('Opened'),
  );
  assert.equal(await page.evaluate(() => window.editorResponseRefreshes), 1);
  assert.equal(fs.realpathSync(opened[0][1]), fs.realpathSync(path.join(other, 'Entity.xml')));
  assert.equal(
    await selectionEvidenceCurrent(page, oldScope),
    false,
    'the previous modal selection never authorizes an editor action',
  );
  // Hold the editor callback after admission, then replace the selection before
  // its response. That completed action must not label the new selection.
  let releaseOpen;
  openGate = new Promise((resolve) => (releaseOpen = resolve));
  const entered = new Promise((resolve) => (openEntered = resolve));
  t.after(() => releaseOpen());
  await card
    .locator('[data-evidence-role=source]')
    .getByRole('button', { name: 'Open source', exact: true })
    .first()
    .click();
  await entered;
  await select();
  releaseOpen();
  await page.waitForFunction(() => window.editorResponseRefreshes === 2);
  assert.equal(await card.locator('.status').textContent(), '');
  assert.equal(opened.length, 2);
  assert.equal(
    await page.evaluate(() => {
      const tools = document.getElementById('paqvilo-xray').__px;
      // One-shot picking deliberately retains its selection while disabled.
      tools.pickOnce();
      tools.select(document.querySelector('iframe').contentDocument.getElementById('fx_title'));
      tools.toggle(true);
      const beforeDisabled = tools.selectionState();
      tools.status('Current feedback');
      tools.toggle(false);
      tools.toggle(true);
      if (tools.selectionState().anchorGeneration !== beforeDisabled.anchorGeneration)
        throw new Error('The retained selection must not change to exercise the disabled feedback boundary.');
      tools.status('Stale editor feedback', beforeDisabled);
      return document.getElementById('paqvilo-xray').shadowRoot.querySelector('.status').textContent;
    }),
    '',
  );
});
