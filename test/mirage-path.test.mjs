import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { samePath, catalogueArgs } from '../lense/commands/mirage.mjs';
import { toolkitCommandHint } from './toolkit-cli.mjs';
import { tempDirSync } from './fixture.mjs';

test('Mirage session paths compare by filesystem identity and the platform path case rules', (t) => {
  // Case folds only where the platform's paths are case-insensitive: Windows folds, POSIX keeps the distinction.
  const folds = process.platform === 'win32';
  assert.equal(samePath('C:\\Portal\\Source', 'c:\\portal\\source'), folds);
  assert.equal(samePath('/tmp/Portal', '/tmp/portal'), folds);
  assert.equal(samePath('/tmp/Portal', '/tmp/Portal'), true);
  assert.equal(samePath(null, '/tmp/Portal'), false);
  // An existing folder reached through a junction (a symbolic link on POSIX) is the same source.
  const dir = tempDirSync('paqvilo-mirage-same-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'Source'),
    linked = path.join(dir, 'linked');
  fs.mkdirSync(source);
  fs.symlinkSync(source, linked, 'junction');
  assert.equal(samePath(linked, source), true);
  assert.equal(samePath(linked, path.join(dir, 'other')), false);
});

test('catalogue Mirage settings fill only the options the command line leaves open', (t) => {
  const dir = tempDirSync('paqvilo-mirage-args-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'site.project.yml');
  fs.writeFileSync(project, 'version: 1\n');
  const cfg = (mirageConfig) => ({
    siteName: 'site',
    mirageConfig: { project: null, solutionRoots: [], dataPacks: [], port: null, preset: null, ...mirageConfig },
  });
  const roots = [path.join(dir, 'Base'), path.join(dir, 'Business')];
  assert.deepEqual(catalogueArgs(cfg({ solutionRoots: roots, port: 0, preset: 'open-sandbox' }), {}), {
    'solution-root': roots,
    port: '0',
    preset: 'open-sandbox',
  });
  assert.deepEqual(
    catalogueArgs(cfg({ solutionRoots: roots, port: 0, preset: 'open-sandbox' }), {
      'solution-root': ['explicit'],
      port: '8790',
      preset: 'other',
    }),
    { 'solution-root': ['explicit'], port: '8790', preset: 'other' },
    'explicit options win',
  );
  assert.deepEqual(
    catalogueArgs(cfg({ project, solutionRoots: roots }), {}),
    { project },
    'a catalogued project supplies its own Solution roots',
  );
  assert.deepEqual(catalogueArgs(cfg({ project }), { project: 'explicit.yml' }), { project: 'explicit.yml' });
  const missing = path.join(dir, 'missing.project.yml');
  assert.throws(() => catalogueArgs(cfg({ project: missing }), {}), /does not exist.*paqvilo mirage init --site site/);
  const config = path.join(dir, 'external config.yml');
  const repo = path.join(dir, 'alternate checkout');
  const expectScopedRecommendation = (configuration, options = {}) =>
    assert.throws(
      () => catalogueArgs(configuration, options),
      (error) => {
        assert.match(error.message, /does not exist/);
        assert.ok(
          error.message.includes(
            toolkitCommandHint(['mirage', 'init', '--config', config, '--repo', repo, '--site', 'site']),
          ),
        );
        return true;
      },
    );
  expectScopedRecommendation({ ...cfg({ project: missing }), configFile: config, sourceRoot: repo });
  expectScopedRecommendation(cfg({ project: missing }), { config, repo });
  expectScopedRecommendation({
    ...cfg({ project: missing }),
    configFile: config,
    sourceRoot: repo,
    stateDir: path.join(dir, 'separate project', '.paqvilo'),
  });
  assert.deepEqual(
    catalogueArgs(cfg({ project: missing }), {}, { requireProject: false }),
    {},
    'stop still works without the project file',
  );
  assert.deepEqual(
    catalogueArgs({ siteName: 'legacy' }, { port: '1' }),
    { port: '1' },
    'configurations without Mirage settings are unchanged',
  );
});
