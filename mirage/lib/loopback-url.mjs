// The loopback URL rule. A leaf module: settings contracts check a configured URL with it without loading the outbound
// HTTP runtime, which re-exports it (dataverse-webhooks.mjs).
const LOOPBACK = /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The one loopback guard: http or https to localhost, *.localhost, 127.0.0.0/8 or ::1. TriggerServiceEndpointCheck uses it too. */
export function isLoopbackUrl(text) {
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) && LOOPBACK.test(url.hostname);
  } catch {
    return false;
  }
}
