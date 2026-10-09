// Schema-driven deterministic data scaffold for any portal. It finds every
// table the portal's forms, advanced form steps, lists, FetchXML blocks,
// Liquid `entities` reads, Web API site settings and site-marked pages refer
// to, and generates rows from solution metadata: column types, option sets
// with their labels, required levels, lookups bound to generated parent rows,
// autonumber formats and active state/status defaults. One persona contact
// per exported web role (with its role membership and an account) signs in.
// IDs are name-based UUIDs of the seed and a readable path, so the same
// portal, metadata, profile and seed always produce identical rows.
import { createHash } from "node:crypto";
import { tableFields } from "./solution-schema.mjs";
import { portalWebRoles } from "./permissions.mjs";

export const DEFAULT_SCAFFOLD_SEED = "scaffold-v1";
export const SCAFFOLD_PROFILES = Object.freeze({
  // Few rows, required columns only: every page can resolve a record.
  smoke: Object.freeze({ rowsPerTable: 3, optionalColumns: false }),
  // More rows and every writable column: lists page and filters have values.
  dev: Object.freeze({ rowsPerTable: 25, optionalColumns: true }),
});

/** Name-based UUID (SHA-1 of `seed:path`, RFC 4122 version 5 layout). */
export function scaffoldId(seed, path) {
  const hex = createHash("sha1").update(`${seed}:${path}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const lc = (value) => String(value ?? "").trim().toLowerCase();
const validTable = (name) => /^[a-z][a-z0-9_]*$/.test(name);
const FETCH_ENTITY = /<(?:entity|link-entity)\b[^>]*\bname\s*=\s*["']([A-Za-z][\w]*)["']/gi;
// `entities.size` and similar read the collection, not a table.
const LIQUID_COLLECTION_PROPERTIES = new Set(["size", "first", "last", "count", "length"]);
const LIQUID_ENTITY = /\bentities\s*(?:\[\s*["']([A-Za-z][\w]*)["']\s*\]|\.([A-Za-z][\w]*))/g;
// Columns Dataverse maintains itself; the scaffold never writes them.
const SYSTEM_COLUMNS = new Set([
  "createdon", "modifiedon", "createdby", "modifiedby", "createdonbehalfby", "modifiedonbehalfby",
  "ownerid", "owneridtype", "owningbusinessunit", "owninguser", "owningteam", "importsequencenumber",
  "overriddencreatedon", "timezoneruleversionnumber", "utcconversiontimezonecode", "versionnumber",
  "traversedpath", "processid", "stageid", "exchangerate", "transactioncurrencyid",
]);
// Site tables the runtime derives from the portal export (lib/site-tables.mjs):
// generated rows would replace the exported web roles, so the scaffold leaves
// them to the export and writes only the personas' membership intersect rows.
const SITE_TABLES = new Set(["adx_webrole", "adx_webrole_contact", "powerpagecomponent", "powerpagecomponent_mspp_webrole_contact"]);
const MEMBERSHIP = Object.freeze({
  // Standard data model: N:N adx_webrole_contact (adx_webroleid / contactid).
  standard: Object.freeze({ table: "adx_webrole_contact", role: "adx_webroleid" }),
  // Enhanced data model: N:N powerpagecomponent_mspp_webrole_contact
  // (powerpagecomponentid / contactid) over the web role components.
  enhanced: Object.freeze({ table: "powerpagecomponent_mspp_webrole_contact", role: "powerpagecomponentid" }),
});
const SKIPPED_TYPES = new Set(["virtual", "entityname", "managedproperty", "partylist", "image", "file", "owner", "calendarrules"]);
const EPOCH = Date.UTC(2026, 0, 5, 8);

/** Tables the portal refers to, each with the sources that refer to it. */
export function referencedTables(portal) {
  const found = new Map();
  const add = (name, source) => {
    const table = lc(name);
    if (!validTable(table)) return;
    if (!found.has(table)) found.set(table, new Set());
    found.get(table).add(source);
  };
  const formsById = new Map();
  for (const form of portal.forms ?? []) {
    add(form.entityName, "form");
    formsById.set(lc(form.id), form.entityName);
  }
  const listsById = new Map();
  for (const list of portal.lists ?? []) {
    add(list.entityName, "list");
    listsById.set(lc(list.id), list.entityName);
  }
  for (const record of portal.records ?? [])
    if (record.kind === "advancedformstep") add(record.adx_targetentitylogicalname, "form");
  const scan = (text) => {
    for (const match of String(text ?? "").matchAll(FETCH_ENTITY)) add(match[1], "fetchxml");
    for (const match of String(text ?? "").matchAll(LIQUID_ENTITY))
      if (!LIQUID_COLLECTION_PROPERTIES.has(lc(match[2]))) add(match[1] ?? match[2], "liquid");
  };
  for (const template of Object.values(portal.templates ?? {})) scan(template.source);
  for (const snippet of Object.values(portal.snippets ?? {})) scan(typeof snippet === "string" ? snippet : snippet?.value ?? snippet?.source);
  for (const page of portal.pages ?? []) {
    scan(page.html);
    scan(page.js);
  }
  for (const [name, value] of Object.entries(portal.settings ?? {})) {
    const match = /^webapi\/([^/]+)\/enabled$/i.exec(name);
    if (match && lc(typeof value === "object" ? value?.value : value) === "true") add(match[1], "webapi");
  }
  const pagesById = new Map((portal.pages ?? []).map((page) => [lc(page.id), page]));
  for (const marker of portal.siteMarkers ?? []) {
    const page = pagesById.get(lc(marker.pageId));
    if (!page) continue;
    add(formsById.get(lc(page.formId)), "sitemarker");
    add(listsById.get(lc(page.listId)), "sitemarker");
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

function textValue(label, index, maxLength, format) {
  const kind = lc(format);
  let text =
    kind === "email" ? `user${index + 1}@example.invalid`
      : kind === "url" ? `https://example.invalid/item/${index + 1}`
        : kind === "phone" ? `+00 000 000 ${String(index + 1).padStart(3, "0")}`
          : `${label} ${index + 1}`;
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

/** Autonumber formats: {SEQNUM:n}, {RANDSTRING:n} (deterministic) and {DATETIMEUTC:...}. */
function autoNumber(format, index, seed, path) {
  return format.replace(/\{(SEQNUM|RANDSTRING|DATETIMEUTC):?([^}]*)\}/gi, (_, token, argument) => {
    const kind = token.toUpperCase();
    if (kind === "SEQNUM") return String(index + 1).padStart(Number(argument) || 1, "0");
    if (kind === "RANDSTRING") {
      const length = Math.min(Math.max(Number(argument) || 4, 1), 6);
      return createHash("sha1").update(`${seed}:${path}:rand`).digest("hex").slice(0, length).toUpperCase();
    }
    return new Date(EPOCH).toISOString().slice(0, 10).replace(/-/g, "");
  });
}

function numberValue(definition, index) {
  const min = Number.isFinite(definition.minValue) ? definition.minValue : 0;
  const max = Number.isFinite(definition.maxValue) ? definition.maxValue : min + 1000;
  const value = Math.min(max, Math.max(min, min + index + 1));
  if (["decimal", "money", "double", "float"].includes(lc(definition.dataverseType))) {
    const precision = Number.isFinite(definition.precision) ? definition.precision : 2;
    return Number((value + 0.25).toFixed(Math.min(precision, 4)));
  }
  return Math.trunc(value);
}

/**
 * Generate scaffold rows for `portal` from solution `schema`
 * (importSolutionData().schema). Returns { tables, idColumns, contactRoles,
 * personas, report }.
 */
export function scaffoldData({ portal, schema, profile = "smoke", seed = DEFAULT_SCAFFOLD_SEED, rowsPerTable } = {}) {
  const settings = SCAFFOLD_PROFILES[profile];
  if (!settings) throw new Error(`Unknown scaffold profile '${profile}' (${Object.keys(SCAFFOLD_PROFILES).join(", ")})`);
  if (!/^[\w.-]{1,64}$/.test(seed)) throw new Error("seed must be 1-64 letters, digits, '.', '_' or '-'");
  const count = rowsPerTable ?? settings.rowsPerTable;
  const referenced = referencedTables(portal);
  const known = (table) => Boolean(schema?.tables?.[table]);
  // Tables to generate: referenced tables with metadata plus the targets of
  // their required lookups (transitively), and the persona tables.
  const generate = new Map();
  const queue = [...referenced.keys()].filter((table) => known(table) && !SITE_TABLES.has(table)).map((table) => [table, "referenced"]);
  for (const table of ["account", "contact"]) if (known(table)) queue.push([table, "personas"]);
  const fieldsOf = new Map();
  const fields = (table) => {
    if (!fieldsOf.has(table)) fieldsOf.set(table, tableFields(schema, table, { provenance: false }));
    return fieldsOf.get(table);
  };
  while (queue.length) {
    const [table, reason] = queue.shift();
    if (generate.has(table)) continue;
    generate.set(table, reason);
    for (const definition of Object.values(fields(table)))
      if (definition.required && ["lookup", "customer"].includes(lc(definition.dataverseType)))
        for (const target of definition.targets ?? []) if (known(target) && !SITE_TABLES.has(target) && !generate.has(target)) queue.push([target, `required by ${table}.${definition.name}`]);
  }
  const tableInfo = (table) => schema.tables[table];
  const idColumn = (table) => tableInfo(table)?.primaryIdAttribute ?? `${table}id`;
  const nameColumn = (table) => tableInfo(table)?.primaryNameAttribute ?? Object.values(fields(table)).find((definition) => definition.isPrimaryName)?.name ?? null;
  const rowId = (table, index) => scaffoldId(seed, `${table}:${index + 1}`);
  const rowName = (table, index) => `${table} ${index + 1}`;
  const reference = (table, index) => ({ id: rowId(table, index), logical_name: table, name: rowName(table, index) });
  const tables = {};
  const unresolved = [];
  for (const table of [...generate.keys()].sort()) {
    const definitions = fields(table);
    const rows = [];
    for (let index = 0; index < count; index++) {
      const row = { [idColumn(table)]: rowId(table, index) };
      const primaryName = nameColumn(table);
      if (primaryName && definitions[primaryName]) row[primaryName] = rowName(table, index);
      for (const definition of Object.values(definitions)) {
        const column = definition.name;
        const type = lc(definition.dataverseType);
        if (column in row || SYSTEM_COLUMNS.has(column) || SKIPPED_TYPES.has(type) || definition.attributeOf || definition.isPrimaryId) continue;
        if (type === "state") {
          row[column] = 0;
          continue;
        }
        if (type === "status") {
          const status = (definition.statuses ?? []).find((option) => option.state === 0) ?? definition.options?.[0];
          if (status) row[column] = { value: status.value, label: status.label };
          continue;
        }
        const required = definition.required === true;
        if (definition.validForCreate === false) continue;
        if (["lookup", "customer"].includes(type)) {
          const target = (definition.targets ?? []).find((candidate) => generate.has(candidate));
          if (target) {
            // Bind to a generated parent; a table's own parent lookup points at its first row.
            const targetIndex = target === table ? (index === 0 ? -1 : 0) : index % count;
            if (targetIndex >= 0) row[column] = reference(target, targetIndex);
          } else if (required) unresolved.push(`${table}.${column}`);
          continue;
        }
        if (!required && !settings.optionalColumns) continue;
        if (definition.autoNumberFormat) {
          row[column] = autoNumber(definition.autoNumberFormat, index, seed, `${table}:${index + 1}:${column}`);
          continue;
        }
        switch (type) {
          case "picklist":
          case "multiselectpicklist": {
            const options = definition.options ?? [];
            if (!options.length) break;
            const option = options[index % options.length];
            row[column] = type === "picklist" ? { value: option.value, label: option.label } : String(option.value);
            break;
          }
          case "bit":
          case "boolean":
            row[column] = index % 2 === 0;
            break;
          case "datetime": {
            const date = new Date(EPOCH + index * 86400000).toISOString();
            row[column] = lc(definition.dateTimeBehavior) === "dateonly" || lc(definition.format) === "dateonly" ? date.slice(0, 10) : date.replace(".000Z", "Z");
            break;
          }
          case "int":
          case "integer":
          case "bigint":
          case "decimal":
          case "money":
          case "double":
          case "float":
            row[column] = numberValue(definition, index);
            break;
          case "uniqueidentifier":
            row[column] = scaffoldId(seed, `${table}:${index + 1}:${column}`);
            break;
          case "memo":
          case "ntext":
            row[column] = textValue(`${definition.label ?? column} for ${rowName(table, index)}.`, index, definition.maxLength);
            break;
          default:
            row[column] = textValue(definition.label ?? column, index, definition.maxLength, definition.format);
        }
      }
      rows.push(row);
    }
    tables[table] = rows;
  }
  // Personas: one contact per exported web role (anonymous excluded), a
  // shared account, and the role membership the identity model reads.
  const personas = [];
  const contactRoles = [];
  if (generate.has("contact")) {
    const accountId = generate.has("account") ? scaffoldId(seed, "account:personas") : null;
    if (accountId) tables.account.push({ [idColumn("account")]: accountId, [nameColumn("account") ?? "name"]: "Scaffold personas" });
    for (const role of portalWebRoles(portal).filter((candidate) => !candidate.anonymous)) {
      const contactId = scaffoldId(seed, `contact:persona/${role.id}`);
      const contact = {
        [idColumn("contact")]: contactId,
        firstname: "Persona",
        lastname: role.name,
        fullname: `Persona ${role.name}`,
        emailaddress1: `persona-${scaffoldId(seed, `email:${role.id}`).slice(0, 8)}@example.invalid`,
        ...(accountId ? { parentcustomerid: { id: accountId, logical_name: "account", name: "Scaffold personas" } } : {}),
        statecode: 0,
      };
      tables.contact.push(contact);
      contactRoles.push({ contactId, roleId: role.id });
      personas.push({ contactId, accountId, role: role.name, roleId: role.id });
    }
  }
  // The same memberships as rows of the data model's intersect table, so
  // FetchXML and Liquid that join web roles to contacts see them too.
  const membership = MEMBERSHIP[portal.format === "enhanced" ? "enhanced" : "standard"];
  if (contactRoles.length)
    tables[membership.table] = contactRoles.map((entry) => ({
      [`${membership.table}id`]: scaffoldId(seed, `${membership.table}:${entry.contactId}:${entry.roleId}`),
      contactid: entry.contactId,
      [membership.role]: entry.roleId,
    }));
  const sources = {};
  for (const [table, refs] of referenced) for (const source of refs) (sources[source] ??= []).push(table);
  const report = {
    profile,
    seed,
    rowsPerTable: count,
    referencedTables: referenced.size,
    referencedWithoutMetadata: [...referenced.keys()].filter((table) => !known(table)),
    generatedTables: Object.keys(tables).length,
    rows: Object.values(tables).reduce((sum, rows) => sum + rows.length, 0),
    personas: personas.length,
    sources: Object.fromEntries(Object.entries(sources).map(([source, list]) => [source, list.length])),
    addedForRequiredLookups: [...generate].filter(([, reason]) => reason.startsWith("required by")).map(([table]) => table),
    derivedFromExport: [...referenced.keys()].filter((table) => SITE_TABLES.has(table)),
    memberships: { table: membership.table, rows: tables[membership.table]?.length ?? 0 },
    unresolvedRequiredLookups: [...new Set(unresolved)].sort(),
  };
  const idColumns = Object.fromEntries(Object.keys(tables).map((table) => [table, table === membership.table ? `${table}id` : idColumn(table)]));
  return { tables, idColumns, contactRoles, personas, report };
}
