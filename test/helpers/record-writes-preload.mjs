// Preloaded (--import) into a command under test by write-recorder.mjs: appends every file-system write the process
// attempts inside the watched roots to the recorder's log. Reads are not recorded.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const log = process.env.PAQ_TEST_WRITE_LOG;
const fold = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const roots = JSON.parse(process.env.PAQ_TEST_WRITE_ROOTS ?? '[]').map((root) => fold(path.resolve(root)));
const append = fs.appendFileSync;

function record(operation, target) {
  let file = target;
  if (file instanceof URL) file = fileURLToPath(file);
  else if (Buffer.isBuffer(file)) file = file.toString();
  if (typeof file !== 'string') return; // a file descriptor: its open() was already seen
  const resolved = path.resolve(file);
  if (roots.some((root) => fold(resolved) === root || fold(resolved).startsWith(root + path.sep)))
    append(log, JSON.stringify({ operation, file: resolved }) + '\n');
}

// [name, indexes of the arguments that name what is written]
const WRITES = [
  ['writeFile', [0]],
  ['appendFile', [0]],
  ['mkdir', [0]],
  ['mkdtemp', [0]],
  ['rm', [0]],
  ['rmdir', [0]],
  ['unlink', [0]],
  ['truncate', [0]],
  ['utimes', [0]],
  ['chmod', [0]],
  ['rename', [0, 1]],
  ['copyFile', [1]],
  ['cp', [1]],
  ['symlink', [1]],
  ['link', [1]],
  ['createWriteStream', [0]],
];
const opensForWriting = (flags) => (typeof flags === 'number' ? (flags & 3) !== 0 : !/^rs?$/.test(flags ?? 'r'));

function wrap(owner, name, operation, targets) {
  const original = owner[name];
  if (typeof original !== 'function') return;
  owner[name] = function (...args) {
    if (targets) for (const index of targets) record(operation, args[index]);
    else if (opensForWriting(typeof args[1] === 'function' ? undefined : args[1])) record(operation, args[0]);
    return Reflect.apply(original, this, args);
  };
}

if (log && roots.length) {
  for (const [name, targets] of WRITES) {
    wrap(fs, name, name, targets);
    wrap(fs, `${name}Sync`, name, targets);
    wrap(fs.promises, name, name, targets);
  }
  wrap(fs, 'open', 'open');
  wrap(fs, 'openSync', 'open');
  wrap(fs.promises, 'open', 'open');
  syncBuiltinESMExports();
}
