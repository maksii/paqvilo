// @test-kind contract: a gesture starts an activity linked to the page load
// Canvas player gesture tracing in a real browser (docs/design/tracing.md): each action a click starts is the root of a
// new trace, linked by parent-request to the GET /_apps/canvas/<app> page load; the page load's trace gains no span.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { canvasPlayerFixture } from '../mirage/test/canvas-player-fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

test('each action a click starts is a new trace linked to the page load; the page load gains no span', async (t) => {
  const sim = await canvasPlayerFixture(t, 'directory');
  // The fixture leaves tracing off; the trace store takes the summary level at run time, as mirage.trace would set it.
  sim.trace.configure({ level: 'summary' });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signInContext(context, sim, 'alex');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const app = 'invented';
  const definition = page.waitForResponse(
    (response) => response.url().endsWith(`/_apps/canvas/api/${app}`) && response.request().method() === 'GET',
  );
  // goto answers with the final response, after the sign-in redirect to the apps origin.
  const loaded = await page.goto(`${sim.url}/_apps/canvas/${app}`);
  assert.equal(loaded.status(), 200);
  await definition;
  const pageTrace = loaded.headers()['x-trace-id'],
    pageSpan = loaded.headers()['x-sim-span-id'];
  assert.ok(pageTrace && pageSpan, 'the player page names its root');
  const pageSpans = () => sim.trace.spans({ traceId: pageTrace, pageSize: 200 }).total;
  const before = pageSpans();
  // A click's action answers with its root span; the click's answer is waited on, not slept for.
  const click = async (locator) => {
    const answer = page.waitForResponse(
      (response) => response.url().endsWith(`/_apps/api/canvas/${app}`) && response.request().method() === 'POST',
    );
    await locator.click();
    return (await answer).headers();
  };
  const traces = [];
  const check = (headers) => {
    const root = sim.trace.span(headers['x-sim-span-id']);
    assert.notEqual(headers['x-trace-id'], pageTrace, 'the click starts an activity of its own');
    assert.equal(root.traceId, headers['x-trace-id']);
    assert.equal(root.parentSpanId, null);
    assert.ok(root.name.startsWith('POST '), root.name);
    assert.deepEqual(
      root.links.filter((link) => link.relation === 'parent-request'),
      [{ traceId: pageTrace, spanId: pageSpan, relation: 'parent-request' }],
    );
    traces.push(headers['x-trace-id']);
  };
  await page.getByTestId('canvas-resolution').selectOption('390x844');
  check(await click(page.getByTestId('canvas-start')));
  const openItem = page.locator('[data-item-index="0"] [data-control="OpenItem"]');
  await openItem.waitFor();
  check(await click(openItem));
  const returnButton = page.locator('[data-control="Return"]');
  await returnButton.waitFor();
  check(await click(returnButton));
  assert.equal(new Set(traces).size, 3, 'each click is a trace of its own');
  assert.equal(pageSpans(), before, 'the page load trace gained no span from the clicks');
  assert.deepEqual(errors, []);
});
