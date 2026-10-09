#!/usr/bin/env node
/**
 * Liquid inventory for an exported Power Pages site (PAC standard YAML or enhanced data model).
 *
 *   node mirage/liquid-inventory.mjs --portal <dir> [--json] [--out FILE]
 *        [--include-inactive] [--sources] [--strict]
 *
 * Every source the Mirage renders through Liquid is scanned: web templates, page copy,
 * page custom JavaScript/CSS, content snippets and basic form, list and advanced form step
 * custom JavaScript (all languages). Tags, filters, objects and first-level object properties
 * are counted and checked against the Mirage renderer itself: registered tags and filters,
 * the global objects of a page context, include/extends resolution and a nil probe of the
 * documented properties of closed objects (request, sitemap, forloop, tablerowloop and the
 * drop properties of page, website and user).
 *
 * `unsupported` lists only constructs Power Pages provides that the renderer lacks. Syntax
 * errors (which Power Pages reports the same way), unresolved includes and variables that are
 * never defined (nil on both platforms) are reported separately. Read-only: nothing is written
 * unless --out is given.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importPortal } from "./lib/importer.mjs";
import { createPortalRenderer } from "./lib/liquid.mjs";
import { Block, Variable } from "./lib/liquid-engine.mjs";

const WORD = "\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}";
const TAG_NAME = new RegExp(`^\\s*([${WORD}]+)\\s*([\\s\\S]*)$`, "u");
const FRAGMENTS = /"[^"]*"|'[^']*'|(?:[^\s,|:'"]|"[^"]*"|'[^']*')+|[|,:]/gu;
const PATH_PARTS = new RegExp(`\\[[^\\]]+\\]|[${WORD}-]+\\??`, "gu");
const IDENTIFIER_START = /^[\p{L}_]/u;
const RANGE = /^\((\S+)\.\.(\S+)\)$/;
const QUOTED = /^(["'])([\s\S]*)\1$/;
const LITERALS = new Set(["true", "false", "nil", "null", "empty", "blank"]);
/** Condition operators (DotLiquid Condition.Operators, case-insensitive) and tag keywords. */
const KEYWORDS = new Set(["and", "or", "contains", "startswith", "endswith", "haskey", "hasvalue", "in", "with", "for", "reversed", "by"]);
const INTERMEDIATE_TAGS = new Set(["else", "elsif", "elseif", "when"]);

/** Global objects listed by Microsoft Learn (Power Pages "Available Liquid objects"). */
export const DOCUMENTED_GLOBALS = [
  "ads",
  "blogs",
  "entities",
  "events",
  "forums",
  "knowledge",
  "now",
  "page",
  "params",
  "polls",
  "request",
  "settings",
  "sitemap",
  "sitemarkers",
  "snippets",
  "user",
  "weblinks",
  "website",
];
/** Tags documented by Microsoft Learn (conditional, iteration, variable, template and Dataverse tags). */
export const DOCUMENTED_TAGS = [
  "assign",
  "block",
  "capture",
  "case",
  "chart",
  "codecomponent",
  "comment",
  "cycle",
  "editable",
  "entityform",
  "entitylist",
  "entityview",
  "extends",
  "fetchxml",
  "for",
  "if",
  "include",
  "log",
  "powerbi",
  "raw",
  "searchindex",
  "substitution",
  "tablerow",
  "unless",
  "webform",
];
/** Filters documented by Microsoft Learn ("Available Liquid filters"). */
export const DOCUMENTED_FILTERS = [
  "add_query", "append", "base", "batch", "boolean", "capitalize", "ceil", "concat", "current_sort", "date",
  "date_add_days", "date_add_hours", "date_add_minutes", "date_add_months", "date_add_seconds", "date_add_years",
  "date_to_iso8601", "date_to_rfc822", "decimal", "default", "divided_by", "downcase", "escape", "except",
  "file_size", "first", "floor", "group_by", "h", "has_role", "host", "html_safe_escape", "integer", "join",
  "last", "liquid", "metafilters", "minus", "modulo", "newline_to_br", "order_by", "path", "path_and_query",
  "plus", "port", "prepend", "random", "remove", "remove_first", "remove_query", "replace", "replace_first",
  "reverse_sort", "round", "scheme", "select", "shuffle", "size", "skip", "split", "string", "strip_html",
  "strip_newlines", "take", "text_to_html", "then_by", "times", "truncate", "truncate_words", "upcase",
  "url_escape", "where", "xml_escape",
];
/** Objects that exist only inside the tag that provides them. */
const CONTEXTUAL_OBJECTS = {
  forloop: "for",
  tablerowloop: "tablerow",
  entitylist: "entitylist",
  entityview: "entityview",
  searchindex: "searchindex",
};
/**
 * Documented properties of objects whose members are a closed set, plus the drop properties
 * of the entity objects (their remaining members are Dataverse attributes).
 */
