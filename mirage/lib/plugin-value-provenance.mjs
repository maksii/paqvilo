// Invocation DTO provenance is external to the DTO: callers can edit ordinary
// records without receiving hidden SDK metadata or mutable store references.
const sources = new WeakMap();
export function rememberPluginValue(value, wire) {
  if (value && typeof value === 'object') sources.set(value, wire);
  return value;
}
export const pluginValueSource = (value) => (value && typeof value === 'object' ? sources.get(value) : undefined);
export function copyPluginValueSource(source, target) {
  const wire = pluginValueSource(source);
  if (wire) rememberPluginValue(target, wire);
  return target;
}
