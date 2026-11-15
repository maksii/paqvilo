import { metadataFields, rootKey, lower, objectRows } from './dataverse-document.mjs';

const scoped = (entry, name) => JSON.stringify([rootKey(entry), lower(name)]);
const values = (object, key) => objectRows(object?.[key]);

export function collectSpecSchema(document, facts) {
  const spec = document.value;
  for (const entity of values(spec, 'entities')) {
    if (typeof entity.schemaName !== 'string' || entity.schemaName.length > 512) continue;
    const key = scoped(document.entry, entity.schemaName),
      columns = facts.columns.get(key) ?? new Set();
    facts.tables.add(key);
    for (const column of values(entity, 'columns'))
      if (typeof column.schemaName === 'string') columns.add(lower(column.schemaName));
    if (typeof entity.primaryAttribute?.schemaName === 'string') columns.add(lower(entity.primaryAttribute.schemaName));
    facts.columns.set(key, columns);
  }
  for (const resource of values(spec, 'webResources'))
    if (typeof resource.name === 'string') facts.resources.add(scoped(document.entry, resource.name));
}

function inspectSpecChoices(options, at, emit) {
  const seen = new Set();
  for (const option of objectRows(options)) {
    if (!Number.isInteger(option?.value)) continue;
    if (seen.has(option.value)) emit('DV-SCHEMA-002', at(option, 'value'), 'options');
    seen.add(option.value);
  }
}

function inspectSpecColumns(spec, at, emit) {
  for (const entity of values(spec, 'entities')) {
    for (const column of values(entity, 'columns')) {
      if (
        typeof column.minValue === 'number' &&
        typeof column.maxValue === 'number' &&
        column.minValue > column.maxValue
      )
        emit('DV-SCHEMA-001', at(column, 'minValue'), 'minValue');
      inspectSpecChoices(column.options, at, emit);
    }
  }
  for (const choice of values(spec, 'globalChoices')) inspectSpecChoices(choice.options, at, emit);
}

function inspectSpecRelationships(spec, source, facts, emit, at) {
  for (const relationship of values(spec, 'relationships'))
    for (const field of ['referenced', 'referencing', 'entity1', 'entity2']) {
      const table = relationship[field];
      if (typeof table === 'string' && !facts.tables.has(scoped(source, table)))
        emit('DV-SCHEMA-003', at(relationship, field), field);
    }
}

function inspectSpecHandlers(form, source, facts, emit, at) {
  const seen = new Set();
  for (const handler of values(form, 'events')) {
    if (handler.enabled === false) continue;
    if (typeof handler.library === 'string' && !facts.resources.has(scoped(source, handler.library)))
      emit('DV-MODEL-001', at(handler, 'library'), 'library');
    const key = JSON.stringify(
      ['event', 'attribute', 'library', 'function', 'parameters'].map((name) => handler[name] ?? ''),
    );
    if (seen.has(key)) emit('DV-MODEL-002', at(handler), 'events');
    seen.add(key);
  }
}

function inspectSpecNodeFields(node, columns, at, emit) {
  const fields = Array.isArray(node?.fields) ? node.fields : [];
  for (const [index, field] of fields.entries()) {
    const name = typeof field === 'string' ? field : field?.name;
    if (typeof name === 'string' && !columns.has(lower(name))) emit('DV-MODEL-003', at(fields, index), 'fields');
  }
}

function inspectSpecFields(form, source, facts, emit, at) {
  const columns = facts.columns.get(scoped(source, form.entity));
  if (!columns) return;
  const pending = [...values(form, 'tabs')];
  while (pending.length) {
    const node = pending.pop();
    inspectSpecNodeFields(node, columns, at, emit);
    for (const child of [...values(node, 'sections'), ...values(node, 'columns')]) pending.push(child);
  }
}

function inspectSpecViews(spec, source, facts, emit, at) {
  for (const view of values(spec, 'views')) {
    const columns = facts.columns.get(scoped(source, view.entity));
    if (!columns) continue;
    const names = Array.isArray(view.columns) ? view.columns : [];
    for (const [index, column] of names.entries())
      if (typeof column === 'string' && !columns.has(lower(column))) emit('DV-MODEL-004', at(names, index), 'columns');
  }
}

function inspectCustomApis(spec, at, emit) {
  for (const api of values(spec, 'customApis')) {
    const fields = metadataFields(api);
    if (
      ['entity', 'entitycollection', '1', '2'].includes(lower(fields.binding ?? fields.bindingtype)) &&
      !String(fields.boundentitylogicalname ?? '').trim()
    )
      emit('DV-API-001', at(api, 'boundEntityLogicalName'), 'boundEntityLogicalName');
    if (!fields.plugintypeid && !fields.implementation) emit('DV-API-002', at(api), 'customApis');
  }
}

export function analyzeDataverseSpec(document, facts, emit) {
  const spec = document.value,
    source = document.entry,
    at = document.at;
  inspectSpecColumns(spec, at, emit);
  inspectSpecRelationships(spec, source, facts, emit, at);
  inspectSpecViews(spec, source, facts, emit, at);
  inspectCustomApis(spec, at, emit);
  for (const form of values(spec, 'forms')) {
    inspectSpecHandlers(form, source, facts, emit, at);
    inspectSpecFields(form, source, facts, emit, at);
  }
  return true;
}
