import { mirageDebugOutput } from './mirage-debug-output.mjs';

/** Keep each owned daemon's relay alive for exactly its foreground dev action. */
export async function withMirageDebugOutput(sessions, action) {
  const relays = [];
  try {
    for (const log of new Set(sessions.map((session) => session.log).filter(Boolean)))
      relays.push(mirageDebugOutput(log));
    return await action();
  } finally {
    await Promise.all(relays.map((relay) => relay.close()));
  }
}
