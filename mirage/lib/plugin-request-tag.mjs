import { DataError } from './data-error.mjs';

export function validateSdkTag(parameters, canonicalTag) {
  if (
    Object.hasOwn(parameters, 'tag') &&
    (typeof parameters.tag !== 'string' || Buffer.byteLength(parameters.tag) > 8192)
  )
    throw new DataError('SDK tag requires a bounded string.', 501, 'LocalPluginSdkUnsupported');
  if (Object.hasOwn(parameters, 'tag') && canonicalTag !== undefined)
    throw new DataError('An item with the same key has already been added.', 400, 'LocalPluginTagDuplicate', {
      innerCode: '0x80040224',
    });
}

/** A transport request owns its tag across awaits. Separate requests and batch
 * members never mutate the caller's operation frame or a global default. */
export function withPluginRequestTag(store, parameters, invoke) {
  // A transport boundary is a separate request, including each batch member.
  // Only a nested SDK invocation joins its caller's canonical tag namespace.
  validateSdkTag(parameters);
  if (!Object.hasOwn(parameters, 'tag') && store?.pluginSdkTag === undefined) return invoke();
  return store.withOperationContext(
    () => {
      store.pluginSdkTag = parameters.tag;
      return invoke();
    },
    { fresh: true },
  );
}
