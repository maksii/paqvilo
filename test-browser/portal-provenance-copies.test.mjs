// @test-kind security: a copy a page script makes of a parser original never takes that original's identity, whichever provenance wrapper sees the copy first
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { installDomProvenance } from '../lense/dom-provenance.mjs';
import { installPortalProvenanceRegistry } from '../lense/portal-element-provider.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
const dom = {
  slot: '__inventedCopyDom',
  secret: 'invented-copy-dom-secret',
  notifyKey: 'invented-copy-notify',
  binding: '__inventedCopyBinding',
};
const portal = { slot: '__inventedCopyPortal', secret: 'invented-copy-portal-secret' };
const html =
  '<!doctype html><html><body><div id="box"><button id="original" data-paqvilo-source="invented-mark-1">Invented</button></div>' +
  '<template id="tpl"><b id="inner" data-paqvilo-source="invented-mark-2">Inert</b></template></body></html>';

/** Both registries in `order` (as a session installs them: the recorder first, or the registry first). */
async function stacked(t, order) {
  const context = await browser.newContext();
  ownedFixture(t).add(() => context.close());
  const page = await context.newPage();
  await page.exposeBinding(dom.binding, () => {});
  const recorder = `(${installDomProvenance.toString()})(${JSON.stringify(dom)});`;
  // The registry asks the recorder whether a script made a node only when the recorder is already there.
  const registry = `(${installPortalProvenanceRegistry.toString()})(${JSON.stringify(
    order === 'recorder-first' ? { ...portal, domProvenanceSlot: dom.slot } : portal,
  )});`;
  await context.addInitScript({
    content:
      'window.__natives={clone:Node.prototype.cloneNode,importNode:Document.prototype.importNode,' +
      "cloneDescriptor:Object.getOwnPropertyDescriptor(Node.prototype,'cloneNode')," +
      "importDescriptor:Object.getOwnPropertyDescriptor(Document.prototype,'importNode')};" +
      (order === 'recorder-first' ? recorder + registry : registry + recorder) +
      '\n//# sourceURL=paqvilo-tool://invented-copy-registries',
  });
  await context.route('http://127.0.0.1:34583/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://127.0.0.1:34583/');
  return page;
}

// What each registry says of the parser's elements and of copies a script makes now.
const copies = (page) =>
  page.evaluate(
    ({ dom, portal }) => {
      const original = document.getElementById('original');
      const template = document.getElementById('tpl');
      const made = {
        clone: original.cloneNode(true),
        shallow: original.cloneNode(),
        imported: document.importNode(original, true),
        importedInert: document.importNode(template.content, true).firstChild,
        templateClone: template.cloneNode(true).content.firstChild,
      };
      for (const [id, node] of Object.entries(made)) {
        node.id = id;
        document.body.append(node);
      }
      const reason = (node) => window[portal.slot].query(node).availability[0]?.reason;
      const answer = { original: reason(original), copies: {}, recorded: {} };
      for (const [id, node] of Object.entries(made)) {
        answer.copies[id] = reason(node);
        // The recorder is compared on the copies it records as cloned (a copied template's content is not one).
        if (id !== 'templateClone') answer.recorded[id] = window[dom.slot].isScriptCreated(node);
      }
      answer.same = made.clone.outerHTML === original.outerHTML.replace('id="original"', 'id="clone"');
      return answer;
    },
    { dom, portal },
  );

// Native behaviour of both entry points, through whatever is installed now: errors and copies are the native's.
const native = (page) =>
  page.evaluate(() => {
    const failure = (call) => {
      try {
        call();
        return null;
      } catch (error) {
        return [error.constructor.name, error.name];
      }
    };
    const { clone, importNode } = window.__natives;
    const pairs = [
      [() => Node.prototype.cloneNode.call({}), () => clone.call({})],
      [() => document.importNode(null), () => importNode.call(document, null)],
      [() => document.importNode(document), () => importNode.call(document, document)],
      [() => document.importNode(), () => importNode.call(document)],
    ];
    const text = document.createTextNode('invented');
    return {
      errors: pairs.map(([wrapped, own]) => [failure(wrapped), failure(own)]),
      text: text.cloneNode().data,
      fragment: document.createDocumentFragment().cloneNode(true).nodeType,
    };
  });

