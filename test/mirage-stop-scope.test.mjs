import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
// Project stop hints: the advertised command stops exactly its runtime from other directories and
// shells, across project edits. Catalogue, standalone and cleanup scopes have their own files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listenerPort } from '../lense/stop-command.mjs';
import { standaloneMirageConfiguration } from '../lense/standalone-mirage.mjs';
import { workspace, fixtureStatusURL, alive, stopped, portalProject } from './mirage-stop-workspace.mjs';

const execute = promisify(execFile);

test(
  'plain project stop hints stay readable and stop only the advertised runtime from other directories and shells',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const project = path.join(work.directory, 'plain project', 'organization.json');
    await fs.mkdir(path.dirname(project));
    await fs.writeFile(
      project,
      JSON.stringify({
        version: 2,
        runtime: { kind: 'model-driven' },
        solutions: [],
        simulation: { level: 'dry-run' },
      }),
    );
    const elsewhere = path.join(work.directory, 'empty replay directory');
    await fs.mkdir(elsewhere);
    const literalProject = path.join(
      work.directory,
      'literal $([char]65) ` %PAQ_HINT% !PAQ_HINT! & ^',
      'organization.json',
    );
    await fs.mkdir(path.dirname(literalProject));
    await fs.copyFile(project, literalProject);
    const nativeShells = process.platform === 'win32' ? ['cmd.exe', 'powershell.exe'] : ['/bin/sh'];
    if (process.platform === 'win32') {
      try {
        await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
          windowsHide: true,
          timeout: 10000,
        });
        nativeShells.push('pwsh.exe');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const started = (file, state) => work.start(['--project', file, '--state', state, '--port', '0']);
    // Every runtime starts up front and concurrently. Each replay must then stop exactly its own
    // runtime while the sibling and every runtime not replayed yet keep answering.
    const [sibling, ...sessions] = await Promise.all([
      started(project, path.join(work.directory, 'sibling.json')),
      ...nativeShells.flatMap((_, index) => [
        started(project, path.join(work.directory, 'selected-' + index + '.json')),
        started(literalProject, path.join(work.directory, 'literal-' + index + '.json')),
      ]),
    ]);
    const running = new Set(sessions);
    const replayStops = async (session, shell) => {
      await work.replay(session.stop, false, elsewhere, shell);
      await stopped(session);
      running.delete(session);
      await Promise.all([sibling, ...running].map(alive));
    };
    for (const [index, shell] of nativeShells.entries()) {
      const [session, literal] = sessions.slice(index * 2, index * 2 + 2);
      assert.match(
        session.stop,
        /^npx paqvilo mirage stop --project /,
        'plain absolute project anchors ownership without an encoded cwd wrapper',
      );
      assert.ok(session.stop.includes(project), 'the selected project is directly reviewable');
      await replayStops(session, shell);
      if (process.platform === 'win32')
        assert.match(literal.stop, /^node -e /, 'Windows shell-active project paths retain fixed encoded argv');
      else {
        assert.match(literal.stop, /^npx paqvilo mirage stop --project '/, 'POSIX literal quoting remains readable');
        assert.ok(
          literal.stop.includes("'" + literalProject + "'"),
          'the complete project path is one literal POSIX argument',
        );
      }
      await replayStops(literal, shell);
    }
  },
);

test('owned status probes admit only a numeric port on the fixed HTTP loopback endpoint', () => {
  assert.equal(fixtureStatusURL({ url: 'http://127.0.0.1:12345' }), 'http://127.0.0.1:12345/_sim/api/status');
  assert.equal(fixtureStatusURL({ url: 'http://127.0.0.1:80/' }), 'http://127.0.0.1:80/_sim/api/status');
  for (const url of [
    'https://127.0.0.1:12345',
    'http://invented.example.invalid:12345',
    'http://127.0.0.1.invented.invalid:12345',
    'http://localhost:12345',
    'http://[::1]:12345',
    'http://2130706433:12345',
    'http://user:secret@127.0.0.1:12345',
    'http://127.0.0.1:12345/other',
    'http://127.0.0.1:12345/?value=invented',
    'http://127.0.0.1:12345/#fragment',
    'http://127.0.0.1:12345/?',
    'http://127.0.0.1:12345/#',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:00123',
    'http://127.0.0.1:12345\\',
    'http://127.0.0.1:12345\n',
    'file:///invented',
  ])
    assert.throws(() => fixtureStatusURL({ url }), /owned HTTP loopback runtime address/);
});

