import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { chromium } from 'playwright-core';
import { startAgentServer } from '../../lense/agent-server.mjs';
import { ownedFixture, drainFixture } from '../../mirage/testing/owned-fixture.mjs';

export function agentBrowserFixture(
  t,
  prefix,
  {
    createServer = http.createServer,
    launchBrowser = (options) => chromium.launch(options),
    startAgent = startAgentServer,
  } = {},
) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    servers = [];
  let browser, agent;
  const owner = ownedFixture(t);
  owner.add(() => agent?.close());
  owner.add(() => browser?.close());
  owner.add(() =>
    drainFixture(
      servers.map((server) => async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    ),
  );
  owner.remove(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }));
  const serve = async (handler) => {
    const server = createServer(handler);
    server.on('connect', (_request, socket) => {
      socket.on('error', () => {});
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  };

  return {
    work,
    serve,
    async launch(origin) {
      const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
      browser = await launchBrowser({
        channel: channel === 'chromium' ? undefined : channel,
        headless: true,
        proxy: { server: origin, bypass: '127.0.0.1,localhost' },
        args: [
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
      });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const session = Object.assign(new EventEmitter(), {
        cfg: {
          stateDir: work,
          origin,
          sourceDir: work,
          siteName: 'fixture',
          envName: 'loopback',
          site: { scope: 'all' },
        },
        baseline: { available: true, spec: 'HEAD', commit: 'abc' },
        model: { webFileByUrl: new Map(), warnings: [] },
        rewriter: { activeBlocks: 0, patches: [], unsupported: [] },
        changedFiles: new Set(),
        pageHits: new WeakMap(),
        rel: (file) => path.relative(work, file),
      });
      agent = await startAgent({ session, context });
      return { browser, context, page, agent };
    },
  };
}
