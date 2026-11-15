import fs from 'node:fs';
import path from 'node:path';
import { validateClrDescriptor } from '../../lib/plugin-clr.mjs';

const proxyAssembly = 'Microsoft.Crm.Sdk.Proxy.dll';
const hostAssembly = 'paqvilo-plugin-host.exe';
const fixtureError = (message) => new Error(`Invalid prepared CLR fixture mapping: ${message}`);
const pathKey = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

function physical(value, label) {
  if (typeof value !== 'string' || !value) throw fixtureError(`${label} is missing.`);
  try {
    return pathKey(fs.realpathSync.native(value));
  } catch (cause) {
    throw fixtureError(`${label} must name an existing physical path (${cause.code ?? 'unavailable'}).`);
  }
}

function pathParts(value) {
  const absolute = path.resolve(value);
  const anchor = path.parse(absolute).root;
  let current = anchor;
  return absolute
    .slice(anchor.length)
    .split(path.sep)
    .filter(Boolean)
    .map((part) => (current = path.join(current, part)));
}

function canonicalCacheDirectory(value, label) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value))
    throw fixtureError(`${label} must be an absolute directory.`);
  try {
    for (const part of pathParts(value)) {
      const stat = fs.lstatSync(part);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fixtureError(`${label} cannot contain symlink components.`);
    }
    return pathKey(fs.realpathSync.native(value));
  } catch (cause) {
    if (cause.message?.startsWith('Invalid prepared CLR fixture mapping:')) throw cause;
    throw fixtureError(`${label} must be a physical directory (${cause.code ?? 'unavailable'}).`);
  }
}

function within(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw fixtureError(`${label} escaped its declared root.`);
  return relative;
}

/** Mirror readClrDependency's relative source policy without rereading or hashing the prepared bytes. */
function confinedSource(root, relative, label) {
  const realRoot = physical(root, `${label} root`);
  const candidate = path.resolve(realRoot, relative);
  const lexicalRelative = within(realRoot, candidate, label);
  let current = realRoot;
  try {
    for (const part of lexicalRelative.split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw fixtureError(`${label} cannot traverse symlink components.`);
    }
    const opened = fs.statSync(candidate);
    const named = fs.lstatSync(candidate);
    if (!opened.isFile() || named.isSymbolicLink()) throw fixtureError(`${label} must be a regular non-symlink file.`);
    const actual = pathKey(fs.realpathSync.native(candidate));
    within(realRoot, actual, label);
    return actual;
  } catch (cause) {
    if (cause.message?.startsWith('Invalid prepared CLR fixture mapping:')) throw cause;
    throw fixtureError(`${label} must be a readable regular file (${cause.code ?? 'unavailable'}).`);
  }
}

function sourcePath(file, label) {
  if (typeof file?.sourcePath !== 'string' || !file.sourcePath)
    throw fixtureError(`${label} must have a captured source path.`);
  const captured = physical(file.sourcePath, label);
  try {
    for (const part of pathParts(file.sourcePath)) {
      const stat = fs.lstatSync(part);
      if (stat.isSymbolicLink()) throw fixtureError(`${label} cannot contain symlink components.`);
    }
    if (!fs.statSync(file.sourcePath).isFile()) throw fixtureError(`${label} must be a regular file.`);
  } catch (cause) {
    if (cause.message?.startsWith('Invalid prepared CLR fixture mapping:')) throw cause;
    throw fixtureError(`${label} must be a physical regular file (${cause.code ?? 'unavailable'}).`);
  }
  return captured;
}

function runtimeSnapshotPath(file, directory, source, label) {
  const captured = physical(file?.path, `${label} snapshot path`);
  within(directory, captured, `${label} snapshot`);
  if (pathKey(path.dirname(captured)) !== directory)
    throw fixtureError(`${label} snapshot must be directly inside its runtime directory.`);
  const expectedName = pathKey(path.basename(source));
  if (pathKey(path.basename(captured)) !== expectedName)
    throw fixtureError(`${label} snapshot name does not match its captured source.`);
  try {
    const named = fs.lstatSync(file.path);
    if (named.isSymbolicLink() || !named.isFile()) throw fixtureError(`${label} snapshot must be a regular non-symlink file.`);
  } catch (cause) {
    if (cause.message?.startsWith('Invalid prepared CLR fixture mapping:')) throw cause;
    throw fixtureError(`${label} snapshot must be a regular file (${cause.code ?? 'unavailable'}).`);
  }
  return captured;
}

