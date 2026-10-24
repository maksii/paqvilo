import path from 'node:path';

/** Read admin environment values live; own null/false values intentionally override defaults. */
export function dataverseEnvironmentValue(store, key, fallback) {
  const environment = store().state.dataverse?.environment ?? {};
  return Object.hasOwn(environment, key) ? environment[key] : fallback;
}

/** Compose host-independent API settings while retaining a live store accessor. */
export function liveDataverseSettings(settings, projectRoot, store) {
  const value = (key, fallback) => dataverseEnvironmentValue(store, key, fallback);
  return {
    ...settings,
    gitRemoteDirectory: settings.gitRemoteDirectory && path.resolve(projectRoot, settings.gitRemoteDirectory),
    tds: { ...settings.tds, enabled: () => value('tdsEnabled', settings.tds?.enabled) },
    serviceProtection: {
      ...settings.serviceProtection,
      requestsPer300s: () => value('requestsPer300s', settings.serviceProtection?.requestsPer300s ?? null),
    },
  };
}
