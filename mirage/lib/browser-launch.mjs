/**
 * Resolve the browser channel used by owned Mirage browser runs.
 * `chromium` uses Playwright's installed browser; Windows defaults to Edge.
 */
export function browserChannel({ platform = process.platform, env = process.env } = {}) {
  return env.PAQVILO_BROWSER || (platform === 'win32' ? 'msedge' : 'chromium');
}

// Backport of microsoft/playwright#43605: Windows TCP port randomization makes busy loopback
// sessions fail with net::ERR_NO_BUFFER_SPACE. Remove with the first stable Playwright upgrade
// that disables it by default; test/browser-backport.test.mjs fails when the pinned defaults change.
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

/** Add the Windows loopback default to Playwright launch options, preserving caller overrides. */
export function windowsLaunchOptions(options = {}, platform = process.platform) {
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

/** Build Playwright launch options with the shared channel selection. */
export function browserLaunchOptions(options = {}, config = {}) {
  const channel = options.channel ?? browserChannel(config);
  return windowsLaunchOptions({ ...options, channel: channel === 'chromium' ? undefined : channel }, config.platform);
}