export const DOCUMENTED_PROPERTIES = {
  request: ["params", "path", "path_and_query", "query", "url"],
  sitemap: ["current", "root"],
  forloop: ["first", "index", "index0", "last", "length", "rindex", "rindex0"],
  tablerowloop: ["col", "col0", "col_first", "col_last", "first", "index", "index0", "last", "length", "rindex", "rindex0"],
  page: ["breadcrumbs", "children", "id", "parent", "title", "url", "logical_name"],
  website: ["id", "logical_name", "sign_in_url", "sign_in_url_substitution", "sign_out_url", "sign_out_url_substitution"],
  user: ["id", "logical_name", "roles"],
};
const CLOSED_OBJECTS = new Set(["request", "sitemap", "forloop", "tablerowloop"]);
const ENTITY_OBJECTS = new Set(["page", "website", "user"]);
const DICTIONARY_OBJECTS = new Set(["settings", "snippets", "sitemarkers", "weblinks", "entities", "params", "resx"]);

/** Record kinds and the fields the Mirage renders through Liquid. */
const SOURCE_FIELDS = {
  webtemplate: [["web-template", "source.html", "source"]],
  webpage: [
    ["page-copy", "copy.html", "copy"],
    ["page-javascript", "custom_javascript.js", "customjavascript"],
    ["page-css", "custom_css.css", "customcss"],
  ],
  contentsnippet: [["content-snippet", "value.html", "value"]],
  basicform: [["basic-form-javascript", "custom_javascript.js", "customjavascript"]],
  list: [["list-javascript", "custom_javascript.js", "customjavascript"]],
  advancedformstep: [["advanced-form-step-javascript", "custom_javascript.js", "customjavascript"]],
};

const fieldOf = (record, name) => record[`adx_${name}`] ?? record[`mspp_${name}`] ?? record[name];

/** Localized enhanced values are JSON arrays of { LCID, Value }; every language is scanned. */
function localizedValues(value) {
  if (typeof value !== "string") return value == null ? [] : [{ lcid: null, text: String(value) }];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.some((entry) => entry && "LCID" in entry))
      return parsed.map((entry) => ({ lcid: Number(entry.LCID), text: String(entry?.Value ?? "") }));
  } catch {}
  return [{ lcid: null, text: value }];
}

/** Collect Liquid-bearing sources from imported portal records. */
export async function collectSources(portal, { includeInactive = false } = {}) {
  const sources = [];
  let inactive = 0;
  for (const record of portal.records ?? []) {
    const fields = SOURCE_FIELDS[record.kind];
    if (!fields) continue;
    const isActive = Number(fieldOf(record, "statecode") ?? record.statecode ?? 0) !== 1;
    if (!isActive) inactive++;
    if (!isActive && !includeInactive) continue;
    for (const [kind, suffix, fieldName] of fields) {
      let values = [];
      // YAML layouts (PAC YAML and .powerpages-site) keep text fields in side files.
      if (record._file && /\.ya?ml$/i.test(record._file)) {
        const file = `${record._file.replace(/\.ya?ml$/i, "")}.${suffix}`;
        try {
          values = [{ lcid: null, text: await fs.readFile(file, "utf8"), file }];
        } catch {}
      }
      if (!values.length) values = localizedValues(fieldOf(record, fieldName)).map((entry) => ({ ...entry, file: record._file }));
      for (const { lcid, text, file } of values) {
        if (!text || (!text.includes("{{") && !text.includes("{%"))) continue;
        sources.push({
          kind,
          name: record.name ?? record.id,
          id: record.id,
          lcid,
          active: isActive,
          file: file ? path.relative(portal.sourceDir, file) : null,
          text,
        });
      }
    }
  }
  return { sources, inactive };
}

