import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConnection, connectedClient, readManifest } from '../../../lense/dataverse/index.mjs';
import { id, registration, localBuild, assemblyFields, fieldDifferences } from './registration.mjs';
import { cli, isMain } from '../cli.mjs';
import { connectionHelp, defaultConnection } from '../paths.mjs';

const usage = `Usage: node examples/company-operations/plugins/deploy.mjs [--connection FILE] [--apply]

Run from the toolkit checkout. Compares the plug-in assemblies, steps, images, secure step configuration and
configuration with the live environment and lists each component as create, update (with the properties that differ)
or unchanged; --apply writes only the create and update components. A secure step configuration is written only when
it is missing: an existing one keeps its secret, and secret values are never printed or journalled. Journals stay
under the example's ignored .paqvilo/plugins.

${connectionHelp('  --connection FILE  ')}
  --apply            write the create and update components; otherwise save a read-only plan`;

const secureBind = 'sdkmessageprocessingstepsecureconfigid@odata.bind';

// The cached SDK message and table filter lookups of one deployment.
function sdkCatalog(client) {
  const messages = new Map();
  const filters = new Map();
  async function message(name) {
    if (!messages.has(name)) {
      const results = await client.list(`sdkmessages?$select=sdkmessageid,name&$filter=name eq '${name}'`);
      if (results.length !== 1) throw new Error(`Ambiguous SDK message: ${name}`);
      messages.set(name, results[0].sdkmessageid);
    }
    return messages.get(name);
  }
  async function filter(name, table) {
    const key = `${name}/${table}`;
    if (!filters.has(key)) {
      const mid = await message(name);
      const result = await client.list(
        `sdkmessagefilters?$select=sdkmessagefilterid,primaryobjecttypecode,isvisible,iscustomprocessingstepallowed&$filter=_sdkmessageid_value eq ${mid} and primaryobjecttypecode eq '${table}'`,
      );
      filters.set(
        key,
        result.filter((f) => f.iscustomprocessingstepallowed),
      );
    }
    return filters.get(key);
  }
  return { message, filter };
}

// Writes one component whose plan state is create or update: only the differing fields, so an unchanged assembly's
// content is never re-sent.
async function writeComponent(ctx, { set, primary, guid, body, existing, state, stateChanges, type, member }) {
  const { client, solution } = ctx;
  if (!existing) await client.request(set, { method: 'POST', body: { [primary]: guid, ...body }, solution });
  const patch = Object.fromEntries(
    Object.entries(body).filter(([k, v]) => existing && fieldDifferences(existing, { [k]: v }).length),
  );
  if (Object.keys(patch).length) await client.request(`${set}(${guid})`, { method: 'PATCH', body: patch, solution });
  if (stateChanges.length) await client.request(`${set}(${guid})`, { method: 'PATCH', body: state });
  if (member) return;
  await client.request('AddSolutionComponent', {
    method: 'POST',
    body: { ComponentId: guid, ComponentType: type, SolutionUniqueName: solution, AddRequiredComponents: false },
  });
  ctx.membership.add(`${type}/${guid}`);
}

// Plans one component as create, update (naming the differing properties) or unchanged and, with apply, writes it.
// `state` holds fields Dataverse sets only by a separate update after create (step state).
async function ensure(ctx, set, primary, key, body, { type, state } = {}) {
  const guid = id(key);
  const existing = await ctx.client.optional(`${set}(${guid})`);
  const stateChanges = state ? fieldDifferences(existing ?? {}, state) : [];
  const member = !type || type === 90 || type === 93 || ctx.membership.has(`${type}/${guid}`);
  const changes = existing
    ? [...fieldDifferences(existing, body), ...stateChanges, ...(member ? [] : ['solution membership'])]
    : [];
  let status = 'create';
  if (existing) status = changes.length ? 'update' : 'unchanged';
  if (ctx.apply && status !== 'unchanged')
    await writeComponent(ctx, { set, primary, guid, body, existing, state, stateChanges, type, member });
  await ctx.record({ key, id: guid, status, ...(changes.length ? { changes } : {}) });
  return guid;
}

