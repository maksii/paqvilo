import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importPortal } from "../lib/importer.mjs";
import { PortalModel } from "../../lense/portal-model.mjs";

// Optional public ecosystem checkouts. The synthetic code-site fixture always runs;
// these additional checks run only when PAQVILO_ECOSYSTEM_FIXTURES is supplied.
const R2 = process.env.PAQVILO_ECOSYSTEM_FIXTURES
  ? path.resolve(process.env.PAQVILO_ECOSYSTEM_FIXTURES)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".paqvilo", "ecosystem");
const SAMPLES = path.join(R2, "microsoft__power-pages-samples");
const CORE_PORTAL = path.join(R2, "microsoft__gov-apptemplates", "portals", "core-portal");
const missing = (dir) => (fs.existsSync(dir) ? false : `${path.relative(path.resolve(R2, "..", "..", ".."), dir)} is not present`);

const codeSites = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.name === ".powerpages-site") out.push(full);
    else codeSites(full, out);
  }
  return out;
};

test("every power-pages-samples code site imports with IDs, pages and web files, in the Mirage and the toolkit", { skip: missing(SAMPLES) }, async () => {
  const sites = codeSites(SAMPLES).sort();
  assert.equal(sites.length, 15);
  for (const site of sites) {
    const label = path.relative(SAMPLES, site);
    const portal = await importPortal(site);
    assert.equal(portal.source.dialect, "short-key-yaml", label);
    assert.equal(portal.records.filter((record) => !record.id).length, 0, label);
    assert.equal(portal.dataModel, "enhanced", label);
    // Every root page is a page unless its parent chain is missing from the export (reported).
    const roots = portal.records.filter((record) => record.kind === "webpage" && record.isroot !== false).length;
    const hierarchy = portal.diagnostics.filter((item) => item.code === "page-hierarchy").length;
    assert.equal(portal.pages.length + hierarchy, roots, label);
    const files = portal.records.filter((record) => record.kind === "webfile").length;
    const missingFiles = portal.diagnostics.filter((item) => item.code === "webfile-missing").length;
    assert.equal(portal.webFiles.length + missingFiles, files, label);
    if (!hierarchy) assert.equal(missingFiles, 0, label);
    assert.ok(portal.language?.code, label);
    const model = new PortalModel(site);
    assert.deepEqual([model.format, model.shortKey], ["classic", true], label);
    if (!hierarchy) assert.deepEqual([model.pages.size, model.webFiles.filter((file) => !file.problem).length, model.warnings], [portal.pages.length, portal.webFiles.length, []], label);
  }
});

test("gov-apptemplates core-portal imports the same records from PAC YAML (site/) and the unpacked Solution (src/)", { skip: missing(CORE_PORTAL) }, async () => {
  const yaml = await importPortal(path.join(CORE_PORTAL, "site"));
  const solution = await importPortal(path.join(CORE_PORTAL, "src"));
  assert.deepEqual([yaml.source.dialect, solution.source.dialect], ["standard-yaml", "enhanced-solution"]);
  const ids = (portal) => {
    const byKind = {};
    for (const record of portal.records) if (record.id && record.kind !== "website") (byKind[record.kind] ??= []).push(record.id);
    return Object.fromEntries(Object.entries(byKind).map(([kind, list]) => [kind, list.sort()]).sort(([a], [b]) => a.localeCompare(b)));
  };
  assert.deepEqual(ids(yaml), ids(solution));
  assert.deepEqual(yaml.pages.map((page) => page.url).sort(), solution.pages.map((page) => page.url).sort());
  assert.deepEqual(yaml.webFiles.map((file) => file.url).sort(), solution.webFiles.map((file) => file.url).sort());
  // Site setting values differ only in the case of booleans (true / True).
  const differences = Object.keys(yaml.settings).filter((name) => yaml.settings[name] !== solution.settings[name]);
  assert.ok(differences.every((name) => yaml.settings[name].toLowerCase() === String(solution.settings[name]).toLowerCase()), differences.join(", "));
});

test("public unpacked Solutions import component types 24, 26, 27, 33 and 34 without unmapped types", { skip: missing(R2) }, async () => {
  const sources = [
    [path.join(R2, "microsoft__contoso-real-estate-power-platform", "src", "portal", "solution", "ContosoRealEstatePortal", "src"), [27, 33]],
    [path.join(R2, "365Evergreen__WorkmateProSWA", "dataverse", "hired-schemas", "HiRedAUstartersolution"), [27, 34]],
    [path.join(R2, "tonipohl__PowerPagesCodeMagazine", "ContosoCoursesRegistrationSite_1_0_0_0"), [24, 26]],
  ].filter(([dir]) => fs.existsSync(dir));
  assert.ok(sources.length, "Supply at least one supported public Solution checkout.");
  for (const [dir, types] of sources) {
    const portal = await importPortal(dir);
    assert.deepEqual(portal.records.filter((record) => /^component:/.test(record.kind)).map((record) => record.kind), [], dir);
    for (const type of types) assert.ok(portal.records.some((record) => record.powerpagecomponenttype === type && !/^component:/.test(record.kind)), `${dir} type ${type}`);
  }
});
