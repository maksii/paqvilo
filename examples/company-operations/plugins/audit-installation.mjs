import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { id, assemblies, localAssemblyIdentity } from './registration.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf('--connection');
if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith('--')))
  throw new Error('--connection requires a saved connection path.');
const connection = await loadConnection(
  at >= 0 ? args[at + 1] : resolve(root, '../../../.paqvilo/dataverse/provisioning.connection.json'),
);
const c = connectedClient(connection);
const who = await c.verify(connection.organisationId);
const builds = [];
const types = [];
for (const a of assemblies) {
  const bytes = await readFile(resolve(root, a.project, 'bin/Release/net462', a.name + '.dll'));
  const row = await c.get(`pluginassemblies(${id('assembly/' + a.name)})?$select=content,name,version,isolationmode`);
  const localHash = createHash('sha256').update(bytes).digest('hex'),
    installedHash = createHash('sha256').update(Buffer.from(row.content, 'base64')).digest('hex');
  builds.push({
    assemblyIdentity: localAssemblyIdentity(resolve(root, a.project, 'bin/Release/net462', a.name + '.dll')),
    assembly: a.name,
    version: row.version,
    isolationMode: row.isolationmode,
    localHash,
    installedHash,
    match: localHash === installedHash,
  });
  for (const type of a.types) types.push(id(`type/${a.name}.${type}`));
}
const steps = await c.list(
  `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,rank,mode,statecode,statuscode,_sdkmessagefilterid_value,_eventhandler_value,configuration&$filter=${types.map((t) => `_eventhandler_value eq ${t}`).join(' or ')}`,
);
const querySteps = steps.filter((s) => s.name.includes('IncomingQueryObserver'));
const trust = querySteps.map((s) => JSON.parse(s.configuration));
const onlyVerifiedApplicationTrusted = trust.every(
  (c) =>
    c.writerId === who.applicationUserId &&
    Array.isArray(c.trustedWriterIds) &&
    c.trustedWriterIds.length === 1 &&
    c.trustedWriterIds[0] === who.applicationUserId,
);
const counts = {
  onlyVerifiedApplicationTrusted,
  installedSteps: steps.length,
  activeSteps: steps.filter((s) => s.statecode === 0).length,
  querySteps: steps.filter((s) => s.name.includes('IncomingQueryObserver')).length,
  unfilteredQuerySteps: steps.filter((s) => s.name.includes('IncomingQueryObserver') && !s._sdkmessagefilterid_value)
    .length,
};
const report = {
  schemaVersion: 1,
  time: new Date().toISOString(),
  environment: who,
  builds,
  counts,
  steps,
  ready: builds.every((b) => b.match) && counts.unfilteredQuerySteps === 0 && onlyVerifiedApplicationTrusted,
};
await writeFile(resolve(root, '../.paqvilo/plugins/installation-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ready: report.ready, builds, counts }));
