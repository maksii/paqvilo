// @test-kind contract: catalogue bootstrap presets preserve Mirage state and print the startup decision they make.
// The subject is the state file across two runtime processes (the second start must keep what the first wrote), so
// the two starts are real and in sequence. No command is limited in time below its hang guard: a start that takes long
// on a loaded host is a start that succeeds late. Each command has the runtime command guard of the bounded command
// helper, which is above the start-up cap of `mirage start`, and the test has the operation budget of its seven
// commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, tempDirSync, withoutToolkitEnvironment } from './fixture.mjs';
import { loadCatalogue, loadConfig } from '../lense/config.mjs';
import { runMirage } from './helpers/mirage-in-process.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { ownStartedRuntimes } from './helpers/mirage-runtimes.mjs';
import { boundedCommand, RUNTIME_COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { countOperations, operationBudget } from './helpers/operation-budget.mjs';
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

test(
  'catalogue bootstrap presets preserve state and print their startup decision',
  { timeout: operationBudget(7, RUNTIME_COMMAND_HANG_GUARD_MS) },
  async (t) => {
    withoutToolkitEnvironment(t);
    const fixture = createFixture(),
      root = tempDirSync('paqvilo-preset-mode-'),
      config = path.join(root, 'catalogue.json');
    const portal = path.join(root, 'portal');
    fs.cpSync(fixture.dir, portal, { recursive: true });
    fixture.cleanup();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
    );
    const run = countOperations(t, 7, (...args) =>
      boundedCommand(
        t,
        process.execPath,
        [cli, 'mirage', ...args, '--config', config],
        { cwd: root, env },
        { guardMs: RUNTIME_COMMAND_HANG_GUARD_MS },
      ),
    );
    /** A start; the runtime it reports, or that its state folder records, is ended after the test if the test's own
     * stop did not end it. */
    const ownershipFile = path.join(root, '.paqvilo', 'mirage', 'sessions.json');
    const start = async (...args) => {
      const result = await run('start', ...args);
      ownStartedRuntimes(t, result.stdout, { ownershipFile });
      return result;
    };
    ownedFixture(t).remove(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const catalog = {
      defaults: { mirage: { presetMode: 'bootstrap', presetConfiguration: 'apply' } },
      sites: {
        fixture: {
          source: portal,
          environments: { dev: 'https://invented.example.test' },
          mirage: { port: 0, preset: 'tiny', solutionRoots: [], dataPacks: ['./pack.mjs'] },
        },
      },
    };
    fs.writeFileSync(config, JSON.stringify(catalog));
    fs.writeFileSync(
      path.join(root, 'pack.mjs'),
      'export default {id:"tiny",name:"Tiny",description:"Synthetic preset",matches:()=>true,configurationPresets:[{id:"tiny-config",name:"Tiny configuration",portalOverrides:{snippets:{Synthetic:"Startup override"}}}],presets:()=>({tiny:{name:"Tiny",configurationPreset:"tiny-config",mappings:{widget:{idColumn:"widgetid",entitySet:"widgets"}},tables:{widget:[{widgetid:"seed",name:"Seed"}]},settings:{permissionMode:"permissive"}}})};',
    );
    try {
      assert.equal((await loadConfig({ config, site: 'fixture' })).mirageConfig.presetMode, 'bootstrap');
      const first = await start('--site', 'fixture', '--json');
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const started = JSON.parse(first.stdout);
      assert.equal(started.runtime.startupPreset.applied, true);
      const firstState = JSON.parse(fs.readFileSync(started.stateFile, 'utf8'));
      assert.equal(firstState.simulator.activeExperiment.id, 'tiny-config');
      assert.equal(firstState.simulator.portalOverrides.snippets.Synthetic, 'Startup override');
      assert.equal((await run('stop', '--site', 'fixture', '--json')).status, 0);
      const state = JSON.parse(fs.readFileSync(started.stateFile, 'utf8'));
      state.tables.widget.push({ widgetid: 'local', name: 'Local' });
      fs.writeFileSync(started.stateFile, JSON.stringify(state));
      catalog.defaults.mirage.presetMode = 'always';
      catalog.sites.fixture.mirage.presetMode = 'bootstrap';
      fs.writeFileSync(config, JSON.stringify(catalog));
      assert.equal((await loadConfig({ config, site: 'fixture' })).mirageConfig.presetMode, 'bootstrap');
      const second = await start('--site', 'fixture', '--json');
      assert.equal(second.status, 0, second.stdout + second.stderr);
      const kept = JSON.parse(second.stdout);
      assert.equal(kept.runtime.startupPreset.applied, false);
      assert.ok(
        JSON.parse(fs.readFileSync(kept.stateFile, 'utf8')).tables.widget.some((row) => row.widgetid === 'local'),
      );
      // Three readers of the running runtime: a start that reuses it and prints text, and the status in both forms.
      const [text, status, listed] = await Promise.all([
        run('start', '--site', 'fixture'),
        run('status'),
        run('status', '--json'),
      ]);
      assert.equal(text.status, 0, text.stdout + text.stderr);
      assert.match(text.stdout, /Preset:.*tiny.*kept existing state/);
      // The status command asks the runtime with its interactive limit. A runtime that answers later than that on a
      // loaded host stays listed as ready, without the details of an answer (test/mirage-status-probe.test.mjs): the
      // commands are asserted on the listing, and the details on the same status command run in process without the
      // limit (the host's probeTimeout).
      assert.equal(status.status, 0, status.stdout + status.stderr);
      assert.match(status.stdout, new RegExp(String.raw`^ready · toolkit managed .*\n.* pid ${kept.pid}$`, 'm'));
      assert.equal(JSON.parse(listed.stdout).sessions.find((s) => s.pid === kept.pid).ready, true);
      const unlimited = { cwd: root, host: { probeTimeout: null } };
      const answeredJson = await runMirage(['mirage', 'status', '--config', config, '--json'], unlimited);
      const answeredText = await runMirage(['mirage', 'status', '--config', config], unlimited);
      assert.equal(answeredJson.status, 0, answeredJson.stdout + answeredJson.stderr);
      assert.equal(answeredText.status, 0, answeredText.stdout + answeredText.stderr);
      const answered = JSON.parse(answeredJson.stdout).sessions.find((s) => s.pid === kept.pid);
      assert.equal(answered.runtime.startupPreset.applied, false);
      assert.match(answeredText.stdout, /preset tiny: kept existing state/);
      catalog.sites.fixture.mirage.presetMode = 'invalid';
      fs.writeFileSync(config, JSON.stringify(catalog));
      assert.throws(() => loadCatalogue({ config }), /presetMode must be bootstrap or always/);
    } finally {
      catalog.sites.fixture.mirage.presetMode = 'bootstrap';
      fs.writeFileSync(config, JSON.stringify(catalog));
      const stop = await run('stop', '--site', 'fixture', '--json');
      assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    }
  },
);
