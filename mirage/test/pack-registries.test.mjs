import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPackRegistries,
  runWithPackRegistries,
  expressionOperator,
  expressionOperators,
  footerLogoClasses,
  headerNotificationQueries,
} from '../lib/extensions.mjs';
import { discoverPacks } from '../lib/preset-registry.mjs';
import { DataStore } from '../lib/data.mjs';

const pack = (id, extra = {}) => ({
  id,
  name: `Invented ${id}`,
  description: 'Invented pack',
  presets: () => ({}),
  matches: ({ portal }) => portal?.website?.name === id,
  ...extra,
});
const portal = (name) => ({ website: { name } });

test('two runtimes with different packs do not see each other operators or shell conventions', async () => {
  const alpha = pack('fx-alpha', {
    expressionOperators: { alphaDouble: ({ args }) => Number(args[0]) * 2 },
    shell: { footerLogoClass: 'alpha-logos' },
  });
  const beta = pack('fx-beta', {
    expressionOperators: { betaTriple: ({ args }) => Number(args[0]) * 3 },
    shell: { headerNotificationQuery: 'Beta notices' },
  });
  const first = await discoverPacks({ packs: [alpha, beta], portal: portal('fx-alpha') });
  const second = await discoverPacks({ packs: [alpha, beta], portal: portal('fx-beta') });
  assert.deepEqual(
    first.map((item) => item.id),
    ['fx-alpha'],
  );
  runWithPackRegistries(first.registries, () => {
    assert.equal(typeof expressionOperator('alphaDouble'), 'function');
    assert.equal(expressionOperator('betaTriple'), null);
    assert.ok(footerLogoClasses().includes('alpha-logos'));
    assert.equal(headerNotificationQueries().includes('Beta notices'), false);
  });
  runWithPackRegistries(second.registries, () => {
    assert.equal(expressionOperator('alphaDouble'), null);
    assert.deepEqual(
      expressionOperators().filter((item) => item.packId.startsWith('fx-')),
      [{ name: 'betaTriple', packId: 'fx-beta' }],
    );
    assert.equal(footerLogoClasses().includes('alpha-logos'), false);
  });
  // DataStore evaluation inside a runtime scope uses that runtime's operators.
  const store = await new DataStore({
    state: { tables: {}, mappings: {}, permissions: [], plugins: [], settings: { permissionMode: 'permissive' } },
  }).init();
  runWithPackRegistries(second.registries, () => {
    assert.equal(store.evaluate({ op: 'betaTriple', args: [2] }, {}), 6);
    assert.throws(() => store.evaluate({ op: 'alphaDouble', args: [2] }, {}), /Unsupported plugin expression/);
  });
  // Outside any scope every activated runtime stays visible (hosts that have not entered a scope keep working).
  assert.equal(typeof expressionOperator('alphaDouble'), 'function');
  assert.equal(typeof expressionOperator('betaTriple'), 'function');
});

test('a footer class or notification query declared by two matched packs is an error, not an overwrite', () => {
  assert.throws(
    () =>
      createPackRegistries([
        pack('fx-one', { shell: { footerLogoClass: 'shared-logos' } }),
        pack('fx-two', { shell: { footerLogoClass: 'shared-logos' } }),
      ]),
    /Ambiguous shell registration for footerLogoClass:shared-logos in packs fx-one and fx-two/,
  );
  assert.throws(
    () =>
      createPackRegistries([
        pack('fx-one', { shell: { headerNotificationQuery: 'Notices' } }),
        pack('fx-two', { shell: { headerNotificationQuery: 'Notices' } }),
      ]),
    /Ambiguous shell registration for headerNotificationQuery:Notices/,
  );
  assert.throws(
    () =>
      createPackRegistries([
        pack('fx-one', { expressionOperators: { sameName: () => 1 } }),
        pack('fx-two', { expressionOperators: { sameName: () => 2 } }),
      ]),
    /Ambiguous expressionOperators registration for sameName in packs fx-one and fx-two/,
  );
});

test('a pack that does not match the portal registers nothing', async () => {
  const unmatched = pack('fx-unmatched', {
    expressionOperators: { unmatchedOperator: () => 1 },
    shell: { footerLogoClass: 'unmatched-logos' },
  });
  const packs = await discoverPacks({ packs: [unmatched], portal: portal('fx-other') });
  assert.deepEqual(packs, []);
  assert.equal(packs.registries.operators.size, 0);
  assert.equal(expressionOperator('unmatchedOperator'), null);
  assert.equal(footerLogoClasses().includes('unmatched-logos'), false);
});
