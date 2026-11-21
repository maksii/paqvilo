// @test-kind contract: Paqvilo pack export registry: every provider export is recognised before its owning module loads (mirage/docs/data-packs.md)
// Imports pack-exports.mjs alone, so no provider module has registered its real row yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PACK_EXPORTS } from '../lib/pack-exports.mjs';

test('virtualTables is a pending export owned by the virtual table provider module', () => {
  assert.equal(PACK_EXPORTS.virtualTables?.pending, 'dataverse-virtual-providers.mjs');
  assert.equal(PACK_EXPORTS.virtualTableProviders?.pending, 'dataverse-virtual-providers.mjs');
});
