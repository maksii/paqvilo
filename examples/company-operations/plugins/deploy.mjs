import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { loadConnection, connectedClient, readManifest } from '../../../lense/dataverse/index.mjs';
import { id, registration } from './registration.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const project = dirname(root);
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const connectionIndex = args.indexOf('--connection');
if (connectionIndex >= 0 && (!args[connectionIndex + 1] || args[connectionIndex + 1].startsWith('--')))
  throw new Error('--connection requires a saved connection path.');
const connectionPath =
  connectionIndex >= 0
    ? args[connectionIndex + 1]
    : resolve(project, '../../.paqvilo/dataverse/provisioning.connection.json');
const manifest = await readManifest(resolve(project, 'dataverse/manifest.json'));
const registry = registration(manifest);
const connection = await loadConnection(connectionPath);
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
const solution = registry.solution;
const rows = [];
const membership = new Set(
  (
    await client.list(
      `solutioncomponents?$select=objectid,componenttype&$expand=solutionid($select=uniquename)&$filter=solutionid/uniquename eq '${solution}'`,
    )
  ).map((x) => `${x.componenttype}/${x.objectid}`),
);
async function include(component, type) {
  if (type === 90 || type === 93) return;
  const key = `${type}/${component}`;
  if (!membership.has(key)) {
    await client.request('AddSolutionComponent', {
      method: 'POST',
      body: { ComponentId: component, ComponentType: type, SolutionUniqueName: solution, AddRequiredComponents: false },
    });
    membership.add(key);
  }
}
async function ensure(set, primary, key, body, type) {
  const guid = id(key);
  const existing = await client.optional(`${set}(${guid})`);
  if (!apply) {
    rows.push({ key, id: guid, status: existing ? 'exists' : 'create' });
    return guid;
  }
  const changed =
    existing &&
    Object.entries(body).some(([k, v]) => {
      if (k.endsWith('@odata.bind')) {
        const attr = k.slice(0, -11).toLowerCase().replace('eventhandler_plugintype', 'eventhandler');
        return existing[`_${attr}_value`]?.toLowerCase() !== v.match(/\(([a-f0-9-]+)\)$/i)?.[1].toLowerCase();
      }
      return JSON.stringify(existing[k]) !== JSON.stringify(v);
    });
  if (changed) {
    await client.request(`${set}(${guid})`, { method: 'PATCH', body, solution });
  } else if (!existing) {
    await client.request(set, { method: 'POST', body: { [primary]: guid, ...body }, solution });
  }
  if (type) await include(guid, type);
  rows.push({ key, id: guid, status: existing ? (changed ? 'updated' : 'exists') : 'created' });
  if (rows.length % 10 === 0) console.log(JSON.stringify({ completed: rows.length, last: key }));
  await writeFile(
    resolve(privateRoot, 'deployment-progress.json'),
    JSON.stringify({ state: 'Running', time: new Date().toISOString(), rows }, null, 2),
  );
  return guid;
}
const types = new Map();
const hashes = [];
const ownerTeamId = id('fixture/ownerteam');
if (apply && !(await client.optional(`teams(${ownerTeamId})?$select=teamid`)))
  await client.request('teams', {
    method: 'POST',
    body: {
      teamid: ownerTeamId,
      name: 'CO plugin fixture owners',
      teamtype: 0,
      'businessunitid@odata.bind': `/businessunits(${who.businessUnitId})`,
    },
  });
