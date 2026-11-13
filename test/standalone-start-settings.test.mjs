// @test-kind contract: standalone reuse keeps the effective platform and managed-identity settings in its launch identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const execute = promisify(execFile),
  cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

// Each test starts at most three runtimes, so the per-test limit covers a bounded amount of work.
async function standalone(t) {
  const root = await tempDir('paq-start-settings-');
  const project = path.join(root, 'project.json');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
  const run = async (action, ...extra) =>
    JSON.parse(
      (
        await execute(
          process.execPath,
          [cli, 'mirage', action, '--project', project, '--port', '0', '--json', ...extra],
          {
            cwd: root,
            env,
            windowsHide: true,
          },
        )
      ).stdout,
    );
  // A start whose effective settings differ from the live runtime on the same state file is refused, naming it:
  // the settings are part of the launch identity (an identity without them would reuse that runtime instead).
  const refusedFor = async (owner) => {
    const failure = await run('start').then(
      (value) => assert.fail(`start was not refused: ${JSON.stringify(value)}`),
      (error) => JSON.parse(error.stdout),
    );
    assert.equal(failure.ok, false);
    assert.match(
      failure.error.message,
      new RegExp(`^Mirage pid ${owner.pid} already uses state file .+ with different settings`),
    );
  };
  const otherState = (name) => ['--state', path.join(root, name, 'state.json')];
  const started = [];
  // Every Mirage this test started is stopped through the command under test, not left running.
  ownedFixture(t).add(async () => {
    const { stopped } = await run('stop');
    assert.deepEqual(stopped.map((item) => item.pid).sort(), [...started].sort());
  });
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const write = (limit, mode) =>
    fs.writeFile(
      project,
      JSON.stringify({
        version: 2,
        runtime: { kind: 'dataverse-api' },
        simulation: { level: 'dry-run' },
        solutions: [],
        platform: { QueryLinkEntityLimit: limit, evidence: 'Invented settings-reuse regression' },
        dataverse: { tls: false, tds: { enabled: false }, managedIdentity: { mode } },
      }),
    );
  const status = async (session) => await (await fetch(session.url + '/_sim/api/status')).json();
  const startOwned = async (...extra) => {
    const session = await run('start', ...extra);
    if (session.started) started.push(session.pid);
    return session;
  };
  return { run, refusedFor, otherState, write, status, startOwned };
}

test('standalone reuse with unchanged effective settings returns the running runtime', async (t) => {
  const { write, startOwned } = await standalone(t);
  await write(1, 'imds');
  const first = await startOwned(),
    reused = await startOwned();
  assert.equal(first.started, true);
  assert.equal(reused.started, false);
  assert.equal(reused.pid, first.pid);
});

test('a changed platform setting is part of the launch identity', async (t) => {
  const { write, startOwned, refusedFor, otherState, status } = await standalone(t);
  await write(1, 'imds');
  const first = await startOwned();
  await write(50, 'imds');
  await refusedFor(first);
  const changedPlatform = await startOwned(...otherState('platform'));
  assert.equal(changedPlatform.started, true);
  assert.notEqual(changedPlatform.pid, first.pid);
  assert.equal(
    (await status(changedPlatform)).platformSettings.find((item) => item.key === 'QueryLinkEntityLimit').value,
    50,
  );
  assert.equal((await status(first)).platformSettings.find((item) => item.key === 'QueryLinkEntityLimit').value, 1);
});

test('a changed managed-identity setting is part of the launch identity', async (t) => {
  const { write, startOwned, refusedFor, otherState, status } = await standalone(t);
  await write(50, 'imds');
  const first = await startOwned();
  await write(50, 'appservice');
  await refusedFor(first);
  const changedIdentity = await startOwned(...otherState('identity'));
  assert.equal(changedIdentity.started, true);
  assert.notEqual(changedIdentity.pid, first.pid);
  assert.equal((await status(changedIdentity)).dataverse.managedIdentity.mode, 'appservice');
  assert.equal((await status(first)).dataverse.managedIdentity.mode, 'imds');
});
