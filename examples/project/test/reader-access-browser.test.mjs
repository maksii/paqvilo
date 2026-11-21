// @test-kind contract: the example's account workspaces hide write controls from a reader and keep the note form working for an editor
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openDemo, project } from './demo-browser.mjs';
import { sdkMessages } from '../pack/dataverse-plugins.mjs';
import { signInContext } from 'paqvilo/mirage/testing/session.mjs';

const ACCOUNT = 'a4300000-0000-4000-8000-000000001001';
const EDITOR = 'a4300000-0000-4000-8000-000000002001';
const READER = 'a4300000-0000-4000-8000-000000002002';
const WRITE_ACTIONS = ['Add note', 'Save account', 'New contact', 'Edit account', 'Delete', 'Deactivate account'];

/** Visible, enabled buttons and fields of the workspace, by label. */
function enabledControls(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-demo-workspace] button, [data-demo-workspace] [data-related] input')]
      .filter((node) => node.offsetParent && !node.disabled)
      .map((node) => node.textContent.trim() || node.name),
  );
}

test('a reader sees no write controls on the Web API and PCF account pages; an editor adds a PCF note', async (t) => {
  const source = await fs.readFile(
    path.join(project, 'portal/web-pages/pcf-account/PCF-account.webpage.copy.html'),
    'utf8',
  );
  const component = /codecomponent name:([0-9a-f-]{36})/i.exec(source)[1];
  const { sim, browser, context } = await openDemo(t, {
    observed: {
      sdkMessages,
      codeComponents: { [component]: 'exa_ExamplePages.ExampleAccountFields' },
      evidence: 'Sample component tag and manifest',
    },
  });
  const open = async (page, approach) => {
    await page.goto(`${sim.url}/approach/${approach}/account/?id=${ACCOUNT}`);
    await page.locator('[data-account-form][data-ready=true]').waitFor({ state: 'attached' });
  };
  await signInContext(context, sim, READER);
  const reader = await context.newPage();
  for (const approach of ['web-api', 'pcf']) {
    await open(reader, approach);
    assert.equal(await reader.locator('form[data-note-form]').count(), 1, `${approach} note form is a form`);
    assert.equal(await reader.locator('form[data-note-form]').isHidden(), true, `${approach} hides the note form`);
    const enabled = await enabledControls(reader);
    assert.deepEqual(
      enabled.filter((label) => WRITE_ACTIONS.includes(label) || ['subject', 'attachment'].includes(label)),
      [],
      `${approach} reader write controls`,
    );
  }

  const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  t.after(() => editorContext.close());
  await signInContext(editorContext, sim, EDITOR);
  const editor = await editorContext.newPage();
  await open(editor, 'pcf');
  const form = editor.locator('form[data-note-form]');
  await form.locator('[name=subject]').fill('PCF reader-access note');
  await form.locator('textarea[name=notetext]').fill('Added from the PCF workspace');
  const created = editor.waitForResponse(
    (response) => response.request().method() === 'POST' && /\/_api\/annotations$/.test(response.url()),
  );
  await form.getByRole('button', { name: 'Add note' }).click();
  assert.equal((await created).status(), 204, 'the click sends the create request');
  await editor.locator('[data-status]', { hasText: 'Note saved.' }).waitFor();
  await editor.locator('[data-note-list]', { hasText: 'PCF reader-access note' }).waitFor();
});
