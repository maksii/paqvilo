// @test-kind contract: catalogue bootstrap presets preserve Mirage state and print the startup decision they make.
// The subject is the state file across two runtime processes (the second start must keep what the first wrote), so
// the two starts are real and in sequence. No command is limited in time below its hang guard: a start that takes long
// on a loaded host is a start that succeeds late. Each command has the guard of the bounded command helper, and the
// test has the operation budget of its seven commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, tempDirSync, withoutToolkitEnvironment } from './fixture.mjs';
import { loadCatalogue, loadConfig } from '../lense/config.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { ownStartedRuntimes } from './helpers/mirage-runtimes.mjs';
import { boundedCommand, COMMAND_HANG_GUARD_MS } from './helpers/bounded-command.mjs';
import { countOperations, operationBudget } from './helpers/operation-budget.mjs';
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));

test(
  'catalogue bootstrap presets preserve state and print their startup decision',
  { timeout: operationBudget(7, COMMAND_HANG_GUARD_MS) },
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
      boundedCommand(t, process.execPath, [cli, 'mirage', ...args, '--config', config], { cwd: root, env }),
    );
    /** A start; the runtime it reports is ended after the test if the test's own stop did not end it. */
    const start = async (...args) => {
      const result = await run('start', ...args);
      ownStartedRuntimes(t, result.stdout);
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
      assert.equal(status.status, 0, status.stdout + status.stderr);
      assert.match(status.stdout, /preset tiny: kept existing state/);
      const json = JSON.parse(listed.stdout);
      assert.equal(json.sessions.find((s) => s.pid === kept.pid).runtime.startupPreset.applied, false);
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
