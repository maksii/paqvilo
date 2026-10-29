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

export function requirePinnedDefaults(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'playwright-core' || manifest.version !== PLAYWRIGHT_VERSION)
    throw new Error('Review the Windows browser backport after changing pinned Playwright');
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
