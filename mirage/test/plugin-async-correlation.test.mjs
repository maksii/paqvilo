// Runner request contexts (plugin-async.mjs): an asynchronous step runs in a child of the request that wrote the row, so
// the plug-in trace log it writes carries the HTTP x-ms-correlation-request-id.
import test from "node:test";
import assert from "node:assert/strict";
import { createAsyncPluginRunner } from "../lib/plugin-async.mjs";
import { pluginCatalogue, pluginHandlers, pluginPhaseRequiresCheckpoint, pluginStepMatchesEntity, runPluginPhase } from "../lib/exported-plugins.mjs";
import { currentRequest } from "../lib/request-context.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const STEP = "5c0b0000-0000-4000-8000-000000000071";
const CORRELATION = "7a7a7a7a-0000-4000-8000-000000000071";
const step = { id: STEP, name: "Invented asynchronous trace", entity: "x_item", message: "Create", enabled: true, stage: 40, rank: 1, mode: 1,
  typeName: "Invented.Plugins.Trace", typeId: "5c0b0000-0000-4000-8000-000000000072", assemblyId: "5c0b0000-0000-4000-8000-000000000073",
  supportedDeployment: 0, filteringAttributes: [], images: [] };

test("an asynchronous step's plug-in trace log carries the HTTP correlation id", async (t) => {
  const seen = [];
  const handlers = pluginHandlers([{ id: "invented", pluginSteps: { [STEP]: ({ trace }) => { seen.push(currentRequest()); trace("Invented async trace"); } } }]);
  const { store, request, json } = await contractModuleFixture(t, {
    mappings: { x_item: { logicalName: "x_item", entitySet: "x_items", idColumn: "x_itemid", nameColumn: "x_name", fields: { x_name: { dataverseType: "nvarchar" } } } },
    tables: { x_item: [] }, extension: { name: "x-none", install() {} },
  });
  await store.transact(() => { store.tableRows("organization")[0].plugintracelogsetting = 2; });
  const items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items: items(), handlers }),
    ({ entity, operation }) => items().some((item) => item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation),
    (context) => pluginPhaseRequiresCheckpoint(items(), context));
  const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map(), systemJobs: () => true });
  t.after(() => runner.close());

  await json(await request("POST", "/x_items", { x_name: "Invented row" }, { "x-ms-correlation-request-id": CORRELATION }), 201);
  await runner.drain();
  const [trace] = store.tableRows("plugintracelog");
  assert.equal(trace?.messageblock, "Invented async trace");
  assert.equal(trace.mode, 1);
  assert.equal(trace.correlationid, CORRELATION);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, "async");
  assert.equal(seen[0].correlationId, CORRELATION);
  assert.equal(seen[0].parentId, CORRELATION);
  assert.equal(seen[0].inBatch, false);
});
