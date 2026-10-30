// Standalone host tracing (docs/design/tracing.md, DV-A-9, DV-A-3, DV-B2-15): a /_sim/api write is an http root on the
// `sim` host acting as the simulator, with its refusal's code on the root; reads, the trace routes and the run-starting
// flow routes open no administration root; simulator.trace.flush() is exposed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';

const CLIENT = 'c3d00000-0000-4000-8000-0000000000c1';
const closers = [],
  removers = [];
after(async () => {
  await drainFixture(closers);
  await drainFixture(removers);
});
let shared;
const runtime = () =>
  (shared ??= (async () => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-standalone-'));
    removers.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'solution', 'Other'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'solution', 'Other', 'Solution.xml'),
      '<ImportExportXml><SolutionManifest><UniqueName>InventedStandaloneTrace</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    );
    const sim = await createSimulator({
      runtime: { kind: 'dataverse-api' },
      solutionRoots: [path.join(root, 'solution')],
      projectRoot: root,
      port: 0,
      watch: false,
      simulation: { level: 'dry-run' },
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
      trace: { level: 'full' },
    });
    closers.push(() => sim.close());
    return sim;
  })());
const simApi = async (method, suffix, { body, csrf = true } = {}) => {
  const sim = await runtime();
  const response = await fetch(sim.url + '/_sim/api' + suffix, {
    method,
    headers: { ...(csrf ? { 'x-sim-csrf': sim.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const answer = await response.json();
  return { response, answer };
};

test('a /_sim/api write is a sim root acting as the simulator', async () => {
  const sim = await runtime();
  const { response } = await simApi('POST', '/dataverse/applications', {
    body: { appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] },
  });
  assert.equal(response.status, 201);
  const traceId = response.headers.get('x-trace-id');
  assert.ok(traceId, 'the administration answer names its trace');
  const { root } = await endedTree(sim.trace, traceId);
  assert.deepEqual(
    [root.kind, root.name, root.module, root.origin.host, root.actor.kind, root.actor.name, root.status],
    ['http', 'POST /_sim/api/dataverse/applications', 'sim', 'sim', 'system', 'simulator', 'ok'],
  );
  assert.equal(root.session.sessionKey, null);
});

test('a refused administration write names its code, message and status on the sim root', async () => {
  const sim = await runtime();
  const { response, answer } = await simApi('POST', '/dataverse/session', { body: { userId: CLIENT }, csrf: false });
  assert.equal(response.status, 403);
  const { root } = await endedTree(sim.trace, response.headers.get('x-trace-id'));
  assert.deepEqual(
    [root.origin.host, root.status, root.error.code, root.error.message, root.error.status],
    ['sim', 'denied', answer.error.code, answer.error.message, 403],
  );
});

test('administration reads, the trace routes and the event channel open no root', async () => {
  const before = (await runtime()).trace.status().latestSequence;
  for (const [method, suffix, body] of [
    ['GET', '/status'],
    ['PUT', '/trace/settings', { level: 'full' }],
    ['POST', '/trace/flush'],
  ]) {
    const { response } = await simApi(method, suffix, { body });
    assert.equal(response.headers.get('x-trace-id'), null, `${method} ${suffix}`);
  }
  assert.equal((await runtime()).trace.status().latestSequence, before, 'no span started');
});

test('simulator.trace exposes flush, which settles once the store has written what it queued', async () => {
  const sim = await runtime();
  assert.equal(typeof sim.trace.flush, 'function');
  assert.equal(await sim.trace.flush(), undefined);
});
