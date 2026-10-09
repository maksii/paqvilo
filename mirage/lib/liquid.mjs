// Power Pages Liquid rendering for exported portal sources.
//
// The engine (liquid-engine.mjs) reproduces DotLiquid at SyntaxCompatibility.DotLiquid20,
// the dialect Power Pages runs; this module supplies the portal object model (page,
// website, user, request/params, snippets, settings, sitemap, sitemarkers, weblinks,
// entities, knowledge, resx), the portal tags (fetchxml, editable, substitution, forms,
// lists, views, search, chart, powerbi, codecomponent, redirect, outputcache, log,
// manifest), web template resolution (active web templates by name, then the embedded
// runtime templates) and the page shell. Behaviour and evidence: docs/liquid-parity.md.
import { normalizePortalPath, portalField } from "./importer.mjs";
import { pageAccess } from "./page-access.mjs";
import { reconcileFooterLogos } from "./footer-capture.mjs";
import { reconcileHeaderNotifications } from "./header-notification-capture.mjs";
import { notificationVisibility } from "./notification-visibility.mjs";
import { headerNotificationQueries } from "./extensions.mjs";
import { resolveSnippetComposition } from "./observed-snippet-composition.mjs";
import { resolveObservedPageCopy } from "./observed-pagecopy-layout.mjs";
import { injectRuntimeCompatibility, isHtmlDocument } from "./source-dependencies.mjs";
import { OFFLINE_NOTIFICATION_BAR, antiForgeryHolder, nativePageRegions, rewritePageLayout, CKEDITOR_BASEPATH, platformShell, bootstrapVariant, PLATFORM_BOOTSTRAP_STYLESHEET } from "./platform-manifest.mjs";
import {
  LiquidEngine,
  LiquidContext,
  LiquidHash,
  LiquidDrop,
  Tag,
  Block,
  RawBlock,
  renderAll,
  tagAttributes,
  formatItem,
  formatOutput,
  isEnumerable,
  toList,
  LiquidError,
  LiquidSyntaxError,
  LIQUID_PROPERTIES,
  LIQUID_HIDDEN,
  isInfrastructureError,
} from "./liquid-engine.mjs";
import { FILTER_SIGNATURES, createFilters } from "./liquid-filters.mjs";
import {
  ISO_DATETIME,
  parseNetDate,
  isDate,
  escapeDataString,
  httpUtilityUrlEncode,
  uriToDisplayString,
  htmlEncode,
} from "./liquid-dotnet.mjs";
import { CMS_VIEW_TEMPLATES, EMBEDDED_TEMPLATES } from "./liquid-builtins.mjs";
import { createAdsDrop, createPollsDrop } from "./liquid-community.mjs";
import { RESX_CULTURES } from "./liquid-resx.mjs";
import { portalLanguage } from "./portal-languages.mjs";
import fs from "node:fs/promises";

const htmlEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export function renderShellResource(value, kind, { localOnly = false } = {}) {
  const source = typeof value === "object" ? (value.src ?? value.href) : value;
  if (
    typeof source !== "string" ||
    source.includes("\\") ||
    !/^(?:\/(?!\/)|https?:\/\/)/i.test(source) ||
    (localOnly && !source.startsWith("/"))
  )
    throw new Error("Shell resources require portal-relative or HTTP(S) paths");
  if (kind === "css")
    return `<link rel="stylesheet" href="${htmlEscape(source)}"${typeof value === "object" && value.media ? ` media="${htmlEscape(value.media)}"` : ""}>`;
  const type = typeof value === "object" ? value.type : undefined;
  if (type && !["module", "text/javascript", "application/javascript"].includes(type))
    throw new Error("Unsupported shell script type");
  return `<script src="${htmlEscape(source)}"${typeof value === "object" && value.defer ? " defer" : ""}${typeof value === "object" && value.async ? " async" : ""}${type ? ` type="${htmlEscape(type)}"` : ""}></script>`;
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------
/**
 * Local adapters for runtime templates whose native implementation is a platform control:
 * entity lists render through the shared component renderer. The embedded poll and ad templates
 * render placement placeholders that the ad and poll services fill (mirage_poll, mirage_ad).
 */
const ADAPTER_TEMPLATES = {
  entity_list: "{% entitylist key:key %}{% endentitylist %}",
};
/** Display names of managed web templates that PAC exports may contain without source. */
const MANAGED_DISPLAY_NAMES = {
  "page copy": "page_copy",
  "page header": "page_header",
  snippet: "snippet",
  breadcrumbs: "breadcrumbs",
  "layout 1 column": "layout_1_column",
  "layout 2 column wide left": "layout_2_column_wide_left",
  "layout 2 column wide right": "layout_2_column_wide_right",
  "layout 3 column wide middle": "layout_3_column_wide_middle",
  "side navigation": "side_navigation",
  "child link list group": "child_link_list_group",
  "weblink list group": "weblink_list_group",
  "top navigation": "top_navigation",
  search: "search",
  poll: "poll",
  ad: "ad",
};
/**
 * Managed web templates whose output on the live platform differs from the embedded Adxstudio
 * template: reference-portal nests the editable wrapper inside div.page-copy (parity baseline
 * gap-page-copy-editable; lib/observed-pagecopy-layout.mjs records the same structure).
 */
const MANAGED_SOURCES = {
  page_copy: "<div class=\"page-copy\">{% editable page 'adx_copy' type: 'html', liquid: true %}</div>",
};
const OBSERVED_PAGE_COPY_PREFIX = '<div class="page-copy"><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value">';
const OBSERVED_PAGE_COPY_SUFFIX = "</div></div></div>";
const builtinSource = (name) =>
  Object.hasOwn(EMBEDDED_TEMPLATES, name) ? EMBEDDED_TEMPLATES[name] : Object.hasOwn(ADAPTER_TEMPLATES, name) ? ADAPTER_TEMPLATES[name] : undefined;
const nameKey = (value) => String(value ?? "").trim().toLowerCase();
const managedSource = (managed) => MANAGED_SOURCES[managed] ?? builtinSource(managed);

// ---------------------------------------------------------------------------
// Data values (Dataverse records become Liquid entity objects)
// ---------------------------------------------------------------------------
/** ISO date/time strings from the local store are Dataverse DateTime values. */
function liquidValue(value) {
  if (typeof value === "string" && ISO_DATETIME.test(value)) return parseNetDate(value) ?? value;
  return value;
}
export function liquidRecord(record, properties = ENTITY_PROPERTIES) {
  if (record == null || typeof record !== "object" || Array.isArray(record) || isDate(record)) return record;
  const out = {};
  for (const key of Object.getOwnPropertyNames(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    // Hidden members such as the store's non-enumerable primary id stay hidden from JSON.
    if ("value" in descriptor) descriptor.value = liquidValue(descriptor.value);
    Object.defineProperty(out, key, descriptor);
  }
  // EntityDrop: Dataverse attribute names are exact; drop properties are not.
  Object.defineProperty(out, LIQUID_PROPERTIES, { value: properties });
  return out;
}
const ENTITY_PROPERTIES = new Set(["id", "logical_name", "logicalname", "url", "notes", "permissions", "formatted_values", "cms"]);
const PAGE_PROPERTIES = new Set([
  ...ENTITY_PROPERTIES,
  "breadcrumbs",
  "children",
  "description",
  "parent",
  "title",
  "entity",
  "languages",
  "available_languages",
  "is_sitemap_ancestor",
  "is_sitemap_current",
]);
const USER_PROPERTIES = new Set([...ENTITY_PROPERTIES, "roles", "role_keys", "basic_badges_url", "profile_badges_url"]);
/** Importer fields that are not attributes of the adx_webpage record. */
const PAGE_HOST_KEYS = new Set([
  "name",
  "translations",
  "html",
  "css",
  "js",
  "summary",
  "metadata",
  "formId",
  "listId",
  "advancedFormId",
  "parentId",
  "pageTemplateId",
  "displayOrder",
  "internalName",
  "__liquidEditable",
  "__isCurrentPage",
]);
const ENTITY_REFERENCE_FIELDS = {
  adx_parentpageid: "adx_webpage",
  adx_rootwebpageid: "adx_webpage",
  adx_pagetemplateid: "adx_pagetemplate",
  adx_websiteid: "adx_website",
  adx_publishingstateid: "adx_publishingstate",
  adx_entityform: "adx_entityform",
  adx_entitylist: "adx_entitylist",
  adx_webform: "adx_webform",
  adx_webpagelanguageid: "adx_websitelanguage",
  adx_subjectid: "subject",
};

const GUID_KEY = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
class EntityTableDrop extends LiquidDrop {
  constructor(name, read, user, cache) {
    super();
    this.name = name;
    this.read = read;
    this.user = user;
    this.cache = cache;
  }
  async liquidGet(key, context) {
    if (key.toLowerCase() === "logical_name" || key.toLowerCase() === "logicalname") return this.name;
    // EntitySetDrop retrieves by primary key; missing or denied records are nil. Dataverse keys
    // are GUIDs (braces and case are normalised). Dataverse cannot hold a non-GUID key, so the
    // platform answers nil; local synthetic ids are still resolved and reported.
    const text = String(key).trim();
    if (!text) return null;
    const guid = GUID_KEY.test(text);
    const id = guid ? text.replace(/[{}]/g, "").toLowerCase() : text;
    const cacheKey = `${this.name}|${id}`;
    if (!this.cache.has(cacheKey))
      this.cache.set(
        cacheKey,
        (async () => {
          try {
            const record = liquidRecord((await this.read?.(this.name, id, this.user)) ?? null);
            // EntityDrop always exposes id and logical_name.
            if (record && typeof record === "object") {
              if (!Object.hasOwn(record, "id")) record.id = id;
              if (!Object.hasOwn(record, "logical_name")) record.logical_name = this.name;
            }
            return record;
          } catch (error) {
            // A record the table permissions do not grant is nil; infrastructure failures propagate.
            if (!isInfrastructureError(error) && Number(error?.status) === 403) return null;
            throw error;
          }
        })(),
      );
    const record = await this.cache.get(cacheKey);
    if (record && !guid)
      context?.diagnostic?.("liquid-entity-non-guid-key", `entities.${this.name}[key] resolved local records by non-GUID keys; Power Pages returns nil for non-GUID keys.`, {
        table: this.name,
        key: text,
      });
    return record;
  }
}
class EntitiesDrop extends LiquidDrop {
  constructor(read, user) {
    super();
    this.read = read;
    this.user = user;
    this.tables = new Map();
    this.cache = new Map();
  }
  liquidGet(key) {
    if (!this.tables.has(key)) this.tables.set(key, new EntityTableDrop(String(key), this.read, this.user, this.cache));
    return this.tables.get(key);
  }
}
class KnowledgeDrop extends LiquidDrop {
  constructor(fetchXml, user) {
    super();
    this.fetchXml = fetchXml;
    this.user = user;
    this.cache = new Map();
  }
  liquidGet(key) {
    if (!["categories", "articles"].includes(key)) return undefined;
    if (!this.cache.has(key)) this.cache.set(key, this.load(key));
    return this.cache.get(key);
  }
  async load(key) {
    if (!this.fetchXml) throw new LiquidError("Knowledge requires the configured portal data provider");
    const entity = key === "categories" ? "category" : "knowledgearticle";
    const rows = [];
    let cookie;
    for (let page = 1; page <= 20; page++) {
      const result = await this.fetchXml(
        `<fetch count="500" page="${page}"${cookie ? ` paging-cookie="${htmlEscape(cookie)}"` : ""}><entity name="${entity}"><all-attributes/><order attribute="${entity}id"/>${key === "articles" ? '<filter><condition attribute="statecode" operator="eq" value="3"/><condition attribute="isinternal" operator="eq" value="false"/></filter>' : ""}</entity></fetch>`,
        this.user,
      );
      rows.push(...(result.entities ?? []).map((row) => ({ ...liquidRecord(row), name: row.title ?? row.name })));
      if (!result.more_records) return rows;
      cookie = result.paging_cookie;
    }
    throw new LiquidError("Knowledge collection exceeds 10,000 visible records; use a filtered FetchXML query.");
  }
}
const knowledgeFunctions = {
  categoryNumber: (rows, number) =>
    Array.isArray(rows) ? (rows.find((r) => String(r.categorynumber ?? r.number ?? r.id) === String(number)) ?? null) : rows,
  topLevel: (rows, count) =>
    Array.isArray(rows) ? rows.filter((r) => !r.parentcategoryid && !r.parent).slice(0, count || undefined) : rows,
};

// Built-in resource strings (ResourceManagerDrop). Values observed on the live portal win
// over the 2017 resource file; the remaining keys come from Adxstudio.Xrm.Resources strings.resx.
const RESX = {
  Sign_In: "Sign in",
  Sign_Out: "Sign out",
  Profile: "Profile",
  Search: "Search",
  Search_DefaultText: "Search",
  Discover_Contoso: "Search",
  Toggle_Navigation: "Toggle navigation",
  Home: "Home",
  Language: "Language",
  Current_Language: "English",
  Editable_Cancel_Label: "Cancel",
  Submit_Button_Label_Text: "Submit",
  // reference-portal /contact-us/ poll (wave 3 recheck 6, probes/contact-us-poll-labels.json): sentence case.
  Poll_Results_Label: "View results",
  Poll_Totals_Label: "Total votes:",
  Poll_Return_Label: "Return to poll",
  Poll_Archives_Heading: "Poll Archives",
  Poll_DefaultText: "Poll",
  All: "All",
  Search_Filter: "Search Filter",
  Search_No_Results_Found: "No results were found for this query: ",
  Search_Results_Format_String: "Results {0} - {1} of {2} for query: ",
  Most_Popular_Categories: "Most Popular Categories",
  Most_Recent_Categories: "Most Recent Categories",
  Events_Label: "Events",
  Forums_Label: "Forums",
  Issues_Label: "Issues",
  KnowledgeMgmt_Most_Popular_Articles: "Most Popular Articles",
  KnowledgeMgmt_Most_Recent_Articles: "Most Recent Articles",
  Knowledge_Base_Label: "Knowledge Base",
  Knowledge_Article_Unavailable: "Article Unavailable",
  Browse_The_KB: "Browse the KB",
  Popular_Topics: "Popular Topics",
  Related_Categories_DefaultText: "Related Categories",
  Get_Help_DefaultText: "Get Help",
  Find_Your_Product: "Find your Product",
  View_More: "View More",
  Most_Popular: "Most Popular",
  Top_Rated_Articles: "Top Rated Articles",
  Case_Deflection_Suggested_Topics: "Suggested Topics",
  Sorting_Rating: "Average User Ratings",
  Sorting_Relevance: "Relevance",
  Sorting_ViewCount: "View Count",
  Sorting_Options: "Sorting options",
  Facet_RecordType: "Record Type",
  Facet_DateModified: "Modified date",
  Facet_Show_Less: "Show less",
  Facet_Show_More: "Show more",
  Facet_All: "All",
  Facet_Rating: "Rating",
  Facet_Products: "Products",
  Pagination_Current_Page: "Current page {0}",
  Pagination_First_Page: "First page",
  Pagination_Last_Page: "Last page",
  Pagination_Next_Page: "Next page",
  Pagination_Page: "Page {0}",
  Pagination_Previous_Page: "Previous page",
};
/** Resource strings of a culture (lib/liquid-resx.mjs); English and unknown cultures use RESX. */
function resxCulture(code) {
  const text = String(code ?? "");
  if (!text || /^en(?:-|$)/i.test(text)) return null;
  const cultures = Object.keys(RESX_CULTURES);
  const exact = cultures.find((culture) => culture.toLowerCase() === text.toLowerCase());
  const family = text.split("-")[0].toLowerCase();
  const sibling = exact ?? cultures.find((culture) => culture.split("-")[0].toLowerCase() === family);
  return sibling ? RESX_CULTURES[sibling] : null;
}
class ResxDrop extends LiquidDrop {
  constructor(culture = null) {
    super();
    this.strings = resxCulture(culture);
  }
  liquidGet(key) {
    if (this.strings && Object.hasOwn(this.strings, key)) return this.strings[key];
    return Object.hasOwn(RESX, key) ? RESX[key] : null;
  }
}
class UniqueDrop extends LiquidDrop {
  liquidGet(key) {
    if (key.toLowerCase() === "new_guid") return crypto.randomUUID();
    return undefined;
  }
}
class SettingsDrop extends LiquidDrop {
  constructor(settings) {
    super();
    this.settings = settings ?? {};
  }
  liquidGet(key) {
    if (Object.hasOwn(this.settings, key)) return this.settings[key];
    const match = Object.keys(this.settings).find((name) => name.toLowerCase() === key.toLowerCase());
    return match === undefined ? null : this.settings[match];
  }
}

/** Snippets render the Liquid they contain in the current context (observed live behaviour). */
class SnippetsDrop extends LiquidDrop {
  constructor({ snippets, engine, profiles, origin, diagnostics }) {
    super();
    this.snippets = snippets ?? {};
    this.engine = engine;
    this.profiles = profiles ?? [];
    this.origin = origin;
    this.diagnostics = diagnostics;
    this.rendering = new Set();
  }
  resolveName(key) {
    if (Object.hasOwn(this.snippets, key)) return key;
    return Object.keys(this.snippets).find((name) => name.toLowerCase() === String(key).toLowerCase());
  }
  rawValue(key) {
    const name = this.resolveName(key);
    if (name === undefined) return { name: undefined, source: undefined };
    const resolved = resolveSnippetComposition(this.snippets, name, this.profiles, { origin: this.origin });
    if (resolved.diagnostic) this.diagnostics.push(resolved.diagnostic);
    return { name, source: resolved.source };
  }
  async liquidGet(key, context) {
    const { name, source } = this.rawValue(key);
    // Dataverse stores empty text as null: a snippet record without a value is nil.
    if (source == null || source === "") return null;
    if (!/\{%|\{\{/.test(source)) return source;
    if (this.rendering.has(name)) throw new LiquidError(`Recursive content snippet ${name}`);
    this.rendering.add(name);
    try {
      return await renderNested(this.engine, source, context);
    } finally {
      this.rendering.delete(name);
    }
  }
}
/** html.Liquid(source, context): parse errors return the bare message; rendering shares the context. */
async function renderNested(engine, source, context) {
  let template;
  try {
    template = engine.parse(source);
  } catch (error) {
    if (error instanceof LiquidSyntaxError) {
      context.diagnostic("liquid-syntax-error", error.message);
      return error.message;
    }
    throw error;
  }
  const buffer = [];
  await context.stack(() => template.renderInto(context, buffer));
  return buffer.join("");
}

// ---------------------------------------------------------------------------
// Portal tags
// ---------------------------------------------------------------------------
const COMPONENT_SYNTAX = /^\s*(?:([\p{L}\p{Mn}\p{Nd}\p{Pc}]+)\s*=\s*)?/u;
async function evaluateAttributes(markup, context) {
  const args = {};
  for (const { key, value } of tagAttributes(markup).values()) args[key] = await context.resolve(value);
  return args;
}
class FetchXmlTag extends Block {
  parse(tokens) {
    const m = /([\p{L}\p{Mn}\p{Nd}\p{Pc}]+)/u.exec(this.markup);
    if (!m) throw new LiquidSyntaxError(`Syntax Error in '${this.tagName}' tag - Valid syntax: ${this.tagName} [var] (right:[string])`);
    this.variable = m[1];
    this.attributes = tagAttributes(this.markup);
    super.parse(tokens);
  }
  async render(context) {
    const buffer = [];
    await renderAll(this.nodeList, context, buffer);
    const xml = buffer.join("");
    const host = context.engine.portalHost;
    if (!host.fetchXml) throw new LiquidError("FetchXML data provider is not configured");
    const right = this.attributes.get("right") ? formatItem(await context.resolve(this.attributes.get("right").value)) : undefined;
    let results;
    try {
      results = (await host.fetchXml(xml, host.user(context), host.request(context), { right })) ?? {};
    } catch (error) {
      // FetchXmlQueryDrop: without a table permission granting read, results is an empty
      // collection rather than an error; simulator infrastructure failures still propagate.
      if (isInfrastructureError(error) || Number(error?.status) !== 403) throw error;
      results = { entities: [], permission_granted: false, global_permission_granted: false };
    }
    const entities = (results.entities ?? []).map((row) => liquidRecord(row));
    // FetchXmlQueryDrop: results exposes the EntityCollection members; xml the executed query.
    context.assignGlobal(this.variable, {
      xml: results.xml ?? xml,
      permission_granted: results.permission_granted ?? true,
      global_permission_granted: results.global_permission_granted ?? false,
      rules_exist: results.rules_exist ?? true,
      results: {
        entity_name: results.entity_name ?? /<entity\b[^>]*\bname\s*=\s*["']([^"']+)/i.exec(xml)?.[1] ?? null,
        min_active_row_version: results.min_active_row_version ?? null,
        more_records: results.more_records ?? false,
        paging_cookie: results.paging_cookie ?? null,
        total_record_count: results.total_record_count ?? -1,
        total_record_count_limit_exceeded: results.total_record_count_limit_exceeded ?? false,
        ...results,
        entities,
      },
    });
  }
}
/** Substitution: a raw block rendered with a fresh context over the request globals. */
class SubstitutionTag extends RawBlock {
  async render(context, out) {
    const host = context.engine.portalHost;
    const fresh = host.freshContext(context);
    let template;
    try {
      template = context.engine.parse(this.source);
    } catch (error) {
      if (!(error instanceof LiquidSyntaxError)) throw error;
      context.diagnostic("liquid-syntax-error", error.message);
      out.push(error.message);
      return;
    }
    await context.stack(() => template.renderInto(fresh, out));
  }
}
/** Editable: CMS wrapper markup for page attributes and snippets (non-editor view). */
const EDITABLE_SYNTAX = new RegExp(`((?:"[^"]*"|'[^']*'|(?:[^\\s,|'"]|"[^"]*"|'[^']*')+))(\\s+((?:"[^"]*"|'[^']*'|(?:[^\\s,|'"]|"[^"]*"|'[^']*')+))?)`, "u");
class EditableTag extends Tag {
  parse() {
    const m = EDITABLE_SYNTAX.exec(this.markup);
    if (!m) throw new LiquidSyntaxError(`Syntax Error in '${this.tagName}' tag - Valid syntax: ${this.tagName} [editable] ([key]) (type:[type])`);
    this.editable = m[1];
    this.key = m[3] ?? "";
    this.attributes = tagAttributes(this.markup);
  }
  async render(context, out) {
    const options = {};
    for (const [name, { value }] of this.attributes) options[name] = await context.resolve(value);
    const key = this.key ? await context.resolve(this.key) : null;
    const target = await context.resolve(this.editable);
    const host = context.engine.portalHost;
    const html = await host.editable(target, typeof key === "string" ? key : null, options, context);
    if (html != null) out.push(html);
  }
}
/** Not documented for current sites; the 2017 runtime redirected to a site-marker page. */
class RedirectTag extends Tag {
  parse() {
    this.attributes = tagAttributes(this.markup);
  }
  async render(context) {
    const marker = this.attributes.get("sitemarker");
    if (!marker) throw new LiquidSyntaxError("Syntax Error in 'redirect' tag. Missing required attribute 'sitemarker:[string]'");
    const name = marker.value.replace(/"/g, "").replace("['", "").replace("']", "");
    const url = context.engine.portalHost.siteMarkerUrl(name);
    if (!url) throw new LiquidSyntaxError("The sitemarker is unavailable");
    context.registers.set("redirect", url);
    context.diagnostic("liquid-redirect", `The page requested a redirect to ${url} (local render continues).`, { url });
  }
}
/** Tags whose output only affects response caching or the DevTools log. */
class NoOutputTag extends Tag {
  parse() {
    this.attributes = tagAttributes(this.markup);
  }
  async render(context) {
    if (this.tagName === "log") {
      const message = this.attributes.get("message");
      context.diagnostic("liquid-log", formatOutput(message ? await context.resolve(message.value) : ""), { level: "info" });
    }
  }
}
class ManifestTag extends RawBlock {
  async render() {}
}
/**
 * {% serverlogic name: 'record', operation: 'function', input: value, output: variable %} (Learn,
 * liquid-objects "serverlogic": the output object has success, status_code, data and raw_result).
 * Server logic never runs locally (lib/server-logic.mjs): the output receives an unsuccessful
 * result with status code 501 and a SERVER_LOGIC_UNSUPPORTED diagnostic names the call.
 */
class ServerLogicTag extends Tag {
  parse() {
    this.attributes = tagAttributes(this.markup);
  }
  async render(context) {
    const value = async (key) => (this.attributes.get(key) ? formatItem(await context.resolve(this.attributes.get(key).value)) : "");
    const name = await value("name");
    const operation = await value("operation");
    const output = this.attributes.get("output")?.value?.trim();
    context.diagnostic("SERVER_LOGIC_UNSUPPORTED", `Server logic "${name}" (operation "${operation}") is not run by the Mirage; ${output ? `${output}.success is false` : "the tag names no output"}.`, { name, operation });
    if (output) context.assignGlobal(output, { success: false, status_code: 501, data: null, raw_result: "" });
  }
}

// ---- Component tags (forms, lists, views, search, charts). Shared with agent C: the
// renderComponent(tag, args, contextSnapshot, portal) contract is unchanged. ----
const COMPONENT_TAGS = ["entityform", "webform", "entitylist", "entityview", "searchindex", "powerbi", "codecomponent", "chart"];
const BLOCK_COMPONENTS = new Set(["entitylist", "entityview", "searchindex"]);
function componentTag(tag) {
  return class extends Block {
    parse(tokens) {
      this.variable = COMPONENT_SYNTAX.exec(this.markup)?.[1] ?? null;
      if (BLOCK_COMPONENTS.has(tag)) super.parse(tokens);
      else this.nodeList = null;
    }
    async render(context, out) {
      const args = await evaluateAttributes(this.markup, context);
      if (["entityform", "webform", "entitylist"].includes(tag) && args.name == null && args.id == null && args.key == null) return;
      const host = context.engine.portalHost;
      if (!host.renderComponent) {
        context.diagnostic("unsupported-platform-component", `No renderer for ${tag}`, { tag, args });
        out.push(`<div data-mirage-component="${tag}" role="alert">${htmlEscape(tag)} component requires form or list metadata mapping.</div>`);
        return;
      }
      const result = await host.renderComponent(tag, args, context.snapshot(), host.portal);
      if (typeof result === "string") {
        out.push(result);
        return;
      }
      if (!result) return;
      const scope = new LiquidHash(result.context ?? {});
      if (this.variable && result.context?.[tag] !== undefined) scope.set(this.variable, result.context[tag]);
      await context.stack(async () => {
        if (result.html) out.push(result.html);
        if (this.nodeList) await renderAll(this.nodeList, context, out);
      }, scope);
    }
  };
}

// ---- Ad and poll services and placements (MasterPortal Areas/Cms AdController, PollController). ----
// The services render one ad or poll: by id or name, or the first item a placement accepts where
// the platform picks one at random (Cms/AdDataAdapter.SelectRandomAd, PollDataAdapter
// .SelectRandomPoll). Items come from the ads and polls objects, which apply the data adapters'
// selection (state, release and expiration dates, publishing state; adx_active is not consulted).
// Views/Ad/Ad.ascx and Views/Poll/Poll.ascx render the item's web template when it has one,
// otherwise the default view template, with `ad` and `show_copy` (true) or `poll`. The placement
// actions (Views/Ad/AdPlacement.ascx, Views/Poll/PollPlacement.ascx, as WebFormsContent.master renders
// them in the sidebar) render the placement's web template or the default placement template with
// `placement`, `random` (true) and, for ads, `show_copy`.
const guidText = (value) => String(value?.id ?? value ?? "").replace(/[{}]/g, "").toLowerCase();
function templateById(portal, id) {
  const wanted = guidText(id);
  if (!wanted) return null;
  return Object.values(portal.templates ?? {}).find((template) => template && guidText(template.id) === wanted) ?? null;
}
async function communityRoot(context, portal, kind) {
  const root = await context.resolve(kind);
  if (typeof root?.liquidGet === "function") return root;
  const now = await context.resolve("now");
  return (kind === "ads" ? createAdsDrop : createPollsDrop)(portal, { now: now instanceof Date ? now : new Date() });
}
async function communityPlacement(context, portal, kind, key) {
  if (key == null || key === "") return null;
  const placements = await (await communityRoot(context, portal, kind)).liquidGet("placements");
  return (await placements?.liquidGet(String(key))) ?? null;
}
async function renderCommunityView(context, portal, record, fallback, scope, out) {
  const template = templateById(portal, portalField(record, "webtemplateid"));
  const source = template ? (template.source ?? "") : fallback;
  await context.stack(() => context.engine.parse(source).renderInto(context, out), new LiquidHash(scope));
}
function communityTag(portal, kind) {
  const variable = kind === "ads" ? "ad" : "poll";
  return class extends Tag {
    async render(context, out) {
      const key = await context.resolve(`${variable}_name`);
      const item =
        key != null && key !== ""
          ? ((await (await communityRoot(context, portal, kind)).liquidGet(String(key))) ?? null)
          : ((await communityPlacement(context, portal, kind, await context.resolve(`${variable}_placement_name`)))?.[kind]?.[0] ?? null);
      if (!item) return;
      await renderCommunityView(context, portal, item, CMS_VIEW_TEMPLATES[variable], kind === "ads" ? { ad: item, show_copy: true } : { poll: item }, out);
    }
  };
}
function communityPlacementTag(portal, kind) {
  const variable = kind === "ads" ? "ad" : "poll";
  return class extends Tag {
    async render(context, out) {
      const placement = await communityPlacement(context, portal, kind, await context.resolve(`${variable}_placement_name`));
      if (!placement) return;
      const scope = kind === "ads" ? { placement, show_copy: true, random: true } : { placement, random: true };
      await renderCommunityView(context, portal, placement, CMS_VIEW_TEMPLATES[`${variable}_placement`], scope, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
/** Render exported templates with Power Pages tags and request-local data/identity. */
export function createPortalRenderer(portal, options = {}) {
  const templateDiagnostics = new WeakMap();
  const findTemplate = (name) => {
    if (name == null) return undefined;
    const wanted = String(name);
    let match;
    for (const [key, template] of Object.entries(portal.templates ?? {})) {
      if (!template || typeof template !== "object") continue;
      const templateName = template.name ?? key;
      if (templateName === wanted) return template;
      if (match === undefined && nameKey(templateName) === nameKey(wanted)) match = template;
    }
    return match;
  };
  /** EntityFileSystem (active web templates by name) then EmbeddedResourceFileSystem. */
  async function loadTemplateSource(name, context) {
    const record = findTemplate(name);
    if (record) {
      if (typeof record.source === "string" && record.source.trim()) return record.source;
      const managed = MANAGED_DISPLAY_NAMES[nameKey(name)] ?? (builtinSource(String(name)) !== undefined ? String(name) : undefined);
      if (managed && builtinSource(managed) !== undefined) {
        context?.diagnostic(
          "liquid-managed-template-source",
          `Web template '${name}' has no exported source; the runtime template '${managed}' is used.`,
          { template: String(name) },
        );
        return managedSource(managed);
      }
      return record.source ?? "";
    }
    if (name != null && builtinSource(String(name)) !== undefined) return builtinSource(String(name));
    // Sites are provisioned with the managed display-name templates; exports can omit them.
    const managed = MANAGED_DISPLAY_NAMES[nameKey(name)];
    if (managed && builtinSource(managed) !== undefined) {
      context?.diagnostic(
        "liquid-managed-template-source",
        `Web template '${name}' is not in the export; the runtime template '${managed}' is used.`,
        { template: String(name) },
      );
      return managedSource(managed);
    }
    context?.diagnostic("liquid-template-not-found", `Template "${name}" not found.`, { template: name == null ? null : String(name) });
    return `Template "${name}" not found.`;
  }
  const filterHost = {
    renderLiquid: (source, context) => renderNested(engine, source, context),
    renderWebTemplate: async (id, context) => {
      const record = Object.values(portal.templates ?? {}).find((t) => String(t?.id ?? "").toLowerCase() === String(id ?? "").toLowerCase());
      if (!record) return null;
      return renderNested(engine, record.source ?? "", context);
    },
    knowledge: knowledgeFunctions,
    isSitemapCurrent: (url, context) => sameUrl(url, context.engine.portalHost.currentPath(context)),
    isSitemapAncestor: (url, context) => {
      const current = context.engine.portalHost.currentPath(context);
      return Boolean(url) && !sameUrl(url, current) && normalizePortalPath(current).startsWith(normalizePortalPath(url));
    },
    metafilters: async () => [],
    localizeRecordType: (logicalName) => logicalName,
  };
  const engine = new LiquidEngine({
    filters: createFilters(filterHost),
    filterSignatures: FILTER_SIGNATURES,
    loadTemplateSource,
    autoEncodeRoots: (context) => context.engine.portalHost.autoEncodeRoots(),
  });
  for (const tag of COMPONENT_TAGS) engine.registerTag(tag, componentTag(tag));
  engine.registerTag("fetchxml", FetchXmlTag);
  engine.registerTag("substitution", SubstitutionTag);
  engine.registerTag("editable", EditableTag);
  engine.registerTag("redirect", RedirectTag);
  engine.registerTag("outputcache", NoOutputTag);
  engine.registerTag("rating", NoOutputTag);
  engine.registerTag("log", NoOutputTag);
  engine.registerTag("manifest", ManifestTag);
  engine.registerTag("serverlogic", ServerLogicTag);
  engine.registerTag("mirage_poll", communityTag(portal, "polls"));
  engine.registerTag("mirage_ad", communityTag(portal, "ads"));
  engine.registerTag("mirage_poll_placement", communityPlacementTag(portal, "polls"));
  engine.registerTag("mirage_ad_placement", communityPlacementTag(portal, "ads"));
  engine.requestOrigin = (context) => {
    const request = context.environments[0].get("request");
    try {
      return new URL(request?.url ?? "http://localhost/").origin;
    } catch {
      return "http://localhost";
    }
  };

  const sameUrl = (a, b) => normalizePortalPath(String(a ?? "")) === normalizePortalPath(String(b ?? ""));
  const websiteLanguageName = () => {
    const languageId = portalField(portal.website ?? {}, "defaultlanguage");
    const language = (portal.records ?? []).find((r) => r.kind === "websitelanguage" && r.id === languageId);
    return language ? (portalField(language, "name", language.name) ?? null) : null;
  };
  // An editable content snippet carries the display name of the request's language (ADX
  // SnippetExtensions: ContextLanguage.DisplayName).
  const snippetLanguageName = (name, context) => {
    const record = (portal.records ?? []).find((r) => r.kind === "contentsnippet" && nameKey(r.name) === nameKey(name) && portalField(r, "contentsnippetlanguageid"));
    if (!record) return null;
    return context?.environments?.[0]?.get("__language")?.name ?? websiteLanguageName();
  };
  /**
   * Website languages and the request's language (Adxstudio ContextLanguageInfo, WebsiteDrop and
   * LanguageDrop): the published website languages with a URL language code (agent D's import) in
   * export order; the selected language is the language code that starts the URL path (sites with
   * MultiLanguage/DisplayLanguageCodeInURL keep it; the server passes a code it removed as
   * extra.languageCode), else the website default language. The session cookie and the user's
   * preferred language, which the platform consults before the default, are not simulated.
   */
  const siteLanguages = () =>
    (portal.websiteLanguages ?? [])
      .filter((language) => language.code && language.published !== false)
      .map((language) => ({
        ...language,
        // The portal language's display name (exported .portalconfig records, else the catalogue).
        displayName: language.displayName ?? portalLanguage({ name: language.code })?.displayName ?? language.name ?? language.code,
      }));
  function requestLanguage(requestUrl, extra = {}) {
    const languages = siteLanguages();
    const byCode = (code) => (code ? (languages.find((language) => language.code.toLowerCase() === String(code).toLowerCase()) ?? null) : null);
    const segment = /^\/([^/]+)(\/.*)?$/.exec(requestUrl.pathname);
    const fromPath = segment ? byCode(segment[1]) : null;
    const selected =
      byCode(extra.languageCode) ?? fromPath ?? languages.find((language) => language.isDefault) ?? byCode(portal.language?.code) ?? languages[0] ?? null;
    const path = fromPath ? segment[2] || "/" : requestUrl.pathname;
    return { languages, selected, path, pathAndQuery: path + requestUrl.search };
  }
  /** LanguageDrop: url and url_substitution are the request path and query prefixed with the code, without a leading "/". */
  const languageDrop = (language, pathAndQuery) => {
    const url = `${language.code}${pathAndQuery}`;
    return { code: language.code, name: language.displayName, url, url_substitution: url };
  };
  /**
   * The layout's language: the request's website language, else (an export without website
   * languages) the culture of the website language LCID, else en-US.
   */
  const layoutLanguageCode = (context) =>
    context.website?.selected_language?.code ?? portalLanguage({ lcid: portalField(portal.website ?? {}, "website_language") })?.code ?? "en-US";
  /** A page with the language content page of the selected website language, when it has one. */
  const localizedPage = (page, languageId) => {
    const variant = languageId ? page?.translations?.[languageId] : null;
    return variant ? { ...page, ...variant } : page;
  };
  const wrapEditable = ({ value, hasValue, editType = "html", cssClass, escape, tag = "div", languageName }) => {
    const classes = ["xrm-editable-" + editType, "xrm-attribute"];
    if (!hasValue) classes.push("no-value");
    if (cssClass) classes.push(String(cssClass));
    const valueClasses = escape ? "xrm-attribute-value-encoded xrm-attribute-value" : "xrm-attribute-value";
    const inner = escape ? htmlEncode(value) : value;
    // TagBuilder sorts attributes and AntiXSS attribute encoding renders spaces as &#32;.
    const attr = (text) => text.replace(/[^A-Za-z0-9,.\-_]/g, (c) => `&#${c.codePointAt(0)};`);
    const language = languageName ? ` data-languageContext="${attr(languageName)}"` : "";
    return `<${tag} class="${attr(classes.join(" "))}"${language}><${tag} class="${valueClasses.replace(/ /g, "&#32;")}">${inner}</${tag}></${tag}>`;
  };
  const portalHost = {
    portal,
    get fetchXml() {
      return options.fetchXml;
    },
    get renderComponent() {
      return options.renderComponent ? (tag, args, snapshot, p) => options.renderComponent(tag, args, snapshot, p) : null;
    },
    user: (context) => context.environments[0].get("user") ?? null,
    request: (context) => context.environments[0].get("request") ?? null,
    currentPath: (context) => {
      const request = context.environments[0].get("request");
      return request?.path ?? "/";
    },
    autoEncodeRoots: () => {
      const setting = Object.entries(portal.settings ?? {}).find(([name]) => name.toLowerCase() === "site/enabledefaulthtmlencoding")?.[1];
      // Power Pages 9.3.8.x+: escape is applied to user and request output unless disabled.
      return String(setting ?? "").trim().toLowerCase() === "false" ? null : AUTO_ENCODE_ROOTS;
    },
    freshContext: (context) =>
      new LiquidContext(engine, {
        environment: context.environments[0],
        registers: context.registers,
        diagnostics: context.diagnostics,
        state: context.state,
      }),
    siteMarkerUrl: (name) => {
      const target = portal.sitemarkers?.[name];
      return target?.url ?? null;
    },
    async editable(target, key, editOptions, context) {
      const editType = editOptions.type == null ? "html" : formatItem(editOptions.type);
      const escape = editOptions.escape === true || String(editOptions.escape ?? "").toLowerCase() === "true";
      const liquidEnabled = !(editOptions.liquid === false || String(editOptions.liquid ?? "").toLowerCase() === "false");
      const tag = editOptions.tag == null ? "div" : formatItem(editOptions.tag);
      const cssClass = editOptions.class == null ? null : formatItem(editOptions.class);
      const defaultValue = editOptions.default == null ? null : formatItem(editOptions.default);
      const render = async (value) => (liquidEnabled ? renderNested(engine, value, context) : value);
      if (target instanceof SnippetsDrop) {
        if (!key) return null;
        const { name, source } = target.rawValue(key);
        if (name === undefined || source == null) {
          // SnippetPlaceHolder: missing snippets keep the editable wrapper.
          return wrapEditable({ value: await render(defaultValue ?? ""), hasValue: defaultValue != null, editType, cssClass, escape, tag });
        }
        // An existing snippet keeps its language context; without a value it is a no-value wrapper
        // (reference-portal, Social Share Widget Code Page Bottom on /contact-us/).
        return wrapEditable({ value: await render(source), hasValue: source !== "", editType, cssClass, escape, tag, languageName: snippetLanguageName(name, context) });
      }
      if (target && typeof target === "object" && target.__liquidEditable === "entity") {
        if (!key) return null;
        let value = target[key] ?? target[key.replace(/^adx_/, "")] ?? null;
        if (target.__isCurrentPage && ["adx_copy", "copy"].includes(key)) {
          const request = context.environments[0].get("request");
          const resolved = resolveObservedPageCopy(value ?? "", {
            pageId: target.id,
            path: request?.path,
            origin: context.environments[0].get("__observationOrigin"),
            profiles: context.environments[0].get("__pageCopyLayouts"),
          });
          value = resolved.source;
          // An observed layout returns the whole live page-copy region; the wrapper is rendered here.
          if (value.startsWith(OBSERVED_PAGE_COPY_PREFIX) && value.endsWith(OBSERVED_PAGE_COPY_SUFFIX))
            value = value.slice(OBSERVED_PAGE_COPY_PREFIX.length, -OBSERVED_PAGE_COPY_SUFFIX.length);
          if (resolved.diagnostic) context.diagnostic(resolved.diagnostic.code, resolved.diagnostic.message);
        }
        // Dataverse stores empty text as null: an empty attribute renders the no-value wrapper.
        const hasValue = value != null && value !== "";
        return wrapEditable({ value: await render(hasValue ? formatItem(value) : (defaultValue ?? "")), hasValue: hasValue || defaultValue != null, editType, cssClass, escape, tag });
      }
      // Web link sets and other editable objects render editing metadata for editors only.
      return null;
    },
  };
  engine.portalHost = portalHost;

  function contextForPage(page, url = "/", extra = {}) {
    const requestUrl = new URL(url, extra.origin ?? "http://localhost");
    const language = requestLanguage(requestUrl, extra);
    const languageId = language.selected?.id ?? null;
    const identity = Object.hasOwn(extra, "user") ? extra.user : options.user;
    const user =
      identity && identity.id === null && !identity.contactId && !identity.authenticated ? null : (identity ?? null);
    const decorate = (base, isCurrent = false) => {
      const p = localizedPage(base, languageId);
      const attributes = {};
      for (const [key, value] of Object.entries(p.metadata ?? {})) {
        if (key.startsWith("_")) continue;
        const target = ENTITY_REFERENCE_FIELDS[key];
        attributes[key] = target && typeof value === "string" ? entityReference(value, target) : liquidValue(value);
      }
      // Enhanced exports name page columns without a prefix; standard Liquid reads adx_* and code
      // written against the enhanced virtual tables reads mspp_*.
      for (const key of Object.keys(attributes))
        if (!/^(?:adx|mspp)_/.test(key))
          for (const prefix of portal.format === "enhanced" ? ["adx_", "mspp_"] : ["adx_"])
            if (!(`${prefix}${key}` in attributes)) attributes[`${prefix}${key}`] = attributes[key];
      const node = {
        ...attributes,
        ...p,
        __liquidEditable: "entity",
        __isCurrentPage: isCurrent,
        logical_name: "adx_webpage",
        adx_webpageid: p.id,
        adx_name: p.name,
        adx_title: p.title,
        adx_copy: p.html,
        adx_summary: p.summary,
        adx_entityform: p.formId ? entityReference(p.formId, "adx_entityform") : null,
        adx_entitylist: p.listId ? entityReference(p.listId, "adx_entitylist") : null,
        adx_webform: p.advancedFormId ? entityReference(p.advancedFormId, "adx_webform") : null,
      };
      Object.defineProperty(node, LIQUID_PROPERTIES, { value: PAGE_PROPERTIES });
      Object.defineProperty(node, LIQUID_HIDDEN, { value: PAGE_HOST_KEYS });
      return node;
    };
    const entityReference = (id, logicalName) => {
      const lower = String(id).toLowerCase();
      const name =
        logicalName === "adx_webpage"
          ? portal.pages.find((p) => p.id === lower)?.name
          : logicalName === "adx_entityform"
            ? portal.forms?.find((f) => f.id === lower)?.name
            : logicalName === "adx_entitylist"
              ? portal.lists?.find((f) => f.id === lower)?.name
              : logicalName === "adx_webform"
                ? portal.advancedForms?.find((f) => f.id === lower)?.name
                : logicalName === "adx_pagetemplate"
                  ? portal.pageTemplates?.find((t) => t.id === lower)?.name
                  : undefined;
      return { id: lower, logical_name: logicalName, name: name ?? null, is_entity_reference: true };
    };
    const current = decorate(page, true);
    current.breadcrumbs = [];
    let parent = portal.pages.find((p) => p.id === page.parentId);
    const seen = new Set();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      current.breadcrumbs.unshift(decorate(parent));
      parent = portal.pages.find((p) => p.id === parent.parentId);
    }
    current.children = portal.pages.filter((p) => p.parentId === page.id).map((p) => decorate(p));
    const pathAndQuery = requestUrl.pathname + requestUrl.search;
    const returnUrl = escapeDataString(pathAndQuery);
    const website = {
      ...Object.fromEntries(Object.entries(portal.website ?? {}).map(([k, v]) => [k, liquidValue(v)])),
      ...Object.fromEntries(
        Object.entries(portal.website ?? {})
          .filter(([k]) => k.startsWith("adx_"))
          .map(([k, v]) => [k.slice(4), liquidValue(v)]),
      ),
      // Unprefixed website columns (enhanced exports, and .powerpages-site exports of either data
      // model) are also readable as adx_*, and as mspp_* on the enhanced data model.
      ...(portal.format === "enhanced" || !Object.keys(portal.website ?? {}).some((k) => k.startsWith("adx_"))
        ? Object.fromEntries(
            Object.entries(portal.website ?? {})
              .filter(([k]) => !/^(?:adx|mspp)_|^_/.test(k) && !["id", "name", "kind"].includes(k))
              .flatMap(([k, v]) => [
                [`adx_${k}`, liquidValue(v)],
                ...(portal.format === "enhanced" ? [[`mspp_${k}`, liquidValue(v)]] : []),
              ]),
          )
        : {}),
      logical_name: "adx_website",
      selected_language: language.selected ? languageDrop(language.selected, language.pathAndQuery) : null,
      languages: language.languages.map((item) => languageDrop(item, language.pathAndQuery)),
      sign_in_url: `/SignIn?returnUrl=${returnUrl}`,
      sign_in_url_substitution: `/SignIn?returnUrl=${returnUrl}`,
      sign_out_url: `/Account/Login/LogOff?returnUrl=${returnUrl}`,
      sign_out_url_substitution: `/Account/Login/LogOff?returnUrl=${returnUrl}`,
    };
    const requestInput = extra.request ?? {};
    const effectiveUrl = (() => {
      try {
        return new URL(requestInput.url ?? requestUrl.href);
      } catch {
        return requestUrl;
      }
    })();
    // Host code reads request.params as a plain object; Liquid sees it as a Hash.
    const params = { ...(requestInput.params ?? Object.fromEntries(effectiveUrl.searchParams)) };
    const rawUrl = effectiveUrl.pathname + effectiveUrl.search;
    const request = {
      ...requestInput,
      url: uriToDisplayString(effectiveUrl.href),
      path: requestInput.path ?? effectiveUrl.pathname,
      path_and_query: rawUrl,
      query: effectiveUrl.search === "?" ? "" : effectiveUrl.search,
      raw_url: httpUtilityUrlEncode(rawUrl),
      raw_url_encode: httpUtilityUrlEncode(rawUrl),
      params,
    };
    const shellProfile = extra.shellProfile ?? options.shellProfile;
    const context = {
      now: extra.now ?? new Date(),
      page: current,
      website,
      user: user ? liquidRecord(user) : null,
      snippets: null,
      settings: new SettingsDrop(portal.settings),
      weblinks: null,
      sitemarkers: null,
      resx: new ResxDrop(language.selected?.code),
      entities: new EntitiesDrop(options.entity, user),
      knowledge: new KnowledgeDrop(options.fetchXml, user),
      uniqueId: new UniqueDrop(),
      // The request's website language for hosts (forms, lists): { id, code, lcid, name, isDefault }.
      __language: language.selected
        ? { id: language.selected.id, code: language.selected.code, lcid: language.selected.lcid ?? null, name: language.selected.displayName, isDefault: Boolean(language.selected.isDefault) }
        : null,
      __diagnostics: [],
      __observationOrigin: extra.observationOrigin ?? options.observationOrigin,
      __pageCopyLayouts: shellProfile?.pageCopyLayouts ?? [],
      ...extra,
    };
    // Anonymous identities are nil in Liquid even when supplied through extra.user.
    context.user = user ? liquidRecord(user, USER_PROPERTIES) : null;
    if (context.user) {
      context.user.roles = (Array.isArray(user.roles) ? user.roles : []).map((r) => (typeof r === "object" && r ? r.name : r));
      // Relationship navigation by schema name: the contact-web role association of the site's
      // data model lists the user's web roles (standard adx_webrole_contact, enhanced
      // powerpagecomponent_mspp_webrole_contact over powerpagecomponent rows).
      const relationship = portal.format === "enhanced" ? "powerpagecomponent_mspp_webrole_contact" : "adx_webrole_contact";
      if (!Object.hasOwn(context.user, relationship)) context.user[relationship] = webRoleRecords(context.user.roles);
    }
    context.request = request;
    // Power Pages exposes the request parameters again as the top-level params object.
    context.params = request.params;
    delete context.languageCode;
    context.snippets = new SnippetsDrop({
      // Snippet values of the selected language win over the import language's values.
      snippets: languageId && portal.snippetTranslations?.[languageId] ? { ...portal.snippets, ...portal.snippetTranslations[languageId] } : portal.snippets,
      engine,
      profiles: shellProfile?.snippetCompositions ?? [],
      origin: extra.observationOrigin ?? options.observationOrigin,
      diagnostics: context.__diagnostics,
    });
    const visible = (p) => !portalField(p.metadata ?? {}, "hiddenfromsitemap", false) && pageAccess(portal, p, identity).allowed;
    const nodes = new Map(portal.pages.map((p) => [p.id, decorate(p)]));
    for (const p of portal.pages) {
      const node = nodes.get(p.id);
      node.parent = nodes.get(p.parentId) ?? null;
      node.entity = { ...node, id: p.id, logical_name: "adx_webpage" };
      node.children = portal.pages.filter((c) => c.parentId === p.id && visible(c)).map((c) => nodes.get(c.id));
    }
    // Shortcuts are sitemap children whose URLs point to existing pages/files;
    // hidden target pages may still be exposed through an authorized shortcut.
    for (const shortcut of portal.shortcuts ?? []) {
      const parentNode = nodes.get(shortcut.parentId);
      const targetPage = portal.pages.find((p) => p.id === shortcut.targetPageId);
      if (!parentNode || !shortcut.url || (!shortcut.disableTargetValidation && targetPage && !pageAccess(portal, targetPage, identity).allowed)) continue;
      // Shortcut names are internal metadata; sitemap navigation exposes Title.
      parentNode.children.push({
        ...shortcut,
        name: shortcut.title,
        internalName: shortcut.name,
        entity: { id: shortcut.id, logical_name: "adx_shortcut" },
        parent: parentNode,
        children: [],
        breadcrumbs: [],
      });
    }
    for (const node of nodes.values())
      node.children.sort(
        (a, b) => Number(a.displayOrder ?? portalField(a.metadata ?? {}, "displayorder", 0)) - Number(b.displayOrder ?? portalField(b.metadata ?? {}, "displayorder", 0)),
      );
    for (const node of nodes.values()) {
      node.breadcrumbs = [];
      let ancestor = node.parent;
      const visited = new Set();
      while (ancestor && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        node.breadcrumbs.unshift(ancestor);
        ancestor = ancestor.parent;
      }
      node.is_sitemap_current = node.id === page.id;
      node.is_sitemap_ancestor = current.breadcrumbs.some((crumb) => crumb.id === node.id);
    }
    current.parent = nodes.get(page.parentId) ?? null;
    current.children = nodes.get(page.id)?.children ?? [];
    current.entity = { ...current, id: page.id, logical_name: "adx_webpage" };
    current.is_sitemap_current = true;
    current.is_sitemap_ancestor = false;
    // PageDrop: languages lists the published website languages, available_languages those the
    // page has a language content page in.
    current.languages = website.languages;
    current.available_languages = language.languages
      .filter((item) => Object.hasOwn(page.translations ?? {}, item.id))
      .map((item) => languageDrop(item, language.pathAndQuery));
    context.sitemap = {
      root: nodes.get(portal.pages.find((p) => p.url === "/")?.id) ?? current,
      current: nodes.get(page.id),
      ancestors: current.breadcrumbs,
      ...Object.fromEntries(
        portal.pages.flatMap((p) => [
          [p.url, nodes.get(p.id)],
          [p.url.replace(/\/$/, ""), nodes.get(p.id)],
        ]),
      ),
    };
    context.sitemarkers = Object.fromEntries(
      Object.entries(portal.sitemarkers ?? {}).map(([name, target]) => [name, target?.id ? { ...nodes.get(target.id), url: target.url } : target?.url ? { url: target.url } : null]),
    );
    context.weblinks = buildWeblinks(identity, page, languageId);
    // Community objects over exported adx_poll*/adx_ad* records (Adxstudio PollsDrop/AdsDrop).
    context.polls ??= createPollsDrop(portal, { now: context.now });
    context.ads ??= createAdsDrop(portal, { now: context.now });
    return context;
  }
  function buildWeblinks(identity, page, languageId = null) {
    const link = (item) => {
      const metadata = item.metadata ?? {};
      const target = item.pageId ? portal.pages.find((p) => p.id === item.pageId) : null;
      const imageUrl = portalField(metadata, "imageurl");
      return {
        ...Object.fromEntries(Object.entries(metadata).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, liquidValue(v)])),
        id: item.id,
        logical_name: "adx_weblink",
        name: item.name,
        url: item.url ?? null,
        description: item.description || null,
        display_image_only: Boolean(portalField(metadata, "displayimageonly", false)),
        display_page_child_links: Boolean(item.display_page_child_links),
        image: imageUrl
          ? { url: imageUrl, alternate_text: portalField(metadata, "imagealttext") ?? null, width: portalField(metadata, "imagewidth") ?? null, height: portalField(metadata, "imageheight") ?? null }
          : null,
        is_external: Boolean(portalField(metadata, "externalurl")),
        nofollow: !portalField(metadata, "robotsfollowlink", true),
        open_in_new_window: Boolean(item.open_in_new_window),
        Open_In_New_Window: Boolean(item.open_in_new_window),
        tooltip: item.name,
        is_sitemap_current: Boolean(target && target.id === page.id),
        is_sitemap_ancestor: Boolean(target && target.id !== page.id && normalizePortalPath(page.url).startsWith(normalizePortalPath(target.url))),
        weblinks: (item.weblinks ?? []).filter(allowed).map(link),
      };
    };
    // Web links to pages the current identity cannot read are omitted (CMS security provider).
    const allowed = (item) => {
      if (!item.pageId || item.disable_page_validation) return true;
      const target = portal.pages.find((p) => p.id === item.pageId);
      return !target || pageAccess(portal, target, identity).allowed;
    };
    const convert = (set) => ({
      id: set.id,
      name: set.name,
      logical_name: "adx_weblinkset",
      title: set.title ?? null,
      copy: set.copy ?? null,
      editable: false,
      weblinks: (set.weblinks ?? []).filter(allowed).map(link),
    });
    // Every active set is reachable by ID (portal.weblinkSets lists same-name sets too); the
    // name map holds the set a name selects (WebLinkSetDataAdapter: first active set). Sites with
    // website languages select the sets of the request's language (adx_websitelanguageid); sets
    // without a language apply to every language.
    const wanted = languageId ? String(languageId).toLowerCase() : null;
    const inLanguage = (set) => {
      if (!wanted) return true;
      const language = weblinkSetLanguages().get(String(set?.id ?? "").toLowerCase());
      return !language || language === wanted;
    };
    const all = new Map();
    for (const set of [...(portal.weblinkSets ?? []), ...Object.values(portal.weblinks ?? {})])
      if (set?.id != null && inLanguage(set) && !all.has(String(set.id).toLowerCase())) all.set(String(set.id).toLowerCase(), convert(set));
    const byName = {};
    for (const set of portal.weblinkSets ?? [])
      if (set?.name != null && !Object.hasOwn(byName, set.name) && all.has(String(set.id ?? "").toLowerCase())) byName[set.name] = all.get(String(set.id).toLowerCase());
    for (const [name, set] of Object.entries(portal.weblinks ?? {}))
      if (!Object.hasOwn(byName, name) && inLanguage(set)) byName[name] = all.get(String(set.id ?? "").toLowerCase()) ?? convert(set);
    return new WebLinkSetsDrop(byName, all);
  }
  /** Web link set id -> website language id (lower case), from the exported set records. */
  let weblinkSetLanguageMap = null;
  function weblinkSetLanguages() {
    if (weblinkSetLanguageMap) return weblinkSetLanguageMap;
    weblinkSetLanguageMap = new Map();
    for (const record of portal.records ?? []) {
      if (record.kind !== "weblinkset") continue;
      const value = portalField(record, "websitelanguageid");
      const language = String(value?.id ?? value ?? "").replace(/[{}]/g, "").toLowerCase();
      if (language) weblinkSetLanguageMap.set(String(record.id).toLowerCase(), language);
    }
    return weblinkSetLanguageMap;
  }
  /** Build a LiquidContext over a plain context object (contextForPage output or test data). */
  function liquidContextFor(context) {
    if (context instanceof LiquidContext) return context;
    const environment = { ...(context ?? {}) };
    const diagnostics = Array.isArray(environment.__diagnostics) ? environment.__diagnostics : [];
    const hashes = new Map();
    const asHash = (value) => {
      if (value instanceof LiquidHash || value == null || typeof value !== "object") return value;
      if (!hashes.has(value)) hashes.set(value, new LiquidHash(value));
      return hashes.get(value);
    };
    // request.params and params are the same Hash (RequestDrop.Params).
    if (environment.request && typeof environment.request === "object" && environment.request.params)
      environment.request = { ...environment.request, params: asHash(environment.request.params) };
    environment.params = environment.params ? asHash(environment.params) : (environment.request?.params ?? null);
    return new LiquidContext(engine, { environment, diagnostics });
  }
  async function renderSource(source, context) {
    const liquidContext = liquidContextFor(context);
    let template;
    try {
      template = engine.parse(source ?? "");
    } catch (error) {
      if (!(error instanceof LiquidSyntaxError)) throw error;
      // InternalRenderLiquid: a template that fails to parse renders the bare message.
      liquidContext.diagnostic("liquid-syntax-error", error.message);
      return error.message;
    }
    return template.render(liquidContext);
  }
  async function renderString(source, context = {}) {
    return renderSource(source, context);
  }
  async function renderPage(url, extra = {}) {
    // A language code that starts the path selects the language and is not part of the page URL.
    const target = requestLanguage(new URL(url, extra.origin ?? "http://localhost"), extra);
    const found = portal.pages.find((p) => normalizePortalPath(p.url) === normalizePortalPath(target.path));
    if (!found) return { html: "<h1>Page not found</h1>", status: 404, page: null, diagnostics: [] };
    const context = contextForPage(found, url, extra);
    const page = localizedPage(found, context.__language?.id);
    const diagnostics = context.__diagnostics;
    try {
      const pageTemplate = portal.pageTemplates.find((t) => t.id === page.pageTemplateId);
      const template = portal.templates[pageTemplate?.webTemplateId];
      if (pageTemplate?.webTemplateId && !template)
        diagnostics.push({ code: "missing-page-template", message: `Web template ${pageTemplate.webTemplateId} is absent` });
      // Legacy ASPX page templates render their WebForms layout with the page's attached
      // advanced form, basic form and list (lib/platform-manifest.mjs, agent C).
      const rewriteLayout = template ? null : rewritePageLayout(page, pageTemplate);
      const body = await renderSource(template ? template.source : (rewriteLayout?.source ?? "{% include 'Page Copy' %}"), context);
      const css = page.css ? `<style>${await renderSource(page.css, context)}</style>` : "";
      const js = page.js ? `<script>${await renderSource(page.js, context)}</script>` : "";
      if (pageTemplate?.useHeaderFooter === false) {
        const mime = String(portalField(template?.metadata ?? {}, "mimetype", "text/html")).replace(/;\s*$/, "");
        return {
          html: body + css + js,
          status: 200,
          page,
          diagnostics,
          contentType: `${mime}${mime.includes("charset=") ? "" : "; charset=utf-8"}`,
          isDocument: isHtmlDocument(body),
        };
      }
      const header = portal.templates[portalField(portal.website, "headerwebtemplateid")];
      const footer = portal.templates[portalField(portal.website, "footerwebtemplateid")];
      let renderedHeader = header ? await renderSource(header.source, context) : "";
      const shellProfile = extra.shellProfile ?? options.shellProfile;
      const observedNotifications = shellProfile?.headerNotifications;
      if (header && observedNotifications && context.user) {
        // The data pack serving this portal names the query template (shell.headerNotificationQuery).
        const notificationTemplate = headerNotificationQueries()
          .map((name) => portal.templates[name])
          .find(Boolean);
        if (!notificationTemplate) {
          diagnostics.push({
            code: "HEADER_NOTIFICATION_QUERY_MISSING",
            message: "The observed header notifications need the notification query that a data pack names (shell.headerNotificationQuery); the export has none of the named templates.",
          });
        } else {
          const payload = JSON.parse(await renderSource(notificationTemplate.source, context));
          if (!Array.isArray(payload.notifications)) throw new Error("The exported header notification query did not return a notifications array.");
          const reconciled = reconcileHeaderNotifications(renderedHeader, header.source, observedNotifications, {
            origin: extra.observationOrigin ?? options.observationOrigin,
            notifications: notificationVisibility(payload.notifications, {
              surface: "header",
              pathname: new URL(url, "http://localhost").pathname,
              user: context.user,
            }),
          });
          renderedHeader = reconciled.html;
          if (reconciled.diagnostic) diagnostics.push(reconciled.diagnostic);
        }
      }
      let renderedFooter = footer ? await renderSource(footer.source, context) : "";
      const observedLogos = shellProfile?.footerLogos;
      if (footer && observedLogos) {
        const styleSources = {};
        const layoutPath = observedLogos.layout?.path;
        const stylesheet = layoutPath && portal.webFiles.find((file) => file.url === layoutPath);
        if (stylesheet?.file)
          try {
            styleSources[layoutPath] = await fs.readFile(stylesheet.file, "utf8");
          } catch {}
        const reconciled = reconcileFooterLogos(renderedFooter, footer.source, observedLogos, {
          styleSources,
          origin: extra.observationOrigin ?? options.observationOrigin,
        });
        renderedFooter = reconciled.html;
        if (reconciled.diagnostic) diagnostics.push(reconciled.diagnostic);
      }
      const cssNames = options.shellStyles ?? ["bootstrap.min.css", "portalbasictheme.css", "theme.css"];
      const assets = (names, type) =>
        names
          .map((name) => portal.webFiles.find((f) => f.url.split("/").at(-1)?.toLowerCase() === name.toLowerCase()))
          .filter(Boolean)
          .map((f) => (type === "css" ? `<link rel="stylesheet" href="${htmlEscape(f.url)}">` : `<script src="${htmlEscape(f.url)}"></script>`))
          .join("\n");
      const urls = (paths, type) => (paths ?? []).map((value) => renderShellResource(value, type)).join("\n");
      const contentStyles = shellProfile?.stylesheets || options.shellStyles ? null : await contentStylesheets(page, context);
      // Platform shell (lib/platform-manifest.mjs, agent C): the ResourceManager script and
      // the platform bundles in live document order, in the Bootstrap 3 or 5 build that
      // Site/BootstrapV5Enabled selects. jQuery, moment and the compatibility adapters come
      // from the bundles' local equivalents. A captured shell supplies the deployed bundle
      // names; its other resources stay in their lists.
      const platform = platformShell({
        variant: bootstrapVariant(portal.settings),
        profile: shellProfile,
        websiteId: portal.website?.id,
        languageCode: layoutLanguageCode(context),
        bootstrap: options.shellStyles ? assets(cssNames, "css") : contentStyles ? contentStyles.bootstrap || PLATFORM_BOOTSTRAP_STYLESHEET : "",
        renderStyles: (paths) => urls(paths, "css"),
      });
      const configuredHeadScripts = shellProfile ? platform.remaining.headScripts : (options.shellScripts ?? []);
      const siteStyles = shellProfile?.stylesheets ? urls(platform.remaining.stylesheets, "css") : (contentStyles?.content ?? "");
      const shellHeadScripts = urls(configuredHeadScripts, "js");
      const shellBeforeContentScripts = urls(platform.remaining.beforeContentScripts, "js");
      const shellAfterFooterScripts = urls(platform.remaining.afterFooterScripts, "js");
      const head = await renderSource(portal.snippets["Head/Bottom"] ?? "", context);
      const titleSuffix = await renderSource(portal.snippets["Browser Title Suffix"] ?? "", context);
      // Preserve authored text entities, while encoding literal markup delimiters.
      const encodedSuffix = htmlEscape(titleSuffix).replace(/&amp;(#x[\da-f]+|#\d+|[a-z][\w]+);/gi, "&$1;");
      // Web templates own their content structure, including main landmarks.
      const content = template ? body : `<main id="mainContent">${body}</main>`;
      // Native platform regions (lib/platform-manifest.mjs, agent C): WebForms form and AXD
      // scripts only on form pages; chrome markup around the header, content and footer.
      const nativeRegions = nativePageRegions({
        content,
        action: url,
        bodyScripts: platform.remaining.bodyScripts,
        renderScripts: (paths) => urls(paths, "js"),
        authenticated: Boolean(context.user),
        serverFormId: rewriteLayout?.serverFormId ?? null,
      });
      const languageCode = layoutLanguageCode(context);
      const direction = /^(ar|fa|he|ur)(-|$)/i.test(languageCode) ? "rtl" : "ltr";
      const bodyAttributes = layoutBodyAttributes(page, context);
      const htmlAttributes = layoutHtmlAttributes(languageCode, context.__language?.lcid);
      // The footer-spacing adapter is a script element; authored footer markup is not modified.
      const html = injectRuntimeCompatibility(
        `<!DOCTYPE html><html lang="${htmlEscape(languageCode)}" dir="${direction}"${htmlAttributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(page.title)}${encodedSuffix ? ` ${encodedSuffix}` : ""}</title>${platform.headStart}${siteStyles}${shellHeadScripts}${css}${head}${extra.headHtml ?? ""}${platform.headEnd}</head><body${bodyAttributes}>${OFFLINE_NOTIFICATION_BAR}${renderedHeader}${antiForgeryHolder()}${platform.bodyStart}${shellBeforeContentScripts}${nativeRegions.content}${nativeRegions.bodyScripts}${platform.afterContent}${renderedFooter}${shellAfterFooterScripts}${platform.afterFooter}${js}${extra.bodyHtml ?? ""}</body></html>`,
        { ...(options.sourceDependencies ?? {}), footerSpacing: Boolean(footer) || options.sourceDependencies?.footerSpacing },
        configuredHeadScripts,
      );
      return { html, status: 200, page, diagnostics, contentType: "text/html; charset=utf-8", isDocument: true };
    } catch (error) {
      let original = error;
      const seen = new Set();
      while (original && !seen.has(original)) {
        seen.add(original);
        const nested = original.originalError ?? original.cause;
        if (!nested) break;
        original = nested;
      }
      const status = Number(original?.status ?? original?.statusCode);
      diagnostics.push({ code: original?.code ?? "liquid-render-error", message: error.message });
      return {
        html: `<!DOCTYPE html><h1>Portal rendering failed</h1><pre>${htmlEscape(error.message)}</pre>`,
        status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
        page,
        diagnostics,
      };
    }
  }
  /**
   * Language attributes of the platform layout's <html>: crm-lang and data-lang carry the current
   * language code, crm-lcid the LCID of the request's website language (else the website language
   * LCID), same-site-mode the session cookie mode (None on every observed site).
   */
  function layoutHtmlAttributes(languageCode, languageLcid) {
    const lcid = Number(languageLcid ?? portalField(portal.website ?? {}, "website_language") ?? 1033) || 1033;
    return ` crm-lang="${htmlEscape(languageCode)}" crm-lcid="${lcid}" data-lang="${htmlEscape(languageCode)}" same-site-mode="None"`;
  }
  const styleTimes = new Map();
  /** Epoch milliseconds (whole seconds) of a web file's modification, the live cache-busting query. */
  async function webFileTimestamp(file) {
    const modified = portalField(file.metadata ?? {}, "modifiedon");
    if (modified && !Number.isNaN(Date.parse(modified))) return Math.floor(Date.parse(modified) / 1000) * 1000;
    if (!file.file) return null;
    if (!styleTimes.has(file.file))
      styleTimes.set(
        file.file,
        fs.stat(file.file).then(
          (stat) => Math.floor(stat.mtimeMs / 1000) * 1000,
          () => null,
        ),
      );
    return styleTimes.get(file.file);
  }
  /**
   * Content stylesheets of the platform layout (Adxstudio StyleExtensions.ContentStyles): active
   * web files whose partial URL ends with ".css" and whose parent is the page or one of its
   * ancestors, root first, then by display order. bootstrap.min.css is linked first on its own:
   * the Head/Bootstrap snippet when it exists, else the content style of that name (the platform
   * default /css/bootstrap.min.css is the platform bundle slot's). Every web file href carries
   * its modification time.
   */
  async function contentStylesheets(page, context) {
    const path = [];
    const visited = new Set();
    for (let current = page; current && !visited.has(current.id); current = portal.pages.find((p) => p.id === current.parentId)) {
      visited.add(current.id);
      path.push(String(current.id).toLowerCase());
    }
    const parentOf = (file) => {
      const parent = portalField(file.metadata ?? {}, "parentpageid");
      return String((parent && typeof parent === "object" ? parent.id : parent) ?? "").replace(/[{}]/g, "").toLowerCase();
    };
    const styles = (portal.webFiles ?? [])
      .map((file, index) => ({
        file,
        index,
        offset: path.indexOf(parentOf(file)),
        partial: String(portalField(file.metadata ?? {}, "partialurl") ?? "").replace(/^\/+/, ""),
        order: Number(portalField(file.metadata ?? {}, "displayorder") ?? 0) || 0,
        name: String(file.name ?? ""),
      }))
      .filter((entry) => entry.offset >= 0 && entry.partial.endsWith(".css"))
      // The platform keeps record (creation) order, which exports do not carry; locally the
      // order is deterministic: page path root first, then display order, then name.
      .sort((a, b) => b.offset - a.offset || a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.index - b.index);
    const link = async (entry) => {
      const stamp = await webFileTimestamp(entry.file);
      return `<link href="${htmlEscape(stamp == null ? entry.file.url : `${entry.file.url}?${stamp}`)}" rel="stylesheet" />`;
    };
    const isBootstrap = (entry) => entry.partial.toLowerCase() === "bootstrap.min.css";
    const bootstrapSnippet = portal.snippets?.["Head/Bootstrap"];
    // Which Bootstrap the layout links is a per-site observation (observed.bootstrapStylesheet:
    // reference-portal reference-site-A links the platform's although it exports a bootstrap.min.css under the home
    // page, reference-site-B its web file); the default is the web file when the home page has one.
    const homeHasBootstrap = styles.some((entry) => entry.offset === path.length - 1 && isBootstrap(entry));
    const bootstrapMode = portal.observed?.bootstrapStylesheet ?? (homeHasBootstrap ? "web-file" : "platform");
    const bootstrapFile = bootstrapMode === "web-file" ? styles.find(isBootstrap) : null;
    // Otherwise the platform's /css/bootstrap.min.css applies; it belongs to the platform bundle
    // slot (lib/platform-manifest.mjs), which serves captured or local bytes, so this slot is empty.
    const bootstrap = bootstrapSnippet != null ? String(bootstrapSnippet) : bootstrapFile ? await link(bootstrapFile) : "";
    const content = [];
    for (const entry of styles) if (!isBootstrap(entry)) content.push(await link(entry));
    return { bootstrap, content: content.join("") };
  }
  /** Exported, active web role records for role names, as entity objects of the site's data model. */
  function webRoleRecords(roleNames) {
    const wanted = new Set(roleNames.map((name) => String(name ?? "").trim().toLowerCase()));
    const enhanced = portal.format === "enhanced";
    return (portal.records ?? [])
      .filter((record) => record.kind === "webrole" && Number(record.statecode ?? 0) === 0 && wanted.has(String(record.name ?? "").trim().toLowerCase()))
      .map((record) => {
        const attributes = Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("_") && key !== "kind"));
        return liquidRecord(
          enhanced
            ? { ...attributes, powerpagecomponentid: record.id, name: record.name, powerpagecomponenttype: 11, id: record.id, logical_name: "powerpagecomponent" }
            : { ...attributes, adx_webroleid: record.id, adx_name: record.name, id: record.id, logical_name: "adx_webrole" },
        );
      });
  }
  /**
   * Attributes of the platform layout's <body> (Default.master): the site map state of the
   * current page and its ancestors, the DateTime/* site settings (en-US defaults), the
   * application path, the CKEditor base path and the portal search service URL.
   */
  function layoutBodyAttributes(page, context) {
    const setting = (name) => {
      const entry = Object.entries(portal.settings ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
      return entry && entry[1] != null && String(entry[1]) !== "" ? String(entry[1]) : null;
    };
    const dateFormat = setting("DateTime/DateFormat") ?? "M/d/yyyy";
    const timeFormat = setting("DateTime/TimeFormat") ?? "h:mm tt";
    const ancestors = [...(context.page?.breadcrumbs ?? [])].reverse().map((node) => node?.url).filter(Boolean);
    const attributes = {
      "data-sitemap-state": [page.url, ...ancestors].join(":"),
      "data-dateformat": dateFormat,
      "data-timeformat": timeFormat,
      "data-datetimeformat": setting("DateTime/DateTimeFormat") ?? `${dateFormat} ${timeFormat}`,
      "data-app-path": "/",
      // The platform's rich-text designer path (lib/platform-manifest.mjs, observed on reference-portal).
      "data-ckeditor-basepath": CKEDITOR_BASEPATH,
      "data-case-deflection-url": `/_services/search/${String(portal.website?.id ?? "").toLowerCase()}`,
    };
    return Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${htmlEscape(value)}"`)
      .join("");
  }
  /** Parse every exported web template, snippet and page source with the Power Pages grammar. */
  function inspectCapabilities() {
    const diagnostics = [];
    const templates = new Set(Object.values(portal.templates ?? {}));
    for (const template of templates) {
      try {
        engine.parse(template.source ?? "");
      } catch (error) {
        diagnostics.push({ code: "template-parse-error", templateId: template.id, name: template.name, message: error.message });
      }
    }
    return { templateCount: templates.size, parsePassed: templates.size - diagnostics.length, diagnostics };
  }
  return { engine, renderString, renderPage, contextForPage, requestLanguage, inspectCapabilities };
}
const AUTO_ENCODE_ROOTS = new Set(["user", "request"]);

/** weblinks['Set name'] or weblinks['<set guid>']. */
/** WebLinkSetsDrop: a GUID key selects any active set by ID, other keys the set a name selects. */
class WebLinkSetsDrop extends LiquidDrop {
  constructor(byName, byId = new Map()) {
    super();
    this.sets = byName;
    this.byId = byId;
  }
  liquidGet(key) {
    const text = String(key ?? "");
    if (GUID_KEY.test(text.trim())) return this.byId.get(text.trim().replace(/[{}]/g, "").toLowerCase()) ?? null;
    return Object.hasOwn(this.sets, text) ? this.sets[text] : null;
  }
}
export { SnippetsDrop, EntitiesDrop, KnowledgeDrop, isEnumerable, toList };
