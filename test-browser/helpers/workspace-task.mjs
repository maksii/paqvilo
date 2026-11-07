import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { childOutput } from './child-output.mjs';
import { PROFILE_RELEASE_RETRIES } from './profile-cleanup.mjs';
import { drainFixture } from '../../mirage/testing/owned-fixture.mjs';

/**
 * Stops an owned child and resolves once it has closed: its stdio drained, not merely exited. After a requested
 * graceful shutdown (the attached browser was asked to close) the child gets GRACEFUL_EXIT_MS to exit on its own.
 */
const GRACEFUL_EXIT_MS = 5000;
export async function stopOwnedChild(child, closed, { graceful = false } = {}) {
  if (graceful && child.exitCode === null && child.signalCode === null) {
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(resolve, GRACEFUL_EXIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  return closed;
}

/**
 * Runs a generated VS Code background task (its CLI arguments, headless on the lane's browser)
 * and owns its teardown: the attached browser, the task process, the project's Mirage and `work`.
 * `attach()` waits for the task's problem-matcher readiness line and its debugger port, then
 * connects to the development browser the task opened.
 */
export function runWorkspaceTask(t, { cli, args, cwd, env, task, port, stop, work, cleanup = () => {}, label }) {
  const child = spawn(
    process.execPath,
    [
      cli,
      ...args,
      '--headless',
      '--browser',
      process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    ],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = childOutput(child);
  const closed = once(child, 'close');
  let browser;
  t.after(async () => {
    let requestedBrowserClose = false;
    await drainFixture([
      async () => {
        if (!browser) return;
        const session = await browser.newBrowserCDPSession().catch(() => null);
        if (session) {
          requestedBrowserClose = true;
          await session.send('Browser.close').catch(() => {});
        }
        await browser.close().catch(() => {});
      },
      () => stopOwnedChild(child, closed, { graceful: requestedBrowserClose }),
      async () => {
        const stopping = spawn(process.execPath, [cli, 'mirage', 'stop', ...stop, '--json'], {
          cwd: work,
          env,
          windowsHide: true,
          stdio: 'ignore',
        });
        assert.deepEqual(await once(stopping, 'close'), [0, null], 'the project Mirage stops cleanly');
      },
      cleanup,
    ]);
    await fs.rm(work, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES });
  });
  return {
    output,
    async attach(message) {
      const ready = new RegExp(task.problemMatcher.background.endsPattern, 'm');
      await output.waitFor(ready, { label });
      assert.match(output.text, ready, message);
      assert.match(output.text, new RegExp(`debugger\\s+port ${port}\\b`));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      return browser;
    },
  };
}
