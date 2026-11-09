/** Read metadata before values: template admission must never execute accessors. */
export function templateDataRecord(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error(label + ' require plain explicit data properties');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).some((key) => !('value' in properties[key])))
    throw Error(label + ' require plain explicit data properties');
}

/** Snapshot dense own data slots without calling an overridden map or iterator. */
export function templateDataArray(value, { maximum, label }) {
  const fail = () => {
    throw Error(label + ' requires a dense plain array of explicit data properties');
  };
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const properties = Object.getOwnPropertyDescriptors(value);
  const length = properties.length?.value;
  if (!Number.isInteger(length) || length < 1 || length > maximum || Reflect.ownKeys(properties).length !== length + 1)
    fail();
  const entries = [];
  for (let index = 0; index < length; index++) {
    const property = properties[index];
    if (!Object.hasOwn(properties, index) || !property || !('value' in property)) fail();
    entries.push(property.value);
  }
  return entries;
}
