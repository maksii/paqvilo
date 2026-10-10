// Web API JSON shaping: lookup properties, formatted-value annotations and
// row versions, following the documented Dataverse/Power Pages responses
// (power-pages/configure/read-operations; data-platform/webapi/query/select-columns
// and fetchxml/select-columns).
import {
  fieldKind,
  formattedValue,
  guidKey,
  isDateOnlyField,
  isoUtc,
  own,
  parseDateValue,
  primaryNameValue,
  scalar,
} from "./dataverse-values.mjs";

export const FORMATTED = "@OData.Community.Display.V1.FormattedValue";
export const ATTRIBUTE_NAME = "@OData.Community.Display.V1.AttributeName";
export const LOOKUP_LOGICAL = "@Microsoft.Dynamics.CRM.lookuplogicalname";
export const NAVIGATION = "@Microsoft.Dynamics.CRM.associatednavigationproperty";
const SYSTEM_DATES = new Set(["createdon", "modifiedon", "overriddencreatedon"]);
const isPrivate = (key) => /^__sim/i.test(key);
const isLookupObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) && own(value, "id") && own(value, "logical_name");
const isChoiceObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) && own(value, "value") && !own(value, "id");
const rowKey = (value) => {
  const raw = scalar(value);
  return raw == null ? null : String(guidKey(raw) ?? raw).toLowerCase();
};

/**
 * Create a formatter bound to one request.
 * options: { store, identity, metadata(logical) -> fields, formatting }
 */
