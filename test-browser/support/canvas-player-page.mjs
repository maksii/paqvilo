import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../../mirage/lib/browser-launch.mjs';
import { createCanvasHandler } from '../../mirage/lib/canvas-http.mjs';
import { createCanvasRuntime } from '../../mirage/lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../../mirage/lib/canvas-power-fx.mjs';
import { fixtureApp } from '../../mirage/test/canvas-runtime-fixture.mjs';
import { closeServer } from '../../mirage/test-browser/shared-browser.mjs';
import { ownedFixture } from '../../mirage/testing/owned-fixture.mjs';

export const control = (name, type, properties, children = []) => ({
  [name]: { Control: type, Properties: properties, ...(children.length ? { Children: children } : {}) },
});

// Serves one Canvas app on a loopback port and opens a browser context for it; the server and browser close with the test.
export async function canvasContext(t, app, contextOptions) {
  const runtime = createCanvasRuntime({ apps: () => [app], evaluator: createPowerFxEvaluator() });
  const handler = createCanvasHandler({
    apps: () => [app],
    runtime,
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    csrf: () => 'fixture-token',
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => closeServer(server));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext(contextOptions);
  return { context, runtime, server };
}

// Serves an invented app, opens its player in a new page at the given viewport and resolves once readyControl is shown.
export async function startCanvasPlayer(t, { files, viewport, readyControl }) {
  const app = await fixtureApp(files);
  const { context, server } = await canvasContext(t, app, viewport && { viewport });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/_apps/canvas/${app.uniqueName}`);
  await page.getByTestId('canvas-start').click();
  await page.locator(`[data-control="${readyControl}"]`).waitFor();
  return { app, page };
}
