// @test-kind contract: on a portal that serves an earlier version of a template than the checkout holds, the panel says which file is served in another version and which Git ref holds that version, X-ray names what the page has and the file does not, and comparing with that ref lays the checkout over the deployed page
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { overlayPanel } from './helpers/overlay-panel.mjs';
import { createFixture } from '../test/fixture.mjs';

const BANNER = 'web-templates/banner/Banner.webtemplate.source.html';
const DEPLOYED = [
  '<section class="banner" id="banner">',
  '  <a class="skip" id="skip" href="#main">Skip to content</a>',
  '  <h2 class="banner-title" id="banner-title">Invented spring sale</h2>',
  '  <p class="banner-text" id="banner-text">Until the end of the month</p>',
  '</section>',
  '',
].join('\n');
const AHEAD = [
  '<section class="banner" id="banner">',
  '  <h2 class="banner-title" id="banner-title">Invented summer sale</h2>',
  '  <p class="banner-text" id="banner-text">Until the end of the month</p>',
  '  <a class="banner-more" id="more" href="/sale/">See the offers</a>',
  '</section>',
  '',
].join('\n');
// The portal's answer: the deployed template in the page shell the portal adds around it.
const served = [
  '<!DOCTYPE html>',
  '<html lang="en-US"><head><title>Home</title></head><body>',
  '<div id="shell" class="shell-bar"></div>',
  DEPLOYED,
  '</body></html>',
  '',
].join('\n');

test('a checkout ahead of the portal is told in the panel and in X-ray, and comparing with the deployed ref lays it over the page', async (t) => {
  const fx = createFixture();
  fx.write(
    'web-templates/banner/Banner.webtemplate.yml',
    'adx_name: Banner\nadx_webtemplateid: 00000000-0000-0000-0000-00000000bb01\n',
  );
  fx.write(BANNER, DEPLOYED);
  fx.commit();
  fx.git('branch', 'deployed');
  fx.write(BANNER, AHEAD);
  fx.commit();
  const server = http.createServer((request, response) => {
    if (new URL(request.url, 'http://fixture.invalid').pathname === '/favicon.ico')
      return response.writeHead(204).end();
    return response.writeHead(200, { 'content-type': 'text/html' }).end(served);
  });
  const { origin, session, page, panel, errors } = await overlayPanel(t, fx, () => listenOwnedServer(t, server));

  await page.goto(origin + '/', { waitUntil: 'load' });
  // Nothing differs from the baseline (HEAD): the page is the portal's, with the deployed version of the template.
  assert.equal(await page.locator('#banner-title').innerText(), 'Invented spring sale');
  assert.equal(await page.locator('#skip').count(), 1);
  const found = await session.served.settled();
  assert.deepEqual(
    found.files.map((file) => [file.rel, file.state, file.places]),
    [[BANNER, 'differs', 3]],
  );
  assert.deepEqual(
    found.search.refs.map((ref) => ref.name),
    ['deployed'],
  );

  // The panel says so on the page, with the ref that holds what is served.
  await panel.draw(page);
  await page.locator('#paqvilo-panel .pill').click();
  const compare = page.locator('#paqvilo-panel [data-act=baseline]');
  await compare.waitFor();
  assert.equal(await compare.innerText(), 'Compare with deployed');
  const body = await page.locator('#paqvilo-panel .body').innerText();
  assert.match(body, /1 file is served in another version than your baseline HEAD [0-9a-f]{7} holds/);
  assert.match(body, /Served in another version than the baseline/);
  assert.match(body, /Line 1 · only in the served page/);
  assert.match(body, /served: <a class="skip" id="skip" href="#main">Skip to content<\/a>/);
  assert.match(body, /Line 2 · differs/);
  assert.match(body, /Line 4 · only in your file/);
  assert.match(body, /yours: <a class="banner-more" id="more" href="\/sale\/">See the offers<\/a>/);

  // X-ray: a tag both versions hold is the file's line; the tag only the served page has is said to be that.
  await page.waitForFunction(() => typeof globalThis.__paqviloXrayUi?.identify === 'function');
  await page.waitForFunction(
    () =>
      globalThis.__paqviloXrayUi.identify(document.getElementById('banner-title')).evidence.source.status === 'exact',
  );
  const answers = await page.evaluate(() => {
    const answer = (id) => {
      const evidence = globalThis.__paqviloXrayUi.identify(document.getElementById(id)).evidence;
      return evidence.source.refs.map((ref) => ({
        file: ref.ref.replaceAll('\\', '/'),
        status: ref.status,
        how: ref.evidenceLabel,
        served: ref.servedVersion ?? null,
      }));
    };
    return { title: answer('banner-title'), skip: answer('skip') };
  });
  assert.deepEqual(answers.title, [
    { file: BANNER, status: 'exact', how: 'Found at this place in the served page', served: 'differs' },
  ]);
  assert.deepEqual(answers.skip, [
    {
      file: BANNER,
      status: 'candidate',
      how: 'Not in your local copy of this file: the deployed version differs here',
      served: 'differs',
    },
  ]);

  // Comparing with the ref lays the whole checkout over what is deployed, as a restart with --baseline would.
  await Promise.all([page.waitForEvent('load'), compare.click()]);
  await page.waitForFunction(() => document.getElementById('banner-title')?.textContent === 'Invented summer sale');
  assert.equal(await page.locator('#skip').count(), 0);
  assert.equal(await page.locator('#more').innerText(), 'See the offers');
  // The full name: a tag called the same would otherwise be what Git resolves.
  assert.equal(session.baseline.spec, 'refs/heads/deployed');
  assert.equal(session.served.snapshot().files.length, 0);
  assert.deepEqual(errors, []);
});
