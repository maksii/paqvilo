import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
// Live Lense mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { listenOwnedServer } from './helpers/owned-server.mjs';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { inspectionFixture, addNativeInspectionFixture } from '../test/source-inspection-fixture.mjs';

function launchInspectBrowser() {
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  return chromium.launch({
    channel: channel === 'chromium' ? undefined : channel,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'],
  });
}

async function prepareInspectPage(context, session) {
  const page = await context.newPage();
  // Existing pages are awaited by attachSession; later pages attach in the
  // background and may replace an already-loaded native document afterward.
  const detach = await attachSession(context, session);
  return { page, detach };
}

test(
  'live Inspect works without Mirage and opens exact project Solution sources, locates controls and refreshes navigation',
  { timeout: 90_000 },
  async (t) => {
    const fx = inspectionFixture();
    addNativeInspectionFixture(fx);
    const nativeFormFile = path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml');
    fs.writeFileSync(
      nativeFormFile,
      fs
        .readFileSync(nativeFormFile, 'utf8')
        .replace('id="fx_title"', 'id="fx_title" uniqueid="native-editor"')
        .replace(
          '</tabs>',
          '</tabs><controlDescriptions><controlDescription forControl="native-editor"><customControl name="fx_Example.Editor" formFactor="0"><parameters><value>fx_title</value></parameters></customControl></controlDescription></controlDescriptions>',
        ),
    );
    fs.writeFileSync(
      path.join(fx.portal, 'basic-forms/Native-editor.basicformmetadata.yml'),
      'adx_entityformmetadataid: native-editor-metadata\nadx_entityform: widget-edit\nadx_type: 100000000\nadx_attributelogicalname: fx_title\nadx_controlstyle: 756150001',
    );
    const nativeControlDir = path.join(fx.solution, 'Controls/fx_Example.Editor');
    fs.mkdirSync(nativeControlDir, { recursive: true });
    fs.writeFileSync(
      path.join(nativeControlDir, 'ControlManifest.xml'),
      '<manifest><control namespace="Example" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    );
    fs.writeFileSync(
      path.join(nativeControlDir, 'ControlManifest.xml.data.xml'),
      '<CustomControl><Name>fx_Example.Editor</Name></CustomControl>',
    );
    fs.writeFileSync(path.join(nativeControlDir, 'bundle.js'), 'window.Example = {};');
    const assetCode =
      "window.widgetFeature = true; function api(path) { return fetch('/_api/' + path); } api('fx_widgets(record-private-id)?$filter=private-filter');";
    fs.writeFileSync(path.join(fx.portal, 'web-files/widget.js'), assetCode);
    const requests = [],
      opened = [],
      errors = [];
    // Resolves the wait of openedBy when the panel asks the editor to open a source.
    let arrived = () => {};
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
      requests.push(pathname);
      if (pathname === '/widget.js')
        return response.writeHead(200, { 'content-type': 'text/javascript' }).end(assetCode);
      if (pathname.startsWith('/_api/'))
        return response.writeHead(200, { 'content-type': 'application/json' }).end('{"value":[]}');
      if (pathname === '/widget.css')
        return response.writeHead(200, { 'content-type': 'text/css' }).end('.widget { margin: 1rem; }');
      if (pathname === '/favicon.ico') return response.writeHead(204).end();
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<!doctype html><html><head><title>Widget fixture</title><link rel="stylesheet" href="/widget.css?private=excluded"></head><body><h1>Widgets</h1><form data-formid="widget-edit" data-entityname="fx_widget"><span data-form-layout='{"Id":"widget-edit","EntityName":"fx_widget"}'></span><label for="fx_title">Title</label><input id="fx_title" name="fx_title" value="private-value-must-not-be-inspected"><input type="password" id="password" value="private-password"></form><div class="subgrid" id="ChildGrid"><div class="entity-grid" data-selected-view="child-view"></div></div><a href="/other/" id="other">Other page</a><script src="/widget.js"></script></body></html>`,
        );
    });
    let browser, panel, detach;
    ownedFixture(t).add(async () => {
      await panel?.dispose();
    });
    ownedFixture(t).add(async () => {
      await detach?.();
    });
    ownedFixture(t).add(async () => {
      await browser?.close();
    });
    ownedFixture(t).remove(async () => {
      fx.cleanup();
    });
    const origin = await listenOwnedServer(t, server);
    browser = await launchInspectBrowser();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
    );
    const session = new OverlaySession({
      sourceDir: fx.portal,
      origin,
      site: structuredClone(SITE),
      sourceMaps: false,
      siteName: 'Widget fixture',
      envName: 'loopback',
      stateDir: fx.work,
      browser: {},
      mirageConfig: { project: fx.project },
    });
    const readyPage = await prepareInspectPage(context, session);
    const { page } = readyPage;
    detach = readyPage.detach;
    panel = enablePanel(context, session, {
      open: async (...args) => {
        opened.push(args);
        arrived();
        return null;
      },
    });
    page.on('pageerror', (error) => errors.push(error.message));
    // Resolves with the source the panel asked the editor to open after one click.
    const openedBy = async (locator) => {
      const before = opened.length;
      const next = new Promise((resolve) => (arrived = resolve));
      await locator.click();
      await next;
      assert.equal(opened.length, before + 1, 'the panel opened one source');
      return opened.at(-1)[1];
    };
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForFunction(() =>
      performance.getEntriesByType('resource').some((entry) => entry.name.includes('/_api/')),
    );
    const scope = page.locator('#paqvilo-panel');
    await scope.locator('.pill').click();
    await scope.locator('[data-act="tab"][data-v="runtime"]').click();
    await scope.locator('[data-group="runtime-forms"]').getByText('Widget form', { exact: false }).first().waitFor();
    assert.equal(await scope.getByText('Live portal · local source inspection').count(), 1);
    assert.equal(await scope.getByText('Live access', { exact: true }).count(), 1);
    assert.equal(await scope.locator('[data-act="tab"][data-v="tweaks"]').count(), 0);
    assert.equal(
      await scope.locator('[data-group="runtime-permissions"]').getByText('Readers view widgets').count(),
      1,
    );
    assert.equal(
      await scope.locator('[data-group="runtime-permissions"]').getByText('Editors update widgets').count(),
      1,
    );
    await scope
      .locator('[data-group="runtime-api"]')
      .getByText('table fx_widget · observed request; IDs and query values excluded')
      .waitFor();
    await scope.locator('[data-group="runtime-native"]').getByText('Child records', { exact: true }).waitFor();
    await scope.locator('[data-group="runtime-forms"]').getByText('Read child', { exact: true }).waitFor();
    await scope.locator('[data-group="runtime-pcf"]').getByText('fx_Example.Editor', { exact: true }).waitFor();
    assert.equal(
      await openedBy(
        scope.locator('[data-group="runtime-pcf"] [data-rel$="ControlManifest.xml"] [data-act="open"]').first(),
      ),
      path.join(nativeControlDir, 'ControlManifest.xml'),
    );
    assert.equal(
      await openedBy(scope.locator('[data-group="runtime-pcf"] [data-rel*="FormXml"] [data-act="open"]').first()),
      nativeFormFile,
    );
    if (process.env.PAQVILO_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, 'lense-inspect-live.png') });
    }
    assert.equal(
      await openedBy(scope.locator('[data-group="runtime-forms"] [data-rel*="FormXml"] [data-act="open"]').first()),
      path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml'),
    );
    assert.equal(
      await openedBy(
        scope
          .locator('[data-group="runtime-page-sources"] [data-rel$="custom_javascript.js"] [data-act="open"]')
          .first(),
      ),
      path.join(fx.portal, 'web-pages/home/Home.webpage.custom_javascript.js'),
    );
    assert.equal(
      await openedBy(
        scope
          .locator('[data-group="runtime-views"] .row')
          .filter({ hasText: 'Related children' })
          .locator('[data-act="open"]')
          .first(),
      ),
      path.join(fx.solution, 'Entities/fx_child/SavedQueries/child-view.xml'),
    );
    await scope.locator('[data-act="inspect-section"][data-v="components"]').click();
    assert.equal(await scope.locator('[data-group="runtime-page-sources"]').count(), 0);
    await scope.locator('[data-group="runtime-columns"] [data-act="inspect-locate"][data-field="fx_title"]').click();
    assert.match(await page.locator('#fx_title').evaluate((node) => node.style.outline), /3px/);
    await scope.locator('[data-act="inspect-pick"]').click();
    const fieldBox = await page.locator('#fx_title').boundingBox();
    await page.mouse.click(fieldBox.x + 10, fieldBox.y + 10);
    await scope
      .locator('[data-selected-identity] [data-evidence-role="owner"] strong')
      .getByText('fx_title', { exact: true })
      .waitFor();
    const selected = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
    assert.equal(selected.identity.evidence.owner.status, 'exact');
    assert.equal(selected.identity.evidence.owner.component.key, 'column:fx_widget:fx_title');
    assert.equal(selected.identity.evidence.source.status, 'exact');
    assert.equal(
      await page.evaluate(() => document.getElementById('paqvilo-xray').__px.enabled),
      false,
      'panel picking ends inspect mode after one element',
    );
    const tab = scope.locator('[data-act=tab][data-v=overrides]'),
      tabBox = await tab.boundingBox();
    assert.equal(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
        x: tabBox.x + tabBox.width / 2,
        y: tabBox.y + tabBox.height / 2,
      }),
      'paqvilo-panel',
    );
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    await scope.locator('[data-act=tab][data-v=runtime]').click();
    await scope.locator('[data-act="inspect-section"][data-v="all"]').click();
    const snapshot = JSON.stringify(
      await page.evaluate(
        async (token) =>
          (
            await fetch('/__paqvilo/api/inspect', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-paqvilo-token': token },
              body: '{}',
            })
          ).json(),
        panel.stateFor(page).token,
      ),
    );
    assert.doesNotMatch(snapshot, /private-value|private-password|private=excluded|record-private-id|private-filter/);
    assert.equal(
      JSON.parse(snapshot).report.renderedControls.some((row) => row.id === 'password'),
      false,
    );
    fs.writeFileSync(path.join(fx.portal, 'content-snippets/Banner.contentsnippet.value.html'), 'Updated banner');
    await scope.locator('[data-act="inspect-refresh"]').click();
    await scope.locator('[data-group="runtime-snippets"]').getByText('“Updated banner”').waitFor();
    await page.locator('#other').click();
    await scope
      .locator('[data-act="tab"][data-v="runtime"]')
      .click()
      .catch(async (error) => {
        const panelState = await page
          .evaluate(() => {
            const panel = document.getElementById('paqvilo-panel');
            return {
              url: location.href,
              ready: document.readyState,
              panel: Boolean(panel),
              open: panel?.classList.contains('open') ?? null,
              tabs: [...(panel?.querySelectorAll('[data-act=tab]') ?? [])].map((tab) => tab.dataset.v),
              html: panel?.outerHTML.slice(0, 400),
            };
          })
          .catch((cause) => ({ evaluate: cause.message }));
        throw Object.assign(error, {
          message: `${error.message}\npanel after navigation: ${JSON.stringify(panelState)}`,
        });
      });
    await scope.getByText('Other', { exact: false }).first().waitFor();
    assert.equal(panel.stateFor(page).inspection.path, '/other/');
    assert.equal(
      requests.some((route) => route.startsWith('/_sim/') || route.startsWith('/__sim/')),
      false,
    );
    assert.deepEqual(errors, []);
  },
);

test('live Inspect fixture awaits real interception setup before application evidence can be captured', async (t) => {
  const fx = inspectionFixture();
  fs.appendFileSync(path.join(fx.portal, 'web-files/widget.js'), '\nfetch("/_api/fx_widgets");');
  const held = Promise.withResolvers(),
    release = Promise.withResolvers();
  let browser, preparing, detach;
  const owner = ownedFixture(t);
  owner.add(async () => {
    release.resolve();
    if (preparing) detach = (await preparing).detach;
    await detach?.();
  });
  owner.add(() => browser?.close());
  const server = http.createServer((request, response) => {
    if (request.url === '/widget.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.widgetFeature = false;');
    if (request.url.startsWith('/_api/'))
      return response.writeHead(200, { 'content-type': 'application/json' }).end('{"value":[]}');
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><script src="/widget.js"></script>');
  });
  owner.remove(() => fx.cleanup());
  const origin = await listenOwnedServer(t, server);
  browser = await launchInspectBrowser();
  const context = await browser.newContext();
  const createCDP = context.newCDPSession.bind(context);
  t.mock.method(context, 'newCDPSession', async (...args) => {
    const cdp = await createCDP(...args),
      send = cdp.send.bind(cdp);
    t.mock.method(cdp, 'send', async (method, ...values) => {
      if (method === 'Fetch.enable') {
        held.resolve();
        await release.promise;
      }
      return send(method, ...values);
    });
    return cdp;
  });
  const session = new OverlaySession({
    sourceDir: fx.portal,
    origin,
    site: structuredClone(SITE),
    sourceMaps: false,
    browser: {},
  });
  let prepared = false;
  preparing = prepareInspectPage(context, session).then((result) => {
    prepared = true;
    return result;
  });
  preparing.catch(() => {}); // The owned cleanup also awaits this preparation if an assertion fails.
  await held.promise;
  assert.equal(prepared, false, 'a held real Fetch setup cannot publish a ready fixture');
  release.resolve();
  const { page } = await preparing;
  await page.goto(origin);
  await page.waitForFunction(
    () =>
      window.widgetFeature === true &&
      performance.getEntriesByType('resource').some((entry) => entry.name.includes('/_api/fx_widgets')),
  );
  assert.equal(await page.evaluate(() => window.widgetFeature), true, 'the selected local script actually ran');
  assert.equal(
    session.pageHits.get(page).some((hit) => hit.type === 'file' && hit.url === '/widget.js'),
    true,
  );
});
