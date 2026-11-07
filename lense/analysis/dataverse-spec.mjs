import { metadataFields, rootKey, lower, objectRows } from './dataverse-document.mjs';

const scoped = (entry, name) => JSON.stringify([rootKey(entry), lower(name)]);
const values = (object, key) => objectRows(object?.[key]);
const sourceOf = (document) => ({ ...document.entry, exactLocation: false });

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

function inspectSpecChoices(options, source, emit) {
  const seen = new Set();
  for (const option of objectRows(options)) {
    if (!Number.isInteger(option?.value)) continue;
    if (seen.has(option.value)) emit('DV-SCHEMA-002', source, 'options');
    seen.add(option.value);
  }
}

function inspectSpecColumns(spec, source, emit) {
  for (const entity of values(spec, 'entities')) {
    for (const column of values(entity, 'columns')) {
      if (
        typeof column.minValue === 'number' &&
        typeof column.maxValue === 'number' &&
        column.minValue > column.maxValue
      )
        emit('DV-SCHEMA-001', source, 'minValue');
      inspectSpecChoices(column.options, source, emit);
    }
  }
  for (const choice of values(spec, 'globalChoices')) inspectSpecChoices(choice.options, source, emit);
}

function inspectSpecRelationships(spec, source, facts, emit) {
  for (const relationship of values(spec, 'relationships'))
    for (const field of ['referenced', 'referencing', 'entity1', 'entity2']) {
      const table = relationship[field];
      if (typeof table === 'string' && !facts.tables.has(scoped(source, table))) emit('DV-SCHEMA-003', source, field);
    }
}

function inspectSpecHandlers(form, source, facts, emit) {
  const seen = new Set();
  for (const handler of values(form, 'events')) {
    if (handler.enabled === false) continue;
    if (typeof handler.library === 'string' && !facts.resources.has(scoped(source, handler.library)))
      emit('DV-MODEL-001', source, 'library');
    const key = JSON.stringify(
      ['event', 'attribute', 'library', 'function', 'parameters'].map((name) => handler[name] ?? ''),
    );
    if (seen.has(key)) emit('DV-MODEL-002', source, 'events');
    seen.add(key);
  }
}

function inspectSpecNodeFields(node, columns, source, emit) {
  for (const field of Array.isArray(node?.fields) ? node.fields : []) {
    const name = typeof field === 'string' ? field : field?.name;
    if (typeof name === 'string' && !columns.has(lower(name))) emit('DV-MODEL-003', source, 'fields');
  }
}

function inspectSpecFields(form, source, facts, emit) {
  const columns = facts.columns.get(scoped(source, form.entity));
  if (!columns) return;
  const pending = [...values(form, 'tabs')];
  while (pending.length) {
    const node = pending.pop();
    inspectSpecNodeFields(node, columns, source, emit);
    for (const child of [...values(node, 'sections'), ...values(node, 'columns')]) pending.push(child);
  }
}

function inspectSpecViews(spec, source, facts, emit) {
  for (const view of values(spec, 'views')) {
    const columns = facts.columns.get(scoped(source, view.entity));
    if (!columns) continue;
    for (const column of Array.isArray(view.columns) ? view.columns : [])
      if (typeof column === 'string' && !columns.has(lower(column))) emit('DV-MODEL-004', source, 'columns');
  }
}

function inspectCustomApis(spec, source, emit) {
  for (const api of values(spec, 'customApis')) {
    const fields = metadataFields(api);
    if (
      ['entity', 'entitycollection', '1', '2'].includes(lower(fields.binding ?? fields.bindingtype)) &&
      !String(fields.boundentitylogicalname ?? '').trim()
    )
      emit('DV-API-001', source, 'boundEntityLogicalName');
    if (!fields.plugintypeid && !fields.implementation) emit('DV-API-002', source, 'customApis');
  }
}

export function analyzeDataverseSpec(document, facts, emit) {
  const spec = document.value,
    source = sourceOf(document);
  inspectSpecColumns(spec, source, emit);
  inspectSpecRelationships(spec, source, facts, emit);
  inspectSpecViews(spec, source, facts, emit);
  inspectCustomApis(spec, source, emit);
  for (const form of values(spec, 'forms')) {
    inspectSpecHandlers(form, source, facts, emit);
    inspectSpecFields(form, source, facts, emit);
  }
  return true;
}
