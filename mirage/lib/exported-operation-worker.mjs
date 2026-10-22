import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

// This is an execution boundary for explicitly trusted project code, not a
// security sandbox for arbitrary downloads. The parent terminates the worker.
// One RPC channel (Atomics.wait over a SharedArrayBuffer) carries every bridge to the parent
// (exported-operations.mjs runExportedServerLogic): Dataverse CRUD, custom APIs, cloud flows and HTTP.
const rpc = (kind, args) => {
  const bytes = new SharedArrayBuffer(1024 * 1024);
  const control = new SharedArrayBuffer(8);
  const flags = new Int32Array(control);
  parentPort.postMessage({ kind, ...args, bytes, control });
  if (Atomics.wait(flags, 0, 0, workerData.timeout) === 'timed-out') throw new Error(`Local ${kind} operation timed out`);
  const answer = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 0, flags[1])));
  if (answer.error) throw new Error(answer.error);
  return JSON.stringify(answer.value);
};
const connectorCall = (kind, entitySet, id, options, payload) => rpc(kind, { entitySet, id, options, payload });
const text = value => (value == null ? null : typeof value === 'string' ? value : JSON.stringify(value));
const connector = {
  RetrieveMultipleRecords: (entitySet, options = '') => connectorCall('query', entitySet, null, options),
  RetrieveRecord: (entitySet, id, options = '') => connectorCall('get', entitySet, id, options),
  CreateRecord: (entitySet, payload) => connectorCall('create', entitySet, null, '', payload),
  UpdateRecord: (entitySet, id, payload) => connectorCall('update', entitySet, id, '', payload),
  DeleteRecord: (entitySet, id) => connectorCall('delete', entitySet, id),
  InvokeCustomApi: (httpMethod, url, payload = null) => rpc('customApi', { method: String(httpMethod ?? ''), url: String(url ?? ''), payload: text(payload) }),
};
// Learn (server objects): HttpClient methods and CloudFlow.TriggerAsync are asynchronous and answer the response envelope.
const http = method => (url, ...rest) => {
  const [body, headers, contentType] = ['GET', 'DELETE'].includes(method) ? [null, rest[0], null] : rest;
  return Promise.resolve().then(() => rpc('http', { method, url: String(url ?? ''), body: text(body), headers: headers ?? {}, contentType: contentType ?? null }));
};
const HttpClient = { GetAsync: http('GET'), PostAsync: http('POST'), PutAsync: http('PUT'), PatchAsync: http('PATCH'), DeleteAsync: http('DELETE') };
const CloudFlow = { TriggerAsync: (flowId, payload = null) => Promise.resolve().then(() => rpc('flow', { flowId: String(flowId ?? ''), payload: text(payload) })) };
const log = level => (...values) => parentPort.postMessage({ kind: 'log', level, message: values.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ').slice(0, 4000) });
const siteSettings = workerData.settings;
// workerData.environmentVariables (secret-resolver.mjs environmentVariablePayload): lower-case schema name → text, or
// { secret: true }. Secret types are never handed to server logic: Power Pages routes them through bound site settings.
const environmentVariables = workerData.environmentVariables ?? {};
const environmentVariable = (name) => {
  const key = String(name ?? '').toLowerCase();
  // Own keys only: 'constructor' or '__proto__' must not reach Object.prototype.
  const value = Object.hasOwn(environmentVariables, key) ? environmentVariables[key] : null;
  if (value !== null && typeof value === 'object') {
    parentPort.postMessage({ kind: 'diagnostic', code: 'SECRET_NOT_EXPOSED_TO_SERVER_LOGIC', message: `Secret environment variable ${String(name).slice(0, 200)} is not exposed to server logic; bind it to a site setting.` });
    return null;
  }
  return value ?? null;
};
const Server = {
  Context: workerData.context,
  User: workerData.user,
  Website: workerData.website,
  SiteSetting: { Get: name => (siteSettings && Object.hasOwn(siteSettings, name) ? siteSettings[name] : null) ?? null },
  EnvironmentVariable: { get: environmentVariable, Get: environmentVariable },
  Connector: { Dataverse: connector, HttpClient, CloudFlow },
  Logger: { Log: log('Log'), Info: log('Log'), Warn: log('Warn'), Error: log('Error') },
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