// The plug-ins only check that a secure configuration is present, parses and carries its version label; nothing else
// holds the synthetic secret, so an existing one is kept and only a missing one is written. The value is never
// returned, recorded or printed.
async function secureConfiguration(ctx, step) {
  const sid = id(`secure/${step.key}`);
  const exists = await ctx.client.optional(
    `sdkmessageprocessingstepsecureconfigs(${sid})?$select=sdkmessageprocessingstepsecureconfigid`,
  );
  if (ctx.apply && !exists)
    await ctx.client.request('sdkmessageprocessingstepsecureconfigs', {
      method: 'POST',
      body: {
        sdkmessageprocessingstepsecureconfigid: sid,
        secureconfig: JSON.stringify({
          version: `synthetic-${step.secureProfile}`,
          syntheticSecret: randomBytes(32).toString('base64'),
        }),
      },
    });
  await ctx.record({
    key: `secure/${step.key}`,
    id: sid,
    status: exists ? 'unchanged' : 'create',
    secret: exists ? 'kept' : 'will set',
  });
  return sid;
}

function stepBody(step, { who, ownerTeamId, messageId, filterId, typeId }) {
  const cfg = {
    schemaVersion: 1,
    captureMode: 'TransactionalLab',
    writerId: who.applicationUserId,
    trustedWriterIds: [who.applicationUserId],
    teamId: ownerTeamId,
    chainStepIds: [
      id('step/ChainA/pqvd_crudprobe/Update/40/100/0'),
      id('step/ChainB/pqvd_chainnode/Create/40/100/0'),
      id('step/ChainC/pqvd_chainnode/Update/40/100/0'),
    ],
    timeoutMs: 2000,
    // verify-live.mjs --cleanup deletes a run's events through the attested owned-evidence contract.
    ...(step.type === 'EvidenceWriteGuard' ? { allowOwnedEvidenceDeletion: true } : {}),
    order: step.order,
    configVersion: step.secureProfile ? `secure-${step.secureProfile}` : 'lab-v1',
  };
  return {
    name: `CO ${step.type}: ${step.message} ${step.table} S${step.stage} O${step.order} M${step.mode}`,
    description: 'Synthetic lab. Transactional capture is rollback-vulnerable. Full durable collector not configured.',
    stage: step.stage,
    rank: step.order,
    mode: step.mode,
    supporteddeployment: 0,
    configuration: JSON.stringify(cfg),
    'sdkmessageid@odata.bind': `/sdkmessages(${messageId})`,
    ...(step.global ? {} : { 'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${filterId})` }),
    'eventhandler_plugintype@odata.bind': `/plugintypes(${typeId})`,
    ...(step.mode === 1 ? { asyncautodelete: true } : {}),
    ...(step.runAsWriter ? { 'impersonatinguserid@odata.bind': `/systemusers(${who.applicationUserId})` } : {}),
    ...(step.filteringAttributes?.length ? { filteringattributes: step.filteringAttributes.join(',') } : {}),
  };
}

async function ensureImages(ctx, step, stepId) {
  const columns = (step.imageColumns ?? []).filter(
    (name) =>
      !(step.table === 'pqvd_testoperation' && name === 'pqvd_operationid') &&
      !(step.table === 'pqvd_pluginevent' && ['pqvd_runid', 'pqvd_runnercontactid'].includes(name)),
  );
  for (const alias of step.images ?? [])
    await ensure(
      ctx,
      'sdkmessageprocessingstepimages',
      'sdkmessageprocessingstepimageid',
      `image/${step.key}/${alias}`,
      {
        name: alias,
        entityalias: alias,
        imagetype: alias === 'Before' ? 0 : 1,
        messagepropertyname: step.message === 'Create' ? 'Id' : 'Target',
        attributes: columns.join(','),
        'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
      },
      { type: 93 },
    );
}

async function ensureAssemblies(ctx, registry, builds) {
  const types = new Map();
  for (const assembly of registry.assemblies) {
    const aid = await ensure(
      ctx,
      'pluginassemblies',
      'pluginassemblyid',
      `assembly/${assembly.name}`,
      {
        name: assembly.name,
        culture: 'neutral',
        ...assemblyFields(builds.get(assembly.name)),
        isolationmode: 2,
        sourcetype: 0,
      },
      { type: 91 },
    );
    for (const type of assembly.types) {
      const fullname = `${assembly.name}.${type}`;
      const body = {
        typename: fullname,
        name: fullname,
        friendlyname: `CO ${type}`,
        'pluginassemblyid@odata.bind': `/pluginassemblies(${aid})`,
      };
      types.set(type, await ensure(ctx, 'plugintypes', 'plugintypeid', `type/${fullname}`, body, { type: 90 }));
    }
  }
  return types;
}

async function ensureOwnerTeam(ctx, who) {
  const ownerTeamId = id('fixture/ownerteam');
  const team = await ctx.client.optional(`teams(${ownerTeamId})?$select=teamid`);
  if (ctx.apply && !team)
    await ctx.client.request('teams', {
      method: 'POST',
      body: {
        teamid: ownerTeamId,
        name: 'CO plugin fixture owners',
        teamtype: 0,
        'businessunitid@odata.bind': `/businessunits(${who.businessUnitId})`,
      },
    });
  await ctx.record({ key: 'team/ownerteam', id: ownerTeamId, status: team ? 'unchanged' : 'create' });
  return ownerTeamId;
}

async function ensureStep(ctx, step, { who, ownerTeamId, types, message, filter, unsupported }) {
  const eligible = step.global ? [{}] : await filter(step.message, step.table);
  if (eligible.length !== 1) {
    unsupported.push({ ...step, reason: eligible.length ? 'AmbiguousFilter' : 'NoTableSpecificMessageFilter' });
    return;
  }
  const body = stepBody(step, {
    who,
    ownerTeamId,
    messageId: await message(step.message),
    filterId: eligible[0].sdkmessagefilterid,
    typeId: types.get(step.type),
  });
  if (step.secureProfile)
    body[secureBind] = `/sdkmessageprocessingstepsecureconfigs(${await secureConfiguration(ctx, step)})`;
  const stepId = await ensure(
    ctx,
    'sdkmessageprocessingsteps',
    'sdkmessageprocessingstepid',
    `step/${step.key}`,
    body,
    {
      type: 92,
      ...(step.disabled ? { state: { statecode: 1, statuscode: 2 } } : {}),
    },
  );
  await ensureImages(ctx, step, stepId);
}

// The Custom API with its request and response parts and the lab environment variable definitions.
async function ensureConfiguration(ctx, types) {
  const privilege = await ctx.client.get("EntityDefinitions(LogicalName='pqvd_chainnode')?$select=Privileges");
  const readPrivilege = privilege.Privileges.find((p) => p.PrivilegeType === 'Read' || p.PrivilegeType === 2);
  if (!readPrivilege) throw new Error('Installed ChainNode Read privilege unavailable.');
  const apiId = await ensure(ctx, 'customapis', 'customapiid', 'api/pqvd_EchoLabContext', {
    uniquename: 'pqvd_EchoLabContext',
    name: 'CO Echo Lab Context',
    displayname: 'CO Echo Lab Context',
    description: 'Synthetic typed SDK echo; no portal action.',
    bindingtype: 0,
    isfunction: false,
    isprivate: false,
    allowedcustomprocessingsteptype: 0,
    executeprivilegename: readPrivilege.Name,
    'PluginTypeId@odata.bind': `/plugintypes(${types.get('EchoLabContext')})`,
  });
  for (const [n, type, optional] of [
    ['OperationId', 12, false],
    ['Payload', 10, true],
  ])
    await ensure(ctx, 'customapirequestparameters', 'customapirequestparameterid', `api/request/${n}`, {
      uniquename: n,
      name: n,
      displayname: n,
      type,
      isoptional: optional,
      'CustomAPIId@odata.bind': `/customapis(${apiId})`,
    });
  for (const [n, type] of [
    ['SummaryJson', 10],
    ['SpanId', 12],
  ])
    await ensure(ctx, 'customapiresponseproperties', 'customapiresponsepropertyid', `api/response/${n}`, {
      uniquename: n,
      name: n,
      displayname: n,
      type,
      'CustomAPIId@odata.bind': `/customapis(${apiId})`,
    });
  for (const [name, type, value] of [
    ['pqvd_LabProfile', 100000000, 'Disabled'],
    ['pqvd_LabCollectorUrl', 100000000, ''],
    ['pqvd_LabTimeoutMs', 100000001, '2000'],
    ['pqvd_LabFeatureFlags', 100000004, '{}'],
    ['pqvd_LabFlowSecret', 100000005, null],
  ])
    await ensure(
      ctx,
      'environmentvariabledefinitions',
      'environmentvariabledefinitionid',
      `environment/${name}`,
      {
        schemaname: name,
        displayname: name,
        description: name.endsWith('Secret')
          ? 'Requires synthetic Key Vault binding and companion flow. No current secret value provisioned.'
          : 'CO lab nonsecret setting.',
        type,
        ...(value !== null ? { defaultvalue: value } : {}),
      },
      { type: 380 },
    );
}

/**
 * Compares the desired registration with the environment behind `client` and, with `apply`, writes exactly the
 * components whose state is create or update. Returns the per-component rows (the same states in plan and apply) and
 * the unsupported steps. `builds` maps assembly name to its local build (see localBuild).
 */
export async function deployPlugins({ client, who, registry, builds, apply = false, progress = async () => {} }) {
  const solution = registry.solution;
  const rows = [];
  const membership = new Set(
    (
      await client.list(
        `solutioncomponents?$select=objectid,componenttype&$expand=solutionid($select=uniquename)&$filter=solutionid/uniquename eq '${solution}'`,
      )
    ).map((x) => `${x.componenttype}/${x.objectid}`),
  );
  const record = async (row) => {
    rows.push(row);
    if (apply) await progress(rows);
  };
  const ctx = { client, apply, solution, membership, record };
  const ownerTeamId = await ensureOwnerTeam(ctx, who);
  const types = await ensureAssemblies(ctx, registry, builds);
  const { message, filter } = sdkCatalog(client);
  const unsupported = [];
  for (const step of registry.steps)
    await ensureStep(ctx, step, { who, ownerTeamId, types, message, filter, unsupported });
  await ensureConfiguration(ctx, types);
  return { rows, unsupported };
}

/** Component counts per state and how many secure configurations get a new secret or keep theirs. */
export const summarize = (rows) => ({
  create: rows.filter((r) => r.status === 'create').length,
  update: rows.filter((r) => r.status === 'update').length,
  unchanged: rows.filter((r) => r.status === 'unchanged').length,
  secrets: {
    willSet: rows.filter((r) => r.secret === 'will set').length,
    kept: rows.filter((r) => r.secret === 'kept').length,
  },
});

/**
 * Readiness of the lab's own registrations, from what is installed: a kind is ready when each of its supported steps
 * matches its registration (`unchanged` in a plan) or this apply has just written it. Every step carries the
 * TransactionalLab capture configuration, so capture is ready when every supported step is.
 */
export function installedReadiness(registry, rows, apply) {
  const status = new Map(rows.map((row) => [row.key, row.status]));
  const ready = (types) => {
    const steps = registry.steps.filter((s) => (!types || types.includes(s.type)) && status.has(`step/${s.key}`));
    return steps.length > 0 && steps.every((s) => apply || status.get(`step/${s.key}`) === 'unchanged');
  };
  return {
    transactionalCapture: ready(null),
    operationGuard: ready(['OperationIntentGuard']),
    probeABC: ready(['ChainA', 'ChainB', 'ChainC']),
  };
}

/** The SDK profiles `verify-live.mjs` can run against this installation, and why the others are blocked. */
export function profileReadiness(rows, apply) {
  const team = rows.find((row) => row.key === 'team/ownerteam');
  const ownerTeam = Boolean(team) && (apply || team.status === 'unchanged');
  return {
    supportedProfiles: [
      'ABC',
      'P02',
      'P03',
      'P04',
      ...(ownerTeam ? ['P05'] : []),
      'P06',
      'P07',
      'P09',
      'P10',
      'P11',
      'P12',
    ],
    blockedProfiles: [
      ...(ownerTeam ? [] : ['P05 (needs the owner team that deploy.mjs --apply creates)']),
      'P08 (needs durable collector)',
      'P13 (needs Azure identity/RBAC/collector)',
      'P14 (needs Flow/Key Vault/collector)',
    ],
  };
}

if (isMain(import.meta)) {
  const { values } = cli(usage, { connection: { type: 'string' }, apply: { type: 'boolean' } });
  const apply = values.apply === true;
  const root = dirname(fileURLToPath(import.meta.url));
  const project = dirname(root);
  const registry = registration(await readManifest(resolve(project, 'dataverse/manifest.json')));
  const builds = new Map();
  for (const assembly of registry.assemblies) builds.set(assembly.name, await localBuild(assembly));
  const connection = await loadConnection(values.connection ?? defaultConnection);
  const client = connectedClient(connection);
  const who = await client.verify(connection.organisationId);
  const privateRoot = resolve(project, '.paqvilo/plugins');
  await mkdir(privateRoot, { recursive: true });
  const nativeFetch = client.fetch;
  client.fetch = async (...params) => {
    const response = await nativeFetch(...params);
    if (!response.ok) {
      const value = await response
        .clone()
        .json()
        .catch(() => null);
      const message = String(value?.error?.message ?? '')
        .slice(0, 3000)
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
      await writeFile(
        resolve(privateRoot, 'last-api-error.json'),
        JSON.stringify(
          { time: new Date().toISOString(), status: response.status, code: value?.error?.code, message },
          null,
          2,
        ),
      );
    }
    return response;
  };
  const progress = async (rows) => {
    if (rows.length % 10 === 0) console.log(JSON.stringify({ completed: rows.length, last: rows.at(-1).key }));
    await writeFile(
      resolve(privateRoot, 'deployment-progress.json'),
      JSON.stringify({ state: 'Running', time: new Date().toISOString(), rows }, null, 2),
    );
  };
  const { rows, unsupported } = await deployPlugins({ client, who, registry, builds, apply, progress });
  const report = resolve(privateRoot, apply ? 'deployment.json' : 'deployment-plan.json');
  const result = {
    schemaVersion: 1,
    state: apply ? 'Deployed' : 'ReadOnlyPlan',
    environment: who,
    time: new Date().toISOString(),
    hashes: registry.assemblies.map((assembly) => ({
      assembly: assembly.name,
      sha256: builds.get(assembly.name).sha256,
      sdk: 'Microsoft.CrmSdk.CoreAssemblies/9.0.2.60',
      target: 'net462',
    })),
    registration: registry,
    summary: summarize(rows),
    unsupported,
    rows,
    readiness: {
      ...registry.readiness,
      ...installedReadiness(registry, rows, apply),
      ...profileReadiness(rows, apply),
    },
  };
  await writeFile(report, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      state: result.state,
      components: rows.length,
      ...result.summary,
      changed: rows
        .filter((r) => r.status !== 'unchanged')
        .map(({ key, status, changes }) => ({ key, status, changes })),
      unsupported: unsupported.length,
      readiness: result.readiness,
      report,
    }),
  );
}
