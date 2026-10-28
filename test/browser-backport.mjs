import fs from 'node:fs';
import path from 'node:path';

// Temporary test-only backport of microsoft/playwright#43605. Remove with the
// first stable Playwright upgrade that includes the upstream default.
export const PLAYWRIGHT_VERSION = '1.64.1';
export const DISABLED_FEATURES = Object.freeze([
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]);
export const DEFAULT_DISABLED_FEATURES = '--disable-features=' + DISABLED_FEATURES.join(',');
export const BACKPORTED_DISABLED_FEATURES = DEFAULT_DISABLED_FEATURES + ',TcpPortRandomizationWin';
const installed = new WeakSet();

export function requirePinnedDefaults(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== 'playwright-core' || manifest.version !== PLAYWRIGHT_VERSION)
    throw new Error('Review the test-only Windows browser backport after changing pinned Playwright');
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
    throw new Error('Pinned Playwright disabledFeatures changed; review the Windows test backport');
}

export function backportLaunchOptions(options = {}, platform = process.platform) {
  if (platform !== 'win32' || options === null || typeof options !== 'object' || Array.isArray(options)) return options;
  // Invalid public-API input must reach Playwright unchanged. In particular,
  // spreading a string must not turn a validation error into an accepted array.
  if (
    options.args !== undefined &&
    (!Array.isArray(options.args) || options.args.some((value) => typeof value !== 'string'))
  )
    return options;
  const ignoredOption = options.ignoreDefaultArgs;
  if (
    ignoredOption !== undefined &&
    typeof ignoredOption !== 'boolean' &&
    (!Array.isArray(ignoredOption) || ignoredOption.some((value) => typeof value !== 'string'))
  )
    return options;
  if (options.ignoreDefaultArgs === true) return options;
  // Playwright applies ignoreDefaultArgs to caller args too. Keep an explicit
  // caller override intact rather than filtering its identical default switch.
  if (options.args?.includes(DEFAULT_DISABLED_FEATURES)) return options;
  const ignored = options.ignoreDefaultArgs || [];
  if (ignored.includes(DEFAULT_DISABLED_FEATURES)) return options;
  return {
    ...options,
    ignoreDefaultArgs: [...ignored, DEFAULT_DISABLED_FEATURES],
    // Preserve caller ordering and overrides, exactly as an upstream default
    // change would: Playwright appends caller args after its own defaults.
    args: [BACKPORTED_DISABLED_FEATURES, ...(options.args || [])],
  };
}

export function installChromiumBackport(chromium, directory, platform = process.platform) {
  if (platform !== 'win32' || installed.has(chromium)) return;
  requirePinnedDefaults(directory);
  const launch = chromium.launch;
  const persistent = chromium.launchPersistentContext;
  const server = chromium.launchServer;
  chromium.launch = function (options) {
    return launch.call(this, backportLaunchOptions(options, platform));
  };
  chromium.launchPersistentContext = function (profile, options) {
    return persistent.call(this, profile, backportLaunchOptions(options, platform));
  };
  chromium.launchServer = function (options) {
    return server.call(this, backportLaunchOptions(options, platform));
  };
  installed.add(chromium);
}
