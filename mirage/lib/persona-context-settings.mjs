export function personaContextSettings(value = {}) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'maxInstances')
  )
    throw new Error('mirage.personaContexts accepts only maxInstances');
  const maxInstances = value.maxInstances ?? 4;
  if (!Number.isInteger(maxInstances) || maxInstances < 0 || maxInstances > 32)
    throw new Error('mirage.personaContexts.maxInstances must be an integer from 0 to 32');
  return { maxInstances };
}
