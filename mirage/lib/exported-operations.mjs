import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DataError } from './data.mjs';
import { parseSolutionXml, descendants } from './solution-xml.mjs';

const canonical = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const failure = (message, status = 501, code = 'LocalOperationUnsupported') => new DataError(message, status, code);

/** Registrations are functions in explicitly trusted, matching project packs. */
export function operationHandlers(packs = []) {
  const result = { serverLogics: new Map(), cloudFlows: new Map() };
  for (const pack of packs) for (const kind of Object.keys(result)) {
    const entries = pack[kind];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`Data pack ${pack.id}: ${kind} must map exported names to functions`);
    for (const [name, handler] of Object.entries(entries)) {
      if (!name.trim() || typeof handler !== 'function') throw new Error(`Data pack ${pack.id}: invalid ${kind} handler`);
      const key = name.toLowerCase();
      if (result[kind].has(key)) throw new Error(`Ambiguous ${kind} registration for ${name}`);
      result[kind].set(key, handler);
    }
  }
  return result;
}

export function assertOperationRole(record, identity) {
  const allowed = (record.roleIds ?? []).map(canonical);
  const held = (identity?.roleIds ?? []).map(canonical);
  if (!allowed.length || !allowed.some(id => held.includes(id))) throw failure('The current web roles cannot execute this operation.', 403, 'Forbidden');
}

/** Execute an explicitly registered export against local data with bounded CPU and lifetime. */
export async function runExportedServerLogic({ record, portal, store, identity, method = 'GET', operation, body = '', input = '', query = {}, timeout = 2000 }) {
  if (!record?.file) throw failure('The exported server-logic code file is missing.');
  if (await fs.realpath(record.file) !== record.file) throw failure('The exported server-logic file changed outside its imported source path.');
  if ((await fs.stat(record.file)).size > 1024 * 1024) throw failure('The exported server-logic code exceeds the local limit.');
  const code = await fs.readFile(record.file, 'utf8');
  const bound = Math.max(100, Math.min(Number(timeout) || 2000, 5000));
  const settings = Object.fromEntries(Object.entries(portal.settings ?? {}).map(([name, value]) => [name, value?.value ?? value]));
  const context = { ActivityId: randomUUID(), Body: body, FunctionName: operation ?? method.toLowerCase(), HttpMethod: method, Input: input, QueryParameters: query, ServerLogicName: record.name, Headers: {}, Url: `/_api/serverlogics/${encodeURIComponent(record.name)}` };
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./exported-operation-worker.mjs', import.meta.url), { workerData: { code, operation: context.FunctionName, context, user: identity ?? null, website: { Id: portal.website?.id, Name: portal.website?.name }, settings, timeout: bound }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
    let complete = false;
    const finish = (error, value) => {
      if (complete) return;
      complete = true; clearTimeout(timer); worker.terminate().catch(() => {});
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(failure('Server-logic execution exceeded its local time limit.', 504, 'LocalOperationTimeout')), bound + 300);
    worker.on('error', error => finish(failure(error.message)));
    worker.on('exit', code => { if (!complete) finish(failure(`Server-logic worker stopped before returning a result (${code}).`)); });
    worker.on('message', message => {
      if (message.kind === 'result') return finish(null, message.raw);
      if (message.kind === 'failure') return finish(failure(message.message));
      if (!['query', 'get'].includes(message.kind)) return;
      const flags = new Int32Array(message.control);
      let answer;
      try {
        const params = new URLSearchParams(String(message.options ?? '').replace(/^\?/, ''));
        const data = message.kind === 'query'
          ? store.query(message.entitySet, params, identity, undefined, { dialect: 'dataverse' })
          : store.get(message.entitySet, message.id, identity);
        answer = { value: { StatusCode: data ? 200 : 404, Body: JSON.stringify(data ?? {}), IsSuccessStatusCode: Boolean(data), ReasonPhrase: data ? 'OK' : 'Not Found', ServerError: false, ServerErrorMessage: null, Headers: {} } };
      } catch (error) {
        answer = { value: { StatusCode: error.status ?? 500, Body: '{}', IsSuccessStatusCode: false, ReasonPhrase: error.message, ServerError: true, ServerErrorMessage: error.message, Headers: {} } };
      }
      let bytes = Buffer.from(JSON.stringify(answer));
      if (bytes.length > message.bytes.byteLength) bytes = Buffer.from(JSON.stringify({ error: 'Local Dataverse result exceeds the limit' }));
      new Uint8Array(message.bytes).set(bytes); flags[1] = bytes.length; Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
    });
  });
}

