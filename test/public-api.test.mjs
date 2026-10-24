import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('stable public exports remain available until an intentional major version change', async () => {
  const contract = JSON.parse(fs.readFileSync(new URL('./fixtures/public-api.json', import.meta.url)));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  for (const [name, expected] of Object.entries(contract.surfaces)) {
    const actual = await import(name);
    for (const symbol of expected)
      assert.ok(
        Object.hasOwn(actual, symbol) || Number(pkg.version.split('.')[0]) > contract.major,
        `${name}: removed ${symbol} requires a major version change`,
      );
  }
  // Patch upgrades preserve the existing deep imports as well.
  assert.equal(typeof (await import('paqvilo/mirage/server.mjs')).createSimulator, 'function');
  assert.equal(typeof (await import('paqvilo/lense/config.mjs')).loadCatalogue, 'function');
});
