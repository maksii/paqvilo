import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { sharedBrowser } from './shared-browser.mjs';
const require = createRequire(import.meta.url);
const browser = sharedBrowser();
const jquery = await fs.readFile(require.resolve('jquery/dist/jquery.js'), 'utf8');
const moment = await fs.readFile(require.resolve('moment/min/moment.min.js'), 'utf8');
const adapters = [
  ['bootstrap-plugins-compat', 'modal'],
  ['datetimepicker-compat', 'datetimepicker'],
  ['jquery-blockui-compat', 'block'],
  ['jqueryui-dialog-compat', 'dialog'],
  ['jqueryui-widgets-compat', 'datepicker'],
];
for (const descriptor of ['plain', 'non-configurable', 'accessor']) {
  for (const group of [...adapters.map((adapter) => [adapter]), adapters, [...adapters].reverse()]) {
    test(`standalone jQuery adapters ${group.map(([name]) => name).join(', ')} survive repeated includes and replacements (${descriptor})`, async (t) => {
      const page = await browser.page(t);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addScriptTag({ content: moment });
      await page.addScriptTag({ content: jquery });
      await page.evaluate((descriptor) => {
        if (descriptor === 'non-configurable')
          Object.defineProperty(window, 'jQuery', { configurable: false, writable: true, value: window.jQuery });
        if (descriptor === 'accessor') {
          let current = window.jQuery;
          Object.defineProperty(window, 'jQuery', {
            configurable: true,
            get: () => current,
            set: (value) => {
              current = value;
            },
          });
        }
      }, descriptor);
      const sources = await Promise.all(
        group.map(([name]) => fs.readFile(new URL(`../lib/${name}.js`, import.meta.url), 'utf8')),
      );
      const verify = async () => {
        assert.deepEqual(
          await page.evaluate(
            (names) => names.map((name) => typeof window.jQuery.fn[name]),
            group.map(([, plugin]) => plugin),
          ),
          group.map(() => 'function'),
        );
      };
      for (const source of sources) await page.addScriptTag({ content: source });
      await verify();
      // A fresh library has a new $.fn object. Writable data globals are watched immediately;
      // accessor/non-configurable globals retain their owner and reattach on a repeated include.
      await page.addScriptTag({ content: jquery });
      if (descriptor === 'plain') await verify();
      for (const source of sources) await page.addScriptTag({ content: source });
      await verify();
      for (const source of sources) await page.addScriptTag({ content: source });
      await verify();
      assert.deepEqual(errors, []);
    });
  }
}
