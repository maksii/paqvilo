import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { classifyChanges } from '../.github/scripts/change-scope.mjs';

test('maintenance PRs retain CI and every main CodeQL configuration', () => {
  for (const name of ['ci', 'security']) {
    const workflow = YAML.parse(fs.readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    for (const branch of ['main', '0.9.8'])
      assert.ok(workflow.on.pull_request.branches.includes(branch), `${name}: ${branch}`);
    assert.equal(workflow.jobs.gate.name, name === 'ci' ? 'CI gate' : 'Security gate');
  }
  const scope = classifyChanges(['docs/cli.md']);
  assert.equal(scope.codeql, true);
  assert.deepEqual(JSON.parse(scope.languages), ['actions', 'csharp', 'javascript-typescript']);
});
