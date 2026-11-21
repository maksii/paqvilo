// Shared by project configuration, local hosts and setup UI. No platform or I/O dependencies.
export const RUNTIME_KINDS = Object.freeze(['power-pages', 'model-driven', 'dataverse-api']);
/** The refusal of a value outside an enumeration: `<label> must be one of a, b or c; got "<value>".` */
export const choiceMessage = (label, choices, value) =>
  `${label} must be one of ${choices.slice(0, -1).join(', ')} or ${choices.at(-1)}; got ${JSON.stringify(value)}.`;
const guid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export function runtimeSettings(value, label = 'runtime') {
  if (value == null) return { kind: 'power-pages' };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['kind', 'defaultApp'].includes(key)) throw new Error(`Unknown ${label} key '${key}'`);
  const kind = value.kind ?? 'power-pages';
  if (!RUNTIME_KINDS.includes(kind)) throw new Error(choiceMessage(`${label}.kind`, RUNTIME_KINDS, kind));
  if (value.defaultApp !== undefined && (typeof value.defaultApp !== 'string' || !guid.test(value.defaultApp)))
    throw new Error(`${label}.defaultApp must be an imported application GUID`);
  if (kind === 'dataverse-api' && value.defaultApp !== undefined)
    throw new Error(`${label}.defaultApp requires a model-driven surface`);
  return { kind, ...(value.defaultApp === undefined ? {} : { defaultApp: value.defaultApp.toLowerCase() }) };
}
export function runtimeCapabilities(runtime) {
  const { kind } = runtimeSettings(runtime);
  // Legacy booleans only: fidelity levels (canvas, code apps) live in the capability registry records.
  return { powerPages: kind === 'power-pages', modelDriven: kind !== 'dataverse-api', organization: true };
}
