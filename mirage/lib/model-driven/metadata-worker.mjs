import { parentPort } from 'node:worker_threads';
import { compileTable } from './catalogue.mjs';
import { encodeModelDrivenProvenance } from './provenance-transport.mjs';
import { stringifyExactJson } from '../exact-numeric.mjs';

// A response sends its immutable global source identity once ({ context }), then
// one table at a time; { context: null } releases it before the thread idles. No
// business dataset, principal, token or runtime store enters this worker.
let context = null;
parentPort.on('message', (message) => {
  if (Object.hasOwn(message, 'context')) {
    context = message.context;
    return;
  }
  const { name, input, capabilities, wire } = message;
  try {
    const { rows: _rows, ...table } = compileTable(input, context, name);
    const projected = { ...table, capabilities };
    const encoded = new TextEncoder().encode(
      stringifyExactJson(wire ? encodeModelDrivenProvenance(projected) : projected),
    );
    parentPort.postMessage({ bytes: encoded.buffer }, [encoded.buffer]);
  } catch (error) {
    parentPort.postMessage({ error: { message: error.message, stack: error.stack } });
  }
});
