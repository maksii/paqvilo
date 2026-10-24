/** Local lifecycle traffic is recorded, but is not portal acceptance work. */
export function simulatorBackgroundRequest(value, origin) {
  try {
    const url = new URL(value, origin ?? 'http://localhost');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false;
    if (origin && url.origin !== new URL(origin).origin) return false;
    return (
      url.pathname === '/__sim/events' ||
      /^\/__sim\/frame-ready\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
