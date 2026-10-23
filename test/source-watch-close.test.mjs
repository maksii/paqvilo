import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import chokidar from "chokidar";
import { watchSources } from "../lense/commands/dev.mjs";
import { createFixture } from "./fixture.mjs";
import { ownedFixture } from "../mirage/testing/owned-fixture.mjs";

for (const repositoryFailure of [false, true]) {
  test(
    `source watcher drains its real Git watcher and accepted refresh after close failures (${repositoryFailure ? "multiple" : "single"})`,
    { timeout: 15000 },
    async (t) => {
      const fixture = createFixture();
      ownedFixture(t).remove(() => fixture.cleanup());
      const sourceFailure = new Error("Invented source close failure");
      const gitFailure = new Error("Invented repository close failure");
      const watched = [];
      const originalWatch = chokidar.watch;
      t.mock.method(chokidar, "watch", function (...args) {
        const instance = originalWatch.apply(this, args);
        const originalClose = instance.close.bind(instance);
        const index = watched.length;
        const entry = {
          instance,
          originalClose,
          closes: 0,
          fail: index === 0 || repositoryFailure,
        };
        watched.push(entry);
        instance.close = async () => {
          await originalClose();
          entry.closes++;
          if (entry.fail) {
            entry.fail = false;
            throw index === 0 ? sourceFailure : gitFailure;
          }
        };
        return instance;
      });
      let release;
      const acceptedRefresh = new Promise((resolve) => {
        release = resolve;
      });
      ownedFixture(t).add(async () => {
        release();
        for (const entry of watched) await entry.originalClose();
      });
      const session = Object.assign(new EventEmitter(), {
        cfg: {
          sourceDir: fixture.dir,
          origin: "https://invented.invalid",
          site: {},
        },
        baseline: {
          available: true,
          spec: "HEAD",
          commit: "a".repeat(40),
          checkForUpdate: async () => false,
        },
        refreshHead: async () => {},
        model: { webFiles: [] },
        rewriter: { unsupported: [] },
        refreshAsync: async () => {
          session.emit("accepted-refresh");
          await acceptedRefresh;
          return { ignored: true };
        },
        rel: (file) => path.relative(fixture.dir, file),
      });
      const watcher = watchSources(
        session,
        { pages: () => [] },
        { reload: false, log: () => {}, baselinePollMs: 60000 },
      );
      await watcher.ready;
      const deadline = Date.now() + 5000;
      while (watched.length < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        watched.length,
        2,
        "actual source and Git Chokidar instances were created",
      );
      const accepted = once(session, "accepted-refresh", {
        signal: AbortSignal.timeout(5000),
      });
      await fs.appendFile(
        path.join(fixture.dir, "web-files/app.js"),
        "\nwindow.inventedCloseRefresh=true;\n",
      );
      await accepted;
      let settled = false;
      const close = watcher.close().then(
        () => {
          settled = true;
          return null;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      const sourceDeadline = Date.now() + 5000;
      while (!watched[0].closes && Date.now() < sourceDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        `close must await the accepted refresh even when source closing rejects; repository close calls=${watched[1].closes}`,
      );
      release();
      const failure = await close;
      if (repositoryFailure) {
        assert.ok(failure instanceof AggregateError);
        assert.deepEqual(failure.errors, [sourceFailure, gitFailure]);
      } else
        assert.equal(
          failure,
          sourceFailure,
          "one exact original error is preserved",
        );
      assert.equal(
        watched[1].closes,
        1,
        "repository watcher is closed after source-close failure",
      );
      assert.deepEqual(watched[1].instance.getWatched(), {});
      await watcher.close();
      assert.equal(watched[0].closes, 2, "a failed shutdown can be retried");
      assert.equal(watched[1].closes, 2);
    },
  );
}
