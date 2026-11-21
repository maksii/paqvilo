import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { id, assemblies, localBuild, assemblyDifferences } from './registration.mjs';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection } from '../paths.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(fileURLToPath(import.meta.url));
const { values } = cli(
  `Usage: node examples/company-operations/plugins/audit-installation.mjs [--connection FILE]

Run from the toolkit checkout. Compares each installed assembly in the live environment with the local Release build
(content hash, version and public key token, as deploy.mjs does; read-only) and saves the example's ignored
.paqvilo/plugins/installation-audit.json.

${connectionHelp('  --connection FILE  ')}`,
  { connection: { type: 'string' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const c = connectedClient(connection);
const who = await c.verify(connection.organisationId);
const builds = [];
const types = [];
for (const a of assemblies) {
  const build = await localBuild(a);
  const row = await c.get(
    `pluginassemblies(${id('assembly/' + a.name)})?$select=content,name,version,publickeytoken,isolationmode`,
  );
  const differences = assemblyDifferences(build, row);
  builds.push({
    assemblyIdentity: build.identity,
    assembly: a.name,
    version: row.version,
    publicKeyToken: row.publickeytoken,
    isolationMode: row.isolationmode,
    localHash: build.sha256,
    installedHash: createHash('sha256').update(Buffer.from(row.content, 'base64')).digest('hex'),
    match: differences.length === 0,
    differences,
  });
  for (const type of a.types) types.push(id(`type/${a.name}.${type}`));
}
const steps = await c.list(
  `sdkmessageprocessingsteps?$select=sdkmessageprocessingstepid,name,stage,rank,mode,statecode,statuscode,_sdkmessagefilterid_value,_eventhandler_value,configuration&$filter=${types.map((t) => '_eventhandler_value eq ' + t).join(' or ')}`,
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