/** Position-aware token scan mirroring the DotLiquid tokenizer's quote handling. */
export function scanTokens(source, rawTags) {
  const text = String(source ?? "");
  const tokens = [];
  const start = /\{\{|\{%/g;
  let position = 0;
  for (;;) {
    start.lastIndex = position;
    const match = start.exec(text);
    if (!match) break;
    const isTag = match[0] === "{%";
    let i = match.index + 2;
    let closed = false;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === "'" || ch === '"') {
        const end = text.indexOf(ch, i);
        if (end < 0) {
          i = text.length;
          break;
        }
        i = end + 1;
      } else if ((isTag ? ch === "%" : ch === "}") && text[i] === "}") {
        i++;
        closed = true;
        break;
      }
    }
    const markup = text
      .slice(match.index + 2, closed ? i - 2 : i)
      .replace(/^-/, "")
      .replace(/-$/, "");
    tokens.push({ type: isTag ? "tag" : "output", offset: match.index, markup, closed });
    position = i;
    if (isTag && closed) {
      const name = TAG_NAME.exec(markup)?.[1];
      if (name && rawTags.has(name)) {
        const end = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, "g");
        end.lastIndex = position;
        const found = end.exec(text);
        if (!found) break;
        position = found.index;
      }
    }
  }
  return tokens;
}

/** Variable paths referenced by an expression (filter names and named-argument keys excluded). */
export function expressionPaths(expression) {
  const fragments = String(expression ?? "").match(FRAGMENTS) ?? [];
  const paths = [];
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    if (fragment === "|" || fragment === "," || fragment === ":") continue;
    if (fragments[i - 1] === "|") continue; // filter name
    if (fragments[i + 1] === ":") continue; // named argument key
    paths.push(...fragmentPaths(fragment));
  }
  return paths;
}

function fragmentPaths(fragment) {
  const range = RANGE.exec(fragment);
  if (range) return [...fragmentPaths(range[1]), ...fragmentPaths(range[2])];
  if (QUOTED.test(fragment) || /^[+-]?\d/.test(fragment)) return [];
  if (!IDENTIFIER_START.test(fragment) && !fragment.startsWith("[")) return [];
  const parts = fragment.match(PATH_PARTS) ?? [];
  if (!parts.length) return [];
  const nested = [];
  const keys = parts.map((part) => {
    if (!part.startsWith("[")) return part.replace(/\?$/, "");
    const inner = part.slice(1, -1).trim();
    const quoted = QUOTED.exec(inner);
    if (quoted) return quoted[2];
    if (/^[+-]?\d+$/.test(inner)) return Number(inner);
    nested.push(...expressionPaths(inner));
    return null;
  });
  const root = keys[0];
  if (typeof root !== "string" || LITERALS.has(root.toLowerCase()) || KEYWORDS.has(root.toLowerCase())) return nested;
  // Variable names are case-insensitive (Adxstudio InvariantCultureNamingConvention: OrdinalIgnoreCase).
  return [{ root: root.toLowerCase(), member: typeof keys[1] === "string" ? keys[1] : null, dynamicMember: keys.length > 1 && keys[1] === null }, ...nested];
}

/** Attribute names (`name: value`) of a tag's markup. */
function attributeNames(markup) {
  const fragments = String(markup ?? "").match(FRAGMENTS) ?? [];
  return fragments.filter((fragment, i) => fragments[i + 1] === ":" && IDENTIFIER_START.test(fragment));
}

