import { DataError } from './data-error.mjs';
import { platformValues } from './platform-settings.mjs';

/** Optional request parameter shared by Web API, SOAP and original SDK calls. */
export function bypassStepIds(store, value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string')
    throw new DataError(
      'BypassBusinessLogicExecutionStepIds requires a comma-separated string of GUID values.',
      400,
      'InvalidRequest',
      { innerCode: '0x80040203' },
    );
  const ids = value.split(',').map((part) => part.trim().toLowerCase());
  const limit = platformValues(store.state).BypassBusinessLogicExecutionStepIdsLimit;
  if (ids.length > limit)
    throw new DataError(
      `The number of step ids: ${ids.length} in the BypassBusinessLogicExecutionStepIds parameter exceeds the orgdb settings limit: ${limit}`,
      400,
      'InvalidRequest',
      { innerCode: '0x80097628' },
    );
  return [...new Set(ids.filter((id) => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id)))];
}

export function pluginBypassOwnership(item) {
  const ownership = item.bypassOwnership;
  if (
    ['microsoft', 'custom', 'system'].includes(ownership?.kind) &&
    typeof ownership.evidence === 'string' &&
    ownership.evidence.trim()
  )
    return { ...ownership, qualification: 'evidenced-classification' };
  return {
    kind: 'unknown',
    qualification: 'unqualified-local-custom-adapter',
    customizationLevel: item.customizationLevel ?? item.customizationlevel ?? null,
    reason: 'Source metadata does not establish system/Microsoft solution ownership for bypass behavior.',
  };
}

/** Per-extension decision: system/Microsoft logic is outside custom bypass. */
export function pluginStepBypassed(
  item,
  { bypassCustomPlugins = false, bypassStepIds = [] } = {},
  diagnostic = () => {},
) {
  const stepId = item.id ?? item.sdkmessageprocessingstepid;
  const selected =
    stepId != null &&
    bypassStepIds.some((id) => String(id).toLowerCase() === String(stepId).replace(/[{}]/g, '').toLowerCase());
  if (!bypassCustomPlugins && !selected) return false;
  const ownership = pluginBypassOwnership(item);
  if (['system', 'microsoft'].includes(ownership.kind)) return false;
  if (ownership.kind === 'unknown')
    diagnostic?.({
      code: 'PLUGIN_BYPASS_OWNERSHIP_UNKNOWN',
      severity: 'warning',
      stepId: stepId ?? item.workflowid ?? item.fxexpressionid ?? null,
      message:
        'Source ownership does not establish whether native custom-logic bypass applies. The explicit local custom adapter is bypassed; Microsoft/system ownership remains unqualified.',
    });
  return true;
}
