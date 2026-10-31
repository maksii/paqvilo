import { decodeClrMessage } from './plugin-clr-protocol.mjs';
import { SANDBOX_WORKER_CRASH } from './plugin-fault.mjs';
// The long-lived host of one prepared runtime. Several invocations may be in flight (a nested Execute enters while its
// caller waits in an SDK call); every line carries its invocation id. A failing host fails every in-flight invocation.
import { workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const { port, signal, executable, parentProcessId, parentStartTicks } = workerData,
  flags = new Int32Array(signal);
const active = new Map();
let closed = false;
const child = spawn(
  executable,
  ['--persistent', '--parent', String(parentProcessId), '--parent-start', String(parentStartTicks)],
  { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
);
function send(message) {
  port.postMessage(message);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
}
const crash = {
  kind: 'failure',
  code: 'LocalPluginHostExited',
  message: SANDBOX_WORKER_CRASH.message,
};
// `owner` alone gets `message` (its own timeout); the host it ran in is gone for the others too.
function stop(message, owner = null) {
  if (closed) return;
  closed = true;
  for (const timer of active.values()) clearTimeout(timer);
  child.kill();
  if (message) for (const id of active.keys()) send({ ...(owner && id !== owner ? crash : message), invocationId: id });
  port.close();
}
child.on('spawn', () => send({ kind: 'owned-child', pid: child.pid }));
child.on('error', () =>
  stop({ kind: 'failure', code: 'LocalPluginHostUnavailable', message: 'Owned pooled CLR host could not start.' }),
);
child.on('exit', (code) => stop({ ...crash, hostExitCode: code }));
// The host discards plug-in console output; anything else on stderr is drained, never a failure.
child.stderr.resume();
child.stdin.on('error', () =>
  stop({ kind: 'failure', code: 'LocalPluginProtocol', message: 'CLR host input channel closed unexpectedly.' }),
);
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  if (closed) return;
  const { message: decoded, error } = decodeClrMessage(line);
  if (error) return stop(error);
  // An untagged line belongs to the only invocation in flight.
  const message = {
    ...decoded,
    invocationId: decoded.invocationId ?? (active.size === 1 ? [...active.keys()][0] : null),
  };
  // A late line of a completed invocation (a thread it left running) has no receiver.
  if (!active.has(message.invocationId)) return;
  if (['result', 'failure'].includes(message.kind)) {
    clearTimeout(active.get(message.invocationId));
    active.delete(message.invocationId);
  }
  send(message);
});
port.on('message', (message) => {
  if (closed) return;
  if (message.kind === 'cancel') return stop();
  if (message.kind === 'invoke') {
    const id = message.invocationId;
    if (
      typeof id !== 'string' ||
      !id ||
      active.has(id) ||
      !Number.isInteger(message.timeout) ||
      message.timeout < 100 ||
      message.timeout > 120_000
    ) {
      if (typeof id === 'string' && id) active.set(id, active.get(id) ?? null);
      return stop({ kind: 'failure', code: 'LocalPluginProtocol', message: 'Invalid pooled CLR invocation.' });
    }
    active.set(
      id,
      setTimeout(
        () =>
          stop(
            { kind: 'failure', code: 'LocalPluginTimeout', message: 'CLR plugin exceeded the configured timeout.' },
            id,
          ),
        message.timeout,
      ),
    );
    child.stdin.write(JSON.stringify({ ...message.input, invocationId: id }) + '\n');
  } else if (message.kind === 'rpc-answer') {
    if (active.has(message.invocationId))
      child.stdin.write(
        JSON.stringify({ kind: 'rpc-answer', call: message.call, value: message.value, error: message.error }) + '\n',
      );
  } else stop({ kind: 'failure', code: 'LocalPluginProtocol', message: 'Invalid pooled CLR callback.' });
});
