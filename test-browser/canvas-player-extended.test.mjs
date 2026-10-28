import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { closeServer } from '../mirage/test-browser/shared-browser.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { stringify } from 'yaml';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { createCanvasHandler } from '../mirage/lib/canvas-http.mjs';
import { createCanvasRuntime } from '../mirage/lib/canvas-runtime.mjs';
import { createPowerFxEvaluator } from '../mirage/lib/canvas-power-fx.mjs';
import { observedConfig } from '../mirage/lib/project-config.mjs';
import { fixtureApp } from '../mirage/test/canvas-runtime-fixture.mjs';

const control = (name, type, properties, children = []) => ({
  [name]: { Control: type, Properties: properties, ...(children.length ? { Children: children } : {}) },
});

function silentWav() {
  const length = 80000,
    buffer = Buffer.alloc(44 + length, 128);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + length, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(length, 40);
  return buffer;
}
async function player(t, { display, resolution, onDanger, watch, onRevision, onStart, assetWarnings } = {}) {
  const rows = Array.from({ length: 60 }, (_, i) => i + 1).join(',');
  const files = {
    'Assets/Logo.png': Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=',
      'base64',
    ),
    'Assets/Tone.wav': silentWav(),
    'Src/App.pa.yaml': stringify({ App: { Properties: { StartScreen: '=Home' } } }),
    'Src/Home.pa.yaml': stringify({
      Screens: {
        Home: {
          Children: [
            control('Search', 'Classic/ComboBox@2.0', {
              Items: '=["Alpha","Beta","Gamma"]',
              SelectMultiple: '=true',
              IsSearchable: '=true',
              ItemDisplayText: '="Choice " & ThisItem.Value',
              X: '=5',
              Y: '=5',
              Width: '=200',
              Height: '=100',
            }),
            control('Chosen', 'Label@2.0', {
              Text: '=Concat(Search.SelectedItems,Value,",")',
              X: '=220',
              Y: '=5',
              Width: '=200',
              Height: '=40',
            }),
            control(
              'Rows',
              'Gallery@2.0',
              {
                Items: `=[${rows}]`,
                TemplateFill: '=If(ThisItem.Value=51, "red", "blue")',
                X: '=5',
                Y: '=120',
                Width: '=300',
                Height: '=300',
                TemplateSize: '=70',
              },
              [
                control(
                  'Inner',
                  'GroupContainer@1.0',
                  { Width: '=200', Height: '=60', LayoutDirection: '=LayoutDirection.Horizontal' },
                  [
                    control('RowLabel', 'Label@2.0', { Text: '=Text(ThisItem.Value)', Width: '=60', Height: '=40' }),
                    control('RowButton', 'Classic/Button@2.0', {
                      Text: '="Pick"',
                      OnSelect: '=Set(picked, ThisItem.Value)',
                      Width: '=60',
                      Height: '=40',
                    }),
                  ],
                ),
              ],
            ),
            control('Picked', 'Label@2.0', {
              Text: '=Text(picked)',
              X: '=320',
              Y: '=120',
              Width: '=100',
              Height: '=40',
            }),
            control(
              'StretchParent',
              'GroupContainer@1.0',
              {
                X: '=700',
                Y: '=500',
                Width: '=300',
                Height: '=80',
                LayoutDirection: '=LayoutDirection.Vertical',
                LayoutAlignItems: '=LayoutAlignItems.Stretch',
              },
              [
                control('StretchChild', 'Label@2.0', {
                  Text: '="Stretched"',
                  Height: '=40',
                  AlignInContainer: '=AlignInContainer.SetByContainer',
                }),
              ],
            ),
            {
              VariantStack: {
                Control: 'GroupContainer@1.0',
                Variant: 'verticalAutoLayoutContainer',
                Properties: { X: '=700', Y: '=600', Width: '=200', Height: '=80' },
                Children: [
                  control('VariantFirst', 'Label@2.0', { Text: '="First"', Width: '=80', Height: '=30' }),
                  control('VariantSecond', 'Label@2.0', { Text: '="Second"', Width: '=80', Height: '=30' }),
                ],
              },
            },
            control('ChoiceStatus', 'Classic/Dropdown@2.0', {
              Items: "=Filter(Choices('Invented Status'), Value <> 'Invented Status'.Inactive)",
              X: '=700',
              Y: '=450',
              Width: '=150',
              Height: '=40',
            }),
            control('Range', 'Classic/Slider@2.0', {
              Default: '=2',
              Min: '=0',
              Max: '=10',
              OnChange: '=Set(rangeValue, Range.Value)',
              X: '=700',
              Y: '=5',
              Width: '=150',
              Height: '=40',
            }),
            control('Numeric', 'ModernNumberInput@1.0.0', {
              Default: '=4',
              OnChange: '=Set(numericValue, Numeric.Value)',
              X: '=700',
              Y: '=55',
              Width: '=150',
              Height: '=40',
            }),
            control('ChoiceRadio', 'Classic/Radio@2.0', {
              Items: '=["One","Two"]',
              OnChange: '=Set(radioValue, ChoiceRadio.Selected.Value)',
              X: '=700',
              Y: '=105',
              Width: '=150',
              Height: '=60',
            }),
            control('Rich', 'HtmlViewer@2.0', {
              HtmlText: `="<p><strong style='color:red'>Safe</strong><script>window.bad=1</script><iframe src=/danger></iframe><a href=javascript:alert(1)>link</a><img src=/danger onerror=alert(1)><img src='/_apps/canvas/fx_inventedcanvas/assets/Logo.png'></p>"`,
              X: '=700',
              Y: '=200',
              Width: '=250',
              Height: '=60',
            }),
            control('ReadOnly', 'ModernTextInput@1.0.0', {
              Default: '="read me"',
              DisplayMode: '=DisplayMode.View',
              X: '=700',
              Y: '=400',
              Width: '=150',
              Height: '=40',
            }),
            control('ModernInput', 'ModernTextInput@1.0.0', {
              Default: '="initial"',
              OnChange: '=Set(modernChanged, true)',
              X: '=500',
              Y: '=300',
              Width: '=150',
              Height: '=40',
            }),
            control('ModernLabel', 'ModernText@1.0.0', {
              Text: '="Press"',
              OnSelect: '=Set(modernSelected, true)',
              X: '=500',
              Y: '=350',
              Width: '=100',
              Height: '=40',
            }),
            control('Upload', 'AddMediaButton@2.0', {
              Text: '="Choose image"',
              OnChange: '=Set(uploaded, true)',
              X: '=900',
              Y: '=200',
              Width: '=260',
              Height: '=80',
            }),
            control('UploadName', 'Label@2.0', {
              Text: '=Upload.FileName',
              X: '=900',
              Y: '=285',
              Width: '=260',
              Height: '=30',
            }),
            control('Preview', 'Image@2.0', {
              Image: '=Upload.Media',
              X: '=900',
              Y: '=320',
              Width: '=60',
              Height: '=60',
            }),
            control('LogoView', 'Image@2.0', {
              Image: '=Logo',
              OnSelect: '=Set(imageClicked, true)',
              X: '=500',
              Y: '=10',
              Width: '=60',
              Height: '=60',
            }),
            control(
              'MediaStack',
              'GroupContainer@1.0',
              { X: '=900', Y: '=10', Width: '=300', Height: '=100', LayoutDirection: '=LayoutDirection.Vertical' },
              [control('NestedSound', 'Audio@2.0', { Media: '=Tone', Width: '=200', Height: '=50' })],
            ),
            control('Sound', 'Audio@2.0', {
              Media: '=Tone',
              OnStart: '=Set(mediaPlayed, true)',
              OnPause: '=Set(mediaPaused, true)',
              X: '=500',
              Y: '=100',
              Width: '=200',
              Height: '=50',
            }),
            control('ResetCounter', 'Classic/Button@2.0', {
              Text: '="Reset"',
              OnSelect: '=Reset(Counter)',
              X: '=500',
              Y: '=180',
              Width: '=100',
              Height: '=40',
            }),
            control('GoDetail', 'Classic/Button@2.0', {
              Text: '="Go"',
              OnSelect: '=Navigate(Detail, ScreenTransition.Fade)',
              X: '=500',
              Y: '=420',
              Width: '=100',
              Height: '=40',
            }),
            control('Counter', 'Timer@2.0', {
              Duration: '=2000',
              Repeat: '=true',
              X: '=320',
              Y: '=180',
              Width: '=150',
              Height: '=40',
              OnTimerEnd: '=Set(finished, true)',
            }),
          ],
        },
      },
    }),
    'Src/Detail.pa.yaml': stringify({
      Screens: { Detail: { Children: [control('DetailLabel', 'Label@2.0', { Text: '="Detail"' })] } },
    }),
  };
  const app = await fixtureApp(files);
  app.source.enums = { 'Invented Status': { Active: 1, Inactive: 2 } };
  if (assetWarnings)
    app.source.assetDiagnostics = [{ code: 'CANVAS_ASSET_UNAVAILABLE', message: 'Invented asset is unavailable.' }];
  if (watch) {
    app.source.watch = true;
    app.source.revision = 'initial-revision';
  }
  if (display)
    app.source.app.display = observedConfig({
      canvasDisplay: { [app.uniqueName]: display },
      evidence: 'invented fixture',
    }).canvasDisplay[app.uniqueName];
  const runtime = createCanvasRuntime({ apps: () => [app], evaluator: createPowerFxEvaluator() });
  const handler = createCanvasHandler({
    apps: () => [app],
    runtime,
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    csrf: () => 'fixture-token',
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => closeServer(server));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.canvasServer = server;
  page.canvasApp = app;
  page.canvasRuntime = runtime;
  if (watch) await page.clock.install();
  if (onRevision) await page.route('**/_apps/canvas/api/*?revision=1', onRevision);
  if (onStart)
    await page.route('**/_apps/api/canvas/*', async (route) => {
      if (route.request().method() === 'POST' && route.request().postDataJSON()?.action === 'start')
        onStart(route.request().postDataJSON());
      await route.continue();
    });
  if (onDanger)
    await page.route('**/danger', (route) => {
      onDanger();
      return route.abort();
    });
  await page.goto(`http://127.0.0.1:${server.address().port}/_apps/canvas/${app.uniqueName}`);
  if (resolution) await page.getByTestId('canvas-resolution').selectOption(resolution);
  await page.getByTestId('canvas-start').click();
  await page.locator('[data-control="Rows"]').waitFor();
  return page;
}

