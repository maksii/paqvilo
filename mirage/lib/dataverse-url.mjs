// Leaf URL helpers shared by schema/storage modules and the HTTP runtime. Keep these independent of DataStore and presets.
export function contextUrl(origin, version, suffix) {
  return `${origin}/api/data/${version}/$metadata#${suffix}`;
}
