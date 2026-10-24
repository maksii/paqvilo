import fs from 'node:fs/promises';
import { modernFlowWorkflows } from './flow-yaml.mjs';
import { readLocalFile, readLocalFileSync } from '../../lense/local-file.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DataError } from './data.mjs';
import { parseSolutionXml, descendants, childText } from './solution-xml.mjs';
import { executeFlowDefinition, runTrackedFlow } from './flow-runtime.mjs';
import { flowRunsOf } from './flow-runs.mjs';
import { validateServiceProfile } from './local-organization-service.mjs';
import { parseExactJson, stringifyExactJson } from './exact-numeric.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { solutionLayerFiles } from './solution-content-fingerprint.mjs';
import { environmentVariablePayload } from './secret-resolver.mjs';
import { isLoopbackUrl, loopbackFetch } from './dataverse-webhooks.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { siteSetting } from './redirects.mjs';
import { portalRecordWrites } from './form-service.mjs';
// URL rewrites (longest prefix wins), applied before the loopback check: the connector runtime's one rule.
import { rewrite as rewritten } from './connector-runtime.mjs';

const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const failure = (message, status = 501, code = 'LocalOperationUnsupported') => new DataError(message, status, code);

/** Registrations are functions in explicitly trusted, matching project packs. */
export function operationHandlers(packs = []) {
  const handlers = (kind) => new Map([...collectPackExport(packs, kind)].map(([key, { value }]) => [key, value]));
  const result = {
    serverLogics: handlers('serverLogics'),
    cloudFlows: handlers('cloudFlows'),
    flowIdentities: handlers('flowIdentities'),
  };
  for (const profile of result.flowIdentities.values()) validateServiceProfile(profile);
  return result;
}

export function assertOperationRole(record, identity) {
  const allowed = (record.roleIds ?? []).map(canonical);
  const held = (identity?.roleIds ?? []).map(canonical);
  if (!allowed.length || !allowed.some((id) => held.includes(id)))
    throw failure('The current web roles cannot execute this operation.', 403, 'Forbidden');
}

// Reason phrases of the server-object response envelope.
const REASONS = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  501: 'Not Implemented',
  502: 'Bad Gateway',
};
const envelope = (status, body = '', headers = {}, serverError = null) => ({
  StatusCode: status,
  Body: body == null ? '' : typeof body === 'string' ? body : stringifyExactJson(body),
  IsSuccessStatusCode: status >= 200 && status < 300,
  ReasonPhrase: serverError ?? REASONS[status] ?? String(status),
  ServerError: Boolean(serverError),
  ServerErrorMessage: serverError,
  Headers: headers ?? {},
});
const settingOf = (portal, name) => siteSetting(portal ?? {}, name);
const settingFlag = (value, fallback) =>
  value == null || String(value).trim() === '' ? fallback : /^(?:true|1)$/i.test(String(value).trim());

/** ServerLogic/Enabled (default true): false refuses every server-logic call with ServerLogicDisabled and reports SERVER_LOGIC_DISABLED. */
export function assertServerLogicEnabled(portal, diagnostic = () => {}) {
  if (settingFlag(settingOf(portal, 'ServerLogic/Enabled'), true)) return;
  diagnostic({
    code: 'SERVER_LOGIC_DISABLED',
    severity: 'warning',
    message: 'ServerLogic/Enabled is false: server logic is turned off for this site.',
  });
  // Native status for a site with ServerLogic/Enabled false is not known; 403 ServerLogicDisabled is a guess.
  throw failure('Server logic is disabled for this site (ServerLogic/Enabled).', 403, 'ServerLogicDisabled');
}

/** Whether HttpClient may call `host` (the original host, before any local rewrite): ServerLogic/AllowNetworkingToAllDomains (default
 * true) and ServerLogic/AllowedDomains (comma or semicolon separated; a domain also allows its subdomains). */
