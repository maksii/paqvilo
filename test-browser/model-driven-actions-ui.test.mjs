// @test-kind contract: the model-driven Actions panel runs on an invented loopback page with stubbed action bindings.
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
  // The count is the kit's count pill, not a number in parentheses.
  assert.equal(await page.locator('.actions-unavailable > summary .n').textContent(), '1');
  await page.locator('.actions-unavailable > summary').click();
  assert.equal(await page.getByRole('button', { name: 'Run Open table', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Native navigation is unavailable.', { exact: true }).last().isVisible(), true);
  // Run on a row that needs inputs first shows them under the row; Run then submits them.
  await page.getByRole('button', { name: 'Run Open by ID', exact: true }).click();
  await page.getByRole('textbox', { name: 'Table logical name', exact: true }).fill('x_item');
  await page.getByRole('textbox', { name: 'Record ID', exact: true }).fill('invalid-guid');
  await page.getByRole('button', { name: 'Run Open by ID', exact: true }).click();
  assert.equal(await page.evaluate(() => window.uiRequests.length), 0, 'invalid IDs never leave the browser form');
  await page.getByRole('textbox', { name: 'Record ID', exact: true }).fill('{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}');
  assert.equal(
    await page.getByRole('textbox', { name: 'Record ID', exact: true }).evaluate((node) => node.checkValidity()),
    true,
  );
  await page.getByRole('textbox', { name: 'Table logical name', exact: true }).fill('x item');
  await page.getByRole('button', { name: 'Run Open by ID', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.uiRequests.length),
    0,
    'invalid table names never leave the browser form',
  );
  await page.getByRole('searchbox', { name: 'Find actions', exact: true }).fill('Read values');
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
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
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByText('Check the action inputs and try again.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__paqviloModelAction = async (request) => {
      window.stalledRequest = request;
      return { accepted: true, requestId: request.requestId };
    };
  });
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await page.evaluate(() =>
    document.getElementById('paqvilo-panel').__paqModelActions.receive(window.stalledRequest.requestId, {
      status: 'ok',
      title: 'Late',
      message: 'LATE_PRIVATE_RESULT',
    }),
  );
  assert.equal(await page.getByText('LATE_PRIVATE_RESULT', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Run Read values', exact: true }).isEnabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.locator('.actions-panel').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth;
    }),
    true,
  );
  await capture(page, 'actions-mobile');
  // Esc folds the open action, then closes the panel; it never moves to another tab.
  await page.getByRole('button', { name: 'Run Read values', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.actions-inline').count(), 0);
  assert.equal(await page.getByRole('tab', { name: 'Actions', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.panel[role=dialog]').isVisible(), false, 'the second Esc closes the panel');
  await page.keyboard.press('Alt+Shift+P');
  await page.locator('.panel[role=dialog]').waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Actions', exact: true }).getAttribute('aria-selected'), 'true');
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
  await page.locator('.actions-tabs').getByRole('button', { name: 'Built-in', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find actions', exact: true }).fill('Record ID');
  await page.getByRole('button', { name: 'Run Record ID', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  assert.equal(
    await page.locator('#paqvilo-panel').evaluate((node) => node.shadowRoot.activeElement?.getAttribute('aria-label')),
    'Action results',
  );
  // Esc folds the result and returns the focus to the action's Run; the Actions tab stays open.
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.actions-inline').count(), 0);
  assert.equal(
    await page.locator('#paqvilo-panel').evaluate((node) => node.shadowRoot.activeElement?.getAttribute('aria-label')),
    'Run Record ID',
  );
  assert.equal(await page.getByRole('tab', { name: 'Actions', exact: true }).getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
});

test('late native operation errors replace only the current completed result and never resurrect cleared or older results', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  await page.evaluate(() => {
    window.firstResultId = window.uiRequests.at(-1).requestId;
    document.getElementById('paqvilo-panel').__paqModelActions.followup(window.firstResultId, {
      status: 'error',
      title: 'Native form error',
      message: 'The requested native form failed.',
    });
  });
  await page.getByText('The requested native form failed.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  await page.evaluate(() =>
    document
      .getElementById('paqvilo-panel')
      .__paqModelActions.followup(window.firstResultId, { status: 'error', message: 'OLD_RESULT_MUST_NOT_REPLACE' }),
  );
  assert.equal(await page.getByText('OLD_RESULT_MUST_NOT_REPLACE', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
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
  await page.getByRole('button', { name: 'Run Find directory users', exact: true }).click();
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
  // The import reads the file asynchronously; its refusal is the signal that it has finished.
  await page.getByText('Use version 1 JSON with at most 50 commands.', { exact: true }).waitFor();
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
  // The saved command keeps its id, so its option exists before the import replaces it: wait for the import itself.
  await page.getByText('Imported 1 commands. Nothing was executed.', { exact: true }).waitFor();
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
  await page.getByText('Imported 1 commands. Nothing was executed.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => Boolean(window.importExecuted)), false);
  await page.getByRole('combobox', { name: 'Saved custom commands', exact: true }).selectOption('imported');
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await page.waitForFunction(() => window.importExecuted === true);
  await page.evaluate(() => document.getElementById('paqvilo-panel').__paqModelInspector.dispose());
  assert.equal(await page.locator('#paqvilo-panel').count(), 0);
  assert.deepEqual(errors, []);
});

test('Run sits on the action row, turns into Reset while its page change is in place, and the result stays under the row', async (t) => {
  const { page, update, errors } = await fixture(t);
  const actions = [
    ...update.actions,
    {
      id: 'form:show-logical-names',
      label: 'Logical names',
      group: 'Inspect',
      description: 'Show names.',
      inputs: [],
      undo: { id: 'form:clear-logical-names' },
    },
    {
      id: 'form:clear-logical-names',
      label: 'Clear logical names',
      group: 'Inspect',
      description: 'Remove labels added by this session.',
      inputs: [],
    },
    { id: 'form:record-id', label: 'Record ID', group: 'Inspect', description: 'Saved record GUID.', inputs: [] },
  ];
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    actions,
    availability: actions.map((action) => ({
      id: action.id,
      available: !['open', 'form:record-id'].includes(action.id),
      reason: action.id === 'form:record-id' ? 'Save the record first; this form has no saved record yet.' : 'No.',
    })),
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  // Unavailable actions are gathered in one collapsed group instead of mixing with what works on this page.
  assert.equal(await page.locator('.actions-unavailable > summary').isVisible(), true);
  assert.equal(await page.locator('.actions-unavailable > summary .n').textContent(), '2');
  assert.equal(await page.getByRole('button', { name: 'Run Record ID', exact: true }).isVisible(), false);
  // The undo of Logical names is its row's Reset, not a row of its own.
  assert.equal(await page.getByText('Clear logical names', { exact: true }).count(), 0);
  // The row is the panel's row: name and description in .main, Run and the icon buttons in .acts, on one line.
  const row = await page.locator('#paqvilo-panel').evaluate((host) => {
    const item = [...host.shadowRoot.querySelectorAll('.actions-item')].find((node) =>
      node.textContent.startsWith('Logical names'),
    );
    const top = (selector) => Math.round(item.querySelector(selector).getBoundingClientRect().top);
    return {
      classes: [...item.classList].includes('row'),
      main: item.querySelector('.main .name').textContent + ' | ' + item.querySelector('.main .sub').textContent,
      acts: [...item.querySelectorAll('.acts > button')].map(
        (node) => `${node.className}:${node.getAttribute('aria-label')}`,
      ),
      oneLine: Math.abs(top('.acts') - top('.main')) < 12,
    };
  });
  assert.deepEqual(row, {
    classes: true,
    main: 'Logical names | Show names.',
    acts: ['btn sec actions-run:Run Logical names', 'ib:Favorite Logical names', 'ib:Hide Logical names'],
    oneLine: true,
  });
  await page.getByRole('button', { name: 'Run Logical names', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.actions-item + .actions-inline .actions-result')
      .getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true })
      .count(),
    1,
    'the result appears under the action that produced it',
  );
  // No second name, description, result heading, card background or bare "Completed." line.
  assert.equal(await page.locator('.actions-inline h3').count(), 0);
  assert.equal(await page.getByText('Show names.', { exact: true }).count(), 1);
  assert.equal(await page.locator('.actions-status').textContent(), '');
  assert.equal(await page.locator('.actions-panel h2').count(), 0, 'the Actions tab names the view');
  assert.equal(
    await page.locator('.actions-inline').evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  const reset = page.getByRole('button', { name: 'Reset Logical names', exact: true });
  assert.equal(await reset.getAttribute('title'), 'Remove labels added by this session.');
  await reset.click();
  await page.waitForFunction(() => window.uiRequests.at(-1)?.action === 'form:clear-logical-names');
  await page.locator('.actions-status').getByText('Undone.', { exact: true }).waitFor();
  assert.equal(await page.locator('.actions-result').isVisible(), false, 'a successful Reset closes the result');
  assert.equal(
    await page.locator('#paqvilo-panel').evaluate((host) => host.shadowRoot.activeElement?.getAttribute('aria-label')),
    'Run Logical names',
    'Reset turns back into Run, which keeps the focus',
  );
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('paqvilo.modelActions.labels.v1')).recent),
    ['Logical names'],
    'a Reset is not a Recent choice',
  );
  // A result without a page change offers Close, which only hides it, and Run stays Run.
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
  assert.equal(await page.locator('.actions-result').isVisible(), false);
  assert.equal(await page.locator('.actions-status').textContent(), '');
  assert.equal(await page.getByRole('button', { name: 'Run Read values', exact: true }).count(), 1);
  await page.locator('.actions-unavailable > summary').click();
  assert.equal(await page.getByRole('button', { name: 'Run Record ID', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
});

test('Reset follows the page changes the runner reports, also ones made before the panel was drawn', async (t) => {
  const { page, update, errors } = await fixture(t);
  const actions = MODEL_DRIVEN_ACTIONS.filter((action) =>
    ['form:show-logical-names', 'form:clear-logical-names'].includes(action.id),
  );
  // The runner's session state, as a run left it: labels still on the form.
  await page.evaluate(() => {
    const host = document.getElementById('paqvilo-panel');
    host.__paqModelActionState = {
      token: 'invented-token',
      labels: ['label'],
      active: () => ({ 'form:show-logical-names': host.__paqModelActionState.labels.length > 0 }),
    };
  });
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    actions,
    availability: actions.map((action) => ({ id: action.id, available: true })),
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  // Clearing the labels empties the runner's list, as the runner does.
  await page.evaluate(() => {
    const run = window.__paqviloModelAction;
    window.__paqviloModelAction = (request) => {
      if (request.action === 'form:clear-logical-names')
        document.getElementById('paqvilo-panel').__paqModelActionState.labels = [];
      return run(request);
    };
  });
  await page.getByRole('button', { name: 'Reset Logical names', exact: true }).click();
  await page.waitForFunction(() => window.uiRequests.at(-1)?.action === 'form:clear-logical-names');
  await page.getByRole('button', { name: 'Run Logical names', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('the autosave guard runs with the guard on and resets with it off, without asking for the switch', async (t) => {
  const { page, update, errors } = await fixture(t);
  const guard = MODEL_DRIVEN_ACTIONS.find((action) => action.id === 'form:toggle-autosave');
  const actions = [...update.actions, guard];
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    actions,
    availability: actions.map((action) => ({ id: action.id, available: action.id !== 'open' })),
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Run Autosave guard', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.uiRequests.at(-1))).params, { enabled: true });
  assert.equal(await page.getByRole('checkbox').count(), 0, 'Run and Reset are the switch');
  const reset = page.getByRole('button', { name: 'Reset Autosave guard', exact: true });
  assert.equal(await reset.getAttribute('title'), 'Remove autosave guard');
  await reset.click();
  await page.locator('.actions-status').getByText('Undone.', { exact: true }).waitFor();
  const undo = await page.evaluate(() => window.uiRequests.at(-1));
  assert.equal(undo.action, 'form:toggle-autosave');
  assert.deepEqual(undo.params, { enabled: false });
  assert.equal(await page.locator('.actions-result').isVisible(), false);
  await page.getByRole('button', { name: 'Run Autosave guard', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('the side pane resets through its declared undo, which is not listed on its own', async (t) => {
  const { page, update, errors } = await fixture(t);
  const actions = [
    ...update.actions,
    ...MODEL_DRIVEN_ACTIONS.filter((action) =>
      ['navigation:pin-to-side-panel', 'navigation:close-side-panes'].includes(action.id),
    ),
  ];
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    actions,
    availability: actions.map((action) => ({ id: action.id, available: action.id !== 'open' })),
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  assert.equal(await page.getByText('Close pinned side panes', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Run Pin to side pane', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Reset Pin to side pane', exact: true }).click();
  await page.locator('.actions-status').getByText('Undone.', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.uiRequests.at(-1))).action, 'navigation:close-side-panes');
  assert.equal(await page.locator('.actions-result').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('hidden actions leave the list and come back from the Hidden filter, remembered like favorites', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  assert.equal(await page.locator('[data-filter=hidden]').isVisible(), false, 'no Hidden filter while none is hidden');
  const hide = page.getByRole('button', { name: 'Hide Read values', exact: true });
  assert.equal(await hide.getAttribute('title'), 'Hide this action from the list');
  await hide.click();
  assert.equal(await page.getByRole('button', { name: 'Run Read values', exact: true }).count(), 0);
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem('paqvilo.modelActions.labels.v1')).hidden),
    ['Read values'],
  );
  // A redrawn panel keeps the choice.
  await page.evaluate(() => document.getElementById('paqvilo-panel').__paqModelActions.dispose());
  await page.evaluate(modelDrivenActionsUi, update);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Run Read values', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Hidden 1', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Run Read values', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Show Read values', exact: true }).click();
  // With nothing hidden any more the list is All again, and the focus stays on the action's eye button.
  assert.equal(await page.locator('[data-filter=all]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-filter=hidden]').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Run Read values', exact: true }).count(), 1);
  assert.equal(
    await page.locator('#paqvilo-panel').evaluate((host) => host.shadowRoot.activeElement?.getAttribute('aria-label')),
    'Hide Read values',
  );
  assert.deepEqual(errors, []);
});

test('a result stays in the view that ran it and does not follow to Identity or Custom', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  const views = page.locator('#paqvilo-panel').getByRole('button', { name: 'Custom', exact: true });
  await views.click();
  assert.equal(
    await page.locator('.actions-result').isVisible(),
    false,
    'the Custom view does not show the Actions result',
  );
  assert.equal(await page.locator('.actions-status').isVisible(), false);
  await page.locator('.actions-tabs').getByRole('button', { name: 'Built-in', exact: true }).click();
  assert.equal(await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
});

test('a result scrolls fully into view in the panel and leaves the focus in a field the user is typing in', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.setViewportSize({ width: 1440, height: 600 });
  const ids = new Set(update.actions.map((action) => action.id)),
    actions = [...update.actions, ...MODEL_DRIVEN_ACTIONS.filter((action) => !ids.has(action.id))];
  await page.evaluate(modelDrivenActionsUi, {
    ...update,
    actions,
    availability: actions.map((action) => ({ id: action.id, available: true })),
  });
  // Results arrive when the test hands them over, as a slow app answers.
  await page.evaluate(() => {
    window.held = [];
    window.__paqviloModelAction = async (request) => {
      window.held.push(request);
      return { accepted: true, requestId: request.requestId };
    };
  });
  const answer = (index, result) =>
    page.evaluate(
      ([index, result]) =>
        document
          .getElementById('paqvilo-panel')
          .__paqModelActions.receive(window.held[index].requestId, { status: 'ok', ...result }),
      [index, result],
    );
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  // The last action of the list: its result opens at the bottom of the panel, and its result is taller than the panel.
  await page.getByRole('button', { name: 'Run Reset diagnostics', exact: true }).click();
  await page.waitForFunction(() => window.held.length === 1);
  await answer(0, {
    title: 'Invented result',
    message: Array.from({ length: 60 }, (_, index) => `Invented line ${index + 1}`).join('\n'),
  });
  await page.locator('.actions-result p').filter({ hasText: 'Invented line 60' }).waitFor();
  const placement = await page.evaluate(() => {
    const results = document.getElementById('paqvilo-panel').shadowRoot.querySelector('.actions-result');
    let box = results.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
      box = box.parentElement;
    const outer = box.getBoundingClientRect(),
      own = results.getBoundingClientRect();
    return {
      // The result starts at the top of the scrolled panel, so its message reads from the start.
      top: Math.abs(own.top - outer.top) < 1,
      focus: results.getRootNode().activeElement?.tagName,
      page: scrollY,
    };
  });
  assert.deepEqual(placement, { top: true, focus: 'SECTION', page: 0 }, 'the result shows from its start, focused');
  // A result that arrives while the user types in the search keeps the focus and the caret in the search.
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
  await page.getByRole('button', { name: 'Run Reset diagnostics', exact: true }).click();
  await page.waitForFunction(() => window.held.length === 2);
  const search = page.getByRole('searchbox', { name: 'Find actions', exact: true });
  await search.click();
  await page.keyboard.type('Rese');
  await answer(1, { title: 'Late result', message: 'Done.' });
  await page.locator('.actions-result').getByText('Done.', { exact: true }).waitFor();
  await page.keyboard.type('t');
  assert.equal(await search.inputValue(), 'Reset');
  assert.equal(
    await page.locator('#paqvilo-panel').evaluate((node) => node.shadowRoot.activeElement?.getAttribute('aria-label')),
    'Find actions',
  );
  assert.deepEqual(errors, []);
});

const active = (page) =>
  page.locator('#paqvilo-panel').evaluate((host) => {
    const node = host.shadowRoot.activeElement;
    return node ? node.getAttribute('aria-label') || node.textContent : null;
  });

// @test-kind contract: Paqvilo's own Actions panel design: redraws keep the focus, Close folds the card and Esc still reaches the panel.
test('opening inputs, starring and closing a result keep the focus in the panel, and Esc still folds the card', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  // The row toggle opens the inputs and keeps the focus on the redrawn toggle, so Esc reaches the panel.
  const toggle = page.locator('.actions-select[data-action=open-id]');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await toggle.evaluate((node) => node.getRootNode().activeElement === node), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.actions-inline').count(), 0);
  assert.equal(await active(page), 'Run Open by ID');
  // Starring redraws the list; the focus stays on the star.
  await page.getByRole('button', { name: 'Favorite Read values', exact: true }).click();
  assert.equal(await active(page), 'Favorite Read values');
  // Close is the kit icon button; it removes the result, folds the card (no empty card stays) and focuses Run.
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  const close = page.getByRole('button', { name: 'Close result', exact: true });
  assert.equal(await close.getAttribute('class'), 'ib');
  assert.equal(await close.textContent(), '', 'an icon, no text');
  await close.click();
  assert.equal(await page.locator('.actions-inline').count(), 0, 'no empty card remains');
  assert.equal(await active(page), 'Run Read values');
  assert.deepEqual(errors, []);
});

// @test-kind contract: Paqvilo's own Actions panel design: the page-change notice appears only when something was cleared.
test('a page change says that results and inputs were cleared only when there were some', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  const changed = () =>
    page.evaluate(() => document.getElementById('paqvilo-panel').__paqModelActions.contextChanged());
  const notice = 'The page changed, so results and action inputs were cleared.';
  // The first app context of the page clears nothing, and often arrives while the user is in the panel: an open card
  // without typed inputs stays open with the focus on its toggle.
  const toggle = page.locator('.actions-select[data-action=open-id]');
  await toggle.click();
  await changed();
  assert.equal(await page.locator('.actions-status').textContent(), '');
  assert.equal(await page.locator('.actions-inline').count(), 1, 'the open card stays');
  assert.equal(await toggle.evaluate((node) => node.getRootNode().activeElement === node), true);
  await page.getByRole('textbox', { name: 'Table logical name', exact: true }).fill('x_item');
  await changed();
  assert.equal(await page.getByText(notice, { exact: true }).count(), 1, 'typed inputs were cleared');
  assert.equal(await page.locator('.actions-inline').count(), 0, 'the card of the old page is closed');
  assert.equal(await active(page), 'Find actions', 'the focus stays in the panel');
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
  await changed();
  assert.equal(await page.locator('.actions-status').textContent(), '', 'a closed result is nothing to clear');
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).waitFor();
  await changed();
  assert.equal(await page.getByRole('cell', { name: 'PRIVATE_NATIVE_VALUE', exact: true }).count(), 0);
  assert.equal(await page.getByText(notice, { exact: true }).count(), 1, 'a shown result was cleared');
  assert.deepEqual(errors, []);
});

// @test-kind contract: Paqvilo's own Actions panel design: the kit's controls (segmented view switch, filled and outlined buttons, folding group headers), no glyph icons, a confirmed Delete.
test('views switch with the segmented control, groups fold, commands are kit buttons and Delete asks once in place', async (t) => {
  const { page, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  const classes = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.className));
  assert.equal(await page.locator('.actions-tabs').getAttribute('class'), 'seg actions-tabs');
  assert.deepEqual(await classes(page.locator('.actions-tabs > button')), ['on', '', '']);
  assert.deepEqual(await classes(page.locator('.actions-toolbar > button:not([hidden])')), ['f on', 'f', 'f']);
  // No unicode glyph stands in for an icon.
  assert.equal(
    await page.locator('.actions-panel .ib').evaluateAll((nodes) => nodes.every((node) => node.querySelector('svg'))),
    true,
  );
  // A group header folds its group, like the groups of Inspect, and stays folded across a redraw.
  const group = page.locator('details.actions-group', { has: page.locator('summary.gh', { hasText: /^Open/ }) });
  assert.equal(await group.getAttribute('open'), '');
  await group.locator('summary.gh').click();
  assert.equal(await group.getAttribute('open'), null);
  assert.equal(await page.getByRole('button', { name: 'Run Open by ID', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: 'Favorite Read values', exact: true }).click();
  assert.equal(await group.getAttribute('open'), null, 'a redraw keeps the group folded');
  // A search holds every group open; that is not the user unfolding it, so clearing the search folds it again.
  const find = page.getByPlaceholder('Find actions');
  await find.fill('e');
  assert.equal(await group.getAttribute('open'), '');
  await find.fill('');
  assert.equal(await group.getAttribute('open'), null, 'a search does not forget that the user folded the group');
  // Identity: its Run names the action and is the view's main (filled) button.
  await page.locator('.actions-tabs').getByRole('button', { name: 'Identity', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Run Find directory users', exact: true }).getAttribute('class'),
    'btn',
  );
  // Custom: "New command" in the chooser is the only way to start a new command.
  await page.locator('.actions-tabs').getByRole('button', { name: 'Custom', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'New', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Run command', exact: true }).getAttribute('class'), 'btn');
  assert.equal(await page.getByRole('button', { name: 'Save command', exact: true }).getAttribute('class'), 'btn sec');
  await page.getByRole('textbox', { name: 'Command label', exact: true }).fill('Invented command');
  await page.getByRole('textbox', { name: 'Command JavaScript', exact: true }).fill('return 1;');
  await page.getByRole('button', { name: 'Save command', exact: true }).click();
  const stored = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('paqvilo.modelActions.commands.v1')).commands.length);
  assert.equal(await stored(), 1);
  // The first click only asks; moving on keeps the command.
  await page.getByRole('button', { name: 'Delete command', exact: true }).click();
  assert.equal(await stored(), 1);
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).waitFor();
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Delete command', exact: true }).waitFor();
  assert.equal(await stored(), 1);
  await page.getByRole('button', { name: 'Delete command', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  assert.equal(await stored(), 0);
  await page.getByText('Invented command deleted.', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('combobox', { name: 'Saved custom commands', exact: true }).inputValue(),
    '',
    'the chooser is back on New command',
  );
  assert.deepEqual(errors, []);
});

// @test-kind contract: Paqvilo's own Actions panel keeps what the user folded or opened when a redraw comes before the browser's queued toggle event; the order is forced by redrawing in the task of the click.
test('a group folded or opened in the task of a redraw keeps that state', async (t) => {
  const { page, update, errors } = await fixture(t);
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  const group = (name) => page.locator('details.actions-group', { has: page.locator('summary.gh', { hasText: name }) });
  // The click changes the group at once and queues its toggle event; the availability update redraws before it.
  const clickThenRedraw = (name) =>
    group(name).evaluate((node, data) => {
      node.querySelector('summary').click();
      node.getRootNode().host.__paqModelActions.update(data);
      return node.isConnected;
    }, update);
  assert.equal(await group(/^Open/).getAttribute('open'), '');
  assert.equal(await clickThenRedraw(/^Open/), false, 'the update drew the group again');
  assert.equal(await group(/^Open/).getAttribute('open'), null, 'the folded group was opened by the redraw');
  assert.equal(await group(/^Not available here/).getAttribute('open'), null);
  await clickThenRedraw(/^Not available here/);
  assert.equal(
    await group(/^Not available here/).getAttribute('open'),
    '',
    'the opened group was folded by the redraw',
  );
  // Opening the folded group again is remembered the same way.
  await clickThenRedraw(/^Open/);
  assert.equal(await group(/^Open/).getAttribute('open'), '');
  assert.deepEqual(errors, []);
});

// @test-kind contract: Paqvilo's own Actions result design: compact first line, an empty table is only its message, empty saved values fold behind Show empty.
test('a result starts with its message and close icon, an empty table is only its message, and empty values fold away', async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => {
    window.nextResult = { status: 'ok', columns: ['Column', 'Label', 'Value'], rows: [], message: 'No choices.' };
    window.__paqviloModelAction = async (request) => {
      queueMicrotask(() =>
        document.getElementById('paqvilo-panel').__paqModelActions.receive(request.requestId, window.nextResult),
      );
      return { accepted: true, requestId: request.requestId };
    };
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  const result = page.locator('.actions-result');
  await result.getByText('No choices.', { exact: true }).waitFor();
  // One first line: the message and the close icon side by side, with no extra indent under the row.
  const line = await result.evaluate((node) => {
    const message = node.querySelector('.actions-head > p').getBoundingClientRect(),
      close = node.querySelector('.actions-head > .ib').getBoundingClientRect();
    return {
      sameLine: close.top < message.bottom && message.top < close.bottom,
      indent: getComputedStyle(node.closest('.actions-inline')).paddingLeft,
      lines: [...node.children].map((child) => child.className || child.tagName).join(),
    };
  });
  assert.deepEqual(line, { sameLine: true, indent: '8px', lines: 'actions-head' }, 'the result is one line');
  assert.equal(await result.locator('table').count(), 0);
  assert.equal(await page.getByRole('searchbox', { name: 'Filter results', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Copy result', exact: true }).count(), 0);
  // Saved record fields: rows without a value wait behind Show empty; names break after underscores.
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
  await page.evaluate(() => {
    window.nextResult = {
      status: 'ok',
      hideEmpty: true,
      columns: ['Column', 'Saved value', 'Formatted value'],
      rows: [
        ['_createdby_value', '[NULL]', ''],
        ['x_name', 'Invented name', ''],
      ],
      message: 'Values saved on the server.',
    };
  });
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await result.getByRole('cell', { name: 'x_name', exact: true }).waitFor();
  const visibleRows = () => result.locator('tbody tr:not([hidden])').count();
  assert.equal(await visibleRows(), 1);
  const show = page.getByRole('button', { name: 'Show empty 1', exact: true });
  assert.equal(await show.getAttribute('aria-pressed'), 'false');
  await show.click();
  assert.equal(await visibleRows(), 2);
  assert.equal(await result.locator('tbody tr').first().locator('td').first().locator('wbr').count(), 2);
  assert.equal(
    await result.locator('tbody tr').first().locator('td').first().textContent(),
    '_createdby_value',
    'the break points add no text',
  );
  assert.deepEqual(errors, []);
});

// @test-kind contract: Paqvilo's own Custom view design: kit inputs and one row of commands with Run first.
test('the Custom view keeps its commands on one row with Run first, and its inputs use the kit style', async (t) => {
  const { page, errors } = await fixture(t);
  await page.setViewportSize({ width: 500, height: 800 });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.locator('.actions-tabs').getByRole('button', { name: 'Custom', exact: true }).click();
  const buttons = await page
    .locator('form .actions-buttons > button')
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.textContent,
        node.getAttribute('aria-label'),
        Math.round(node.getBoundingClientRect().top),
      ]),
    );
  assert.deepEqual(
    buttons.map(([text, name]) => [text, name]),
    [
      ['Run', 'Run command'],
      ['Save', 'Save command'],
      ['Delete', 'Delete command'],
      ['Import', 'Import JSON'],
      ['Export', 'Export JSON'],
    ],
  );
  assert.equal(new Set(buttons.map(([, , top]) => top)).size, 1, 'one row');
  // The label box and the chooser share the kit's border and radius.
  const look = (role, name) =>
    page.getByRole(role, { name, exact: true }).evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.borderTopColor, style.borderRadius];
    });
  assert.deepEqual(await look('textbox', 'Command label'), await look('combobox', 'Saved custom commands'));
  assert.deepEqual(errors, []);
});

// @test-kind contract: Paqvilo's own Actions result design: a table result without a message puts the close icon in its filter row.
test('a table result without a message has no line holding only the close icon', async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => {
    window.__paqviloModelAction = async (request) => {
      queueMicrotask(() =>
        document.getElementById('paqvilo-panel').__paqModelActions.receive(request.requestId, {
          status: 'ok',
          columns: ['Property', 'Value'],
          rows: [['Client URL', location.origin]],
          message: '',
        }),
      );
      return { accepted: true, requestId: request.requestId };
    };
  });
  await page.getByRole('tab', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Run Read values', exact: true }).click();
  await page.getByRole('cell', { name: 'Client URL', exact: true }).waitFor();
  assert.equal(await page.locator('.actions-result .actions-head').count(), 0);
  assert.equal(
    await page.locator('.actions-result-tools').getByRole('button', { name: 'Close result', exact: true }).count(),
    1,
  );
  await page.getByRole('button', { name: 'Close result', exact: true }).click();
  assert.equal(await page.locator('.actions-inline').count(), 0);
  assert.deepEqual(errors, []);
});
