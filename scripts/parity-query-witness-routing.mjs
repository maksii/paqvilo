// Private prototype: a prior proof's authority may never be replaced during cumulative qualification.
function check(x) {
  if (!x)
    throw Object.assign(new Error('invalid-query-witness-routing'), {
      qualificationCode: 'invalid-query-witness-routing',
    });
}
function singleRoutes(file, prior, bridgedPaths) {
  check(bridgedPaths.length <= 1);
  if (bridgedPaths.length && prior.queryBridgeAuthoritySha256 !== undefined)
    check(file.queryBridgeWitness?.sha256 === prior.queryBridgeAuthoritySha256);
  if (prior.queryBridgeAuthorities !== undefined) {
    check(prior.queryBridgeAuthorities.length === bridgedPaths.length);
    for (const row of prior.queryBridgeAuthorities)
      check(row.proofPath === bridgedPaths[0] && row.sha256 === file.queryBridgeWitness?.sha256);
  }
  return new Map(bridgedPaths.map((path) => [path, file.queryBridgeWitness]));
}
function retainRoutes(prior, bridgedPaths, routes) {
  const previousProofs = new Set((prior.proofs ?? []).map((p) => p.path)),
    previousPaths = bridgedPaths.filter((path) => previousProofs.has(path)),
    anchored = prior.queryBridgeAuthorities;
  if (anchored !== undefined) {
    check(Array.isArray(anchored) && anchored.length === previousPaths.length);
    const priorMap = new Map();
    for (const row of anchored) {
      check(
        row && typeof row.proofPath === 'string' && /^[a-f0-9]{64}$/.test(row.sha256) && !priorMap.has(row.proofPath),
      );
      priorMap.set(row.proofPath, row.sha256);
    }
    for (const path of previousPaths) check(priorMap.get(path) === routes.get(path)?.sha256);
  } else if (prior.queryBridgeAuthoritySha256 !== undefined) {
    check(previousPaths.length > 0);
    for (const path of previousPaths) check(routes.get(path)?.sha256 === prior.queryBridgeAuthoritySha256);
  } else check(previousPaths.length === 0);
}
export function routeQueryWitnesses({ file, prior, bridgedPaths }) {
  check(Array.isArray(bridgedPaths) && new Set(bridgedPaths).size === bridgedPaths.length);
  const multi = file.queryBridgeWitnesses;
  if (multi === undefined) return singleRoutes(file, prior, bridgedPaths);
  check(Array.isArray(multi) && multi.length === bridgedPaths.length);
  const routes = new Map();
  for (const route of multi) {
    check(
      route &&
        typeof route.proofPath === 'string' &&
        typeof route.indexPath === 'string' &&
        /^[a-f0-9]{64}$/.test(route.sha256) &&
        !routes.has(route.proofPath),
    );
    routes.set(route.proofPath, { indexPath: route.indexPath, sha256: route.sha256 });
  }
  check(bridgedPaths.every((path) => routes.has(path)));
  retainRoutes(prior, bridgedPaths, routes);
  if (file.queryBridgeWitness !== undefined && prior.queryBridgeAuthoritySha256 !== undefined)
    check(file.queryBridgeWitness.sha256 === prior.queryBridgeAuthoritySha256);
  return routes;
}
export function queryBridgeSourceIsCurrent({ prior, proofPath, witness, currentSourceSha256, capsuleSourceSha256 }) {
  return Boolean(
    prior.queryBridgeAuthorities?.some((entry) => entry.proofPath === proofPath && entry.sha256 === witness?.sha256) ||
    prior.queryBridgeAuthoritySha256 === witness?.sha256 ||
    capsuleSourceSha256 === currentSourceSha256,
  );
}
