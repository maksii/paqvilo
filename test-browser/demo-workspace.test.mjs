import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

test('scaffolded VS Code task signals readiness and attaches to its own development browser', { timeout: 120000 }, async (t) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-workspace-'));
  const directory = path.join(work, 'demo');
  const cli = process.env.PAQVILO_DEMO_CLI || fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
  await promisify(execFile)(process.execPath, [cli, 'mirage', 'demo', '--scaffold', '--dir', directory], { cwd: work, env, windowsHide: true });
  const tasks = JSON.parse(await fs.readFile(path.join(directory, '.vscode/tasks.json'), 'utf8'));
  const launch = JSON.parse(await fs.readFile(path.join(directory, '.vscode/launch.json'), 'utf8'));
  const configuration = launch.configurations.find((item) => item.name === 'Demo: Mirage and browser debugger');
  const task = tasks.tasks.find((item) => item.label === configuration.preLaunchTask);
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  // The dependency installation is covered by the independent package smoke.
  // Use its installed CLI when supplied; isolate the browser port for this test.
  const args = task.args.slice(1).map((argument) => argument === '9222' ? String(port) : argument);
  args.push('--headless', '--browser', process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium'));
  const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      await session?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    const cleanup = spawn(process.execPath, [cli, 'mirage', 'stop', '--config', path.join(directory, 'paqvilo.config.yml'), '--site', 'example', '--json'], { cwd: work, env, windowsHide: true, stdio: 'ignore' });
    await once(cleanup, 'exit');
    await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ready = new RegExp(task.problemMatcher.background.endsPattern, 'm');
  const deadline = Date.now() + 60000;
  while (!ready.test(output) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Workspace task exited before readiness: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(output, ready, 'F5 must wait for the task readiness signal');
  assert.match(output, new RegExp(`debugger\\s+port ${port}\\b`));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find((candidate) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(candidate.url()));
  assert.ok(page, 'attach reuses the page opened by the task');
  await page.getByRole('heading', { name: 'Build it three ways. Understand every layer.' }).waitFor();
  const css = path.join(directory, 'portal/web-files/demo.css');
  await fs.appendFile(css, '\nbody{--workspace-task-proof:ready}\n');
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--workspace-task-proof').trim() === 'ready');
  assert.equal(configuration.pathMapping['/'], '${workspaceFolder}/portal/web-files');
  const resource = await page.request.get(new URL('/demo-workspace.js', page.url()).href);
  assert.equal(resource.status(), 200);
  assert.equal((await resource.text()).replaceAll('\r\n', '\n'), (await fs.readFile(path.join(directory, 'portal/web-files/demo-workspace.js'), 'utf8')).replaceAll('\r\n', '\n'));
});
