import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  builtinPresets,
  resolvePreset,
  compactBuiltinPresets,
  applyPresetSections,
} from "./presets.mjs";
// Preset functions live in presets.mjs; these re-exports keep existing imports working.
export { builtinPresets, resolvePreset, compactBuiltinPresets };
import { expressionOperator } from "./extensions.mjs";
import { createHash } from "node:crypto";

import { DataError } from "./data-error.mjs";
import {
  executeFetch,
  parseXmlDocument,
  planFetch,
} from "./fetchxml-engine.mjs";
import {
  columnValue,
  compileODataPredicate,
  evaluateApply,
  parseApply,
  parseExpand,
  parseODataExpression,
  parseOrderBy,
  parseSelect,
  sortRows,
} from "./odata-query.mjs";
import {
  fieldKind,
  formatDotNetDate,
  primaryNameValue,
  isDateOnlyField,
  isoUtc,
  parseDateValue,
  valuesEqual,
} from "./dataverse-values.mjs";
// The store's query error type lives in data-error.mjs; this re-export keeps imports working.
export { DataError };
const clone = (value) => structuredClone(value);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
// Query bounds (32 OData navigation levels, 15 FetchXML links, 64 XML levels)
// live in odata-query.mjs and fetchxml-engine.mjs with their evidence.
const formattedAnnotation = "@OData.Community.Display.V1.FormattedValue";
const lookupAnnotation = "@Microsoft.Dynamics.CRM.lookuplogicalname";

const metadataField = (mapping, key) => {
  const fields = mapping?.fields ?? mapping?.fieldMetadata ?? {};
  return (
    fields[key] ??
    fields[
      Object.keys(fields).find(
        (name) => name.toLowerCase() === key.toLowerCase(),
      )
    ]
  );
};
const choiceDefinition = (definition) => {
  const type = String(
    definition?.dataverseType ?? definition?.type ?? "",
  ).toLowerCase();
  return (
    ["picklist", "state", "status", "choice", "optionset"].includes(type) ||
    (Array.isArray(definition?.options) &&
      ![
        "bit",
        "boolean",
        "int",
        "integer",
        "bigint",
        "decimal",
        "double",
        "float",
        "money",
      ].includes(type))
  );
};
const choiceLabel = (definition, value) =>
  Array.isArray(definition?.options)
    ? definition.options.find(
        (option) => Number(option.value) === Number(value),
      )?.label
    : undefined;

/** Native Liquid entity.id is metadata, not an additional Dataverse JSON column. */
export function withLiquidEntityId(
  record,
  mapping = {},
  { aggregate = false } = {},
) {
  const primary = mapping?.idColumn && record?.[mapping.idColumn];
  if (!aggregate && primary != null && !own(record, "id"))
    Object.defineProperty(record, "id", {
      value: scalar(primary),
      enumerable: false,
      configurable: true,
    });
  return record;
}

/** Format permission-filtered local reads for Liquid; never change persisted/API scalars. */
export function normalizeMockLiquidRecord(
  record,
  mapping = {},
  { aggregate = false, mappings = {}, aliasFields = {} } = {},
) {
  if (record == null || typeof record !== "object") return record;
  if (Array.isArray(record))
    return record.map((row) =>
      normalizeMockLiquidRecord(row, mapping, {
        aggregate,
        mappings,
        aliasFields,
      }),
    );
  const out = clone(record);
  for (const [key, value] of Object.entries(record)) {
    if (key.includes("@")) continue;
    const definition = aliasFields[key] ?? metadataField(mapping, key);
    if (
      !aggregate &&
      typeof value === "number" &&
      choiceDefinition(definition)
    ) {
      out[key] = {
        value,
        label:
          choiceLabel(definition, value) ??
          record[key + formattedAnnotation] ??
          "",
      };
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      own(value, "value")
    ) {
      // Preserve explicit typed fixture values. A label omitted by a caller may
      // be supplied from metadata without mutating that caller's record.
      if (!aggregate && choiceDefinition(definition) && !own(value, "label"))
        out[key].label = choiceLabel(definition, value.value) ?? "";
    } else if (
      value &&
      typeof value === "object" &&
      mapping.relationships?.[key] &&
      !own(value, "id")
    ) {
      const target = mapping.relationships[key].entity;
      const targetMapping =
        typeof mappings === "function" ? mappings(target) : mappings[target];
      out[key] = normalizeMockLiquidRecord(value, targetMapping ?? {}, {
        aggregate,
        mappings,
      });
    }
  }
  return withLiquidEntityId(out, mapping, { aggregate });
}

/** Resolve attribute aliases from the authored FetchXML, retaining aggregates as numbers. */
export function normalizeMockLiquidFetchXml(result, xml, mappingResolver) {
  const fetch = parseFetchXml(xml),
    root = fetch.children.find((node) => node.name === "entity");
  if (!root) throw new DataError("FetchXML requires a root entity");
  const resolve = (name) =>
    typeof mappingResolver === "function"
      ? mappingResolver(name)
      : (mappingResolver?.[name] ?? {});
  const mapping = resolve(root.attrs.name),
    aliasFields = {};
  let serial = 0;
  const collect = (node, alias = null) => {
    const current = resolve(node.attrs.name);
    if (alias)
      for (const [key, definition] of Object.entries(
        current.fields ?? current.fieldMetadata ?? {},
      ))
        aliasFields[alias + "." + key] = definition;
    for (const attribute of node.children.filter(
      (child) => child.name === "attribute",
    )) {
      const key =
        attribute.attrs.alias ??
        (alias ? alias + "." : "") + attribute.attrs.name;
      aliasFields[key] = metadataField(current, attribute.attrs.name);
    }
    for (const link of node.children.filter(
      (child) => child.name === "link-entity",
    ))
      collect(link, link.attrs.alias ?? `${link.attrs.name}${++serial}`);
  };
  collect(root);
  // Evaluator results describe their output columns exactly (generated
  // aliases count every link-entity in document order, including filters).
  if (result.columns) {
    for (const [alias, logical] of Object.entries(result.columns.aliases ?? {})) {
      const current = resolve(logical);
      for (const [key, definition] of Object.entries(
        current.fields ?? current.fieldMetadata ?? {},
      ))
        aliasFields[alias + "." + key] ??= definition;
    }
    for (const column of result.columns.columns ?? [])
      aliasFields[column.key] = metadataField(
        resolve(column.entity),
        column.attribute,
      );
  }
  return {
    ...result,
    entities: (result.entities ?? []).map((row) =>
      normalizeMockLiquidRecord(row, mapping, {
        aggregate: fetch.attrs.aggregate === "true",
        aliasFields,
        mappings: resolve,
      }),
    ),
  };
}

/** API serialization only. Liquid and the persisted workspace retain their typed values. */
export function formatMockRecord(
  record,
  mapping = {},
  mappings = {},
  tables = {},
) {
  if (!record || typeof record !== "object") return record;
  if (Array.isArray(record))
    return record.map((row) =>
      formatMockRecord(row, mapping, mappings, tables),
    );
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (/^__simArtifact(?:$|[/.])/i.test(key)) continue;
    if (key.includes("@")) {
      out[key] = value;
      continue;
    }
    const relationship = mapping.relationships?.[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      own(value, "id") &&
      own(value, "logical_name")
    ) {
      const name =
        key.includes(".") || /^_.*_value$/.test(key) ? key : `_${key}_value`;
      out[name] = value.id;
      const targetMapping = mappings[value.logical_name] ?? {};
      const target = (tables[value.logical_name] ?? []).find(
        (row) =>
          String(
            row[targetMapping.idColumn ?? `${value.logical_name}id`],
          ).toLowerCase() === String(value.id).toLowerCase(),
      );
      out[name + formattedAnnotation] =
        value.name ?? primaryNameValue(targetMapping, target, value.logical_name) ?? "";
      out[name + lookupAnnotation] = value.logical_name;
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      own(value, "value") &&
      own(value, "label")
    ) {
      out[key] = value.value;
      out[key + formattedAnnotation] = value.label;
    } else if (value && typeof value === "object" && relationship) {
      out[key] = formatMockRecord(
        value,
        mappings[relationship.entity] ?? {},
        mappings,
        tables,
      );
    } else {
      out[key] = value;
      const definition = metadataField(mapping, key);
      if (typeof value === "number" && choiceDefinition(definition)) {
        const label = choiceLabel(definition, value);
        if (label != null) out[key + formattedAnnotation] = label;
      } else if (
        typeof value === "number" &&
        ["int", "integer", "bigint"].includes(
          String(
            definition?.dataverseType ?? definition?.type ?? "",
          ).toLowerCase(),
        )
      ) {
        out[key + formattedAnnotation] = value.toLocaleString("en-US");
      }
      const physical =
        key.startsWith("_") && key.endsWith("_value") ? key.slice(1, -6) : key;
      const rel = Object.values(mapping.relationships ?? {}).find(
        (r) => r.many === false && r.from === physical,
      );
      if (rel && value != null && typeof value !== "object") {
        const targetMapping = mappings[rel.entity] ?? {};
        const target = (tables[rel.entity] ?? []).find(
          (row) =>
            String(row[targetMapping.idColumn ?? rel.to]).toLowerCase() ===
            String(value).toLowerCase(),
        );
        const name =
          key.includes(".") || /^_.*_value$/.test(key) ? key : `_${key}_value`;
        out[name] = value;
        out[name + lookupAnnotation] = rel.entity;
        if (target)
          out[name + formattedAnnotation] =
            primaryNameValue(targetMapping, target, rel.entity) ?? "";
      }
    }
  }
  return out;
}

const safeName = (name) => {
  if (
    !/^[\w.-]+$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name)
  )
    throw new DataError(`Invalid entity or field name: ${name}`);
  return name;
};
const scalar = (value) =>
  value && typeof value === "object"
    ? (value.id ?? value.value ?? value)
    : value;
const comparable = (value) => {
  const v = scalar(value);
  return String(typeof v === "boolean" ? Number(v) : v)
    .replace(
      /^(?:\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}|\(([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\))$/i,
      (_match, braced, parenthesized) => braced ?? parenthesized,
    )
    .toLowerCase();
};
const equal = (a, b) =>
  a == null || b == null
    ? a == null && b == null
    : comparable(a) === comparable(b);
const field = (row, name) =>
  own(row, name)
    ? row[name]
    : name.startsWith("_") && name.endsWith("_value")
      ? scalar(row[name.slice(1, -6)])
      : name.split("/").reduce((v, k) => v?.[k], row);
/** Small non-resolving XML parser: external entities and doctypes are rejected. */
export function parseFetchXml(source) {
  return parseXmlDocument(source, { root: "fetch" });
}
const splitTop = (text, separator = ",") => {
  const out = [];
  let start = 0,
    depth = 0,
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      if (quote && text[i + 1] === "'") {
        i++;
        continue;
      }
      quote = !quote;
    }
    if (quote) continue;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === separator && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
};

// Plugin predicates evaluate a single in-memory record: "/" reads nested
// object members, not relationships, and the extended dialect keeps the
// simulator's convenience functions (tolower, length, in, ...).
const pluginMapping = { logicalName: "record", idColumn: "id", relationships: {} };
const pluginContext = {
  dialect: "extended",
  navigate: (_mapping, row, name) =>
    row && typeof row === "object" && own(row, name)
      ? { mapping: pluginMapping, value: row[name], many: false }
      : { mapping: pluginMapping, value: undefined, many: false },
  definition: () => undefined,
  settings: {},
  identity: {},
};

/** Compile rather than eval OData expressions. Unknown syntax always fails visibly. */
export function compileFilter(source) {
  if (!source) return () => true;
  const predicate = compileODataPredicate(
    parseODataExpression(source, { dialect: "extended" }),
    pluginMapping,
    { ...pluginContext, now: Date.now() },
  );
  return (row) => predicate(row);
}

