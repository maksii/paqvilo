import fs from 'node:fs';
import path from 'node:path';

import { DISABLED_FEATURES, windowsLaunchOptions } from '../mirage/lib/browser-launch.mjs';

// Product launches apply the Windows default through mirage/lib/browser-launch.mjs. This hook
// applies the same options to tests that call Playwright directly, and verifies the copied
// default list against the pinned Playwright before it is trusted.
export {
  DISABLED_FEATURES,
  DEFAULT_DISABLED_FEATURES,
  BACKPORTED_DISABLED_FEATURES,
  windowsLaunchOptions as backportLaunchOptions,
} from '../mirage/lib/browser-launch.mjs';
export const PLAYWRIGHT_VERSION = '1.64.1';
const installed = new WeakSet();

function requirePinnedVersion(directory, reviewed) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'playwright-core' || manifest.version !== PLAYWRIGHT_VERSION)
    throw new Error(`Review ${reviewed} after changing pinned Playwright`);
}

export function requirePinnedDefaults(directory) {
  requirePinnedVersion(directory, 'the Windows browser backport');
  const source = fs.readFileSync(path.join(directory, 'lib/coreBundle.js'), 'utf8');
  const block = /\n\s+disabledFeatures = \[([\s\S]*?)\n\s+\]\.filter\(Boolean\);/.exec(source)?.[1];
  if (!block) throw new Error('Cannot verify pinned Playwright disabledFeatures');
  const features = JSON.parse(
    '[' +
      block
        .replace(/\/\/[^\r\n]*/g, '')
        .trim()
        .replace(/,$/, '') +
      ']',
  );
  if (JSON.stringify(features) !== JSON.stringify(DISABLED_FEATURES))
    throw new Error('Pinned Playwright disabledFeatures changed; review the Windows browser backport');
}

export function installChromiumBackport(chromium, directory, platform = process.platform) {
  if (platform !== 'win32' || installed.has(chromium)) return;
  requirePinnedDefaults(directory);
  const launch = chromium.launch;
  const persistent = chromium.launchPersistentContext;
  const server = chromium.launchServer;
  chromium.launch = function (options) {
    return launch.call(this, windowsLaunchOptions(options, platform));
  };
  chromium.launchPersistentContext = function (profile, options) {
    return persistent.call(this, profile, windowsLaunchOptions(options, platform));
  };
  chromium.launchServer = function (options) {
    return server.call(this, windowsLaunchOptions(options, platform));
  };
  installed.add(chromium);
}

const timeoutsInstalled = new WeakSet();

/** Fails when the pinned Playwright no longer resolves its default timeouts the way installTestTimeouts relies on. */
export function requirePinnedTimeoutDefaults(directory) {
  requirePinnedVersion(directory, 'the test timeout hook');
  const source = fs.readFileSync(path.join(directory, 'lib/coreBundle.js'), 'utf8');
  for (const needle of [
    'context.setDefaultTimeout(this._browserType._playwright._defaultContextTimeout);',
    'context.setDefaultNavigationTimeout(this._browserType._playwright._defaultContextNavigationTimeout);',
    'options = { ...this._playwright._defaultLaunchOptions, ...options };',
  ])
    if (!source.includes(needle))
      throw new Error('Pinned Playwright timeout defaults changed; review the test timeout hook');
}

/**
 * Tests carry no real timer on steps they do not assert: the runner's --test-timeout is the only hang guard. This removes
 * Playwright's default action, navigation, launch and connectOverCDP timeouts in the test process. An explicit per-call
 * timeout and an explicit page or context setDefaultTimeout or setDefaultNavigationTimeout still win: a navigation uses
 * the first default that is set of its page's navigation and action defaults, then its context's (0 here).
 */
export function installTestTimeouts(playwright, directory) {
  if (timeoutsInstalled.has(playwright)) return;
  requirePinnedTimeoutDefaults(directory);
  // Browser._setupBrowserContext applies these to every context of every launch and connection path.
  playwright._defaultContextTimeout = 0;
  playwright._defaultLaunchOptions = { ...playwright._defaultLaunchOptions, timeout: 0 };
  for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
    // connectOverCDP resolves its own 30 s default, outside the context settings.
    const connectOverCDP = type.connectOverCDP;
    type.connectOverCDP = function (target, options) {
      if (target && typeof target === 'object' && ('endpointURL' in target || 'wsEndpoint' in target))
        return connectOverCDP.call(this, { timeout: 0, ...target }, options);
      return connectOverCDP.call(this, target, { timeout: 0, ...options });
    };
  }
  timeoutsInstalled.add(playwright);
}
