// Preserve both dependency layouts: npm can re-resolve tarball transitives.
export function packageDependencyEvidence(sourceLock, consumerLock, packageName) {
  const packages = (lock) =>
    Object.entries(lock.packages ?? {})
      .filter(([location, entry]) => location && entry.version && !entry.dev && !entry.link)
      .map(([location, entry]) => ({
        path: location,
        version: entry.version,
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  const sourcePackages = packages(sourceLock);
  const consumerPackages = packages(consumerLock);
  const source = new Map(sourcePackages.map((entry) => [entry.path, entry]));
  const consumer = new Map(consumerPackages.map((entry) => [entry.path, entry]));
  const toolkitPath = `node_modules/${packageName}`;
  const differences = [...new Set([...source.keys(), ...consumer.keys()])]
    .filter((location) => location !== toolkitPath)
    .sort()
    .flatMap((location) => {
      const expected = source.get(location),
        actual = consumer.get(location);
      return expected?.version === actual?.version && expected?.integrity === actual?.integrity
        ? []
        : [{ path: location, source: expected ?? null, consumer: actual ?? null }];
    });
  return {
    comparison: 'Lockfile locations, versions and integrity; hoisting and platform omissions remain visible.',
    toolkit: consumer.get(toolkitPath) ?? null,
    sourcePackages,
    consumerPackages,
    differences,
  };
}
