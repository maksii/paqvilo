import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { replayStore } from '../portal-harness/replay.mjs';
import { capturedQueries } from '../portal-harness/parity.mjs';
import {
  buildODataPermissionFilter,
  inspectNativeODataPermissionFilter,
  serializeODataPermissionNode,
} from './odata-permission-model.mjs';

const jobFile = process.argv[2];
if (!jobFile || process.argv.length !== 3)
  throw new Error('Usage: node portal-security/odata-permission-diagnostic.mjs <private-job.json>');
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const job = await read(jobFile);
if (
  !path
    .resolve(job.output ?? '')
    .split(path.sep)
    .includes('.paqvilo')
)
  throw new Error('Native OData diagnostics must stay in ignored .paqvilo.');
const [schema, catalogue, snapshot, components, capture] = await Promise.all(
  ['schema', 'catalogue', 'nativeSnapshot', 'nativeComponents', 'capture'].map((key) => read(job[key])),
);
if (!snapshot.complete) throw new Error('Diagnostic needs a complete frozen native input snapshot.');
const actor = snapshot.tables.contact.find((contact) => contact.contactid === snapshot.contactId);
if (!actor) throw new Error('The native snapshot is missing the actual portal actor.');
const environment = replayStore({
  schema,
  catalogue,
  nativeComponents: components,
  roles: snapshot.memberships.map((role) => role.name),
  contactId: snapshot.contactId,
  overlay: {
    records: [
      {
        key: 'ODATA-DIAGNOSTIC-ACTOR',
        id: snapshot.contactId,
        table: 'contact',
        fields: {
          ...actor,
          parentcustomerid: actor._parentcustomerid_value
            ? { id: actor._parentcustomerid_value, logical_name: 'account' }
            : null,
        },
      },
    ],
    associations: [],
  },
});
const report = {
  kind: 'source-derived-native-odata-permission-diagnostic',
  qualification: 'diagnostic',
  cells: [],
  nativeExecution: false,
  nativeMutation: false,
  nativeQualifiedCells: 0,
  limitations: [
    'Ordering learned from the same query remains a calibration hypothesis; it is not independent validation.',
    'Uncaptured queries and unsupported scopes/relationships are explicit gaps; source modeling grants no native coverage.',
  ],
};
for (const request of capture.requests.filter((request) => request.caseId.endsWith('-odata'))) {
  const events = capture.backendEvents.filter((event) => event._pqvd_operationid_value === request.operationId);
  const checked = capturedQueries(events, { operationId: request.operationId });
  if (checked.errors.length || !checked.queries.length) {
    report.cells.push({
      caseId: request.caseId,
      qualification: 'unqualified',
      reason: 'missing-or-invalid-backend-query',
      errors: checked.errors,
    });
    continue;
  }
  const final = checked.queries.at(-1),
    spans = new Map();
  for (const event of events.filter(
    (event) =>
      event.pqvd_stage === final.stage &&
      event.pqvd_executionorder === final.order &&
      event.pqvd_artifacttype === final.artifact,
  )) {
    const parts = spans.get(event.pqvd_spanid) ?? [];
    parts.push(event);
    spans.set(event.pqvd_spanid, parts);
  }
  const payload = [...spans.values()]
    .map((parts) =>
      JSON.parse(
        parts
          .sort((a, b) => a.pqvd_partnumber - b.pqvd_partnumber)
          .map((part) => part.pqvd_payloadtext)
          .join(''),
      ),
    )
    .find(
      (payload) => createHash('sha256').update(payload.content.query.xml).digest('hex') === final.fingerprint.exactHash,
    );
  if (!payload) throw new Error('Validated OData artifact could not be bound to its original received XML.');
  const native = inspectNativeODataPermissionFilter(payload.content.query.xml);
  const input = {
    table: native.table,
    permissions: environment.store.state.permissions,
    identity: environment.identity,
    mappings: environment.store.state.mappings,
    rules: environment.store.rules.bind(environment.store),
  };
  const model = buildODataPermissionFilter(input);
  const paths = native.alternatives.map((alternative) => ({
    links: alternative.links,
    terminalAttributes: alternative.terminalAttributes,
    matchingPermissionIds: model.alternatives
      .filter((candidate) => candidate.xml === alternative.xml)
      .map((candidate) => candidate.permissionId),
    debugXml: alternative.xml,
  }));
  const inferredOrder = paths.every((path) => path.matchingPermissionIds.length === 1)
    ? paths.map((path) => path.matchingPermissionIds[0])
    : null;
  const ordered = inferredOrder ? buildODataPermissionFilter({ ...input, grantOrder: inferredOrder }) : null;
  report.cells.push({
    caseId: request.caseId,
    table: native.table,
    qualification: 'one-native-query-calibration-only',
    sourceArtifactHash: final.fingerprint.exactHash,
    nativeAlternatives: native.alternatives.length,
    modelAlternatives: model.alternatives.length,
    paths,
    modelDiagnostics: model.diagnostics,
    inferredPermissionOrder: inferredOrder,
    sourceAlternativeXml: model.alternatives,
    inferredOrderExpressionMatch:
      ordered?.xml ===
      // Avoid formatting normalization: native AST is serialized in its original
      // attribute order, independent of the inferred source grant order.
      serializeODataPermissionNode(native.expression),
    nativeQualified: false,
  });
}
await mkdir(path.dirname(job.output), { recursive: true });
await writeFile(job.output, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    output: job.output,
    qualification: report.qualification,
    nativeQualifiedCells: 0,
    cells: report.cells.length,
    missingBackendQueries: report.cells.filter((cell) => cell.qualification === 'unqualified').length,
    inferredExpressionMatches: report.cells.filter((cell) => cell.inferredOrderExpressionMatch).length,
    unmatchedPaths: report.cells
      .flatMap((cell) => cell.paths ?? [])
      .filter((path) => !path.matchingPermissionIds.length).length,
  }),
);
