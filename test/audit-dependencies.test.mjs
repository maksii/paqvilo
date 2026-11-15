// @test-kind security: the dependency audit accepts only the recorded advisory on its exact dependency path
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedFinding } from '../scripts/audit-dependencies.mjs';

const ADVISORY = 'https://github.com/advisories/GHSA-g3hv-75wg-m249';
const report = (via = [{ url: ADVISORY }], nodes = ['node_modules/minimatch']) => ({
  vulnerabilities: {
    minimatch: { severity: 'moderate', nodes, via },
    'eslint-plugin-import-x': {
      severity: 'moderate',
      nodes: ['node_modules/eslint-plugin-import-x'],
      via: ['minimatch'],
    },
  },
});
const lockfile = (extra = {}, importX = '4.17.1') => ({
  packages: {
    '': { devDependencies: { eslint: '^10', 'eslint-plugin-import-x': '^4' } },
    'node_modules/eslint': { version: '10.13.0', dependencies: { minimatch: '^10' } },
    'node_modules/eslint/node_modules/minimatch': { version: '11.0.3' },
    'node_modules/eslint-plugin-import-x': { version: importX, dependencies: { minimatch: '^10' } },
    'node_modules/minimatch': { version: '10.2.6' },
    ...extra,
  },
});
const accepted = (name, r = report(), l = lockfile(), project = '.') =>
  acceptedFinding(project, name, r.vulnerabilities[name], r, l);

test('the recorded advisory is accepted only through eslint-plugin-import-x 4.17.1', () => {
  assert.equal(accepted('minimatch'), true);
  assert.equal(accepted('eslint-plugin-import-x'), true);
});

test('another project, advisory, node, import-x version or dependent fails the audit', () => {
  assert.equal(accepted('minimatch', report(), lockfile(), 'mirage'), false);
  assert.equal(
    accepted('minimatch', report([{ url: ADVISORY }, { url: 'https://github.com/advisories/GHSA-x' }])),
    false,
  );
  assert.equal(
    accepted('minimatch', report(undefined, ['node_modules/minimatch', 'node_modules/x/node_modules/minimatch'])),
    false,
  );
  assert.equal(accepted('minimatch', report(), lockfile({}, '4.18.0')), false);
  const another = { 'node_modules/glob': { version: '11.0.0', dependencies: { minimatch: '^10' } } };
  assert.equal(accepted('minimatch', report(), lockfile(another)), false);
  assert.equal(accepted('eslint-plugin-import-x', report(), lockfile(another)), false);
});
