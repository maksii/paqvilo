#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  loadConnection,
  publicConnection,
  registerApplication,
  connectExistingApplication,
  privateJson,
} from './connection.mjs';
import { connectedClient } from './client.mjs';
import { readManifest } from './manifest.mjs';
import {
  planManifest,
  applyManifest,
  publishManifest,
  checkKeys,
  exportSolution,
  completeLookupAuditing,
  scopeSolutionRoots,
} from './provision.mjs';
import { readCatalogue, planData, applyData, compareData, runDataQueries } from './data.mjs';

const HELP = `paqvilo dataverse — provision schema through Dataverse, then export it

  register --connection .paqvilo/dataverse/connection.json --name NAME [--role ROLE]
           [--environment HTTPS-ORG-ORIGIN]  Uses the active PAC administrator profile.
  inspect  --connection FILE               Show connection details without credentials.
  connect  --registration FILE --secret-file FILE --connection FILE [--role ROLE]
           [--consume-secret-file]  Finish a partial registration using the same app.
  verify   --connection FILE               Verify application identity and organisation.
  plan     --manifest FILE [--connection FILE] [--out FILE]
           No connection: offline payload plan. With connection: read-only reconciliation.
  apply    --manifest FILE --connection FILE [--out JOURNAL]
           Create missing components. Refuse incompatible existing metadata; no deletes.
  publish  --manifest FILE --connection FILE
           Publish only the declared tables/choices.
  keys     --manifest FILE --connection FILE
           Report asynchronous alternate-key activation; non-ready is not success.
  audit-lookups --manifest FILE --connection FILE
           Complete auditing on declared custom lookups after relationship creation.
  scope-solutions --manifest FILE --connection FILE
           Narrow declared table roots to explicit subcomponents before exporting.
  export   --connection FILE --solution NAME --out ZIP [--unpack DIRECTORY]
           Export unmanaged solution from Dataverse; optionally unpack using PAC.
  data-plan    --catalogue FILE [--connection FILE] [--out FILE]
               Offline inventory or read-only fixture reconciliation.
  data-apply   --catalogue FILE --connection FILE [--out JOURNAL]
               Create missing fixtures and links; refuse drift, never delete.
  data-compare --catalogue FILE --connection FILE [--out REPORT]
               Compare controlled fields and exact association sets.
  data-query   --catalogue FILE --connection FILE [--out REPORT]
               Run paged FetchXML and compare expected rows under this app identity.

Credentials use Windows DPAPI CurrentUser, or an environment-secret reference in a
connection file. PAC output/tokens are never printed. Registration is not retried
after an uncertain or partial outcome. Lense/Mirage commands do not provision.
`;

