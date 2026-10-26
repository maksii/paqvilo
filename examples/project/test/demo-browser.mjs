import { ownedFixture } from 'paqvilo/mirage/testing/owned-fixture.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createSimulator } from 'paqvilo/mirage/server.mjs';

export const project = fileURLToPath(new URL('../', import.meta.url));

/** The example site on loopback with the demo preset, plus a desktop browser context owned by the test. */
export async function openDemo(t, options = {}) {
  const sim = await createSimulator({
    sourceDir: path.join(project, 'portal'),
    solutionRoots: ['metadata', 'code-solution', 'solution'].map((name) => path.join(project, name)),
    solutionOrder: 'explicit',
    dataPacks: [{ module: path.join(project, 'pack/pack.mjs') }],
    port: 0,
    watch: false,
    ...options,
  });
  // Registration order is close order: the browser and its connections go before the simulator.
  let browser;
  ownedFixture(t).add(() => browser?.close());
  ownedFixture(t).add(() => sim.close());
  await sim.applyPreset('example-demo');
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15_000);
  return { sim, browser, context };
}
