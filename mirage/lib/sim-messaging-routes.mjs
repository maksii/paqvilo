// /_sim/api/messages and /_sim/api/outbox: read-only inspection of the message bus (message-bus.mjs) and the outbox
// (outbox.mjs), plus a CSRF-guarded purge of one bus entity. Credentials never leave: authvalue, connection strings, keys,
// passwords and secrets are redacted wherever they appear (message bodies carry RemoteExecutionContext entities, which may
// be a serviceendpoint row).
import { DEAD_LETTER_SUFFIX, QUEUE_MESSAGE_TABLE } from './message-bus.mjs';
import { messagingOf } from './dataverse-webhooks.mjs';

const PREFIX = /^\/(?:_sim|__sim)\/api\/(messages|outbox)(?:\/(.*))?$/;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/messages', '/outbox']);
// Credential names match by suffix after lower-casing and dropping separators, so client-secret and x-functions-key match
// too. The bare pair field `key` and `sharedaccesskeyname` never match.
const SECRET_NAME =
  /(?:authvalue|connectionstring|password|secret|clientsecret|clientpassword|saskey|sastoken|sharedaccesskey|sharedaccesssignature|accountkey|apikey|token|accesstoken|authorization|primarykey|secondarykey|functionkey|signature|cookie)$|functionskey/;
const isSecretName = (name) =>
  SECRET_NAME.test(
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''),
  );
const REDACTED = '[redacted]';

/** A deep copy with every credential-named value replaced, including DataContract `{ key, value }` pairs. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  const pair = typeof value.key === 'string' && 'value' in value && isSecretName(value.key);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (pair && key === 'value') || isSecretName(key) ? (item == null ? item : REDACTED) : redactSecrets(item),
    ]),
  );
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(status === 204 ? undefined : JSON.stringify(redactSecrets(body)));
  return true;
};
const fail = (res, status, code, message) => send(res, status, { error: { code, message } });
const decode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/**
 * Route handler the host mounts before its generic /_sim/api router: resolves true when it answered. `api.providers.messaging`
 * (see dataverse-webhooks.mjs messagingOf) and `api.providers.outbox` may be null; the GETs then answer `configured: false`.
 * `csrf()` returns the simulator token every mutation must echo in `x-sim-csrf`.
 */
export function createMessagingRoutes({ api, csrf }) {
  return async (req, res, url) => {
    const match = PREFIX.exec(url.pathname);
    if (!match) return false;
    const [, area, rest = ''] = match,
      method = req.method;
    try {
      if (area === 'outbox') {
        if (rest) return false;
        if (method !== 'GET') return fail(res, 405, 'MethodNotAllowed', 'The outbox is read-only.');
        const outbox = api.providers?.outbox ?? null;
        if (!outbox) return send(res, 200, { configured: false, entries: [] });
        const query = (name) => url.searchParams.get(name) ?? undefined;
        return send(res, 200, {
          configured: true,
          entries: outbox.list({
            correlationId: query('correlationId'),
            channel: query('channel'),
            since: query('since'),
          }),
        });
      }
      const messaging = messagingOf(api.providers?.messaging ?? null);
      if (method === 'GET' && !rest) {
        if (!messaging) return send(res, 200, { configured: false, entities: [], endpoints: {} });
        const entity = url.searchParams.get('entity');
        const { bus } = messaging; // ponytail: inspects the default bus only; list per provider when buses holds more than one.
        if (entity)
          return send(res, 200, {
            entity,
            messages: bus.peek(entity, { max: Math.min(Number(url.searchParams.get('max')) || 100, 1000) }),
          });
        const rows = api.store?.state?.tables?.[QUEUE_MESSAGE_TABLE] ?? [];
        const names = new Set(
          rows.map((row) =>
            row.entity.endsWith(DEAD_LETTER_SUFFIX) ? row.entity.slice(0, -DEAD_LETTER_SUFFIX.length) : row.entity,
          ),
        );
        for (const target of Object.values(messaging.endpoints ?? {}))
          names.add(String(target).slice(String(target).indexOf('/') + 1));
        const entities = [...names]
          .sort()
          .map((name) => ({ entity: name, stats: typeof bus.stats === 'function' ? bus.stats(name) : null }));
        return send(res, 200, { configured: true, entities, endpoints: messaging.endpoints ?? {} });
      }
      if (method === 'DELETE' && rest) {
        const token = csrf();
        if (!token || req.headers['x-sim-csrf'] !== token)
          return fail(res, 403, 'Forbidden', 'Missing simulator CSRF token.');
        if (!messaging) return fail(res, 404, 'NotFound', 'No messaging provider is configured.');
        const segments = rest.split('/').map(decode);
        if (segments.some((segment) => segment == null || !segment))
          return fail(res, 400, 'InvalidEntity', 'The entity path is not valid.');
        const entity = segments.join('/');
        let purged = 0;
        // ponytail: purge edits the local bus table directly; a pack bus without rows in this store needs its own purge operation.
        await api.store.transact(
          () => {
            const rows = api.store.state.tables?.[QUEUE_MESSAGE_TABLE] ?? [];
            for (let index = rows.length - 1; index >= 0; index -= 1)
              if (rows[index].entity === entity) {
                api.store.removeRow(QUEUE_MESSAGE_TABLE, rows, index);
                purged += 1;
              }
          },
          { incremental: true },
        );
        return send(res, 200, { entity, purged });
      }
      return fail(
        res,
        405,
        'MethodNotAllowed',
        'Use GET /_sim/api/messages[?entity=] or DELETE /_sim/api/messages/<entity>.',
      );
    } catch (error) {
      return fail(
        res,
        Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500,
        error.code ?? 'Error',
        error.message,
      );
    }
  };
}