test(
  'player filters multi-select choices and pages gallery with row scope and auto layout',
  { timeout: 60000 },
  async (t) => {
    const page = await player(t);
    const combo = page.locator('[data-control="Search"]');
    const search = combo.locator('input[type="search"]');
    assert.equal(await combo.locator('option').first().textContent(), 'Choice Alpha');
    await search.fill('a');
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute('aria-label') === 'Search search' && document.activeElement.value === 'a',
    );
    await combo.locator('select').selectOption(['0', '1']);
    await page.waitForFunction(() => document.querySelector('[data-control="Chosen"]')?.textContent === 'Alpha,Beta');
    const gallery = page.locator('[data-control="Rows"]');
    assert.equal(await gallery.locator('[data-item-index]').count(), 50);
    assert.equal(await gallery.locator('[data-item-index="0"]').evaluate((el) => el.style.backgroundColor), 'blue');
    await gallery.getByRole('button', { name: 'Next', exact: true }).click();
    const row = gallery.locator('[data-item-index="50"]');
    await row.waitFor();
    assert.equal(await row.evaluate((el) => el.style.backgroundColor), 'red');
    const label = await row.locator('[data-control="RowLabel"]').boundingBox();
    const button = await row.locator('[data-control="RowButton"]').boundingBox();
    assert.ok(button.x >= label.x + label.width);
    await row.locator('[data-control="RowButton"]').click();
    await page.waitForFunction(() => document.querySelector('[data-control="Picked"]')?.textContent === '51');
  },
);

