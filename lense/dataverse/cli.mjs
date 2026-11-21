#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseOptions, DATAVERSE_OPTIONS, DATAVERSE_COMMAND_OPTIONS } from '../cli-options.mjs';
import { dataverseCommandHelp } from '../cli-help.mjs';
import fs from 'node:fs/promises';

// Operational modules load only once help is ruled out, so help reads no file and contacts nothing.
let fileIdentity, sameFile, loadConnection, environmentOrigin, publicConnection, registerApplication;
let connectExistingApplication, privateJson, existingPathError, connectedClient, readManifest, planManifest;
let applyManifest, publishManifest, checkKeys, exportSolution, completeLookupAuditing, scopeSolutionRoots;
let readCatalogue, planData, applyData, compareData, runDataQueries;
async function loadOperations() {
  ({ fileIdentity, sameFile } = await import('../file-identity.mjs'));
  ({
    loadConnection,
    environmentOrigin,
    publicConnection,
    registerApplication,
    connectExistingApplication,
    privateJson,
    existingPathError,
  } = await import('./connection.mjs'));
  ({ connectedClient } = await import('./client.mjs'));
  ({ readManifest } = await import('./manifest.mjs'));
  ({
    planManifest,
    applyManifest,
    publishManifest,
    checkKeys,
    exportSolution,
    completeLookupAuditing,
    scopeSolutionRoots,
  } = await import('./provision.mjs'));
  ({ readCatalogue, planData, applyData, compareData, runDataQueries } = await import('./data.mjs'));
}

const HELP = `paqvilo dataverse — provision schema through Dataverse, then export it

  register --connection .paqvilo/dataverse/connection.json --name NAME [--role ROLE]
           [--environment HTTPS-ORG-ORIGIN]  Uses the active PAC administrator profile.
           Refused with REGISTRATION_EXISTS when any *.json file beside --connection
           records this environment or name, or when the tenant already lists an application
           with this name (matched by name); reuse it with inspect or verify. If PAC cannot
           list applications, registration stops. --allow-additional-application skips both
           checks and creates another app deliberately.
  inspect  --connection FILE               Show connection details without credentials.
  connect  --registration FILE --secret-file FILE --connection FILE [--role ROLE]
           [--consume-secret-file]  Finish a partial registration using the same app.
  verify   --connection FILE               Verify application identity and organisation.
  plan     --manifest FILE [--connection FILE] [--out FILE]
           No connection: offline payload plan. With connection: read-only reconciliation.
  apply    --manifest FILE --connection FILE [--out JOURNAL] [--update-labels]
           Create missing components. Refuse incompatible existing metadata; no deletes.
           --update-labels changes only the display labels and descriptions of declared
           tables and columns that a remote plan lists as labelsOnly.
  publish  --manifest FILE --connection FILE
           Publish only the declared tables/choices.
  keys     --manifest FILE --connection FILE
           Report asynchronous alternate-key activation; non-ready is not success.
  audit-lookups --manifest FILE --connection FILE
           Complete auditing on declared custom lookups after relationship creation.
  scope-solutions --manifest FILE --connection FILE [--out JOURNAL]
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

Run paqvilo dataverse <command> --help for what one command does, whether it changes
the live environment, and exactly the options it accepts; any other option is refused (exit 1).
All commands accept --json for machine-readable errors. Plans and data reports
print the full result alongside --out when --json is set.
Credentials use Windows DPAPI CurrentUser, or an environment-secret reference in a
connection file. PAC output/tokens are never printed. Registration is not retried
after an uncertain or partial outcome. Lense/Mirage commands do not provision.
`;

async function validateFileSelections(command, values) {
  if (command === 'connect') {
    const [registration, secret] = await Promise.all([
      fileIdentity(values.registration),
      fileIdentity(values['secret-file']),
    ]);
    if (sameFile(registration, secret)) throw new Error('--registration and --secret-file must be different files');
  }
  if (values.out === undefined) return;
  const output = await fileIdentity(values.out);
  for (const key of ['manifest', 'catalogue', 'connection']) {
    if (values[key] !== undefined && sameFile(output, await fileIdentity(values[key])))
      throw new Error(`--out must not overwrite --${key}`);
  }
  // These commands create --out exclusively; refuse an existing file before contacting Dataverse.
  if (output.stat && ['apply', 'scope-solutions', 'export', 'data-apply'].includes(command))
    throw existingPathError(values.out);
}

