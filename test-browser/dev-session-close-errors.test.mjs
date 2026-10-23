import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import chokidar from "chokidar";
import { createFixture } from "../test/fixture.mjs";
import { loadDevTargets } from "../lense/config.mjs";
import { startDevSessions } from "../lense/dev-sessions.mjs";
import { OverlaySession } from "../lense/session.mjs";
import { ownedFixture } from "../mirage/testing/owned-fixture.mjs";

async function fixture(t) {
  const owner = ownedFixture(t);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paqvilo-dev-close-"),
  );
  const source = createFixture();
  owner.remove(() => source.cleanup());
  owner.remove(() => fs.rm(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith("/")) return response.writeHead(403).end();
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        "<!doctype html><title>Owned close fixture</title><p>Synthetic portal</p>",
      );
  });
  server.on("connect", (_request, socket) =>
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"),
  );
  owner.add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(directory, "paqvilo.config.yml");
  const channel =
    process.env.PAQVILO_BROWSER ||
    (process.platform === "win32" ? "msedge" : "chromium");
  await fs.writeFile(
    config,
    JSON.stringify({
      defaultSite: "synthetic",
      panel: false,
      browser: { channel, headless: true, profileDir: "profiles" },
      sites: {
        synthetic: { source: source.dir, environments: { dev: origin } },
      },
    }),
  );
  const browserOptions = {
    channel: channel === "chromium" ? undefined : channel,
    headless: true,
    proxy: { server: origin, bypass: "127.0.0.1,localhost" },
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ],
  };
  const browser = await chromium.launch(browserOptions);
  owner.add(() => browser.close());
  const context = await browser.newContext();
  const selection = await loadDevTargets({ config }, {});
  return {
    owner,
    directory,
    config,
    origin,
    context,
    selection,
    browserOptions,
  };
}

for (const multiple of [false, true]) {
  test(
    `development teardown exposes actual agent filesystem failure and drains remaining owners (${multiple ? "multiple causes" : "single cause"})`,
    { timeout: 30000 },
    async (t) => {
      const { owner, origin, context, selection } = await fixture(t);
      const pageListeners = context.listenerCount("page");
      const runtime = await startDevSessions(context, selection, {
        log: () => {},
      });
      const record = runtime.active.get(origin);
      const discovery = record.agent.discoveryFile;
      const logFailure = new Error("Invented synchronous log cleanup failure");
      let expectedFailure;
      owner.add(async () => {
        // The blocker is entirely owned by this fixture. Preserve genuine cleanup
        // faults while accepting only the exact failure asserted by this test.
        await fs.rmdir(discovery);
        try {
          await runtime.close();
        } catch (cause) {
          if (cause !== expectedFailure) throw cause;
        }
      });
      await fs.unlink(discovery);
      await fs.mkdir(discovery);
      const stopLogs = record.stopLogs;
      if (multiple)
        record.stopLogs = () => {
          stopLogs();
          throw logFailure;
        };
      let watcherClosed = false;
      const closeWatcher = record.watcher.close.bind(record.watcher);
      owner.add(async () => {
        // Also drain directly if a counterfactual runtime abandons this record
        // after a synchronous stop callback failure.
        await closeWatcher();
        try {
          await record.agent.close();
        } catch (cause) {
          if (!/EISDIR|EPERM/.test(cause.code ?? "")) throw cause;
        }
      });
      record.watcher.close = async () => {
        await closeWatcher();
        watcherClosed = true;
      };
      let failure;
      try {
        await runtime.close();
      } catch (cause) {
        failure = cause;
      }
      expectedFailure = failure;
      assert.ok(
        failure,
        "cleanup failure must not become successful runtime completion",
      );
      let agentFailure;
      try {
        await record.agent.close();
      } catch (cause) {
        agentFailure = cause;
      }
      assert.match(agentFailure.code, /EISDIR|EPERM/);
      if (multiple) {
        assert.ok(failure instanceof AggregateError);
        assert.deepEqual(failure.errors, [logFailure, agentFailure]);
      } else
        assert.equal(
          failure,
          agentFailure,
          "one original error remains unchanged",
        );
      assert.equal(
        runtime.failure instanceof AggregateError
          ? runtime.failure.errors.includes(agentFailure)
          : runtime.failure === agentFailure,
        true,
        "failure remains observable after records are removed",
      );
      assert.equal(watcherClosed, true);
      assert.equal(runtime.active.size, 0);
      assert.equal(context.listenerCount("page"), pageListeners);
      assert.equal(record.session.eventNames().length, 0);
      await assert.rejects(
        fetch(record.agent.endpoint + "/v1/session", {
          signal: AbortSignal.timeout(1000),
        }),
        "the failed remover must not leave its HTTP listener open",
      );
      await assert.rejects(runtime.close(), (cause) => cause === failure);
    },
  );
}

