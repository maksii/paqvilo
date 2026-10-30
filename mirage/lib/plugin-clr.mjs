import { initializePluginOperation } from './plugin-operation-context.mjs';
import { cloneStateData } from './state-clone.mjs';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { DataError } from './data-error.mjs';
import { pluginFailure } from './plugin-fault.mjs';
import { bypassStepIds as parseBypassStepIds } from './plugin-bypass.mjs';
import { pluginInvocationDepth, pluginInvocationSdkParent } from './plugin-execution-lifetime.mjs';
import {
  asyncMultipleJobParent,
  asynchronousParentChain,
  clrSdkEntryContext,
  mainOperationParent,
  observedParentChain,
  selectSdkEntryParent,
} from './plugin-sdk-parent.mjs';
import { delegatedPluginParent } from './plugin-delegation.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { localOrganizationService, validateServiceProfile, sdkValueToRecord } from './local-organization-service.mjs';
import {
  queryExpressionToFetch,
  prepareFetchForSdk,
  fetchResultToSdkCollection,
  sdkReadColumns,
} from './plugin-sdk-query.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { dateTimeBehavior } from './dataverse-values.mjs';
import { imageAttributes } from './plugin-images.mjs';
import { captureSdkResponse } from './plugin-response.mjs';
import { isElastic, samePartition } from './dataverse-elastic.mjs';
import { convertSdkQuery } from './plugin-query-conversion.mjs';
import { CRM_FUNCTIONS } from './dataverse-conditions.mjs';
import { runtimeConstructorSettings } from './plugin-constructor-configuration.mjs';
import { validateSdkTag, canonicalTagParent } from './plugin-request-tag.mjs';
import { executePlatformSdkMessage, isPlatformSdkMessage } from './plugin-platform-messages.mjs';
import {
  executePluginServiceCall,
  executeSdkOrganizationMessage,
  organizationApiOf,
  sdkFault,
} from './plugin-sdk-messages.mjs';
import { formatPipelineTargets, pipelineFormattedValues } from './plugin-formatted-values.mjs';
import { privilegeDeniedError } from './dataverse-security.mjs';
import { bridgeTargetInputs, bulkTargetsCollection } from './plugin-single-multiple.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex'),
  uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = (message, code = 'LocalPluginClrConfiguration', status = 409) => {
  throw new DataError(message, status, code);
};
const canon = (id) =>
  String(id ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const hostSource = fileURLToPath(new URL('./plugin-clr-host.cs', import.meta.url));
let executionDepth = 0;
// The nested plug-in Depth cap. Native evidence: a synchronous Create chain reached Depth 10 and the request
// succeeded (the documented on-premises default of 8 does not apply online); the native limit itself is not observed.
export const PLUGIN_MAX_DEPTH = 16;
// An invocation's deadline includes its nested SDK calls (and their plug-ins). Native plug-in execution and the whole
// message operation are limited to 2 minutes (Learn: Analyze plug-in performance), so a descriptor may ask up to that.
const CLR_MAX_TIMEOUT_MS = 120_000;
export const PLUGIN_DEPTH_MESSAGE = `Plug-in nested execution depth exceeds ${PLUGIN_MAX_DEPTH}.`;
let parentStartTicks;
function clrParentIdentity(executable) {
  if (!parentStartTicks) {
    // This starts the CLR only to read the owning Node process's birth time.
    // Cold CLR/OS startup gets its own finite allowance, before plugin execution.
    const answer = spawnSync(executable, ['--process-start', String(process.pid)], {
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024,
    });
    if (answer.status !== 0 || !/^\d{1,19}$/.test(answer.stdout ?? ''))
      fail(
        'Owned CLR host cannot bind its parent process incarnation.' +
          (answer.error?.code === 'ETIMEDOUT' ? ' Parent identity probe exceeded its 30-second startup limit.' : ''),
        'LocalPluginParentUnavailable',
      );
    parentStartTicks = answer.stdout;
  }
  return { parentProcessId: process.pid, parentStartTicks };
}
const pooledHosts = new Map();
process.once('exit', () => {
  for (const session of pooledHosts.values())
    if (session.pid)
      try {
        process.kill(session.pid);
      } catch {
        /* Best-effort diagnostics and teardown must not mask the primary plugin result. */
      }
});
// One Depth per synchronous execution chain, shared by CLR steps and JavaScript handlers (exported-plugins.mjs), so an
// alternating JS/CLR chain is capped at PLUGIN_MAX_DEPTH in total and each side reports the same contiguous Depth. Both paths run
// synchronously (CLR waits with Atomics.wait), so the counter is balanced within one call stack.
export const pluginExecutionDepth = () => executionDepth;
export const enterPluginExecution = () => ++executionDepth;
export const leavePluginExecution = () => {
  executionDepth--;
};
function clrTimeout(descriptor) {
  const value = descriptor.timeoutMs;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    fail('CLR timeoutMs must be a positive safe integer in milliseconds.');
  return Math.max(100, Math.min(value ?? CLR_MAX_TIMEOUT_MS, CLR_MAX_TIMEOUT_MS));
}
export function validateClrDescriptor(value) {
  if (!value || typeof value !== 'object' || value.trust !== 'execute-local-assembly')
    fail('CLR execution requires an explicit trusted project assembly descriptor.');
  clrTimeout(value);
  for (const key of ['root', 'sdkRoot', 'cacheRoot'])
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key]))
      fail('CLR ' + key + ' must be an explicit absolute project/toolchain path.');
  for (const key of ['assembly', 'sdkAssembly'])
    if (
      typeof value[key] !== 'string' ||
      path.isAbsolute(value[key]) ||
      !value[key].toLowerCase().endsWith('.dll') ||
      value[key]
        .replaceAll('\\', '/')
        .split('/')
        .some((p) => !p || p === '.' || p === '..' || p.includes(':'))
    )
      fail('CLR ' + key + ' must be a confined relative DLL path.');
  if (typeof value.typeName !== 'string' || !/^[_a-z][\w.+`]{0,249}$/i.test(value.typeName))
    fail('An exact original CLR typeName is required.');
  if (value.persistentHost !== undefined && typeof value.persistentHost !== 'boolean')
    fail('CLR persistentHost must be an explicit Boolean opt-in.');
  if (
    value.dependencies !== undefined &&
    (!Array.isArray(value.dependencies) ||
      value.dependencies.length > 100 ||
      value.dependencies.some(
        (p) =>
          typeof p !== 'string' ||
          path.isAbsolute(p) ||
          !p.endsWith('.dll') ||
          p
            .replaceAll('\\', '/')
            .split('/')
            .some((p) => !p || p === '.' || p === '..' || p.includes(':')),
      ))
  )
    fail('CLR dependencies must be confined relative DLL paths.');
  if (
    !uuid.test(value.context?.initiatingUserId ?? '') ||
    !uuid.test(value.context?.organizationId ?? '') ||
    !uuid.test(value.context?.businessUnitId ?? '')
  )
    fail('Explicit initiating user, organization and business unit context GUIDs are required.');
  if (value.sdkCallerProfiles !== undefined) {
    if (
      !Array.isArray(value.sdkCallerProfiles) ||
      value.sdkCallerProfiles.length > 32 ||
      new Set(value.sdkCallerProfiles.map((profile) => canon(profile?.userId))).size !== value.sdkCallerProfiles.length
    )
      fail('SDK caller profiles require a bounded unique list of explicitly authorized identities.');
    for (const profile of value.sdkCallerProfiles) validateServiceProfile(profile);
  }
  if (value.context.interfaceVersion !== undefined && ![4, 7].includes(value.context.interfaceVersion))
    fail('CLR context interfaceVersion supports only 4 or explicitly observed 7.');
  for (const field of ['executionUserId', 'tenantId'])
    if (value.context[field] !== undefined && !uuid.test(value.context[field]))
      fail('CLR context ' + field + ' must be a GUID.');
  if (
    (value.context.mainOperationStepId !== undefined || value.context.mainOperationStepEvidence !== undefined) &&
    (!uuid.test(value.context.mainOperationStepId ?? '') ||
      typeof value.context.mainOperationStepEvidence !== 'string' ||
      !value.context.mainOperationStepEvidence.trim() ||
      value.context.mainOperationStepEvidence.length > 2048)
  )
    fail('A custom API main-operation step requires a GUID and bounded source evidence.');
  if (
    value.context.interfaceVersion === 7 &&
    (typeof value.context.environmentId !== 'string' ||
      typeof value.context.isApplicationUser !== 'boolean' ||
      typeof value.context.initiatingUserAgentPresent !== 'boolean' ||
      !uuid.test(value.context.tenantId ?? ''))
  )
    fail('Context7 requires explicit environment, tenant, application-user and user-agent-presence observations.');
  if (value.context.portalInputParameters !== undefined) {
    const values = value.context.portalInputParameters;
    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).length > 16 ||
      Object.entries(values).some(
        ([key, item]) =>
          !['AppModuleId', 'IsAppModuleContext', 'IncludeAnnotations'].includes(key) ||
          (key === 'AppModuleId' && (item?.$type !== 'Guid' || !uuid.test(item.value ?? ''))) ||
          (['IsAppModuleContext', 'IncludeAnnotations'].includes(key) && typeof item !== 'boolean'),
      )
    )
      fail('Portal input observations support only a typed AppModuleId and Boolean app-module/annotation flags.');
  }
  if (value.context.operationCreatedOn !== undefined) {
    const clock = value.context.operationCreatedOn,
      evidence = value.context.operationCreatedOnEvidence;
    if (
      typeof clock !== 'string' ||
      !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(clock) ||
      !Number.isFinite(Date.parse(clock)) ||
      new Date(Date.parse(clock)).toISOString().slice(0, 19) !== clock.slice(0, 19) ||
      typeof evidence !== 'string' ||
      !evidence.trim() ||
      evidence.length > 2048
    )
      fail(
        'Observed framework operationCreatedOn requires a valid canonical UTC timestamp and bounded source evidence.',
      );
  }
  if (value.context.emptyFetchPagingCookie !== undefined)
    fail('Empty Fetch paging cookies must be derived from the executed query, not a CLR context override.');
  validateServiceProfile(value.serviceProfile);
  return value;
}
function pathParts(file) {
  const absolute = path.resolve(file),
    anchor = path.parse(absolute).root;
  let current = anchor;
  return absolute
    .slice(anchor.length)
    .split(path.sep)
    .filter(Boolean)
    .map((part) => (current = path.join(current, part)));
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const CLR_FILE_LIMIT = 32 * 1024 * 1024;
async function readClrBytes(handle) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(65536, CLR_FILE_LIMIT - total + 1));
    const { bytesRead } = await handle.read({ buffer, offset: 0, length: buffer.length, position: null });
    if (!bytesRead) break;
    total += bytesRead;
    if (total > CLR_FILE_LIMIT) fail('CLR dependency must be a regular DLL of at most 32 MiB.');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
function readClrBytesSync(fd) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(Math.min(65536, CLR_FILE_LIMIT - total + 1));
    const bytesRead = syncFs.readSync(fd, buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > CLR_FILE_LIMIT) fail('Trusted CLR bytes changed after preparation.', 'LocalPluginSourceChanged', 409);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}
/** Canonical spelling may differ on Windows; actual link components remain forbidden. */
export async function canonicalClrDirectory(directory) {
  for (const part of pathParts(directory)) {
    const stat = await fs.lstat(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('CLR cache root cannot use a symlink.');
  }
  return fs.realpath(directory);
}
function canonicalClrDirectorySync(directory) {
  for (const part of pathParts(directory)) {
    const stat = syncFs.lstatSync(part);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail('CLR cache directory or dependencies changed.', 'LocalPluginSourceChanged', 409);
  }
  return syncFs.realpathSync(directory);
}
/** Validate and read the opened object, rather than reopening a checked pathname. */
export async function readClrDependency(root, relative) {
  const realRoot = await fs.realpath(root),
    candidate = path.resolve(realRoot, relative);
  const rel = path.relative(realRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    fail('CLR source escaped its declared root.');
  // The relative name only: the local path stays out of configuration responses.
  const handle = await fs
    .open(candidate, 'r')
    .catch((error) => fail(`CLR dependency ${relative} cannot be read (${error.code ?? 'error'}).`));
  try {
    const stat = await handle.stat({ bigint: true });
    let current = realRoot;
    for (const part of rel.split(path.sep)) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) fail('CLR source symlinks are not executable dependencies.');
    }
    const named = await fs.lstat(candidate, { bigint: true });
    if (!stat.isFile() || stat.size > CLR_FILE_LIMIT || !sameFile(stat, named))
      fail('CLR dependency must be a regular DLL of at most 32 MiB.');
    const bytes = await readClrBytes(handle),
      actual = await fs.realpath(candidate);
    const after = await fs.lstat(candidate, { bigint: true }),
      actualRelative = path.relative(realRoot, actual);
    if (
      after.isSymbolicLink() ||
      !sameFile(stat, after) ||
      actualRelative === '..' ||
      actualRelative.startsWith('..' + path.sep) ||
      path.isAbsolute(actualRelative)
    )
      fail('CLR dependency changed during preparation.');
    return { path: actual, bytes };
  } finally {
    await handle.close();
  }
}
function readClrFileSync(file) {
  const fd = syncFs.openSync(file, 'r');
  try {
    const stat = syncFs.fstatSync(fd, { bigint: true }),
      named = syncFs.lstatSync(file, { bigint: true });
    if (named.isSymbolicLink() || !stat.isFile() || stat.size > CLR_FILE_LIMIT || !sameFile(stat, named))
      fail('Trusted CLR bytes changed after preparation.', 'LocalPluginSourceChanged', 409);
    return readClrBytesSync(fd);
  } finally {
    syncFs.closeSync(fd);
  }
}
function removeClrSnapshot(directory, files) {
  // Process absence may precede Windows releasing the owning worker's file handles.
  const deadline = Date.now() + 1000,
    signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      for (const file of files) {
        try {
          syncFs.unlinkSync(path.join(directory, file.name));
        } catch (cause) {
          if (cause.code !== 'ENOENT') throw cause;
        }
      }
      syncFs.rmdirSync(directory);
      return;
    } catch (cause) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(cause.code) || Date.now() >= deadline) throw cause;
      Atomics.wait(signal, 0, 0, 25);
    }
  }
}
/** No assembly is discovered or executed automatically. Cache contains only explicitly trusted bytes. */
export async function prepareClrRuntime(descriptor, { compiler } = {}) {
  validateClrDescriptor(descriptor);
  if (process.platform !== 'win32')
    fail(
      'The built-in CLR host requires Windows .NET Framework; configure mocks on other platforms.',
      'LocalPluginClrUnavailable',
      501,
    );
  const assembly = await readClrDependency(descriptor.root, descriptor.assembly),
    sdk = await readClrDependency(descriptor.sdkRoot, descriptor.sdkAssembly),
    dependencies = await Promise.all(
      (descriptor.dependencies ?? []).map((relative) => readClrDependency(descriptor.root, relative)),
    );
  // The sandbox supplies Microsoft.Crm.Sdk.Proxy with the SDK: a plug-in that does not ship it still binds the
  // Microsoft.Crm.Sdk.Messages request classes (WhoAmIRequest, AssignRequest) when the SDK folder carries it.
  const proxyName = 'Microsoft.Crm.Sdk.Proxy.dll';
  if (!dependencies.some((file) => path.basename(file.path).toLowerCase() === proxyName.toLowerCase())) {
    const proxy = await fs
      .access(path.join(descriptor.sdkRoot, proxyName))
      .then(() => readClrDependency(descriptor.sdkRoot, proxyName))
      .catch(() => null);
    if (proxy) dependencies.push(proxy);
  }
  const names = [assembly, sdk, ...dependencies].map((f) => path.basename(f.path).toLowerCase());
  if (new Set(names).size !== names.length) fail('CLR dependency filenames must be unique.');
  const source = (await readClrDependency(path.dirname(hostSource), path.basename(hostSource))).bytes,
    signature = sha(Buffer.concat([source, assembly.bytes, sdk.bytes, ...dependencies.map((f) => f.bytes)]));
  await fs.mkdir(path.resolve(descriptor.cacheRoot), { recursive: true });
  const cacheParent = await canonicalClrDirectory(descriptor.cacheRoot),
    directory = await fs.mkdtemp(path.join(cacheParent, 'clr-' + signature + '-'));
  try {
    const files = [];
    for (const original of [assembly, sdk, ...dependencies]) {
      const destination = path.join(directory, path.basename(original.path));
      await fs.writeFile(destination, original.bytes, { flag: 'wx' });
      files.push({ path: destination, sourcePath: original.path, sha256: sha(original.bytes) });
    }
    const executable = path.join(directory, 'paqvilo-plugin-host.exe'),
      sourceFile = path.join(directory, 'paqvilo-plugin-host.cs');
    await fs.writeFile(sourceFile, source, { flag: 'wx' });
    const compilerFile =
      compiler ?? path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    // The host context implements IPluginExecutionContext7 when the installed SDK declares it (current
    // online contract); an older SDK gets the Context4 class instead.
    const compile = (defines) =>
      spawnSync(
        compilerFile,
        [
          '/nologo',
          '/target:exe',
          ...defines.map((name) => '/define:' + name),
          '/out:' + executable,
          '/reference:' + files[1].path,
          '/reference:System.Web.Extensions.dll',
          '/reference:System.Runtime.Serialization.dll',
          '/reference:System.ServiceModel.dll',
          sourceFile,
        ],
        { shell: false, windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 },
      );
    let contextInterfaceVersion = 7,
      build = compile(['PAQVILO_CONTEXT7']);
    if (!build.error && build.status !== 0 && /IPluginExecutionContext7/.test(String(build.stdout))) {
      contextInterfaceVersion = 4;
      build = compile([]);
    }
    if (build.error || build.status !== 0)
      fail(
        'CLR host compilation failed: ' + String(build.error?.message ?? build.stdout ?? build.stderr).slice(0, 4000),
        'LocalPluginClrBuild',
        501,
      );
    files.push({
      path: executable,
      sha256: sha((await readClrDependency(directory, path.basename(executable))).bytes),
    });
    const allowed = new Set([...files.map((f) => path.basename(f.path)), path.basename(sourceFile)]);
    if ((await fs.readdir(directory)).some((name) => !allowed.has(name)))
      fail('CLR cache has unregistered sidecar dependencies.');
    return {
      descriptor,
      executable,
      assembly: files[0].path,
      files,
      directory,
      allowedFiles: [...allowed],
      provenance: {
        kind: 'original-clr-assembly',
        typeName: descriptor.typeName,
        assemblySha256: files[0].sha256,
        sdkSha256: files[1].sha256,
        hostSourceSha256: sha(source),
        contextInterfaceVersion,
        trusted: true,
        securityModel: 'Explicit project backend profile; native process is trusted code, not a security sandbox',
      },
    };
  } catch (cause) {
    // This newly created directory belongs only to this preparation attempt.
    // Preserve the original preparation failure if Windows delays handle release.
    const relative = path.relative(cacheParent, directory);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }).catch(() => {});
    throw cause;
  }
}
export function pluginRuntimeDescriptors(packs = []) {
  let collected;
  try {
    collected = collectPackExport(packs, 'pluginRuntimes');
  } catch (error) {
    fail(error.message);
  }
  return new Map([...collected].map(([key, { value }]) => [key, value]));
}
const typed = (type, value) => ({ $type: type, value });
export function recordToSdkEntity(store, entity, row, columns = { allColumns: true }) {
  const mapping = store.resolveMapping(entity),
    attributes = {},
    formattedValues = {};
  let platform;
  const reference = (logicalName, id, suppliedName, partitionId) => {
    let target;
    try {
      target = store.resolveMapping(logicalName);
    } catch (error) {
      if (error.code !== 'UnknownEntity') throw error;
    }
    const primaryName =
        target &&
        (target.nameColumn ??
          target.primaryNameColumn ??
          Object.entries(target.fields ?? target.fieldMetadata ?? {}).find(
            ([, definition]) => definition.isPrimaryName,
          )?.[0]),
      record = primaryName
        ? store
            .tableRows(target.logicalName)
            .find(
              (record) =>
                canon(record[target.idColumn]) === canon(id) &&
                (!isElastic(target) || samePartition(record.partitionid, partitionId)),
            )
        : null,
      name = suppliedName ?? record?.[primaryName] ?? null;
    // A message Target's references carry no resolved names (native Create/Update Targets: Name null);
    // retrieved rows and images name them.
    return { $type: 'EntityReference', logicalName, id, name: columns.target ? null : name };
  };
  for (const [key, value] of Object.entries(row ?? {})) {
    if (!columns.allColumns && !(columns.columns ?? []).includes(key)) continue;
    if (value == null) {
      attributes[key] = null;
      continue;
    }
    // Platform columns a Solution export omits (createdon, transactioncurrencyid, exchangerate, <money>_base)
    // are typed from the organization's attribute metadata.
    const field =
        store.fieldDefinition(mapping.logicalName, key) ??
        (platform ??= store.platformFields?.(mapping.logicalName) ?? {})[key] ??
        {},
      type = String(field.dataverseType ?? field.type ?? '').toLowerCase();
    if (value && typeof value === 'object' && value.id && value.logical_name)
      attributes[key] = reference(value.logical_name, value.id, value.name, value.partitionid ?? row[`${key}pid`]);
    else if (['lookup', 'customer', 'owner'].includes(type) && typeof value === 'string') {
      let targets = field.targets;
      if (targets === undefined && type === 'lookup') {
        const relationships = Object.values(mapping.relationships ?? {}).filter(
          (relationship) => relationship?.many === false && canon(relationship.from) === canon(key),
        );
        const declared = [];
        for (const relationship of relationships) {
          let related;
          try {
            related = store.resolveMapping(relationship.entity);
          } catch (error) {
            if (error.code !== 'UnknownEntity') throw error;
          }
          if (!related || canon(relationship.to) !== canon(related.idColumn)) {
            declared.push(null);
            break;
          }
          declared.push(related.logicalName);
        }
        targets = declared.includes(null) ? [] : [...new Set(declared)];
      }
      // A polymorphic lookup (customer, owner, regarding) stored as a bare GUID names its table in the row's type
      // column (<column>type, as owneridtype); without one the target stays ambiguous (never guessed from row presence).
      const companion = row[key + 'type'];
      if (uuid.test(value) && typeof companion === 'string' && !(Array.isArray(targets) && targets.length === 1)) {
        let known = null;
        try {
          known = store.resolveMapping(companion);
        } catch (error) {
          if (error.code !== 'UnknownEntity') throw error;
        }
        if (known && (!targets?.length || targets.includes(known.logicalName))) targets = [known.logicalName];
      }
      if (
        !uuid.test(value) ||
        !Array.isArray(targets) ||
        targets.length !== 1 ||
        typeof targets[0] !== 'string' ||
        !/^[a-z][\w]*$/i.test(targets[0])
      )
        fail('SDK lookup GUID requires one exact source-declared target table.', 'LocalPluginSdkUnsupported', 501);
      attributes[key] = reference(targets[0], canon(value), undefined, row[`${key}pid`]);
    } else if (['money', 'decimal'].includes(type)) {
      let text = String(value?.value ?? value);
      // A stored decimal (a retrieved row, or a value only the platform writes) carries its storage scale: ten
      // places, or the column's precision when larger (native images: 1.5000000000; exchangerate 1.000000000000).
      const scale = Math.max(10, Number.isInteger(field.precision) ? field.precision : 0),
        match = /^-?\d+(?:\.(\d*))?$/.exec(text);
      if (type === 'decimal' && (columns.retrieved || field.validForCreate === false) && match)
        text = (match[1] === undefined ? text + '.' : text) + '0'.repeat(Math.max(0, scale - (match[1] ?? '').length));
      attributes[key] = typed(type === 'money' ? 'Money' : 'Decimal', text);
    } else if (type === 'bigint') attributes[key] = typed('Int64', String(value?.value ?? value));
    else if (['double', 'float'].includes(type)) {
      const raw = isExactNumeric(value) ? value.value : value,
        number =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
              ? Number(raw)
              : NaN;
      if (!Number.isFinite(number))
        fail('SDK Double requires a finite numeric source value.', 'LocalPluginSdkUnsupported', 501);
      attributes[key] = typed('Double', String(number));
    } else if (['choice', 'picklist', 'state', 'status', 'optionset'].includes(type)) {
      const option = value?.value ?? value;
      attributes[key] = typed('OptionSetValue', option);
      const label = value?.label ?? field.options?.find((entry) => Number(entry.value) === Number(option))?.label;
      if (typeof label === 'string') formattedValues[key] = label;
    } else if (type === 'multiselectpicklist') {
      const parsed =
        typeof value === 'string' && /^\s*\[/.test(value)
          ? (() => {
              try {
                return JSON.parse(value).map((item) =>
                  item && typeof item === 'object' ? (item.Value ?? item.value) : item,
                );
              } catch {
                return null;
              }
            })()
          : value;
      const values = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'string'
          ? parsed.split(',').filter((part) => part.trim() !== '')
          : null;
      if (!values) fail('SDK choices require stored option values.', 'LocalPluginSdkUnsupported', 501);
      attributes[key] = {
        $type: 'OptionSetValueCollection',
        values: values.map((item) => {
          const raw = item?.value ?? item,
            number =
              typeof raw === 'number'
                ? raw
                : typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim())
                  ? Number(raw.trim())
                  : NaN;
          if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647)
            fail('SDK choices require Int32 option values.', 'LocalPluginSdkUnsupported', 501);
          return typed('OptionSetValue', number);
        }),
      };
    } else if (['datetime', 'date'].includes(type))
      // DateOnly and TimeZoneIndependent values carry no time zone: their SDK DateTime kind is Unspecified. The
      // PreValidation Target (columns.submitted) still shows a TimeZoneIndependent value as the caller sent it.
      attributes[key] = typed(
        'DateTime',
        typeof value === 'string' &&
          (dateTimeBehavior(field) === 'dateonly' ||
            (dateTimeBehavior(field) === 'timezoneindependent' && !columns.submitted))
          ? value.replace(/(?:Z|[+-]\d{2}:\d{2})$/i, '')
          : value,
      );
    else if (type === 'uniqueidentifier' || key === mapping.idColumn) attributes[key] = typed('Guid', value);
    else attributes[key] = cloneStateData(value);
    if (attributes[key]?.$type === 'EntityReference' && typeof attributes[key].name === 'string')
      formattedValues[key] = attributes[key].name;
  }
  // A retrieved row carries the phonetic-name companion of a lookup whose metadata declares one
  // (native images: createdbyyominame, owneridyominame), valued from the referenced row.
  // A lookup without a name companion (owninguser, owningteam) is retrieved unnamed.
  if (columns.retrieved)
    for (const [key, value] of Object.entries(attributes)) {
      const companion = `${key}yominame`,
        declared = (name) =>
          store.fieldDefinition(mapping.logicalName, name) ??
          (platform ??= store.platformFields?.(mapping.logicalName) ?? {})[name];
      if (value?.$type !== 'EntityReference') continue;
      if (store.platformFields && !declared(`${key}name`)) {
        value.name = null;
        delete formattedValues[key];
      }
      if (Object.hasOwn(attributes, companion) || !declared(companion)) continue;
      if (!columns.allColumns && !(columns.columns ?? []).includes(companion)) continue;
      let related;
      try {
        related = store.resolveMapping(value.logicalName);
      } catch (error) {
        if (error.code !== 'UnknownEntity') throw error;
      }
      const source =
        related && store.tableRows(related.logicalName).find((r) => canon(r[related.idColumn]) === canon(value.id));
      const yomi = source?.yomifullname ?? value.name;
      if (yomi != null) attributes[companion] = yomi;
    }
  const id = row?.[mapping.idColumn] ?? '00000000-0000-0000-0000-000000000000',
    versionColumn = mapping.sdkRowVersionColumn;
  const sourceVersion =
    versionColumn &&
    store
      .tableRows(mapping.logicalName)
      .find(
        (source) =>
          canon(source[mapping.idColumn]) === canon(id) &&
          (!isElastic(mapping) || samePartition(source.partitionid, row.partitionid)),
      )?.[versionColumn];
  const rowVersion = sourceVersion == null ? null : String(sourceVersion?.value ?? sourceVersion);
  if (rowVersion !== null && !/^\d+$/.test(rowVersion))
    fail('Source SDK RowVersion column requires an unsigned integral value.', 'LocalPluginSdkUnsupported', 501);
  return {
    $type: 'Entity',
    logicalName: mapping.logicalName,
    id,
    attributes,
    ...(versionColumn ? { rowVersion } : {}),
    // A message Target carries formatted values only once PostOperation runs (native PreValidation/PreOperation: none).
    ...(Object.keys(formattedValues).length && !(columns.target && !columns.postOperation) ? { formattedValues } : {}),
  };
}
export function recordToSdkReadEntity(store, entity, row, columns) {
  const present = Object.fromEntries(Object.entries(row ?? {}).filter(([, value]) => value != null));
  const result = recordToSdkEntity(store, entity, present, {
    ...sdkReadColumns(store, entity, columns),
    retrieved: true,
  });
  // A retrieved Dataverse row reports its stored row version as Entity.RowVersion (native Retrieve/RetrieveMultiple).
  if (result.rowVersion == null && store.platformFields) {
    const mapping = store.resolveMapping(entity),
      stored = store
        .tableRows(mapping.logicalName)
        .find((source) => canon(source[mapping.idColumn]) === canon(result.id))?.versionnumber;
    const version = stored == null ? null : String(stored?.value ?? stored);
    if (version !== null && /^\d+$/.test(version)) result.rowVersion = version;
  }
  return result;
}
export function sdkQueryParameters(query) {
  if (query.pageInfo?.returnTotalRecordCount === true)
    fail('SDK total counts require the Fetch/QueryExpression execution adapter.', 'LocalPluginSdkUnsupported', 501);
  if (query.linkEntities?.length)
    fail('Linked QueryExpression requires the typed FetchXML execution adapter.', 'LocalPluginSdkUnsupported', 501);
  const name = (value) => {
    if (typeof value !== 'string' || !/^[a-z][\w]*$/i.test(value))
      fail('Unsupported SDK query column.', 'LocalPluginSdkUnsupported', 501);
    return value;
  };
  const literal = (value) => {
    value = sdkValueToRecord(value);
    if (value === null) return 'null';
    if (isExactNumeric(value)) return value.value;
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') return "'" + value.replaceAll("'", "''") + "'";
    fail('Unsupported SDK query value.', 'LocalPluginSdkUnsupported', 501);
  };
  const condition = (c) => {
    if (c.entityName) fail('SDK alias conditions require a configured mock.', 'LocalPluginSdkUnsupported', 501);
    const attribute = name(c.attributeName),
      values = c.values ?? [],
      ops = { Equal: 'eq', NotEqual: 'ne', GreaterThan: 'gt', GreaterEqual: 'ge', LessThan: 'lt', LessEqual: 'le' };
    if (ops[c.operatorName] && values.length === 1)
      return `${attribute} ${ops[c.operatorName]} ${c.compareColumns ? name(values[0]) : literal(values[0])}`;
    if (['Null', 'NotNull'].includes(c.operatorName) && !values.length)
      return `${attribute} ${c.operatorName === 'Null' ? 'eq' : 'ne'} null`;
    if (['In', 'NotIn'].includes(c.operatorName) && values.length)
      return (
        '(' +
        values
          .map((v) => `${attribute} ${c.operatorName === 'In' ? 'eq' : 'ne'} ${literal(v)}`)
          .join(c.operatorName === 'In' ? ' or ' : ' and ') +
        ')'
      );
    if (
      ['BeginsWith', 'DoesNotBeginWith', 'EndsWith', 'DoesNotEndWith'].includes(c.operatorName) &&
      values.length === 1
    ) {
      const predicate = `${c.operatorName.includes('Begin') ? 'startswith' : 'endswith'}(${attribute},${literal(values[0])})`;
      return c.operatorName.startsWith('DoesNot') ? `not (${predicate})` : predicate;
    }
    if (['Like', 'NotLike'].includes(c.operatorName) && values.length === 1 && typeof values[0] === 'string') {
      const value = values[0];
      const leading = value.startsWith('%'),
        trailing = value.endsWith('%');
      const inner = value.slice(leading ? 1 : 0, trailing ? -1 : undefined);
      const decoded = inner.replace(/\[\[\]|\[%\]|\[_\]/g, (match) => ({ '[[]': '[', '[%]': '%', '[_]': '_' })[match]);
      if (!['%', '_', '['].some((character) => inner.replace(/\[\[\]|\[%\]|\[_\]/g, '').includes(character))) {
        const predicate =
          leading && trailing
            ? `contains(${attribute},${literal(decoded)})`
            : leading
              ? `endswith(${attribute},${literal(decoded)})`
              : trailing
                ? `startswith(${attribute},${literal(decoded)})`
                : `${attribute} eq ${literal(decoded)}`;
        return c.operatorName === 'NotLike' ? `not (${predicate})` : predicate;
      }
    }
    const fn = CRM_FUNCTIONS[c.operatorName];
    if (fn) {
      const parameters = [`PropertyName=${literal(attribute)}`];
      if (fn.values === 'list') parameters.push(`PropertyValues=[${values.map(literal).join(',')}]`);
      else if (fn.values === 'pair' && values.length === 2)
        parameters.push(`PropertyValue1=${literal(values[0])}`, `PropertyValue2=${literal(values[1])}`);
      else if (fn.values === 'one' && values.length === 1) parameters.push(`PropertyValue=${literal(values[0])}`);
      else if (fn.values !== 'none' || values.length)
        fail('Unsupported SDK condition values.', 'LocalPluginSdkUnsupported', 501);
      return `Microsoft.Dynamics.CRM.${c.operatorName}(${parameters.join(',')})`;
    }
    fail('Unsupported SDK condition operator: ' + c.operatorName, 'LocalPluginSdkUnsupported', 501);
  };
  const filter = (f) => {
    if (f.anyAllFilterLinkEntity)
      fail('Collection criteria require the typed FetchXML execution adapter.', 'LocalPluginSdkUnsupported', 501);
    if (!['And', 'Or'].includes(f.operatorName ?? 'And'))
      fail('Unsupported SDK filter operator.', 'LocalPluginSdkUnsupported', 501);
    return [...(f.conditions ?? []).map(condition), ...(f.filters ?? []).map(filter).filter(Boolean)]
      .map((v) => '(' + v + ')')
      .join(f.operatorName === 'Or' ? ' or ' : ' and ');
  };
  const params = {};
  if (query.distinct || query.pageInfo?.pageNumber > 1 || query.pageInfo?.pagingCookie)
    fail('SDK distinct/continuation requires an explicit adapter.', 'LocalPluginSdkUnsupported', 501);
  if (query.orders?.length)
    params.$orderby = query.orders.map((o) => name(o.attributeName) + (o.descending ? ' desc' : ' asc')).join(',');
  if (query.$type === 'QueryByAttribute') {
    if (query.attributes?.length !== query.values?.length)
      fail('SDK attribute query length mismatch.', 'LocalPluginSdkUnsupported', 501);
    params.$filter = (query.attributes ?? [])
      .map((attributeName, i) => condition({ attributeName, operatorName: 'Equal', values: [query.values[i]] }))
      .join(' and ');
  } else {
    if (query.distinct || query.pageInfo?.pageNumber > 1 || query.pageInfo?.pagingCookie)
      fail('SDK distinct/continuation requires an explicit adapter.', 'LocalPluginSdkUnsupported', 501);
    params.$filter = filter(query.criteria ?? {});
    if (query.orders?.length)
      params.$orderby = query.orders.map((o) => name(o.attributeName) + (o.descending ? ' desc' : ' asc')).join(',');
  }
  if (query.topCount != null) params.$top = query.topCount;
  else if (query.pageInfo?.count > 0) params.$top = query.pageInfo.count;
  if (!query.columnSet?.allColumns && query.columnSet?.columns?.length)
    params.$select = query.columnSet.columns.map(name).join(',');
  return params;
}
export function dispatchSdkCall(args) {
  // The other plug-in services the host binds (IServiceProvider.GetService) name their calls "<interface>.<method>".
  if (String(args.message?.method).includes('.')) {
    const call = () =>
      executePluginServiceCall({
        store: args.store,
        method: args.message.method,
        args: args.message.arguments,
        diagnostic: args.diagnostic,
      });
    return args.store.traces?.enabled ? args.store.traces.wrap(sdkCallSpan(args.message), call) : call();
  }
  const { store, message } = args,
    previous = store.pluginParentContext,
    previousRequestMetadata = store.pluginRequestId,
    previousMainOperation = store.pluginMainOperation;
  // A plug-in's SDK request is its own operation, never part of a named message's main operation.
  store.pluginMainOperation = null;
  // A plug-in that itself runs inside an SDK-issued pipeline (Depth 2 and deeper) keeps the depth-1 sandbox step as the
  // ParentContext of its own SDK requests; Depth still counts every level (native depth: Create/10/dN < Create/40/d1
  // < Create/30/d1 for N 3..10).
  const sdkParent = previous
    ? null
    : (args.sdkParentContext ?? message.parentContext ?? pluginInvocationSdkParent(store));
  if (sdkParent) {
    if (sdkParent.$type !== 'ExecutionContext' || Buffer.byteLength(JSON.stringify(sdkParent)) > 4 * 1024 * 1024)
      fail('SDK ParentContext is invalid or excessive.', 'LocalPluginInputLimit', 413);
    store.pluginParentContext = canonicalTagParent(cloneStateData(sdkParent), store.pluginSdkTag);
  }
  store.pluginRequestId = message.method === 'Execute' ? message.arguments?.[0]?.requestId : undefined;
  // Collections the caller's operation starts after a plug-in request report no Accept-Language
  // (exported-plugins.mjs runPluginPhase).
  store.pluginSdkRequests = (store.pluginSdkRequests ?? 0) + 1;
  try {
    return store.traces?.enabled
      ? store.traces.wrap(sdkCallSpan(message), (span) => {
          const value = dispatchSdkCallCore(args);
          // A create names its new record (D-R3-23): the span's record id and the output id.
          const created = createdIdOf(value);
          if (created && span.recordId == null) span.setEntity(span.entity, created);
          span.output(() => sdkAnswerSummary(value));
          return value;
        })
      : dispatchSdkCallCore(args);
  } catch (error) {
    const method = message.method === 'Execute' ? message.arguments?.[0]?.requestName : message.method;
    if (
      error.code !== 'LocalPluginTagDuplicate' &&
      ([
        'Create',
        'Update',
        'Delete',
        'Associate',
        'Disassociate',
        'CreateMultiple',
        'UpdateMultiple',
        'Assign',
        'SetState',
        'SetStateDynamicEntity',
        'GrantAccess',
        'ModifyAccess',
        'RevokeAccess',
        'Upsert',
      ].includes(method) ||
        store.tableRows('customapi').some((row) => row.uniquename === method && !row.isfunction))
    )
      store.markPluginTransactionFailure?.(error);
    throw error;
  } finally {
    store.pluginParentContext = previous;
    store.pluginRequestId = previousRequestMetadata;
    store.pluginMainOperation = previousMainOperation;
  }
}
// The sdk-call span of one CLR RPC (tracing): it runs on the main thread inside the plugin-step span, so the record entries it
// calls nest under it. The arguments are captured only at level full.
// A record id of an SDK call, or null: the empty GUID an unsaved Entity carries names no record.
const EMPTY_GUID = /^\{?0{8}-0{4}-0{4}-0{4}-0{12}\}?$/;
const sdkId = (value) => {
  const id = value && typeof value === 'object' ? value.value : value;
  return typeof id === 'string' && id && !EMPTY_GUID.test(id) ? id : null;
};
// The id a Create answers: the Guid of IOrganizationService.Create, or the id result of an Execute CreateResponse.
const createdIdOf = (value) =>
  value?.$type === 'Guid'
    ? sdkId(value)
    : value?.$type === 'OrganizationResponse' && value.responseName === 'Create'
      ? sdkId(value.results?.id)
      : null;
function sdkCallSpan(message) {
  const [first, second] = message.arguments ?? [];
  const request = first?.$type === 'OrganizationRequest' ? first : null;
  const target = request ? request.parameters?.values?.Target : first;
  const name = request?.requestName ?? String(message.method ?? 'Call');
  return {
    kind: 'sdk-call',
    name,
    module: 'clr',
    operation: name,
    entity: typeof target === 'string' ? target : (target?.logicalName ?? null),
    recordId: typeof target === 'string' ? sdkId(second) : sdkId(target?.id),
    attributes: {
      method: message.method ?? null,
      userId: message.userId ?? null,
      parentContext: message.parentContext ? true : undefined,
    },
    input: () => message.arguments ?? [],
  };
}
const sdkAnswerSummary = (value) =>
  value && typeof value === 'object'
    ? {
        type: value.$type ?? null,
        id: createdIdOf(value) ?? sdkId(value.id),
        ...(Array.isArray(value.entities) ? { count: value.entities.length } : {}),
      }
    : (value ?? null);
function dispatchSdkCallCore({
  store,
  profile,
  message,
  callerProfiles = [],
  diagnostic,
  sdkFromSandbox = false,
  invokingUserId,
}) {
  // IOrganizationServiceFactory.CreateOrganizationService (Learn): null is the organization's SYSTEM user, Guid.Empty the
  // step's executing user (context.UserId), any other id that system user. With an organization the calls are authorized by
  // that user's Dataverse security roles, as the Web API authorizes its callers (SYSTEM is not checked; a missing privilege
  // is the native 0x80040220 fault). A store without a Dataverse security model has no roles: there the descriptor's
  // grants (or a caller profile of that user) authorize the call. So do they for the descriptor's own identities (its
  // profile user, the step's executing user) when the organization has no such systemuser: those are project-configured
  // stand-ins, not users the plug-in chose.
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM');
  const runAs =
    message.userId === null
      ? (system?.systemuserid ?? profile.userId)
      : canon(message.userId) === canon('00000000-0000-0000-0000-000000000000')
        ? (invokingUserId ?? profile.userId)
        : message.userId;
  const principals = organizationApiOf(store)?.principals,
    user = principals?.byId(runAs),
    configured = [profile.userId, invokingUserId].some((id) => id && canon(id) === canon(runAs));
  let selected;
  if (principals && (user || !configured)) {
    if (!user)
      throw new DataError(`systemuser With Id = ${runAs} Does Not Exist`, 404, 'NotFound', { innerCode: '0x80040217' });
    selected = {
      userId: user.systemuserid,
      evidence: profile.evidence,
      grants: [],
      ...(profile.bulkTables ? { bulkTables: profile.bulkTables } : {}),
      dataverseSecurity: system && canon(user.systemuserid) === canon(system.systemuserid) ? 'system' : user,
    };
  } else
    selected = {
      ...([profile, ...callerProfiles].find((candidate) => canon(candidate.userId) === canon(runAs)) ?? profile),
      userId: runAs,
    };
  validateServiceProfile(selected);
  const previousExecutionUser = store.pluginExecutionUserId;
  store.pluginExecutionUserId = selected.userId;
  try {
    return dispatchSdkCallAuthorized({ store, profile: selected, message, diagnostic, sdkFromSandbox });
  } finally {
    store.pluginExecutionUserId = previousExecutionUser;
  }
}
const SDK_BYPASS_PARAMETERS = [
  'BypassCustomPluginExecution',
  'BypassBusinessLogicExecution',
  'BypassBusinessLogicExecutionStepIds',
];
function sdkBypassOptions(parameters, profile, store) {
  if (
    parameters.BypassCustomPluginExecution !== undefined &&
    typeof parameters.BypassCustomPluginExecution !== 'boolean'
  )
    fail('SDK BypassCustomPluginExecution requires a boolean.', 'LocalPluginSdkUnsupported', 501);
  if (
    parameters.BypassBusinessLogicExecution !== undefined &&
    typeof parameters.BypassBusinessLogicExecution !== 'string'
  )
    fail('SDK BypassBusinessLogicExecution requires a comma-separated string.', 'LocalPluginSdkUnsupported', 501);
  const logic = String(parameters.BypassBusinessLogicExecution ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const bypassStepIds = parseBypassStepIds(store, parameters.BypassBusinessLogicExecutionStepIds);
  if (logic.some((value) => !['customsync', 'customasync'].includes(value)))
    fail('SDK BypassBusinessLogicExecution accepts CustomSync and CustomAsync.', 'LocalPluginSdkUnsupported', 501);
  // A run-as user holds a bypass privilege through its roles (System Administrator holds both, as on the Web API).
  const security = profile.dataverseSecurity,
    principals = security && security !== 'system' ? organizationApiOf(store)?.principals : null;
  const holds = (privilege) =>
    security === 'system' ||
    (principals
      ? principals.privileges(security).get(privilege) > 0 ||
        principals.roles(security).some((role) => role.name === 'System Administrator')
      : profile.privileges?.includes(privilege));
  for (const [requested, privilege] of [
    [parameters.BypassCustomPluginExecution === true, 'prvBypassCustomPlugins'],
    [logic.length > 0 || bypassStepIds.length > 0, 'prvBypassCustomBusinessLogic'],
  ])
    if (requested && !holds(privilege))
      throw principals
        ? privilegeDeniedError(security, privilege, 'systemuser')
        : new DataError('The local backend profile lacks ' + privilege + '.', 403, 'LocalBackendPermissionDenied');
  return {
    bypassCustomPlugins: parameters.BypassCustomPluginExecution === true || logic.includes('customsync'),
    bypassCustomAsync: logic.includes('customasync'),
    bypassStepIds,
    systemParameters: Object.fromEntries(
      SDK_BYPASS_PARAMETERS.filter((key) => Object.hasOwn(parameters, key)).map((key) => [key, parameters[key]]),
    ),
  };
}
function dispatchSdkCallAuthorized({ store, profile, message, diagnostic, sdkFromSandbox }) {
  const readExecute =
    message.method === 'Execute' &&
    [
      'Retrieve',
      'RetrieveMultiple',
      'FetchXmlToQueryExpression',
      'QueryExpressionToFetchXml',
      'WhoAmI',
      'RetrieveVersion',
      'RetrieveEntity',
      'RetrieveAttribute',
      'RetrieveAllEntities',
      'RetrieveAllOptionSets',
      'RetrieveOptionSet',
      'RetrieveRelationship',
      'RetrieveMetadataChanges',
    ].includes(message.arguments?.[0]?.requestName);
  if (
    store.pluginReadOnly &&
    ['Create', 'Update', 'Delete', 'Associate', 'Disassociate', 'Execute'].includes(message.method) &&
    !readExecute
  )
    fail(
      'SDK writes from a RetrieveMultiple observer require a serialized read-operation transaction adapter.',
      'LocalPluginReadWriteUnsupported',
      501,
    );
  // The organization's internal entries (store.recordPipeline): an SDK call runs the Web API write rules and read projection.
  const service = localOrganizationService(store, profile, undefined, {
    diagnostic,
    requestOptions: { sdkFromSandbox },
  });
  const args = message.arguments ?? [];
  switch (message.method) {
    case 'Execute': {
      const request = args[0],
        parameters = request?.parameters?.values;
      if (
        request?.$type !== 'OrganizationRequest' ||
        (request.typed !== undefined && typeof request.typed !== 'boolean') ||
        (request.requestId != null && (typeof request.requestId !== 'string' || !uuid.test(request.requestId))) ||
        request.parameters?.$type !== 'ParameterCollection' ||
        !parameters ||
        typeof parameters !== 'object' ||
        Array.isArray(parameters)
      )
        fail(
          'SDK Execute requires a typed OrganizationRequest and ParameterCollection.',
          'LocalPluginSdkUnsupported',
          501,
        );
      const bypass = sdkBypassOptions(parameters, profile, store);
      if (['FetchXmlToQueryExpression', 'QueryExpressionToFetchXml'].includes(request.requestName)) {
        const parameter = request.requestName === 'FetchXmlToQueryExpression' ? 'FetchXml' : 'Query';
        if (
          Object.keys(parameters).some((key) => key !== parameter && !SDK_BYPASS_PARAMETERS.includes(key)) ||
          !Object.hasOwn(parameters, parameter)
        )
          fail('Query conversion requires exactly ' + parameter + '.', 'LocalPluginSdkUnsupported', 501);
        return {
          $type: 'OrganizationResponse',
          responseName: request.requestName,
          results: convertSdkQuery(store, request.requestName, parameters),
        };
      }
      if (isPlatformSdkMessage(request.requestName)) {
        validateSdkTag(parameters, store.pluginSdkTag);
        const previousTag = store.pluginSdkTag;
        store.pluginSdkTag = Object.hasOwn(parameters, 'tag') ? parameters.tag : previousTag;
        const options = { ...bypass, sdkFromSandbox },
          scoped = localOrganizationService(store, profile, undefined, { diagnostic, requestOptions: options });
        try {
          return executePlatformSdkMessage({
            store,
            profile,
            service: scoped,
            request,
            parameters,
            options,
            invoke: (method, args) =>
              invokeSdkMethod({ store, service: scoped, message: { ...message, method, arguments: args } }, false),
          });
        } finally {
          store.pluginSdkTag = previousTag;
        }
      }
      const shapes = {
          Create: ['Target'],
          Update: ['Target'],
          Delete: ['Target'],
          Retrieve: ['Target', 'ColumnSet'],
          RetrieveMultiple: ['Query'],
          CreateMultiple: ['Targets'],
          UpdateMultiple: ['Targets'],
          Associate: ['Target', 'Relationship', 'RelatedEntities'],
          Disassociate: ['Target', 'Relationship', 'RelatedEntities'],
        },
        shape = shapes[request.requestName];
      if (
        !shape &&
        store
          .tableRows('customapi')
          .some((row) => String(row.uniquename).toLowerCase() === String(request.requestName).toLowerCase())
      ) {
        const ref = parameters.Target;
        const target = ref?.$type === 'EntityReference' ? { entity: ref.logicalName, id: ref.id } : null;
        const input = {
          $type: 'ParameterCollection',
          values: Object.fromEntries(
            Object.entries(parameters).filter(([key]) => !SDK_BYPASS_PARAMETERS.includes(key) && key !== 'tag'),
          ),
        };
        const previousTag = store.pluginSdkTag;
        validateSdkTag(parameters, store.pluginSdkTag);
        store.pluginSdkTag = Object.hasOwn(parameters, 'tag') ? parameters.tag : previousTag;
        try {
          const answer = localOrganizationService(store, profile, undefined, {
            diagnostic,
            requestOptions: { ...bypass, sdkFromSandbox },
          }).executeMessageSync(request.requestName, target, input);
          return {
            $type: 'OrganizationResponse',
            responseName: request.requestName,
            custom: true,
            results: answer.outputs?.values ?? {},
          };
        } finally {
          store.pluginSdkTag = previousTag;
        }
      }
      if (!shape) {
        const answer = executeSdkOrganizationMessage({
          store,
          userId: profile.userId,
          request,
          parameters,
          dispatch: (inner) =>
            dispatchSdkCallAuthorized({
              store,
              profile,
              message: { ...message, method: 'Execute', arguments: [inner] },
              diagnostic,
              sdkFromSandbox,
            }),
        });
        if (answer !== undefined) return answer;
      }
      // UnMaskedData (Learn optional-parameters#return-unmasked-data): Retrieve and RetrieveMultiple only, exact case, a boolean.
      // ConcurrencyBehavior (Update, Delete), SuppressDuplicateDetection and SolutionUniqueName (Create, Update): the
      // documented optional parameters (Microsoft.Xrm.Sdk.Messages request members and Learn optional-parameters).
      const optional = [
        'tag',
        'partitionId',
        'SessionToken',
        ...SDK_BYPASS_PARAMETERS,
        ...(['Retrieve', 'RetrieveMultiple'].includes(request.requestName) ? ['UnMaskedData'] : []),
        ...(['Update', 'Delete'].includes(request.requestName) ? ['ConcurrencyBehavior'] : []),
        ...(request.requestName === 'Retrieve' ? ['RelatedEntitiesQuery'] : []),
        ...(['Create', 'Update'].includes(request.requestName)
          ? ['SuppressDuplicateDetection', 'SolutionUniqueName']
          : []),
      ];
      if (
        !shape ||
        Object.keys(parameters).some((key) => !shape.includes(key) && !optional.includes(key)) ||
        shape.some((key) => !Object.hasOwn(parameters, key))
      )
        fail('Unsupported SDK Execute request or parameters: ' + request.requestName, 'LocalPluginSdkUnsupported', 501);
      if (parameters.UnMaskedData != null && typeof parameters.UnMaskedData !== 'boolean')
        fail('SDK UnMaskedData requires a boolean.', 'LocalPluginSdkUnsupported', 501);
      for (const key of ['partitionId', 'SessionToken', 'SolutionUniqueName'])
        if (parameters[key] != null && typeof parameters[key] !== 'string')
          fail('SDK ' + key + ' requires a string.', 'LocalPluginSdkUnsupported', 501);
      if (parameters.SuppressDuplicateDetection != null && typeof parameters.SuppressDuplicateDetection !== 'boolean')
        fail('SDK SuppressDuplicateDetection requires a boolean.', 'LocalPluginSdkUnsupported', 501);
      const concurrency = sdkConcurrency(request.requestName, parameters);
      validateSdkTag(parameters, store.pluginSdkTag);
      const method = request.requestName;
      let arguments_ = shape.map((key) => parameters[key]);
      if (['Associate', 'Disassociate'].includes(method)) {
        const target = parameters.Target;
        if (target?.$type !== 'EntityReference') fail('SDK relationship request requires an EntityReference Target.');
        arguments_ = [
          target.logicalName,
          typed('Guid', target.id),
          parameters.Relationship,
          parameters.RelatedEntities,
        ];
      }
      if (['CreateMultiple', 'UpdateMultiple'].includes(method)) {
        const targets = parameters.Targets;
        if (targets?.$type !== 'EntityCollection' || !Array.isArray(targets.entities))
          fail('Bulk SDK request requires a typed Targets EntityCollection.');
        arguments_ = [targets];
      }
      if (['Delete', 'Retrieve'].includes(method)) {
        const target = parameters.Target;
        if (target?.$type !== 'EntityReference') fail('SDK ' + method + 'Request requires an EntityReference.');
        arguments_ = [target.logicalName, target, ...(method === 'Retrieve' ? [parameters.ColumnSet] : [])];
      }
      const previousTag = store.pluginSdkTag;
      store.pluginSdkTag = Object.hasOwn(parameters, 'tag') ? parameters.tag : previousTag;
      try {
        return invokeSdkMethod(
          {
            store,
            service: localOrganizationService(store, profile, undefined, {
              diagnostic,
              requestOptions: { ...bypass, sdkFromSandbox },
            }),
            message: {
              ...message,
              method,
              arguments: arguments_,
              requestOptions: {
                partitionId: parameters.partitionId,
                sessionToken: parameters.SessionToken,
                ...bypass,
                ...(parameters.UnMaskedData === true ? { unmask: true } : {}),
                ...concurrency,
                ...(parameters.RelatedEntitiesQuery ? { relatedEntitiesQuery: parameters.RelatedEntitiesQuery } : {}),
              },
            },
          },
          true,
        );
      } finally {
        store.pluginSdkTag = previousTag;
      }
    }
    default:
      return invokeSdkMethod({ store, service, message }, false);
  }
}
// ConcurrencyBehavior (Microsoft.Xrm.Sdk.ConcurrencyBehavior: Default 0, IfRowVersionMatches 1, AlwaysOverwrite 2): with
// IfRowVersionMatches the write applies only when the target's RowVersion is the stored row version (else 0x80060882), and
// a missing RowVersion faults 0x80060883 (Learn "Optimistic concurrency"); the other values overwrite.
function sdkConcurrency(name, parameters) {
  if (!Object.hasOwn(parameters, 'ConcurrencyBehavior')) return {};
  const behavior = parameters.ConcurrencyBehavior;
  if (behavior?.$type !== 'ConcurrencyBehavior' || ![0, 1, 2].includes(behavior.value))
    fail('SDK ConcurrencyBehavior requires a ConcurrencyBehavior value.', 'LocalPluginSdkUnsupported', 501);
  if (behavior.value !== 1) return { concurrencyBehavior: behavior.value };
  const version = parameters.Target?.rowVersion;
  if (version == null || version === '')
    throw new DataError(
      'The RowVersion property must be provided when the value of ConcurrencyBehavior is IfVersionMatches.',
      400,
      'ConcurrencyVersionNotProvided',
      { innerCode: '0x80060883' },
    );
  return { concurrencyBehavior: 1, ifMatch: 'W/"' + String(version).replaceAll('"', '') + '"' };
}
// The relationship a deep insert or a RelatedEntitiesQuery names, from the table's relationships (schema name and related table).
function relatedBinding(store, entity, relationship, rows, table) {
  if (relationship?.$type !== 'Relationship' || typeof relationship.schemaName !== 'string' || !rows?.length || !table)
    throw new DataError('SDK related rows require a Relationship and related rows.', 400, 'InvalidArgument', {
      innerCode: '0x80040203',
    });
  const rel = Object.values(store.relationshipsFor(store.resolveMapping(entity), { dataverse: true })).find(
    (candidate) =>
      candidate.schemaName?.toLowerCase() === relationship.schemaName.toLowerCase() && candidate.entity === table,
  );
  if (!rel)
    throw new DataError(
      'The relationship ' + relationship.schemaName + ' does not relate ' + entity + ' to ' + table + '.',
      400,
      'InvalidArgument',
      { innerCode: '0x80040203' },
    );
  return { rel, relationship, entities: rows };
}
function invokeSdkMethod({ store, service, message }, namedResponse) {
  const args = message.arguments ?? [],
    method = message.method;
  const table = ['Create', 'Update'].includes(method)
    ? args[0]?.logicalName
    : ['CreateMultiple', 'UpdateMultiple'].includes(method)
      ? args[0]?.entities?.[0]?.logicalName
      : method === 'RetrieveMultiple'
        ? (args[0]?.entityName ?? /<entity\s[^>]*name=["'](\w+)["']/i.exec(args[0]?.query ?? '')?.[1])
        : args[0];
  const entity = typeof table === 'string' ? store.resolveMapping(table).logicalName : null;
  const captured = captureSdkResponse(store, method.toLowerCase(), entity, (responseToken) =>
      executeSdkMethod({ store, service, message, responseToken }),
    ),
    defaults =
      method === 'Create'
        ? { id: captured.value }
        : method === 'Retrieve'
          ? { BusinessEntity: captured.value }
          : method === 'RetrieveMultiple'
            ? { BusinessEntityCollection: captured.value }
            : method === 'CreateMultiple'
              ? { Ids: captured.value }
              : {};
  const results = captured.results ?? defaults;
  if (namedResponse) {
    const mapped = cloneStateData(results),
      aliases =
        method === 'Retrieve'
          ? [['BusinessEntity', 'Entity']]
          : method === 'RetrieveMultiple'
            ? [['BusinessEntityCollection', 'EntityCollection']]
            : [];
    for (const [from, to] of aliases)
      if (Object.hasOwn(mapped, from)) {
        if (Object.hasOwn(mapped, to))
          fail(
            'Plugin output contains conflicting context and SDK response result aliases.',
            'LocalPluginResponseUnsupported',
            501,
          );
        mapped[to] = mapped[from];
        delete mapped[from];
      }
    return { $type: 'OrganizationResponse', responseName: method, results: mapped };
  }
  // These defaults mirror the installed SDK response getters; original-DLL tests
  // qualify the missing-key behavior separately from native organization faults.
  if (method === 'Create')
    return Object.hasOwn(results, 'id') ? results.id : typed('Guid', '00000000-0000-0000-0000-000000000000');
  if (method === 'Retrieve') return results.BusinessEntity ?? null;
  if (method === 'RetrieveMultiple') return results.BusinessEntityCollection ?? null;
  return captured.value;
}
const hasCollectionCriteria = (filter) =>
  Boolean(filter?.anyAllFilterLinkEntity || filter?.filters?.some(hasCollectionCriteria));
function executeSdkMethod({ store, service, message, responseToken }) {
  const args = message.arguments ?? [];
  switch (message.method) {
    case 'CreateMultiple':
    case 'UpdateMultiple': {
      const result = service.bulk(message.method.toLowerCase(), args[0].entities, { responseToken });
      return message.method === 'CreateMultiple'
        ? { $type: 'GuidArray', values: result.ids.map((value) => typed('Guid', value)) }
        : null;
    }
    case 'Create': {
      const entity = args[0];
      if (entity?.$type !== 'Entity') fail('SDK Create requires an Entity.');
      // Deep insert (Entity.RelatedEntities, Learn "create related table rows in one operation"): a row the new row looks up
      // (N:1) is created first; rows that look the new row up (1:N) are created with that lookup; N:N rows are created and
      // then associated. Each related row is an ordinary SDK Create (its own pipeline, its own related rows).
      const related = (entity.relatedEntities ?? []).map((item) =>
          relatedBinding(
            store,
            entity.logicalName,
            item.relationship,
            item.entities?.entities,
            item.entities?.entities?.[0]?.logicalName,
          ),
        ),
        create = (child) =>
          executeSdkMethod({ store, service, message: { ...message, method: 'Create', arguments: [child] } }).value;
      const values = sdkValueToRecord(entity);
      for (const { rel, entities } of related.filter((binding) => binding.rel.many === false)) {
        if (entities.length !== 1)
          throw new DataError('A many-to-one deep insert takes exactly one related row.', 400, 'InvalidArgument', {
            innerCode: '0x80040203',
          });
        values[rel.from] = { id: create(entities[0]), logical_name: rel.entity };
      }
      const row = service.create(entity.logicalName, values, {
        responseToken,
        sdkCreateId: entity.id,
      });
      const id = row[service.mapping(entity.logicalName).idColumn];
      for (const { rel, relationship, entities } of related.filter((binding) => binding.rel.many !== false)) {
        if (rel.intersect) {
          const ids = entities.map(create);
          service.associate(
            entity.logicalName,
            id,
            relationship,
            {
              $type: 'EntityReferenceCollection',
              values: ids.map((value) => ({ $type: 'EntityReference', logicalName: rel.entity, id: value })),
            },
            true,
            {},
          );
        } else
          for (const child of entities)
            create({
              ...child,
              attributes: {
                ...child.attributes,
                [rel.to]: { $type: 'EntityReference', logicalName: entity.logicalName, id },
              },
            });
      }
      return typed('Guid', id);
    }
    case 'Update': {
      const entity = args[0];
      if (entity?.$type !== 'Entity') fail('SDK Update requires an Entity.');
      service.update(entity.logicalName, entity, sdkValueToRecord(entity), {
        responseToken,
        ifMatch: message.requestOptions?.ifMatch,
        concurrencyBehavior: message.requestOptions?.concurrencyBehavior,
      });
      return null;
    }
    case 'Delete':
      service.remove(args[0], args[1], { responseToken, ...message.requestOptions });
      return null;
    case 'Associate':
    case 'Disassociate':
      return service.associate(args[0], sdkValueToRecord(args[1]), args[2], args[3], message.method === 'Associate', {
        responseToken,
      });
    case 'Retrieve': {
      if (args[2] === null)
        throw new DataError('SandboxFault.ThrowIfNull: columnSet', 400, 'InvalidArgument', { innerCode: '0x80040203' });
      const row = service.get(args[0], args[1], args[2], { responseToken, ...message.requestOptions }),
        result = recordToSdkReadEntity(store, args[0], row, args[2]);
      // RetrieveRequest.RelatedEntitiesQuery: each relationship's query, restricted to the rows related to this one.
      const queries = message.requestOptions?.relatedEntitiesQuery?.values ?? [];
      if (queries.length)
        result.relatedEntities = queries.map(({ relationship, query }) => {
          if (query?.$type !== 'QueryExpression') fail('SDK RelatedEntitiesQuery requires QueryExpression values.');
          const { rel } = relatedBinding(store, args[0], relationship, [query], query.entityName),
            mapping = service.mapping(args[0]),
            criteria = query.criteria ?? { operatorName: 'And', conditions: [], filters: [] },
            key = (value) => (value && typeof value === 'object' ? value.id : value) ?? null;
          const equal = (attributeName, value) => ({
            operatorName: 'And',
            conditions: [
              {
                attributeName,
                operatorName: value == null ? 'Null' : 'Equal',
                values: value == null ? [] : [typed('Guid', value)],
              },
            ],
            filters: [],
          });
          const scoped = rel.intersect
            ? {
                ...query,
                linkEntities: [
                  ...(query.linkEntities ?? []),
                  {
                    $type: 'LinkEntity',
                    linkFromEntityName: query.entityName,
                    linkToEntityName: rel.intersect.entity,
                    linkFromAttributeName: rel.to,
                    linkToAttributeName: rel.intersect.to,
                    joinOperator: 'Inner',
                    columns: { $type: 'ColumnSet', allColumns: false, columns: [] },
                    linkCriteria: equal(rel.intersect.from, key(row[rel.from])),
                    linkEntities: [],
                    orders: [],
                  },
                ],
              }
            : {
                ...query,
                criteria: {
                  ...criteria,
                  filters: [
                    ...(criteria.filters ?? []),
                    // N:1: the row this one looks up; 1:N: the rows that look this one up.
                    rel.many === false
                      ? equal(rel.to, key(row[rel.from]) ?? '00000000-0000-0000-0000-000000000000')
                      : equal(rel.to, row[mapping.idColumn]),
                  ],
                },
              };
          return {
            relationship,
            entities: executeSdkMethod({
              store,
              service,
              message: { ...message, method: 'RetrieveMultiple', arguments: [scoped] },
            }),
          };
        });
      return result;
    }
    case 'RetrieveMultiple': {
      const query = args[0];
      let rows,
        entity = query.entityName;
      const structured = ['QueryExpression', 'QueryByAttribute'].includes(query.$type);
      const mapping = structured ? service.mapping(entity) : null;
      const provider = structured ? store.recordPipeline?.virtualProviders?.status?.(entity) : null;
      const defaultPaging =
        structured &&
        query.topCount == null &&
        !mapping.isVirtual &&
        !/^virtual$/i.test(mapping.tableType ?? '') &&
        !mapping.dataSourceId &&
        !provider?.virtual;
      if (
        query.$type === 'FetchExpression' ||
        (['QueryExpression', 'QueryByAttribute'].includes(query.$type) &&
          (defaultPaging ||
            query.linkEntities?.length ||
            query.pageInfo?.count > 0 ||
            query.pageInfo?.returnTotalRecordCount === true ||
            query.distinct ||
            query.pageInfo?.pageNumber > 1 ||
            query.pageInfo?.pagingCookie ||
            query.dataSource ||
            query.queryHints ||
            query.columnSet?.attributeExpressions?.length ||
            query.orders?.some((order) => order.alias) ||
            hasCollectionCriteria(query.criteria)))
      ) {
        const expression =
          query.$type === 'QueryByAttribute'
            ? {
                ...query,
                $type: 'QueryExpression',
                linkEntities: [],
                criteria: {
                  operatorName: 'And',
                  filters: [],
                  conditions: (query.attributes ?? []).map((attributeName, index) => ({
                    attributeName,
                    operatorName: 'Equal',
                    values: [query.values?.[index]],
                  })),
                },
              }
            : query;
        if (query.$type === 'QueryByAttribute' && query.attributes?.length !== query.values?.length)
          fail('SDK attribute query length mismatch.', 'LocalPluginSdkUnsupported', 501);
        const xml = query.$type === 'FetchExpression' ? query.query : queryExpressionToFetch(expression, store);
        entity = /<entity\s[^>]*name=["'](\w+)["']/i.exec(xml)?.[1];
        const answer = service.fetch(xml, {
          sdkResult: true,
          sdkQuery: query,
          sdkResponseToken: responseToken,
          unmask: message.requestOptions?.unmask === true,
        });
        return (
          answer.sdkCollection ??
          fetchResultToSdkCollection(store, entity, answer, recordToSdkEntity, {
            hiddenId: answer.sdkHiddenId,
            rootColumns: query.columnSet,
          })
        );
      } else if (['QueryExpression', 'QueryByAttribute'].includes(query.$type)) {
        const params = sdkQueryParameters(query),
          primary = service.mapping(entity).idColumn;
        if (!query.columnSet?.allColumns && !query.columnSet?.columns?.length) params.$select = primary;
        if (params.$select && !params.$select.split(',').includes(primary)) params.$select += ',' + primary;
        const answer = service.query(entity, params, {
          responseToken,
          sdkQuery: query,
          unmask: message.requestOptions?.unmask === true,
        });
        if (answer.sdkCollection) return answer.sdkCollection;
        rows = answer.value;
      } else fail('Unsupported SDK query structure.', 'LocalPluginSdkUnsupported', 501);
      return {
        $type: 'EntityCollection',
        entities: rows.map((row) =>
          recordToSdkReadEntity(store, entity, row, query.columnSet ?? { allColumns: false, columns: [] }),
        ),
        entityName: entity,
        minActiveRowVersion: '-1',
        moreRecords: false,
        totalRecordCount: -1,
        pagingCookie: null,
      };
    }
    default:
      fail('Unsupported SDK service method: ' + message.method, 'LocalPluginSdkUnsupported', 501);
  }
}
export function executeSdkFetch(store, xml, execute) {
  const prepared = prepareFetchForSdk(xml, store),
    answer = execute(prepared.xml);
  Object.defineProperty(answer, 'sdkHiddenId', { value: prepared.hiddenId, configurable: true });
  return answer;
}
/** Synchronous pipeline RPC; no queued DataStore.create/update await can deadlock this thread. */
export function executeClrPlugin(runtime, input, { store, diagnostic = () => {} }) {
  clrTimeout(runtime.descriptor);
  if (
    path.relative(canonicalClrDirectorySync(runtime.directory), path.resolve(runtime.directory)) !== '' ||
    syncFs.readdirSync(runtime.directory).some((name) => !runtime.allowedFiles.includes(name))
  )
    fail('CLR cache directory or dependencies changed.', 'LocalPluginSourceChanged', 409);
  const verified = [];
  for (const file of runtime.files) {
    canonicalClrDirectorySync(path.dirname(file.path));
    const bytes = readClrFileSync(file.path);
    if (sha(bytes) !== file.sha256)
      fail('Trusted CLR bytes changed after preparation.', 'LocalPluginSourceChanged', 409);
    if (file.sourcePath) {
      canonicalClrDirectorySync(path.dirname(file.sourcePath));
      if (sha(readClrFileSync(file.sourcePath)) !== file.sha256)
        fail('Trusted CLR bytes changed after preparation.', 'LocalPluginSourceChanged', 409);
    }
    verified.push({ name: path.basename(file.path), bytes, sha256: file.sha256 });
  }
  if (sha(readClrFileSync(hostSource)) !== runtime.provenance.hostSourceSha256)
    fail('CLR host source changed; restart to prepare the new host.', 'LocalPluginSourceChanged', 409);
  if (Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024)
    fail('CLR context exceeds 4 MiB.', 'LocalPluginInputLimit', 413);
  if (runtime.descriptor.persistentHost === true)
    return executePooledClr(runtime, input, { store, diagnostic }, verified);
  const directory = syncFs.mkdtempSync(path.join(path.dirname(runtime.directory), 'clr-run-'));
  try {
    for (const file of verified) syncFs.writeFileSync(path.join(directory, file.name), file.bytes, { flag: 'wx' });
    return executeClrSnapshot(
      runtime,
      input,
      { store, diagnostic },
      {
        directory,
        executable: path.join(directory, path.basename(runtime.executable)),
        assembly: path.join(directory, path.basename(runtime.assembly)),
      },
    );
  } finally {
    try {
      removeClrSnapshot(directory, verified);
    } catch (cause) {
      // Cleanup diagnostics must not replace an original plugin exception.
      try {
        diagnostic({
          code: 'PLUGIN_CLR_CLEANUP',
          message: 'Owned CLR snapshot cleanup failed: ' + cause.code + ' (' + cause.syscall + ')',
        });
      } catch {
        /* Best-effort diagnostics and teardown must not mask the primary plugin result. */
      }
    }
  }
}
function stopClrHost(session, diagnostic = () => {}) {
  if (session.active) fail('An active CLR host cannot be closed.', 'LocalPluginHostBusy', 409);
  const report = (note) => {
    try {
      diagnostic(note);
    } catch {
      /* Best-effort diagnostics and teardown must not mask the primary plugin result. */
    }
  };
  pooledHosts.delete(session.key);
  if (session.pid)
    try {
      process.kill(session.pid);
    } catch (cause) {
      if (cause.code !== 'ESRCH')
        report({ code: 'PLUGIN_CLR_CLEANUP', message: 'Owned CLR process cleanup failed: ' + cause.code });
    }
  session.port1.postMessage({ kind: 'cancel' });
  session.port1.close();
  void session.worker.terminate();
  let absent = !session.pid;
  const deadline = Date.now() + 1000;
  while (session.pid && Date.now() < deadline) {
    try {
      process.kill(session.pid, 0);
    } catch (cause) {
      if (cause.code === 'ESRCH') {
        absent = true;
        break;
      }
    }
    Atomics.wait(session.flags, 0, 0, 10);
  }
  if (session.pid) report({ code: 'PLUGIN_CLR_HOST_STOPPED', pid: session.pid, absenceVerified: absent });
  try {
    removeClrSnapshot(session.snapshot.directory, session.files);
  } catch (cause) {
    report({ code: 'PLUGIN_CLR_CLEANUP', message: 'Owned pooled CLR snapshot cleanup failed: ' + cause.code });
  }
  return absent;
}
/** Stop only hosts created by this process. Campaigns must close their pool in
 * finally; default runtimes never enter the pool. */
export function closeClrHostPool({ runtime, diagnostic = () => {} } = {}) {
  const selected = [...pooledHosts.values()].filter(
    (session) => !runtime || session.runtimeDirectory === runtime.directory,
  );
  if (selected.some((session) => session.active))
    fail('An active CLR host cannot be closed.', 'LocalPluginHostBusy', 409);
  return {
    closed: selected.length,
    allAbsenceVerified: selected.map((session) => stopClrHost(session, diagnostic)).every(Boolean),
  };
}
export function clrHostPoolStatus() {
  return [...pooledHosts.values()].map((session) => ({
    pid: session.pid ?? null,
    active: session.active,
    depth: session.depth,
    typeName: session.typeName,
  }));
}
function executePooledClr(runtime, input, options, verified) {
  const depth = executionDepth + 1,
    key = runtime.directory + '\0' + runtime.descriptor.typeName + '\0' + depth;
  if (depth > PLUGIN_MAX_DEPTH) fail(PLUGIN_DEPTH_MESSAGE, 'LocalPluginDepth', 400);
  let session = pooledHosts.get(key);
  if (!session) {
    if (pooledHosts.size >= 32) {
      const idle = [...pooledHosts.values()].find((host) => !host.active);
      if (!idle) fail('CLR host pool exceeds 32 active hosts.', 'LocalPluginHostLimit', 413);
      stopClrHost(idle, options.diagnostic);
    }
    const directory = syncFs.mkdtempSync(path.join(path.dirname(runtime.directory), 'clr-pool-'));
    try {
      for (const file of verified) syncFs.writeFileSync(path.join(directory, file.name), file.bytes, { flag: 'wx' });
    } catch (cause) {
      removeClrSnapshot(directory, verified);
      throw cause;
    }
    const snapshot = {
      directory,
      executable: path.join(directory, path.basename(runtime.executable)),
      assembly: path.join(directory, path.basename(runtime.assembly)),
    };
    let parentIdentity;
    try {
      parentIdentity = clrParentIdentity(snapshot.executable);
    } catch (cause) {
      removeClrSnapshot(directory, verified);
      throw cause;
    }
    const { port1, port2 } = new MessageChannel(),
      signal = new SharedArrayBuffer(4),
      flags = new Int32Array(signal);
    const worker = new Worker(new URL('./plugin-clr-pool-worker.mjs', import.meta.url), {
      workerData: { port: port2, signal, executable: snapshot.executable, ...parentIdentity },
      transferList: [port2],
    });
    worker.on('error', () => {});
    worker.unref();
    port1.unref();
    session = {
      key,
      runtimeDirectory: runtime.directory,
      typeName: runtime.descriptor.typeName,
      depth,
      snapshot,
      files: verified.map((file) => ({ name: file.name })),
      worker,
      port1,
      signal,
      flags,
      active: false,
    };
    pooledHosts.set(key, session);
  }
  if (session.active) fail('Concurrent CLR pool invocation is unsupported.', 'LocalPluginHostBusy', 409);
  // The opened execution copy remains immutable and gets checked independently
  // of the source/compiled runtime checks above on every reused invocation.
  let intact = false;
  try {
    intact =
      syncFs.readdirSync(session.snapshot.directory).length === verified.length &&
      verified.every((file) => sha(readClrFileSync(path.join(session.snapshot.directory, file.name))) === file.sha256);
  } catch {
    /* Best-effort diagnostics and teardown must not mask the primary plugin result. */
  }
  if (!intact) {
    stopClrHost(session, options.diagnostic);
    fail('Pooled CLR execution bytes changed.', 'LocalPluginSourceChanged', 409);
  }
  return executeClrSnapshot(runtime, input, options, session.snapshot, session);
}
function executeClrSnapshot(runtime, input, { store, diagnostic, constructorConfiguration }, snapshot, session) {
  const sdkParentContext = selectSdkEntryParent(clrSdkEntryContext(input), input.sdkFrameworkSource);
  const timeout = clrTimeout(runtime.descriptor);
  const parentIdentity = session ? null : clrParentIdentity(snapshot.executable);
  const channels = session ?? new MessageChannel(),
    port1 = channels.port1,
    port2 = channels.port2,
    signal = session?.signal ?? new SharedArrayBuffer(4),
    flags = session?.flags ?? new Int32Array(signal);
  const invocationId = session ? randomUUID() : null;
  const invocation = {
    ...input,
    inputParameters: input.inputParameters ?? { $type: 'ParameterCollection', values: {} },
    outputParameters: input.outputParameters ?? { $type: 'ParameterCollection', values: {} },
    sharedVariables: input.sharedVariables ?? { $type: 'ParameterCollection', values: {} },
    assembly: snapshot.assembly,
    typeName: runtime.descriptor.typeName,
    ...runtimeConstructorSettings(
      store,
      input.context?.OwningExtension?.id,
      constructorConfiguration,
      runtime.descriptor,
    ),
  };
  const worker =
    session?.worker ??
    new Worker(new URL('./plugin-clr-worker.mjs', import.meta.url), {
      workerData: {
        port: port2,
        signal,
        executable: snapshot.executable,
        input: invocation,
        timeout,
        ...parentIdentity,
      },
      transferList: [port2],
    });
  if (session) {
    session.active = true;
    port1.postMessage({ kind: 'invoke', invocationId, input: invocation, timeout });
  } else worker.on('error', () => {});
  const deadline = Date.now() + timeout + 1000;
  // A step that outlives its deadline is the platform's unhandled timeout fault (400 0x80040224, the message names the type),
  // as for a custom API (plugin-fault.mjs); the code stays LocalPluginTimeout for local callers.
  const traces = [];
  const timedOut = () => {
    const owner = input.context?.OwningExtension;
    const failure = pluginFailure(
      { timedOut: true },
      {
        name: owner?.name,
        id: owner?.id,
        type: runtime.descriptor.typeName,
        traces,
        label: owner?.name ?? '',
        stage: input.context?.Stage,
        depth: input.context?.Depth,
      },
      timeout,
    );
    failure.code = 'LocalPluginTimeout';
    return failure;
  };
  let calls = 0,
    result,
    ownedPid = session?.pid,
    completed = false;
  executionDepth++;
  try {
    if (executionDepth > PLUGIN_MAX_DEPTH) fail(PLUGIN_DEPTH_MESSAGE, 'LocalPluginDepth', 400);
    while (!result) {
      let packet;
      while ((packet = receiveMessageOnPort(port1))) {
        const message = packet.message;
        if (session && message.kind !== 'owned-child' && message.invocationId !== invocationId)
          fail('Stale pooled CLR output.', 'LocalPluginProtocol', 500);
        if (message.kind === 'owned-child') {
          if (!Number.isInteger(message.pid) || message.pid <= 0)
            fail('Invalid owned CLR process.', 'LocalPluginProtocol', 500);
          ownedPid = message.pid;
          if (session) session.pid = ownedPid;
          diagnostic({ code: 'PLUGIN_CLR_HOST_STARTED', pid: ownedPid, pooled: Boolean(session) });
        } else if (message.kind === 'rpc') {
          let value, error;
          try {
            if (++calls > 1000) fail('CLR SDK call limit exceeded.', 'LocalPluginCallLimit', 413);
            value = dispatchSdkCall({
              store,
              sdkParentContext,
              profile: runtime.descriptor.serviceProfile,
              callerProfiles: runtime.descriptor.sdkCallerProfiles,
              sdkFromSandbox: true,
              invokingUserId: input.context?.UserId?.value,
              message,
              diagnostic,
            });
          } catch (cause) {
            error = { code: cause.code ?? 'LocalPluginSdkError', message: cause.message };
            if (cause.code === 'LocalPluginTagDuplicate') error.clrExceptionType = 'System.ArgumentException';
            else {
              const fault = sdkFault(cause);
              if (fault) error.organizationServiceFault = fault;
            }
          }
          port1.postMessage({ kind: 'rpc-answer', value, error, ...(session ? { invocationId } : {}) });
        } else if (message.kind === 'trace') {
          if (typeof message.message !== 'string' || message.message.length > 16384)
            fail('CLR trace exceeds the local limit.', 'LocalPluginOutputLimit', 413);
          traces.push(message.message);
          diagnostic({ code: 'PLUGIN_CLR_TRACE', message: message.message });
          // ITracingService: an event on the current (plugin-step) span.
          store?.traces?.current()?.event('trace', { message: message.message });
        } else if (message.kind === 'telemetry') {
          // ILogger entries: natively Application Insights telemetry, never the plug-in trace log.
          if (typeof message.message !== 'string' || message.message.length > 16384)
            fail('CLR telemetry exceeds the local limit.', 'LocalPluginOutputLimit', 413);
          diagnostic({ code: 'PLUGIN_CLR_TELEMETRY', level: String(message.level ?? ''), message: message.message });
          store?.traces
            ?.current()
            ?.event('telemetry', { level: String(message.level ?? ''), message: message.message });
        } else if (message.kind === 'failure') {
          if (message.code === 'LocalPluginTimeout') throw timedOut();
          const details = {
            sourceException: {
              type: message.exceptionType ?? null,
              duringPluginExecute: message.duringPluginExecute === true,
              errorCode: message.errorCode ?? null,
              operationStatus: message.operationStatus ?? null,
              exceptionDetails: message.exceptionDetails ?? null,
            },
          };
          // Native traceFaults (two captures): an InvalidPluginExecutionException answers 0x80040265 with its message
          // whatever errorCode (12345, 0x80040216) or OperationStatus it names; the code stays in sourceException.
          if (Number.isInteger(message.errorCode))
            details.innerCode =
              message.pluginException === true ||
              message.exceptionType === 'Microsoft.Xrm.Sdk.InvalidPluginExecutionException'
                ? '0x80040265'
                : '0x' + (message.errorCode >>> 0).toString(16).padStart(8, '0');
          else if (
            message.duringPluginExecute === true &&
            message.code === 'PluginValidation' &&
            message.pluginException !== true
          )
            details.innerCode = '0x80040224';
          throw new DataError(
            message.message,
            400,
            details.innerCode === '0x8009000c' ? 'PluginTransactionAborted' : (message.code ?? 'PluginValidation'),
            details,
          );
        } else if (message.kind === 'result') {
          result = message;
          break;
        } else fail('Unknown CLR protocol result.', 'LocalPluginProtocol', 500);
      }
      if (result) break;
      if (Date.now() > deadline) throw timedOut();
      Atomics.wait(flags, 0, 0, 20);
      Atomics.store(flags, 0, 0);
    }
    completed = true;
  } finally {
    executionDepth--;
    if (session) {
      session.active = false;
      if (!completed) stopClrHost(session, diagnostic);
    } else {
      if (ownedPid)
        try {
          process.kill(ownedPid);
        } catch (cause) {
          if (cause.code !== 'ESRCH')
            diagnostic({ code: 'PLUGIN_CLR_CLEANUP', message: 'Owned CLR process cleanup failed: ' + cause.code });
        }
      port1.postMessage({ kind: 'cancel' });
      port1.close();
      void worker.terminate();
      if (ownedPid) {
        let absent = false;
        const stopDeadline = Date.now() + 1000;
        while (Date.now() < stopDeadline) {
          try {
            process.kill(ownedPid, 0);
          } catch (cause) {
            if (cause.code === 'ESRCH') {
              absent = true;
              break;
            }
          }
          Atomics.wait(flags, 0, 0, 10);
        }
        diagnostic({ code: 'PLUGIN_CLR_HOST_STOPPED', pid: ownedPid, absenceVerified: absent });
      }
    }
  }
  return {
    ...result,
    provenance: runtime.provenance,
    sdkCalls: calls,
    executionMode: session ? 'pooled-fresh-instance' : 'fresh-host',
  };
}
export function clrContext({
  runtime,
  store,
  step,
  entity,
  operation,
  stage,
  target,
  record,
  previous,
  frame,
  depth,
  bridged = false,
}) {
  const descriptor = runtime.descriptor,
    context = descriptor.context,
    parent = frame.delegatedParentContext ?? store.pluginParentContext ?? pluginInvocationSdkParent(store),
    primary = entity && !(frame.customApi && entity === 'none') ? store.resolveMapping(entity).idColumn : null;
  const contextDepth = frame.exactDepth
    ? frame.delegatedDepth
    : frame.delegatedParentContext
      ? Math.max(depth, pluginInvocationDepth(store) + 1, frame.delegatedDepth ?? 0, frame.operationDepth ?? 0)
      : Math.max(
          depth,
          pluginInvocationDepth(store) + 1,
          frame.operationDepth ?? 0,
          parent ? Number(parent.values.Depth) + 1 : 0,
        );
  if (contextDepth > PLUGIN_MAX_DEPTH) fail(PLUGIN_DEPTH_MESSAGE, 'LocalPluginDepth', 400);
  const preValidationParent =
    stage !== 10 &&
    (step.contract?.mode ?? 0) === 0 &&
    ['create', 'update', 'delete', 'createmultiple', 'updatemultiple'].includes(operation) &&
    frame.preValidationContext;
  if (preValidationParent && !frame.preValidationSharedDetached) {
    const prior = frame.sharedVariables?.values ?? {};
    frame.sharedVariables = {
      $type: 'ParameterCollection',
      values: Object.hasOwn(prior, 'tag') ? { tag: prior.tag } : {},
    };
    frame.preValidationSharedDetached = true;
  }
  // FormattedValues are the calling user's (plugin-formatted-values.mjs).
  const formatUserId =
    store.pluginExecutionUserId ??
    frame.callerIdentity?.systemUserId ??
    context.executionUserId ??
    descriptor.serviceProfile.userId;
  const image = (row, registration) => {
    if (!row) return null;
    const { formattedValues: _, ...value } = recordToSdkEntity(store, entity, imageAttributes(row), {
      allColumns: !registration.attributes?.length,
      columns: registration.attributes ?? [],
      retrieved: true,
    });
    const formattedValues = pipelineFormattedValues(store, entity, value, {
      userId: formatUserId,
      retrieved: true,
      currencyId: row.transactioncurrencyid,
    });
    return Object.keys(formattedValues).length ? { ...value, formattedValues } : value;
  };
  const asynchronous = (step.contract?.mode ?? 0) === 1,
    crud = ['create', 'update', 'delete'].includes(operation),
    nameColumn = primary ? store.resolveMapping(entity).nameColumn : null;
  // The platform's own image for asynchronous registrations: the row's primary name and key (pre for Delete).
  const asyncPrimaryName = () => {
    const row = operation === 'delete' ? previous : record;
    if (!row || !nameColumn) return null;
    const columns = [nameColumn, primary];
    return recordToSdkEntity(store, entity, imageAttributes(row, columns), { allColumns: false, columns });
  };
  const collectImages = (registrations, post, target) => {
    for (const registration of registrations)
      if (post ? [1, 2].includes(registration.type) && record : [0, 2].includes(registration.type) && previous)
        target[registration.alias || registration.name] = image(post ? record : previous, registration);
    return target;
  };
  const postAvailable = stage === 40 && operation !== 'delete';
  const preImages = collectImages(step.images ?? [], false, {}),
    postImages = postAvailable ? collectImages(step.images ?? [], true, {}) : {};
  if (asynchronous && crud) {
    const name = asyncPrimaryName();
    if (name) (operation === 'delete' ? preImages : postImages).AsynchronousStepPrimaryName = name;
  }
  // IPluginExecutionContext4 collections of a single-record message: every registration of the stage (see
  // runPluginPhase stageImages), plus the asynchronous primary-name image at PostOperation.
  const stageCollection = (viewStage, post) => {
    const registrations =
      frame.stageImages?.[viewStage]?.registrations ?? (viewStage === stage ? [step.images ?? []] : []);
    const values = {};
    if (!post || (viewStage === 40 && operation !== 'delete'))
      for (const images of registrations) collectImages(images, post, values);
    if (
      crud &&
      viewStage === 40 &&
      post === (operation !== 'delete') &&
      (asynchronous || frame.stageImages?.[40]?.asynchronous)
    ) {
      const name = asyncPrimaryName();
      if (name) values.AsynchronousStepPrimaryName = name;
    }
    return {
      $type: 'EntityImageCollectionArray',
      values: Object.keys(values).length ? [{ $type: 'EntityImageCollection', values }] : [],
    };
  };
  const bulk = ['createmultiple', 'updatemultiple'].includes(operation),
    messageName =
      frame.customApi?.name ??
      {
        retrievemultiple: 'RetrieveMultiple',
        createmultiple: 'CreateMultiple',
        updatemultiple: 'UpdateMultiple',
        onexternalcreated: 'OnExternalCreated',
        onexternalupdated: 'OnExternalUpdated',
        onexternaldeleted: 'OnExternalDeleted',
      }[operation] ??
      // A bridged step runs the single message's pipeline under its own multiple message name.
      (bridged ? operation[0].toUpperCase() + operation.slice(1) + 'Multiple' : null) ??
      operation[0].toUpperCase() + operation.slice(1);
  const externalParameters = frame.externalEvent
    ? {
        PreImage: frame.externalEvent.previous ? recordToSdkEntity(store, entity, frame.externalEvent.previous) : null,
        ChangedFields: {
          $type: 'PrimitiveArray',
          elementType: 'String',
          values: frame.externalEvent.changedAttributes,
        },
      }
    : {};
  const portalRequest = frame.portalRequest === true && !parent,
    portalContactId =
      portalRequest && uuid.test(frame.portalContactId ?? '')
        ? frame.portalContactId
        : '00000000-0000-0000-0000-000000000000';
  // Identities as the platform reports them. UserId is the executing principal: an impersonating step, a nested
  // SDK service's user, else the Dataverse caller (the descriptor's identity stands in for portal and replay
  // callers). The initiating/authenticated values belong to the original caller and pass down nested contexts.
  const caller = frame.callerIdentity?.dataverse ? frame.callerIdentity : null,
    user = (id) =>
      id
        ? store
            .tableRows('systemuser')
            .find((row) => String(row.systemuserid).toLowerCase() === String(id).toLowerCase())
        : null,
    inherited = (key) => parent?.values?.[key],
    guidOf = (value) => value?.value ?? value ?? null,
    empty = '00000000-0000-0000-0000-000000000000';
  // A native Delete's main operation (and its PreOperation, PostOperation and asynchronous steps) executes as the
  // organization's SYSTEM user; PreValidation still runs as the caller.
  const systemDelete =
    operation === 'delete' && stage !== 10 && !store.pluginParentContext && !pluginInvocationSdkParent(store)
      ? store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM')?.systemuserid
      : null;
  const callerUserId =
      systemDelete ??
      store.pluginExecutionUserId ??
      caller?.systemUserId ??
      context.executionUserId ??
      descriptor.serviceProfile.userId,
    executionUserId = step.impersonatingUserId ?? callerUserId,
    // A plug-in's SDK call runs as its service's user, which is also the nested contexts' InitiatingUserId (recorded native
    // sdkSurface and readNested: SYSTEM for CreateOrganizationService(null), the caller for Guid.Empty).
    initiatingUserId =
      store.pluginExecutionUserId ??
      guidOf(inherited('InitiatingUserId')) ??
      caller?.systemUserId ??
      context.initiatingUserId ??
      executionUserId,
    authenticatedUserId = guidOf(inherited('AuthenticatedUserId')) ?? caller?.dataverse?.callerId ?? initiatingUserId,
    businessUnitId =
      guidOf(inherited('BusinessUnitId')) ??
      (caller ? guidOf(user(initiatingUserId)?.businessunitid?.id ?? user(initiatingUserId)?.businessunitid) : null) ??
      context.businessUnitId,
    objectId = (id) => user(id)?.azureactivedirectoryobjectid ?? empty;
  const identityFacts = {
    UserAzureActiveDirectoryObjectId: typed('Guid', objectId(executionUserId)),
    InitiatingUserAzureActiveDirectoryObjectId: typed('Guid', objectId(initiatingUserId)),
    InitiatingUserApplicationId:
      inherited('InitiatingUserApplicationId') ??
      typed('Guid', caller?.dataverse?.appId ?? user(initiatingUserId)?.applicationid ?? empty),
    AuthenticatedUserId: typed('Guid', authenticatedUserId),
    // A request a plug-in issues through its IOrganizationService, and the asynchronous jobs it queues, report no user
    // agent (native depth, faults, sdkMessages and customApi, also at Depth 1); others report the caller's.
    InitiatingUserAgent:
      (frame.sdkIssued ?? Boolean(store.pluginParentContext || pluginInvocationSdkParent(store)))
        ? ''
        : (inherited('InitiatingUserAgent') ?? caller?.dataverse?.userAgent ?? null),
    EnvironmentId: context.environmentId ?? store.state?.dataverse?.environmentId ?? null,
    TenantId: typed('Guid', context.tenantId ?? store.state?.dataverse?.tenantId ?? empty),
    IsApplicationUser:
      inherited('IsApplicationUser') ?? context.isApplicationUser ?? Boolean(user(authenticatedUserId)?.applicationid),
  };
  // A queued bulk job has no pre-image sets unless its registration asks for pre images (native sdkSurface, both
  // captures: an SDK UpdateMultiple of two targets queues PreEntityImagesCollection length 0, PostEntityImagesCollection 2).
  const bulkImages = (rows, post) => ({
    $type: 'EntityImageCollectionArray',
    values:
      !post && asynchronous && !(step.images ?? []).some((registration) => [0, 2].includes(registration.type))
        ? []
        : frame.targets.map((_, index) => ({
            $type: 'EntityImageCollection',
            values: Object.fromEntries(
              (step.images ?? [])
                .filter((registration) => (post ? [1, 2] : [0, 2]).includes(registration.type) && rows[index])
                .map((registration) => [registration.alias || registration.name, image(rows[index], registration)]),
            ),
          })),
  });
  // The main operation populates system results once. Keep custom values and
  // subsequent PostOperation replacements across ranks for every message shape.
  frame.outputParameters ??= { $type: 'ParameterCollection', values: {} };
  initializePluginOperation(frame, store, parent, { createdOn: context.operationCreatedOn });
  // Create's PreOperation/PostOperation collection carries the platform's telemetry root (a JSON string).
  // A bulk CreateMultiple's collections have none (native bulk); each delegated Create's have.
  if (operation === 'create' && stage !== 10 && !asynchronous && !frame.telemetryRootSeeded) {
    frame.sharedVariables ??= { $type: 'ParameterCollection', values: {} };
    frame.sharedVariables.values.telemetryrootcontext ??= JSON.stringify({
      serviceRequestId: frame.requestId,
      correlationId: frame.correlationId,
      activityVector: '00',
      clientCorrelation: {
        clientPrincipalId: identityFacts.InitiatingUserAzureActiveDirectoryObjectId.value,
        clientTenantId: identityFacts.TenantId.value,
        clientAppIdId: guidOf(identityFacts.InitiatingUserApplicationId),
        organizationId: context.organizationId ?? store.state?.dataverse?.organizationId ?? empty,
      },
    });
    frame.telemetryRootSeeded = true;
  }
  if (stage === 40 && !frame.systemOutputsPopulated) {
    const values =
      operation === 'create'
        ? { id: typed('Guid', record[primary]) }
        : operation === 'createmultiple'
          ? { Ids: { $type: 'GuidArray', values: record.bulkIds.map((value) => typed('Guid', value)) } }
          : operation === 'retrieve'
            ? { BusinessEntity: frame.entity }
            : operation === 'retrievemultiple'
              ? { BusinessEntityCollection: frame.collection }
              : {};
    frame.outputParameters = { $type: 'ParameterCollection', values: { ...frame.outputParameters.values, ...values } };
    frame.systemOutputsPopulated = true;
  }
  // Reads requested outside a plug-in carry the client's app-module and annotation inputs (Web API reads natively;
  // the app module is empty outside a model-driven app).
  // Explicit descriptor observations (portalInputParameters) keep precedence.
  const outsidePlugin = !store.pluginParentContext && !pluginInvocationSdkParent(store);
  const readRequestParameters = Object.fromEntries(
    Object.entries(
      !outsidePlugin
        ? {}
        : {
            ...(frame.delegatedParentContext ? {} : { IncludeAnnotations: false }),
            ...(operation === 'retrievemultiple'
              ? { AppModuleId: typed('Guid', empty), IsAppModuleContext: false }
              : {}),
          },
    ).filter(([key]) => !(portalRequest && Object.hasOwn(context.portalInputParameters ?? {}, key))),
  );
  const answer = {
    ...(frame.sdkFrameworkSource ? { sdkFrameworkSource: frame.sdkFrameworkSource } : {}),
    expectedAssemblyName: step.assemblyName ?? null,
    context: {
      InterfaceVersion: runtime.provenance?.contextInterfaceVersion ?? 7,
      ...identityFacts,
      IsPortalsClientCall: portalRequest,
      PortalsContactId: typed('Guid', portalContactId),
      RequestId: typed('Guid', (frame.requestId ??= parent?.values?.RequestId?.value ?? randomUUID())),
      // Native reports 'none' for every message observed (CRUD, reads, bulk, association, named messages).
      SecondaryEntityName: context.secondaryEntityName ?? 'none',
      Stage: stage,
      Mode: step.contract?.mode ?? 0,
      Depth: contextDepth,
      MessageName: messageName,
      PrimaryEntityName: ['associate', 'disassociate'].includes(operation) ? 'none' : entity,
      PrimaryEntityId: typed(
        'Guid',
        // A queued DeleteMultiple job names no row (native crud, async, upsert: its context and parents carry Guid.Empty).
        ['associate', 'disassociate'].includes(operation) || (bridged && asynchronous && operation === 'delete')
          ? '00000000-0000-0000-0000-000000000000'
          : primary
            ? (record[primary] ?? '00000000-0000-0000-0000-000000000000')
            : '00000000-0000-0000-0000-000000000000',
      ),
      UserId: typed('Guid', executionUserId),
      InitiatingUserId: typed('Guid', initiatingUserId),
      OrganizationId: typed('Guid', context.organizationId ?? store.state?.dataverse?.organizationId),
      OrganizationName: context.organizationName ?? store.state?.dataverse?.uniqueName ?? '',
      BusinessUnitId: typed('Guid', businessUnitId),
      CorrelationId: typed('Guid', (frame.correlationId ??= parent?.values.CorrelationId?.value ?? randomUUID())),
      OperationId: typed('Guid', frame.operationId),
      OperationCreatedOn: cloneStateData(frame.createdOnWire),
      IsInTransaction: store.pluginInTransaction === true,
      IsExecutingOffline: false,
      IsOfflinePlayback: false,
      IsolationMode: step.isolationMode ?? 2,
      OwningExtension: {
        $type: 'EntityReference',
        logicalName: 'sdkmessageprocessingstep',
        id: step.id,
        // Native asynchronous contexts do not name their step.
        name: asynchronous ? null : step.name,
      },
      ParentContext: parent || null,
      ...(bulk
        ? {
            PreEntityImagesCollection:
              operation === 'createmultiple' && (step.contract?.mode ?? 0) === 1
                ? { $type: 'EntityImageCollectionArray', values: [] }
                : bulkImages(frame.previousRecords ?? [], false),
            PostEntityImagesCollection: bulkImages(stage === 40 ? (frame.records ?? []) : [], true),
          }
        : {
            PreEntityImagesCollection: stageCollection(stage, false),
            PostEntityImagesCollection: stageCollection(stage, true),
          }),
    },
    inputParameters: {
      $type: 'ParameterCollection',
      values: {
        ...(frame.requestTag === undefined || frame.inputTagConsumed ? {} : { tag: frame.requestTag }),
        ...(portalRequest ? (context.portalInputParameters ?? {}) : {}),
        ...(frame.inputParameters?.values ?? {}),
        ...(frame.customApi
          ? (frame.inputParameters?.values ?? {})
          : (frame.associationParameters ??
            (bulk
              ? {
                  Targets: bulkTargetsCollection(
                    entity,
                    stage === 40 &&
                      frame.inputParametersStage === 40 &&
                      frame.inputParameters?.values?.Targets?.$type === 'EntityCollection'
                      ? frame.inputParameters.values.Targets.entities
                      : frame.targets,
                    { submitted: stage === 10 && !asynchronous },
                  ),
                }
              : operation === 'retrievemultiple'
                ? { Query: frame.query, ...readRequestParameters }
                : operation === 'retrieve'
                  ? {
                      Target: frame.retrieveTarget ?? {
                        $type: 'EntityReference',
                        logicalName: entity,
                        id: record[primary],
                      },
                      ColumnSet: { $type: 'ColumnSet', ...frame.columns },
                      ...(readRequestParameters.IncludeAnnotations === undefined
                        ? {}
                        : { IncludeAnnotations: false, ReturnNotifications: false }),
                    }
                  : {
                      Target:
                        operation === 'delete'
                          ? { $type: 'EntityReference', logicalName: entity, id: record[primary] }
                          : stage === 40 &&
                              frame.inputParametersStage === 40 &&
                              frame.inputParameters?.values?.Target?.$type === 'Entity'
                            ? frame.inputParameters.values.Target
                            : {
                                ...recordToSdkEntity(
                                  store,
                                  entity,
                                  {
                                    ...target,
                                    ...(operation === 'create' && stage === 10 && Object.hasOwn(target, primary)
                                      ? {}
                                      : { [primary]: record[primary] }),
                                  },
                                  operation === 'create' && stage === 10
                                    ? {
                                        allColumns: false,
                                        columns: Object.keys(target ?? {}),
                                        submitted: true,
                                        target: true,
                                      }
                                    : {
                                        allColumns: true,
                                        submitted: stage === 10,
                                        target: true,
                                        postOperation: stage === 40,
                                      },
                                ),
                                id: frame.inputParameters?.values?.Target?.id ?? record[primary],
                              },
                    }))),
        ...externalParameters,
      },
    },
    outputParameters: frame.outputParameters,
    sharedVariables: frame.sharedVariables ?? { $type: 'ParameterCollection', values: {} },
    preImages,
    postImages,
  };
  if (frame.delegatedSourceOperation) {
    const source = frame.delegatedSourceOperation;
    const caller =
      store.pluginExecutionUserId ??
      source.identity?.systemUserId ??
      (source.identity?.admin ? source.identity.id : null) ??
      context.initiatingUserId ??
      descriptor.serviceProfile.userId;
    answer.context.ParentContext = delegatedPluginParent(source, answer.context, caller);
  }
  // PreOperation and PostOperation (and the asynchronous copies) see the main operation as their parent. A record
  // operation a named message's main operation delegates sees that message's stage-30 context instead (native
  // sdkMessages: Update/20/d2 < Assign/30/d2 < Update/40/d1).
  // A bulk CreateMultiple/UpdateMultiple has its own main operation too (native bulk: CreateMultiple/30).
  if ((crud || bulk) && stage !== 10 && !frame.delegatedSourceOperation && !frame.namedMainOperation)
    answer.context.ParentContext = mainOperationParent({
      frame,
      // A bridged multiple step's parent is the single message's main operation.
      context: bridged
        ? { ...answer.context, MessageName: operation[0].toUpperCase() + operation.slice(1) }
        : answer.context,
      parent: asynchronous ? (frame.mainOuterParent ?? frame.asyncCallerParent ?? null) : parent,
      userId: executionUserId,
      objectId,
      inputs: () =>
        bulk
          ? { ...cloneStateData(frame.mainOperationInputs ?? {}), Targets: cloneStateData(frame.mainOperationTargets) }
          : {
              ...cloneStateData(frame.mainOperationInputs ?? {}),
              Target:
                operation === 'delete'
                  ? { $type: 'EntityReference', logicalName: entity, id: record[primary] }
                  : {
                      ...recordToSdkEntity(
                        store,
                        entity,
                        operation === 'create' && Object.hasOwn(frame.mainOperationTarget ?? {}, primary)
                          ? frame.mainOperationTarget
                          : { ...frame.mainOperationTarget, [primary]: record[primary] },
                        operation === 'create'
                          ? { allColumns: false, columns: Object.keys(frame.mainOperationTarget ?? {}) }
                          : { allColumns: true },
                      ),
                      id: record[primary],
                    },
            },
      images: stageCollection(10, false),
    });
  // The Create main operation's Target names the key it allocated after PreValidation (native upsert and
  // nested-SDK creates: the Create/30 parent Target carries the primary-key attribute).
  const mainParentTarget = answer.context.ParentContext?.values?.InputParameters?.values?.Target;
  if (
    operation === 'create' &&
    crud &&
    stage !== 10 &&
    !frame.delegatedSourceOperation &&
    mainParentTarget?.$type === 'Entity' &&
    record[primary] != null &&
    !Object.hasOwn(mainParentTarget.attributes ?? {}, primary)
  )
    mainParentTarget.attributes = {
      ...mainParentTarget.attributes,
      ...recordToSdkEntity(store, entity, { [primary]: record[primary] }).attributes,
    };
  if (!asynchronous && (crud || bulk) && stage !== 10) frame.mainOuterParent ??= parent ? cloneStateData(parent) : null;
  // An asynchronous job sees the synchronous step parent chain as its own operation (plugin-sdk-parent.mjs).
  if (asynchronous)
    answer.context.ParentContext = asynchronousParentChain(
      answer.context.ParentContext ?? frame.asyncCallerParent,
      answer.context,
    );
  answer.context.ParentContext =
    asyncMultipleJobParent(frame, operation, entity, answer.context) ?? answer.context.ParentContext;
  // A named message's main operation reports the user its delegated record operation runs as (native sdkMessages:
  // Assign/30 carries the SYSTEM user of its owner Update, and an impersonating step's user, as Update/30 does).
  if (frame.namedMainOperation && !asynchronous && answer.context.ParentContext?.values)
    answer.context.ParentContext = {
      $type: 'ExecutionContext',
      values: {
        ...answer.context.ParentContext.values,
        UserId: typed('Guid', executionUserId),
        UserAzureActiveDirectoryObjectId: typed('Guid', objectId(executionUserId)),
      },
    };
  answer.context.ParentContext = observedParentChain(
    answer.context.ParentContext,
    answer.context,
    objectId,
    store.pluginRequestRoots,
  );
  formatPipelineTargets(store, {
    entity,
    operation,
    stage,
    frame,
    userId: formatUserId,
    values: answer.inputParameters.values,
    currencyId: bulk ? undefined : record?.transactioncurrencyid,
  });
  if (bridged) answer.inputParameters.values = bridgeTargetInputs(answer.inputParameters.values, entity);
  return answer;
}
