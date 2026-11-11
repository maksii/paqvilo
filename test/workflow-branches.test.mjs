// @test-kind tooling: required workflows retain their triggers and test-kind dependency ordering.
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

test('change scope checks test kinds with Node built-ins and installs no dependencies', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.changes.steps;
  const setup = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
  const check = steps.findIndex((step) => step.run === 'node scripts/check-test-tags.mjs --event');
  assert.ok(setup >= 0 && setup < check, 'the checker runs after Node is set up');
  assert.equal(
    steps.some((step) => /\bnpm (?:ci|install)\b/.test(step.run ?? '')),
    false,
    'the checker imports only Node built-ins and the parity library, so the changes job installs nothing',
  );
});
