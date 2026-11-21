// @test-kind contract: mirage status and stop apply one selection rule (lense/commands/mirage.mjs, above miragePaths) to runtime doubles in this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspace, alive, stopped, portalProject } from './helpers/mirage-in-process.mjs';

/** A folder holding a catalogue (site `first`) and an unmapped project file in a sub-folder, the commands run there. */
async function projectFolder(t) {
  const work = await workspace(t);
  const config = path.join(work.cwd, 'paqvilo.config.yml');
  await work.writeCatalogue(config);
  const project = path.join(work.cwd, 'sub', 'x.json');
  await fs.mkdir(path.dirname(project), { recursive: true });
  const single = { ...portalProject(path.join(work.alternate, 'portal')) };
  single.portals = single.portals.slice(0, 1);
  await fs.writeFile(project, JSON.stringify(single));
  return { work, config, project };
}

const json = (result) => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const pidsOf = (items) => items.map((item) => item.pid).sort((a, b) => a - b);

// Started four ways: with no selector, with the catalogue site, with the project file alone, and with both.
const STARTS = {
  bare: (f) => ['--state', path.join(f.work.directory, 'bare.json'), '--port', '0'],
  site: (f) => [
    '--config',
    f.config,
    '--site',
    'first',
    '--state',
    path.join(f.work.directory, 'site.json'),
    '--port',
    '0',
  ],
  project: (f) => ['--project', f.project, '--port', '0'],
  catalogueProject: (f) => [
    '--config',
    f.config,
    '--project',
    f.project,
    '--state',
    path.join(f.work.directory, 'cp.json'),
    '--port',
    '0',
  ],
};
// Called four ways, with the runtimes each selects under the rule.
const CALLS = {
  bare: { args: () => [], selects: ['bare', 'site'] },
  config: { args: (f) => ['--config', f.config], selects: ['bare', 'site'] },
  site: { args: (f) => ['--config', f.config, '--site', 'first'], selects: ['bare', 'site'] },
  project: { args: (f) => ['--project', f.project], selects: ['project', 'catalogueProject'] },
};

for (const [call, { args, selects }] of Object.entries(CALLS))
  test(`status and stop called with ${call} selectors list and stop the same runtimes and report the others`, async (t) => {
    const folder = await projectFolder(t);
    const started = {};
    for (const [name, selectors] of Object.entries(STARTS)) started[name] = await folder.work.start(selectors(folder));
    const expected = pidsOf(selects.map((name) => started[name]));
    const others = pidsOf(
      Object.keys(STARTS)
        .filter((name) => !selects.includes(name))
        .map((name) => started[name]),
    );
    const status = json(await folder.work.run(['mirage', 'status', ...args(folder), '--json']));
    assert.deepEqual(pidsOf(status.sessions), expected, 'status lists the selected runtimes');
    assert.deepEqual(pidsOf(status.others ?? []), others, 'status reports every other runtime it found');
    for (const other of status.others) assert.match(other.status, /mirage status/);
    const text = await folder.work.run(['mirage', 'status', ...args(folder)]);
    assert.match(
      text.stdout,
      new RegExp(`^${others.length} other toolkit-owned Mirage session\\(s\\) outside this selection:`, 'm'),
    );
    const stop = json(await folder.work.run(['mirage', 'stop', ...args(folder), '--json']));
    assert.deepEqual(pidsOf(stop.stopped), expected, 'stop stops exactly what status listed');
    assert.deepEqual(pidsOf(stop.others ?? []), others);
    for (const name of selects) await stopped(started[name]);
    for (const name of Object.keys(STARTS).filter((item) => !selects.includes(item))) await alive(started[name]);
    // Every printed stop hint is accepted by stop and stops its runtime.
    for (const name of Object.keys(STARTS).filter((item) => !selects.includes(item))) {
      await folder.work.replay(started[name].stop);
      await stopped(started[name]);
    }
  });

test('a project start beside an unrelated catalogue prints a readable stop hint and is not that catalogue site', async (t) => {
  const folder = await projectFolder(t);
  const session = await folder.work.start(['--project', folder.project, '--port', '0']);
  assert.match(session.stop, /mirage stop --project /);
  assert.doesNotMatch(session.stop, /^node -e /);
  assert.doesNotMatch(session.stop, /--site|--config/);
  await folder.work.replay(session.stop, folder.work.directory);
  await stopped(session);
});

