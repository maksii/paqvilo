import net from 'node:net';
import { isAlive, recordedIdentityNow } from './process-identity.mjs';

/** How long a runtime that still runs but refuses a connection (it is closing its listener) is left before the next look. */
const RECHECK_MS = 1_000;

/**
 * Observes a runtime this process did not start, so it has no child handle to wait on: resolves `gone` once the
 * recorded process no longer runs. It holds one idle connection to the runtime's listener, which the operating system
 * closes when that process ends, however it ends. A connection that closes while the recorded process still runs (the
 * server dropped an idle connection, or its listener is closing) is opened again. Nothing here keeps the process
 * running, and `stop` ends the observation.
 * @param {{ pid: number, url: string, processIdentity?: string|null }} runtime
 */
export function watchRuntimeGone(
  runtime,
  { connect = net.connect, alive = isAlive, identityNow = recordedIdentityNow, clock = globalThis } = {},
) {
  const { port, hostname } = new URL(runtime.url);
  const host = hostname.replace(/^\[|\]$/g, '');
  let stopped = false;
  let socket = null;
  let timer = null;
  const { promise: gone, resolve } = Promise.withResolvers();
  const stop = () => {
    stopped = true;
    clock.clearTimeout(timer);
    socket?.destroy();
  };
  /** Whether the recorded process still runs; an identity that cannot be read is not evidence that it ended. */
  const running = async () => {
    if (!alive(runtime.pid)) return false;
    if (!runtime.processIdentity) return true;
    const identity = await identityNow(runtime.pid, runtime.processIdentity).catch(() => null);
    return identity === null ? alive(runtime.pid) : identity === runtime.processIdentity;
  };
  const closed = async (connected) => {
    if (stopped) return;
    if (!(await running())) {
      stop();
      resolve();
      return;
    }
    if (stopped) return;
    if (connected) open();
    else {
      timer = clock.setTimeout(open, RECHECK_MS);
      timer.unref?.();
    }
  };
  function open() {
    if (stopped) return;
    let connected = false;
    socket = connect({ port: Number(port), host });
    socket.unref?.();
    socket.on('connect', () => {
      connected = true;
    });
    socket.on('error', () => {});
    socket.on('close', () => void closed(connected));
  }
  open();
  return { gone, stop };
}
