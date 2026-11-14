import { mirageDebugOutput } from './mirage-debug-output.mjs';
import { guardShutdownSignals } from './signal-forwarding.mjs';

/** Keep each owned daemon's relay alive for exactly its foreground dev action. */
export async function withMirageDebugOutput(sessions, action, { relay = mirageDebugOutput } = {}) {
  const relays = [];
  try {
    for (const log of new Set(sessions.map((session) => session.log).filter(Boolean))) relays.push(relay(log));
    return await action();
  } finally {
    await guardShutdownSignals(() => Promise.all(relays.map((item) => item.close())));
  }
}