/** Refuses every option the command's help does not list, in one line that says where the supported ones are. */
async function refuseUnsupportedOptions(command, contract, values) {
  const unsupported = Object.keys(values)
    .filter((key) => key !== 'help' && !contract.allowed.includes(key))
    .map((key) => `--${key}`);
  if (unsupported.length)
    throw Object.assign(
      new Error(
        `${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not valid for dataverse ${command}; ` +
          `run ${await dataverseCommand([command, '--help'])} for its options.`,
      ),
      { code: 'unsupported_option' },
    );
}

/** `paqvilo dataverse <words>` as it runs where the user is (lense/command-hint.mjs), loaded only for a message. */
async function dataverseCommand(words) {
  const { paqviloCommand } = await import('../command-hint.mjs');
  return paqviloCommand(['dataverse', ...words]);
}

const FILE_PROBLEMS = {
  ENOENT: ['does not exist', 'check the path'],
  EACCES: ['cannot be accessed (permission denied)', 'check its permissions'],
  EPERM: ['cannot be accessed (operation not permitted)', 'check its permissions and that no program holds it open'],
  EISDIR: ['is a directory', 'give a file path'],
  ENOTDIR: ['has a parent that is not a directory', 'check the path'],
  EEXIST: ['already exists', 'choose another path or remove it'],
};

/** A file-system failure as one line naming the option whose path failed, the path and what to do. */
function fileFailureMessage(error, values) {
  const problem = typeof error?.path === 'string' && FILE_PROBLEMS[error.code];
  if (!problem) return null;
  const failed = path.resolve(error.path);
  const option = Object.keys(DATAVERSE_OPTIONS).find((key) => {
    if (typeof values[key] !== 'string' || !values[key]) return false;
    const selected = path.resolve(values[key]);
    return (
      failed === selected ||
      failed.startsWith(selected + '.') || // its temporary sibling
      failed.startsWith(selected + path.sep) || // inside a selected folder
      selected.startsWith(failed + path.sep) // a parent folder
    );
  });
  const subject = option ? `--${option} ${values[option]}` : failed;
  return `${subject} ${problem[0]}; ${problem[1]}.`;
}

/* NOSONAR */ function validateCommandValues(command, contract, values) {
  for (const key of contract.required) {
    if (!values[key]?.trim()) throw new Error(`--${key} required for dataverse ${command}`);
  }
  for (const key of contract.allowed) {
    if (typeof values[key] === 'string' && !values[key].trim()) throw new Error(`--${key} must not be empty`);
  }
  // Match exportSolution's identifier contract before loading credentials or contacting Dataverse.
  if (command === 'export' && !/^[a-z][a-z0-9_]*$/i.test(values.solution)) throw new Error('Invalid solution name.');
  if (command === 'register' && values.environment !== undefined) {
    try {
      environmentOrigin(values.environment);
    } catch {
      throw new Error('--environment must be an HTTPS organisation origin without credentials, query or path');
    }
  }
}

function executeEarlyCommand(command, values, output) {
  if (command === 'register') {
    return registerApplication({
      connectionFile: values.connection,
      environment: values.environment,
      applicationName: values.name,
      role: values.role,
      allowAdditionalApplication: values['allow-additional-application'],
    }).then(output);
  }
  if (command === 'connect') {
    return connectExistingApplication({
      registrationFile: values.registration,
      secretFile: values['secret-file'],
      connectionFile: values.connection,
      role: values.role,
      consumeSecretFile: values['consume-secret-file'],
    }).then(output);
  }
  if (command !== 'inspect') return null;
  return inspectDataverseConnection(values, output);
}

