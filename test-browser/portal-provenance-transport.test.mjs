import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { createPortalProvenanceTransport } from '../lense/portal-provenance-transport.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { xrayUi } from '../lense/xray-ui.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }));
});
after(() => browser?.close());
const scope = {
  documentId: 'invented-document',
  frameId: 'invented-frame',
  uiEpoch: 1,
  sourceRevision: 'invented-current',
};
async function fixture(t, { mirage = false, delayDescriptor = false } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-proof-ui-'));
  const metadataFile = path.join(directory, 'Main.webtemplate.yml');
  await fs.writeFile(metadataFile, 'adx_webtemplateid: invented-main\nadx_name: Main');
  await fs.writeFile(
    path.join(directory, 'Main.webtemplate.source.html'),
    '<!doctype html><html><body><button id="original">Invented</button></body></html>',
  );
  const renderer = createPortalRenderer({
    sourceDir: directory,
    website: {},
    templates: {
      Main: {
        id: 'invented-main',
        name: 'Main',
        metadata: { id: 'invented-main', kind: 'webtemplate', name: 'Main', _file: metadataFile },
        source: '<!doctype html><html><body><button id="original">Invented</button></body></html>',
      },
    },
    records: [],
    pages: [],
    snippets: {},
  });
  const generated = await renderer.renderStringWithProvenance(
    '<!doctype html><html><body><button id="original">Invented</button></body></html>',
    {},
    renderer.sourceIndex().templates.get('invented-main'),
  );
  const requests = [],
    descriptors = new Map();
  descriptors.set(generated.provenance.proofId, generated.provenance);
  const heldDescriptors = [];
  let descriptorsReleased = !delayDescriptor;
  const releaseDescriptors = () => {
    descriptorsReleased = true;
    for (const { response, proof } of heldDescriptors.splice(0))
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(proof));
  };
  const server = http.createServer((request, response) => {
    const address = new URL(request.url, 'http://fixture.invalid');
    requests.push({ path: address.pathname, cookie: request.headers.cookie, proof: address.searchParams.get('proof') });
    if (address.pathname === '/_sim/api/page-provenance') {
      if (request.headers['x-paqvilo-provenance-access'] !== '1'.repeat(64))
        return response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      const proof = descriptors.get(address.searchParams.get('proof'));
      if (proof && !descriptorsReleased) {
        heldDescriptors.push({ response, proof });
        return;
      }
      if (address.searchParams.get('proof') === 'redirect-proof')
        return response.writeHead(302, { location: '/must-not-follow' }).end();
      return response
        .writeHead(proof ? 200 : 404, { 'content-type': 'application/json' })
        .end(JSON.stringify(proof ?? {}));
    }
    if (mirage && address.pathname !== '/native')
      return response
        .writeHead(200, {
          'content-type': 'text/html',
          'x-paqvilo-provenance': address.pathname === '/redirect' ? 'redirect-proof' : generated.provenance.proofId,
          'x-paqvilo-provenance-access': '1'.repeat(64),
        })
        .end(generated.html);
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><html><body><button id="native">Native response</button></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.addCookies([{ name: 'invented', value: 'one', url: origin }]);
  const transport = createPortalProvenanceTransport(context, [{ origin, mirage }]);
  const acknowledgments = [];
  let acknowledge = () => {};
  // Resolves with the fulfillment result of `pathname` once interception has it.
  const acknowledgment = async (pathname) => {
    while (!acknowledgments.some((item) => item.path === pathname))
      await new Promise((resolve) => (acknowledge = resolve));
    return acknowledgments.find((item) => item.path === pathname);
  };
  // Resolves once the server has received the Mirage sideband request for `proof`.
  const sideband = async (proof) => {
    while (!requests.some((item) => item.path === '/_sim/api/page-provenance' && item.proof === proof))
      await once(server, 'request');
  };
  let releaseSlow, enteredSlow;
  const slowEntered = new Promise((resolve) => {
    enteredSlow = resolve;
  });
  const slowReleased = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  let detached;
  t.after(async () => {
    releaseDescriptors();
    releaseSlow();
    await detached?.();
    await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const attach = async () => {
    detached = await interceptOrigin(
      context,
      origin,
      async (route) => {
        const address = new URL(route.request().url());
        if (mirage || route.request().resourceType() !== 'document' || address.pathname === '/native')
          return route.fallback();
        if (address.pathname === '/abort') return route.abort();
        if (address.pathname === '/slow-fulfill') {
          enteredSlow();
          await slowReleased;
        }
        const script =
          address.pathname === '/clone'
            ? '<script>const original=document.getElementById("original");original.replaceWith(original.cloneNode(true));</script>'
            : '';
        const html = generated.html.replace(
          '</body>',
          `${address.pathname === '/parent' ? '<iframe id="child" src="/child"></iframe>' : ''}${script}</body>`,
        );
        const acknowledged = await route.fulfill({
          body: html,
          headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'unsafe-inline'" },
          provenance: { ...generated.provenance, channel: 'lense-applied-response' },
        });
        acknowledgments.push({ path: address.pathname, acknowledged });
        acknowledge();
      },
      { onAttach: transport.onAttach },
    );
  };
  const query = (target = page, id = 'original') =>
    target.evaluate(
      ({ slot, scope, id }) => {
        const registry = window[slot];
        return registry?.query(document.getElementById(id), { scope, anchorGeneration: 9 }) ?? null;
      },
      { slot: transport.slot, scope, id },
    );
  const proved = async (target = page) => {
    try {
      await target.waitForFunction(
        ({ slot, scope }) =>
          window[slot]?.query(document.getElementById('original'), { scope, anchorGeneration: 9 }).facts.length === 1,
        { slot: transport.slot, scope },
      );
    } catch (error) {
      throw new Error(JSON.stringify(await query(target)), { cause: error });
    }
  };
  return {
    origin,
    context,
    page,
    attach,
    query,
    proved,
    requests,
    acknowledgments,
    acknowledgment,
    sideband,
    slowEntered,
    releaseSlow,
    slot: transport.slot,
    proof: generated.provenance,
    releaseDescriptors,
    detach: () => detached(),
  };
}

test('successful fulfillment publishes private original-node proof before authored clones can impersonate it', async (t) => {
  const fx = await fixture(t);
  await fx.attach();
  await fx.page.goto(fx.origin + '/accepted');
  await fx.proved();
  const packet = await fx.query();
  assert.equal(packet.facts[0].kind, 'lense-applied-literal');
  assert.deepEqual(packet.scope, scope);
  assert.equal(await fx.page.evaluate((slot) => typeof window[slot].publish, fx.slot), 'undefined');
  assert.equal(await fx.page.evaluate((slot) => window[slot].claim('invented-wrong-secret'), fx.slot), null);
  await fx.page.goto(fx.origin + '/clone');
  assert.equal((await fx.query()).facts.length, 0);
  await assert.rejects(fx.page.goto(fx.origin + '/abort'), /ERR_ABORTED/);
  await fx.page.goto(fx.origin + '/native');
  await fx.page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'original';
    button.setAttribute('data-paqvilo-source', 'forged');
    document.body.append(button);
  });
  assert.equal((await fx.query()).facts.length, 0);
});

test('Xray consumes actual acknowledged source proof independently of ownership and a cloned node cannot inherit it', async (t) => {
  const fx = await fixture(t);
  await fx.attach();
  await fx.page.goto(fx.origin + '/accepted');
  await fx.proved();
  const data = {
    origin: fx.origin,
    token: 'invented-proof-inspection',
    provenanceSlot: fx.slot,
    sourceRevision: fx.proof.sourceRevision,
    inspection: { active: true, version: 1 },
  };
  await fx.page.evaluate(xrayUi, data);
  await fx.page.evaluate(
    ({ data, proof }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, { sourceRevision: proof.sourceRevision, sourceRefs: proof.sourceRefs });
      api.toggle(true);
      api.select(document.getElementById('original'));
    },
    { data, proof: fx.proof },
  );
  const identity = await fx.page.evaluate(() => document.getElementById('paqvilo-xray').__px.selection());
  assert.equal(identity.evidence.source.status, 'exact');
  assert.equal(identity.evidence.owner.status, 'unavailable');
  const card = fx.page.locator('#paqvilo-xray');
  assert.equal(await card.getByRole('button', { name: 'Open source', exact: true }).isEnabled(), true);
  const source = identity.evidence.source.refs.find((ref) => ref.status === 'exact');
  assert.ok(
    source.region.start > 0 && source.region.end > source.region.start,
    'the selected literal tag has its own nonzero source region',
  );
  await fx.page.evaluate(() =>
    document.addEventListener('paqvilo-xray', (event) => {
      if (event.detail.action === 'open') window.sourceOpen = event.detail;
    }),
  );
  await card.getByRole('button', { name: 'Open source', exact: true }).click();
  const action = await fx.page.evaluate(() => window.sourceOpen);
  assert.deepEqual(action.region, source.region);
  assert.deepEqual(action.scope, identity.evidence.scope);
  assert.equal(action.contentRevision, source.contentRevision);
  assert.equal(action.sourceKey, source.sourceKey ?? source.key);
  assert.ok(Number.isSafeInteger(action.anchorGeneration));
  if (process.env.PAQVILO_EVIDENCE_DIR) {
    await fs.mkdir(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
    await fx.page.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, 'acknowledged-original-source.png') });
  }
  await fx.page.evaluate((next) => document.getElementById('paqvilo-xray').__px.update(next), {
    ...data,
    sourceRevision: 'invented-next-source-revision',
  });
  assert.equal(
    (await fx.page.evaluate(() => document.getElementById('paqvilo-xray').__px.selection())).evidence.source.status,
    'stale',
  );
  assert.equal(await card.getByRole('button', { name: 'Open source', exact: true }).isDisabled(), true);
  await fx.page.locator('#original').evaluate((node) => node.replaceWith(node.cloneNode(true)));
  await fx.page.waitForFunction(() => document.getElementById('paqvilo-xray').__px.selection() === null);
  await fx.page.evaluate(() =>
    document.getElementById('paqvilo-xray').__px.select(document.getElementById('original')),
  );
  assert.notEqual(
    (await fx.page.evaluate(() => document.getElementById('paqvilo-xray').__px.selection())).evidence.source.status,
    'exact',
  );
});

