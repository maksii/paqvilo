import { normalizeInspectionScope } from './inspection-evidence.mjs';

/** A selected-source action cannot survive navigation or a replacement selection. */
export async function selectionEvidenceCurrent(page, expected, { timeout = 2500 } = {}) {
  if (!expected?.scope) return true; // Explicit generic definition browsing has no selected-node assertion.
  const scope = normalizeInspectionScope(expected.scope);
  if (!scope || !page || page.isClosed?.()) return false;
  if (!Number.isSafeInteger(expected.anchorGeneration) || expected.anchorGeneration < 0) return false;
  let timer;
  try {
    return await Promise.race([
      page
        .evaluate(
          ({ scope, anchorGeneration, sourceKey, sourceRevision, contentRevision, region }) => {
            const tools = document.getElementById('paqvilo-xray')?.__px;
            const current = tools?.selectionState?.();
            const node = tools?.selectedNode?.();
            if (typeof tools?.selectedNode === 'function' && !node) return false;
            const actualScope = node && tools?.getSelectionScope?.(node);
            const observed = node && typeof tools?.identify === 'function' ? tools.identify(node, actualScope) : null;
            const identity = observed?.evidence ? { evidence: observed.evidence } : current?.identity;
            if (sourceKey !== undefined) {
              const source = identity?.evidence?.source;
              if (
                !['exact', 'candidate'].includes(source?.status) ||
                !source.refs?.some(
                  (ref) =>
                    [ref.sourceKey, ref.key, ref.id].includes(sourceKey) &&
                    ref.sourceRevision === sourceRevision &&
                    ref.contentRevision === contentRevision &&
                    ['exact', 'candidate'].includes(ref.status ?? source.status) &&
                    (region === undefined || (ref.region?.start === region.start && ref.region?.end === region.end)),
                )
              )
                return false;
            }
            return Boolean(
              identity &&
              current.scope &&
              ['documentId', 'frameId', 'uiEpoch', 'sourceRevision'].every(
                (key) => current.scope[key] === scope[key] && (!actualScope || actualScope[key] === scope[key]),
              ) &&
              (anchorGeneration === undefined || current.anchorGeneration === anchorGeneration),
            );
          },
          {
            scope,
            anchorGeneration: expected.anchorGeneration,
            sourceKey: expected.sourceKey,
            sourceRevision: expected.sourceRevision,
            contentRevision: expected.contentRevision,
            region: expected.region,
          },
        )
        .catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeout, false);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