export function createWebApiFormatter({ store, identity = {}, metadata, formatting = {} }) {
  const definition = (logical, attribute) => store.fieldDefinition(logical, attribute, metadata);
  const storedRows = new Map();
  const storedRow = (mapping, id) => {
    const key = rowKey(id);
    if (key == null) return null;
    if (!storedRows.has(mapping.logicalName)) {
      const index = new Map();
      for (const row of store.tableRows(mapping.logicalName))
        index.set(rowKey(row[mapping.idColumn]), row);
      storedRows.set(mapping.logicalName, index);
    }
    return storedRows.get(mapping.logicalName).get(key) ?? null;
  };
  const names = new Map();
  /**
   * Lookup FormattedValue is the lookup's own name column, so it is returned
   * even when the caller can't read the related table (the platform: anonymous
   * reference terms carry their list name although lists are denied).
   */
  const targetName = (logical, id, fallback) => {
    const key = `${logical}\u0000${rowKey(id)}`;
    if (!names.has(key)) {
      let name = fallback;
      try {
        const mapping = store.resolveMapping(logical);
        const target = storedRow(mapping, id);
        if (target) name = primaryNameValue(mapping, target) ?? fallback;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      names.set(key, name ?? undefined);
    }
    return names.get(key);
  };
  const singleValued = (mapping, attribute) =>
    attribute === mapping.idColumn
      ? []
      : Object.entries(mapping.relationships ?? {}).filter(
          ([, rel]) => rel.many === false && rel.from === attribute,
        );
  /** Resolve the relationship behind a lookup column (polymorphic lookups by target). */
  const lookupOf = (mapping, attribute, value) => {
    const candidates = singleValued(mapping, attribute);
    const logical = isLookupObject(value) ? value.logical_name : null;
    let chosen = logical
      ? (candidates.find(([, rel]) => store.resolveMapping(rel.entity).logicalName === logical) ?? null)
      : null;
    if (!chosen && candidates.length > 1 && value != null)
      chosen = candidates.find(([, rel]) => storedRow(store.resolveMapping(rel.entity), value)) ?? null;
    chosen ??= candidates[0] ?? null;
    if (chosen) return { navigation: chosen[0], entity: store.resolveMapping(chosen[1].entity).logicalName };
    if (logical) return { navigation: null, entity: logical };
    const targets = definition(mapping.logicalName, attribute)?.targets;
    if (Array.isArray(targets) && targets.length === 1) return { navigation: null, entity: targets[0] };
    return null;
  };
  const isLookupColumn = (mapping, attribute, value) =>
    attribute !== mapping.idColumn &&
    (isLookupObject(value) ||
      singleValued(mapping, attribute).length > 0 ||
      fieldKind(definition(mapping.logicalName, attribute)) === "lookup");

  /** JSON value of a column: choices as numbers, lookups as ids, UTC instants. */
  const outputValue = (value, columnDefinition, key) => {
    if (value == null) return null;
    if (isChoiceObject(value)) return value.value;
    if (isLookupObject(value)) return value.id;
    const kind = fieldKind(columnDefinition);
    if (
      typeof value === "string" &&
      (kind === "datetime" || (!kind && (SYSTEM_DATES.has(key) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))))
    ) {
      const parsed = parseDateValue(value);
      if (parsed)
        return parsed.dateOnly || isDateOnlyField(columnDefinition)
          ? isoUtc(parsed.ms, { dateOnly: true })
          : isoUtc(parsed.ms);
    }
    return value;
  };
  const formatted = (value, columnDefinition, key) => {
    if (value == null) return undefined;
    if (isChoiceObject(value)) return value.label ?? formattedValue(value.value, columnDefinition, formatting);
    if (fieldKind(columnDefinition)) return formattedValue(value, columnDefinition, formatting);
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "string" && (SYSTEM_DATES.has(key) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)))
      return formattedValue(value, { dataverseType: "datetime" }, formatting);
    return undefined;
  };

  /** Write one lookup value and its annotations into `out` under `key`. */
  const writeLookup = (out, mapping, attribute, value, key, { navigation = true } = {}) => {
    if (value == null || value === "") {
      out[key] = null;
      return;
    }
    const lookup = lookupOf(mapping, attribute, value);
    const id = scalar(value);
    const name = lookup ? targetName(lookup.entity, id, isLookupObject(value) ? value.name : undefined) : undefined;
    if (name != null) out[`${key}${FORMATTED}`] = name;
    if (navigation && lookup?.navigation) out[`${key}${NAVIGATION}`] = lookup.navigation;
    if (lookup?.entity) out[`${key}${LOOKUP_LOGICAL}`] = lookup.entity;
    out[key] = id;
  };

  /**
   * Format one OData entity. `projected` is the store projection (with
   * expanded navigation values); the stored row supplies lookups and version.
   * Expanded collection items carry their own ETag; single-valued ones do not.
   */
  function formatEntity(projected, mapping, { etag = true, expand = [] } = {}) {
    if (projected == null) return projected;
    const stored = storedRow(mapping, projected[mapping.idColumn]);
    const out = {};
    if (etag && stored) out["@odata.etag"] = store.etag(stored);
    // Only navigation properties named in $expand are expanded entities; a
    // single-valued navigation may share its name with the lookup column.
    const expanded = new Map((expand ?? []).map((spec) => [spec.navigation, spec]));
    for (const key of Object.keys(projected)) {
      if (isPrivate(key) || key.includes("@")) continue;
      const value = projected[key];
      const spec = expanded.get(key);
      if (spec && mapping.relationships?.[key]) {
        const target = store.resolveMapping(mapping.relationships[key].entity);
        out[key] = Array.isArray(value)
          ? value.map((item) => formatEntity(item, target, { etag: true, expand: spec.expand }))
          : value == null
            ? null
            : formatEntity(value, target, { etag: false, expand: spec.expand });
        continue;
      }
      const lookupProperty = /^_(.+)_value$/.exec(key);
      if (lookupProperty) {
        const attribute = lookupProperty[1];
        const source = stored && own(stored, attribute) ? stored[attribute] : value;
        writeLookup(out, mapping, attribute, source ?? null, key);
        continue;
      }
      if (isLookupColumn(mapping, key, value)) {
        writeLookup(out, mapping, key, value ?? null, `_${key}_value`);
        continue;
      }
      const columnDefinition = definition(mapping.logicalName, key);
      const text = formatted(value, columnDefinition, key);
      if (text != null) out[`${key}${FORMATTED}`] = text;
      out[key] = outputValue(value, columnDefinition, key);
    }
    return out;
  }

  /**
   * Format one FetchXML row using the evaluator's column descriptors. FetchXML
   * Web API results omit null values; aliased and linked columns carry
   * AttributeName; only root lookups name their navigation property.
   */
  function formatFetchRow(row, info) {
    const rootMapping = store.resolveMapping(info.root);
    const out = {};
    if (!info.aggregate && row[info.idColumn] != null) {
      const stored = storedRow(rootMapping, row[info.idColumn]);
      if (stored) out["@odata.etag"] = store.etag(stored);
    }
    const byKey = new Map(info.columns.map((column) => [column.key, column]));
    for (const [key, value] of Object.entries(row)) {
      if (isPrivate(key) || key.includes("@") || value == null || value === "") continue;
      const column = byKey.get(key);
      let entity = info.root,
        attribute = key;
      if (column) {
        entity = column.entity;
        attribute = column.attribute;
      } else if (key.includes(".")) {
        const alias = key.slice(0, key.indexOf("."));
        entity = info.aliases[alias] ?? entity;
        attribute = key.slice(key.indexOf(".") + 1);
      }
      const rootColumn = !column?.aliased && !key.includes(".");
      if (!rootColumn) out[`${key}${ATTRIBUTE_NAME}`] = attribute;
      if (column?.aggregate || column?.dategrouping) {
        if (typeof value === "number")
          out[`${key}${FORMATTED}`] = formattedValue(
            value,
            { dataverseType: Number.isInteger(value) ? "int" : "decimal" },
            formatting,
          );
        out[key] = value;
        continue;
      }
      const mapping = store.resolveMapping(entity);
      if (isLookupColumn(mapping, attribute, value)) {
        writeLookup(out, mapping, attribute, value, rootColumn ? `_${attribute}_value` : key, {
          navigation: rootColumn,
        });
        continue;
      }
      const columnDefinition = definition(entity, attribute);
      const text = formatted(value, columnDefinition, attribute);
      if (text != null) out[`${key}${FORMATTED}`] = text;
      out[key] = outputValue(value, columnDefinition, attribute);
    }
    return out;
  }

  return { formatEntity, formatFetchRow, storedRow };
}
