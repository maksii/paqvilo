import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { canvasPlayerFixture } from '../mirage/test/canvas-player-fixture.mjs';

for (const format of ['directory', 'archive']) {
  test(`canvas player runs configured ${format} source in the simulator`, async (t) => {
    const sim = await canvasPlayerFixture(t, format);
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await signInContext(context, sim, 'alex');
    const page = await context.newPage();
    const app = format === 'archive' ? 'Invented' : 'invented';
    const ready = Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith(`/_apps/api/canvas/${app}`) && response.request().method() === 'GET',
      ),
      page.waitForResponse(
        (response) => response.url().endsWith(`/_apps/canvas/api/${app}`) && response.request().method() === 'GET',
      ),
    ]);
    await page.goto(`${sim.url}/_apps/canvas/${app}`);
    await ready;
    const action = async (fn) => {
      const response = page.waitForResponse(
        (r) => r.url().endsWith(`/_apps/api/canvas/${app}`) && r.request().method() === 'POST',
      );
      await fn();
      assert.equal((await response).ok(), true);
    };
    await page.getByTestId('canvas-resolution').selectOption('390x844');
    await action(() => page.getByTestId('canvas-start').click());
    const stage = page.getByTestId('canvas-stage');
    await stage.waitFor();
    const control = (name) => page.locator(`[data-control="${name}"]`);
    await control('SearchBox').fill('Al');
    await action(() => control('SearchBox').press('Tab'));
    await page.waitForFunction(() =>
      document.querySelector('[data-control="Greeting"]')?.textContent.includes('Hello Al'),
    );
    assert.match(await control('List').innerText(), /Alpha/);
    assert.doesNotMatch(await control('List').innerText(), /Beta/);
    await action(() => control('Check').check());
    assert.equal(await control('Check').isChecked(), true);
    await action(() => control('Switch').check());
    assert.equal(await control('Switch').isChecked(), true);
    assert.equal(await control('Choice').locator('option').count(), 2);
    await action(() => control('Choice').selectOption({ index: 1 }));
    await action(() => page.locator('[data-item-index="0"] [data-control="OpenItem"]').click());
    await control('Return').waitFor();
    assert.equal(await control('Detail').innerText(), 'Alpha');
    await action(() => control('Return').click());
    await control('SearchBox').waitFor();
    assert.equal(await control('SearchBox').inputValue(), 'Al');
    assert.equal(await control('Check').isChecked(), true);
    assert.equal(await control('Switch').isChecked(), true);
    assert.equal(await control('VisitStatus').innerText(), 'visited');
    assert.equal(await control('Hidden').count(), 0);
    assert.equal(await control('Disabled').isDisabled(), true);
    const inventory = await (await context.request.get(sim.url + '/_apps/canvas/api/' + app)).json();
    assert.deepEqual(inventory.diagnostics, []);
    const report = await sim.preflight({ strict: true });
    assert.ok(
      report.requirements.some(
        (row) => row.id.toLowerCase() === `canvas:app/${app}`.toLowerCase() && row.status === 'satisfied',
      ),
      JSON.stringify(report.requirements),
    );
    assert.ok(report.requirements.some((row) => row.id === 'canvas:rendering' && row.status === 'satisfied'));
    const state = await (await context.request.get(sim.url + '/_apps/api/canvas/' + app)).json();
    assert.deepEqual(state.errors, []);
    assert.equal(state.variables.initialWidth, 390, 'OnStart uses the selected mobile resolution');
    assert.equal(await page.evaluate(() => window.canvasInjected), undefined);
    assert.equal(await stage.locator('img').count(), 0);
    for (const [width, height] of [
      [1366, 768],
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await action(() => page.getByTestId('canvas-resolution').selectOption(`${width}x${height}`));
      await page.waitForFunction(
        (expected) => document.querySelector('[data-control="UnsafeText"]')?.style.left === `${expected - 220}px`,
        width,
      );
      const rect = await control('UnsafeText').boundingBox();
      const stageRect = await stage.boundingBox();
      assert.ok(rect && stageRect);
      assert.equal(Math.round(rect.x - stageRect.x), width - 220);
      assert.equal(Math.round(stageRect.width), width);
      const stack = await control('Stack').boundingBox();
      const first = await control('First').boundingBox();
      const second = await control('Second').boundingBox();
      const left = await control('Left').boundingBox();
      const right = await control('Right').boundingBox();
      assert.equal(Math.round(stack.width), width / 2);
      assert.equal(Math.round(first.width), Math.round(width / 4));
      assert.ok(second.y > first.y);
      assert.ok(right.x > left.x);
    }
    if (format === 'directory') {
      const evidence = path.resolve('.paqvilo/canvas-baseline');
      await fs.mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, 'player-mobile.png'), fullPage: true });
    }
  });
}
test('player reports source gaps and serializes actions, including a refused action snapshot', async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory', { gaps: true });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const context = await browser.newContext();
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  await page.goto(`${sim.url}/_apps/canvas/invented`);
  await page.getByTestId('canvas-start').click();
  await page.locator('[data-control="Next"]').waitFor();
  const inventory = await (await context.request.get(sim.url + '/_apps/canvas/api/invented')).json();
  assert.ok(inventory.diagnostics.some((d) => d.code === 'CANVAS_SOURCE_YAML_INVALID'));
  assert.match(await page.getByTestId('canvas-inspector').textContent(), /Unsupported|PieChart/i);
  const report = await sim.preflight();
  assert.ok(report.requirements.some((row) => row.id === 'canvas:rendering' && row.status === 'unsupported'));

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let firstSeen;
  const seen = new Promise((resolve) => {
    firstSeen = resolve;
  });
  const received = [];
  await page.route('**/_apps/api/canvas/invented', async (route) => {
    const payload = route.request().postDataJSON();
    received.push(payload);
    if (received.length === 1) {
      firstSeen();
      await gate;
      const response = await route.fetch();
      const body = await response.json();
      body.snapshot.variables.refusedMarker = 'shown after refusal';
      body.errors = [{ message: 'Invented refusal' }];
      await route.fulfill({ response, status: 403, json: body });
    } else await route.continue();
  });
  await page.evaluate(() => {
    const check = document.querySelector('[data-control="Check"]');
    const toggle = document.querySelector('[data-control="Switch"]');
    check.checked = true;
    check.dispatchEvent(new Event('change', { bubbles: true }));
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await seen;
  assert.equal(received.length, 1);
  const second = page.waitForResponse(
    (r) => r.url().endsWith('/_apps/api/canvas/invented') && r.request().postDataJSON()?.control === 'Switch',
  );
  release();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('shown after refusal'),
  );
  await second;
  assert.deepEqual(
    received.map((a) => a.control),
    ['Check', 'Switch'],
  );
});
