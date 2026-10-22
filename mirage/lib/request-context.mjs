// One request context per inbound call (Web API, model-driven, portal, code app) and per asynchronous run it starts.
// It lives in the organization ALS (dataverse-transaction-context.mjs), so the record pipeline, committed events and the
// runners read it without new parameters. A context with inBatch true owns the host change slot, as the legacy `true` did.
import { organizationContext } from './dataverse-transaction-context.mjs';
import { clockFunction, systemClock, systemIds } from './runtime-clock.mjs';

// A client correlation id is echoed into events and diagnostics: keep it to a GUID-like token.
const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;
export const correlationOf = value => (typeof value === 'string' && CORRELATION.test(value) ? value : null);

/**
 * initiator: who asked ({ kind: 'contact'|'staff'|'app'|'anonymous'|'system', id }); principal: who executes (the organization
 * principal context or a service profile); portal / connection: surface facts. organization (an organization runtime or its
 * api) supplies organizationId, clock and ids; clock / ids may be given directly. mode: 'sync' | 'async' | 'job'.
 */
export function createRequestContext({ organization = null, initiator = null, principal = null, portal = null, connection = null,
  correlationId, requestId = null, parentId = null, depth = 0, signal = null, inBatch = false, mode = 'sync',
  clock = organization?.clock ?? systemClock, ids = organization?.ids ?? systemIds } = {}) {
  const fields = { organizationId: organization?.organizationId ?? null, initiator, principal, portal, connection,
    correlationId: correlationOf(correlationId) ?? ids.uuid(), requestId, parentId, depth, signal, inBatch, mode,
    clock: { now: clockFunction(clock) }, ids };
  const context = {
    ...fields,
    /** A nested run (an async job, a child flow): same correlation, the parent's correlation as parentId, one level deeper. */
    child: (over = {}) => createRequestContext({ organization, ...fields, clock, parentId: fields.correlationId, depth: depth + 1, ...over }),
    /** The same request with some facts replaced (the authenticated principal, the batch flag). */
    with: (over = {}) => createRequestContext({ organization, ...fields, clock, ...over }),
  };
  return Object.freeze(context);
}

/** The current request context, or null outside one (a legacy owned flag `true` is not a context). */
export const currentRequest = () => {
  const value = organizationContext.getStore();
  return value && typeof value === 'object' ? value : null;
};

export const runWithRequest = (context, fn) => organizationContext.run(context, fn);
