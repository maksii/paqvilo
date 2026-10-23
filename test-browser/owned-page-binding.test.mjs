import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { chromium } from "playwright-core";
import { browserLaunchOptions } from "../mirage/lib/browser-launch.mjs";
import { createOwnedPageBindings } from "../lense/owned-page-binding.mjs";
import { comparison } from "../lense/panel.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-binding-test-"));
  const server = http.createServer((request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><h1>Invented</h1>"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const context = await chromium.launchPersistentContext(
    root,
    browserLaunchOptions({
      headless: true,
      args: ["--remote-debugging-port=" + port],
    }),
  );
  const page = context.pages()[0];
  await page.goto(origin);
  t.after(async () => {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { context, page, origin, port };
}

test(
  "owned raw binding survives independent persistent-browser CDP owners and observers",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const helper = new URL("../lense/owned-page-binding.mjs", import.meta.url)
      .href;
    const child = `import{chromium}from'playwright-core';import{createOwnedPageBindings}from'${helper}';const b=await chromium.connectOverCDP('http://127.0.0.1:${f.port}');let observer;try{const p=await b.contexts()[0].newPage();await p.goto('${f.origin}/attached');const bridge=await createOwnedPageBindings(p,{origin:'${f.origin}',bindings:{inventedEcho:(_source,v)=>({echo:v})}});const before=await p.evaluate(()=>inventedEcho('before'));observer=await chromium.connectOverCDP('http://127.0.0.1:${f.port}');const during=await p.evaluate(()=>inventedEcho('during'));await observer.close();observer=null;const after=await p.evaluate(()=>inventedEcho('after'));await p.reload();const navigation=await p.evaluate(()=>inventedEcho('navigation'));await bridge.close();const closed=await p.evaluate(()=>typeof inventedEcho);await p.reload();const retired=await p.evaluate(()=>typeof inventedEcho);console.log(JSON.stringify({before,during,after,navigation,closed,retired}));await p.close()}finally{await observer?.close();await b.close()}`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", child],
      { windowsHide: true },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      before: { echo: "before" },
      during: { echo: "during" },
      after: { echo: "after" },
      navigation: { echo: "navigation" },
      closed: "undefined",
      retired: "undefined",
    });
  },
);

