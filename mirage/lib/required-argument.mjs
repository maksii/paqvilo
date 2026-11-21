/**
 * A parameter default that refuses a missing required argument of a public function with a TypeError naming the call
 * and the argument, instead of a later "Cannot read properties of undefined": `function f(portal = requiredArgument(
 * 'f(portal)', 'a portal')) {}`. It runs only when the argument is undefined.
 */
export function requiredArgument(call, what) {
  throw new TypeError(`${call} requires ${what}.`);
}

/**
 * The source check createSimulator and preflight share: options must be an object that selects sources. A Power
 * Pages simulator (the default runtime kind) needs `sourceDir`; preflight also accepts Solution roots alone
 * (`{ solutionRoots: true }`). The refusal lists the keys it was given, so a misspelt `source` is visible.
 */
export function requireRuntimeSources(call, options, { solutionRoots = false } = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    requiredArgument(call, 'an options object with the portal sources (sourceDir or project)');
  const kind = options.runtime?.kind ?? 'power-pages';
  const selected = options.sourceDir || (solutionRoots ? options.solutionRoots?.length : kind !== 'power-pages');
  if (!selected) {
    const given = Object.keys(options);
    const wanted = solutionRoots
      ? 'sourceDir (the exported portal directory) or solutionRoots'
      : 'sourceDir (the exported portal directory) for the power-pages runtime';
    requiredArgument(call, `${wanted}; got ${given.length ? given.join(', ') : 'no options'}`);
  }
  return options;
}
