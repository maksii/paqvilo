import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

// This is an execution boundary for explicitly trusted project code, not a
// security sandbox for arbitrary downloads. The parent terminates the worker.
const connectorCall = (kind, entitySet, id, options, payload) => {
  const bytes = new SharedArrayBuffer(1024 * 1024);
  const control = new SharedArrayBuffer(8);
  const flags = new Int32Array(control);
  parentPort.postMessage({ kind, entitySet, id, options, payload, bytes, control });
  if (Atomics.wait(flags, 0, 0, workerData.timeout) === 'timed-out') throw new Error('Local Dataverse operation timed out');
  const answer = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 0, flags[1])));
  if (answer.error) throw new Error(answer.error);
  return JSON.stringify(answer.value);
};
const unsupported = () => { throw new Error('This connector is not available in the local server-logic adapter. Register a project handler for external services or custom APIs.'); };
const connector = {
  RetrieveMultipleRecords: (entitySet, options = '') => connectorCall('query', entitySet, null, options),
  RetrieveRecord: (entitySet, id, options = '') => connectorCall('get', entitySet, id, options),
  CreateRecord: (entitySet, payload) => connectorCall('create', entitySet, null, '', payload),
  UpdateRecord: (entitySet, id, payload) => connectorCall('update', entitySet, id, '', payload),
  DeleteRecord: (entitySet, id) => connectorCall('delete', entitySet, id),
  InvokeCustomApi: unsupported,
};
const siteSettings = workerData.settings;
const Server = {
  Context: workerData.context,
  User: workerData.user,
  Website: workerData.website,
  SiteSetting: { Get: name => siteSettings[name] ?? null },
  Connector: { Dataverse: connector, HttpClient: new Proxy({}, { get: () => unsupported }), CloudFlow: new Proxy({}, { get: () => unsupported }) },
  Logger: { Log: () => {}, Info: () => {}, Warn: () => {}, Error: () => {} },
};
try {
  const context = vm.createContext({ Server, console: { log() {}, warn() {}, error() {} } }, { codeGeneration: { strings: false, wasm: false } });
  const name = workerData.operation;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('Invalid server-logic operation');
  new vm.Script(workerData.code, { filename: 'exported-server-logic.js' }).runInContext(context, { timeout: workerData.timeout });
  const result = await new vm.Script(`if(typeof ${name} !== 'function') throw new Error('The exported operation is not defined'); ${name}();`).runInContext(context, { timeout: workerData.timeout });
  const raw = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Server-logic result exceeds the local limit');
  parentPort.postMessage({ kind: 'result', raw });
} catch (error) {
  parentPort.postMessage({ kind: 'failure', message: String(error.message).slice(0, 1000) });
}
