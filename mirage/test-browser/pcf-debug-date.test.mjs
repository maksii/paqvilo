import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { drainFixture } from '../testing/owned-fixture.mjs';

test('PCF debugger updates typed instances, native timestamp wires and contains lifecycle failures', async (t) => {
  const runtime = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser, context;
  t.after(() =>
    drainFixture([
      () => context?.close(),
      () => browser?.close(),
      () =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ]),
  );
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  context = await browser.newContext({ timezoneId: 'Europe/Kiev' });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.addScriptTag({ content: runtime });
  const mounted = await page.evaluate(async () => {
    window.destroyed = [];
    window.updates = [];
    window.ComponentFramework.registerControl(
      'Synthetic.DateEditor',
      class {
        init(context, notify, _state, container) {
          this.context = context;
          this.id = container.id;
          this.button = document.createElement('button');
          this.button.textContent = 'Notify';
          this.button.onclick = notify;
          container.append(this.button);
        }
        updateView(context) {
          this.context = context;
          window.updates.push({
            id: this.id,
            updated: context.updatedProperties,
            raw: context.parameters.value.raw?.toISOString() ?? null,
          });
        }
        getOutputs() {
          if (this.context.parameters.fault.raw === 'getOutputs') throw new Error('Synthetic output failure');
          return { value: this.context.parameters.value.raw };
        }
        destroy() {
          window.destroyed.push(this.id);
        }
      },
    );
    const declarations = [
      ['date-local', 'date', 'UserLocal'],
      ['datetime-local', 'datetime', 'UserLocal'],
      ['date-independent', 'date', 'DateOnly'],
      ['datetime-independent', 'datetime', 'TimeZoneIndependent'],
    ];
    const result = [];
    for (const [fieldId, kind, behavior] of declarations) {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-pcf-native-field', fieldId);
      const field = document.createElement('input');
      field.id = fieldId;
      field.setAttribute('data-ui', 'datetimepicker');
      field.dataset.type = kind;
      field.dataset.behavior = behavior;
      const target = document.createElement('div');
      wrapper.append(field, target);
      document.body.append(wrapper);
      await window.__paqviloPcf.mount(
        {
          id: 'date-editor',
          constructor: 'Synthetic.DateEditor',
          resources: [],
          properties: [
            {
              name: 'value',
              'of-type': kind === 'date' ? 'DateAndTime.DateOnly' : 'DateAndTime.DateAndTime',
              usage: 'bound',
            },
            { name: 'fault', 'of-type': 'SingleLine.Text', usage: 'input' },
          ],
          args: {},
          strings: {},
          mappings: {},
          identity: { id: null, roles: [] },
          language: { code: 'en-US', lcid: 1033 },
          nativeBinding: { id: fieldId, properties: ['value'] },
        },
        target,
      );
      const date = new Date(2026, 9, 10, kind === 'date' ? 0 : 12, 0, 0, 125);
      window.__paqviloPcf.updateParameters(target.id, { value: date });
      target.querySelector('button').click();
      result.push({ id: target.id, fieldId, value: field.value });
    }
    return result;
  });
  assert.deepEqual(
    mounted.map((item) => item.value),
    [
      '2026-10-09T21:00:00.0000000Z',
      '2026-10-10T09:00:00.1250000Z',
      '2026-10-10T00:00:00.0000000',
      '2026-10-10T12:00:00.1250000',
    ],
  );
  assert.equal(new Set(mounted.map((item) => item.id)).size, 4);
  const before = await page.evaluate(() => window.__paqviloPcf.inspect());
  assert.equal(before.length, 4);
  assert.ok(
    before.every(
      (item) =>
        item.state === 'ready' &&
        item.lifecycle.some((event) => event.stage === 'debug:updateView') &&
        item.lifecycle.some((event) => event.stage === 'getOutputs'),
    ),
  );
  await page.evaluate(() => window.__paqviloPcf.openDebugger());
  const dialog = page.getByRole('dialog', { name: 'Code component debugger' });
  await dialog.getByLabel('Code component instance').selectOption(mounted[2].id);
  await dialog
    .getByLabel('Parameter values (JSON)')
    .fill(JSON.stringify({ value: '2027-01-20T00:00:00+02:00', fault: null }));
  await dialog.getByRole('button', { name: 'Apply parameters' }).click();
  assert.equal(await dialog.getByRole('status').textContent(), 'Parameters applied.');
  assert.equal(await page.locator('#date-independent').inputValue(), '2027-01-20T00:00:00.0000000');
  assert.equal(await page.locator('#date-local').inputValue(), mounted[0].value);
  await dialog.getByLabel('Parameter values (JSON)').fill('{broken');
  await dialog.getByRole('button', { name: 'Apply parameters' }).click();
  assert.match(await dialog.getByRole('status').textContent(), /JSON|property name/i);
  await dialog.getByRole('button', { name: 'Refresh state' }).click();
  assert.equal(
    JSON.parse(await dialog.getByLabel('Parameter values (JSON)').inputValue()).value,
    '2027-01-19T22:00:00.000Z',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await dialog.isVisible(), false);
  const invalid = await page.evaluate((id) => {
    try {
      window.__paqviloPcf.updateParameters(id, { fault: 'should-not-apply', value: 'invalid-date' });
    } catch (error) {
      return { message: error.message, state: window.__paqviloPcf.inspect(id)[0] };
    }
  }, mounted[0].id);
  assert.match(invalid.message, /date parameter is invalid/);
  assert.equal(invalid.state.parameters.fault.raw, null);
  assert.equal(invalid.state.state, 'ready');
  await page.evaluate((id) => {
    window.__paqviloPcf.updateParameters(id, { fault: 'getOutputs' });
    document.getElementById(id).querySelector('button').click();
  }, mounted[1].id);
  const failed = await page.evaluate((id) => window.__paqviloPcf.inspect(id)[0], mounted[1].id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'Synthetic output failure');
  assert.ok(failed.lifecycle.some((event) => event.stage === 'destroy'));
  await page.evaluate((id) => document.getElementById(id).remove(), mounted[0].id);
  await page.waitForFunction((id) => window.__paqviloPcf.inspect(id)[0]?.state === 'destroyed', mounted[0].id);
  const destroyed = await page.evaluate(() => window.destroyed);
  assert.equal(destroyed.filter((id) => id === mounted[0].id).length, 1);
  assert.equal(destroyed.filter((id) => id === mounted[1].id).length, 1);
  const boundaries = await page.evaluate(async () => {
    window.snapshotGetterReads = 0;
    window.ComponentFramework.registerControl(
      'Synthetic.HostileOutput',
      class {
        init(context, notify, _state, container) {
          this.context = context;
          const button = document.createElement('button');
          button.onclick = notify;
          container.append(button);
        }
        updateView(context) {
          const value = {};
          Object.defineProperty(value, 'hostile', {
            enumerable: true,
            get() {
              window.snapshotGetterReads++;
              throw new Error('Snapshot getter must not mask component failure');
            },
          });
          context.parameters.value.raw = value;
        }
        getOutputs() {
          throw 'Plain component failure';
        }
        destroy() {
          throw {
            toString() {
              throw new Error('Unprintable thrown object');
            },
          };
        }
      },
    );
    const target = document.createElement('div');
    document.body.append(target);
    const base = {
      id: 'boundary',
      constructor: 'Synthetic.HostileOutput',
      resources: [],
      properties: [{ name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' }],
      args: {},
      strings: {},
      mappings: {},
      identity: { id: null, roles: [] },
    };
    await window.__paqviloPcf.mount(base, target);
    const before = window.__paqviloPcf.inspect(target.id)[0];
    target.querySelector('button').click();
    const failed = window.__paqviloPcf.inspect(target.id)[0];
    const mixed = document.createElement('div');
    document.body.append(mixed);
    await window.__paqviloPcf.mount(
      { ...base, properties: [{ name: 'value', types: ['SingleLine.Text', 'DateAndTime.DateOnly'], usage: 'bound' }] },
      mixed,
    );
    return { before, failed, mixed: window.__paqviloPcf.inspect(mixed.id)[0], getterReads: window.snapshotGetterReads };
  });
  assert.equal(boundaries.before.parameters.value.raw.hostile, '[accessor]');
  assert.equal(boundaries.getterReads, 0);
  assert.equal(boundaries.failed.state, 'failed');
  assert.equal(boundaries.failed.error, 'Plain component failure');
  assert.match(boundaries.mixed.error, /ambiguous type-group/);
  assert.equal(boundaries.mixed.state, 'failed');
  const outputFailures = await page.evaluate(async () => {
    const result = [];
    window.ComponentFramework.registerControl(
      'Synthetic.BadOutput',
      class {
        init(context, notify, _state, container) {
          this.context = context;
          this.id = container.id;
          const button = document.createElement('button');
          button.onclick = notify;
          container.append(button);
        }
        updateView() {}
        getOutputs() {
          const value = {};
          if (this.context.parameters.mode.raw === 'cycle') value.self = value;
          else
            Object.defineProperty(value, 'nested', {
              enumerable: true,
              get() {
                throw new Error('Nested output getter failed');
              },
            });
          return { value };
        }
        destroy() {
          window.destroyed.push(this.id);
        }
      },
    );
    for (const mode of ['cycle', 'getter']) {
      const target = document.createElement('div');
      document.body.append(target);
      await window.__paqviloPcf.mount(
        {
          id: 'output-failure',
          constructor: 'Synthetic.BadOutput',
          resources: [],
          properties: [
            { name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' },
            { name: 'mode', 'of-type': 'SingleLine.Text', usage: 'input' },
          ],
          args: { mode },
          strings: {},
          mappings: {},
          identity: { id: null, roles: [] },
        },
        target,
      );
      target.querySelector('button').click();
      result.push({
        debug: window.__paqviloPcf.inspect(target.id)[0],
        destroys: window.destroyed.filter((id) => id === target.id).length,
      });
    }
    return result;
  });
  assert.ok(outputFailures.every((item) => item.debug.state === 'failed' && item.destroys === 1));
  assert.match(outputFailures[0].debug.error, /circular|cyclic/i);
  assert.equal(outputFailures[1].debug.error, 'Nested output getter failed');
  assert.deepEqual(errors, []);
});
