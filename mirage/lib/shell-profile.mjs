import { normalizePortalPath } from "./importer.mjs";

/** Replace the observed shell order while retaining separately captured, source-bound observations. */
export function mergeShellProfile(
  previous = {},
  observed = {},
  { pagePath } = {},
) {
  const result = structuredClone(observed);
  const merge = (key, identity, keep = () => true) => {
    const entries = new Map();
    for (const item of Array.isArray(previous[key]) ? previous[key] : [])
      if (keep(item)) entries.set(identity(item), structuredClone(item));
    for (const item of Array.isArray(observed[key]) ? observed[key] : [])
      entries.set(identity(item), structuredClone(item));
    if (entries.size || previous[key] || observed[key])
      result[key] = [...entries.values()];
  };
  merge("observedStylesheets", (item) => item.path);
  merge("snippetCompositions", (item) => item.parentName);
  merge("richTextConfigurations", (item) => item.url);
  merge(
    "pageCopyLayouts",
    (item) => `${item.pageId}:${normalizePortalPath(item.path)}`,
    (item) =>
      !pagePath ||
      normalizePortalPath(item.path) !== normalizePortalPath(pagePath),
  );
  for (const key of ["footerLogos", "headerNotifications"])
    if (!Object.hasOwn(observed, key) && previous[key])
      result[key] = structuredClone(previous[key]);
  if (previous.managedControls || observed.managedControls)
    result.managedControls = structuredClone({
      ...previous.managedControls,
      ...observed.managedControls,
    });
  return result;
}