test(
  "owned binding rejects child contexts, foreign origins, oversized calls and oversized replies",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      maxBytes: 200,
      maxResultBytes: 200,
      bindings: {
        inventedEcho(source, value) {
          calls++;
          assert.equal(source.page, f.page);
          assert.equal(source.frame, f.page.mainFrame());
          return value === "large-result" ? "x".repeat(201) : value;
        },
      },
    });
    t.after(() => bridge.close());
    assert.equal(await f.page.evaluate(() => inventedEcho("valid")), "valid");
    assert.equal(
      await f.page.evaluate(async () => {
        try {
          await inventedEcho("x".repeat(300));
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    assert.equal(
      await f.page.evaluate(async () => {
        try {
          await inventedEcho("large-result");
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    await f.page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "/child";
      document.body.append(frame);
    });
    const child = await f.page.waitForEvent("framenavigated", {
      predicate: (frame) => frame !== f.page.mainFrame(),
    });
    assert.equal(await child.evaluate(() => typeof inventedEcho), "undefined");
    await child.evaluate(() => {
      const raw = Object.getOwnPropertyNames(window).find((name) =>
        name.startsWith("__paqviloOwned_"),
      );
      window[raw](
        JSON.stringify({ id: 1, name: "inventedEcho", args: ["child"] }),
      );
    });
    await f.page.goto(f.origin.replace("127.0.0.1", "localhost"));
    assert.equal(await f.page.evaluate(() => typeof inventedEcho), "undefined");
    await f.page.evaluate(() => {
      const raw = Object.getOwnPropertyNames(window).find((name) =>
        name.startsWith("__paqviloOwned_"),
      );
      window[raw](
        JSON.stringify({ id: 1, name: "inventedEcho", args: ["foreign"] }),
      );
    });
    await f.page.waitForTimeout(50);
    assert.equal(calls, 2);
  },
);

test(
  "late callback replies remain confined to the original document context",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let release, began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: {
        inventedEcho(_source, value) {
          if (value === "old") {
            began();
            return new Promise((resolve) => {
              release = resolve;
            });
          }
          return value;
        },
      },
    });
    t.after(() => bridge.close());
    const old = f.page
      .evaluate(() => inventedEcho("old"))
      .catch(() => "document-retired");
    await started;
    await f.page.reload();
    assert.equal(await f.page.evaluate(() => inventedEcho("fresh")), "fresh");
    release("old-reply");
    assert.equal(await old, "document-retired");
    assert.equal(
      await f.page.evaluate(() => inventedEcho("still-fresh")),
      "still-fresh",
    );
  },
);

test(
  "bounded callback lifetime and real debugger pause preserve a fresh bridge call",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      callTimeout: 50,
      bindings: {
        inventedEcho(_source, value) {
          return value === "never" ? new Promise(() => {}) : value;
        },
      },
    });
    t.after(() => bridge.close());
    assert.equal(
      await f.page.evaluate(async () => {
        try {
          await inventedEcho("never");
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    const debuggerSession = await f.context.newCDPSession(f.page);
    let pauses = 0;
    debuggerSession.on("Debugger.paused", () => {
      pauses++;
      void debuggerSession.send("Debugger.resume").catch(() => {});
    });
    await debuggerSession.send("Debugger.enable");
    assert.equal(
      await f.page.evaluate(() => {
        debugger;
        return inventedEcho("after-debugger");
      }),
      "after-debugger",
    );
    assert.ok(pauses > 0);
    await debuggerSession.detach();
  },
);

test(
  "wrapper installation exceptions fail readiness and clean the owned channel",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.page.evaluate(() =>
      Object.defineProperty(window, "inventedEcho", {
        value: "occupied",
        configurable: false,
      }),
    );
    await assert.rejects(
      createOwnedPageBindings(f.page, {
        origin: f.origin,
        bindings: { inventedEcho: () => "unexpected" },
      }),
      /wrapper installation failed/,
    );
    assert.equal(
      await f.page.evaluate(
        () =>
          Object.getOwnPropertyNames(window).filter((name) =>
            name.startsWith("__paqviloOwned"),
          ).length,
      ),
      0,
    );
    assert.equal(await f.page.evaluate(() => inventedEcho), "occupied");
  },
);

test(
  "cleanup attempts later real protocol operations and preserves an exact injected cause",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      original = f.context.newCDPSession.bind(f.context);
    const marker = Error("Invented script cleanup refusal");
    let fail = false;
    const commands = [];
    f.context.newCDPSession = async (page) => {
      const session = await original(page),
        send = session.send.bind(session);
      session.send = async (method, params) => {
        commands.push(method);
        if (fail && method === "Page.removeScriptToEvaluateOnNewDocument")
          throw marker;
        return send(method, params);
      };
      return session;
    };
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: { inventedEcho: (_source, value) => value },
    });
    fail = true;
    commands.length = 0;
    await assert.rejects(bridge.close(), (error) => error === marker);
    assert.ok(
      commands.indexOf("Runtime.evaluate") >
        commands.indexOf("Page.removeScriptToEvaluateOnNewDocument"),
    );
    assert.ok(
      commands.indexOf("Runtime.removeBinding") >
        commands.indexOf("Runtime.evaluate"),
    );
    assert.equal(await f.page.evaluate(() => typeof inventedEcho), "undefined");
  },
);

test(
  "closing the bridge preserves a real user debugger pause and the owned browser",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: { inventedEcho: (_source, value) => value },
    });
    const debuggerSession = await f.context.newCDPSession(f.page);
    await debuggerSession.send("Debugger.enable");
    let resolvePaused,
      resumed = false;
    const paused = new Promise((resolve) => {
      resolvePaused = resolve;
    });
    debuggerSession.on("Debugger.paused", resolvePaused);
    debuggerSession.on("Debugger.resumed", () => {
      resumed = true;
    });
    const execution = f.page.evaluate(() => {
      debugger;
      return "continued";
    });
    await paused;
    const started = Date.now();
    try {
      await bridge.close();
      assert.ok(Date.now() - started < 2500);
      assert.equal(resumed, false);
      assert.equal(f.page.isClosed(), false);
    } finally {
      await debuggerSession.send("Debugger.resume").catch(() => {});
      await debuggerSession.detach();
    }
    assert.equal(await execution, "continued");
  },
);

