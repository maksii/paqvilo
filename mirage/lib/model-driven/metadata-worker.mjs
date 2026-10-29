import { parentPort, workerData } from 'node:worker_threads';
import { appCatalogue } from './catalogue.mjs';
import { encodeModelDrivenProvenance } from './provenance-transport.mjs';
import { stringifyExactJson } from '../exact-numeric.mjs';
import { gzipSync } from 'node:zlib';

// A request sends immutable global source identity once, then one table at a
// time. No business dataset, principal, token or runtime store enters this worker.
parentPort.on('message', ({ name, input, capabilities, wire, gzip }) => {
  try {
    const context = workerData;
    const compiled = appCatalogue({
      ...input,
      ...context,
      metadata: {
        ...input.metadata,
        sourceRevisions: context.sourceRevisions,
        modelDrivenRibbonDocuments: context.modelDrivenRibbonDocuments,
        modelDrivenAppActions: context.modelDrivenAppActions,
      },
    }).tables[name];
    const { rows: _rows, ...table } = compiled;
    const projected = { ...table, capabilities };
    const text = stringifyExactJson(wire ? encodeModelDrivenProvenance(projected) : projected);
    const encoded = gzip ? Uint8Array.from(gzipSync(text, { level: 1 })) : new TextEncoder().encode(text);
    parentPort.postMessage({ bytes: encoded.buffer }, [encoded.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
  }
});
