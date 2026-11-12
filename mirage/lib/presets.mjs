import { isDeepStrictEqual } from 'node:util';
import { seedPresetBody } from './solution-schema.mjs';
import { validatePersonaCatalog } from './persona-catalog.mjs';
import { cloneStateData } from './state-clone.mjs';
import {
  LAZY_PRESET,
  OWNED_PRESET,
  defineLazyPreset,
  discoverPacks,
  genericPresets,
  packMatches,
  packPresetEntries,
  presetDescriptor,
  presetLibrary,
} from './preset-registry.mjs';

const clone = cloneStateData;
const hasOwn = (object, key) => object != null && typeof object === 'object' && Object.hasOwn(object, key);

/**
 * The public library contains generic presets only. Project packs are supplied
 * explicitly to the portal library; never import adjacent project code at startup.
 */
const defaultPacks = Object.freeze(await discoverPacks());

/**
 * Compatibility library: generic presets plus every discovered pack, without
 * portal filtering, so stored builtin descriptors remain resolvable. Bodies are
 * memoized lazy getters; use `presetDescriptor` to read names cheaply.
 */
export const builtinPresets = presetLibrary({ packs: defaultPacks });

const lazyMeta = (library, id) =>
  hasOwn(library, id) ? (Object.getOwnPropertyDescriptor(library, id).get?.[LAZY_PRESET] ?? null) : null;
const instantiatePreset = (library, id, context) => {
  const create = Object.getOwnPropertyDescriptor(library, id)?.get?.[OWNED_PRESET];
  return create ? create(context) : cloneStateData(library[id], { forkTables: Boolean(context?.records) });
};
const compactDescriptor = (name, description, configurationPreset) => ({
  builtin: true,
  builtinVersion: 1,
  ...(configurationPreset ? { configurationPreset } : {}),
  name,
  description,
});
const bodyKeys = [
  'tables',
  'mappings',
  'permissions',
  'plugins',
  'settings',
  'identity',
  'endpoints',
  'personaRoles',
  'contactRoles',
  'personaCatalog',
];
const isCompactDescriptor = (preset) => preset?.builtin === true && !bodyKeys.some((key) => hasOwn(preset, key));

/** Refresh generated library entries; explicitly edited presets and mappings remain authoritative. */
/* NOSONAR */ export function resolvePreset(state, name, generatedPresets = builtinPresets, context) {
  const copySaved = (value) => cloneStateData(value, { forkTables: Boolean(context?.records) });
  const saved = hasOwn(state.presets, name) ? state.presets[name] : undefined;
  const generatedHas = hasOwn(generatedPresets, name);
  // Explicit project packs are absent from the compatibility library; their
  // stored descriptors resolve from the supplied portal library instead.
  let library = null;
  if (hasOwn(builtinPresets, name)) library = builtinPresets;
  else if (generatedHas && saved?.builtin === true && saved.userConfigured !== true) library = generatedPresets;
  if (
    saved?.userConfigured === true ||
    !library ||
    (saved && saved.builtin !== true && !isDeepStrictEqual(saved, library[name]))
  ) {
    if (saved) return !library && isCompactDescriptor(saved) ? null : copySaved(saved);
    return generatedHas ? instantiatePreset(generatedPresets, name, context) : null;
  }
  const result = instantiatePreset(generatedHas ? generatedPresets : library, name, context);
  if (!result) return saved ? copySaved(saved) : null;
  applyExistingMappings(result, state);
  return result;
}

function applyExistingMappings(result, state) {
  for (const [entity, mapping] of Object.entries(result.mappings ?? {})) {
    const existing = state.mappings?.[entity];
    if (existing?.userConfigured === true) result.mappings[entity] = clone(existing);
    else if (existing?.metadataSources?.length && !mapping.metadataSources?.length)
      result.mappings[entity] = {
        ...mapping,
        ...clone(existing),
        relationships: {
          ...mapping.relationships,
          ...clone(existing.relationships),
        },
      };
  }
}

/** Builtin bodies are generated on demand; explicit custom presets remain complete. */
export function compactBuiltinPresets(presets, library = builtinPresets) {
  if (!presets || Array.isArray(presets) || typeof presets !== 'object') return presets;
  return Object.fromEntries(
    Object.keys(presets).map((id) => {
      // Lazy library entries (bootstrap/pack presets) compact without
      // generating their bodies.
      const lazy = lazyMeta(presets, id);
      if (lazy) return [id, compactDescriptor(lazy.name, lazy.description, lazy.configurationPreset)];
      const preset = presets[id];
      if (
        hasOwn(library, id) &&
        preset?.userConfigured !== true &&
        (preset?.builtin === true || isDeepStrictEqual(preset, library[id]))
      ) {
        const meta = presetDescriptor(library, id);
        return [
          id,
          compactDescriptor(
            preset?.name ?? meta.name,
            preset?.description ?? meta.description,
            preset?.configurationPreset ?? meta.configurationPreset,
          ),
        ];
      }
      return [id, preset];
    }),
  );
}

