// @test-kind observation: notifyOutputChanged debouncing of the Power Pages field and Liquid tag hosts, live captures paqvilo-developer pcf-parity summary-F section 2 (runs fa and fb, nt-field-ny and nt-liquid-ny, paqvilo3 2026-11-26), replayed on invented loopback pages with Playwright's controlled clock
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sharedBrowser, loopbackServer } from './shared-browser.mjs';

const browser = sharedBrowser({ headless: true });

// The page's timers run on Playwright's controlled clock: time moves only through clock.runFor, so the assertions
// name the moments of the capture (getOutputs about 100 ms after the last notify) without any wall-clock deadline.
async function hostPage(t) {
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const { origin } = await loopbackServer(t, (request, response) => {
    if (request.url === '/host.js') {
      response.setHeader('Content-Type', 'text/javascript');
      return response.end(host);
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><script src="/host.js"></script></body></html>');
  });
  const page = await browser.page(t),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Paused: the controlled time does not flow on its own.
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(origin);
  await page.evaluate(() => {
    window.events = {};
    window.notify = {};
    window.values = {};
    // Records getOutputs (with the value it answers) and updateView (with its updatedProperties) per control.
    window.ComponentFramework.registerControl(
      'Synthetic.Notifier',
      class {
        init(context, notify, state, container) {
          this.key = container.dataset.key;
          window.events[this.key] = [];
          window.notify[this.key] = notify;
        }
        updateView(context) {
          window.events[this.key]?.push(['updateView', [...context.updatedProperties], context.parameters.value.raw]);
        }
        getOutputs() {
          window.events[this.key].push(['getOutputs', window.values[this.key]]);
          return { value: window.values[this.key] };
        }
        destroy() {}
      },
    );
    window.mountNotifier = async (key, spec, markup) => {
      let parent = document.body;
      if (markup !== undefined) {
        parent = document.createElement('div');
        parent.className = 'control';
        parent.dataset.logicalName = key;
        parent.innerHTML = markup;
        document.body.append(parent);
      }
      const target = document.createElement('div');
      target.dataset.key = key;
      parent.append(target);
      await window.__paqviloPcf.mount(
        {
          id: key,
          constructor: 'Synthetic.Notifier',
          resources: [],
          strings: {},
          args: {},
          identity: { id: null, roles: [] },
          mappings: {},
          properties: [{ name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' }],
          ...spec,
        },
        target,
      );
      window.events[key].length = 0;
    };
  });
  return { page, errors };
}

const mountField = (page) =>
  page.evaluate(() =>
    window.mountNotifier(
      'field',
      { host: 'field', nativeBinding: { id: 'f', control: 'text', properties: ['value'] } },
      '<input id="f" type="hidden" value="&quot;initial&quot;">',
    ),
  );
const mountLiquid = (page) => page.evaluate(() => window.mountNotifier('liquid', { host: 'liquid' }));
/** Sets the control's next output and calls notifyOutputChanged; answers what the call returned. */
const notify = (page, key, value) =>
  page.evaluate(
    ([name, output]) => {
      window.values[name] = output;
      return String(window.notify[name]());
    },
    [key, value],
  );
const events = (page, key) => page.evaluate((name) => window.events[name].splice(0), key);

for (const [host, mount, after] of [
  // The field host follows each getOutputs with one updateView [] holding the output as raw value.
  ['field', mountField, (value) => [['updateView', [], value]]],
  // The Liquid tag host never runs updateView after a notify.
  ['liquid', mountLiquid, () => []],
]) {
  test(`${host} host: getOutputs runs once, 100 ms after the last notify, with the last value`, async (t) => {
    const { page, errors } = await hostPage(t);
    await mount(page);
    // single: notifyOutputChanged returns at once; nothing runs before 100 ms.
    assert.equal(await notify(page, host, 'single one'), 'undefined');
    await page.clock.runFor(99);
    assert.deepEqual(await events(page, host), []);
    await page.clock.runFor(1);
    assert.deepEqual(await events(page, host), [['getOutputs', 'single one'], ...after('single one')]);
    // sync3: three notifies in one turn collapse into one call reading the last value.
    await page.evaluate((name) => {
      for (const value of ['sync one', 'sync two', 'sync three']) {
        window.values[name] = value;
        window.notify[name]();
      }
    }, host);
    await page.clock.runFor(100);
    assert.deepEqual(await events(page, host), [['getOutputs', 'sync three'], ...after('sync three')]);
    // microtasks and timeout0: notifies in microtasks and in a setTimeout(0) task share one call.
    await page.evaluate((name) => {
      const send = (value) => {
        window.values[name] = value;
        window.notify[name]();
      };
      send('micro one');
      queueMicrotask(() => send('micro two'));
      queueMicrotask(() => queueMicrotask(() => send('micro three')));
      setTimeout(() => send('task two'), 0);
    }, host);
    await page.clock.runFor(99);
    assert.deepEqual(await events(page, host), []);
    await page.clock.runFor(1);
    assert.deepEqual(await events(page, host), [['getOutputs', 'task two'], ...after('task two')]);
    // spaced50: notifies 50 ms apart keep moving the call to 100 ms after the last one.
    await notify(page, host, 'spaced one');
    await page.clock.runFor(50);
    await notify(page, host, 'spaced two');
    await page.clock.runFor(50);
    await notify(page, host, 'spaced three');
    await page.clock.runFor(99);
    assert.deepEqual(await events(page, host), []);
    await page.clock.runFor(1);
    assert.deepEqual(await events(page, host), [['getOutputs', 'spaced three'], ...after('spaced three')]);
    // spaced150: notifies 150 ms apart get one call each.
    await notify(page, host, 'wide one');
    await page.clock.runFor(150);
    await notify(page, host, 'wide two');
    await page.clock.runFor(100);
    assert.deepEqual(await events(page, host), [
      ['getOutputs', 'wide one'],
      ...after('wide one'),
      ['getOutputs', 'wide two'],
      ...after('wide two'),
    ]);
    // sameValueTwice: the unchanged value is read once and runs no updateView.
    await page.evaluate((name) => {
      window.notify[name]();
      window.notify[name]();
    }, host);
    await page.clock.runFor(100);
    assert.deepEqual(await events(page, host), [['getOutputs', 'wide two']]);
    if (host === 'field') assert.equal(await page.locator('#f').inputValue(), '"wide two"');
    assert.deepEqual(errors, []);
  });
}

// @test-kind unproven: local teardown model; the capture did not remove a control with a notify pending
test('a pending notify of a removed control never calls getOutputs', async (t) => {
  const { page, errors } = await hostPage(t);
  await mountField(page);
  await notify(page, 'field', 'late');
  await page.evaluate(() => document.querySelector('[data-key="field"]').remove());
  await page.clock.runFor(200);
  assert.deepEqual(await events(page, 'field'), []);
  assert.deepEqual(errors, []);
});
