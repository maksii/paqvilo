import { emptyState } from './data.mjs';
import { applySolutionData } from './solution-data.mjs';
import { bootstrapPresetLibrary } from './presets.mjs';

export function initialOrganizationState({ solutionData, packs = [], environmentVariables, platform } = {}) {
  const state = emptyState();
  state.simulator = { mode: 'local', operations: {}, endpoints: [], identity: { roles: [] } };
  const prepared = applySolutionData(state, solutionData, {
    webApiTables: Object.keys(solutionData.mappings), environmentVariables,
  });
  const library = bootstrapPresetLibrary({ metadata: solutionData, mappings: prepared.mappings, tables: prepared.tables, packs });
  prepared.presets = library;
  return { state: prepared, presetLibrary: library };
}