async function inspectDataverseConnection(values, output) {
  if (!values.connection) throw new Error('--connection required');
  const details = publicConnection(JSON.parse(await fs.readFile(values.connection, 'utf8')));
  if (details.environmentUrl != null) {
    try {
      const url = new URL(details.environmentUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid environment URL protocol');
      details.environmentUrl = `${url.origin}${url.pathname === '/' ? '' : url.pathname}${url.search ? '?[redacted]' : ''}`;
    } catch {
      throw new Error('Connection environmentUrl is invalid.');
    }
  }
  output(details);
}

function executeDataCommand(command, values, connection, client, output) {
  if (!['data-plan', 'data-apply', 'data-compare', 'data-query'].includes(command)) return null;
  return executeDataCommandBody(command, values, connection, client, output);
}

async function executeDataCommandBody(command, values, connection, client, output) {
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
  let result;
  if (command === 'data-plan') result = await planData(catalogue, { client });
  else if (command === 'data-compare') result = await compareData(catalogue, { client });
  else result = await runDataQueries(catalogue, { client });
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
}

async function executeManifestCommand(command, values, connection, client, output) {
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
            // Each drifted component with the declared properties that differ; values are in the saved plan.
            drift: plan.actions
              .filter((a) => a.status === 'drift')
              .map((a) =>
                a.differences?.length ? `${a.key} (${a.differences.map((d) => d.property).join(', ')})` : a.key,
              ),
            blockedRoots: plan.membership.filter((e) => e.operation === 'blocked').map((e) => e.objectId),
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
      updateLabels: values['update-labels'] === true,
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
    await executeSolutionScoping(manifest, values, client, output);
    return;
  }
  return publishOrCheckKeys(command, manifest, client, output);
}

function publishOrCheckKeys(command, manifest, client, output) {
  if (command === 'publish') return publishManifest(manifest, client).then(output);
  return checkKeys(manifest, client).then((result) => {
    output(result);
    if (!result.ready) process.exitCode = 2;
  });
}

async function executeSolutionScoping(manifest, values, client, output) {
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
}

const [command, ...args] = process.argv.slice(2);
let selectedValues = {};
async function main() {
  if (command === undefined || ['--help', '-h'].includes(command)) {
    console.log(HELP);
    return;
  }
  const options = Object.hasOwn(DATAVERSE_COMMAND_OPTIONS, command) ? DATAVERSE_COMMAND_OPTIONS[command] : null;
  if (!options)
    throw Object.assign(
      new Error(
        `Unknown dataverse command ${JSON.stringify(command)}; choose ${Object.keys(DATAVERSE_COMMAND_OPTIONS).join(', ')}. ` +
          `Run ${await dataverseCommand(['--help'])} for details.`,
      ),
      { code: 'unknown_command' },
    );
  const contract = { required: options.required, allowed: [...options.required, ...options.optional] };
  const { values } = parseOptions({ args, options: DATAVERSE_OPTIONS });
  await refuseUnsupportedOptions(command, contract, values);
  if (values.help) {
    console.log(dataverseCommandHelp(command));
    return;
  }
  selectedValues = values;
  await loadOperations();
  validateCommandValues(command, contract, values);
  await validateFileSelections(command, values);
  const output = (value) => console.log(JSON.stringify(value, null, 2));
  const earlyCommand = executeEarlyCommand(command, values, output);
  /* NOSONAR: optional pending promise, awaited only when set */ if (earlyCommand) {
    await earlyCommand;
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
  const dataCommand = executeDataCommand(command, values, connection, client, output);
  /* NOSONAR: optional pending promise, awaited only when set */ if (dataCommand) {
    await dataCommand;
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
  await executeManifestCommand(command, values, connection, client, output);
}
/* NOSONAR: module-level promise chain must not block evaluation */ main().catch((error) => {
  // JSON parser diagnostics can include credential-file contents.
  const message =
    error instanceof SyntaxError
      ? 'Invalid JSON input.'
      : (fileFailureMessage(error, selectedValues) ?? error.message.replace(/[\r\n]+/g, ' '));
  const terminator = args.indexOf('--');
  const json = args.slice(0, terminator < 0 ? args.length : terminator).includes('--json');
  if (json)
    console.log(JSON.stringify({ ok: false, error: { code: error.code ?? 'DATAVERSE_COMMAND_FAILED', message } }));
  else console.error(`paqvilo dataverse: ${message}`);
  process.exitCode = 1;
});
