import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MIRAGE_TOOLS } from '../mirage/tool-registry.mjs';
import { resolveCatalogue } from '../lense/api.mjs';

test('public tool registry routes each tool-specific help and prints the package version', async () => {
  const bin = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  for (const name of Object.keys(MIRAGE_TOOLS)) {
    const result = spawnSync(process.execPath, [bin, 'mirage', name, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`paqvilo mirage ${name}`));
  }
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', windowsHide: true });
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(result.stdout.trim(), pkg.version);
});

test('resolved catalogue reports effective paths and shell, env, local and catalogue provenance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-resolved-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'portal'));
  const config = path.join(root, 'paqvilo.config.yml');
  await fs.writeFile(config, 'sourceRoot: .\nsites:\n  synthetic:\n    source: portal\n    environments: { dev: https://synthetic.example.test }\n    mirage: { port: 8888 }\n');
  let resolved = await resolveCatalogue({ config }, {});
  assert.equal(resolved.provenance.sourceRoot, 'catalogue');
  assert.equal(resolved.sites[0].sourceDir, path.join(root, 'portal'));
  assert.equal(resolved.sites[0].mirage.port, 8888);
  assert.equal(resolved.sites[0].mirage.stateFile, path.join(root, '.paqvilo/simulator/synthetic/state.json'));
  await fs.writeFile(path.join(root, 'paqvilo.config.local.yml'), 'sourceRoot: .\nsites:\n  synthetic:\n    mirage: { port: 8999 }\n');
  resolved = await resolveCatalogue({ config }, {});
  assert.equal(resolved.provenance.sourceRoot, 'local config'); assert.equal(resolved.sites[0].provenance.port, 'local config');
  await fs.writeFile(path.join(root, '.env'), 'PAQVILO_REPO=.\nPAQVILO_SYNTHETIC_SOURCE=portal\n');
  resolved = await resolveCatalogue({ config }, {});
  assert.equal(resolved.provenance.sourceRoot, '.env'); assert.equal(resolved.sites[0].provenance.sourceDir, '.env');
  resolved = await resolveCatalogue({ config }, { PAQVILO_REPO: root });
  assert.equal(resolved.provenance.sourceRoot, 'shell');
});