test(
  'timer uses the explicit browser clock, repeats, and pauses through the runtime',
  { timeout: 60000 },
  async (t) => {
    const page = await player(t);
    await page.clock.install();
    const timer = page.locator('[data-control="Counter"]');
    const started = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'select',
    );
    await timer.click();
    await started;
    const tick = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'tick',
    );
    await page.clock.fastForward(2500);
    assert.equal((await tick).ok(), true);
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"finished": true'),
    );
    const paused = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'select',
    );
    await timer.click();
    const snapshot = (await (await paused).json()).snapshot;
    const control = snapshot.screens.find((screen) => screen.current).controls.find((item) => item.name === 'Counter');
    assert.equal(control.properties.Running, false);
    const reset = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.request().postDataJSON()?.control === 'ResetCounter',
    );
    await page.locator('[data-control="ResetCounter"]').click();
    const resetSnapshot = (await (await reset).json()).snapshot;
    const resetTimer = resetSnapshot.screens
      .find((screen) => screen.current)
      .controls.find((item) => item.name === 'Counter');
    assert.equal(resetTimer.properties.Value, 0);
  },
);

test('browser viewport option resizes the runtime when the window changes', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  await page.getByTestId('canvas-resolution').selectOption('browser');
  const resized = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.action === 'resize' &&
      response.request().postDataJSON()?.width === 700,
  );
  await page.setViewportSize({ width: 700, height: 500 });
  assert.equal((await resized).ok(), true);
  await page.waitForFunction(() => document.querySelector('[data-testid="canvas-stage"]')?.style.width === '700px');
});

