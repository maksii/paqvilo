// @test-kind unproven: local model of the PCF host around the Power Pages field host (state, bfcache, resize, statics, batching) on invented loopback pages; the captured field host behaviour is in native-pcf-field-host.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { ownedFixture, drainFixture } from '../testing/owned-fixture.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function hostPage(t, options = {}) {
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const hanging = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/host.js') {
      response.setHeader('Content-Type', 'text/javascript');
      return response.end(host);
    }
    if (request.url.startsWith('/_api/tst_hangs')) return hanging.push(response);
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><script src="/host.js"></script></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let context;
  ownedFixture(t).add(() =>
    drainFixture([
      () => context?.close(),
      () =>
        new Promise((resolve) => {
          for (const response of hanging) response.destroy();
          server.close(resolve);
          server.closeAllConnections();
        }),
    ]),
  );
  context = await browser.newContext({ timezoneId: options.timezoneId ?? 'UTC' });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installRecorder(page);
  return { page, errors };
}

/** Registers the recorder control and the mountRecorder/updates helpers on the page. */
function installRecorder(page) {
  return page.evaluate(() => {
    window.log = [];
    window.contexts = {};
    window.notify = {};
    window.outputs = {};
    window.echo = {};
    window.waiters = [];
    // Resolves at the next updateView of a control (with its updatedProperties).
    window.nextUpdate = (key) => new Promise((resolve) => window.waiters.push([key, resolve]));
    window.ComponentFramework.registerControl(
      'Synthetic.Recorder',
      class {
        init(context, notify, state, container) {
          this.key = container.dataset.key;
          window.contexts[this.key] = context;
          window.notify[this.key] = notify;
          window.log.push([this.key, 'init', state]);
        }
        updateView(context) {
          window.log.push([this.key, 'updateView', [...context.updatedProperties]]);
          const ready = window.waiters.filter(([key]) => key === this.key);
          window.waiters = window.waiters.filter(([key]) => key !== this.key);
          for (const [, resolve] of ready) resolve([...context.updatedProperties]);
          window.echo[this.key]?.(context);
        }
        getOutputs() {
          return window.outputs[this.key] ?? {};
        }
        destroy() {
          window.log.push([this.key, 'destroy']);
        }
      },
    );
    // Mounts a recorder control; markup becomes the native field wrapper when given.
    window.mountRecorder = async (key, spec, markup, host = document.body) => {
      let parent = host;
      if (markup !== undefined) {
        parent = document.createElement('div');
        parent.className = 'control';
        parent.dataset.logicalName = key;
        parent.innerHTML = markup;
        host.append(parent);
      }
      const target = document.createElement('div');
      target.dataset.key = key;
      parent.append(target);
      await window.__paqviloPcf.mount(
        {
          id: key,
          constructor: 'Synthetic.Recorder',
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
      return target.id;
    };
    // The lifecycle stages the host recorded for a control (inspect().lifecycle).
    window.stages = (id) => window.__paqviloPcf.inspect(id)[0].lifecycle.map((entry) => entry.stage);
    window.updates = (key) =>
      window.log.filter((entry) => entry[0] === key && entry[1] === 'updateView').map((e) => e[2]);
  });
}

test('invalid static values become parameter errors and input properties carry manifest attributes, Enum values and security', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async () => {
    const id = await window.mountRecorder('inputs', {
      strings: { size_label: 'Size', size_help: 'Pick a size', small_label: 'Small', large_label: 'Large' },
      properties: [
        { name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' },
        { name: 'count', 'of-type': 'Whole.None', usage: 'input', 'default-value': 'many' },
        // Declared values (packet 05 CPCF-063): string values stay strings, numeric ones become numbers.
        {
          name: 'size',
          'of-type': 'Enum',
          usage: 'input',
          required: '1',
          'display-name-key': 'size_label',
          'description-key': 'size_help',
          'default-value': 'large',
          values: [
            { name: 'small', 'display-name-key': 'small_label', value: 'small' },
            { name: 'large', 'display-name-key': 'large_label', value: 'large' },
          ],
        },
        {
          name: 'level',
          'of-type': 'Enum',
          usage: 'input',
          required: 'true',
          'default-value': '2',
          values: [
            { name: 'one', value: '1' },
            { name: 'two', value: '2' },
          ],
        },
        // Today's catalogue imports no <value> declarations: an Enum stays the integer it always was.
        { name: 'shipping', 'of-type': 'Enum', usage: 'input', 'default-value': '3' },
        { name: 'shippingText', 'of-type': 'Enum', usage: 'input', 'default-value': 'text' },
        // A malformed declaration is the parameter's error, not a mount failure.
        { name: 'broken', 'of-type': 'Enum', usage: 'input', values: [{ name: 'bad', value: { nested: true } }] },
      ],
    });
    const parameters = window.contexts.inputs.parameters;
    const summary = (name) => [parameters[name].raw, parameters[name].error, parameters[name].errorMessage];
    return {
      state: window.__paqviloPcf.inspect(id)[0].state,
      count: [...summary('count'), parameters.count.attributes],
      size: [parameters.size.raw, parameters.size.formatted, parameters.size.attributes, parameters.size.security],
      level: [parameters.level.raw, parameters.level.attributes.RequiredLevel, parameters.level.attributes.Options],
      shipping: [...summary('shipping'), parameters.shipping.attributes.Options],
      shippingText: summary('shippingText'),
      broken: [parameters.broken.error, parameters.broken.attributes],
    };
  });
  assert.deepEqual(result, {
    state: 'ready',
    count: [
      null,
      true,
      'PCF Whole.None requires a finite number',
      { DisplayName: 'count', LogicalName: 'count', RequiredLevel: 0, Options: [] },
    ],
    size: [
      'large',
      'Large',
      {
        DisplayName: 'Size',
        LogicalName: 'size',
        RequiredLevel: 1,
        Description: 'Pick a size',
        Options: [
          { Label: 'Small', Value: 'small' },
          { Label: 'Large', Value: 'large' },
        ],
      },
      { readable: true, editable: true, secured: false },
    ],
    level: [
      2,
      1,
      [
        { Label: 'one', Value: 1 },
        { Label: 'two', Value: 2 },
      ],
    ],
    shipping: [3, false, '', []],
    shippingText: [null, true, 'PCF Enum requires a finite number'],
    broken: [true, { DisplayName: 'broken', LogicalName: 'broken', RequiredLevel: 0, Options: [] }],
  });
  assert.deepEqual(errors, []);
});

test('a control mounted in a hidden wrapper starts with isVisible false', async (t) => {
  const { page, errors } = await hostPage(t);
  const visible = await page.evaluate(async () => {
    const hidden = document.createElement('div');
    hidden.style.display = 'none';
    document.body.append(hidden);
    await window.mountRecorder(
      'hidden',
      { args: { value: 'x' }, nativeBinding: { id: 'h', control: 'text', properties: ['value'] } },
      '<input id="h" type="hidden" value="&quot;x&quot;">',
      hidden,
    );
    await window.mountRecorder('shown', {});
    return [window.contexts.hidden.mode.isVisible, window.updates('hidden'), window.contexts.shown.mode.isVisible];
  });
  assert.deepEqual(visible, [false, [[]], true]);
  assert.deepEqual(errors, []);
});

// @test-kind observation: the field host stores an output as the raw value and writes it JSON-encoded to the hidden input, also an output of the wrong type and also for a disabled control (paqvilo-developer pcf-parity capture r2 notify-save statuscode, capture g1 save-wrongtype)
test('outputs of the wrong type are written as they are; a disabled control still writes its output', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async () => {
    const refused = [];
    document.addEventListener('paqvilo:pcf-output-refused', (event) => refused.push(event.detail));
    const id = await window.mountRecorder(
      'whole',
      {
        properties: [{ name: 'value', 'of-type': 'Whole.None', usage: 'bound' }],
        nativeBinding: { id: 'w', control: 'integer', properties: ['value'] },
      },
      '<input id="w" type="hidden" value="5">',
    );
    const fields = [];
    for (const value of ['abc', 1.5]) {
      const update = window.nextUpdate('whole');
      window.outputs.whole = { value };
      window.notify.whole();
      await update;
      fields.push(document.getElementById('w').value);
    }
    const whole = {
      fields,
      field: document.getElementById('w').value,
      raw: window.contexts.whole.parameters.value.raw,
      state: window.__paqviloPcf.inspect(id)[0].state,
    };
    await window.mountRecorder(
      'locked',
      { args: { disabled: true }, nativeBinding: { id: 'r', control: 'text', properties: ['value'] } },
      '<input id="r" type="hidden" value="&quot;Native&quot;">',
    );
    const update = window.nextUpdate('locked');
    window.outputs.locked = { value: 'From control' };
    window.notify.locked();
    return {
      whole,
      locked: {
        updated: await update,
        field: document.getElementById('r').value,
        raw: window.contexts.locked.parameters.value.raw,
        disabled: window.contexts.locked.mode.isControlDisabled,
      },
      refused: refused.map((batch) => batch.map((item) => item.message)),
      recorded: window.__paqviloPcf.inspect(id)[0].refusedOutputs,
    };
  });
  assert.deepEqual(result.whole, { fields: ['"abc"', '1.5'], field: '1.5', raw: 1.5, state: 'ready' });
  assert.deepEqual(result.recorded, []);
  assert.deepEqual(result.locked, { updated: [], field: '"From control"', raw: 'From control', disabled: true });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(errors, []);
});

