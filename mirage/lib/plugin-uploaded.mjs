// Registered plug-in assemblies whose bytes were uploaded through the registration API (pluginassembly.content, directly or
// from a pluginpackage) run in the CLR host by default, as the platform runs registered plug-ins (user decision C08, docs:
// mirage/docs/dataverse-plugins.md "Uploaded assemblies run like native"). The runtime is built from the stored bytes only:
// the assembly and, for a package, the other lib/ assemblies of the same target framework are written into an owned
// directory under the cache root, next to the toolchain's Microsoft.Xrm.Sdk.dll, and the host is compiled there
// (plugin-clr.mjs buildClrRuntime). Nothing else is loaded. A step whose assembly cannot be loaded fails the way a
// platform plug-in that cannot load fails: a 400 0x80040224 fault naming the type and assembly; its operation rolls back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataError } from './data-error.mjs';
import { inspectPackage } from './clr-assembly-reader.mjs';
import { buildClrRuntime, closeClrHostPool } from './plugin-clr.mjs';
import { organizationRecord } from './organization-context.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';
// Native plug-in execution and its message operation are limited to 2 minutes (Learn: Analyze plug-in performance).
const TIMEOUT_MS = 120_000;
const SDK_NAME = 'Microsoft.Xrm.Sdk.dll';
// The sandbox supplies these; a package copy of them is not a dependency of the plug-in.
const PLATFORM_ASSEMBLIES = new Set(['microsoft.xrm.sdk.dll', 'microsoft.crm.sdk.proxy.dll']);
// The verified CI fixture `npm run ci:prepare` restores in a toolkit checkout.
const CI_SDK = fileURLToPath(
  new URL('../../.paqvilo/ci/sdk-reference/reference/lib/net462/Microsoft.Xrm.Sdk.dll', import.meta.url),
);

