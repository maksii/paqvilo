// @test-kind contract: provenance traversal keeps using indexed array access when pages override prototype methods.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { installPortalProvenanceRegistry } from '../lense/portal-element-provider.mjs';
import { installDomProvenance } from '../lense/dom-provenance.mjs';

// @test-kind contract: page reassignment of globalThis cannot redirect the captured-native provenance capabilities.
test('provenance initializers retain the browser WindowProxy when globalThis is reassigned', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main>Invented</main>');
  await page.exposeBinding('__inventedAliasBinding', () => {});
  const result = await page.evaluate(
    ({ domSource, portalSource }) => {
      const original = window.globalThis;
      const alias = {};
      try {
        window.globalThis = alias;
        (0, eval)(`(${domSource})`)({
          slot: '__inventedAliasDom',
          secret: 'invented-secret',
          binding: '__inventedAliasBinding',
        });
        (0, eval)(`(${portalSource})`)({ slot: '__inventedAliasPortal', secret: 'invented-secret' });
        return {
          dom: typeof window.__inventedAliasDom,
          portal: typeof window.__inventedAliasPortal,
          aliasKeys: Object.keys(alias),
        };
      } finally {
        window.globalThis = original;
      }
    },
    { domSource: installDomProvenance.toString(), portalSource: installPortalProvenanceRegistry.toString() },
  );
  assert.deepEqual(result, { dom: 'object', portal: 'object', aliasKeys: [] });
});

test('DOM provenance cloning does not invoke a page override of Array.prototype.at', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main><section><span>Invented</span></section></main>');
  await page.exposeBinding('__inventedProvenanceBinding', () => {});
  await page.evaluate(installDomProvenance, {
    slot: '__inventedProvenance',
    secret: 'invented-secret',
    binding: '__inventedProvenanceBinding',
  });
  const calls = await page.evaluate(() => {
    const original = Array.prototype.at;
    let calls = 0;
    Array.prototype.at = function (...args) {
      calls++;
      return Reflect.apply(original, this, args);
    };
    try {
      document.querySelector('main').cloneNode(true);
    } finally {
      Array.prototype.at = original;
    }
    return calls;
  });
  assert.equal(calls, 0);
});

test('portal provenance mutation records do not invoke a page override of the array iterator', async (t) => {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main>Invented</main>');
  await page.evaluate(installPortalProvenanceRegistry, {
    slot: '__inventedPortalProvenance',
    secret: 'invented-secret',
  });
  const result = await page.evaluate(() => {
    const node = document.createElement('div');
    node.setAttribute('data-paqvilo-source', 'invented-node');
    document.body.appendChild(node);
    const original = Array.prototype[Symbol.iterator];
    let calls = 0;
    Array.prototype[Symbol.iterator] = function (...args) {
      calls++;
      return Reflect.apply(original, this, args);
    };
    let evidence;
    try {
      evidence = globalThis.__inventedPortalProvenance.query(node);
    } finally {
      Array.prototype[Symbol.iterator] = original;
    }
    return { calls, id: evidence.node.id };
  });
  assert.deepEqual(result, { calls: 0, id: 'invented-node' });
});