test(
  "blocked protocol replies release capacity and expired delivery cannot complete a request",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      original = f.context.newCDPSession.bind(f.context);
    let send,
      blocked = true;
    const delayed = [];
    f.context.newCDPSession = async (page) => {
      const session = await original(page);
      send = session.send.bind(session);
      session.send = (method, params) => {
        if (blocked && method === "Runtime.callFunctionOn") {
          delayed.push(params);
          return new Promise(() => {});
        }
        return send(method, params);
      };
      return session;
    };
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: { inventedEcho: (_source, value) => value },
    });
    t.after(() => bridge.close());
    await f.page.evaluate(() => {
      window.ownedDeliveryProbe = Promise.all(
        Array.from({ length: 32 }, () =>
          inventedEcho("held").then(
            () => "incorrect-success",
            () => "rejected",
          ),
        ),
      );
    });
    const deadline = Date.now() + 2000;
    while (delayed.length < 32 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delayed.length, 32);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    blocked = false;
    assert.equal(
      await f.page.evaluate(() => inventedEcho("fresh-after-deadlines")),
      "fresh-after-deadlines",
    );
    for (const params of delayed) await send("Runtime.callFunctionOn", params);
    assert.deepEqual(
      await f.page.evaluate(() => window.ownedDeliveryProbe),
      Array(32).fill("rejected"),
    );
  },
);

test(
  "existing Unicode Diff results above4MiB remain supported and results above16MiB are refused",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const before = ("//" + "漢".repeat(498) + "\n").repeat(1500),
      after = ("//" + "字".repeat(498) + "\n").repeat(1500);
    assert.ok(
      Buffer.byteLength(before) < 3 * 1024 * 1024 &&
        Buffer.byteLength(after) < 3 * 1024 * 1024,
    );
    const valid = comparison(before, after);
    assert.ok(Buffer.byteLength(JSON.stringify(valid)) > 4 * 1024 * 1024);
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: {
        inventedEcho: (_source, input) =>
          input === "valid" ? valid : "x".repeat(16 * 1024 * 1024 + 1),
      },
    });
    t.after(() => bridge.close());
    const result = await f.page.evaluate(async () => {
      const value = await inventedEcho("valid");
      return {
        lines: value.lines.length,
        added: value.added,
        removed: value.removed,
      };
    });
    assert.deepEqual(result, {
      lines: 3000,
      added: valid.added,
      removed: valid.removed,
    });
    assert.equal(
      await f.page.evaluate(async () => {
        try {
          await inventedEcho("oversized");
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
  },
);

test(
  "cross-origin retirement accepts only actual already-absent script removal and still retires wrappers",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      original = f.context.newCDPSession.bind(f.context);
    let absenceObserved = false;
    f.context.newCDPSession = async (page) => {
      const session = await original(page),
        send = session.send.bind(session);
      session.send = async (method, params) => {
        if (method !== "Page.removeScriptToEvaluateOnNewDocument")
          return send(method, params);
        // A real second removal deterministically exercises Chromium's absence response
        // even on versions which retain script IDs across the origin change.
        try {
          await send(method, params);
          await send(method, params);
        } catch (error) {
          absenceObserved = error.message.endsWith(
            "Protocol error (Page.removeScriptToEvaluateOnNewDocument): Script not found",
          );
          throw error;
        }
      };
      return session;
    };
    const bridge = await createOwnedPageBindings(f.page, {
      origin: f.origin,
      bindings: { inventedEcho: (_source, value) => value },
    });
    assert.equal(await f.page.evaluate(() => inventedEcho("before")), "before");
    await f.page.goto(f.origin.replace("127.0.0.1", "localhost"));
    await bridge.close();
    assert.equal(absenceObserved, true);
    await f.page.goto(f.origin);
    assert.equal(await f.page.evaluate(() => typeof inventedEcho), "undefined");
  },
);
