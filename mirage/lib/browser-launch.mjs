/**
 * Resolve the browser channel used by owned Mirage browser runs.
 * `chromium` uses Playwright's installed browser; Windows defaults to Edge.
 */
export function browserChannel({ platform = process.platform, env = process.env } = {}) {
  return env.PAQVILO_BROWSER || (platform === 'win32' ? 'msedge' : 'chromium');
}

// Hang guard for a browser launch or CDP attach: stops only a start that never answers.
export const BROWSER_HANG_GUARD_MS = 120_000;

// Reviewed Playwright 1.65.1 defaults. Anonymous capture extends this one switch;
// the pinned-default regression compares the complete list with Playwright itself.
export const CHROMIUM_DISABLED_FEATURES = Object.freeze([
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'HttpsUpgrades',
  'HttpsFirstBalancedModeAutoEnable',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'TcpPortRandomizationWin',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'PreconnectToSearch',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
]);
export const CHROMIUM_DEFAULT_DISABLED_FEATURES = '--disable-features=' + CHROMIUM_DISABLED_FEATURES.join(',');

/** An anonymous capture extends the upstream feature switch without changing its numeric CDP port. */
export function captureLaunchOptions(channel, port, platform = process.platform) {
  const options = {
    headless: true,
    timeout: BROWSER_HANG_GUARD_MS,
    ...(channel !== 'chromium' ? { channel } : {}),
    args: [`--remote-debugging-port=${port}`],
  };
  // Edge otherwise signs a fresh Windows profile into the host account and adds
  // its Microsoft cookies. Replace exactly the upstream switch, retaining every
  // reviewed mitigation, and add only the anonymous-capture feature.
  if (platform === 'win32') {
    options.ignoreDefaultArgs = [CHROMIUM_DEFAULT_DISABLED_FEATURES];
    options.args.unshift(CHROMIUM_DEFAULT_DISABLED_FEATURES + ',msImplicitSignin');
  }
  return options;
}

// Playwright 1.65.1 includes the Windows TCP port randomization fix upstream.
// Forward caller options unchanged; overriding its entire default feature list would
// discard new upstream defaults on future supported releases.
export function windowsLaunchOptions(options = {}) {
  return options;
}

/** Build Playwright launch options with the shared channel selection. */
export function browserLaunchOptions(options = {}, config = {}) {
  const channel = options.channel ?? browserChannel(config);
  return windowsLaunchOptions({ ...options, channel: channel === 'chromium' ? undefined : channel });
}
