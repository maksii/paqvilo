import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LAZY_PRESET,
  defineLazyPreset,
  discoverPacks,
  genericPresets,
  loadPack,
  presetDescriptor,
  presetLibrary,
  validatePack,
} from "../lib/preset-registry.mjs";
import {
  bootstrapPresetLibrary,
  builtinPresets,
  compactBuiltinPresets,
  listPresets,
  resolvePreset,
} from "../lib/presets.mjs";
import * as data from "../lib/data.mjs";
import { initialState } from "../lib/bootstrap.mjs";
import { expressionOperator, footerLogoClasses, packEndpoints, registerShellConventions } from "../lib/extensions.mjs";
import { DataStore } from "../lib/data.mjs";

const otherPortal = { records: [], templates: {}, forms: [], lists: [], website: { id: "other", name: "Other" } };

/** A synthetic pack module in a temporary packs root; `loads` counts body generations. */
async function writePack(root, id, { name = `Pack ${id}`, matchName = id, presets = `{"${id}-preset": { name: "Synthetic ${id}", description: "Test preset", load: () => { globalThis.__packLoads = (globalThis.__packLoads ?? 0) + 1; return { tables: { item: [{ itemid: "${id}" }] }, mappings: { item: { entitySet: "items", idColumn: "itemid" } } }; } }}` } = {}) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "pack.mjs"),
    `export default { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, description: "Synthetic test pack", matches: ({ portal }) => portal?.website?.name === ${JSON.stringify(matchName)}, presets: () => (${presets}), generators: {}, personas: [], plugins: [] };\n`,
  );
  return path.join(dir, "pack.mjs");
}

test("generic presets are project-agnostic and described", () => {
  const generic = genericPresets();
  assert.deepEqual(Object.keys(generic), ["empty-local", "open-sandbox", "strict-permissions", "contact-demo"]);
  for (const preset of Object.values(generic)) {
    assert.ok(preset.name && preset.description, "every generic preset has a name and description");
    assert.ok(!JSON.stringify(preset).includes("sample_"), "generic presets contain no ExampleApp tables");
  }
  assert.equal(generic["open-sandbox"].settings.permissionMode, "permissive");
});

test("explicit and root packs load, validate, dedupe and reject conflicts", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-packs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alpha = await writePack(root, "alpha");
  await writePack(root, "beta");
  await fs.mkdir(path.join(root, "not-a-pack"));
  const packs = await discoverPacks({ root });
  assert.deepEqual(packs.map((p) => p.id), ["alpha", "beta"]);
  // An explicit entry naming an already discovered module is not duplicated.
  assert.deepEqual((await discoverPacks({ root, explicit: [{ id: "alpha", module: alpha }] })).map((p) => p.id), ["alpha", "beta"]);
  // Explicit project entries resolve relative to the project file.
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pp-project-packs-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await writePack(path.join(projectRoot, "custom"), "gamma");
  const project = { configFile: path.join(projectRoot, "mirage.project.yml"), dataPacks: [{ id: "gamma", module: "custom/gamma/pack.mjs" }] };
  assert.deepEqual((await discoverPacks({ root, project, portal: { website: { name: "gamma" } } })).map((p) => p.id), ["gamma"]);
  await assert.rejects(discoverPacks({ root, explicit: [{ id: "other", module: alpha }] }), /declares id 'alpha', expected 'other'/);
  const duplicate = await writePack(path.join(projectRoot, "copy"), "alpha");
  await assert.rejects(discoverPacks({ root, explicit: [{ module: duplicate }] }), /Duplicate data pack id 'alpha'/);
  const invalid = path.join(projectRoot, "invalid.mjs");
  await fs.writeFile(invalid, "export default { id: 'bad', name: 'Bad', description: 'No matcher', presets: () => ({}) };\n");
  await assert.rejects(loadPack(invalid), /matches\(\{ portal \}\) must be a function/);
  assert.throws(() => validatePack({ id: "Bad Id", name: "x", description: "y", matches() {}, presets() {} }), /id must match/);
  assert.throws(() => validatePack({ id: "ok", name: "x", description: "y", matches() {}, presets() {}, generators: { deep: 1 } }), /generators.deep must be a function/);
});

