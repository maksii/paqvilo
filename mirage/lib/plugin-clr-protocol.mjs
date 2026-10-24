const failure = (code, message) => ({ kind: 'failure', code, message });
const protocolFailure = (message) => failure('LocalPluginProtocol', message);

/** Output bounds are cumulative per invocation; workers own their counters and lifetime. */
export function clrOutputFailure(channel, bytes) {
  if (channel === 'stderr' && bytes > 65536)
    return failure('LocalPluginOutputLimit', 'CLR host stderr exceeded 64 KiB.');
  if (channel === 'stdout' && bytes > 8 * 1024 * 1024)
    return failure('LocalPluginOutputLimit', 'CLR host output exceeded 8 MiB.');
  return null;
}

/** Parse and validate a line; pooled admission and pending-callback policy stay explicit. */
export function decodeClrMessage(line, { pending = false, pooled = false, active = true } = {}) {
  if (pooled && (!active || Buffer.byteLength(line) > 4 * 1024 * 1024))
    return { error: protocolFailure('Unexpected or excessive pooled CLR output.') };
  if (Buffer.byteLength(line) > 4 * 1024 * 1024)
    return { error: failure('LocalPluginOutputLimit', 'CLR protocol message exceeded 4 MiB.') };
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return { error: protocolFailure('CLR host returned an invalid protocol message.') };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return { error: protocolFailure('CLR host returned an invalid protocol message.') };
  if (message.kind === 'rpc') {
    if (pending) return { error: protocolFailure('Concurrent CLR SDK calls are unsupported.') };
  } else if (['result', 'failure'].includes(message.kind)) {
    if (pending) return { error: protocolFailure('CLR completed with a pending SDK callback.') };
  } else if (message.kind !== 'trace') return { error: protocolFailure('Unknown CLR host message.') };
  return { message };
}