/** Analyse one tag: definitions it creates, paths it reads, include targets and filters. */
function analyseTag(name, markup) {
  const result = { definitions: [], paths: [], include: null, filters: [] };
  const fromVariable = (expression) => {
    const variable = new Variable(expression);
    if (variable.name != null) result.paths.push(...fragmentPaths(variable.name));
    for (const filter of variable.filters) {
      result.filters.push(filter.name);
      for (const arg of filter.args) result.paths.push(...fragmentPaths(arg));
    }
  };
  switch (name) {
    case "assign": {
      const match = /^\s*([^=\s]+)\s*=\s*([\s\S]*)$/.exec(markup);
      if (match) {
        result.definitions.push(match[1]);
        fromVariable(match[2]);
      }
      break;
    }
    case "capture":
    case "increment":
    case "decrement":
    case "fetchxml": {
      const variable = /^\s*([^\s]+)/.exec(markup)?.[1];
      if (variable) result.definitions.push(variable.replace(QUOTED, "$2"));
      break;
    }
    case "for":
    case "tablerow": {
      const match = /^\s*([^\s]+)\s+in\s+([\s\S]*)$/.exec(markup);
      if (match) {
        result.definitions.push(match[1]);
        result.paths.push(...expressionPaths(match[2]));
      }
      break;
    }
    case "include":
    case "extends": {
      const fragments = String(markup).match(FRAGMENTS) ?? [];
      const target = fragments[0];
      if (target) {
        const quoted = QUOTED.exec(target);
        result.include = quoted ? { name: quoted[2], dynamic: false } : { name: target, dynamic: true };
        if (!quoted) result.paths.push(...fragmentPaths(target));
      }
      if (name === "include") {
        result.definitions.push(...attributeNames(markup));
        result.paths.push(...expressionPaths(fragments.slice(1).join(" ")));
      }
      break;
    }
    case "else": // DotLiquid ignores else markup ({% else if x %} is a plain else)
    case "block":
    case "endblock":
    case "raw":
    case "comment":
    case "literal":
    case "substitution":
      break;
    case "editable": {
      result.paths.push(...expressionPaths(markup));
      break;
    }
    default:
      result.paths.push(...expressionPaths(markup));
  }
  return result;
}

function lineAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

class Counter {
  constructor() {
    this.entries = new Map();
  }
  add(name, location) {
    let entry = this.entries.get(name);
    if (!entry) this.entries.set(name, (entry = { name, count: 0, sources: new Set(), examples: [] }));
    entry.count++;
    entry.sources.add(location.source);
    if (entry.examples.length < 3 && !entry.examples.some((example) => example.source === location.source))
      entry.examples.push(location);
  }
  list(extra = () => ({})) {
    return [...this.entries.values()]
      .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)))
      .map((entry) => ({ name: entry.name, count: entry.count, sources: entry.sources.size, examples: entry.examples, ...extra(entry) }));
  }
}

/** Probe which documented properties the renderer resolves to a non-nil value. */
async function probeProperties(renderer, portal, references) {
  const page = portal.pages.find((candidate) => candidate.parentId) ?? portal.pages[0];
  const results = {};
  if (!page) return results;
  const contextFor = () =>
    renderer.contextForPage(page, `${page.url}?inventory=1`, {
      user: { id: "00000000-0000-0000-0000-000000000001", contactid: "00000000-0000-0000-0000-000000000001", fullname: "Inventory probe", roles: ["Authenticated Users"] },
    });
  for (const reference of references) {
    const [root, member] = reference.split(".");
    const test = `{% if ${root}.${member} == nil %}N{% else %}Y{% endif %}`;
    const template =
      root === "forloop"
        ? `{% for inventory_item in (1..2) %}${test}{% endfor %}`
        : root === "tablerowloop"
          ? `{% tablerow inventory_item in (1..2) %}${test}{% endtablerow %}`
          : test;
    try {
      results[reference] = /Y/.test(await renderer.renderString(template, contextFor()));
    } catch {
      results[reference] = false;
    }
  }
  return results;
}

