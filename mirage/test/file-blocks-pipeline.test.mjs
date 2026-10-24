// Block-committed notes and attachments go through the record create pipeline: attachment policy, mimetype,
// ownership and synchronous plug-in steps apply exactly as on an ordinary create.
import test from "node:test";
import assert from "node:assert/strict";
import { pluginCatalogue, pluginHandlers, pluginPhaseRequiresCheckpoint, pluginStepMatchesEntity, runPluginPhase } from "../lib/exported-plugins.mjs";
import { attachmentApi, b64, WIDGET } from "./attachment-api-fixture.mjs";

const STEP = "77777777-7777-4777-8777-7777777777a1";
const blockExe = (store) => { store.state.simulator = { ...store.state.simulator, platformOverrides: { BlockedAttachments: "exe" } }; };

test("a block-committed evil.exe note is refused with AttachmentTypeBlocked, exactly like a record create", async (t) => {
  const h = await attachmentApi(t, { before: blockExe });
  const before = h.store.tableRows("annotation").length;
  const created = await h.send("annotations", { filename: "evil.exe", documentbody: b64("MZ") });
  const committed = await h.blocks("Annotation", ["MZ"], { FileName: "evil.exe" });
  assert.equal(created.status, 400);
  assert.deepEqual(committed.json.error, created.json.error);
  assert.equal(committed.status, created.status);
  assert.equal(h.store.tableRows("annotation").length, before, "no row is stored");
  const attachment = await h.blocks("Attachment", ["MZ"], { FileName: "evil.exe" });
  assert.deepEqual(attachment.json.error, created.json.error);
});

test("a block-committed note has its mimetype, owner and regarding lookup", async (t) => {
  const h = await attachmentApi(t);
  const committed = await h.blocks("Annotation", ["hello ", "notes"], { FileName: "notes.txt" });
  assert.equal(committed.status, 200, JSON.stringify(committed.json));
  assert.equal(committed.json.FileSizeInBytes, 11);
  const row = h.store.tableRows("annotation").find((r) => r.annotationid === committed.json.AnnotationId);
  assert.equal(row.mimetype, "text/plain");
  assert.equal(row.ownerid?.id, h.appUserId);
  assert.equal(row.createdby?.id, h.appUserId);
  assert.deepEqual([row.objectid.id, row.objectid.logical_name], [WIDGET, "fx_widget"]);
  assert.equal(row.documentbody, b64("hello notes"));
});

test("a synchronous plug-in step on annotation Create runs for the block path", async (t) => {
  const h = await attachmentApi(t);
  const seen = [];
  const handlers = pluginHandlers([{ id: "invented", pluginSteps: { [STEP]: ({ record }) => { seen.push(record.filename); } } }]);
  const steps = () => pluginCatalogue({ plugins: { steps: [{
    id: STEP, name: "Invented note check", entity: "annotation", message: "Create", enabled: true, stage: 20, rank: 1, mode: 0,
    typeName: "Invented.NoteCheck", typeId: STEP, assemblyId: STEP, supportedDeployment: 0, filteringAttributes: [], images: [],
  }] }, handlers });
  h.store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store: h.store, items: steps(), handlers, diagnostic: () => {} }),
    ({ entity, operation }) => steps().some((item) => item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation),
    (context) => pluginPhaseRequiresCheckpoint(steps(), context),
  );
  const committed = await h.blocks("Annotation", ["plugin bytes"], { FileName: "seen.txt" });
  assert.equal(committed.status, 200, JSON.stringify(committed.json));
  assert.deepEqual(seen, ["seen.txt"]);
});
