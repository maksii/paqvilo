// @test-kind tooling: verifies inherited process coverage merges into LCOV with resolvable source paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const c8 = fileURLToPath(new URL('../node_modules/c8/bin/c8.js', import.meta.url));

test('c8 merges inherited V8 coverage from independent child processes into source-addressed LCOV', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-coverage-'));
  try {
    const raw = path.join(dir, 'raw');
    await fs.mkdir(raw);
    const source = path.join(dir, 'invented-source.mjs');
    await fs.writeFile(source, 'export function hit(value) {\n  if (value) return 1;\n  return 2;\n}\n');
    const sourceUrl = JSON.stringify(pathToFileURL(source).href);
    const bridge = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { spawnSync } from 'node:child_process';
         for (const value of ['true', 'false']) {
           const child = spawnSync(process.execPath, ['--input-type=module', '-e',
             'import { hit } from ' + ${JSON.stringify(sourceUrl)} + '; hit(' + value + ');'], { encoding: 'utf8' });
           if (child.status !== 0) throw new Error(child.stderr || 'Coverage child failed');
         }`,
      ],
      {
        cwd: dir,
        env: { ...process.env, NODE_V8_COVERAGE: raw },
        encoding: 'utf8',
      },
    );
    assert.equal(bridge.status, 0, bridge.stderr);
    const report = spawnSync(
      process.execPath,
      [c8, 'report', '--temp-directory', raw, '--report-dir', 'coverage', '--reporter', 'lcov'],
      {
        cwd: dir,
        encoding: 'utf8',
      },
    );
    assert.equal(report.status, 0, report.stderr);
    const lcov = await fs.readFile(path.join(dir, 'coverage', 'lcov.info'), 'utf8');
    assert.match(lcov, /SF:invented-source\.mjs\r?\n/);
    assert.match(lcov, /DA:2,[1-9]\d*/);
    assert.match(lcov, /DA:3,[1-9]\d*/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