/** Build the inventory of an imported portal model. */
export async function inventoryPortal(portal, { includeInactive = false, includeSources = false } = {}) {
  const renderer = createPortalRenderer(portal);
  const { engine } = renderer;
  const rawTags = engine.rawTags;
  const structural = new Set(INTERMEDIATE_TAGS);
  for (const [name, type] of engine.tags) if (type.prototype instanceof Block) structural.add(`end${name}`);
  let globals = [];
  try {
    const page = portal.pages[0] ?? { id: "inventory", url: "/", title: "Inventory", name: "Inventory" };
    globals = Object.keys(renderer.contextForPage(page)).filter((key) => !key.startsWith("__"));
  } catch {}
  const globalSet = new Set(globals.map((name) => name.toLowerCase()));

  const { sources, inactive } = await collectSources(portal, { includeInactive });
  const tags = new Counter();
  const filters = new Counter();
  const objects = new Counter();
  const properties = new Counter();
  const includes = new Counter();
  const definitions = new Set();
  const syntaxErrors = [];
  const byKind = {};
  const sourceSummaries = [];
  for (const source of sources) {
    byKind[source.kind] = (byKind[source.kind] ?? 0) + 1;
    const label = `${source.kind}:${source.name}${source.lcid ? `[${source.lcid}]` : ""}`;
    const lineStarts = [0];
    for (let i = 0; i < source.text.length; i++) if (source.text[i] === "\n") lineStarts.push(i + 1);
    try {
      engine.parse(source.text);
    } catch (error) {
      syntaxErrors.push({ source: label, file: source.file, message: error.message });
    }
    const tokens = scanTokens(source.text, rawTags);
    let tagCount = 0;
    let outputCount = 0;
    for (const token of tokens) {
      const location = { source: label, file: source.file, line: lineAt(lineStarts, token.offset) };
      const usePaths = (paths) => {
        for (const reference of paths) {
          objects.add(reference.root, location);
          if (reference.member) properties.add(`${reference.root}.${reference.member}`, location);
        }
      };
      if (token.type === "output") {
        outputCount++;
        const variable = new Variable(token.markup);
        if (variable.name != null) usePaths(fragmentPaths(variable.name));
        for (const filter of variable.filters) {
          filters.add(filter.name, location);
          for (const arg of filter.args) usePaths(fragmentPaths(arg));
        }
        continue;
      }
      tagCount++;
      const parsed = TAG_NAME.exec(token.markup);
      if (!parsed) continue;
      const [, name, markup] = parsed;
      tags.add(name, location);
      const analysis = analyseTag(name, markup);
      for (const definition of analysis.definitions) definitions.add(definition.toLowerCase());
      for (const filter of analysis.filters) filters.add(filter, location);
      usePaths(analysis.paths);
      if (analysis.include) includes.add(analysis.include.dynamic ? `{${analysis.include.name}}` : analysis.include.name, location);
    }
    if (includeSources) sourceSummaries.push({ source: label, file: source.file, active: source.active, tags: tagCount, outputs: outputCount });
  }
  // Contextual objects defined by tags in use.
  const tagNames = new Set(tags.entries.keys());
  const objectStatus = (name) => {
    if (globalSet.has(name)) return "global";
    if (CONTEXTUAL_OBJECTS[name]) return tagNames.has(CONTEXTUAL_OBJECTS[name]) ? "contextual" : "undefined";
    if (definitions.has(name)) return "local";
    if (DOCUMENTED_GLOBALS.includes(name)) return "unsupported";
    return "undefined";
  };
  // Properties: probe documented members of closed and entity objects.
  const probeTargets = [];
  for (const name of properties.entries.keys()) {
    const [root, member] = name.split(".");
    if (objectStatus(root) === "local" && !globalSet.has(root)) continue;
    if (DOCUMENTED_PROPERTIES[root]?.includes(member.toLowerCase()) || CLOSED_OBJECTS.has(root)) probeTargets.push(name);
  }
  const probed = await probeProperties(renderer, portal, probeTargets);
  const propertyStatus = (name) => {
    const [root, member] = name.split(".");
    const rootStatus = objectStatus(root);
    if (rootStatus === "local" || rootStatus === "undefined") return rootStatus;
    if (rootStatus === "unsupported") return "unsupported-object";
    if (["entitylist", "entityview", "searchindex"].includes(root)) return "component";
    if (DICTIONARY_OBJECTS.has(root)) return "key";
    const documented = DOCUMENTED_PROPERTIES[root]?.includes(member.toLowerCase());
    if (Object.hasOwn(probed, name)) {
      if (probed[name]) return documented ? "supported" : "supported-undocumented";
      return documented ? "unsupported" : "nil";
    }
    if (ENTITY_OBJECTS.has(root)) return "attribute";
    return "unchecked";
  };
  const includeStatus = async (entry) => {
    if (entry.name.startsWith("{")) return "dynamic";
    const codes = [];
    const probeContext = { diagnostic: (code) => codes.push(code) };
    const resolved = await engine.loadTemplateSource(entry.name, probeContext);
    if (codes.includes("liquid-template-not-found")) return "missing";
    if (codes.includes("liquid-managed-template-source")) return "runtime-managed";
    const record = Object.values(portal.templates ?? {}).find((t) => String(t?.name ?? "").toLowerCase() === entry.name.toLowerCase());
    return record && resolved === record.source ? "web-template" : "runtime";
  };
  const includeList = [];
  for (const entry of includes.list()) includeList.push({ ...entry, resolution: await includeStatus(entry) });

  // A tag the engine lacks is a parse error ("Unknown tag") on both platforms unless Power Pages
  // documents it. A filter the engine lacks returns its input unchanged on both platforms
  // (DotLiquid Context.Invoke) unless Power Pages documents it.
  const tagList = tags.list((entry) => ({
    status: engine.tags.has(entry.name)
      ? "supported"
      : structural.has(entry.name)
        ? "structural"
        : DOCUMENTED_TAGS.includes(entry.name)
          ? "unsupported"
          : "unknown",
  }));
  const filterList = filters.list((entry) => ({
    status: engine.filters.has(entry.name) ? "supported" : DOCUMENTED_FILTERS.includes(entry.name) ? "unsupported" : "unknown",
  }));
  const objectList = objects.list((entry) => ({ status: objectStatus(entry.name) }));
  const propertyList = properties.list((entry) => ({ status: propertyStatus(entry.name) }));
  const unsupported = [
    ...tagList.filter((entry) => entry.status === "unsupported").map((entry) => ({ kind: "tag", ...entry })),
    ...filterList.filter((entry) => entry.status === "unsupported").map((entry) => ({ kind: "filter", ...entry })),
    ...objectList.filter((entry) => entry.status === "unsupported").map((entry) => ({ kind: "object", ...entry })),
    ...propertyList.filter((entry) => entry.status === "unsupported").map((entry) => ({ kind: "property", ...entry })),
  ].map(({ kind, name, count, sources: sourceCount, examples }) => ({ kind, name, count, sources: sourceCount, examples }));
  return {
    portal: portal.sourceDir,
    format: portal.format,
    renderer: { tags: engine.tags.size, filters: engine.filters.size, globals },
    sources: { total: sources.length, inactiveRecords: inactive, inactiveIncluded: includeInactive, byKind },
    totals: {
      tags: tagList.reduce((sum, entry) => sum + entry.count, 0),
      filters: filterList.reduce((sum, entry) => sum + entry.count, 0),
      objects: objectList.reduce((sum, entry) => sum + entry.count, 0),
    },
    tags: tagList,
    filters: filterList,
    objects: objectList,
    properties: propertyList,
    includes: includeList,
    syntaxErrors,
    undefinedObjects: objectList.filter((entry) => entry.status === "undefined").map((entry) => entry.name),
    unknownTags: tagList.filter((entry) => entry.status === "unknown").map((entry) => entry.name),
    unknownFilters: filterList.filter((entry) => entry.status === "unknown").map((entry) => entry.name),
    missingIncludes: includeList.filter((entry) => entry.resolution === "missing").map((entry) => entry.name),
    unsupported,
    ...(includeSources ? { sourceList: sourceSummaries } : {}),
  };
}

