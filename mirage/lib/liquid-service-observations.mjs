import { LiquidError } from './liquid-engine.mjs';
import { portalField } from './importer.mjs';
import { portalLanguage } from './portal-languages.mjs';

/** Host service behavior is evidence-backed per site; the pinned reference stays the default. */
function observedLiquidServiceTags(options = {}) {
  return (options.observed ?? options.config?.observed ?? options.portal?.observed)?.liquidServiceTags === 'observed';
}

export function missingLiquidComponent(kind, options) {
  if (!observedLiquidServiceTags(options)) return false;
  if (kind === 'webform' || kind === 'entitylist') throw new LiquidError('Sequence contains no matching element');
  return kind === 'entityview';
}

export function serverLogicFallback(portal, name, observed) {
  const present = (portal.serverLogics ?? []).some(
    (record) => String(record.name ?? '').toLowerCase() === String(name).toLowerCase(),
  );
  const absentObserved = observedLiquidServiceTags({ observed }) && !present;
  return {
    status: absentObserved ? 404 : 501,
    diagnosticCode: absentObserved ? 'SERVER_LOGIC_NOT_FOUND' : 'SERVER_LOGIC_UNSUPPORTED',
  };
}

const attr = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );

/** Chart placeholder markup is not chart execution or a successful service response. */
export function observedChartMarkup(args, context, options) {
  if (!observedLiquidServiceTags(options) || args?.id == null || args?.viewid == null) return null;
  const portal = options.portal;
  const websiteId = String(portal.website?.id ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  const language =
    context.website?.selected_language?.code ??
    context.__language?.code ??
    portal.language?.code ??
    portalLanguage({ lcid: portalField(portal.website ?? {}, 'website_language') })?.code ??
    'en-US';
  options.diagnostic?.({
    code: 'LIQUID_CHART_MARKUP_ONLY',
    severity: 'warning',
    component: 'chart',
    message:
      'The observed chart tag emits its source-derived placeholder; chart data execution is unavailable locally.',
  });
  return `<div class="crm-chart" data-chartid="${attr(args.id)}" data-lang="${attr(language)}" data-serviceurl="${attr('/_services/visualizations/get-chart-builder?__portalScopeId__=' + websiteId)}" data-viewid="${attr(args.viewid)}"></div>`;
}

export function observedSearchUnavailable(options) {
  if (observedLiquidServiceTags(options))
    throw new LiquidError('There were no exact matches. Make sure search is enabled for this environment.');
}
