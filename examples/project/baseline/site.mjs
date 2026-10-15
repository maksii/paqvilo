#!/usr/bin/env node
// Baseline Power Pages fixture site: writes an upload-ready PAC site folder that contains only the
// baseline records (pages under /baseline/, basic forms and metadata, lists, multistep forms,
// table permissions, web roles, a page rule, site settings, page/web templates) plus the existing
// website and language records. Layout and field names follow a PAC export of the target site; ids
// derive from names, so reruns produce identical bytes.
//
//   node examples/project/baseline/site.mjs [--identity FILE] [--out DIR] [--manifest FILE]
//
// Defaults: the demo identity (site-identity.json next to this file), site/ and site-manifest.json
// next to this file; with --out, the manifest defaults to site-manifest.json beside DIR.
//
// Catalog citations: every record cites the catalog items its columns and choice values exercise
// (derived from the catalog's `field`/`values` by `derivedIds`, so the mapping cannot drift), plus
// hand-cited items for JSON settings, Liquid and behaviour without a column. A boolean exercises an
// item when it is true, or when it is false and the catalog states the default is true (false is
// then the configured, non-default state). Items the export cannot express, or that would change the
// shared site outside /baseline/, are listed in `notExpressed`; facts without a configurable value in
// `documentationOnly`; open questions about exercised items in `caveats`. Nothing here changes the
// site's existing records (website, roles, templates, settings, snippets).
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { guid, VIEWS as OWN_VIEWS, PLATFORM_VIEW_ADJUSTMENTS } from "./generate.mjs";
import { ids as DATA } from "./data.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const CATALOG = fileURLToPath(import.meta.resolve("paqvilo/mirage/docs/baseline/catalog/power-pages.json"));
const CATALOG_ITEMS = JSON.parse(readFileSync(CATALOG, "utf8")).items;

// Site identity: the target site's existing records the fixture points at (website, language,
// publishing state, home page, the page template for page copy, header/footer web templates). Read
// from a JSON file so no site-bound id lives in this generator; every fixture record id derives from
// guid('site:…') and is independent of it.
export const DEFAULT_IDENTITY = path.join(root, "site-identity.json");
const IDENTITY_KEYS = ["websiteId", "websiteName", "languageId", "publishingStateId", "rootParentPageId", "pageTemplateId", "headerWebTemplateId", "footerWebTemplateId"];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readIdentity(file = DEFAULT_IDENTITY) {
  const identity = JSON.parse(readFileSync(file, "utf8"));
  for (const key of IDENTITY_KEYS) {
    if (typeof identity[key] !== "string" || !identity[key]) throw new Error(`${file}: ${key} is required`);
    if (key !== "websiteName" && !GUID.test(identity[key])) throw new Error(`${file}: ${key} is not a GUID`);
  }
  return identity;
}
function siteRecords(identity) {
  const WEBSITE = {
    adx_defaultbotconsumerid: "",
    adx_defaultlanguage: identity.languageId,
    adx_enhancedauthorization: 0,
    adx_footerwebtemplateid: identity.footerWebTemplateId,
    adx_headerwebtemplateid: identity.headerWebTemplateId,
    adx_name: identity.websiteName,
    adx_parentwebsiteid: identity.parentWebsiteId ?? identity.websiteId,
    adx_website_language: 1033,
    adx_websiteid: identity.websiteId,
  };
  const LANGUAGE = { adx_name: "English", adx_portallanguageid: identity.portalLanguageId ?? identity.languageId, adx_publishingstate: identity.publishingStateId, adx_websitelanguageid: identity.languageId };
  return { WEBSITE, LANGUAGE, LANGUAGE_ID: identity.languageId, PUBLISHED: identity.publishingStateId, HOME: identity.rootParentPageId, TEMPLATE: identity.pageTemplateId };
}

// 1x1 transparent PNG: the map lists' pushpin web file (fixed bytes, so reruns stay identical).
const PUSHPIN_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const ITEM = "pqvd_baselineitem";
const PARENT = "pqvd_baselineparent";
const CHILD = "pqvd_baselinechild";
const id = (name) => guid(`site:${name}`);
// Fixture views plus the platform views (lookup, associated, quick find) whose definitions generate.mjs adjusts.
const VIEWS = [...OWN_VIEWS, ...(PLATFORM_VIEW_ADJUSTMENTS ?? [])];
const view = (file) => VIEWS.find((v) => v.file === file).id;
const label = (value) => [{ LCID: 1033, Value: value }];
const res = (value) => [{ Type: "LanguageResources", LCID: 1033, Value: value }];
const json = (value) => ({ json: value });
const unique = (list) => [...new Set(list)];
const metaKey = (values) => values.adx_attributelogicalname ?? values.adx_sectionname ?? values.adx_tabname ?? values.adx_subgrid_name ?? ({ 100000005: "notes", 756150000: "timeline" })[values.adx_type] ?? "metadata";