test('stop and status of a project file that no longer exists still find its runtime and say so', async (t) => {
  const folder = await projectFolder(t);
  const session = await folder.work.start(['--project', folder.project, '--port', '0']);
  await fs.rm(folder.project);
  const status = json(await folder.work.run(['mirage', 'status', '--project', folder.project, '--json']));
  assert.deepEqual(pidsOf(status.sessions), [session.pid]);
  assert.equal(status.projectMissing, folder.project);
  const stop = await folder.work.run(['mirage', 'stop', '--project', folder.project]);
  assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  assert.doesNotMatch(stop.stdout + stop.stderr, /ENOENT/);
  assert.match(stop.stdout, /no longer exists; the runtimes recorded for it were selected/);
  assert.match(stop.stdout, /Stopped 1 toolkit-owned Mirage session/);
  await stopped(session);
});

test('stop, like status, selects by the runtime records when the selected sources no longer exist', async (t) => {
  const folder = await projectFolder(t);
  const session = await folder.work.start(STARTS.site(folder));
  await fs.rm(path.join(folder.work.defaults, 'portal'), { recursive: true, force: true });
  const status = json(await folder.work.run(['mirage', 'status', '--config', folder.config, '--json']));
  assert.deepEqual(pidsOf(status.sessions), [session.pid]);
  const stop = json(await folder.work.run(['mirage', 'stop', '--config', folder.config, '--json']));
  assert.deepEqual(pidsOf(stop.stopped), [session.pid]);
  await stopped(session);
  // A folder without a catalogue selects its own runtimes started without a site, never the toolkit's sample site.
  const empty = path.join(folder.work.directory, 'empty');
  await fs.mkdir(empty);
  for (const action of ['status', 'stop']) {
    const result = await folder.work.run(['mirage', action], empty);
    assert.equal(result.status, 0, `${action}: ${result.stdout}${result.stderr}`);
    assert.match(
      result.stdout,
      /^No (?:Mirage sessions found|toolkit-owned Mirage session for the runtimes started in .+ without a catalogue site)\./,
      action,
    );
  }
});

test('a bare selection in a folder without a catalogue uses that folder alone and names no site', async (t) => {
  const work = await workspace(t);
  const empty = path.join(work.directory, 'empty');
  await fs.mkdir(empty);
  const session = await work.start(['--runtime', 'dataverse-api', '--port', '0'], empty);
  const status = json(await work.run(['mirage', 'status', '--json'], empty));
  assert.deepEqual(pidsOf(status.sessions), [session.pid]);
  const stop = json(await work.run(['mirage', 'stop', '--json'], empty));
  assert.deepEqual(pidsOf(stop.stopped), [session.pid]);
  assert.deepEqual(stop.writesFiles, [path.join(empty, '.paqvilo', 'mirage', 'sessions.json')]);
  assert.equal(
    stop.message,
    `Stopped 1 toolkit-owned Mirage session(s) for the runtimes started in ${empty} without a catalogue site.`,
  );
  await stopped(session);
  // A start or init there is refused as a missing catalogue, never run with the toolkit's sample site.
  for (const action of ['start', 'dev', 'init']) {
    const result = await work.run(['mirage', action], empty);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^paqvilo: No catalogue: .+paqvilo\.config\.yml does not exist\./, action);
  }
  // A stop in a folder that records nothing creates no state there.
  const other = path.join(work.directory, 'other');
  await fs.mkdir(other);
  const nothing = json(await work.run(['mirage', 'stop', '--json'], other));
  assert.deepEqual(nothing.writesFiles, []);
  await assert.rejects(fs.stat(path.join(other, '.paqvilo')), { code: 'ENOENT' });
});

test('a bare stop in a catalogue folder names the site and the runtimes started there without one', async (t) => {
  const folder = await projectFolder(t);
  const session = await folder.work.start(['--runtime', 'dataverse-api', '--port', '0'], folder.work.cwd);
  const stop = json(await folder.work.run(['mirage', 'stop', '--json']));
  assert.deepEqual(pidsOf(stop.stopped), [session.pid]);
  assert.match(stop.message, new RegExp(`for first and the runtimes started in .+ without a catalogue site\\.`));
  await stopped(session);
});

test('a site that maps a project in another folder finds and stops the runtime started with that project', async (t) => {
  const folder = await projectFolder(t);
  await folder.work.writeCatalogue(folder.config, { project: folder.project });
  const session = await folder.work.start(['--project', folder.project, '--port', '0']);
  const status = json(await folder.work.run(['mirage', 'status', '--site', 'first', '--json']));
  assert.deepEqual(pidsOf(status.sessions), [session.pid]);
  const stop = json(await folder.work.run(['mirage', 'stop', '--site', 'first', '--json']));
  assert.deepEqual(pidsOf(stop.stopped), [session.pid]);
  await stopped(session);
});