test('outputs of one turn are delivered in one updateView after the output event', async (t) => {
  const { page, errors } = await hostPage(t);
  const order = await page.evaluate(async () => {
    document.addEventListener('paqvilo:pcf-output', () => window.log.push(['batch', 'output']));
    await window.mountRecorder('batch', {
      properties: [
        { name: 'a', 'of-type': 'SingleLine.Text', usage: 'bound' },
        { name: 'b', 'of-type': 'SingleLine.Text', usage: 'bound' },
      ],
    });
    window.outputs.batch = { a: 'one' };
    window.notify.batch();
    window.outputs.batch = { a: 'one', b: 'two' };
    window.notify.batch();
    await Promise.resolve();
    return window.log.filter((entry) => entry[0] === 'batch').map((entry) => entry.slice(1));
  });
  assert.deepEqual(order, [['init', {}], ['updateView', []], ['output'], ['output'], ['updateView', ['a', 'b']]]);
  assert.deepEqual(errors, []);
});

test('control state saves report success, survive a value change and a failing storage', async (t) => {
  const { page, errors } = await hostPage(t);
  const saved = await page.evaluate(async () => {
    await window.mountRecorder('first', { id: 'pcf-a', stateId: 'pcf-state-x', args: { value: 'One' } });
    return window.contexts.first.mode.setControlState({ page: 3 });
  });
  // After a reload the same control and configuration with another bound value restores the saved state.
  await page.reload();
  await installRecorder(page);
  const result = await page.evaluate(async () => {
    await window.mountRecorder('first', { id: 'pcf-b', stateId: 'pcf-state-x', args: { value: 'Two' } });
    const restored = window.log.find((entry) => entry[0] === 'first' && entry[1] === 'init')[2];
    Storage.prototype.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    const failed = window.contexts.first.mode.setControlState({ page: 4 });
    return { restored, failed, key: Object.keys(sessionStorage) };
  });
  assert.equal(saved, true);
  assert.deepEqual(result, { restored: { page: 3 }, failed: false, key: ['paqvilo-pcf:/:pcf-state-x-1'] });
  assert.deepEqual(errors, []);
});