test('standalone settings-only catalogues keep editor settings without claiming a site, and invalid selected sites fail', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-settings-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // Shell settings such as PAQVILO_EDITOR or PAQVILO_SITE would otherwise override the catalogue under test.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PAQVILO_')));
  for (const key of Object.keys(inherited)) delete process.env[key];
  t.after(() => Object.assign(process.env, inherited));
  const config = path.join(directory, 'settings.json');
  await fs.writeFile(config, JSON.stringify({ editor: 'code --profile Invented', sites: {} }));
  const cfg = standaloneMirageConfiguration(null, { config, runtime: 'model-driven' });
  assert.equal(cfg.editor, 'code --profile Invented');
  assert.equal(cfg.catalogueScope, null);
  assert.equal(cfg.stateDir, path.join(process.cwd(), '.paqvilo'));
  assert.throws(
    () => standaloneMirageConfiguration(null, { config, runtime: 'model-driven', site: 'missing' }),
    /Unknown Mirage configuration 'missing'/,
  );
  await fs.writeFile(
    config,
    JSON.stringify({ defaultSite: 'missing', sites: { first: { mirage: { runtime: { kind: 'model-driven' } } } } }),
  );
  assert.throws(
    () => standaloneMirageConfiguration(null, { config, runtime: 'model-driven' }),
    /Unknown Mirage configuration/,
  );
});

test(
  'project stop hints survive valid path remaps, portal renames and removals without selecting a same-source sibling',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'selected.json');
    const other = path.join(path.dirname(config), 'unrelated.json');
    const project = path.join(work.directory, 'external projects', 'editable.json');
    const elsewhere = path.join(work.directory, 'replay edited project here');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.mkdir(elsewhere);
    await work.writeCatalogue(config);
    await work.writeCatalogue(other);
    const before = portalProject(path.join(work.alternate, 'portal'));
    await fs.writeFile(project, JSON.stringify(before));
    const sibling = await work.start([
      '--config',
      other,
      '--project',
      project,
      '--portal',
      'first',
      '--state',
      path.join(work.directory, 'unrelated state.json'),
      '--port',
      '0',
    ]);
    for (const edit of ['path-remap', 'portal-rename', 'portal-remove']) {
      await fs.writeFile(project, JSON.stringify(before));
      const selected = await work.start([
        '--config',
        config,
        '--project',
        project,
        '--portal',
        'first',
        '--state',
        path.join(work.directory, edit + '.json'),
        '--port',
        '0',
      ]);
      const after = structuredClone(before);
      if (edit === 'path-remap') after.portals[0].path = path.join(work.defaults, 'portal');
      else if (edit === 'portal-rename') {
        after.portals[0].id = 'renamed';
        after.defaultPortal = 'renamed';
      } else {
        after.portals.shift();
        after.defaultPortal = 'second';
      }
      await fs.writeFile(project, JSON.stringify(after));
      await work.replay(selected.stop, false, elsewhere);
      await stopped(selected);
      await alive(sibling);
    }
    // The project now lacks portal 'first': every action refuses it. They read the same files
    // and start nothing, so they run together.
    await Promise.all(
      ['start', 'dev', 'inspect'].map(async (action) => {
        const refused = await work.run([
          'mirage',
          action,
          '--config',
          config,
          '--project',
          project,
          '--portal',
          'first',
          ...(action === 'inspect' ? [] : ['--port', '0']),
          ...(action === 'dev' ? [] : ['--json']),
        ]);
        assert.equal(refused.status, 1, refused.stdout + refused.stderr);
        assert.match(
          refused.stdout + refused.stderr,
          /Unknown Mirage portal \\?"first\\?"|Portal 'first' is not configured/,
        );
      }),
    );
  },
);

test(
  'unqualified project stop includes recorded portals absent from current multi- and single-portal mappings',
  { timeout: 90000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'selected.json');
    const other = path.join(path.dirname(config), 'unrelated.json');
    const project = path.join(work.directory, 'external projects', 'editable.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await work.writeCatalogue(config);
    await work.writeCatalogue(other);
    const before = portalProject(path.join(work.alternate, 'portal'));
    await fs.writeFile(project, JSON.stringify(before));
    const sibling = await work.start(['--config', other, '--project', project, '--portal', 'first', '--port', '0']);
    for (const count of [2, 1]) {
      await fs.writeFile(project, JSON.stringify(before));
      const group = await work.start(['--config', config, '--project', project, '--port', '0']);
      await fs.writeFile(
        project,
        JSON.stringify({
          ...before,
          defaultPortal: 'replacement',
          portals: Array.from({ length: count }, (_, index) => ({
            id: index ? 'another' : 'replacement',
            path: path.join(work.defaults, 'portal'),
          })),
        }),
      );
      const report = await work.run(['mirage', 'stop', '--config', config, '--project', project, '--json']);
      assert.equal(report.status, 0, report.stdout + report.stderr);
      assert.deepEqual(
        JSON.parse(report.stdout)
          .stopped.map(({ pid }) => pid)
          .sort(),
        group.portals.map(({ pid }) => pid).sort(),
      );
      for (const session of group.portals) await stopped(session);
      await alive(sibling);
    }
  },
);

test('listener selectors normalize default ports without binding privileged listeners', () => {
  assert.equal(listenerPort('http://127.0.0.1:80'), '80');
  assert.equal(listenerPort('https://localhost:443'), '443');
  assert.equal(listenerPort('http://127.0.0.1:1234'), '1234');
  assert.equal(listenerPort(null), undefined);
});
