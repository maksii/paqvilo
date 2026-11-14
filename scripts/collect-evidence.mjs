// CI publishes only known synthetic outputs, never the complete development state directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Round evidence carries the writing run in its name (`multipart.run-<pid>.json`), so lanes running at once never
// write the same file.
const RUN = String.raw`\.run-\d+`;
const OUTPUTS = {
  'synthetic-navigation': /^[a-f0-9]{32}-(?:diagnostic\.json|failure\.png)$/,
  'extended-round': new RegExp(
    String.raw`^(?:multipart${RUN}\.json|(?:classic|enhanced)-workflows${RUN}\.(?:json|png)|verify-(?:classic|enhanced)-(?:baseline|working-copy)${RUN}\.json)$`,
  ),
  'multi-portal-round': new RegExp(String.raw`^(?:acceptance|cli-smoke)${RUN}\.json$`),
};

const processRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/**
 * The path a browser test writes the round evidence `name` (for example `multipart.json`) to: `<stateDir>/<round>/`,
 * with this run in the file name. A name the collector would not publish is refused, so a test cannot write evidence
 * the collector misses. Writing removes the same evidence of runs that have ended, so a developer's state directory
 * keeps one file per name and running lane; the collector itself never deletes evidence.
 */
export function syntheticEvidencePath(stateDir, round, name, pid = process.pid) {
  const extension = path.extname(name);
  const stem = name.slice(0, -extension.length);
  const file = `${stem}.run-${pid}${extension}`;
  if (round === 'synthetic-navigation' || !OUTPUTS[round]?.test(file))
    throw new Error(`The evidence collector does not publish ${round}/${file}.`);
  const folder = path.join(stateDir, round);
  fs.mkdirSync(folder, { recursive: true });
  const earlier = new RegExp(String.raw`^${RegExp.escape(stem)}\.run-(\d+)${RegExp.escape(extension)}$`);
  for (const entry of fs.readdirSync(folder)) {
    const run = earlier.exec(entry)?.[1];
    if (run && Number(run) !== pid && !processRunning(Number(run)))
      fs.rmSync(path.join(folder, entry), { force: true });
  }
  return path.join(folder, file);
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const ordinaryFile = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n && entry.size >= 0n;

function cleanup(callbacks) {
  const errors = [];
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Synthetic evidence cleanup failed.');
}

function transfer(size, read, write) {
  const buffer = Buffer.alloc(64 * 1024);
  let copied = 0n;
  while (copied < size) {
    const remaining = size - copied;
    const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
    const count = read(buffer, length, copied);
    if (!count) return false;
    let written = 0;
    while (written < count) {
      const bytes = write(buffer, written, count - written);
      if (!bytes) throw new Error('Synthetic evidence output could not be written.');
      written += bytes;
    }
    copied += BigInt(count);
  }
  return true;
}

function assertStage(root, stage, entry) {
  const current = fs.lstatSync(stage, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFile(current, entry) ||
    path.relative(root, fs.realpathSync.native(stage)) !== path.basename(stage) ||
    !path.basename(stage).startsWith('.ci-evidence-stage-')
  )
    throw new Error('Synthetic evidence private staging directory changed or escaped its owned root.');
}

function removeStage(root, stage, entry) {
  assertStage(root, stage, entry);
  fs.rmSync(stage, { recursive: true, force: true });
}

function publish({ root, output, outputEntry, qualify, folder = '', name, size, read }) {
  const destination = path.join(output, folder);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const directoryEntry = fs.lstatSync(destination, { bigint: true });
  const confined = () => {
    qualify();
    const parent = fs.lstatSync(output, { bigint: true });
    const current = fs.lstatSync(destination, { bigint: true });
    return (
      parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      sameFile(parent, outputEntry) &&
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      sameFile(current, directoryEntry) &&
      path.relative(root, fs.realpathSync.native(output)) === path.relative(root, output) &&
      path.relative(output, fs.realpathSync.native(destination)) === folder
    );
  };
  if (!confined()) throw new Error('Synthetic evidence output directory changed or escaped its owned root.');
  const target = path.join(destination, name);
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const leafConfined = () => {
      const entry = fs.lstatSync(target, { bigint: true });
      return (
        ordinaryFile(entry) &&
        sameFile(entry, opened) &&
        path.relative(destination, fs.realpathSync.native(target)) === name
      );
    };
    if (!confined() || !ordinaryFile(opened) || !leafConfined())
      throw new Error('Synthetic evidence output directory or file changed before copying.');
    if (!transfer(size, read, (buffer, offset, length) => fs.writeSync(descriptor, buffer, offset, length)))
      throw new Error('Synthetic evidence snapshot ended before its verified size.');
    const final = fs.fstatSync(descriptor, { bigint: true });
    if (!confined() || !leafConfined() || !ordinaryFile(final) || final.size !== size || !sameFile(final, opened))
      throw new Error('Synthetic evidence output directory or file changed while copying.');
  } finally {
    fs.closeSync(descriptor);
  }
}

