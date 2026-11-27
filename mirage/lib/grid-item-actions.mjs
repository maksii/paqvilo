/**
 * A grid's record actions as the platform reads them from a list or subgrid's settings: ItemActions, then
 * ExtendedItemActions, ordered by ActionIndex. The ordering is stable, so an equal index keeps that order, and a missing
 * index sorts first (int? ordering in the legacy list source, Adxstudio ViewConfiguration.GetActions).
 */
export function gridItemActions(settings) {
  return [...actionList(settings?.ItemActions), ...actionList(settings?.ExtendedItemActions)].sort(byActionIndex);
}

const actionList = (value) => (Array.isArray(value) ? value : []);

const actionIndexKey = (action) => {
  const index = action?.ActionIndex == null || action.ActionIndex === '' ? Number.NaN : Number(action.ActionIndex);
  return Number.isFinite(index) ? index : Number.NEGATIVE_INFINITY;
};

/** Ascending ActionIndex, a missing index first; a comparator for a stable sort. */
export function byActionIndex(a, b) {
  const left = actionIndexKey(a),
    right = actionIndexKey(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
