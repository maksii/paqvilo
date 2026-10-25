import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedBrowser } from './shared-browser.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { resolveInspectionEvidence } from '../../lense/inspection-evidence.mjs';
import { modelDrivenObservationRuntime } from '../../lense/model-driven-observation.mjs';

const chrome = sharedBrowser();
const scope = { documentId: 'invented-document', frameId: 'top', uiEpoch: 1, sourceRevision: '1' };

test('actual installed Mirage registry cannot acquire an unbound owner through WeakMap prototype tampering', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const packets = await page.evaluate((scope) => {
    const node = document.createElement('div');
    document.body.append(node);
    const reader = window.__paqviloMirageProvenance;
    const before = reader.query(node, { scope, anchorGeneration: 1 });
    const original = WeakMap.prototype.get;
    let calls = 0;
    let after;
    try {
      WeakMap.prototype.get = function () {
        calls++;
        return {
          lifetime: 'document',
          coverage: 'self',
          owner: { kind: 'control', key: 'control:forged', name: 'Forged owner' },
          sourceKeys: [],
          sourceRefs: [],
          facts: [],
          context: [],
          availability: [],
          generation: 999,
        };
      };
      after = reader.query(node, { scope, anchorGeneration: 1 });
    } finally {
      WeakMap.prototype.get = original;
      node.remove();
    }
    return { before, after, calls };
  }, scope);
  const resolve = (packet) => resolveInspectionEvidence({ ...packet, node: { connected: true } });
  assert.equal(resolve(packets.before).owner.status, 'unavailable');
  assert.equal(
    resolve(packets.after).owner.status,
    'unavailable',
    'page-provided prototype results never become private writer evidence',
  );
  assert.equal(packets.calls, 0, 'the private WeakMap never calls the authored replacement');
});

test('query packets cannot mutate private actual-node owner and source snapshots', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const cell = page.locator('td[data-id="x_name"]').first();
  await cell.waitFor();
  const result = await cell.evaluate((node, scope) => {
    const reader = window.__paqviloMirageProvenance;
    const first = reader.query(node, { scope, anchorGeneration: 1 });
    const expected = structuredClone(first);
    first.facts[0].binding.key = 'control:forged';
    first.facts[0].binding.name = 'Forged owner';
    if (first.sourceRefs[0]) first.sourceRefs[0].contentRevision = 'forged-revision';
    if (first.sourceRefs[0]?.region) first.sourceRefs[0].region.start = 999999;
    return { expected, actual: reader.query(node, { scope, anchorGeneration: 1 }) };
  }, scope);
  assert.deepEqual(result.actual, result.expected, 'public metadata is detached from private bindings');
});

test('model-driven provider query snapshots cannot rewrite cached source regions or limits', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const cell = page.locator('td[data-id="x_name"]').first();
  await cell.waitFor();
  await page.evaluate(() => {
    window.Xrm = {
      Utility: { getPageContext: () => ({ input: { pageType: 'entitylist', entityName: 'x_item' } }) },
      Page: { data: { entity: { getEntityName: () => 'x_item' } }, ui: {} },
    };
  });
  await page.evaluate(new Function('data', `return (${modelDrivenObservationRuntime.toString()})().install(data);`), {
    origin,
    token: 'invented-cache',
    validatedScope: scope,
    validatedAnchorGeneration: 1,
    sourceRefs: [
      {
        id: 'source-a',
        sourceKey: 'key-a',
        componentKey: 'column:x_item:x_name',
        ref: 'Entities/x_item/Entity.xml',
        region: { start: 4, end: 9 },
        sourceRevision: '1',
        contentRevision: 'content-a',
      },
    ],
    limits: { truncated: false },
  });
  const result = await cell.evaluate((node, scope) => {
    const provider = window.__paqviloModelDrivenProvider;
    const first = provider.query(node, { scope, anchorGeneration: 1 }),
      expected = structuredClone(first);
    first.sourceRefs[0].region.start = 999999;
    first.limits.metadata.truncated = true;
    return { expected, actual: provider.query(node, { scope, anchorGeneration: 1 }) };
  }, scope);
  assert.deepEqual(result.actual, result.expected, 'read-only query metadata never mutates the current cache');
});

