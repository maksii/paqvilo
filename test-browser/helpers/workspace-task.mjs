import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { childOutput } from './child-output.mjs';
import { startOnFreePort } from './debug-port.mjs';
import { PROFILE_RELEASE_RETRIES } from './profile-cleanup.mjs';
import { drainFixture } from '../../mirage/testing/owned-fixture.mjs';
import { browserChannel } from '../../mirage/lib/browser-launch.mjs';
import { recordedRuntimeOwner } from '../../test/helpers/mirage-runtimes.mjs';

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

/** Returns the arguments with the browser choice and headless flag replaced; other arguments keep their order. */
export function laneArguments(args, browser) {
  const kept = [];
  let skipBrowserValue = false;
  for (const arg of args) {
    if (skipBrowserValue) {
      skipBrowserValue = false;
      continue;
    }
    if (arg === '--browser') {
      skipBrowserValue = true;
      continue;
    }
    if (arg !== '--headless' && !arg.startsWith('--browser=')) kept.push(arg);
  }
  return [...kept, '--headless', '--browser', browser];
}

/**
 * Runs a generated VS Code background task (its CLI arguments, headless on the lane's browser)
 * and owns its teardown: the attached browser, the task process, the project's Mirage and `work`.
 * An `args` array starts the task at once. An `args(port)` function starts it in `attach()`, with
 * the task's debugging port; `attach()` waits for the task's problem-matcher readiness line and
 * its debugger port, then connects to the development browser the task opened. A start that lost
 * its debugging port to another process has closed; the task starts again on another port.
 */
export function runWorkspaceTask(t, { cli, args, cwd, env, task, stop, work, cleanup = () => {}, label }) {
  const laneBrowser = browserChannel();
  let child, output, closed, browser;
  const start = (taskArgs) => {
    child = spawn(process.execPath, [cli, ...laneArguments(taskArgs, laneBrowser)], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    output = childOutput(child);
    closed = once(child, 'close');
  };
  if (typeof args !== 'function') start(args);
  // `mirage stop` keeps its records in the state folder next to the configuration or project it names, else in its
  // working directory.
  const flag = stop.findIndex((arg) => arg === '--config' || arg === '--project');
  const stateRoot = flag === -1 ? work : path.dirname(path.resolve(work, stop[flag + 1]));
  const ownershipFile = path.join(stateRoot, '.paqvilo', 'mirage', 'sessions.json');
  const report = (line) => (t.diagnostic ? t.diagnostic(line) : process.emitWarning(line));
  t.after(async () => {
    let requestedBrowserClose = false;
    const runtimes = recordedRuntimeOwner(ownershipFile, { report });
    await drainFixture([
      // While the task still runs: a development command that ends removes its own record.
      () => runtimes.note(),
      async () => {
        if (!browser) return;
        const session = await browser.newBrowserCDPSession().catch(() => null);
        if (session) {
          requestedBrowserClose = true;
          await session.send('Browser.close').catch(() => {});
        }
        await browser.close().catch(() => {});
      },
      () => child && stopOwnedChild(child, closed, { graceful: requestedBrowserClose }),
      () => runtimes.note(),
      async () => {
        const stopping = spawn(process.execPath, [cli, 'mirage', 'stop', ...stop, '--json'], {
          cwd: work,
          env,
          windowsHide: true,
          stdio: 'ignore',
        });
        assert.deepEqual(await once(stopping, 'close'), [0, null], 'the project Mirage stops cleanly');
      },
      // Whatever the task or the stop left running, although they may have removed its record.
      () => runtimes.end(),
      cleanup,
    ]);
    await fs.rm(work, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES });
  });
  return {
    get output() {
      return output;
    },
    async attach(message) {
      const ready = new RegExp(task.problemMatcher.background.endsPattern, 'm');
      const port = await startOnFreePort(async (port) => {
        start(args(port));
        await output.waitFor(ready, { label });
        return port;
      });
      assert.match(output.text, ready, message);
      assert.match(output.text, new RegExp(`debugger\\s+port ${port}\\b`));
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      return browser;
    },
  };
}
