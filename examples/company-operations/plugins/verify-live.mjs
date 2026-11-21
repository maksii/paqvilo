import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient, retrieveFetchXml } from '../../../lense/dataverse/index.mjs';
import { cli, isMain, UsageError } from '../cli.mjs';
import { connectionHelp, defaultConnection } from '../paths.mjs';

const usage = `Usage: node examples/company-operations/plugins/verify-live.mjs [--connection FILE]
       node examples/company-operations/plugins/verify-live.mjs --cleanup RUN_ID [--apply] [--connection FILE]

Run from the toolkit checkout. Runs the SDK qualification profiles in the live environment (writes test records) and
saves the example's ignored .paqvilo/plugins/qualification.json. Each run leaves its rows as evidence: one test run,
one CRUD probe, one test operation per case, and the chain nodes and plug-in events the plug-ins record for them
(audit-evidence.mjs reads the events). The final line names the run ID and the passed and failed counts; the exit
code is 2 when any case failed.

Precondition: no other synchronous plug-in steps run on every Create or on chain nodes (for example an environment-wide
recorder). They slow each nested operation so much that the deep P09 chains hit the plug-in's 60-second suite budget
before the platform's depth limit; the run names such assemblies first and reports those cases as SuiteBudgetExceeded.

${connectionHelp('  --connection FILE  ')}
  --cleanup RUN_ID   list the rows of that run of this tool (read-only) instead of running the profiles
  --apply            with --cleanup, delete exactly those rows: chain nodes, probes, plug-in events, test operations
                     and the test run`;

/** Steps of other (non-Microsoft) assemblies that run synchronously inside every chain hop. */
export async function foreignSynchronousSteps(client, labAssemblies) {
  const rows = await client.list(
    "sdkmessageprocessingsteps?$select=stage&$filter=statecode eq 0 and mode eq 0 and customizationlevel eq 1 and sdkmessageid/name eq 'Create' and (_sdkmessagefilterid_value eq null or sdkmessagefilterid/primaryobjecttypecode eq 'pqvd_chainnode')&$expand=plugintypeid($select=assemblyname)",
  );
  const counts = {};
  for (const row of rows) {
    const assembly = row.plugintypeid?.assemblyname ?? '(unknown)';
    if (!assembly.startsWith('Microsoft.') && !labAssemblies.includes(assembly))
      counts[assembly] = (counts[assembly] ?? 0) + 1;
  }
  return Object.entries(counts).map(([assembly, steps]) => ({ assembly, steps }));
}

/** A P09 depth case that failed: the platform's depth fault passes; the lab's own time budget is not a depth result. */
export function depthFault(error, rollback, foreign) {
  const message = error.message ?? '';
  if (/suite wall-clock budget exceeded/i.test(message))
    return {
      status: 'Failed',
      outcome: 'SuiteBudgetExceeded',
      cause: foreign.length
        ? `synchronous steps of ${foreign.map((f) => f.assembly).join(', ')} slow every hop; pause them and rerun`
        : 'the chain exceeded the 60-second suite budget before the platform depth limit',
    };
  return {
    status: rollback && /depth|loop|recursive|cancel/i.test(message) ? 'Passed' : 'Failed',
    outcome: 'PlatformFault',
  };
}

// Like data:compare: 2 is a completed run with failed cases (1 is an error that stopped the run).
export const qualificationExitCode = (outcomes) => (outcomes.some((o) => o.status !== 'Passed') ? 2 : 0);

const SEALED = /^ChainStep:[0-9a-f-]{36}$/i;
const tagged = (path, tag) => `${path}?tag=${encodeURIComponent(tag)}`;

// Dataverse runs a chain-node Delete as SYSTEM under an internal ObjectModel parent, so ChainNodeGuard accepts it only
// for a node sealed with its registered chain step (`ChainStep:<step id>`), initiated by the sole trusted SDK writer,
// with a same-operation ancestor: the request's `CO-OP:<operation>` tag. DepthChain does not copy the seal to the nodes
// it creates, so each unsealed node first gets the seal of its nearest sealed ancestor (an Update the guard allows the
// trusted writer). Returns node id -> seal for the unsealed nodes.
function chainSeals(nodes, runId) {
  const sealed = (node) => SEALED.test(node?.pqvd_configstatus ?? '');
  const byId = new Map(nodes.map((node) => [node.pqvd_chainnodeid, node]));
  const seals = new Map();
  for (const node of nodes.filter((n) => !sealed(n))) {
    let ancestor = byId.get(node._pqvd_parentnodeid_value);
    for (let hops = 0; ancestor && !sealed(ancestor) && hops < nodes.length; hops++)
      ancestor = byId.get(ancestor._pqvd_parentnodeid_value);
    if (!sealed(ancestor))
      throw new Error(
        `Chain node ${node.pqvd_chainnodeid} of run ${runId} has no sealed chain-step ancestor, so the chain guard refuses its delete; nothing was deleted.`,
      );
    seals.set(node.pqvd_chainnodeid, ancestor.pqvd_configstatus);
  }
  return seals;
}

