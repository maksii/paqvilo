// @test-kind contract: a standalone runtime started for a catalogue Power Pages site takes that site's Mirage settings and is selected by status and stop for the site (lense/commands/mirage.mjs selection rule, docs/cli.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workspace, stopped, hintCommands } from './helpers/mirage-in-process.mjs';
import { paqviloPrefix } from '../lense/command-hint.mjs';

const json = (result) => {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const option = (argv, name) => argv[argv.indexOf(name) + 1];

/** A catalogue whose Power Pages site `first` names its own Solution root. */
async function siteCatalogue(work) {
  const config = path.join(work.cwd, 'paqvilo.config.yml');
  const solution = path.join(work.directory, 'solution');
  await fs.mkdir(solution, { recursive: true });
  await fs.writeFile(
    config,
    JSON.stringify({
      sourceRoot: work.defaults,
      defaultSite: 'first',
      sites: {
        first: {
          source: 'portal',
          environments: { dev: 'https://invented.example.invalid' },
          mirage: { solutionRoots: [solution], port: 0 },
        },
      },
    }),
  );
  return { config, solution };
}

test('a standalone start for a catalogue Power Pages site uses its Mirage settings and is that site’s runtime', async (t) => {
  const work = await workspace(t);
  const { config, solution } = await siteCatalogue(work);
  const started = await work.start(['--runtime', 'dataverse-api', '--config', config, '--site', 'first']);
  const { argv } = work.host.runtime(started.pid);
  // The runtime is given the catalogue site, whose data packs it registers (mirage/cli-command.mjs), and its roots.
  assert.equal(option(argv, '--site'), 'first', argv.join(' '));
  assert.equal(path.resolve(option(argv, '--config')), path.resolve(config), argv.join(' '));
  assert.equal(path.resolve(option(argv, '--solution-root')), solution, argv.join(' '));
  for (const selectors of [['--config', config, '--site', 'first'], ['--site', 'first'], []]) {
    const status = json(await work.run(['mirage', 'status', ...selectors, '--json']));
    assert.deepEqual(
      status.sessions.map((item) => item.pid),
      [started.pid],
      `status ${selectors.join(' ')} lists the site's runtime`,
    );
    assert.equal(status.others, undefined);
  }
  const stop = json(await work.run(['mirage', 'stop', '--site', 'first', '--json']));
  assert.deepEqual(
    stop.stopped.map((item) => item.pid),
    [started.pid],
  );
  await stopped(started);
});

test('status labels a runtime with the site it was started for when two sites share one source folder', async (t) => {
  const work = await workspace(t);
  await work.writeCatalogue(path.join(work.cwd, 'paqvilo.config.yml'));
  const two = path.join(work.cwd, 'two.json');
  await fs.writeFile(
    two,
    JSON.stringify({
      sourceRoot: work.defaults,
      defaultSite: 'second',
      // Both sites read the same export folder; `first` comes first, as a folder match would pick it.
      sites: Object.fromEntries(
        ['first', 'second'].map((id) => [
          id,
          {
            source: 'portal',
            environments: { dev: 'https://invented.example.invalid' },
            mirage: { solutionRoots: [], port: 0 },
          },
        ]),
      ),
    }),
  );
  const first = await work.start(['--state', path.join(work.directory, 'first.json')]);
  const second = await work.start([
    '--config',
    two,
    '--site',
    'second',
    '--state',
    path.join(work.directory, 'second.json'),
  ]);
  const status = json(await work.run(['mirage', 'status', '--config', two, '--site', 'second', '--json']));
  assert.deepEqual(
    status.sessions.map((item) => [item.pid, item.site]),
    [[second.pid, 'second']],
  );
  const text = await work.run(['mirage', 'status', '--config', two, '--site', 'second']);
  assert.match(text.stdout, /\[second\]/);
  assert.doesNotMatch(text.stdout, /\[first\]/);
  const bare = json(await work.run(['mirage', 'status', '--json']));
  assert.deepEqual(
    bare.sessions.map((item) => [item.pid, item.site]),
    [[first.pid, 'first']],
  );
  for (const session of [first, second]) {
    await work.replay(session.stop);
    await stopped(session);
  }
});

test('a runtime that exits before it is ready is reported by what it said, without its start-up progress records', async (t) => {
  const work = await workspace(t);
  const project = path.join(work.cwd, 'project.json');
  await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'dataverse-api' }, solutions: [] }));
  work.host.failNextStart(
    '{"type":"runtime-startup","phase":"runtime-module-load","elapsedMs":0}\n' +
      '{"type":"runtime-startup","phase":"preset-library","elapsedMs":152}\n' +
      'A dataverse-api runtime requires its HTTP API to be enabled: remove dataverse.enabled: false.',
  );
  const result = await work.run(['mirage', 'start', '--project', project, '--port', '0']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Mirage exited before it became ready\. See startup log: /);
  assert.match(result.stderr, /requires its HTTP API to be enabled: remove dataverse\.enabled: false\.$/);
  assert.doesNotMatch(result.stdout + result.stderr, /runtime-startup/);
});