export function emptyState() {
  return {
    version: 1,
    mappings: {},
    tables: {},
    permissions: [],
    plugins: [],
    presets: {},
    settings: { permissionMode: "enforce" },
  };
}
export function reconcilePermissionDiagnostics(state) {
  if (!state.simulator) return state;
  const byId = new Map((state.permissions ?? []).map((p) => [p.id, p]));
  const codes = new Set([
    "PERMISSION_MAPPING_REQUIRED",
    "PERMISSION_ENTITY_UNRESOLVED",
  ]);
  const existing = (state.simulator.importDiagnostics ?? [])
    .filter((d) => !codes.has(d.code) || byId.get(d.id)?.enabled === false)
    .map((d) =>
      codes.has(d.code) && byId.get(d.id)?.disabledReason
        ? {
            ...d,
            entity: byId.get(d.id).entity,
            message: byId.get(d.id).disabledReason,
          }
        : d,
    );
  const seen = new Set(
    existing.filter((d) => codes.has(d.code)).map((d) => d.id),
  );
  for (const p of state.permissions ?? [])
    if (
      p.imported &&
      p.enabled === false &&
      p.disabledReason &&
      !seen.has(p.id)
    )
      existing.push({
        code: "PERMISSION_MAPPING_REQUIRED",
        id: p.id,
        entity: p.entity,
        message: p.disabledReason,
      });
  state.simulator.importDiagnostics = existing;
  return state;
}
function normalizeState(state, presetLibrary = builtinPresets) {
  const result = {
    ...emptyState(),
    ...clone(
      state
        ? { ...state, presets: compactBuiltinPresets(state.presets ?? {}, presetLibrary) }
        : state,
    ),
    settings: { ...emptyState().settings, ...state?.settings },
  };
  for (const key of ["mappings", "tables", "presets"])
    if (
      !result[key] ||
      Array.isArray(result[key]) ||
      typeof result[key] !== "object"
    )
      throw new DataError(`${key} must be an object`);
  for (const key of ["permissions", "plugins"])
    if (!Array.isArray(result[key]))
      throw new DataError(`${key} must be an array`);
  if (!["enforce", "permissive"].includes(result.settings.permissionMode))
    throw new DataError("Unknown permissionMode");
  if (
    result.settings.associationPermissions !== undefined &&
    !["enforce", "compatibility"].includes(
      result.settings.associationPermissions,
    )
  )
    throw new DataError("Unknown associationPermissions mode");
  for (const [name, rows] of Object.entries(result.tables)) {
    safeName(name);
    if (!Array.isArray(rows))
      throw new DataError(`Table ${name} must be an array`);
    for (const row of rows)
      if (!row || Array.isArray(row) || typeof row !== "object")
        throw new DataError(`Invalid row in ${name}`);
  }
  for (const [name, m] of Object.entries(result.mappings)) {
    safeName(name);
    if (m.entitySet) safeName(m.entitySet);
    if (m.idColumn) safeName(m.idColumn);
  }
  const entitySets = new Set();
  for (const [name, m] of Object.entries(result.mappings)) {
    if (m.entitySet) {
      if (entitySets.has(m.entitySet))
        throw new DataError(`Duplicate entitySet ${m.entitySet}`);
      entitySets.add(m.entitySet);
    }
    for (const [nav, rel] of Object.entries(m.relationships ?? {})) {
      safeName(nav);
      if (!rel.entity || !rel.from || !rel.to)
        throw new DataError(`Relationship ${name}.${nav} needs entity/from/to`);
      safeName(rel.entity);
      safeName(rel.from);
      safeName(rel.to);
    }
  }
  for (const rule of result.permissions) {
    if (!rule.entity) throw new DataError("Permission requires entity");
    if (rule.entity !== "*") safeName(rule.entity);
    if (
      rule.enabled !== false &&
      !["global", "contact", "account", "self", "parent"].includes(
        rule.scope ?? "global",
      )
    )
      throw new DataError(`Unsupported permission scope ${rule.scope}`);
    if (rule.operations && !Array.isArray(rule.operations))
      throw new DataError("Permission operations must be an array");
    for (const op of rule.operations ?? [])
      if (
        !["read", "create", "update", "delete", "append", "appendTo"].includes(
          op,
        )
      )
        throw new DataError(`Unknown permission operation ${op}`);
    if (rule.roles && !Array.isArray(rule.roles))
      throw new DataError("Permission roles must be an array");
    if (
      rule.enabled !== false &&
      rule.scope === "parent" &&
      (!rule.relationship?.entity ||
        !rule.relationship.from ||
        !rule.relationship.to)
    )
      throw new DataError(
        "Parent permission requires relationship entity/from/to",
      );
  }
  const checkExpr = (expr) => {
    if (
      expr &&
      typeof expr === "object" &&
      !Array.isArray(expr) &&
      !own(expr, "literal")
    ) {
      if (
        ![
          "concat",
          "coalesce",
          "lower",
          "upper",
          "sum",
          "multiply",
          "uuid",
          "sequence",
          "now",
          "split",
          "join",
          "length",
          "lookup",
          "find",
          "findMany",
          "related",
          "reference",
        ].includes(expr.op) &&
        !expressionOperator(expr.op)
      )
        throw new DataError(`Unsupported plugin expression ${expr.op}`);
      if (expr.args && !Array.isArray(expr.args))
        throw new DataError("Expression args must be an array");
      for (const arg of expr.args ?? []) checkExpr(arg);
      if (["find", "findMany"].includes(expr.op)) {
        if (
          !expr.match ||
          typeof expr.match !== "object" ||
          Array.isArray(expr.match) ||
          !Object.keys(expr.match).length
        )
          throw new DataError("Plugin find requires explicit matching fields");
        for (const [key, value] of Object.entries(expr.match)) {
          safeName(key);
          checkExpr(value);
        }
      }
    }
  };
  const pluginIds = new Set();
  for (const p of result.plugins) {
    if (!p.entity) throw new DataError("Plugin requires entity");
    if (p.id) {
      if (pluginIds.has(p.id))
        throw new DataError(`Duplicate plugin id ${p.id}`);
      pluginIds.add(p.id);
    }
    if (p.operations && !Array.isArray(p.operations))
      throw new DataError("Plugin operations must be an array");
    for (const op of p.operations ?? [])
      if (!["create", "update", "delete"].includes(op))
        throw new DataError(`Unknown plugin operation ${op}`);
    if (p.when) compileFilter(p.when);
    if (p.validate && !Array.isArray(p.validate))
      throw new DataError("Plugin validate must be an array");
    for (const v of p.validate ?? []) {
      if (v.pattern) new RegExp(v.pattern);
      if (v.assert) compileFilter(v.assert);
      if (v.field) safeName(v.field);
      // Dataverse reports plugin exceptions as ISV aborted (0x80040265) unless
      // the simulated plugin names the platform error it reproduces.
      if (v.innerCode != null && !/^0x[0-9a-f]{8}$/i.test(String(v.innerCode)))
        throw new DataError("Plugin validation innerCode must be a 0x-prefixed 8-digit hex code");
    }
    for (const bag of [p.defaults, p.set])
      for (const [key, expr] of Object.entries(bag ?? {})) {
        safeName(key);
        checkExpr(expr);
      }
    if (p.secondary && !Array.isArray(p.secondary))
      throw new DataError("Plugin secondary must be an array");
    for (const action of p.secondary ?? []) {
      if (
        action.requireMatch != null &&
        typeof action.requireMatch !== "boolean"
      )
        throw new DataError("Secondary requireMatch must be a boolean");
      if (action.foreach) checkExpr(action.foreach);
      if (
        !action.entity ||
        !["create", "update", "delete"].includes(action.operation)
      )
        throw new DataError(
          "Secondary action requires entity and create/update/delete operation",
        );
      if (action.operation !== "create" && !action.match)
        throw new DataError("Secondary update/delete requires match");
      for (const bag of [action.match, action.set])
        for (const [key, expr] of Object.entries(bag ?? {})) {
          safeName(key);
          checkExpr(expr);
        }
    }
  }
  return reconcilePermissionDiagnostics(result);
}

