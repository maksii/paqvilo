// @test-kind observation: two native Canvas draft captures recorded in fixtures/canvas-draft-input-native.json (2026-11-08, fixture sha256 53da0137...); the operation sequence and invented source are typed in this test and the probe is code, so it is not a replay case
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSimulator } from '../api.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { canvasLocalIdentity } from '../test/canvas-player-fixture.mjs';
import { canvasDraftInputFiles, canvasDraftInputFixture } from '../test/fixtures/canvas-draft-input.mjs';
import { captureCanvasDraftInputContract } from '../testing/canvas-contract.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const bytes = await fs.readFile(new URL('../test/fixtures/canvas-draft-input-native.json', import.meta.url));

const evidence = JSON.parse(bytes);

const browser = sharedBrowser();

test.before(async () => {
  assert.equal(hash(bytes), '53da0137b56a0e32e4c224d8124719991cd1f984d1d1d9a6d7aab3cd9d489fbc');
  assert.equal(hash(captureCanvasDraftInputContract.toString()), evidence.probeFunctionSha256);
  assert.equal(
    hash(await fs.readFile(new URL('../test/fixtures/canvas-draft-input.mjs', import.meta.url))),
    'ebc17e797293adfcf514035194a2685a3af10979aa0a32e0890594554811d10b',
    'invented source preserves the native form data source, omitted Item and nested custom input topology',
  );
  assert.deepEqual(canvasDraftInputFixture, evidence.fixture);
});

test('draft text, cancel confirmation, retained edits and reopen reset match the native Canvas player', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-input-')));
  const cleanup = ownedFixture(t);
  cleanup.remove(() => removeFixtureDirectory(root));
  const write = async (file, body) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  };
  await write(
    'portal/website.yml',
    'adx_websiteid: 77777777-7777-4777-8777-777777777777\nadx_name: Invented\nadx_enhancedauthorization: 1\n',
  );
  await write('portal/web-pages/home/Home.webpage.yml', 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n');
  for (const [file, body] of Object.entries(canvasDraftInputFiles)) await write('apps/invented/' + file, body);
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    projectRoot: root,
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
    canvas: { sources: ['apps/invented'] },
    initial: {
      ...canvasLocalIdentity(),
      mappings: {
        ...canvasLocalIdentity().mappings,
        fx_draft: { entitySet: 'fx_drafts', idColumn: 'fx_draftid', nameColumn: 'fx_name' },
      },
      tables: { ...canvasLocalIdentity().tables, fx_draft: [] },
    },
  });
  cleanup.add(() => sim.close());
  const page = await browser.page(t);
  await signInContext(page.context(), sim, 'alex');
  await page.goto(sim.url + '/_apps/canvas/invented');
  const target = sim.url + '/_apps/api/canvas/invented';
  const action = async (run) => {
    const rendered = page.getByTestId('canvas-stage').locator(':scope > *').first();
    const before = (await rendered.count()) ? await rendered.elementHandle() : null;
    const pending = page.waitForResponse((r) => r.url() === target && r.request().method() === 'POST');
    await run();
    const response = await pending;
    assert.equal(response.status(), 200, await response.text());
    const body = await response.json();
    assert.deepEqual(body.errors ?? body.snapshot?.errors ?? [], []);
    if (before) await page.waitForFunction((node) => !node.isConnected, before);
    await page.waitForFunction(
      (screen) => document.querySelector('[data-testid="canvas-status"]')?.textContent === `Current screen: ${screen}`,
      body.snapshot.currentScreen,
    );
  };
  await action(() => page.getByTestId('canvas-start').click());
  const control = (name) => page.locator(`[data-control="${name}"]`);
  const field = (key) => control(key === 'single' ? 'SingleInput' : 'MultiInput');
  const rows = await captureCanvasDraftInputContract(
    {
      open: async () => {
        await action(() => control('OpenDraft').click());
        await field('single').waitFor();
      },
      read: (key) => field(key).inputValue(),
      maxLength: (key) => field(key).evaluate((node) => node.maxLength),
      write: async (key, value) => {
        await field(key).fill(value);
        await action(() => field(key).press('Tab'));
      },
      cancel: () => action(() => control('CancelDraft').click()),
      confirmationVisible: () => control('ConfirmLabel').isVisible(),
      keepEditing: async () => {
        await action(() => control('KeepDraft').click());
        assert.equal(
          await field('single').inputValue(),
          evidence.fixture.single,
          'native No/Back retains the single-line draft',
        );
        assert.equal(
          await field('multi').inputValue(),
          evidence.fixture.multi,
          'native No/Back retains the multiline draft',
        );
      },
      discard: () => action(() => control('DiscardDraft').click()),
    },
    canvasDraftInputFixture,
  );
  assert.deepEqual(rows, evidence.rows);
  await control('OpenDraft').waitFor();
});
