import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath, catalogueArgs } from '../lense/commands/mirage.mjs';

test('Mirage session paths compare according to Windows path case rules', () => {
  assert.equal(samePath('C:\\Portal\\Source', 'c:\\portal\\source'), process.platform === 'win32');
});

test('Mirage session paths preserve case-sensitive POSIX distinctions', { skip: process.platform !== 'linux' }, () => {
  assert.equal(samePath('/tmp/Portal', '/tmp/portal'), false);
  assert.equal(samePath('/tmp/Portal', '/tmp/Portal'), true);
});

test('catalogue Mirage settings fill only the options the command line leaves open', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'site.project.yml');
  fs.writeFileSync(project, 'version: 1\n');
  const cfg = (mirageConfig) => ({ siteName: 'site', mirageConfig: { project: null, solutionRoots: [], dataPacks: [], port: null, preset: null, ...mirageConfig } });
  const roots = [path.join(dir, 'Base'), path.join(dir, 'Business')];
  assert.deepEqual(catalogueArgs(cfg({ solutionRoots: roots, port: 0, preset: 'open-sandbox' }), {}), { 'solution-root': roots, port: '0', preset: 'open-sandbox' });
  assert.deepEqual(catalogueArgs(cfg({ solutionRoots: roots, port: 0, preset: 'open-sandbox' }), { 'solution-root': ['explicit'], port: '8790', preset: 'other' }), { 'solution-root': ['explicit'], port: '8790', preset: 'other' }, 'explicit options win');
  assert.deepEqual(catalogueArgs(cfg({ project, solutionRoots: roots }), {}), { project }, 'a catalogued project supplies its own Solution roots');
  assert.deepEqual(catalogueArgs(cfg({ project }), { project: 'explicit.yml' }), { project: 'explicit.yml' });
  const missing = path.join(dir, 'missing.project.yml');
  assert.throws(() => catalogueArgs(cfg({ project: missing }), {}), /does not exist.*paqvilo mirage init --site site/);
  assert.deepEqual(catalogueArgs(cfg({ project: missing }), {}, { requireProject: false }), {}, 'stop still works without the project file');
  assert.deepEqual(catalogueArgs({ siteName: 'legacy' }, { port: '1' }), { port: '1' }, 'configurations without Mirage settings are unchanged');
});