/** Apply a resolved preset's state sections in place (DataStore transaction body). */
export function applyPresetSections(state, preset, { owned = false } = {}) {
  const copy = owned ? (value) => value : clone;
  if (preset.personaCatalog !== undefined)
    state.personaCatalog = validatePersonaCatalog(
      preset.personaCatalog,
      `Preset ${preset.id ?? preset.name ?? 'unnamed'}`,
    );
  if (preset.tables) applyPresetTables(state, preset.tables, copy);
  if (preset.mappings) Object.assign(state.mappings, copy(preset.mappings));
  applyPresetSectionsByKey(state, preset, copy);
  if (preset.settings) Object.assign(state.settings, copy(preset.settings));
  applyPresetSimulator(state, preset, copy);
  return state;
}

function applyPresetTables(state, tables, copy) {
  for (const [entity, rows] of Object.entries(tables)) state.tables[entity] = copy(rows);
}

function applyPresetSectionsByKey(state, preset, copy) {
  for (const key of ['plugins', 'permissions']) if (preset[key]) state[key] = copy(preset[key]);
}

function applyPresetSimulator(state, preset, copy) {
  if (preset.identity) {
    state.simulator ??= {};
    state.simulator.identity = copy(preset.identity);
  }
  if (preset.endpoints) {
    state.simulator ??= {};
    state.simulator.endpoints = copy(preset.endpoints);
  }
}

/**
 * Presets stored in a newly bootstrapped state: `empty-local` with the
 * imported tables, plus every matching pack preset as a lazy builtin whose
 * mappings/tables are layered over the imported mappings and empty tables.
 */
export function bootstrapPresetLibrary({
  portal,
  metadata,
  mappings = {},
  tables = {},
  packs = defaultPacks,
  options,
} = {}) {
  const importedMappings = clone(mappings);
  const importedTables = clone(tables);
  const library = {
    'empty-local': {
      ...genericPresets()['empty-local'],
      tables: clone(importedTables),
    },
  };
  for (const pack of packs) {
    if (!packMatches(pack, portal)) continue;
    for (const [id, entry] of packPresetEntries(pack, { portal, metadata, options })) {
      if (Object.hasOwn(library, id))
        throw new Error(`Preset '${id}' from data pack ${pack.id} duplicates an existing preset`);
      defineLazyPreset(library, id, entry, {
        pack: pack.id,
        finish: (body, { owned = false } = {}) => {
          // These sections are composed separately; cloning the whole body first
          // temporarily duplicates every generated business row for no purpose.
          const { mappings: bodyMappings, tables: bodyTables, ...rest } = body;
          const copy = owned ? (value) => value : clone;
          return seedPresetBody(
            {
              ...copy(rest),
              id,
              builtin: true,
              ...(bodyMappings ? { mappings: { ...clone(importedMappings), ...copy(bodyMappings) } } : {}),
              ...(bodyTables ? { tables: { ...clone(importedTables), ...copy(bodyTables) } } : {}),
            },
            metadata?.schema,
            { owned: true },
          );
        },
      });
    }
  }
  return library;
}

/**
 * Body-free preset listing for admin/CLI: generic presets, the portal library
 * (`library`, normally the bootstrap presets) and stored state presets.
 */
export function listPresets({ state = {}, library = {} } = {}) {
  const stored = state.presets ?? {};
  const ids = [...new Set([...Object.keys(genericPresets()), ...Object.keys(library ?? {}), ...Object.keys(stored)])];
  return ids.map((id) => {
    const saved = hasOwn(stored, id) ? stored[id] : undefined;
    const meta = presetDescriptor(library, id) ?? presetDescriptor(builtinPresets, id);
    const custom = saved !== undefined && (saved?.userConfigured === true || !meta || saved?.builtin !== true);
    const unavailable = !meta && isCompactDescriptor(saved);
    const configuredPreset = custom ? saved?.configurationPreset : meta?.configurationPreset;
    return {
      id,
      name: (custom ? saved?.name : meta?.name) ?? meta?.name ?? id,
      description: (custom ? saved?.description : meta?.description) ?? meta?.description ?? '',
      source: saved?.userConfigured || !meta ? 'stored' : 'builtin',
      ...(meta?.pack ? { pack: meta.pack } : {}),
      ...(configuredPreset ? { configurationPreset: configuredPreset } : {}),
      ...(unavailable ? { unavailable: true } : {}),
    };
  });
}

export { presetDescriptor };
