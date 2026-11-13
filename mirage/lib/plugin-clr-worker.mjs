import { decodeClrMessage, hostExitFailure } from './plugin-clr-protocol.mjs';
import { SANDBOX_WORKER_CRASH } from './plugin-fault.mjs';
import { workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const { port, signal, executable, input, timeout, parentProcessId } = workerData,
  flags = new Int32Array(signal);
let complete = false,
  child;
try {
  child = spawn(executable, ['--parent', String(parentProcessId)], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (error) {
  // A start the system refuses outright throws here: no process exists, and the main thread learns it at once.
  send({ kind: 'failure', code: 'LocalPluginHostUnavailable', message: error.message });
  reportHostProcessExit(null);
  throw error;
}
child.on('spawn', () => send({ kind: 'owned-child', pid: child.pid }));
function send(message) {
  port.postMessage(message);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
}
function finish(message) {
  if (complete) return;
  complete = true;
  clearTimeout(timer);
  child.kill();
  send(message);
}
// The child's own exit is the host's real exit: the port closes only after it is reported, and then the worker ends.
function reportHostProcessExit(code) {
  send({ kind: 'host-process-exited', hostExitCode: code });
  port.close();
}
const timer = setTimeout(
  () => finish({ kind: 'failure', code: 'LocalPluginTimeout', message: 'CLR plugin exceeded the configured timeout.' }),
  timeout,
);
child.on('error', (cause) => {
  finish({ kind: 'failure', code: 'LocalPluginHostUnavailable', message: cause.message });
  // A child that never started emits no exit event.
  if (child.pid === undefined) reportHostProcessExit(null);
});
child.on('exit', (code) => {
  if (!complete)
    finish(
      hostExitFailure(code, { kind: 'failure', code: 'LocalPluginHostExited', message: SANDBOX_WORKER_CRASH.message }),
    );
  reportHostProcessExit(code);
});
// The host discards plug-in console output; anything else on stderr is drained, never a failure.
child.stderr.resume();
child.stdin.on('error', () =>
  finish({ kind: 'failure', code: 'LocalPluginProtocol', message: 'CLR host input channel closed unexpectedly.' }),
);
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  if (complete) return;
  const { message, error } = decodeClrMessage(line);
  if (error) return finish(error);
  if (['result', 'failure'].includes(message.kind)) finish(message);
  else send(message);
});
port.on('message', (message) => {
  if (message.kind === 'rpc-answer' && !complete)
    child.stdin.write(
      JSON.stringify({ kind: 'rpc-answer', call: message.call, value: message.value, error: message.error }) + '\n',
    );
  else if (message.kind === 'cancel')
    finish({ kind: 'failure', code: 'LocalPluginCancelled', message: 'CLR execution was cancelled.' });
});
child.stdin.write(JSON.stringify(input) + '\n');
