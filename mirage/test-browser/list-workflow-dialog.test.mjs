// @test-kind unproven: local model of the legacy list workflow dialog (Adxstudio EntityGridExtensions renders the first workflow action's dialog; entity-grid.js writes a CustomizeModal action's title, confirmation and primary text into it, never its close text, and never restores it); no hosted capture of a configured list workflow action
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyState } from '../lib/data.mjs';
import { startListWorkflowSimulator } from '../test/support/list-workflow-fixture.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { openPortalPage, sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });

const G = (n) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const SITE = G(1);
const LIST = G(2);
const CONTACT = G(3);
const ROW = G(4);
const CUSTOM = G(5);
const PLAIN = G(6);
const label = (value) => [{ LCID: 1033, Value: value }];

async function launch(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'list-workflow-dialog-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const workflow = (id, extra) => ({
    Type: 'CrmEntityFormView-WorkflowAction',
    WorkflowId: id,
    ShowModal: 1,
    ...extra,
  });
  const settings = {
    ExtendedItemActions: [workflow(PLAIN, { ActionIndex: 1, ButtonLabel: label('Plain run') })],
    ItemActions: [
      workflow(CUSTOM, {
        ActionIndex: 2,
        ButtonLabel: label('Custom run'),
        Confirmation: label('Run the custom process?'),
        WorkflowDialogTitle: label('Custom title'),
        WorkflowDialogPrimaryButtonText: label('Start'),
        WorkflowDialogCloseButtonText: label('Not now'),
      }),
    ],
    WorkflowDialog: { Title: label('Grid title'), PrimaryButtonText: label('Go'), CloseButtonText: label('Back') },
  };
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Workflow dialog\n`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': "{% include 'entity_list' key: 'Widgets' %}",
    'Widgets.list.yml': [
      `adx_entitylistid: ${LIST}`,
      'adx_name: Widgets',
      'adx_entityname: contoso_widget',
      'adx_settings: |-',
      `  ${JSON.stringify(settings)}`,
    ].join('\n'),
    'pack.mjs': `
      export default {
        id: 'workflow-dialog-fixture', name: 'Workflow dialog fixture', description: 'Invented list handlers',
        matches: () => true, presets: () => ({}),
        workflows: {
          '${CUSTOM}': async ({ api, target }) => {
            await api.store.updateRecordAsync('contoso_widget', target.id, { status: 2 }, { admin: true });
          },
          '${PLAIN}': async ({ api, target }) => {
            await api.store.updateRecordAsync('contoso_widget', target.id, { status: 3 }, { admin: true });
          },
        },
      };
    `,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' }, status: { dataverseType: 'int' } },
    relationships: {},
  };
  state.settings.permissionMode = 'enforce';
  state.permissions = [
    { id: 'editor', entity: 'contoso_widget', scope: 'global', roles: ['Editor'], operations: ['read', 'update'] },
  ];
  state.tables.contact = [{ contactid: CONTACT, fullname: 'Invented visitor' }];
  state.tables.contoso_widget = [{ contoso_widgetid: ROW, name: 'alpha', status: 1 }];
  const app = await startListWorkflowSimulator({
    dir,
    state,
    workflowIds: [CUSTOM, PLAIN],
    pack: path.join(dir, 'pack.mjs'),
  });
  ownedFixture(t).add(() => app.close());
  const context = await chrome.browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, { roles: ['Editor'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await openPortalPage(page, `${app.url}/`);
  return { app, page, errors };
}

test('a list workflow action writes its own dialog texts into the grid dialog as the legacy grid does', async (t) => {
  const { app, page, errors } = await launch(t);
  const row = page.locator(`.entity-grid tr[data-id="${ROW}"]`);
  await row.waitFor();
  const modal = page.locator('.entity-grid .modal-run-workflow');
  const texts = () =>
    modal.evaluate((element) => {
      const primary = element.querySelector('.modal-footer button.primary');
      return {
        title: element.querySelector('.modal-title').textContent,
        body: element.querySelector('.modal-body').textContent,
        primary: primary.textContent,
        primaryTitle: primary.getAttribute('title'),
        cancel: element.querySelector('.modal-footer button.cancel').textContent,
      };
    });
  // The extended action (index 1) comes before the item action (index 2), and the dialog is the first action's.
  assert.deepEqual(await row.locator('a.workflow-link').allTextContents(), ['Plain run', 'Custom run']);
  assert.deepEqual(await texts(), {
    title: 'Grid title',
    body: 'Are you sure you want to run this workflow?',
    primary: 'Go',
    primaryTitle: null,
    cancel: 'Back',
  });
  await row.locator('a.workflow-link', { hasText: 'Custom run' }).evaluate((link) => link.click());
  await modal.locator('.modal-footer button.primary', { hasText: 'Start' }).waitFor({ state: 'attached' });
  // The action's close text never reaches the dialog (legacy data-modal-canled-action).
  assert.deepEqual(await texts(), {
    title: 'Custom title',
    body: 'Run the custom process?',
    primary: 'Start',
    primaryTitle: 'Start',
    cancel: 'Back',
  });
  await modal.locator('.modal-footer button.cancel').evaluate((button) => button.click());
  // An action without its own texts leaves the dialog as the last customized action wrote it.
  await row.locator('a.workflow-link', { hasText: 'Plain run' }).evaluate((link) => link.click());
  const plain = await texts();
  assert.deepEqual([plain.title, plain.primary, plain.cancel], ['Custom title', 'Start', 'Back']);
  const done = page.waitForResponse((response) => response.url().includes('/_services/execute-workflow/'));
  await modal.locator('.modal-footer button.primary').evaluate((button) => button.click());
  assert.equal((await done).status(), 204);
  assert.equal(app.store.tableRows('contoso_widget')[0].status, 3);
  assert.deepEqual(errors, []);
});