for (const assembly of registry.assemblies) {
  const path = resolve(root, assembly.project, 'bin/Release/net462', `${assembly.name}.dll`);
  const bytes = await readFile(path);
  hashes.push({
    assembly: assembly.name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sdk: 'Microsoft.CrmSdk.CoreAssemblies/9.0.2.60',
    target: 'net462',
  });
  const aid = await ensure(
    'pluginassemblies',
    'pluginassemblyid',
    `assembly/${assembly.name}`,
    {
      name: assembly.name,
      version: '1.0.0.0',
      culture: 'neutral',
      publickeytoken: '',
      content: bytes.toString('base64'),
      isolationmode: 2,
      sourcetype: 0,
    },
    91,
  );
  for (const type of assembly.types) {
    const fullname = `${assembly.name}.${type}`;
    const tid = await ensure(
      'plugintypes',
      'plugintypeid',
      `type/${fullname}`,
      {
        typename: fullname,
        name: fullname,
        friendlyname: `CO ${type}`,
        'pluginassemblyid@odata.bind': `/pluginassemblies(${aid})`,
      },
      90,
    );
    types.set(type, tid);
  }
}
const messages = new Map();
async function message(name) {
  if (!messages.has(name)) {
    const results = await client.list(`sdkmessages?$select=sdkmessageid,name&$filter=name eq '${name}'`);
    if (results.length !== 1) throw new Error(`Ambiguous SDK message: ${name}`);
    messages.set(name, results[0].sdkmessageid);
  }
  return messages.get(name);
}
const filters = new Map();
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
const unsupported = [];
for (const step of registry.steps) {
  const eligible = step.global ? [{}] : await filter(step.message, step.table);
  if (eligible.length !== 1) {
    unsupported.push({ ...step, reason: eligible.length ? 'AmbiguousFilter' : 'NoTableSpecificMessageFilter' });
    continue;
  }
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
    order: step.order,
    configVersion: step.secureProfile ? `secure-${step.secureProfile}` : 'lab-v1',
  };
  const body = {
    name: `CO ${step.type}: ${step.message} ${step.table} S${step.stage} O${step.order} M${step.mode}`,
    description: 'Synthetic lab. Transactional capture is rollback-vulnerable. Full durable collector not configured.',
    stage: step.stage,
    rank: step.order,
    mode: step.mode,
    supporteddeployment: 0,
    configuration: JSON.stringify(cfg),
    'sdkmessageid@odata.bind': `/sdkmessages(${await message(step.message)})`,
    'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${eligible[0].sdkmessagefilterid})`,
    'eventhandler_plugintype@odata.bind': `/plugintypes(${types.get(step.type)})`,
    ...(step.mode === 1 ? { asyncautodelete: true } : {}),
    ...(step.runAsWriter ? { 'impersonatinguserid@odata.bind': `/systemusers(${who.applicationUserId})` } : {}),
    ...(step.filteringAttributes?.length ? { filteringattributes: step.filteringAttributes.join(',') } : {}),
  };
  if (step.global) delete body['sdkmessagefilterid@odata.bind'];
  if (step.secureProfile && apply) {
    const sid = id(`secure/${step.key}`);
    const exists = await client.optional(
      `sdkmessageprocessingstepsecureconfigs(${sid})?$select=sdkmessageprocessingstepsecureconfigid`,
    );
    const secure = {
      secureconfig: JSON.stringify({
        version: `synthetic-${step.secureProfile}`,
        syntheticSecret: randomBytes(32).toString('base64'),
      }),
    };
    await client.request(
      exists ? `sdkmessageprocessingstepsecureconfigs(${sid})` : 'sdkmessageprocessingstepsecureconfigs',
      {
        method: exists ? 'PATCH' : 'POST',
        body: exists ? secure : { sdkmessageprocessingstepsecureconfigid: sid, ...secure },
      },
    );
    body['sdkmessageprocessingstepsecureconfigid@odata.bind'] = `/sdkmessageprocessingstepsecureconfigs(${sid})`;
  }
  const stepId = await ensure('sdkmessageprocessingsteps', 'sdkmessageprocessingstepid', `step/${step.key}`, body, 92);
  if (step.disabled && apply)
    await client.request(`sdkmessageprocessingsteps(${stepId})`, {
      method: 'PATCH',
      body: { statecode: 1, statuscode: 2 },
    });
  for (const alias of step.images ?? []) {
    const columns = step.imageColumns.filter(
      (name) =>
        !(step.table === 'pqvd_testoperation' && name === 'pqvd_operationid') &&
        !(step.table === 'pqvd_pluginevent' && ['pqvd_runid', 'pqvd_runnercontactid'].includes(name)),
    );
    await ensure(
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
      93,
    );
  }
}
const privilege = await client.get("EntityDefinitions(LogicalName='pqvd_chainnode')?$select=Privileges");
const readPrivilege = privilege.Privileges.find((p) => p.PrivilegeType === 'Read' || p.PrivilegeType === 2);
if (!readPrivilege) throw new Error('Installed ChainNode Read privilege unavailable.');
const apiId = await ensure('customapis', 'customapiid', 'api/pqvd_EchoLabContext', {
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
  await ensure('customapirequestparameters', 'customapirequestparameterid', `api/request/${n}`, {
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
  await ensure('customapiresponseproperties', 'customapiresponsepropertyid', `api/response/${n}`, {
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
    380,
  );
const result = {
  schemaVersion: 1,
  state: apply ? 'Deployed' : 'ReadOnlyPlan',
  environment: who,
  time: new Date().toISOString(),
  hashes,
  registration: registry,
  unsupported,
  rows,
  readiness: {
    ...registry.readiness,
    transactionalCapture: apply,
    operationGuard: apply,
    probeABC: apply,
    supportedProfiles: ['ABC', 'P02', 'P03', 'P04', 'P06', 'P07', 'P10', 'P11', 'P12'],
    blockedProfiles: [
      'P05 (needs demo owner team)',
      'P08 (needs durable collector)',
      'P09 (adapter qualification)',
      'P13 (needs Azure identity/RBAC/collector)',
      'P14 (needs Flow/Key Vault/collector)',
    ],
  },
};
await writeFile(
  resolve(privateRoot, apply ? 'deployment.json' : 'deployment-plan.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    state: result.state,
    components: rows.length,
    unsupported: unsupported.length,
    readiness: result.readiness,
    report: resolve(privateRoot, apply ? 'deployment.json' : 'deployment-plan.json'),
  }),
);
