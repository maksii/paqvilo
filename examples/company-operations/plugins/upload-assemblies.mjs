import { id, assemblies, localBuild, assemblyFields, assemblyDifferences } from './registration.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection } from '../paths.mjs';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/upload-assemblies.mjs [--connection FILE]

Run from the toolkit checkout. Replaces each registered plug-in assembly in the live environment whose content hash,
version or public key token differs from the local Release build (writes); an assembly that already is the local
build is left alone.

${connectionHelp('  --connection FILE  ')}`,
  { connection: { type: 'string' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const root = dirname(fileURLToPath(import.meta.url));
const c = connectedClient(connection);
await c.verify(connection.organisationId);
const hashes = [];
for (const a of assemblies) {
  const build = await localBuild(a);
  const route = `pluginassemblies(${id('assembly/' + a.name)})`;
  const changes = assemblyDifferences(build, await c.get(`${route}?$select=content,version,publickeytoken`));
  if (changes.length) await c.request(route, { method: 'PATCH', body: assemblyFields(build) });
  hashes.push({
    name: a.name,
    status: changes.length ? 'updated' : 'unchanged',
    ...(changes.length ? { changes } : {}),
    sha256: build.sha256,
    assemblyIdentity: build.identity,
  });
}
await writeFile(
  resolve(root, '../.paqvilo/plugins/assembly-update.json'),
  JSON.stringify({ time: new Date().toISOString(), hashes }, null, 2),
);
console.log(JSON.stringify({ state: hashes.some((h) => h.changes) ? 'Updated' : 'Unchanged', hashes }));