for (const order of ['recorder-first', 'registry-first'])
  for (const disposal of ['registry-first', 'recorder-first'])
    test(`stacked copy wrappers (${order} installed, ${disposal} disposed) keep both registries' answers and native behaviour`, async (t) => {
      const page = await stacked(t, order);
      // Shaped like the natives: a method with the native's name, length and descriptor flags.
      assert.deepEqual(
        await page.evaluate(() => {
          const shape = (prototype, name, descriptor) => {
            const current = Object.getOwnPropertyDescriptor(prototype, name);
            let constructs = true;
            try {
              Reflect.construct(String, [], current.value);
            } catch {
              constructs = false;
            }
            return {
              wrapped: current.value !== descriptor.value,
              name: current.value.name === descriptor.value.name,
              length: current.value.length === descriptor.value.length,
              flags: ['writable', 'enumerable', 'configurable'].every((flag) => current[flag] === descriptor[flag]),
              prototype: Object.hasOwn(current.value, 'prototype'),
              constructs,
            };
          };
          return [
            shape(Node.prototype, 'cloneNode', window.__natives.cloneDescriptor),
            shape(Document.prototype, 'importNode', window.__natives.importDescriptor),
          ];
        }),
        Array(2).fill({ wrapped: true, name: true, length: true, flags: true, prototype: false, constructs: false }),
      );
      const revoked = {
        clone: 'node-identity-revoked',
        shallow: 'node-identity-revoked',
        imported: 'node-identity-revoked',
        importedInert: 'node-identity-revoked',
        templateClone: 'node-identity-revoked',
      };
      const recorded = { clone: true, shallow: true, imported: true, importedInert: true };
      // The original is admitted (no proof is published here); every copy is revoked and recorded as cloned.
      assert.deepEqual(await copies(page), {
        original: 'response-proof-not-published',
        copies: revoked,
        recorded,
        same: true,
      });
      const expectedNative = {
        errors: [
          [
            ['TypeError', 'TypeError'],
            ['TypeError', 'TypeError'],
          ],
          [
            ['TypeError', 'TypeError'],
            ['TypeError', 'TypeError'],
          ],
          [
            ['DOMException', 'NotSupportedError'],
            ['DOMException', 'NotSupportedError'],
          ],
          [
            ['TypeError', 'TypeError'],
            ['TypeError', 'TypeError'],
          ],
        ],
        text: 'invented',
        fragment: 11,
      };
      assert.deepEqual(await native(page), expectedNative);
      const dispose = (which) =>
        page.evaluate(
          ({ slot, secret }) => {
            window[slot].claim(secret).dispose();
          },
          which === 'registry' ? portal : dom,
        );
      const [first, second] = disposal === 'registry-first' ? ['registry', 'recorder'] : ['recorder', 'registry'];
      await dispose(first);
      // The registry left installed still sees copies: disposing the other wrapper did not unhook it.
      if (second === 'registry') {
        const answer = await copies(page);
        assert.deepEqual(answer.copies, revoked);
        assert.equal(answer.same, true);
      } else {
        const answer = await copies(page);
        assert.deepEqual(answer.recorded, recorded);
        assert.equal(answer.same, true);
      }
      assert.deepEqual(await native(page), expectedNative);
      await dispose(second);
      // Disposed in the reverse order of installation, both natives are back; otherwise the inner wrapper the outer one
      // restored stays installed and only passes calls through (as after an author override, it is not removed).
      const restored = await page.evaluate(() => [
        Node.prototype.cloneNode === window.__natives.clone,
        Document.prototype.importNode === window.__natives.importNode,
      ]);
      assert.deepEqual(restored, order === disposal ? [false, false] : [true, true]);
      assert.deepEqual(await native(page), expectedNative);
      assert.equal(
        await page.evaluate(() => {
          const original = document.getElementById('original');
          return original.cloneNode(true).outerHTML === original.outerHTML;
        }),
        true,
      );
    });

test('dispose leaves a later author override of cloneNode and importNode in place', async (t) => {
  const page = await stacked(t, 'recorder-first');
  const result = await page.evaluate(({ slot, secret }) => {
    const clone = function cloneNode(deep) {
      return Reflect.apply(window.__natives.clone, this, [deep]);
    };
    const importNode = function importNode(node, deep) {
      return Reflect.apply(window.__natives.importNode, this, [node, deep]);
    };
    Node.prototype.cloneNode = clone;
    Document.prototype.importNode = importNode;
    window[slot].claim(secret).dispose();
    return [Node.prototype.cloneNode === clone, Document.prototype.importNode === importNode];
  }, portal);
  assert.deepEqual(result, [true, true]);
});