test('registry writer leases and metadata copies retain captured intrinsics after customization overrides', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const result = await page.evaluate(
    async ({ asset, scope }) => {
      const { createModelDrivenProvenanceRegistry, modelDrivenKey } = await import(asset);
      const writer = createModelDrivenProvenanceRegistry(document);
      const node = document.createElement('input');
      document.body.append(node);
      const lease = writer.beginUI();
      const define = Object.defineProperty,
        descriptor = Object.getOwnPropertyDescriptor;
      const replacements = [
        [WeakMap.prototype, 'get'],
        [WeakMap.prototype, 'set'],
        [WeakMap.prototype, 'delete'],
        [Set.prototype, 'has'],
        [Set.prototype, 'add'],
        [Array.prototype, 'map'],
        [Array.prototype, 'filter'],
        [Array.prototype, 'slice'],
        [Array.prototype, 'push'],
        [Array.prototype, Symbol.iterator],
        [String.prototype, 'replace'],
        [String.prototype, 'toLowerCase'],
        [String.prototype, 'slice'],
        [Object, 'freeze'],
        [Object, 'keys'],
        [Object, 'entries'],
        [Object, 'fromEntries'],
        [Object, 'getPrototypeOf'],
        [Object, 'getOwnPropertyDescriptor'],
        [Object, 'getOwnPropertyDescriptors'],
        [Object, 'defineProperty'],
        [Array, 'isArray'],
        [Number, 'isFinite'],
        [globalThis, 'structuredClone'],
      ].map(([object, key]) => ({ object, key, original: descriptor(object, key) }));
      let hooks = 0,
        reads = 0,
        packet,
        stale,
        expired,
        context,
        afterRelease,
        key;
      const input = {
        owner: { kind: 'column', key: 'column:sample_item:sample_name', name: 'sample_name', entity: 'sample_item' },
        sourceRefs: [{ id: 'source-a', region: { start: 4, end: 8 }, sourceRevision: '1' }],
        sourceKeys: ['column:sample_item:sample_name'],
        context: [],
        facts: [],
      };
      define(input.owner, 'row', {
        get() {
          reads++;
          return 'PRIVATE_ROW';
        },
        enumerable: true,
      });
      try {
        for (let i = 0; i < replacements.length; i++)
          define(replacements[i].object, replacements[i].key, {
            value: function () {
              hooks++;
              throw Error('Authored intrinsic replacement');
            },
            configurable: true,
            writable: true,
          });
        const release = writer.bind(node, input, lease);
        writer.setContext({ state: 'ready', form: { id: 'known-form' }, recordId: 'PRIVATE_ROW' }, lease);
        context = writer.reader.context();
        context.form.id = 'forged-form';
        context = writer.reader.context();
        packet = writer.reader.query(node, { scope, anchorGeneration: 2 });
        key = modelDrivenKey('form', '{FORM-A}');
        writer.beginUI();
        expired = writer.update(node, input, lease);
        stale = writer.reader.query(node, { scope, anchorGeneration: 2 });
        release();
        afterRelease = writer.reader.query(node, { scope, anchorGeneration: 2 });
      } finally {
        for (let i = 0; i < replacements.length; i++)
          define(replacements[i].object, replacements[i].key, replacements[i].original);
        node.remove();
      }
      return { hooks, reads, packet, stale, expired, context, afterRelease, key };
    },
    { asset: origin + '/_apps/assets/provenance-registry.mjs', scope },
  );
  assert.equal(result.hooks, 0);
  assert.equal(result.reads, 0, 'metadata copies never invoke an authored value getter');
  assert.equal(result.packet.facts[0].binding.key, 'column:sample_item:sample_name');
  assert.equal(result.context.form.id, 'known-form');
  assert.equal(result.key, 'form:form-a');
  assert.equal(result.expired, false);
  assert.equal(result.stale.facts[0].stale, true);
  assert.equal(result.afterRelease.facts.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ROW|forged-form/);
});

test('page-writable parent and connected properties cannot transfer actual-node registry identity', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  const cell = page.locator('td[data-id="x_name"]').first();
  await cell.waitFor();
  const result = await cell.evaluate((node, scope) => {
    const reader = window.__paqviloMirageProvenance,
      forged = document.createElement('div');
    document.body.append(forged);
    let reads = 0;
    Object.defineProperty(forged, 'parentElement', {
      get() {
        reads++;
        return node;
      },
    });
    const forgedPacket = reader.query(forged, { scope, anchorGeneration: 1 });
    const originalParent = node.parentNode;
    node.remove();
    Object.defineProperty(node, 'isConnected', {
      get() {
        reads++;
        return true;
      },
      configurable: true,
    });
    const detachedPacket = reader.query(node, { scope, anchorGeneration: 1 });
    delete node.isConnected;
    originalParent.append(node);
    forged.remove();
    return { reads, forgedPacket, detachedPacket };
  }, scope);
  assert.equal(result.reads, 0);
  for (const packet of [result.forgedPacket, result.detachedPacket]) assert.equal(packet.facts.length, 0);
  assert.equal(result.detachedPacket.availability[0].reason, 'node-document-unavailable');
});