// Parent lookups restrict deletion: remove nodes no remaining node points to, children first.
async function deleteChainNodes(client, nodes, runId) {
  let left = nodes;
  while (left.length) {
    const parents = new Set(left.map((node) => node._pqvd_parentnodeid_value).filter(Boolean));
    const leaves = left.filter((node) => !parents.has(node.pqvd_chainnodeid));
    if (!leaves.length)
      throw new Error(`Chain nodes of run ${runId} reference each other in a cycle; delete them by hand.`);
    for (const node of leaves) {
      const tag = 'CO-OP:' + node._pqvd_operationid_value;
      await client.request(tagged(`pqvd_chainnodes(${node.pqvd_chainnodeid})`, tag), { method: 'DELETE' });
    }
    left = left.filter((node) => !leaves.includes(node));
  }
}

// EvidenceWriteGuard admits an event Delete only through its owned-evidence contract: an immutable maintenance intent of
// the same run (at most 30 minutes old) naming the event, its operation and payload hash, and the request tag
// CO-OWNED-EVIDENCE-DELETE:<intent>. The intents are test operations of the run and go with the others.
async function deleteOwnedEvent(client, event, runId) {
  const intent = randomUUID();
  await client.request('pqvd_testoperations', {
    method: 'POST',
    body: {
      pqvd_testoperationid: intent,
      pqvd_name: 'SHA256:' + event.pqvd_payloadhash,
      pqvd_pairkey: event._pqvd_operationid_value,
      pqvd_caseid: 'ARCHIVE-OWNED-EVENT:' + event.pqvd_plugineventid,
      pqvd_lane: 183270002,
      pqvd_phase: 183270001,
      pqvd_attempt: 1,
      pqvd_pagenumber: 1,
      pqvd_expectedmessage: 'Delete',
      pqvd_roottable: 'pqvd_pluginevent',
      'pqvd_runid@odata.bind': `/pqvd_testruns(${runId})`,
    },
  });
  const tag = 'CO-OWNED-EVIDENCE-DELETE:' + intent;
  await client.request(tagged(`pqvd_pluginevents(${event.pqvd_plugineventid})`, tag), { method: 'DELETE' });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lists (and with `apply` deletes) the rows one verify-live run created. Refuses a run this tool did not create or one
 * that other rows (results, canary equipment, baseline runs) depend on. Deleting nodes and the probe makes the
 * observers record more events for the run's operations, so events are listed again before they are deleted.
 */
export async function cleanupRun(client, runId, { apply = false } = {}) {
  const run = await client.optional(`pqvd_testruns(${runId})?$select=pqvd_name,pqvd_suiteversion,pqvd_environment`);
  if (!run) throw new Error(`Test run ${runId} was not found; there is nothing to clean up.`);
  if (
    run.pqvd_suiteversion !== 'plugin-v1' ||
    run.pqvd_environment !== 'Dataverse.SDK.ApplicationIdentity' ||
    !String(run.pqvd_name).startsWith('Live SDK qualification ')
  )
    throw new Error(`Test run ${runId} was not created by verify-live.mjs; it is left alone.`);
  const foreign = [
    ...(await client.list(`pqvd_testresults?$select=pqvd_testresultid&$filter=_pqvd_runid_value eq ${runId}`)),
    ...(await client.list(`pqvd_equipments?$select=pqvd_equipmentid&$filter=_pqvd_canaryrunid_value eq ${runId}`)),
    ...(await client.list(`pqvd_testruns?$select=pqvd_testrunid&$filter=_pqvd_baselinerunid_value eq ${runId}`)),
  ];
  if (foreign.length)
    throw new Error(
      `Test run ${runId} has ${foreign.length} result, equipment or baseline-run rows that verify-live.mjs does not create; it is left alone.`,
    );
  const operations = (
    await client.list(`pqvd_testoperations?$select=pqvd_testoperationid&$filter=_pqvd_runid_value eq ${runId}`)
  ).map((row) => row.pqvd_testoperationid);
  const probes = (
    await client.list(`pqvd_crudprobes?$select=pqvd_crudprobeid&$filter=_pqvd_runid_value eq ${runId}`)
  ).map((row) => row.pqvd_crudprobeid);
  const byOperation = async (set, select) => {
    const rows = [];
    for (const operation of operations)
      rows.push(...(await client.list(`${set}?$select=${select}&$filter=_pqvd_operationid_value eq ${operation}`)));
    return rows;
  };
  const nodes = await byOperation(
    'pqvd_chainnodes',
    'pqvd_chainnodeid,_pqvd_parentnodeid_value,_pqvd_operationid_value,pqvd_configstatus',
  );
  const seals = chainSeals(nodes, runId);
  const events = () => byOperation('pqvd_pluginevents', 'pqvd_plugineventid,_pqvd_operationid_value,pqvd_payloadhash');
  const listed = await events();
  const unbindable = listed.find((event) => !/^[a-f0-9]{64}$/.test(event.pqvd_payloadhash ?? ''));
  if (unbindable)
    throw new Error(
      `Plug-in event ${unbindable.pqvd_plugineventid} of run ${runId} has no full payload hash, so no maintenance intent can bind it; nothing was deleted.`,
    );
  const planned = {
    chainNodes: nodes.length,
    crudProbes: probes.length,
    pluginEvents: listed.length,
    testOperations: operations.length,
    testRuns: 1,
  };
  if (!apply)
    return {
      runId,
      state: 'CleanupPlan',
      seal: { chainNodes: seals.size },
      create: { maintenanceIntents: planned.pluginEvents },
      delete: planned,
    };
  const remove = (set, id) => client.request(`${set}(${id})`, { method: 'DELETE' });
  for (const [node, seal] of seals)
    await client.request(`pqvd_chainnodes(${node})`, {
      method: 'PATCH',
      ifMatch: '*',
      body: { pqvd_configstatus: seal },
    });
  await deleteChainNodes(client, nodes, runId);
  for (const probe of probes) await remove('pqvd_crudprobes', probe);
  const recorded = await events();
  for (const event of recorded) await deleteOwnedEvent(client, event, runId);
  const finalOperations = await client.list(
    `pqvd_testoperations?$select=pqvd_testoperationid&$filter=_pqvd_runid_value eq ${runId}`,
  );
  for (const { pqvd_testoperationid } of finalOperations) await remove('pqvd_testoperations', pqvd_testoperationid);
  await remove('pqvd_testruns', runId);
  return {
    runId,
    state: 'CleanedUp',
    sealed: { chainNodes: seals.size },
    created: { maintenanceIntents: recorded.length },
    deleted: { ...planned, pluginEvents: recorded.length, testOperations: finalOperations.length },
  };
}

async function main() {
  const { values } = cli(usage, {
    connection: { type: 'string' },
    cleanup: { type: 'string' },
    apply: { type: 'boolean' },
  });
  if (values.apply && values.cleanup === undefined) throw new UsageError('--apply only applies with --cleanup RUN_ID.');
  if (values.cleanup !== undefined && !GUID.test(values.cleanup))
    throw new UsageError(`--cleanup needs the run ID (a GUID) that verify-live.mjs printed, not ${values.cleanup}.`);
  const connection = await loadConnection(values.connection ?? defaultConnection);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const client = connectedClient(connection);
  const who = await client.verify(connection.organisationId);
  if (values.cleanup !== undefined) {
    const result = await cleanupRun(client, values.cleanup.toLowerCase(), { apply: values.apply === true });
    console.log(
      JSON.stringify(
        result.state === 'CleanupPlan' ? { ...result, next: 'rerun with --apply to delete these rows' } : result,
      ),
    );
    return;
  }
  const out = resolve(project, '.paqvilo/plugins');
  await mkdir(out, { recursive: true });
  const fetchNative = client.fetch;
  client.fetch = async (...params) => {
    const r = await fetchNative(...params);
    if (!r.ok) {
      const e = await r
        .clone()
        .json()
        .catch(() => null);
      await writeFile(
        resolve(out, 'qualification-last-error.json'),
        JSON.stringify(
          { status: r.status, code: e?.error?.code, message: String(e?.error?.message ?? '').slice(0, 2500) },
          null,
          2,
        ),
      );
    }
    return r;
  };
  const registry = JSON.parse(await readFile(resolve(project, 'plugins/registrations.json'), 'utf8'));
  const foreign = await foreignSynchronousSteps(
    client,
    registry.assemblies.map((a) => a.name),
  );
  if (foreign.length)
    console.log(
      JSON.stringify({
        precondition: 'NotMet',
        foreignSynchronousSteps: foreign,
        effect: 'deep P09 cases are expected to fail with SuiteBudgetExceeded; pause these steps and rerun',
      }),
    );
  await qualify({ client, who, out, project, foreign });
}

if (isMain(import.meta)) await main();

// NOSONAR below: the qualification script body, unchanged, moved into a function so the module can be imported.
/* NOSONAR */ async function qualify({ client, who, out, project, foreign }) {
  const catalogue = JSON.parse(await readFile(resolve(project, 'data/catalogue.json'), 'utf8'));
  const person = catalogue.records.find((r) => r.key === 'P01');
  const nonce = randomUUID();
  const runId = randomUUID();
  const probeId = randomUUID();
  const hash = createHash('sha256')
    .update(await readFile(resolve(project, 'dataverse/manifest.json')))
    .digest('hex');
  await client.request('pqvd_testruns', {
    method: 'POST',
    body: {
      pqvd_testrunid: runId,
      pqvd_name: 'Live SDK qualification ' + nonce,
      pqvd_runkey: nonce,
      pqvd_suiteversion: 'plugin-v1',
      pqvd_manifesthash: hash,
      pqvd_datasetversion: catalogue.version,
      pqvd_environment: 'Dataverse.SDK.ApplicationIdentity',
      pqvd_startedat: new Date().toISOString(),
      pqvd_runstate: 183270000,
      pqvd_rolesnapshot: JSON.stringify({
        source: 'SDK application identity; not portal authorization',
        userId: who.applicationUserId,
      }),
      'pqvd_runnercontactid@odata.bind': `/contacts(${person.id})`,
    },
  });
  await client.request('pqvd_crudprobes', {
    method: 'POST',
    body: {
      pqvd_crudprobeid: probeId,
      pqvd_name: 'SDK qualification probe',
      pqvd_token: nonce,
      pqvd_counter: 0,
      'pqvd_runid@odata.bind': `/pqvd_testruns(${runId})`,
      'pqvd_ownercontactid@odata.bind': `/contacts(${person.id})`,
    },
  });
  const outcomes = [];
  let operationCount = 0;
  async function operation(caseId, table = 'pqvd_crudprobe', message = 'Update') {
    const id = randomUUID();
    operationCount++;
    await client.request('pqvd_testoperations', {
      method: 'POST',
      body: {
        pqvd_testoperationid: id,
        pqvd_name: caseId + ' ' + id,
        pqvd_pairkey: randomUUID(),
        pqvd_caseid: caseId,
        pqvd_lane: 183270002,
        pqvd_variant: 'live-qualification',
        pqvd_phase: 183270001,
        pqvd_attempt: 1,
        pqvd_pagenumber: 1,
        pqvd_expectedmessage: message,
        pqvd_roottable: table,
        'pqvd_runid@odata.bind': `/pqvd_testruns(${runId})`,
      },
    });
    return await client.get(`pqvd_testoperations(${id})`);
  }
  async function complete(outcome) {
    if (outcome.operationId)
      await client.request(`pqvd_testoperations(${outcome.operationId})`, {
        method: 'PATCH',
        body: {
          pqvd_clientsummary: JSON.stringify({
            ...outcome,
            source: 'LiveSDK.ApplicationIdentity.NotPortalAuthorization',
          }),
          pqvd_clientfinishedat: new Date().toISOString(),
        },
      });
  }
  const readOp = await operation('SDK-Marked-Fetch', 'account', 'RetrieveMultiple');
  const xml = `<fetch><entity name="account"><attribute name="accountid"/><attribute name="name"/><filter type="and"><condition attribute="accountnumber" operator="begins-with" value="CO-"/><filter type="or"><condition attribute="name" operator="null"/><filter type="and"><condition attribute="name" operator="ne" value="${readOp.pqvd_markerutc}"/><condition attribute="name" operator="ne" value="${readOp.pqvd_markeroperation}"/></filter></filter></filter></entity></fetch>`;
  try {
    const result = await retrieveFetchXml(client, { entitySet: 'accounts', fetchXml: xml });
    const events = await client.list(
      `pqvd_pluginevents?$select=pqvd_artifacttype,pqvd_stage,pqvd_payloadtext,pqvd_payloadhash,pqvd_partnumber,pqvd_partcount&$filter=_pqvd_operationid_value eq ${readOp.pqvd_testoperationid}`,
    );
    outcomes.push({
      caseId: 'SDK-Marked-Fetch',
      operationId: readOp.pqvd_testoperationid,
      status: events.length >= 4 ? 'Passed' : 'MissingBackendEvidence',
      returnedCount: result.rows.length,
      events: events.map((e) => ({
        artifact: e.pqvd_artifacttype,
        stage: e.pqvd_stage,
        hash: e.pqvd_payloadhash,
        parts: e.pqvd_partcount,
      })),
    });
  } catch (e) {
    outcomes.push({ caseId: 'SDK-Marked-Fetch', status: 'Failed', code: e.code, http: e.status });
  }
  for (const scenario of ['ABC', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P10', 'P11', 'P12']) {
    const op = await operation(scenario);
    try {
      await client.request(`pqvd_crudprobes(${probeId})`, {
        method: 'PATCH',
        body: {
          'pqvd_activeoperationid@odata.bind': `/pqvd_testoperations(${op.pqvd_testoperationid})`,
          pqvd_pluginscenario: scenario,
          pqvd_hopbudget: 3,
          pqvd_triggernonce: randomUUID(),
          pqvd_counter: outcomes.length,
        },
      });
      const events = await client.list(
        `pqvd_pluginevents?$select=pqvd_artifacttype,pqvd_depth,pqvd_message,pqvd_stage,pqvd_provenance,pqvd_querytype,pqvd_payloadtext&$filter=_pqvd_operationid_value eq ${op.pqvd_testoperationid}`,
      );
      const nodes = await client.list(
        `pqvd_chainnodes?$select=pqvd_nodecode,pqvd_hop&$filter=_pqvd_operationid_value eq ${op.pqvd_testoperationid}`,
      );
      const snapshots = events.map((e) => JSON.parse(e.pqvd_payloadtext));
      outcomes.push({
        caseId: scenario,
        operationId: op.pqvd_testoperationid,
        status:
          events.some((e) => e.pqvd_artifacttype === 'ChainA') &&
          events.some((e) => e.pqvd_artifacttype === 'ChainB') &&
          events.some((e) => e.pqvd_artifacttype === 'ChainC')
            ? 'Passed'
            : 'MissingBackendEvidence',
        events: events.length,
        nodes: nodes.length,
        maxObservedDepth: Math.max(...events.map((e) => e.pqvd_depth ?? 0)),
        messages: [...new Set(events.map((e) => e.pqvd_message))],
        queryTypes: [...new Set(events.map((e) => e.pqvd_querytype).filter(Boolean))],
        beforeImages: snapshots.filter((s) => s.context.preImages?.Before).length,
        afterImages: snapshots.filter((s) => s.context.postImages?.After).length,
        secureVersionLabels: [
          ...new Set(snapshots.map((s) => s.content?.secureConfiguration?.version).filter(Boolean)),
        ],
        secretValueRecorded: events.some((e) => e.pqvd_payloadtext.includes('syntheticSecret')),
      });
    } catch (e) {
      const error = JSON.parse(await readFile(resolve(out, 'qualification-last-error.json'), 'utf8').catch(() => '{}'));
      outcomes.push({
        caseId: scenario,
        operationId: op.pqvd_testoperationid,
        status: 'Failed',
        code: error.code ?? e.code,
        http: e.status,
        safeMessage: error.message,
      });
    }
    await complete(outcomes.at(-1));
    await writeFile(resolve(out, 'qualification-progress.json'), JSON.stringify({ runId, probeId, outcomes }, null, 2));
    console.log(JSON.stringify(outcomes.at(-1)));
  }
  for (const budget of [1, 3, 7, 8, 9, 10]) {
    const op = await operation(`P09-Depth-${budget}`);
    const previous = await client.get(
      `pqvd_crudprobes(${probeId})?$select=pqvd_triggernonce,_pqvd_activeoperationid_value`,
    );
    try {
      await client.request(`pqvd_crudprobes(${probeId})`, {
        method: 'PATCH',
        body: {
          'pqvd_activeoperationid@odata.bind': `/pqvd_testoperations(${op.pqvd_testoperationid})`,
          pqvd_pluginscenario: 'P09',
          pqvd_hopbudget: budget,
          pqvd_triggernonce: randomUUID(),
        },
      });
      const events = await client.list(
        `pqvd_pluginevents?$select=pqvd_artifacttype,pqvd_depth&$filter=_pqvd_operationid_value eq ${op.pqvd_testoperationid}`,
      );
      outcomes.push({
        caseId: `P09-Depth-${budget}`,
        operationId: op.pqvd_testoperationid,
        status: 'Passed',
        outcome: 'Committed',
        maxObservedDepth: Math.max(...events.map((e) => e.pqvd_depth ?? 0)),
        depthHops: events.filter((e) => e.pqvd_artifacttype === 'DepthChain').length,
      });
    } catch {
      const error = JSON.parse(await readFile(resolve(out, 'qualification-last-error.json'), 'utf8'));
      const after = await client.get(
        `pqvd_crudprobes(${probeId})?$select=pqvd_triggernonce,_pqvd_activeoperationid_value`,
      );
      const nodes = await client.list(
        `pqvd_chainnodes?$select=pqvd_chainnodeid&$filter=_pqvd_operationid_value eq ${op.pqvd_testoperationid}`,
      );
      const rollback =
        after.pqvd_triggernonce === previous.pqvd_triggernonce &&
        after._pqvd_activeoperationid_value === previous._pqvd_activeoperationid_value &&
        nodes.length === 0;
      outcomes.push({
        caseId: `P09-Depth-${budget}`,
        operationId: op.pqvd_testoperationid,
        ...depthFault(error, rollback, foreign),
        code: error.code,
        safeMessage: error.message,
        rollbackVerified: rollback,
        durableFailedHopEvidence: false,
      });
    }
    await complete(outcomes.at(-1));
    console.log(JSON.stringify(outcomes.at(-1)));
  }
  const asyncCase = outcomes.find((o) => o.caseId === 'P10');
  for (let attempt = 0; attempt < 6 && asyncCase; attempt++) {
    const events = await client.list(
      `pqvd_pluginevents?$select=pqvd_mode,pqvd_artifacttype&$filter=_pqvd_operationid_value eq ${asyncCase.operationId} and pqvd_artifacttype eq 'AsyncContext'`,
    );
    if (events.length) {
      asyncCase.asyncObserved = true;
      asyncCase.asyncMode = events[0].pqvd_mode;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (asyncCase && !asyncCase.asyncObserved) asyncCase.asyncQualification = 'Pending.NoAsyncEventInObservationWindow';
  // Immutable markers cannot be overwritten, even by the SDK provisioner.
  try {
    await client.request(`pqvd_testoperations(${readOp.pqvd_testoperationid})`, {
      method: 'PATCH',
      body: { pqvd_markerutc: 'CO-UTC:2000-01-01T00:00:00.000Z' },
    });
    outcomes.push({ caseId: 'ImmutableMarkers', status: 'Failed' });
  } catch (e) {
    outcomes.push({ caseId: 'ImmutableMarkers', status: e.status === 400 ? 'Passed' : 'Failed', http: e.status });
  }
  const failed = outcomes.filter((o) => o.status !== 'Passed').length;
  const report = {
    schemaVersion: 1,
    source: 'Observed live Dataverse SDK/application identity',
    runId,
    probeId,
    environment: who,
    time: new Date().toISOString(),
    captureMode: 'TransactionalLab',
    durability: 'RollbackVulnerable',
    portalAuthorizationQualified: false,
    collectorReady: false,
    foreignSynchronousSteps: foreign,
    outcomes,
  };
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      runId,
      passed: outcomes.filter((o) => o.status === 'Passed').length,
      failed,
      report: resolve(out, 'qualification.json'),
      // The rows stay as evidence (audit-evidence.mjs reads this run's events); --cleanup removes exactly them.
      left: {
        testRun: runId,
        crudProbe: probeId,
        testOperations: operationCount,
        rest: "this run's chain nodes and plug-in events",
      },
      cleanup: `node examples/company-operations/plugins/verify-live.mjs --cleanup ${runId} [--apply]`,
    }),
  );
  process.exitCode = qualificationExitCode(outcomes);
}
