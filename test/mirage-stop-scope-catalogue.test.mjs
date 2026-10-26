// Catalogue site/portal scope: shared IDs and runtime dispatch never broaden a stop, and legacy
// ownership records without a catalogue marker require exact selectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { miragePaths } from '../lense/commands/mirage.mjs';
import { listenerPort } from '../lense/stop-command.mjs';
import { workspace, alive, stopped } from './mirage-stop-workspace.mjs';

test(
  'catalogue site/portal ID collisions never broaden project stop and ambiguous legacy records require exact selectors',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'shared.json');
    const project = path.join(work.directory, 'external projects', 'shared.json');
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
    await work.writeCatalogue(config, { all: true, project });
    const catalogue = JSON.parse(await fs.readFile(config, 'utf8'));
    catalogue.portals = 'selected';
    await fs.writeFile(config, JSON.stringify(catalogue));
    const firstArgs = ['--config', config, '--site', 'first', '--project', project, '--portal', 'first', '--port', '0'];
    const secondArgs = [
      '--config',
      config,
      '--site',
      'second',
      '--project',
      project,
      '--portal',
      'second',
      '--port',
      '0',
    ];
    // Different catalogue sites and portals: independent launches.
    const [first, second] = await Promise.all([work.start(firstArgs), work.start(secondArgs)]);
    const reused = await work.start(firstArgs);
    assert.equal(reused.pid, first.pid);
    assert.equal(reused.started, false);
    const broadArgs = ['mirage', 'stop', '--config', config, '--site', 'first', '--project', project, '--json'];
    const wrongSite = await work.run([
      ...broadArgs,
      '--portal',
      'second',
      '--state',
      second.stateFile,
      '--port',
      listenerPort(second.url),
    ]);
    assert.equal(wrongSite.status, 0, wrongSite.stdout + wrongSite.stderr);
    assert.deepEqual(
      JSON.parse(wrongSite.stdout).stopped,
      [],
      'exact selectors never bypass a marked catalogue-site mismatch',
    );
    await alive(second);
    const modern = await work.run(broadArgs);
    assert.equal(modern.status, 0, modern.stdout + modern.stderr);
    assert.deepEqual(
      JSON.parse(modern.stdout).stopped.map(({ pid }) => pid),
      [first.pid],
    );
    await alive(second);
    const restarted = await work.start(firstArgs);
    const paths = miragePaths({ stateDir: path.join(path.dirname(config), '.paqvilo') });
    const records = JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8'));
    for (const entry of records.sessions) {
      delete entry.identity.scope.version;
      delete entry.identity.scope.catalogueSite;
    }
    await fs.writeFile(paths.ownershipFile, JSON.stringify(records));
    const modernAfterLegacy = await work.start(firstArgs);
    assert.notEqual(modernAfterLegacy.pid, restarted.pid, 'markerless scope cannot satisfy the new identity for reuse');
    assert.equal(modernAfterLegacy.started, true);
    const ambiguous = await work.run(broadArgs);
    assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
    assert.match(JSON.parse(ambiguous.stdout).error.message, /legacy.*ownership.*ambiguous/i);
    const requestedZero = await work.run([...broadArgs, '--state', restarted.stateFile, '--port', '0']);
    assert.equal(requestedZero.status, 1, requestedZero.stdout + requestedZero.stderr);
    assert.match(JSON.parse(requestedZero.stdout).error.message, /legacy.*ownership.*ambiguous/i);
    await alive(restarted);
    await alive(modernAfterLegacy);
    await alive(second);
    await work.replay(restarted.stop);
    await stopped(restarted);
    await work.replay(modernAfterLegacy.stop);
    await stopped(modernAfterLegacy);
    await alive(second);
    const oneSite = structuredClone(catalogue);
    delete oneSite.sites.first;
    oneSite.defaultSite = 'second';
    await fs.writeFile(config, JSON.stringify(oneSite));
    const unambiguous = await work.run([
      'mirage',
      'stop',
      '--config',
      config,
      '--site',
      'second',
      '--project',
      project,
      '--json',
    ]);
    assert.equal(unambiguous.status, 0, unambiguous.stdout + unambiguous.stderr);
    assert.deepEqual(
      JSON.parse(unambiguous.stdout).stopped.map(({ pid }) => pid),
      [second.pid],
    );
    const overridden = structuredClone(catalogue);
    delete overridden.sites.second.mirage.project;
    await fs.writeFile(config, JSON.stringify(overridden));
    const override = await work.start([
      '--config',
      config,
      '--site',
      'second',
      '--project',
      project,
      '--portal',
      'first',
      '--port',
      '0',
    ]);
    const overriddenRecords = JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8'));
    const legacyOverride = overriddenRecords.sessions.find(({ pid }) => pid === override.pid);
    delete legacyOverride.identity.scope.version;
    delete legacyOverride.identity.scope.catalogueSite;
    legacyOverride.identity.scope.siteName = 'first';
    await fs.writeFile(paths.ownershipFile, JSON.stringify(overriddenRecords));
    const stillAmbiguous = await work.run(broadArgs);
    assert.equal(stillAmbiguous.status, 1, stillAmbiguous.stdout + stillAmbiguous.stderr);
    assert.match(JSON.parse(stillAmbiguous.stdout).error.message, /legacy.*ownership.*ambiguous/i);
    await alive(override);
    await work.replay(override.stop);
    await stopped(override);
  },
);

test(
  'standalone catalogue scope survives inferred/explicit runtime dispatch independently of its ownership store',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'shared.json');
    const project = path.join(work.directory, 'external projects', 'standalone.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, solutions: [] }));
    await work.writeCatalogue(config, { all: true, project });
    const catalogue = JSON.parse(await fs.readFile(config, 'utf8'));
    catalogue.portals = 'selected';
    await fs.writeFile(config, JSON.stringify(catalogue));
    const elsewhere = path.join(work.directory, 'different hint cwd');
    await fs.mkdir(elsewhere);
    for (const runtime of [[], ['--runtime', 'model-driven']]) {
      // Sequential: both sites run the same standalone project, whose default state file one
      // runtime at a time may write.
      const site = (name) =>
        work.start(['--config', config, '--site', name, '--project', project, ...runtime, '--port', '0']);
      const first = await site('first');
      const second = await site('second');
      const ownershipCwd = runtime.length ? work.cwd : path.dirname(config);
      const stop = [
        'mirage',
        'stop',
        '--config',
        config,
        '--site',
        'first',
        '--project',
        project,
        '--runtime',
        'model-driven',
        '--json',
      ];
      const wrong = await work.run(
        [...stop, '--state', second.stateFile, '--port', listenerPort(second.url)],
        {},
        ownershipCwd,
      );
      assert.equal(wrong.status, 0, wrong.stdout + wrong.stderr);
      assert.deepEqual(JSON.parse(wrong.stdout).stopped, []);
      await alive(first);
      await alive(second);
      const broad = await work.run(stop, {}, ownershipCwd);
      assert.equal(broad.status, 0, broad.stdout + broad.stderr);
      assert.deepEqual(
        JSON.parse(broad.stdout).stopped.map(({ pid }) => pid),
        [first.pid],
      );
      await stopped(first);
      await alive(second);
      await work.replay(second.stop, false, elsewhere);
      await stopped(second);
    }
    const invalid = await work.run([
      'mirage',
      'start',
      '--config',
      config,
      '--site',
      'not-configured',
      '--project',
      project,
      '--runtime',
      'model-driven',
      '--port',
      '0',
      '--json',
    ]);
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(JSON.parse(invalid.stdout).error.message, /Unknown Mirage configuration 'not-configured'/);
  },
);