test(
  'local assets render and native media and accessible image actions reach the runtime',
  { timeout: 60000 },
  async (t) => {
    const page = await player(t);
    const image = page.locator('[data-control="LogoView"]');
    assert.equal(await image.evaluate((el) => el.tagName), 'IMG');
    assert.ok(await image.getAttribute('src').then((src) => src.startsWith('/_apps/canvas/')));
    await image.focus();
    await image.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"imageClicked": true'),
    );
    const audio = page.locator('[data-control="Sound"]');
    assert.equal(await audio.evaluate((el) => el.tagName), 'AUDIO');
    const media = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'media',
    );
    await audio.evaluate((el) => {
      window.playingNode = el;
      return el.play();
    });
    assert.equal((await media).ok(), true);
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"mediaPlayed": true'),
    );
    assert.equal(await audio.evaluate((el) => el === window.playingNode && !el.paused), true);
    const paused = page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.request().postDataJSON()?.event === 'pause',
    );
    await audio.evaluate((el) => el.pause());
    assert.equal((await paused).ok(), true);
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"mediaPaused": true'),
    );
  },
);

test(
  'modern text input and selectable text use supported aliases with a visible approximation warning',
  { timeout: 60000 },
  async (t) => {
    const page = await player(t);
    const readOnly = page.locator('[data-control="ReadOnly"]');
    assert.equal(await readOnly.isDisabled(), false);
    assert.equal(await readOnly.isEditable(), false);
    const input = page.locator('[data-control="ModernInput"]');
    assert.equal(await input.inputValue(), 'initial');
    await input.fill('changed');
    await input.press('Tab');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"modernChanged": true'),
    );
    const label = page.locator('[data-control="ModernLabel"]');
    await label.focus();
    await label.press('Space');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"modernSelected": true'),
    );
    assert.match(await page.getByTestId('canvas-inspector').textContent(), /Modern control behavior is approximated/);
  },
);

test('one browser tab owns a shared timer clock and another takes over after close', { timeout: 60000 }, async (t) => {
  const first = await player(t);
  await first.locator('[data-control="Counter"]').click();
  await first.waitForFunction(
    () => document.querySelector('[data-testid="canvas-stage"]')?.dataset.clockOwned === 'true',
  );
  const second = await first.context().newPage();
  await second.goto(first.url());
  await second.locator('[data-control="Counter"]').waitFor();
  const locks = await second.evaluate(() => navigator.locks.query());
  assert.equal(locks.held.filter((lock) => lock.name.startsWith('paqvilo-canvas-clock:')).length, 1);
  assert.notEqual(await second.getByTestId('canvas-stage').getAttribute('data-clock-owned'), 'true');
  await first.close();
  await second.waitForFunction(
    () => document.querySelector('[data-testid="canvas-stage"]')?.dataset.clockOwned === 'true',
  );
});

test('screen navigation applies the selected transition and respects reduced motion', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-control="GoDetail"]').click();
  await page.locator('[data-control="DetailLabel"]').waitFor();
  const stage = page.getByTestId('canvas-stage');
  assert.equal(await stage.evaluate((el) => el.classList.contains('canvas-transition-fade')), true);
  assert.equal(await stage.evaluate((el) => getComputedStyle(el).animationName), 'none');
});

test('slider, number input and radio drive native changes with keyboard access', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  const range = page.locator('[data-control="Range"]');
  await range.fill('7');
  await range.dispatchEvent('change');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"rangeValue": 7'),
  );
  const numeric = page.locator('[data-control="Numeric"]');
  await numeric.fill('9');
  await numeric.press('Tab');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"numericValue": 9'),
  );
  const radio = page.locator('[data-control="ChoiceRadio"]').getByRole('radio').nth(1);
  await radio.focus();
  await radio.press('Space');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"radioValue": "Two"'),
  );
});