test('the hint for a runtime outside the selection selects it, with the prefix every hint of that output uses', async (t) => {
  const work = await workspace(t);
  const { config } = await siteCatalogue(work);
  const project = path.join(work.directory, 'standalone', 'project.json');
  await fs.mkdir(path.dirname(project), { recursive: true });
  await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'dataverse-api' }, solutions: [] }));
  // A project that depends on paqvilo runs it with npx --no-install: every hint of one output says so.
  await fs.writeFile(
    path.join(work.cwd, 'package.json'),
    JSON.stringify({ private: true, devDependencies: { paqvilo: '0.0.0' } }),
  );
  const prefix = paqviloPrefix(work.cwd).join(' ');
  assert.equal(prefix, 'npx --no-install paqvilo');
  const site = await work.start(['--runtime', 'dataverse-api', '--config', config, '--site', 'first']);
  const owned = await work.start(['--project', project, '--port', '0']);
  // Started without a catalogue site or project: the runtime of the folder it was started in.
  const bare = await work.start([
    '--runtime',
    'model-driven',
    '--port',
    '0',
    '--state',
    path.join(work.directory, 'bare.json'),
  ]);
  const pids = (items) => items.map((item) => item.pid).sort((a, b) => a - b);
  const status = json(await work.run(['mirage', 'status', '--project', project, '--json']));
  assert.deepEqual(pids(status.sessions), [owned.pid]);
  assert.deepEqual(pids(status.others), pids([site, bare]));
  for (const other of status.others) {
    assert.ok(other.status.startsWith(`${prefix} mirage status`), other.status);
    // The printed command lists that runtime as selected, not again as one outside its selection.
    const argv = hintCommands(`npx paqvilo ${other.status.slice(prefix.length + 1)}`).commands[0];
    const listed = json(await work.run([...argv, '--json']));
    assert.ok(
      listed.sessions.some((item) => item.pid === other.pid),
      `${other.status} selects ${other.pid}: ${JSON.stringify(listed)}`,
    );
  }
  // One stop output: its stop and status hints all start the same way.
  const text = await work.run(['mirage', 'stop', '--project', project]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const prefixes = text.stdout.match(/\bnpx(?: --no-install)? paqvilo\b|\bnode \S*paqvilo\.mjs\b/g) ?? [];
  assert.ok(prefixes.length >= 2, text.stdout);
  for (const used of prefixes) assert.equal(used, prefix, text.stdout);
  await stopped(owned);
  for (const session of [site, bare]) {
    // A readable stop hint has the same prefix; one that must run in its own folder is an encoded node -e batch.
    if (session.stop.startsWith('node -e ')) await work.replay(session.stop);
    else {
      assert.ok(session.stop.startsWith(`${prefix} mirage stop `), session.stop);
      await work.replay(`npx paqvilo ${session.stop.slice(prefix.length + 1)}`);
    }
    await stopped(session);
  }
});
