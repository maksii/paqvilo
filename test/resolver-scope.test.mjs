// @test-kind contract: automatic mappings retain the same overridable scope decision as explicit routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalModel } from '../lense/portal-model.mjs';
import { Resolver } from '../lense/resolver.mjs';
import { createFixture, SITE } from './fixture.mjs';

test('resolver: automatic web files use the instance scope decision', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.cleanup());
  const resolver = new Resolver(new PortalModel(fixture.dir), SITE);
  const checked = [];
  resolver.inScope = (file) => {
    checked.push(file);
    return false;
  };
  assert.equal(resolver.resolve('/scripts/app.js'), null);
  assert.deepEqual(checked, [fixture.file('web-files/app.js')]);
});
