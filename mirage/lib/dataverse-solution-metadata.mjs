import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { classifySolutionPath, parseSchemaDocument, buildSolutionSchema, tableFields } from './solution-schema.mjs';
import { parseSolutionXml, descendants, pickLabel } from './solution-xml.mjs';

const id = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const mergeRows = (base, incoming) => [...new Map([...base, ...incoming].map(row => [row.uniqueName ?? `${row.entity ?? ''}/${row.id}`, structuredClone(row)])).values()];
const metadataXml = name => /(?:^|\/)(?:customizations\.xml|Entities\/.*\.xml|AppModules\/.*\.xml|AppModuleSiteMaps\/.*\.xml|Other\/Solution\.xml|solution\.xml|OptionSets\/.*\.xml|Relationships\/.*\.xml)$/i.test(name);
// Most component values are scalar strings, including potentially large XML.
// Compare those values directly instead of serializing their contents on every
// record-field lookup. Snapshot small structured values too so in-place edits
// cannot reuse a stale catalogue simply because the row identity stayed equal.
const rowStamp = row => Object.entries(row).map(([key, value]) => [key, typeof value,
  value !== null && typeof value === 'object' ? JSON.stringify(value) : value]);

/** Build one host-local overlay, never write exported files or run imported code.
 * Parsed documents are cached by immutable asset digest. Normal business-record
 * writes do not decode or parse ZIP payloads again. appsOf is the model-driven
 * catalogue's source parser, supplied by the host to keep this adapter acyclic. */
