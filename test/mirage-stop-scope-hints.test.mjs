// @test-kind contract: stop hints retain exact catalogue and project ownership and stop only selected processes
// Multi-portal and Power Pages stop hints keep their catalogue, checkout, state and port selectors,
// and human and JSON output advertise the same exact targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspace, startOnPair, alive, stopped } from './mirage-stop-workspace.mjs';

// Each scenario is its own test, so the per-test limit covers a bounded number of CLI processes and runtimes.
async function multiProject(t) {
  const work = await workspace(t);
  const config = path.join(work.directory, 'catalogue controls', 'custom.json');
  const other = path.join(path.dirname(config), 'unrelated.json');
  const project = path.join(work.directory, 'external projects', 'workspace.json');
  await fs.mkdir(path.dirname(project), { recursive: true });
  await fs.writeFile(
    project,
    JSON.stringify({
      version: 2,
      defaultPortal: 'first',
      portals: ['first', 'second'].map((id) => ({ id, path: path.join(work.alternate, 'portal') })),
      solutions: [],
    }),
  );
  await work.writeCatalogue(config);
  await work.writeCatalogue(other);
  // The sibling: an unrelated catalogue on the same source, which no hint below may stop.
  const sibling = () => work.start(['--config', other, '--repo', work.alternate, '--port', '0']);
  return { work, config, project, sibling };
}

test('multi-project human and JSON hints retain catalogue/project ownership and spare a same-source catalogue', async (t) => {
  const { work, config, project, sibling: startSibling } = await multiProject(t);
  // The sibling listens on any free port; the group on a free pair. Independent launches.
  const [sibling, { base, selected }] = await Promise.all([
    startSibling(),
    startOnPair(work, (base) => ['--config', config, '--project', project, '--port', base]).then(
      ({ base, started }) => ({ base, selected: started }),
    ),
  ]);
  assert.equal(selected.portals.length, 2);
  const human = await work.run(['mirage', 'start', '--config', config, '--project', project, '--port', base]);
  assert.equal(human.status, 0, human.stderr);
  const humanHint = /^Stop:\s+(.+)$/m.exec(human.stdout)?.[1];
  assert.equal(humanHint, selected.stop, 'human and JSON output advertise the same exact targets');
  await work.replay(humanHint);
  for (const session of selected.portals) await stopped(session);
  await alive(sibling);
});

test('a project-only hint never stops an unrelated same-source catalogue', async (t) => {
  const { work, project, sibling: startSibling } = await multiProject(t);
  const sibling = await startSibling();
  const projectOnly = await work.start(['--project', project, '--port', '0']);
  await work.replay(projectOnly.stop);
  for (const session of projectOnly.portals) await stopped(session);
  await alive(sibling);
});

test('an explicit catalogue/project/port stop after a configuration edit stops exactly that group', async (t) => {
  const { work, config, project, sibling: startSibling } = await multiProject(t);
  const sibling = await startSibling();
  const { base, started: manualGroup } = await startOnPair(work, (base) => [
    '--config',
    config,
    '--project',
    project,
    '--port',
    base,
  ]);
  const edited = JSON.parse(await fs.readFile(config, 'utf8'));
  edited.sites.first.mirage.port = Number(base) + 4;
  await fs.writeFile(config, JSON.stringify(edited));
  const explicitRange = await work.run([
    'mirage',
    'stop',
    '--config',
    config,
    '--project',
    project,
    '--port',
    base,
    '--json',
  ]);
  assert.equal(explicitRange.status, 0, explicitRange.stdout + explicitRange.stderr);
  assert.deepEqual(
    JSON.parse(explicitRange.stdout)
      .stopped.map((item) => item.pid)
      .sort(),
    manualGroup.portals.map((item) => item.pid).sort(),
  );
  for (const session of manualGroup.portals) await stopped(session);
  await alive(sibling);
});

test('init next retains the custom catalogue and checkout', async (t) => {
  const work = await workspace(t);
  const config = path.join(work.directory, 'catalogue controls', 'custom.json');
  await work.writeCatalogue(config, { all: true });
  const init = await work.run(['mirage', 'init', '--config', config, '--repo', work.alternate, '--json']);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const nextArgs = JSON.parse((await work.replay(JSON.parse(init.stdout).next, true)).stdout);
  assert.ok(nextArgs.includes(config) && nextArgs.includes(work.alternate));
  assert.deepEqual(nextArgs.slice(-2), ['--portals', 'all']);
});

test('catalogue-all exact batch retains the selected state override', async (t) => {
  const work = await workspace(t);
  const config = path.join(work.directory, 'catalogue controls', 'custom.json');
  const other = path.join(path.dirname(config), 'unrelated.json');
  await work.writeCatalogue(config, { all: true });
  await work.writeCatalogue(other);
  const sibling = await work.start(['--config', other, '--repo', work.alternate, '--port', '0']);
  const state = path.join(work.directory, 'selected override.json');
  const selected = await work.start(['--config', config, '--repo', work.alternate, '--state', state, '--port', '0']);
  const human = await work.run([
    'mirage',
    'start',
    '--config',
    config,
    '--repo',
    work.alternate,
    '--state',
    state,
    '--port',
    '0',
  ]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(/^Stop:\s+(.+)$/m.exec(human.stdout)?.[1], selected.stop);
  await work.replay(selected.stop);
  for (const session of selected.portals) await stopped(session);
  await alive(sibling);
});

async function editedPowerPages(t) {
  const work = await workspace(t);
  const config = path.join(work.directory, 'catalogue controls', 'custom.json');
  await work.writeCatalogue(config);
  const edit = async () => {
    const document = JSON.parse(await fs.readFile(config, 'utf8'));
    document.sites.first.mirage.sourceMaps = false;
    document.sites.first.mirage.port = 65530;
    await fs.writeFile(config, JSON.stringify(document));
  };
  // Both launches follow the same edit and select different states: independent.
  const startPair = () =>
    Promise.all(
      [path.join(work.directory, 'shared state.json'), path.join(work.directory, 'other state.json')].map((file) =>
        work.start(['--config', config, '--repo', work.alternate, '--state', file, '--port', '0']),
      ),
    );
  return { work, config, edit, startPair };
}

test('a single Power Pages hint retains its repo and assigned state after configuration edits', async (t) => {
  const { work, config, edit, startPair } = await editedPowerPages(t);
  // The first launch keeps its own state file: it stays live until its replayed hint stops it, and the
  // pair below must not start on a state file that a live runtime with other settings owns.
  const first = await work.start([
    '--config',
    config,
    '--repo',
    work.alternate,
    '--state',
    path.join(work.directory, 'first state.json'),
    '--port',
    '0',
  ]);
  await edit();
  const [sameState, otherState] = await startPair();
  await work.replay(first.stop);
  await stopped(first);
  await alive(sameState);
  await alive(otherState);
});

test('a broad site stop after configuration edits stops every runtime of that repo and site', async (t) => {
  const { work, config, edit, startPair } = await editedPowerPages(t);
  await edit();
  const [sameState, otherState] = await startPair();
  const broad = await work.run([
    'mirage',
    'stop',
    '--config',
    config,
    '--repo',
    work.alternate,
    '--site',
    'first',
    '--json',
  ]);
  assert.equal(broad.status, 0, broad.stdout + broad.stderr);
  assert.deepEqual(
    JSON.parse(broad.stdout)
      .stopped.map((item) => item.pid)
      .sort(),
    [sameState.pid, otherState.pid].sort(),
  );
  await stopped(sameState);
  await stopped(otherState);
});