test("preset library merges packs lazily; descriptors and compaction never generate bodies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-packs-lazy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePack(root, "lazy");
  const packs = await discoverPacks({ root });
  globalThis.__packLoads = 0;
  const library = presetLibrary({ packs });
  assert.deepEqual(Object.keys(library), [...Object.keys(genericPresets()), "lazy-preset"]);
  assert.deepEqual(presetDescriptor(library, "lazy-preset"), { id: "lazy-preset", name: "Synthetic lazy", description: "Test preset", pack: "lazy", lazy: true });
  assert.deepEqual(compactBuiltinPresets(library)["lazy-preset"], { builtin: true, builtinVersion: 1, name: "Synthetic lazy", description: "Test preset" });
  assert.equal(globalThis.__packLoads, 0, "listing and compaction must not load preset bodies");
  assert.equal(library["lazy-preset"].tables.item[0].itemid, "lazy");
  assert.equal(library["lazy-preset"], library["lazy-preset"], "bodies are memoized");
  assert.equal(globalThis.__packLoads, 1);
  // A portal that the pack does not match receives only generic presets.
  assert.deepEqual(Object.keys(presetLibrary({ packs, portal: otherPortal })), Object.keys(genericPresets()));
  // Two packs defining the same preset id are rejected.
  const second = await writePack(root, "clash", { presets: `{"lazy-preset": { name: "Clash", load: () => ({}) }}` });
  const clash = await loadPack(second);
  assert.throws(() => presetLibrary({ packs: [...packs, clash] }), /Preset 'lazy-preset' from data pack clash duplicates/);
  // Explicit-pack descriptors resolve from the supplied library, not the compatibility export.
  const state = { presets: compactBuiltinPresets(library), mappings: {} };
  assert.equal(resolvePreset(state, "lazy-preset", library).tables.item[0].itemid, "lazy");
  assert.equal(resolvePreset(state, "lazy-preset", {}), null, "an unavailable builtin descriptor is not returned as a body");
  const listing = listPresets({ state, library: {} });
  assert.deepEqual(listing.find((entry) => entry.id === "lazy-preset"), { id: "lazy-preset", name: "Synthetic lazy", description: "Test preset", source: "stored", unavailable: true });
  delete globalThis.__packLoads;
});

test("defineLazyPreset validates ids and loaded bodies", () => {
  const library = {};
  assert.throws(() => defineLazyPreset(library, "__proto__", {}), /Invalid preset id/);
  assert.throws(() => defineLazyPreset(library, "bad id", {}), /Invalid preset id/);
  defineLazyPreset(library, "broken", { name: "Broken", load: () => null });
  assert.throws(() => library.broken, /did not load an object/);
  assert.equal(Object.getOwnPropertyDescriptor(library, "broken").get[LAZY_PRESET].name, "Broken");
  library.broken = { tables: {} };
  assert.deepEqual(library.broken, { tables: {} }, "assignment replaces a lazy entry");
});

test("discovery filters a packs root by portal and bootstraps only matching pack presets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-packs-generic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePack(root, "alpha", { matchName: "Alpha" });
  await writePack(root, "beta", { matchName: "Beta" });
  const alphaPortal = { ...otherPortal, website: { id: "a", name: "Alpha" } };
  assert.deepEqual((await discoverPacks({ root })).map((pack) => pack.id), ["alpha", "beta"]);
  assert.deepEqual((await discoverPacks({ root, portal: alphaPortal })).map((pack) => pack.id), ["alpha"]);
  assert.deepEqual((await discoverPacks({ root, portal: otherPortal })).map((pack) => pack.id), []);
  const packs = await discoverPacks({ root, portal: alphaPortal });
  const library = bootstrapPresetLibrary({ portal: alphaPortal, packs, tables: {}, mappings: {} });
  assert.deepEqual(Object.keys(library), ["empty-local", "alpha-preset"]);
  assert.equal(presetDescriptor(library, "alpha-preset").pack, "alpha");
});

test("packs contribute expression operators, /__sim/ endpoints and shell conventions through the registry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-packs-ext-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "gamma");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "pack.mjs"),
    [
      "export default {",
      '  id: "gamma", name: "Gamma", description: "Extension test pack",',
      '  matches: ({ portal }) => portal?.website?.name === "Gamma",',
      "  presets: () => ({}),",
      "  expressionOperators: { gammaDouble: ({ args }) => Number(args[0]) * 2 },",
      String.raw`  endpoints: [{ id: "gamma-ping", methods: ["GET"], pattern: /^\/__sim\/gamma\/ping$/, handle: ({ res }) => res.end("pong") }],`,
      "};",
    ].join("\n"),
  );
  const [pack] = await discoverPacks({ root, portal: { website: { name: "Gamma" } } });
  assert.equal(typeof expressionOperator("gammaDouble"), "function");
  const store = await new DataStore({ state: { tables: {}, mappings: {}, permissions: [], plugins: [], settings: { permissionMode: "permissive" } } }).init();
  assert.equal(store.evaluate({ op: "gammaDouble", args: [21] }, {}), 42);
  assert.throws(() => store.evaluate({ op: "unknownOperator", args: [] }, {}), /Unsupported plugin expression/);
  const [endpoint] = packEndpoints([pack]);
  assert.equal(endpoint.packId, "gamma");
  assert.ok(endpoint.pattern.test("/__sim/gamma/ping"));
  assert.throws(
    () => validatePack({ id: "bad", name: "Bad", description: "Bad", matches: () => true, presets: () => ({}), endpoints: [{ id: "x", methods: ["GET"], pattern: /^\/_api\/x$/, handle() {} }] }),
    /anchored under \/__sim\//,
  );
  registerShellConventions("gamma", { footerLogoClass: "gamma-logos" });
  assert.ok(footerLogoClasses().includes("gamma-logos"));
  assert.throws(() => registerShellConventions("gamma", { footerLogoClass: "not a class" }), /CSS class name/);
});
