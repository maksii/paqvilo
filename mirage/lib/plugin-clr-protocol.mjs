const failure = (code, message) => ({ kind: 'failure', code, message });
const protocolFailure = (message) => failure('LocalPluginProtocol', message);
/** A host that exits 74 could not bind the exact parent process incarnation that started it (plugin-clr-host.cs). */
export const hostExitFailure = (code, crash) =>
  code === 74
    ? failure('LocalPluginParentUnavailable', 'Owned CLR host cannot bind its parent process incarnation.')
    : { ...crash, hostExitCode: code };

/** Parse and validate a host line. Lines carry their invocation id; SDK callbacks from several plug-in threads queue. */
export function decodeClrMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return { error: protocolFailure('CLR host returned an invalid protocol message.') };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return { error: protocolFailure('CLR host returned an invalid protocol message.') };
  if (!['rpc', 'result', 'failure', 'trace', 'telemetry', 'debug-wait'].includes(message.kind))
    return { error: protocolFailure('Unknown CLR host message.') };
  return { message };
}
