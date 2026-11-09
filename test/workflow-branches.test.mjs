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

test('change scope installs locked parser dependencies before checking generated test guards', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.changes.steps;
  const setup = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
  const install = steps.findIndex((step) => step.run === 'npm ci --ignore-scripts --no-audit --no-fund');
  const check = steps.findIndex((step) => step.run === 'node scripts/check-test-tags.mjs --event');
  assert.ok(setup >= 0 && setup < install && install < check);
  assert.equal(steps[install].if, undefined, 'the parser is required for every event');
  assert.notEqual(steps[install]['continue-on-error'], true);
  const lock = JSON.parse(readFileSync(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
  assert.ok(lock.packages['node_modules/espree']?.integrity, 'the parser is present in the root lockfile');
});
