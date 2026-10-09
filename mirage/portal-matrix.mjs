#!/usr/bin/env node
/**
 * Portal matrix: one offline validation report across every portal of a Mirage project
 * (or of catalogue sites), side by side.
 *
 *   node mirage/portal-matrix.mjs --project FILE [--portal ID]... [options]
 *   node mirage/portal-matrix.mjs --sites SITE,SITE... [--repo DIR] [options]
 *
 * Stages (per portal unless noted):
 *   import     independent census of the raw export (YAML records or powerpagecomponent types)
 *              compared with the imported runtime model, kind by kind
 *   bootstrap  bootstrap-report summary: layers, tables, entity sets, permissions, routing,
 *              environment variables, Web API settings, diagnostics
 *   liquid     liquid-inventory: unsupported constructs, authored syntax errors, missing includes
 *              (classified against the raw export: absent, inactive or not resolved)
 *   webapi     webapi-inventory: unsupported request/FetchXML features, static syntax failures
 *   sweep      render-sweep on a fresh bootstrap (no rows) for the --personas
 *   scaffold   `data scaffold` rows and personas on a temporary state; its table/row/persona counts,
 *              Web API reads over the rows (anonymous and as a contact holding every exported role)
 *              and render-sweep over the rows for the --scaffold-personas (forms, lists, records)
 *   runtime    cold start, state size, admin and home status, a Web API read probe per enabled
 *              table (anonymous; also signed in with the all-roles persona selected), warm restart
 *   serve      (project only) `cli.mjs serve --project` with every portal: separate ports, state
 *              files, CSRF tokens and admin workspaces, discovery, toolkit status, clean stop
 *
 * Options:
 *   --out DIR                  matrix.json, matrix.md and <portal>/<stage>.json details
 *                              (default .paqvilo/portal-matrix/<timestamp>)
 *   --json                     print matrix.json instead of the Markdown summary
 *   --only a,b | --skip a,b    select stages
 *   --personas a,b             fresh-state sweep personas: anonymous, authenticated, all-roles
 *                              (default anonymous)
 *   --scaffold-personas a,b    scaffold sweep personas: anonymous, all-roles (default both)
 *   --scaffold-profile NAME    smoke (default) or dev
 *   --limit N, --path PREFIX   restrict the page sweeps
 *   --preset PORTAL=NAME       preset applied to that portal's fresh sweep and runtime (repeatable)
 *   --use-state                sweep a copy of the developer's state instead of a fresh bootstrap
 *   --strict                   exit 1 on stage errors, 5xx or request failures, local injection
 *                              into non-documents, URLs claimed by different records without a
 *                              resolution, malformed URLs, failed serve checks or unexplained
 *                              import differences
 *
 * Read-only for sources and developer state: nothing connects to a portal, PAC or a live
 * browser. Runtimes bind to loopback on free ports with temporary state that is removed
 * afterwards. Parse caches live in the output directory. Generic: no data pack is required.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const MIRAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = path.resolve(MIRAGE_ROOT, "..");
export const STAGES = ["import", "bootstrap", "liquid", "webapi", "sweep", "scaffold", "runtime", "serve"];
export const PERSONAS = ["anonymous", "authenticated", "all-roles"];
export const SCAFFOLD_PERSONAS = ["anonymous", "all-roles"];
const DEFAULT_PERSONAS = ["anonymous"];

/** Site component types documented by Microsoft Learn ("Site component type reference"). */
export const COMPONENT_TYPES = Object.freeze({
  1: "publishingstate",
  2: "webpage",
  3: "webfile",
  4: "weblinkset",
  5: "weblink",
  6: "pagetemplate",
  7: "contentsnippet",
  8: "webtemplate",
  9: "sitesetting",
  10: "webpageaccesscontrolrule",
  11: "webrole",
  12: "websiteaccess",
  13: "sitemarker",
  15: "basicform",
  16: "basicformmetadata",
  17: "list",
  18: "tablepermission",
  19: "advancedform",
  20: "advancedformstep",
  21: "advancedformmetadata",
  24: "pollplacement",
  26: "adplacement",
  27: "botconsumer",
  28: "columnpermissionprofile",
  29: "columnpermission",
  30: "redirect",
  31: "publishingstatetransitionrule",
  32: "shortcut",
  33: "cloudflow",
  34: "uxcomponent",
});
const TYPE_OF_KIND = Object.fromEntries(Object.entries(COMPONENT_TYPES).map(([type, kind]) => [kind, Number(type)]));
const STANDARD_KIND_ALIASES = { webpagerule: "webpageaccesscontrolrule" };
const SKIPPED_DIRECTORIES = new Set([".git", ".portalconfig", "node_modules"]);

const sortObject = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const countBy = (items, key) =>
  items.reduce((counts, item) => {
    const value = typeof key === "function" ? key(item) : item?.[key];
    counts[value ?? "unknown"] = (counts[value ?? "unknown"] ?? 0) + 1;
    return counts;
  }, {});
const normalizeId = (value) =>
  String(value && typeof value === "object" ? value.id ?? value.Id ?? value.value ?? "" : value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const isInactive = (value) => Number(value && typeof value === "object" ? value.value ?? value.Value : value) === 1;
const decodeXml = (text = "") =>
  String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) =>
      entity[0] === "#"
        ? String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()],
    );
const xmlValue = (xml, tag) => {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : null;
};
const field = (row, name) => row?.[`adx_${name}`] ?? row?.[`mspp_${name}`] ?? row?.[name];
const exists = (file) =>
  fs.stat(file).then(
    (stat) => stat.isFile(),
    () => false,
  );
const elapsed = (started) => Math.round(performance.now() - started);

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

async function listFiles(root) {
  const files = [];
  const visit = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await visit(root);
  return files;
}

// ---------------------------------------------------------------------------------- census
function emptyKind() {
  return { total: 0, active: 0, names: new Set(), activeNames: new Set() };
}

/**
 * Count the records of a portal export without the Mirage importer: PAC standard YAML
 * (one kind per `*.<kind>.yml` file, arrays or single records) or the enhanced data model
 * (`powerpagecomponent.xml` by documented component type, `Assets/powerpagesites.xml` and
 * `Assets/powerpagesitelanguages.xml`). Inactive means statecode 1.
 */
export async function exportCensus(sourceDir) {
  const root = await fs.realpath(path.resolve(sourceDir));
  const files = await listFiles(root);
  const components = files.filter((file) => path.basename(file).toLowerCase() === "powerpagecomponent.xml");
  const census = {
    sourceDir: root,
    format: components.length ? "enhanced" : "standard",
    // Layout: enhanced powerpagecomponent XML, PAC YAML with adx_ keys, or a code site (.powerpages-site,
    // Microsoft's current "git format": one file per record, short keys such as id, name, isroot).
    dialect: components.length ? "enhanced-xml" : "pac-yaml",
    shortKeyRecords: 0,
    files: 0,
    kinds: {},
    pages: { roots: { total: 0, active: 0 }, content: { total: 0, active: 0 }, contentRoots: new Set(), activeRootIds: new Set(), activeRootFiles: new Set() },
    webFiles: { active: 0, attachmentMissing: [] },
    webTemplates: [],
    siteLanguages: null,
    languageTagged: {},
    unknownTypes: {},
    invalid: [],
    website: null,
  };
  const kindEntry = (kind) => (census.kinds[kind] ??= emptyKind());
  const add = (kind, { name, inactive }) => {
    const entry = kindEntry(kind);
    entry.total++;
    if (name != null) entry.names.add(String(name));
    if (!inactive) {
      entry.active++;
      if (name != null) entry.activeNames.add(String(name));
    }
  };
  const page = ({ id, root: isRoot, inactive, rootId, file }) => {
    const bucket = isRoot ? census.pages.roots : census.pages.content;
    bucket.total++;
    if (!inactive) bucket.active++;
    if (isRoot && !inactive && id) census.pages.activeRootIds.add(normalizeId(id));
    if (isRoot && !inactive && file) census.pages.activeRootFiles.add(path.resolve(file).toLowerCase());
    if (!isRoot && !inactive && rootId) census.pages.contentRoots.add(normalizeId(rootId));
  };
  if (census.format === "enhanced") {
    census.files = components.length;
    for (const file of components) {
      const xml = await fs.readFile(file, "utf8");
      const type = Number(/<powerpagecomponenttype>\s*(\d+)\s*</.exec(xml)?.[1]);
      const kind = COMPONENT_TYPES[type] ?? `type-${Number.isFinite(type) ? type : "missing"}`;
      if (!COMPONENT_TYPES[type]) census.unknownTypes[type] = (census.unknownTypes[type] ?? 0) + 1;
      const inactive = isInactive(/<statecode>\s*(\d+)\s*</.exec(xml)?.[1]);
      const name = xmlValue(xml, "name") ?? "";
      const id = /powerpagecomponentid="([^"]+)"/.exec(xml)?.[1] ?? path.basename(path.dirname(file));
      let content = {};
      try {
        content = JSON.parse(xmlValue(xml, "content") ?? "{}") ?? {};
      } catch (error) {
        census.invalid.push({ file, message: error.message });
      }
      add(kind, { name, inactive });
      if (/<powerpagesitelanguageid>/.test(xml)) census.languageTagged[kind] = (census.languageTagged[kind] ?? 0) + 1;
      if (kind === "webpage") page({ id, root: content.isroot !== false, inactive, rootId: content.rootwebpageid, file });
      if (kind === "webtemplate") census.webTemplates.push({ name, active: !inactive, file });
      if (kind === "webfile" && !inactive) {
        census.webFiles.active++;
        const attachment = xmlValue(xml, "filecontent")?.trim();
        if (!attachment || !(await exists(path.join(path.dirname(file), "filecontent", attachment))))
          census.webFiles.attachmentMissing.push({ name, file });
      }
    }
    const assets = files.filter((file) => /^powerpagesite(?:language)?s\.xml$/i.test(path.basename(file)));
    for (const file of assets) {
      const xml = await fs.readFile(file, "utf8");
      if (/^powerpagesites\.xml$/i.test(path.basename(file))) {
        census.website = { id: normalizeId(/powerpagesiteid="([^"]+)"/.exec(xml)?.[1]), name: xmlValue(xml, "name"), dataModelVersion: xmlValue(xml, "datamodelversion") };
        continue;
      }
      census.siteLanguages = { total: 0, active: 0, names: [] };
      for (const match of xml.matchAll(/<powerpagesitelanguage\b[^>]*>([\s\S]*?)<\/powerpagesitelanguage>/g)) {
        census.siteLanguages.total++;
        if (!isInactive(/<statecode>\s*(\d+)\s*</.exec(match[1])?.[1])) census.siteLanguages.active++;
        census.siteLanguages.names.push(xmlValue(match[1], "name"));
      }
    }
  } else {
    const yamlFiles = files.filter((file) => /\.ya?ml$/i.test(file) && !/[\\/]deployment-profiles[\\/]/i.test(path.relative(root, file)));
    census.files = yamlFiles.length;
    if (/(?:^|[\\/])\.powerpages-site$/i.test(root)) census.dialect = "code-site";
    const texts = await mapLimit(yamlFiles, 32, (file) => fs.readFile(file, "utf8").catch((error) => ({ error })));
    for (const [index, file] of yamlFiles.entries()) {
      const stem = path.basename(file).replace(/\.ya?ml$/i, "");
      const raw = stem.split(".").at(-1).toLowerCase();
      const kind = STANDARD_KIND_ALIASES[raw] ?? raw;
      let rows;
      try {
        if (texts[index]?.error) throw texts[index].error;
        rows = YAML.parse(texts[index], { uniqueKeys: false });
      } catch (error) {
        census.invalid.push({ file, message: error.message });
        continue;
      }
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (!row || typeof row !== "object") continue;
        const inactive = isInactive(row.statecode ?? row.adx_statecode);
        const name = field(row, "name") ?? null;
        add(kind, { name, inactive });
        // Short keys (code sites) carry the record ID as id and the columns without the adx_ prefix.
        const shortKeys = typeof row.id === "string" && !Object.keys(row).some((key) => key.startsWith("adx_"));
        if (shortKeys) census.shortKeyRecords++;
        if (kind === "website") census.website = { id: normalizeId(row.adx_websiteid ?? row.id), name };
        if (kind === "webpage") page({ id: row.adx_webpageid ?? row.id, root: field(row, "isroot") !== false, inactive, rootId: field(row, "rootwebpageid"), file });
        if (kind === "webtemplate") census.webTemplates.push({ name: name ?? stem, active: !inactive, file });
        if (kind === "webfile" && !inactive) {
          census.webFiles.active++;
          const candidates = [row.filename, stem.replace(/\.webfile$/i, ""), name].filter(Boolean);
          let found = false;
          for (const candidate of candidates) if (await exists(path.join(path.dirname(file), String(candidate)))) found = true;
          if (!found) census.webFiles.attachmentMissing.push({ name, file });
        }
      }
    }
    // A YAML export whose records use short keys is a code site even outside a .powerpages-site folder.
    const records = Object.values(census.kinds).reduce((sum, entry) => sum + entry.total, 0);
    if (census.shortKeyRecords && census.shortKeyRecords * 2 > records) census.dialect = "code-site";
  }
  return census;
}

