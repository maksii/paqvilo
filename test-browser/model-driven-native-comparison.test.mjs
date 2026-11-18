// @test-kind observation: a live Dataverse web resource read for native Diff answered with Content-Type text/jscript (fix18 live check); replayed on an invented loopback page.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { readModelDrivenNativeSource } from '../lense/model-driven-native-comparison.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions());
});
after(() => browser?.close());

test('native Diff reads a web resource served as text/jscript and still refuses a non-script response', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/WebResources/x_/legacy.js')
      return response.writeHead(200, { 'content-type': 'text/jscript' }).end('var invented = 1;');
    if (request.url === '/WebResources/x_/page.js')
      return response.writeHead(200, { 'content-type': 'text/html' }).end('<p>not a script</p>');
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Invented app</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  ownedFixture(t).add(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const page = await context.newPage();
  await page.goto(origin + '/main.aspx');
  const read = (path) => page.evaluate(readModelDrivenNativeSource, { origin, path, token: 'invented' });
  assert.deepEqual(await read('/WebResources/x_/legacy.js'), { ok: true, text: 'var invented = 1;', bytes: 17 });
  assert.equal((await read('/WebResources/x_/page.js')).error, 'The native response is not a script or stylesheet.');
});