export class DataStore {
  constructor({ file = null, state = emptyState(), presetLibrary = builtinPresets } = {}) {
    this.file = file;
    this.presetLibrary = presetLibrary;
    this.state = normalizeState(state, this.presetLibrary);
    this.persistedDigest = null;
    this.queue = Promise.resolve();
    // Advances with every committed change (transact), so consumers such as OData
    // paging can bind to the data without digesting the whole state per request.
    this.revision = 0;
  }
  /**
   * A key that changes whenever the data a query reads may have changed: committed
   * store changes and a new site-table provider value (a reloaded portal).
   */
  dataRevision() {
    const site = this.virtualTables?.() ?? null;
    if (site !== this.siteTablesSeen) {
      this.siteTablesSeen = site;
      this.siteRevision = (this.siteRevision ?? 0) + 1;
    }
    return `${this.revision}.${this.siteRevision ?? 0}`;
  }
  async init() {
    if (this.file) {
      try {
        const raw = await readFile(this.file, "utf8");
        this.state = normalizeState(JSON.parse(raw), this.presetLibrary);
        this.persistedDigest = this.digest(raw);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.persistedDigest = null;
        await this.save();
      }
    }
    return this;
  }
  snapshot(projection) {
    if (projection === undefined) return clone(this.state);
    if (
      !projection ||
      typeof projection !== "object" ||
      Array.isArray(projection)
    )
      throw new DataError(
        "Snapshot projection must name sections, tables or mappings",
      );
    const selected = {};
    for (const [kind, names] of Object.entries(projection)) {
      if (
        !["sections", "tables", "mappings"].includes(kind) ||
        !Array.isArray(names)
      )
        throw new DataError("Invalid snapshot projection");
      for (const name of names) {
        safeName(name);
        if (kind === "sections") {
          if (own(this.state, name)) selected[name] = this.state[name];
        } else {
          selected[kind] ??= {};
          if (own(this.state[kind], name))
            selected[kind][name] = this.state[kind][name];
        }
      }
    }
    return clone(selected);
  }
  summary() {
    const selected = this.snapshot({
      sections: [
        "version",
        "settings",
        "simulator",
        "mappings",
        "permissions",
        "plugins",
      ],
      tables: ["contact"],
    });
    selected.presets = Object.fromEntries(
      Object.entries(this.state.presets ?? {}).map(([id, preset]) => [
        id,
        {
          name: preset.name,
          description: preset.description,
          userConfigured: preset.userConfigured,
        },
      ]),
    );
    selected.tableCounts = Object.fromEntries(
      Object.entries(this.state.tables ?? {}).map(([name, rows]) => [
        name,
        rows.length,
      ]),
    );
    return selected;
  }
  async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const lockPath = `${this.file}.lock`,
      lockToken = `${process.pid}:${randomUUID()}`,
      temp = `${this.file}.${randomUUID()}.tmp`;
    let lockHandle;
    try {
      try {
        lockHandle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST")
          throw new DataError(
            "Local state is being written by another process; retry after it finishes",
            409,
            "StateConflict",
          );
        throw error;
      }
      await lockHandle.writeFile(`${lockToken}\n`);
      await lockHandle.close();
      lockHandle = null;

      const current = await this.readPersistedDigest();
      if (current !== this.persistedDigest)
        throw new DataError(
          "Local state changed outside this runtime; restart the simulator from the updated state file before writing",
          409,
          "StateConflict",
        );

      const serialized = JSON.stringify(this.state, null, 2) + "\n";
      await writeFile(temp, serialized, { flag: "wx" });
      // Recheck immediately before replacement to catch non-cooperating edits
      // made while the temporary snapshot was being prepared.
      if ((await this.readPersistedDigest()) !== this.persistedDigest)
        throw new DataError(
          "Local state changed outside this runtime; restart the simulator from the updated state file before writing",
          409,
          "StateConflict",
        );
      await rename(temp, this.file);
      this.persistedDigest = this.digest(serialized);
    } finally {
      if (lockHandle) await lockHandle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
      // Remove only the lock this save created. Never infer staleness or
      // delete a lock owned by another process.
      try {
        if ((await readFile(lockPath, "utf8")) === `${lockToken}\n`)
          await unlink(lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  digest(raw) {
    return createHash("sha256").update(raw).digest("hex");
  }
  async readPersistedDigest() {
    try {
      return this.digest(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  transact(fn) {
    const run = this.queue.then(async () => {
      const backup = clone(this.state);
      try {
        const result = await fn();
        await this.save();
        this.revision++;
        return clone(result);
      } catch (error) {
        this.state = backup;
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async replaceState(state, { expectedSnapshot } = {}) {
    return this.transact(() => {
      if (expectedSnapshot !== undefined && JSON.stringify(this.snapshot()) !== expectedSnapshot)
        throw new DataError("Local state changed before replacement; no imported state was applied", 409, "StateConflict");
      this.state = normalizeState(state, this.presetLibrary);
      return this.snapshot();
    });
  }
  /**
   * Read-only tables a host derives from the portal export (site components,
   * web role memberships): provider() -> { tables: { logical: { mapping, rows } },
   * relationships: { logical: { navigation: rel } } }. Local mappings and rows win.
   */
  setVirtualTables(provider) {
    this.virtualTables = typeof provider === "function" ? provider : null;
  }
  /**
   * The site's observed platform behaviour (createSimulator `observed`,
   * lib/project-config.mjs observedConfig). rules() reads anonymousDataAccess.
   */
  setObserved(observed) {
    this.observed = observed ?? null;
  }
  /** Exported registrations use an explicit local adapter, never compiled .NET. */
  setPluginPipeline(provider, active = () => true) {
    if (typeof provider !== 'function') throw new DataError('Plugin pipeline must be a function.');
    this.pluginPipeline = provider;
    this.pluginPipelineActive = active;
  }
  exportedPluginPhase(mapping, operation, stage, target, row, previous, identity, changedAttributes, options = {}) {
    if (!this.pluginPipeline || !this.pluginPipelineActive({ entity: mapping.logicalName, operation })) return;
    const id = row[mapping.idColumn];
    this.pluginPipeline?.({ entity: mapping.logicalName, operation, stage, target, record: row, previous, identity, changedAttributes });
    if (!equal(row[mapping.idColumn], id)) throw new DataError('Plugin target cannot replace the primary key.', 400, 'LocalPluginInvalid');
    if (stage !== 40 && operation !== 'delete') {
      const normalized = this.normalizeRecord(mapping, target);
      if (options.coerce) this.coerceRecord(mapping, normalized, options);
      if (normalized[mapping.idColumn] !== undefined && !equal(normalized[mapping.idColumn], id)) throw new DataError('Plugin target cannot replace the primary key.', 400, 'LocalPluginInvalid');
      Object.assign(target, normalized);
      Object.assign(row, normalized);
      if (options.coerce) this.assertStateStatus(mapping, row, options);
    }
  }
  virtualTable(name) {
    const tables = this.virtualTables?.()?.tables;
    if (!tables) return null;
    if (own(tables, name)) return tables[name];
    return Object.values(tables).find((table) => table.mapping.entitySet === name) ?? null;
  }
  /** Rows of a table: a virtual site table when the host supplies one, else local data. */
  tableRows(logical) {
    return this.virtualTable(logical)?.rows ?? this.state.tables[logical] ?? [];
  }
  /** Site tables are derived from the export; local writes to them aren't simulated. */
  assertWritable(logical) {
    if (this.virtualTable(logical))
      throw new DataError(
        `${logical} rows come from the portal export and are read-only locally.`,
        501,
        "NotImplemented",
      );
  }
  resolveMapping(entity) {
    safeName(entity);
    let logical = entity;
    let m = this.state.mappings[entity];
    if (!m) {
      const hit = Object.entries(this.state.mappings).find(
        ([, value]) => value.entitySet === entity,
      );
      if (hit) {
        logical = hit[0];
        m = hit[1];
      }
    }
    if (!m && !own(this.state.tables, logical)) {
      const site = this.virtualTable(entity);
      if (!site)
        throw new DataError(
          `No mapping or local table for ${entity}`,
          404,
          "UnknownEntity",
        );
      logical = site.mapping.logicalName;
      m = site.mapping;
    }
    const resolved = {
      logicalName: logical,
      entitySet: m?.entitySet ?? logical,
      idColumn: m?.idColumn ?? `${logical}id`,
      relationships: m?.relationships ?? {},
      ...m,
    };
    const extra = this.virtualTables?.()?.relationships?.[logical];
    if (extra) resolved.relationships = { ...extra, ...(m?.relationships ?? {}) };
    return resolved;
  }
  rules(entity, operation, identity = {}) {
    // "Disable anonymous access" (Learn, disable-anonymous-access), a tenant governance
    // control that the export can't show: observed.anonymousDataAccess "blocked" keeps
    // anonymous visitors from reading Dataverse data even when a table permission grants
    // the Anonymous Users role; they can still write data.
    if (
      operation === "read" &&
      this.observed?.anonymousDataAccess === "blocked" &&
      !identity.admin &&
      !identity.id &&
      !identity.contactId
    )
      return [];
    const roleIds = new Set(
      (identity.roleIds ?? []).map((id) => String(id).toLowerCase()),
    );
    const roles = new Set([
      ...(identity.roles ?? []),
      ...(identity.roleSource === "memberships"
        ? []
        : identity.id || identity.contactId
          ? ["Authenticated Users"]
          : ["Anonymous Users"]),
    ]);
    const anonymous = !identity.admin && !identity.id && !identity.contactId;
    return this.state.permissions.filter(
      (p) =>
        p.enabled !== false &&
        (p.entity === entity || p.entity === "*") &&
        (p.operations ?? ["read"]).includes(operation) &&
        (identity.roleSource === "memberships" &&
        (p.imported || p.roleIds?.length)
          ? (p.roleIds ?? []).some((id) =>
              roleIds.has(String(id).toLowerCase()),
            )
          : !p.roles?.length || p.roles.some((r) => roles.has(r))) &&
        (!anonymous || this.grantsWithoutContact(p)),
    );
  }
  /**
   * Whether a table permission can grant anything to a visitor without a contact. The
   * Self, Contact and Account scopes, and parent chains rooted in them, need the
   * signed-in contact, so for anonymous visitors they grant nothing and a table they
   * alone cover answers 403 90040120. Observed live: a Self grant on the Anonymous
   * Users role still answers 403 to an anonymous contacts read.
   */
  grantsWithoutContact(rule, seen = new Set()) {
    const scope = rule.scope ?? "global";
    if (scope === "global") return true;
    if (scope !== "parent" || seen.has(rule.id)) return false;
    seen.add(rule.id);
    const parentId = rule.parentPermissionId ?? rule.parentId;
    const parent =
      parentId == null
        ? null
        : this.state.permissions.find((p) => p.enabled !== false && equal(p.id, parentId));
    return Boolean(parent) && this.grantsWithoutContact(parent, seen);
  }
  /**
   * Per-evaluation indexes and results for table-permission checks. Parent
   * and identity scopes look rows up by key instead of scanning every parent
   * and intersect row for every child (rows x parents x edges). A memo is
   * only valid while the store state is unchanged, so it never outlives one
   * rows() call or one top-level allowed() call.
   */
  permissionMemo() {
    const indexes = new Map(),
      results = new Map(),
      rules = new Map();
    const lookup = (logical, column, value) => {
      const key = `${logical}\u0000${column}`;
      if (!indexes.has(key)) {
        const index = new Map();
        for (const item of this.tableRows(logical)) {
          const raw = field(item, column);
          if (raw == null) continue;
          const itemKey = comparable(raw);
          if (!index.has(itemKey)) index.set(itemKey, []);
          index.get(itemKey).push(item);
        }
        indexes.set(key, index);
      }
      return value == null ? [] : (indexes.get(key).get(comparable(value)) ?? []);
    };
    return {
      lookup,
      results,
      rules: (entity, operation, identity) => {
        const key = `${entity}\u0000${operation}`;
        if (!rules.has(key)) rules.set(key, this.rules(entity, operation, identity));
        return rules.get(key);
      },
      /** Targets related to `row` through `rel` (direct lookup or intersect table). */
      related: (row, rel, targetLogical) => {
        const value = field(row, rel.from);
        if (value == null) return [];
        if (!rel.intersect) return lookup(targetLogical, rel.to, value);
        const edgeTable = this.resolveMapping(rel.intersect.entity).logicalName;
        const out = [];
        for (const edge of lookup(edgeTable, rel.intersect.from, value)) {
          const target = field(edge, rel.intersect.to);
          if (target != null) out.push(...lookup(targetLogical, rel.to, target));
        }
        return out;
      },
    };
  }
  allowed(
    entity,
    operation,
    row,
    identity = {},
    chain = new Set(),
    permissionId = null,
    memo = this.permissionMemo(),
  ) {
    if (identity.admin || this.state.settings.permissionMode === "permissive")
      return true;
    const mapping = this.resolveMapping(entity);
    const visit = `${mapping.logicalName}:${scalar(row?.[mapping.idColumn])}:${operation}:${permissionId ?? "*"}`;
    if (chain.has(visit))
      throw new DataError(
        "Cyclic parent table permission",
        400,
        "InvalidPermission",
      );
    const rowId = row?.[mapping.idColumn];
    const cacheKey =
      rowId == null
        ? null
        : `${mapping.logicalName}\u0000${comparable(rowId)}\u0000${operation}\u0000${permissionId ?? "*"}`;
    if (cacheKey != null && memo.results.has(cacheKey)) return memo.results.get(cacheKey);
    const nextChain = new Set([...chain, visit]);
    const result = memo
      .rules(mapping.logicalName, operation, identity)
      .filter((rule) => !permissionId || equal(rule.id, permissionId))
      .some((rule) => {
        const scope = rule.scope ?? "global";
        if (scope === "global") return true;
        if (!row) return false;
        if (rule.identityRelationship) {
          const rel = rule.identityRelationship;
          const im = this.resolveMapping(rel.entity);
          const identityId =
            rel.entity === "account"
              ? identity.accountId
              : (identity.contactId ?? identity.id);
          if (!identityId) return false;
          const person = memo.lookup(im.logicalName, im.idColumn, identityId);
          if (!person.length) return false;
          const people = new Set(person);
          return memo.related(row, rel, im.logicalName).some((target) => people.has(target));
        }
        const value = scalar(
          field(
            row,
            rule.field ??
              (scope === "self"
                ? mapping.idColumn
                : scope === "account"
                  ? "parentcustomerid"
                  : "contactid"),
          ),
        );
        if (scope === "self" || scope === "contact")
          return (
            Boolean(identity.contactId || identity.id) &&
            equal(value, identity.contactId ?? identity.id)
          );
        if (scope === "account")
          return (
            Boolean(identity.accountId) && equal(value, identity.accountId)
          );
        if (scope === "parent") {
          const rel = rule.relationship;
          if (!rel?.entity || !rel.from || !rel.to)
            throw new DataError(
              "Parent permission requires relationship entity/from/to",
            );
          const pm = this.resolveMapping(rel.entity);
          return memo.related(row, rel, pm.logicalName).some((parent) =>
            this.allowed(
              pm.logicalName,
              "read",
              parent,
              identity,
              nextChain,
              rule.parentPermissionId,
              memo,
            ),
          );
        }
        throw new DataError(`Unsupported permission scope ${scope}`);
      });
    if (cacheKey != null) memo.results.set(cacheKey, result);
    return result;
  }
  assertAllowed(entity, operation, row, identity, related) {
    if (!this.allowed(entity, operation, row, identity))
      throw new DataError(
        `Table permission denies ${operation} on ${entity}`,
        403,
        "PermissionDenied",
        { operation, table: entity, ...(related ? { related } : {}) },
      );
  }
  rows(entity, identity = {}) {
    const m = this.resolveMapping(entity);
    const memo = this.permissionMemo();
    return this.tableRows(m.logicalName).filter((r) =>
      this.allowed(m.logicalName, "read", r, identity, new Set(), null, memo),
    );
  }
  relationshipMatches(row, target, rel) {
    if (!rel.intersect)
      return (
        field(row, rel.from) != null &&
        equal(field(row, rel.from), field(target, rel.to))
      );
    const mapping = this.resolveMapping(rel.intersect.entity);
    return this.tableRows(mapping.logicalName).some(
      (edge) =>
        field(row, rel.from) != null &&
        field(target, rel.to) != null &&
        equal(field(row, rel.from), field(edge, rel.intersect.from)) &&
        equal(field(target, rel.to), field(edge, rel.intersect.to)),
    );
  }
  get(entity, id, identity = {}) {
    const m = this.resolveMapping(entity);
    const row = this.tableRows(m.logicalName).find((r) =>
      equal(r[m.idColumn], id),
    );
    if (!row) return null;
    this.assertAllowed(m.logicalName, "read", row, identity);
    return clone(row);
  }
  /** Field metadata from explicit mappings or a caller-supplied solution metadata resolver. */
  fieldDefinition(logical, attribute, metadata) {
    if (!attribute) return undefined;
    const lookup = /^_(.+)_value$/.exec(attribute);
    const name = lookup ? lookup[1] : attribute;
    const find = (fields) =>
      fields && typeof fields === "object"
        ? (fields[name] ??
          fields[
            Object.keys(fields).find(
              (key) => key.toLowerCase() === name.toLowerCase(),
            )
          ])
        : undefined;
    let mapping = null;
    try {
      mapping = this.resolveMapping(logical);
    } catch {
      mapping = null;
    }
    const external =
      typeof metadata === "function"
        ? metadata(mapping?.logicalName ?? logical)
        : null;
    return (
      find(external) ?? find(mapping?.fields) ?? find(mapping?.fieldMetadata)
    );
  }
  /** Fiscal calendar settings: explicit settings win over the organization row. */
  fiscalSettings(settings = this.state.settings ?? {}) {
    const explicit = ["fiscalCalendarStart", "fiscalPeriodType", "fiscalPeriodsPerYear"].some(
      (key) => settings[key] != null && settings[key] !== "",
    );
    if (explicit)
      return {
        fiscalCalendarStart: settings.fiscalCalendarStart,
        fiscalPeriodType: settings.fiscalPeriodType,
        fiscalPeriodsPerYear: settings.fiscalPeriodsPerYear,
      };
    const organizations = this.state.tables?.organization ?? [];
    if (organizations.length !== 1) return {};
    const [organization] = organizations;
    return {
      fiscalCalendarStart: scalar(organization.fiscalcalendarstart) ?? undefined,
      fiscalPeriodType: scalar(organization.fiscalperiodtype) ?? undefined,
    };
  }
  /** Query evaluation settings: collation, local time zone and fiscal calendar. */
  querySettings() {
    const settings = this.state.settings ?? {};
    return {
      collation: settings.collation ?? "CI_AI",
      timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
      languageCode: settings.languageCode,
      // The organisation fiscal calendar (lib/fiscal-calendar.mjs): simulator settings, else
      // the FiscalCalendarStart and FiscalPeriodType of a single local organization row.
      ...this.fiscalSettings(settings),
      // Local bound on intermediate FetchXML join rows (FETCH_LIMITS.joinRows by default).
      fetchJoinRowLimit: settings.fetchJoinRowLimit,
      // "strict" rejects FetchXML columns that complete Solution metadata lacks.
      fetchColumnValidation: settings.fetchColumnValidation,
    };
  }
  /**
   * Query-local, immutable caches of this identity's readable rows and
   * relationship indexes. Never share them across requests or mutations.
   */
  queryContext(identity = {}, options = {}) {
    const readable = new Map();
    const readRows = (logical) => {
      const name = this.resolveMapping(logical).logicalName;
      if (!readable.has(name)) readable.set(name, this.rows(name, identity));
      return readable.get(name);
    };
    const key = (value) => {
      const raw = scalar(value);
      return raw == null || raw === "" ? null : comparable(raw);
    };
    const indexes = new Map();
    const indexBy = (cacheKey, rows, column) => {
      if (!indexes.has(cacheKey)) {
        const index = new Map();
        for (const row of rows) {
          const value = key(columnValue(row, column));
          if (value == null) continue;
          if (!index.has(value)) index.set(value, []);
          index.get(value).push(row);
        }
        indexes.set(cacheKey, index);
      }
      return indexes.get(cacheKey);
    };
    const related = (row, rel) => {
      const target = this.resolveMapping(rel.entity);
      const value = key(columnValue(row, rel.from));
      if (value == null) return [];
      const targets = indexBy(
        `t\u0000${target.logicalName}\u0000${rel.to}`,
        readRows(target.logicalName),
        rel.to,
      );
      if (!rel.intersect) return targets.get(value) ?? [];
      const edgeMapping = this.resolveMapping(rel.intersect.entity);
      const edges = indexBy(
        `e\u0000${edgeMapping.logicalName}\u0000${rel.intersect.from}`,
        this.tableRows(edgeMapping.logicalName),
        rel.intersect.from,
      );
      const out = [],
        seen = new Set();
      for (const edge of edges.get(value) ?? [])
        for (const item of targets.get(
          key(columnValue(edge, rel.intersect.to)),
        ) ?? [])
          if (!seen.has(item)) {
            seen.add(item);
            out.push(item);
          }
      return out;
    };
    const names = new Map();
    const lookupName = (reference) => {
      if (!reference) return undefined;
      if (reference.name != null) return reference.name;
      const logical = reference.logical_name ?? reference.logicalName;
      if (!logical) return undefined;
      let mapping;
      try {
        mapping = this.resolveMapping(logical);
      } catch {
        return undefined;
      }
      if (!names.has(mapping.logicalName)) {
        const index = new Map();
        for (const row of this.tableRows(mapping.logicalName)) {
          const id = key(row[mapping.idColumn]);
          if (id != null)
            index.set(
              id,
              primaryNameValue(mapping, row),
            );
        }
        names.set(mapping.logicalName, index);
      }
      return names.get(mapping.logicalName).get(key(reference.id));
    };
    return {
      dialect: options.dialect ?? "extended",
      readRows,
      related,
      navigate: (mapping, row, name) => {
        const rel = mapping.relationships?.[name];
        if (!rel) return null;
        const target = this.resolveMapping(rel.entity);
        if (row == null)
          return rel.many === false
            ? { mapping: target, value: null, many: false }
            : { mapping: target, value: [], many: true };
        const rows = related(row, rel);
        return rel.many === false
          ? { mapping: target, value: rows[0] ?? null, many: false }
          : { mapping: target, value: rows, many: true };
      },
      definition: (logical, attribute) =>
        this.fieldDefinition(logical, attribute, options.metadata),
      column: (logical, attribute) => this.columnStatus(logical, attribute, options.metadata),
      lookupName,
      identity,
      settings: this.querySettings(),
      now: Date.now(),
    };
  }
  /**
   * Whether a table has a column: "known" (field metadata, a relationship column, the
   * primary key, or a stored row when the metadata isn't complete), "unknown" (the
   * mapping declares schemaComplete and none of those name it) or "unverified"
   * (incomplete metadata and no stored row has it).
   */
  columnStatus(logical, attribute, metadata) {
    let mapping;
    try {
      mapping = this.resolveMapping(logical);
    } catch {
      return "unverified";
    }
    const name = String(attribute ?? "");
    if (!name) return "unverified";
    const lower = name.toLowerCase();
    if (name === mapping.idColumn) return "known";
    if (Object.keys(this.fieldDefinitions(mapping.logicalName, metadata)).some((key) => key.toLowerCase() === lower))
      return "known";
    if (Object.values(mapping.relationships ?? {}).some((rel) => String(rel?.from ?? "").toLowerCase() === lower))
      return "known";
    // Dataverse's virtual name columns, which Solution XML doesn't list: <lookup>name and
    // <lookup>yominame, and <choice|status|state|two-options>name (statecodename).
    const virtual = /^(.+?)(yominame|name)$/.exec(lower);
    if (virtual) {
      const definitions = this.fieldDefinitions(mapping.logicalName, metadata);
      const baseKey = Object.keys(definitions).find((key) => key.toLowerCase() === virtual[1]);
      const kind = baseKey ? fieldKind(definitions[baseKey]) : null;
      const lookup =
        kind === "lookup" ||
        Object.values(mapping.relationships ?? {}).some((rel) => rel?.many === false && String(rel.from ?? "").toLowerCase() === virtual[1]);
      if (lookup || (virtual[2] === "name" && ["choice", "multichoice", "boolean"].includes(kind))) return "known";
    }
    if (mapping.schemaComplete === true) return "unknown";
    // Stored columns per table, rebuilt only after the data changes.
    const revision = this.dataRevision();
    this.storedColumns ??= new Map();
    let entry = this.storedColumns.get(mapping.logicalName);
    if (!entry || entry.revision !== revision) {
      const columns = new Set();
      for (const row of this.tableRows(mapping.logicalName)) for (const key of Object.keys(row)) columns.add(key);
      entry = { revision, columns };
      this.storedColumns.set(mapping.logicalName, entry);
    }
    return entry.columns.has(name) ? "known" : "unverified";
  }
  /** Resolve a $orderby/$apply path from a root row (single-valued navigation only). */
  pathValue(ctx, mapping, row, segments) {
    let current = row,
      currentMapping = mapping;
    for (const segment of segments.slice(0, -1)) {
      const navigation = ctx.navigate(currentMapping, current, segment);
      if (!navigation || navigation.many)
        throw new DataError(
          `Navigation ${segment} must be a single-valued navigation property`,
          400,
          "UnsupportedQuery",
        );
      current = navigation.value;
      currentMapping = navigation.mapping;
      if (current == null) return undefined;
    }
    return columnValue(current, segments.at(-1));
  }
  pathMapping(ctx, mapping, segments) {
    let currentMapping = mapping;
    for (const segment of segments) {
      const rel = currentMapping.relationships?.[segment];
      if (!rel)
        throw new DataError(
          `No relationship mapping for ${currentMapping.logicalName}.${segment}`,
          400,
          "MissingRelationship",
        );
      currentMapping = this.resolveMapping(rel.entity);
    }
    return currentMapping;
  }
  pathDefinition(ctx, mapping, segments) {
    const target = this.pathMapping(ctx, mapping, segments.slice(0, -1));
    return ctx.definition(target.logicalName, segments.at(-1));
  }
  /** Compile nested $expand options once per query. */
  prepareExpand(ctx, mapping, specs, query) {
    return specs.map((spec) => {
      const rel = mapping.relationships?.[spec.navigation];
      if (!rel)
        throw new DataError(
          `No relationship mapping for ${mapping.logicalName}.${spec.navigation}`,
          400,
          "MissingRelationship",
        );
      const target = this.resolveMapping(rel.entity);
      return {
        navigation: spec.navigation,
        rel,
        target,
        predicate: spec.filter
          ? compileODataPredicate(
              parseODataExpression(spec.filter, query),
              target,
              ctx,
            )
          : null,
        order: parseOrderBy(spec.orderby, query),
        top: spec.top == null ? null : boundedInt(spec.top, "$top"),
        select: parseSelect(spec.select),
        expand: this.prepareExpand(ctx, target, spec.expand ?? [], query),
      };
    });
  }
  projectRow(ctx, mapping, row, select, expand, includeKeys = false) {
    // Dataverse always returns the primary key, selected or not.
    const out = project(
      row,
      includeKeys && Array.isArray(select) && !select.includes(mapping.idColumn)
        ? [...select, mapping.idColumn]
        : select,
    );
    for (const spec of expand) {
      let linked = ctx.related(row, spec.rel);
      if (spec.predicate) linked = linked.filter(spec.predicate);
      if (spec.order.length)
        linked = sortRows(linked, spec.order, {
          mapping: spec.target,
          valueOf: (item, path) => this.pathValue(ctx, spec.target, item, path),
          definition: (path) => this.pathDefinition(ctx, spec.target, path),
          lookupName: ctx.lookupName,
          collation: ctx.settings.collation,
          tieBreak: false,
        });
      if (spec.top != null) linked = linked.slice(0, spec.top);
      const nested = (item) =>
        this.projectRow(ctx, spec.target, item, spec.select, spec.expand, includeKeys);
      out[spec.navigation] =
        spec.rel.many === false
          ? linked[0]
            ? nested(linked[0])
            : null
          : linked.map(nested);
    }
    return out;
  }
  /**
   * OData collection query. options.dialect "dataverse" applies the public
   * Web API grammar; the default "extended" dialect serves internal reads.
   */
  query(entity, params = {}, identity = {}, paging, options = {}) {
    const m = this.resolveMapping(entity);
    const p =
      params instanceof URLSearchParams
        ? Object.fromEntries(params)
        : { ...params };
    if (p.fetchXml || p.fetchxml) {
      const r = this.fetchXml(p.fetchXml ?? p.fetchxml, identity, options);
      return { value: r.entities, "@odata.count": r.total_record_count };
    }
    const dialect = options.dialect ?? "extended";
    const aliases = Object.create(null);
    for (const key of Object.keys(p)) {
      if (key.startsWith("@")) {
        aliases[key] = p[key];
        continue;
      }
      if (
        key.startsWith("$") &&
        ![
          "$filter",
          "$select",
          "$expand",
          "$orderby",
          "$top",
          "$skip",
          "$count",
          "$apply",
        ].includes(key)
      )
        throw new DataError(
          `Unsupported OData option ${key}`,
          400,
          "UnsupportedQuery",
        );
    }
    if (
      !identity.admin &&
      this.state.settings.permissionMode !== "permissive" &&
      !this.rules(m.logicalName, "read", identity).length
    )
      throw new DataError(
        `Table permission denies read on ${entity}`,
        403,
        "PermissionDenied",
        { operation: "read", table: m.logicalName },
      );
    const queryOptions = { dialect, aliases };
    const ctx = this.queryContext(identity, { ...options, dialect });
    let rows = ctx.readRows(m.logicalName);
    // Single-record and navigation routes restrict the readable rows first.
    if (options.id != null)
      rows = rows.filter((row) => equal(row[m.idColumn], options.id));
    if (options.ids) {
      const wanted = new Set([...options.ids].map(comparable));
      rows = rows.filter((row) => wanted.has(comparable(row[m.idColumn])));
    }
    if (p.$filter != null && String(p.$filter).trim() !== "")
      rows = rows.filter(
        compileODataPredicate(
          parseODataExpression(p.$filter, queryOptions),
          m,
          ctx,
        ),
      );
    const order = parseOrderBy(p.$orderby, queryOptions);
    const sortOptions = {
      mapping: m,
      valueOf: (row, path) => this.pathValue(ctx, m, row, path),
      definition: (path) => this.pathDefinition(ctx, m, path),
      lookupName: ctx.lookupName,
      collation: ctx.settings.collation,
    };
    if (p.$apply) {
      for (const key of ["$select", "$expand", "$skip"])
        if (own(p, key))
          throw new DataError(
            `OData $apply can't be combined with ${key}`,
            400,
            "UnsupportedQuery",
          );
      const steps = parseApply(p.$apply, queryOptions);
      const applied = evaluateApply(steps, rows, {
        ...ctx,
        mapping: m,
        pathValue: (row, segments) => this.pathValue(ctx, m, row, segments),
        pathDefinition: (segments) => this.pathDefinition(ctx, m, segments),
        targetLogicalName: (segments) =>
          this.pathMapping(ctx, m, segments).logicalName,
      });
      let values = applied.rows;
      if (order.length) {
        const aggregateAliases = new Set(
          steps.flatMap((step) =>
            (step.aggregates ?? []).map((aggregate) => aggregate.alias),
          ),
        );
        for (const spec of order)
          if (aggregateAliases.has(spec.path.join("/")))
            throw new DataError(
              "The query node SingleValueOpenPropertyAccess is not supported",
              400,
              "UnsupportedQuery",
            );
        values = sortRows(values, order, {
          ...sortOptions,
          valueOf: (row, path) => row[path.join("/")],
          definition: (path) =>
            path.length === 1
              ? ctx.definition(m.logicalName, path[0])
              : undefined,
          tieBreak: false,
        });
      }
      if (p.$top != null) values = values.slice(0, boundedInt(p.$top, "$top"));
      return { value: clone(values) };
    }
    const count = rows.length,
      publicCount = paging ? Math.min(count, 5000) : count;
    // Public pages always have a deterministic primary-key tie breaker.
    if (order.length || paging)
      rows = sortRows(rows, order, {
        ...sortOptions,
        tieBreak: Boolean(paging),
      });
    const skip = paging ? paging.offset : boundedInt(p.$skip ?? 0, "$skip"),
      totalLimit = paging
        ? Math.min(count, p.$top == null ? count : boundedInt(p.$top, "$top"))
        : rows.length,
      top = paging
        ? Math.min(paging.pageSize, Math.max(totalLimit - skip, 0))
        : p.$top == null
          ? rows.length
          : boundedInt(p.$top, "$top");
    rows = rows.slice(skip, skip + top);
    const select = parseSelect(p.$select);
    const expand = this.prepareExpand(
      ctx,
      m,
      parseExpand(p.$expand),
      queryOptions,
    );
    const values = rows.map((row) =>
      this.projectRow(ctx, m, row, select, expand, options.includeKeys === true),
    );
    return {
      value: clone(values),
      ...(String(p.$count) === "true" ? { "@odata.count": publicCount } : {}),
      ...(paging
        ? {
            paging: {
              nextOffset: skip + values.length,
              moreRecords: skip + values.length < totalLimit,
              totalCount: count,
            },
          }
        : {}),
    };
  }
  normalizeRecord(mapping, data) {
    const row = clone(data);
    for (const [key, value] of Object.entries(row)) {
      safeName(key.replace(/@odata\.bind$/, ""));
      if (key.endsWith("@odata.bind")) {
        const navigation = key.slice(0, -11),
          relationship = mapping.relationships?.[navigation],
          field = relationship?.from ?? navigation;
        if (relationship?.many)
          throw new DataError(
            `Collection binding ${key} is not supported`,
            400,
            "InvalidLookup",
          );
        if (Object.hasOwn(row, field))
          throw new DataError(
            `Lookup field ${field} and navigation binding cannot both be supplied`,
            400,
            "InvalidLookup",
          );
        if (value === null) {
          row[field] = null;
          delete row[key];
          continue;
        }
        const reference = parseEntityReference(value);
        if (!reference) throw new DataError(`Invalid lookup binding ${key}`);
        const target = this.resolveMapping(reference.set);
        if (relationship && relationship.entity !== target.logicalName)
          throw new DataError(
            `Lookup binding target does not match navigation ${navigation}`,
            400,
            "InvalidLookup",
          );
        const hit = this.findByKey(target, reference.id);
        if (!hit)
          throw new DataError(
            `Lookup target ${value} does not exist`,
            400,
            "InvalidLookup",
          );
        row[field] = {
          id: hit[target.idColumn],
          logical_name: target.logicalName,
          name: primaryNameValue(target, hit) ?? "",
        };
        delete row[key];
      }
    }
    return row;
  }
  /**
   * Resolve a key segment: a primary key (GUID with or without braces) or an
   * alternate key (attr='v',attr2=1) declared in mapping.alternateKeys.
   */
  findByKey(mapping, key) {
    const rows = this.tableRows(mapping.logicalName);
    const parts = parseKeySegment(key);
    if (!parts) return rows.find((r) => equal(r[mapping.idColumn], key));
    const names = Object.keys(parts).sort();
    const declared = (mapping.alternateKeys ?? []).some((alternate) => {
      const attributes = (alternate.attributes ?? alternate.keyAttributes ?? [])
        .map((name) => String(name).toLowerCase())
        .sort();
      return (
        attributes.length === names.length &&
        attributes.every((name, index) => name === names[index])
      );
    });
    if (!declared && !(names.length === 1 && names[0] === mapping.idColumn))
      throw new DataError(
        `The key attribute(s) ${names.join(", ")} don't match an alternate key declared for ${mapping.logicalName}.`,
        400,
        "InvalidKey",
        { innerCode: "0x80040203" },
      );
    return rows.find((row) =>
      names.every((name) => valuesEqual(field(row, name), parts[name])),
    );
  }
  evaluate(expr, context) {
    if (typeof expr === "string" && expr.startsWith("$")) {
      const [root, ...parts] = expr.slice(1).split(".");
      return parts.reduce((v, k) => v?.[k], context[root]);
    }
    if (!expr || typeof expr !== "object" || Array.isArray(expr))
      return clone(expr);
    if (own(expr, "literal")) return clone(expr.literal);
    const args = (expr.args ?? []).map((a) => this.evaluate(a, context));
    switch (expr.op) {
      case "concat":
        return args.map((a) => a ?? "").join("");
      case "coalesce":
        return args.find((v) => v != null && v !== "");
      case "lower":
        return String(args[0] ?? "").toLowerCase();
      case "upper":
        return String(args[0] ?? "").toUpperCase();
      case "sum":
        return args.reduce((n, a) => n + Number(a ?? 0), 0);
      case "multiply":
        return args.reduce((n, a) => n * Number(a ?? 0), 1);
      case "uuid":
        return randomUUID();
      case "sequence": {
        const scope = safeName(String(args[0]));
        const prefix = String(args[1] ?? "");
        const width = Number(args[2] ?? 6);
        if (
          !/^[a-z0-9 _-]{0,32}$/i.test(prefix) ||
          !Number.isInteger(width) ||
          width < 1 ||
          width > 12
        )
          throw new DataError(
            "Plugin sequence requires a bounded prefix and width",
            400,
            "InvalidPlugin",
          );
        const counters = (this.state.settings.pluginSequences ??= {});
        const next = Number(counters[scope] ?? 0) + 1;
        if (!Number.isSafeInteger(next) || next >= 10 ** width)
          throw new DataError(
            "Plugin sequence exhausted configured width",
            400,
            "InvalidPlugin",
          );
        counters[scope] = next;
        return prefix + String(next).padStart(width, "0");
      }
      case "now":
        return new Date().toISOString();
      case "split":
        return String(args[0] ?? "")
          .split(args[1] ?? ",")
          .map((s) => s.trim())
          .filter(Boolean);
      case "join":
        if (!Array.isArray(args[0]))
          throw new DataError(
            "Plugin join requires an array",
            400,
            "InvalidPlugin",
          );
        return args[0].map(scalar).join(args[1] ?? ", ");
      case "length":
        if (!Array.isArray(args[0]))
          throw new DataError(
            "Plugin length requires an array",
            400,
            "InvalidPlugin",
          );
        return args[0].length;
      case "lookup": {
        const record = this.get(
          safeName(String(args[0])),
          scalar(args[1]),
          context.identity,
        );
        if (!record)
          throw new DataError(
            "Plugin lookup target does not exist",
            400,
            "InvalidLookup",
          );
        return clone(
          args[2] ? field(record ?? {}, safeName(String(args[2]))) : record,
        );
      }
      case "related": {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const relationshipName = safeName(String(args[2]));
        const relationship = mapping.relationships?.[relationshipName];
        if (!relationship)
          throw new DataError(
            "Plugin relationship is not declared in entity metadata",
            400,
            "MissingRelationship",
          );
        const multiple = Array.isArray(args[1]),
          ids = multiple ? args[1] : [args[1]],
          result = [];
        if (ids.length > 1024)
          throw new DataError(
            "Plugin related exceeds 1024 parent records",
            400,
            "InvalidPlugin",
          );
        const targets = this.rows(relationship.entity, context.identity);
        // Indexed relationship lookup (direct or through the intersect table)
        // instead of testing every target against every intersect row.
        const relatedIndex = this.permissionMemo();
        const targetLogical = this.resolveMapping(relationship.entity).logicalName;
        for (const id of ids) {
          const parent = this.get(
            mapping.logicalName,
            scalar(id),
            context.identity,
          );
          if (!parent)
            throw new DataError(
              "Plugin relationship parent does not exist",
              400,
              "InvalidLookup",
            );
          const linked = new Set(relatedIndex.related(parent, relationship, targetLogical));
          for (const row of targets.filter((row) => linked.has(row))) {
            const value = args[3] ? field(row, safeName(String(args[3]))) : row;
            result.push(
              multiple
                ? { parentId: parent[mapping.idColumn], record: value }
                : value,
            );
          }
          if (result.length > 1024)
            throw new DataError(
              "Plugin related exceeds 1024 records",
              400,
              "InvalidPlugin",
            );
        }
        return clone(result);
      }
      case "find": {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const matches = Object.entries(expr.match ?? {}).map(([key, value]) => [
          safeName(key),
          this.evaluate(value, context),
        ]);
        if (!matches.length)
          throw new DataError(
            "Plugin find requires explicit matching fields",
            400,
            "InvalidPlugin",
          );
        const record = this.tableRows(mapping.logicalName).find(
          (row) =>
            matches.every(([key, value]) => equal(field(row, key), value)) &&
            this.allowed(mapping.logicalName, "read", row, context.identity),
        );
        return clone(
          record
            ? args[1]
              ? field(record, safeName(String(args[1])))
              : record
            : null,
        );
      }
      case "findMany": {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const matches = Object.entries(expr.match ?? {}).map(([key, value]) => [
          safeName(key),
          this.evaluate(value, context),
        ]);
        if (!matches.length)
          throw new DataError(
            "Plugin findMany requires explicit matching fields",
            400,
            "InvalidPlugin",
          );
        const records = this.tableRows(mapping.logicalName).filter(
          (row) =>
            matches.every(([key, value]) =>
              Array.isArray(value)
                ? value.some((candidate) => equal(field(row, key), candidate))
                : equal(field(row, key), value),
            ) &&
            this.allowed(mapping.logicalName, "read", row, context.identity),
        );
        if (records.length > 1024)
          throw new DataError(
            "Plugin findMany exceeds 1024 records",
            400,
            "InvalidPlugin",
          );
        return clone(
          records.map((row) =>
            args[1] ? field(row, safeName(String(args[1]))) : row,
          ),
        );
      }
      case "reference": {
        const mapping = this.resolveMapping(safeName(String(args[0])));
        const id = scalar(args[1]);
        const record =
          mapping.logicalName === context.entity &&
          equal(id, context.record[mapping.idColumn])
            ? context.record
            : this.get(mapping.logicalName, id, context.identity);
        if (!record)
          throw new DataError(
            "Plugin reference target does not exist",
            400,
            "InvalidLookup",
          );
        return {
          id,
          logical_name: mapping.logicalName,
          name: primaryNameValue(mapping, record) ?? "",
        };
      }
      default: {
        // Operators contributed by data packs (lib/extensions.mjs).
        const operator = expressionOperator(expr.op);
        if (operator)
          return operator({
            store: this,
            context,
            args,
            expression: expr,
            fail: (message, status, code) => {
              throw new DataError(message, status, code);
            },
          });
        throw new DataError(
          `Unsupported plugin expression ${expr.op}`,
          400,
          "InvalidPlugin",
        );
      }
    }
  }
  applyPlugins(entity, operation, row, previous, identity) {
    const context = {
      entity,
      record: row,
      previous: previous ?? {},
      identity,
      now: new Date().toISOString(),
    };
    const secondary = [];
    for (const p of this.state.plugins.filter(
      (p) =>
        p.enabled !== false &&
        (p.entity === entity || p.entity === "*") &&
        (p.operations ?? ["create", "update"]).includes(operation),
    )) {
      if (p.when && !compileFilter(p.when)(row)) continue;
      for (const [key, expr] of Object.entries(p.defaults ?? {}))
        if (row[key] == null) {
          safeName(key);
          row[key] = this.evaluate(expr, context);
        }
      for (const [key, expr] of Object.entries(p.set ?? {})) {
        safeName(key);
        row[key] = this.evaluate(expr, context);
      }
      for (const v of p.validate ?? []) {
        const value = field(row, v.field ?? "");
        let valid = true;
        if (v.required) valid = value != null && value !== "";
        if (v.pattern)
          valid = valid && new RegExp(v.pattern).test(String(value ?? ""));
        if (v.min != null) valid = valid && Number(value) >= v.min;
        if (v.max != null) valid = valid && Number(value) <= v.max;
        if (v.oneOf) valid = valid && v.oneOf.some((x) => equal(x, value));
        if (v.assert) valid = valid && compileFilter(v.assert)(row);
        if (v.unique) {
          const m = this.resolveMapping(entity);
          valid =
            valid &&
            !(this.state.tables[entity] ?? []).some(
              (r) =>
                !equal(r[m.idColumn], row[m.idColumn]) &&
                equal(field(r, v.field), value),
            );
        }
        if (!valid)
          throw new DataError(
            v.message ??
              `Plugin ${p.id ?? "validation"} rejected ${v.field ?? "record"}`,
            400,
            "PluginValidation",
            { innerCode: String(v.innerCode ?? "0x80040265").toLowerCase() },
          );
      }
      secondary.push(
        ...(p.secondary ?? []).map((action) => ({ action, context })),
      );
    }
    return secondary;
  }
  applySecondary(effects) {
    for (const { action, context } of effects) {
      if (action.foreach) {
        const values = this.evaluate(action.foreach, context);
        if (!Array.isArray(values) || values.length > 1024)
          throw new DataError(
            "Plugin foreach requires an array of at most 1024 items",
            400,
            "InvalidPlugin",
          );
        const { foreach, ...nested } = action;
        this.applySecondary(
          values.map((item, index) => ({
            action: nested,
            context: { ...context, item, index },
          })),
        );
        continue;
      }
      const m = this.resolveMapping(action.entity);
      const targets = (this.state.tables[m.logicalName] ??= []);
      const values = Object.fromEntries(
        Object.entries(action.set ?? {}).map(([k, v]) => [
          safeName(k),
          this.evaluate(v, context),
        ]),
      );
      if (action.operation === "create") {
        if (action.match) {
          const matches = Object.fromEntries(
            Object.entries(action.match).map(([k, v]) => [
              k,
              this.evaluate(v, context),
            ]),
          );
          if (
            targets.some((target) =>
              Object.entries(matches).every(([k, v]) =>
                equal(field(target, k), v),
              ),
            )
          )
            continue;
        }
        targets.push({ [m.idColumn]: randomUUID(), ...values });
      } else if (
        action.operation === "update" ||
        action.operation === "delete"
      ) {
        if (!action.match)
          throw new DataError("Secondary update/delete requires match");
        const matches = Object.fromEntries(
          Object.entries(action.match).map(([k, v]) => [
            k,
            this.evaluate(v, context),
          ]),
        );
        if (
          action.requireMatch &&
          !targets.some((target) =>
            Object.entries(matches).every(([key, value]) =>
              equal(field(target, key), value),
            ),
          )
        )
          throw new DataError(
            "The backend action cannot find a matching related record",
            400,
            "InvalidPlugin",
          );
        for (let i = targets.length - 1; i >= 0; i--)
          if (
            Object.entries(matches).every(([k, v]) =>
              equal(field(targets[i], k), v),
            )
          ) {
            if (action.operation === "delete") targets.splice(i, 1);
            else Object.assign(targets[i], values);
          }
      } else
        throw new DataError(
          `Unsupported secondary operation ${action.operation}`,
          400,
          "InvalidPlugin",
        );
    }
  }
  validateBindings(mapping, input, row, identity, previous = null) {
    if (this.state.settings.associationPermissions === "enforce")
      for (const key of Object.keys(input).filter((key) =>
        key.endsWith("@odata.bind"),
      ))
        if (!mapping.relationships[key.slice(0, -11)])
          throw new DataError(
            "Lookup binding requires a known navigation relationship",
            400,
            "MissingRelationship",
          );
    const changed = new Set(
      Object.keys(input).map((key) =>
        key.endsWith("@odata.bind")
          ? (mapping.relationships[key.slice(0, -11)]?.from ??
            key.slice(0, -11))
          : key,
      ),
    );
    for (const relationship of Object.values(mapping.relationships ?? {})) {
      if (relationship.many === true || !changed.has(relationship.from))
        continue;
      const id = scalar(
        field(row, relationship.from) ??
          field(previous ?? {}, relationship.from),
      );
      if (id == null) continue;
      const targetMapping = this.resolveMapping(relationship.entity);
      // Polymorphic lookups (annotation objectid, customerid, regardingobjectid) have one
      // relationship per target table: only the one naming the bound table applies .
      const bound = field(row, relationship.from) ?? field(previous ?? {}, relationship.from);
      if (bound?.logical_name && String(bound.logical_name).toLowerCase() !== String(targetMapping.logicalName).toLowerCase())
        continue;
      const target = this.tableRows(targetMapping.logicalName).find(
        (record) => equal(record[targetMapping.idColumn], id),
      );
      if (!target)
        throw new DataError(
          "Lookup target does not exist",
          400,
          "InvalidLookup",
        );
      this.assertBindingTarget(mapping, row, targetMapping, target, identity);
    }
  }
  /**
   * Binding a lookup (create, update or $ref) needs Append on the source and
   * AppendTo on the target (Power Pages 90040105/90040106); read on the target
   * record isn't required. Exported portal grants rely on this: global
   * AppendTo-only contact permissions let co-authors from other
   * organisations be added. Without association enforcement, the binding
   * still needs read or AppendTo access to the target.
   */
  assertBindingTarget(mapping, row, targetMapping, target, identity) {
    if (this.state.settings.associationPermissions === "enforce") {
      this.assertAllowed(mapping.logicalName, "append", row, identity, targetMapping.logicalName);
      this.assertAllowed(targetMapping.logicalName, "appendTo", target, identity, mapping.logicalName);
      return;
    }
    if (
      !this.allowed(targetMapping.logicalName, "read", target, identity) &&
      !this.allowed(targetMapping.logicalName, "appendTo", target, identity)
    )
      this.assertAllowed(targetMapping.logicalName, "appendTo", target, identity, mapping.logicalName);
  }
  /** Dataverse row version for @odata.etag and If-Match checks. */
  etag(row) {
    if (row?.versionnumber != null) return `W/"${scalar(row.versionnumber)}"`;
    // Rows without a stored version get a content-derived version that changes
    // whenever the row changes (Dataverse increments versionnumber instead).
    const digest = createHash("sha256")
      .update(JSON.stringify(row ?? {}))
      .digest("hex");
    return `W/"${parseInt(digest.slice(0, 13), 16)}"`;
  }
  /**
   * Alternate keys (mapping.alternateKeys: [{ name, attributes }]) are unique
   * indexes in Dataverse. Keys with an empty column are not compared here.
   */
  assertAlternateKeys(mapping, row, rows, ownIndex) {
    for (const key of mapping.alternateKeys ?? []) {
      const attributes = key.attributes ?? key.keyAttributes ?? [];
      if (!attributes.length) continue;
      const values = attributes.map((name) => scalar(field(row, name)));
      if (values.some((value) => value == null || value === "")) continue;
      const clash = rows.some(
        (other, index) =>
          index !== ownIndex &&
          !equal(other[mapping.idColumn], row[mapping.idColumn]) &&
          attributes.every((name, position) =>
            equal(field(other, name), values[position]),
          ),
      );
      if (clash)
        throw new DataError(
          `A record that has the attribute values ${values.join(", ")} already exists. The entity key ${key.name ?? attributes.join("_")} requires that this set of attributes contains unique values. Select unique values and try again.`,
          412,
          "DuplicateRecord",
          { innerCode: "0x80040237" },
        );
    }
  }
  /** If-Match / If-None-Match semantics of Dataverse PATCH, PUT and DELETE. */
  assertPrecondition(mapping, row, { ifMatch, ifNoneMatch } = {}) {
    if (ifNoneMatch != null && String(ifNoneMatch).trim() === "*" && row)
      throw new DataError(
        "A record with matching key values already exists.",
        412,
        "PreconditionFailed",
        { innerCode: "0x80040237" },
      );
    if (ifMatch == null || !row) return;
    const wanted = String(ifMatch)
      .split(",")
      .map((tag) => tag.trim());
    if (wanted.includes("*")) return;
    if (!wanted.includes(this.etag(row)))
      throw new DataError(
        "The version of the existing record doesn't match the RowVersion property provided.",
        412,
        "PreconditionFailed",
        { innerCode: "0x80060882" },
      );
  }
  /** All field definitions for a table (explicit mapping plus caller metadata). */
  fieldDefinitions(logical, metadata) {
    let mapping = null;
    try {
      mapping = this.resolveMapping(logical);
    } catch {
      mapping = null;
    }
    const external =
      typeof metadata === "function"
        ? metadata(mapping?.logicalName ?? logical)
        : null;
    return {
      ...(mapping?.fieldMetadata ?? {}),
      ...(mapping?.fields ?? {}),
      ...(external ?? {}),
    };
  }
  /** Autonumber columns follow AutoNumberFormat with a transactional counter (seed 1000). */
  applyAutoNumbers(mapping, row, options = {}) {
    for (const [name, definition] of Object.entries(
      this.fieldDefinitions(mapping.logicalName, options.metadata),
    )) {
      const format = definition?.autoNumberFormat;
      if (!format || (row[name] != null && row[name] !== "")) continue;
      const counters = (this.state.settings.autoNumberSequences ??= {});
      const key = `${mapping.logicalName}.${name}`;
      const value = Number(counters[key] ?? definition.autoNumberSeed ?? 1000);
      if (!Number.isSafeInteger(value))
        throw new DataError("Autonumber sequence is invalid", 400, "InvalidAutoNumber");
      counters[key] = value + 1;
      let random = 0;
      row[name] = format
        .replace(/\{SEQNUM:(\d+)\}/g, (_all, width) =>
          String(value).padStart(Number(width), "0"),
        )
        .replace(/\{RANDSTRING:(\d+)\}/g, (_all, width) => {
          const length = Number(width);
          if (length < 1 || length > 6)
            throw new DataError("Invalid Argument", 400, "InvalidAutoNumber", {
              innerCode: "0x80040203",
            });
          // Deterministic stand-in for Dataverse's random segment.
          const digest = createHash("sha256")
            .update(`${key}\u0000${value}\u0000${random++}`)
            .digest();
          const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
          return Array.from(digest.subarray(0, length), (byte) => alphabet[byte % alphabet.length]).join("");
        })
        .replace(/\{DATETIMEUTC:([^}]+)\}/g, (_all, pattern) =>
          formatDotNetDate(Date.now(), pattern, 0),
        );
    }
  }
  /**
   * Typed Web API payload validation from field metadata: Dataverse rejects
   * wrong JSON types, stores empty text as null, enforces text MaxLength,
   * rounds decimals to their precision and stores UTC instants.
   */
  coerceRecord(mapping, row, options = {}) {
    for (const [key, value] of Object.entries(row)) {
      if (key.includes("@") || value == null) continue;
      const definition = this.fieldDefinition(mapping.logicalName, key, options.metadata);
      if (!definition) continue;
      row[key] = coerceValue(mapping.logicalName, key, value, definition);
    }
    return row;
  }
  /** Separate deep-insert payloads and collection binds from scalar columns. */
  splitDeepInsert(mapping, data) {
    const input = {},
      nested = [],
      collectionBinds = [];
    for (const [key, value] of Object.entries(data ?? {})) {
      if (key.endsWith("@odata.bind")) {
        const navigation = key.slice(0, -11),
          rel = mapping.relationships?.[navigation];
        if (Array.isArray(value)) {
          if (!rel || rel.many === false)
            throw new DataError(
              `Collection binding ${key} requires a collection-valued navigation property`,
              400,
              "InvalidLookup",
            );
          collectionBinds.push({ navigation, rel, refs: value });
          continue;
        }
        input[key] = value;
        continue;
      }
      const rel = mapping.relationships?.[key];
      if (
        rel &&
        value &&
        typeof value === "object" &&
        !(own(value, "id") && own(value, "logical_name"))
      ) {
        nested.push({ navigation: key, rel, value });
        continue;
      }
      input[key] = value;
    }
    return { input, nested, collectionBinds };
  }
  createRecord(entity, data, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    this.assertWritable(m.logicalName);
    const rows = (this.state.tables[m.logicalName] ??= []);
    const { input, nested, collectionBinds } = this.splitDeepInsert(m, data);
    const row = { ...this.normalizeRecord(m, input) };
    if (options.coerce) this.coerceRecord(m, row, options);
    const pluginTarget = clone(row), changedAttributes = Object.keys(pluginTarget);
    for (const [key, value] of Object.entries(m.recordDefaults ?? {}))
      if (key !== "statuscode" && !own(row, key))
        row[safeName(key)] = clone(value);
    if (!own(row, "statuscode")) {
      const status =
        m.stateStatusDefaults?.[scalar(row.statecode)] ??
        m.recordDefaults?.statuscode;
      if (status !== undefined) row.statuscode = clone(status);
    }
    if (options.coerce) this.assertStateStatus(m, row, options);
    row[m.idColumn] ??= randomUUID();
    if (rows.some((r) => equal(r[m.idColumn], row[m.idColumn])))
      throw new DataError(
        "A record with matching key values already exists.",
        412,
        "DuplicateRecord",
        { innerCode: "0x80040237" },
      );
    if (
      !identity.admin &&
      this.state.settings.permissionMode !== "permissive" &&
      !this.rules(m.logicalName, "create", identity).length
    )
      throw new DataError(
        "Table permission denied create",
        403,
        "PermissionDenied",
        { operation: "create", table: m.logicalName },
      );
    row.createdon ??= isoUtc(Date.now());
    row.modifiedon ??= row.createdon;
    this.applyAutoNumbers(m, row, options);
    // Authorization precedes all local handlers, including PreValidation. Every
    // phase participates in the same local rollback transaction.
    if (this.pluginPipeline && this.pluginPipelineActive({ entity: m.logicalName, operation: 'create' })) this.assertAllowed(m.logicalName, 'create', row, identity);
    this.exportedPluginPhase(m, 'create', 10, pluginTarget, row, null, identity, changedAttributes, options);
    // Deep insert: single-valued navigation records are created first and bound.
    for (const item of nested.filter((entry) => entry.rel.many === false)) {
      const target = this.resolveMapping(item.rel.entity);
      if (Array.isArray(item.value))
        throw new DataError(
          `Single-valued navigation ${item.navigation} requires an object`,
          400,
          "InvalidLookup",
        );
      const child = this.createRecord(target.logicalName, item.value, identity, options);
      row[item.rel.from] = {
        id: child[target.idColumn],
        logical_name: target.logicalName,
        name: primaryNameValue(target, child) ?? "",
      };
    }
    this.exportedPluginPhase(m, 'create', 20, pluginTarget, row, null, identity, changedAttributes, options);
    const effects = this.applyPlugins(
      m.logicalName,
      "create",
      row,
      null,
      identity,
    );
    this.assertAlternateKeys(m, row, rows, -1);
    rows.push(row);
    this.applySecondary(effects);
    this.assertAllowed(m.logicalName, "create", row, identity);
    this.validateBindings(m, pluginTarget, row, identity);
    // Deep insert/bind into collection-valued navigation properties.
    for (const item of nested.filter((entry) => entry.rel.many !== false)) {
      const target = this.resolveMapping(item.rel.entity);
      for (const value of Array.isArray(item.value) ? item.value : [item.value]) {
        if (item.rel.intersect) {
          const child = this.createRecord(target.logicalName, value, identity, options);
          this.changeAssociationRecord(m.logicalName, row[m.idColumn], item.navigation, child[target.idColumn], identity, true);
        } else
          this.createRecord(
            target.logicalName,
            {
              ...value,
              [item.rel.to]: {
                id: scalar(row[item.rel.from]),
                logical_name: m.logicalName,
                name: primaryNameValue(m, row) ?? "",
              },
            },
            identity,
            options,
          );
      }
    }
    for (const bind of collectionBinds)
      for (const value of bind.refs) {
        const reference = parseEntityReference(value);
        if (!reference)
          throw new DataError(`Invalid lookup binding ${bind.navigation}@odata.bind`, 400, "InvalidLookup");
        const target = this.resolveMapping(reference.set);
        if (target.logicalName !== this.resolveMapping(bind.rel.entity).logicalName)
          throw new DataError(
            `Lookup binding target does not match navigation ${bind.navigation}`,
            400,
            "InvalidLookup",
          );
        this.changeAssociationRecord(m.logicalName, row[m.idColumn], bind.navigation, reference.id, identity, true);
      }
    this.exportedPluginPhase(m, 'create', 40, pluginTarget, row, null, identity, changedAttributes, options);
    return row;
  }
  async create(entity, data, identity = {}, options = {}) {
    return this.transact(() => this.createRecord(entity, data, identity, options));
  }
  updateRecord(entity, id, data, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    this.assertWritable(m.logicalName);
    const rows = (this.state.tables[m.logicalName] ??= []);
    const index = rows.findIndex((r) => equal(r[m.idColumn], id));
    if (index < 0) throw new DataError("Record not found", 404, "NotFound");
    this.assertPrecondition(m, rows[index], options);
    this.assertAllowed(m.logicalName, "update", rows[index], identity);
    const changes = this.normalizeRecord(m, data);
    if (options.coerce) this.coerceRecord(m, changes, options);
    const row = this.touchRow(rows[index], {
      ...rows[index],
      ...changes,
      [m.idColumn]: rows[index][m.idColumn],
    });
    if (own(data, "statecode") && !own(data, "statuscode")) {
      const status = m.stateStatusDefaults?.[scalar(row.statecode)];
      if (status !== undefined) row.statuscode = clone(status);
    }
    if (options.coerce) this.assertStateStatus(m, row, options);
    this.assertAllowed(m.logicalName, "update", row, identity);
    this.validateBindings(m, data, row, identity, rows[index]);
    return this.commitUpdate(m, rows, index, row, identity, changes, options);
  }
  /**
   * Concurrency metadata that every Dataverse update sets: modifiedon is now and a
   * stored versionnumber advances, so earlier ETags stop matching (rows without a
   * stored version have a content-derived ETag, which changes with the row anyway).
   */
  touchRow(previous, row) {
    row.modifiedon = isoUtc(Date.now());
    const version = Number(scalar(previous.versionnumber));
    if (previous.versionnumber != null && Number.isSafeInteger(version))
      row.versionnumber = version + 1;
    return row;
  }
  /** Commit an updated row: update plugins, unique alternate keys, secondary effects. */
  commitUpdate(mapping, rows, index, row, identity, target, options = {}) {
    const previous = rows[index];
    const authorizedWrite = target !== undefined;
    target ??= Object.fromEntries(Object.entries(row).filter(([key, value]) => !isDeepStrictEqual(value, previous[key])));
    const changedAttributes = Object.keys(target);
    this.exportedPluginPhase(mapping, 'update', 10, target, row, previous, identity, changedAttributes, options);
    this.exportedPluginPhase(mapping, 'update', 20, target, row, previous, identity, changedAttributes, options);
    if (authorizedWrite && this.pluginPipeline) {
      this.assertAllowed(mapping.logicalName, 'update', row, identity);
      this.validateBindings(mapping, target, row, identity, previous);
    }
    const effects = this.applyPlugins(mapping.logicalName, "update", row, rows[index], identity);
    this.assertAlternateKeys(mapping, row, rows, index);
    rows[index] = row;
    this.applySecondary(effects);
    this.exportedPluginPhase(mapping, 'update', 40, target, row, previous, identity, changedAttributes, options);
    return row;
  }
  /**
   * A coerced write's status reason must belong to its status (Dataverse
   * InvalidStateCodeStatusCode, 0x80048408) when the statuscode metadata says which
   * statecode each status reason belongs to.
   */
  assertStateStatus(mapping, row, options = {}) {
    if (row.statuscode == null) return;
    const definition = this.fieldDefinition(mapping.logicalName, "statuscode", options.metadata);
    const statuses = (definition?.statuses ?? definition?.options ?? []).filter((option) => option?.state != null);
    if (!statuses.length) return;
    const status = statuses.find((option) => Number(option.value) === Number(scalar(row.statuscode)));
    const state = scalar(row.statecode);
    if (!status || (state != null && Number(status.state) !== Number(state)))
      throw new DataError(
        "State code is invalid or state code is valid but status code is invalid for a specified state code.",
        400,
        "InvalidStateCodeStatusCode",
        { innerCode: "0x80048408" },
      );
  }
  async update(entity, id, data, identity = {}, options = {}) {
    return this.transact(() => this.updateRecord(entity, id, data, identity, options));
  }
  /**
   * PATCH semantics: update an existing record, or create it with the
   * supplied key. If-Match prevents creation; If-None-Match: * prevents update.
   */
  async upsert(entity, id, data, identity = {}, options = {}) {
    return this.transact(() => this.upsertRecord(entity, id, data, identity, options));
  }
  upsertRecord(entity, id, data, identity = {}, options = {}) {
    const m = this.resolveMapping(entity);
    const existing = (this.state.tables[m.logicalName] ?? []).find((r) =>
      equal(r[m.idColumn], id),
    );
    this.assertPrecondition(m, existing ?? null, options);
    if (existing || options.ifMatch != null)
      return {
        created: false,
        row: this.updateRecord(entity, id, data, identity, options),
      };
    return {
      created: true,
      row: this.createRecord(entity, { ...data, [m.idColumn]: id }, identity, options),
    };
  }
  async remove(entity, id, identity = {}, options = {}) {
    return this.transact(() => {
      const m = this.resolveMapping(entity);
      this.assertWritable(m.logicalName);
      const rows = (this.state.tables[m.logicalName] ??= []);
      const index = rows.findIndex((r) => equal(r[m.idColumn], id));
      if (index < 0) throw new DataError("Record not found", 404, "NotFound");
      this.assertPrecondition(m, rows[index], options);
      this.assertAllowed(m.logicalName, "delete", rows[index], identity);
      return this.deleteRow(m, rows[index], identity, new Set());
    });
  }
  /**
   * Delete a row with the delete behaviour of every one-to-many relationship that
   * references it (relationship.cascade.delete, the Solution's CascadeDelete):
   * "Cascade" deletes the referencing rows, whose own relationships apply in turn;
   * "RemoveLink" clears their lookup through the update pipeline; "Restrict" refuses
   * the delete while one exists (CannotDeleteDueToAssociation, 0x80040227, 405 as the
   * Dataverse Web API documents it); "NoCascade" leaves them. A relationship without
   * imported configuration uses RemoveLink, Dataverse's default for a referential
   * relationship, and is recorded in cascadeDiagnostics(). Intersect rows of
   * many-to-many relationships go with the row. Cascaded changes are the platform's
   * own, so table permissions aren't checked for them; delete and update plugins run.
   */
  deleteRow(mapping, row, identity, deleting) {
    const key = `${mapping.logicalName}\u0000${comparable(row[mapping.idColumn])}`;
    if (deleting.has(key)) return row;
    deleting.add(key);
    const target = { [mapping.idColumn]: row[mapping.idColumn] }, attributes = Object.keys(target);
    this.exportedPluginPhase(mapping, 'delete', 10, target, row, row, identity, attributes);
    this.exportedPluginPhase(mapping, 'delete', 20, target, row, row, identity, attributes);
    const effects = this.applyPlugins(mapping.logicalName, "delete", clone(row), row, identity);
    for (const reference of this.referencesTo(mapping.logicalName)) {
      const target = scalar(field(row, reference.targetColumn ?? mapping.idColumn));
      if (target == null) continue;
      const children = (this.state.tables[reference.entity] ?? []).filter((child) => {
        const value = field(child, reference.column);
        if (value && typeof value === "object" && value.logical_name && value.logical_name !== mapping.logicalName)
          return false;
        return equal(scalar(value), target);
      });
      if (!children.length) continue;
      const behaviour = reference.cascade?.delete ?? "RemoveLink";
      if (reference.cascade?.delete == null) this.noteCascadeDefault(mapping.logicalName, reference);
      if (behaviour === "Restrict")
        throw new DataError(
          "The object you tried to delete is associated with another object and cannot be deleted.",
          405,
          "CannotDeleteDueToAssociation",
          { innerCode: "0x80040227", table: reference.entity, relationship: reference.schemaName ?? null },
        );
      if (behaviour !== "Cascade" && behaviour !== "RemoveLink") continue;
      const childMapping = this.resolveMapping(reference.entity);
      for (const child of children) {
        const rows = this.state.tables[reference.entity];
        const index = rows.findIndex((item) => equal(item[childMapping.idColumn], child[childMapping.idColumn]));
        if (index < 0) continue;
        if (behaviour === "Cascade") this.deleteRow(childMapping, rows[index], identity, deleting);
        else {
          const next = this.touchRow(rows[index], { ...rows[index], [reference.column]: null });
          this.commitUpdate(childMapping, rows, index, next, identity);
        }
      }
    }
    for (const [owner, ownerMapping] of Object.entries(this.state.mappings ?? {}))
      for (const rel of Object.values(ownerMapping?.relationships ?? {})) {
        if (!rel?.intersect?.entity || !this.state.tables[rel.intersect.entity]?.length) continue;
        const sides = [];
        if (owner === mapping.logicalName) sides.push([rel.intersect.from, scalar(field(row, rel.from))]);
        if (rel.entity === mapping.logicalName) sides.push([rel.intersect.to, scalar(field(row, rel.to))]);
        for (const [column, value] of sides)
          if (value != null)
            this.state.tables[rel.intersect.entity] = this.state.tables[rel.intersect.entity].filter(
              (edge) => !equal(scalar(field(edge, column)), value),
            );
      }
    const rows = this.state.tables[mapping.logicalName] ?? [];
    const index = rows.findIndex((item) => equal(item[mapping.idColumn], row[mapping.idColumn]));
    if (index >= 0) rows.splice(index, 1);
    this.applySecondary(effects);
    this.exportedPluginPhase(mapping, 'delete', 40, target, row, row, identity, attributes);
    return row;
  }
  /**
   * One-to-many relationships whose lookup references `logical`, from either side's
   * mapping (the child's single-valued lookup or the parent's collection), once per
   * referencing table and lookup column: { entity, column, targetColumn, cascade, schemaName }.
   */
  referencesTo(logical) {
    const found = new Map();
    const add = (reference) => {
      const key = `${reference.entity}\u0000${reference.column}`;
      const existing = found.get(key);
      if (!existing || (!existing.cascade && reference.cascade)) found.set(key, reference);
    };
    for (const [owner, ownerMapping] of Object.entries(this.state.mappings ?? {}))
      for (const rel of Object.values(ownerMapping?.relationships ?? {})) {
        if (!rel || rel.intersect || !rel.entity || !rel.from || !rel.to) continue;
        if (rel.many === false && rel.entity === logical)
          add({ entity: owner, column: rel.from, targetColumn: rel.to, cascade: rel.cascade, schemaName: rel.schemaName });
        else if (rel.many !== false && owner === logical)
          add({ entity: rel.entity, column: rel.to, targetColumn: rel.from, cascade: rel.cascade, schemaName: rel.schemaName });
      }
    return [...found.values()];
  }
  noteCascadeDefault(logical, reference) {
    this.defaultedCascades ??= new Map();
    const key = `${reference.entity}\u0000${reference.column}\u0000${logical}`;
    if (!this.defaultedCascades.has(key))
      this.defaultedCascades.set(key, {
        code: "CASCADE_DELETE_DEFAULTED",
        table: logical,
        referencing: reference.entity,
        column: reference.column,
        relationship: reference.schemaName ?? null,
        message: `No imported CascadeDelete for ${reference.entity}.${reference.column} -> ${logical}; RemoveLink, the Dataverse default for a referential relationship, was applied.`,
      });
  }
  /** Relationships whose delete behaviour defaulted to RemoveLink (no imported cascade). */
  cascadeDiagnostics() {
    return [...(this.defaultedCascades?.values() ?? [])];
  }
  async associate(entity, id, navigation, targetId, identity = {}) {
    return this.changeAssociation(
      entity,
      id,
      navigation,
      targetId,
      identity,
      true,
    );
  }
  async disassociate(entity, id, navigation, targetId, identity = {}) {
    return this.changeAssociation(
      entity,
      id,
      navigation,
      targetId,
      identity,
      false,
    );
  }
  async changeAssociation(
    entity,
    id,
    navigation,
    targetId,
    identity,
    associate,
  ) {
    return this.transact(() =>
      this.changeAssociationRecord(entity, id, navigation, targetId, identity, associate),
    );
  }
  changeAssociationRecord(entity, id, navigation, targetId, identity, associate) {
    const mapping = this.resolveMapping(entity);
    const relationship = mapping.relationships[safeName(navigation)];
    if (!relationship)
      throw new DataError(
        "Association navigation has no mapping",
        400,
        "MissingRelationship",
      );
    if (relationship.intersect) this.assertWritable(this.resolveMapping(relationship.intersect.entity).logicalName);
    if (relationship.many === false)
      throw new DataError(
        "Use a lookup binding for a single-valued navigation",
        400,
        "InvalidAssociation",
      );
    const row = (this.state.tables[mapping.logicalName] ?? []).find(
      (record) => equal(record[mapping.idColumn], id),
    );
    if (!row)
      throw new DataError(
        "Association source record not found",
        404,
        "NotFound",
      );
    this.assertAllowed(mapping.logicalName, "update", row, identity);
    const targetMapping = this.resolveMapping(relationship.entity);
    const target = (this.state.tables[targetMapping.logicalName] ?? []).find(
      (record) => equal(record[targetMapping.idColumn], targetId),
    );
    if (!target)
      throw new DataError(
        "Association target record not found",
        404,
        "NotFound",
      );
    this.assertBindingTarget(mapping, row, targetMapping, target, identity);
    if (relationship.intersect) {
      const link = relationship.intersect;
      const edgeMapping = this.resolveMapping(link.entity);
      const edges = (this.state.tables[edgeMapping.logicalName] ??= []);
      const values = {
        [link.from]: scalar(field(row, relationship.from)),
        [link.to]: scalar(field(target, relationship.to)),
      };
      const existing = edges.filter((edge) =>
        Object.entries(values).every(([key, value]) =>
          equal(field(edge, key), value),
        ),
      );
      if (associate) {
        const edge = { [edgeMapping.idColumn]: randomUUID(), ...values };
        this.assertAllowed(edgeMapping.logicalName, "create", edge, identity);
        if (!existing.length) edges.push(edge);
      } else {
        if (!existing.length)
          this.assertAllowed(
            edgeMapping.logicalName,
            "delete",
            values,
            identity,
          );
        for (const edge of existing)
          this.assertAllowed(
            edgeMapping.logicalName,
            "delete",
            edge,
            identity,
          );
        this.state.tables[edgeMapping.logicalName] = edges.filter(
          (edge) => !existing.includes(edge),
        );
      }
    } else {
      if (relationship.to === targetMapping.idColumn)
        throw new DataError(
          "Collection mapping cannot reassign a target primary key",
          400,
          "InvalidAssociation",
        );
      this.assertAllowed(
        targetMapping.logicalName,
        "update",
        target,
        identity,
      );
      const value = associate
        ? clone(row[relationship.from])
        : this.relationshipMatches(row, target, relationship)
          ? null
          : undefined;
      if (value !== undefined) {
        // A one-to-many association sets or clears the referencing row's lookup: an
        // update of that row through the update pipeline (version, modifiedon, plugins).
        const rows = this.state.tables[targetMapping.logicalName];
        const next = this.touchRow(target, { ...target, [relationship.to]: value });
        this.assertAllowed(targetMapping.logicalName, "update", next, identity);
        this.commitUpdate(targetMapping, rows, rows.indexOf(target), next, identity);
      }
    }
    return {
      associated: associate,
      entity: mapping.logicalName,
      recordId: id,
      navigation,
      targetId,
    };
  }
  async applyPreset(name, { generatedPresets = this.presetLibrary } = {}) {
    const preset = resolvePreset(this.state, name, generatedPresets);
    if (!preset) throw new DataError(`Unknown preset ${name}`, 404);
    return this.transact(() => {
      applyPresetSections(this.state, preset);
      this.state = normalizeState(this.state, this.presetLibrary);
      return this.snapshot();
    });
  }
  /**
   * Evaluate FetchXML for an identity. options.profile "webapi" applies the
   * Dataverse schema strictly (public /_api?fetchXml=); the default "portal"
   * profile models Liquid/list/lookup execution through the portal.
   */
  fetchXml(xml, identity = {}, options = {}) {
    const plan = planFetch(parseFetchXml(xml), {
      profile: options.profile === "webapi" ? "webapi" : "portal",
    });
    // Web API $count=true counts the matching rows like returntotalrecordcount.
    if (options.returnTotal === true && plan.top == null && !plan.aggregate)
      plan.returnTotal = true;
    const ctx = this.queryContext(identity, options);
    return executeFetch(plan, {
      mapping: (name) => this.resolveMapping(name),
      readableRows: ctx.readRows,
      tableRows: (logical) => this.tableRows(logical),
      definition: ctx.definition,
      column: ctx.column,
      lookupName: ctx.lookupName,
      identity,
      settings: ctx.settings,
      now: ctx.now,
      platformLanguageCode: options.platformLanguageCode,
    });
  }
}

function boundedInt(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DataError(`${name} must be a nonnegative integer`);
  return n;
}
function project(row, select) {
  if (!select || select === "*") return clone(row);
  const out = Object.create(null);
  for (const key of Array.isArray(select) ? select : splitTop(select)) {
    out[key] = field(row, key) ?? null;
    if (key.startsWith("_") && key.endsWith("_value")) {
      const lookup = row[key.slice(1, -6)];
      if (lookup && typeof lookup === "object" && own(lookup, "id")) {
        out[key + formattedAnnotation] = lookup.name ?? "";
        if (lookup.logical_name)
          out[key + lookupAnnotation] = lookup.logical_name;
      }
    }
  }
  return Object.fromEntries(Object.entries(out));
}

/**
 * Parse an entity reference used by @odata.bind/@odata.id: absolute portal
 * URLs, /_api/set(key), /set(key) or set(key). The caller checks origins.
 */
export function parseEntityReference(value) {
  let text = String(value ?? "").trim();
  let origin = null;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.search || url.hash || url.username || url.password) return null;
    origin = url.origin;
    text = decodeURIComponent(url.pathname);
  }
  text = text.replace(/^\/?_api\//, "").replace(/^\//, "");
  const match = /^([A-Za-z_]\w*)\(([^()]+)\)$/.exec(text);
  if (!match) return null;
  const key = match[2].trim();
  return {
    set: match[1],
    id: /=/.test(key) ? key : key.replace(/^'(.*)'$/, "$1").replace(/^\{(.*)\}$/, "$1"),
    origin,
  };
}
/** Alternate key segment `a='x',b=2` as a column map; null for a primary key. */
export function parseKeySegment(key) {
  const text = String(key ?? "").trim();
  if (!text.includes("=")) return null;
  const parts = {};
  const pattern = /\s*([A-Za-z_]\w*)\s*=\s*('(?:[^']|'')*'|[^,]+)\s*(?:,|$)/y;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match) throw new DataError(`Invalid key segment (${text})`, 400, "InvalidKey");
    const raw = match[2].trim();
    parts[match[1].toLowerCase()] = raw.startsWith("'")
      ? raw.slice(1, -1).replace(/''/g, "'")
      : /^-?\d+(?:\.\d+)?$/.test(raw)
        ? Number(raw)
        : raw.replace(/^\{(.*)\}$/, "$1");
    index = pattern.lastIndex;
  }
  return parts;
}
/** The column's imported MinValue/MaxValue bound a numeric write (Dataverse validation). */
function assertBounds(value, definition, code, innerCode, message) {
  const min = Number(definition.minValue),
    max = Number(definition.maxValue);
  if ((definition.minValue != null && Number.isFinite(min) && value < min) || (definition.maxValue != null && Number.isFinite(max) && value > max))
    throw new DataError(`A validation error occurred. ${message}`, 400, code, { innerCode, minValue: definition.minValue ?? null, maxValue: definition.maxValue ?? null });
}
/** A choice write must be one of the column's exported options (PicklistValueOutOfRange). */
function assertOption(value, definition) {
  const options = Array.isArray(definition.options) ? definition.options : [];
  if (options.length && !options.some((option) => Number(option?.value) === value))
    throw new DataError("The picklist value is out of the range.", 400, "PicklistValueOutOfRange", { innerCode: "0x8004431a", value });
}
/** Validate and normalise one Web API column value from its Dataverse type. */
function coerceValue(entity, attribute, value, definition) {
  const kind = fieldKind(definition);
  const literal = typeof value === "object" ? JSON.stringify(value) : String(value);
  const conversion = (type) =>
    new DataError(
      `Cannot convert the literal '${literal}' to the expected type '${type}'.`,
      400,
      "InvalidValue",
      { innerCode: "0x80048d19" },
    );
  switch (kind) {
    case "string": {
      if (typeof value !== "string") throw conversion("Edm.String");
      if (value === "") return null;
      const max = Number(definition.maxLength);
      if (Number.isFinite(max) && max > 0 && value.length > max)
        throw new DataError(
          `A validation error occurred.  The length of the '${attribute}' attribute of the '${entity}' entity exceeded the maximum allowed length of '${max}'.`,
          400,
          "StringLengthExceeded",
          { innerCode: "0x80044331" },
        );
      return value;
    }
    case "integer": {
      const int64 = String(definition.dataverseType ?? "").toLowerCase() === "bigint";
      const type = int64 ? "Edm.Int64" : "Edm.Int32";
      if (typeof value !== "number" || !Number.isInteger(value)) throw conversion(type);
      // A literal outside Edm.Int32 doesn't convert; MinValue/MaxValue narrow the column.
      if (int64 ? !Number.isSafeInteger(value) : value < -2147483648 || value > 2147483647)
        throw conversion(type);
      assertBounds(value, definition, "IntegerValueOutOfRange", "0x8004432f", "An integer provided is outside of the allowed values for this attribute.");
      return value;
    }
    case "decimal":
    case "money":
    case "double": {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw conversion(kind === "double" ? "Edm.Double" : "Edm.Decimal");
      const precision = Number.isInteger(definition.precision)
        ? definition.precision
        : kind === "double"
          ? null
          : 2;
      let result = value;
      if (precision != null) {
        // Decimal half-away-from-zero rounding on the decimal digits, not the
        // binary approximation (10.555 -> 10.56 like SQL decimal conversion).
        const text = String(Math.abs(value));
        if (/e/i.test(text)) result = Number(value.toFixed(precision));
        else {
          const rounded = Number(`${Math.round(Number(`${text}e${precision}`))}e-${precision}`);
          result = value < 0 ? -rounded : rounded;
        }
      }
      // The documented DecimalValueOutOfRange covers money and float columns too; their
      // own codes aren't documented.
      assertBounds(result, definition, "DecimalValueOutOfRange", "0x80044330", "A decimal value provided is outside of the allowed values for this attribute.");
      return result;
    }
    case "boolean":
      if (typeof value !== "boolean") throw conversion("Edm.Boolean");
      return value;
    case "choice": {
      const raw = value && typeof value === "object" ? value.value : value;
      if (typeof raw !== "number" || !Number.isInteger(raw))
        throw conversion("Edm.Int32");
      assertOption(raw, definition);
      return raw;
    }
    case "multichoice": {
      const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").filter((part) => part.trim() !== "") : null;
      if (!parts) throw conversion("Edm.String");
      for (const part of parts) {
        const number = Number(typeof part === "string" ? part.trim() : part);
        if (!Number.isInteger(number)) throw conversion("Edm.Int32");
        assertOption(number, definition);
      }
      return value;
    }
    case "datetime": {
      if (typeof value !== "string") throw conversion("Edm.DateTimeOffset");
      const parsed = parseDateValue(value);
      const year = parsed ? new Date(parsed.ms).getUTCFullYear() : NaN;
      if (!parsed || year < 1753 || year > 9999)
        throw new DataError(
          `The date-time format for ${value} is invalid, or value is outside the supported range.`,
          400,
          "InvalidDateTime",
          { innerCode: "0x80040239" },
        );
      return parsed.dateOnly || isDateOnlyField(definition)
        ? isoUtc(parsed.ms, { dateOnly: true })
        : isoUtc(parsed.ms);
    }
    default:
      return value;
  }
}