/** JSON-safe census: sets become counts. */
export function censusSummary(census) {
  return {
    format: census.format,
    dialect: census.dialect,
    shortKeyRecords: census.shortKeyRecords,
    files: census.files,
    website: census.website,
    kinds: sortObject(
      Object.fromEntries(
        Object.entries(census.kinds).map(([kind, entry]) => [kind, { total: entry.total, active: entry.active, activeNames: entry.activeNames.size }]),
      ),
    ),
    pages: {
      roots: census.pages.roots,
      content: census.pages.content,
      activeRootsWithoutActiveContent: [...census.pages.activeRootIds].filter((id) => !census.pages.contentRoots.has(id)).length,
    },
    webFiles: { active: census.webFiles.active, attachmentMissing: census.webFiles.attachmentMissing.length },
    siteLanguages: census.siteLanguages,
    languageTagged: sortObject(census.languageTagged),
    unknownTypes: census.unknownTypes,
    invalid: census.invalid,
  };
}

// ---------------------------------------------------------------------------------- import comparison
const MODELLED = {
  webpage: "root pages with a resolved URL",
  webtemplate: "web templates",
  contentsnippet: "content snippets (distinct names)",
  sitesetting: "site settings (distinct names)",
  webfile: "web files with attachment and parent",
  pagetemplate: "page templates",
  weblinkset: "web link sets (distinct names)",
  weblink: "web links reachable from a set",
  sitemarker: "site markers",
  webrole: "web roles",
  webpageaccesscontrolrule: "page access rules",
  tablepermission: "table permissions",
  websiteaccess: "website access records",
  websitelanguage: "website languages",
  publishingstate: "publishing states (all, no statecode filter)",
  redirect: "redirects (all, no statecode filter)",
  urlhistory: "URL history rows",
  shortcut: "shortcuts",
  basicform: "basic forms",
  basicformmetadata: "basic form metadata",
  list: "lists",
  advancedform: "advanced forms",
  advancedformstep: "advanced form steps",
  advancedformmetadata: "advanced form metadata",
  columnpermissionprofile: "column permission profiles (Web API column security)",
  columnpermission: "column permissions (Web API column security)",
};
const NOT_MODELLED_NOTE = "kept as raw records; no runtime model";

/** Compare the raw census with the imported model, kind by kind; differences carry their explanation. */
export function compareImport(census, portal) {
  const records = portal.records ?? [];
  const active = (kinds) => records.filter((record) => kinds.includes(record.kind) && !isInactive(field(record, "statecode"))).length;
  const aliases = (kind) => [kind, ...(TYPE_OF_KIND[kind] ? [`component:${TYPE_OF_KIND[kind]}`] : [])];
  const diagnostics = portal.diagnostics ?? [];
  const byCode = (code, kind) => diagnostics.filter((d) => d.code === code && (!kind || d.kind === kind)).length;
  const raw = (kind) => census.kinds[kind] ?? emptyKind();
  const linkCount = (links = []) => links.reduce((sum, link) => sum + 1 + linkCount(link.weblinks), 0);
  // Copies the importer drops: identical re-exports, and conflicting copies of one ID resolved
  // to a single copy (DUPLICATE_RECORD_RESOLVED; DUPLICATE_RECORD_CONFLICT kept both before).
  const DROPPED = ["DUPLICATE_RECORD_IDENTICAL", "DUPLICATE_RECORD_RESOLVED"];
  const dropped = (kind) => diagnostics.filter((d) => DROPPED.includes(d.code) && d.kind === kind).length;
  const rows = [];
  const row = (kind, expected, imported, explained = [], note) => {
    const explainedCount = explained.reduce((sum, item) => sum + item.count, 0);
    rows.push({
      kind,
      label: MODELLED[kind] ?? kind,
      expected,
      imported,
      difference: expected - imported,
      explained: explained.filter((item) => item.count),
      unexplained: expected - imported - explainedCount,
      ...(note ? { note } : {}),
    });
  };
  const duplicates = (kind) => [{ reason: "duplicate copies of one ID dropped (DUPLICATE_RECORD_IDENTICAL/RESOLVED)", count: dropped(kind) }];
  {
    // A dropped copy counts against root pages only when its file is an active root record.
    const rootFiles = census.pages.activeRootFiles ?? new Set();
    const droppedRoots = diagnostics.filter((d) => DROPPED.includes(d.code) && d.kind === "webpage" && d.file && rootFiles.has(path.resolve(d.file).toLowerCase())).length;
    row("webpage", census.pages.roots.active, portal.pages.length, [
      { reason: "missing parent or cycle (page-hierarchy)", count: byCode("page-hierarchy") },
      { reason: "duplicate root copies of one ID dropped (DUPLICATE_RECORD_IDENTICAL/RESOLVED)", count: droppedRoots },
    ]);
  }
  row("webtemplate", raw("webtemplate").active, new Set(Object.values(portal.templates ?? {})).size, duplicates("webtemplate"));
  row("contentsnippet", raw("contentsnippet").activeNames.size, Object.keys(portal.snippets ?? {}).length, [],
    `distinct names; ${active(["contentsnippet"])} active snippet records imported of ${raw("contentsnippet").active} in the export`);
  row("sitesetting", raw("sitesetting").activeNames.size, Object.keys(portal.settings ?? {}).length);
  row("webfile", raw("webfile").active, (portal.webFiles ?? []).length, [
    { reason: "attachment or parent missing (webfile-missing)", count: byCode("webfile-missing") },
    ...duplicates("webfile"),
  ], census.webFiles.attachmentMissing.length ? `${census.webFiles.attachmentMissing.length} active web file(s) have no attachment in the export` : undefined);
  row("pagetemplate", raw("pagetemplate").active, (portal.pageTemplates ?? []).length, duplicates("pagetemplate"));
  row("weblinkset", raw("weblinkset").activeNames.size, Object.keys(portal.weblinks ?? {}).length);
  const notes = [];
  {
    const activeSets = records.filter((r) => r.kind === "weblinkset" && !isInactive(field(r, "statecode")));
    const sets = new Set(activeSets.map((r) => normalizeId(r.id)));
    const links = records.filter((r) => r.kind === "weblink" && !isInactive(field(r, "statecode")));
    const linkIds = new Set(links.map((r) => normalizeId(r.id)));
    const setOf = (r) => normalizeId(field(r, "weblinksetid"));
    const orphan = (r) => !sets.has(setOf(r)) || Boolean(field(r, "parentweblinkid") && !linkIds.has(normalizeId(field(r, "parentweblinkid"))));
    // Every active set is reachable by ID (portal.weblinkSets); older models keyed sets by name only.
    const reachableSets = portal.weblinkSets ?? Object.values(portal.weblinks ?? {});
    const kept = new Set(reachableSets.map((set) => normalizeId(set.id)));
    const unreachable = activeSets.filter((r) => !kept.has(normalizeId(r.id)));
    const unreachableIds = new Set(unreachable.map((r) => normalizeId(r.id)));
    row("weblink", raw("weblink").active, reachableSets.reduce((sum, set) => sum + linkCount(set.weblinks), 0), [
      { reason: "set or parent link inactive or missing", count: links.filter(orphan).length },
      {
        reason: `in ${unreachable.length} active set(s) shadowed by another set with the same name (${[...new Set(unreachable.map((r) => r.name))].join(", ")}); unreachable by name and by set ID`,
        count: links.filter((r) => !orphan(r) && unreachableIds.has(setOf(r))).length,
        limitation: true,
      },
      ...duplicates("weblink"),
    ]);
    const shared = diagnostics.filter((d) => d.code === "WEBLINK_SET_NAME_SHARED");
    if (shared.length)
      notes.push({ kind: "weblinkset", count: shared.length, reason: `set(s) share a name with an earlier set (${[...new Set(shared.map((d) => d.name))].join(", ")}); lookups by name use the first, each set stays reachable by ID (WEBLINK_SET_NAME_SHARED)` });
  }
  row("sitemarker", raw("sitemarker").active, (portal.siteMarkers ?? []).length, duplicates("sitemarker"));
  for (const kind of ["webrole", "webpageaccesscontrolrule", "tablepermission", "basicformmetadata", "advancedformstep", "advancedformmetadata"])
    row(kind, raw(kind).active, active(aliases(kind)), duplicates(kind));
  row("websiteaccess", raw("websiteaccess").active, (portal.websiteAccess ?? []).length, duplicates("websiteaccess"));
  if (census.format === "enhanced")
    row("websitelanguage", census.siteLanguages?.active ?? 0, (portal.websiteLanguages ?? []).length, [],
      "enhanced: Assets/powerpagesitelanguages.xml");
  else row("websitelanguage", raw("websitelanguage").active, (portal.websiteLanguages ?? []).length, duplicates("websitelanguage"));
  row("publishingstate", raw("publishingstate").total, (portal.publishingStates ?? []).length, duplicates("publishingstate"));
  row("redirect", raw("redirect").total, (portal.redirects ?? []).length, duplicates("redirect"));
  row("urlhistory", raw("urlhistory").active, (portal.urlHistory ?? []).length, duplicates("urlhistory"),
    raw("urlhistory").total === 5000 ? "the export holds exactly 5,000 rows (one Dataverse page); it may be truncated" : undefined);
  row("shortcut", raw("shortcut").active, (portal.shortcuts ?? []).length, duplicates("shortcut"));
  row("basicform", raw("basicform").active, (portal.forms ?? []).length, duplicates("basicform"));
  row("list", raw("list").active, (portal.lists ?? []).length, duplicates("list"));
  row("advancedform", raw("advancedform").active, (portal.advancedForms ?? []).length, duplicates("advancedform"));
  for (const kind of ["columnpermissionprofile", "columnpermission"])
    if (raw(kind).total) row(kind, raw(kind).active, active(aliases(kind)), duplicates(kind));
  const modelled = new Set([...Object.keys(MODELLED), "website"]);
  const notModelled = Object.entries(census.kinds)
    .filter(([kind]) => !modelled.has(kind))
    .map(([kind, entry]) => ({ kind, total: entry.total, active: entry.active, note: NOT_MODELLED_NOTE }));
  const importedKinds = countBy(records, "kind");
  const unrecognized = Object.entries(importedKinds)
    .filter(([kind]) => kind.startsWith("component:"))
    .map(([kind, count]) => ({ kind, documented: COMPONENT_TYPES[kind.split(":")[1]] ?? null, records: count }));
  // Export hygiene: records exported twice with different content, and how the runtime resolved them.
  for (const [kind, count] of Object.entries(countBy(diagnostics.filter((d) => d.code === "DUPLICATE_RECORD_RESOLVED"), "kind")))
    notes.push({ kind, count, reason: "exported twice with different content; one copy is used (DUPLICATE_RECORD_RESOLVED names it)" });
  for (const [kind, count] of Object.entries(countBy(diagnostics.filter((d) => d.code === "DUPLICATE_RECORD_CONFLICT"), "kind")))
    notes.push({ kind, count, reason: "share an ID with different content (DUPLICATE_RECORD_CONFLICT); consumers treat the ID as ambiguous", limitation: true });
  return {
    rows,
    notModelled,
    unrecognizedComponentTypes: unrecognized,
    unexplained: rows.filter((item) => item.unexplained !== 0).map(({ kind, expected, imported, unexplained }) => ({ kind, expected, imported, unexplained })),
    // Explained losses that still change what the runtime can reach.
    limitations: [
      ...rows.flatMap((item) => item.explained.filter((reason) => reason.limitation).map((reason) => ({ kind: item.kind, count: reason.count, reason: reason.reason }))),
      ...notes.filter((note) => note.limitation),
    ],
    notes: notes.filter((note) => !note.limitation),
  };
}

/**
 * URLs claimed by more than one imported page, or by more than one web file, after the runtime's
 * own path normalization (normalizePortalPath); a page and a web file collide only on the same
 * URL (pages answer paths ending with "/", web files the others). A claim the importer resolved
 * (URL_CLAIMED_TWICE: the claimant first in Dataverse ID order is served) carries `resolved`.
 * Also lists URLs with empty segments ("//").
 */
