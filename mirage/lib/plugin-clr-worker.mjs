import { decodeClrMessage } from './plugin-clr-protocol.mjs';
import { SANDBOX_WORKER_CRASH } from './plugin-fault.mjs';
import { workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const { port, signal, executable, input, timeout, parentProcessId, parentStartTicks } = workerData,
  flags = new Int32Array(signal);
let complete = false;
const child = spawn(executable, ['--parent', String(parentProcessId), '--parent-start', String(parentStartTicks)], {
  shell: false,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
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
  port.close();
}
const timer = setTimeout(
  () => finish({ kind: 'failure', code: 'LocalPluginTimeout', message: 'CLR plugin exceeded the configured timeout.' }),
  timeout,
);
child.on('error', (cause) => finish({ kind: 'failure', code: 'LocalPluginHostUnavailable', message: cause.message }));
child.on('exit', (code) => {
  if (!complete)
    finish({
      kind: 'failure',
      code: 'LocalPluginHostExited',
      message: SANDBOX_WORKER_CRASH.message,
      hostExitCode: code,
    });
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