function validatePreparedPair(descriptor, runtime) {
  try {
    validateClrDescriptor(descriptor);
  } catch (cause) {
    throw fixtureError(`descriptor failed production validation (${cause.code ?? cause.name ?? 'invalid'}).`);
  }
  if (!runtime || typeof runtime !== 'object' || runtime.descriptor !== descriptor)
    throw fixtureError('the descriptor must be the exact descriptor object captured by its runtime.');
  if (!Array.isArray(runtime.files) || runtime.files.length < 3)
    throw fixtureError('captured assembly, SDK and host files are required.');

  const cache = canonicalCacheDirectory(descriptor.cacheRoot, 'declared cache root');
  const runtimeDirectory = canonicalCacheDirectory(runtime.directory, 'captured runtime directory');
  if (pathKey(path.dirname(runtimeDirectory)) !== cache)
    throw fixtureError('declared cache root must be the physical parent of the captured runtime directory.');

  const hostEntries = runtime.files.filter((file) => typeof file?.sourcePath !== 'string' || !file.sourcePath);
  if (hostEntries.length !== 1 || runtime.files.at(-1) !== hostEntries[0])
    throw fixtureError('the final captured file must be the one source-less compiled host executable.');
  if (typeof runtime.executable !== 'string' || !runtime.executable)
    throw fixtureError('the compiled host executable path is missing.');
  const executable = physical(runtime.executable, 'compiled host executable');
  const expectedExecutable = pathKey(path.join(runtimeDirectory, hostAssembly));
  if (executable !== expectedExecutable || physical(hostEntries[0].path, 'captured host executable') !== executable)
    throw fixtureError('the source-less captured file must be the expected host inside the runtime directory.');
  try {
    const named = fs.lstatSync(runtime.executable);
    if (named.isSymbolicLink() || !named.isFile()) throw fixtureError('the compiled host must be a regular non-symlink file.');
  } catch (cause) {
    if (cause.message?.startsWith('Invalid prepared CLR fixture mapping:')) throw cause;
    throw fixtureError(`compiled host must be a regular file (${cause.code ?? 'unavailable'}).`);
  }

  const sourceFiles = runtime.files.slice(0, -1);
  const assembly = sourcePath(sourceFiles[0], 'captured assembly source');
  const sdk = sourcePath(sourceFiles[1], 'captured SDK source');
  if (assembly !== confinedSource(descriptor.root, descriptor.assembly, 'declared assembly source'))
    throw fixtureError('declared assembly source does not match captured file 0.');
  if (sdk !== confinedSource(descriptor.sdkRoot, descriptor.sdkAssembly, 'declared SDK source'))
    throw fixtureError('declared SDK source does not match captured file 1.');
  const assemblySnapshot = runtimeSnapshotPath(sourceFiles[0], runtimeDirectory, assembly, 'assembly');
  if (physical(runtime.assembly, 'runtime assembly') !== assemblySnapshot)
    throw fixtureError('runtime.assembly must be the captured assembly snapshot.');
  try {
    const namedAssembly = fs.lstatSync(runtime.assembly);
    if (namedAssembly.isSymbolicLink() || !namedAssembly.isFile())
      throw fixtureError('runtime.assembly must be a regular non-symlink file.');
  } catch (cause) {
    if (cause.message?.startsWith('Invalid prepared CLR fixture mapping:')) throw cause;
    throw fixtureError(`runtime.assembly must be a regular file (${cause.code ?? 'unavailable'}).`);
  }
  runtimeSnapshotPath(sourceFiles[1], runtimeDirectory, sdk, 'SDK');

  const declaredDependencies = (descriptor.dependencies ?? []).map((relative) =>
    confinedSource(descriptor.root, relative, 'declared dependency source'),
  );
  const declaredSet = new Set(declaredDependencies);
  if (declaredSet.size !== declaredDependencies.length)
    throw fixtureError('declared dependency sources must be unique.');
  const dependencyFiles = sourceFiles.slice(2);
  const capturedDependencies = dependencyFiles.map((file) => sourcePath(file, 'captured dependency source'));
  const capturedSet = new Set(capturedDependencies);
  if (capturedSet.size !== capturedDependencies.length)
    throw fixtureError('captured dependency sources must be unique.');
  dependencyFiles.forEach((file, index) => runtimeSnapshotPath(file, runtimeDirectory, capturedDependencies[index], 'dependency'));

  const missing = declaredDependencies.filter((source) => !capturedSet.has(source));
  if (missing.length) throw fixtureError('a declared dependency does not match the captured dependency sources.');
  const extras = capturedDependencies.filter((source) => !declaredSet.has(source));
  const declaredProxy = (descriptor.dependencies ?? []).some((relative) => basename(relative) === proxyAssembly.toLowerCase());
  if (extras.length > 1 || (extras.length && declaredProxy))
    throw fixtureError('captured dependencies contain an undeclared source.');
  if (!declaredProxy) {
    let sdkProxy = null;
    try {
      sdkProxy = confinedSource(descriptor.sdkRoot, proxyAssembly, 'SDK proxy source');
    } catch {
      // Production preparation treats any missing/unreadable implicit SDK proxy as absent.
    }
    if (sdkProxy) {
      if (extras.length !== 1 || extras[0] !== sdkProxy)
        throw fixtureError('the only permitted extra source is the SDK-root Microsoft.Crm.Sdk.Proxy.dll.');
    } else if (extras.length) {
      throw fixtureError('captured dependencies contain an undeclared source.');
    }
  }
}

function basename(value) {
  return path.posix.basename(value.replaceAll('\\', '/')).toLowerCase();
}

/** Return the exact caller-prepared runtime for each exact descriptor object. Test fixture only. */
export function createPreparedClrRuntimePreparer(runtimes, descriptors) {
  if (!(runtimes instanceof Map) || !(descriptors instanceof Map) || runtimes.size !== descriptors.size)
    throw fixtureError('runtime and descriptor maps must have matching keys.');

  const byDescriptor = new Map();
  for (const [stepId, runtime] of runtimes) {
    if (!descriptors.has(stepId)) throw fixtureError('every runtime must have a descriptor entry.');
    const descriptor = descriptors.get(stepId);
    if (!descriptor || typeof descriptor !== 'object') throw fixtureError('every runtime must have a descriptor object.');
    const existing = byDescriptor.get(descriptor);
    if (existing && existing !== runtime)
      throw fixtureError('one descriptor object cannot identify different prepared runtime objects.');
    validatePreparedPair(descriptor, runtime);
    byDescriptor.set(descriptor, runtime);
  }
  for (const stepId of descriptors.keys())
    if (!runtimes.has(stepId)) throw fixtureError('every descriptor must have a runtime entry.');

  return (descriptor) => {
    if (!byDescriptor.has(descriptor)) throw fixtureError('backend requested an unknown descriptor object.');
    return byDescriptor.get(descriptor);
  };
}
