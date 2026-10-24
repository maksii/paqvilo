/** Explicit simulation levels apply to every local mutation surface. Omission
 * retains existing ignored-state persistence for older project configurations. */
const SIMULATION_LEVELS = Object.freeze(['dry-run', 'simulation', 'deep']);

export function simulationSettings(value, label = 'simulation') {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'level') ||
    !SIMULATION_LEVELS.includes(value.level)
  )
    throw new Error(`${label} requires level: ${SIMULATION_LEVELS.join(', ')}.`);
  return { level: value.level };
}

export function simulationReport(settings = null) {
  return {
    level: settings?.level ?? 'local-state',
    legacy: !settings,
    recordPersistence: !settings ? 'local-state' : settings.level === 'dry-run' ? 'memory' : 'pack-data-files',
    schemaChanges: !settings || settings.level === 'deep',
    targets: [],
    dirtyRecords: 0,
    ready: true,
    restartRequired: false,
  };
}