function serverLogicDomainAllowed(portal, host) {
  const domains = String(settingOf(portal, 'ServerLogic/AllowedDomains') ?? '')
    .split(/[;,\s]+/)
    .map((item) =>
      item
        .trim()
        .toLowerCase()
        .replace(/^\*?\./, ''),
    )
    .filter(Boolean);
  const all = settingFlag(settingOf(portal, 'ServerLogic/AllowNetworkingToAllDomains'), true);
  // Native combination of AllowedDomains and AllowNetworkingToAllDomains is a guess: a configured list restricts, and networking off with no list refuses all.
  if (!domains.length) return all;
  const name = String(host ?? '').toLowerCase();
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** Capability record of the server-logic bridges (runExportedServerLogic `services`). */
export function describe() {
  return {
    name: 'serverLogic',
    version: 1,
    kind: 'host-surface',
    level: 'behaviour',
    operations: [
      { name: 'dataverse', level: 'behaviour' },
      {
        name: 'invokeCustomApi',
        level: 'behaviour',
        reason: "Runs as the portal application user; the bound row needs the caller's table-permission read.",
      },
      { name: 'cloudFlow', level: 'behaviour' },
      { name: 'logger', level: 'behaviour' },
      { name: 'environmentVariable', level: 'behaviour' },
      {
        name: 'siteSettings',
        level: 'behaviour',
        reason:
          'ServerLogic/Enabled, AllowedDomains and AllowNetworkingToAllDomains apply; TimeoutInSeconds is bounded by the local 5 s limit (SERVER_LOGIC_TIMEOUT_LOCAL).',
      },
      {
        name: 'httpClient',
        level: 'contract',
        reason: 'SERVER_LOGIC_HTTP_REFUSED: only hosts rewritten to a declared loopback service are reached.',
      },
    ],
    requires: [],
    principal: 'portal-application-user',
    stateOwner: 'none',
    lifecycle: 'in-process',
  };
}
const parsePayload = (text) => {
  if (text == null || text === '') return {};
  const value = parseExactJson(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw failure('The payload must be a JSON object.', 400, 'InvalidRequest');
  return value;
};

/**
 * Execute an explicitly registered export against local data with bounded CPU and lifetime.
 * `environmentVariables` (secret-resolver.mjs environmentVariablePayload) defaults to the store's effective values.
 * `services` carries the host bridges of one RPC channel (exported-operation-worker.mjs), each optional:
 * - invokeCustomApi({ method, url, payload, identity }) -> { status, body, headers }: Dataverse.InvokeCustomApi (organizationCustomApi below);
 * - triggerFlow({ flowId, payload, identity }) -> { status, body }: CloudFlow.TriggerAsync through the portal cloud-flow pipeline
 *   (web-role check included); the payload carries siteId and userId;
 * - httpRewrites: { 'https://cloud.example.test/': 'http://127.0.0.1:7071/' } for HttpClient (contract: loopback only);
 * - log(entry) and diagnostic(entry): Logger lines and bridge diagnostics, each with the operation id (Server.Context.ActivityId).
 * A bridge without its service answers the envelope with ServerError true, never a success.
 */
export async function runExportedServerLogic({
  record,
  portal,
  store,
  identity,
  method = 'GET',
  operation,
  body = '',
  input = '',
  query = {},
  timeout = 2000,
  environmentVariables,
  services = {},
}) {
  if (!record?.file) throw failure('The exported server-logic code file is missing.');
  if ((await fs.realpath(record.file)) !== record.file)
    throw failure('The exported server-logic file changed outside its imported source path.');
  if ((await fs.stat(record.file)).size > 1024 * 1024)
    throw failure('The exported server-logic code exceeds the local limit.');
  const code = await readLocalFile(record.file, {
    root: path.dirname(record.file),
    maxBytes: 1024 * 1024,
    encoding: 'utf8',
  });
  // ServerLogic/TimeoutInSeconds (default 120, at most 240) bounds the run; the local bound (at most 5 s) is lower.
  const seconds = Math.min(Number(settingOf(portal, 'ServerLogic/TimeoutInSeconds')) || 120, 240);
  const bound = Math.max(100, Math.min(Number(timeout) || 2000, 5000, seconds * 1000));
  const settings = Object.fromEntries(
    Object.entries(portal.settings ?? {}).map(([name, value]) => [name, value?.value ?? value]),
  );
  const variables = environmentVariables ?? environmentVariablePayload(store?.state ?? {});
  const context = {
    ActivityId: randomUUID(),
    Body: body,
    FunctionName: operation ?? (method === 'DELETE' ? 'del' : method.toLowerCase()),
    HttpMethod: method,
    Input: input,
    QueryParameters: query,
    ServerLogicName: record.name,
    Headers: {},
    Url: `/_api/serverlogics/${encodeURIComponent(record.name)}`,
  };
  const note = (entry) =>
    (services.diagnostic ?? (() => {}))({ serverLogic: record.name, operationId: context.ActivityId, ...entry });
  if (settingOf(portal, 'ServerLogic/TimeoutInSeconds') != null && seconds * 1000 > bound)
    note({
      code: 'SERVER_LOGIC_TIMEOUT_LOCAL',
      severity: 'info',
      message: `ServerLogic/TimeoutInSeconds is ${seconds} s; the local run is bounded at ${bound} ms.`,
    });
  const unavailable = (bridge, code) => {
    note({ code, severity: 'warning', message: `${bridge} has no local service in this host.` });
    return envelope(501, '', {}, `${bridge} is not available in this local host.`);
  };
  const bridges = {
    async customApi(message) {
      if (!services.invokeCustomApi)
        return unavailable('Dataverse.InvokeCustomApi', 'SERVER_LOGIC_CUSTOM_API_UNAVAILABLE');
      const answer = await services.invokeCustomApi({
        method: message.method,
        url: message.url,
        payload: message.payload == null || message.payload === '' ? null : parsePayload(message.payload),
        identity,
      });
      return envelope(answer.status, answer.body ?? '', answer.headers);
    },
    async flow(message) {
      if (!services.triggerFlow) return unavailable('CloudFlow.TriggerAsync', 'SERVER_LOGIC_FLOW_UNAVAILABLE');
      // The platform adds siteId, siteUrl and userId to the payload; their native casing is a guess and siteUrl is not known here.
      const payload = {
        ...parsePayload(message.payload),
        siteId: portal.website?.id ?? null,
        userId: identity?.contactId ?? identity?.id ?? null,
      };
      const answer = await services.triggerFlow({ flowId: canonical(message.flowId), payload, identity });
      // A flow without a Response action answers 202 Accepted with an empty Body, reported as success.
      return envelope(answer.status ?? 200, answer.status === 202 ? '' : (answer.body ?? ''), answer.headers);
    },
    async http(message) {
      // The site's domain settings apply to the original host, before any local rewrite.
      let original = null;
      try {
        original = new URL(message.url).hostname;
      } catch {
        /* An invalid URL has no allowed original host and is rejected below. */
      }
      if (!serverLogicDomainAllowed(portal, original)) {
        note({
          code: 'SERVER_LOGIC_HTTP_DOMAIN_BLOCKED',
          severity: 'warning',
          host: original,
          message:
            'HttpClient target is outside ServerLogic/AllowedDomains (or ServerLogic/AllowNetworkingToAllDomains is false).',
        });
        // A blocked outbound call answers 403 Forbidden (documented for disabled external calls, assumed for AllowedDomains).
        return envelope(403, '', {}, 'HTTP target domain is not allowed for server logic');
      }
      // Contract: every outbound call goes through loopbackFetch; a cloud host must be rewritten to a declared local service.
      const target = rewritten(message.url, services.httpRewrites);
      if (!isLoopbackUrl(target)) {
        note({
          code: 'SERVER_LOGIC_HTTP_REFUSED',
          severity: 'warning',
          host: original,
          message: 'HttpClient target is not a declared local service; declare a connection rewrite to a loopback URL.',
        });
        return envelope(502, '', {}, 'HTTP target is not a declared local service');
      }
      const headers = Object.fromEntries(
        Object.entries(message.headers ?? {})
          .filter(([name]) => !/^content-?type$/i.test(name))
          .map(([name, value]) => [name, String(value)]),
      );
      if (message.contentType) headers['content-type'] = message.contentType;
      const response = await loopbackFetch(target, {
        method: message.method,
        headers,
        body: message.body ?? undefined,
        signal: AbortSignal.timeout(bound),
      });
      return envelope(response.status, await response.text(), Object.fromEntries(response.headers));
    },
  };
  return new Promise((resolve, reject) => {
    const user =
      identity?.id || identity?.contactId
        ? { ...identity, contactid: identity.contactId ?? identity.id, fullname: identity.name ?? null }
        : null;
    const worker = new Worker(new URL('./exported-operation-worker.mjs', import.meta.url), {
      workerData: {
        code,
        operation: context.FunctionName,
        context,
        user,
        website: { ...portal.website, Id: portal.website?.id, Name: portal.website?.name },
        settings,
        environmentVariables: variables,
        timeout: bound,
      },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    let complete = false;
    const finish = (error, value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      error ? reject(error) : resolve(value);
    };
    const reply = (message, answer) => {
      const flags = new Int32Array(message.control);
      let bytes = Buffer.from(JSON.stringify(answer));
      if (bytes.length > message.bytes.byteLength)
        bytes = Buffer.from(JSON.stringify({ error: 'Local result exceeds the limit' }));
      new Uint8Array(message.bytes).set(bytes);
      flags[1] = bytes.length;
      Atomics.store(flags, 0, 1);
      Atomics.notify(flags, 0);
    };
    // Cold worker bootstrap is host scheduling, not exported-code execution. Keep it
    // bounded separately so a loaded machine cannot consume the VM/RPC budget first.
    let timer = setTimeout(
      () =>
        finish(
          failure(
            'Server-logic worker did not become ready before its startup limit.',
            504,
            'LocalOperationStartupTimeout',
          ),
        ),
      30_000,
    );
    worker.on('error', (error) => finish(failure(error.message)));
    worker.on('exit', (code) => {
      if (!complete) finish(failure(`Server-logic worker stopped before returning a result (${code}).`));
    });
    worker.on('message', async (message) => {
      if (complete) return;
      if (message.kind === 'ready') {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(failure('Server-logic execution exceeded its local time limit.', 504, 'LocalOperationTimeout')),
          bound + 300,
        );
        return;
      }
      if (message.kind === 'result') return finish(null, message.raw);
      if (message.kind === 'failure') return finish(failure(message.message));
      if (message.kind === 'log')
        return (services.log ?? (() => {}))({
          serverLogic: record.name,
          operationId: context.ActivityId,
          level: message.level,
          message: message.message,
        });
      if (message.kind === 'diagnostic') return note({ code: message.code, message: message.message });
      if (bridges[message.kind]) {
        let answer;
        try {
          answer = { value: await bridges[message.kind](message) };
        } catch (error) {
          answer = { value: envelope(error.status ?? 500, '', {}, error.message) };
        }
        return reply(message, answer);
      }
      if (!['query', 'get', 'create', 'update', 'delete'].includes(message.kind)) return;
      let answer;
      try {
        const params = new URLSearchParams(String(message.options ?? '').replace(/^\?/, ''));
        let data,
          status = 200;
        if (message.kind === 'query')
          data = store.query(message.entitySet, params, identity, undefined, { dialect: 'dataverse' });
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
          if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
            throw failure('Local server-logic mutations require a verified write request.', 403, 'Forbidden');
          let payload;
          if (message.kind !== 'delete') {
            payload = parseExactJson(message.payload);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload))
              throw failure('The Dataverse payload must be a JSON object.', 400, 'InvalidRequest');
          }
          // The one portal write path (form-service.mjs portalRecordWrites): table permissions, the record pipeline and, under
          // enhanced authorization, the visitor's mapped user and column security.
          const writes = portalRecordWrites(store),
            write = (fn) => store.transact(fn, { incremental: true });
          if (message.kind === 'create') {
            data = await write(() => writes.create(message.entitySet, payload, identity));
            status = 201;
          }
          if (message.kind === 'update') {
            await write(() => writes.update(message.entitySet, message.id, payload, identity));
            status = 204;
          }
          if (message.kind === 'delete') {
            await write(() => writes.remove(message.entitySet, message.id, identity));
            status = 204;
          }
        }
        if (['query', 'get'].includes(message.kind) && !data) status = 404;
        answer = {
          value: {
            StatusCode: status,
            Body: data === undefined ? '' : stringifyExactJson(data),
            IsSuccessStatusCode: status < 400,
            ReasonPhrase:
              status === 404 ? 'Not Found' : status === 204 ? 'No Content' : status === 201 ? 'Created' : 'OK',
            ServerError: false,
            ServerErrorMessage: null,
            Headers: {},
          },
        };
      } catch (error) {
        answer = {
          value: {
            StatusCode: error.status ?? 500,
            Body: '{}',
            IsSuccessStatusCode: false,
            ReasonPhrase: error.message,
            ServerError: true,
            ServerErrorMessage: error.message,
            Headers: {},
          },
        };
      }
      reply(message, answer);
    });
  });
}

