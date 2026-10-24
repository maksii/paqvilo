import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { installModelPanel } from './helpers/model-driven-panel.mjs';
import { modelDrivenActionsUi } from '../lense/model-driven-actions-ui.mjs';
import { installModelDrivenCommands } from '../lense/model-driven-commands.mjs';
import { MODEL_DRIVEN_ACTIONS } from '../lense/model-driven-actions.mjs';

async function capture(page, name) {
  if (process.env.PAQVILO_ACTIONS_SCREENSHOTS) {
    await fs.mkdir(process.env.PAQVILO_ACTIONS_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PAQVILO_ACTIONS_SCREENSHOTS, name + '.png') });
  }
}

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions());
});
after(() => browser?.close());

async function fixture(t) {
  const server = http.createServer((_request, response) =>
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented native app</title>'),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  ownedFixture(t).add(async () => {
    await context.close();
  });
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
  });
  ownedFixture(t).add(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const data = {
    origin,
    token: 'invented-token',
    revision: 1,
    resourceCount: 0,
    resources: [],
    diagnostics: [],
    problems: [],
    catalogue: { forms: [], commands: [] },
    context: {},
  };
  await installModelPanel(page, data);
  await page.evaluate(installModelDrivenCommands, data);
  const actions = [
    { id: 'read', label: 'Read values', group: 'Inspect', description: 'Read an invented record.', inputs: [] },
    {
      id: 'open',
      label: 'Open table',
      group: 'Open',
      description: 'Requires a native table.',
      inputs: [{ name: 'entity', label: 'Table logical name', type: 'table', required: true }],
    },
    {
      id: 'open-id',
      label: 'Open by ID',
      group: 'Open',
      description: 'Open a saved record.',
      inputs: [
        { name: 'entity', label: 'Table logical name', type: 'table', required: true },
        { name: 'id', label: 'Record ID', type: 'guid', required: true },
      ],
    },
    {
      id: 'identity:users',
      label: 'Find directory users',
      group: 'Identity',
      description: 'Search the directory.',
      inputs: [{ name: 'query', label: 'Directory search', type: 'text' }],
    },
    {
      id: 'identity:status',
      label: 'Identity support',
      group: 'Identity',
      description: 'Read native privilege support.',
      inputs: [],
    },
  ];
  const update = {
    origin,
    token: data.token,
    actions,
    availability: actions.map((action) => ({
      id: action.id,
      available: action.id !== 'open',
      reason: action.id === 'open' ? 'Native navigation is unavailable.' : undefined,
    })),
  };
  await page.evaluate(() => {
    window.uiRequests = [];
    window.secret = 'PRIVATE_NATIVE_VALUE';
    window.__paqviloModelAction = async (request) => {
      window.uiRequests.push(request);
      const host = document.getElementById('paqvilo-panel');
      const result =
        request.action === 'identity:users'
          ? {
              status: 'ok',
              title: 'Directory',
              users: [{ label: 'Invented user', objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
            }
          : {
              status: 'ok',
              title: 'Invented result',
              columns: ['Value'],
              rows: [[window.secret], ['<img src=x onerror=alert(1)>']],
              copyText: window.secret,
              links: [
                { label: 'Native record', url: location.origin + '/main.aspx?pagetype=entityrecord' },
                { label: 'Unsafe link', url: 'javascript:alert(1)' },
              ],
            };
      queueMicrotask(() => host.__paqModelActions.receive(request.requestId, result));
      return { accepted: true, requestId: request.requestId };
    };
    window.__paqviloModelIdentity = async (request) => {
      window.uiRequests.push(request);
      queueMicrotask(() =>
        document.getElementById('paqvilo-panel').__paqModelActions.receive(request.requestId, {
          status: 'ok',
          title: 'Identity',
          message: 'Updated',
          identity: { active: Boolean(request.objectId), label: 'Invented user' },
        }),
      );
      return { accepted: true, requestId: request.requestId };
    };
  });
  await page.evaluate(modelDrivenActionsUi, update);
  return { page, update, errors };
}

test('Actions groups, reasons, label-only favorites, inert results, responsive layout and context cleanup', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Favorite Read values', exact: true }).click();
  await page.getByRole('button', { name: /^Open table/ }).click();
  assert.equal(await page.getByRole('button', { name: 'Run action', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Native navigation is unavailable.', { exact: true }).last().isVisible(), true);
  await page.getByRole('button', { name: /^Open by ID/ }).click();
  await page.getByRole('textbox', { name: 'Table logical name', exact: true }).fill('x_item');
  await page.getByRole('textbox', { name: 'Record ID', exact: true }).fill('invalid-guid');
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  assert.equal(await page.evaluate(() => window.uiRequests.length), 0, 'invalid IDs never leave the browser form');
  await page.getByRole('textbox', { name: 'Record ID', exact: true }).fill('{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}');
  assert.equal(
    await page.getByRole('textbox', { name: 'Record ID', exact: true }).evaluate((node) => node.checkValidity()),
    true,
  );
  await page.getByRole('textbox', { name: 'Table logical name', exact: true }).fill('x item');
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.uiRequests.length),
    0,
    'invalid table names never leave the browser form',
  );
  await page.getByRole('searchbox', { name: 'Find actions', exact: true }).fill('Read values');
  await page.getByRole('button', { name: /^Read values/ }).click();
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  assert.equal(await page.locator('.actions-result img').count(), 0);
  await page.getByRole('searchbox', { name: 'Filter results', exact: true }).fill('PRIVATE');
  assert.equal(await page.getByRole('cell', { name: '<img src=x onerror=alert(1)>', exact: true }).isVisible(), false);
  await page.getByRole('searchbox', { name: 'Filter results', exact: true }).fill('');
  assert.equal(await page.getByRole('link', { name: 'Unsafe link', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('link', { name: 'Native record', exact: true }).getAttribute('rel'),
    'noopener noreferrer',
  );
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.ok(stored.includes('Read values'));
  assert.equal(stored.includes('PRIVATE_NATIVE_VALUE'), false);
  await capture(page, 'actions-desktop');
  await page.evaluate(modelDrivenActionsUi, update);
  assert.equal(await page.getByRole('searchbox', { name: 'Find actions', exact: true }).inputValue(), 'Read values');
  await page.evaluate(() => document.getElementById('paqvilo-panel').__paqModelActions.contextChanged());
  assert.equal(await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).count(), 0);
  await page.evaluate(() => {
    window.__paqviloModelAction = async (request) => ({
      accepted: false,
      requestId: request.requestId,
      reason: 'invalid-input',
    });
  });
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await page.getByText('Check the action inputs and try again.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__paqviloModelAction = async (request) => {
      window.stalledRequest = request;
      return { accepted: true, requestId: request.requestId };
    };
  });
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await page.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await page.evaluate(() =>
    document.getElementById('paqvilo-panel').__paqModelActions.receive(window.stalledRequest.requestId, {
      status: 'ok',
      title: 'Late',
      message: 'LATE_PRIVATE_RESULT',
    }),
  );
  assert.equal(await page.getByText('LATE_PRIVATE_RESULT', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Run action', exact: true }).isEnabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.locator('.actions-panel').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }),
    true,
  );
  await capture(page, 'actions-mobile');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Model-driven actions', exact: true }).isVisible(), false);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.locator('#paqvilo-panel [data-act=xray]').click();
  assert.equal(await page.getByRole('dialog', { name: 'Model-driven actions', exact: true }).isVisible(), false);
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-xray').__px.enabled), true);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});

test('the full action registry keeps keyboard focus through tool tabs, execution results and Escape on mobile', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    actions: MODEL_DRIVEN_ACTIONS,
    availability: MODEL_DRIVEN_ACTIONS.map((action) => ({ id: action.id, available: true })),
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  assert.equal(await page.getByRole('searchbox', { name: 'Find actions', exact: true }).isVisible(), true);
  await page.locator('.actions-tabs').getByRole('button', { name: 'Identity', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(
    await page.locator('#paqvilo-panel').evaluate((node) => node.shadowRoot.activeElement?.textContent),
    'Identity',
  );
  await page.locator('.actions-tabs').getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find actions', exact: true }).fill('Record ID');
  await page.locator('.actions-item>button:first-child').filter({ hasText: 'Record ID' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Run action', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Invented result', exact: true }).waitFor();
  assert.equal(await page.locator('#paqvilo-panel').evaluate((node) => node.shadowRoot.activeElement?.tagName), 'H3');
  await page.keyboard.press('Escape');
  assert.equal(
    await page
      .locator('#paqvilo-panel')
      .evaluate((node) => node.shadowRoot.activeElement?.getAttribute('aria-controls')),
    'paqvilo-tab-content',
  );
  assert.deepEqual(errors, []);
});

test('late native operation errors replace only the current completed result and never resurrect cleared or older results', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: /^Read values/ }).click();
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await page.getByRole('heading', { name: 'Invented result', exact: true }).waitFor();
  await page.evaluate(() => {
    window.firstResultId = window.uiRequests.at(-1).requestId;
    document.getElementById('paqvilo-panel').__paqModelActions.followup(window.firstResultId, {
      status: 'error',
      title: 'Native form error',
      message: 'The requested native form failed.',
    });
  });
  await page.getByText('The requested native form failed.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await page.getByRole('heading', { name: 'Invented result', exact: true }).waitFor();
  await page.evaluate(() =>
    document
      .getElementById('paqvilo-panel')
      .__paqModelActions.followup(window.firstResultId, { status: 'error', message: 'OLD_RESULT_MUST_NOT_REPLACE' }),
  );
  assert.equal(await page.getByText('OLD_RESULT_MUST_NOT_REPLACE', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.evaluate(() =>
    document.getElementById('paqvilo-panel').__paqModelActions.followup(window.uiRequests.at(-1).requestId, {
      status: 'error',
      message: 'CLEARED_RESULT_MUST_NOT_RETURN',
    }),
  );
  assert.equal(await page.getByText('CLEARED_RESULT_MUST_NOT_RETURN', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('Identity requires explicit selection and Start, keeps visible Stop when closed, and survives metadata updates', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Identity', exact: true }).click();
  await page.getByRole('textbox', { name: 'Directory search', exact: true }).fill('Invented');
  await page.getByRole('button', { name: 'Run action', exact: true }).click();
  await page.getByRole('button', { name: 'Invented user', exact: true }).click();
  assert.equal(await page.evaluate(() => window.uiRequests.some((request) => 'objectId' in request)), false);
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    availability: update.availability.map((item) =>
      item.id === 'identity:status' ? { ...item, available: false, reason: 'Native privilege API unavailable.' } : item,
    ),
  });
  assert.equal(
    await page.getByRole('button', { name: 'Start acting as selected user', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByText('Native privilege API unavailable.', { exact: true }).isVisible(), true);
  await page.evaluate(modelDrivenActionsUi, update);
  await page.getByRole('button', { name: 'Start acting as selected user', exact: true }).click();
  await page.locator('.actions-bar-identity').waitFor();
  await page.evaluate(modelDrivenActionsUi, update);
  await page.getByRole('tab', { name: /^Overrides/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, 'identity-closed-mobile');
  assert.equal(await page.locator('.actions-bar-identity').isVisible(), true);
  await page.locator('.actions-bar-identity').getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('.actions-bar-identity').waitFor({ state: 'hidden' });
  assert.deepEqual(
    await page.evaluate(() =>
      window.uiRequests.filter((request) => 'objectId' in request).map((request) => request.objectId),
    ),
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null],
  );
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...localStorage }).includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
    false,
  );
  assert.deepEqual(errors, []);
});

test('Custom commands retain drafts and caret, import without execution, run async code only explicitly and retire cleanly', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await page.getByRole('textbox', { name: 'Command label', exact: true }).fill('Read current browser value');
  const editor = page.getByRole('textbox', { name: 'Command JavaScript', exact: true });
  await editor.fill('await Promise.resolve(); return window.secret;');
  await editor.focus();
  await editor.evaluate((node) => node.setSelectionRange(5, 9));
  await page.evaluate(modelDrivenActionsUi, update);
  assert.equal(await editor.inputValue(), 'await Promise.resolve(); return window.secret;');
  assert.deepEqual(
    await editor.evaluate((node) => [
      node.selectionStart,
      node.selectionEnd,
      node.getRootNode().activeElement === node,
    ]),
    [5, 9, true],
  );
  await page.getByRole('button', { name: 'Save command', exact: true }).click();
  assert.equal(await page.getByText('PRIVATE_NATIVE_VALUE', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await page.getByText('PRIVATE_NATIVE_VALUE', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('paqvilo.modelActions.commands.v1').includes('PRIVATE_NATIVE_VALUE'),
    ),
    false,
  );
  const savedId = await page.evaluate(
    () => JSON.parse(localStorage.getItem('paqvilo.modelActions.commands.v1')).commands[0].id,
  );
  await editor.fill('window.staleDraftExecuted=true; return "old";');
  await page.locator('.actions-panel input[type=file]').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":2,"commands":[]}'),
  });
  assert.equal(await editor.inputValue(), 'window.staleDraftExecuted=true; return "old";');
  await page.locator('.actions-panel input[type=file]').setInputFiles({
    name: 'replacement.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        commands: [{ id: savedId, label: 'Replacement action', code: 'window.replacementExecuted=true; return 99;' }],
      }),
    ),
  });
  await page.getByRole('combobox', { name: 'Saved custom commands', exact: true }).selectOption(savedId);
  assert.equal(await editor.inputValue(), 'window.replacementExecuted=true; return 99;');
  assert.equal(await page.evaluate(() => Boolean(window.replacementExecuted)), false);
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await page.waitForFunction(() => window.replacementExecuted === true);
  assert.equal(await page.evaluate(() => Boolean(window.staleDraftExecuted)), false);
  await page.locator('.actions-panel input[type=file]').setInputFiles({
    name: 'commands.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        commands: [{ id: 'imported', label: 'Imported action', code: 'window.importExecuted=true; return 42;' }],
      }),
    ),
  });
  assert.equal(await page.evaluate(() => Boolean(window.importExecuted)), false);
  await page.getByRole('combobox', { name: 'Saved custom commands', exact: true }).selectOption('imported');
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await page.waitForFunction(() => window.importExecuted === true);
  await page.evaluate(() => document.getElementById('paqvilo-panel').__paqModelInspector.dispose());
  assert.equal(await page.locator('#paqvilo-panel').count(), 0);
  assert.deepEqual(errors, []);
});
