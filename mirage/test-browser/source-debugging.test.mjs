// @test-kind contract: Paqvilo's own source-map and CDP debugging surface for exported model-driven web resources
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sourceDebugFixture } from '../test/fixtures/source-debugging.mjs';
import { appsOrigin, sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser();

test('the model-driven script exposes its local source and an executable breakpoint through CDP', async (t) => {
  const page = await browser.page(t);
  const { runtime, root, resources, script } = await sourceDebugFixture(t);
  await page.goto(appsOrigin(runtime, runtime.url) + '/main.aspx');
  assert.equal(new URL(page.url()).origin, appsOrigin(runtime, runtime.url));
  const cdp = await page.context().newCDPSession(page);
  t.after(async () => {
    if (!page.isClosed()) await cdp.detach();
  });
  await cdp.send('Debugger.enable');
  const address = new URL(resources.find((item) => item.name === 'x_/debug.js').url, page.url()).href;
  const parsed = new Promise((resolve) =>
    cdp.on('Debugger.scriptParsed', (event) => {
      if (event.url === address) resolve(event);
    }),
  );
  await page.addScriptTag({ url: address });
  const event = await parsed;
  assert.match(event.sourceMapURL, /^data:application\/json;charset=utf-8;base64,/);
  const map = JSON.parse(Buffer.from(event.sourceMapURL.split(',')[1], 'base64').toString());
  assert.deepEqual(map.sources, [
    pathToFileURL(await fs.realpath(path.join(root, 'solution/WebResources/debug.js'))).href,
  ]);
  assert.deepEqual(map.sourcesContent, [script]);
  const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', { url: address, lineNumber: 1 });
  assert.equal(breakpoint.locations.length, 1);
  const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
  const result = page.evaluate(() => window.inventedDebugger());
  const stop = await paused;
  assert.equal(stop.callFrames[0].location.lineNumber, 1);
  await cdp.send('Debugger.resume');
  assert.equal(await result, 42);
});
