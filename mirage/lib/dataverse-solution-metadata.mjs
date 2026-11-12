import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { classifySolutionPath, parseSchemaDocument, buildSolutionSchema, tableFields } from './solution-schema.mjs';
import { parseSolutionXml, descendants, pickLabel } from './solution-xml.mjs';

const id = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const COMPONENT_IDS = {
  systemform: 'formid',
  savedquery: 'savedqueryid',
  appmodule: 'appmoduleid',
  sitemap: 'sitemapid',
};
const mergeRows = (base, incoming) => [
  ...new Map(
    [...base, ...incoming].map((row) => [row.uniqueName ?? `${row.entity ?? ''}/${row.id}`, structuredClone(row)]),
  ).values(),
];
const metadataXml = (name) => {
  const parts = String(name).toLowerCase().split('/');
  const file = parts.at(-1);
  if (file === 'customizations.xml' || file === 'solution.xml') return true;
  if (!file.endsWith('.xml')) return false;
  return parts
    .slice(0, -1)
    .some(
      (part) =>
        part === 'entities' ||
        part === 'appmodules' ||
        part === 'appmodulesitemaps' ||
        part === 'optionsets' ||
        part === 'relationships',
    );
};
// Most component values are scalar strings, including potentially large XML.
// Compare those values directly instead of serializing their contents on every
// record-field lookup. Snapshot small structured values too so in-place edits
// cannot reuse a stale catalogue simply because the row identity stayed equal.
const stampedValue = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
const rowStamp = (row) => {
  const keys = Object.keys(row),
    values = [],
    types = [];
  for (const key of keys) {
    const value = row[key];
    values.push(stampedValue(value));
    types.push(typeof value);
  }
  return { keys, values, types };
};
const rowMatches = (row, stamp) => {
  if (!stamp) return false;
  const keys = Object.keys(row);
  if (keys.length !== stamp.keys.length) return false;
  for (let field = 0; field < keys.length; field++) {
    if (keys[field] !== stamp.keys[field]) return false;
    const value = row[keys[field]];
    if (typeof value !== stamp.types[field] || !Object.is(stampedValue(value), stamp.values[field])) return false;
  }
  return true;
};
const rowsMatch = (rows, stamps) =>
  Boolean(stamps && rows.length === stamps.length && rows.every((row, index) => rowMatches(row, stamps[index])));
const presenceStamp = (value) => new Set(Object.keys(value ?? {}).filter((key) => value[key]));
const presenceMatches = (value, stamp) => {
  let count = 0;
  for (const key of Object.keys(value ?? {}))
    if (value[key]) {
      if (!stamp?.has(key)) return false;
      count++;
    }
  return count === stamp?.size;
};
const mappingStamps = (mappings) => {
  const stamps = new Map();
  for (const name of Object.keys(mappings ?? {})) {
    const mapping = mappings[name],
      fields = new Map();
    for (const field of Object.keys(mapping.fields ?? {}))
      if (mapping.fields[field]?.columnMetadata) fields.set(field, rowStamp(mapping.fields[field]));
    if (mapping.dataverseMetadata || fields.size)
      stamps.set(name, { metadata: stampedValue(mapping.dataverseMetadata), fields });
  }
  return stamps;
};
const mappingFieldCount = (mapping, stamp) => {
  let fields = 0;
  for (const field of Object.keys(mapping.fields ?? {}))
    if (mapping.fields[field]?.columnMetadata) {
      if (!rowMatches(mapping.fields[field], stamp?.fields.get(field))) return -1;
      fields++;
    }
  return fields;
};
const mappingsMatch = (mappings, stamps) => {
  if (!stamps) return false;
  let count = 0;
  for (const name of Object.keys(mappings ?? {})) {
    const mapping = mappings[name],
      stamp = stamps.get(name),
      fields = mappingFieldCount(mapping, stamp);
    if (fields < 0) return false;
    if (mapping.dataverseMetadata || fields) {
      if (stamp?.fields.size !== fields || !Object.is(stampedValue(mapping.dataverseMetadata), stamp.metadata))
        return false;
      count++;
    }
  }
  return count === stamps.size;
};
const layerFields = ['id', 'ownerSolutionId', 'uniqueName', 'solutionVersion', 'managed'];
const layerStamp = (layer) => ({
  values: layerFields.map((key) => layer[key]),
  entries: (layer.entries ?? []).map(rowStamp),
});
const layerMatches = (layer, stamp) =>
  Boolean(
    stamp &&
    layerFields.every((key, index) => Object.is(layer[key], stamp.values[index])) &&
    rowsMatch(layer.entries ?? [], stamp.entries),
  );
