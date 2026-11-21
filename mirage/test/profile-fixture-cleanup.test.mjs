// @test-kind tooling: the deployment-profile fixture closes resources registered after its test was stopped
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileFixture } from './fixtures/deployment-profiles.mjs';

test('a resource registered with the deployment-profile fixture after its test was stopped is still closed', async () => {
  const hooks = [],
    controller = new AbortController();
  const fixture = await profileFixture({ after: (hook) => hooks.push(hook), signal: controller.signal });
  controller.abort();
  await Promise.all(hooks.map((hook) => hook()));
  const { promise, resolve } = Promise.withResolvers();
  assert.throws(() => fixture.onCleanup(() => resolve()), /already started/);
  await promise;
});
