// @test-kind security: the dependency audit keeps no historical acceptance, so a finding outside the time-limited risk acceptance always fails it
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as audit from '../scripts/audit-dependencies.mjs';

const ADVISORY = 'https://github.com/advisories/GHSA-g3hv-75wg-m249';
// The exact dependency path the removed historical acceptance once matched: minimatch 10 hoisted for
// eslint-plugin-import-x 4.17.1 only, reported with one advisory on one node.
const report = {
  auditReportVersion: 2,
  vulnerabilities: {
    minimatch: { name: 'minimatch', severity: 'moderate', nodes: ['node_modules/minimatch'], via: [{ url: ADVISORY }] },
    'eslint-plugin-import-x': {
      name: 'eslint-plugin-import-x',
      severity: 'moderate',
      nodes: ['node_modules/eslint-plugin-import-x'],
      via: ['minimatch'],
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 0, total: 2 },
    dependencies: { prod: 0, dev: 4, optional: 0, peer: 0, peerOptional: 0, total: 4 },
  },
};
const lockfile = JSON.stringify({
  name: 'invented-audit-root',
  lockfileVersion: 3,
  packages: {
    '': { devDependencies: { eslint: '^10', 'eslint-plugin-import-x': '^4' } },
    'node_modules/eslint': { version: '10.13.0', dev: true, dependencies: { minimatch: '^10' } },
    'node_modules/eslint/node_modules/minimatch': { version: '11.0.3', dev: true },
    'node_modules/eslint-plugin-import-x': { version: '4.17.1', dev: true, dependencies: { minimatch: '^10' } },
    'node_modules/minimatch': { version: '10.2.6', dev: true },
  },
});

function inventedRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-audit-historical-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"invented-audit-root","private":true}\n');
  fs.writeFileSync(path.join(directory, 'paqvilo-lock.json'), lockfile);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), lockfile);
  return directory;
}

test('the formerly accepted minimatch path fails the root audit and is never labelled accepted', (t) => {
  const output = [];
  const failed = audit.auditProject('.', 'fixture-npm-cli.js', {
    rootDirectory: inventedRoot(t),
    now: () => Date.parse('2026-11-01T00:00:00Z'),
    log: (line) => output.push(line),
    error: (line) => output.push(line),
    runAudit: () => ({ status: 1, stdout: JSON.stringify(report), stderr: '' }),
  });
  assert.equal(failed, true);
  assert.ok(output.includes('.: minimatch (moderate)'), output.join('\n'));
  assert.ok(output.includes('.: eslint-plugin-import-x (moderate)'), output.join('\n'));
  assert.equal(
    output.some((line) => / accepted$/.test(line)),
    false,
  );
});

test('the audit module exposes no historical acceptance', () => {
  assert.equal('acceptedFinding' in audit, false);
});
