import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readClrDependency, canonicalClrDirectory } from 'paqvilo/mirage/lib/plugin-clr.mjs';
import { savePrivateJson } from '../portal-harness/private-journal.mjs';
const guid = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
/** Source-only pure SDK controls. Native writer prepares immutable SDK intents
 * and freezes the referenced records before invoking the read-only driver. */
export function planSdkProjectionProbes({ equipmentId, canaryRunId, markerUtc, operationId = () => randomUUID() }) {
  if (
    !guid(equipmentId) ||
    !guid(canaryRunId) ||
    !/^CO-UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(markerUtc ?? '')
  )
    throw new Error('SDK projection probes require exact owned Equipment/Run IDs and a source UTC marker.');
  const probes = [];
  const add = (id, kind, columnMode, extra = {}) => {
    const operation = operationId();
    if (!guid(operation) || probes.some((row) => row.operationId === operation))
      throw new Error('SDK controls require unique immutable operation identities.');
    probes.push({ id, kind, columnMode, operationId: operation, equipmentId, canaryRunId, markerUtc, ...extra });
  };
  for (const mode of ['empty', 'name', 'pk', 'all']) {
    add('QE-' + mode, 'QueryExpression', mode);
    add('Retrieve-' + mode, 'Retrieve', mode);
    add('Fetch-' + mode, 'FetchExpression', mode);
  }
  for (const distinct of [false, true]) add('Fetch-name-distinct-' + distinct, 'FetchExpression', 'name', { distinct });
  for (const totalCount of [null, false, true]) {
    add('QE-count-' + totalCount, 'QueryExpression', 'pk', { countFixture: true, totalCount });
    add('Fetch-count-' + totalCount, 'FetchExpression', 'pk', { countFixture: true, totalCount });
  }
  add('Fetch-min-active-row-version', 'FetchExpression', 'pk', { minActiveRowVersion: true });
  return {
    schemaVersion: 1,
    scope: 'Actual application SDK object/projection/count controls; no Portal permissions or impersonation',
    requiresPreparedIntents: true,
    probes,
  };
}

/** Sole native writer explicitly supplies its client and exact compiled-driver
 * receipt. No connection discovery, token persistence or caller impersonation. */
export async function executeSdkProjectionProbes({
  client,
  plan,
  executable,
  expectedDriverSha256,
  outputRoot,
  timeoutMs = 1200000,
}) {
  if (
    plan?.schemaVersion !== 1 ||
    plan.requiresPreparedIntents !== true ||
    !Array.isArray(plan.probes) ||
    plan.probes.length < 1 ||
    plan.probes.length > 32 ||
    typeof client?.token !== 'function' ||
    !/^https:\/\//.test(client.origin ?? '') ||
    !path.isAbsolute(executable ?? '') ||
    !/^[a-f\d]{64}$/.test(expectedDriverSha256 ?? '') ||
    !path.isAbsolute(outputRoot ?? '') ||
    !path.resolve(outputRoot).split(path.sep).includes('.paqvilo') ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 1200000
  )
    throw new Error(
      'Native SDK controls require explicit trusted driver/client, private output and bounded execution.',
    );
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex'),
    source = await canonicalClrDirectory(path.dirname(executable)),
    files = [];
  for (const name of [path.basename(executable), 'Microsoft.Xrm.Sdk.dll', 'Microsoft.Crm.Sdk.Proxy.dll']) {
    const opened = await readClrDependency(source, name);
    files.push({ name, bytes: opened.bytes, sha256: digest(opened.bytes) });
  }
  if (files[0].sha256 !== expectedDriverSha256)
    throw new Error('Native SDK driver does not match its compiled source receipt.');
  await fs.mkdir(outputRoot, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(outputRoot, 'execution-'))),
    journalFile = path.join(directory, 'journal.json'),
    receipt = {
      schemaVersion: 1,
      kind: 'NativeReadOnlySdkProjectionProbe',
      scope: plan.scope,
      plan,
      files: files.map(({ name, sha256 }) => ({ name, sha256 })),
      state: 'prepared',
      nativeQualified: false,
    };
  await savePrivateJson(journalFile, receipt, { exclusive: true });
  for (const file of files) await fs.writeFile(path.join(directory, file.name), file.bytes, { flag: 'wx' });
  const token = await client.token();
  if (typeof token !== 'string' || token.length > 65536 || /\s/.test(token))
    throw new Error('Native token provider returned an invalid private token.');
  const endpoint = new URL('/XRMServices/2011/Organization.svc/web', client.origin);
  endpoint.searchParams.set('SdkClientVersion', '9.0.0.0');
  receipt.state = 'pending';
  await savePrivateJson(journalFile, receipt);
  try {
    const bytes = await new Promise((resolve, reject) => {
      const child = spawn(path.join(directory, files[0].name), [], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        chunks = [];
      let size = 0,
        stderr = 0,
        failure;
      const timeout = setTimeout(() => {
        failure = new Error('Owned native SDK probe driver timed out.');
        child.kill();
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          failure = new Error('Native SDK probe exceeded bounded output.');
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.length;
        if (stderr > 65536) {
          failure = new Error('Native SDK probe exceeded bounded diagnostics.');
          child.kill();
        }
      });
      child.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('Owned native SDK driver failed to start.'));
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error('Native SDK driver failed; credentials and raw diagnostics withheld.'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ endpoint: endpoint.href, accessToken: token, probes: plan.probes }) + '\n');
    });
    const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length !== plan.probes.length) throw new Error('Native SDK control result inventory is incomplete.');
    const summaries = lines.map((line, index) => {
      const row = JSON.parse(line),
        expected = plan.probes[index];
      if (
        !['result', 'fault', 'failure'].includes(row.kind) ||
        (row.kind === 'result' ? row.value?.id : row.id) !== expected.id
      )
        throw new Error('Native SDK result order/source identity mismatched.');
      return { id: expected.id, kind: row.kind, operationId: expected.operationId };
    });
    const resultFile = path.join(directory, 'results.jsonl');
    await fs.writeFile(resultFile, bytes, { flag: 'wx' });
    Object.assign(receipt, {
      state: 'recorded',
      results: summaries,
      resultFile,
      resultSha256: digest(bytes),
      qualification:
        'Actual application SDK objects; source/schema/fixtures and native context comparison remain independent gates',
    });
    await savePrivateJson(journalFile, receipt);
    return { journalFile, resultFile, probes: summaries.length, nativeQualified: false };
  } catch (error) {
    receipt.state = 'failed';
    receipt.errorCode = error.code ?? error.name;
    await savePrivateJson(journalFile, receipt);
    throw error;
  }
}