test('frame and popup writers are document-local, and owned bootstrap is removed on detach', async (t) => {
  const fx = await fixture(t);
  await fx.attach();
  await fx.page.goto(fx.origin + '/parent');
  await fx.proved();
  const child = fx.page.frames().find((frame) => frame !== fx.page.mainFrame());
  await fx.proved(child);
  assert.equal((await fx.query(child)).facts.length, 1);
  const popupReady = fx.page.waitForEvent('popup');
  await fx.page.evaluate((url) => window.open(url), fx.origin + '/popup');
  const popup = await popupReady;
  await popup.waitForLoadState();
  await fx.proved(popup);
  await fx.detach();
  await fx.page.goto(fx.origin + '/native');
  assert.equal(await fx.query(), null, 'no owned bootstrap survives detach into a later document');
});

test('Mirage observes one native document response and reads only its same-cookie nonredirecting metadata sideband', async (t) => {
  const fx = await fixture(t, { mirage: true });
  await fx.attach();
  await fx.page.goto(fx.origin + '/mirage');
  await fx.proved();
  assert.equal((await fx.query()).facts[0].kind, 'render-literal');
  assert.equal(
    fx.requests.filter(({ path }) => path === '/mirage').length,
    1,
    'document is never fetched a second time by the overlay',
  );
  assert.ok(
    fx.requests.some(({ path, cookie }) => path === '/_sim/api/page-provenance' && cookie?.includes('invented=one')),
  );
  await fx.page.goto(fx.origin + '/redirect');
  await fx.sideband('redirect-proof');
  // A followed redirect would request its location as soon as the 302 arrives; nothing marks one that never comes.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fx.query()).facts.length, 0);
  assert.equal(
    fx.requests.some(({ path }) => path === '/must-not-follow'),
    false,
  );
});

