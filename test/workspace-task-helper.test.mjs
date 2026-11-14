// @test-kind tooling: the lane helper that runs a generated workspace task hands the CLI exactly one browser choice and one headless flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneArguments } from '../test-browser/helpers/workspace-task.mjs';

const LANE = ['--headless', '--browser', 'chromium'];

test('a generated --browser choice is replaced by the lane browser, not repeated', () => {
  assert.deepEqual(laneArguments(['dev', '--browser', 'msedge', '--profile', 'lense'], 'chromium'), [
    'dev',
    '--profile',
    'lense',
    ...LANE,
  ]);
});

test('a generated --browser=<value> choice is replaced by the lane browser', () => {
  assert.deepEqual(laneArguments(['dev', '--browser=chrome', '--profile', 'lense'], 'chromium'), [
    'dev',
    '--profile',
    'lense',
    ...LANE,
  ]);
});

test('a command without a browser choice receives the lane browser once, appended', () => {
  assert.deepEqual(laneArguments(['dev', '--profile', 'lense'], 'chromium'), ['dev', '--profile', 'lense', ...LANE]);
});

test('a generated --headless is not duplicated and the other arguments keep their order', () => {
  assert.deepEqual(
    laneArguments(['mirage', '--headless', 'dev', '--browser', 'msedge', '--debug-port', '9223'], 'chromium'),
    ['mirage', 'dev', '--debug-port', '9223', ...LANE],
  );
});
