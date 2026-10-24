import { agentBrowserFixture } from './support/agent-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscovery } from '../lense/commands/agent.mjs';

test(
  'agent diagnostics distinguish documents and capture initial popup navigation across origin changes',
  { timeout: 60_000 },
  async (t) => {
    const { serve, launch } = agentBrowserFixture(t, 'pp-agent-lifecycle-');
    const external = await serve((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<title>External fixture</title><script>console.error("foreign-secret")</script>'),
    );
    const origin = await serve((request, response) => {
      if (request.url === '/redirect') return response.writeHead(302, { location: external }).end();
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><title>Lifecycle fixture</title><body><div id="paqvilo-panel">Panel fixture</div><h1>${request.url}</h1>${request.url === '/broken' ? '<script>console.error("first-document-error")</script>' : ''}`,
        );
    });
    const { context, page, agent } = await launch(origin);
    const discovery = await readDiscovery(agent.discoveryFile);
    assert.equal(discovery.endpoint, agent.endpoint);
    const call = async (route, body) => {
      const response = await fetch(agent.endpoint + route, {
        redirect: 'error',
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${discovery.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    await page.goto(origin + '/broken');
    const broken = await call('/v1/pages/1/state');
    assert.ok(broken.runtime.events.some((event) => event.text === 'first-document-error'));
    await page.goto(origin + '/clean');
    const clean = await call('/v1/pages/1/state');
    const selected = await call('/v1/pages/1/dom', { selector: '#paqvilo-panel, h1', limit: 1 });
    assert.deepEqual(
      selected.elements.map((element) => element.tag),
      ['h1'],
      'panel matches cannot consume the requested element limit',
    );
    assert.equal(selected.total, 1);
    assert.equal(selected.truncated, false);
    const body = await call('/v1/pages/1/dom', { selector: 'body' });
    assert.equal(
      body.elements[0].text.includes('Panel fixture'),
      false,
      'ancestor text also excludes the developer panel',
    );
    assert.ok(
      (await call('/v1/events?limit=500')).events.some((event) => event.text === 'first-document-error'),
      'session history retains the earlier error',
    );
    const popupEvent = context.waitForEvent('page');
    await page.evaluate((url) => window.open(url), origin + '/popup');
    const popup = await popupEvent;
    await popup.waitForLoadState('load');
    let history = await call('/v1/events?limit=500');
    const firstRequest = history.events.find((event) => event.type === 'request' && event.url === origin + '/popup');
    assert.ok(firstRequest, 'popup initial navigation request must be captured');
    assert.equal(firstRequest.unattributed, true);
    assert.equal(firstRequest.pageId, undefined, 'frameless popup requests must not be assigned to a guessed page');
    assert.ok(
      history.events.some(
        (event) => event.type === 'response' && event.requestId === firstRequest.requestId && event.status === 200,
      ),
    );
    assert.equal(
      (await call('/v1/pages')).pages.find((entry) => entry.id === '2').reloadAllowed,
      false,
      'initial frameless navigation cannot establish reload provenance',
    );
    await popup.goto(origin + '/popup-second');
    assert.equal((await call('/v1/pages')).pages.find((entry) => entry.id === '2').reloadAllowed, true);
    await popup.goto(origin + '/redirect');
    assert.equal((await call('/v1/pages')).pages.length, 1);
    await popup.goto(origin + '/returned');
    assert.deepEqual(
      (await call('/v1/pages')).pages.map((entry) => entry.id),
      ['1', '2'],
    );
    history = await call('/v1/events?limit=500');
    assert.equal(JSON.stringify(history).includes('foreign-secret'), false);
    await popup.close();
    assert.equal((await call('/v1/pages')).pages.length, 1);
    assert.equal(popup.listenerCount('console'), 0);
    assert.equal(
      clean.runtime.events.some((event) => event.text === 'first-document-error'),
      false,
      'current state must not report an old document error',
    );
  },
);