const idOf = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const canon = (value) =>
  String(idOf(value) ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const rowOf = (store, logical, id) =>
  id == null ? null : (store.tableRows(logical).find((row) => canon(row[`${logical}id`]) === canon(id)) ?? null);
const versionParts = (name) => name.split('.').map((part) => Number.parseInt(part, 10) || 0);
const newestFirst = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

/**
 * The Microsoft.Xrm.Sdk.dll uploaded assemblies compile and run against: the explicit `sdkAssembly` option, else the
 * PAQVILO_XRM_SDK environment variable (an explicit path that does not exist fails rather than falling through), else the
 * newest microsoft.crmsdk.coreassemblies/<version>/lib/net462 in the NuGet global packages folder (NUGET_PACKAGES, else
 * ~/.nuget/packages), else the toolkit's CI fixture. Throws when none exists.
 */
export function resolveXrmSdk({ sdkAssembly, env = process.env } = {}) {
  const explicit = sdkAssembly ?? env.PAQVILO_XRM_SDK;
  if (explicit) {
    const file = path.resolve(explicit);
    if (!fs.existsSync(file))
      throw new Error(
        `${SDK_NAME} was not found at the configured ${sdkAssembly ? 'sdkAssembly' : 'PAQVILO_XRM_SDK'} path.`,
      );
    return file;
  }
  const packages = path.join(
    env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages'),
    'microsoft.crmsdk.coreassemblies',
  );
  let versions = [];
  try {
    versions = fs.readdirSync(packages).sort(newestFirst);
  } catch {
    /* No NuGet copy; the CI fixture is the last candidate. */
  }
  for (const version of versions) {
    const file = path.join(packages, version, 'lib', 'net462', SDK_NAME);
    if (fs.existsSync(file)) return file;
  }
  if (fs.existsSync(CI_SDK)) return CI_SDK;
  throw new Error(
    `${SDK_NAME} was not found: set PAQVILO_XRM_SDK, or restore the microsoft.crmsdk.coreassemblies NuGet package.`,
  );
}

/** The registered assembly with uploaded content that holds plug-in type typeId, else null. */
export function uploadedAssemblyOfType(store, typeId) {
  const type = rowOf(store, 'plugintype', typeId);
  const assembly = type ? rowOf(store, 'pluginassembly', type.pluginassemblyid) : null;
  return typeof assembly?.content === 'string' && assembly.content !== '' ? assembly : null;
}

// The stored bytes of an uploaded assembly and, for a package-owned one, its package's other lib/ assemblies.
function uploadedSource(store, assemblyId) {
  const assembly = rowOf(store, 'pluginassembly', assemblyId);
  if (typeof assembly?.content !== 'string' || !assembly.content)
    throw new Error('The plug-in assembly has no uploaded content.');
  const packageRow = assembly.packageid != null ? rowOf(store, 'pluginpackage', assembly.packageid) : null;
  return { assembly, packageContent: typeof packageRow?.content === 'string' ? packageRow.content : null };
}

// The other lib/ assemblies of the package folder (target framework) that holds the plug-in assembly.
function packageDependencies(packageContent, assemblyName) {
  if (!packageContent) return [];
  const entries = inspectPackage(Buffer.from(packageContent, 'base64')).assemblies;
  const own = entries.find((entry) => entry.name.toLowerCase() === String(assemblyName).toLowerCase());
  if (!own) return [];
  const folder = path.posix.dirname(own.path);
  return entries
    .filter((entry) => entry !== own && path.posix.dirname(entry.path) === folder)
    .map((entry) => ({ name: path.posix.basename(entry.path).replace(/\.dll$/i, '.dll'), bytes: entry.bytes }))
    .filter((entry) => !PLATFORM_ASSEMBLIES.has(entry.name.toLowerCase()));
}

// The organization facts a native context carries when no caller supplies them; the caller's identity wins at execution.
function organizationContext(store) {
  const organizationId =
    canon(organizationRecord(store)?.organizationid ?? store.state?.dataverse?.organizationId) || EMPTY;
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM');
  const root = store.tableRows('businessunit').find((row) => idOf(row.parentbusinessunitid) == null);
  return {
    organizationId,
    businessUnitId: canon(root?.businessunitid) || EMPTY,
    initiatingUserId: canon(system?.systemuserid) || EMPTY,
  };
}

const sameSource = (runtime, assembly, packageContent) =>
  canon(runtime.uploaded.assemblyId) === canon(assembly.pluginassemblyid) &&
  runtime.uploaded.content === assembly.content &&
  runtime.uploaded.packageContent === packageContent;

function loadFault(item, assemblyName, cause) {
  return new DataError(
    `Unable to load plug-in type '${item.typeName}' from assembly '${assemblyName ?? item.assemblyName ?? 'unknown'}': ${cause.message}`,
    400,
    'PluginValidation',
    { innerCode: '0x80040224', loadFailure: cause.code ?? null },
  );
}

/**
 * The prepared runtime of an uploaded step, prepared on first use and again when the stored content changed. Steps of the
 * same uploaded content share one prepared directory. `uploads` = { cacheRoot, sdkAssembly, env }. A failure is the
 * 0x80040224 load fault.
 */
export function uploadedClrRuntime({ store, item, runtimes, uploads = {}, diagnostic = () => {} }) {
  let assembly = null;
  try {
    const source = uploadedSource(store, item.uploadedAssemblyId);
    assembly = source.assembly;
    const current = runtimes.get(item.id);
    if (
      current?.uploaded &&
      sameSource(current, assembly, source.packageContent) &&
      current.descriptor.typeName === item.typeName
    )
      return current;
    if (current?.uploaded) releaseUploadedRuntime(runtimes, item.id, diagnostic);
    const shared = [...runtimes.values()].find(
      (runtime) => runtime.uploaded && sameSource(runtime, assembly, source.packageContent),
    );
    const runtime = shared
      ? {
          ...shared,
          descriptor: { ...shared.descriptor, typeName: item.typeName },
          provenance: { ...shared.provenance, typeName: item.typeName },
        }
      : prepareUploaded({ store, item, assembly, packageContent: source.packageContent, uploads });
    runtimes.set(item.id, runtime);
    return runtime;
  } catch (cause) {
    diagnostic({
      code: 'PLUGIN_CLR_LOAD_FAILED',
      stepId: item.id,
      typeName: item.typeName,
      assemblyName: assembly?.name ?? item.assemblyName ?? null,
      message: cause.message,
    });
    throw loadFault(item, assembly?.name, cause);
  }
}

function prepareUploaded({ store, item, assembly, packageContent, uploads }) {
  const sdk = resolveXrmSdk(uploads);
  const cacheRoot = path.resolve(uploads.cacheRoot ?? path.join('.paqvilo', 'plugin-assemblies'));
  const dependencies = packageDependencies(packageContent, assembly.name);
  const context = organizationContext(store);
  const descriptor = {
    trust: 'execute-local-assembly',
    root: cacheRoot,
    cacheRoot,
    assembly: `${assembly.name}.dll`,
    ...(dependencies.length ? { dependencies: dependencies.map((entry) => entry.name) } : {}),
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    typeName: item.typeName,
    timeoutMs: TIMEOUT_MS,
    // One long-lived host per uploaded content, as one native sandbox worker serves the assembly's steps.
    persistentHost: true,
    context,
    // The SDK service's identities are the organization's users (plugin-clr.mjs dispatchSdkCallCore): SYSTEM for
    // CreateOrganizationService(null), the caller's security roles otherwise.
    serviceProfile: {
      userId: context.initiatingUserId,
      evidence: `Registered pluginassembly ${canon(assembly.pluginassemblyid)} uploaded content`,
      grants: [],
    },
  };
  const read = (file) => fs.readFileSync(file);
  const proxy = path.join(path.dirname(sdk), 'Microsoft.Crm.Sdk.Proxy.dll');
  const runtime = buildClrRuntime(
    descriptor,
    {
      assembly: { name: descriptor.assembly, bytes: Buffer.from(assembly.content, 'base64') },
      sdk: { path: sdk, bytes: read(sdk) },
      dependencies: [...dependencies, ...(fs.existsSync(proxy) ? [{ path: proxy, bytes: read(proxy) }] : [])],
    },
    {
      kind: 'uploaded-plugin-assembly',
      securityModel:
        'Registered uploaded assembly bytes run as the platform runs them; the native process is not a sandbox',
    },
  );
  runtime.uploaded = {
    assemblyId: canon(assembly.pluginassemblyid),
    content: assembly.content,
    packageContent,
  };
  return runtime;
}

/** Closes a step's uploaded runtime; its prepared directory goes once no other step shares it. */
export function releaseUploadedRuntime(runtimes, stepId, diagnostic = () => {}) {
  const runtime = runtimes.get(stepId);
  if (!runtime?.uploaded) return;
  runtimes.delete(stepId);
  if ([...runtimes.values()].some((other) => other.directory === runtime.directory)) return;
  closeClrHostPool({ runtime, diagnostic });
  try {
    fs.rmSync(runtime.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  } catch (cause) {
    diagnostic({ code: 'PLUGIN_CLR_CLEANUP', message: 'Uploaded assembly cache cleanup failed: ' + cause.code });
  }
}

/** Closes the uploaded runtimes whose step (or custom API main operation) is gone, no longer uploaded, or whose stored
 * content changed. */
export function releaseStaleUploadedRuntimes(store, runtimes, steps, diagnostic = () => {}) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const [id, runtime] of [...runtimes]) {
    if (!runtime.uploaded) continue;
    const step = byId.get(id);
    const api = step ? null : rowOf(store, 'customapi', id);
    const assembly = step?.uploadedAssemblyId
      ? rowOf(store, 'pluginassembly', step.uploadedAssemblyId)
      : api?.plugintypeid
        ? uploadedAssemblyOfType(store, api.plugintypeid)
        : null;
    if (
      !assembly ||
      canon(assembly.pluginassemblyid) !== runtime.uploaded.assemblyId ||
      assembly.content !== runtime.uploaded.content
    )
      releaseUploadedRuntime(runtimes, id, diagnostic);
  }
}
