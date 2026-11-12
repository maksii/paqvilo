// @test-kind security: the anonymous shell-capture browser must not be signed in to the host's Microsoft account.
// On Windows, Edge's implicit sign-in put the Windows account's msn.com/bing.com cookies into every fresh capture
// profile about two seconds after launch, which failed runtime-client.test.mjs's empty-cookie check whenever the
// capture connected late. This reads the launched browser's own command line, so it does not depend on that timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { launchCaptureBrowser } from '../capture-shell.mjs';
import { browserChannel } from '../lib/browser-launch.mjs';

const HANG_GUARD_MS = 120_000; // hang guard only: Playwright's 30 s default fails a loaded machine

test('the capture browser starts anonymous, with Edge implicit sign-in disabled on Windows', async () => {
  const channel = browserChannel();
  const owned = await launchCaptureBrowser(channel);
  let browser;
  try {
    browser = await chromium.connectOverCDP(owned.cdp);
    const context = browser.contexts()[0];
    context.setDefaultTimeout(HANG_GUARD_MS);
    context.setDefaultNavigationTimeout(HANG_GUARD_MS);
    assert.deepEqual(await context.cookies(), []);
    // Implicit sign-in is an Edge-on-Windows feature. Edge's version page shows the browser process's actual
    // command line (CDP's getBrowserCommandLine needs --enable-automation, which the capture launch omits).
    if (channel === 'msedge' && process.platform === 'win32') {
      const page = await context.newPage();
      await page.goto('edge://version');
      const commandLine = await page.locator('#command_line').innerText();
      await page.close();
      const features = commandLine.split(/\s+/).filter((value) => value.startsWith('--disable-features='));
      // One switch: a second --disable-features would replace the backported defaults instead of adding to them.
      assert.equal(features.length, 1, features.join(' '));
      const disabled = features[0].slice('--disable-features='.length).split(',');
      assert.ok(disabled.includes('msImplicitSignin'), features[0]);
      assert.ok(disabled.includes('TcpPortRandomizationWin'), features[0]);
    }
  } finally {
    await browser?.close();
    await owned.close();
  }
});
