// Only the invented acceptance-navigation fixture may publish these diagnostic artifacts.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertTemporaryDirectory } from '../testing/owned-fixture.mjs';

const fixtureName = 'paqvilo-document-commit-';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxJson = 64 * 1024;
const limit = (value, maximum) => (Array.isArray(value) ? value.slice(0, maximum) : []);
const number = (value) => (Number.isFinite(value) ? value : undefined);
const id = (value) => (typeof value === 'string' && /^[a-f0-9-]{1,128}$/i.test(value) ? value : undefined);
const method = (value) =>
  ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'].includes(value) ? value : undefined;
const url = (value) => {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      ? `${parsed.origin}${parsed.pathname.slice(0, 256)}`
      : '<external>';
  } catch {
    return '<invalid>';
  }
};
const request = (row) => ({
  method: method(row.method),
  url: url(row.url),
  status: number(row.status),
  finished: typeof row.finished === 'boolean' ? row.finished : undefined,
  durationMs: number(row.durationMs),
  elapsedMs: number(row.elapsedMs),
});
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const ordinaryFile = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n;

async function ordinaryDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const entry = await fs.lstat(directory, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error('Synthetic evidence directories must not be links.');
  return entry;
}

async function readArtifact(directory, sourceEntry, name, maximum) {
  const file = path.join(directory, name);
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const ordinary = (entry) => ordinaryFile(entry) && entry.size <= BigInt(maximum);
    if (!ordinary(opened)) throw Error('Synthetic navigation artifact must be an ordinary bounded file.');
    const assertSource = async () => {
      const current = await fs.lstat(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, sourceEntry))
        throw Error('Synthetic navigation source directory changed while opening.');
      if (path.relative(directory, await fs.realpath(directory)))
        throw Error('Synthetic navigation source directory changed or escaped its owned root.');
    };
    await assertSource();
    const entry = await fs.lstat(file, { bigint: true });
    if (!ordinary(entry)) throw Error('Synthetic navigation artifact must be an ordinary bounded file.');
    if (path.relative(directory, await fs.realpath(file)) !== name)
      throw Error('Synthetic navigation artifact escaped its owned directory.');
    const current = await fs.lstat(file, { bigint: true });
    if (
      !ordinary(current) ||
      [entry, current].some((candidate) => candidate.dev !== opened.dev || candidate.ino !== opened.ino)
    )
      throw Error('Synthetic navigation artifact changed while opening.');
    // A fixed buffer also bounds a file that grows after the metadata checks; read only this verified descriptor.
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw Error('Synthetic navigation artifact exceeds its bound.');
    await assertSource();
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function discardArtifact(file, opened) {
  try {
    const current = await fs.lstat(file, { bigint: true });
    if (ordinaryFile(current) && sameIdentity(current, opened)) await fs.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function writeArtifact(directory, name, bytes, assertPublication) {
  const file = path.join(directory, name);
  let handle, opened;
  let complete = false;
  try {
    await assertPublication();
    handle = await fs.open(file, 'wx', 0o600);
    opened = await handle.stat({ bigint: true });
    await assertPublication();
    const assertLeaf = async () => {
      const entry = await fs.lstat(file, { bigint: true });
      if (!ordinaryFile(opened) || !ordinaryFile(entry) || !sameIdentity(opened, entry))
        throw Error('Synthetic navigation publication file changed while writing.');
      if (path.relative(directory, await fs.realpath(file)) !== name)
        throw Error('Synthetic navigation publication file escaped its owned directory.');
    };
    await assertLeaf();
    await handle.writeFile(bytes);
    await assertPublication();
    await assertLeaf();
    complete = true;
  } finally {
    await handle?.close();
    if (opened && !complete) await discardArtifact(file, opened);
  }
}

/** Preserve an explicit safe projection, never a report/state/header/body tree. */
export async function preserveNavigationEvidence(
  root,
  flow,
  { toolkitRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {},
) {
  root = await assertTemporaryDirectory(root);
  if (!path.basename(root).startsWith(fixtureName))
    throw Error('Only the invented navigation fixture may publish evidence.');
  const source = path.join(root, 'evidence');
  const sourceEntry = await fs.lstat(source, { bigint: true });
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink())
    throw Error('Synthetic evidence source must not be a link.');
  for (const screenshot of flow.screenshots ?? [])
    if (
      !['1-Document-boundary-failure.png', '1-Document-boundary-final.png'].some(
        (name) => path.resolve(screenshot) === path.join(source, name),
      )
    )
      throw Error('Synthetic navigation screenshot is outside the explicit fixture allowlist.');
  const failurePng = await readArtifact(source, sourceEntry, '1-Document-boundary-failure.png', 2 * 1024 * 1024);
  const finalPng = failurePng
    ? null
    : await readArtifact(source, sourceEntry, '1-Document-boundary-final.png', 2 * 1024 * 1024);
  const png = failurePng ?? finalPng;
  if (png && !png.subarray(0, 8).equals(pngSignature)) throw Error('Synthetic navigation screenshot must be a PNG.');
  const network = await readArtifact(source, sourceEntry, '1-browser-network.json', 1024 * 1024);
  const parsed = network ? JSON.parse(network) : {};
  const diagnostic = {
    synthetic: true,
    fixture: 'invented-acceptance-navigation',
    passed: Boolean(flow.passed),
    imageStage: failurePng ? 'flow-failure' : finalPng ? 'final' : null,
    errorKind: flow.error
      ? String(flow.error).startsWith('locator.waitFor:')
        ? 'locator-timeout'
        : 'acceptance-failure'
      : null,
    steps: limit(flow.steps, 20).map((step) => ({
      action: ['navigate', 'visible', 'click', 'settle'].includes(step.action) ? step.action : 'other',
      passed: Boolean(step.passed),
      status: number(step.status),
    })),
    resources: limit(flow.resources, 80).map(request),
    pendingRequests: limit(flow.pendingRequests, 80).map(request),
    navigationCancelledRequests: limit(flow.navigationCancelledRequests, 20).map((row) => ({
      ...request(row),
      reason: ['document-replaced', 'frame-detached'].includes(row.reason) ? row.reason : undefined,
    })),
    finalFrameTree: limit(flow.finalFrameTree, 20).map((row) => ({
      id: id(row.id),
      parentId: id(row.parentId),
      loaderId: id(row.loaderId),
    })),
    frameEvents: limit(parsed.frameEvents, 100).map((row) => ({
      event: ['frameAttached', 'frameDetached', 'frameNavigated'].includes(row.event) ? row.event : undefined,
      frameId: id(row.frameId),
      parentFrameId: id(row.parentFrameId),
      loaderId: id(row.loaderId),
      reason: ['swap', 'remove'].includes(row.reason) ? row.reason : undefined,
    })),
    fixtureEvents: limit(flow.fixtureEvents, 20).filter((value) =>
      [
        'navigation',
        'late-writes-released',
        'gate-read-finished',
        'read:/never',
        'read-observed:/never',
        'history-released',
        'history-observed',
        'no-content-gate-read-finished',
        'write-observed:/slow-one',
        'write-observed:/slow-two',
        'write:/slow-one',
        'write:/slow-two',
        'document-response',
      ].includes(value),
    ),
  };
  const json = JSON.stringify(diagnostic, null, 2) + '\n';
  if (Buffer.byteLength(json) > maxJson) throw Error('Synthetic navigation diagnostic exceeds its bound.');
  const toolkit = await fs.realpath(toolkitRoot);
  const state = path.join(toolkit, '.paqvilo');
  const stateEntry = await ordinaryDirectory(state);
  const destination = path.join(state, 'synthetic-navigation');
  const destinationEntry = await ordinaryDirectory(destination);
  const assertPublication = async () => {
    const currentState = await fs.lstat(state, { bigint: true });
    const currentDestination = await fs.lstat(destination, { bigint: true });
    if (
      !currentState.isDirectory() ||
      currentState.isSymbolicLink() ||
      !sameIdentity(currentState, stateEntry) ||
      !currentDestination.isDirectory() ||
      currentDestination.isSymbolicLink() ||
      !sameIdentity(currentDestination, destinationEntry) ||
      path.relative(toolkit, await fs.realpath(state)) !== '.paqvilo' ||
      path.relative(state, await fs.realpath(destination)) !== 'synthetic-navigation'
    )
      throw Error('Synthetic navigation publication directory changed or escaped its owned root.');
  };
  const prefix = randomUUID().replaceAll('-', '');
  const files = [`${prefix}-diagnostic.json`];
  await writeArtifact(destination, files[0], json, assertPublication);
  if (png) {
    files.push(`${prefix}-failure.png`);
    await writeArtifact(destination, files[1], png, assertPublication);
  }
  return { destination, files };
}
