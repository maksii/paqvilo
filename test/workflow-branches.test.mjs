import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

test('required workflows run for pull requests to main and the release branch', () => {
  for (const name of ['ci', 'security']) {
    const workflow = YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
    for (const branch of ['main', '0.9.8'])
      assert.ok(workflow.on.pull_request.branches.includes(branch), `${name} must run for PRs to ${branch}`);
  }
});
