// @test-kind contract: catalogue start applies a linked configuration only with the explicit flag and rejects unknown options.
// Which flag a start hands its runtime, what it reports for it and how it reports a runtime that refuses its settings
// is decided by the command: those starts run in this process against runtime doubles
// (test/helpers/mirage-in-process.mjs). That a runtime applies a linked configuration only when selected, and refuses
// an unknown link, is mirage/test/pack-configuration-presets.test.mjs. One real runtime, started by the real command
// line with the flag, joins the two across the process boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, tempDirSync } from './fixture.mjs';
import { loadConfig } from '../lense/config.mjs';
import { catalogueArgs, cliArgs } from '../lense/commands/mirage.mjs';
import { boundedCommand, RUNTIME_COMMAND_HANG_GUARD_MS, SCENARIO_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { ownStartedRuntimes } from './helpers/mirage-runtimes.mjs';
import { runtimeHost, runMirage } from './helpers/mirage-in-process.mjs';
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

// Hang guard only: one scenario with a real runtime start and stop between the starts against runtime doubles.
test(
  'catalogue start applies a linked configuration only with --apply-configuration, keeps the flag over a data-only catalogue and rejects an unknown link',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const fixture = createFixture(),
      root = tempDirSync('paqvilo-feedback-preset-'),
      config = path.join(root, 'catalogue.json');
    const portal = path.join(root, 'portal');
    fs.cpSync(fixture.dir, portal, { recursive: true });
    fixture.cleanup();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
    );
    // A start is allowed what the product allows it; every command is ended with its test.
    const toolkit = (...args) =>
      boundedCommand(
        t,
        process.execPath,
        [cli, ...args, '--config', config],
        { cwd: root, env },
        { guardMs: RUNTIME_COMMAND_HANG_GUARD_MS },
      );
    const run = (...args) => toolkit('mirage', ...args);
    const catalog = {
      sites: {
        fixture: {
          source: portal,
          environments: { local: 'http://127.0.0.1:8787' },
          mirage: { port: 0, preset: 'tiny', solutionRoots: [], dataPacks: ['./pack.mjs'] },
        },
      },
    };
    const packFile = path.join(root, 'pack.mjs');
    fs.writeFileSync(
      packFile,
      `import {readFileSync} from 'node:fs';
const {link}=JSON.parse(readFileSync(new URL('./pack-data.json',import.meta.url),'utf8'));
export default {id:'tiny',name:'Tiny',description:'Invented linked configuration',matches:()=>true,configurationPresets:[{id:'tiny-config',name:'Tiny configuration',platformOverrides:{QueryLinkEntityLimit:30}}],presets:()=>({tiny:{name:'Tiny',configurationPreset:link,tables:{}}})};
`,
    );
    const writePack = (link) => fs.writeFileSync(path.join(root, 'pack-data.json'), JSON.stringify({ link }));
    fs.writeFileSync(config, JSON.stringify(catalog));
    writePack('tiny-config');
    ownedFixture(t).remove(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    /** Stops every runtime of the site; a runtime a start reported is also ended after the test if this did not. */
    const stop = async () => {
      const result = await run('stop', '--site', 'fixture', '--json');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.offline, false);
      assert.ok(report.writesFiles.some((file) => file.endsWith('sessions.json')));
      return report;
    };
    const host = runtimeHost(t);
    const inProcess = (...args) => runMirage(['mirage', ...args, '--config', config], { cwd: root, host });
    const initialized = await inProcess('init', '--site', 'fixture', '--json');
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    const project = JSON.parse(initialized.stdout);
    assert.equal(project.offline, true);
    assert.deepEqual(project.writesFiles, [project.file]);
    // The refused interactive launch only reads the initialized catalogue.
    const interactive = await inProcess('dev', '--site', 'fixture', '--json');
    assert.equal(interactive.status, 1);
    assert.equal(JSON.parse(interactive.stdout).ok, false);
    assert.match(JSON.parse(interactive.stdout).error.message, /interactive/);
    // Offline inspection reads the same catalogue while the real runtime starts with the flag.
    const [inspected, applied] = await Promise.all([
      toolkit('lense', 'mirage', 'inspect', '--site', 'fixture', '--json'),
      run('start', '--site', 'fixture', '--apply-configuration', '--json'),
    ]);
    // A start that was ended before it answered has still recorded its runtime in the catalogue's state folder.
    ownStartedRuntimes(t, applied.stdout, { ownershipFile: path.join(root, '.paqvilo', 'mirage', 'sessions.json') });
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    const inventory = JSON.parse(inspected.stdout);
    assert.equal(inventory.command, 'mirage');
    assert.equal(inventory.action, 'inspect');
    assert.equal(inventory.offline, true);
    assert.deepEqual(inventory.writesFiles, []);
    assert.deepEqual(inventory.errors, []);
    /** What every successful start reports, whatever kind of process its runtime is. */
    const reportsItsWrites = (result) => {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const started = JSON.parse(result.stdout);
      assert.equal(started.offline, false);
      assert.equal(started.runtimeWrites, true);
      assert.ok(started.writesFiles.includes(started.stateFile));
      assert.ok(started.writesFiles.some((file) => file.endsWith('sessions.json')));
      assert.ok(started.writesFiles.every((file) => fs.existsSync(file)));
      return started;
    };
    const real = reportsItsWrites(applied);
    const status = await (await fetch(real.url + '/__sim/api/status')).json();
    assert.equal(status.activeConfigurationPreset?.id, 'tiny-config', 'the runtime applied the linked configuration');
    await stop();
    // The same two starts against runtime doubles: the flag reaches the runtime's command line exactly when given.
    for (const flag of [false, true]) {
      const started = reportsItsWrites(
        await inProcess('start', '--site', 'fixture', ...(flag ? ['--apply-configuration'] : []), '--json'),
      );
      assert.equal(host.runtime(started.pid).argv.includes('--apply-configuration'), flag);
      const stopped = await inProcess('stop', '--site', 'fixture', '--json');
      assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
      const report = JSON.parse(stopped.stdout);
      assert.equal(report.offline, false);
      assert.ok(report.writesFiles.some((file) => file.endsWith('sessions.json')));
      assert.deepEqual(
        report.stopped.map((item) => item.pid),
        [started.pid],
      );
    }
    // The dev launcher shares this argument construction with start. It must
    // retain an explicit flag even when the catalogue requests data-only.
    catalog.sites.fixture.mirage.presetConfiguration = 'data-only';
    fs.writeFileSync(config, JSON.stringify(catalog));
    const cfg = await loadConfig({ config, site: 'fixture' }, env),
      effective = catalogueArgs(cfg, { 'apply-configuration': true });
    assert.ok(cliArgs(cfg, 'dev', effective).values.includes('--apply-configuration'));
    // A runtime that refuses its settings (here: a preset linked to a configuration no pack defines) says so in its
    // start-up log and exits: the start fails with that text and names the log.
    writePack('missing-config');
    host.failNextStart('Unknown configuration preset missing-config');
    const bad = await inProcess('start', '--site', 'fixture', '--apply-configuration', '--json');
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /missing-config/);
    const failure = JSON.parse(bad.stdout);
    assert.equal(failure.offline, false);
    assert.ok(failure.writesFiles.some((file) => file.endsWith('.log')));
    const nothing = await inProcess('stop', '--site', 'fixture', '--json');
    assert.equal(nothing.status, 0, nothing.stdout + nothing.stderr);
    assert.deepEqual(JSON.parse(nothing.stdout).stopped, [], 'the runtime that refused left nothing to stop');
  },
);
