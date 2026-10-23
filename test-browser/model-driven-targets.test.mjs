import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { ownedFixture } from "../mirage/testing/owned-fixture.mjs";

const cli = fileURLToPath(new URL("../lense/cli.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function modelTargetsFixture(t) {
  const owner = ownedFixture(t);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "paqvilo-model-targets-"),
  );
  owner.remove(() => fs.rm(directory, { recursive: true, force: true }));
  const methods = [],
    documentReads = [0, 0],
    nativeReads = [0, 0],
    servers = [];
  const origins = [];
  for (let index = 0; index < 2; index++) {
    const server = http.createServer((request, response) => {
      if (!request.url.startsWith("/")) return response.writeHead(403).end();
      methods.push(request.method);
      if (request.url.startsWith(`/resource-${index}.js`)) {
        nativeReads[index]++;
        return response
          .writeHead(200, { "content-type": "text/javascript" })
          .end('window.targetRevision="native";');
      }
      if (request.url.startsWith(`/resource-${index}.css`))
        return response
          .writeHead(200, { "content-type": "text/css" })
          .end("#sentinel{color:rgb(1,2,3)}");
      if (request.url === "/favicon.ico") return response.writeHead(204).end();
      documentReads[index]++;
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<!doctype html><title>Invented target ${index}</title><link rel="stylesheet" href="/resource-${index}.css"><h1 id="sentinel">Target ${index}</h1><script src="/resource-${index}.js"></script>`,
        );
    });
    server.on("connection", (socket) =>
      socket.on("error", (error) => {
        if (!["ECONNRESET", "EPIPE"].includes(error.code))
          server.emit("error", error);
      }),
    );
    server.on("connect", (_request, socket) =>
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    origins.push(`http://127.0.0.1:${server.address().port}`);
  }
  // Kill/await the child before closing fixture servers or removing its profile.
  let child, closed, browser;
  owner.add(async () => {
    if (
      child &&
      child.exitCode === null &&
      child.signalCode === null &&
      !child.killed
    )
      child.kill();
    if (closed) await closed;
  });
  owner.add(() => browser?.close());
  owner.add(async () => {
    const failures = [];
    for (const server of servers) {
      try {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned model target servers did not close",
      );
  });
  const solution = path.join(directory, "solution"),
    resources = path.join(solution, "WebResources");
  await fs.mkdir(path.join(solution, "Other"), { recursive: true });
  await fs.mkdir(resources);
  await fs.writeFile(
    path.join(solution, "Other/Solution.xml"),
    "<ImportExportXml><SolutionManifest><UniqueName>InventedTargets</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>",
  );
  const js = path.join(resources, "x_script.js"),
    css = path.join(resources, "x_style.css");
  await fs.writeFile(js, 'window.targetRevision="initial";');
  await fs.writeFile(css, "#sentinel{color:rgb(11,22,33)}");
  for (const [name, type] of [
    ["x_script.js", 3],
    ["x_style.css", 2],
  ])
    await fs.writeFile(
      path.join(resources, `${name}.data.xml`),
      `<WebResource><Name>${name}</Name><WebResourceType>${type}</WebResourceType><FileName>WebResources/${name}</FileName></WebResource>`,
    );
  execFileSync("git", ["init", "-q"], { cwd: solution, windowsHide: true });
  execFileSync("git", ["add", "."], { cwd: solution, windowsHide: true });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Invented",
      "-c",
      "user.email=invented@example.invalid",
      "commit",
      "-qm",
      "Initial",
    ],
    { cwd: solution, windowsHide: true },
  );
  const maps = [];
  for (let index = 0; index < 2; index++) {
    const file = path.join(directory, `map-${index}.json`);
    maps.push(file);
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        resources: [
          { path: `/resource-${index}.js`, resource: "x_script.js" },
          { path: `/resource-${index}.css`, resource: "x_style.css" },
        ],
      }),
    );
  }
  const project = path.join(directory, "project.json");
  await fs.writeFile(
    project,
    JSON.stringify({
      version: 2,
      runtime: { kind: "model-driven" },
      modelDriven: {
        trustedExtensions: true,
        targets: origins.map((_origin, index) => ({
          reference: index ? "review" : "development",
          startPath: `/main.aspx?target=${index}`,
          resourceMap: `./map-${index}.json`,
          caution: index === 1,
        })),
      },
      solutions: [{ id: "invented", path: "./solution" }],
      references: origins.map((origin, index) => ({
        id: index ? "review" : "development",
        origin,
        name: "Invented app",
        environment: index ? "review" : "development",
        default: index === 0,
      })),
    }),
  );
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const debugPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
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
  let output = "";
  const wait = async (predicate, label, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (child?.exitCode !== null && child?.exitCode !== undefined)
        throw new Error(
          `${label}: owned CLI exited ${child.exitCode}: ${output}`,
        );
      const value = await predicate();
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`${label}: exceeded ${timeout}ms: ${output}`);
  };
  child = spawn(
    process.execPath,
    [
      "--import",
      new URL("./helpers/browser-loopback-preload.mjs", import.meta.url).href,
      cli,
      "model-driven",
      "dev",
      "--project",
      project,
      "--env",
      "development",
      "--browser",
      process.platform === "win32" ? "msedge" : "chromium",
      "--headless",
      "--debug-port",
      String(debugPort),
      "--output",
      path.join(directory, "report.json"),
    ],
    {
      cwd: directory,
      env: { ...env, PAQVILO_TEST_LOOPBACK_PROXY: origins[0] },
      windowsHide: true,
      signal: t.signal,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.on("error", (error) => {
    if (error.name !== "AbortError")
      output += `\n${error.name}: ${error.message}`;
  });
  closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      if (code !== 0 && code !== null) t.diagnostic(output);
      resolve({ code, signal });
    }),
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-32000);
    });
  const agents = path.join(directory, ".paqvilo/agents");
  const discoveries = async () => {
    let names;
    try {
      names = await fs.readdir(agents);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          fs.readFile(path.join(agents, name), "utf8").then(JSON.parse),
        ),
    );
  };
  await wait(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
    } catch {
      return false;
    }
  }, "owned CDP listener");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = await wait(
    () =>
      browser
        .contexts()[0]
        .pages()
        .find((page) => page.url().startsWith(origins[0])),
    "initial target page",
  );
  page.setDefaultTimeout(10000);
  await page.waitForFunction(() => window.targetRevision === "initial");
  await page.locator("#paqvilo-panel").waitFor();
  await wait(async () => (await discoveries()).length > 0, "owned agent");
  const initialAgents = await discoveries();
  assert.equal(initialAgents.length, 1);
  assert.equal(initialAgents[0].pid, child.pid);
  return {
    owner,
    directory,
    solution,
    js,
    css,
    maps,
    origins,
    page,
    browser,
    child,
    closed,
    methods,
    documentReads,
    nativeReads,
    discoveries,
    wait,
    getOutput: () => output,
  };
}

