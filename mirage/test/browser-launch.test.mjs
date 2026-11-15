import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserChannel,
  browserLaunchOptions,
  BACKPORTED_DISABLED_FEATURES,
  DEFAULT_DISABLED_FEATURES,
} from '../lib/browser-launch.mjs';

test('Mirage browser selection honors override and has portable defaults', () => {
  assert.equal(browserChannel({ platform: 'win32', env: {} }), 'msedge');
  assert.equal(browserChannel({ platform: 'linux', env: {} }), 'chromium');
  assert.equal(browserChannel({ platform: 'darwin', env: {} }), 'chromium');
  assert.equal(browserChannel({ platform: 'linux', env: { PAQVILO_BROWSER: 'msedge' } }), 'msedge');
  assert.deepEqual(browserLaunchOptions({ headless: true }, { platform: 'linux', env: {} }), {
    headless: true,
    channel: undefined,
  });
});

test('owned Windows launches disable TCP port randomization while keeping the remaining Playwright defaults', () => {
  assert.deepEqual(browserLaunchOptions({ headless: true, args: ['--invented'] }, { platform: 'win32', env: {} }), {
    headless: true,
    channel: 'msedge',
    ignoreDefaultArgs: [DEFAULT_DISABLED_FEATURES],
    args: [BACKPORTED_DISABLED_FEATURES, '--invented'],
  });
});
