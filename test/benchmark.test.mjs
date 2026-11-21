// @test-kind tooling: the offline benchmark script loads the current Lense implementation and measures refreshes without source writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture, HOME_ID } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { observeBenchmarkProgress } from './helpers/benchmark-progress.mjs';
import { operationBudget } from './helpers/operation-budget.mjs';

const BENCHMARK_PHASES = ['startup', 'webFileRefresh', 'inlineRefresh', 'fullRefresh', 'unrelatedSave'];
const CLI_HANG_GUARD_MS = 170_000; // silence guard per ordered work phase, including process exit

// The finite phase protocol has its own guard; startup plus every refresh is not a single timed operation.
test(
  'offline benchmark loads the current Lense implementation and measures refreshes without source writes',
  { timeout: operationBudget(BENCHMARK_PHASES.length * 2 + 1, CLI_HANG_GUARD_MS) },
  async (t) => {
    const fixture = createFixture();
    ownedFixture(t).remove(fixture.cleanup);
    fixture.write('web-files/theme.css', 'body { color: navy; }\n');
    fixture.write(
      'web-files/theme.css.webfile.yml',
      `adx_name: theme.css\nadx_partialurl: theme.css\nadx_parentpageid: ${HOME_ID}\nfilename: theme.css\nmimetype: text/css\n`,
    );
    const config = fixture.file('benchmark.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        sourceRoot: fixture.dir,
        sites: {
          invented: { source: '.', environments: { local: 'http://127.0.0.1:8787' } },
        },
      }),
    );
    const before = fixture.read('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js');
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/benchmark.mjs', import.meta.url)),
        '--config',
        config,
        '--site',
        'invented',
        '--samples',
        '1',
        '--json',
        '--progress',
      ],
      {
        cwd: fixture.dir,
        // A hook's GIT_DIR would make the fixture's baseline the toolkit repository.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')),
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const closed = new Promise((resolve) => child.once('close', resolve));
    ownedFixture(t).add(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    });
    const result = await observeBenchmarkProgress(child, {
      phases: BENCHMARK_PHASES,
      guardMs: CLI_HANG_GUARD_MS,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.implementation, path.resolve(import.meta.dirname, '../lense'));
    assert.equal(report.offline, true);
    assert.equal(report.sourceWrites, false);
    assert.equal(report.baselineAvailable, true, 'the timings use an available real Git baseline');
    for (const name of [
      'startup',
      'webFilePrepare',
      'webFileChangeTracking',
      'webFileRefresh',
      'inlineRefresh',
      'fullRefresh',
      'unrelatedSave',
    ]) {
      assert.equal(report.timings[name].samplesMs.length, 1, name);
      assert.ok(Number.isFinite(report.timings[name].medianMs), name);
    }
    assert.equal(fixture.read('web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js'), before);
  },
);