/** Read only workflow JSON paired with its exported WorkflowId in selected layers. */
export async function importOperationWorkflows(layers = []) {
  const result = new Map();
  for (const layer of layers) {
    if (!layer.dir) continue;
    const directory = path.join(layer.dir, 'Workflows');
    const root = await fs.realpath(directory).catch(() => null);
    if (!root) continue;
    for (const name of await fs.readdir(root)) {
      if (!/\.json\.data\.xml$/i.test(name)) continue;
      const files = [path.join(root, name), path.join(root, name.replace(/\.data\.xml$/i, ''))];
      const contained = await Promise.all(files.map(async file => {
        const real = await fs.realpath(file).catch(() => null);
        if (!real || path.dirname(real) !== root || (await fs.stat(real)).size > 1024 * 1024) return null;
        return fs.readFile(real, 'utf8');
      }));
      if (contained.some(value => value === null)) continue;
      const xml = parseSolutionXml(contained[0]);
      const id = canonical(xml.attrs.WorkflowId ?? descendants(xml, 'Workflow')[0]?.attrs.WorkflowId);
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      result.set(id, { file: files[1], definition: JSON.parse(contained[1]) });
    }
  }
  return result;
}

/** Deliberately small declarative interpreter. Unknown actions are rejected before any work. */
export function runExportedCloudFlow({ record, workflows, input }) {
  const workflow = workflows.get(canonical(record.processId));
  if (!workflow) throw failure('This cloud flow has no JSON definition in the selected solution sources.');
  const definition = workflow.definition.properties?.definition ?? workflow.definition.definition;
  const triggers = Object.values(definition?.triggers ?? {});
  const actions = Object.values(definition?.actions ?? {});
  if (triggers.length !== 1 || triggers[0].type !== 'Request' || triggers[0].kind !== 'powerpages' || actions.length !== 1 || actions[0].type !== 'Response' || actions[0].kind !== 'powerpages') throw failure('This local cloud-flow adapter supports a Power Pages Request and one Response only. Register a project handler for other actions.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('The cloud-flow input must be an object.', 400, 'InvalidRequest');
  const schema = triggers[0].inputs?.schema ?? {};
  for (const name of schema.required ?? []) if (input[name] == null) throw failure(`Cloud-flow input ${name} is required.`, 400, 'InvalidRequest');
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (input[name] == null) continue;
    if (['string', 'boolean', 'number', 'integer'].includes(property.type) && (typeof input[name] !== (property.type === 'integer' ? 'number' : property.type) || property.type === 'integer' && !Number.isInteger(input[name]))) throw failure(`Cloud-flow input ${name} has an invalid type.`, 400, 'InvalidRequest');
  }
  const resolve = value => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
    if (typeof value === 'string' && value.startsWith('@')) {
      const match = /^@triggerBody\(\)\?\['([^']+)'\]$/.exec(value);
      if (!match) throw failure('The response uses an unsupported local flow expression.');
      return input[match[1]] ?? null;
    }
    return value;
  };
  const status = Number(actions[0].inputs?.statusCode ?? 200);
  if (!Number.isInteger(status) || status < 200 || status > 599) throw failure('The flow response status is invalid.');
  return { status, body: resolve(actions[0].inputs?.body ?? {}) };
}
