import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runWorkspaceTask } from './helpers/workspace-task.mjs';
import { freeDebugPort } from './helpers/debug-port.mjs';

test(
  'scaffolded VS Code task signals readiness and attaches to its own development browser',
  { timeout: 120000 },
  async (t) => {
    const work = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-workspace-'));
    const directory = path.join(work, 'demo');
    const cli = process.env.PAQVILO_DEMO_CLI || fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
    await promisify(execFile)(process.execPath, [cli, 'mirage', 'demo', '--scaffold', '--dir', directory], {
      cwd: work,
      env,
      windowsHide: true,
    });
    const tasks = JSON.parse(await fs.readFile(path.join(directory, '.vscode/tasks.json'), 'utf8'));
    const launch = JSON.parse(await fs.readFile(path.join(directory, '.vscode/launch.json'), 'utf8'));
    const configuration = launch.configurations.find((item) => item.name === 'Demo: Mirage and browser debugger');
    const task = tasks.tasks.find((item) => item.label === configuration.preLaunchTask);
    const port = await freeDebugPort();
    // The dependency installation is covered by the independent package smoke.
    // Use its installed CLI when supplied; isolate the browser port for this test.
    const args = task.args.slice(1).map((argument) => (argument === '9222' ? String(port) : argument));
    const run = runWorkspaceTask(t, {
      cli,
      args,
      cwd: directory,
      env,
      task,
      port,
      stop: ['--config', path.join(directory, 'paqvilo.config.yml'), '--site', 'example'],
      work,
      label: 'Workspace task readiness',
    });
    const browser = await run.attach('F5 must wait for the task readiness signal');
    const page = browser
      .contexts()[0]
      .pages()
      .find((candidate) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(candidate.url()));
    assert.ok(page, 'attach reuses the page opened by the task');
    await page.getByRole('heading', { name: 'Build it three ways. Understand every layer.' }).waitFor();
    const css = path.join(directory, 'portal/web-files/demo.css');
    await fs.appendFile(css, '\nbody{--workspace-task-proof:ready}\n');
    await page.waitForFunction(
      () =>
        document.body && getComputedStyle(document.body).getPropertyValue('--workspace-task-proof').trim() === 'ready',
    );
    assert.equal(configuration.type, 'msedge');
    assert.equal(configuration.pathMapping, undefined);
    assert.ok(configuration.resolveSourceMapLocations.includes('${workspaceFolder}/**'));
    const resource = await page.request.get(new URL('/demo-workspace.js', page.url()).href);
    assert.equal(resource.status(), 200);
    const mappedBody = (await resource.text()).replaceAll('\r\n', '\n'),
      exportBody = (await fs.readFile(path.join(directory, 'portal/web-files/demo-workspace.js'), 'utf8')).replaceAll(
        '\r\n',
        '\n',
      );
    assert.ok(mappedBody.startsWith(exportBody));
    assert.match(mappedBody.slice(exportBody.length), /sourceMappingURL=data:/);
  },
);
