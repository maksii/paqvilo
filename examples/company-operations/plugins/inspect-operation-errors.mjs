import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection, exampleRoot } from '../paths.mjs';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/inspect-operation-errors.mjs [--connection FILE]

Run from the toolkit checkout. Reads recent OperationIntentGuard exceptions from the live plug-in trace log into the
example's ignored .paqvilo/plugins/operation-errors.json.

${connectionHelp('  --connection FILE  ')}`,
  { connection: { type: 'string' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const c = connectedClient(connection);
await c.verify(connection.organisationId);
const rows = await c.list(
  "plugintracelogs?$select=createdon,typename,exceptiondetails,messageblock,correlationid&$filter=startswith(typename,'Paqvilo.Demo.PipelineTests.OperationIntentGuard') and exceptiondetails ne null&$orderby=createdon desc&$top=5",
);
await writeFile(join(exampleRoot, '.paqvilo/plugins/operation-errors.json'), JSON.stringify(rows, null, 2));
console.log(
  JSON.stringify(
    rows.map((r) => ({ time: r.createdon, error: r.exceptiondetails?.split('\r\n')[0], trace: r.messageblock })),
    null,
    2,
  ),
);