// The column facts a mapping field supplies: its columnMetadata, or for a field the mapping declares only by type the
// minimal facts of that type. A column the solution already declares keeps the solution's definition.
const mappingFacts = (field, solutionField) => {
  if (field?.columnMetadata) return field.columnMetadata;
  if (solutionField || !field?.dataverseType) return null;
  return { type: String(field.dataverseType).toLowerCase() };
};
const mappingFieldFacts = (base, name, mapping) =>
  Object.entries(mapping?.fields ?? {}).some(([attribute, field]) =>
    mappingFacts(field, base.entities?.[name]?.fields?.[attribute]),
  );
// Whether a base entity's mapping carries Dataverse metadata, or types a column the solution does not declare.
const hasBaseMappingMetadata = (base, mappings) =>
  Object.keys(base.entities ?? {}).some((name) => {
    const mapping = mappings?.[name];
    return Boolean(mapping) && (Boolean(mapping.dataverseMetadata) || mappingFieldFacts(base, name, mapping));
  });
// The columns of a table only a mapping declares: each field that carries column facts or a type.
const mappedFields = (mapping, lcid) => {
  const fields = {};
  for (const [attribute, field] of Object.entries(mapping.fields ?? {})) {
    const facts = mappingFacts(field, undefined);
    if (!facts) continue;
    const { type: metadataType, ...properties } = facts; // NOSONAR: binding is excluded from the rest object or is a placeholder
    fields[attribute] = structuredClone({
      ...field,
      ...properties,
      name: attribute,
      label: pickLabel(properties.labels, lcid) ?? field.label ?? attribute,
    });
  }
  return fields;
};
/** The metadata with each table that only a mapping declares listed by its mapped columns; the metadata itself when there is none. */
function withMappedTables(metadata, mappings) {
  const lcid = metadata.lcid ?? 1033;
  const tables = Object.entries(mappings ?? {}).filter(
    ([name, mapping]) => !metadata.entities?.[name] && mappingFieldFacts(metadata, name, mapping),
  );
  if (!tables.length) return metadata;
  const entities = Object.fromEntries(
    tables.map(([name, mapping]) => [name, { entity: name, fields: mappedFields(mapping, lcid) }]),
  );
  return { ...metadata, entities: { ...metadata.entities, ...entities } };
}
// The same keys, each bound to a value that `same` accepts for the pair of the old and the new value.
const sameEntries = (previous, current, same = Object.is) => {
  const names = Object.keys(current ?? {});
  return names.length === Object.keys(previous).length && names.every((name) => same(previous[name], current[name]));
};
// A mapping field's snapshot: the field object, then each own key and its value in order, because mappedFields spreads
// the whole field. A writer that replaces the field or changes any of its keys in place makes the snapshot differ.
const fieldSnapshot = (field) =>
  field && typeof field === 'object' ? [field, ...Object.entries(field).flat()] : [field];
const fieldReads = (mapping) =>
  Object.fromEntries(
    Object.entries(mapping?.fields ?? {}).map(([attribute, field]) => [attribute, fieldSnapshot(field)]),
  );
// Whether two field snapshots hold the same values in the same order.
const sameReads = (previous, current) =>
  Array.isArray(previous) &&
  previous.length === current.length &&
  previous.every((value, index) => Object.is(value, current[index]));
const sameTableReads = (previous, current) => Boolean(previous) && sameEntries(previous, current, sameReads);
// The field reads of each table only a mapping declares, keyed by table name.
const mappedTableReads = (metadata, mappings) =>
  Object.fromEntries(
    Object.entries(mappings ?? {})
      .filter(([name]) => !metadata.entities?.[name])
      .map(([name, mapping]) => [name, fieldReads(mapping)]),
  );
/**
 * One memo of withMappedTables. While the revision function returns a value that is unchanged, and the metadata and the
 * state are the objects of the previous call, the previous value is returned without reading any mapping. Otherwise the
 * memo compares the mapping objects, the fields the mapped tables read and the metadata log, and rebuilds only when one
 * differs. A null revision means the store cannot vouch for its content, so every call takes the comparison. The
 * metadata is the overlay's result, which keeps its identity across ordinary record writes.
 */
