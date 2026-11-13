// @test-kind contract: standalone code app dev preserves configured startup and owned-process lifecycle
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
import { startOnFreePort } from './helpers/debug-port.mjs';
import { childOutput } from './helpers/child-output.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { PROFILE_RELEASE_RETRIES } from './helpers/profile-cleanup.mjs';
import { recordedRuntimeOwner } from '../test/helpers/mirage-runtimes.mjs';

const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('standalone dev starts configured apps, opens the workbench and closes only owned processes', async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-app-dev-cli-')));
  const owner = ownedFixture(t);
  // The development browser's profile and the app's server processes release this directory after they exit.
  owner.remove(() => fs.rm(dir, { recursive: true, force: true, ...PROFILE_RELEASE_RETRIES }));
  // Both projects keep their records here; a development command that ends removes its own record.
  const runtimes = recordedRuntimeOwner(path.join(dir, '.paqvilo', 'mirage', 'sessions.json'), {
    report: (line) => t.diagnostic(line),
  });
  const external = http.createServer((_req, res) => res.end('external'));
  await listen(external);
  owner.add(() => {
    external.closeAllConnections();
    return close(external);
  });
  await fs.mkdir(path.join(dir, 'app'));
  await fs.symlink(
    fileURLToPath(new URL('../node_modules/', import.meta.url)),
    path.join(dir, 'node_modules'),
    'junction',
  );
  await fs.writeFile(path.join(dir, 'app', 'package.json'), JSON.stringify({ name: 'invented-vite', type: 'module' }));
  await fs.writeFile(path.join(dir, 'app', 'power.config.json'), JSON.stringify({ appId: 'owned-app' }));
  await fs.writeFile(
    path.join(dir, 'app', 'index.html'),
    '<!doctype html><p id="context">Loading</p><script type="module" src="/main.js"></script>',
  );
  await fs.writeFile(
    path.join(dir, 'app', 'main.js'),
    "import { getContext } from '@microsoft/power-apps/app'; const context = await getContext(); document.querySelector('#context').textContent = context.app.appId + ' \uFFFD ' + context.user.fullName;",
  );
  const plugin = new URL('../mirage/lib/code-apps-vite.mjs', import.meta.url).href;
  await fs.writeFile(
    path.join(dir, 'app', 'vite.config.mjs'),
    `import { codeApps } from ${JSON.stringify(plugin)}; export default { plugins: [codeApps(), { name: 'invented-env-check', configureServer(server) { server.middlewares.use('/env-check', (_req,res) => res.end(JSON.stringify({ app: process.env.PAQVILO_CODE_APP, origin: process.env.PAQVILO_MIRAGE_URL }))); } }] };`,
  );
  const vite = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  const project = path.join(dir, 'mirage.project.json');
  const portalProject = path.join(dir, 'portal.project.json');
  // Vite binds the owned app's port itself (--strictPort), so the port is written into both projects before each start.
  const writeProjects = async (port) => {
    const config = {
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
    };
    await fs.writeFile(project, JSON.stringify(config));
    config.runtime = { kind: 'power-pages' };
    config.portals = [{ id: 'example', path: fileURLToPath(new URL('../examples/project/portal/', import.meta.url)) }];
    await fs.writeFile(portalProject, JSON.stringify(config));
  };
  // Another process took the app's port: Vite refused it, or dev found a foreign server there and would have used it.
  const appPortTaken = (error, port) =>
    new RegExp(
      `Port ${port} is already in use|\\[code app owned\\] using existing http://127\\.0\\.0\\.1:${port}\\b`,
    ).test(String(error?.message ?? error));
  async function start(startPath, selectedProject, port, debugPort) {
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
    const closed = once(child, 'close');
    const started = { port, debugPort, child, closed, browser: null };
    owner.add(async () => {
      await runtimes.note();
      const { browser } = started;
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
      await closed;
      // A runtime the closed development command left running, whether or not it kept its record.
      await runtimes.note();
      await runtimes.end();
    });
    started.output = childOutput(child);
    started.match = await started.output.waitFor(/[Oo]pening (http:\/\/127\.0\.0\.1:\d+)(\/[^\s]*)/, {
      label: 'Code Apps development opening browser',
    });
    // The app's start is reported before the browser opens; a foreign server is a lost port, not this test's app.
    if (appPortTaken(started.output.text, port)) throw new Error(`Code app port taken:\n${started.output.text}`);
    return started;
  }
  async function launch(startPath, selectedProject = project) {
    const started = await startOnFreePort(async (port) => {
      await writeProjects(port);
      return startOnFreePort((debugPort) => start(startPath, selectedProject, port, debugPort));
    }, appPortTaken);
    const { port, debugPort, closed, output, match } = started;
    const browser = (started.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`));
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    // The dev command prints the administration address; its calls and a start path under /_sim use that origin.
    const admin = await output.waitFor(/^admin +(http:\/\/127\.0\.0\.1:\d+)/m, {
      label: 'Code Apps development administration address',
    });
    const adminOrigin = new URL(admin[1]).origin;
    const expectedOrigin = startPath ? adminOrigin : match[1];
    await page.waitForURL(
      (url) =>
        url.origin === expectedOrigin &&
        (startPath ? url.pathname + url.search + url.hash === startPath : url.pathname === '/_apps/code/'),
    );
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/env-check`)).json(), {
      app: 'owned',
      origin: match[1],
    });
    if (!startPath) {
      const state = await (await page.request.get(adminOrigin + '/_sim/api/state')).json();
      const made = await page.request.post(adminOrigin + '/_sim/api/dataverse/users', {
        headers: { 'x-sim-csrf': state.csrf },
        data: { fullname: 'Invented Developer', domainname: 'dev@example.test', roles: ['System Administrator'] },
      });
      assert.equal(made.status(), 201);
      const selected = await page.request.post(adminOrigin + '/_sim/api/dataverse/session', {
        headers: { 'x-sim-csrf': state.csrf },
        data: { userId: (await made.json()).systemuserid },
      });
      assert.equal(selected.status(), 200);
      await page.reload();
      await page.getByLabel('App', { exact: true }).selectOption('owned');
      await page
        .frameLocator('#preview')
        .locator('#context')
        .filter({ hasText: 'owned-app \uFFFD Invented Developer' })
        .waitFor();
    }
    assert.equal(await (await fetch(`http://127.0.0.1:${external.address().port}/`)).text(), 'external');
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => {});
    const [code] = await closed;
    assert.equal(code, 0, output.text);
    assert.match(output.text, /^mirage +stopped http:\/\/127\.0\.0\.1:\d+ \(pid \d+\)$/m, output.text);
    assert.doesNotMatch(output.text, /could not stop pid/, output.text);
    // Closing the browser is the stop. A start-up that was still waiting for the page's resources ends with its own line;
    // one that had completed prints none.
    const startupCompleted = /document and initial resources loaded/.test(output.text);
    assert.equal(/browser closed before start-up finished/.test(output.text), !startupCompleted, output.text);
    assert.equal(await (await fetch(`http://127.0.0.1:${external.address().port}/`)).text(), 'external');
  }
  await launch();
  await launch('/_sim/?example=1#section');
  await launch(undefined, portalProject);
});
