// ZIP and persistence transport tests use invented package names and bytes. No filesystem extraction or network access.
import test from "node:test";
import assert from "node:assert/strict";
import {
  SolutionArchiveError, appendSolutionAssetLayer, latestSolutionAssetEntries, readSolutionAssetEntries,
  reassignSolutionAssetLayers, removeSolutionAssetLayers, solutionAssetLayers, writeSolutionAssetEntries,
} from "../lib/dataverse-solution-assets.mjs";

const BASE = "11111111-1111-4111-8111-111111111111";
const PATCH = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const file = (name, text) => ({ name, data: Buffer.from(text) });
const directoryOffset = (zip) => zip.readUInt32LE(zip.length - 6);
const refused = (code) => (error) => error instanceof SolutionArchiveError && error.code === code;
const plain = (entries) => entries.map(({ name, data }) => [name, Buffer.from(data).toString("base64")]).sort(([left], [right]) => left.localeCompare(right));

test("solution ZIP round-trips deflated XML, Unicode names and opaque binary/script assets deterministically", () => {
  const entries = [file("solution.xml", "<ImportExportXml><SolutionManifest><UniqueName>new_fixture</UniqueName></SolutionManifest></ImportExportXml>"),
    file("customizations.xml", `<ImportExportXml>${"<Entity Name='new_widget'/>".repeat(100)}</ImportExportXml>`),
    file("WebResources/new_opaque.js", "throw new Error('Opaque package content must never execute');"),
    { name: "WebResources/new_binary.bin", data: Uint8Array.from([0, 255, 10, 128, 4]) }, file("AppModules/new_фікстура/AppModule.xml", "<AppModule/>"),
  ];
  const zip = writeSolutionAssetEntries(entries);
  assert.deepEqual(writeSolutionAssetEntries(entries), zip);
  assert.deepEqual(plain(readSolutionAssetEntries(zip)), plain(entries));
  assert.equal(zip.readUInt16LE(directoryOffset(zip) + 10), 8, "repeated XML uses deflate");
  const detached = readSolutionAssetEntries(zip);
  detached[0].data.fill(0);
  assert.deepEqual(plain(readSolutionAssetEntries(zip)), plain(entries), "callers cannot mutate the stored archive through returned bytes");
});

test("solution ZIP reads data descriptors and rejects CRC, header and archive bounds corruption", () => {
  const original = writeSolutionAssetEntries([file("probe.xml", "<probe/>")]);
  const descriptor = Buffer.from(original), central = directoryOffset(descriptor);
  descriptor.writeUInt16LE(descriptor.readUInt16LE(6) | 8, 6);
  descriptor.writeUInt16LE(descriptor.readUInt16LE(central + 8) | 8, central + 8);
  descriptor.fill(0, 14, 26);
  assert.equal(readSolutionAssetEntries(descriptor)[0].data.toString(), "<probe/>");
  const crc = Buffer.from(original);
  crc.writeUInt32LE(123, directoryOffset(crc) + 16);
  assert.throws(() => readSolutionAssetEntries(crc), refused("InvalidArchive"));
  const header = Buffer.from(original);
  header.writeUInt16LE(1, 8);
  assert.throws(() => readSolutionAssetEntries(header), refused("InvalidArchive"));
  const offset = Buffer.from(original);
  offset.writeUInt32LE(offset.length, directoryOffset(offset) + 42);
  assert.throws(() => readSolutionAssetEntries(offset), refused("InvalidArchive"));
  assert.throws(() => readSolutionAssetEntries(original.subarray(0, -3)), refused("InvalidArchive"));
});

test("solution ZIP rejects traversal, ambiguous duplicate names, symlinks, encryption and ZIP64", () => {
  for (const name of ["../escape.xml", "/absolute.xml", "C:/drive.xml", "a/./b.xml", "a//b.xml", "a/file.xml:stream", "a/trailing. ", "a\u0000.xml"]) {
    assert.throws(() => writeSolutionAssetEntries([file(name, "x")]), refused("EntryPath"));
  }
  assert.throws(() => writeSolutionAssetEntries([file("A.xml", "a"), file("a.xml", "b")]), refused("EntryPath"));
  const traversal = writeSolutionAssetEntries([file("a.xml", "x")]);
  Buffer.from("../aa").copy(traversal, 30);
  Buffer.from("../aa").copy(traversal, directoryOffset(traversal) + 46);
  assert.throws(() => readSolutionAssetEntries(traversal), refused("EntryPath"));
  const symlink = writeSolutionAssetEntries([file("a.xml", "x")]);
  symlink.writeUInt32LE((0xa1ff * 65536) >>> 0, directoryOffset(symlink) + 38);
  assert.throws(() => readSolutionAssetEntries(symlink), refused("EntryPath"));
  const encrypted = writeSolutionAssetEntries([file("a.xml", "x")]);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(directoryOffset(encrypted) + 8) | 1, directoryOffset(encrypted) + 8);
  assert.throws(() => readSolutionAssetEntries(encrypted), refused("UnsupportedArchive"));
  const zip64 = writeSolutionAssetEntries([file("a.xml", "x")]);
  zip64.writeUInt32LE(0xffffffff, zip64.length - 6);
  assert.throws(() => readSolutionAssetEntries(zip64), refused("UnsupportedArchive"));
});

