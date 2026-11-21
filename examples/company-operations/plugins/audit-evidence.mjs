import { loadConnection, connectedClient } from '../../../lense/dataverse/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cli } from '../cli.mjs';
import { connectionHelp, defaultConnection, exampleRoot } from '../paths.mjs';
const { values } = cli(
  `Usage: node examples/company-operations/plugins/audit-evidence.mjs [--connection FILE]

Run from the toolkit checkout. Reads the P02 plug-in event parts of the last qualification run from the live
environment into the example's ignored .paqvilo/plugins/evidence-audit.json.

${connectionHelp('  --connection FILE  ')}`,
  { connection: { type: 'string' } },
);
const connection = await loadConnection(values.connection ?? defaultConnection);
const c = connectedClient(connection);
await c.verify(connection.organisationId);
const report = JSON.parse(await readFile(join(exampleRoot, '.paqvilo/plugins/qualification.json'), 'utf8'));
const op = report.outcomes.find((o) => o.caseId === 'P02').operationId;
const events = await c.list(
  `pqvd_pluginevents?$select=pqvd_payloadtext,pqvd_artifacttype,pqvd_payloadhash,pqvd_partnumber,pqvd_partcount&$filter=_pqvd_operationid_value eq ${op}`,
);
const summaries = events.map((e) => {
  const p = JSON.parse(e.pqvd_payloadtext);
  return {
    artifact: e.pqvd_artifacttype,
    message: p.context.MessageName,
    stage: p.context.Stage,
    depth: p.context.Depth,
    requestId: p.context.RequestId,
    spanId: p.spanId,
    parentSpan: p.parentSpanId,
    userId: p.context.UserId,
    initiatingUserId: p.context.InitiatingUserId,
  };
});
await writeFile(join(exampleRoot, '.paqvilo/plugins/evidence-audit.json'), JSON.stringify(summaries, null, 2));
console.log(
  JSON.stringify(
    {
      events: summaries.length,
      requestIDs: [...new Set(summaries.map((s) => s.requestId))],
      missingRequestIDs: summaries.filter((s) => !s.requestId).length,
    },
    null,
    2,
  ),
);
