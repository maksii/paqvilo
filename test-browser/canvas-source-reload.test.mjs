import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { signInContext } from '../mirage/testing.mjs';
import { canvasPlayerFixture } from '../mirage/test/canvas-player-fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

test(
  'a watched source save updates the same runtime and requires explicit startup for its new revision',
  { timeout: 60000 },
  async (t) => {
    const sim = await canvasPlayerFixture(t, 'directory', { watch: true });
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    ownedFixture(t).add(() => browser.close());
    const context = await browser.newContext();
    await signInContext(context, sim, 'alex');
    const page = await context.newPage();
    let starts = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        request.url().endsWith('/_apps/api/canvas/invented') &&
        request.postDataJSON()?.action === 'start'
      )
        starts++;
    });
    await page.goto(sim.url + '/_apps/canvas/invented');
    await page.getByTestId('canvas-start').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-control="Greeting"]')?.textContent.startsWith('Hello'),
    );
    const first = await (await context.request.get(sim.url + '/_apps/canvas/api/invented?revision=1')).json();
    const file = path.join(sim.fixtureRoot, 'apps/invented/Src/App.pa.yaml');
    const old = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, old.replace('Hello', 'Reloaded'));
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-status"]')?.textContent.toLowerCase().includes('source updated'),
    );
    const next = await (await context.request.get(sim.url + '/_apps/canvas/api/invented?revision=1')).json();
    assert.notEqual(next.revision, first.revision);
    assert.equal((await (await context.request.get(sim.url + '/_apps/api/canvas/invented')).json()).started, false);
    assert.equal(starts, 1);
    await page.getByTestId('canvas-start').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-control="Greeting"]')?.textContent.startsWith('Reloaded'),
    );
    assert.equal(starts, 2);
  },
);
