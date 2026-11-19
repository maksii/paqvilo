// @test-kind contract: the /_sim/ status of a source reload is Paqvilo's own designed runtime-administration behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// A storage pack whose provider owns a resource with a settle() the test can hold: reload() settles the organization host
// (its providers) before it starts, so a held settle keeps a reload between the source notification and its start. A
// reload pass asks the pack whether it matches the source, which `gate.onMatch` observes.
function heldSettlePack(gate) {
  return {
    id: 'fx-reload',
    name: 'Invented',
    description: 'Invented reload status pack',
    matches: () => {
      gate.onMatch?.();
      return true;
    },
    presets: () => ({}),
    storageProviders: {
      blob: ({ id, own }) => {
        own({ settle: () => gate.hold?.() });
        return {
          descriptor: {
            id,
            kind: 'pack:fx-reload/blob',
            level: 'contract',
            operations: ['put', 'get', 'delete', 'list'],
          },
          put: async () => ({}),
          get: async () => null,
          delete: async () => {},
          list: async () => ({ items: [] }),
        };
      },
    },
  };
}

// A started runtime over a one-page website with an injected watcher (the test emits its notifications) and the held
// settle pack; `release` is resolved before the runtime closes, which settles the host, so a failed assertion cannot
// leave the settle held.
async function startWatchedRuntime(t, { solutionRoots = [] } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'source-reload-status-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented');
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  const gate = {};
  const release = Promise.withResolvers();
  ownedFixture(t).add(() => release.resolve());
  // Every watcher the runtime creates (a change of the solution layers restarts it); the last one is current.
  const watchers = [];
  const sim = await createSimulator({
    sourceDir: dir,
    port: 0,
    solutionRoots,
    providers: { storage: { s1: { kind: 'pack:fx-reload/blob' } }, routes: { annotations: 's1' } },
    packs: [heldSettlePack(gate)],
    sourceWatcher: () => {
      const watcher = new EventEmitter();
      watcher.close = async () => {};
      watchers.push(watcher);
      queueMicrotask(() => watcher.emit('ready'));
      return watcher;
    },
  });
  ownedFixture(t).add(() => sim.close());
  const status = () => fetch(`${sim.adminOrigin}/__sim/api/status`).then((response) => response.json());
  // Opens the runtime's event stream `route`; `matched` resolves once it carries text matching `pattern`.
  const streamed = async (route, pattern) => {
    const stream = await fetch(`${sim.url}${route}`);
    ownedFixture(t).add(() => stream.body.cancel().catch(() => {}));
    const decoder = new TextDecoder();
    const matched = (async () => {
      let text = '';
      for await (const chunk of stream.body) {
        text += decoder.decode(chunk, { stream: true });
        if (pattern.test(text)) return;
      }
    })();
    return { matched };
  };
  return { dir, gate, release, watcher: watchers[0], watchers, sim, status, streamed };
}

test('status reports a source reload as pending from the first notification until the reload publishes', async (t) => {
  const { dir, gate, release, watcher, status, streamed } = await startWatchedRuntime(t);
  const before = await status();
  assert.equal(before.pendingReload, false);
  const entered = Promise.withResolvers();
  gate.hold = () => {
    entered.resolve();
    return release.promise;
  };
  // The reload publishes `reload` on the runtime's event stream.
  const { matched: published } = await streamed('/__sim/events', /event: reload\ndata: \d+/);
  watcher.emit('all', 'change', path.join(dir, 'Home.webpage.yml'));
  // From the notification on: the reload cannot publish while its settle is held.
  assert.equal((await status()).pendingReload, true);
  // reload() is settling the host, before it marks itself running.
  await entered.promise;
  const settling = await status();
  assert.equal(settling.pendingReload, true);
  assert.equal(settling.revision, before.revision);
  gate.hold = null;
  release.resolve();
  await published;
  const after = await status();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.reloading, false);
  assert.equal(after.pendingReload, false);
});

test('a host settle that fails before the reload records RELOAD_FAILED and returns status to idle', async (t) => {
  const { dir, gate, release, watcher, status, streamed } = await startWatchedRuntime(t);
  const before = await status();
  const failuresBefore = before.diagnostics.byCode.RELOAD_FAILED ?? 0;
  // The settle is held, and fails when the test releases it.
  const entered = Promise.withResolvers();
  gate.hold = () => {
    gate.hold = null;
    entered.resolve();
    return release.promise.then(() => {
      throw new Error('Invented settle failure.');
    });
  };
  // The failure is published as a diagnostic log line.
  const { matched: failed } = await streamed('/__sim/events?channels=logs', /"code":"RELOAD_FAILED"/);
  watcher.emit('all', 'change', path.join(dir, 'Home.webpage.yml'));
  await entered.promise;
  assert.equal((await status()).pendingReload, true);
  release.resolve();
  await failed;
  const after = await status();
  assert.equal(after.pendingReload, false);
  assert.equal(after.reloading, false);
  assert.equal(after.revision, before.revision);
  assert.equal(after.diagnostics.byCode.RELOAD_FAILED, failuresBefore + 1);
});

test('a notification during a reload that restarts the watcher runs one more reload, and status returns to idle', async (t) => {
  // The solution root starts as one loose layer; a solution tree added below it changes the layer set, so the reload
  // that reads it restarts the watcher.
  const solution = await makeTemporaryDirectory(path.join(os.tmpdir(), 'source-reload-layers-'));
  ownedFixture(t).remove(() => fs.rm(solution, { recursive: true, force: true }));
  const { dir, gate, watchers, status, streamed } = await startWatchedRuntime(t, { solutionRoots: [solution] });
  const before = await status();
  assert.equal(watchers.length, 1);
  const manifest = path.join(solution, 'invented', 'Other', 'Solution.xml');
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(
    manifest,
    '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  // Inside the first reload pass, before it restarts the watcher: a second source save is reported.
  gate.onMatch = () => {
    gate.onMatch = null;
    watchers.at(-1).emit('all', 'change', path.join(dir, 'Home.webpage.yml'));
  };
  const first = await streamed('/__sim/events', new RegExp(String.raw`event: reload\ndata: ${before.revision + 1}\n`));
  const second = await streamed('/__sim/events', new RegExp(String.raw`event: reload\ndata: ${before.revision + 2}\n`));
  watchers[0].emit('all', 'add', manifest);
  await first.matched;
  assert.equal(watchers.length, 2, 'the changed layer set restarted the watcher');
  // The first pass has published; the save it did not read is read by a further pass, never left pending.
  const between = await status();
  assert.ok(
    between.reloading || between.revision === before.revision + 2,
    `a further reload follows the restart: ${JSON.stringify({ revision: between.revision, reloading: between.reloading, pendingReload: between.pendingReload })}`,
  );
  await second.matched;
  const after = await status();
  assert.equal(after.revision, before.revision + 2);
  assert.equal(after.reloading, false);
  assert.equal(after.pendingReload, false);
});
