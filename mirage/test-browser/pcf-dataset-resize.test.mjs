import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sharedBrowser, loopbackServer } from './shared-browser.mjs';

const browser = sharedBrowser();
const bundle = `ComponentFramework.registerControl('Invented.ResponsiveGrid', class {
  init(context, notify, state, container) {
    window.datasetContext = context;
    window.initSize = [context.mode.allocatedWidth, context.mode.allocatedHeight];
    container.textContent = 'Invented dataset';
    context.mode.trackContainerResize(true);
    if (window.failure === 'init') throw new Error('Invented init failure');
  }
  updateView(context) {
    if (window.failure === 'updateView') throw new Error('Invented update failure');
    // Bound a faulty host's recursion so the regression can report it instead
    // of starving the browser's task queue indefinitely.
    if (window.repeatTracking && window.updates.length < 8) context.mode.trackContainerResize(true);
    window.updates.push({width:context.mode.allocatedWidth,height:context.mode.allocatedHeight,changes:[...context.updatedProperties]});
  }
  destroy() { window.destroys++; }
});`;

async function fixture(t, { controlled = false, failure, repeatTracking = false } = {}) {
  const runtime = await fs.readFile(new URL('../lib/model-driven/pcf-runtime.mjs', import.meta.url));
  const { origin } = await loopbackServer(t, (req, res) => {
    res.setHeader(
      'Content-Type',
      req.url.endsWith('.mjs') || req.url.endsWith('.js') ? 'text/javascript' : 'text/html',
    );
    res.end(
      req.url === '/runtime.mjs'
        ? runtime
        : req.url === '/bundle.js'
          ? bundle
          : '<!doctype html><main style="width:300px"></main>',
    );
  });
  const page = await browser.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(
    async ({ controlled, failure, repeatTracking }) => {
      window.updates = [];
      window.destroys = 0;
      window.failure = failure;
      window.repeatTracking = repeatTracking;
      window.observers = [];
      if (controlled)
        window.ResizeObserver = class {
          constructor(callback) {
            this.callback = callback;
            this.disconnects = 0;
            window.observers.push(this);
          }
          observe(element) {
            this.element = element;
          }
          disconnect() {
            this.disconnects++;
          }
        };
      const { renderPcfDataset } = await import(new URL('/runtime.mjs', location.href).href);
      const table = {
        entity: 'x_invented',
        idColumn: 'x_inventedid',
        nameColumn: 'x_name',
        fields: { x_name: { type: 'text' } },
      };
      window.control = renderPcfDataset(
        { pcf: { name: 'x_ResponsiveGrid', bindings: {} } },
        {
          table,
          tables: { x_invented: table },
          query: async () => ({ rows: [], total: 0 }),
          clientExtensions: {
            trusted: true,
            pcf: {
              controls: [
                {
                  name: 'x_ResponsiveGrid',
                  constructor: 'Invented.ResponsiveGrid',
                  controlType: 'standard',
                  datasets: [{ name: 'rows' }],
                  resources: { code: ['/bundle.js'] },
                },
              ],
            },
          },
        },
      );
      document.querySelector('main').append(window.control.element);
      await window.control.ready;
    },
    { controlled, failure, repeatTracking },
  );
  return { page, errors };
}

test('dataset tracking reports model-driven width changes with layout updates and unconstrained height', async (t) => {
  const { page, errors } = await fixture(t);
  await page.waitForFunction(() =>
    window.updates.some((update) => update.width === 300 && update.changes.includes('layout')),
  );
  assert.deepEqual(await page.evaluate(() => window.initSize), [-1, -1]);
  await page.locator('main').evaluate((element) => {
    element.style.width = '450px';
  });
  await page.waitForFunction(() =>
    window.updates.some((update) => update.width === 450 && update.changes.includes('layout')),
  );
  assert.equal(await page.evaluate(() => window.updates.every((update) => update.height === -1)), true);
  assert.deepEqual(errors, []);
});

test('dataset resize merges pending data changes, stops when disabled and cannot restart after destruction', async (t) => {
  const { page, errors } = await fixture(t, { controlled: true });
  const result = await page.evaluate(async () => {
    const context = window.datasetContext,
      observer = window.observers[0];
    window.updates = [];
    const refresh = window.control.dataset.refresh();
    document.querySelector('main').style.width = '440px';
    observer.callback();
    await refresh;
    const combined = window.updates.some(
      (update) => update.width === 440 && update.changes.includes('layout') && update.changes.includes('rows'),
    );
    context.mode.trackContainerResize(false);
    await Promise.resolve();
    const disabledWidth = context.mode.allocatedWidth,
      calls = window.updates.length;
    document.querySelector('main').style.width = '510px';
    observer.callback();
    await Promise.resolve();
    const ignored = calls === window.updates.length;
    context.mode.trackContainerResize(true);
    window.control.destroy();
    await Promise.resolve();
    context.mode.trackContainerResize(true);
    return {
      combined,
      disabledWidth,
      ignored,
      observers: window.observers.length,
      disconnects: window.observers.map((entry) => entry.disconnects),
      destroys: window.destroys,
    };
  });
  assert.deepEqual(result, {
    combined: true,
    disabledWidth: -1,
    ignored: true,
    observers: 2,
    disconnects: [1, 1],
    destroys: 1,
  });
  assert.deepEqual(errors, []);
});

test('repeated dataset resize subscriptions settle without recursive updates or replacement observers', async (t) => {
  const { page, errors } = await fixture(t, { controlled: true, repeatTracking: true });
  const result = await page.evaluate(async () => {
    const context = window.datasetContext,
      observer = window.observers[0],
      initial = window.updates.length;
    document.querySelector('main').style.width = '440px';
    observer.callback();
    await Promise.resolve();
    const resized = window.updates.length;
    window.repeatTracking = false;
    context.mode.trackContainerResize(false);
    context.mode.trackContainerResize(false);
    await Promise.resolve();
    return {
      initial,
      resizeUpdates: resized - initial,
      disableUpdates: window.updates.length - resized,
      observers: window.observers.length,
      disconnects: observer.disconnects,
      widths: [window.updates[resized - 1].width, context.mode.allocatedWidth],
    };
  });
  const { initial, ...changes } = result;
  assert.ok(initial > 0 && initial <= 2, 'initial data/layout updates settle');
  assert.deepEqual(changes, {
    resizeUpdates: 1,
    disableUpdates: 1,
    observers: 1,
    disconnects: 1,
    widths: [440, -1],
  });
  assert.deepEqual(errors, []);
});

for (const failure of ['init', 'updateView'])
  test(`dataset resize cleanup disconnects observers after ${failure} failure`, async (t) => {
    const { page, errors } = await fixture(t, { controlled: true, failure });
    assert.equal(await page.locator('.model-driven-pcf').getAttribute('data-pcf-state'), 'unsupported');
    const result = await page.evaluate(() => {
      window.datasetContext.mode.trackContainerResize(true);
      window.control.destroy();
      return {
        observers: window.observers.length,
        disconnects: window.observers[0].disconnects,
        destroys: window.destroys,
      };
    });
    assert.deepEqual(result, { observers: 1, disconnects: 1, destroys: 1 });
    assert.deepEqual(errors, []);
  });