test('observed display settings control logical size, letterboxing and orientation', { timeout: 60000 }, async (t) => {
  const page = await player(t, {
    display: { designWidth: 800, designHeight: 400, scaleToFit: true, lockAspectRatio: true },
    resolution: '390x844',
  });
  const stage = await page.getByTestId('canvas-stage').boundingBox();
  const surface = await page.locator('.canvas-surface').boundingBox();
  assert.ok(Math.abs(stage.width - 390) < 1 && Math.abs(stage.height - 195) < 1);
  assert.ok(Math.abs(stage.y - surface.y - 324.5) < 1);
  const state = await (await page.request.get(new URL('/_apps/api/canvas/fx_inventedcanvas', page.url()).href)).json();
  assert.deepEqual(state.viewport, { width: 800, height: 400 });
  const locked = await player(t, {
    display: { lockOrientation: true, orientation: 'Landscape' },
    resolution: '390x844',
  });
  const lockedState = await (
    await locked.request.get(new URL('/_apps/api/canvas/fx_inventedcanvas', locked.url()).href)
  ).json();
  assert.deepEqual(lockedState.viewport, { width: 844, height: 390 });
});

test(
  'HTML viewer renders a safe markup subset without active elements or URL attributes',
  { timeout: 60000 },
  async (t) => {
    let danger = 0;
    const page = await player(t, { onDanger: () => danger++ });
    const rich = page.locator('[data-control="Rich"]');
    assert.equal(await rich.locator('strong').textContent(), 'Safe');
    assert.match(await rich.textContent(), /link/);
    assert.equal(await rich.locator('script,a,iframe,form').count(), 0);
    assert.equal(await rich.locator('img').count(), 1);
    assert.equal(await rich.locator('strong').evaluate((el) => el.style.color), 'red');
    assert.equal(danger, 0);
    assert.equal(await page.evaluate(() => window.bad), undefined);
  },
);

test('nested media keeps playing across unrelated snapshot redraws', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  const audio = page.locator('[data-control="NestedSound"]');
  await page.locator('[data-control="ModernLabel"]').click();
  await audio.evaluate(async (element) => {
    window.nestedAudio = element;
    await element.play();
  });
  await page.waitForFunction(() => document.querySelector('[data-control="NestedSound"]')?.currentTime > 0);
  const prior = await audio.evaluate((element) => element.currentTime);
  const input = page.locator('[data-control="ModernInput"]');
  await input.fill('new value');
  await input.press('Tab');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-inspector"]')?.textContent.includes('"modernChanged": true'),
  );
  assert.equal(await audio.evaluate((element) => element === window.nestedAudio && !element.paused), true);
  assert.ok((await audio.evaluate((element) => element.currentTime)) >= prior);
  await page.locator('[data-control="GoDetail"]').click();
  await page.locator('[data-control="DetailLabel"]').waitFor();
  assert.equal(await page.evaluate(() => !window.nestedAudio.isConnected && window.nestedAudio.paused), true);
});

test(
  'watched source revision reloads without restarting the app and releases timer ownership',
  { timeout: 60000 },
  async (t) => {
    let release,
      arrived,
      starts = 0,
      revisions = 0;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = new Promise((resolve) => {
      arrived = resolve;
    });
    t.after(() => release());
    const page = await player(t, {
      watch: true,
      onStart: (payload) => {
        starts++;
        assert.equal(payload.sourceRevision, 'initial-revision');
      },
      onRevision: async (route) => {
        revisions++;
        arrived();
        await gate;
        await route.fulfill({ status: 200, json: { revision: 'updated-revision' } });
      },
    });
    await page.locator('[data-control="Counter"]').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="canvas-stage"]')?.dataset.clockOwned === 'true',
    );
    await page.clock.fastForward(1000);
    await seen;
    await page.clock.fastForward(4000);
    assert.equal(revisions, 1, 'only one revision request is outstanding');
    const priorKey = (
      await (await page.request.get(new URL('/_apps/api/canvas/fx_inventedcanvas', page.url()).href)).json()
    ).clockKey;
    page.canvasApp.source.revision = 'updated-revision';
    page.canvasRuntime.reset(page.canvasApp.uniqueName, { kind: 'staff', principalId: 'local' });
    const loaded = page.waitForEvent('load');
    release();
    await loaded;
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="canvas-status"]')?.textContent === 'Source updated. Start the app again.',
    );
    assert.equal(starts, 1);
    assert.equal(await page.locator('[data-control="Counter"]').count(), 0);
    assert.equal(
      await page.evaluate(async (key) => navigator.locks.request(`paqvilo-canvas-clock:${key}`, () => true), priorKey),
      true,
    );
  },
);

