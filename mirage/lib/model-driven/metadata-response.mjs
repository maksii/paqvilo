import { stringifyExactJson } from '../exact-numeric.mjs';

/** Preserve the complete metadata JSON contract, encoding one table at a time.
 * No source, form, control or capability is omitted to make a response smaller. */
export function* metadataResponseChunks(catalogue, { tableChunk } = {}) {
  yield '{';
  let first = true;
  for (const [key, value] of Object.entries(catalogue)) {
    if (key !== 'tables') {
      const encoded = stringifyExactJson(value);
      if (encoded === undefined) continue;
      yield (first ? '' : ',') + JSON.stringify(key) + ':' + encoded;
    } else {
      yield (first ? '' : ',') + '"tables":{';
      let firstTable = true;
      for (const name of Object.keys(value)) {
        if (tableChunk) {
          yield (firstTable ? '' : ',') + JSON.stringify(name) + ':';
          yield tableChunk(name);
          firstTable = false;
          continue;
        }
        const encoded = stringifyExactJson(value[name]);
        if (encoded === undefined) continue;
        yield (firstTable ? '' : ',') + JSON.stringify(name) + ':' + encoded;
        firstTable = false;
      }
      yield '}';
    }
    first = false;
  }
  yield '}';
}
