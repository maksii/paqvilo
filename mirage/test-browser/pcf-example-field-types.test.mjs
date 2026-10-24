import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import ts from 'typescript';
import { sharedBrowser } from './shared-browser.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
const chrome = sharedBrowser();
const root = new URL('../../examples/project/components/pcf-field-types/', import.meta.url);
test('each manifest field example loads independently and keeps typed outputs, nulls, choices, disabled state and cleanup', async (t) => {
  const server = http.createServer(async (request, response) => {
    if (request.url === '/') return response.end('<!doctype html><main></main>');
    const file = new URL('.' + request.url + (path.extname(request.url) ? '' : '.ts'), root);
    if (!file.href.startsWith(root.href)) return response.writeHead(404).end();
    try {
      const source = await fs.readFile(file, 'utf8');
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText,
      );
    } catch {
      response.writeHead(404).end();
    }
  });
  ownedFixture(t).add(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const page = await chrome.page(t);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const groups = [
    [
      'ExampleText',
      'ExampleEmail',
      'ExampleUrl',
      'ExamplePhone',
      'ExampleTicker',
      'ExampleTextArea',
      'ExampleMultiple',
    ],
    ['ExampleCurrency', 'ExampleDecimal', 'ExampleFloat', 'ExampleWholeNumber'],
    ['ExampleEnum', 'ExampleOptionSet'],
  ];
  for (let kind = 0; kind < groups.length; kind++) {
    for (const name of groups[kind]) {
      const result = await page.evaluate(
        async ({ name, kind }) => {
          const { [name]: Constructor } = await import(`/${name}/index.ts`);
          const instance = new Constructor(),
            container = document.createElement('div');
          document.querySelector('main').replaceChildren(container);
          const context = {
            parameters: {
              controlValue: {
                raw: null,
                attributes: {
                  Options: [
                    { Value: 1, Label: 'First' },
                    { Value: 2, Label: 'Second' },
                  ],
                },
              },
            },
            mode: { isControlDisabled: false },
          };
          let notifications = 0;
          instance.init(context, () => notifications++, {}, container);
          const editor = container.querySelector('input, textarea, select');
          const initial = instance.getOutputs().controlValue;
          const labels = [...container.querySelectorAll('option')].map((option) => option.textContent);
          editor.value = kind === 0 ? 'authored' : '2';
          editor.dispatchEvent(new Event(kind === 2 ? 'change' : 'input'));
          const edited = instance.getOutputs().controlValue;
          context.mode.isControlDisabled = true;
          editor.focus();
          instance.updateView(context);
          const disabled = editor.disabled;
          instance.destroy();
          editor.dispatchEvent(new Event(kind === 2 ? 'change' : 'input'));
          return { initial, edited, notifications, disabled, labels };
        },
        { name, kind },
      );
      assert.equal(result.initial, kind === 0 ? '' : undefined, name);
      assert.equal(result.edited, kind === 0 ? 'authored' : name === 'ExampleEnum' ? '2' : 2, name);
      assert.equal(result.notifications, 1, name + ' removes input handlers on destroy');
      assert.equal(result.disabled, true, name + ' applies disabled changes even while focused');
      if (kind === 2) assert.deepEqual(result.labels, ['', 'First', 'Second'], name);
    }
  }
});
