import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection, exampleRoot } from '../paths.mjs';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/inspect-trace.mjs [--connection FILE] [--enable]

Run from the toolkit checkout. Reads recent Paqvilo.Demo plug-in exceptions from the live trace log into the example's
ignored .paqvilo/plugins/trace-errors.json.

${connectionHelp('  --connection FILE  ')}
  --enable           first turn on the organisation plug-in trace log (writes)`,
  { connection: { type: 'string' }, enable: { type: 'boolean' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const c = connectedClient(connection);
await c.verify(connection.organisationId);
if (values.enable) {
  const orgs = await c.list('organizations?$select=organizationid,plugintracelogsetting');
  console.log(JSON.stringify(orgs));
  for (const o of orgs)
    if (o.plugintracelogsetting === 0)
      await c.request(`organizations(${o.organizationid})`, { method: 'PATCH', body: { plugintracelogsetting: 1 } });
}
const rows = await c.list(
  "plugintracelogs?$select=createdon,typename,exceptiondetails,messageblock,correlationid&$filter=startswith(typename,'Paqvilo.Demo.') and exceptiondetails ne null&$orderby=createdon desc&$top=5",
);
await mkdir(join(exampleRoot, '.paqvilo/plugins'), { recursive: true });
await writeFile(join(exampleRoot, '.paqvilo/plugins/trace-errors.json'), JSON.stringify(rows, null, 2));
console.log(
  JSON.stringify(
    rows.map((r) => ({ type: r.typename, exception: r.exceptiondetails?.slice(-6500), trace: r.messageblock })),
    null,
    2,
  ),
);
