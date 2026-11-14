import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { attachmentApi } from './attachment-api-fixture.mjs';
import { routingApi } from './storage-routing-fixture.mjs';
import { ownedFixture, drainFixture } from '../testing/owned-fixture.mjs';

for (const [name, build, prefix] of [
  ['attachment', attachmentApi, 'PAQVILO_ATTACHMENT_FIXTURE_SECRET_'],
  ['storage routing', routingApi, 'PAQVILO_STORAGE_ROUTING_FIXTURE_SECRET_'],
])
  test(`${name} fixture closes its API and removes its per-call secret after another owned closer fails`, async () => {
    const before = new Set(Object.keys(process.env));
    const created = () => Object.keys(process.env).filter((key) => key.startsWith(prefix) && !before.has(key));
    const hooks = [];
    const context = { after: (hook) => hooks.push(hook) };
    const failure = Error('Invented sibling resource failure');
    ownedFixture(context).add(() => {
      throw failure;
    });
    let fixture;
    let close;
    try {
      fixture = await build(context);
      assert.equal(created().length, 1, 'the fixture owns one newly created secret variable');
      let closed = false;
      close = fixture.server.close.bind(fixture.server);
      fixture.server.close = async () => {
        await close();
        closed = true;
      };
      // node:test after hooks stop at the first failed hook. The fixture must keep all owned cleanup in that hook.
      await assert.rejects(
        async () => {
          for (const hook of hooks) await hook();
        },
        (error) => error === failure,
      );
      assert.equal(closed, true, 'one failed closer must not leave the API listening');
      assert.deepEqual(created(), [], 'fixture secrets must not survive a failed sibling close');
    } finally {
      try {
        await drainFixture([() => close?.(), () => fixture?.provider?.close()]);
      } finally {
        for (const key of created()) delete process.env[key];
      }
      // Preserve the fixture directory when draining fails, as ownedFixture does.
      if (fixture?.root) await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
