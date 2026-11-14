// /_sim/api/messages and /_sim/api/outbox: read-only inspection of the message bus (message-bus.mjs) and the outbox
// (outbox.mjs), plus a CSRF-guarded purge of one bus entity. Credentials never leave: authvalue, connection strings, keys,
// passwords and secrets are redacted wherever they appear (message bodies carry RemoteExecutionContext entities, which may
// be a serviceendpoint row).
import { DEAD_LETTER_SUFFIX, QUEUE_MESSAGE_TABLE } from './message-bus.mjs';
import { messagingOf } from './dataverse-webhooks.mjs';
import { auditText } from './audit-log.mjs';

const PREFIX = /^\/(?:_sim|__sim)\/api\/(messages|outbox)(?:\/(.*))?$/;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/messages', '/outbox']);
// Credential names match by suffix after lower-casing and dropping separators, so client-secret and x-functions-key match
// too. The bare pair field `key` and `sharedaccesskeyname` never match.
const SECRET_NAME =
  /(?:authvalue|connectionstring|password|secret|client(?:secret|password)|(?:sas|sharedaccess|account|primary|secondary|function|subscription)key|(?:access|sas)?token|sharedaccesssignature|apikey|authorization|signature|cookie|pwd)$|functionskey/; // NOSONAR: regex kept: a rewrite would change matches or captures
const isSecretName = (name) =>
  SECRET_NAME.test(
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''),
  );
const REDACTED = '[redacted]';
// Free-text fields (message bodies, outbox bodies and subjects, error messages, wait comments and run reasons) may embed a
// connection string or a credential header, so their strings also pass through auditText. Names match in any letter case.
// Other strings are returned as they are: a URL or token the API hands to its caller (a callback URL's sig, for example)
// is not free text.
const FREE_TEXT_NAMES = new Set([
  'body',
  'subject',
  'message',
  'text',
  'payload',
  'description',
  'detail',
  'details',
  'errormessage',
  'comments',
  'reason',
]);

/**
 * A deep copy with every credential-named value replaced, including DataContract `{ key, value }` pairs. Free-text
 * fields are also masked by auditText. No text is cut, because a redacted text can be longer than the original.
 */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  const pair = typeof value.key === 'string' && 'value' in value && isSecretName(value.key);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      let redacted;
      if ((pair && key === 'value') || isSecretName(key)) {
        if (item == null) redacted = item;
        else redacted = REDACTED;
      } else if (typeof item === 'string' && FREE_TEXT_NAMES.has(key.toLowerCase()))
        redacted = auditText(item, Number.POSITIVE_INFINITY);
      else redacted = redactSecrets(item);
      return [key, redacted];
    }),
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
      if (area === 'outbox') return handleOutboxRequest(api, res, url, rest, method);
      const messaging = messagingOf(api.providers?.messaging ?? null);
      if (method === 'GET' && !rest) return handleMessagesGet(api, res, url, messaging);
      if (method === 'DELETE' && rest) {
        const deletion = prepareMessageDeletion(req, res, rest, messaging, csrf);
        if (deletion.response) return deletion.response;
        let purged = 0;
        // ponytail: purge edits the local bus table directly; a pack bus without rows in this store needs its own purge operation.
        await api.store.transact(
          () => {
            purged = removeMessageRows(api, deletion.entity);
          },
          { incremental: true },
        );
        return send(res, 200, { entity: deletion.entity, purged });
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

function handleOutboxRequest(api, res, url, rest, method) {
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

function handleMessagesGet(api, res, url, messaging) {
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
    .sort(/* NOSONAR: preserve default string coercion */)
    .map((name) => ({ entity: name, stats: typeof bus.stats === 'function' ? bus.stats(name) : null }));
  return send(res, 200, { configured: true, entities, endpoints: messaging.endpoints ?? {} });
}

function prepareMessageDeletion(req, res, rest, messaging, csrf) {
  const token = csrf();
  if (!token || req.headers['x-sim-csrf'] !== token)
    return { response: fail(res, 403, 'Forbidden', 'Missing simulator CSRF token.') };
  if (!messaging) return { response: fail(res, 404, 'NotFound', 'No messaging provider is configured.') };
  const segments = rest.split('/').map(decode);
  if (segments.some((segment) => segment == null || !segment))
    return { response: fail(res, 400, 'InvalidEntity', 'The entity path is not valid.') };
  return { entity: segments.join('/') };
}

function removeMessageRows(api, entity) {
  let purged = 0;
  const rows = api.store.state.tables?.[QUEUE_MESSAGE_TABLE] ?? [];
  for (let index = rows.length - 1; index >= 0; index -= 1)
    if (rows[index].entity === entity) {
      api.store.removeRow(QUEUE_MESSAGE_TABLE, rows, index);
      purged += 1;
    }
  return purged;
}
