// Invented loopback-only exports. Run serially to assess budgets, not with the full test suite.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { parseOptions } from '../lense/cli-options.mjs';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { importPortal } from '../mirage/lib/importer.mjs';
import { inspectionFixture } from '../test/source-inspection-fixture.mjs';
import { SITE } from '../test/fixture.mjs';

const USAGE = `Usage: node scripts/benchmark-xray.mjs [--samples <1-5>] [--strict] [--json]
  --samples <n>   small and large synthetic sample pairs to measure, 1 to 5 (default 3)
  --strict        exit 1 when a sample exceeds a latency budget
  --json          print the JSON report (the only output format; accepted for clarity)
  --help          print this help
Runs headless on invented loopback exports only; run it serially, not beside the test suite.`;
let values;
try {
  ({ values } = parseOptions({
    options: {
      samples: { type: 'string', default: '3' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
  if (!values.help && !/^[1-5]$/.test(values.samples))
    throw new Error('--samples must be from 1 to 5. Run with --help to see supported options.');
} catch (error) {
  console.error('benchmark-xray: ' + error.message);
  process.exit(1);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
// Steps wait for observed page state with no per-step deadline, so a slow host never fails a run. Only this hang
// guard stops a run, after a single sample makes no progress for ten minutes.
const HANG_GUARD_MS = 10 * 60_000;
let hangGuard;
const armHangGuard = (label) => {
  clearTimeout(hangGuard);
  hangGuard = setTimeout(() => {
    console.error(
      `benchmark-xray: hang guard: the ${label} sample did not finish within 10 minutes; a slow host alone does not reach this, so inspect the X-ray page state.`,
    );
    process.exit(1);
  }, HANG_GUARD_MS);
};
const browser = await chromium.launch(
  browserLaunchOptions({ headless: true, args: ['--disable-background-networking'] }),
);
const samples = [];
async function run(large, index) {
  const fx = inspectionFixture();
  let context, panel, detach, server;
  try {
    const used = Array.from({ length: 3 }, (_, i) => ({
      adx_webtemplateid: 'used-' + i,
      adx_name: 'Used ' + i,
      adx_source: `<section id="used-${i}">${'<b class="used-detail">Invented</b>'.repeat(20)}</section>`,
    }));
    const unused = Array.from({ length: large ? 395 : 0 }, (_, i) => ({
      adx_webtemplateid: 'unused-' + i,
      adx_name: 'Unused ' + i,
      adx_source: Array.from({ length: 20 }, (_, j) => `<i class="unused-${index}-${i}-${j}"></i>`).join(''),
    }));
    fs.writeFileSync(path.join(fx.portal, 'webtemplate.yml'), JSON.stringify([...used, ...unused]));
    const dynamic = '<aside id="dynamic-banner"><span class="dynamic-message">Invented</span></aside>';
    fs.writeFileSync(
      path.join(fx.portal, 'contentsnippet.yml'),
      JSON.stringify([
        { adx_contentsnippetid: 'dynamic', adx_name: 'Dynamic notice', adx_value: dynamic },
        ...Array.from({ length: large ? 598 : 0 }, (_, i) => ({
          adx_contentsnippetid: 'unused-' + i,
          adx_name: 'Unused snippet ' + i,
          adx_value: Array.from({ length: 20 }, (_, j) => `<i class="unused-snippet-${index}-${i}-${j}"></i>`).join(''),
        })),
      ]),
    );
    fs.appendFileSync(
      path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'),
      used.map((row) => `{% include '${row.adx_name}' %}`).join(''),
    );
    const html = `<!doctype html><style>body{padding:100px}section{margin:10px}b{display:inline-block;padding:4px}</style>${used.map((row) => row.adx_source).join('')}<main></main><script>document.querySelector('main').innerHTML=${JSON.stringify(dynamic)};window.selectionActivations=0;document.querySelector('.dynamic-message').addEventListener('click',()=>window.selectionActivations++);</script>`;
    server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(0);
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.fallback() : route.abort(),
    );
    await context.addInitScript(() => {
      globalThis.addEventListener(
        'keydown',
        (e) => {
          if (e.altKey && e.shiftKey && e.code === 'KeyX') globalThis.toggleStarted = performance.now();
        },
        { capture: true },
      );
      // Register before X-ray so its capture handler cannot precede the start clock.
      globalThis.addEventListener(
        'pointerdown',
        (event) => {
          const probe = globalThis.selectionProbe;
          if (!probe?.armed) return;
          probe.started = performance.now();
          probe.trusted = event.isTrusted;
          probe.armed = false;
        },
        { capture: true },
      );
      document.addEventListener('paqvilo-xray', (event) => {
        const probe = globalThis.selectionProbe;
        if (event.detail.action !== 'selected' || probe?.started === undefined) return;
        const ms = performance.now() - probe.started;
        delete probe.started;
        const card = document.getElementById('paqvilo-xray').shadowRoot.querySelector('.card');
        probe.samples.push({
          ms,
          trusted: probe.trusted,
          sources: event.detail.identity.evidence.source.refs
            .filter((ref) => ref.status === 'candidate')
            .map((ref) => ref.name),
          cardNamesSource: card.textContent.includes('Dynamic notice'),
          element: event.detail.element,
        });
      });
    });
    const session = new OverlaySession({
      sourceDir: fx.portal,
      origin,
      site: structuredClone(SITE),
      sourceMaps: false,
      siteName: 'Synthetic X-ray benchmark',
      envName: 'loopback',
      stateDir: fx.work,
      browser: {},
    });
    // Open the tab before attaching: attachSession awaits interception on existing pages, while a later page attaches
    // in the background and may replace its already-loaded native document, losing the shortcut pressed on it.
    const page = await context.newPage();
    detach = await attachSession(context, session);
    panel = enablePanel(context, session, { open: async () => null });
    const navigation = performance.now();
    await page.goto(origin);
    await page.locator('#paqvilo-panel').waitFor();
    const navigationToPanelMs = performance.now() - navigation;
    // The shortcut is handled by the X-ray host, which can attach after the panel; a key pressed earlier is lost.
    await page.waitForFunction(() => document.getElementById('paqvilo-xray')?.__px);
    const toggle = async () => {
      await page.keyboard.press('Alt+Shift+X');
      // Ready when the source report names the snippet. Static export markup is an explicit source candidate, never
      // an exact owner, because page script inserts the dynamic snippet.
      await page.waitForFunction(() => {
        const host = document.getElementById('paqvilo-xray');
        return (
          host?.__px.enabled &&
          host.shadowRoot.querySelector('.ui').getAttribute('aria-busy') === 'false' &&
          host.__px
            .identify(document.getElementById('dynamic-banner'))
            .evidence.source.refs.some((ref) => ref.name === 'Dynamic notice' && ref.status === 'candidate')
        );
      });
      return page.evaluate(
        () =>
          new Promise((resolve) => {
            let firstFrame = true;
            const measure = () => {
              if (firstFrame) {
                firstFrame = false;
                requestAnimationFrame(measure);
              } else resolve(performance.now() - globalThis.toggleStarted);
            };
            requestAnimationFrame(measure);
          }),
      );
    };
    const coldToggleMs = await toggle();
    await page.evaluate(() => (globalThis.selectionProbe = { samples: [], armed: false }));
    for (let selection = 0; selection < 5; selection++) {
      if (selection) await page.keyboard.press('Escape');
      const rect = await page.locator('.dynamic-message').boundingBox();
      if (!rect) throw new Error('Dynamic snippet selection target is missing');
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.evaluate(() => (globalThis.selectionProbe.armed = true));
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForFunction((count) => globalThis.selectionProbe.samples.length === count, selection + 1);
    }
    const pointerSelection = await page.evaluate(() => ({
      samples: globalThis.selectionProbe.samples,
      activations: globalThis.selectionActivations,
    }));
    if (
      pointerSelection.activations !== 0 ||
      pointerSelection.samples.some(
        (sample) =>
          !sample.trusted ||
          !sample.sources.includes('Dynamic notice') ||
          !sample.cardNamesSource ||
          !sample.element.classes.split('.').includes('dynamic-message'),
      )
    )
      throw new Error('Trusted pointer selection did not identify the dynamic snippet without activating it');
    pointerSelection.maxMs = Math.max(...pointerSelection.samples.map((sample) => sample.ms));
    const internalIdentification = await page.evaluate(() => {
      const api = document.getElementById('paqvilo-xray').__px,
        node = document.querySelector('.dynamic-message');
      let identity;
      const start = performance.now();
      for (let n = 0; n < 100; n++) identity = api.identify(node);
      return { meanMs: (performance.now() - start) / 100, iterations: 100, title: identity.title };
    });
    await page.keyboard.press('Alt+Shift+X');
    const revisitMs = await toggle();
    await page.evaluate(() => {
      const ui = document.getElementById('paqvilo-xray').shadowRoot.querySelector('.ui');
      let busy = false;
      globalThis.refreshMs = null;
      const start = performance.now(),
        observer = new MutationObserver(() => {
          if (ui.getAttribute('aria-busy') === 'true') busy = true;
          else if (busy) {
            globalThis.refreshMs = performance.now() - start;
            observer.disconnect();
          }
        });
      observer.observe(ui, { attributes: true, attributeFilter: ['aria-busy'] });
      document.getElementById('paqvilo-xray').shadowRoot.querySelector('[data-action=refresh]').click();
    });
    await page.waitForFunction(() => globalThis.refreshMs !== null);
    const refreshMs = await page.evaluate(() => globalThis.refreshMs);
    const imported = await importPortal(fx.portal);
    const counts = {
      templates: new Set(Object.values(imported.templates)).size,
      snippets: Object.keys(imported.snippets).length,
    };
    if (counts.templates !== (large ? 400 : 5) || counts.snippets !== (large ? 600 : 2))
      throw new Error('Benchmark source count mismatch');
    return {
      large,
      counts,
      navigationToPanelMs,
      coldToggleMs,
      revisitMs,
      refreshMs,
      pointerSelection,
      internalIdentification,
    };
  } finally {
    await panel?.dispose();
    await detach?.();
    await context?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    fx.cleanup();
  }
}
try {
  for (let index = 0; index < Number(values.samples); index++) {
    armHangGuard(`small #${index + 1}`);
    const small = await run(false, index);
    armHangGuard(`large #${index + 1}`);
    samples.push({ small, large: await run(true, index) });
  }
  const findings = samples.flatMap((pair, index) =>
    Object.entries(pair).flatMap(([size, row]) => [
      ...(row.coldToggleMs > 1000
        ? [`${index + 1} ${size}: cold toggle ${row.coldToggleMs.toFixed(1)} ms exceeds 1000 ms`]
        : []),
      ...(row.revisitMs >= 200 ? [`${index + 1} ${size}: revisit ${row.revisitMs.toFixed(1)} ms reaches 200 ms`] : []),
      ...(row.pointerSelection.maxMs >= 5
        ? [
            `${index + 1} ${size}: trusted pointer-to-card selection ${row.pointerSelection.maxMs.toFixed(3)} ms reaches 5 ms`,
          ]
        : []),
    ]),
  );
  const report = {
    scope: 'Invented loopback sources only; no live data or origins',
    samples,
    findings,
    note: 'Cold means first toggle in a new browser context and inspector. Navigation already starts the source report. Toggle times start at trusted keydown and end after source identity plus two animation frames. Browser launch, synthetic fixture generation and automation dispatch precede this interval; navigation-to-panel is measured separately. Each of five pointer selections starts at trusted pointerdown capture before the inspector handler and ends at the selected event after synchronous source-card rendering and identity construction. Target geometry, pointer movement, automation preparation/dispatch, and subsequent browser paint are outside the pointer interval. Every selection checks that the event identity names the snippet as a source candidate (static export markup of a script-inserted snippet is never an exact owner) and that the visible card names it, plus zero page click activations. The strict 5 ms budget applies to the maximum pointer selection, not the separately reported mean of 100 internal api.identify calls. OS caches and concurrent work affect results; this is not an arbitrary-export or live-page latency guarantee.',
  };
  console.log(JSON.stringify(report, null, 2));
  if (values.strict && findings.length) process.exitCode = 1;
} finally {
  clearTimeout(hangGuard);
  await browser.close();
}