test('an in-page remount of the same control restores its saved state', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async () => {
    await window.mountRecorder('before', { id: 'pcf-a', stateId: 'pcf-state-y', args: { value: 'One' } });
    window.contexts.before.mode.setControlState({ tab: 2 });
    document.querySelector('[data-key="before"]').remove();
    while (!window.log.some((entry) => entry[0] === 'before' && entry[1] === 'destroy'))
      await new Promise((resolve) => queueMicrotask(resolve));
    await window.mountRecorder('after', { id: 'pcf-b', stateId: 'pcf-state-y', args: { value: 'Two' } });
    return window.log.find((entry) => entry[0] === 'after' && entry[1] === 'init')[2];
  });
  assert.deepEqual(result, { tab: 2 });
  assert.deepEqual(errors, []);
});

test('a page entering the back/forward cache keeps its controls; an unload destroys them', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async () => {
    const id = await window.mountRecorder('life', {});
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    const restored = window.__paqviloPcf.inspect(id).map((entry) => entry.state);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    return {
      restored,
      unloaded: window.__paqviloPcf.inspect(id).map((entry) => entry.state),
      log: window.log.filter((entry) => entry[0] === 'life').map((entry) => entry[1]),
    };
  });
  assert.deepEqual(result, {
    restored: ['ready'],
    unloaded: ['destroyed'],
    log: ['init', 'updateView', 'destroy'],
  });
  assert.deepEqual(errors, []);
});

// @test-kind observation: Power Pages reports allocatedWidth/Height -1 at mount and after trackContainerResize(true), which is followed by one updateView(['layout']) (2026-11-26, paqvilo-developer pcf-parity capture r1 actions-save and edit-full-ny.json DatasetProbe)
test('the allocated size stays -1 before datasets load and trackContainerResize(true) schedules one layout update', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async () => {
    window.shell = { getTokenDeferred: () => ({ done: (resolve) => (resolve('token'), { fail() {} }) }) };
    const target = document.createElement('div');
    target.dataset.key = 'sized';
    target.style.width = '300px';
    document.body.append(target);
    // The dataset request never completes, so the control stays loading.
    window.__paqviloPcf.mount(
      {
        id: 'sized',
        constructor: 'Synthetic.Recorder',
        resources: [],
        strings: {},
        args: {},
        identity: { id: null, roles: [] },
        mappings: { tst_row: { entitySet: 'tst_hangs', idColumn: 'tst_rowid' } },
        properties: [],
        datasets: [
          {
            name: 'items',
            entity: 'tst_row',
            idColumn: 'tst_rowid',
            columns: [],
            fields: {},
            fetchXml: '<fetch><entity name="tst_row"/></fetch>',
          },
        ],
      },
      target,
    );
    while (!window.contexts.sized) await new Promise((resolve) => setTimeout(resolve, 10));
    const context = window.contexts.sized;
    const initial = [context.mode.allocatedWidth, context.mode.allocatedHeight];
    target.style.width = '250px';
    const layout = window.nextUpdate('sized');
    const returned = context.mode.trackContainerResize(true);
    const names = await layout;
    return {
      initial,
      returned,
      names,
      refreshed: [context.mode.allocatedWidth, context.mode.allocatedHeight],
      ready: target.dataset.pcfReady ?? null,
    };
  });
  assert.deepEqual(result, {
    initial: [-1, -1],
    returned: undefined,
    names: ['layout'],
    refreshed: [-1, -1],
    ready: null,
  });
  assert.deepEqual(errors, []);
});