export function createSolutionMetadataOverlay({ appsOf = () => [], parseDocument = parseSchemaDocument } = {}) {
  const parsed = new Map();
  let previousBase, previousKey, previous;
  return (base = {}, state = {}) => {
    const layers = state.dataverse?.solutionAssets?.layers ?? [];
    if (!layers.length && !Object.keys(state.dataverse?.sourceSolutionComponents?.baseline ?? {}).length) return base;
    const rows = Object.fromEntries(['systemform', 'savedquery', 'appmodule', 'sitemap'].map(table => [table, state.tables?.[table] ?? []]));
    const key = [layers.map(layer => [layer.id, layer.ownerSolutionId]),
      Object.entries(rows).map(([table, values]) => [table, values.map(rowStamp)]), state.dataverse?.metadataLog?.at(-1)?.seq ?? 0];
    if (previousBase === base && isDeepStrictEqual(previousKey, key)) return previous;
    const active = new Set(layers.map(layer => layer.id));
    for (const digest of parsed.keys()) if (!active.has(digest)) parsed.delete(digest);
    const scan = { inputs: [], diagnostics: [], order: 'explicit', layers: layers.map((layer, index) => {
      let documents = parsed.get(layer.id);
      if (!documents) {
        documents = layer.entries.filter(entry => metadataXml(entry.name)).map(entry => {
          const bytes = Buffer.from(entry.content, 'base64');
          if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
            throw new Error('Persisted solution asset integrity failed.');
          const info = classifySolutionPath(entry.name) ?? {};
          return { file: `solution-state:${layer.id}/${entry.name}`, kind: info.kind ?? 'xml', facts: parseDocument(bytes.toString('utf8'), { ...info, name: entry.name }), hash: entry.sha256 };
        });
        parsed.set(layer.id, documents);
      }
      return { index, name: layer.uniqueName, input: `solution-state:${layer.ownerSolutionId}`, type: 'state', files: [], documents, solution: { uniqueName: layer.uniqueName, version: layer.solutionVersion, managed: layer.managed ? '1' : '0' } };
    }) };
    const schema = buildSolutionSchema(scan, { lcid: base.lcid ?? 1033 });
    const entities = { ...base.entities };
    for (const [name, table] of Object.entries(schema.tables)) {
      if (!table.layers?.length) continue;
      entities[name] = { ...entities[name], entity: name, fields: tableFields(schema, name), sources: table.sources, entitySet: table.entitySet, ownership: table.ownership,
        tableType: table.tableType, dataSourceId: table.dataSourceId, dataProviderId: table.dataProviderId, changeTrackingEnabled: table.changeTrackingEnabled, isOptimisticConcurrencyEnabled: table.isOptimisticConcurrencyEnabled,
        label: pickLabel(table.labels, base.lcid), collectionLabel: pickLabel(table.collectionLabels, base.lcid),
        primaryIdAttribute: table.primaryIdAttribute, primaryNameAttribute: table.primaryNameAttribute, schemaComplete: table.schemaComplete, completeness: table.completeness };
      const mapping = state.mappings?.[name];
      for (const [attribute, field] of Object.entries(mapping?.fields ?? {})) {
        const facts = field.columnMetadata;
        if (!facts) continue;
        const { type: metadataType, ...properties } = facts;
        entities[name].fields[attribute] = { ...entities[name].fields[attribute], ...field, ...properties, name: attribute,
          label: pickLabel(facts.labels, base.lcid) ?? entities[name].fields[attribute]?.label ?? attribute };
      }
      const dm = mapping?.dataverseMetadata;
      if (dm) Object.assign(entities[name], { label: pickLabel(dm.labels?.DisplayName, base.lcid) ?? entities[name].label, collectionLabel: pickLabel(dm.labels?.DisplayCollectionName, base.lcid) ?? entities[name].collectionLabel });
    }
    for (const [name, entity] of Object.entries(entities)) {
      const mapping = state.mappings?.[name];
      if (!mapping) continue;
      const next = entities[name] = { ...entity, fields: { ...entity.fields } };
      for (const [attribute, field] of Object.entries(mapping.fields ?? {})) {
        if (!field.columnMetadata) continue;
        const { type: metadataType, ...properties } = field.columnMetadata;
        next.fields[attribute] = { ...next.fields[attribute], ...field, ...properties, name: attribute,
          label: pickLabel(properties.labels, base.lcid) ?? next.fields[attribute]?.label ?? attribute };
      }
      next.label = pickLabel(mapping.dataverseMetadata?.labels?.DisplayName, base.lcid) ?? next.label;
      next.collectionLabel = pickLabel(mapping.dataverseMetadata?.labels?.DisplayCollectionName, base.lcid) ?? next.collectionLabel;
    }
    const components = scan.layers.flatMap(layer => layer.documents.map(document => document.facts.appComponents ?? {}));
    const present = (table, key, componentId) => (!state.dataverse?.solutionPayloads?.[componentId]
      && !state.dataverse?.sourceSolutionComponents?.baseline?.[`${table}/${componentId}`]) || rows[table].some(row => id(row[key]) === componentId);
    const localized = component => ({ ...component, name: pickLabel(component.nameLabels, base.lcid) ?? component.name });
    const forms = mergeRows(base.forms ?? [], components.flatMap(component => component.forms ?? []).map(localized)).filter(form => present('systemform', 'formid', form.id));
    const views = mergeRows(base.views ?? [], components.flatMap(component => component.views ?? []).map(localized)).filter(view => present('savedquery', 'savedqueryid', view.id));
    // Current metadata rows take precedence over their original import payload.
    for (const row of rows.systemform) {
      const form = forms.find(form => form.id === id(row.formid));
      if (form) Object.assign(form, { name: row.name ?? form.name, xml: row.formxml ?? form.xml, active: row.formactivationstate !== 0, systemFormType: row.type ?? form.systemFormType });
    }
    for (const row of rows.savedquery) {
      const view = views.find(view => view.id === id(row.savedqueryid));
      if (!view) continue;
      Object.assign(view, { name: row.name ?? view.name, fetchXml: row.fetchxml ?? view.fetchXml, queryType: row.querytype ?? view.queryType, isDefault: row.isdefault ?? view.isDefault });
      if (row.layoutxml) view.fields = descendants(parseSolutionXml(row.layoutxml), 'cell').filter(cell => cell.attrs.ishidden !== '1').map(cell => ({ name: cell.attrs.name, width: Number(cell.attrs.width) || 180 }));
    }
    const appDocuments = [];
    for (const row of rows.appmodule) if (row.appmodulexml) appDocuments.push({ file: `solution-row:appmodule/${id(row.appmoduleid)}`, facts: parseDocument(row.appmodulexml) });
    for (const row of rows.sitemap) if (row.sitemapxml) {
      const facts = parseDocument(row.sitemapxml);
      for (const map of facts.appMaps ?? []) { map.appId ||= id(row.appmoduleid); map.uniqueName ||= row.appmoduleuniquename; }
      appDocuments.push({ file: `solution-row:sitemap/${id(row.sitemapid)}`, facts });
    }
    const explicitMaps = [...scan.layers.flatMap(layer => layer.documents), ...appDocuments].flatMap(document => document.facts.appMaps ?? []);
    const apps = [];
    for (const source of [...(base.modelDrivenApps ?? []), ...appsOf({ ...scan, layers: [...scan.layers, { documents: appDocuments }] }, { lcid: base.lcid ?? 1033 })]) {
      if (!present('appmodule', 'appmoduleid', source.id)) continue;
      const index = apps.findIndex(app => source.id && app.id === source.id || source.uniqueName && app.uniqueName === source.uniqueName);
      const next = structuredClone(source);
      if (index < 0) apps.push(next);
      else {
        const explicitNavigation = explicitMaps.some(map => map.uniqueName === next.uniqueName || map.appId && map.appId === next.id)
          || rows.appmodule.some(row => id(row.appmoduleid) === next.id && /<SiteMap(?:\s|>)/i.test(row.appmodulexml ?? ''));
        if (!next.navigation?.length && !explicitNavigation) next.navigation = structuredClone(apps[index].navigation ?? []);
        apps[index] = next;
      }
    }
    for (const app of apps) {
      const row = rows.appmodule.find(row => id(row.appmoduleid) === app.id || row.uniquename === app.uniqueName);
      if (row) Object.assign(app, { name: row.name ?? app.name, uniqueName: row.uniquename ?? app.uniqueName });
    }
    previousBase = base;
    previousKey = key;
    previous = { ...base, entities, forms, views, modelDrivenApps: apps, layers: [...(base.layers ?? []), ...schema.layers], importedSchema: schema };
    return previous;
  };
}
