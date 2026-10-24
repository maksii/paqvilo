import { canonicalRows, stable } from './core.mjs';
import { compareNativeSnapshots } from './native-capture.mjs';
/** Assemble physical page captures only under identical frozen native state.
 * Additional pages after the observed terminator stay evidence but are excluded
 * from logical results. No failed/absent response is synthesized as an empty page. */
export function qualifyNativePaging({ captures, plan }) {
  const errors = [],
    lanes = {};
  if (!captures.length) return { qualified: false, errors: ['missing-captures'], lanes };
  const reference = captures[0].before;
  for (const capture of captures) {
    if (
      !compareNativeSnapshots(capture.before, capture.after).stable ||
      !compareNativeSnapshots(reference, capture.before).stable
    )
      errors.push('native-state-not-identical');
  }
  for (const lane of ['liquid', 'webapi']) {
    const pages = [];
    for (const { capture } of captures)
      for (const request of capture.requests.filter((request) => request.caseId === plan.id && request.lane === lane)) {
        if (lane === 'liquid') {
          const result = capture.liquidPages.find((page) => page.operationId === request.operationId);
          pages.push({
            page: request.page ?? 1,
            operationId: request.operationId,
            success: result?.outcome === 'success',
            rows: result?.rows,
            more: result?.more,
          });
        } else {
          const response = capture.results.find(
            (result) => result.operationId === request.operationId && result.lane === 'webapi',
          );
          let body;
          try {
            body = JSON.parse(response.body);
          } catch {
            /* Optional payload or browser capability is unavailable. */
          }
          pages.push({
            page: request.page ?? 1,
            operationId: request.operationId,
            success: response?.status === 200 && Array.isArray(body?.value),
            rows: body?.value,
            more: body ? !!body['@odata.nextLink'] || body.value?.length === plan.pageSize : undefined,
          });
        }
      }
    pages.sort((a, b) => a.page - b.page);
    const seen = new Set(),
      selected = [];
    let terminal = false;
    for (const page of pages) {
      if (terminal) continue;
      if (seen.has(page.page)) {
        errors.push(lane + ':duplicate-page');
        break;
      }
      seen.add(page.page);
      if (
        page.page !== selected.length + 1 ||
        !page.success ||
        !Array.isArray(page.rows) ||
        typeof page.more !== 'boolean'
      ) {
        errors.push(lane + ':missing-or-failed-page');
        break;
      }
      selected.push(page);
      if (!page.more) terminal = true;
    }
    if (!terminal) errors.push(lane + ':unterminated-paging');
    const rows = selected.flatMap((page) => canonicalRows(page.rows, plan)),
      ids = rows.map((row) => row[plan.primaryId]).filter(Boolean);
    if (new Set(ids).size !== ids.length) errors.push(lane + ':duplicate-record-across-pages');
    lanes[lane] = {
      complete: terminal,
      count: rows.length,
      rows,
      pages: selected.map(({ page, operationId, rows }) => ({ page, operationId, count: rows.length })),
      extraPages: pages.length - selected.length,
    };
  }
  const equal = errors.length === 0 && stable(lanes.liquid.rows) === stable(lanes.webapi.rows);
  return { qualified: errors.length === 0, equal, errors, lanes };
}
