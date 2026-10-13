import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { prepareProject } from '../lense/project-scaffold.mjs';
import { createFixture } from '../test/fixture.mjs';

test('empty-project debugger task matches the actual local development ready line and reuses its browser', { timeout: 120000 }, async t => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-init-browser-'));
  const fixture = createFixture();
  await prepareProject(work, { name: 'sample', noPack: true });
  const config = YAML.parse(await fs.readFile(path.join(work, 'paqvilo.config.yml'), 'utf8'));
  config.sourceRoot = fixture.dir;
  config.sites.portal.source = '.';
  config.sites.portal.environments.dev = 'http://127.0.0.1:8787';
  config.sites.portal.mirage.port = 0;
  await fs.writeFile(path.join(work, 'paqvilo.config.yml'), YAML.stringify(config));
  const manifest = JSON.parse(await fs.readFile(path.join(work, 'package.json'), 'utf8'));
  const tasks = JSON.parse(await fs.readFile(path.join(work, '.vscode/tasks.json'), 'utf8'));
  const launches = JSON.parse(await fs.readFile(path.join(work, '.vscode/launch.json'), 'utf8'));
  const launch = launches.configurations.find(item => item.port === 9223 && item.preLaunchTask.includes('portal'));
  const task = tasks.tasks.find(item => item.label === launch.preLaunchTask);
  assert.equal(task.script, 'mirage:dev:portal:debug');
  assert.equal(manifest.scripts[task.script], 'npm run mirage:dev:portal -- --debug-port 9223');
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
  const args = manifest.scripts['mirage:dev:portal'].split(' ').slice(1).filter(arg => arg !== '--headed');
  args.push('--debug-port', String(port), '--headless', '--browser', process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium'));
  const child = spawn(process.execPath, [cli, ...args], { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', browser;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      await session?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    const cleanup = spawn(process.execPath, [cli, 'mirage', 'stop', '--config', path.join(work, 'paqvilo.config.yml'), '--site', 'portal', '--json'], { cwd: work, env, windowsHide: true, stdio: 'ignore' });
    await once(cleanup, 'exit');
    fixture.cleanup();
    await fs.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const ready = new RegExp(task.problemMatcher.background.endsPattern, 'm');
  const deadline = Date.now() + 60000;
  while (!ready.test(output) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Generated task exited before readiness: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(output, ready);
  assert.match(output, new RegExp(`debugger\\s+port ${port}\\b`));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  assert.ok(page, 'debugger reuses the browser opened by development');
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 30000 });
  const response = await page.request.get(page.url());
  assert.equal(response.status(), 200);
  const status = await page.request.get(new URL('/_sim/', page.url()).href);
  assert.equal(status.status(), 200);
});
