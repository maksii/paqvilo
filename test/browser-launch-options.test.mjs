// @test-kind contract: the dedicated browser never installs Playwright's own interrupt handlers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchOptions } from '../lense/browser.mjs';

test('the dedicated browser launch leaves interrupts to the Lense command and keeps the given hang guard', () => {
  const options = launchOptions({ channel: 'msedge' }, true, ['--invented-flag'], 4321);
  assert.equal(options.handleSIGINT, false);
  assert.equal(options.handleSIGTERM, false);
  assert.equal(options.timeout, 4321);
});
