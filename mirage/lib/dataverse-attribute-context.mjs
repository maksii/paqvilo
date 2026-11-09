import { templateDataRecord } from './error-template-data.mjs';

const logicalName = /^[a-z][a-z0-9_]{0,127}$/;
const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Native organization-cache diagnostics are explicit observations, never generated metadata. */
export function validateDataverseAttributeErrorContexts(value, label = 'dataverseAttributeErrorContexts') {
  templateDataRecord(value, label);
  const names = Reflect.ownKeys(value);
  if (!names.length || names.length > 1000) throw Error(`${label} requires 1..1000 entity contexts`);
  const result = Object.create(null);
  for (const name of names) {
    if (typeof name !== 'string' || !logicalName.test(name)) throw Error(`${label} has an invalid entity name`);
    const context = value[name];
    templateDataRecord(context, `${label}.${name}`);
    if (Reflect.ownKeys(context).some((key) => !['organizationIndex', 'metadataId'].includes(key)))
      throw Error(`${label}.${name} has an unknown context key`);
    if (
      !Number.isInteger(context.organizationIndex) ||
      context.organizationIndex < 0 ||
      context.organizationIndex > 2147483647
    )
      throw Error(`${label}.${name}.organizationIndex must be an integer from 0 to 2147483647`);
    if (
      Object.hasOwn(context, 'metadataId') &&
      (typeof context.metadataId !== 'string' || !guid.test(context.metadataId))
    )
      throw Error(`${label}.${name}.metadataId must be a GUID`);
    result[name] = { organizationIndex: context.organizationIndex };
    if (context.metadataId) result[name].metadataId = context.metadataId.toLowerCase();
  }
  return result;
}

/** Resolve only the observed entity; exported metadata takes precedence over a captured fallback. */
export function dataverseAttributeErrorContext(error, observed, store) {
  if (error?.code !== 'InvalidFetchXml' || error?.details?.innerCode !== '0x80041103') return null;
  const entity = error.details.entity;
  if (typeof entity !== 'string' || !logicalName.test(entity) || !error.details.attribute) return null;
  const contexts = observed?.dataverseAttributeErrorContexts;
  if (!contexts) return null;
  const context = validateDataverseAttributeErrorContexts(contexts)[entity];
  if (!context) return null;
  let mapping;
  try {
    mapping = store.resolveMapping(entity);
  } catch (error) {
    if (error?.code === 'UnknownEntity') return null;
    throw error;
  }
  const exported = mapping?.dataverseMetadata?.MetadataId ?? mapping?.dataverseMetadata?.metadataId;
  const metadataId = exported ?? context.metadataId;
  if (typeof metadataId !== 'string' || !guid.test(metadataId)) return null;
  return { entity, organizationIndex: context.organizationIndex, metadataId: metadataId.toLowerCase() };
}