/**
 * Dataverse.InvokeCustomApi(httpMethod, url, payload) through the organization:
 * `url` is an unbound `name`, or `set(id)/Microsoft.Dynamics.CRM.name` / `set/Microsoft.Dynamics.CRM.name` for bound
 * operations; a function takes inline literal parameters, `name(P1='text',P2=5)`. The operation runs through the
 * organization's operation registry as `principal` (a systemuserid, or a function answering one: the host passes the portal
 * application user, never SYSTEM). A bound row must be readable by the portal `identity` under its table permissions
 * (store.allowed). Answers { status, body, headers } and never throws for a Dataverse error.
 * ponytail: inline literal function parameters only (no @alias parameters).
 */
export function organizationCustomApi(organization, { principal, origin = 'http://localhost' } = {}) {
  return async ({ method, url, payload, identity }) =>
    invokeOrganizationOperation(organization, {
      method,
      url,
      payload,
      identity,
      principal: typeof principal === 'function' ? await principal() : principal,
      origin,
    });
}

async function invokeOrganizationOperation(organization, { method, url, payload, identity, principal, origin }) {
  const verb = String(method ?? '').toUpperCase();
  const path = String(url ?? '')
    .replace(/^\/+/, '')
    .replace(/^api\/data\/v\d+(?:\.\d+)?\//i, '');
  const match =
    /^(?:([A-Za-z_]\w*)(?:\(([^)]*)\))?\/)?(?:Microsoft\.Dynamics\.CRM\.)?([A-Za-z_]\w*)(?:\((.*)\))?$/.exec(path);
  const error = (status, message) => ({ status, body: { error: { code: '0x80060888', message } }, headers: {} });
  if (!match || !['GET', 'POST'].includes(verb))
    return error(404, `No HTTP resource was found that matches the request URI '${url}'.`);
  const [, set, key, name, inline] = match;
  const params = {};
  for (const part of String(inline ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const pair = /^([A-Za-z_]\w*)=(?:'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|(true|false|null))$/.exec(part);
    if (!pair) return error(400, `The function parameter '${part}' is not a literal parameter.`);
    params[pair[1]] =
      pair[2] !== undefined
        ? pair[2].replace(/''/g, "'")
        : pair[3] !== undefined
          ? Number(pair[3])
          : pair[4] === 'null'
            ? null
            : pair[4] === 'true';
  }
  const store = organization.store;
  let mapping = null,
    target = null;
  if (set) {
    try {
      mapping = store.resolveMapping(set);
    } catch {
      return error(404, `Resource not found for the segment '${set}'.`);
    }
    const id = key == null ? null : String(key).replace(/^'|'$/g, '');
    target = {
      mapping,
      id,
      row: id
        ? (store.tableRows(mapping.logicalName).find((row) => canonical(row[mapping.idColumn]) === canonical(id)) ??
          null)
        : null,
    };
    if (id && !target.row) return error(404, `${mapping.logicalName} With Id = ${id} Does Not Exist`);
    // Table permissions govern what server logic reaches; the native status and code of a denial are a guess.
    if (target.row && !store.allowed(mapping.logicalName, 'read', target.row, identity ?? {}))
      return {
        status: 403,
        body: {
          error: { code: 'Forbidden', message: `The current portal user cannot read ${mapping.logicalName} ${id}.` },
        },
        headers: {},
      };
  }
  const binding = !set ? 'unbound' : key == null ? 'collection' : 'entity';
  const operation = organization.registry.find({
    name,
    kind: verb === 'GET' ? 'function' : 'action',
    binding,
    entity: mapping?.logicalName,
  });
  if (!operation) return error(404, `Resource not found for the segment '${name}'.`);
  try {
    // The Web API operation call (dataverse-api.mjs runOperation) for the principal's systemuser row.
    const user = store.tableRows('systemuser').find((row) => canonical(row.systemuserid) === canonical(principal));
    const principalContext = organizationPrincipalContext(store, user);
    const c = {
      method: verb,
      url: new URL(path, `${origin}/api/data/v9.2/`),
      route: { version: 'v9.2' },
      params,
      body: verb === 'POST' ? (payload ?? {}) : undefined,
      user: principalContext.user,
      caller: principalContext.caller,
      identity: principalContext.identity,
      origin,
      version: 'v9.2',
      target,
      prefer: {},
      headers: {},
      requestId: randomUUID(),
      api: organization.api,
    };
    const answer = await operation.handle(c);
    return { status: answer?.status ?? 200, body: answer?.body ?? '', headers: answer?.headers ?? {} };
  } catch (cause) {
    return {
      status: cause.status ?? 500,
      body: { error: { code: cause.innerCode ?? cause.code ?? '0x80040216', message: cause.message } },
      headers: {},
    };
  }
}

/**
 * Read only workflow JSON paired with its exported WorkflowId in selected layers. The Workflows folder matches without case,
 * in a directory or a Solution ZIP layer (solutionLayerFiles); a file above 1 MiB or an unreadable layer is skipped.
 */
export async function importOperationWorkflows(layers = []) {
  const result = new Map(),
    limit = 1024 * 1024;
  for (const layer of layers) {
    if (!layer.dir) continue;
    // A YAML repository layer: its modernflows/ cloud flows normalise into the same entries (flow-yaml.mjs); a file that does
    // not parse is reported by its inventory record (MODERNFLOW_YAML_INVALID).
    if (layer.format === 'yaml')
      for (const [id, entry] of modernFlowWorkflows(layer.files ?? [], (file) => {
        try {
          return readLocalFileSync(file.path, { root: layer.dir, maxBytes: limit, encoding: 'utf8' });
        } catch {
          return null;
        }
      }))
        result.set(id, entry);
    let entries;
    try {
      entries = solutionLayerFiles(layer, /^workflows$/i).filter((file) => /^[^/]+\/[^/]+$/.test(file.name));
    } catch {
      continue;
    }
    const byName = new Map(entries.map((file) => [file.name.slice(file.name.indexOf('/') + 1).toLowerCase(), file]));
    for (const entry of entries) {
      const name = entry.name.slice(entry.name.indexOf('/') + 1);
      if (!/\.json\.data\.xml$/i.test(name)) continue;
      const pair = [entry, byName.get(name.replace(/\.data\.xml$/i, '').toLowerCase())];
      const files = pair.map((file) => file && path.join(layer.dir, ...file.name.split('/')));
      const contained = pair.map((file) => {
        try {
          return file ? file.read(limit).toString('utf8') : null;
        } catch {
          return null;
        }
      });
      if (contained.some((value) => value === null)) continue;
      const xml = parseSolutionXml(contained[0]);
      const id = canonical(xml.attrs.WorkflowId ?? descendants(xml, 'Workflow')[0]?.attrs.WorkflowId);
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const node = descendants(xml, 'Workflow')[0] ?? xml,
        state =
          childText(node, 'StateCode') ??
          childText(node, 'statecode') ??
          node.attrs.StateCode ??
          node.attrs.statecode ??
          null;
      const active = state === null ? null : ['1', 'activated'].includes(String(state).toLowerCase());
      result.set(id, {
        file: files[1],
        name: xml.attrs.Name ?? node.attrs.Name ?? null,
        active,
        activation: { sourceValue: state, sourceFile: files[0] },
        definition: parseExactJson(contained[1]),
      });
    }
  }
  return result;
}

/** Deliberately small declarative interpreter. Unknown actions are rejected before any work.
 * `serviceProfile` (pack flowIdentities[processId]) overrides a connection principal; `connectors` routes connector actions.
 * Synchronous while every provider answers synchronously, otherwise a Promise: always await it.
 * With the organization's run store (flow-runs.mjs flowRunsOf) the request is a tracked flowrun; a run that waits before its
 * Response answers 202 { runId, status: 'Waiting' }, and resumes through /_sim/api/flow-waits or its wait timer. */
export function runExportedCloudFlow({
  record,
  workflows,
  input,
  store,
  serviceProfile,
  steps,
  diagnostic,
  connectors,
  context,
}) {
  const workflow = workflows.get(canonical(record.processId));
  if (!workflow) throw failure('This cloud flow has no JSON definition in the selected solution sources.');
  const definition = workflow.definition.properties?.definition ?? workflow.definition.definition;
  const args = {
    definition,
    input,
    store,
    serviceProfile,
    steps,
    diagnostic,
    connectors,
    connectionReferences: workflow.definition.properties?.connectionReferences,
    context,
  };
  const runs = flowRunsOf(store);
  if (!runs) return executeFlowDefinition(args);
  // The native answer of a Power Pages flow request whose run waits before its Response is a guess (natively the request
  // waits for the Response until the portal times out), as is the flowrun triggertype text.
  return runTrackedFlow({ runs, processId: record.processId, trigger: 'PowerPages', ...args }).then((answer) =>
    answer?.status === 'Waiting'
      ? (answer.response ?? { status: 202, body: { runId: answer.runId, status: 'Waiting' } })
      : answer,
  );
}
