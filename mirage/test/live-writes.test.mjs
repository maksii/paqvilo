import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LiveBridge } from "../lib/live.mjs";
import { createSimulator } from "../server.mjs";

// Live writes are impossible unless the runtime was started with --allow-live-writes
// (independent review docs/runtime-evidence.md, M1). Every live write (portal
// routes in live page mode, /_api in live data mode, native form saves and subgrid actions)
// goes through LiveBridge.request, which refuses writes without the runtime permission.

const origin = "https://portal.example.test";
const response = ({ status = 200, headers = { "content-type": "application/json" }, body = "{}", url = origin + "/" } = {}) => ({
  status: () => status,
  headers: () => headers,
  body: async () => Buffer.from(body),
  url: () => url,
  dispose: async () => {},
});
/** A bridge whose browser context answers every request (the token fragment and the call). */
function fakeBridge(config = {}, options) {
  const bridge = new LiveBridge({ origin, ...config }, options);
  const calls = [];
  bridge.context = {
    request: {
      fetch: async (url, init) => {
        calls.push({ url, method: init?.method ?? "GET" });
        return url.endsWith("/_layout/tokenhtml")
          ? response({ headers: { "content-type": "text/html" }, body: '<input name="__RequestVerificationToken" type="hidden" value="T" />', url })
          : response({ status: 204, body: "", url });
      },
    },
  };
  return { bridge, calls };
}

test("the live bridge refuses every write without the runtime permission, whatever the connection switch says", async () => {
  const blocked = fakeBridge({ allowWrites: true }, { writesPermitted: false });
  assert.equal(blocked.bridge.status().liveWrites, "disabled");
  for (const method of ["POST", "PATCH", "PUT", "DELETE"])
    await assert.rejects(blocked.bridge.request("/_api/contacts", { method, body: {} }), (error) => error.status === 403 && error.code === "LIVE_WRITES_DISABLED" && /start the Mirage with --allow-live-writes/.test(error.message));
  assert.equal(blocked.calls.length, 0, "nothing reaches the live environment");
  await blocked.bridge.request("/_api/contacts");
  assert.ok(blocked.calls.length > 0 && blocked.calls.every((call) => call.method === "GET"), "reads still work");
  const off = fakeBridge({ allowWrites: false }, { writesPermitted: true });
  assert.equal(off.bridge.status().liveWrites, "off");
  await assert.rejects(off.bridge.request("/_api/contacts", { method: "POST", body: {} }), /Enable them explicitly in the connection settings/);
  const enabled = fakeBridge({ allowWrites: true }, { writesPermitted: true });
  assert.equal(enabled.bridge.status().liveWrites, "enabled");
  await enabled.bridge.request("/_api/contacts", { method: "POST", body: {} });
  assert.deepEqual(enabled.calls.map((call) => call.method), ["GET", "POST"]);
});

async function portal(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-live-writes-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_name: Live Writes\nadx_websiteid: site",
    "web-pages/home/Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml": "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "web-templates/Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": "<p>home</p>",
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}
const initial = (allowWrites) => ({
  version: 1,
  mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
  tables: { contact: [] },
  permissions: [],
  settings: { permissionMode: "permissive" },
  simulator: { mode: "live", pageMode: "local", identity: { roles: [] }, live: { origin, allowWrites }, endpoints: [] },
});
async function runtime(t, { allowLiveWrites, allowWrites }) {
  const dir = await portal(t);
  const { bridge, calls } = fakeBridge({ allowWrites });
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), port: 0, watch: false, initial: initial(allowWrites), liveBridge: bridge, ...(allowLiveWrites ? { allowLiveWrites } : {}) });
  t.after(() => app.close());
  const { csrf } = await (await fetch(app.url + "/__sim/api/state?summary=1")).json();
  const status = async () => (await fetch(app.url + "/__sim/api/status")).json();
  const configure = (live) => fetch(app.url + "/__sim/api/config", { method: "PATCH", headers: { "content-type": "application/json", "x-sim-csrf": csrf }, body: JSON.stringify({ live }) });
  const write = () => fetch(app.url + "/_api/contacts", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ fullname: "Synthetic" }) });
  return { app, calls, status, configure, write };
}

test("without --allow-live-writes the /_sim switch is refused, status reports disabled and no write reaches live", async (t) => {
  // A state saved with the switch on (an earlier session) still cannot write.
  const { calls, status, configure, write } = await runtime(t, { allowWrites: true });
  const current = await status();
  assert.deepEqual([current.liveWrites, current.live.liveWrites], ["disabled", "disabled"]);
  const refused = await configure({ origin, allowWrites: true });
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.match(JSON.stringify(body), /LIVE_WRITES_DISABLED/);
  assert.match(JSON.stringify(body), /start the Mirage with --allow-live-writes/);
  // Turning the switch off stays possible.
  assert.equal((await configure({ origin, allowWrites: false })).status, 200);
  const attempt = await write();
  assert.equal(attempt.status, 403);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "no write reached the live environment");
});

test("with --allow-live-writes the switch decides: off until enabled, then writes reach live", async (t) => {
  const { calls, status, configure, write } = await runtime(t, { allowLiveWrites: true, allowWrites: false });
  assert.equal((await status()).liveWrites, "off");
  assert.equal((await write()).status, 403);
  assert.equal((await configure({ origin, allowWrites: true })).status, 200);
  assert.equal((await status()).liveWrites, "enabled");
  const sent = await write();
  assert.equal(sent.status, 204);
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => new URL(call.url).pathname), ["/_api/contacts"]);
});
