import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createCanvasHandler } from '../mirage/lib/canvas-http.mjs';
import { readCanvasSource } from '../mirage/lib/canvas-source.mjs';
import { writeSolutionAssetEntries } from '../mirage/lib/dataverse-solution-assets.mjs';

test(
  'SVG app images render while direct navigation stays sandboxed without scripts or external requests',
  { timeout: 60000 },
  async (t) => {
    const source = await readCanvasSource({
      name: 'Svg',
      msapp: writeSolutionAssetEntries([
        { name: 'Src/Home.pa.yaml', data: Buffer.from('Screens:\n  Home: {}\n') },
        {
          name: 'Assets/Images/Logo.svg',
          data: Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/><script>window.injected=true;fetch("/danger")</script><image href="/danger"/></svg>',
          ),
        },
      ]),
    });
    const handler = createCanvasHandler({ apps: () => [{ uniqueName: 'svg', source }] });
    let requests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/danger') {
        requests++;
        res.writeHead(200).end();
      } else if (req.url === '/')
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<img id="logo" src="/_apps/canvas/svg/assets/Images%2FLogo.svg">');
      else if (!handler(req, res)) res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#logo').complete);
    assert.equal(await page.locator('#logo').evaluate((element) => element.naturalWidth), 20);
    const response = await page.goto(url + '/_apps/canvas/svg/assets/Images%2FLogo.svg');
    assert.match(response.headers()['content-security-policy'], /^sandbox;/);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(requests, 0);
  },
);
