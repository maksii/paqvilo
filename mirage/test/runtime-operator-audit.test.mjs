import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersonaContexts } from '../lib/persona-contexts.mjs';
import { createSimulator } from '../server.mjs';
import { fixture, initial } from './fixtures/platform-experiments.mjs';
import { personaFixture, contactId } from './fixtures/persona-catalog.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

test('warming the persona cache anonymously does not change reported defaults or leak browser sessions', async (t) => {
  const { app } = await personaFixture(t);
  await fetch(app.url + '/SignIn');
  const reports = await Promise.all(
    [1, 2].map(async (number) =>
      fetch(app.url + '/_sim/api/personas', { headers: { cookie: app.signIn(contactId(number)).cookieHeader } }).then(
        (response) => response.json(),
      ),
    ),
  );
  for (let index = 0; index < reports.length; index++) {
    assert.equal(
      reports[index].identity.contactId,
      contactId(1),
      'The admin identity describes the configured runtime default',
    );
    assert.equal(
      reports[index].session.contactId,
      contactId(index + 1),
      'The session belongs to the requesting browser',
    );
  }
  assert.equal(app.state().config.identity.contactId, contactId(1));
});

test('failed context cleanup cannot be reused and does not prevent other runtimes closing', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'context-audit-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const paths = [],
    stopped = [];
  let fail = true;
  const manager = createPersonaContexts({
    directory: root,
    snapshot: async (file) => {
      paths.push(dirname(file));
      await fs.writeFile(file, 'fixture');
    },
    start: async ({ definition }) => ({
      url: 'http://127.0.0.1:1',
      close: async () => {
        if (definition.id === 'one' && fail) throw Error('Synthetic stop failure');
        stopped.push(definition.id);
      },
    }),
  });
  ownedFixture(t).add(() => manager.close());
  const first = await manager.open({ id: 'one' });
  await manager.open({ id: 'two' });
  await assert.rejects(manager.stop(first.id), /Synthetic stop failure/);
  assert.equal(manager.list().items[0].status, 'stopping');
  await assert.rejects(manager.open({ id: 'one' }), (e) => e.code === 'PersonaContextStopping');
  await assert.rejects(
    manager.close(),
    (e) => e instanceof AggregateError && e.errors[0].message === 'Synthetic stop failure',
  );
  assert.deepEqual(stopped, ['two']);
  assert.equal(manager.list().items.length, 1);
  fail = false;
  await manager.close();
  assert.deepEqual(stopped, ['two', 'one']);
  assert.equal(manager.list().items.length, 0);
  for (const directory of paths) await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('operator configuration reads avoid cloning unrelated business tables', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'operator-reads-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);
  const app = await createSimulator({ sourceDir: root, initial: initial(), watch: false });
  ownedFixture(t).add(() => app.close());
  const snapshot = app.store.snapshot.bind(app.store);
  let fullCopies = 0;
  app.store.snapshot = (projection) => {
    if (!projection || projection.sections?.includes('tables')) fullCopies++;
    return snapshot(projection);
  };
  const responses = await Promise.all(
    ['/platform-settings', '/experiments', '/experiments/source-defaults'].map(async (path) => {
      const response = await fetch(app.url + '/__sim/api' + path);
      assert.equal(response.status, 200);
      return response.json();
    }),
  );
  assert.ok(responses[0].some((entry) => entry.key === 'QueryLinkEntityLimit'));
  assert.equal(responses[2].id, 'source-defaults');
  assert.equal(fullCopies, 0);
});

test('a bridge cleanup failure still releases the runtime HTTP listener', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'runtime-close-audit-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fixture(root);
  const app = await createSimulator({ sourceDir: root, initial: initial(), watch: false });
  // Releases the runtime when an assertion fails before the final close below.
  ownedFixture(t).add(() => app.close());
  const close = app.live.close.bind(app.live);
  let fail = true;
  app.live.close = async () => {
    await close();
    if (fail) throw Error('Synthetic bridge cleanup failure');
  };
  await assert.rejects(
    app.close(),
    (e) =>
      e instanceof AggregateError && e.errors.some((cause) => cause.message === 'Synthetic bridge cleanup failure'),
  );
  assert.equal(app.server.listening, false);
  await assert.rejects(fetch(app.url));
  fail = false;
  await app.close();
});