export function createMappedTables({ revision } = {}) {
  let last = null;
  return (metadata, state) => {
    const current = revision?.() ?? null;
    if (current !== null && last?.metadata === metadata && last.state === state && last.revision === current)
      return last.value;
    const seq = state.dataverse?.metadataLog?.at(-1)?.seq ?? 0;
    const tables = mappedTableReads(metadata, state.mappings);
    if (
      last?.metadata !== metadata ||
      last.seq !== seq ||
      !sameEntries(last.mappings, state.mappings) ||
      !sameEntries(last.tables, tables, sameTableReads)
    )
      last = {
        metadata,
        seq,
        mappings: { ...state.mappings },
        tables,
        value: withMappedTables(metadata, state.mappings),
      };
    last.state = state;
    last.revision = current;
    return last.value;
  };
}

/** Build one host-local overlay, never write exported files or run imported code.
 * Parsed documents are cached by immutable asset digest. Normal business-record
 * writes do not decode or parse ZIP payloads again. appsOf is the model-driven
 * catalogue's source parser, supplied by the host to keep this adapter acyclic. */
export function createSolutionMetadataOverlay({ appsOf = () => [], parseDocument = parseSchemaDocument } = {}) {
  const parsed = new Map();
  const readEpoch = new AsyncLocalStorage();
  let previousBase, previousKey, previousRows, previousInputs, previous, mappingProbe;
  // Whether a base entity's mapping carries Dataverse metadata, rescanned only when the base,
  // the mapping set or its size, or the metadata log changes. Metadata writers log every
  // column/table change; a solution import adds a layer, which takes the full path below.
  const baseMappingMetadata = (base, state) => {
    const mappings = state.mappings,
      size = Object.keys(mappings ?? {}).length,
      seq = state.dataverse?.metadataLog?.at(-1)?.seq ?? 0;
    if (
      mappingProbe?.base !== base ||
      mappingProbe.mappings !== mappings ||
      mappingProbe.size !== size ||
      mappingProbe.seq !== seq
    )
      mappingProbe = { base, mappings, size, seq, value: hasBaseMappingMetadata(base, mappings) };
    return mappingProbe.value;
  };
  /* NOSONAR */ const resolve = (base = {}, state = {}) => {
    const epoch = readEpoch.getStore();
    const reusable = epoch && !epoch.closed && epoch.valid();
    if (epoch && !reusable) epoch.resolved = false;
    if (reusable && epoch.revision) {
      const revision = epoch.revision();
      if (epoch.lastRevision !== revision) epoch.resolved = false;
      epoch.lastRevision = revision;
    }
    if (reusable && epoch.resolved && epoch.base === base && epoch.state === state) return epoch.value;
    const finish = (value) => {
      if (reusable) {
        epoch.resolved = true;
        epoch.base = base;
        epoch.state = state;
        epoch.value = value;
      }
      return value;
    };
    const layers = state.dataverse?.solutionAssets?.layers ?? [];
    const baseline = state.dataverse?.sourceSolutionComponents?.baseline;
    const payloads = state.dataverse?.solutionPayloads;
    if (!layers.length && !Object.keys(baseline ?? {}).length && !baseMappingMetadata(base, state)) return finish(base);
    const rows = Object.fromEntries(
      ['systemform', 'savedquery', 'appmodule', 'sitemap'].map((table) => [table, state.tables?.[table] ?? []]),
    );
    const key = [
      layers.map((layer) => [layer.id, layer.ownerSolutionId]),
      state.dataverse?.metadataLog?.at(-1)?.seq ?? 0,
    ];
    // Unchanged reads compare against the retained snapshot directly. Rebuilding
    // a nested [key,type,value] tree for every component inflated first-use GC
    // and retained memory even though a read epoch bounds the number of scans.
    if (
      previousBase === base &&
      isDeepStrictEqual(previousKey, key) &&
      Object.entries(rows).every(([table, values]) => rowsMatch(values, previousRows?.[table])) &&
      mappingsMatch(state.mappings, previousInputs?.mappings) &&
      presenceMatches(baseline, previousInputs?.baseline) &&
      presenceMatches(payloads, previousInputs?.payloads) &&
      layers.length === previousInputs?.layers.length &&
      layers.every((layer, index) => layerMatches(layer, previousInputs.layers[index]))
    )
      return finish(previous);
    const rowStamps = Object.fromEntries(Object.entries(rows).map(([table, values]) => [table, values.map(rowStamp)]));
    const inputs = {
      mappings: mappingStamps(state.mappings),
      baseline: presenceStamp(baseline),
      payloads: presenceStamp(payloads),
      layers: layers.map(layerStamp),
    };
    const active = new Set(layers.map((layer) => layer.id));
    for (const digest of parsed.keys()) if (!active.has(digest)) parsed.delete(digest);
    const scan = {
      inputs: [],
      diagnostics: [],
      order: 'explicit',
      layers: layers.map((layer, index) => {
        if (!layerMatches(layer, previousInputs?.layers[index])) parsed.delete(layer.id);
        let documents = parsed.get(layer.id);
        if (!documents) {
          documents = layer.entries
            .filter((entry) => metadataXml(entry.name))
            .map((entry) => {
              const bytes = Buffer.from(entry.content, 'base64');
              if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
                throw new Error('Persisted solution asset integrity failed.');
              const info = classifySolutionPath(entry.name) ?? {};
              return {
                file: `solution-state:${layer.id}/${entry.name}`,
                kind: info.kind ?? 'xml',
                facts: parseDocument(bytes.toString('utf8'), { ...info, name: entry.name }),
                hash: entry.sha256,
              };
            });
          parsed.set(layer.id, documents);
        }
        return {
          index,
          name: layer.uniqueName,
          input: `solution-state:${layer.ownerSolutionId}`,
          type: 'state',
          files: [],
          documents,
          solution: {
            uniqueName: layer.uniqueName,
            version: layer.solutionVersion,
            managed: layer.managed ? '1' : '0',
          },
        };
      }),
    };
    const schema = buildSolutionSchema(scan, { lcid: base.lcid ?? 1033 });
    const entities = { ...base.entities };
    for (const [name, table] of Object.entries(schema.tables)) {
      if (!table.layers?.length) continue;
      entities[name] = {
        ...entities[name],
        entity: name,
        fields: tableFields(schema, name),
        sources: table.sources,
        entitySet: table.entitySet,
        ownership: table.ownership,
        tableType: table.tableType,
        dataSourceId: table.dataSourceId,
        dataProviderId: table.dataProviderId,
        changeTrackingEnabled: table.changeTrackingEnabled,
        isOptimisticConcurrencyEnabled: table.isOptimisticConcurrencyEnabled,
        label: pickLabel(table.labels, base.lcid),
        collectionLabel: pickLabel(table.collectionLabels, base.lcid),
        primaryIdAttribute: table.primaryIdAttribute,
        primaryNameAttribute: table.primaryNameAttribute,
        schemaComplete: table.schemaComplete,
        completeness: table.completeness,
      };
      const mapping = state.mappings?.[name];
      for (const [attribute, field] of Object.entries(mapping?.fields ?? {})) {
        const facts = mappingFacts(field, entities[name].fields[attribute]);
        if (!facts) continue;
        const { type: metadataType, ...properties } = facts; // NOSONAR: binding is excluded from the rest object or is a placeholder
        entities[name].fields[attribute] = {
          ...entities[name].fields[attribute],
          ...field,
          ...properties,
          name: attribute,
          label: pickLabel(facts.labels, base.lcid) ?? entities[name].fields[attribute]?.label ?? attribute,
        };
      }
      const dm = mapping?.dataverseMetadata;
      if (dm)
        Object.assign(entities[name], {
          label: pickLabel(dm.labels?.DisplayName, base.lcid) ?? entities[name].label,
          collectionLabel: pickLabel(dm.labels?.DisplayCollectionName, base.lcid) ?? entities[name].collectionLabel,
        });
    }
    for (const [name, entity] of Object.entries(entities)) {
      const mapping = state.mappings?.[name];
      if (!mapping) continue;
      const next = (entities[name] = { ...entity, fields: { ...entity.fields } });
      for (const [attribute, field] of Object.entries(mapping.fields ?? {})) {
        const facts = mappingFacts(field, next.fields[attribute]);
        if (!facts) continue;
        const { type: metadataType, ...properties } = facts; // NOSONAR: binding is excluded from the rest object or is a placeholder
        next.fields[attribute] = structuredClone({
          ...next.fields[attribute],
          ...field,
          ...properties,
          name: attribute,
          label: pickLabel(properties.labels, base.lcid) ?? next.fields[attribute]?.label ?? attribute,
          ...(!isDeepStrictEqual(facts, base.entities?.[name]?.fields?.[attribute]?.columnMetadata)
            ? { sourceOriginVerified: false }
            : {}),
        });
      }
      next.label = pickLabel(mapping.dataverseMetadata?.labels?.DisplayName, base.lcid) ?? next.label;
      next.collectionLabel =
        pickLabel(mapping.dataverseMetadata?.labels?.DisplayCollectionName, base.lcid) ?? next.collectionLabel;
      const original = base.entities?.[name];
      if (
        original &&
        (next.label !== original.label ||
          next.collectionLabel !== original.collectionLabel ||
          !isDeepStrictEqual(
            Object.keys(next.fields).sort(/* NOSONAR: preserve default string coercion */),
            Object.keys(original.fields ?? {}).sort(/* NOSONAR: preserve default string coercion */),
          ) ||
          Object.values(next.fields).some((field) => field.sourceOriginVerified === false))
      )
        next.sourceOriginVerified = false;
    }
    const components = scan.layers.flatMap((layer) =>
      layer.documents.map((document) => document.facts.appComponents ?? {}),
    );
    const rowIds = Object.fromEntries(
      Object.entries(rows).map(([table, values]) => [
        table,
        new Set(values.map((row) => id(row[COMPONENT_IDS[table]]))),
      ]),
    );
    const present = (table, componentId) =>
      (!state.dataverse?.solutionPayloads?.[componentId] &&
        !state.dataverse?.sourceSolutionComponents?.baseline?.[`${table}/${componentId}`]) ||
      rowIds[table].has(componentId);
    const localized = (component) => ({
      ...component,
      name: pickLabel(component.nameLabels, base.lcid) ?? component.name,
    });
    const forms = mergeRows(
      base.forms ?? [],
      components.flatMap((component) => component.forms ?? []).map(localized),
    ).filter((form) => present('systemform', form.id));
    const views = mergeRows(
      base.views ?? [],
      components.flatMap((component) => component.views ?? []).map(localized),
    ).filter((view) => present('savedquery', view.id));
    const firstById = (values) => {
      const byId = new Map();
      for (const value of values) if (!byId.has(value.id)) byId.set(value.id, value);
      return byId;
    };
    const formsById = firstById(forms),
      viewsById = firstById(views);
    // Current metadata rows take precedence over their original import payload.
    for (const row of rows.systemform) {
      const form = formsById.get(id(row.formid));
      if (form) {
        const { formxml, name, type, formactivationstate } = row;
        if (
          (formxml != null && formxml !== form.xml) ||
          (name != null && name !== form.name) ||
          (type != null && type !== form.systemFormType)
        )
          form.sourceOriginVerified = false;
        Object.assign(form, {
          name: name ?? form.name,
          xml: formxml ?? form.xml,
          active: formactivationstate !== 0,
          systemFormType: type ?? form.systemFormType,
        });
      }
    }
    for (const row of rows.savedquery) {
      const view = viewsById.get(id(row.savedqueryid));
      if (!view) continue;
      const { fetchxml, name, querytype, isdefault, layoutxml } = row;
      if (
        (fetchxml != null && fetchxml !== view.fetchXml) ||
        (name != null && name !== view.name) ||
        (querytype != null && querytype !== view.queryType)
      )
        view.sourceOriginVerified = false;
      Object.assign(view, {
        name: name ?? view.name,
        fetchXml: fetchxml ?? view.fetchXml,
        queryType: querytype ?? view.queryType,
        isDefault: isdefault ?? view.isDefault,
      });
      if (layoutxml) {
        const fields = descendants(parseSolutionXml(layoutxml), 'cell')
          .filter((cell) => cell.attrs.ishidden !== '1')
          .map((cell) => ({ name: cell.attrs.name, width: Number(cell.attrs.width) || 180 }));
        if (!isDeepStrictEqual(fields, view.fields)) view.sourceOriginVerified = false;
        view.fields = fields;
      }
    }
    const appDocuments = [];
    for (const row of rows.appmodule)
      if (row.appmodulexml)
        appDocuments.push({
          file: `solution-row:appmodule/${id(row.appmoduleid)}`,
          facts: parseDocument(row.appmodulexml),
        });
    for (const row of rows.sitemap)
      if (row.sitemapxml) {
        const facts = parseDocument(row.sitemapxml);
        for (const map of facts.appMaps ?? []) {
          map.appId ||= id(row.appmoduleid);
          map.uniqueName ||= row.appmoduleuniquename;
        }
        appDocuments.push({ file: `solution-row:sitemap/${id(row.sitemapid)}`, facts });
      }
    const explicitMaps = [...scan.layers.flatMap((layer) => layer.documents), ...appDocuments].flatMap(
      (document) => document.facts.appMaps ?? [],
    );
    const apps = [];
    for (const source of [
      ...(base.modelDrivenApps ?? []),
      ...appsOf({ ...scan, layers: [...scan.layers, { documents: appDocuments }] }, { lcid: base.lcid ?? 1033 }),
    ]) {
      if (!present('appmodule', source.id)) continue;
      const index = apps.findIndex(
        (app) => (source.id && app.id === source.id) || (source.uniqueName && app.uniqueName === source.uniqueName),
      );
      const next = structuredClone(source);
      if (index < 0) apps.push(next);
      else {
        const explicitNavigation =
          explicitMaps.some((map) => map.uniqueName === next.uniqueName || (map.appId && map.appId === next.id)) ||
          rows.appmodule.some(
            (row) => id(row.appmoduleid) === next.id && /<SiteMap(?:\s|>)/i.test(row.appmodulexml ?? ''),
          );
        if (!next.navigation?.length && !explicitNavigation)
          next.navigation = structuredClone(apps[index].navigation ?? []);
        // Mirrored component rows are reparsed under synthetic identities. A
        // byte-independent parsed equality proves an unchanged local mapping;
        // edited navigation keeps its synthetic origin and cannot open a file
        // merely because the same app ID exists in an export.
        if (isDeepStrictEqual(next.navigation, apps[index].navigation)) {
          next.navigationIdentityFile = apps[index].navigationIdentityFile;
          next.navigationSourceFile = apps[index].navigationSourceFile;
        }
        if (!next.dashboards?.length) next.dashboards = structuredClone(apps[index].dashboards ?? []);
        // Mobile offline profiles come from Solution component files the overlay does not reparse (model-driven/offline.mjs).
        if (!next.offlineProfiles?.length) next.offlineProfiles = structuredClone(apps[index].offlineProfiles ?? []);
        apps[index] = next;
      }
    }
    for (const app of apps) {
      const row = rows.appmodule.find((row) => id(row.appmoduleid) === app.id || row.uniquename === app.uniqueName);
      if (row) Object.assign(app, { name: row.name ?? app.name, uniqueName: row.uniquename ?? app.uniqueName });
    }
    previousBase = base;
    previousKey = key;
    previousRows = rowStamps;
    previousInputs = inputs;
    previous = {
      ...base,
      entities,
      forms,
      views,
      modelDrivenApps: apps,
      layers: [...(base.layers ?? []), ...schema.layers],
      importedSchema: schema,
    };
    return finish(previous);
  };
  // Hosts use this only for a read-only catalogue projection, inside their
  // serialized store read. Retain that projection's first metadata snapshot
  // across cooperative yields; the next request always establishes a new epoch.
  // Staff grants and field permissions remain live checks, never epoch-cached.
  return Object.assign(resolve, {
    withReadEpoch: (fn, options = {}) => {
      const { valid = () => true, revision } = options;
      const inherited = readEpoch.getStore();
      if (inherited && !inherited.closed && !Object.keys(options).length) return fn();
      const parent = inherited && !inherited.closed ? inherited : null;
      // Explicit nested boundaries may narrow validity or change the revision
      // source. Never let an outer snapshot bypass either restriction, or reuse
      // its pre-boundary projection after an inner write.
      if (parent) parent.resolved = false;
      const epoch = {
        resolved: false,
        valid: () => (!parent || parent.valid()) && valid(),
        revision: parent?.revision || revision ? () => JSON.stringify([parent?.revision?.(), revision?.()]) : undefined,
      };
      const close = () => {
        epoch.closed = true;
        epoch.value = undefined;
        if (parent) parent.resolved = false;
      };
      return readEpoch.run(epoch, () => {
        try {
          const result = fn();
          if (result && typeof result.then === 'function') return Promise.resolve(result).finally(close);
          close();
          return result;
        } catch (error) {
          close();
          throw error;
        }
      });
    },
  });
}
