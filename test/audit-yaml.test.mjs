import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectSourceYaml } from '../lense/commands/doctor.mjs';
import { tempDirSync } from './fixture.mjs';

test('source YAML diagnostics skip state, Git, dependencies and deployment profiles by directory name', (t) => {
  const root = tempDirSync('paqvilo-yaml-audit-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const damaged = 'adx_name: One\nadx_name: Two\n';
  for (const directory of [
    '.git',
    '.portalconfig',
    '.paqvilo',
    'node_modules',
    'Deployment-Profiles',
    'web-pages/deployment-profiles-adjacent',
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'record.yml'), damaged);
  }
  const diagnostics = inspectSourceYaml(root);
  assert.equal(diagnostics.length, 1);
  assert.equal(
    path.relative(root, diagnostics[0].file).replaceAll('\\', '/'),
    'web-pages/deployment-profiles-adjacent/record.yml',
  );
});
