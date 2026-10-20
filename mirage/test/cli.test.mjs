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
function within(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message())), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}
function closed(child) {
  // AbortSignal emits an error before close. Observe it immediately, but wait
  // for close so cleanup also covers the process and all of its stdio pipes.
  return new Promise(resolve => {
    let error;
    // Shutdown can race the child's exit; an EPIPE on our stop command is
    // harmless once close has confirmed that the owned process has ended.
    child.stdin.on("error", () => {});
    child.once("error", cause => { error = cause; });
    child.once("close", (code, signal) => resolve({ code, signal, error }));
  });
}
async function forceStop(child, completion) {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  } finally {
    // A failed worker must never retain subprocess pipes and hold up the suite.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await within(completion, 1500, () => "CLI did not close after forced termination");
}
async function stop(child, completion) {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end("stop\n");
  await within(completion, 1500, () => "CLI did not stop during cleanup")
    .catch(() => forceStop(child, completion));
}
function closeServer(server) {
  const completion = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  return within(completion, 1500, () => "Owned HTTP fixture did not close");
}
function startup(child, completion, output) {
  let check;
  const diagnostic = () => {
    const { stdout, stderr } = output();
    return `stdout: ${stdout}\nstderr: ${stderr}`;
  };
  return within(new Promise((resolve, reject) => {
    check = () => {
      try {
        resolve(JSON.parse(output().stdout));
      } catch {
        /* Wait for complete startup JSON. */
      }
    };
    child.stdout.on("data", check);
    check();
    completion.then(({ error }) => {
      reject(error ?? new Error(`CLI exited before complete startup JSON. ${diagnostic()}`));
    });
  }), 30_000, () => `CLI did not start after 30s. ${diagnostic()}`)
    .finally(() => child.stdout.off("data", check));
}
async function run(t, args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    signal: t.signal,
    killSignal: "SIGKILL",
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const completion = closed(child);
  try {
    // Cold Windows runners need up to 10s just to start a valid runtime. Give
    // startup/commands headroom without extending any product request deadline.
    const { code, signal, error } = await within(completion, 30_000,
      () => `CLI timed out after 30s: ${JSON.stringify(args)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    if (error) throw error;
    return { code, signal, stdout, stderr };
  } finally {
    await forceStop(child, completion);
  }
}

test('CLI subprocess cleanup forcibly terminates a child that ignores stop', { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, ['-e',
    'process.stdin.on("data", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    signal: t.signal, killSignal: 'SIGKILL',
  });
  const completion = closed(child);
  t.after(() => forceStop(child, completion));
  await within(once(child.stdout, 'data'), 10_000, () => 'Fixture child did not start');
  await stop(child, completion);
  const result = await completion;
  assert.equal(result.error, undefined);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  // Repeated cleanup must not attempt another write to the ended stdin pipe.
  await stop(child, completion);
});

test('CLI subprocess cleanup observes cancellation before close', { timeout: 15_000 }, async (t) => {
  const controller = new AbortController();
  const child = spawn(process.execPath, ['-e',
    'process.stdin.on("data", () => {}); process.stdout.write("ready");'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    signal: controller.signal, killSignal: 'SIGKILL',
  });
  const completion = closed(child);
  t.after(() => forceStop(child, completion));
  await within(once(child.stdout, 'data'), 10_000, () => 'Fixture child did not start');
  controller.abort();
  await forceStop(child, completion);
  const result = await completion;
  assert.equal(result.error?.name, 'AbortError');
  assert.notEqual(result.signal, null);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('CLI startup rejects partial JSON on exit and releases its output listener', { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("{\\\"url\\\":");'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    signal: t.signal, killSignal: 'SIGKILL',
  });
  const completion = closed(child);
  t.after(() => forceStop(child, completion));
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  const listeners = child.stdout.listenerCount('data');
  await assert.rejects(startup(child, completion, () => ({ stdout, stderr: '' })),
    /CLI exited before complete startup JSON/);
  assert.equal(stdout, '{"url":');
  assert.equal(child.stdout.listenerCount('data'), listeners);
});

test('CLI: invalid serve ports fail before starting or writing simulation state', { timeout: 60_000 }, async (t) => {
  const directory = await fixture(t, {
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'portal/Home.webpage.copy.html': '<h1>Local home</h1>',
    'project.json': JSON.stringify({ version: 1, portals: [{ id: 'first', path: './portal' }, { id: 'second', path: './portal' }], solutions: [], references: [] }),
  });
  const state = path.join(directory, 'invalid-state.json');
  for (const selection of [['--source', path.join(directory, 'portal')], ['--project', path.join(directory, 'project.json')]]) {
    for (const port of ['', ' ', '-1', '0x1000', '1e3', '65536']) {
      const result = await run(t, ['serve', ...selection, `--port=${port}`, '--state', state, '--no-watch'], directory);
      assert.equal(result.code, 1, `${JSON.stringify(port)}: ${result.stderr}`);
      assert.match(result.stderr, /--port must be an integer/);
      assert.equal(result.stdout, '');
    }
  }
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(directory, 'first')), { code: 'ENOENT' });
});

test('CLI: multi-portal serve closes its runtime after browser attachment fails', { timeout: 45_000 }, async (t) => {
  const directory = await fixture(t, {
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'portal/Home.webpage.copy.html': '<h1>Local home</h1>',
    'project.json': JSON.stringify({ version: 1, portals: [{ id: 'first', path: './portal' }, { id: 'second', path: './portal' }], solutions: [], references: [] }),
  });
  const rejectedCdp = http.createServer((_req, res) => { res.writeHead(404); res.end('No browser'); });
  rejectedCdp.listen(0, '127.0.0.1');
  await once(rejectedCdp, 'listening');
  t.after(() => closeServer(rejectedCdp));
  const result = await run(t, ['serve', '--project', path.join(directory, 'project.json'), '--port', '0', '--no-watch', '--cdp', `http://127.0.0.1:${rejectedCdp.address().port}`], directory);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null, 'failure exits on its own after closing portal and identity provider');
  assert.match(result.stderr, /404|browser|CDP/i);
  assert.equal(result.stdout, '');
});

test(
  "CLI: standard/enhanced inspect, local render, controlled argument errors and no absolute render traffic",
  { timeout: 120_000 },
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
    let result = await run(t,
      ["inspect", "--source", standard, "--env", "sandbox", "--json"],
      directory,
    );
    assert.equal(result.code, 0, result.stderr);
    const inspected = JSON.parse(result.stdout);
    assert.equal(inspected.format, "standard");
    assert.equal(inspected.pages[0].url, "/");
    assert.equal(inspected.pages[0].name, "CLI standard");
    assert.equal(inspected.liquidSyntax.sourceCount, 1);
    assert.equal(inspected.liquidSyntax.sourceParsePassed, 1);
    assert.deepEqual(inspected.liquidSyntax.diagnostics, []);
    result = await run(t,
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
    result = await run(t,
      ["inspect", "--source", path.join(directory, "enhanced"), "--json"],
      directory,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).format, "enhanced");
    assert.equal(JSON.parse(result.stdout).pages[0].name, "Enhanced home");
    const output = path.join(directory, "rendered.html");
    result = await run(t,
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
    t.after(() => closeServer(unrelated));
    const unrelatedUrl = `http://127.0.0.1:${unrelated.address().port}/unrelated`;
    for (const badPath of [
      unrelatedUrl,
      unrelatedUrl.replace("http:", ""),
      "/\\127.0.0.1/unsafe",
    ]) {
      result = await run(t,
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
    result = await run(t,
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
    result = await run(t,
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
    result = await run(t,
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
      // An insert form renders only for an identity with a Create permission.
      "portal/webrole.yml":
        "- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true\n",
      "portal/contact.tablepermission.yml":
        "adx_entitypermissionid: contact-create\nadx_entitylogicalname: contact\nadx_entityname: Contacts\nadx_scope: 756150000\nadx_create: true\nadx_entitypermission_webrole:\n- anonymous\n",
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
      { cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        signal: t.signal, killSignal: "SIGKILL" },
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
    const completion = closed(child).then((values) => {
      ended = true;
      return values;
    });
    t.after(async () => {
      if (!ended) await stop(child, completion);
    });
    const discovery = await startup(child, completion, () => ({ stdout, stderr }));
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
    child.stdin.end("stop\n");
    const { code, error } = await within(completion, 10_000,
      () => `CLI did not stop. stdout: ${stdout}\nstderr: ${stderr}`);
    if (error) throw error;
    assert.equal(code, 0, stderr);
    await assert.rejects(
      fs.stat(discovery.discovery),
      (error) => error.code === "ENOENT",
    );
    await assert.rejects(fetch(discovery.url));
  },
);
