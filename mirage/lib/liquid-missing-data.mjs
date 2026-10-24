import { parseXmlDocument } from './fetchxml-engine.mjs';

const enabled = (observed) => observed?.liquidMissingData === 'empty';
const unknownEntity = (error) => error?.code === 'UnknownEntity' && error?.infrastructure !== true;

/** Only an unmapped root table receives the observed empty result; providers are not called here. */
export function emptyUnmappedLiquidFetchXml(xml, { observed, resolveMapping }) {
  if (!enabled(observed)) return null;
  const fetch = parseXmlDocument(xml, { root: 'fetch' });
  if (fetch.children.length !== 1 || fetch.children[0].name !== 'entity') return null;
  const entity = fetch.children[0].attrs.name;
  if (!entity) return null;
  try {
    resolveMapping(entity);
  } catch (error) {
    if (!unknownEntity(error)) throw error;
    // Qualified absence probes establish these flags; they do not prove successful query execution.
    return {
      entities: [],
      more_records: false,
      entity_name: entity,
      xml,
      permission_granted: false,
      global_permission_granted: false,
      rules_exist: true,
      total_record_count: 0,
    };
  }
  return null;
}

/** An absent mapping is nil only in the explicitly observed mode; all other failures propagate. */
export async function observedLiquidEntityRead(read, observed) {
  try {
    return await read();
  } catch (error) {
    if (enabled(observed) && unknownEntity(error)) return null;
    throw error;
  }
}
