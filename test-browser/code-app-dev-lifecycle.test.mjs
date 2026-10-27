import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { freeDebugPort } from './helpers/debug-port.mjs';
import { childOutput } from './helpers/child-output.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test(
  'standalone dev starts configured apps, opens the workbench and closes only owned processes',
  { timeout: 120000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-dev-cli-'));
    const owner = ownedFixture(t);
    owner.remove(() => fs.rm(dir, { recursive: true, force: true }));
    const external = http.createServer((_req, res) => res.end('external'));
    await listen(external);
    owner.add(() => {
      external.closeAllConnections();
      return close(external);
    });
    const reserve = http.createServer();
    await listen(reserve);
    const port = reserve.address().port;
    await close(reserve);
    await fs.mkdir(path.join(dir, 'app'));
    await fs.symlink(
      fileURLToPath(new URL('../node_modules/', import.meta.url)),
      path.join(dir, 'node_modules'),
      'junction',
    );
    await fs.writeFile(
      path.join(dir, 'app', 'package.json'),
      JSON.stringify({ name: 'invented-vite', type: 'module' }),
    );
    await fs.writeFile(path.join(dir, 'app', 'power.config.json'), JSON.stringify({ appId: 'owned-app' }));
    await fs.writeFile(
      path.join(dir, 'app', 'index.html'),
      '<!doctype html><p id="context">Loading</p><script type="module" src="/main.js"></script>',
    );
    await fs.writeFile(
      path.join(dir, 'app', 'main.js'),
      "import { getContext } from '@microsoft/power-apps/app'; const context = await getContext(); document.querySelector('#context').textContent = context.app.appId + ' � ' + context.user.fullName;",
    );
    const plugin = new URL('../mirage/lib/code-apps-vite.mjs', import.meta.url).href;
    await fs.writeFile(
      path.join(dir, 'app', 'vite.config.mjs'),
      `import { codeApps } from ${JSON.stringify(plugin)}; export default { plugins: [codeApps(), { name: 'invented-env-check', configureServer(server) { server.middlewares.use('/env-check', (_req,res) => res.end(JSON.stringify({ app: process.env.PAQVILO_CODE_APP, origin: process.env.PAQVILO_MIRAGE_URL }))); } }] };`,
    );
    const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
    const project = path.join(dir, 'mirage.project.json');
    await fs.writeFile(
      project,
      JSON.stringify({
        version: 2,
        runtime: { kind: 'dataverse-api' },
        simulation: { level: 'dry-run' },
        dataverse: { enabled: true, tls: false, tds: { enabled: false } },
        codeApps: [
          {
            name: 'owned',
            dir: 'app',
            localAppUrl: `http://127.0.0.1:${port}/`,
            devServer: {
              command: [process.execPath, vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
            },
          },
          {
            name: 'external',
            dir: 'app',
            localAppUrl: `http://127.0.0.1:${external.address().port}/`,
            devServer: { command: ['unwanted-app-server'] },
          },
        ],
      }),
    );
    async function launch(startPath, selectedProject = project) {
      const debugPort = await freeDebugPort();
      const args = [
        cli,
        'mirage',
        'dev',
        '--project',
        selectedProject,
        '--port',
        '0',
        '--headless',
        '--debug-port',
        String(debugPort),
        ...(startPath ? ['--path', startPath] : []),
      ];
      const child = spawn(process.execPath, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const exited = once(child, 'exit');
      let browser;
      owner.add(async () => {
        if (browser?.isConnected()) {
          const cdp = await browser.newBrowserCDPSession();
          await cdp.send('Browser.close').catch(() => {});
          await browser.close().catch(() => {});
        } else if (child.exitCode === null) {
          if (process.platform === 'win32') {
            const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
              windowsHide: true,
              stdio: 'ignore',
            });
            await once(kill, 'exit');
          } else child.kill('SIGTERM');
        }
        if (child.exitCode === null) await exited;
      });
      const output = childOutput(child);
      const match = await output.waitFor(/[Oo]pening (http:\/\/127\.0\.0\.1:\d+)(\/[^\s]*)/, {
        timeoutMs: 60000,
        label: 'Code Apps development opening browser',
      });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForURL(
        (url) =>
          url.origin === match[1] &&
          (startPath ? url.pathname + url.search + url.hash === startPath : url.pathname === '/_apps/code/'),
      );
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/env-check`)).json(), {
        app: 'owned',
        origin: match[1],
      });
      if (!startPath) {
        const state = await (await page.request.get(match[1] + '/_sim/api/state')).json();
        const made = await page.request.post(match[1] + '/_sim/api/dataverse/users', {
          headers: { 'x-sim-csrf': state.csrf },
          data: { fullname: 'Invented Developer', domainname: 'dev@example.test', roles: ['System Administrator'] },
        });
        assert.equal(made.status(), 201);
        const selected = await page.request.post(match[1] + '/_sim/api/dataverse/session', {
          headers: { 'x-sim-csrf': state.csrf },
          data: { userId: (await made.json()).systemuserid },
        });
        assert.equal(selected.status(), 200);
        await page.reload();
        await page.getByLabel('App', { exact: true }).selectOption('owned');
        await page
          .frameLocator('#preview')
          .locator('#context')
          .filter({ hasText: 'owned-app � Invented Developer' })
          .waitFor();
      }
      assert.equal(await (await fetch(`http://127.0.0.1:${external.address().port}/`)).text(), 'external');
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
      const [code] = await exited;
      assert.equal(code, 0, output.text);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
      await assert.rejects(fetch(`${match[1]}/_sim/api/status`));
      assert.equal(await (await fetch(`http://127.0.0.1:${external.address().port}/`)).text(), 'external');
    }
    await launch();
    await launch('/_sim/?example=1#section');
    const config = JSON.parse(await fs.readFile(project, 'utf8'));
    config.runtime = { kind: 'power-pages' };
    config.portals = [{ id: 'example', path: fileURLToPath(new URL('../examples/project/portal/', import.meta.url)) }];
    const portalProject = path.join(dir, 'portal.project.json');
    await fs.writeFile(portalProject, JSON.stringify(config));
    await launch(undefined, portalProject);
  },
);
