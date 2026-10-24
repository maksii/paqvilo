import { connectionPath } from './registration.mjs';
import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { writeFile } from 'node:fs/promises';
const connection = await loadConnection(connectionPath());
const c = connectedClient(connection);
await c.verify(connection.organisationId);
const rows = await c.list(
  "plugintracelogs?$select=createdon,typename,exceptiondetails,messageblock,correlationid&$filter=startswith(typename,'Paqvilo.Demo.PipelineTests.OperationIntentGuard') and exceptiondetails ne null&$orderby=createdon desc&$top=5",
);
await writeFile('examples/company-operations/.paqvilo/plugins/operation-errors.json', JSON.stringify(rows, null, 2));
console.log(
  JSON.stringify(
    rows.map((r) => ({ time: r.createdon, error: r.exceptiondetails?.split('\r\n')[0], trace: r.messageblock })),
    null,
    2,
  ),
);