test(
  "development initialization preserves its primary failure and a separate real watcher cleanup failure",
  { timeout: 30000 },
  async (t) => {
    const { owner, context, selection } = await fixture(t);
    const primary = new Error("Invented source reconciliation failure");
    const cleanup = new Error("Invented watcher close failure");
    const create = OverlaySession.create;
    t.mock.method(OverlaySession, "create", async function (...args) {
      const session = await create.apply(this, args);
      session.reconcile = () => {
        throw primary;
      };
      return session;
    });
    const originalWatch = chokidar.watch;
    const watches = [];
    t.mock.method(chokidar, "watch", function (...args) {
      const watcher = originalWatch.apply(this, args);
      const close = watcher.close.bind(watcher);
      const first = watches.length === 0;
      watches.push({ watcher, close });
      watcher.close = async () => {
        await close();
        if (first) throw cleanup;
      };
      return watcher;
    });
    owner.add(async () => {
      for (const entry of watches) await entry.close();
    });
    const listeners = context.listenerCount("page");
    await assert.rejects(
      startDevSessions(context, selection, { log: () => {} }),
      (cause) => {
        assert.ok(cause instanceof AggregateError);
        assert.deepEqual(cause.errors, [primary, cleanup]);
        return true;
      },
    );
    assert.ok(watches.length > 0);
    for (const entry of watches)
      assert.deepEqual(entry.watcher.getWatched(), {});
    assert.equal(context.listenerCount("page"), listeners);
  },
);

test(
  "actual development CLI exits nonzero after agent filesystem cleanup failure",
  { timeout: 30000 },
  async (t) => {
    const { owner, directory, config, browserOptions } = await fixture(t);
    const preload = path.join(directory, "loopback-browser.mjs");
    await fs.writeFile(
      preload,
      `import {chromium} from ${JSON.stringify(import.meta.resolve("playwright-core"))};\nconst launch=chromium.launchPersistentContext;chromium.launchPersistentContext=function(profile,options){return launch.call(this,profile,{...options,proxy:${JSON.stringify(browserOptions.proxy)},args:[...options.args,...${JSON.stringify(browserOptions.args)}]});};\n`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(?:PAQVILO_|GIT_)/.test(key) &&
          ![
            "NODE_OPTIONS",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NODE_USE_ENV_PROXY",
          ].includes(key),
      ),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "lense/cli.mjs",
        "dev",
        "--config",
        config,
        "--headless",
        "--debug-port",
        "0",
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env,
        signal: t.signal,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-32000);
      });
    const closed = new Promise((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    child.on("error", () => {}); // Abort is owned by the test deadline; close is still awaited.
    let discovery, blocker;
    owner.add(async () => {
      if (child.exitCode === null && child.signalCode === null && !child.killed)
        child.kill();
      await closed;
      if (blocker) await fs.rmdir(blocker);
    });
    const agentDir = path.join(directory, ".paqvilo", "agents");
    const deadline = Date.now() + 15000;
    while (!discovery && Date.now() < deadline) {
      assert.equal(
        child.exitCode,
        null,
        "actual dev must reach its agent startup",
      );
      try {
        const name = (await fs.readdir(agentDir)).find((name) =>
          name.endsWith(".json"),
        );
        if (name) {
          blocker = path.join(agentDir, name);
          discovery = JSON.parse(await fs.readFile(blocker, "utf8"));
        }
      } catch {
        /* the first discovery write may still be in flight */
      }
      if (!discovery) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(discovery, "actual CLI published its owned agent");
    await fs.unlink(blocker);
    await fs.mkdir(blocker);
    const response = await fetch(discovery.endpoint + "/v1/stop", {
      method: "POST",
      headers: {
        authorization: `Bearer ${discovery.token}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(
      await closed,
      1,
      "actual CLI must report unsuccessful shutdown",
    );
    assert.equal(
      output.includes(discovery.token),
      false,
      "discovery credentials must not enter diagnostics",
    );
    assert.match(output, /EISDIR|EPERM|directory/);
    await assert.rejects(
      fetch(discovery.endpoint + "/v1/session", {
        signal: AbortSignal.timeout(1000),
      }),
    );
  },
);
