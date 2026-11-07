import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture, tempDirSync } from './fixture.mjs';
import { loadConfig } from '../lense/config.mjs';
import { catalogueArgs, cliArgs } from '../lense/commands/mirage.mjs';
import { withProcessSlot } from '../mirage/test/process-slots.mjs';
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
// A start may use the whole default Mirage startup budget (120 s, lense/commands/mirage.mjs); the guard only ends a
// hung command. The test has no overall deadline: every command it waits for is bounded by this guard.
const COMMAND_TIMEOUT = 150_000;

test('catalogue start applies a linked configuration only with --apply-configuration, keeps the flag over a data-only catalogue and rejects an unknown link', async () => {
  const fixture = createFixture(),
    root = tempDirSync('paqvilo-feedback-preset-'),
    config = path.join(root, 'catalogue.json');
  const portal = path.join(root, 'portal');
  fs.cpSync(fixture.dir, portal, { recursive: true });
  fixture.cleanup();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
  );
  const toolkit = (...args) =>
    withProcessSlot(
      () =>
        new Promise((resolve) =>
          execFile(
            process.execPath,
            [cli, ...args, '--config', config],
            { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT },
            (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
          ),
        ),
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
  // Set while a start may have left a runtime that the test has not stopped yet.
  let running = false;
  const stop = async () => {
    const result = await run('stop', '--site', 'fixture', '--json');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.offline, false);
    assert.ok(report.writesFiles.some((file) => file.endsWith('sessions.json')));
    running = false;
  };
  try {
    const initialized = await run('init', '--site', 'fixture', '--json');
    assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
    const project = JSON.parse(initialized.stdout);
    assert.equal(project.offline, true);
    assert.deepEqual(project.writesFiles, [project.file]);
    // Offline inspection and the refused interactive launch only read the initialized catalogue.
    const [inspected, interactive] = await Promise.all([
      toolkit('lense', 'mirage', 'inspect', '--site', 'fixture', '--json'),
      run('dev', '--site', 'fixture', '--json'),
    ]);
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    const inventory = JSON.parse(inspected.stdout);
    assert.equal(inventory.command, 'mirage');
    assert.equal(inventory.action, 'inspect');
    assert.equal(inventory.offline, true);
    assert.deepEqual(inventory.writesFiles, []);
    assert.deepEqual(inventory.errors, []);
    assert.equal(interactive.status, 1);
    assert.equal(JSON.parse(interactive.stdout).ok, false);
    assert.match(JSON.parse(interactive.stdout).error.message, /interactive/);
    for (const flag of [false, true]) {
      running = true;
      const result = await run('start', '--site', 'fixture', ...(flag ? ['--apply-configuration'] : []), '--json');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const started = JSON.parse(result.stdout);
      assert.equal(started.offline, false);
      assert.equal(started.runtimeWrites, true);
      assert.ok(started.writesFiles.includes(started.stateFile));
      assert.ok(started.writesFiles.some((file) => file.endsWith('sessions.json')));
      assert.ok(started.writesFiles.every((file) => fs.existsSync(file)));
      const status = await (await fetch(started.url + '/__sim/api/status')).json();
      assert.equal(status.activeConfigurationPreset?.id ?? null, flag ? 'tiny-config' : null);
      await stop();
    }
    // The dev launcher shares this argument construction with start. It must
    // retain an explicit flag even when the catalogue requests data-only.
    catalog.sites.fixture.mirage.presetConfiguration = 'data-only';
    fs.writeFileSync(config, JSON.stringify(catalog));
    const cfg = await loadConfig({ config, site: 'fixture' }, env),
      effective = catalogueArgs(cfg, { 'apply-configuration': true });
    assert.ok(cliArgs(cfg, 'dev', effective).values.includes('--apply-configuration'));
    writePack('missing-config');
    running = true;
    const bad = await run('start', '--site', 'fixture', '--apply-configuration', '--json');
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout + bad.stderr, /missing-config/);
    const failure = JSON.parse(bad.stdout);
    assert.equal(failure.offline, false);
    assert.ok(failure.writesFiles.some((file) => file.endsWith('.log')));
    await stop();
  } finally {
    if (running) await run('stop', '--site', 'fixture', '--json');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
