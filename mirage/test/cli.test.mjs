// CLI subprocess acceptance: disposable exports, explicit solution roots and loopback only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
async function fixture(t, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-mirage-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  return directory;
}
async function run(args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

test(
  "CLI: standard/enhanced inspect, local render, controlled argument errors and no absolute render traffic",
  { timeout: 60_000 },
  async (t) => {
    const directory = await fixture(t, {
      "standard/Home.webpage.yml":
        "adx_webpageid: home\nadx_name: CLI standard\nadx_partialurl: /\n",
      "standard/Home.webpage.copy.html":
        '<h1>CLI local {{ "Liquid" | upcase }}</h1>',
      "standard/deployment-profiles/sandbox.deployment.yml":
        "adx_webpage:\n- adx_webpageid: home\n  adx_name: Profile selected explicitly\n",
      "enhanced/home/powerpagecomponent.xml":
        '<powerpagecomponent powerpagecomponentid="enhanced-home"><name>Enhanced home</name><powerpagecomponenttype>2</powerpagecomponenttype><content>{&quot;adx_webpageid&quot;:&quot;enhanced-home&quot;,&quot;adx_name&quot;:&quot;Enhanced home&quot;,&quot;adx_partialurl&quot;:&quot;/&quot;,&quot;adx_copy&quot;:&quot;&lt;h1&gt;Enhanced local&lt;/h1&gt;&quot;}</content></powerpagecomponent>',
    });
    const standard = path.join(directory, "standard");
    let result = await run(
      ["inspect", "--source", standard, "--env", "sandbox", "--json"],
      directory,
    );
    assert.equal(result.code, 0, result.stderr);
    const inspected = JSON.parse(result.stdout);
    assert.equal(inspected.format, "standard");
    assert.equal(inspected.pages[0].url, "/");
    assert.equal(inspected.pages[0].name, "CLI standard");
    result = await run(
      [
        "inspect",
        "--source",
        standard,
        "--env",
        "sandbox",
        "--deployment-profile",
        "sandbox",
        "--json",
      ],
      directory,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).pages[0].name,
      "Profile selected explicitly",
    );
    assert.match(
      await fs.readFile(path.join(standard, "Home.webpage.yml"), "utf8"),
      /CLI standard/,
    );
    result = await run(
      ["inspect", "--source", path.join(directory, "enhanced"), "--json"],
      directory,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).format, "enhanced");
    assert.equal(JSON.parse(result.stdout).pages[0].name, "Enhanced home");
    const output = path.join(directory, "rendered.html");
    result = await run(
      [
        "render",
        "--source",
        standard,
        "--state",
        path.join(directory, "render-state.json"),
        "--path",
        "/",
        "--output",
        output,
      ],
      directory,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 200);
    assert.match(await fs.readFile(output, "utf8"), /CLI local LIQUID/);
    let unrelatedTraffic = 0;
    const unrelated = http.createServer((_req, res) => {
      unrelatedTraffic++;
      res.end("Unrelated");
    });
    unrelated.listen(0, "127.0.0.1");
    await once(unrelated, "listening");
    t.after(() => new Promise((resolve) => unrelated.close(resolve)));
    const unrelatedUrl = `http://127.0.0.1:${unrelated.address().port}/unrelated`;
    for (const badPath of [
      unrelatedUrl,
      unrelatedUrl.replace("http:", ""),
      "/\\127.0.0.1/unsafe",
    ]) {
      result = await run(
        [
          "render",
          "--source",
          standard,
          "--state",
          path.join(directory, "invalid-render-state.json"),
          "--path",
          badPath,
        ],
        directory,
      );
      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        /portal-relative|escaped the local simulator/,
      );
    }
    assert.equal(unrelatedTraffic, 0);
    result = await run(
      ["inspect", "--source", standard, "--not-an-option"],
      directory,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option/);
    assert.doesNotMatch(
      result.stderr,
      /at parseArgs|node:internal|ERR_PARSE_ARGS/,
    );
    const unusedState = path.join(directory, "capture-state.json");
    result = await run(
      [
        "capture-shell",
        "--source",
        standard,
        "--state",
        unusedState,
        "--path",
        "/",
      ],
      directory,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires --cdp/);
    await assert.rejects(
      fs.stat(unusedState),
      (error) => error.code === "ENOENT",
    );
    result = await run(
      [
        "capture-shell",
        "--source",
        standard,
        "--state",
        unusedState,
        "--cdp",
        "http://127.0.0.1:1",
        "--preset",
        "contact-demo",
      ],
      directory,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not apply presets/);
    await assert.rejects(
      fs.stat(unusedState),
      (error) => error.code === "ENOENT",
    );
  },
);