test(
  "actual model-driven CLI switches declared references with caution, mappings and retired-origin boundaries",
  { timeout: 60000 },
  async (t) => {
    const f = await modelTargetsFixture(t),
      { page, origins } = f;
    try {
      const host = page.locator("#paqvilo-panel");
      const open = async () => {
        await host.waitFor();
        if (!(await host.locator(".wrap.open").count()))
          await page.keyboard.press("Alt+Shift+P");
        await host.locator(".wrap.open").waitFor();
      };
      await open();
      const selector = page.getByLabel("Portal / environment", { exact: true });
      assert.deepEqual(await selector.locator("option").allTextContents(), [
        "Invented app @ development",
        "Invented app @ review",
      ]);
      assert.equal(
        f.documentReads[1],
        0,
        "rendering the selector does not probe another origin",
      );
      await selector.selectOption("1");
      assert.equal(
        new URL(page.url()).origin,
        origins[0],
        "selection alone does not navigate",
      );
      await page.locator("[data-target-go]").click();
      await page.getByRole("alertdialog").waitFor();
      await page.locator("[data-target-cancel]").click();
      assert.equal(new URL(page.url()).origin, origins[0]);
      assert.equal(f.documentReads[1], 0);
      await selector.evaluate((node) => {
        node.add(new Option("Foreign URL", "https://example.invalid"));
        node.value = "https://example.invalid";
      });
      await page.locator("[data-target-go]").click();
      assert.equal(
        new URL(page.url()).origin,
        origins[0],
        "unlisted option cannot supply an origin",
      );
      const old = await page.evaluate(() => ({
        token: document.getElementById("paqvilo-panel").__pp.token,
      }));
      const oldAgents = await f.discoveries();
      await host.getByRole("tab", { name: "Actions", exact: true }).click();
      await host
        .locator(".actions-tabs")
        .getByRole("button", { name: "Custom", exact: true })
        .click();
      await host
        .getByRole("textbox", { name: "Command label", exact: true })
        .fill("Owned pending command");
      await host
        .getByRole("textbox", { name: "Command JavaScript", exact: true })
        .fill(
          'window.ownedPendingStarted=true; await new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true})); return "RETIRED_ORIGIN_RESULT";',
        );
      await host
        .getByRole("button", { name: "Run command", exact: true })
        .click();
      await page.waitForFunction(() => window.ownedPendingStarted === true);

      await selector.selectOption("1");
      await page.locator("[data-target-go]").click();
      try {
        await Promise.all([
          page.waitForURL(origins[1] + "/main.aspx?target=1"),
          page.locator("[data-target-confirm]").click(),
        ]);
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            url: page.url(),
            closed: page.isClosed(),
            childExit: f.child.exitCode,
            output: f.getOutput(),
          }),
        );
        throw error;
      }
      await page.waitForFunction(() => window.targetRevision === "initial");
      await open();
      assert.equal(await selector.inputValue(), "1");
      assert.equal(
        await host.getByText("RETIRED_ORIGIN_RESULT", { exact: true }).count(),
        0,
        "retired pending command cannot deliver into the new target",
      );
      const stale = await page.evaluate(
        (old) =>
          window.__paqviloModelPanelApi({
            token: old.token,
            name: "mode",
            body: { online: true },
          }),
        old,
      );
      assert.equal(
        stale.ok,
        false,
        "old origin capability cannot mutate the selected target",
      );
      for (const agent of oldAgents) {
        const response = await fetch(agent.endpoint + "/v1/session", {
          headers: { authorization: `Bearer ${agent.token}` },
        }).catch(() => null);
        if (response) await response.arrayBuffer();
        assert.ok(
          !response || !response.ok,
          "retired origin agent is not still authorized",
        );
      }
      await fs.writeFile(f.js, 'window.targetRevision="review-save";');
      await page.waitForFunction(() => window.targetRevision === "review-save");
      assert.equal(
        new URL(page.url()).origin,
        origins[1],
        "source save reloads the selected reference",
      );
      assert.equal(
        f.nativeReads[1],
        0,
        "review mapping overlays its own resource URL",
      );
      await open();
      await selector.selectOption("0");
      await Promise.all([
        page.waitForURL(origins[0] + "/main.aspx?target=0"),
        page.locator("[data-target-go]").click(),
      ]);
      await page.waitForFunction(() => window.targetRevision === "review-save");
      await open();
      assert.equal(await selector.inputValue(), "0");
      const agents = await f.discoveries();
      assert.equal(agents.length, 1, "only the current target agent remains");
      assert.equal(agents[0].pid, f.child.pid);
      const stopped = await fetch(agents[0].endpoint + "/v1/stop", {
        method: "POST",
        headers: {
          authorization: `Bearer ${agents[0].token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(stopped.status, 200);
      assert.equal((await f.closed).code, 0, f.getOutput());
      assert.deepEqual(await f.discoveries(), []);
      assert.ok(
        f.methods.every((method) => method === "GET"),
        "all invented app requests remain read-only",
      );
      assert.equal(f.getOutput().includes(old.token), false);
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          url: page.url(),
          closed: page.isClosed(),
          childExit: f.child.exitCode,
          output: f.getOutput(),
        }),
      );
      throw error;
    }
  },
);
