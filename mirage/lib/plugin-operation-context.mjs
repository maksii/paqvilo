import { cloneStateData } from './state-clone.mjs';
import { systemClock, systemIds } from './runtime-clock.mjs';

// These qualified Unspecified stamps contain UTC clock values. Keep the wire
// representation separate from the internal stamp parsed in any local timezone.
const utcClockStamp = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? value + 'Z' : value;

/** A nested SDK operation joins its caller's pipeline identity. Authored
 * OrganizationRequest.RequestId stays separate transport metadata. */
export function initializePluginOperation(frame, store, parent, { createdOn, requestId } = {}) {
  const values = parent?.values;
  frame.requestId ??= values?.RequestId?.value ?? requestId ?? (store?.ids ?? systemIds).uuid();
  frame.operationId ??= values?.OperationId?.value ?? frame.requestId;
  frame.correlationId ??= values?.CorrelationId?.value ?? (store?.ids ?? systemIds).uuid();
  // Native OperationCreatedOn is whole seconds in every context (corpus: all 1736 occurrences).
  frame.createdOn ??=
    values?.OperationCreatedOn?.value ??
    createdOn ??
    new Date(Math.floor((store?.clock ?? systemClock).now() / 1000) * 1000).toISOString();
  frame.createdOn = utcClockStamp(frame.createdOn);
  frame.createdOnWire ??=
    values?.OperationCreatedOn?.$type === 'DateTime'
      ? cloneStateData(values.OperationCreatedOn)
      : {
          $type: 'DateTime',
          value: frame.asyncOperation ? frame.createdOn : String(frame.createdOn).replace(/Z$/, ''),
        };
}
