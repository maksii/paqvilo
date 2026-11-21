import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/*
 * Project code (a data pack's plug-in step handler) runs on the runtime's main thread, as the rest of the runtime
 * does. Two faults of that code would otherwise take the whole runtime with them, with no word about the cause:
 *
 * - A handler that never returns (an endless loop) blocks every request for good. Nothing on the main thread can
 *   notice it, so a watch thread does: the main thread marks the project code it enters (`projectCode`), and once such
 *   a section has run for the plug-in time limit the watch thread writes the cause and ends the process. JavaScript
 *   offers no way to interrupt the loop and keep the process, and Dataverse ends a plug-in at the same limit.
 * - An error thrown later from a callback that project code scheduled (a timer, an unawaited promise) is an uncaught
 *   exception of the process. `guardProjectCodeFaults` reports it as a diagnostic and keeps the runtime serving; an
 *   uncaught error of the toolkit's own code still ends the process as before.
 *
 * Both are installed by the process that serves a runtime (cli-command.mjs), never by a library user or a test.
 */

/** The time a plug-in may run on Dataverse, which is also the limit of a local step handler. */
const PROJECT_CODE_LIMIT_MS = 120_000;
const LABEL_BYTES = 512;
const ACTIVE = 0;
const WAITING = 1;
const LENGTH = 2;

let shared = null;
/** Sections entered and not yet left, innermost last: a step handler whose SDK call runs another step. */
const sections = [];

function publish() {
  const current = sections.at(-1);
  if (!current) {
    Atomics.store(shared.flags, ACTIVE, 0);
    return;
  }
  const bytes = shared.encoder.encode(current.label).subarray(0, LABEL_BYTES);
  shared.label.set(bytes);
  Atomics.store(shared.flags, LENGTH, bytes.length);
  shared.started[0] = current.started;
  Atomics.store(shared.flags, ACTIVE, sections.length);
}

/** Runs `run`, synchronous project code named `label`, where the watch thread can see how long it has been running. */
export function projectCode(label, run) {
  if (!shared) return run();
  sections.push({ label, started: Date.now() });
  publish();
  try {
    return run();
  } finally {
    sections.pop();
    publish();
  }
}

/**
 * Runs `run`, a wait the runtime itself makes on the main thread with its own deadline (a CLR call, a bridged web hook):
 * the time it takes is not time of the project code around it, whose clock starts again when the wait ends.
 */
export function designedWait(run) {
  if (!shared) return run();
  Atomics.add(shared.flags, WAITING, 1);
  try {
    return run();
  } finally {
    const now = Date.now();
    for (const section of sections) section.started = now;
    if (sections.length) shared.started[0] = now;
    Atomics.sub(shared.flags, WAITING, 1);
  }
}

/** The message the watch thread writes before it ends the process. */
export const stalledMessage = (label, limitMs) =>
  `Mirage stopped: ${label} did not return within ${Math.round(limitMs / 1000)} s (Dataverse ends a plug-in at its 2-minute limit). ` +
  'Code that never returns blocks every request of this runtime. Fix it and start Mirage again.\n';

/**
 * Starts the watch thread of this process. `limitMs` is the longest a marked section may run. Returns a function that
 * stops the watch. The thread never keeps the process running.
 */
export function watchProjectCode({ limitMs = PROJECT_CODE_LIMIT_MS, intervalMs = 1000 } = {}) {
  if (shared) return () => {};
  const flags = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
  const started = new Float64Array(new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT));
  const label = new Uint8Array(new SharedArrayBuffer(LABEL_BYTES));
  const worker = new Worker(new URL('./project-code-watch-worker.mjs', import.meta.url), {
    workerData: { flags, started, label, limitMs, intervalMs, pid: process.pid },
    stdout: false,
    stderr: false,
  });
  worker.unref();
  worker.on('error', () => {});
  shared = { flags, started, label, encoder: new TextEncoder(), worker };
  return () => {
    const current = shared;
    shared = null;
    sections.length = 0;
    return current?.worker.terminate();
  };
}

/** Hosts of this process that record a project code fault as their diagnostic. */
const faultListeners = new Set();
/** Registers `listener(diagnostic)` for the faults the guard of this process reports; returns its removal. */
export function onProjectCodeFault(listener) {
  faultListeners.add(listener);
  return () => faultListeners.delete(listener);
}

const TOOLKIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The location of one stack frame: the text in its last parentheses, or all of it after `at`; null when it is no frame. */
function frameLocation(line) {
  const text = line.trim();
  if (text === line || !text.startsWith('at ')) return null;
  const open = text.lastIndexOf('(');
  return open !== -1 && text.endsWith(')') ? text.slice(open + 1, -1) : text.slice(3).trim();
}
const FILE_POSITION = /^((?:file:\/\/|[A-Za-z]:[\\/]|\/).*):(\d+):\d+$/;

/**
 * Where an uncaught error was thrown, when that is a file outside the toolkit (project code: a data pack module or a
 * file it imports): `{ file, line }`; null for the toolkit's own code, Node's internals, or an error without a stack.
 */
export function projectCodeOrigin(error, toolkitRoot = TOOLKIT_ROOT) {
  if (typeof error?.stack !== 'string') return null;
  for (const line of error.stack.split('\n').slice(1)) {
    const location = frameLocation(line);
    if (location === null) return null;
    // A frame without a file (node:internal, native, eval) says nothing about the origin: look at the next one.
    const frame = FILE_POSITION.exec(location);
    if (!frame) continue;
    let file = frame[1];
    if (file.startsWith('file:')) {
      try {
        file = fileURLToPath(file);
      } catch {
        return null;
      }
    }
    const relative = path.relative(toolkitRoot, path.resolve(file));
    const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    // A project's node_modules copy of the toolkit is the toolkit, wherever the project keeps it.
    if (inside || /[\\/]node_modules[\\/]paqvilo[\\/]/.test(file)) return null;
    return { file, line: Number(frame[2]) };
  }
  return null;
}

/**
 * Keeps the runtime of this process serving when project code throws outside a request: an error whose origin is a
 * project file is passed to `report` as a diagnostic. Any other uncaught error ends the process as Node would end it
 * (the error on standard error, status 1). Returns a function that removes the guard.
 */
export function guardProjectCodeFaults({
  report = (diagnostic) => {
    console.error(diagnostic.message);
    for (const listener of faultListeners) listener(diagnostic);
  },
  target = process,
  toolkitRoot = TOOLKIT_ROOT,
  fatal = (error) => {
    console.error(error);
    process.exit(1);
  },
} = {}) {
  const handle = (kind) => (error) => {
    const origin = projectCodeOrigin(error, toolkitRoot);
    if (!origin) return fatal(error);
    try {
      report({
        code: 'PROJECT_CODE_UNCAUGHT',
        severity: 'error',
        file: origin.file,
        line: origin.line,
        message: `${kind} in project code at ${origin.file}:${origin.line}, outside any request: ${error.message}. It was thrown after the code that scheduled it had returned (a timer, an unawaited promise), so no request reports it; the runtime keeps serving.`,
      });
    } catch {
      /* A report that fails must not end the runtime it protects. */
    }
    return undefined;
  };
  const onException = handle('Uncaught error');
  const onRejection = handle('Unhandled promise rejection');
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.off('uncaughtException', onException);
    target.off('unhandledRejection', onRejection);
  };
}
