/** Read one npm pack result: npm 12 keys results by name; npm 11 used an array. */
export function packedPackage(output) {
  const parsed = JSON.parse(output);
  let packages = [];
  if (Array.isArray(parsed)) packages = parsed;
  else if (parsed && typeof parsed === 'object') packages = Object.values(parsed);
  if (
    packages.length !== 1 ||
    typeof packages[0]?.filename !== 'string' ||
    !packages[0].filename.endsWith('.tgz') ||
    /[\\/]/.test(packages[0].filename)
  )
    throw new Error('Expected one npm pack result with a local archive filename.');
  return packages[0];
}
