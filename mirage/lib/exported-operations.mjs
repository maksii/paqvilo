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
  const context = { ActivityId: randomUUID(), Body: body, FunctionName: operation ?? (method === 'DELETE' ? 'del' : method.toLowerCase()), HttpMethod: method, Input: input, QueryParameters: query, ServerLogicName: record.name, Headers: {}, Url: `/_api/serverlogics/${encodeURIComponent(record.name)}` };
  return new Promise((resolve, reject) => {
    const user = identity?.id || identity?.contactId ? { ...identity, contactid: identity.contactId ?? identity.id, fullname: identity.name ?? null } : null;
    const worker = new Worker(new URL('./exported-operation-worker.mjs', import.meta.url), { workerData: { code, operation: context.FunctionName, context, user, website: { ...portal.website, Id: portal.website?.id, Name: portal.website?.name }, settings, timeout: bound }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
    let complete = false;
    const finish = (error, value) => {
      if (complete) return;
      complete = true; clearTimeout(timer); worker.terminate().catch(() => {});
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(failure('Server-logic execution exceeded its local time limit.', 504, 'LocalOperationTimeout')), bound + 300);
    worker.on('error', error => finish(failure(error.message)));
    worker.on('exit', code => { if (!complete) finish(failure(`Server-logic worker stopped before returning a result (${code}).`)); });
    worker.on('message', async message => {
      if (message.kind === 'result') return finish(null, message.raw);
      if (message.kind === 'failure') return finish(failure(message.message));
      if (!['query', 'get', 'create', 'update', 'delete'].includes(message.kind)) return;
      const flags = new Int32Array(message.control);
      let answer;
      try {
        const params = new URLSearchParams(String(message.options ?? '').replace(/^\?/, ''));
        let data, status = 200;
        if (message.kind === 'query') data = store.query(message.entitySet, params, identity, undefined, { dialect: 'dataverse' });
        else if (message.kind === 'get') {
          const row = store.get(message.entitySet, message.id, identity);
          if (row && params.size) {
            const mapping = store.resolveMapping(message.entitySet);
            const requested = params.get('$filter');
            const idFilter = `${mapping.idColumn} eq '${String(message.id).replace(/'/g, "''")}'`;
            params.set('$filter', requested ? `(${requested}) and (${idFilter})` : idFilter);
            data = store.query(message.entitySet, params, identity, undefined, { dialect: 'dataverse' }).value[0];
          } else data = row;
        } else {
          if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw failure('Local server-logic mutations require a verified write request.', 403, 'Forbidden');
          let payload;
          if (message.kind !== 'delete') {
            payload = JSON.parse(message.payload);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('The Dataverse payload must be a JSON object.', 400, 'InvalidRequest');
          }
          if (message.kind === 'create') { data = await store.create(message.entitySet, payload, identity); status = 201; }
          if (message.kind === 'update') { await store.update(message.entitySet, message.id, payload, identity); status = 204; }
          if (message.kind === 'delete') { await store.remove(message.entitySet, message.id, identity); status = 204; }
        }
        if (['query', 'get'].includes(message.kind) && !data) status = 404;
        answer = { value: { StatusCode: status, Body: data === undefined ? '' : JSON.stringify(data), IsSuccessStatusCode: status < 400, ReasonPhrase: status === 404 ? 'Not Found' : status === 204 ? 'No Content' : status === 201 ? 'Created' : 'OK', ServerError: false, ServerErrorMessage: null, Headers: {} } };
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
      result.set(id, { file: files[1], name: xml.attrs.Name ?? descendants(xml, 'Workflow')[0]?.attrs.Name ?? null, definition: JSON.parse(contained[1]) });
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
  const validate = (value, schema, name = 'body', depth = 0) => {
    if (depth > 32) throw failure('The cloud-flow input schema exceeds the local nesting limit.');
    const invalid = message => { throw failure(`Cloud-flow input ${name} ${message}.`, 400, 'InvalidRequest'); };
    const types = schema.type ? [schema.type].flat() : [];
    const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? Boolean(value && typeof value === 'object' && !Array.isArray(value)) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    if (types.length && !types.some(matches)) invalid('has an invalid type');
    if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) invalid('is not an allowed value');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid(`is missing required property ${key}`);
      for (const [key, item] of Object.entries(value)) {
        if (schema.properties?.[key]) validate(item, schema.properties[key], `${name}.${key}`, depth + 1);
        else if (schema.additionalProperties === false) invalid(`contains undeclared property ${key}`);
      }
    }
    if (Array.isArray(value) && schema.items) value.forEach((item, index) => validate(item, schema.items, `${name}[${index}]`, depth + 1));
  };
  validate(input, triggers[0].inputs?.schema ?? {});
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
