import { DataStore } from '../data.mjs';
import { parseSolutionXml, child, serializeXml } from '../solution-xml.mjs';
import { managementOverlay } from './power-pages.mjs';
import { controlDescriptor } from './control-descriptors.mjs';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status, code: 'ModelDrivenRequestInvalid' });
const node = (name, attrs = {}, children = []) => ({ name, attrs, children, text: '' });
const admin = Object.freeze({ admin: true });
function validateWebApiQuery(input) {
  if (typeof input.options !== 'string' || input.options.length > 65536 || input.options && !input.options.startsWith('?') || /[\r\n#]/.test(input.options)) throw invalid('Provide local WebApi query options.');
  if (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 5000)) throw invalid('WebApi page size must be between 1 and 5000.');
}
export function writableField(field, operation) {
  return controlDescriptor(field)[operation === 'create' ? 'create' : 'update'];
}
export function validateValues(table, values, operation) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid('Provide a values object.');
  const result = {};
  for (const [name, value] of Object.entries(values)) {
    const field = Object.hasOwn(table.fields, name) ? table.fields[name] : null;
    if (!field || !writableField(field, operation)) throw invalid(`Column ${name} is unavailable for ${operation}.`);
    if (field.required && (value == null || value === '' || Array.isArray(value) && !value.length)) throw invalid(`${field.label} is required.`);
    if (value != null) {
      if (field.type === 'boolean' && typeof value !== 'boolean') throw invalid(`${field.label} requires a boolean.`);
      if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw invalid(`${field.label} requires a finite number.`);
      if (field.type === 'date' && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw invalid(`${field.label} requires a date.`);
      if (['text', 'textarea', 'lookup'].includes(field.type ?? 'text') && typeof value !== 'string' && !(field.type === 'lookup' && typeof value === 'object' && value.id)) throw invalid(`${field.label} requires text or a lookup reference.`);
      if (field.maxLength && String(value).length > field.maxLength) throw invalid(`${field.label} exceeds ${field.maxLength} characters.`);
      if (field.type === 'multiselect') {
        if (!Array.isArray(value) || value.length > 150 || value.some(option => !Number.isInteger(option) || !field.options?.some(known => known.value === option))) throw invalid(`${field.label} requires an array of known choice values.`);
      } else if (field.options?.length && !field.options.some(option => String(field.type === 'boolean' ? Number(option.value) : option.value) === String(field.type === 'boolean' ? Number(value) : value))) throw invalid(`${field.label} has an invalid choice.`);
    }
    // The form API uses numeric arrays; the shared Dataverse record pipeline
    // accepts the native Web API's comma-separated representation.
    result[name] = field.type === 'multiselect' && Array.isArray(value) ? value.length ? [...new Set(value)].join(',') : null : value;
  }
  if (operation === 'create') for (const field of Object.values(table.fields)) {
    // Dataverse supplies omitted system-required values (owner, state and audit
    // columns) in the canonical create pipeline. Explicit nulls still fail above.
    if (field.required && String(field.requiredLevel ?? '').toLowerCase() !== 'systemrequired' && writableField(field, operation) && (result[field.name] == null || result[field.name] === '')) throw invalid(`${field.label} is required.`);
  }
  return result;
}

function projectedStore(table) {
  return new DataStore({ state: { version: 1,
    mappings: { [table.entity]: { entitySet: table.entity + 's', idColumn: table.idColumn, nameColumn: table.nameColumn, fields: table.fields } },
    tables: { [table.entity]: table.rows }, settings: { permissionMode: 'permissive' } } });
}

/** The shell consumes this interface, not HTTP OData or the live bridge. The
 * Dataverse HTTP host can use the same DataStore without coupling either UI to it. */
export function createModelDrivenData({ store, catalogue, portal, saveOverlay, writeRecord, recordService, readMetadata = fn => fn() }) {
  const readOperation = fn => store.readOperation(() => readMetadata(fn));
  const tableFor = entity => {
    const tables = catalogue().tables;
    const table = Object.hasOwn(tables, entity) ? tables[entity] : null;
    if (!table) throw invalid('Table is unavailable in this runtime.', 404);
    return table;
  };
  const backend = table => table.projected && !store.state.mappings[table.entity]?.modelDrivenSource ? projectedStore(table) : store;
  const format = (table, rows) => {
    const tables = catalogue().tables;
    return rows.map(row => {
      const copy = { ...row };
      for (const field of Object.values(table.fields)) {
        if (field.type !== 'lookup' || row[field.name] == null) continue;
        const value = row[field.name], id = String(value?.id ?? value?.value ?? value).replace(/[{}]/g, '').toLowerCase();
        let name = value?.name;
        for (const entity of field.targets ?? []) {
          const target = tables[entity]; if (!target) continue;
          const targetRows = target.projected && !store.state.mappings[entity]?.modelDrivenSource ? target.rows : store.tableRows(entity);
          const found = targetRows.find(record => String(record[target.idColumn]).replace(/[{}]/g, '').toLowerCase() === id);
          if (found) { name = found[target.nameColumn]; break; }
        }
        if (!name && table.kind === 'website' && /defaultlanguage$/.test(field.name)) name = portal().websiteLanguages?.find(language => language.id === id)?.displayName;
        if (name) copy[field.name + '@OData.Community.Display.V1.FormattedValue'] = name;
      }
      return copy;
    });
  };
  const capabilities = (entity, actor, id, fields = tableFor(entity).fields) => {
    const rights = recordService?.capabilities?.(entity, actor, { id, fields });
    return rights && id && tableFor(entity).protectedIds?.includes(id) ? { ...rights, delete: false } : rights;
  };
  return {
    tableFor,
    capabilities,
    async list(entity, input = {}, actor = {}) {
      return readOperation(async () => {
      const table = tableFor(entity);
      if (input.scope === 'odata') {
        if (!recordService?.list) throw invalid('Organization queries are unavailable.', 501);
        validateWebApiQuery(input);
        return recordService.list(entity, input.options, { ...actor, pageSize: input.pageSize });
      }
      if (input.scope !== undefined && input.scope !== 'table') throw invalid('Unsupported query scope.');
      if (input.scope === 'table' && input.view) throw invalid('A table query cannot select a saved view.');
      const view = input.scope === 'table' ? { id: null, fields: Object.keys(table.fields).map(name => ({ name })) }
        : [...table.views, ...(table.lookupViews ?? [])].find(view => view.id === input.view) ?? (!input.view ? table.views.find(view => view.isDefault) ?? table.views[0] : null);
      if (!view) throw invalid('View not found.', 404);
      const fields = input.columns ?? view.fields.map(field => field.name);
      if (!Array.isArray(fields) || !fields.length || fields.length > 100 || fields.some(name => !table.fields[name] && !view.fields.some(field => field.name === name))) throw invalid('Select known columns.');
      const root = view.fetchXml ? parseSolutionXml(view.fetchXml) : node('fetch', {}, [node('entity', { name: entity })]);
      const target = child(root, 'entity');
      if (root.name !== 'fetch' || target?.attrs.name !== entity) throw invalid('Saved view does not target this table.');
      root.attrs.count = String(Math.max(1, Math.min(input.scope === 'table' ? 5000 : 100, Number(input.pageSize) || 50)));
      root.attrs.page = String(Math.max(1, Math.min(100000, Number(input.page) || 1)));
      root.attrs.returntotalrecordcount = 'true';
      delete root.attrs.top;
      for (const name of new Set([table.idColumn, ...fields])) if (/^[a-z][\w]*$/i.test(name) && !target.children.some(item => item.name === 'attribute' && item.attrs.name === name)) target.children.push(node('attribute', { name }));
      const filter = node('filter', { type: 'and' });
      if (view.state !== undefined && table.fields.statecode) filter.children.push(node('condition', { attribute: 'statecode', operator: 'eq', value: String(view.state) }));
      if (input.search) {
        if (typeof input.search !== 'string' || input.search.length > 500) throw invalid('Search is limited to 500 characters.');
        const columns = Object.keys(table.fields).filter(name => ['text', 'textarea'].includes(table.fields[name].type) && !table.fields[name].isPrimaryId);
        if (columns.length) filter.children.push(node('filter', { type: 'or' }, columns.map(name => node('condition', { attribute: name, operator: 'like', value: `%${input.search.replace(/[\[%_]/g, char => `[${char}]`)}%` }))));
      }
      if (input.filters !== undefined && (!Array.isArray(input.filters) || input.filters.length > 30)) throw invalid('Provide at most 30 filter conditions.');
      for (const condition of input.filters ?? []) {
        if (!table.fields[condition.field] || !['eq', 'ne', 'like', 'not-like', 'contains', 'not-contains', 'begins-with', 'ends-with', 'gt', 'ge', 'lt', 'le', 'null', 'not-null'].includes(condition.operator)) throw invalid('Unsupported filter column or operator.');
        let operator = condition.operator, value = String(condition.value ?? '');
        // The native filter editor treats the typed text as a literal substring.
        // Explicit legacy LIKE queries retain their existing pattern semantics.
        if (['contains', 'not-contains', 'begins-with', 'ends-with'].includes(operator)) {
          const literal = value.replace(/[\[%_]/g, char => `[${char}]`);
          value = (operator === 'ends-with' || operator.endsWith('contains') ? '%' : '') + literal + (operator === 'begins-with' || operator.endsWith('contains') ? '%' : '');
          operator = operator === 'not-contains' ? 'not-like' : 'like';
        }
        filter.children.push(node('condition', { attribute: condition.field, operator, ...(!['null', 'not-null'].includes(operator) ? { value } : {}) }));
      }
      if (filter.children.length) target.children.push(filter);
      if (input.sort) {
        if (!table.fields[input.sort] || !['asc', 'desc'].includes(input.direction ?? 'asc')) throw invalid('Unsupported sort.');
        target.children = target.children.filter(item => item.name !== 'order');
        target.children.push(node('order', { attribute: input.sort, descending: input.direction === 'desc' ? 'true' : 'false' }));
      }
      if (!target.children.some(item => item.name === 'order')) target.children.push(node('order', { attribute: table.nameColumn }));
      const db = backend(table);
      const secured = recordService ? await recordService.query(entity, serializeXml(root), actor) : null;
      const result = secured ? null : db === store ? db.fetchXml(serializeXml(root), admin) : await db.readOperation(() => db.fetchXml(serializeXml(root), admin));
      const order = target.children.find(item => item.name === 'order');
      return { rows: secured?.rows ?? format(table, result.entities), total: secured?.total ?? result.total_record_count, more: secured?.more ?? result.more_records,
        ...(recordService?.capabilities ? { capabilities: capabilities(entity, actor),
          rowCapabilities: Object.fromEntries(secured.rows.map(row => { const id = row[table.idColumn]; return [id, capabilities(entity, actor, id, {})]; })) } : {}),
        page: Number(root.attrs.page), pageSize: Number(root.attrs.count), columns: fields, view: view.id,
        sort: order?.attrs.attribute, direction: order?.attrs.descending === 'true' ? 'desc' : 'asc' };
      });
    },
    async get(entity, id, actor = {}, input = {}) {
      return readOperation(async () => {
      const table = tableFor(entity), db = backend(table);
      if (input.scope === 'odata') {
        if (!recordService?.retrieve) throw invalid('Organization queries are unavailable.', 501);
        validateWebApiQuery(input);
        return recordService.retrieve(entity, id, input.options, actor);
      }
      if (recordService) return { ...await recordService.get(entity, id, actor), capabilities: capabilities(entity, actor, id) };
      const row = db === store ? db.get(entity, id, admin) : await db.readOperation(() => db.get(entity, id, admin));
      if (!row) throw invalid('Record not found.', 404);
      return { row: format(table, [row])[0], etag: db.etag(row) };
      });
    },
    async write(entity, id, values, { remove = false, etag, ...actor } = {}) {
      const table = await store.readOperation(() => tableFor(entity)), db = backend(table), operation = id ? 'update' : 'create';
      if (remove && !id) throw invalid('A record ID is required.');
      const data = remove ? {} : validateValues(table, values, operation);
      // Require a version when editing existing data; stale tabs cannot silently overwrite.
      if (id && !etag) throw invalid('Reload the record before saving or deleting it.', 428);
      if (remove && table.protectedIds?.includes(id)) throw invalid('The source website cannot be deleted from its own running Mirage instance.', 501);
      if (recordService) {
        const saved = await recordService.write({ entity, id, values: data, remove, etag, ...actor });
        return remove ? saved : { ...saved, capabilities: capabilities(entity, actor, saved.id) };
      }
      if (writeRecord && db === store) {
        const result = await writeRecord({ entity, id, values: data, remove, etag });
        if (remove) return { deleted: true };
        return store.readOperation(() => {
        const saved = store.get(entity, result.id, admin);
        return { row: format(table, [saved])[0], etag: store.etag(saved) };
        });
      }
      const options = { coerce: true, metadata: () => table.fields, ...(id ? { ifMatch: etag } : {}) };
      const row = remove ? await db.remove(entity, id, admin, options) : id ? await db.update(entity, id, data, admin, options) : await db.create(entity, data, admin, options);
      if (table.projected) {
        const recordId = id ?? row[table.idColumn];
        const previous = table.rows.find(record => record[table.idColumn] === recordId);
        await saveOverlay(`${table.kind}/${recordId}`, remove ? null : managementOverlay(table, row, previous));
        if (!remove) {
          return store.readOperation(() => {
          const savedTable = tableFor(entity), savedStore = backend(savedTable);
          const savedRow = savedStore.get(entity, recordId, admin);
          return { row: format(savedTable, [savedRow])[0], etag: savedStore.etag(savedRow) };
          });
        }
      }
      return remove ? { deleted: true } : { row, etag: db.etag(row) };
    },
  };
}
