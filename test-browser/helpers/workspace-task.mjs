import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { childOutput } from './child-output.mjs';
import { PROFILE_RELEASE_RETRIES } from './profile-cleanup.mjs';

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
  const exited = once(child, 'exit');
  let browser;
  t.after(async () => {
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      await session?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    const stopping = spawn(process.execPath, [cli, 'mirage', 'stop', ...stop, '--json'], {
      cwd: work,
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    await once(stopping, 'exit');
    await cleanup();
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
