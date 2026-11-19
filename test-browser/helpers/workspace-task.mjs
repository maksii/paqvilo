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
import { SCENARIO_HANG_GUARD_MS } from '../../test/helpers/bounded-command.mjs';

// Hang guard only: a child whose browser accepted the close stops on its own; one still running after this is ended
// and reported as a failure, and the caller's drain goes on.
const GRACEFUL_EXIT_HANG_GUARD_MS = SCENARIO_HANG_GUARD_MS / 2;
// Hang guard only: the teardown waits for the task to stop; a hook gets the lane timeout unless it has its own.
const HOOK_HANG_GUARD = { timeout: SCENARIO_HANG_GUARD_MS };
/**
 * Stops an owned child and resolves once it has closed: its stdio drained, not merely exited. After a delivered
 * graceful shutdown (its attached browser accepted the close) the child stops on its own and is awaited, so it removes
 * what it owns. A child that has not closed by `hangGuardMs` (GRACEFUL_EXIT_HANG_GUARD_MS; a test of the guard
 * passes a short one) is ended, and the stop then throws.
 */
export async function stopOwnedChild(
  child,
  closed,
  { graceful = false, hangGuardMs = GRACEFUL_EXIT_HANG_GUARD_MS } = {},
) {
  const running = () => child.exitCode === null && child.signalCode === null;
  if (graceful && running()) {
    let timer;
    const expired = await Promise.race([
      closed.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), hangGuardMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!expired) return closed;
    child.kill('SIGTERM');
    await closed;
    throw new Error('the child did not exit after its browser closed');
  }
  if (running()) child.kill('SIGTERM');
  return closed;
}

/**
 * Asks a connected browser to close; true when the close was delivered: the browser answered, or the connection
 * dropped under the request because the browser was closing.
 */
export function browserClosed(browser, session) {
  return session.send('Browser.close').then(
    () => true,
    (error) => error.name === 'TargetClosedError' || !browser.isConnected(),
  );
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
        // The close is delivered when the browser answers or drops the connection as it closes.
        if (session) requestedBrowserClose = await browserClosed(browser, session);
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
  }, HOOK_HANG_GUARD);
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