test('source watch pauses while hidden and checks again on visibility regain', { timeout: 60000 }, async (t) => {
  let checks = 0,
    arrived;
  const seen = new Promise((resolve) => {
    arrived = resolve;
  });
  const page = await player(t, {
    watch: true,
    onRevision: async (route) => {
      checks++;
      arrived();
      await route.fulfill({ status: 200, json: { revision: 'initial-revision' } });
    },
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(3000);
  assert.equal(checks, 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(1);
  await seen;
  assert.equal(checks, 1);
});

test('local picture picker validates image bytes and updates Media and FileName', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  const picker = page.locator('[data-control="Upload"] input[type="file"]');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=',
    'base64',
  );
  const response = page.waitForResponse(
    (result) => result.request().method() === 'POST' && result.request().postDataJSON()?.action === 'add-media',
  );
  await picker.setInputFiles({ name: 'invented.png', mimeType: 'image/png', buffer: png });
  assert.equal((await response).ok(), true);
  await page.waitForFunction(
    () => document.querySelector('[data-control="UploadName"]')?.textContent === 'invented.png',
  );
  assert.match(await page.locator('[data-control="Preview"]').getAttribute('src'), /^data:image\/png;base64,/);
  assert.equal(
    await page.locator('[data-control="Preview"]').evaluate(async (image) => {
      await image.decode();
      return image.naturalWidth;
    }),
    1,
  );
  assert.match(await page.getByTestId('canvas-inspector').textContent(), /"uploaded": true/);
  await picker.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload=alert(1)>') });
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-status"]')?.textContent.includes('matching file content'),
  );
  assert.equal(await page.locator('[data-control="UploadName"]').textContent(), 'invented.png');
  await picker.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(1024 * 1024 + 1) });
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas-status"]')?.textContent.includes('no larger than 1 MiB'),
  );
  assert.equal(await page.locator('[data-control="UploadName"]').textContent(), 'invented.png');
});

test('auto-layout stretches the cross axis and honors an explicit container variant', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  const parent = await page.locator('[data-control="StretchParent"]').boundingBox();
  const child = await page.locator('[data-control="StretchChild"]').boundingBox();
  assert.equal(Math.round(child.width), Math.round(parent.width));
  const first = await page.locator('[data-control="VariantFirst"]').boundingBox();
  const second = await page.locator('[data-control="VariantSecond"]').boundingBox();
  assert.ok(second.y >= first.y + first.height);
});

test('player inspector reports source asset diagnostics', { timeout: 60000 }, async (t) => {
  const page = await player(t, { assetWarnings: true });
  assert.match(
    await page.getByTestId('canvas-inspector').textContent(),
    /CANVAS_ASSET_UNAVAILABLE.*Invented asset is unavailable/,
  );
});

test('choice dropdown displays labels and filters inactive backing values', { timeout: 60000 }, async (t) => {
  const page = await player(t);
  const options = page.locator('[data-control="ChoiceStatus"] option');
  assert.deepEqual(await options.allTextContents(), ['Active']);
});

test('player fixture drains accepted idle sockets before browser cleanup', { timeout: 60000 }, async (t) => {
  const hooks = [];
  let socket, cleanup;
  const close = () =>
    (cleanup ??= (async () => {
      for (const hook of hooks) await hook();
    })());
  t.after(async () => {
    socket?.destroy();
    await close();
  });
  const page = await player({ after: (hook) => hooks.push(hook) });
  const accepted = once(page.canvasServer, 'connection');
  socket = net.createConnection({ host: '127.0.0.1', port: page.canvasServer.address().port });
  await once(socket, 'connect');
  await accepted;
  // A browser preconnect has no HTTP request for close() to finish. Its close event is the gate;
  // the timeout only names a missing event, and the test's own cleanup releases a broken fixture.
  const socketClosed = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
  const pending = close();
  await socketClosed;
  await pending;
  assert.equal(page.isClosed(), true);
});