// ---------------------------------------------------------------------------
// Catalog index: a record's columns and choice values select the catalog items it exercises.
// ---------------------------------------------------------------------------
const KIND_PREFIXES = {
  basicform: ["pp.basicform."],
  basicformmetadata: ["pp.bfmeta."],
  list: ["pp.list.", "pp.listfilter."],
  advancedform: ["pp.msform."],
  advancedformstep: ["pp.msstep."],
  advancedformmetadata: ["pp.msmeta."],
  tablepermission: ["pp.tableperm."],
  webrole: ["pp.webrole."],
  sitesetting: ["pp.sitesetting.", "pp.webapi."],
  pagetemplate: ["pp.template.pagetemplate."],
  webtemplate: ["pp.template.webtemplate."],
  website: ["pp.template.website."],
  webpagerule: ["pp.pagerule."],
  contentsnippet: ["pp.contentsnippet."],
  webfile: ["pp.webfile."],
};
// JSON columns: their inner items are cited by hand next to the JSON that sets them.
const JSON_COLUMNS = new Set(["adx_settings", "adx_subgrid_settings", "adx_notes_settings", "adx_timeline_settings", "adx_filter_definition"]);
const FIELD_ITEMS = new Map();
const SETTING_ITEMS = [];
for (const item of CATALOG_ITEMS) {
  const column = /^([a-z][a-z0-9_]*)(?: |$)/.exec(item.field)?.[1];
  if (column && !JSON_COLUMNS.has(column)) FIELD_ITEMS.set(column, [...(FIELD_ITEMS.get(column) ?? []), item]);
  const setting = /^(\S+) \(mspp_sitesetting name\)$/.exec(item.field)?.[1];
  if (setting) SETTING_ITEMS.push({ item, id: item.id, pattern: new RegExp(`^${setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("<table-name>", "[^/]+")}$`, "i") });
}
const BFMETA_TYPE = Object.fromEntries(CATALOG_ITEMS.filter((item) => /^pp\.bfmeta\.type\.[a-z]+$/.test(item.id)).map((item) => [Number(item.values[0].split("=")[1]), item.id.split(".").pop()]));
const BFMETA_SCOPES = new Set(Object.values(BFMETA_TYPE));
const isBoolean = (item) => item.values.length > 0 && item.values.every((v) => /^(true|false)$/.test(v));
const defaultTrue = (item) => /default(?:value)?:?\s*(?:is\s*)?(?:true|yes)\b/i.test(item.notes ?? "");
function valueMatches(item, value) {
  if (isBoolean(item)) return String(value).toLowerCase() === "true" || defaultTrue(item);
  const codes = item.values.map((v) => /=(-?\d+)$/.exec(v)?.[1]);
  if (!codes.length || codes.some((code) => code === undefined)) return true; // free text, names
  return codes.map(Number).includes(Number(value));
}
/** Catalog ids exercised by the columns (and choice values) a record of `kind` sets. */
export function derivedIds(kind, values) {
  const prefixes = KIND_PREFIXES[kind] ?? [];
  const out = [];
  for (const [column, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null) continue;
    // Description position renders only with Add Description (catalog: "Requires Add Description").
    if (column === "adx_descriptionposition" && values.adx_adddescription !== true) continue;
    for (const item of FIELD_ITEMS.get(column) ?? []) {
      if (!prefixes.some((prefix) => item.id.startsWith(prefix))) continue;
      const scope = item.id.split(".")[2];
      if (kind === "basicformmetadata" && BFMETA_SCOPES.has(scope) && scope !== BFMETA_TYPE[values.adx_type]) continue;
      if (valueMatches(item, value)) out.push(item.id);
    }
  }
  if (kind === "sitesetting") for (const { item, id: itemId, pattern } of SETTING_ITEMS) if (pattern.test(values.adx_name) && valueMatches(item, values.adx_value)) out.push(itemId);
  return out;
}
/** Every catalog id under `prefix`; of the `.size.<value>` members only `size`. */
const family = (prefix, size) => CATALOG_ITEMS.map((item) => item.id).filter((itemId) => itemId.startsWith(prefix) && (!/\.size\.[a-z]+$/.test(itemId) || itemId.endsWith(`.size.${size}`)));
const LIQUID_TAGS = ["entityform", "webform", "entitylist", "entityview", "include", "extends", "block", "fetchxml", "editable"];
const liquidIds = (copy) => [
  ...[...copy.matchAll(new RegExp(`\\{%-?\\s*(${LIQUID_TAGS.join("|")})\\b`, "g"))].flatMap((m) => [`pp.template.liquid.${m[1]}`, ...(m[1] === "webform" ? ["pp.msform.liquid"] : [])]),
  ...(/\{\{-?\s*snippets\[/.test(copy) ? ["pp.template.liquid.snippets"] : []),
  ...(/\{%-?\s*entitylist\s+name:/.test(copy) ? ["pp.list.name"] : []),
];

// ---------------------------------------------------------------------------
// YAML in the PAC export style: sorted keys, `>-` blocks for JSON, `- ` lists.
// ---------------------------------------------------------------------------
function scalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (text === "") return "";
  const plain = /^[A-Za-z0-9_/][A-Za-z0-9 _./,()*:-]*$/.test(text) && !/ $|:( |$)/.test(text) && !/^(true|false|null|~|yes|no|on|off|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(text);
  return plain ? text : `'${text.replace(/'/g, "''")}'`;
}
function mapping(record, indent) {
  const pad = " ".repeat(indent);
  return Object.keys(record)
    .filter((key) => record[key] !== undefined && record[key] !== null)
    .sort()
    .map((key) => {
      const value = record[key];
      if (Array.isArray(value)) return `${key}:\n${value.map((v) => `${pad}- ${scalar(v)}`).join("\n")}`;
      if (value && typeof value === "object" && "json" in value)
        return `${key}: >-\n${JSON.stringify(value.json, null, 2).split("\n").map((line) => `${pad}  ${line}`).join("\n")}`;
      const text = scalar(value);
      return text === "" ? `${key}: ` : `${key}: ${text}`;
    })
    .map((line, index) => (index === 0 ? line : pad + line))
    .join("\n");
}
const yamlRecord = (record) => mapping(record, 0) + "\n";
const yamlList = (records) => records.map((record) => `- ${mapping(record, 2)}`).join("\n") + "\n";
const fileName = (name) => name.replace(/[\\/:*?"<>|]/g, "").replace(/ /g, "-");
const slug = (name) => fileName(name).toLowerCase();
const script = (name) => `document.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.baselineScript=${JSON.stringify(name)};});\n`;

// Dialog settings (modal size: Default=0, Large=1, Small=2, the catalog's value order).
const SIZE = { default: 0, large: 1, small: 2 };
const dialog = (type, title, size = "default", extra = {}) => ({
  Type: type, LoadingMessage: res(`Loading ${title.toLowerCase()}...`), Title: res(title), PrimaryButtonText: res("OK"), CloseButtonText: res("Close"), DismissButtonSrText: res("Close dialog"),
  Size: SIZE[size], CssClass: "baseline-dialog", TitleCssClass: "baseline-dialog-title", PrimaryButtonCssClass: "btn btn-primary", CloseButtonCssClass: "btn btn-default", ...extra,
});
// Notes dialogs carry no Type discriminator in exported settings (PAC rejects unknown Type values).
const untypedDialog = (...args) => { const { Type, ...rest } = dialog(...args); return rest; };
const gridMessages = (what) => ({ LoadingMessage: res(`Loading ${what}...`), ErrorMessage: res(`Could not load ${what}.`), AccessDeniedMessage: res(`You do not have access to ${what}.`), EmptyMessage: res(`No ${what}.`), CssClass: "baseline-grid", GridCssClass: "table-striped" });

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
export function buildSite(identity = readIdentity()) {
  const { WEBSITE, LANGUAGE, LANGUAGE_ID, PUBLISHED, HOME, TEMPLATE } = siteRecords(identity);
  const files = new Map();
  const records = [];
  const put = (relative, content) => files.set(relative.split(path.sep).join("/"), content);
  const record = (kind, recordId, name, variation, catalog, extra = {}, values = {}) => records.push({ id: recordId, kind, name, ...extra, ...(values.adx_entityname ? { table: values.adx_entityname } : {}), variation, catalog: unique([...catalog, ...derivedIds(kind, values)]) });

  // Pages ------------------------------------------------------------------
  const pages = new Map();
  const ROOT = { key: "root", id: id("page:root"), name: "Baseline", partial: "baseline", path: "/baseline/" };
  pages.set("root", ROOT);
  const page = (key, partial, name, template = TEMPLATE, lookups = {}) => {
    const entry = { key, id: id(`page:${key}`), name, partial, path: `/baseline/${partial}/`, template, lookups };
    pages.set(key, entry);
    return entry;
  };
  function writePage(entry, copy, catalog = []) {
    const isRoot = entry === ROOT;
    const common = {
      adx_hiddenfromsitemap: true,
      adx_name: entry.name,
      adx_pagetemplateid: entry.template ?? TEMPLATE,
      adx_parentpageid: isRoot ? HOME : ROOT.id,
      adx_partialurl: entry.partial,
      adx_publishingstateid: PUBLISHED,
      adx_sharedpageconfiguration: false,
      ...entry.lookups, // adx_entityform / adx_entitylist / adx_webform bound through the page record
    };
    const dir = `web-pages/${slug(entry.name)}`;
    const base = fileName(entry.name);
    const html = `<div class="baseline-page" data-baseline-page="${entry.key}"><h1>${entry.name}</h1>${copy}</div>\n`;
    put(`${dir}/${base}.webpage.yml`, yamlRecord({ ...common, adx_isroot: true, adx_webpageid: entry.id }));
    put(`${dir}/${base}.webpage.copy.html`, html);
    put(`${dir}/content-pages/${base}.en-US.webpage.yml`, yamlRecord({ ...common, adx_isroot: false, adx_rootwebpageid: entry.id, adx_title: entry.name, adx_webpageid: id(`page:${entry.key}:en-US`), adx_webpagelanguageid: LANGUAGE_ID }));
    put(`${dir}/content-pages/${base}.en-US.webpage.copy.html`, html);
    record("webpage", entry.id, entry.name, isRoot ? "root page, hidden from sitemap" : `page for ${entry.key}`, [...catalog, ...liquidIds(copy)], { path: entry.path, contentPageId: id(`page:${entry.key}:en-US`) });
  }

  // Basic forms --------------------------------------------------------------
  const forms = new Map();
  const formBase = (name, table, formName, mode) => ({
    adx_captcharequired: false,
    adx_entityformid: id(`basicform:${name}`),
    adx_entityname: table,
    adx_entitypermissionsenabled: true,
    adx_formname: formName,
    adx_mode: mode,
    adx_name: name,
    adx_showunsupportedfields: false,
    adx_validationsummarylinksenabled: true,
  });
  const INSERT = 100000000, EDIT = 100000001, READONLY = 100000002;
  const QUERY = { adx_entitysourcetype: 756150001, adx_recordidquerystringparametername: "id" };
  const MESSAGE = { adx_onsuccess: 756150000, adx_hideformonsuccess: false };
  function basicForm(key, { name, table = ITEM, formName = "Baseline Item", mode, fields = {}, variation, catalog = [], page: pageInfo, js = false }) {
    const values = { ...formBase(name, table, formName, mode), ...fields };
    const entry = { key, name, id: values.adx_entityformid, values, metadata: [], js, variation };
    forms.set(key, entry);
    entry.catalog = [...catalog, ...(js ? ["pp.basicform.custom-javascript"] : [])];
    entry.page = pageInfo ? page(key, pageInfo, `${name} Page`) : null;
    return entry;
  }

  const create = basicForm("item-create", { name: "Baseline Item Insert", mode: INSERT, fields: { ...MESSAGE, adx_successmessage: json(label("Baseline item created.")) }, variation: "insert", page: "item-create" });
  const edit = basicForm("item-edit", { name: "Baseline Item Edit", mode: EDIT, fields: { ...QUERY, ...MESSAGE }, variation: "edit, record from query string id; carries the metadata records", page: "item-edit" });
  const read = basicForm("item-read", { name: "Baseline Item Read", mode: READONLY, fields: { ...QUERY }, variation: "read-only", page: "item-read" });
  basicForm("item-create-success", { name: "Baseline Item Insert Success", mode: INSERT, fields: { adx_onsuccess: 756150000, adx_hideformonsuccess: true, adx_successmessage: json(label("Baseline item saved; the form is hidden.")) }, variation: "insert, success message and hide form", page: "item-create-success" });
  basicForm("item-create-redirect", { name: "Baseline Item Insert Redirect", mode: INSERT, fields: { adx_onsuccess: 756150001, adx_hideformonsuccess: false, adx_redirectwebpage: edit.page.id, adx_redirecturlappendentityidquerystring: true, adx_redirecturlquerystringname: "returnurl", adx_appendquerystring: false }, variation: "insert, redirect to the edit page appending the record id; a redirect URL can come from ?returnurl=", page: "item-create-redirect" });
  basicForm("item-create-redirect-url", { name: "Baseline Item Insert Redirect URL", mode: INSERT, fields: { adx_onsuccess: 756150001, adx_hideformonsuccess: false, adx_redirecturl: "/baseline/item-read/", adx_redirecturlappendentityidquerystring: true, adx_redirecturlquerystringname: "returnurl", adx_appendquerystring: true, adx_redirecturlcustomquerystring: "source=baseline", adx_redirecturlquerystringattributeparamname: "code", adx_redirecturlquerystringattribute: "pqvd_code" }, variation: "insert, redirect to a URL (or the URL in ?returnurl=) appending the existing query string, the record id, a custom query string and code=<pqvd_code>", page: "item-create-redirect-url" });
  basicForm("item-edit-nolinks", { name: "Baseline Item Edit No Summary Links", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_validationsummarylinksenabled: false }, variation: "edit, validation summary links disabled", page: "item-edit-nolinks" });
  basicForm("item-create-captcha", { name: "Baseline Item Insert Captcha", mode: INSERT, fields: { ...MESSAGE, adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: false }, variation: "insert, captcha for anonymous users only", page: "item-create-captcha" });
  basicForm("item-create-captcha-all", { name: "Baseline Item Insert Captcha All Users", mode: INSERT, fields: { ...MESSAGE, adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true }, variation: "insert, captcha for anonymous and authenticated users", page: "item-create-captcha-all" });
  basicForm("item-create-attach", { name: "Baseline Item Insert Attach", mode: INSERT, fields: { ...MESSAGE, adx_attachfile: true, adx_attachfileaccept: "image/*", adx_attachfilerestrictaccept: true, adx_attachfilemaxsize: 1024, adx_attachfileallowmultiple: false, adx_attachfilerequired: false, adx_attachfilestoragelocation: 756150000, adx_attachfilesaveoption: 756150000, adx_attachfilelabel: json(label("Baseline attachment")) }, variation: "insert, attach file (image/*, 1024 KB) saved as notes", page: "item-create-attach" });
  basicForm("item-create-attach-multiple", { name: "Baseline Item Insert Attach Multiple", mode: INSERT, fields: { ...MESSAGE, adx_attachfile: true, adx_attachfileallowmultiple: true, adx_attachfilerequired: true, adx_attachfilerequirederrormessage: json(label("Attach at least one baseline PDF.")), adx_attachfileaccept: "application/pdf", adx_attachfileacceptextensions: ".pdf", adx_attachfilerestrictaccept: true, adx_attachfiletypeerrormessage: json(label("Baseline attachments must be PDF files.")), adx_attachfilemaxsize: 2048, adx_attachfilesizeerrormessage: json(label("Baseline attachments must be 2 MB or smaller.")), adx_attachfilestoragelocation: 756150000, adx_attachfilesaveoption: 756150001, adx_attachfilelabel: json(label("Baseline PDFs")) }, variation: "insert, multiple required PDF attachments saved as portal comments, with type/size/required messages", page: "item-create-attach-multiple" });
  basicForm("item-edit-geo", { name: "Baseline Item Edit Geolocation", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_geolocation_enabled: true, adx_geolocation_displaymap: true, adx_geolocation_maptype: 756150000 }, variation: "edit, geolocation enabled (no address columns mapped)", page: "item-edit-geo" });
  const GEO_FIELDS = { adx_geolocation_addresslinefieldname: "pqvd_text", adx_geolocation_cityfieldname: "pqvd_wide", adx_geolocation_countyfieldname: "pqvd_nolabel", adx_geolocation_statefieldname: "pqvd_relabelled", adx_geolocation_countryfieldname: "pqvd_recommended", adx_geolocation_postalcodefieldname: "pqvd_ticker", adx_geolocation_latitudefieldname: "pqvd_float", adx_geolocation_longitudefieldname: "pqvd_decimal", adx_geolocation_formattedaddressfieldname: "pqvd_textarea", adx_geolocation_neighborhoodfieldname: "pqvd_memo" };
  basicForm("item-edit-geo-google", { name: "Baseline Item Edit Geolocation Google", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_geolocation_enabled: true, adx_geolocation_displaymap: true, adx_geolocation_maptype: 756150001, ...GEO_FIELDS }, variation: "edit, geolocation Google map with every address column mapped to an item text/number column", page: "item-edit-geo-google" });
  basicForm("item-edit-geo-esri", { name: "Baseline Item Edit Geolocation Esri", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_geolocation_enabled: true, adx_geolocation_displaymap: false, adx_geolocation_maptype: 756150002, ...GEO_FIELDS }, variation: "edit, geolocation Esri without map display, address columns mapped", page: "item-edit-geo-esri" });
  basicForm("item-edit-associated", { name: "Baseline Item Edit Associated", mode: EDIT, fields: { ...MESSAGE, adx_entitysourcetype: 756150003, adx_recordsourcerelationshipname: "pqvd_contact_baselineitem", adx_recordsourceallowcreateonnull: true }, variation: "edit, record associated to current portal user through pqvd_contactid, create if null", page: "item-edit-associated" });
  basicForm("contact-read-current", { name: "Baseline Contact Read Current User", table: "contact", formName: "Contact", mode: READONLY, fields: { adx_entitysourcetype: 756150002 }, variation: "read-only, record source current portal user (the signed-in contact; no write)", page: "contact-read-current" });
  basicForm("item-edit-tab", { name: "Baseline Item Edit General Tab", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_tabname: "general" }, variation: "edit, tab general only", page: "item-edit-tab" });
  basicForm("item-edit-options", {
    name: "Baseline Item Edit Options",
    mode: EDIT,
    fields: {
      ...QUERY, ...MESSAGE,
      adx_validationgroup: "baseline", adx_renderwebresourcesinline: true, adx_tooltipenabled: true, adx_showunsupportedfields: true, adx_showownerfields: true,
      adx_validationsummarycssclass: "alert alert-danger baseline-summary", adx_validationsummarylinktext: json(label("Go to the field")), adx_validationsummaryheadertext: json(label("The baseline item has errors:")),
      adx_instructions: json(label("Edit the baseline item and save.")), adx_recordnotfoundmessage: json(label("The baseline item was not found.")),
      adx_submitbuttontext: json(label("Update baseline item")), adx_submitbuttonbusytext: json(label("Saving baseline item...")), adx_submitbuttoncssclass: "btn btn-success baseline-submit",
    },
    variation: "edit, validation group, inline web resources, tooltips, unsupported and owner fields, summary CSS/link/header text, instructions, record-not-found message, submit label/busy text/CSS, custom JavaScript",
    page: "item-edit-options",
    js: true,
  });
  basicForm("item-create-required", { name: "Baseline Item Insert Required", mode: INSERT, fields: { ...MESSAGE, adx_recommendedfieldsrequired: true, adx_forceallfieldsrequired: true }, variation: "insert, recommended and all fields required", page: "item-create-required" });
  basicForm("item-create-steps", { name: "Baseline Item Insert Steps", mode: INSERT, fields: { ...MESSAGE, adx_autogeneratesteps: true, adx_nextbuttontext: json(label("Next baseline tab")), adx_nextbuttoncssclass: "btn btn-primary baseline-next", adx_previousbuttontext: json(label("Previous baseline tab")), adx_previousbuttoncssclass: "btn btn-default baseline-previous" }, variation: "insert, tabs as auto-generated steps with next/previous labels and CSS", page: "item-create-steps" });
  basicForm("item-create-owner", { name: "Baseline Item Insert Owner", mode: INSERT, fields: { ...MESSAGE, adx_associatecurrentportaluser: true, adx_targetentityportaluserlookupattribute: "pqvd_contactid", adx_portaluserlookupattributeisactivityparty: false }, variation: "insert, associate the current portal user through pqvd_contactid (not an activity party)", page: "item-create-owner" });
  const REFERENCE_ITEM = { adx_setentityreference: true, adx_referenceentitylogicalname: ITEM, adx_referenceentityrelationshipname: "pqvd_baselineitem_baselinechild", adx_referencetargetlookupattributelogicalname: "pqvd_itemid" };
  basicForm("child-create-reference", { name: "Baseline Child Insert Reference", table: CHILD, formName: "Baseline Child", mode: INSERT, fields: { ...MESSAGE, ...REFERENCE_ITEM, adx_populatereferenceentitylookupfield: true, adx_referenceentitysourcetype: 756150000, adx_referencequerystringname: "itemid", adx_referencequerystringisprimarykey: true, adx_referenceentityshowreadonlyform: true, adx_referenceentityreadonlyformname: "Baseline Item" }, variation: "insert child, reference the item from ?itemid=<id>, populate the lookup, show the item read-only", page: "child-create-reference" });
  basicForm("child-create-reference-code", { name: "Baseline Child Insert Reference Code", table: CHILD, formName: "Baseline Child", mode: INSERT, fields: { ...MESSAGE, ...REFERENCE_ITEM, adx_populatereferenceentitylookupfield: false, adx_referenceentitysourcetype: 756150000, adx_referencequerystringname: "code", adx_referencequerystringisprimarykey: false, adx_referencequeryattributelogicalname: "pqvd_code", adx_referenceentityshowreadonlyform: false }, variation: "insert child, reference the item whose pqvd_code matches ?code=", page: "child-create-reference-code" });
  basicForm("item-create-contact-reference", { name: "Baseline Item Insert Contact Reference", mode: INSERT, fields: { ...MESSAGE, adx_setentityreference: true, adx_referenceentitylogicalname: "contact", adx_referenceentityrelationshipname: "pqvd_contact_baselineitem", adx_referencetargetlookupattributelogicalname: "pqvd_contactid", adx_populatereferenceentitylookupfield: true, adx_referenceentitysourcetype: 756150001 }, variation: "insert item, reference the record associated to the current portal user (contact)", page: "item-create-contact-reference" });
  const actionCss = { ButtonCssClass: "btn btn-default baseline-action" };
  const actionsSettings = (size, placement, deleteTarget) => json({
    ActionButtonPlacement: placement,
    ActionButtonAlignment: 0,
    Actions: [
      { Type: "SubmitAction", ButtonLabel: label("Save baseline item"), ButtonTooltip: label("Save the baseline item"), ...actionCss },
      { Type: "DeleteAction", ButtonLabel: label("Delete baseline item"), ButtonTooltip: label("Delete the baseline item"), ...actionCss, ConfirmationRequired: true, Confirmation: label("Delete this baseline item?"), ...deleteTarget },
      { Type: "ActivateAction", ButtonLabel: label("Activate baseline item"), ButtonTooltip: label("Activate"), ...actionCss },
      { Type: "DeactivateAction", ButtonLabel: label("Deactivate baseline item"), ButtonTooltip: label("Deactivate"), ...actionCss },
      { Type: "CreateRelatedRecordAction", EntityFormId: id("basicform:Baseline Child Insert"), Relationship: "pqvd_baselineitem_baselinechild", ButtonLabel: label("Add baseline child"), ButtonTooltip: label("Create a related child"), ...actionCss },
    ],
    DeleteDialog: dialog("DeleteModal", "Delete baseline item", size),
  });
  const ACTION_IDS = ["pp.basicform.settings", "pp.basicform.action.delete", "pp.basicform.action.activate", "pp.basicform.action.deactivate", "pp.basicform.action.create-related-record", "pp.basicform.action.button-label", "pp.basicform.action.button-tooltip", "pp.basicform.action.button-css-class", "pp.basicform.action.confirmation-required", "pp.basicform.action.confirmation", "pp.basicform.action.button-placement"];
  basicForm("item-edit-actions", { name: "Baseline Item Edit Actions", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_submitbuttontext: json(label("Save baseline item")), adx_settings: actionsSettings("default", 1, { RedirectWebpageId: id("page:item-list") }) }, variation: "edit, submit/delete/activate/deactivate/create-related actions below the form, delete redirects to a page, default delete dialog (workflow skipped)", catalog: [...ACTION_IDS, "pp.basicform.action.redirect-webpage", ...family("pp.basicform.action.dialog.", "default")], page: "item-edit-actions" });
  basicForm("item-edit-actions-above", { name: "Baseline Item Edit Actions Above", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_settings: actionsSettings("large", 0, { RedirectUrl: "/baseline/item-list/" }) }, variation: "edit, actions above the form, delete redirects to a URL, large delete dialog", catalog: [...ACTION_IDS, "pp.basicform.action.redirect-url", ...family("pp.basicform.action.dialog.", "large")], page: "item-edit-actions-above" });
  basicForm("item-edit-actions-small", { name: "Baseline Item Edit Actions Small Dialog", mode: EDIT, fields: { ...QUERY, ...MESSAGE, adx_settings: actionsSettings("small", 1, {}) }, variation: "edit, actions below the form, small delete dialog", catalog: [...ACTION_IDS, ...family("pp.basicform.action.dialog.", "small")], page: "item-edit-actions-small" });
  // Forms opened in dialogs (no page of their own).
  const MODAL = ["pp.basicform.rendering.modal"];
  const childCreate = basicForm("child-create", { name: "Baseline Child Insert", table: CHILD, formName: "Baseline Child", mode: INSERT, fields: { ...MESSAGE }, variation: "subgrid create dialog form", catalog: MODAL });
  const childDetails = basicForm("child-details", { name: "Baseline Child Read", table: CHILD, formName: "Baseline Child", mode: READONLY, fields: { ...QUERY }, variation: "subgrid details dialog form", catalog: MODAL });
  const childEdit = basicForm("child-edit", { name: "Baseline Child Edit", table: CHILD, formName: "Baseline Child", mode: EDIT, fields: { ...QUERY, ...MESSAGE }, variation: "subgrid edit dialog form", catalog: MODAL });
  const itemLookupCreate = basicForm("item-lookup-create", { name: "Baseline Item Lookup Create", formName: "Baseline Item Lookup Create", mode: INSERT, fields: { ...MESSAGE }, variation: "form for create of the child's item lookup (opened from the lookup dialog)", catalog: MODAL });
  const parentLookupCreate = basicForm("parent-lookup-create", { name: "Baseline Parent Lookup Create", table: PARENT, formName: "Baseline Parent", mode: INSERT, fields: { ...MESSAGE }, variation: "form for create of the multistep parent lookup", catalog: MODAL });
  const childLookup = basicForm("child-edit-lookup", { name: "Baseline Child Edit Lookup", table: CHILD, formName: "Baseline Child", mode: EDIT, fields: { ...QUERY, ...MESSAGE }, variation: "edit child; item lookup offers Baseline Item Lookup Create", page: "child-edit-lookup" });
  const parentEdit = basicForm("parent-edit", { name: "Baseline Parent Edit", table: PARENT, formName: "Baseline Parent", mode: EDIT, fields: { ...QUERY, ...MESSAGE }, variation: "edit parent; items subgrid with associate/disassociate", page: "parent-edit" });

  // Basic form metadata -----------------------------------------------------------
  const ATTRIBUTE = 100000000, SECTION = 100000001, TAB = 100000002, SUBGRID = 100000003, NOTES = 100000005, TIMELINE = 756150000;
  const ATTRIBUTE_DEFAULTS = { adx_adddescription: false, adx_descriptionposition: 100000000, adx_fieldisrequired: false, adx_ignoredefaultvalue: false, adx_setvalueonsave: false, adx_useattributedescriptionproperty: false };
  // The server assigns adx_name (observed in the exports): "<form name> <target>", with an empty target for
  // notes and timeline. The generator emits that value; the manifest names the record by its target key
  // (attribute, section, tab or subgrid name; notes; timeline) and claims no stored name.
  const metaTarget = (fields) => fields.adx_attributelogicalname ?? fields.adx_sectionname ?? fields.adx_tabname ?? fields.adx_subgrid_name ?? "";
  const metaName = (form, fields) => `${form.name} ${metaTarget(fields)}`;
  const metaOn = (form) => (key, type, fields, variation, catalog = []) => {
    const values = { adx_entityform: form.id, adx_entityformmetadataid: id(form === edit ? `bfmeta:${key}` : `bfmeta:${form.key}:${key}`), adx_name: metaName(form, fields), adx_type: type, ...(type === ATTRIBUTE ? ATTRIBUTE_DEFAULTS : {}), ...fields };
    form.metadata.push({ key, values, variation, catalog });
  };
  const meta = metaOn(edit);
  meta("label", ATTRIBUTE, { adx_attributelogicalname: "pqvd_relabelled", adx_label: json(label("Baseline label override")) }, "attribute label override");
  meta("vertical-radio", ATTRIBUTE, { adx_attributelogicalname: "pqvd_localchoice", adx_controlstyle: 100000000 }, "choice as vertical radio list");
  meta("horizontal-radio", ATTRIBUTE, { adx_attributelogicalname: "pqvd_globalchoice", adx_controlstyle: 100000001 }, "choice as horizontal radio list");
  meta("lookup-dropdown", ATTRIBUTE, { adx_attributelogicalname: "pqvd_parentid", adx_controlstyle: 756150000 }, "render lookup as dropdown");
  meta("css-class", ATTRIBUTE, { adx_attributelogicalname: "pqvd_phone", adx_cssclass: "baseline-css-class" }, "CSS class");
  meta("prepopulate-value", ATTRIBUTE, { adx_attributelogicalname: "pqvd_recommended", adx_prepopulatetype: 100000000, adx_prepopulatevalue: "baseline prepopulated" }, "prepopulate with value");
  meta("prepopulate-today", ATTRIBUTE, { adx_attributelogicalname: "pqvd_dateonly", adx_prepopulatetype: 100000001 }, "prepopulate with today's date");
  meta("prepopulate-user", ATTRIBUTE, { adx_attributelogicalname: "pqvd_email", adx_prepopulatetype: 100000002, adx_prepopulatefromattribute: "emailaddress1" }, "prepopulate from current contact emailaddress1");
  meta("onsave-value", ATTRIBUTE, { adx_attributelogicalname: "pqvd_hidden", adx_setvalueonsave: true, adx_onsavetype: 100000000, adx_onsavevalue: "baseline on save" }, "set value on save: value");
  meta("onsave-today", ATTRIBUTE, { adx_attributelogicalname: "pqvd_datetimetzi", adx_setvalueonsave: true, adx_onsavetype: 100000001 }, "set value on save: today's date");
  meta("onsave-user", ATTRIBUTE, { adx_attributelogicalname: "pqvd_contactid", adx_setvalueonsave: true, adx_onsavetype: 100000002, adx_onsavefromattribute: "contactid" }, "set value on save: current contact");
  meta("ignore-default", ATTRIBUTE, { adx_attributelogicalname: "pqvd_defaulted", adx_ignoredefaultvalue: true }, "ignore default value");
  meta("regex", ATTRIBUTE, { adx_attributelogicalname: "pqvd_text", adx_validationregularexpression: "^[A-Za-z ]*$", adx_validationregularexpressionerrormessage: json(label("Baseline text accepts letters and spaces only.")) }, "regex validation with message");
  meta("required", ATTRIBUTE, { adx_attributelogicalname: "pqvd_textarea", adx_fieldisrequired: true, adx_requiredfieldvalidationerrormessage: json(label("Baseline text area is required.")) }, "required with message");
  meta("range", ATTRIBUTE, { adx_attributelogicalname: "pqvd_wholenumber", adx_rangevalidationerrormessage: json(label("Baseline whole number must be between 0 and 1000.")) }, "range message");
  meta("validation-message", ATTRIBUTE, { adx_attributelogicalname: "pqvd_memo", adx_validationerrormessage: json(label("Baseline memo is not valid.")) }, "generic validation error message");
  meta("attribute-description", ATTRIBUTE, { adx_attributelogicalname: "pqvd_amount", adx_adddescription: true, adx_descriptionposition: 100000001, adx_useattributedescriptionproperty: true }, "description from the column's Dataverse description");
  const description = (key, column, position, text) => meta(key, ATTRIBUTE, { adx_attributelogicalname: column, adx_adddescription: true, adx_descriptionposition: position, adx_description: json(label(text)) }, `description ${text.toLowerCase()}`);
  description("description-above-field", "pqvd_url", 100000000, "Above the field");
  description("description-below-field", "pqvd_ticker", 100000001, "Below the field");
  description("description-above-label", "pqvd_json", 100000002, "Above the label");
  meta("section-label", SECTION, { adx_sectionname: "text", adx_label: json(label("Baseline text section")) }, "section label override");
  meta("tab-label", TAB, { adx_tabname: "related", adx_label: json(label("Baseline related tab")) }, "tab label override");
  const SUBGRID_IDS = ["pp.bfmeta.subgrid.settings", "pp.bfmeta.subgrid.viewactions", "pp.bfmeta.subgrid.itemactions", "pp.bfmeta.subgrid.targettype", "pp.bfmeta.subgrid.overridecolumns", "pp.bfmeta.subgrid.overridecolumns.attribute", "pp.bfmeta.subgrid.overridecolumns.displayname", "pp.bfmeta.subgrid.overridecolumns.width", "pp.bfmeta.subgrid.loadingmessage", "pp.bfmeta.subgrid.errormessage", "pp.bfmeta.subgrid.accessdeniedmessage", "pp.bfmeta.subgrid.emptymessage", "pp.bfmeta.subgrid.cssclass", "pp.bfmeta.subgrid.gridcssclass", "pp.bfmeta.subgrid.gridcolumnwidthstyle", "pp.bfmeta.subgrid.errordialog"];
  meta("subgrid", SUBGRID, {
    adx_subgrid_name: "subgrid_children",
    adx_subgrid_settings: json({
      Type: "CrmEntityFormView-GridMetadata",
      ViewFormats: [],
      ViewActions: [
        { Type: "CrmEntityFormView-CreateAction", EntityFormId: childCreate.id, TargetType: 0, ButtonLabel: res("New baseline child"), ButtonTooltip: res("Create a baseline child") },
        { Type: "CrmEntityFormView-DownloadAction", ButtonLabel: res("Download children"), ButtonTooltip: res("Download the baseline children") },
      ],
      ItemActions: [
        { Type: "CrmEntityFormView-DetailsAction", EntityFormId: childDetails.id, TargetType: 0, RecordIdQueryStringParameterName: "id", ButtonLabel: res("View child"), ButtonTooltip: res("View the baseline child") },
        { Type: "CrmEntityFormView-EditAction", EntityFormId: childEdit.id, TargetType: 0, RecordIdQueryStringParameterName: "id", ButtonLabel: res("Edit child"), ButtonTooltip: res("Edit the baseline child") },
        { Type: "CrmEntityFormView-DeleteAction", ButtonLabel: res("Delete child"), ButtonTooltip: res("Delete the baseline child"), Confirmation: res("Delete this baseline child?") },
      ],
      ExtendedViewActions: [],
      ExtendedItemActions: [],
      ColumnOverrides: [{ AttributeLogicalName: "pqvd_sortorder", DisplayName: res("Order"), Width: 80 }],
      ...gridMessages("baseline children"),
      EmptyMessage: res("No baseline children yet."),
      GridColumnWidthStyle: 0,
      CreateFormDialog: dialog("CrmEntityFormView-CreateFormModal", "Create baseline child", "default"),
      DetailsFormDialog: dialog("CrmEntityFormView-DetailsFormModal", "Baseline child", "small"),
      EditFormDialog: dialog("CrmEntityFormView-EditFormModal", "Edit baseline child", "large"),
      DeleteDialog: dialog("CrmEntityFormView-GridDeleteModal", "Delete baseline child", "default"),
      ErrorDialog: dialog("CrmEntityFormView-ErrorModal", "Baseline child error"),
    }),
  }, "subgrid create/download/details/edit/delete in modal dialogs (default/small/large), tooltips, messages, CSS, pixel column widths, column override, error dialog", [...SUBGRID_IDS, ...["create", "download", "details", "edit", "delete"].flatMap((action) => family(`pp.bfmeta.subgrid.action.${action}`)), ...["createformdialog", "detailsformdialog", "editformdialog", "deletedialog"].flatMap((d) => family(`pp.bfmeta.subgrid.${d}`))]);
  const notesDialog = (title, privacy) => ({ DisplayPrivacyOptionsField: privacy, PrivacyOptionFieldDefaultValue: privacy, DisplayAttachFile: true, AttachFileAccept: "image/*,application/pdf", NoteFieldLabel: res("Baseline note"), NoteFieldColumns: 20, NoteFieldRows: 6, PrivacyOptionFieldLabel: res("Private"), AttachFileLabel: res("Baseline file"), LeftColumnCssClass: "col-sm-3", RightColumnCssClass: "col-sm-9", ...untypedDialog("NotesModal", title) });
  const notesSettings = (privacy, order) => json({
    CreateEnabled: true, EditEnabled: true, DeleteEnabled: true, DisplayAttachFile: true, DisplayPrivacyOptionField: privacy, PageSize: 10,
    FileAttachmentLocation: 756150000, AcceptMimeTypes: "image/*,application/pdf", RestrictMimeTypes: true, MaximumFileSize: 1024,
    ListTitle: res("Baseline notes"), AddNoteButtonLabel: res("Add baseline note"), NotePrivacyLabel: res("Private"), ...gridMessages("baseline notes"),
    ListOrders: [{ Attribute: "createdon", Direction: order }],
    CreateDialogOptions: notesDialog("Add baseline note", privacy), EditDialogOptions: notesDialog("Edit baseline note", privacy),
    DeleteDialogOptions: { Confirmation: res("Delete this baseline note?"), ...untypedDialog("NotesDeleteModal", "Delete baseline note") },
  });
  meta("notes", NOTES, { adx_notes_settings: notesSettings(true, "Descending") }, "notes create/edit/delete with attachments, privacy option, MIME restriction, size limit, list title/order, messages and every dialog option", family("pp.bfmeta.notes."));
  // Geolocation lookup validator on the geolocation form (like the geolocation forms, configured without a map key).
  metaOn(forms.get("item-edit-geo"))("geolocation-validator", ATTRIBUTE, { adx_attributelogicalname: "pqvd_wide", adx_controlstyle: 100000002, adx_geolocationvalidatorerrormessage: json(label("Enter a baseline address that can be located.")) }, "single line of text as geolocation lookup validator with error message");
  // Lookup "form for create" on the child's item lookup.
  metaOn(childLookup)("item-lookup", ATTRIBUTE, { adx_attributelogicalname: "pqvd_itemid", adx_entityformforcreate: itemLookupCreate.id }, "item lookup with form for create Baseline Item Lookup Create");
  // Associate/disassociate subgrid on the parent form (items are related through pqvd_parentid).
  metaOn(parentEdit)("subgrid", SUBGRID, {
    adx_subgrid_name: "subgrid_items",
    adx_subgrid_settings: json({
      Type: "CrmEntityFormView-GridMetadata",
      ViewFormats: [],
      ViewActions: [{ Type: "CrmEntityFormView-AssociateAction", ViewId: view("item-active"), ButtonLabel: res("Add existing items"), ButtonTooltip: res("Associate baseline items") }],
      ItemActions: [{ Type: "CrmEntityFormView-DisassociateAction", ButtonLabel: res("Remove item"), ButtonTooltip: res("Disassociate the baseline item") }],
      ExtendedViewActions: [],
      ExtendedItemActions: [],
      ColumnOverrides: [],
      ...gridMessages("baseline items"),
      GridColumnWidthStyle: 1,
      LookupDialog: { ...dialog("CrmEntityFormView-LookupModal", "Associate baseline items", "large"), SelectRecordsTitle: res("Select baseline items"), DefaultErrorMessage: res("The items could not be associated."), GridOptions: gridMessages("candidate items") },
      ErrorDialog: dialog("CrmEntityFormView-ErrorModal", "Baseline item error"),
    }),
  }, "subgrid associate (lookup dialog) and disassociate, percent column widths (workflow skipped)", ["pp.bfmeta.subgrid.settings", "pp.bfmeta.subgrid.viewactions", "pp.bfmeta.subgrid.itemactions", "pp.bfmeta.subgrid.gridcolumnwidthstyle", "pp.bfmeta.subgrid.lookupdialog", "pp.bfmeta.subgrid.errordialog", ...family("pp.bfmeta.subgrid.action.associate"), ...family("pp.bfmeta.subgrid.action.disassociate"), ...family("pp.bfmeta.subgrid.lookupdialog.")]);
  // Survey control styles: grouped whole numbers, multiple choice over two-option columns, matrix over choices.
  const SURVEY = [
    { key: "constant-sum", style: 100000003, columns: ["pqvd_wholenumber", "pqvd_ruleerror"], fields: { adx_constantsumminimumtotal: 0, adx_constantsummaximumtotal: 100, adx_constantsumvalidationerrormessage: json(label("The baseline totals must add up to between 0 and 100.")) } },
    { key: "multiple-choice", style: 100000007, columns: ["pqvd_flag", "pqvd_flagcheckbox"], fields: { adx_minmultiplechoiceselectedcount: 1, adx_maxmultiplechoiceselectedcount: 2, adx_multiplechoicevalidationerrormessage: json(label("Choose one or two baseline flags.")) } },
    { key: "matrix", style: 100000006, columns: ["pqvd_localchoice", "pqvd_globalchoice"], fields: { adx_randomizeoptionsetvalues: true } },
    { key: "rank-no-ties", style: 100000004, columns: ["pqvd_wholenumber", "pqvd_ruleerror", "pqvd_defaulted"], fields: { adx_rankordernotiesvalidationerrormessage: json(label("Rank each baseline number once.")) } },
    { key: "rank-allow-ties", style: 100000005, columns: ["pqvd_wholenumber", "pqvd_ruleerror", "pqvd_defaulted"], fields: {} },
    { key: "stack-rank", style: 100000008, columns: ["pqvd_wholenumber", "pqvd_ruleerror", "pqvd_defaulted"], fields: {} },
  ];
  const surveyFields = (group, column) => ({ adx_attributelogicalname: column, adx_controlstyle: group.style, adx_groupname: `baseline-${group.key}`, ...group.fields });
  for (const [key, title, groups] of [["survey", "Survey", SURVEY.slice(0, 3)], ["rank-no-ties", "Rank No Ties", [SURVEY[3]]], ["rank-allow-ties", "Rank Allow Ties", [SURVEY[4]]], ["stack-rank", "Stack Rank", [SURVEY[5]]]]) {
    const form = basicForm(`item-edit-${key}`, { name: `Baseline Item Edit ${title}`, mode: EDIT, fields: { ...QUERY, ...MESSAGE }, variation: `edit, survey control styles: ${groups.map((g) => g.key).join(", ")}`, page: `item-edit-${key}` });
    for (const group of groups) for (const column of group.columns) metaOn(form)(`${group.key}-${column}`, ATTRIBUTE, surveyFields(group, column), `${group.key} group member`);
  }
  // Timeline metadata (Learn: "Basic form metadata type = Timeline"); keys follow the notes settings shape.
  const timelineSettings = json({
    CreateEnabled: true,
    CreateDialogOptions: { DisplayAttachFile: true, ...untypedDialog("TimelineModal", "Add baseline timeline entry") },
    FileAttachmentLocation: 756150000, AcceptMimeTypes: "image/*,application/pdf", AcceptExtensionTypes: ".png,.pdf", RestrictMimeTypes: true, MaximumFileSize: 1024,
  });
  const timelineForm = basicForm("item-edit-timeline", { name: "Baseline Item Edit Timeline", mode: EDIT, fields: { ...QUERY, ...MESSAGE }, variation: "edit, timeline metadata", page: "item-edit-timeline" });
  metaOn(timelineForm)("timeline", TIMELINE, { adx_timeline_settings: timelineSettings }, "timeline: create enabled with attachments in a dialog, note attachments, MIME/extension restriction, 1024 KB limit", family("pp.bfmeta.timeline."));
  // Inactive basic form (statecode Inactive): its page shows that a deactivated form is not rendered.
  basicForm("item-read-inactive", { name: "Baseline Item Read Inactive", mode: READONLY, fields: { ...QUERY, statecode: 1, statuscode: 2 }, variation: "read-only, deactivated record", page: "item-read-inactive" });

  // Lists ------------------------------------------------------------------------
  const lists = [];
  const listBase = (key, name, fields) => ({ adx_entitylistid: id(`list:${key}`), adx_entityname: ITEM, adx_entitypermissionsenabled: true, adx_idquerystringparametername: "id", adx_name: name, adx_pagesize: 5, adx_view: view("item-active"), ...fields });
  const viewsJson = (files) => json({ Type: "ViewMetadata", Views: files.map((file) => ({ Type: "View", ViewId: view(file), DisplayName: label(VIEWS.find((v) => v.file === file).name) })) });
  const list = (key, name, fields, variation, catalog, js = false) => {
    const entry = { key, name, values: listBase(key, name, fields), variation, catalog: [...catalog, ...(js ? ["pp.list.registerstartupscript"] : [])], page: page(key, key, `${name} Page`), js };
    lists.push(entry);
    return entry;
  };
  const ACTIONS = ["pp.list.action.viewactions", "pp.list.action.itemactions", "pp.list.action.create", "pp.list.action.details", "pp.list.action.edit", "pp.list.action.delete", "pp.list.action.details.recordidparametername", "pp.list.action.edit.recordidparametername"];
  const pageActions = {
    Type: "CrmEntityFormView-GridMetadata",
    ViewActions: [{ Type: "CrmEntityFormView-CreateAction", TargetType: 1, ButtonLabel: res("New baseline item"), RedirectWebpageId: create.page.id }],
    ItemActions: [
      { Type: "CrmEntityFormView-DetailsAction", TargetType: 1, RecordIdQueryStringParameterName: "id", ButtonLabel: res("View"), RedirectWebpageId: read.page.id },
      { Type: "CrmEntityFormView-EditAction", TargetType: 1, RecordIdQueryStringParameterName: "id", ButtonLabel: res("Edit"), RedirectWebpageId: edit.page.id },
      { Type: "CrmEntityFormView-DeleteAction", ButtonLabel: res("Delete"), Confirmation: res("Delete this baseline item?") },
    ],
    ExtendedViewActions: [],
    ExtendedItemActions: [],
    ColumnOverrides: [],
    GridColumnWidthStyle: 1,
  };
  const itemList = list("item-list", "Baseline Item List", {
    adx_views: viewsJson(["item-active", "item-inactive", "item-all"]),
    adx_searchenabled: true,
    adx_searchplaceholdertext: "Search baseline items",
    adx_webpageforcreate: create.page.id,
    adx_webpagefordetailsview: read.page.id,
    adx_createbuttonlabel: "New baseline item",
    adx_detailsbuttonlabel: "View",
    adx_emptylisttext: "No baseline items.",
    adx_settings: json(pageActions),
  }, "classic list, three views with selector, search, page size 5, create/details/edit/delete to pages, percent column widths", [...ACTIONS, "pp.list.action.redirectwebpage", "pp.list.action.create.target.webpage", "pp.list.action.details.target.webpage", "pp.list.action.edit.target.webpage", "pp.list.action.delete.confirmation", "pp.list.grid.columnwidthstyle", "pp.list.grid.columnwidthstyle.percent"]);
  // Modal lists: one per dialog size so every action dialog takes every size.
  for (const size of ["default", "large", "small"]) {
    const suffix = size === "default" ? "" : `-${size}`;
    list(`item-list-modal${suffix}`, `Baseline Item List Modal${size === "default" ? "" : ` ${size[0].toUpperCase()}${size.slice(1)}`}`, {
      adx_settings: json({
        Type: "CrmEntityFormView-GridMetadata",
        ViewActions: [{ Type: "CrmEntityFormView-CreateAction", EntityFormId: create.id, TargetType: 0, ButtonLabel: res("New baseline item") }],
        ItemActions: [
          { Type: "CrmEntityFormView-DetailsAction", EntityFormId: read.id, TargetType: 0, RecordIdQueryStringParameterName: "id", ButtonLabel: res("View") },
          { Type: "CrmEntityFormView-EditAction", EntityFormId: edit.id, TargetType: 0, RecordIdQueryStringParameterName: "id", ButtonLabel: res("Edit") },
          { Type: "CrmEntityFormView-DeleteAction", ButtonLabel: res("Delete") },
        ],
        ExtendedViewActions: [],
        ExtendedItemActions: [],
        ColumnOverrides: [],
        CreateFormDialog: dialog("CrmEntityFormView-CreateFormModal", "Create baseline item", size),
        DetailsFormDialog: dialog("CrmEntityFormView-DetailsFormModal", "Baseline item", size),
        EditFormDialog: dialog("CrmEntityFormView-EditFormModal", "Edit baseline item", size),
        DeleteDialog: dialog("CrmEntityFormView-GridDeleteModal", "Delete baseline item", size),
      }),
    }, `create/details/edit in modal dialogs (basic forms), ${size} dialog size; the row link opens the details dialog`, [...ACTIONS, "pp.list.action.create.target.form", "pp.list.action.details.target.form", "pp.list.action.edit.target.form", "pp.list.action.create.basicform", "pp.list.action.details.basicform", "pp.list.action.edit.basicform", "pp.list.detailslink.dialog", "pp.basicform.rendering.modal", ...["create", "details", "edit", "delete"].flatMap((action) => family(`pp.list.action.${action}.dialog.`, size))]);
  }
  const tip = (text) => ({ ButtonTooltip: res(text), ButtonCssClass: "btn btn-default baseline-action" });
  list("item-list-options", "Baseline Item List Options", {
    adx_key: "baseline-item-list-options",
    adx_primarykeyname: `${ITEM}id`,
    adx_searchenabled: true,
    adx_searchtooltiptext: "Search baseline items by name",
    adx_filteraccount: "pqvd_accountid",
    adx_settings: json({
      Type: "CrmEntityFormView-GridMetadata",
      ViewFormats: [],
      ViewActions: [
        { Type: "CrmEntityFormView-CreateAction", TargetType: 2, RedirectUrl: "/baseline/item-create/", ButtonLabel: res("New baseline item"), ...tip("Create a baseline item") },
        { Type: "CrmEntityFormView-DownloadAction", ButtonLabel: res("Download"), ...tip("Download the baseline items") },
      ],
      ItemActions: [
        { Type: "CrmEntityFormView-DetailsAction", TargetType: 2, RedirectUrl: "/baseline/item-read/", RecordIdQueryStringParameterName: "id", ButtonLabel: res("View"), ...tip("View the item") },
        { Type: "CrmEntityFormView-EditAction", TargetType: 2, RedirectUrl: "/baseline/item-edit/", RecordIdQueryStringParameterName: "id", ButtonLabel: res("Edit"), ...tip("Edit the item") },
        { Type: "CrmEntityFormView-DeleteAction", ConfirmationRequired: true, Confirmation: res("Delete this baseline item?"), ButtonLabel: res("Delete"), ...tip("Delete the item") },
        { Type: "ActivateAction", ConfirmationRequired: true, Confirmation: res("Activate this baseline item?"), ButtonLabel: res("Activate"), ...tip("Activate the item") },
        { Type: "DeactivateAction", ConfirmationRequired: false, ButtonLabel: res("Deactivate"), ...tip("Deactivate the item") },
      ],
      ExtendedViewActions: [],
      ExtendedItemActions: [],
      ColumnOverrides: [{ AttributeLogicalName: "pqvd_code", DisplayName: res("Baseline code"), Width: 120 }],
      ...gridMessages("baseline items"),
      GridColumnWidthStyle: 0,
      DeleteDialog: dialog("CrmEntityFormView-GridDeleteModal", "Delete baseline item", "large"),
      ErrorDialog: dialog("CrmEntityFormView-ErrorModal", "Baseline item error"),
    }),
  }, "key, primary key name, search tooltip, account filter; actions to URLs, download, activate/deactivate, tooltips/CSS/confirmation, grid messages and CSS, pixel widths, column override, large delete dialog, error dialog, custom JavaScript", [
    ...ACTIONS, "pp.list.action.confirmationrequired", "pp.list.action.confirmation", "pp.list.action.buttonlabel", "pp.list.action.buttontooltip", "pp.list.action.buttoncssclass", "pp.list.action.redirecturl", "pp.list.action.activate", "pp.list.action.deactivate",
    "pp.list.grid.loadingmessage", "pp.list.grid.errormessage", "pp.list.grid.accessdeniedmessage", "pp.list.grid.emptymessage", "pp.list.grid.cssclass", "pp.list.grid.gridcssclass", "pp.list.grid.columnwidthstyle", "pp.list.grid.columnwidthstyle.pixels", "pp.list.grid.overridecolumn", "pp.list.grid.errordialog",
    "pp.list.action.create.buttonlabel", "pp.list.action.create.buttontooltip", "pp.list.action.create.target.url", ...family("pp.list.action.download"),
    "pp.list.action.details.buttonlabel", "pp.list.action.details.buttontooltip", "pp.list.action.details.target.url",
    "pp.list.action.edit.buttonlabel", "pp.list.action.edit.buttontooltip", "pp.list.action.edit.target.url",
    "pp.list.action.delete.buttonlabel", "pp.list.action.delete.buttontooltip", ...family("pp.list.action.delete.dialog.", "large"),
  ], true);
  // Filter definition: JSON-serialized FetchXML with adx.* designer keys (shape read by Mirage's list filter).
  const opt = (index, attribute, value, uiname) => ({ "adx.id": String(index), attribute, operator: "eq", value: String(value), uiname });
  const filterDefinition = {
    entity: {
      name: ITEM,
      filters: [
        { "adx.id": "0", "adx.uiorder": "0", "adx.uiname": "Name", "adx.filtertype": "textfilter", "adx.attribute": "pqvd_name", "adx.uiselectionmode": "Text", type: "and", conditions: [{ attribute: "pqvd_name", operator: "like", value: "" }] },
        { "adx.id": "1", "adx.uiorder": "1", "adx.uiname": "Local choice", "adx.filtertype": "attributefilterset", "adx.attribute": "pqvd_localchoice", "adx.uiselectionmode": "Dropdown", type: "or", conditions: [opt(0, "pqvd_localchoice", 1, "Alpha"), opt(1, "pqvd_localchoice", 2, "Beta"), opt(2, "pqvd_localchoice", 3, "Gamma")] },
        { "adx.id": "2", "adx.uiorder": "2", "adx.uiname": "Global choice", "adx.filtertype": "attributefilterset", "adx.attribute": "pqvd_globalchoice", "adx.uiselectionmode": "Multiple", type: "or", conditions: [opt(0, "pqvd_globalchoice", 18327000, "Red"), opt(1, "pqvd_globalchoice", 18327001, "Green"), opt(2, "pqvd_globalchoice", 18327002, "Blue")] },
        { "adx.id": "3", "adx.uiorder": "3", "adx.uiname": "Flag", "adx.filtertype": "attributefilterset", "adx.attribute": "pqvd_flag", "adx.uiselectionmode": "Single", type: "or", conditions: [opt(0, "pqvd_flag", 1, "Yes"), opt(1, "pqvd_flag", 0, "No")] },
        { "adx.id": "4", "adx.uiorder": "4", "adx.uiname": "Whole number", "adx.filtertype": "rangefilterset", "adx.attribute": "pqvd_wholenumber", "adx.uiselectionmode": "Multiple", type: "or", conditions: [
          { "adx.id": "0", uiname: "Below 100", type: "and", conditions: [{ attribute: "pqvd_wholenumber", operator: "lt", value: "100" }] },
          { "adx.id": "1", uiname: "100 to 499", type: "and", conditions: [{ attribute: "pqvd_wholenumber", operator: "ge", value: "100" }, { attribute: "pqvd_wholenumber", operator: "lt", value: "500" }] },
          { "adx.id": "2", uiname: "500 and above", type: "and", conditions: [{ attribute: "pqvd_wholenumber", operator: "ge", value: "500" }] },
        ] },
        { "adx.id": "5", "adx.uiorder": "5", "adx.uiname": "Global choice (dynamic)", "adx.filtertype": "dynamicpicklistset", "adx.attribute": "pqvd_globalchoice", "adx.uiselectionmode": "Multiple", type: "or", conditions: [{ attribute: "pqvd_globalchoice", operator: "eq", value: "" }] },
        { "adx.id": "6", "adx.uiorder": "6", "adx.uiname": "Flagged (FetchXML)", "adx.filtertype": "fetchxmlfilter", "adx.uiselectionmode": "Multiple", type: "or", conditions: [{ "adx.id": "0", uiname: "Flagged only", type: "and", conditions: [{ attribute: "pqvd_flag", operator: "eq", value: "1" }] }] },
      ],
      links: [
        { "adx.id": "7", "adx.uiorder": "7", "adx.uiname": "Parent", "adx.filtertype": "lookupset", "adx.uiselectionmode": "Multiple", name: PARENT, from: `${PARENT}id`, to: "pqvd_parentid", filters: [{ type: "or", conditions: [{ attribute: `${PARENT}id`, operator: "eq", value: DATA.parent1, uiname: "Baseline Parent One" }, { attribute: `${PARENT}id`, operator: "eq", value: DATA.parent2, uiname: "Baseline Parent Two" }] }] },
        { "adx.id": "8", "adx.uiorder": "8", "adx.uiname": "Parent (dynamic)", "adx.filtertype": "dynamiclookupset", "adx.uiselectionmode": "Dropdown", name: PARENT, from: `${PARENT}id`, to: "pqvd_parentid", filters: [{ type: "or", conditions: [{ attribute: `${PARENT}id`, operator: "eq", value: "", "adx.view": VIEWS.find((v) => v.file === "parent-active").id, "adx.labelcolumn": "pqvd_name", "adx.filterlookuponrelationship": "pqvd_baselineparent_baselineitem" }] }] },
      ],
    },
  };
  // The definition sets every filter item: display names (adx.uiname), attributes, operators, values, relationships (link name/from/to), views and FetchXML.
  list("item-list-filters", "Baseline Item List Filters", {
    adx_filter_enabled: true,
    adx_filter_orientation: 756150001,
    adx_filter_applybuttonlabel: "Apply baseline filters",
    adx_filter_definition: json(filterDefinition),
  }, "metadata filters: text, dropdown, checkbox set, radio, range, dynamic picklist, lookup set, dynamic lookup, FetchXML", family("pp.listfilter.").filter((itemId) => !/^pp\.listfilter\.(enabled|orientation|applybuttonlabel)/.test(itemId)));
  list("item-list-filters-horizontal", "Baseline Item List Filters Horizontal", {
    adx_filter_enabled: true,
    adx_filter_orientation: 756150000,
    adx_filter_definition: json({ entity: { name: ITEM, filters: [filterDefinition.entity.filters[0]] } }),
  }, "metadata filter, horizontal orientation, text filter, default apply label", ["pp.listfilter.definition", "pp.listfilter.text", "pp.listfilter.text.attribute", "pp.listfilter.text.displayname"]);
  list("item-list-odata", "Baseline Item List OData", {
    adx_odata_enabled: true,
    adx_odata_entitysetname: "BaselineItems",
    adx_odata_entitytypename: "BaselineItem",
    adx_odata_view: view("item-all"),
  }, "OData feed", []);
  list("item-list-calendar", "Baseline Item List Calendar", {
    adx_calendar_enabled: true,
    adx_calendar_startdatefieldname: "pqvd_datetime",
    adx_calendar_summaryfieldname: "pqvd_name",
    adx_calendar_descriptionfieldname: "pqvd_text",
    adx_calendar_initialview: 756150001,
    adx_calendar_style: 756150000,
    adx_calendar_timezonemode: 756150000,
  }, "calendar view on pqvd_datetime", []);
  const CALENDAR = { adx_calendar_enabled: true, adx_calendar_startdatefieldname: "pqvd_datetime", adx_calendar_enddatefieldname: "pqvd_datetimetzi", adx_calendar_summaryfieldname: "pqvd_name", adx_calendar_descriptionfieldname: "pqvd_text", adx_calendar_organizerfieldname: "pqvd_email", adx_calendar_locationfieldname: "pqvd_wide", adx_calendar_alldayfieldname: "pqvd_flag", adx_calendar_initialdate: "2026-01-01T00:00:00.0000000" };
  list("item-list-calendar-year", "Baseline Item List Calendar Year", { ...CALENDAR, adx_calendar_initialview: 756150000, adx_calendar_style: 756150001, adx_calendar_timezonemode: 756150001, adx_calendar_timezone: 85 }, "calendar event list, year view from 2026-01-01, specific time zone (85, GMT), end/organizer/location/all-day columns", []);
  list("item-list-calendar-week", "Baseline Item List Calendar Week", { ...CALENDAR, adx_calendar_initialview: 756150002, adx_calendar_style: 756150000, adx_calendar_timezonemode: 756150000 }, "full calendar, week view", []);
  list("item-list-calendar-day", "Baseline Item List Calendar Day", { ...CALENDAR, adx_calendar_initialview: 756150003, adx_calendar_style: 756150000, adx_calendar_timezonemode: 756150000 }, "full calendar, day view", []);
  list("item-list-mine", "Baseline Item List Mine", {
    adx_view: view("item-all"),
    adx_filterportaluser: "pqvd_contactid",
  }, "sorted view (All Baseline Items, code ascending) filtered to the portal user's pqvd_contactid", ["pp.list.sorting"]);
  // Map view columns, stored as the export stores them on other lists (no credentials, no default centre: see notExpressed).
  const PUSHPIN = { name: "baseline-pushpin.png", path: "/baseline/baseline-pushpin.png" };
  const MAP = { adx_map_resturl: "https://dev.virtualearth.net/REST/v1/Locations", adx_map_zoom: 12, adx_map_distancevalues: "5,10,25,50,100", adx_map_latitudefieldname: "pqvd_float", adx_map_longitudefieldname: "pqvd_decimal", adx_map_infoboxtitlefieldname: "pqvd_name", adx_map_infoboxdescriptionfieldname: "pqvd_text", adx_map_infoboxoffsetx: 25, adx_map_infoboxoffsety: 46, adx_map_pushpinurl: PUSHPIN.path, adx_map_pushpinwidth: 32, adx_map_pushpinheight: 39 };
  list("item-list-map", "Baseline Item List Map", { ...MAP, adx_map_enabled: true, adx_map_type: 756150000, adx_map_distanceunits: 756150001 }, "map view (Bing, miles) over pqvd_float/pqvd_decimal, info box and pushpin settings (pushpin: the Baseline web file baseline-pushpin.png); renders only with a Bing Maps key", []);
  list("item-list-map-google", "Baseline Item List Map Google", { ...MAP, adx_map_enabled: true, adx_map_type: 756150001, adx_map_distanceunits: 756150000 }, "map view type Google (Learn: only Bing is supported), kilometres", []);
  list("item-list-map-esri", "Baseline Item List Map Esri", { ...MAP, adx_map_enabled: true, adx_map_type: 756150002, adx_map_distanceunits: 756150000 }, "map view type Esri (Learn: only Bing is supported), kilometres", []);
  list("item-list-inactive", "Baseline Item List Inactive", { statecode: 1, statuscode: 2 }, "deactivated list record", []);

  // Multistep forms ---------------------------------------------------------------
  const multisteps = [];
  const stepId = (key) => id(`advancedformstep:${key}`);
  const stepBase = (webformId, key, name, fields) => ({
    adx_allowmultiplefiles: false, adx_appendquerystring: false, adx_associatecurrentportaluser: false, adx_attachfile: false, adx_attachfilerequired: false, adx_attachfilerestrictaccept: false, adx_autogeneratesteps: false, adx_captcharequired: false, adx_createautonumber: false, adx_editexistingrecordpermitted: false, adx_entitypermissionsenabled: true, adx_forceallfieldsrequired: false, adx_geolocation_displaymap: false, adx_geolocation_enabled: false, adx_geolocation_maptype: 756150000, adx_hideformonsuccess: true, adx_loguser: false, adx_movepreviouspermitted: true, adx_multiplerecordsperuserpermitted: false, adx_populatereferenceentitylookupfield: false, adx_portaluserlookupattributeisactivityparty: false, adx_recommendedfieldsrequired: false, adx_redirecturlappendentityidquerystring: false, adx_referenceentityshowreadonlyform: false, adx_referenceentitysourcetype: 100000001, adx_referencequerystringisprimarykey: true, adx_renderwebresourcesinline: false, adx_setentityreference: false, adx_showcaptchaforauthenticatedusers: false, adx_showownerfields: false, adx_showunsupportedfields: false, adx_targetentitylogicalname: ITEM, adx_tooltipenabled: false, adx_validationsummarylinksenabled: true,
    adx_name: name, adx_title: name, adx_webform: webformId, adx_webformstepid: stepId(key), ...fields,
  });
  const MS_ATTRIBUTE = 100000000, MS_SECTION = 100000001, MS_TAB = 100000002, MS_SUBGRID = 100000004, MS_NOTES = 100000005;
  const MSMETA_DEFAULTS = { adx_adddescription: false, adx_descriptionposition: 100000000, adx_fieldisrequired: false, adx_ignoredefaultvalue: false, adx_randomizeoptionsetvalues: false, adx_setvalueonsave: false, adx_useattributedescriptionproperty: false };
  const msMeta = (step, key, type, fields, variation, catalog = []) => ({ key: `${step}-${key}`, values: { adx_webformmetadataid: id(`msmeta:${step}-${key}`), adx_webformstep: stepId(step), adx_type: type, ...(type === MS_ATTRIBUTE ? MSMETA_DEFAULTS : {}), ...fields }, variation, catalog });
  const multistep = (key, values, variation, steps, metadata = []) => {
    const entry = { values: { adx_webformid: id(`advancedform:${key}`), ...values }, variation, steps, metadata, page: page(key, key, `${values.adx_name} Page`) };
    multisteps.push(entry);
    return entry;
  };
  const MSFORM = { adx_authenticationrequired: false, adx_editexistingrecordpermitted: true, adx_multiplerecordsperuserpermitted: true, adx_progressindicatorenabled: true, adx_progressindicatorignorelaststep: false, adx_progressindicatorposition: 756150000, adx_progressindicatorprependstepnum: true, adx_progressindicatortype: 756150000, adx_savechangeswarningonclose: false, adx_startnewsessiononload: false };
  const fromPrevious = (step) => ({ adx_entitysourcetype: 100000003, adx_entitysourcestep: stepId(step) });

  // A: tabs, condition, load form, redirect to a page; edit-expired settings.
  const webformId = id("advancedform:multistep");
  const mainMultistep = multistep("multistep", {
    ...MSFORM, adx_name: "Baseline Multistep", adx_startstep: stepId("step1"),
    adx_editexpiredstatecode: 1, adx_editexpiredstatuscode: 2, adx_editexpiredmessage: json(label("This baseline item can no longer be edited.")), adx_editnotpermittedmessage: json(label("You cannot edit this baseline item.")),
  }, "multistep: progress indicator (title, numbered, top), resume session, multiple records per user, edit-expired state/status/message", [
    { values: stepBase(webformId, "step1", "Baseline Multistep Step One", { adx_type: 100000002, adx_formname: "Baseline Item Compact", adx_tabname: "step1", adx_mode: INSERT, adx_nextstep: stepId("step2") }), variation: "load tab step1, insert", catalog: [] },
    { values: stepBase(webformId, "step2", "Baseline Multistep Step Two", { ...fromPrevious("step1"), adx_type: 100000002, adx_formname: "Baseline Item Compact", adx_tabname: "step2", adx_mode: EDIT, adx_nextstep: stepId("step3"), adx_previousstep: stepId("step1") }), variation: "load tab step2, edit result from previous step, move previous permitted", catalog: [] },
    { values: stepBase(webformId, "step3", "Baseline Multistep Flag Condition", { ...fromPrevious("step1"), adx_type: 100000000, adx_condition: "pqvd_flag == true", adx_nextstep: stepId("step4"), adx_conditiondefaultnextstep: stepId("step5"), adx_mode: EDIT }), variation: "condition pqvd_flag == true, else redirect step", catalog: [] },
    { values: stepBase(webformId, "step4", "Baseline Multistep Step Lookup Create", { ...fromPrevious("step1"), adx_type: 100000001, adx_formname: "Baseline Item Lookup Create", adx_mode: EDIT }), variation: "load form Baseline Item Lookup Create, edit", catalog: [] },
    { values: stepBase(webformId, "step5", "Baseline Multistep Redirect", { ...fromPrevious("step1"), adx_type: 100000003, adx_mode: READONLY, adx_redirectwebpage: read.page.id, adx_redirecturlappendentityidquerystring: true, adx_redirecturlquerystringname: "returnurl" }), variation: "redirect to the read page appending the record id; a redirect URL can come from ?returnurl=", catalog: ["pp.msstep.onsuccess"] },
  ], [
    { key: "step1-label", values: { adx_webformmetadataid: id("msmeta:step1-label"), adx_webformstep: stepId("step1"), adx_type: 100000000, adx_attributelogicalname: "pqvd_text", adx_label: json(label("Baseline step text")), adx_adddescription: true, adx_descriptionposition: 100000001, adx_description: json(label("Shown below the field")), adx_fieldisrequired: false, adx_ignoredefaultvalue: false, adx_randomizeoptionsetvalues: false, adx_setvalueonsave: false, adx_useattributedescriptionproperty: false }, variation: "step attribute label and description below", catalog: [] },
    { key: "step1-radio", values: { adx_webformmetadataid: id("msmeta:step1-radio"), adx_webformstep: stepId("step1"), adx_type: 100000000, adx_attributelogicalname: "pqvd_globalchoice", adx_controlstyle: 100000001, adx_adddescription: false, adx_descriptionposition: 100000000, adx_fieldisrequired: true, adx_requiredfieldvalidationerrormessage: json(label("Choose a baseline colour.")), adx_ignoredefaultvalue: false, adx_randomizeoptionsetvalues: false, adx_setvalueonsave: false, adx_useattributedescriptionproperty: false }, variation: "step choice as horizontal radio, required with message", catalog: [] },
  ]);

  // B: survey groups over the full item form, every attribute option, section/tab/subgrid/notes metadata, redirect to a URL.
  const surveyId = id("advancedform:multistep-survey");
  const loadItem = (key, name, fields) => stepBase(surveyId, key, name, { adx_type: 100000001, adx_formname: "Baseline Item", adx_mode: EDIT, ...fields });
  const S5 = "survey5";
  const surveyMeta = SURVEY.flatMap((group, index) => group.columns.map((column) => msMeta(index < 3 ? "survey1" : `survey${index - 1}`, `${group.key}-${column}`, MS_ATTRIBUTE, surveyFields(group, column), `${group.key} group member`)));
  surveyMeta.push(
    msMeta(S5, "vertical-radio", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_localchoice", adx_controlstyle: 100000000 }, "choice as vertical radio list"),
    msMeta(S5, "lookup-dropdown", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_accountid", adx_controlstyle: 756150000 }, "account lookup as dropdown"),
    msMeta(S5, "form-for-create", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_parentid", adx_entityformforcreateinwebformmetadata: parentLookupCreate.id }, "parent lookup with form for create Baseline Parent Lookup Create", ["pp.msmeta.entityformforcreate"]),
    msMeta(S5, "geolocation-validator", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_wide", adx_controlstyle: 100000002, adx_geolocationvalidatorerrormessage: json(label("Enter a baseline address that can be located.")) }, "single line of text as geolocation lookup validator with error message"),
    msMeta(S5, "css-class", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_phone", adx_cssclass: "baseline-css-class" }, "CSS class"),
    msMeta(S5, "prepopulate-value", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_recommended", adx_prepopulatetype: 100000000, adx_prepopulatevalue: "baseline prepopulated" }, "prepopulate with value"),
    msMeta(S5, "prepopulate-today", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_dateonly", adx_prepopulatetype: 100000001 }, "prepopulate with today's date"),
    msMeta(S5, "prepopulate-user", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_email", adx_prepopulatetype: 100000002, adx_prepopulatefromattribute: "emailaddress1" }, "prepopulate from current contact"),
    msMeta(S5, "onsave-value", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_hidden", adx_setvalueonsave: true, adx_onsavetype: 100000000, adx_onsavevalue: "baseline on save" }, "set value on save: value"),
    msMeta(S5, "onsave-today", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_datetimetzi", adx_setvalueonsave: true, adx_onsavetype: 100000001 }, "set value on save: today's date"),
    msMeta(S5, "onsave-user", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_contactid", adx_setvalueonsave: true, adx_onsavetype: 100000002, adx_onsavefromattribute: "contactid" }, "set value on save: current contact"),
    msMeta(S5, "ignore-default", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_defaulted", adx_ignoredefaultvalue: true }, "ignore default value"),
    msMeta(S5, "regex", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_text", adx_validationregularexpression: "^[A-Za-z ]*$", adx_validationregularexpressionerrormessage: json(label("Baseline text accepts letters and spaces only.")) }, "regex validation with message"),
    msMeta(S5, "range", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_wholenumber", adx_rangevalidationerrormessage: json(label("Baseline whole number must be between 0 and 1000.")) }, "range message"),
    msMeta(S5, "validation-message", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_memo", adx_validationerrormessage: json(label("Baseline memo is not valid.")) }, "generic validation message"),
    msMeta(S5, "attribute-description", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_amount", adx_adddescription: true, adx_descriptionposition: 100000001, adx_useattributedescriptionproperty: true }, "description from the column"),
    msMeta(S5, "description-above-field", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_url", adx_adddescription: true, adx_descriptionposition: 100000000, adx_description: json(label("Above the field")) }, "description above the field"),
    msMeta(S5, "description-above-label", MS_ATTRIBUTE, { adx_attributelogicalname: "pqvd_ticker", adx_adddescription: true, adx_descriptionposition: 100000002, adx_description: json(label("Above the label")) }, "description above the label"),
    msMeta(S5, "section-label", MS_SECTION, { adx_sectionname: "text", adx_label: json(label("Baseline text section")) }, "section label override"),
    msMeta(S5, "tab-label", MS_TAB, { adx_tabname: "related", adx_label: json(label("Baseline related tab")) }, "tab label override"),
    msMeta(S5, "subgrid", MS_SUBGRID, {
      adx_subgrid_name: "subgrid_children",
      adx_subgrid_settings: json({
        Type: "CrmEntityFormView-GridMetadata",
        ViewFormats: [],
        ViewActions: [
          { Type: "CrmEntityFormView-CreateAction", EntityFormId: childCreate.id, TargetType: 0, ButtonLabel: res("New baseline child") },
          { Type: "CrmEntityFormView-DownloadAction", ButtonLabel: res("Download children") },
          { Type: "CrmEntityFormView-AssociateAction", ViewId: view("child-active"), ButtonLabel: res("Add existing children") },
        ],
        ItemActions: [
          { Type: "CrmEntityFormView-DetailsAction", EntityFormId: childDetails.id, TargetType: 0, RecordIdQueryStringParameterName: "id", ButtonLabel: res("View child") },
          { Type: "CrmEntityFormView-EditAction", EntityFormId: childEdit.id, TargetType: 0, RecordIdQueryStringParameterName: "id", ButtonLabel: res("Edit child") },
          { Type: "CrmEntityFormView-DeleteAction", ButtonLabel: res("Delete child"), Confirmation: res("Delete this baseline child?") },
          { Type: "CrmEntityFormView-DisassociateAction", ButtonLabel: res("Remove child") },
        ],
        ExtendedViewActions: [],
        ExtendedItemActions: [],
        ColumnOverrides: [{ AttributeLogicalName: "pqvd_sortorder", DisplayName: res("Order"), Width: 20 }],
        ...gridMessages("baseline children"),
        GridColumnWidthStyle: 1,
      }),
    }, "step subgrid: create, download, associate, details, edit, delete, disassociate (workflow skipped), column override, messages, CSS", ["pp.msmeta.subgrid_settings", "pp.msmeta.subgrid.viewaction.create", "pp.msmeta.subgrid.viewaction.download", "pp.msmeta.subgrid.viewaction.associate", "pp.msmeta.subgrid.itemaction.details", "pp.msmeta.subgrid.itemaction.edit", "pp.msmeta.subgrid.itemaction.delete", "pp.msmeta.subgrid.itemaction.disassociate", "pp.msmeta.subgrid.overridecolumnattributes", "pp.msmeta.subgrid.messages", "pp.msmeta.subgrid.cssclass"]),
    msMeta(S5, "notes", MS_NOTES, { adx_notes_settings: notesSettings(false, "Ascending") }, "step notes: create/edit/delete, note attachments, MIME types, order, messages, dialogs", ["pp.msmeta.notes_settings", "pp.msmeta.notes.createenabled", "pp.msmeta.notes.editenabled", "pp.msmeta.notes.deleteenabled", "pp.msmeta.notes.fileattachmentlocation", "pp.msmeta.notes.mimetypes", "pp.msmeta.notes.listorders", "pp.msmeta.notes.messages", "pp.msmeta.notes.dialogs"]),
    msMeta(S5, "timeline", TIMELINE, { adx_timeline_settings: timelineSettings }, "step timeline: create enabled with attachments, MIME/extension restriction, size limit", ["pp.msmeta.timeline_settings"]),
  );
  const UI = {
    adx_validationsummarycssclass: "alert alert-danger baseline-summary", adx_validationsummarylinktext: json(label("Go to the field")), adx_validationsummaryheadertext: json(label("The baseline step has errors:")),
    adx_instructions: json(label("Complete the baseline step.")), adx_recordnotfoundmessage: json(label("The baseline item was not found.")), adx_validationgroup: "baseline-step",
    adx_previousbuttontext: json(label("Back")), adx_previousbuttoncssclass: "btn btn-default baseline-previous", adx_nextbuttontext: json(label("Continue")), adx_nextbuttoncssclass: "btn btn-primary baseline-next",
    adx_submitbuttontext: json(label("Finish")), adx_submitbuttoncssclass: "btn btn-success baseline-submit", adx_submitbuttonbusytext: json(label("Saving...")),
  };
  multistep("multistep-survey", { ...MSFORM, adx_name: "Baseline Multistep Survey", adx_startstep: stepId("survey1"), adx_authenticationrequired: true, adx_progressindicatortype: 756150001, adx_progressindicatorposition: 756150001, adx_progressindicatorignorelaststep: true, adx_progressindicatorprependstepnum: false, adx_savechangeswarningonclose: true, adx_savechangeswarningmessage: json(label("Leave the baseline survey without saving?")), adx_startnewsessiononload: true }, "multistep: authentication required, numeric progress at the bottom ignoring the redirect step, save-changes warning, new session on load", [
    { values: loadItem("survey1", "Baseline Multistep Survey Groups", { adx_entitysourcetype: 100000001, adx_primarykeyquerystringparametername: "id", adx_primarykeyattributelogicalname: `${ITEM}id`, adx_targetentityprimarykeylogicalname: `${ITEM}id`, adx_nextstep: stepId("survey2"), ...UI, adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true, adx_tooltipenabled: true, adx_renderwebresourcesinline: true, adx_recommendedfieldsrequired: true, adx_showunsupportedfields: true, adx_showownerfields: true, adx_loguser: true, adx_userhostaddressattributelogicalname: "pqvd_wide", adx_useridentitynameattributelogicalname: "pqvd_nolabel", adx_editexistingrecordpermitted: true, adx_multiplerecordsperuserpermitted: true, adx_editexpiredstatecode: 1, adx_editexpiredstatusreason: 2, adx_editexpiredmessage: json(label("This baseline item can no longer be edited.")), adx_editnotpermittedmessage: json(label("You cannot edit this baseline item.")) }), variation: "load form, edit the item from ?id=, constant sum/multiple choice/matrix groups, captcha for everyone, every validation/button text option, log user host and identity, edit-expired settings, custom JavaScript", catalog: ["pp.msstep.registerstartupscript"], js: true },
    { values: loadItem("survey2", "Baseline Multistep Survey Rank No Ties", { ...fromPrevious("survey1"), adx_nextstep: stepId("survey3"), adx_forceallfieldsrequired: true }), variation: "rank order (no ties) group, all fields required", catalog: [] },
    { values: loadItem("survey3", "Baseline Multistep Survey Rank Allow Ties", { ...fromPrevious("survey1"), adx_nextstep: stepId("survey4") }), variation: "rank order (ties allowed) group", catalog: [] },
    { values: loadItem("survey4", "Baseline Multistep Survey Stack Rank", { ...fromPrevious("survey1"), adx_nextstep: stepId(S5) }), variation: "stack rank group", catalog: [] },
    { values: loadItem(S5, "Baseline Multistep Survey Attributes", { ...fromPrevious("survey1"), adx_nextstep: stepId("survey6") }), variation: "every attribute option, section/tab labels, subgrid and notes metadata", catalog: [] },
    { values: stepBase(surveyId, "survey6", "Baseline Multistep Survey Redirect", { ...fromPrevious("survey1"), adx_type: 100000003, adx_mode: READONLY, adx_redirecturl: "/baseline/item-read/", adx_appendquerystring: true, adx_redirecturlappendentityidquerystring: true, adx_redirecturlquerystringname: "returnurl", adx_redirecturlcustomquerystring: "source=multistep", adx_redirecturlquerystringattributeparamname: "code", adx_redirecturlquerystringattribute: "pqvd_code" }), variation: "redirect to a URL (or the URL in ?returnurl=) with the existing query string, record id, custom query string and code=<pqvd_code>", catalog: ["pp.msstep.onsuccess"] },
  ], surveyMeta);

  // C: insert with attachments, geolocation, portal user association and table references (query string, previous step, query attribute).
  const insertId = id("advancedform:multistep-insert");
  multistep("multistep-insert", { ...MSFORM, adx_name: "Baseline Multistep Insert", adx_startstep: stepId("insert1"), adx_progressindicatortype: 756150002, adx_progressindicatorposition: 756150002 }, "multistep: progress bar on the left", [
    { values: stepBase(insertId, "insert1", "Baseline Multistep Insert Item", {
      adx_type: 100000001, adx_formname: "Baseline Item Lookup Create", adx_mode: INSERT, adx_nextstep: stepId("insert2"),
      adx_associatecurrentportaluser: true, adx_targetentityportaluserlookupattribute: "pqvd_contactid", adx_portaluserlookupattributeisactivityparty: false,
      adx_attachfile: true, adx_allowmultiplefiles: true, adx_accept: "image/*", adx_attachfilelabel: json(label("Baseline images")), adx_attachfilerequired: true, adx_attachfilerequirederrormessage: json(label("Attach a baseline image.")), adx_attachfilestoragelocation: 756150000, adx_attachfilerestrictaccept: true, adx_attachfiletypeerrormessage: json(label("Baseline attachments must be images.")), adx_attachfilemaxsize: 1024, adx_attachfilesizeerrormessage: json(label("Baseline images must be 1 MB or smaller.")), adx_maximumnooffiles: 3,
      adx_geolocation_enabled: true, adx_geolocation_displaymap: true, adx_geolocation_maptype: 756150001, ...GEO_FIELDS,
      adx_setentityreference: true, adx_referenceentitylogicalname: PARENT, adx_referenceentityrelationshipname: "pqvd_baselineparent_baselineitem", adx_referencetargetlookupattributelogicalname: "pqvd_parentid", adx_populatereferenceentitylookupfield: true, adx_referenceentitysourcetype: 100000000, adx_referencequerystringname: "parentid", adx_referencequerystringisprimarykey: true, adx_referenceentityshowreadonlyform: true, adx_referenceentityreadonlyformname: "Baseline Parent",
    }), variation: "insert, associate current portal user, multiple required images (max 3), geolocation (Google) with address columns, parent reference from ?parentid=", catalog: ["pp.msstep.geolocation_fieldmappings"] },
    { values: stepBase(insertId, "insert2", "Baseline Multistep Insert Child", { adx_type: 100000001, adx_targetentitylogicalname: CHILD, adx_formname: "Baseline Child", adx_mode: INSERT, adx_nextstep: stepId("insert3"), ...REFERENCE_ITEM, adx_populatereferenceentitylookupfield: true, adx_referenceentitysourcetype: 100000001, adx_referenceentitystep: stepId("insert1") }), variation: "insert child referencing the item created by the previous step", catalog: [] },
    { values: stepBase(insertId, "insert3", "Baseline Multistep Insert Child By Code", { adx_type: 100000001, adx_targetentitylogicalname: CHILD, adx_formname: "Baseline Child", adx_mode: INSERT, ...REFERENCE_ITEM, adx_referenceentitysourcetype: 100000000, adx_referencequerystringname: "code", adx_referencequerystringisprimarykey: false, adx_referencequeryattributelogicalname: "pqvd_code", adx_successmessage: json(label("Baseline records created.")), adx_hideformonsuccess: false }), variation: "insert child referencing the item whose pqvd_code matches ?code=, success message without hiding the form", catalog: ["pp.msstep.onsuccess"] },
  ]);

  // D: current portal user (read-only contact) and the record associated to it.
  const userId = id("advancedform:multistep-user");
  multistep("multistep-user", { ...MSFORM, adx_name: "Baseline Multistep Portal User", adx_startstep: stepId("user1"), adx_progressindicatorposition: 756150003 }, "multistep: title progress on the right", [
    { values: stepBase(userId, "user1", "Baseline Multistep Current Contact", { adx_type: 100000001, adx_targetentitylogicalname: "contact", adx_formname: "Contact", adx_mode: READONLY, adx_entitysourcetype: 100000002, adx_nextstep: stepId("user2") }), variation: "current portal user's contact, read-only (no write)", catalog: [] },
    { values: stepBase(userId, "user2", "Baseline Multistep Associated Item", { adx_type: 100000001, adx_formname: "Baseline Item Compact", adx_mode: EDIT, adx_entitysourcetype: 100000004, adx_recordsourcerelationshipname: "pqvd_contact_baselineitem", adx_previousstep: stepId("user1"), adx_nextstep: stepId("user3"), adx_autogeneratesteps: true }), variation: "edit the item associated to the current portal user, the compact form's tabs as auto-generated steps", catalog: [] },
    { values: stepBase(userId, "user3", "Baseline Multistep Associated Reference", { adx_type: 100000001, adx_targetentitylogicalname: CHILD, adx_formname: "Baseline Child", adx_mode: INSERT, ...REFERENCE_ITEM, adx_referenceentitysourcetype: 100000002, adx_referencerecordsourcerelationshipname: "pqvd_contact_baselineitem", adx_referencesourceentitylogicalname: "contact", adx_referenceentityprimarykeylogicalname: `${ITEM}id` }), variation: "insert child referencing the item associated to the current portal user", catalog: [] },
  ]);

  // Web roles, table permissions, page rule -------------------------------------------------
  const roleNames = ["Baseline Editors", "Baseline Readers", "Baseline Contact Scope", "Baseline Account Scope", "Baseline Parent Scope", "Baseline Privilege Combinations"];
  const role = Object.fromEntries(roleNames.map((name) => [name, id(`webrole:${name}`)]));
  const webroles = [...roleNames, "Baseline Inactive Role"].map((name) => ({ adx_anonymoususersrole: false, adx_authenticatedusersrole: false, adx_description: `Baseline fixture role ${name}; not a default role.`, adx_key: `baseline-${slug(name)}`, adx_name: name, adx_webroleid: id(`webrole:${name}`), ...(name === "Baseline Inactive Role" ? { statecode: 1, statuscode: 2 } : {}) }));
  const permissions = [];
  const PRIVILEGES = ["read", "write", "create", "delete", "append", "appendto"];
  const ALL = { read: true, write: true, create: true, delete: true, append: true, appendto: true };
  const READ = { read: true, write: false, create: false, delete: false, append: false, appendto: false };
  const READ_APPEND = { ...READ, append: true, appendto: true };
  const perm = (name, table, scope, privileges, roles, extra = {}, variation = "") => {
    const values = { adx_entitylogicalname: table, adx_entityname: name, adx_entitypermission_webrole: roles.map((r) => role[r]), adx_entitypermissionid: id(`tablepermission:${name}`), adx_scope: scope, ...Object.fromEntries(Object.entries(privileges).map(([k, v]) => [`adx_${k}`, v])), ...extra };
    permissions.push({ name, values, variation });
    return values.adx_entitypermissionid;
  };
  const withChildren = (parentId, label_, privileges, roles) => {
    perm(`${label_} children`, CHILD, 756150003, privileges, roles, { adx_parententitypermission: parentId, adx_parentrelationship: "pqvd_baselineitem_baselinechild" }, "child rows through the item permission");
    perm(`${label_} notes`, "annotation", 756150003, privileges, roles, { adx_parententitypermission: parentId, adx_parentrelationship: "pqvd_baselineitem_Annotations" }, "notes through the item permission");
  };
  const personaRoles = roleNames.slice(0, 5);
  const parentGlobal = perm("Baseline parent global read", PARENT, 756150000, READ_APPEND, personaRoles, {}, "parent lookup read for every baseline role");
  perm("Baseline Editors parents", PARENT, 756150000, ALL, ["Baseline Editors"], {}, "editors edit parents and associate items");
  withChildren(perm("Baseline Editors items", ITEM, 756150000, ALL, ["Baseline Editors"], {}, "global full privileges"), "Baseline Editors items", ALL, ["Baseline Editors"]);
  withChildren(perm("Baseline Readers items", ITEM, 756150000, READ, ["Baseline Readers"], {}, "global read only"), "Baseline Readers items", READ, ["Baseline Readers"]);
  withChildren(perm("Baseline Contact Scope items", ITEM, 756150001, ALL, ["Baseline Contact Scope"], { adx_contactrelationship: "pqvd_contact_baselineitem" }, "contact scope through pqvd_contact_baselineitem"), "Baseline Contact Scope items", ALL, ["Baseline Contact Scope"]);
  withChildren(perm("Baseline Account Scope items", ITEM, 756150002, ALL, ["Baseline Account Scope"], { adx_accountrelationship: "pqvd_account_baselineitem" }, "account scope through pqvd_account_baselineitem"), "Baseline Account Scope items", ALL, ["Baseline Account Scope"]);
  withChildren(perm("Baseline Parent Scope items", ITEM, 756150003, READ, ["Baseline Parent Scope"], { adx_parententitypermission: parentGlobal, adx_parentrelationship: "pqvd_baselineparent_baselineitem" }, "items read through the parent permission (its children and notes form a parent chain two levels deep)"), "Baseline Parent Scope items", READ, ["Baseline Parent Scope"]);
  perm("Baseline Editors account read", "account", 756150000, READ_APPEND, ["Baseline Editors"], {}, "customer lookup read");
  perm("Baseline Editors contact read", "contact", 756150000, READ_APPEND, ["Baseline Editors"], {}, "customer lookup read");
  perm("Baseline Contact Scope self", "contact", 756150004, READ, ["Baseline Contact Scope"], {}, "self scope: the signed-in contact reads its own contact record");
  perm("Baseline inactive items read", ITEM, 756150000, READ, ["Baseline Privilege Combinations"], { statecode: 1, statuscode: 2 }, "deactivated global read permission");
  // Every privilege combination once, on a role with no members (no behaviour change for personas).
  for (let mask = 0; mask < 64; mask++) {
    const privileges = Object.fromEntries(PRIVILEGES.map((p, bit) => [p, Boolean(mask & (1 << bit))]));
    perm(`Baseline privileges ${PRIVILEGES.filter((p) => privileges[p]).join(" ") || "none"}`, ITEM, 756150000, privileges, ["Baseline Privilege Combinations"], {}, `privilege combination ${mask} of 64`);
  }
  const restricted = page("restricted", "restricted", "Baseline Restricted Page");
  const editorsPage = page("editors", "editors", "Baseline Editors Page");
  const pageRules = [
    { values: { adx_description: "Baseline: restrict read of the restricted page to Baseline Readers.", adx_name: "Baseline Restricted Page Read", adx_right: 2, adx_scope: 1, adx_webpageaccesscontrolrule_webrole: [role["Baseline Readers"]], adx_webpageaccesscontrolruleid: id("webpagerule:restricted"), adx_webpageid: restricted.id }, page: restricted, variation: "restrict read, all content, Baseline Readers" },
    { values: { adx_description: "Baseline: grant change on the editors page to Baseline Editors, excluding its direct child web files.", adx_name: "Baseline Editors Page Grant Change", adx_right: 1, adx_scope: 2, adx_webpageaccesscontrolrule_webrole: [role["Baseline Editors"]], adx_webpageaccesscontrolruleid: id("webpagerule:editors"), adx_webpageid: editorsPage.id }, page: editorsPage, variation: "grant change, exclude direct child web files, Baseline Editors" },
  ];

  // Site settings, scoped to the baseline tables (the site-wide ones are not safe: notExpressed) --------
  const setting = (name, value, variation, extra = {}) => ({ values: { adx_description: `Baseline fixture: ${variation}.`, adx_name: name, adx_sitesettingid: id(`sitesetting:${name}`), adx_value: value, ...extra }, variation });
  const settings = [
    setting(`Webapi/${ITEM}/enabled`, "true", "Web API enabled"),
    // Wildcards are rejected by PAC uploads after September 2026 (Learn); list the fixture columns explicitly.
    setting(`Webapi/${ITEM}/fields`, "pqvd_name,pqvd_code,pqvd_text,pqvd_textarea,pqvd_email,pqvd_url,pqvd_phone,pqvd_ticker,pqvd_memo,pqvd_wholenumber,pqvd_decimal,pqvd_float,pqvd_amount,pqvd_datetime,pqvd_dateonly,pqvd_globalchoice,pqvd_multichoice,pqvd_flag,pqvd_parentid,pqvd_contactid,pqvd_accountid,statecode,statuscode", "Web API listed fields"),
    setting(`Webapi/${PARENT}/enabled`, "true", "Web API enabled for parents"),
    setting(`Webapi/${PARENT}/fields`, "pqvd_name,pqvd_code,pqvd_rank", "Web API listed fields"),
    setting(`Webapi/${CHILD}/enabled`, "false", "Web API disabled for children"),
    setting(`Webapi/${CHILD}/UseFieldsFromView`, "false", "Web API fields not taken from a view"),
    // Settings only the fixture reads (no recognised feature key): Source=Table and a deactivated record.
    setting("Baseline/Source Table", "baseline", "value from the Value column (Source = Table)", { adx_source: 0 }),
    setting("Baseline/Inactive", "baseline", "deactivated setting", { statecode: 1, statuscode: 2 }),
  ];

  // Own page and web templates (the site's templates stay untouched) ------------------------
  const webTemplates = [
    { values: { adx_mimetype: "text/html", adx_name: "Baseline Page Template", adx_webtemplateid: id("webtemplate:page") }, source: `<div class="baseline-template">{{ page.adx_copy }}</div>\n` },
    { values: { adx_mimetype: "application/json", adx_name: "Baseline Json Template", adx_webtemplateid: id("webtemplate:json") }, source: `{"page":{{ page.adx_name | escape | json }}}\n` },
    // Template inheritance and inclusion: Extends overrides one block of Layout and includes Part with a parameter.
    { values: { adx_mimetype: "text/html", adx_name: "Baseline Layout", adx_webtemplateid: id("webtemplate:layout") }, source: `<div class="baseline-layout"><header class="baseline-layout-title">{% block title %}Baseline layout title{% endblock %}</header><main class="baseline-layout-main">{% block main %}Baseline layout main{% endblock %}</main></div>\n` },
    { values: { adx_mimetype: "text/html", adx_name: "Baseline Include Part", adx_webtemplateid: id("webtemplate:include-part") }, source: `<p class="baseline-include-part">{{ part_label | default: 'Baseline part' | escape }}</p>\n` },
    { values: { adx_mimetype: "text/html", adx_name: "Baseline Two Column", adx_webtemplateid: id("webtemplate:two-column") }, source: `{% extends 'Layout 2 Column Wide Left' %}{% block main %}<div class="baseline-two-column-main">{{ page.adx_copy }}</div>{% endblock %}{% block aside %}<aside class="baseline-two-column-aside">Baseline aside</aside>{% endblock %}\n`, catalog: ["pp.template.builtin.layouts"] },
    { values: { adx_mimetype: "text/html", adx_name: "Baseline Extends", adx_webtemplateid: id("webtemplate:extends") }, source: `{% extends 'Baseline Layout' %}{% block main %}{% include 'Baseline Include Part' part_label: 'Baseline included part' %}<div class="baseline-snippet-text">{{ snippets['Baseline Text Snippet'] }}</div>{% editable snippets 'Baseline Html Snippet' type: 'html', default: 'Baseline snippet missing' %}{{ page.adx_copy }}{% endblock %}\n` },
  ];
  const snippets = [
    { values: { adx_contentsnippetid: id("snippet:text"), adx_contentsnippetlanguageid: LANGUAGE_ID, adx_display_name: "Baseline Text Snippet", adx_name: "Baseline Text Snippet", adx_type: 756150000 }, value: "Baseline text snippet value.", variation: "text snippet read through the snippets object" },
    { values: { adx_contentsnippetid: id("snippet:html"), adx_contentsnippetlanguageid: LANGUAGE_ID, adx_display_name: "Baseline Html Snippet", adx_name: "Baseline Html Snippet", adx_type: 756150001 }, value: `<p class="baseline-snippet-html">Baseline <strong>HTML</strong> snippet value.</p>`, variation: "HTML snippet placed with the editable tag" },
  ];
  const pageTemplates = [
    { adx_description: "Baseline: web template with the site header and footer.", adx_entityname: "adx_webpage", adx_isdefault: false, adx_name: "Baseline Page Template", adx_pagetemplateid: id("pagetemplate:page"), adx_type: 756150001, adx_usewebsiteheaderandfooter: true, adx_webtemplateid: webTemplates[0].values.adx_webtemplateid },
    { adx_description: "Baseline: JSON web template without header and footer.", adx_entityname: "adx_webpage", adx_isdefault: false, adx_name: "Baseline Json Template", adx_pagetemplateid: id("pagetemplate:json"), adx_type: 756150001, adx_usewebsiteheaderandfooter: false, adx_webtemplateid: webTemplates[1].values.adx_webtemplateid },
    { adx_description: "Baseline: rewrite template to FullPage.aspx (as the site's existing rewrite templates).", adx_isdefault: false, adx_name: "Baseline Rewrite Template", adx_pagetemplateid: id("pagetemplate:rewrite"), adx_rewriteurl: "~/Pages/FullPage.aspx", adx_type: 756150000, adx_usewebsiteheaderandfooter: false },
    { adx_description: "Baseline: web template that extends Baseline Layout, includes Baseline Include Part and places the Baseline snippets.", adx_entityname: "adx_webpage", adx_isdefault: false, adx_name: "Baseline Extends Template", adx_pagetemplateid: id("pagetemplate:extends"), adx_type: 756150001, adx_usewebsiteheaderandfooter: true, adx_webtemplateid: webTemplates.find((t) => t.values.adx_name === "Baseline Extends").values.adx_webtemplateid },
    { adx_description: "Baseline: web template that extends the built-in Layout 2 Column Wide Left (main and aside blocks).", adx_entityname: "adx_webpage", adx_isdefault: false, adx_name: "Baseline Two Column Template", adx_pagetemplateid: id("pagetemplate:two-column"), adx_type: 756150001, adx_usewebsiteheaderandfooter: true, adx_webtemplateid: id("webtemplate:two-column") },
  ];
  const templatePages = pageTemplates.map((t) => page(`template-${slug(t.adx_name.replace(/^Baseline /, ""))}`, `template-${slug(t.adx_name.replace(/^Baseline /, ""))}`, `${t.adx_name} Page`, t.adx_pagetemplateid));

  // Liquid tags by id and key (forms and lists above use the tags by name).
  const activeView = VIEWS.find((v) => v.file === "item-active");
  const liquidPages = [
    [page("liquid-entityform-id", "liquid-entityform-id", "Baseline Liquid Entityform By Id"), `{% entityform id: '${read.id}' %}`],
    [page("liquid-webform-id", "liquid-webform-id", "Baseline Liquid Webform By Id"), `{% webform id: '${mainMultistep.values.adx_webformid}' %}`],
    [page("liquid-entitylist", "liquid-entitylist", "Baseline Liquid Entitylist"), [
      `{% entitylist name: 'Baseline Item List' %}<p class="baseline-list-name">{{ entitylist.adx_name }}</p>{% entityview id: '${activeView.id}', page_size: 2, page: 1, order: 'pqvd_code ASC', search: 'Baseline', language_code: 1033 %}<p class="baseline-total">{{ entityview.total_records }}</p>{% endentityview %}{% endentitylist %}`,
      `{% entitylist id: '${itemList.values.adx_entitylistid}' %}{% entityview logical_name: '${ITEM}', name: '${activeView.name}', filter: 'all' %}<p class="baseline-by-id">{{ entityview.total_records }}</p>{% endentityview %}{% endentitylist %}`,
      `{% entitylist key: 'Baseline Item List Filters', language_code: 1033 %}{% entityview id: '${activeView.id}', metafilter: '' %}<p class="baseline-by-key">{{ entityview.total_records }}</p>{% endentityview %}{% endentitylist %}`,
    ].join("")],
    // FetchXML without self-closing elements (Learn); table permissions filter the result.
    [page("liquid-fetchxml", "liquid-fetchxml", "Baseline Liquid Fetchxml"), `{% fetchxml baseline_items %}<fetch count="5" returntotalrecordcount="true"><entity name="${ITEM}"><attribute name="pqvd_name"></attribute><attribute name="pqvd_code"></attribute><order attribute="pqvd_code"></order></entity></fetch>{% endfetchxml %}<p class="baseline-fetch-total">{{ baseline_items.results.total_record_count }}</p><ul class="baseline-fetch-items">{% for item in baseline_items.results.entities %}<li>{{ item.pqvd_code | escape }} {{ item.pqvd_name | escape }}</li>{% endfor %}</ul>`],
  ];
  // Forms and lists bound through the page record's own lookups, rendered by the rewrite template (FullPage.aspx).
  const rewrite = pageTemplates[2].adx_pagetemplateid;
  const boundPages = [
    [page("bound-entityform", "bound-entityform", "Baseline Bound Basic Form", rewrite, { adx_entityform: read.id }), "basic form Baseline Item Read bound through adx_entityform", ["pp.basicform.rendering.full-page"]],
    [page("bound-entitylist", "bound-entitylist", "Baseline Bound List", rewrite, { adx_entitylist: itemList.values.adx_entitylistid }), "list Baseline Item List bound through adx_entitylist", ["pp.list.webpage"]],
    [page("bound-webform", "bound-webform", "Baseline Bound Multistep Form", rewrite, { adx_webform: mainMultistep.values.adx_webformid }), "multistep form Baseline Multistep bound through adx_webform", ["pp.msform.webpage"]],
  ];

  // Emit -------------------------------------------------------------------------------
  put("website.yml", yamlRecord(WEBSITE));
  record("website", WEBSITE.adx_websiteid, WEBSITE.adx_name, "existing website record, emitted unchanged (header and footer web templates)", [], { path: "/baseline/" }, WEBSITE);
  put("websitelanguage.yml", yamlList([LANGUAGE]));
  const links = [...pages.values()].filter((p) => p !== ROOT).map((p) => `<li><a href="${p.path}">${p.name}</a></li>`).join("");
  writePage(ROOT, `<ul class="baseline-index">${links}</ul>`);
  for (const form of forms.values()) {
    const dir = `basic-forms/${slug(form.name)}`;
    put(`${dir}/${fileName(form.name)}.basicform.yml`, yamlRecord(form.values));
    if (form.js) put(`${dir}/${fileName(form.name)}.basicform.custom_javascript.js`, script(form.name));
    if (form.metadata.length) put(`${dir}/${fileName(form.name)}.basicform.basicformmetadata.yml`, yamlList(form.metadata.map((m) => m.values)));
    record("basicform", form.id, form.name, form.variation, form.catalog, form.page ? { path: form.page.path } : {}, form.values);
    for (const m of form.metadata) record("basicformmetadata", m.values.adx_entityformmetadataid, metaKey(m.values), `metadata (server-named): ${m.variation}`, m.catalog, { form: form.name, path: form.page.path }, m.values);
    if (form.page) writePage(form.page, `{% entityform name: '${form.name}' %}`);
  }
  for (const entry of lists) {
    put(`lists/${fileName(entry.name)}.list.yml`, yamlRecord(entry.values));
    if (entry.js) put(`lists/${fileName(entry.name)}.list.custom_javascript.js`, script(entry.name));
    record("list", entry.values.adx_entitylistid, entry.name, entry.variation, entry.catalog, { path: entry.page.path }, entry.values);
    writePage(entry.page, `{% include 'entity_list' key: '${entry.values.adx_entitylistid}' %}`);
  }
  for (const ms of multisteps) {
    const msDir = `advanced-forms/${slug(ms.values.adx_name)}`;
    put(`${msDir}/${fileName(ms.values.adx_name)}.advancedform.yml`, yamlRecord(ms.values));
    record("advancedform", ms.values.adx_webformid, ms.values.adx_name, ms.variation, [], { path: ms.page.path }, ms.values);
    for (const step of ms.steps) {
      const base = `${msDir}/advanced-form-steps/${slug(step.values.adx_name)}/${fileName(step.values.adx_name)}.advancedformstep`;
      put(`${base}.yml`, yamlRecord(step.values));
      if (step.js) put(`${base}.custom_javascript.js`, script(step.values.adx_name));
      const metadata = ms.metadata.filter((m) => m.values.adx_webformstep === step.values.adx_webformstepid);
      if (metadata.length) put(`${base}.advancedformmetadata.yml`, yamlList(metadata.map((m) => m.values)));
      record("advancedformstep", step.values.adx_webformstepid, step.values.adx_name, step.variation, step.catalog, { path: ms.page.path }, step.values);
      for (const m of metadata) record("advancedformmetadata", m.values.adx_webformmetadataid, metaKey(m.values), `metadata (server-named): ${m.variation}`, m.catalog, { step: step.values.adx_name, path: ms.page.path }, m.values);
    }
    writePage(ms.page, `{% webform name: '${ms.values.adx_name}' %}`);
  }
  for (const p of permissions) {
    put(`table-permissions/${fileName(p.name)}.tablepermission.yml`, yamlRecord(p.values));
    record("tablepermission", p.values.adx_entitypermissionid, p.name, p.variation, [], {}, p.values);
  }
  put("webrole.yml", yamlList(webroles));
  for (const r of webroles) record("webrole", r.adx_webroleid, r.adx_name, r.statecode ? "baseline role, deactivated" : "baseline role, not a default role", [
    ...(permissions.some((p) => p.values.adx_entitypermission_webrole.includes(r.adx_webroleid)) ? ["pp.webrole.tablepermissions"] : []),
    ...(pageRules.some((rule) => rule.values.adx_webpageaccesscontrolrule_webrole.includes(r.adx_webroleid)) ? ["pp.webrole.pagepermissions"] : []),
  ], {}, r);
  put("webpagerule.yml", yamlList(pageRules.map((rule) => rule.values)));
  for (const rule of pageRules) record("webpagerule", rule.values.adx_webpageaccesscontrolruleid, rule.values.adx_name, rule.variation, [], { path: rule.page.path }, rule.values);
  writePage(restricted, `<p class="baseline-restricted">Readable by Baseline Readers only.</p>`, ["pp.pagerule.webpage"]);
  writePage(editorsPage, `<p class="baseline-editors">Baseline Editors may publish changes to this page.</p>`, ["pp.pagerule.webpage"]);
  for (const s of snippets) {
    const dir = `content-snippets/${slug(s.values.adx_name)}`;
    const base = `${dir}/${fileName(s.values.adx_name)}.en-US.contentsnippet`;
    put(`${base}.yml`, yamlRecord(s.values));
    put(`${base}.value.html`, `${s.value}\n`);
    record("contentsnippet", s.values.adx_contentsnippetid, s.values.adx_name, s.variation, [], { path: templatePages[pageTemplates.findIndex((t) => t.adx_name === "Baseline Extends Template")].path }, { ...s.values, adx_value: s.value });
  }
  put("sitesetting.yml", yamlList(settings.map((s) => s.values)));
  for (const s of settings) record("sitesetting", s.values.adx_sitesettingid, s.values.adx_name, s.variation, [], {}, s.values);
  for (const t of webTemplates) {
    const dir = `web-templates/${slug(t.values.adx_name)}`;
    put(`${dir}/${fileName(t.values.adx_name)}.webtemplate.yml`, yamlRecord(t.values));
    put(`${dir}/${fileName(t.values.adx_name)}.webtemplate.source.html`, t.source);
    record("webtemplate", t.values.adx_webtemplateid, t.values.adx_name, `web template (${t.values.adx_mimetype})`, ["pp.template.webtemplate.source", ...liquidIds(t.source), ...(t.catalog ?? [])], {}, t.values);
  }
  for (const [index, t] of pageTemplates.entries()) {
    put(`page-templates/${fileName(t.adx_name)}.pagetemplate.yml`, yamlRecord(t));
    record("pagetemplate", t.adx_pagetemplateid, t.adx_name, t.adx_description, [], { path: templatePages[index].path }, t);
    writePage(templatePages[index], `<p class="baseline-template-copy">Rendered by ${t.adx_name}.</p>`);
  }
  for (const [entry, copy] of liquidPages) writePage(entry, copy);
  for (const [entry, copy, catalog] of boundPages) writePage(entry, `<p class="baseline-bound">Rendered from the page's ${copy}.</p>`, catalog);

  // Web file for the map pushpin, parented under /baseline/ (shape of the exported web-files/*.webfile.yml).
  const pushpinId = id(`webfile:${PUSHPIN.name}`);
  const webFile = { adx_enabletracking: false, adx_excludefromsearch: false, adx_hiddenfromsitemap: true, adx_name: PUSHPIN.name, adx_parentpageid: ROOT.id, adx_partialurl: PUSHPIN.name, adx_publishingstateid: PUBLISHED, adx_webfileid: pushpinId, annotationid: id(`webfile:${PUSHPIN.name}:annotation`), filename: PUSHPIN.name, isdocument: true, mimetype: "image/png", objectid: pushpinId, objecttypecode: "adx_webfile" };
  put(`web-files/${PUSHPIN.name}`, Buffer.from(PUSHPIN_PNG, "base64"));
  put(`web-files/${PUSHPIN.name}.webfile.yml`, yamlRecord(webFile));
  record("webfile", pushpinId, PUSHPIN.name, "map pushpin image (1x1 PNG) referenced by adx_map_pushpinurl on the three map lists", [], { path: PUSHPIN.path }, webFile);

  const manifest = {
    description: "Baseline Power Pages fixture records generated by examples/project/baseline/site.mjs.",
    website: WEBSITE.adx_websiteid,
    notExpressed: withSources(NOT_EXPRESSED),
    documentationOnly: withSources(DOCUMENTATION_ONLY),
    caveats: withSources(CAVEATS),
    records,
  };
  return { files, manifest };
}

// ---------------------------------------------------------------------------
// Items the fixture does not set, with the reason; the catalog's Learn source ids are appended.
// ---------------------------------------------------------------------------
const SHARED = "Site-wide setting: changing it changes the shared site outside /baseline/ (not safe on the shared fixture site).";
const under = (pattern) => CATALOG_ITEMS.map((item) => item.id).filter((itemId) => pattern.test(itemId));
const NOT_EXPRESSED = [
  { catalog: under(/^pp\.colperm\.(profile|column|statecode)/), reason: "PAC CLI supports only the tables Learn lists under Supported tables; adx_columnpermissionprofile and adx_columnpermission are not among them, so a site folder cannot carry column permissions. Baseline Secret Profile (deny pqvd_secret for Baseline Readers) is not generated.", sources: ["learn-pac-cli"] },
  { catalog: ["pp.list.modern"], reason: "The export does not show how a modern list is flagged (backing column not stated on Learn)." },
  { catalog: ["pp.msstep.createautonumber", "pp.msstep.autonumberdefinitionname", "pp.msstep.autonumberattributelogicalname"], reason: "Needs an auto-number definition record that the fixture lacks; Learn lists the columns only (learn-ref-webformstep), so adx_createautonumber stays false (its default, which does not exercise the item)." },
  { catalog: ["pp.bfmeta.attribute.controlstyle.code-component", "pp.msmeta.controlstyle.codecomponent"], reason: "Learn (Use code components in Power Pages): the code component must first be added to the field on the model-driven (Dataverse) form, then enabled with Control Style = Code Component. The fixture's Dataverse forms bind no code component to a column, and a site folder cannot add one to a Dataverse form.", sources: ["learn-pcf"] },
  { catalog: ["pp.basicform.action.workflow", ...under(/^pp\.(bfmeta\.subgrid|list)\.action\.workflow/), "pp.msmeta.subgrid.itemaction.workflow"], reason: "Needs an on-demand classic workflow on the baseline table; the fixture has none." },
  { catalog: ["pp.basicform.action.table-specific", "pp.list.action.tablespecific"], reason: "Offered only for opportunity, incident, quote and sales order (D365 tables the fixture lacks)." },
  { catalog: ["pp.msmeta.type.purchase", "pp.msmeta.purchase"], reason: "Purchase metadata needs D365 commerce tables (quote, order, invoice) the fixture lacks." },
  { catalog: ["pp.basicform.attach-file-storage-location.azure-blob-storage", "pp.msstep.containername", "pp.msstep.storageaccountname"], reason: "Azure Blob Storage needs a storage account and container configured for the site; the fixture has none (note attachments are used)." },
  { catalog: ["pp.list.map.credentials"], reason: "Holds the Bing Maps key; Learn (List map view): the map view is powered by Bing maps. A key is a secret, so a site folder fixture carries none. The map columns and the geolocation forms are configured without it and render the map only where a key is set." },
  { catalog: ["pp.list.map.latitude", "pp.list.map.longitude"], reason: "The enhanced data model stores no map_latitude/map_longitude in list content (upload sent them; read-only Web API read of the stored content on 2026-10-15 shows neither key; export carries neither). The fixture therefore no longer sends them." },
  { catalog: ["pp.list.filterwebsite"], reason: "Needs a lookup to adx_website on the listed table; pqvd_baselineitem has none (and no second website exists)." },
  { catalog: ["pp.list.enhancedviewfilter"], reason: "Learn (Enhanced view filter for lists): the filter is configured on the underlying model-driven view definition used by the list (condition elements with uitype=\"contact\"/\"account\"/\"adx_website\"). A view is a Dataverse solution component, not a site record, so a site folder cannot carry it; the fixture's views have no uitype condition." },
  { catalog: ["pp.tableperm.website", "pp.webrole.website", "pp.sitesetting.table.websiteid"], reason: "Observed: the PAC export's table permission, web role and site setting records carry no adx_websiteid (baseline export table-permissions/*.yml, webrole.yml, sitesetting.yml); the website is implied by the site folder." },
  { catalog: ["pp.tableperm.scope.custom", "pp.tableperm.permissionfetchxml"], reason: "Learn (Table permissions, Custom access type): Custom Access is available only for sites enabled for enhanced authorization. The fixture keeps the website record unchanged (adx_enhancedauthorization 0), and enabling enhanced authorization is site-wide." },
  { catalog: ["pp.list.iscodecomponent"], reason: "True needs a code component configured on the list's view (Learn tutorial: Use a configured code component = Yes after adding it to the views); no baseline view has one. False is the default and the export drops it." },
  { catalog: ["pp.basicform.is-activity-party", "pp.msstep.portaluserlookupattributeisactivityparty"], reason: "True only when the portal user lookup column is an activity party (Learn basic forms: Is Activity Party); the baseline tables are not activity tables." },
  { catalog: ["pp.template.pagetemplate.isdefault"], reason: `${SHARED} Is Default makes a template the default choice in the site's editing tools.` },
  { catalog: ["pp.webapi.table.usefieldsfromview"], reason: "True needs the 'Power Pages Web API Columns' system view on the table (Learn Web API overview). A view is a Dataverse solution component a site folder cannot carry, and the fixture's views include none; false is the default and exercises nothing." },
  { catalog: ["pp.webrole.contacts", "pp.webrole.accounts"], reason: "Not expressible in the site folder: contact and account membership are data associations (N:N powerpagecomponent_mspp_webrole_contact / powerpagecomponent_mspp_webrole_account in the powerpagecomponent and account references), not site records; personas are assigned by the project data.", sources: ["learn-ref-powerpagecomponent", "learn-ref-account"] },
  { catalog: ["pp.msstep.type.loadusercontrol", "pp.msstep.usercontrolpath", "pp.msstep.usercontroltitle"], reason: "Needs an ASP.NET user control (.ascx) deployed with the portal host; a Power Pages site cannot add one." },
  { catalog: ["pp.msstep.loadeventkeyname", "pp.msstep.savingeventkeyname", "pp.msstep.savedeventkeyname", "pp.msstep.submiteventkeyname", "pp.msstep.movepreviouseventkeyname", "pp.msstep.postbackurl", "pp.msstep.settings"], reason: "Learn lists the column only (no behaviour or value format); there is no event handler, postback target or documented JSON to point it at." },
  { catalog: ["pp.basicform.redirect-record-id-parameter-name"], reason: "Learn names no column for the redirect Record ID Parameter Name; adx_redirecturlquerystringname is the parameter that carries the redirect URL (mspp_entityform reference), set to returnurl on the redirect forms, so no column holds the record id parameter name." },
  { catalog: ["pp.webrole.authenticatedusersrole", "pp.webrole.anonymoususersrole"], reason: "State true is not set: it belongs to the site's existing Authenticated Users / Anonymous Users roles, and a second default role is not safe on the shared site (baseline roles set false)." },
  { catalog: ["pp.sitesetting.datetime.dateformat", "pp.sitesetting.datetime.timeformat", "pp.sitesetting.datetime.datetimeformat", "pp.sitesetting.site.bootstrapv5enabled", "pp.template.bootstrap.version"], reason: `${SHARED} Date/time formats and the Bootstrap version change every page.` },
  { catalog: ["pp.sitesetting.site.enablecustompluginerror", "pp.sitesetting.enhancedfileupload", "pp.sitesetting.site.enabledefaulthtmlencoding", "pp.sitesetting.disablevalidationwebtemplate", "pp.sitesetting.site.disableformdatasafehtmlvalidation", "pp.sitesetting.knowledgemanagement.displaynotes", "pp.sitesetting.knowledgemanagement.notesfilter", "pp.sitesetting.timeline.rteenabled", "pp.sitesetting.customersupport.displayalluseractivitiesontimeline", "pp.sitesetting.site.enablecontentsnippettranslationforforms", "pp.sitesetting.usertrace.debug", "pp.sitesetting.sharepoint.maxuploadsize", "pp.sitesetting.sharepoint.maxtotaluploadsize", "pp.sitesetting.header.outputcache.enabled", "pp.sitesetting.footer.outputcache.enabled", "pp.list.showrecordlevelactions", "pp.list.sorting.linkedentities", "pp.webapi.error.innererror", "pp.webapi.disableodatafilter"], reason: SHARED },
  { catalog: under(/^pp\.sitesetting\.(search|profile|auth)\./), reason: `${SHARED} Search, profile and registration settings drive pages outside /baseline/.` },
  { catalog: under(/^pp\.snippet\./), reason: "Site-wide content snippet read by sign-in, header, search or error pages outside /baseline/; overriding it changes the shared site (not safe)." },
];
// Exercised items whose stored shape is not fully confirmed by Learn or the export.
const CAVEATS = [
  { catalog: ["pp.listfilter.definition"], reason: "Learn does not name the filter definition JSON keys; the definition follows the adx.* shape Mirage reads and may differ from the designer's output." },
  { catalog: ["pp.basicform.settings"], reason: "Learn does not name the basic form settings JSON keys; actions use the {Actions:[{Type}]} shape Mirage reads, placement and dialog keys are unverified." },
  { catalog: ["pp.sitesetting.table.source"], reason: "Only Source = Table (0) is set; Environment Variable (1) needs an environment variable definition the fixture lacks." },
  { catalog: ["pp.bfmeta.type.timeline", ...under(/^pp\.bfmeta\.timeline\./), "pp.msmeta.type.timeline", "pp.msmeta.timeline_settings"], reason: "Learn names the timeline settings by display name only; the JSON keys follow the notes settings shape. Shape verified: the export stores adx_type 756150000 and adx_timeline_settings unchanged, and names the record '<form name> ' (empty target), as for notes. Rendering of these keys is not verified." },
  { catalog: ["pp.template.builtin.layouts"], reason: "Exercised through Layout 2 Column Wide Left (Learn: Built-in web templates), extended by name as the site's web template record is named; Layout 1 Column, Layout 2 Column Wide Right and Layout 3 Column Wide Middle are not web template records in the demo portal or the target site export, so they are not extended." },
  { catalog: ["pp.list.map.enabled", "pp.list.map.type.google", "pp.list.map.type.esri", "pp.bfmeta.attribute.controlstyle.geolocation-lookup-validator", "pp.msmeta.controlstyle.geolocationvalidator"], reason: "Configured without a Bing Maps key (pp.list.map.credentials): the map columns are stored except the default centre (pp.list.map.latitude/longitude: not stored, see notExpressed), and the map and geocoding need the key. Learn (List map view): only Bing maps are supported as the map type." },
];
const DOCUMENTATION_ONLY = [
  { catalog: under(/^pp\.msform\.session/), reason: "Runtime session table written by the server while a user fills a multistep form; nothing to configure." },
  { catalog: ["pp.tableperm.enforcement", "pp.colperm.scope"], reason: "Statement of how permissions are enforced; no configurable value." },
  { catalog: ["pp.tableperm.datamodel", "pp.colperm.datamodel", "pp.webrole.datamodel"], reason: "Standard vs enhanced data model storage: a property of the environment, not of a record." },
];
function withSources(entries) {
  const byId = new Map(CATALOG_ITEMS.map((item) => [item.id, item]));
  return entries.map((entry) => ({ ...entry, sources: unique([...(entry.sources ?? []), ...entry.catalog.flatMap((itemId) => byId.get(itemId)?.sources ?? [])]) }));
}

const listed = (manifest) => [...manifest.notExpressed, ...(manifest.documentationOnly ?? [])].flatMap((entry) => entry.catalog);

/** Validates that every catalog id exists; returns the unknown ids. */
export async function unknownCatalogIds(manifest) {
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  const known = new Set(catalog.items.map((item) => item.id));
  const used = [...manifest.records.flatMap((r) => r.catalog), ...listed(manifest), ...(manifest.caveats ?? []).flatMap((entry) => entry.catalog)];
  return [...new Set(used.filter((c) => !known.has(c)))];
}

/** Catalog ids neither exercised by a record nor listed in notExpressed/documentationOnly. */
export function unaccountedCatalogIds(manifest) {
  const seen = new Set([...manifest.records.flatMap((r) => r.catalog), ...listed(manifest)]);
  return CATALOG_ITEMS.map((item) => item.id).filter((itemId) => !seen.has(itemId));
}

/** Catalog ids both cited by a record and listed in notExpressed/documentationOnly. */
export function contradictoryCatalogIds(manifest) {
  const exercised = new Set(manifest.records.flatMap((r) => r.catalog));
  return unique(listed(manifest).filter((itemId) => exercised.has(itemId)));
}

export async function writeSite(outDir = path.join(root, "site"), manifestFile = path.join(root, "site-manifest.json"), identityFile = DEFAULT_IDENTITY) {
  const { files, manifest } = buildSite(readIdentity(identityFile));
  const unknown = await unknownCatalogIds(manifest);
  if (unknown.length) throw new Error(`Unknown catalog ids: ${unknown.join(", ")}`);
  const contradictory = contradictoryCatalogIds(manifest);
  if (contradictory.length) throw new Error(`Exercised and notExpressed: ${contradictory.join(", ")}`);
  await fs.rm(outDir, { recursive: true, force: true });
  for (const [relative, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(outDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  await fs.mkdir(path.dirname(manifestFile), { recursive: true });
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  const counts = {};
  for (const r of manifest.records) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return { outDir, manifestFile, files: files.size, counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { identity: { type: "string" }, out: { type: "string" }, manifest: { type: "string" } } });
  const outDir = values.out ? path.resolve(values.out) : undefined;
  const manifestFile = values.manifest ? path.resolve(values.manifest) : outDir ? path.join(path.dirname(outDir), "site-manifest.json") : undefined;
  writeSite(outDir, manifestFile, values.identity ? path.resolve(values.identity) : undefined)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
