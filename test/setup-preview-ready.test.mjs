// @test-kind contract: the setup page's preview status says "running" for a preview that has answered and is alive, and "starting" only before its first answer
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { previewSessions } from '../lense/setup/preview.mjs';
import { tempDirSync } from './fixture.mjs';

/** A loopback stand-in for a preview runtime: it answers its status read, or holds it while `hold` is set. */
async function runtime(t) {
  const state = { hold: false, fail: false, asked: null };
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith('/_sim/api/status')) return response.writeHead(404).end();
    if (state.fail) return response.writeHead(500).end();
    if (state.hold) return state.asked?.();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ site: 'fixture', pageCount: 1, links: { website: '/' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

test('a running preview whose status read gets no answer in time stays running; one that never answered is starting', async (t) => {
  const dir = tempDirSync('pp-preview-ready-');
  ownedFixture(t).remove(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config = path.join(dir, 'paqvilo.config.yml');
  const answering = await runtime(t);
  const silent = await runtime(t);
  silent.state.hold = true;
  const discovery = path.join(dir, '.paqvilo', 'simulator');
  fs.mkdirSync(discovery, { recursive: true });
  // The recorded process is this test, which is alive; the recorded addresses are the two stand-ins.
  fs.writeFileSync(
    path.join(discovery, `session-${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      portals: [
        { id: 'answering', url: answering.url },
        { id: 'silent', url: silent.url },
      ],
    }),
  );
  // The probe's own limit is the only clock: the test moves it, so no answer "in time" is the test's decision.
  t.mock.timers.enable({ apis: ['AbortSignal.timeout'] });
  const read = async (held) => {
    const asked = held.map(
      (stand) =>
        new Promise((resolve) => {
          stand.state.asked = resolve;
        }),
    );
    const pending = previewSessions({ kind: 'config', file: config });
    // The portals are asked one after the other: each held read ends when the limit passes.
    for (const wait of asked) {
      await wait;
      t.mock.timers.tick(2500);
    }
    return Object.fromEntries((await pending).map((session) => [session.url, session]));
  };
  const first = await read([silent]);
  assert.equal(first[answering.url].ready, true);
  assert.deepEqual(first[answering.url].links, { website: '/' });
  assert.equal(first[silent.url].ready, false, 'a preview that has not answered yet is starting');
  // The same live process gets no answer to one later status read.
  answering.state.hold = true;
  const second = await read([answering, silent]);
  assert.equal(second[answering.url].ready, true, 'a preview that answered before is still running');
  assert.deepEqual(second[answering.url].links, { website: '/' }, 'and keeps the links it reported');
  assert.equal(second[silent.url].ready, false);
  // The first answer of the other one makes it running.
  silent.state.hold = false;
  answering.state.hold = false;
  const third = await read([]);
  assert.equal(third[silent.url].ready, true);
  assert.equal(third[answering.url].ready, true);
});

// @test-kind contract: a running preview whose status read answers with an error is no longer running
test('a running preview that answers its status read with an error is no longer running', async (t) => {
  const dir = tempDirSync('pp-preview-refused-');
  ownedFixture(t).remove(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config = path.join(dir, 'paqvilo.config.yml');
  const answering = await runtime(t);
  const discovery = path.join(dir, '.paqvilo', 'simulator');
  fs.mkdirSync(discovery, { recursive: true });
  fs.writeFileSync(
    path.join(discovery, `session-${process.pid}.json`),
    JSON.stringify({ pid: process.pid, portals: [{ id: 'answering', url: answering.url }] }),
  );
  const first = await previewSessions({ kind: 'config', file: config });
  assert.equal(first[0].ready, true);
  answering.state.fail = true;
  const second = await previewSessions({ kind: 'config', file: config });
  assert.equal(second[0].ready, false, 'an error status is not a running preview');
  assert.equal(second[0].probe, 'refused');
});
