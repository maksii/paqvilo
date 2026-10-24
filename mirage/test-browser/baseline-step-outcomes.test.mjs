import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { captureScenario, pageRunner } from '../baseline-capture.mjs';

const origin = 'http://127.0.0.1:15153';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());
async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route(origin + '/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Fixture</title><link rel="icon" href="data:,"><input id="visible"><input id="hidden" style="display:none"><input id="readonly" readonly>',
    }),
  );
  return context.newPage();
}
const options = (steps) => ({
  origin,
  scenario: { id: 'invented/steps', steps },
  settle: { quietMs: 5, timeout: 500 },
});

test('optional actions record performed, absent and hidden outcomes without field values, preserving the legacy timeline', async (t) => {
  const page = await fixture(t);
  const result = await pageRunner(
    page,
    options([
      { goto: '/' },
      { fill: '#missing', value: 'invented-sensitive-value', optional: 'authored-truthy' },
      { fill: '#hidden', value: 'invented-sensitive-value', optional: true },
      { fill: '#visible', value: 'invented-sensitive-value', optional: true },
    ]),
  );
  assert.equal(result.summary.status, 'captured');
  assert.equal(result.summary.steps, 4);
  assert.deepEqual(
    result.summary.timeline.filter((row) => row.name.startsWith('step ')).map((row) => row.name),
    ['step 1 goto', 'step 2 fill', 'step 3 fill', 'step 4 fill'],
  );
  assert.deepEqual(result.summary.stepOutcomes, [
    { index: 1, action: 'goto', optional: false, status: 'performed' },
    {
      index: 2,
      action: 'fill',
      optional: true,
      status: 'skipped',
      presence: { matched: 0, visible: false },
      reason: 'optional-target-absent',
    },
    {
      index: 3,
      action: 'fill',
      optional: true,
      status: 'skipped',
      presence: { matched: 1, visible: false },
      reason: 'optional-target-hidden',
    },
    { index: 4, action: 'fill', optional: true, status: 'performed', presence: { matched: 1, visible: true } },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result.summary.stepOutcomes),
    /invented-sensitive-value|#visible|#hidden|#missing/,
  );
});

test('an optional visibility probe error is an execution error rather than an absence or skip', async (t) => {
  const page = await fixture(t);
  const result = await pageRunner(
    page,
    options([{ goto: '/' }, { fill: '[', value: 'invented-sensitive-value', optional: true }]),
  );
  assert.equal(result.summary.status, 'error');
  assert.equal(result.summary.steps, 1);
  assert.deepEqual(result.summary.stepOutcomes[1], {
    index: 2,
    action: 'fill',
    optional: true,
    status: 'error',
    reason: 'optional-probe-error',
  });
});

test('a visible optional action that fails remains an action error with its successful presence probe', async (t) => {
  const page = await fixture(t);
  const result = await pageRunner(
    page,
    options([{ goto: '/' }, { fill: '#readonly', value: 'invented-sensitive-value', optional: true, timeout: 75 }]),
  );
  assert.equal(result.summary.status, 'error');
  assert.deepEqual(result.summary.stepOutcomes[1], {
    index: 2,
    action: 'fill',
    optional: true,
    status: 'error',
    presence: { matched: 1, visible: true },
    reason: 'action-error',
  });
});

test('persisted capture metadata retains explicit optional outcomes without selectors or submitted values', async (t) => {
  const page = await fixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-step-outcomes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scenario = {
    id: 'invented/persisted-steps',
    steps: [{ goto: '/' }, { fill: '#missing', value: 'invented-sensitive-value', optional: true }],
  };
  await captureScenario(page, scenario, {
    origin,
    outDir: directory,
    side: 'loopback',
    matrix: { settle: { quietMs: 5, timeout: 500 } },
  });
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
  assert.equal(metadata.status, 'captured');
  assert.equal(metadata.stepOutcomes[1].reason, 'optional-target-absent');
  assert.doesNotMatch(JSON.stringify(metadata.stepOutcomes), /invented-sensitive-value|#missing/);
});
