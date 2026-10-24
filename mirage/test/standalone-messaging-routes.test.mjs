// A queue service endpoint (contract 2) step in a running standalone host delivers through providers.messaging, and the
// message is visible at GET /_sim/api/messages with the organization URI of the Dataverse API.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../api.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const ENDPOINT = "77777777-7777-4777-8777-777777777791";
const STEP = "77777777-7777-4777-8777-777777777792";
const WIDGET = "77777777-7777-4777-8777-777777777793";

async function solutionFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "standalone-messaging-"));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, "solution");
  const files = {
    "Other/Solution.xml": "<ImportExportXml><SolutionManifest><UniqueName>InventedMessaging</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>",
    "Entities/x_widget/Entity.xml": '<Entity><Name>x_widget</Name><EntityInfo><entity Name="x_widget"><EntitySetName>x_widgets</EntitySetName><PrimaryIdAttribute>x_widgetid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_widgetid"><Name>x_widgetid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(solution, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const sim = await createSimulator({ runtime: { kind: "dataverse-api" }, solutionRoots: [solution], projectRoot: root, port: 0, watch: false,
    // A state file, not dry-run: the bus table is a schema the dry-run level refuses to create.
    stateFile: path.join(root, "state.json"), dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    providers: { messaging: { endpoints: { [ENDPOINT]: "local/x-queue" } } } });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test("a contract 2 step reaches /_sim/api/messages through a running standalone host", async (t) => {
  const sim = await solutionFixture(t);
  const { store } = sim;
  const messageId = store.tableRows("sdkmessage").find((row) => row.name === "Create").sdkmessageid;
  const filterId = store.tableRows("sdkmessagefilter").find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === "x_widget").sdkmessagefilterid;
  await store.create("serviceendpoint", { serviceendpointid: ENDPOINT, name: "Invented queue", contract: 2, connectionmode: 1, authtype: 2, authvalue: "invented-sas-key" }, { admin: true });
  await store.create("sdkmessageprocessingstep", { sdkmessageprocessingstepid: STEP, name: "Invented queue step", sdkmessageid: messageId, sdkmessagefilterid: filterId,
    eventhandler: { id: ENDPOINT, logical_name: "serviceendpoint" }, stage: 40, mode: 1, rank: 1, statecode: 0, supporteddeployment: 0 }, { admin: true });
  await store.create("x_widget", { x_widgetid: WIDGET, x_name: "Invented widget" }, { admin: true });

  let messages = [];
  for (let attempt = 0; attempt < 100 && !messages.length; attempt += 1) {
    const response = await fetch(`${sim.url}/_sim/api/messages?entity=x-queue`);
    assert.equal(response.status, 200);
    messages = (await response.json()).messages;
    if (!messages.length) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body.PrimaryEntityId, WIDGET);
  assert.equal(messages[0].properties.organizationUri, sim.dataverse.origin);
  const listing = await (await fetch(`${sim.url}/_sim/api/messages`)).json();
  assert.equal(listing.configured, true);
  assert.deepEqual(listing.endpoints, { [ENDPOINT]: "local/x-queue" });
  const outbox = await (await fetch(`${sim.url}/_sim/api/outbox`)).json();
  assert.equal(outbox.configured, true);
});
