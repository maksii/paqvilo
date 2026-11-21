// The `providers.messaging` settings contract: validation only, no bus. message-bus.mjs re-exports messagingSettings;
// settings-contracts.mjs registers it on the config-load path.

/** A queue, topic or subscription path a bus accepts. */
export const MESSAGING_ENTITY = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,259}(?:\/[A-Za-z0-9._~-]{1,260}){0,2}$/;
/** The retry policy of a provider that declares none. */
export const DEFAULT_RETRY = Object.freeze({ maxAttempts: 1, backoffMs: Object.freeze([]), deadLetter: true });

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const KINDS = new Set(['local-queue', 'servicebus-emulator']);
const PACK_KIND = /^pack:[A-Za-z0-9@._-]+\/[A-Za-z0-9._-]+$/;
const ENV_REFERENCE = /^env:[A-Za-z_]\w{0,127}$/;
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function retrySettings(value, label) {
  if (value === undefined) return { ...DEFAULT_RETRY, backoffMs: [] };
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['maxAttempts', 'backoffMs', 'deadLetter'].includes(key)) throw new Error(`Unknown ${label} key '${key}'`);
  const maxAttempts = value.maxAttempts ?? 1,
    backoffMs = value.backoffMs ?? [],
    deadLetter = value.deadLetter ?? true;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    throw new Error(`${label}.maxAttempts must be an integer from 1 through 100`);
  if (
    !Array.isArray(backoffMs) ||
    backoffMs.length > 32 ||
    backoffMs.some((ms) => !Number.isInteger(ms) || ms < 0 || ms > 86_400_000)
  )
    throw new Error(`${label}.backoffMs must be at most 32 integer delays from 0 through 86400000`);
  if (typeof deadLetter !== 'boolean') throw new Error(`${label}.deadLetter must be a boolean`);
  return { maxAttempts, backoffMs: [...backoffMs], deadLetter };
}

/** Validate and normalise `providers.messaging`. Throws Error naming the label; never echoes a credential value. */
export function messagingSettings(value, label = 'providers.messaging') {
  if (value === undefined) value = {};
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const result = {};
  for (const [providerId, provider] of Object.entries(value)) {
    if (providerId === 'endpoints') continue;
    result[providerId] = normalizeMessagingProvider(providerId, provider, label);
  }
  result.local ??= { kind: 'local-queue', retry: retrySettings(undefined) };
  const endpoints = value.endpoints ?? {};
  if (!plainObject(endpoints))
    throw new Error(`${label}.endpoints must map service endpoint ids or names to <provider>/<entity>`);
  result.endpoints = {};
  for (const [key, target] of Object.entries(endpoints)) validateMessagingEndpoint(result, key, target, label);
  return result;
}

function normalizeMessagingProvider(providerId, provider, label) {
  const at = `${label}.${providerId}`;
  if (!PROVIDER_ID.test(providerId))
    throw new Error(`${label} provider ids must be lower-case names (got '${providerId.slice(0, 64)}')`);
  if (!plainObject(provider)) throw new Error(`${at} must be an object`);
  const { kind } = provider;
  if (typeof kind !== 'string' || !(KINDS.has(kind) || PACK_KIND.test(kind)))
    throw new Error(`${at}.kind must be local-queue, servicebus-emulator or pack:<packId>/<name>`);
  const allowed = allowedMessagingKeys(kind);
  for (const key of Object.keys(provider))
    if (!allowed.includes(key)) throw new Error(`Unknown ${at} key '${key}' for kind ${kind}`);
  const normalized = {
    kind,
    ...(allowed.includes('retry') ? { retry: retrySettings(provider.retry, `${at}.retry`) } : {}),
  };
  applyMessagingProviderOptions(provider, normalized, at, kind);
  return normalized;
}

function allowedMessagingKeys(kind) {
  if (kind === 'local-queue') return ['kind', 'retry', 'lockDurationMs'];
  if (kind === 'servicebus-emulator') return ['kind', 'connectionString', 'amqpPort'];
  return ['kind', 'retry', 'connectionString'];
}

function applyMessagingProviderOptions(provider, normalized, at, kind) {
  if (provider.amqpPort !== undefined) {
    if (!Number.isInteger(provider.amqpPort) || provider.amqpPort < 1 || provider.amqpPort > 65535)
      throw new Error(`${at}.amqpPort must be an integer from 1 through 65535`);
    normalized.amqpPort = provider.amqpPort;
  }
  if (provider.lockDurationMs !== undefined) {
    if (
      !Number.isInteger(provider.lockDurationMs) ||
      provider.lockDurationMs < 1000 ||
      provider.lockDurationMs > 300_000
    )
      throw new Error(`${at}.lockDurationMs must be an integer from 1000 through 300000`);
    normalized.lockDurationMs = provider.lockDurationMs;
  }
  if (provider.connectionString !== undefined) {
    if (typeof provider.connectionString !== 'string' || !ENV_REFERENCE.test(provider.connectionString))
      throw new Error(
        `${at}.connectionString must be an env:NAME reference; literal connection strings are not accepted in config`,
      );
    normalized.connectionString = provider.connectionString;
  } else if (kind === 'servicebus-emulator') throw new Error(`${at}.connectionString is required (env:NAME)`);
}

function validateMessagingEndpoint(result, key, target, label) {
  if (!key.trim() || key.length > 200)
    throw new Error(`${label}.endpoints keys must be service endpoint ids or names of at most 200 characters`);
  const slash = typeof target === 'string' ? target.indexOf('/') : -1;
  const providerId = slash > 0 ? target.slice(0, slash) : '',
    entity = slash > 0 ? target.slice(slash + 1) : '';
  if (!Object.hasOwn(result, providerId) || providerId === 'endpoints' || !MESSAGING_ENTITY.test(entity))
    throw new Error(
      `${label}.endpoints.${key.slice(0, 64)} must be <provider>/<entity> naming a declared messaging provider`,
    );
  result.endpoints[key] = target;
}
