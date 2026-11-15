// This serializable probe runs with the official SDK and the local client.
// It changes only an authored query-parameter property in the returned JavaScript object, then restores it.
export async function captureCodeAppContextCacheContract(client) {
  const first = await client.getContext();
  const second = await client.getContext();
  const key = '_paqvilo_context_cache_probe';
  const had = Object.hasOwn(first.app.queryParams, key);
  const previous = first.app.queryParams[key];
  try {
    first.app.queryParams[key] = 'authored cache probe';
    const third = await client.getContext();
    return [
      { id: 'context.resolvedReference', value: first === second },
      { id: 'context.queryReference', value: first.app.queryParams === second.app.queryParams },
      { id: 'context.clientMutationVisible', value: third.app.queryParams[key] === 'authored cache probe' },
      { id: 'context.mutationReference', value: third === first },
    ];
  } finally {
    if (had) first.app.queryParams[key] = previous;
    else delete first.app.queryParams[key];
  }
}

// Allowlisted context relationships only: never serialize host globals, identities or arbitrary query values.
// queryKeys must name authored fixture parameters, and reference identities stay inputs rather than output.
export async function captureCodeAppContextContract(client, reference) {
  if (
    !Array.isArray(reference.queryKeys) ||
    reference.queryKeys.length > 16 ||
    reference.queryKeys.some((key) => typeof key !== 'string' || !/^_paqvilo_[a-z0-9_]+$/.test(key))
  )
    throw new Error('Context probes accept at most 16 authored _paqvilo_ query keys.');
  const context = await client.getContext();
  const guid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const rows = [
    { id: 'app.appId.matches', value: context.app.appId === reference.appId },
    { id: 'app.environmentId.matches', value: context.app.environmentId === reference.environmentId },
    { id: 'app.appSettings.object', value: object(context.app.appSettings) },
    { id: 'app.queryParams.object', value: object(context.app.queryParams) },
    {
      id: 'user.fullName.nonempty',
      value: typeof context.user.fullName === 'string' && context.user.fullName.length > 0,
    },
    { id: 'user.objectId.guid', value: guid(context.user.objectId) },
    { id: 'user.tenantId.guid', value: guid(context.user.tenantId) },
    {
      id: 'user.userPrincipalName.nonempty',
      value: typeof context.user.userPrincipalName === 'string' && context.user.userPrincipalName.length > 0,
    },
    { id: 'host.sessionId.guid', value: guid(context.host.sessionId) },
  ];
  for (const key of reference.queryKeys) {
    const value = context.app.queryParams[key];
    rows.push({ id: `app.query.${key}`, value: typeof value === 'string' ? value : { type: typeof value } });
  }
  return rows;
}
