// launchCaptureBrowser (capture-shell.mjs) removes its temporary profile after close(); a closed browser can keep a
// profile file busy for seconds on Windows, so the removal must retry while the event loop keeps running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { launchCaptureBrowser } from '../capture-shell.mjs';

// How long the file stays busy after close(): the lower end of the 2-12 s Windows sandbox hold observed for Chromium.
const BUSY_MS = 2000;

test(
  'closing the capture browser removes its profile once a busy profile file is released',
  {
    timeout: 60_000,
    // Exclusive (non-shared) file handles that block deletion are a Windows capability.
    skip: process.platform !== 'win32' && 'mandatory file locks exist only on Windows',
  },
  async (t) => {
    const launch = chromium.launchPersistentContext;
    let profile, holder;
    t.after(() => {
      chromium.launchPersistentContext = launch;
      holder?.kill();
    });
    chromium.launchPersistentContext = async (directory) => {
      profile = directory;
      return {
        close: async () => {
          const busy = path.join(directory, 'Default', 'chrome_debug.log');
          fs.mkdirSync(path.dirname(busy), { recursive: true });
          // Another process holds a profile file without sharing delete access, as an exiting browser can. It lets
          // go only after the removal's first attempt (immediate) and well inside its retry budget (about 11 s).
          holder = spawn(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `$f=[IO.File]::Open('${busy}','OpenOrCreate','ReadWrite','None'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`,
            ],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] },
          );
          await once(holder.stdout, 'data');
          setTimeout(() => holder.stdin.end(), BUSY_MS);
        },
      };
    };
    const browser = await launchCaptureBrowser('chromium');
    assert.match(browser.cdp, /^http:\/\/127\.0\.0\.1:\d+$/);
    await browser.close();
    assert.equal(fs.existsSync(profile), false);
  },
);