test('existing authored lookalike registries are never claimed and canceled fulfillments cannot publish into a later document', async (t) => {
  const fx = await fixture(t);
  let claims = 0;
  await fx.context.exposeBinding('inventedClaimAttempt', () => claims++);
  await fx.page.goto(fx.origin + '/native');
  await fx.page.evaluate((slot) => {
    window[slot] = {
      claim() {
        window.inventedClaimAttempt();
        return {
          publish() {
            return true;
          },
        };
      },
    };
  }, fx.slot);
  await fx.attach();
  await fx.page.waitForLoadState();
  assert.equal(claims, 0, 'no backend claim is attempted against the already-authored Document');
  const canceled = fx.page.goto(fx.origin + '/slow-fulfill').catch(() => null);
  await fx.slowEntered;
  await fx.page.goto(fx.origin + '/native');
  fx.releaseSlow();
  await canceled;
  assert.equal((await fx.acknowledgment('/slow-fulfill')).acknowledged, false);
  const packet = await fx.query();
  assert.ok(packet === null || packet.facts.length === 0);
});

test('a delayed native sideband refreshes the same hidden one-shot anchor when its private proof arrives', async (t) => {
  const fx = await fixture(t, { mirage: true, delayDescriptor: true });
  await fx.attach();
  await fx.page.goto(fx.origin + '/mirage');
  const data = {
    origin: fx.origin,
    token: 'invented-delayed-proof',
    provenanceSlot: fx.slot,
    sourceRevision: fx.proof.sourceRevision,
    mirageMode: true,
    inspection: { active: true, version: 1 },
  };
  await fx.page.evaluate(xrayUi, data);
  const selected = await fx.page.evaluate(
    ({ data, proof }) => {
      const api = document.getElementById('paqvilo-xray').__px;
      api.update(data, { sourceRevision: proof.sourceRevision, sourceRefs: proof.sourceRefs });
      api.pickOnce();
      api.select(document.getElementById('original'));
      return api.selectionState();
    },
    { data, proof: fx.proof },
  );
  assert.equal(selected.identity.evidence.source.status, 'unavailable');
  fx.releaseDescriptors();
  await fx.page.waitForFunction(
    () => document.getElementById('paqvilo-xray').__px.selection()?.evidence.source.status === 'exact',
  );
  const updated = await fx.page.evaluate(() => ({
    state: document.getElementById('paqvilo-xray').__px.selectionState(),
    enabled: document.getElementById('paqvilo-xray').__px.enabled,
  }));
  assert.equal(updated.state.anchorId, selected.anchorId);
  assert.equal(updated.state.anchorGeneration, selected.anchorGeneration);
  assert.equal(updated.enabled, false);
});