test("solution ZIP checks declared and actual size budgets before returning bytes", () => {
  const entries = [file("large.xml", "x".repeat(1000)), file("other.xml", "x")];
  const zip = writeSolutionAssetEntries(entries);
  assert.throws(() => readSolutionAssetEntries(zip, { entryBytes: 100 }), refused("ArchiveLimit"));
  assert.throws(() => readSolutionAssetEntries(zip, { totalBytes: 100 }), refused("ArchiveLimit"));
  assert.throws(() => readSolutionAssetEntries(zip, { entries: 1 }), refused("ArchiveLimit"));
  assert.throws(() => writeSolutionAssetEntries(entries, { archiveBytes: 20 }), refused("ArchiveLimit"));
  assert.throws(() => writeSolutionAssetEntries(entries, { entryBytes: -1 }), refused("ArchiveLimit"));
  const inflated = Buffer.from(zip), central = directoryOffset(inflated);
  inflated.writeUInt32LE(1, central + 24);
  inflated.writeUInt32LE(1, 22);
  assert.throws(() => readSolutionAssetEntries(inflated), refused("InvalidArchive"), "a forged small size cannot permit unbounded inflate");
});

test("asset layers persist byte-for-byte through JSON restart and survive patch roll-up with their original provenance", () => {
  const state = { dataverse: { unrelatedSetting: true } };
  const baseEntries = [file("customizations.xml", "<base/>"), file("WebResources/new_keep.js", "opaque")];
  appendSolutionAssetLayer(state, BASE, baseEntries, { uniqueName: "new_fixture", version: "1.0.0.0" });
  appendSolutionAssetLayer(state, PATCH, [file("customizations.xml", "<patch/>"), file("AppModules/new_app.xml", "<AppModule/>")], { uniqueName: "new_fixture", version: "1.0.1.0" });
  appendSolutionAssetLayer(state, OTHER, [file("customizations.xml", "<unrelated/>")], { uniqueName: "new_other", managed: true });
  const restarted = JSON.parse(JSON.stringify(state));
  assert.deepEqual(plain(latestSolutionAssetEntries(restarted, BASE)), plain(baseEntries));
  reassignSolutionAssetLayers(restarted, [PATCH], BASE);
  const layers = solutionAssetLayers(restarted, { solutionIds: [BASE] });
  assert.deepEqual(layers.map((layer) => layer.sourceSolutionId), [BASE, PATCH]);
  assert.deepEqual(layers.map((layer) => layer.ownerSolutionId), [BASE, BASE]);
  assert.deepEqual(layers.map((layer) => Buffer.from(layer.entries.find((entry) => entry.name === "customizations.xml").content, "base64").toString()), ["<base/>", "<patch/>"], "semantic XML layers are retained, not flattened by ZIP path");
  assert.equal(latestSolutionAssetEntries(restarted, BASE).find((entry) => entry.name === "WebResources/new_keep.js").data.toString(), "opaque");
  removeSolutionAssetLayers(restarted, [BASE]);
  assert.deepEqual(solutionAssetLayers(restarted).map((layer) => layer.ownerSolutionId), [OTHER]);
  assert.equal(restarted.dataverse.unrelatedSetting, true);
});

test("invalid capture is atomic and persisted bytes are integrity-checked", () => {
  const state = { dataverse: { unrelatedSetting: 7 } }, before = structuredClone(state);
  assert.throws(() => appendSolutionAssetLayer(state, BASE, [file("../bad.xml", "x")]), refused("EntryPath"));
  assert.deepEqual(state, before);
  appendSolutionAssetLayer(state, BASE, [file("AppModules/new_app.xml", "<AppModule/>")]);
  const copy = solutionAssetLayers(state);
  copy[0].entries[0].content = "changed";
  assert.equal(latestSolutionAssetEntries(state, BASE)[0].data.toString(), "<AppModule/>", "snapshots cannot mutate persisted bytes");
  state.dataverse.solutionAssets.layers[0].entries[0].content = "changed";
  assert.throws(() => latestSolutionAssetEntries(state, BASE), refused("AssetState"));
});

test("persisted asset limits bound the combined layers and a refused append leaves prior layers intact", () => {
  const state = {};
  appendSolutionAssetLayer(state, BASE, [file("base.xml", "123456")], {}, { totalBytes: 10 });
  const before = structuredClone(state);
  assert.throws(() => appendSolutionAssetLayer(state, PATCH, [file("patch.xml", "123456")], {}, { totalBytes: 10 }), refused("ArchiveLimit"));
  assert.deepEqual(state, before);
  assert.throws(() => appendSolutionAssetLayer(state, PATCH, [file("patch.xml", "1")], {}, { layers: 1 }), refused("ArchiveLimit"));
  assert.deepEqual(state, before);
});
