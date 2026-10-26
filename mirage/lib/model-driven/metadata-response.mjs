import { stringifyExactJson } from '../exact-numeric.mjs';

/** Preserve the complete metadata JSON contract, encoding one table at a time.
 * No source, form, control or capability is omitted to make a response smaller. */
export function* metadataResponseChunks(catalogue) {
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
      for (const [name, table] of Object.entries(value)) {
        const encoded = stringifyExactJson(table);
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
