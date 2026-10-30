import { clrOutputFailure, decodeClrMessage } from './plugin-clr-protocol.mjs';
// Explicit opt-in host reuse. One invocation and one synchronous SDK callback
// may be outstanding; unsolicited or stale protocol output closes the host.
import { workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const { port, signal, executable, parentProcessId, parentStartTicks } = workerData,
  flags = new Int32Array(signal);
let active = null,
  pending = false,
  closed = false,
  bytes = 0,
  stderr = 0,
  timer;
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
function stop(message, invocationId = active) {
  if (closed) return;
  closed = true;
  clearTimeout(timer);
  child.kill();
  if (message) send({ ...message, invocationId });
  port.close();
}
child.on('spawn', () => send({ kind: 'owned-child', pid: child.pid }));
child.on('error', () =>
  stop({ kind: 'failure', code: 'LocalPluginHostUnavailable', message: 'Owned pooled CLR host could not start.' }),
);
child.on('exit', (code) =>
  stop({ kind: 'failure', code: 'LocalPluginHostExited', message: 'Owned pooled CLR host exited (' + code + ').' }),
);
child.stderr.on('data', (chunk) => {
  stderr += chunk.length;
  const error = clrOutputFailure('stderr', stderr);
  if (error) stop(error);
});
child.stdout.on('data', (chunk) => {
  bytes += chunk.length;
  const error = clrOutputFailure('stdout', bytes);
  if (error) stop(error);
});
child.stdin.on('error', () =>
  stop({ kind: 'failure', code: 'LocalPluginProtocol', message: 'CLR host input channel closed unexpectedly.' }),
);
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  if (closed) return;
  const { message, error } = decodeClrMessage(line, { pending, pooled: true, active: Boolean(active) });
  if (error) return stop(error);
  if (message.kind === 'rpc') {
    pending = true;
    send({ ...message, invocationId: active });
  } else if (message.kind === 'trace') send({ ...message, invocationId: active });
  else if (['result', 'failure'].includes(message.kind)) {
    clearTimeout(timer);
    send({ ...message, invocationId: active });
    active = null;
  }
});
port.on('message', (message) => {
  if (closed) return;
  if (message.kind === 'cancel') {
    stop();
    return;
  }
  if (message.kind === 'invoke') {
    const invocationId = typeof message.invocationId === 'string' && message.invocationId ? message.invocationId : null;
    if (
      active ||
      typeof message.invocationId !== 'string' ||
      !message.invocationId ||
      !Number.isInteger(message.timeout) ||
      message.timeout < 100 ||
      message.timeout > 120_000
    )
      return stop(
        { kind: 'failure', code: 'LocalPluginProtocol', message: 'Invalid pooled CLR invocation.' },
        active ?? invocationId,
      );
    const input = JSON.stringify(message.input);
    if (Buffer.byteLength(input) > 4 * 1024 * 1024)
      return stop(
        { kind: 'failure', code: 'LocalPluginInputLimit', message: 'CLR context exceeds 4 MiB.' },
        invocationId,
      );
    active = message.invocationId;
    pending = false;
    bytes = 0;
    stderr = 0;
    timer = setTimeout(
      () =>
        stop({ kind: 'failure', code: 'LocalPluginTimeout', message: 'CLR plugin exceeded the configured timeout.' }),
      message.timeout,
    );
    child.stdin.write(input + '\n');
  } else if (message.kind === 'rpc-answer' && active === message.invocationId && pending) {
    pending = false;
    child.stdin.write(JSON.stringify({ kind: 'rpc-answer', value: message.value, error: message.error }) + '\n');
  } else stop({ kind: 'failure', code: 'LocalPluginProtocol', message: 'Stale or invalid pooled CLR callback.' });
});
