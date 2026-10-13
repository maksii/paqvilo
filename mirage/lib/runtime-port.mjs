/** Parse an explicit runtime port without treating empty values as an ephemeral port. */
export function runtimePort(value, fallback = 8787) {
  const input = value === undefined ? String(fallback) : String(value);
  if (!/^\d+$/.test(input) || !Number.isInteger(Number(input)) || Number(input) > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return Number(input);
}
