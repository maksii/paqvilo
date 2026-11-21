/** Explicit simulation levels apply to every local mutation surface. Omission
 * retains existing ignored-state persistence for older project configurations. */
export const SIMULATION_LEVELS = Object.freeze(['dry-run', 'simulation', 'deep']);

export function simulationSettings(value, label = 'simulation') {
  if (value === undefined || value === null) return null;
  // Each refusal names the offending key; the message keeps its "requires level" prefix.
  const levels = SIMULATION_LEVELS.join(', ');
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} requires level: ${levels}. ${label} must be an object such as { level: dry-run }.`);
  const unknown = Object.keys(value).find((key) => key !== 'level');
  if (unknown !== undefined)
    throw new Error(`${label} requires level: ${levels}. Unknown key ${label}.${unknown}: only level is accepted.`);
  if (!SIMULATION_LEVELS.includes(value.level))
    throw new Error(
      `${label} requires level: ${levels}. ${label}.level is ${value.level === undefined ? 'missing' : JSON.stringify(value.level)}.`,
    );
  return { level: value.level };
}

export function simulationReport(settings = null) {
  return {
    level: settings?.level ?? 'local-state',
    legacy: !settings,
    recordPersistence: persistenceFor(settings),
    schemaChanges: !settings || settings.level === 'deep',
    targets: [],
    dirtyRecords: 0,
    ready: true,
    restartRequired: false,
  };
}

function persistenceFor(settings) {
  if (!settings) return 'local-state';
  if (settings.level === 'dry-run') return 'memory';
  return 'pack-data-files';
}