function summarize(report) {
  const lines = [];
  const count = (list, status) => list.filter((entry) => entry.status === status).length;
  lines.push(`Liquid inventory: ${report.portal} (${report.format})`);
  lines.push(
    `Sources: ${report.sources.total} Liquid-bearing (${Object.entries(report.sources.byKind)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ")}); inactive records ${report.sources.inactiveIncluded ? "included" : "skipped"}: ${report.sources.inactiveRecords}`,
  );
  lines.push(`Renderer: ${report.renderer.tags} tags, ${report.renderer.filters} filters, globals ${report.renderer.globals.join(", ")}`);
  lines.push(
    `Tags: ${report.tags.length} distinct, ${report.totals.tags} uses (${count(report.tags, "unsupported")} unsupported, ${count(report.tags, "unknown")} unknown)`,
  );
  lines.push(
    `Filters: ${report.filters.length} distinct, ${report.totals.filters} uses (${count(report.filters, "unsupported")} unsupported, ${count(report.filters, "unknown")} unknown)`,
  );
  lines.push(
    `Objects: ${report.objects.length} distinct roots, ${report.totals.objects} references (global ${count(report.objects, "global")}, contextual ${count(report.objects, "contextual")}, local ${count(report.objects, "local")}, undefined ${count(report.objects, "undefined")}, unsupported ${count(report.objects, "unsupported")})`,
  );
  lines.push(`Properties: ${report.properties.length} distinct first-level members (${count(report.properties, "unsupported")} unsupported)`);
  lines.push(`Includes: ${report.includes.length} distinct targets (${report.missingIncludes.length} missing)`);
  lines.push(`Syntax errors: ${report.syntaxErrors.length}`);
  for (const error of report.syntaxErrors.slice(0, 20)) {
    const message = error.message.replace(/\s+/g, " ");
    lines.push(`  ${error.source}: ${message.length > 200 ? `${message.slice(0, 200)}...` : message}`);
  }
  if (report.missingIncludes.length) lines.push(`Missing includes: ${report.missingIncludes.join(", ")}`);
  if (report.unknownTags.length) lines.push(`Unknown tags (parse errors on both platforms): ${report.unknownTags.join(", ")}`);
  for (const name of report.unknownFilters) {
    const entry = report.filters.find((filter) => filter.name === name);
    lines.push(
      `Unknown filter (input returned unchanged on both platforms): ${name} x${entry.count} (${entry.examples.map((example) => `${example.source}:${example.line}`).join(", ")})`,
    );
  }
  if (report.undefinedObjects.length) lines.push(`Undefined roots (nil on both platforms): ${report.undefinedObjects.join(", ")}`);
  lines.push(`Unsupported: ${report.unsupported.length ? "" : "none"}`);
  for (const entry of report.unsupported)
    lines.push(`  ${entry.kind} ${entry.name} x${entry.count} (${entry.examples.map((example) => `${example.source}:${example.line}`).join(", ")})`);
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = { json: false, includeInactive: false, includeSources: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--portal") options.portal = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--json") options.json = true;
    else if (arg === "--include-inactive") options.includeInactive = true;
    else if (arg === "--sources") options.includeSources = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.portal) {
    console.log("Usage: node mirage/liquid-inventory.mjs --portal <dir> [--json] [--out FILE] [--include-inactive] [--sources] [--strict]");
    return options.help ? 0 : 2;
  }
  const portal = await importPortal(options.portal);
  const report = await inventoryPortal(portal, options);
  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(options.out, JSON.stringify(report, null, 2));
  }
  console.log(options.json ? JSON.stringify(report, null, 2) : summarize(report));
  return options.strict && report.unsupported.length ? 1 : 0;
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
