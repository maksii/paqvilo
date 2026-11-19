// @test-kind security: a hostile page's prototype hooks never obtain the script-provenance writer secret, the notification key or the writer, and cannot forge a script creation callsite
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { isRegistryCall, scriptProvenancePage } from './helpers/script-provenance-page.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const source =
  'window.makeWidget=function(id){const node=document.createElement("button");node.id=id;document.body.append(node);};\n' +
  'makeWidget("created");\n';

// Shared by every hook: records each string a hook observes and, once armed, tries to forge with it. A forged
// notification names the honest callsite of the acknowledged script for the page's own pending node; a claimed writer
// resolves the page's node with a forged proof.
const attacker = `
window.seen = [];
window.writers = 0;
window.forgeries = 0;
const forgedProof = {
  sourceRefs: [{ id: 'web-file:forged:$content', ref: 'web-files/FORGED.js', relationship: 'created-by' }],
  facts: [{ id: 'dom:forged', dimension: 'source', proof: 'observed-dom-callsite', sourceRefIds: ['web-file:forged:$content'] }],
};
window.observe = (value) => {
  // Hooks fire inside this function too: observe each value once, outside nested hook calls.
  if (window.observing) return;
  window.observing = true;
  try {
    inspect(value);
  } finally {
    window.observing = false;
  }
};
const inspect = (value) => {
  const strings = [];
  if (typeof value === 'string') strings.push(value);
  else if (value && typeof value === 'object')
    for (const key of Reflect.ownKeys(value)) {
      const item = Reflect.getOwnPropertyDescriptor(value, key)?.value;
      if (typeof item === 'string') strings.push(item);
    }
  for (const text of strings) {
    window.seen.push(text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (!window.armed) continue;
    const ids = [parsed?.id, value?.id].filter((id) => typeof id === 'string');
    const binding = Object.getOwnPropertyNames(window).find((name) => name.startsWith('__paqviloDomEvent_'));
    for (const candidate of [text, parsed?.key, parsed?.secret, value?.key, value?.secret]) {
      if (typeof candidate !== 'string') continue;
      for (const id of ids) {
        window.forgeries++;
        window[binding](JSON.stringify({ version: 1, key: candidate, secret: candidate, id, relationship: 'created-by', frames: window.legitFrames }));
      }
      const slot = Object.getOwnPropertyNames(window).find((name) => name.startsWith('__paqviloDom_'));
      const writer = window[slot]?.claim(candidate);
      if (writer) {
        window.writers++;
        for (const id of ids) writer.resolve(id, forgedProof);
      }
    }
  }
};
window.mk = (id) => {
  const node = document.createElement('button');
  node.id = id;
  document.body.append(node);
};
`;

const hooks = {
  'toJSON accessors on Object.prototype and Array.prototype': `
for (const prototype of [Object.prototype, Array.prototype])
  Object.defineProperty(prototype, 'toJSON', {
    configurable: true,
    get() {
      window.observe(this);
      if (Array.isArray(this)) for (const item of this) window.observe(item);
      return undefined;
    },
  });`,
  'property accessors on Object.prototype': `
for (const name of ['payload', 'secret', 'key', 'notifyKey', 'frames', 'barrier', 'url', 'urlKey', 'line', 'column', 'relationship', 'reason', 'proof', 'version', 'limits', 'facts', 'sourceRefs'])
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    get() {
      return undefined;
    },
    set(value) {
      window.observe(value);
      window.observe(this);
      Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
    },
  });`,
  'index setters on Array.prototype that replace callsite frames': `
for (let index = 0; index < 16; index++)
  Object.defineProperty(Array.prototype, index, {
    configurable: true,
    set(value) {
      window.observe(value);
      const frame = window.armed && value && typeof value === 'object' && typeof value.url === 'string' ? window.legitFrames[0] : value;
      Object.defineProperty(this, index, { value: frame, writable: true, enumerable: true, configurable: true });
    },
  });`,
};

for (const [name, hook] of Object.entries(hooks))
  test(`page ${name} never obtain the writer or the keys and cannot forge a creation callsite`, async (t) => {
    const keys = new Set();
    let honestFrames;
    const fx = await scriptProvenancePage(t, browser, {
      html: `<!doctype html><html><body><script>${attacker}${hook}</script><script src="/widget.js"></script></body></html>`,
      source,
      onSession(cdp, transport) {
        // The test reads both keys from the transport's own DevTools traffic.
        const send = cdp.send.bind(cdp);
        cdp.send = (method, params) => {
          // The script-provenance claim; the markup registry has its own secret.
          if (isRegistryCall(method, params, transport.domSlot)) keys.add(params.arguments[0].value);
          return send(method, params);
        };
        cdp.on('Runtime.bindingCalled', ({ name, payload }) => {
          if (!name.startsWith('__paqviloDomEvent_')) return;
          const data = JSON.parse(payload);
          // The first notification is the bootstrap's own; later ones may be the page's forgery attempts.
          if (!honestFrames) keys.add(data.key);
          if (data.frames?.[0]?.url?.endsWith('/widget.js')) honestFrames ??= data.frames;
        });
      },
    });
    await fx.page.goto(fx.origin);
    const honest = await fx.verdict('created');
    assert.equal(honest.sourceRefs[0]?.relationship, 'created-by', 'an honest callsite is still proven');
    assert.equal(honest.sourceRefs[0].ref, 'web-files/widget.js');
    assert.ok(honestFrames, 'the honest callsite was notified');
    assert.equal(keys.size, 2, 'the claim secret and the notification key are distinct');
    await fx.page.evaluate((frames) => {
      window.legitFrames = frames;
      window.armed = true;
      window.mk('forged');
    }, honestFrames);
    const forged = await fx.verdict('forged');
    const outcome = await fx.page.evaluate(() => ({ seen: window.seen, writers: window.writers }));
    for (const key of keys)
      assert.equal(
        outcome.seen.some((text) => text.includes(key)),
        false,
        'no page hook observes the claim secret or the notification key',
      );
    assert.equal(outcome.writers, 0, 'no observed value unlocks the writer');
    assert.deepEqual(forged.sourceRefs, [], JSON.stringify(forged));
    assert.deepEqual(forged.facts, []);
  });

test('the notification key does not unlock the writer', async (t) => {
  let notifyKey;
  const fx = await scriptProvenancePage(t, browser, {
    html: '<!doctype html><html><body><script src="/widget.js"></script></body></html>',
    source,
    onSession(cdp) {
      cdp.on('Runtime.bindingCalled', ({ name, payload }) => {
        if (name.startsWith('__paqviloDomEvent_')) notifyKey ??= JSON.parse(payload).key;
      });
    },
  });
  await fx.page.goto(fx.origin);
  await fx.verdict('created');
  assert.match(notifyKey, /^[a-f0-9]{64}$/);
  assert.equal(
    await fx.page.evaluate(({ slot, key }) => window[slot].claim(key), { slot: fx.transport.domSlot, key: notifyKey }),
    null,
  );
});
