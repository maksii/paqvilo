#!/usr/bin/env node
/**
 * Read-only bootstrap quality report: what the Mirage derives from the portal
 * export and the selected solution layers (tables, columns, relationships, grants,
 * routing records, environment variables, Web API settings and diagnostics).
 * It reads local sources only and writes nothing except an optional parse cache
 * under .paqvilo and an optional --output file.
 *
 *   node mirage/bootstrap-report.mjs --site SITE [--env ENV] [--json] [--output FILE]
 *   node mirage/bootstrap-report.mjs --source PATH [--solution-root PATH ...]
 *   node mirage/bootstrap-report.mjs --project mirage.project.yml [--portal ID]
 *   Options: --deployment-profile NAME, --data-model standard|enhanced, --no-cache, --all-fields, --lcid N
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { importPortal, portalField as field } from "./lib/importer.mjs";
import { initialState } from "./lib/bootstrap.mjs";
import { scanSolutionSources, buildSolutionSchema, tableFields } from "./lib/solution-schema.mjs";
import { SolutionFileCache } from "./lib/solution-cache.mjs";
import { importSolutionMetadata } from "./lib/solution-metadata.mjs";
import { importSolutionData, applySolutionData } from "./lib/solution-data.mjs";
import { buildPermissionModel, portalWebRoles } from "./lib/permissions.mjs";
import { resolveSolutionRoots } from "./lib/solution-roots.mjs";
import { loadProjectConfig, projectOrigin, observedConfig } from "./lib/project-config.mjs";
import { STANDARD_LOOKUP_TARGETS } from "./lib/solution-standard.mjs";
import { applyObserved, signInPath } from "./lib/redirects.mjs";
import { assertPortalSource } from "./lib/source-dialect.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const countBy = (items, key) =>
  items.reduce((counts, item) => {
    const value = typeof key === "function" ? key(item) : item[key];
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
const sortObject = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const id = (value) => String(typeof value === "object" && value ? value.id ?? "" : value ?? "").replace(/[{}]/g, "").toLowerCase();
// Non-table Power Pages endpoints that share the /_api prefix.
const NON_TABLE_API = new Set(["cloudflow"]);

export async function resolveReportInputs(args) {
  if (args.project) {
    const project = await loadProjectConfig(args.project);
    const portal = project.portals.find((item) => item.id === (args.portal ?? project.defaultPortal));
    if (!portal) throw new Error(`Portal '${args.portal}' is not configured in ${project.configFile}`);
    return {
      label: `${path.basename(project.configFile)}#${portal.id}`,
      sourceDir: portal.sourceDir,
      solutionRoots: portal.solutionRoots,
      order: project.solutionOrder,
      deploymentProfile: args["deployment-profile"] ?? portal.deploymentProfile ?? undefined,
      dataModel: args["data-model"] ?? portal.dataModel ?? undefined,
      origin: projectOrigin(project, portal),
      observed: portal.observed,
      environmentVariables: project.environmentVariables,
      lcid: project.lcid,
      cacheFile: path.join(project.stateDirectory ?? path.join(ROOT, ".paqvilo/simulator/projects", project.stateNamespace), portal.id, "cache", "solution-sources.json"),
    };
  }
  let sourceDir = args.source,
    origin = null,
    label = args.source ? path.basename(args.source) : null,
    siteMirage = null;
  if (!sourceDir) {
    const { loadConfig } = await import("../lense/config.mjs");
    const cfg = await loadConfig({ site: args.site, env: args.env, ...(args.repo ? { repo: args.repo } : {}), ...(args.config ? { config: args.config } : {}) });
    sourceDir = cfg.sourceDir;
    origin = cfg.origin ?? null;
    label = `${args.site ?? "default"}/${args.env ?? "default"}`;
    siteMirage = cfg.mirageConfig ?? null;
  } else if (args.site) {
    // --source with a catalogued --site: the site's mirage settings still apply.
    const { loadConfig } = await import("../lense/config.mjs");
    siteMirage = (await loadConfig({ site: args.site, env: args.env, ...(args.repo ? { repo: args.repo } : {}), ...(args.config ? { config: args.config } : {}) })).mirageConfig ?? null;
  }
  // The same cache as `cli.mjs serve` for this site (next to its state; "default" without --site).
  const cacheFile = path.join(ROOT, ".paqvilo/simulator", args.site ?? "default", "cache", "solution-sources.json");
  // The same resolution as `cli.mjs serve`: --solution-root, else the catalogue site's
  // mirage solutionRoots, else discovery; derived order unless explicitly requested.
  const resolved = await resolveSolutionRoots({
    sourceDir,
    explicitRoots: args["solution-root"],
    explicitOrder: args["solution-order"],
    catalogue: siteMirage,
    cacheFile: args["no-cache"] ? undefined : cacheFile,
  });
  return {
    label,
    sourceDir,
    solutionRoots: resolved.roots,
    order: resolved.order,
    rootSource: resolved.source,
    observed: siteMirage?.observed ?? null,
    discovered: resolved.source === "discovered",
    deploymentProfile: args["deployment-profile"],
    // The data model of a YAML source: --data-model, else the catalogue site's (lib/importer.mjs).
    dataModel: args["data-model"] ?? siteMirage?.dataModel ?? undefined,
    origin,
    environmentVariables: {},
    lcid: Number(args.lcid ?? 1033),
    cacheFile,
  };
}

/** Collect the bootstrap report for one portal and its solution layers. */
export async function bootstrapReport(inputs, { noCache = false, allFields = false } = {}) {
  const timings = {};
  let started = performance.now();
  // Duplicate-copy commit lookups are cached beside the solution cache.
  const portalCache = await SolutionFileCache.open(noCache || !inputs.cacheFile ? null : path.join(path.dirname(inputs.cacheFile), "portal-sources.json"));
  // A source with zero recognised pages is not a portal: fail loudly, naming its layout.
  const portal = assertPortalSource(applyObserved(await importPortal(inputs.sourceDir, { lcid: inputs.lcid, cache: portalCache, ...(inputs.deploymentProfile ? { deploymentProfile: inputs.deploymentProfile } : {}), ...(inputs.dataModel ? { dataModel: inputs.dataModel } : {}) }), observedConfig(inputs.observed)));
  await portalCache.save();
  timings.portalMs = Math.round(performance.now() - started);
  started = performance.now();
  const cache = await SolutionFileCache.open(noCache ? null : inputs.cacheFile);
  const scan = await scanSolutionSources(inputs.solutionRoots, { cache, order: inputs.order });
  const schema = buildSolutionSchema(scan, { lcid: inputs.lcid });
  const metadata = await importSolutionMetadata(inputs.solutionRoots, { portal, scan, schema, lcid: inputs.lcid });
  const data = await importSolutionData(inputs.solutionRoots, { scan, schema, lcid: inputs.lcid });
  await cache.save();
  timings.solutionsMs = Math.round(performance.now() - started);
  timings.cache = { ...cache.stats, file: noCache ? null : inputs.cacheFile };
  started = performance.now();
  const webApiTables = Object.entries(portal.settings)
    .filter(([name, value]) => /^Webapi\/[^/]+\/enabled$/i.test(name) && String(value).toLowerCase() === "true")
    .map(([name]) => name.split("/")[1].toLowerCase());
  const state = applySolutionData(initialState(portal, { metadata: data }), data, {
    webApiTables,
    environmentVariables: inputs.environmentVariables,
  });
  const configured = buildPermissionModel(portal, state, { relationships: data.relationships, source: "configured" });
  const exported = buildPermissionModel(portal, state, { relationships: data.relationships, source: "exported" });
  timings.modelMs = Math.round(performance.now() - started);

  // Why the portal needs each table.
  const reasons = new Map();
  const need = (table, reason) => {
    if (!table) return;
    const name = String(table).toLowerCase();
    if (!reasons.has(name)) reasons.set(name, new Set());
    reasons.get(name).add(reason);
  };
  for (const record of portal.records.filter((r) => r.kind === "tablepermission" && Number(field(r, "statecode", 0)) !== 1))
    need(field(record, "entitylogicalname"), "permission");
  for (const name of webApiTables) need(name, "webapi");
  for (const item of [...portal.forms, ...portal.lists]) need(item.entityName, portal.forms.includes(item) ? "form" : "list");
  for (const step of portal.records.filter((r) => r.kind === "advancedformstep"))
    need(field(step, "targetentitylogicalname", field(step, "entityname")), "advanced-form");
  for (const template of new Set(Object.values(portal.templates)))
    for (const match of template.source.matchAll(/<(?:entity|link-entity)\b[^>]*\bname\s*=\s*["']([\w]+)["']/gi)) need(match[1], "fetchxml");
  const tables = Object.values(schema.tables)
    .sort((a, b) => (a.logicalName < b.logicalName ? -1 : 1))
    .map((table) => ({
      logicalName: table.logicalName,
      entitySet: table.entitySet,
      entitySetSource: table.entitySetSource,
      primaryIdAttribute: table.primaryIdAttribute,
      primaryIdSource: table.primaryIdSource,
      primaryNameAttribute: table.primaryNameAttribute ?? null,
      primaryNameSource: table.primaryNameSource ?? null,
      schemaComplete: table.schemaComplete,
      completeness: table.completeness,
      intersect: Boolean(table.isIntersect),
      attributes: Object.keys(table.attributes).length,
      layers: table.layers.map((layer) => ({ solution: layer.solution, file: layer.file, fullDefinition: layer.fullDefinition, attributes: layer.attributes })),
      origin: table.origin,
      portalUse: [...(reasons.get(table.logicalName) ?? [])].sort(),
      ...(allFields || reasons.has(table.logicalName) ? { fields: tableFields(schema, table.logicalName, { lcid: inputs.lcid }) } : {}),
    }));
  const missingTables = [...reasons.keys()]
    .filter((name) => !schema.tables[name])
    .sort()
    .map((name) => ({ logicalName: name, portalUse: [...reasons.get(name)].sort(), mapping: state.mappings[name] ?? null }));
  const relationships = Object.values(data.relationships).sort((a, b) => (a.schemaName.toLowerCase() < b.schemaName.toLowerCase() ? -1 : 1));
  // Lookup columns of portal tables and whether a relationship resolves their targets.
  const lookups = [];
  for (const name of reasons.keys()) {
    const table = schema.tables[name];
    if (!table) continue;
    for (const attribute of Object.values(table.attributes))
      if (["lookup", "customer", "owner"].includes(attribute.type)) {
        const related = schema.targets[`${name}/${attribute.name}`];
        const standard = STANDARD_LOOKUP_TARGETS[attribute.name];
        lookups.push({
          table: name,
          column: attribute.name,
          type: attribute.type,
          targets: related ?? standard ?? [],
          targetsSource: related ? "relationship" : standard ? "dataverse-reference" : null,
        });
      }
  }
  // /_api/<entity set> references in the portal source (test oracle for entity sets).
  const sources = [
    ...portal.webFiles.filter((file) => /\.(?:js|html?|txt)$/i.test(file.name) || !path.extname(file.name)).map((file) => file.file),
  ];
  const texts = [
    ...Object.values(portal.templates).map((t) => t.source),
    ...Object.values(portal.snippets),
    ...portal.pages.flatMap((p) => [p.html, p.js]),
    ...portal.forms.map((f) => f.js),
    ...portal.lists.map((l) => l.js),
  ];
  for (const file of new Set(sources))
    try {
      texts.push(await fs.readFile(file, "utf8"));
    } catch {}
  const apiNames = new Map();
  for (const text of texts)
    for (const match of String(text ?? "").matchAll(/\/_api\/([A-Za-z_][A-Za-z0-9_]*)(\/?)/g)) {
      const entry = apiNames.get(match[1]) ?? { name: match[1], references: 0, continues: false };
      entry.references++;
      if (match[2] === "/") entry.continues = true;
      apiNames.set(match[1], entry);
    }
  const bySet = new Map(Object.entries(state.mappings).map(([name, mapping]) => [mapping.entitySet, { name, mapping }]));
  const apiOracle = [...apiNames.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((entry) => {
    const hit = bySet.get(entry.name);
    return {
      entitySet: entry.name,
      references: entry.references,
      table: hit?.name ?? null,
      entitySetSource: hit?.mapping.entitySetSource ?? null,
      status: hit ? "resolved" : NON_TABLE_API.has(entry.name.toLowerCase()) || entry.continues ? "non-table-endpoint" : "unresolved",
    };
  });
  const permissionSummary = (model) => {
    const disabled = model.permissions.filter((rule) => rule.enabled === false);
    return {
      total: model.permissions.length,
      enabled: model.permissions.length - disabled.length,
      byScope: sortObject(
        model.permissions.reduce((acc, rule) => {
          acc[rule.scope] ??= { total: 0, enabled: 0 };
          acc[rule.scope].total++;
          if (rule.enabled !== false) acc[rule.scope].enabled++;
          return acc;
        }, {}),
      ),
      disabledByCode: sortObject(countBy(disabled, (rule) => rule.disabledCode ?? "PERMISSION_DISABLED")),
      disabled: disabled.map((rule) => ({
        id: rule.id,
        name: rule.name,
        entity: rule.entity,
        scope: rule.scope,
        relationshipName: rule.relationshipName ?? null,
        code: rule.disabledCode ?? null,
        reason: rule.disabledReason,
      })),
      diagnostics: sortObject(countBy(model.diagnostics, "code")),
    };
  };
  const roles = portalWebRoles(portal);
  const roleName = new Map(roles.map((role) => [role.id, role.name]));
  const pageUrl = new Map(portal.pages.map((page) => [page.id, page.url]));
  const pageRules = portal.records
    .filter((r) => r.kind === "webpageaccesscontrolrule" && Number(field(r, "statecode", 0)) !== 1)
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      page: pageUrl.get(id(field(rule, "webpageid"))) ?? id(field(rule, "webpageid")),
      right: Number(field(rule, "right")) === 1 ? "grant-change" : Number(field(rule, "right")) === 2 ? "restrict-read" : field(rule, "right"),
      scope: Number(field(rule, "scope", 1)) === 2 ? "exclude-direct-child-web-files" : "all-content",
      roles: [].concat(field(rule, "webpageaccesscontrolrule_webrole", []) ?? []).map((role) => roleName.get(id(role)) ?? id(role)),
    }));
  const webApi = {};
  for (const [name, value] of Object.entries(portal.settings)) {
    const match = /^Webapi\/([^/]+)\/(.+)$/i.exec(name);
    if (!match) continue;
    const entry = (webApi[match[1].toLowerCase()] ??= { table: match[1].toLowerCase() });
    entry[match[2]] = value;
  }
  const webApiSettings = Object.values(webApi)
    .sort((a, b) => (a.table < b.table ? -1 : 1))
    .map((entry) => ({
      ...entry,
      entitySet: state.mappings[entry.table]?.entitySet ?? null,
      schemaComplete: state.mappings[entry.table]?.schemaComplete ?? false,
      fieldMetadata: Object.keys(state.mappings[entry.table]?.fieldMetadata ?? {}).length,
    }));
  const siteSettings = sortObject(
    Object.fromEntries(Object.entries(portal.settings).filter(([name]) => /^(?:Webapi\/error|Site\/|HTTP\/|Authentication\/Registration\/LoginButtonAuthenticationType|MultiLanguage\/)/i.test(name))),
  );
  const diagnostics = [
    ...portal.diagnostics.map((d) => ({ ...d, origin: "portal" })),
    ...schema.diagnostics.map((d) => ({ ...d, origin: "solution" })),
    ...metadata.diagnostics.filter((d) => !schema.diagnostics.includes(d)).map((d) => ({ ...d, origin: "metadata" })),
    ...(state.simulator.importDiagnostics ?? []).map((d) => ({ ...d, origin: "bootstrap" })),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    inputs: {
      label: inputs.label,
      sourceDir: portal.sourceDir,
      format: portal.format,
      layout: portal.source?.dialect ?? null,
      dataModel: portal.dataModel,
      dataModelSource: portal.dataModelSource,
      deploymentProfile: inputs.deploymentProfile ?? null,
      origin: inputs.origin ?? null,
      solutionRoots: inputs.solutionRoots,
      rootOrder: inputs.order ?? "derived",
      rootSource: inputs.rootSource ?? (inputs.discovered ? "discovered" : "project"),
      layers: schema.layers,
    },
    summary: {
      pages: portal.pages.length,
      templates: new Set(Object.values(portal.templates)).size,
      snippets: Object.keys(portal.snippets).length,
      webFiles: portal.webFiles.length,
      forms: portal.forms.length,
      lists: portal.lists.length,
      tables: tables.length,
      completeTables: tables.filter((table) => table.schemaComplete).length,
      entitySetSources: sortObject(countBy(tables, "entitySetSource")),
      primaryIdSources: sortObject(countBy(tables, "primaryIdSource")),
      portalTables: reasons.size,
      portalTablesWithoutDefinition: missingTables.length,
      relationships: relationships.length,
      relationshipTypes: sortObject(countBy(relationships, "type")),
      // Delete behaviour of one-to-many relationships as the Solutions state it (cascade.delete);
      // "unstated" for documented standard fallbacks without a source definition.
      cascadeDelete: sortObject(countBy(relationships.filter((rel) => rel.type === "one-to-many"), (rel) => rel.cascade?.delete ?? "unstated")),
      standardRelationships: data.stats.standardRelationships,
      lookups: { total: lookups.length, resolved: lookups.filter((l) => l.targets.length).length },
      apiOracle: sortObject(countBy(apiOracle, "status")),
      formsResolved: `${metadata.counts.forms}/${metadata.counts.formsTotal}`,
      listsResolved: `${metadata.counts.lists}/${metadata.counts.listsTotal}`,
      advancedFormsResolved: `${metadata.counts.advancedForms}/${(portal.advancedForms ?? []).length}`,
      permissionsConfigured: `${configured.permissions.filter((p) => p.enabled !== false).length}/${configured.permissions.length}`,
      permissionsExported: `${exported.permissions.filter((p) => p.enabled !== false).length}/${exported.permissions.length}`,
      webRoles: roles.length,
      pageRules: pageRules.length,
      redirects: portal.redirects.length,
      urlHistory: portal.urlHistory.length,
      shortcuts: portal.shortcuts.length,
      environmentVariables: data.environmentVariables.length,
      environmentVariablesWithValues: data.environmentVariables.filter((v) => v.value !== undefined).length,
      webApiTables: webApiTables.length,
      diagnostics: sortObject(countBy(diagnostics, "code")),
      timings,
    },
    tables,
    portalTablesWithoutDefinition: missingTables,
    relationships,
    lookups,
    apiOracle,
    permissions: { configured: permissionSummary(configured), exported: permissionSummary(exported) },
    webRoles: roles,
    pageRules,
    publishingStates: portal.publishingStates,
    websiteAccess: portal.websiteAccess.map((access) => ({ ...access, roles: access.roleIds.map((role) => roleName.get(role) ?? role) })),
    websiteLanguages: portal.websiteLanguages,
    // The sign-in path in effect: site setting, observed configuration or documented default.
    signInPath: signInPath(portal),
    redirects: portal.redirects.map(({ file, ...redirect }) => ({ ...redirect, target: redirect.redirectUrl ?? pageUrl.get(redirect.webPageId) ?? redirect.siteMarkerId })),
    urlHistory: portal.urlHistory.map((row) => ({ ...row, target: pageUrl.get(row.webPageId) ?? null })),
    shortcuts: portal.shortcuts.map(({ metadata, ...shortcut }) => shortcut),
    environmentVariables: data.environmentVariables,
    webApiSettings,
    siteSettings,
    diagnostics,
  };
  return report;
}

export function formatReport(report) {
  const s = report.summary;
  const lines = [];
  const add = (...text) => lines.push(text.join(""));
  const pairs = (object) => Object.entries(object).map(([k, v]) => `${k} ${v}`).join(", ");
  add(`Bootstrap report: ${report.inputs.label} (${report.inputs.format}) ${report.inputs.sourceDir}`);
  add(`Solution layers (${report.inputs.layers.length}, ${report.inputs.rootOrder}): `, report.inputs.layers.map((l) => l.solution).join(" > ") || "none");
  add(`Portal: ${s.pages} pages, ${s.templates} templates, ${s.snippets} snippets, ${s.webFiles} web files, ${s.forms} basic forms, ${s.lists} lists`);
  add(`Forms resolved ${s.formsResolved}; lists ${s.listsResolved}; advanced forms ${s.advancedFormsResolved}`);
  add(`Tables: ${s.tables} (complete ${s.completeTables}); entity set: ${pairs(s.entitySetSources)}; primary id: ${pairs(s.primaryIdSources)}`);
  add(`Portal tables: ${s.portalTables}; without a solution definition: ${s.portalTablesWithoutDefinition}`, s.portalTablesWithoutDefinition ? ` (${report.portalTablesWithoutDefinition.map((t) => `${t.logicalName}[${t.portalUse.join("/")}]`).join(", ")})` : "");
  add(`/_api entity-set oracle: ${pairs(s.apiOracle)}`);
  const unresolvedApi = report.apiOracle.filter((entry) => entry.status === "unresolved");
  if (unresolvedApi.length) add(`  unresolved: ${unresolvedApi.map((entry) => entry.entitySet).join(", ")}`);
  add(`Relationships: ${s.relationships} (${pairs(s.relationshipTypes)}; documented standard ${s.standardRelationships}); portal lookups resolved ${s.lookups.resolved}/${s.lookups.total}`);
  if (Object.keys(s.cascadeDelete ?? {}).length) add(`  one-to-many delete behaviour: ${pairs(s.cascadeDelete)}`);
  for (const [mode, summary] of Object.entries(report.permissions)) {
    add(`Permissions (${mode}): ${summary.enabled}/${summary.total} enabled; by scope: ${Object.entries(summary.byScope).map(([scope, c]) => `${scope} ${c.enabled}/${c.total}`).join(", ")}`);
    if (Object.keys(summary.disabledByCode).length) add(`  disabled: ${pairs(summary.disabledByCode)}`);
  }
  add(`Web roles ${s.webRoles}; page rules ${s.pageRules}; publishing states: ${report.publishingStates.map((p) => `${p.name}${p.isVisible ? " (visible)" : ""}${p.active ? "" : " [inactive record]"}`).join(", ") || "none"}`);
  add(`Website access: ${report.websiteAccess.map((a) => `${a.name}${a.previewUnpublishedEntities ? " (preview)" : ""} [${a.roles.join(", ")}]`).join("; ") || "none"}`);
  add(`Website languages: ${report.websiteLanguages.map((l) => `${l.name}${l.isDefault ? " (default)" : ""}${l.published ? "" : " [unpublished]"}`).join(", ") || "none"}`);
  add(`Redirects ${s.redirects}; URL history ${s.urlHistory}; shortcuts ${s.shortcuts}`);
  add(`Environment variables: ${s.environmentVariables} (${s.environmentVariablesWithValues} with exported values)`);
  add(`Web API tables enabled: ${s.webApiTables}; with complete column metadata: ${report.webApiSettings.filter((w) => w.schemaComplete).length}`);
  add(`Diagnostics: ${pairs(s.diagnostics) || "none"}`);
  add(`Timings: portal ${s.timings.portalMs} ms, solutions ${s.timings.solutionsMs} ms (cache hits ${s.timings.cache.hits}, misses ${s.timings.cache.misses}), model ${s.timings.modelMs} ms`);
  return lines.join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { values: args } = parseArgs({
      options: {
        site: { type: "string" },
        env: { type: "string" },
        repo: { type: "string" },
        config: { type: "string" },
        source: { type: "string" },
        "solution-root": { type: "string", multiple: true },
        "solution-order": { type: "string" },
        project: { type: "string" },
        portal: { type: "string" },
        "deployment-profile": { type: "string" },
        "data-model": { type: "string" },
        lcid: { type: "string" },
        json: { type: "boolean" },
        output: { type: "string" },
        "no-cache": { type: "boolean" },
        "all-fields": { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (args.help) {
      console.log("node mirage/bootstrap-report.mjs (--site S --env E [--config FILE] [--repo DIR] | --source PATH | --project FILE [--portal ID]) [--solution-root PATH ...] [--solution-order derived|explicit] [--json] [--output FILE] [--no-cache] [--all-fields]");
      process.exit(0);
    }
    if (args.project && (args.source || args["solution-root"]?.length))
      throw new Error("--project supplies the portal source and solution roots.");
    const inputs = await resolveReportInputs(args);
    const report = await bootstrapReport(inputs, { noCache: args["no-cache"], allFields: args["all-fields"] });
    if (args.output) {
      const output = path.resolve(args.output);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
