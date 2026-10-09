/**
 * Resolve the browser channel used by owned Mirage browser runs.
 * `chromium` uses Playwright's installed browser; Windows defaults to Edge.
 */
export function browserChannel({ platform = process.platform, env = process.env } = {}) {
  return env.PAQVILO_BROWSER || (platform === "win32" ? "msedge" : "chromium");
}

/** Build Playwright launch options with the shared channel selection. */
export function browserLaunchOptions(options = {}, config = {}) {
  const channel = options.channel ?? browserChannel(config);
  return { ...options, channel: channel === "chromium" ? undefined : channel };
}