const [command, ...args] = process.argv.slice(2);
async function main() {
  if (!command || ['--help', '-h'].includes(command) || args.some((a) => ['--help', '-h'].includes(a))) {
    console.log(HELP);
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      connection: { type: 'string' },
      manifest: { type: 'string' },
      catalogue: { type: 'string' },
      environment: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      out: { type: 'string' },
      solution: { type: 'string' },
      unpack: { type: 'string' },
      json: { type: 'boolean' },
      registration: { type: 'string' },
      'secret-file': { type: 'string' },
      'consume-secret-file': { type: 'boolean' },
    },
  });
  const output = (value) => console.log(JSON.stringify(value, null, 2));
  if (command === 'register') {
    output(
      await registerApplication({
        connectionFile: values.connection,
        environment: values.environment,
        applicationName: values.name,
        role: values.role,
      }),
    );
    return;
  }
  if (command === 'connect') {
    output(
      await connectExistingApplication({
        registrationFile: values.registration,
        secretFile: values['secret-file'],
        connectionFile: values.connection,
        role: values.role,
        consumeSecretFile: values['consume-secret-file'],
      }),
    );
    return;
  }
  if (command === 'inspect') {
    if (!values.connection) throw new Error('--connection required');
    output(publicConnection(JSON.parse(await fs.readFile(values.connection, 'utf8'))));
    return;
  }
  let connection, client;
  if (values.connection) {
    connection = await loadConnection(values.connection);
    client = connectedClient(connection);
  }
  if (command === 'verify') {
    if (!client) throw new Error('--connection required');
    output(await client.verify(connection.organisationId));
    return;
  }
  if (['data-plan', 'data-apply', 'data-compare', 'data-query'].includes(command)) {
    if (!values.catalogue) throw new Error('--catalogue required');
    const catalogue = await readCatalogue(values.catalogue);
    if (client) await client.verify(connection.organisationId);
    if (command !== 'data-plan' && !client) throw new Error('--connection required');
    if (command === 'data-apply') {
      const journalFile = values.out ?? path.resolve('.paqvilo/dataverse', `data-apply-${randomUUID()}.json`);
      const result = await applyData(catalogue, {
        client,
        expectedOrganisationId: connection.organisationId,
        journalFile,
      });
      output({ state: result.state, steps: result.entries.length, journalFile: path.resolve(journalFile) });
      return;
    }
    const result =
      command === 'data-plan'
        ? await planData(catalogue, { client })
        : command === 'data-compare'
          ? await compareData(catalogue, { client })
          : await runDataQueries(catalogue, { client });
    if (values.out) await privateJson(values.out, result);
    output(
      values.out && !values.json
        ? {
            datasetId: result.datasetId,
            version: result.version,
            mode: result.mode,
            summary: result.summary,
            passed: result.passed,
            queries: result.results?.length,
            savedTo: path.resolve(values.out),
          }
        : result,
    );
    if (result.passed === false) process.exitCode = 2;
    return;
  }
  if (command === 'export') {
    if (!client || !values.solution || !values.out)
      throw new Error('Export requires --connection, --solution and --out.');
    await client.verify(connection.organisationId);
    output(
      await exportSolution({ client, solutionName: values.solution, zipFile: values.out, unpackFolder: values.unpack }),
    );
    return;
  }
  if (!['plan', 'apply', 'publish', 'keys', 'audit-lookups', 'scope-solutions'].includes(command))
    throw new Error('Unknown dataverse command; run paqvilo dataverse --help.');
  if (!values.manifest) throw new Error('--manifest required');
  const manifest = await readManifest(path.resolve(values.manifest));
  if (command === 'plan') {
    if (client) await client.verify(connection.organisationId);
    const plan = await planManifest(manifest, { client });
    if (values.out) await privateJson(values.out, plan);
    output(
      values.json || !values.out
        ? plan
        : {
            schemaVersion: plan.schemaVersion,
            mode: plan.mode,
            manifestHash: plan.manifestHash,
            environmentUrl: plan.environmentUrl,
            summary: plan.summary,
            drift: plan.actions.filter((a) => a.status === 'drift').map((a) => a.key),
            savedTo: path.resolve(values.out),
          },
    );
    return;
  }
  if (!client) throw new Error('--connection required');
  if (command === 'apply') {
    const journalFile = values.out ?? path.resolve('.paqvilo/dataverse', `apply-${randomUUID()}.json`);
    const result = await applyManifest(manifest, {
      client,
      journalFile,
      expectedOrganisationId: connection.organisationId,
    });
    output({
      state: result.state,
      components: result.entries.length,
      journalFile: path.resolve(journalFile),
      next: 'Publish, check key activation, then export.',
    });
    return;
  }
  await client.verify(connection.organisationId);
  if (command === 'audit-lookups') {
    output(await completeLookupAuditing(manifest, client));
    return;
  }
  if (command === 'scope-solutions') {
    const journalFile = values.out ?? path.resolve('.paqvilo/dataverse', `solution-scoping-${randomUUID()}.json`),
      journal = { startedAt: new Date().toISOString(), state: 'Running', entries: [] };
    await privateJson(journalFile, journal, true);
    try {
      const result = await scopeSolutionRoots(manifest, client, {
        onProgress: async (event) => {
          journal.entries.push(event);
          await privateJson(journalFile, journal);
        },
      });
      journal.state = 'Completed';
      journal.result = result;
      await privateJson(journalFile, journal);
      output({ ...result, journalFile: path.resolve(journalFile) });
    } catch (error) {
      journal.state = 'Interrupted';
      journal.error = { code: error.code ?? 'SCOPING_STOPPED', message: error.message };
      await privateJson(journalFile, journal);
      throw error;
    }
    return;
  }
  if (command === 'publish') output(await publishManifest(manifest, client));
  else {
    const result = await checkKeys(manifest, client);
    output(result);
    if (!result.ready) process.exitCode = 2;
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: { code: error.code ?? 'DATAVERSE_COMMAND_FAILED', message: error.message } }),
  );
  process.exitCode = 1;
});
