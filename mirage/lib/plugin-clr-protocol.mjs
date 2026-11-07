const failure = (code, message) => ({ kind: 'failure', code, message });
const protocolFailure = (message) => failure('LocalPluginProtocol', message);

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
  if (!['rpc', 'result', 'failure', 'trace', 'telemetry'].includes(message.kind))
    return { error: protocolFailure('Unknown CLR host message.') };
  return { message };
}