function snapshotSource({ root, source, sourceEntry, name, stage, stageEntry, accept }) {
  const file = path.join(source, name);
  const snapshot = path.join(stage, 'source-snapshot');
  let descriptor, snapshotDescriptor, snapshotEntry;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!ordinaryFile(opened) || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    const confined = () => {
      const parent = fs.lstatSync(source, { bigint: true });
      const entry = fs.lstatSync(file, { bigint: true });
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        !sameFile(parent, sourceEntry) ||
        !ordinaryFile(entry) ||
        !sameFile(entry, opened)
      )
        return false;
      if (
        path.relative(root, fs.realpathSync.native(source)) !== path.basename(source) ||
        path.relative(source, fs.realpathSync.native(file)) !== name
      )
        return false;
      const current = fs.lstatSync(file, { bigint: true });
      return ordinaryFile(current) && sameFile(current, opened);
    };
    if (!confined()) return false;
    // This directory never matches the workflow upload glob. Unvalidated bytes stay private until accepted.
    assertStage(root, stage, stageEntry);
    snapshotDescriptor = fs.openSync(snapshot, 'wx+', 0o600);
    snapshotEntry = fs.fstatSync(snapshotDescriptor, { bigint: true });
    assertStage(root, stage, stageEntry);
    if (!ordinaryFile(snapshotEntry)) throw new Error('Synthetic evidence snapshot is not an owned ordinary file.');
    if (
      !transfer(
        opened.size,
        (buffer, length, offset) => fs.readSync(descriptor, buffer, 0, length, Number(offset)),
        (buffer, offset, length) => fs.writeSync(snapshotDescriptor, buffer, offset, length),
      )
    )
      return false;
    const sentinel = Buffer.alloc(1);
    if (fs.readSync(descriptor, sentinel, 0, 1, Number(opened.size))) return false;
    const final = fs.fstatSync(descriptor, { bigint: true });
    const staged = fs.fstatSync(snapshotDescriptor, { bigint: true });
    if (
      !ordinaryFile(final) ||
      !sameFile(final, opened) ||
      final.size !== opened.size ||
      final.mtimeNs !== opened.mtimeNs ||
      final.ctimeNs !== opened.ctimeNs ||
      !confined() ||
      !ordinaryFile(staged) ||
      staged.size !== opened.size
    )
      return false;
    assertStage(root, stage, stageEntry);
    accept(opened.size, (buffer, length, offset) => fs.readSync(snapshotDescriptor, buffer, 0, length, Number(offset)));
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes(error.code)) return false;
    throw error;
  } finally {
    cleanup([
      () => {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      },
      () => {
        if (snapshotDescriptor !== undefined) fs.closeSync(snapshotDescriptor);
      },
      () => {
        if (!snapshotEntry) return;
        assertStage(root, stage, stageEntry);
        const current = fs.lstatSync(snapshot, { bigint: true });
        if (ordinaryFile(current) && sameFile(current, snapshotEntry)) fs.unlinkSync(snapshot);
      },
    ]);
  }
}

export function collectSyntheticEvidence(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const root = fs.realpathSync.native(stateDir);
  const rootEntry = fs.lstatSync(root, { bigint: true });
  // Leading dot deliberately excludes all staging bytes from .paqvilo/ci-evidence-*/ uploads.
  const stage = fs.mkdtempSync(path.join(root, '.ci-evidence-stage-'));
  const stageEntry = fs.lstatSync(stage, { bigint: true });
  const publication = path.join(stage, 'publication');
  const files = [];
  try {
    fs.mkdirSync(publication, { mode: 0o700 });
    const outputEntry = fs.lstatSync(publication, { bigint: true });
    for (const [folder, allowed] of Object.entries(OUTPUTS)) {
      const source = path.join(root, folder);
      if (!fs.existsSync(source)) continue;
      const sourceEntry = fs.lstatSync(source, { bigint: true });
      if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) continue;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (!entry.isFile() || !allowed.test(entry.name)) continue;
        const accepted = snapshotSource({
          root,
          source,
          sourceEntry,
          name: entry.name,
          stage,
          stageEntry,
          accept: (size, read) =>
            publish({
              root,
              output: publication,
              outputEntry,
              qualify: () => assertStage(root, stage, stageEntry),
              folder,
              name: entry.name,
              size,
              read,
            }),
        });
        if (accepted) files.push(path.join(folder, entry.name).replaceAll('\\', '/'));
      }
    }
    const manifest = Buffer.from(JSON.stringify({ synthetic: true, files }, null, 2) + '\n');
    publish({
      root,
      output: publication,
      outputEntry,
      name: 'manifest.json',
      size: BigInt(manifest.length),
      qualify: () => assertStage(root, stage, stageEntry),
      read: (buffer, length, offset) => manifest.copy(buffer, 0, Number(offset), Number(offset) + length),
    });
    const currentRoot = fs.lstatSync(root, { bigint: true });
    const currentOutput = fs.lstatSync(publication, { bigint: true });
    assertStage(root, stage, stageEntry);
    if (
      !currentRoot.isDirectory() ||
      currentRoot.isSymbolicLink() ||
      !sameFile(currentRoot, rootEntry) ||
      path.relative(root, fs.realpathSync.native(root)) !== '' ||
      !currentOutput.isDirectory() ||
      currentOutput.isSymbolicLink() ||
      !sameFile(currentOutput, outputEntry) ||
      path.relative(stage, fs.realpathSync.native(publication)) !== 'publication'
    )
      throw new Error('Synthetic evidence output directory changed before publication.');
    const output = path.join(root, 'ci-evidence-' + randomUUID().replaceAll('-', ''));
    fs.renameSync(publication, output);
    return { output, files };
  } finally {
    // Only this fresh private staging tree is removed; leaf substitutions never trigger pathname deletion.
    removeStage(root, stage, stageEntry);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = collectSyntheticEvidence(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.paqvilo'));
  console.log(`Collected ${result.files.length} synthetic evidence files in ${result.output}`);
}
