// @test-kind security: anonymous capture retains every pinned browser mitigation and disables Windows account sign-in without corrupting its CDP port.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { captureLaunchOptions } from '../lib/browser-launch.mjs';
import { DEFAULT_DISABLED_FEATURES, DISABLED_FEATURES, requirePinnedDefaults } from '../../test/browser-backport.mjs';

test('anonymous Windows capture extends the exact upstream defaults and keeps the debugging port numeric', () => {
  const require = createRequire(import.meta.url);
  requirePinnedDefaults(path.dirname(require.resolve('playwright-core/package.json')));
  for (const channel of ['chromium', 'msedge']) {
    const options = captureLaunchOptions(channel, 12345, 'win32');
    assert.deepEqual(options.ignoreDefaultArgs, [DEFAULT_DISABLED_FEATURES]);
    assert.deepEqual(options.args, [DEFAULT_DISABLED_FEATURES + ',msImplicitSignin', '--remote-debugging-port=12345']);
    assert.deepEqual(options.args[0].slice('--disable-features='.length).split(','), [
      ...DISABLED_FEATURES,
      'msImplicitSignin',
    ]);
    assert.equal(options.args.filter((arg) => arg.startsWith('--disable-features=')).length, 1);
  }
});

test('capture on other platforms keeps browser defaults and its separate CDP port', () => {
  for (const platform of ['linux', 'darwin']) {
    const options = captureLaunchOptions('chromium', 12345, platform);
    assert.deepEqual(options.args, ['--remote-debugging-port=12345']);
    assert.equal(options.ignoreDefaultArgs, undefined);
    assert.equal(options.channel, undefined);
    assert.equal(captureLaunchOptions('msedge', 12345, platform).channel, 'msedge');
  }
});