test(
  "CLI: explicit solution root resolves real form fixture and owned serve process shuts down cleanly",
  { timeout: 45_000 },
  async (t) => {
    const directory = await fixture(t, {
      "portal/Home.webpage.yml":
        "adx_webpageid: home\nadx_name: Form page\nadx_partialurl: /\n",
      "portal/Home.webpage.copy.html":
        "<h1>Form fixture</h1>{% entityform name: 'Edit contact' %}",
      "portal/Edit.basicform.yml":
        "adx_entityformid: basic-form\nadx_name: Edit contact\nadx_entityname: contact\nadx_formname: Portal edit\nadx_mode: 100000000\n",
      "solutions/Package/Entities/contact/Entity.xml":
        '<Entity><Name>contact</Name><EntityInfo><entity Name="contact"><PrimaryIdAttribute>contactid</PrimaryIdAttribute><EntitySetName>contacts</EntitySetName><attributes><attribute PhysicalName="fullname"><LogicalName>fullname</LogicalName><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel></attribute></attributes></entity></EntityInfo></Entity>',
      "solutions/Package/Entities/contact/FormXml/main/{form-id}.xml":
        '<forms><systemform><formid>{form-id}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column width="100%"><sections><section name="contact"><rows><row><cell showlabel="true"><labels><label description="Friendly name" languagecode="1033"/></labels><control id="fullname" datafieldname="fullname"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal edit" languagecode="1033"/></LocalizedNames></systemform></forms>',
    });
    const child = spawn(
      process.execPath,
      [
        cli,
        "serve",
        "--source",
        path.join(directory, "portal"),
        "--solution-root",
        path.join(directory, "solutions"),
        "--state",
        "state.json",
        "--port",
        "0",
        "--no-watch",
      ],
      { cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "",
      stderr = "",
      ended = false;
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const completion = once(child, "close").then((values) => {
      ended = true;
      return values;
    });
    t.after(async () => {
      if (!ended) {
        child.stdin.write("stop\n");
        const stopped = await Promise.race([
          completion,
          new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (!stopped) {
          child.kill();
          await completion;
        }
      }
    });
    const discovery = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`CLI did not start: ${stderr}`)),
        12_000,
      );
      const check = () => {
        try {
          const value = JSON.parse(stdout);
          clearTimeout(timeout);
          child.stdout.off("data", check);
          resolve(value);
        } catch {
          /* Wait for complete startup JSON. */
        }
      };
      child.stdout.on("data", check);
      completion.then(() => {
        clearTimeout(timeout);
        if (!stdout) reject(new Error(`CLI exited before startup: ${stderr}`));
      });
    });
    const stateResponse = await fetch(`${discovery.url}/__sim/api/state`);
    assert.equal(discovery.stateFile, path.join(directory, "state.json"));
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.status.solutionMetadata.resolved.forms, 1);
    assert.deepEqual(state.status.solutionMetadata.roots, [
      path.join(directory, "solutions"),
    ]);
    const page = await fetch(discovery.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Friendly name/);
    assert.ok(await fs.stat(discovery.discovery));
    child.stdin.write("stop\n");
    const [code] = await completion;
    assert.equal(code, 0, stderr);
    await assert.rejects(
      fs.stat(discovery.discovery),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(fetch(discovery.url));
  },
);
