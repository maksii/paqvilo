import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { routingApi } from "./storage-routing-fixture.mjs";

test("storage fixture closes every restarted API/provider before failed directory cleanup", async () => {
  const hooks = [],
    context = { after: (hook) => hooks.push(hook) };
  const first = await routingApi(context);
  await first.close();
  const second = await routingApi(context, { root: first.root });
  const remove = fs.rm,
    failure = Object.assign(new Error("Invented directory cleanup failure"), {
      code: "ENOTEMPTY",
    });
  let observed = false;
  fs.rm = async (target, options) => {
    if (target === first.root) {
      observed = true;
      assert.ok(
        second.server.servers.every((server) => !server.listening),
        "Current restarted listeners must close before removal",
      );
      assert.equal(
        (await second.provider.preflight()).ready,
        false,
        "Current provider must close before removal",
      );
      throw failure;
    }
    return remove(target, options);
  };
  try {
    await assert.rejects(
      async () => {
        for (const hook of hooks) await hook();
      },
      (error) => error === failure,
    );
    assert.equal(observed, true);
    await assert.rejects(
      fetch(second.server.origin, { signal: AbortSignal.timeout(1000) }),
    );
  } finally {
    fs.rm = remove;
    await second.close();
    await remove(first.root, { recursive: true, force: true });
  }
});

test("storage fixture attempts provider cleanup after server cleanup fails and preserves the state directory", async () => {
  const hooks = [],
    fixture = await routingApi({ after: (hook) => hooks.push(hook) });
  const closeServer = fixture.server.close,
    failure = new Error(
      "Invented server close failure after listener shutdown",
    );
  fixture.server.close = async () => {
    await closeServer();
    throw failure;
  };
  try {
    await assert.rejects(
      async () => {
        for (const hook of hooks) await hook();
      },
      (error) => error === failure,
    );
    assert.ok(fixture.server.servers.every((server) => !server.listening));
    assert.equal(
      (await fixture.provider.preflight()).ready,
      false,
      "Provider closes even when another resource fails",
    );
    assert.ok(
      (await fs.stat(fixture.root)).isDirectory(),
      "Failed close preserves the evidence directory",
    );
  } finally {
    fixture.server.close = closeServer;
    await fixture.close();
    await fixture.provider.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("storage fixture drains an accepted blob delete before directory cleanup", async () => {
  const hooks = [],
    fixture = await routingApi({ after: (hook) => hooks.push(hook) });
  const remove = fs.rm,
    objectPrefix = path.join(fixture.root, "blobs", "objects") + path.sep;
  let enter,
    release,
    removed = false,
    cleanup;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  fs.rm = async (target, options) => {
    if (String(target).startsWith(objectPrefix)) {
      enter();
      await gate;
    }
    if (target === fixture.root) removed = true;
    return remove(target, options);
  };
  try {
    const widget = "fx_widgets(77777777-7777-4777-8777-7777777777b2)";
    assert.equal(
      (
        await fixture.call(
          "PATCH",
          widget + "/fx_doc",
          Buffer.from("invented bytes"),
          {
            "content-type": "application/octet-stream",
            "x-ms-file-name": "owned.txt",
          },
        )
      ).status,
      204,
    );
    assert.equal(
      (await fixture.call("DELETE", widget + "/fx_doc")).status,
      204,
    );
    await entered;
    cleanup = (async () => {
      for (const hook of hooks) await hook();
    })();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      removed,
      false,
      "Directory cleanup must await the accepted release",
    );
    release();
    await cleanup;
    assert.equal(removed, true);
    await assert.rejects(fs.stat(fixture.root), { code: "ENOENT" });
  } finally {
    release();
    await cleanup?.catch(() => {});
    fs.rm = remove;
    await fixture.close();
    await remove(fixture.root, { recursive: true, force: true });
  }
});
