import { chromium, firefox, webkit } from 'playwright-core';

export const renderingBrowserName =
  process.env.LENSE_TEST_ENGINE ?? (process.env.LENSE_TEST_WEBKIT === '1' ? 'webkit' : 'chromium');

const renderingBrowser = new Map([
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]).get(renderingBrowserName);
if (!renderingBrowser) throw new Error(`Unknown Lense rendering test browser: ${renderingBrowserName}`);

export function launchRenderingBrowser(chromiumOptions) {
  // Chromium channels and command-line flags do not apply to Playwright Firefox or WebKit.
  return renderingBrowser.launch(
    renderingBrowser === chromium ? chromiumOptions : { headless: chromiumOptions.headless },
  );
}