export function routeCollisions(portal, normalizePortalPath) {
  const claims = new Map();
  const claim = (kind, url, owner) => {
    if (!url) return;
    const key = `${kind}\0${normalizePortalPath(url)}`;
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(owner);
  };
  for (const page of portal.pages ?? []) claim("webpage", page.url, { kind: "page", id: page.id, name: page.name, url: page.url });
  for (const file of portal.webFiles ?? []) claim("webfile", file.url, { kind: "webfile", id: file.id, name: file.name, url: file.url });
  const resolutions = new Map(
    (portal.diagnostics ?? []).filter((d) => d.code === "URL_CLAIMED_TWICE").map((d) => [`${d.kind}\0${normalizePortalPath(d.path)}`, d]),
  );
  const collisions = [];
  for (const [key, owners] of claims) {
    if (owners.length < 2) continue;
    const [kind, route] = key.split("\0");
    const resolution = resolutions.get(key);
    const served = resolution ? owners.find((owner) => owner.id === resolution.usedId) ?? null : null;
    collisions.push({
      route,
      kind,
      distinctRecords: new Set(owners.map((owner) => owner.id)).size,
      owners,
      resolved: resolution ? { rule: resolution.rule ?? null, served: served?.name ?? resolution.usedId ?? null } : null,
    });
  }
  // A page and a web file on exactly the same URL (case-insensitive).
  const pageUrls = new Map((portal.pages ?? []).map((page) => [String(page.url).toLowerCase(), page]));
  for (const file of portal.webFiles ?? []) {
    const page = pageUrls.get(String(file.url).toLowerCase());
    if (page)
      collisions.push({
        route: normalizePortalPath(file.url),
        kind: "mixed",
        distinctRecords: 2,
        owners: [{ kind: "page", id: page.id, name: page.name, url: page.url }, { kind: "webfile", id: file.id, name: file.name, url: file.url }],
        resolved: null,
      });
  }
  const malformed = [...(portal.pages ?? []).map((page) => ({ kind: "page", id: page.id, name: page.name, url: page.url })), ...(portal.webFiles ?? []).map((file) => ({ kind: "webfile", id: file.id, name: file.name, url: file.url }))].filter((owner) => /\/\//.test(owner.url ?? ""));
  return { collisions, malformed };
}

/** Missing include targets classified against the raw export. */
export function classifyMissingIncludes(names, webTemplates) {
  return names.map((name) => {
    const lower = String(name).toLowerCase();
    const matches = webTemplates.filter((template) => String(template.name ?? "").toLowerCase() === lower);
    const exact = matches.filter((template) => template.name === name);
    let classification;
    if (!matches.length) classification = "absent-from-export";
    else if (!matches.some((template) => template.active)) classification = "inactive-in-export";
    else classification = "present-not-resolved";
    return {
      name,
      classification,
      ...(matches.length ? { exportRecords: matches.map(({ name: recordName, active, file }) => ({ name: recordName, active, file })) } : {}),
      ...(matches.length && !exact.length ? { caseDiffers: true } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------- public samples
/**
 * Public sample sites, referenced in place under a samples root (one folder per cloned
 * repository, named owner__repo). Nothing is copied. `model` is what the publisher declares
 * (PAC YAML does not mark it); `solutions` are the sample's own unpacked Solutions, relative to
 * the repository. Every listed repository is MIT licensed.
 */
export const PUBLIC_SAMPLES = Object.freeze([
  // Microsoft's current code sites (".powerpages-site"); every folder of that name is a sample.
  { repo: "microsoft__power-pages-samples", url: "https://github.com/microsoft/power-pages-samples", licence: "MIT", codeSites: true, model: "enhanced" },
  { id: "gov-core-portal-yaml", repo: "microsoft__gov-apptemplates", url: "https://github.com/microsoft/gov-apptemplates", licence: "MIT", source: "portals/core-portal/site", solutions: ["cross-module/core/src"], model: "enhanced" },
  { id: "gov-core-portal-solution", repo: "microsoft__gov-apptemplates", url: "https://github.com/microsoft/gov-apptemplates", licence: "MIT", source: "portals/core-portal/src", solutions: ["cross-module/core/src"], model: "enhanced" },
  { id: "contoso-real-estate", repo: "microsoft__contoso-real-estate-power-platform", url: "https://github.com/microsoft/contoso-real-estate-power-platform", licence: "MIT", source: "lense/portal/solution/ContosoRealEstatePortal/src", solutions: ["lense/core/solution/ContosoRealEstateCore/src", "lense/controls/solution/ContosoRealEstateCustomControls/src"], model: "enhanced" },
  { id: "nonprofits-volunteer-edm", repo: "microsoft__Nonprofits", url: "https://github.com/microsoft/Nonprofits", licence: "MIT", source: "VolunteerEngagement/Portal-EDM/.powerpages-site", solutions: [], model: "enhanced", note: "its CDM and VolunteerManagement Solutions are not part of the clone" },
  { id: "wet-boew-gcweb", repo: "alfredofosu__wet-boew-power-pages-template", url: "https://github.com/alfredofosu/wet-boew-power-pages-template", licence: "MIT", source: "enhanced-data-model/gcweb-power-pages-template", solutions: [], model: "enhanced", note: "the Solution ships only as packed zips" },
  { id: "portals-alm-starter", repo: "microsoft__power-apps-portals-alm", url: "https://github.com/microsoft/power-apps-portals-alm", licence: "MIT", source: "portal/starter-portal", solutions: [], model: "standard" },
]);

/** Folders named `.powerpages-site` below a directory (code sites), skipping dependencies. */
async function codeSiteFolders(dir, depth = 0, found = []) {
  if (depth > 9) return found;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ["node_modules", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === ".powerpages-site") found.push(full);
    else await codeSiteFolders(full, depth + 1, found);
  }
  return found;
}

/** The public samples present under `root`, with their Solution roots; missing clones are listed, not fatal. */
export async function publicSampleTargets(root, samples = PUBLIC_SAMPLES) {
  const base = path.resolve(root);
  const isDirectory = (dir) => fs.stat(dir).then((stat) => stat.isDirectory(), () => false);
  const targets = [];
  const missing = [];
  for (const sample of samples) {
    const repo = path.join(base, sample.repo);
    if (!(await isDirectory(repo))) {
      missing.push({ id: sample.id ?? sample.repo, repo: sample.repo, reason: "not cloned" });
      continue;
    }
    const entries = sample.codeSites
      ? (await codeSiteFolders(repo)).map((dir) => {
          const relative = path.relative(repo, dir).replace(/\\/g, "/");
          // samples/spa/<group>/<name>/<variant>/.powerpages-site -> pps-<group>-<name>-<variant>
          const id = `pps-${relative.replace(/\/?\.powerpages-site$/, "").replace(/^(?:samples|templates)\/spa\//, "").replace(/\/(?:variants|website-code)\b/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
          // Templates ship their Dataverse Solution beside the variants: templates/spa/<t>/solutions.
          const template = /^templates\/spa\/([^/]+)\//.exec(relative);
          return { id, source: relative, solutions: template ? [`templates/spa/${template[1]}/solutions`] : [] };
        })
      : [{ id: sample.id, source: sample.source, solutions: sample.solutions ?? [] }];
    for (const entry of entries) {
      const sourceDir = path.join(repo, entry.source);
      if (!(await isDirectory(sourceDir))) {
        missing.push({ id: entry.id, repo: sample.repo, reason: `${entry.source} is not in the clone` });
        continue;
      }
      const solutionRoots = [];
      for (const solution of entry.solutions) if (await isDirectory(path.join(repo, solution))) solutionRoots.push(path.join(repo, solution));
      targets.push({
        id: entry.id,
        label: `${sample.repo}/${entry.source}`,
        sourceDir,
        solutionRoots,
        // No Solution of its own: an empty root keeps sibling discovery from layering unrelated clones.
        isolateSolutions: true,
        solutions: [],
        solutionOrder: "derived",
        origin: null,
        reference: null,
        deploymentProfile: undefined,
        environmentVariables: {},
        lcid: 1033,
        simulatorOptions: { solutionOrder: "derived" },
        sweepOptions: { source: sourceDir, portal: entry.id, solutionRoots: [...solutionRoots] },
        sample: { repo: sample.repo, url: sample.url, licence: sample.licence, declaredModel: sample.model, ...(sample.note ? { note: sample.note } : {}) },
      });
    }
  }
  return { targets, missing };
}

// ---------------------------------------------------------------------------------- targets
/** Resolve the portals under test from a project file, catalogue sites or a public samples root. */
export async function resolveTargets(options) {
  if (options.samples) {
    const { targets, missing } = await publicSampleTargets(options.samples);
    const selected = options.portals?.length ? targets.filter((target) => options.portals.includes(target.id)) : targets;
    for (const id of options.portals ?? []) if (!targets.some((target) => target.id === id)) throw new Error(`Sample '${id}' is not present under ${path.resolve(options.samples)}`);
    return { mode: "samples", project: null, targets: selected, missing };
  }
  if (options.project) {
    const { loadProjectConfig, projectOrigin, projectSummary } = await import("./lib/project-config.mjs");
    const project = await loadProjectConfig(options.project);
    const selected = options.portals?.length ? options.portals : project.portals.map((portal) => portal.id);
    for (const id of selected)
      if (!project.portals.some((portal) => portal.id === id)) throw new Error(`Portal '${id}' is not configured in ${project.configFile}`);
    return {
      mode: "project",
      project,
      targets: project.portals
        .filter((portal) => selected.includes(portal.id))
        .map((portal) => ({
          id: portal.id,
          label: `${path.basename(project.configFile)}#${portal.id}`,
          sourceDir: portal.sourceDir,
          solutionRoots: portal.solutionRoots ?? [],
          solutions: portal.solutions ?? [],
          solutionOrder: project.solutionOrder ?? "explicit",
          origin: projectOrigin(project, portal),
          reference: portal.reference ?? project.defaultReference?.id ?? null,
          deploymentProfile: portal.deploymentProfile ?? undefined,
          environmentVariables: project.environmentVariables ?? {},
          lcid: project.lcid ?? 1033,
          simulatorOptions: { project: projectSummary(project, portal.id), solutionOrder: project.solutionOrder, environmentVariables: project.environmentVariables },
          sweepOptions: { project: project.configFile, portal: portal.id },
        })),
    };
  }
  if (!options.sites?.length) throw new Error("Select portals with --project FILE or --sites a,b");
  const { loadConfig } = await import("../lense/config.mjs");
  const { discoverSolutionRoots } = await import("./lib/solution-roots.mjs");
  const targets = [];
  for (const site of options.sites) {
    const cfg = await loadConfig({ site, ...(options.env?.[site] ? { env: options.env[site] } : {}), ...(options.repo ? { repo: options.repo } : {}) });
    const catalogued = cfg.mirageConfig?.solutionRoots ?? [];
    targets.push({
      id: cfg.siteName,
      label: `${cfg.siteName}/${cfg.envName}`,
      sourceDir: cfg.sourceDir,
      solutionRoots: catalogued.length ? catalogued : await discoverSolutionRoots(cfg.sourceDir),
      solutionRootsSource: catalogued.length ? "catalogue" : "discovery",
      solutions: [],
      solutionOrder: "explicit",
      origin: cfg.origin ?? null,
      reference: cfg.envName,
      deploymentProfile: undefined,
      environmentVariables: {},
      lcid: 1033,
      simulatorOptions: {},
      sweepOptions: { site: cfg.siteName, env: cfg.envName, ...(options.repo ? { repo: options.repo } : {}) },
    });
  }
  return { mode: "sites", project: null, targets };
}

// ---------------------------------------------------------------------------------- stages
async function importStage(target, context) {
  const { importPortal, normalizePortalPath } = await import("./lib/importer.mjs");
  let started = performance.now();
  const census = await exportCensus(target.sourceDir);
  const censusMs = elapsed(started);
  started = performance.now();
  const portal = await importPortal(target.sourceDir, { lcid: target.lcid, ...(target.deploymentProfile ? { deploymentProfile: target.deploymentProfile } : {}) });
  const importMs = elapsed(started);
  context.census = census;
  context.portal = portal;
  const comparison = compareImport(census, portal);
  const routes = routeCollisions(portal, normalizePortalPath);
  const pagesWithoutCopy = portal.pages.filter(
    (page) => !(portal.records ?? []).some((record) => record.kind === "webpage" && normalizeId(field(record, "rootwebpageid")) === page.id),
  ).length;
  return {
    format: portal.format,
    dialect: census.dialect,
    website: { id: normalizeId(portal.website?.id ?? field(portal.website, "websiteid")), name: portal.website?.name ?? field(portal.website, "name") ?? null },
    language: portal.language ? { id: portal.language.id, code: portal.language.code ?? null, lcid: portal.language.lcid ?? null } : null,
    census: censusSummary(census),
    counts: {
      pages: portal.pages.length,
      pagesWithoutContentCopy: pagesWithoutCopy,
      templates: new Set(Object.values(portal.templates ?? {})).size,
      snippets: Object.keys(portal.snippets ?? {}).length,
      settings: Object.keys(portal.settings ?? {}).length,
      webFiles: portal.webFiles.length,
      forms: portal.forms.length,
      lists: portal.lists.length,
      advancedForms: (portal.advancedForms ?? []).length,
      redirects: portal.redirects.length,
      urlHistory: portal.urlHistory.length,
      shortcuts: portal.shortcuts.length,
      websiteLanguages: portal.websiteLanguages.length,
      records: portal.records.length,
      recordsWithoutId: portal.records.filter((record) => !record.id).length,
    },
    comparison,
    routes,
    diagnostics: sortObject(countBy(portal.diagnostics ?? [], "code")),
    diagnosticSamples: (portal.diagnostics ?? []).slice(0, 50).map(({ code, kind, id, file, message, pageId }) => ({ code, kind, id, pageId, file, message })),
    censusMs,
    importMs,
  };
}

async function bootstrapStage(target, context) {
  const { bootstrapReport } = await import("./bootstrap-report.mjs");
  const report = await bootstrapReport({
    label: target.label,
    sourceDir: target.sourceDir,
    solutionRoots: target.solutionRoots,
    order: target.solutionOrder,
    deploymentProfile: target.deploymentProfile,
    origin: target.origin,
    environmentVariables: target.environmentVariables,
    lcid: target.lcid,
    cacheFile: path.join(context.cacheDir, target.id, "solution-sources.json"),
  });
  const s = report.summary;
  // Where the tables this portal uses are defined: root/solution of the full definition, else the
  // last partial layer, else the documented catalogue or relationship origin.
  const rootOf = (dir) => {
    const owner = target.solutionRoots.find((root) => {
      const relative = path.relative(path.resolve(root), path.resolve(dir ?? ""));
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    return owner ? path.basename(owner) : null;
  };
  const layerRoot = new Map((report.inputs.layers ?? []).map((layer) => [layer.solution, rootOf(layer.dir)]));
  const definedBy = (table) => {
    const full = table.layers.find((layer) => layer.fullDefinition);
    const layer = full ?? table.layers.at(-1);
    if (layer) return `${layerRoot.get(layer.solution) ?? "?"}/${layer.solution}${full ? "" : " (partial)"}`;
    return `no layer (${table.origin ?? table.entitySetSource ?? "unknown"})`;
  };
  const portalTables = report.tables.filter((table) => table.portalUse.length);
  const permission = (mode) => {
    const p = report.permissions[mode];
    return { enabled: p.enabled, total: p.total, byScope: p.byScope, disabledByCode: p.disabledByCode };
  };
  context.details.bootstrap = {
    inputs: report.inputs,
    summary: s,
    tableSources: portalTables.map((table) => ({ table: table.logicalName, portalUse: table.portalUse, definedBy: definedBy(table), entitySetSource: table.entitySetSource, schemaComplete: table.schemaComplete })),
    portalTablesWithoutDefinition: report.portalTablesWithoutDefinition.map(({ logicalName, portalUse, mapping }) => ({ logicalName, portalUse, entitySet: mapping?.entitySet ?? null })),
    apiOracle: report.apiOracle,
    permissions: { configured: report.permissions.configured, exported: report.permissions.exported },
    webRoles: report.webRoles,
    pageRules: report.pageRules,
    websiteLanguages: report.websiteLanguages,
    redirects: report.redirects,
    shortcuts: report.shortcuts,
    environmentVariables: report.environmentVariables.map(({ schemaName, value, defaultValue, type, source }) => ({ schemaName, hasValue: value !== undefined, hasDefault: defaultValue !== undefined, type, source })),
    webApiSettings: report.webApiSettings,
    diagnostics: report.diagnostics.map(({ code, origin, message, table, entity, file, id, name }) => ({ code, origin, message, table, entity, file, id, name })),
  };
  return {
    layers: report.inputs.layers.length,
    layerOrder: report.inputs.rootOrder,
    firstLayer: report.inputs.layers[0]?.solution ?? null,
    lastLayer: report.inputs.layers.at(-1)?.solution ?? null,
    tables: s.tables,
    completeTables: s.completeTables,
    portalTables: s.portalTables,
    portalTableSources: sortObject(countBy(portalTables, definedBy)),
    portalTablesWithoutDefinition: report.portalTablesWithoutDefinition.map((table) => `${table.logicalName}[${table.portalUse.join("/")}]`),
    apiOracle: s.apiOracle,
    apiUnresolved: report.apiOracle.filter((entry) => entry.status === "unresolved").map((entry) => entry.entitySet),
    relationships: s.relationships,
    lookups: s.lookups,
    formsResolved: s.formsResolved,
    listsResolved: s.listsResolved,
    advancedFormsResolved: s.advancedFormsResolved,
    permissionsConfigured: permission("configured"),
    permissionsExported: permission("exported"),
    webRoles: s.webRoles,
    authenticatedUsersRoles: report.webRoles.filter((role) => role.authenticated).map((role) => role.name),
    anonymousUsersRoles: report.webRoles.filter((role) => role.anonymous).map((role) => role.name),
    pageRules: s.pageRules,
    publishingStates: report.publishingStates.map((state) => `${state.name}${state.isVisible ? " (visible)" : ""}${state.active ? "" : " [inactive]"}`),
    websiteLanguages: report.websiteLanguages.map((language) => `${language.name}${language.isDefault ? " (default)" : ""}`),
    redirects: s.redirects,
    urlHistory: s.urlHistory,
    shortcuts: s.shortcuts,
    environmentVariables: s.environmentVariables,
    environmentVariablesWithValues: s.environmentVariablesWithValues,
    webApiTables: s.webApiTables,
    webApiTablesComplete: report.webApiSettings.filter((entry) => String(entry.enabled).toLowerCase() === "true" && entry.schemaComplete).length,
    webApiTablesIncomplete: report.webApiSettings.filter((entry) => String(entry.enabled).toLowerCase() === "true" && !entry.schemaComplete).map((entry) => entry.table),
    diagnostics: s.diagnostics,
    timings: s.timings,
  };
}

async function liquidStage(target, context) {
  const { inventoryPortal } = await import("./liquid-inventory.mjs");
  if (!context.portal) {
    const { importPortal } = await import("./lib/importer.mjs");
    context.portal = await importPortal(target.sourceDir, { lcid: target.lcid });
  }
  context.census ??= await exportCensus(target.sourceDir);
  const inventory = await inventoryPortal(context.portal);
  const count = (list, status) => list.filter((entry) => entry.status === status).length;
  const missing = classifyMissingIncludes(inventory.missingIncludes ?? [], context.census.webTemplates).map((entry) => {
    const include = (inventory.includes ?? []).find((item) => item.name === entry.name);
    return { ...entry, uses: include?.count ?? null, examples: (include?.examples ?? []).slice(0, 5) };
  });
  context.details.liquid = inventory;
  return {
    sources: inventory.sources.total,
    sourcesByKind: inventory.sources.byKind,
    tags: { distinct: inventory.tags.length, uses: inventory.totals.tags, unsupported: count(inventory.tags, "unsupported"), unknown: count(inventory.tags, "unknown") },
    filters: { distinct: inventory.filters.length, uses: inventory.totals.filters, unsupported: count(inventory.filters, "unsupported"), unknown: count(inventory.filters, "unknown") },
    objects: { distinct: inventory.objects.length, undefined: inventory.undefinedObjects.length, unsupported: count(inventory.objects, "unsupported") },
    properties: { distinct: inventory.properties.length, unsupported: count(inventory.properties, "unsupported") },
    unsupported: inventory.unsupported.map(({ kind, name, count: uses, examples }) => ({ kind, name, uses, examples: (examples ?? []).slice(0, 3) })),
    syntaxErrors: inventory.syntaxErrors.map(({ source, file, message }) => ({ source, file, message: String(message).replace(/\s+/g, " ").slice(0, 300) })),
    missingIncludes: missing,
    unknownTags: inventory.unknownTags,
    unknownFilters: inventory.unknownFilters,
    undefinedObjects: inventory.undefinedObjects.slice(0, 40),
  };
}

async function webapiStage(target, context) {
  const { inventoryWebApi } = await import("./webapi-inventory.mjs");
  const report = await inventoryWebApi(target.sourceDir, { solutionRoots: target.solutionRoots });
  context.details.webapi = report;
  return {
    sources: report.sourceCount,
    requestExpressions: report.webApi.requestExpressions,
    entitySets: Object.keys(report.webApi.entitySets ?? {}).length,
    settings: report.webApi.settings,
    fetchXml: { analysed: report.fetchXml.blocksAnalysed, parsed: report.fetchXml.parsed },
    features: report.supportMatrix.length,
    unsupported: report.unsupported.map(({ feature, uses, note }) => ({ feature, uses, ...(note ? { note } : {}) })),
    staticSyntaxFailures: report.syntaxFailures.staticFailures.map(({ kind, name, file, option, error }) => ({ kind, name, file, option, error: String(error).slice(0, 300) })),
    dynamicOnlyFailures: report.syntaxFailures.dynamicOnly,
    unknownEntitySets: report.solution?.unknownEntitySets ?? null,
  };
}

/** Compact one render-sweep run (A's renderSweep report shape, with a fallback for the single-run shape). */
function compactSweepRun(run) {
  const liquidErrorPages = (run.liquidErrorPages ?? []).map((url) => {
    const result = (run.results ?? []).find((entry) => entry.url === url);
    const messages = [...new Set([...(result?.liquidErrors ?? []).map((diagnostic) => diagnostic.message), ...(result?.inlineErrors ?? [])])];
    return { url, messages: messages.slice(0, 3) };
  });
  return {
    persona: run.persona ?? "anonymous",
    note: run.personaNote ?? null,
    state: run.state ?? null,
    identity: run.identity ?? null,
    pages: run.pages,
    requests: run.requests,
    byStatus: run.byStatus,
    liquidErrorPages,
    liquidDiagnosticCounts: run.liquidDiagnosticCounts ?? {},
    injectedNonDocuments: run.injectedNonDocuments ?? [],
    failures: run.failures ?? [],
    durationMs: run.durationMs ?? null,
  };
}

async function sweepStage(target, context) {
  const personas = context.personas;
  if (!personas.length) return { skipped: "no persona selected" };
  const { renderSweep } = await import("./render-sweep.mjs");
  // render-sweep runs anonymous+authenticated as "both" and all three as "all"; other subsets run one by one.
  const set = new Set(personas);
  const selections =
    set.size === 3 ? ["all"] : set.size === 2 && set.has("anonymous") && set.has("authenticated") ? ["both"] : [...set];
  const reports = [];
  for (const persona of selections)
    reports.push(
      await renderSweep({
        ...target.sweepOptions,
        solutionRoots: target.sweepOptions.solutionRoots ?? [],
        persona,
        ...(context.useState ? {} : { state: path.join(context.tmp, "fresh-state", target.id, "state.json") }),
        ...(context.presets[target.id] ? { preset: context.presets[target.id] } : {}),
        ...(context.limit ? { limit: context.limit } : {}),
        ...(context.pathPrefix ? { pathPrefix: context.pathPrefix } : {}),
      }),
    );
  const runs = reports.flatMap((report) => (Array.isArray(report.runs) ? report.runs : [report]));
  context.details.sweep = { ...reports[0], runs };
  return { runs: runs.map(compactSweepRun) };
}

async function api(simulator, route, { method = "GET", body } = {}) {
  const csrf = simulator.state({ summary: true }).csrf;
  const response = await fetch(`${simulator.url}/__sim/api${route}`, {
    method,
    headers: { "content-type": "application/json", "x-sim-csrf": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

/**
 * Create a local contact holding every exported web role except Anonymous Users (the coverage
 * persona render-sweep calls all-roles) and sign it in. Returns the role names, the contact and
 * the Cookie header of its paqvilo-mirage-auth session (simulator.signIn, else the session API).
 */
export async function signInAllRolesPersona(simulator) {
  const personas = await api(simulator, "/personas");
  const named = (name) => String(name ?? "").trim().toLowerCase();
  const roles = (personas.payload.webRoles ?? []).filter((role) => !role.anonymous && named(role.name) !== "anonymous users");
  const create = () => api(simulator, "/personas", { method: "POST", body: { firstname: "Portal", lastname: "Matrix", roleIds: roles.map((role) => role.id) } });
  let created = await create();
  if (created.status === 409 && created.payload?.error?.code === "CONTACT_UNMAPPED") {
    await simulator.applyPreset("empty-local");
    created = await create();
  }
  if (created.status >= 300) throw new Error(`persona HTTP ${created.status}: ${created.payload?.error?.message ?? created.payload?.message ?? "unknown error"}`);
  const contactId =
    created.payload.contact?.contactid ?? Object.values(created.payload.contact ?? {}).find((value) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value));
  if (typeof simulator.signIn === "function") {
    const session = simulator.signIn(contactId);
    return { roles: roles.map((role) => role.name), contactId, signedInRoles: session.identity?.roles ?? [], cookie: session.cookieHeader };
  }
  const session = await api(simulator, "/session/sign-in", { method: "POST", body: { contactId } });
  if (session.status !== 200 || !session.payload?.signedIn) throw new Error(`sign-in HTTP ${session.status}: ${session.payload?.error?.message ?? "the persona did not sign in"}`);
  const cookie = session.payload.cookie?.name && session.payload.cookie?.value ? `${session.payload.cookie.name}=${session.payload.cookie.value}` : null;
  if (!cookie) throw new Error("sign-in returned no session cookie");
  return { roles: roles.map((role) => role.name), contactId, signedInRoles: session.payload.roles ?? [], cookie };
}

/**
 * GET /_api/<entity set>?$select=<primary key>&$top=1 for every table whose Webapi/<table>/enabled
 * setting is true (a select-less read names a column outside Webapi/<table>/fields, 403 90040101),
 * as a same-origin script request (webapi.safeAjax) of a browser, signed in when `cookie` is given.
 */
export async function probeWebApi(simulator, { cookie = null } = {}) {
  const settings = simulator.portal.settings ?? {};
  const tables = Object.entries(settings)
    .filter(([name, value]) => /^Webapi\/[^/]+\/enabled$/i.test(name) && String(value).trim().toLowerCase() === "true")
    .map(([name]) => name.split("/")[1].toLowerCase())
    .sort();
  const headers = { accept: "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", ...(cookie ? { cookie } : {}) };
  const results = [];
  for (const table of [...new Set(tables)]) {
    let entitySet = null,
      idColumn = null;
    try {
      ({ entitySet, idColumn } = simulator.store.resolveMapping(table));
    } catch (error) {
      results.push({ table, entitySet: null, status: null, error: `no mapping: ${error.code ?? error.message}` });
      continue;
    }
    try {
      const response = await fetch(`${simulator.url}/_api/${entitySet}?$select=${encodeURIComponent(idColumn)}&$top=1`, { headers, signal: AbortSignal.timeout(60_000) });
      const payload = await response.json().catch(() => null);
      results.push({
        table,
        entitySet,
        status: response.status,
        ...(response.ok ? { rows: Array.isArray(payload?.value) ? payload.value.length : null } : { error: payload?.error?.code ?? payload?.error?.message ?? null }),
      });
    } catch (error) {
      results.push({ table, entitySet, status: 0, error: error.message });
    }
  }
  return { tables: results.length, byStatus: countBy(results, (result) => result.status ?? "unmapped"), results };
}

async function fileSize(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return null;
  }
}

/** Cold start, state size, admin and home status, Web API probes, close and warm restart of one portal. */
async function runtimeStage(target, context) {
  const { createSimulator } = await import("./server.mjs");
  const directory = await fs.mkdtemp(path.join(context.tmp, `runtime-${target.id}-`));
  const stateFile = path.join(directory, "state.json");
  const options = {
    sourceDir: target.sourceDir,
    stateFile,
    origin: target.origin ?? undefined,
    solutionRoots: target.solutionRoots,
    deploymentProfile: target.deploymentProfile,
    watch: false,
    port: 0,
    ...target.simulatorOptions,
  };
  const result = {};
  let simulator;
  try {
    let started = performance.now();
    simulator = await createSimulator(options);
    result.coldStartMs = elapsed(started);
    result.stateBytesAfterStart = await fileSize(stateFile);
    const summary = simulator.state({ summary: true });
    result.bootstrapTimings = summary.status?.bootstrap?.timings ?? null;
    result.layers = summary.status?.bootstrap?.layers?.length ?? null;
    const status = await fetch(`${simulator.url}/__sim/api/status`).then((response) => response.json());
    result.status = { site: status.site, format: status.format, pageCount: status.pageCount, diagnostics: status.diagnostics?.total ?? null };
    result.admin = (await fetch(simulator.adminUrl)).status;
    result.home = (await fetch(`${simulator.url}/`, { headers: { "sec-fetch-site": "none" }, redirect: "manual" })).status;
    const preset = context.presets[target.id];
    if (preset) {
      started = performance.now();
      await simulator.applyPreset(preset);
      result.preset = { id: preset, applyMs: elapsed(started), stateBytes: await fileSize(stateFile) };
    }
    // Data binding: every Webapi-enabled table anonymously (cross-check with agent B's probes) and,
    // with the all-roles persona selected, as that signed-in contact.
    try {
      result.webApiProbe = { identity: "anonymous", ...(await probeWebApi(simulator)) };
    } catch (error) {
      result.webApiProbe = { identity: "anonymous", error: error.message };
    }
    if (context.personas.includes("all-roles")) {
      try {
        const session = await signInAllRolesPersona(simulator);
        result.webApiProbeAllRoles = { identity: "all-roles", roles: session.signedInRoles, ...(await probeWebApi(simulator, { cookie: session.cookie })) };
      } catch (error) {
        result.webApiProbeAllRoles = { identity: "all-roles", error: error.message };
      }
    }
    started = performance.now();
    await simulator.close();
    simulator = null;
    result.closeMs = elapsed(started);
    result.stateBytesAfterRun = await fileSize(stateFile);
    started = performance.now();
    simulator = await createSimulator(options);
    result.warmStartMs = elapsed(started);
    result.warmBootstrapTimings = simulator.state({ summary: true }).status?.bootstrap?.timings ?? null;
    await simulator.close();
    simulator = null;
  } finally {
    await simulator?.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

/**
 * One scaffold persona contact (the one holding an Authenticated Users role, else the first) gets
 * every exported web role except Anonymous Users and becomes the state's configured identity, so
 * render-sweep's `configured` persona signs in as it over the scaffolded rows (its `all-roles`
 * persona would apply the empty-local preset and drop them).
 */
export async function configureCoverageContact(stateFile, portal) {
  const { DataStore } = await import("./lib/data.mjs");
  const { portalWebRoles } = await import("./lib/permissions.mjs");
  const store = await new DataStore({ file: stateFile }).init();
  const state = store.snapshot();
  const roles = portalWebRoles(portal).filter((role) => !role.anonymous && String(role.name ?? "").trim().toLowerCase() !== "anonymous users");
  const memberships = (state.simulator ??= {}).contactRoles ?? [];
  const contacts = [...new Set(memberships.map((entry) => normalizeId(entry.contactId)))].sort();
  if (!contacts.length) return { contactId: null, roles: [], note: "the scaffold created no persona contact" };
  const authenticated = new Set(roles.filter((role) => role.authenticated || String(role.name).trim().toLowerCase() === "authenticated users").map((role) => normalizeId(role.id)));
  const contactId = contacts.find((id) => memberships.some((entry) => normalizeId(entry.contactId) === id && authenticated.has(normalizeId(entry.roleId)))) ?? contacts[0];
  const held = new Set(memberships.filter((entry) => normalizeId(entry.contactId) === contactId).map((entry) => normalizeId(entry.roleId)));
  state.simulator.contactRoles = [...memberships, ...roles.filter((role) => !held.has(normalizeId(role.id))).map((role) => ({ contactId, roleId: role.id }))];
  state.simulator.identity = { id: contactId, contactId, roleSource: "memberships", roles: [] };
  await store.replaceState(state, { expectedSnapshot: JSON.stringify(store.snapshot()) });
  return { contactId, roles: roles.map((role) => role.name) };
}

const COMPONENT_TAG = /\{%-?\s*(entityform|webform|entitylist)\b/gi;
const STATIC_INCLUDE = /\{%-?\s*include\s+(['"])([^'"]+)\1/g;
const COMPONENT_KIND = { entityform: "basicform", webform: "advancedform", entitylist: "list" };

/**
 * Basic forms, advanced forms and lists a page renders: its own form/list fields and the
 * entityform, webform and entitylist tags of its page template's web template, its copy and
 * their statically included web templates.
 */
export function pageComponentKinds(portal, page) {
  const kinds = new Set();
  if (page.formId) kinds.add("basicform");
  if (page.advancedFormId) kinds.add("advancedform");
  if (page.listId) kinds.add("list");
  const byName = new Map();
  for (const template of Object.values(portal.templates ?? {})) if (template?.name) byName.set(template.name.toLowerCase(), template);
  const pageTemplate = (portal.pageTemplates ?? []).find((candidate) => candidate.id === page.pageTemplateId);
  const queue = [portal.templates?.[pageTemplate?.webTemplateId]?.source, page.html].filter(Boolean);
  const seen = new Set();
  for (let index = 0; index < queue.length && index < 200; index++) {
    for (const match of queue[index].matchAll(COMPONENT_TAG)) kinds.add(COMPONENT_KIND[match[1].toLowerCase()]);
    for (const match of queue[index].matchAll(STATIC_INCLUDE)) {
      const name = match[2].toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      if (byName.get(name)?.source) queue.push(byName.get(name).source);
    }
  }
  return kinds;
}

/** Form, list and record-bound requests of sweep results: how many, and with which status codes. */
export function componentRequests(results, portal) {
  const kinds = new Map((portal?.pages ?? []).map((page) => [page.id, pageComponentKinds(portal, page)]));
  const group = (filter) => {
    const selected = results.filter(filter);
    return { requests: selected.length, byStatus: countBy(selected, "status") };
  };
  const has = (result, kind) => kinds.get(result.pageId)?.has(kind) ?? false;
  return {
    basicFormPages: group((result) => has(result, "basicform")),
    advancedFormPages: group((result) => has(result, "advancedform")),
    listPages: group((result) => has(result, "list")),
    recordRequests: group((result) => Boolean(result.derivedRecord)),
    componentDiagnostics: sortObject(
      countBy(
        results.flatMap((result) => (result.otherDiagnostics ?? []).filter((code) => /^(?:COMPONENT_|ADVANCEDFORM_|SYSTEMFORM_|SYSTEMVIEW_|LIST_|FORM_|LOOKUP_)/.test(String(code)))),
        (code) => code,
      ),
    ),
  };
}

/**
 * Generic data: `data scaffold` (lib/scaffold-data.mjs) on a temporary state, its table/row/persona
 * counts, a runtime on that state (start time, size, Web API reads anonymously and as the coverage
 * contact) and render-sweep's anonymous and configured personas over the scaffolded rows.
 */
async function scaffoldStage(target, context) {
  const { scaffoldDataCommand } = await import("./lib/data-generation.mjs");
  const { createSimulator } = await import("./server.mjs");
  const { renderSweep } = await import("./render-sweep.mjs");
  if (!context.portal) {
    const { importPortal } = await import("./lib/importer.mjs");
    context.portal = await importPortal(target.sourceDir, { lcid: target.lcid });
  }
  const directory = path.join(context.tmp, "scaffold", target.id);
  await fs.mkdir(directory, { recursive: true });
  const stateFile = path.join(directory, "state.json");
  let started = performance.now();
  const generated = await scaffoldDataCommand({ profile: context.scaffoldProfile, state: stateFile, source: target.sourceDir, solutionRoots: target.solutionRoots });
  const report = generated.report ?? {};
  const result = {
    profile: generated.profile,
    scaffoldMs: generated.elapsedMs ?? elapsed(started),
    referencedTables: report.referencedTables ?? null,
    referencedWithoutMetadata: report.referencedWithoutMetadata ?? [],
    generatedTables: report.generatedTables ?? null,
    rows: report.rows ?? null,
    personas: report.personas ?? null,
    memberships: generated.addedMemberships ?? null,
    sources: report.sources ?? {},
    addedForRequiredLookups: report.addedForRequiredLookups ?? [],
    unresolvedRequiredLookups: report.unresolvedRequiredLookups ?? [],
    stateBytes: await fileSize(stateFile),
  };
  result.coverage = await configureCoverageContact(stateFile, context.portal);
  // Data binding over scaffolded rows (a copy, so the sweeps below start from the same state).
  const runtimeState = path.join(directory, "runtime", "state.json");
  await fs.mkdir(path.dirname(runtimeState), { recursive: true });
  await fs.copyFile(stateFile, runtimeState);
  let simulator;
  try {
    started = performance.now();
    simulator = await createSimulator({ sourceDir: target.sourceDir, stateFile: runtimeState, origin: target.origin ?? undefined, solutionRoots: target.solutionRoots, deploymentProfile: target.deploymentProfile, watch: false, port: 0, ...target.simulatorOptions });
    result.startMs = elapsed(started);
    result.webApiProbe = { identity: "anonymous", ...(await probeWebApi(simulator)) };
    if (result.coverage.contactId && typeof simulator.signIn === "function") {
      const session = simulator.signIn(result.coverage.contactId);
      result.webApiProbeCoverage = { identity: "coverage contact", roles: session.identity?.roles ?? [], ...(await probeWebApi(simulator, { cookie: session.cookieHeader })) };
    }
  } catch (error) {
    result.runtimeError = error.message;
  } finally {
    await simulator?.close().catch(() => {});
  }
  const runs = [];
  for (const persona of context.scaffoldPersonas) {
    const sweep = await renderSweep({
      ...target.sweepOptions,
      solutionRoots: target.sweepOptions.solutionRoots ?? [],
      persona: persona === "all-roles" ? "configured" : persona,
      state: stateFile,
      ...(context.limit ? { limit: context.limit } : {}),
      ...(context.pathPrefix ? { pathPrefix: context.pathPrefix } : {}),
    });
    for (const run of sweep.runs ?? []) runs.push({ ...run, persona: `scaffold ${persona}` });
  }
  context.details.scaffold = { generated, coverage: result.coverage, webApiProbe: result.webApiProbe, webApiProbeCoverage: result.webApiProbeCoverage, runs };
  result.runs = runs.map((run) => ({ ...compactSweepRun(run), components: componentRequests(run.results ?? [], context.portal) }));
  return result;
}

/** Spawn `cli.mjs serve --project FILE --port 0 --no-watch` and wait for the printed portal list. */
async function serveOnce(projectFile, timeoutMs) {
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(MIRAGE_ROOT, "cli.mjs"), "serve", "--project", projectFile, "--port", "0", "--no-watch"], {
    cwd: MIRAGE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not report its portals within ${timeoutMs} ms`)), timeoutMs);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        try {
          const parsed = JSON.parse(output);
          clearTimeout(timer);
          resolve(parsed);
        } catch {}
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      exited.then(({ code }) => {
        clearTimeout(timer);
        reject(new Error(`serve exited with ${code} before it was ready: ${(errors || output).trim().slice(-2000)}`));
      });
    });
    return { child, exited, ready, startMs: elapsed(started) };
  } catch (error) {
    await stopServe({ child, exited });
    throw error;
  }
}

/** Graceful stop (a `stop` line on stdin), forced after 30 s. */
async function stopServe({ child, exited }) {
  if (child.exitCode != null) return { graceful: true, exitCode: child.exitCode };
  child.stdin.write("stop\n");
  let timer;
  const stopped = await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(() => resolve(null), 30_000)))]);
  clearTimeout(timer);
  if (!stopped) {
    child.kill();
    await exited;
  }
  return { graceful: Boolean(stopped), exitCode: stopped?.code ?? null };
}

/** Start every project portal with `cli.mjs serve --project` (temporary copy of the project) and check isolation. */
async function serveStage(resolved, context) {
  const project = resolved.project;
  const directory = await fs.mkdtemp(path.join(context.tmp, "serve-"));
  const stateDirectory = path.join(directory, "state");
  const copy = {
    version: 2,
    defaultPortal: project.defaultPortal,
    lcid: project.lcid,
    watch: false,
    solutionOrder: project.solutionOrder,
    stateDirectory,
    portals: project.portals.map((portal) => ({
      id: portal.id,
      path: portal.sourceDir,
      ...(portal.origin ? { origin: portal.origin } : {}),
      ...(portal.reference ? { reference: portal.reference } : {}),
      ...(portal.deploymentProfile ? { deploymentProfile: portal.deploymentProfile } : {}),
      solutions: portal.solutions,
    })),
    solutions: project.solutions.map((solution) => ({ id: solution.id, path: solution.root })),
    references: project.references.map(({ id, origin, name, environment, default: isDefault }) => ({ id, origin, ...(name ? { name } : {}), ...(environment ? { environment } : {}), default: isDefault })),
    dataPacks: project.dataPacks.map(({ id, module }) => ({ id, module })),
    environmentVariables: project.environmentVariables,
  };
  const projectFile = path.join(directory, "mirage.project.json");
  await fs.writeFile(projectFile, JSON.stringify(copy, null, 2));
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(MIRAGE_ROOT, "cli.mjs"), "serve", "--project", projectFile, "--port", "0", "--no-watch"], {
    cwd: MIRAGE_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const result = { projectCopy: projectFile, portals: [], checks };
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not report its portals within ${context.serveTimeoutMs} ms`)), context.serveTimeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        try {
          const parsed = JSON.parse(output);
          clearTimeout(timer);
          resolve(parsed);
        } catch {}
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      exited.then(({ code }) => {
        clearTimeout(timer);
        reject(new Error(`serve exited with ${code} before it was ready: ${(errors || output).trim().slice(-2000)}`));
      });
    });
    result.startMs = elapsed(started);
    result.discovery = ready.discovery ?? null;
    const portals = ready.portals ?? [];
    check("one runtime per configured portal", portals.length === project.portals.length, `${portals.length}/${project.portals.length}`);
    check("distinct loopback ports", new Set(portals.map((portal) => new URL(portal.url).port)).size === portals.length);
    check("distinct state files", new Set(portals.map((portal) => path.resolve(portal.stateFile).toLowerCase())).size === portals.length);
    check(
      "state files under stateDirectory/<portal>/state.json",
      portals.every((portal) => path.resolve(portal.stateFile).toLowerCase() === path.join(stateDirectory, portal.id, "state.json").toLowerCase()),
    );
    const csrfTokens = [];
    for (const portal of portals) {
      const entry = { id: portal.id, url: portal.url, stateFile: portal.stateFile, stateBytes: await fileSize(portal.stateFile) };
      try {
        const status = await fetch(`${portal.url}/__sim/api/status`, { signal: AbortSignal.timeout(30_000) }).then((response) => response.json());
        csrfTokens.push(status.csrf);
        const state = await fetch(`${portal.url}/__sim/api/state?summary=1`, { signal: AbortSignal.timeout(60_000) }).then((response) => response.json());
        entry.site = status.site;
        entry.format = status.format;
        entry.pageCount = status.pageCount;
        entry.projectPortal = state.status?.project?.portal ?? null;
        entry.sourceDir = status.sourceDir;
        entry.admin = (await fetch(`${portal.url}/_sim/`)).status;
        entry.legacyAdmin = (await fetch(portal.adminUrl)).status;
        entry.home = (await fetch(`${portal.url}/`, { redirect: "manual" })).status;
      } catch (error) {
        entry.error = error.message;
      }
      result.portals.push(entry);
    }
    check("every runtime reports its own project portal", result.portals.every((entry) => entry.projectPortal === entry.id));
    check("every runtime serves its own export", result.portals.every((entry) => {
      const configured = project.portals.find((portal) => portal.id === entry.id);
      return configured && entry.sourceDir && path.resolve(entry.sourceDir).toLowerCase() === path.resolve(configured.sourceDir).toLowerCase();
    }));
    check("admin workspace answers on every origin (/_sim/ and /__sim/)", result.portals.every((entry) => entry.admin === 200 && entry.legacyAdmin === 200));
    check("distinct CSRF tokens (separate admin sessions)", csrfTokens.length === portals.length && new Set(csrfTokens).size === csrfTokens.length);
    let discovery = null;
    try {
      discovery = JSON.parse(await fs.readFile(ready.discovery, "utf8"));
    } catch {}
    check("discovery file lists every portal", (discovery?.portals ?? []).length === portals.length, ready.discovery ?? null);
    try {
      const { mirageStatus, miragePaths } = await import("../lense/commands/mirage.mjs");
      const paths = miragePaths(null, { project: projectFile });
      // The toolkit probes each runtime with a short timeout; a loaded machine gets a few attempts.
      let sessions = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        sessions = (await mirageStatus(paths)).filter((session) => session.pid === child.pid);
        if (sessions.length === portals.length && sessions.every((session) => session.ready)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      result.toolkitStatus = sessions.map(({ portal, url, ready: isReady, owned, stateFile }) => ({ portal, url, ready: isReady, owned, stateFile }));
      check("toolkit `mirage status` lists every portal as ready", sessions.length === portals.length && sessions.every((session) => session.ready), `${sessions.length} session(s), owned: ${[...new Set(sessions.map((session) => session.owned))].join("/")}`);
    } catch (error) {
      check("toolkit `mirage status` lists every portal as ready", false, error.message);
    }
  } catch (error) {
    result.error = error.message;
  } finally {
    const stopStarted = performance.now();
    if (child.exitCode == null) {
      child.stdin.write("stop\n");
      let timer;
      const stopped = await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(() => resolve(null), 30_000)))]);
      clearTimeout(timer);
      if (!stopped) {
        child.kill();
        await exited;
      }
      result.stop = { graceful: Boolean(stopped), ms: elapsed(stopStarted), exitCode: stopped?.code ?? null };
    }
    check("clean stop removes the discovery file", result.discovery ? !(await exists(result.discovery)) : false);
    // Warm restart: the same state directory, now with each portal's state and Solution parse cache.
    if (!result.error)
      try {
        const warm = await serveOnce(projectFile, context.serveTimeoutMs);
        result.warmStartMs = warm.startMs;
        check("warm restart starts every portal", (warm.ready.portals ?? []).length === project.portals.length, `${((warm.startMs ?? 0) / 1000).toFixed(1)} s`);
        await stopServe(warm);
      } catch (error) {
        check("warm restart starts every portal", false, error.message);
      }
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

// ---------------------------------------------------------------------------------- orchestration
/** Run the selected stages for every portal and return the matrix object. */
export async function portalMatrix(options = {}) {
  const started = performance.now();
  const stages = new Set(options.only?.length ? options.only : STAGES);
  for (const stage of options.skip ?? []) stages.delete(stage);
  for (const stage of stages) if (!STAGES.includes(stage)) throw new Error(`Unknown stage '${stage}'; use ${STAGES.join(", ")}`);
  const personas = options.personas?.length ? options.personas : DEFAULT_PERSONAS;
  for (const persona of personas) if (!PERSONAS.includes(persona)) throw new Error(`Unknown persona '${persona}'; use ${PERSONAS.join(", ")}`);
  const scaffoldPersonas = options.scaffoldPersonas?.length ? options.scaffoldPersonas : SCAFFOLD_PERSONAS;
  for (const persona of scaffoldPersonas)
    if (!SCAFFOLD_PERSONAS.includes(persona)) throw new Error(`Unknown scaffold persona '${persona}'; use ${SCAFFOLD_PERSONAS.join(", ")}`);
  const scaffoldProfile = options.scaffoldProfile ?? "smoke";
  if (!["smoke", "dev"].includes(scaffoldProfile)) throw new Error("--scaffold-profile must be smoke or dev");
  const resolved = await resolveTargets(options);
  const out = options.out ? path.resolve(options.out) : null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pp-portal-matrix-"));
  const log = options.log ?? ((line) => process.stderr.write(`[portal-matrix] ${line}\n`));
  const cacheDir = out ? path.join(out, "cache") : path.join(tmp, "cache");
  // Targets without Solutions of their own (public samples) get an empty root: every tool then
  // skips sibling discovery, which would layer unrelated neighbouring clones into them.
  const noSolutions = path.join(tmp, "no-solutions");
  for (const target of resolved.targets)
    if (target.isolateSolutions && !target.solutionRoots.length) {
      await fs.mkdir(noSolutions, { recursive: true });
      target.solutionRoots = [noSolutions];
      target.sweepOptions.solutionRoots = [noSolutions];
      target.solutionRootsSource = "none (empty placeholder root)";
    }
  const matrix = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    input: resolved.mode === "project"
      ? { project: resolved.project.configFile, version: resolved.project.version, solutionOrder: resolved.project.solutionOrder, solutions: resolved.project.solutions.map(({ id, root }) => ({ id, root })), references: resolved.project.references.map(({ id, origin, environment }) => ({ id, origin, environment })) }
      : resolved.mode === "samples"
        ? { samples: path.resolve(options.samples), missing: resolved.missing }
        : { sites: resolved.targets.map((target) => target.label) },
    stages: STAGES.filter((stage) => stages.has(stage) && (stage !== "serve" || resolved.mode === "project")),
    personas,
    ...(stages.has("scaffold") ? { scaffoldPersonas, scaffoldProfile } : {}),
    sweepScope: { limit: options.limit ?? null, pathPrefix: options.pathPrefix ?? null, state: options.useState ? "copy of developer state" : "fresh bootstrap" },
    portals: [],
  };
  try {
    for (const target of resolved.targets) {
      const entry = {
        id: target.id,
        label: target.label,
        sourceDir: target.sourceDir,
        solutionRoots: target.solutionRoots,
        ...(target.solutionRootsSource ? { solutionRootsSource: target.solutionRootsSource } : {}),
        solutionOrder: target.solutionOrder,
        origin: target.origin,
        reference: target.reference,
        ...(target.sample ? { sample: target.sample } : {}),
        errors: [],
      };
      const context = { tmp, cacheDir, personas, scaffoldPersonas, scaffoldProfile, presets: options.presets ?? {}, limit: options.limit, pathPrefix: options.pathPrefix, useState: options.useState, details: {} };
      const runners = { import: importStage, bootstrap: bootstrapStage, liquid: liquidStage, webapi: webapiStage, sweep: sweepStage, scaffold: scaffoldStage, runtime: runtimeStage };
      for (const stage of STAGES.filter((name) => name !== "serve" && stages.has(name))) {
        const stageStarted = performance.now();
        log(`${target.id}: ${stage}…`);
        try {
          entry[stage] = await runners[stage](target, context);
        } catch (error) {
          entry[stage] = { error: error.message };
          entry.errors.push({ stage, message: error.message });
        }
        entry[stage].ms = elapsed(stageStarted);
        log(`${target.id}: ${stage} ${(entry[stage].ms / 1000).toFixed(1)} s${entry[stage].error ? ` (error: ${entry[stage].error})` : ""}`);
        if (out) {
          // Details: the full tool report where one exists (bootstrap, liquid, webapi, sweep), else the matrix entry.
          await fs.mkdir(path.join(out, target.id), { recursive: true });
          const detail = stage === "runtime" ? { ...entry.runtime, ...(context.details.runtime ?? {}) } : (context.details[stage] ?? entry[stage]);
          await fs.writeFile(path.join(out, target.id, `${stage}.json`), JSON.stringify(detail, null, 2));
        }
      }
      matrix.portals.push(entry);
    }
    if (stages.has("serve") && resolved.mode === "project") {
      log("project: serve…");
      const serveStarted = performance.now();
      try {
        matrix.serve = await serveStage(resolved, { tmp, serveTimeoutMs: options.serveTimeoutMs ?? 600_000 });
      } catch (error) {
        matrix.serve = { error: error.message, checks: [] };
      }
      matrix.serve.ms = elapsed(serveStarted);
      log(`project: serve ${(matrix.serve.ms / 1000).toFixed(1)} s`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  matrix.durationMs = elapsed(started);
  matrix.problems = matrixProblems(matrix);
  if (out) {
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, "matrix.json"), JSON.stringify(matrix, null, 2));
    await fs.writeFile(path.join(out, "matrix.md"), formatMatrix(matrix));
  }
  return matrix;
}

/** Problems that fail --strict. */
export function matrixProblems(matrix) {
  const problems = [];
  for (const portal of matrix.portals) {
    for (const error of portal.errors) problems.push({ portal: portal.id, stage: error.stage, problem: `stage failed: ${error.message}` });
    for (const item of portal.import?.comparison?.unexplained ?? [])
      problems.push({ portal: portal.id, stage: "import", problem: `${item.kind}: export ${item.expected}, imported ${item.imported} (${item.unexplained > 0 ? `${item.unexplained} missing` : `${-item.unexplained} extra`}, unexplained)` });
    for (const item of portal.import?.routes?.collisions ?? [])
      if (item.distinctRecords > 1 && !item.resolved)
        problems.push({ portal: portal.id, stage: "import", problem: `route ${item.route} is claimed by ${item.owners.map((owner) => `${owner.kind} '${owner.name}' (${owner.url})`).join(" and ")}` });
    for (const item of portal.import?.routes?.malformed ?? [])
      problems.push({ portal: portal.id, stage: "import", problem: `${item.kind} '${item.name}' has the malformed URL ${item.url}` });
    for (const [stage, runs] of [["sweep", portal.sweep?.runs ?? []], ["scaffold", portal.scaffold?.runs ?? []]])
      for (const run of runs) {
        for (const failure of run.failures ?? []) problems.push({ portal: portal.id, stage, problem: `${run.persona}: ${failure.url} ${failure.failure ?? `HTTP ${failure.status}`}` });
        for (const injected of run.injectedNonDocuments ?? []) problems.push({ portal: portal.id, stage, problem: `${run.persona}: local runtime injected into non-document ${injected.url}` });
      }
    if (portal.scaffold?.runtimeError) problems.push({ portal: portal.id, stage: "scaffold", problem: `runtime on scaffolded state: ${portal.scaffold.runtimeError}` });
  }
  for (const item of matrix.serve?.checks ?? []) if (!item.passed) problems.push({ portal: "project", stage: "serve", problem: `${item.name}${item.detail ? ` (${item.detail})` : ""}` });
  if (matrix.serve?.error) problems.push({ portal: "project", stage: "serve", problem: matrix.serve.error });
  return problems;
}

// ---------------------------------------------------------------------------------- Markdown
const cell = (value) => (value === undefined || value === null || value === "" ? "–" : String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
const statuses = (byStatus) =>
  byStatus && Object.keys(byStatus).length
    ? Object.entries(byStatus)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([status, count]) => `${status}×${count}`)
        .join(" ")
    : "–";
const pairs = (object) => (object && Object.keys(object).length ? Object.entries(object).map(([key, value]) => `${key} ${value}`).join(", ") : "–");
const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "–");
const bytes = (value) => (Number.isFinite(value) ? (value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(0)} KB`) : "–");

function table(header, rows) {
  return [`| ${header.map((value) => (value ? cell(value) : " ")).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)].join("\n");
}

/** Markdown summary: one column per portal, then findings. */
export function formatMatrix(matrix) {
  const portals = matrix.portals;
  const ids = portals.map((portal) => portal.id);
  const lines = [];
  const add = (...text) => lines.push(...text);
  const metric = (label, get) => [label, ...portals.map((portal) => {
    try {
      return get(portal);
    } catch {
      return "–";
    }
  })];
  // Rows of one stage: a failed or skipped stage shows as such instead of partial values.
  const stageMetric = (stage) => (label, get) =>
    metric(label, (portal) => (!portal[stage] ? "–" : portal[stage].error ? `error: ${portal[stage].error}` : get(portal)));
  add(`# Portal matrix`, "");
  add(`Generated ${matrix.generatedAt} on ${matrix.platform} (Node ${matrix.node}) in ${seconds(matrix.durationMs)}.`);
  add(matrix.input.project ? `Project: \`${matrix.input.project}\` (version ${matrix.input.version}, solution order ${matrix.input.solutionOrder}).` : `Catalogue sites: ${matrix.input.sites.join(", ")}.`);
  add(`Stages: ${matrix.stages.join(", ")}; fresh-state personas: ${matrix.personas.join(", ")}${matrix.scaffoldPersonas ? `; scaffold personas: ${matrix.scaffoldPersonas.join(", ")}` : ""}; sweep state: ${matrix.sweepScope.state}${matrix.sweepScope.limit ? `, limit ${matrix.sweepScope.limit}` : ""}${matrix.sweepScope.pathPrefix ? `, path ${matrix.sweepScope.pathPrefix}` : ""}.`, "");
  add(table(["", ...ids], [
    metric("format", (p) => p.import?.format ?? p.runtime?.status?.format),
    metric("website", (p) => p.import?.website?.name ?? p.runtime?.status?.site),
    metric("source", (p) => p.sourceDir),
    metric("reference origin", (p) => p.origin),
    metric("solution layers", (p) => (p.bootstrap?.layers != null ? `${p.bootstrap.layers} (${p.bootstrap.layerOrder}; ${p.bootstrap.firstLayer} … ${p.bootstrap.lastLayer})` : p.solutionRoots.length ? `${p.solutionRoots.length} root(s)` : "none")),
  ]), "");
  if (matrix.stages.includes("import")) {
    add("## Import (raw export census vs imported model)", "");
    const kinds = [...new Set(portals.flatMap((portal) => (portal.import?.comparison?.rows ?? []).map((row) => row.kind)))];
    add(table(["kind (imported/export)", ...ids], [
      ...kinds.map((kind) => [kind, ...portals.map((portal) => {
        const row = portal.import?.comparison?.rows.find((item) => item.kind === kind);
        if (!row) return "–";
        const flag = row.unexplained !== 0 ? " ⚠" : row.difference ? " ✓" : "";
        return `${row.imported}/${row.expected}${flag}`;
      })]),
      stageMetric("import")("not modelled", (p) => (p.import?.comparison?.notModelled ?? []).map((item) => `${item.kind} ${item.active}/${item.total}`).join(", ") || "none"),
      stageMetric("import")("unrecognised component types", (p) => (p.import?.comparison?.unrecognizedComponentTypes ?? []).map((item) => `${item.kind}${item.documented ? ` (${item.documented})` : ""} ×${item.records}`).join(", ") || "none"),
      stageMetric("import")("route collisions / malformed URLs", (p) =>
        `${(p.import.routes?.collisions ?? []).map((item) => `${item.route} ×${item.owners.length}${item.resolved ? ` ✓ (${item.resolved.rule}: ${item.resolved.served})` : item.distinctRecords > 1 ? " ⚠" : " (same ID)"}`).join(", ") || "none"} / ${(p.import.routes?.malformed ?? []).map((item) => item.url).join(", ") || "none"}`),
      stageMetric("import")("import diagnostics", (p) => pairs(p.import?.diagnostics)),
      stageMetric("import")("census / import time", (p) => `${p.import?.censusMs ?? "–"} / ${p.import?.importMs ?? "–"} ms`),
    ]), "");
    add("`imported/export`: active export records (all records for publishing states and redirects, distinct names for settings and link sets). ✓ = difference fully explained by diagnostics; ⚠ = unexplained difference.", "");
  }
  if (matrix.stages.includes("bootstrap")) {
    add("## Bootstrap", "");
    add(table(["", ...ids], [
      stageMetric("bootstrap")("tables (complete)", (p) => `${p.bootstrap.tables} (${p.bootstrap.completeTables})`),
      stageMetric("bootstrap")("portal tables / without definition", (p) => `${p.bootstrap.portalTables} / ${p.bootstrap.portalTablesWithoutDefinition.length}`),
      stageMetric("bootstrap")("portal tables defined by (root/solution)", (p) =>
        Object.entries(p.bootstrap.portalTableSources ?? {})
          .sort(([, a], [, b]) => b - a)
          .map(([source, count]) => `${source} ${count}`)
          .join(", ")),
      stageMetric("bootstrap")("tables without definition", (p) => p.bootstrap.portalTablesWithoutDefinition.join(", ") || "none"),
      stageMetric("bootstrap")("/_api oracle", (p) => pairs(p.bootstrap.apiOracle) + (p.bootstrap.apiUnresolved.length ? ` (unresolved: ${p.bootstrap.apiUnresolved.join(", ")})` : "")),
      stageMetric("bootstrap")("portal lookups resolved", (p) => `${p.bootstrap.lookups.resolved}/${p.bootstrap.lookups.total}`),
      stageMetric("bootstrap")("forms / lists / advanced forms resolved", (p) => `${p.bootstrap.formsResolved} / ${p.bootstrap.listsResolved} / ${p.bootstrap.advancedFormsResolved}`),
      stageMetric("bootstrap")("form tab fallbacks / ambiguous form names", (p) => `${p.bootstrap.diagnostics.SYSTEMFORM_TAB_FALLBACK ?? 0} / ${p.bootstrap.diagnostics.SYSTEMFORM_NAME_AMBIGUOUS ?? 0}`),
      stageMetric("bootstrap")("permissions enabled (exported)", (p) => `${p.bootstrap.permissionsExported.enabled}/${p.bootstrap.permissionsExported.total}`),
      stageMetric("bootstrap")("disabled by code", (p) => pairs(p.bootstrap.permissionsExported.disabledByCode)),
      stageMetric("bootstrap")("web roles (Authenticated Users flag)", (p) => `${p.bootstrap.webRoles} (${p.bootstrap.authenticatedUsersRoles.join(", ") || "none"})`),
      stageMetric("bootstrap")("page rules", (p) => p.bootstrap.pageRules),
      stageMetric("bootstrap")("publishing states", (p) => p.bootstrap.publishingStates.join(", ")),
      stageMetric("bootstrap")("website languages", (p) => p.bootstrap.websiteLanguages.join(", ") || "none"),
      stageMetric("bootstrap")("redirects / URL history / shortcuts", (p) => `${p.bootstrap.redirects} / ${p.bootstrap.urlHistory} / ${p.bootstrap.shortcuts}`),
      stageMetric("bootstrap")("environment variables (with values)", (p) => `${p.bootstrap.environmentVariables} (${p.bootstrap.environmentVariablesWithValues})`),
      stageMetric("bootstrap")("Web API tables (complete metadata)", (p) => `${p.bootstrap.webApiTables} (${p.bootstrap.webApiTablesComplete})`),
      stageMetric("bootstrap")("bootstrap diagnostics", (p) => pairs(p.bootstrap.diagnostics)),
      stageMetric("bootstrap")("timings", (p) => `portal ${p.bootstrap.timings.portalMs} ms, solutions ${p.bootstrap.timings.solutionsMs} ms (cache ${p.bootstrap.timings.cache?.hits ?? 0}/${(p.bootstrap.timings.cache?.hits ?? 0) + (p.bootstrap.timings.cache?.misses ?? 0)}), model ${p.bootstrap.timings.modelMs} ms`),
    ]), "");
  }
  if (matrix.stages.includes("liquid")) {
    add("## Liquid inventory", "");
    add(table(["", ...ids], [
      stageMetric("liquid")("Liquid sources", (p) => p.liquid.sources),
      stageMetric("liquid")("tags (unsupported/unknown)", (p) => `${p.liquid.tags.distinct} distinct, ${p.liquid.tags.uses} uses (${p.liquid.tags.unsupported}/${p.liquid.tags.unknown})`),
      stageMetric("liquid")("filters (unsupported/unknown)", (p) => `${p.liquid.filters.distinct} distinct, ${p.liquid.filters.uses} uses (${p.liquid.filters.unsupported}/${p.liquid.filters.unknown})`),
      stageMetric("liquid")("unsupported constructs", (p) => (p.liquid.unsupported.length ? p.liquid.unsupported.map((item) => `${item.kind} ${item.name} ×${item.uses}`).join(", ") : "0")),
      stageMetric("liquid")("authored syntax errors", (p) => p.liquid.syntaxErrors.length),
      stageMetric("liquid")("missing includes", (p) => (p.liquid.missingIncludes.length ? p.liquid.missingIncludes.map((item) => `${item.name} (${item.classification})`).join(", ") : "0")),
      stageMetric("liquid")("unknown filters", (p) => p.liquid.unknownFilters.join(", ") || "none"),
      stageMetric("liquid")("undefined roots", (p) => p.liquid.objects.undefined),
    ]), "");
  }
  if (matrix.stages.includes("webapi")) {
    add("## Web API and FetchXML inventory", "");
    add(table(["", ...ids], [
      stageMetric("webapi")("/_api expressions / entity sets", (p) => `${p.webapi.requestExpressions} / ${p.webapi.entitySets}`),
      stageMetric("webapi")("FetchXML blocks (parsed)", (p) => `${p.webapi.fetchXml.analysed} (${p.webapi.fetchXml.parsed})`),
      stageMetric("webapi")("enabled tables", (p) => p.webapi.settings.enabledTables),
      stageMetric("webapi")("unsupported features", (p) => (p.webapi.unsupported.length ? p.webapi.unsupported.map((item) => `${item.feature} ×${item.uses}`).join(", ") : "0")),
      stageMetric("webapi")("static syntax failures / dynamic-only", (p) => `${p.webapi.staticSyntaxFailures.length} / ${p.webapi.dynamicOnlyFailures}`),
      stageMetric("webapi")("unknown entity sets", (p) => (p.webapi.unknownEntitySets ?? []).join(", ") || "none"),
      stageMetric("webapi")("wildcard Webapi fields", (p) => (p.webapi.settings.wildcardFields ?? []).length),
    ]), "");
  }
  if (matrix.stages.includes("sweep")) {
    add("## Render sweeps", "");
    const runsOf = (portal) => portal.sweep?.runs ?? [];
    const personas = [...new Set(portals.flatMap((portal) => runsOf(portal).map((run) => run.persona)))];
    const rows = [];
    for (const persona of personas) {
      const run = (portal) => runsOf(portal).find((item) => item.persona === persona);
      rows.push(metric(`${persona}: requests`, (p) => (run(p)?.error ? `error: ${run(p).error}` : run(p) ? `${run(p).requests} (${run(p).pages} pages)` : "–")));
      rows.push(metric(`${persona}: status codes`, (p) => statuses(run(p)?.byStatus)));
      rows.push(metric(`${persona}: Liquid error pages`, (p) => (run(p) ? run(p).liquidErrorPages?.length ?? "–" : "–")));
      rows.push(metric(`${persona}: Liquid diagnostics`, (p) => pairs(run(p)?.liquidDiagnosticCounts)));
      rows.push(metric(`${persona}: 5xx / failures / injected`, (p) => (run(p) ? `${run(p).failures?.length ?? 0} / ${run(p).injectedNonDocuments?.length ?? 0}` : "–")));
      rows.push(metric(`${persona}: identity`, (p) => (run(p) ? run(p).note ?? (run(p).identity?.authenticated ? `contact, ${run(p).identity.roles?.length ?? 0} role(s)` : "anonymous") : "–")));
      rows.push(metric(`${persona}: duration`, (p) => seconds(run(p)?.durationMs)));
    }
    add(table(["", ...ids], rows), "");
  }
  if (matrix.stages.includes("scaffold")) {
    add(`## Scaffold data (\`data scaffold --profile ${matrix.scaffoldProfile ?? "smoke"}\`) and data-backed sweeps`, "");
    const scaffoldMetric = stageMetric("scaffold");
    const rows = [
      scaffoldMetric("referenced tables / generated tables", (p) => `${p.scaffold.referencedTables} / ${p.scaffold.generatedTables}`),
      scaffoldMetric("rows / personas / memberships", (p) => `${p.scaffold.rows} / ${p.scaffold.personas} / ${p.scaffold.memberships}`),
      scaffoldMetric("referenced without metadata", (p) => p.scaffold.referencedWithoutMetadata.join(", ") || "none"),
      scaffoldMetric("unresolved required lookups", (p) => (p.scaffold.unresolvedRequiredLookups ?? []).length),
      scaffoldMetric("scaffold time / state size", (p) => `${seconds(p.scaffold.scaffoldMs)} / ${bytes(p.scaffold.stateBytes)}`),
      scaffoldMetric("coverage contact roles", (p) => (p.scaffold.coverage?.contactId ? p.scaffold.coverage.roles.length : p.scaffold.coverage?.note ?? "–")),
      scaffoldMetric("runtime start on scaffolded state", (p) => (p.scaffold.runtimeError ? `error: ${p.scaffold.runtimeError}` : seconds(p.scaffold.startMs))),
      scaffoldMetric("Web API reads, anonymous", (p) => `${statuses(p.scaffold.webApiProbe?.byStatus)}; rows in ${(p.scaffold.webApiProbe?.results ?? []).filter((r) => r.rows > 0).length}`),
      scaffoldMetric("Web API reads, coverage contact", (p) => (p.scaffold.webApiProbeCoverage ? `${statuses(p.scaffold.webApiProbeCoverage.byStatus)}; rows in ${p.scaffold.webApiProbeCoverage.results.filter((r) => r.rows > 0).length}` : "–")),
    ];
    const personas = [...new Set(portals.flatMap((portal) => (portal.scaffold?.runs ?? []).map((run) => run.persona)))];
    for (const persona of personas) {
      const run = (p) => (p.scaffold?.runs ?? []).find((item) => item.persona === persona);
      const group = (p, key) => (run(p)?.components?.[key]?.requests ? `${run(p).components[key].requests}: ${statuses(run(p).components[key].byStatus)}` : "0");
      rows.push(metric(`${persona}: requests / status codes`, (p) => (run(p) ? `${run(p).requests}: ${statuses(run(p).byStatus)}` : "–")));
      rows.push(metric(`${persona}: identity`, (p) => (run(p) ? run(p).note ?? (run(p).identity?.authenticated ? `contact, ${run(p).identity.roles?.length ?? 0} role(s)` : "anonymous") : "–")));
      rows.push(metric(`${persona}: record (?id=) requests`, (p) => (run(p) ? group(p, "recordRequests") : "–")));
      rows.push(metric(`${persona}: basic / advanced form pages`, (p) => (run(p) ? `${group(p, "basicFormPages")} | ${group(p, "advancedFormPages")}` : "–")));
      rows.push(metric(`${persona}: list pages`, (p) => (run(p) ? group(p, "listPages") : "–")));
      rows.push(metric(`${persona}: component diagnostics`, (p) => pairs(run(p)?.components?.componentDiagnostics)));
      rows.push(metric(`${persona}: Liquid error pages / 5xx`, (p) => (run(p) ? `${run(p).liquidErrorPages.length} / ${run(p).failures.length}` : "–")));
    }
    add(table(["", ...ids], rows), "");
  }
  if (matrix.stages.includes("runtime")) {
    add("## Runtime start, state and data binding", "");
    add(table(["", ...ids], [
      stageMetric("runtime")("cold start (fresh state, no parse cache)", (p) => seconds(p.runtime.coldStartMs)),
      stageMetric("runtime")("of which solutions", (p) => seconds(p.runtime.bootstrapTimings?.solutionsMs)),
      stageMetric("runtime")("warm restart (state + cache)", (p) => seconds(p.runtime.warmStartMs)),
      stageMetric("runtime")("state file after start / after run", (p) => `${bytes(p.runtime.stateBytesAfterStart)} / ${bytes(p.runtime.stateBytesAfterRun)}`),
      stageMetric("runtime")("pages / runtime diagnostics", (p) => `${p.runtime.status?.pageCount} / ${p.runtime.status?.diagnostics}`),
      stageMetric("runtime")("admin / home", (p) => `${p.runtime.admin} / ${p.runtime.home}`),
      stageMetric("runtime")("Web API probe, anonymous", (p) => (p.runtime.webApiProbe?.error ? `error: ${p.runtime.webApiProbe.error}` : `${p.runtime.webApiProbe?.tables} tables: ${statuses(p.runtime.webApiProbe?.byStatus)}`)),
      stageMetric("runtime")("Web API probe, all-roles session", (p) => (!p.runtime.webApiProbeAllRoles ? "–" : p.runtime.webApiProbeAllRoles.error ? `error: ${p.runtime.webApiProbeAllRoles.error}` : `${p.runtime.webApiProbeAllRoles.tables} tables: ${statuses(p.runtime.webApiProbeAllRoles.byStatus)}`)),
    ]), "");
  }
  if (matrix.serve) {
    add("## Multi-portal serve (`cli.mjs serve --project`)", "");
    add(`Started cold in ${seconds(matrix.serve.startMs)}${matrix.serve.warmStartMs ? `, warm (same state directory) in ${seconds(matrix.serve.warmStartMs)}` : ""}; stopped ${matrix.serve.stop?.graceful ? "gracefully" : "forcibly"} in ${seconds(matrix.serve.stop?.ms)}.${matrix.serve.error ? ` Error: ${matrix.serve.error}` : ""}`, "");
    add(table(["portal", "url", "site", "pages", "state", "admin", "home"], (matrix.serve.portals ?? []).map((entry) => [entry.id, entry.url, entry.site, entry.pageCount, `${entry.stateFile} (${bytes(entry.stateBytes)})`, entry.admin, entry.home])), "");
    add(table(["check", "result"], matrix.serve.checks.map((item) => [item.name, `${item.passed ? "pass" : "FAIL"}${item.detail ? ` (${item.detail})` : ""}`])), "");
  }
  add("## Findings", "");
  const findings = [];
  for (const portal of portals) {
    for (const row of portal.import?.comparison?.rows ?? [])
      if (row.unexplained !== 0) findings.push(`- **${portal.id}** import: ${row.label} — export ${row.expected}, imported ${row.imported}${row.note ? ` (${row.note})` : ""}`);
    for (const item of portal.import?.comparison?.unrecognizedComponentTypes ?? [])
      findings.push(`- **${portal.id}** import: ${item.records} record(s) of ${item.kind}${item.documented ? ` (${item.documented})` : ""} are not recognised by the importer`);
    for (const item of portal.import?.routes?.collisions ?? [])
      findings.push(`- **${portal.id}** routing: ${item.route} is claimed by ${item.owners.map((owner) => `${owner.kind} '${owner.name}' (${owner.url})`).join(" and ")}${item.resolved ? `; the runtime serves ${item.resolved.served} (${item.resolved.rule}, URL_CLAIMED_TWICE)` : item.distinctRecords > 1 ? "" : " (one record ID exported twice)"}`);
    for (const item of portal.import?.routes?.malformed ?? []) findings.push(`- **${portal.id}** routing: ${item.kind} '${item.name}' has the malformed URL ${item.url}`);
    for (const item of portal.import?.comparison?.notes ?? []) findings.push(`- **${portal.id}** import note: ${item.count} ${item.kind} record(s) ${item.reason}`);
    for (const item of portal.import?.comparison?.limitations ?? [])
      findings.push(`- **${portal.id}** import limitation: ${item.count} ${item.kind} record(s) ${item.reason}`);
    for (const item of portal.liquid?.missingIncludes ?? []) findings.push(`- **${portal.id}** Liquid: include '${item.name}' is ${item.classification.replace(/-/g, " ")}`);
    for (const item of portal.liquid?.syntaxErrors ?? []) findings.push(`- **${portal.id}** Liquid syntax error in ${item.source}: ${item.message}`);
    for (const run of [...(portal.sweep?.runs ?? []), ...(portal.scaffold?.runs ?? [])]) {
      for (const page of run.liquidErrorPages ?? []) findings.push(`- **${portal.id}** ${run.persona}: ${page.url} — ${page.messages.join(" | ")}`);
      for (const failure of run.failures ?? []) findings.push(`- **${portal.id}** ${run.persona}: ${failure.url} — ${failure.failure ?? `HTTP ${failure.status}`}`);
    }
    for (const error of portal.errors) findings.push(`- **${portal.id}** ${error.stage} stage failed: ${error.message}`);
  }
  for (const item of matrix.serve?.checks ?? []) if (!item.passed) findings.push(`- **project** serve: ${item.name} failed${item.detail ? ` (${item.detail})` : ""}`);
  add(findings.length ? findings.join("\n") : "None.", "");
  add("## What this proves", "");
  add(
    "Offline facts about local sources and the local runtime only: what the importer and bootstrap derive, which constructs the Liquid and Web API implementations lack, which pages, forms and lists render, redirect or fail for synthetic personas over empty, scaffolded or preset data, how long runtimes take to start and whether project portals stay isolated. It does not prove parity with an environment, which layer is deployed, real data access, client-side behaviour after page load or behaviour that depends on records the scaffold does not generate.",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------- CLI
export function parseArgs(argv) {
  const options = { portals: [], presets: {}, env: {}, json: false, strict: false, useState: false };
  const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next == null || next.startsWith("--")) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--project") options.project = value();
    else if (arg === "--samples") options.samples = value();
    else if (arg === "--portal") options.portals.push(...list(value()));
    else if (arg === "--sites") options.sites = list(value());
    else if (arg === "--env") {
      const [site, env] = value().split("=");
      if (!env) throw new Error("--env takes SITE=ENV");
      options.env[site] = env;
    } else if (arg === "--repo") options.repo = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--only") options.only = list(value());
    else if (arg === "--skip") options.skip = list(value());
    else if (arg === "--personas") options.personas = list(value());
    else if (arg === "--scaffold-personas") options.scaffoldPersonas = list(value());
    else if (arg === "--scaffold-profile") options.scaffoldProfile = value();
    else if (arg === "--limit") {
      options.limit = Number(value());
      if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error("--limit must be a positive integer");
    } else if (arg === "--path") options.pathPrefix = value();
    else if (arg === "--preset") {
      const [portal, preset] = value().split("=");
      if (!preset) throw new Error("--preset takes PORTAL=NAME");
      options.presets[portal] = preset;
    } else if (arg === "--use-state") options.useState = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if ([options.project, options.sites, options.samples].filter(Boolean).length > 1) throw new Error("Use one of --project, --sites or --samples.");
  if (options.portals.length && !options.project && !options.samples) throw new Error("--portal selects portals of --project or samples of --samples.");
  return options;
}

const USAGE = `Usage: node mirage/portal-matrix.mjs (--project FILE [--portal ID]... | --sites a,b [--env SITE=ENV] [--repo DIR] | --samples DIR [--portal ID]...)
       [--out DIR] [--json] [--only|--skip ${STAGES.join(",")}] [--personas ${PERSONAS.join(",")}]
       [--scaffold-personas ${SCAFFOLD_PERSONAS.join(",")}] [--scaffold-profile smoke|dev]
       [--limit N] [--path PREFIX] [--preset PORTAL=NAME] [--use-state] [--strict]`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || (!options.project && !options.sites && !options.samples)) {
    console.log(USAGE);
    return options.help ? 0 : 2;
  }
  options.out ??= path.join(TOOLKIT_ROOT, ".paqvilo", "portal-matrix", new Date().toISOString().replace(/[:.]/g, "-"));
  const matrix = await portalMatrix(options);
  console.log(options.json ? JSON.stringify(matrix, null, 2) : `${formatMatrix(matrix)}\nWritten: ${path.join(path.resolve(options.out), "matrix.md")}`);
  return options.strict && matrix.problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.stack ?? String(error));
      process.exitCode = 2;
    },
  );
